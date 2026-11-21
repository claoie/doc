//! Port of `src/server/db/index.ts`: the connection pool, queries and migrations.
//!
//! The Bun server writes its queries as tagged templates and lets Postgres
//! work out the type of every parameter. This module keeps both habits:
//! [`sql!`] builds a query from a template whose `{}` are values or nested
//! fragments, and every value travels as text of unknown type, so the queries
//! read like the ones they port and Postgres coerces them the same way.

use std::error::Error as StdError;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

use bytes::BytesMut;
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use postgres_protocol::types as pg;
use serde_json::{Map, Value};
use tokio_postgres::error::SqlState;
use tokio_postgres::types::{Format, FromSql, IsNull, Kind, ToSql, Type};
use tokio_postgres::NoTls;

use crate::jsutil::{js_json, normalize_numbers, number_json};
use crate::logger;

// ---------------------------------------------------------------------------
// Errors

#[derive(Debug)]
pub enum DbError {
    Postgres(tokio_postgres::Error),
    Pool(String),
    /// A column the code asked for is missing or of an unexpected type.
    Decode(String),
}

impl DbError {
    /// The SQLSTATE of a database error, e.g. `23505` for a unique violation.
    pub fn code(&self) -> Option<&str> {
        match self {
            DbError::Postgres(e) => e.code().map(SqlState::code),
            _ => None,
        }
    }

    pub fn is_unique_violation(&self) -> bool {
        self.code() == Some("23505")
    }

    /// The database ended this statement to break a deadlock.
    pub fn is_deadlock(&self) -> bool {
        self.code() == Some("40P01")
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Postgres(e) => match e.as_db_error() {
                Some(db) => write!(f, "{}", db.message()),
                None => write!(f, "{e}"),
            },
            DbError::Pool(message) | DbError::Decode(message) => write!(f, "{message}"),
        }
    }
}

impl StdError for DbError {}

impl From<tokio_postgres::Error> for DbError {
    fn from(error: tokio_postgres::Error) -> Self {
        DbError::Postgres(error)
    }
}

// ---------------------------------------------------------------------------
// Query fragments

/// A piece of SQL with the values bound into it.
#[derive(Debug, Clone, Default)]
pub struct Sql {
    text: String,
    params: Vec<Option<String>>,
}

pub enum Arg {
    Param(Option<String>),
    Fragment(Sql),
}

/// What may fill a `{}` of [`sql!`]: a value (bound as a parameter) or a fragment (spliced in).
pub trait IntoArg {
    fn into_arg(self) -> Arg;
}

impl IntoArg for Sql {
    fn into_arg(self) -> Arg {
        Arg::Fragment(self)
    }
}

impl IntoArg for &Sql {
    fn into_arg(self) -> Arg {
        Arg::Fragment(self.clone())
    }
}

/// Text is bound as UTF-8, where half a surrogate pair becomes U+FFFD.
impl IntoArg for &str {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(crate::jsutil::to_text(self).into_owned()))
    }
}

impl IntoArg for String {
    fn into_arg(self) -> Arg {
        self.as_str().into_arg()
    }
}

impl IntoArg for &String {
    fn into_arg(self) -> Arg {
        self.as_str().into_arg()
    }
}

impl IntoArg for bool {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(if self { "true" } else { "false" }.to_string()))
    }
}

macro_rules! display_arg {
    ($($ty:ty),*) => {$(
        impl IntoArg for $ty {
            fn into_arg(self) -> Arg {
                Arg::Param(Some(self.to_string()))
            }
        }
    )*};
}
display_arg!(i16, i32, i64, u16, u32, u64, usize);

impl IntoArg for f64 {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(crate::jsutil::number_to_string(self)))
    }
}

impl IntoArg for DateTime<Utc> {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(self.to_rfc3339_opts(SecondsFormat::Micros, true)))
    }
}

/// JSON values are bound as their text; the query casts them (`{}::jsonb`).
impl IntoArg for &Value {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(js_json(self)))
    }
}

impl IntoArg for Value {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(js_json(&self)))
    }
}

impl<T: IntoArg> IntoArg for Option<T> {
    fn into_arg(self) -> Arg {
        match self {
            Some(value) => value.into_arg(),
            None => Arg::Param(None),
        }
    }
}

