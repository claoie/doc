//! Port of `src/server/lib/validate.ts`: typed, bounded accessors over an
//! untrusted JSON object or query string.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::common::ids::is_uuid;
use crate::http::{bad_request, Ctx, Result};
use crate::jsutil::{char_len, js_trim, number_value, string_to_number, utf16_len};

#[derive(Debug, Clone, Copy)]
pub struct StringRule {
    /// `None` is the default of 1.
    pub min: Option<usize>,
    pub max: usize,
    /// `false` keeps surrounding whitespace (passwords).
    pub trim: bool,
}

/// `{ max }`: required, trimmed.
pub const fn max(max: usize) -> StringRule {
    StringRule { min: None, max, trim: true }
}

/// `{ min, max }`.
pub const fn min_max(min: usize, max: usize) -> StringRule {
    StringRule { min: Some(min), max, trim: true }
}

pub const NAME_RULE: StringRule = min_max(1, 50);
pub const PASSWORD_RULE: StringRule = StringRule { min: Some(8), max: 70, trim: false };
pub const EMAIL_RULE: StringRule = min_max(3, 254);

/// A field that may be absent, explicitly null (or blank), or given.
#[derive(Debug, Clone, PartialEq)]
pub enum Nullable<T> {
    Absent,
    Null,
    Value(T),
}

impl<T> Nullable<T> {
    /// `value !== undefined`.
    pub fn is_given(&self) -> bool {
        !matches!(self, Nullable::Absent)
    }