/// An array parameter (`sql.array(values, type)`), bound as an array literal.
pub struct PgArray(String);

impl IntoArg for PgArray {
    fn into_arg(self) -> Arg {
        Arg::Param(Some(self.0))
    }
}

/// An array of strings (text, uuid, …) as a Postgres array literal.
pub fn array<S: AsRef<str>>(values: &[S]) -> PgArray {
    let mut out = String::from("{");
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        for ch in crate::jsutil::to_text(value.as_ref()).chars() {
            if ch == '"' || ch == '\\' {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
    }
    out.push('}');
    PgArray(out)
}

impl Sql {
    /// SQL text taken as is (`sql.unsafe`). Never pass anything a client sent.
    pub fn raw(text: impl Into<String>) -> Sql {
        Sql { text: text.into(), params: Vec::new() }
    }

    /// Builds a fragment from a template: each `{}` takes the next argument;
    /// `{{` and `}}` are literal braces.
    pub fn format(template: &str, args: Vec<Arg>) -> Sql {
        let mut sql = Sql { text: String::with_capacity(template.len() + 16), params: Vec::new() };
        let mut args = args.into_iter();
        let mut chars = template.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '{' if chars.peek() == Some(&'{') => {
                    chars.next();
                    sql.text.push('{');
                }
                '}' if chars.peek() == Some(&'}') => {
                    chars.next();
                    sql.text.push('}');
                }
                '{' if chars.peek() == Some(&'}') => {
                    chars.next();
                    match args.next().expect("sql!: more placeholders than arguments") {
                        Arg::Param(value) => {
                            sql.params.push(value);
                            sql.text.push_str(&format!("${}", sql.params.len()));
                        }
                        Arg::Fragment(fragment) => sql.splice(fragment),
                    }
                }
                other => sql.text.push(other),
            }
        }
        assert!(args.next().is_none(), "sql!: more arguments than placeholders");
        sql
    }

    /// Appends a fragment, renumbering its parameters after this one's.
    fn splice(&mut self, fragment: Sql) {
        let offset = self.params.len();
        if offset == 0 || fragment.params.is_empty() {
            self.text.push_str(&fragment.text);
        } else {
            let bytes = fragment.text.as_bytes();
            let mut i = 0;
            let mut copied = 0;
            let mut in_string = false;
            while i < bytes.len() {
                let b = bytes[i];
                if b == b'\'' {
                    in_string = !in_string;
                } else if b == b'$' && !in_string {
                    let start = i + 1;
                    let mut end = start;
                    while end < bytes.len() && bytes[end].is_ascii_digit() {
                        end += 1;
                    }
                    if end > start {
                        let n: usize = fragment.text[start..end].parse().expect("parameter number");
                        self.text.push_str(&fragment.text[copied..i]);
                        self.text.push_str(&format!("${}", n + offset));
                        copied = end;
                        i = end;
                        continue;
                    }
                }
                i += 1;
            }
            self.text.push_str(&fragment.text[copied..]);
        }
        self.params.extend(fragment.params);
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }
}

/// Builds a [`Sql`] fragment: `sql!("SELECT 1 FROM users WHERE id = {} AND {}", id, condition)`.
#[macro_export]
macro_rules! sql {
    ($template:expr) => {
        $crate::db::Sql::format($template, Vec::new())
    };
    ($template:expr, $($arg:expr),+ $(,)?) => {
        $crate::db::Sql::format($template, vec![$($crate::db::IntoArg::into_arg($arg)),+])
    };
}

/// A parameter sent as text, whatever type Postgres decides it has.
#[derive(Debug)]
struct TextParam<'a>(Option<&'a str>);

impl ToSql for TextParam<'_> {
    fn to_sql(&self, _ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        match self.0 {
            Some(text) => {
                out.extend_from_slice(text.as_bytes());
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    tokio_postgres::types::to_sql_checked!();
}

// ---------------------------------------------------------------------------
// Rows

/// A column value, decoded by its Postgres type.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    Json(Value),
    /// Microseconds since the Unix epoch.
    Time(i64),
    Array(Vec<Cell>),
}

const PG_EPOCH_MICROS: i64 = 946_684_800_000_000;

fn decode(ty: &Type, raw: &[u8]) -> Result<Cell, Box<dyn StdError + Sync + Send>> {
    if let Kind::Array(element) = ty.kind() {
        let array = pg::array_from_sql(raw)?;
        let mut cells = Vec::new();
        let mut values = array.values();
        while let Some(value) = fallible_next(&mut values)? {
            cells.push(match value {
                Some(bytes) => decode(element, bytes)?,
                None => Cell::Null,
            });
        }
        return Ok(Cell::Array(cells));
    }
    Ok(match *ty {
        // A function without a result, such as `pg_advisory_xact_lock`.
        Type::VOID => Cell::Null,
        Type::BOOL => Cell::Bool(pg::bool_from_sql(raw)?),
        Type::INT2 => Cell::Int(pg::int2_from_sql(raw)?.into()),
        Type::INT4 => Cell::Int(pg::int4_from_sql(raw)?.into()),
        Type::INT8 => Cell::Int(pg::int8_from_sql(raw)?),
        Type::OID => Cell::Int(pg::oid_from_sql(raw)?.into()),
        Type::FLOAT4 => Cell::Float(pg::float4_from_sql(raw)?.into()),
        Type::FLOAT8 => Cell::Float(pg::float8_from_sql(raw)?),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => Cell::Text(pg::text_from_sql(raw)?.to_string()),
        Type::UUID => Cell::Text(uuid::Uuid::from_bytes(pg::uuid_from_sql(raw)?).hyphenated().to_string()),
        Type::JSON => Cell::Json(parse_json(raw)?),
        Type::JSONB => {
            if raw.first() != Some(&1) {
                return Err("unsupported jsonb version".into());
            }
            Cell::Json(parse_json(&raw[1..])?)
        }
        Type::TIMESTAMPTZ | Type::TIMESTAMP => Cell::Time(pg::timestamp_from_sql(raw)? + PG_EPOCH_MICROS),
        _ => return Err(format!("unsupported column type {ty}").into()),
    })
}

fn fallible_next<'a>(values: &mut pg::ArrayValues<'a>) -> Result<Option<Option<&'a [u8]>>, Box<dyn StdError + Sync + Send>> {
    use fallible_iterator::FallibleIterator;
    values.next()
}

fn parse_json(raw: &[u8]) -> Result<Value, Box<dyn StdError + Sync + Send>> {
    let mut deserializer = serde_json::Deserializer::from_slice(raw);
    // What is stored was accepted through `http::read_json`, which bounds the depth.
    deserializer.disable_recursion_limit();
    let mut value: Value = serde::Deserialize::deserialize(&mut deserializer)?;
    normalize_numbers(&mut value);
    Ok(value)
}

impl<'a> FromSql<'a> for Cell {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        decode(ty, raw)
    }

    fn from_sql_null(_ty: &Type) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        Ok(Cell::Null)
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

/// `new Date(value).toISOString()` for a timestamp in microseconds: JavaScript
/// dates hold milliseconds, so the rest is dropped, as the Bun driver does.
pub fn micros_to_iso(micros: i64) -> String {
    let millis = micros.div_euclid(1000);
    match Utc.timestamp_millis_opt(millis).single() {
        Some(time) => time.to_rfc3339_opts(SecondsFormat::Millis, true),
        None => String::new(),
    }
}

impl Cell {
    /// The value as JSON, the way the Bun driver hands it to JavaScript:
    /// timestamps as ISO strings, 64-bit integers as numbers.
    pub fn into_json(self) -> Value {
        match self {
            Cell::Null => Value::Null,
            Cell::Bool(b) => Value::Bool(b),
            Cell::Int(i) => Value::from(i),
            Cell::Float(f) => number_json(f),
            Cell::Text(s) => Value::String(s),
            Cell::Json(v) => v,
            Cell::Time(t) => Value::String(micros_to_iso(t)),
            Cell::Array(items) => Value::Array(items.into_iter().map(Cell::into_json).collect()),
        }
    }
}

/// A result row with its values decoded.
#[derive(Debug, Clone)]
pub struct Row {
    columns: Vec<(String, Cell)>,
}

impl Row {
    fn from_pg(row: &tokio_postgres::Row) -> Result<Row, DbError> {
        let mut columns = Vec::with_capacity(row.len());
        for (index, column) in row.columns().iter().enumerate() {
            let cell: Cell = row.try_get(index).map_err(|e| DbError::Decode(format!("column {}: {e}", column.name())))?;
            columns.push((column.name().to_string(), cell));
        }
        Ok(Row { columns })
    }