    /// `value ?? null`.
    pub fn into_option(self) -> Option<T> {
        match self {
            Nullable::Value(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_option(&self) -> Option<&T> {
        match self {
            Nullable::Value(value) => Some(value),
            _ => None,
        }
    }
}

pub struct Input {
    data: Map<String, Value>,
}

pub fn input(data: Map<String, Value>) -> Input {
    Input { data }
}

impl Input {
    /// `Input.query(url)`: the query string as an object; a repeated key keeps its last value.
    pub fn query(ctx: &Ctx) -> Input {
        let mut data = Map::new();
        for (key, value) in &ctx.query {
            data.insert(key.clone(), Value::String(value.clone()));
        }
        Input { data }
    }

    /// `data[key] !== undefined`: a JSON null counts as present.
    pub fn has(&self, key: &str) -> bool {
        self.data.contains_key(key)
    }

    pub fn raw(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }

    fn check_string(&self, key: &str, value: &Value, rule: StringRule) -> Result<String> {
        let Value::String(value) = value else { return Err(bad_request(format!("{key} must be a string"))) };
        let s = if rule.trim { js_trim(value) } else { value.as_str() };
        let length = char_len(s);
        if length < rule.min.unwrap_or(1) {
            return Err(bad_request(match rule.min {
                None | Some(1) => format!("{key} is required"),
                _ => format!("{key} is too short"),
            }));
        }
        if length > rule.max {
            return Err(bad_request(format!("{key} must be at most {} characters", rule.max)));
        }
        Ok(s.to_string())
    }

    pub fn string(&self, key: &str, rule: StringRule) -> Result<String> {
        // `undefined` is not a string either.
        match self.data.get(key) {
            Some(value) => self.check_string(key, value, rule),
            None => Err(bad_request(format!("{key} must be a string"))),
        }
    }

    pub fn optional_string(&self, key: &str, rule: StringRule) -> Result<Option<String>> {
        self.data.get(key).map(|value| self.check_string(key, value, rule)).transpose()
    }

    /// Absent when the key is missing, null when explicitly null or blank.
    pub fn nullable_string(&self, key: &str, rule: StringRule) -> Result<Nullable<String>> {
        match self.data.get(key) {
            None => Ok(Nullable::Absent),
            Some(Value::Null) => Ok(Nullable::Null),
            Some(Value::String(s)) if js_trim(s).is_empty() => Ok(Nullable::Null),
            Some(value) => self.check_string(key, value, StringRule { min: Some(0), ..rule }).map(Nullable::Value),
        }
    }

    pub fn boolean(&self, key: &str) -> Result<Option<bool>> {
        match self.data.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(Value::String(s)) if s == "1" || s == "true" => Ok(Some(true)),
            Some(Value::String(s)) if s == "0" || s == "false" || s.is_empty() => Ok(Some(false)),
            Some(_) => Err(bad_request(format!("{key} must be a boolean"))),
        }
    }

    pub fn integer(&self, key: &str, min: i64, max: i64) -> Result<Option<i64>> {
        let n = match self.data.get(key) {
            None => return Ok(None),
            Some(Value::String(s)) if s.is_empty() => return Ok(None),
            Some(Value::String(s)) => string_to_number(s),
            Some(Value::Number(n)) => number_value(n),
            Some(_) => f64::NAN,
        };
        if !n.is_finite() || n != n.trunc() || n < min as f64 || n > max as f64 {
            return Err(bad_request(format!("{key} must be an integer between {min} and {max}")));
        }
        Ok(Some(n as i64))
    }

    pub fn uuid(&self, key: &str) -> Result<String> {
        match self.data.get(key) {
            Some(Value::String(s)) if is_uuid(s) => Ok(s.to_lowercase()),
            _ => Err(bad_request(format!("{key} must be a valid id"))),
        }
    }

    /// Absent when missing, null when null or `""`.
    pub fn optional_uuid(&self, key: &str) -> Result<Nullable<String>> {
        match self.data.get(key) {
            None => Ok(Nullable::Absent),
            Some(Value::Null) => Ok(Nullable::Null),
            Some(Value::String(s)) if s.is_empty() => Ok(Nullable::Null),
            Some(_) => self.uuid(key).map(Nullable::Value),
        }
    }

    /// A list of ids, lower-cased and deduplicated in order.
    pub fn uuids(&self, key: &str, max_items: usize) -> Result<Option<Vec<String>>> {
        let Some(value) = self.data.get(key) else { return Ok(None) };
        let items = match value {
            Value::Array(items) if items.len() <= max_items => items,
            _ => return Err(bad_request(format!("{key} must be a list of at most {max_items} ids"))),
        };
        let mut out: Vec<String> = Vec::with_capacity(items.len());
        for item in items {
            match item {
                Value::String(s) if is_uuid(s) => {
                    let id = s.to_lowercase();
                    if !out.contains(&id) {
                        out.push(id);
                    }
                }
                _ => return Err(bad_request(format!("{key} must contain valid ids"))),
            }
        }
        Ok(Some(out))
    }

    pub fn strings(&self, key: &str, max_items: usize, rule: StringRule) -> Result<Option<Vec<String>>> {
        let Some(value) = self.data.get(key) else { return Ok(None) };
        let items = match value {
            Value::Array(items) if items.len() <= max_items => items,
            _ => return Err(bad_request(format!("{key} must be a list of at most {max_items} items"))),
        };
        items.iter().map(|item| self.check_string(key, item, rule)).collect::<Result<Vec<_>>>().map(Some)
    }

    pub fn one_of(&self, key: &str, values: &[&str]) -> Result<Option<String>> {
        match self.data.get(key) {
            None => Ok(None),
            Some(Value::String(s)) if values.contains(&s.as_str()) => Ok(Some(s.clone())),
            Some(_) => Err(bad_request(format!("{key} must be one of {}", values.join(", ")))),
        }
    }

    pub fn object(&self, key: &str) -> Result<Option<&Map<String, Value>>> {
        match self.data.get(key) {
            None => Ok(None),
            Some(Value::Object(map)) => Ok(Some(map)),
            Some(_) => Err(bad_request(format!("{key} must be an object"))),
        }
    }
}

/// The characters JavaScript's `\s` matches, for use inside a `regex` character class.
pub const JS_SPACE: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

fn email_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let part = format!(r#"[^{JS_SPACE}@<>()\[\]\\,;:"]+"#);
        Regex::new(&format!("^{part}@{part}\\.{part}$")).expect("email pattern")
    })
}