    /// The value of a column; panics when the query has no such column (a bug in the query).
    pub fn cell(&self, name: &str) -> &Cell {
        self.columns
            .iter()
            .find(|(column, _)| column == name)
            .map(|(_, cell)| cell)
            .unwrap_or_else(|| panic!("query returned no column {name}"))
    }

    pub fn has(&self, name: &str) -> bool {
        self.columns.iter().any(|(column, _)| column == name)
    }

    pub fn is_null(&self, name: &str) -> bool {
        matches!(self.cell(name), Cell::Null)
    }

    /// A text or uuid column that may be NULL.
    pub fn opt_str(&self, name: &str) -> Option<String> {
        match self.cell(name) {
            Cell::Null => None,
            Cell::Text(s) => Some(s.clone()),
            other => panic!("column {name} is not text: {other:?}"),
        }
    }

    /// A text or uuid column; NULL reads as `""`.
    pub fn str(&self, name: &str) -> String {
        self.opt_str(name).unwrap_or_default()
    }

    /// A boolean column; NULL reads as false.
    pub fn bool(&self, name: &str) -> bool {
        match self.cell(name) {
            Cell::Null => false,
            Cell::Bool(b) => *b,
            other => panic!("column {name} is not boolean: {other:?}"),
        }
    }

    pub fn opt_i64(&self, name: &str) -> Option<i64> {
        match self.cell(name) {
            Cell::Null => None,
            Cell::Int(i) => Some(*i),
            Cell::Float(f) => Some(*f as i64),
            Cell::Text(s) => s.parse().ok(),
            other => panic!("column {name} is not a number: {other:?}"),
        }
    }

    /// An integer column; NULL reads as 0.
    pub fn i64(&self, name: &str) -> i64 {
        self.opt_i64(name).unwrap_or(0)
    }

    /// A json or jsonb column; NULL reads as JSON null.
    pub fn json(&self, name: &str) -> Value {
        match self.cell(name) {
            Cell::Null => Value::Null,
            Cell::Json(v) => v.clone(),
            other => other.clone().into_json(),
        }
    }

    pub fn opt_json(&self, name: &str) -> Option<Value> {
        match self.cell(name) {
            Cell::Null => None,
            _ => Some(self.json(name)),
        }
    }

    /// A timestamp column, in microseconds since the Unix epoch.
    pub fn opt_micros(&self, name: &str) -> Option<i64> {
        match self.cell(name) {
            Cell::Null => None,
            Cell::Time(t) => Some(*t),
            other => panic!("column {name} is not a timestamp: {other:?}"),
        }
    }

    /// A timestamp column in milliseconds since the Unix epoch, as a JavaScript `Date` holds it.
    pub fn opt_millis(&self, name: &str) -> Option<i64> {
        self.opt_micros(name).map(|t| t.div_euclid(1000))
    }

    /// `iso(row.column)`: the timestamp as an ISO string, or `None` for NULL.
    pub fn opt_iso(&self, name: &str) -> Option<String> {
        self.opt_micros(name).map(micros_to_iso)
    }

    /// `iso(row.column)!`.
    pub fn iso(&self, name: &str) -> String {
        self.opt_iso(name).unwrap_or_default()
    }

    /// A text[] or uuid[] column; NULL reads as empty, NULL elements are skipped.
    pub fn strings(&self, name: &str) -> Vec<String> {
        match self.cell(name) {
            Cell::Null => Vec::new(),
            Cell::Array(items) => items
                .iter()
                .filter_map(|item| match item {
                    Cell::Text(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            other => panic!("column {name} is not an array: {other:?}"),
        }
    }

    /// The column as JSON (see [`Cell::into_json`]).
    pub fn value(&self, name: &str) -> Value {
        self.cell(name).clone().into_json()
    }

    /// The whole row as a JSON object, columns in query order.
    pub fn to_json(&self) -> Map<String, Value> {
        self.columns.iter().map(|(name, cell)| (name.clone(), cell.clone().into_json())).collect()
    }
}

// ---------------------------------------------------------------------------
// Connections

static POOL: OnceLock<Pool> = OnceLock::new();

/// Connects the pool. libpq's `?host=/socket/dir` form is understood, and a
/// URL without a user connects as the operating-system user, as libpq does.
/// `?host=/socket/dir`: the directory of a Unix socket. The host name of the
/// URL is then not used, and the socket is the one of the URL's port (5432
/// without one), as in the Bun server.
fn socket_config(url: &str) -> Option<tokio_postgres::Config> {
    let parsed = url::Url::parse(url).ok()?;
    let directory = parsed.query_pairs().find(|(key, value)| key == "host" && value.starts_with('/')).map(|(_, value)| value.into_owned())?;
    let decode = |text: &str| crate::jsutil::decode_uri_component(text).unwrap_or_else(|| text.to_string());
    let mut config = tokio_postgres::Config::new();
    let directory = directory.trim_end_matches('/');
    config.host_path(if directory.is_empty() { "/" } else { directory });
    config.port(parsed.port().unwrap_or(5432));
    if !parsed.username().is_empty() {
        config.user(decode(parsed.username()));
    }
    if let Some(password) = parsed.password() {
        config.password(decode(password));
    }
    let database = decode(parsed.path().trim_start_matches('/'));
    if !database.is_empty() {
        config.dbname(&database);
    }
    Some(config)
}

pub fn connect(url: &str, max: usize) -> Result<(), DbError> {
    let mut config = match socket_config(url) {
        Some(config) => config,
        None => tokio_postgres::Config::from_str(url).map_err(DbError::Postgres)?,
    };
    if config.get_user().is_none() {
        config.user(std::env::var("USER").unwrap_or_else(|_| "postgres".into()));
    }
    if config.get_dbname().is_none() {
        let user = config.get_user().unwrap_or("postgres").to_string();
        config.dbname(&user);
    }
    let manager = Manager::from_config(config, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    let pool = Pool::builder(manager).max_size(max.max(1)).build().map_err(|e| DbError::Pool(e.to_string()))?;
    POOL.set(pool).map_err(|_| DbError::Pool("the database is already connected".into()))
}

fn pool() -> &'static Pool {
    POOL.get().expect("the database is not connected")
}

pub async fn disconnect() {
    if let Some(pool) = POOL.get() {
        pool.close();
    }
}

/// Where a query runs: on any pooled connection, or inside a transaction.
#[derive(Clone, Copy)]
pub enum Conn<'a> {
    Pool,
    Tx(&'a tokio_postgres::Transaction<'a>),
}

/// Queries outside a transaction.
pub fn db() -> Conn<'static> {
    Conn::Pool
}

impl Conn<'_> {
    pub async fn query(self, query: Sql) -> Result<Vec<Row>, DbError> {
        let params: Vec<TextParam> = query.params.iter().map(|p| TextParam(p.as_deref())).collect();
        let typed: Vec<(&(dyn ToSql + Sync), Type)> = params.iter().map(|p| (p as &(dyn ToSql + Sync), Type::UNKNOWN)).collect();
        let rows = match self {
            Conn::Pool => {
                let client = pool().get().await.map_err(|e| DbError::Pool(e.to_string()))?;
                client.query_typed(&query.text, &typed).await?
            }
            Conn::Tx(tx) => tx.query_typed(&query.text, &typed).await?,
        };
        rows.iter().map(Row::from_pg).collect()
    }

    /// The first row, if any (`const [row] = await sql\`…\``).
    pub async fn first(self, query: Sql) -> Result<Option<Row>, DbError> {
        Ok(self.query(query).await?.into_iter().next())
    }

    /// Runs a statement for its effect.
    pub async fn execute(self, query: Sql) -> Result<(), DbError> {
        self.query(query).await.map(|_| ())
    }

    /// Several statements at once, without parameters (migrations).
    pub async fn batch(self, text: &str) -> Result<(), DbError> {
        match self {
            Conn::Pool => {
                let client = pool().get().await.map_err(|e| DbError::Pool(e.to_string()))?;
                client.batch_execute(text).await?;
            }
            Conn::Tx(tx) => tx.batch_execute(text).await?,
        }
        Ok(())
    }
}