/// `normalizeEmail`: trimmed, lower-cased, at most 254 characters, shaped like an address.
pub fn normalize_email(value: &str) -> Result<String> {
    let email = js_trim(value).to_lowercase();
    if utf16_len(&email) > 254 || !email_re().is_match(&email) {
        return Err(bad_request("Invalid email address"));
    }
    Ok(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn of(value: Value) -> Input {
        input(value.as_object().unwrap().clone())
    }

    fn message<T: std::fmt::Debug>(result: Result<T>) -> String {
        result.unwrap_err().to_string()
    }

    #[test]
    fn strings() {
        let i = of(json!({ "a": "  hi  ", "b": 5, "c": "", "d": null, "e": "😀😀😀", "f": "   " }));
        assert_eq!(i.string("a", max(10)).unwrap(), "hi");
        assert_eq!(i.string("a", StringRule { trim: false, ..max(10) }).unwrap(), "  hi  ");
        assert_eq!(message(i.string("b", max(10))), "b must be a string");
        assert_eq!(message(i.string("zz", max(10))), "zz must be a string");
        assert_eq!(message(i.string("c", max(10))), "c is required");
        assert_eq!(message(i.string("a", min_max(3, 10))), "a is too short");
        assert_eq!(i.string("e", max(3)).unwrap(), "😀😀😀");
        assert_eq!(message(i.string("e", max(2))), "e must be at most 2 characters");
        assert_eq!(i.optional_string("zz", max(1)).unwrap(), None);
        assert_eq!(i.nullable_string("zz", max(5)).unwrap(), Nullable::Absent);
        assert_eq!(i.nullable_string("d", max(5)).unwrap(), Nullable::Null);
        assert_eq!(i.nullable_string("f", max(5)).unwrap(), Nullable::Null);
        assert_eq!(i.nullable_string("a", max(5)).unwrap(), Nullable::Value("hi".into()));
        assert_eq!(message(i.nullable_string("b", max(5))), "b must be a string");
    }

    #[test]
    fn booleans_integers_and_ids() {
        let i = of(json!({ "t": true, "s": "1", "e": "", "n": 1, "i": 5, "f": 5.5, "q": "7", "x": "abc", "nul": null,
            "id": "0123ABCD-89ef-4567-89ab-0123456789AB", "ids": ["0123ABCD-89ef-4567-89ab-0123456789AB", "0123abcd-89ef-4567-89ab-0123456789ab"], "bad": ["x"] }));
        assert_eq!(i.boolean("t").unwrap(), Some(true));
        assert_eq!(i.boolean("s").unwrap(), Some(true));
        assert_eq!(i.boolean("e").unwrap(), Some(false));
        assert_eq!(message(i.boolean("n")), "n must be a boolean");
        assert_eq!(i.integer("i", 1, 10).unwrap(), Some(5));
        assert_eq!(i.integer("q", 1, 10).unwrap(), Some(7));
        assert_eq!(i.integer("e", 1, 10).unwrap(), None);
        assert_eq!(message(i.integer("f", 1, 10)), "f must be an integer between 1 and 10");
        assert_eq!(message(i.integer("x", 1, 10)), "x must be an integer between 1 and 10");
        assert_eq!(message(i.integer("nul", 1, 10)), "nul must be an integer between 1 and 10");
        assert_eq!(message(i.integer("i", 6, 10)), "i must be an integer between 6 and 10");
        assert_eq!(i.uuid("id").unwrap(), "0123abcd-89ef-4567-89ab-0123456789ab");
        assert_eq!(message(i.uuid("x")), "x must be a valid id");
        assert_eq!(i.optional_uuid("nul").unwrap(), Nullable::Null);
        assert_eq!(i.optional_uuid("e").unwrap(), Nullable::Null);
        assert_eq!(i.optional_uuid("zz").unwrap(), Nullable::Absent);
        assert_eq!(i.uuids("ids", 5).unwrap().unwrap().len(), 1);
        assert_eq!(message(i.uuids("ids", 1)), "ids must be a list of at most 1 ids");
        assert_eq!(message(i.uuids("bad", 5)), "bad must contain valid ids");
        assert_eq!(message(i.one_of("x", &["a", "b"])), "x must be one of a, b");
        assert_eq!(message(i.object("x")), "x must be an object");
    }

    #[test]
    fn emails() {
        assert_eq!(normalize_email("  Owner@Example.COM ").unwrap(), "owner@example.com");
        for bad in ["a@b", "a b@c.d", "a@b@c.d", "<a>@b.c", "a@b.c,d", "@b.c", "a@.c"] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
        assert!(normalize_email("ü@exämple.de").is_ok());
    }
}