/// Runs `body` in a transaction (`sql.begin`): committed when it returns `Ok`,
/// rolled back when it returns `Err`.
pub async fn begin<T, E, F>(body: F) -> Result<T, E>
where
    E: From<DbError>,
    F: for<'c> AsyncFnOnce(Conn<'c>) -> Result<T, E>,
{
    let mut client = pool().get().await.map_err(|e| DbError::Pool(e.to_string()))?;
    let tx = client.transaction().await.map_err(DbError::from)?;
    match body(Conn::Tx(&tx)).await {
        Ok(value) => {
            tx.commit().await.map_err(DbError::from)?;
            Ok(value)
        }
        Err(error) => {
            // A failed rollback leaves nothing to report beyond the original error.
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

// ---------------------------------------------------------------------------
// Migrations: the same files the Bun server embeds.

pub const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial", include_str!("../../server/db/migrations/001_initial.sql")),
    ("002_bases", include_str!("../../server/db/migrations/002_bases.sql")),
    ("003_cell_time_zone", include_str!("../../server/db/migrations/003_cell_time_zone.sql")),
    ("004_realtime_leader", include_str!("../../server/db/migrations/004_realtime_leader.sql")),
    ("005_sso", include_str!("../../server/db/migrations/005_sso.sql")),
];

pub async fn migrate() -> Result<(), DbError> {
    db().execute(sql!(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    ))
    .await?;
    let applied: Vec<String> = db().query(sql!("SELECT name FROM schema_migrations")).await?.iter().map(|row| row.str("name")).collect();
    for (name, text) in MIGRATIONS {
        if applied.iter().any(|done| done == name) {
            continue;
        }
        let ran = begin(async |tx| -> Result<bool, DbError> {
            tx.execute(sql!("SELECT pg_advisory_xact_lock(726354)")).await?;
            // Another copy of the server may have applied it while this one waited for the lock.
            if tx.first(sql!("SELECT 1 AS done FROM schema_migrations WHERE name = {}", *name)).await?.is_some() {
                return Ok(false);
            }
            tx.batch(text).await?;
            tx.execute(sql!("INSERT INTO schema_migrations (name) VALUES ({})", *name)).await?;
            Ok(true)
        })
        .await?;
        // The Bun server logs this line whether or not it was the copy that ran the migration.
        let _ = ran;
        logger::info_with("migration applied", serde_json::json!({ "name": name }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queries_from_templates() {
        let condition = sql!("p.id = {} AND p.deleted_at IS NULL", "abc");
        let query = sql!("SELECT {} FROM pages p WHERE p.space_id = {} AND {} LIMIT {}", Sql::raw("p.id"), "space", condition, 5);
        assert_eq!(query.text, "SELECT p.id FROM pages p WHERE p.space_id = $1 AND p.id = $2 AND p.deleted_at IS NULL LIMIT $3");
        assert_eq!(query.params, vec![Some("space".to_string()), Some("abc".to_string()), Some("5".to_string())]);
    }

    #[test]
    fn renumbers_nested_parameters() {
        let inner = sql!("(a = {} OR b = {} OR c = '$1')", 1, 2);
        let outer = sql!("x = {} AND {} AND y = {} AND {}", "x", &inner, None::<String>, inner);
        assert_eq!(outer.text, "x = $1 AND (a = $2 OR b = $3 OR c = '$1') AND y = $4 AND (a = $5 OR b = $6 OR c = '$1')");
        assert_eq!(outer.params.len(), 6);
        assert_eq!(outer.params[3], None);
    }

    #[test]
    fn keeps_literal_braces() {
        let query = sql!("SELECT COALESCE(settings, '{{}}'::jsonb) -> {}", "key");
        assert_eq!(query.text, "SELECT COALESCE(settings, '{}'::jsonb) -> $1");
    }

    #[test]
    fn writes_array_literals() {
        assert_eq!(array(&["a", "b\"c", "d\\e", ""]).0, r#"{"a","b\"c","d\\e",""}"#);
        assert_eq!(array::<&str>(&[]).0, "{}");
    }

    #[test]
    fn formats_timestamps_like_javascript() {
        assert_eq!(micros_to_iso(1_767_268_800_123_999), "2026-01-01T12:00:00.123Z");
        assert_eq!(micros_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(micros_to_iso(-1), "1969-12-31T23:59:59.999Z");
    }
}
