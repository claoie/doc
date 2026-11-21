//! JavaScript `Date` behaviour the ported code depends on.
//!
//! A JavaScript date is a *time value*: milliseconds since 1970-01-01T00:00Z
//! as a double, whole, at most 8.64e15 in magnitude, or NaN for an invalid
//! date. This module works on such doubles directly:
//!
//! - [`time_clip`] is what `new Date(value)` keeps of a number;
//! - [`date_utc`] is `Date.UTC(...)`;
//! - [`utc_fields`], [`to_iso_string`] and [`set_utc_date`] are the UTC
//!   getters, `toISOString` and `setUTCDate`;
//! - [`date_parse`] is `Date.parse(text)` as Bun 1.4 implements it.
//!
//! `Date.parse` is the part with the most behaviour. Bun's parser accepts an
//! ISO 8601 date-time and, when the text is not one, carries on with a
//! forgiving "legacy" reading of the remaining tokens: month names, `AM`/`PM`,
//! zone abbreviations, `m/d/y`, bare numbers and so on (`"1"` is 1 January
//! 2001). The algorithm here was reconstructed from Bun's observable results
//! and is held to them by `tests/dates.rs` on some twenty thousand strings in
//! each of three time zones.
//!
//! Text without a zone is local time. The local zone is the `TZ` environment
//! variable when it names an IANA zone and UTC otherwise; the parser takes
//! the zone as a parameter ([`date_parse_in`]) so the tests can check zones
//! other than the process's own. Offsets come from the zone database compiled
//! into `chrono-tz`, where Bun asks ICU: the two agree wherever they hold the
//! same edition of the IANA data.

use std::sync::OnceLock;

use chrono::{DateTime, Offset, TimeZone};
use chrono_tz::Tz;

use crate::jsutil::is_js_whitespace;

/// The largest magnitude of a valid time value: 100,000,000 days.
pub const MAX_TIME_VALUE: f64 = 8.64e15;

const MS_PER_SECOND: f64 = 1_000.0;
const MS_PER_MINUTE: f64 = 60_000.0;
const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_DAY: f64 = 86_400_000.0;
const MS_PER_DAY_INT: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// The calendar

/// Days from 1970-01-01 to the given day of the proleptic Gregorian calendar
/// (`month` is 1-based).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The inverse of [`days_from_civil`]: `(year, month 1-12, day 1-31)`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

// ---------------------------------------------------------------------------
// Time values

/// `TimeClip`: what `new Date(value)` stores. NaN when the value is not
/// finite or beyond [`MAX_TIME_VALUE`]; otherwise the value without its
/// fraction (and never `-0`).
pub fn time_clip(time: f64) -> f64 {
    if !time.is_finite() || time.abs() > MAX_TIME_VALUE {
        return f64::NAN;
    }
    time.trunc() + 0.0
}

/// Whether `new Date(value)` is a valid date.
pub fn is_valid_time(time: f64) -> bool {
    time.is_finite() && time.abs() <= MAX_TIME_VALUE
}

/// `MakeTime`: milliseconds within a day from clock fields, each truncated
/// first. The fields may be out of range (25 hours, -1 seconds).
pub fn make_time(hours: f64, minutes: f64, seconds: f64, milliseconds: f64) -> f64 {
    if !hours.is_finite() || !minutes.is_finite() || !seconds.is_finite() || !milliseconds.is_finite() {
        return f64::NAN;
    }
    hours.trunc() * MS_PER_HOUR + minutes.trunc() * MS_PER_MINUTE + seconds.trunc() * MS_PER_SECOND + milliseconds.trunc()
}

/// `MakeDay`: the day number of a year, 0-based month and day of month, each
/// truncated first. Months and days out of range roll over. Bun gives NaN
/// when the year, after adding the months' overflow, does not fit a 32-bit
/// integer.
pub fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !year.is_finite() || !month.is_finite() || !date.is_finite() {
        return f64::NAN;
    }
    let (year, month, date) = (year.trunc(), month.trunc(), date.trunc());
    let carry = (month / 12.0).floor();
    let full_year = year + carry;
    if !(full_year >= f64::from(i32::MIN) && full_year <= f64::from(i32::MAX)) {
        return f64::NAN;
    }
    let month_in_year = month - carry * 12.0;
    let days = days_from_civil(full_year as i64, month_in_year as i64 + 1, 1);
    days as f64 + date - 1.0
}

/// `MakeDate`: a day number and the time within the day as one time value.
pub fn make_date(day: f64, time: f64) -> f64 {
    if !day.is_finite() || !time.is_finite() {
        return f64::NAN;
    }
    let value = day * MS_PER_DAY + time;
    if value.is_finite() {
        value
    } else {
        f64::NAN
    }
}

/// `Date.UTC(year, month?, date?, hours?, minutes?, seconds?, ms?)` for
/// arguments already converted to numbers. A missing year is NaN, a missing
/// month is 0, a missing day is 1 and the rest default to 0. Years that
/// truncate to 0..=99 mean 1900..=1999, as in JavaScript.
pub fn date_utc(args: &[f64]) -> f64 {
    let arg = |index: usize, default: f64| args.get(index).copied().unwrap_or(default);
    let year = arg(0, f64::NAN);
    let year = if year.is_nan() {
        year
    } else {
        let whole = year.trunc();
        if (0.0..=99.0).contains(&whole) {
            1900.0 + whole
        } else {
            year
        }
    };
    let day = make_day(year, arg(1, 0.0), arg(2, 1.0));
    let time = make_time(arg(3, 0.0), arg(4, 0.0), arg(5, 0.0), arg(6, 0.0));
    time_clip(make_date(day, time))
}

/// The UTC calendar and clock fields of a date. `month` is 0-based and
/// `weekday` counts from Sunday = 0, as the JavaScript getters do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateFields {
    pub year: i64,
    pub month: i64,
    pub date: i64,
    pub hours: i64,
    pub minutes: i64,
    pub seconds: i64,
    pub milliseconds: i64,
    pub weekday: i64,
}

/// The fields of `new Date(value)`: `getUTCFullYear()`, `getUTCMonth()` and
/// so on. `None` for an invalid date, where the getters return NaN.
pub fn utc_fields(value: f64) -> Option<DateFields> {
    let time = time_clip(value);
    if time.is_nan() {
        return None;
    }
    let time = time as i64;
    let days = time.div_euclid(MS_PER_DAY_INT);
    let in_day = time.rem_euclid(MS_PER_DAY_INT);
    let (year, month, date) = civil_from_days(days);
    Some(DateFields {
        year,
        month: month - 1,
        date,
        hours: in_day / 3_600_000,
        minutes: in_day / 60_000 % 60,
        seconds: in_day / 1_000 % 60,
        milliseconds: in_day % 1_000,
        weekday: (days + 4).rem_euclid(7),
    })
}

/// `new Date(value).toISOString()`. `None` where JavaScript throws a
/// RangeError (an invalid date). Years outside 0..=9999 are written with a
/// sign and six digits.
pub fn to_iso_string(value: f64) -> Option<String> {
    let f = utc_fields(value)?;
    let year =
        if (0..=9999).contains(&f.year) { format!("{:04}", f.year) } else { format!("{}{:06}", if f.year < 0 { '-' } else { '+' }, f.year.abs()) };
    Some(format!("{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", f.month + 1, f.date, f.hours, f.minutes, f.seconds, f.milliseconds))
}

/// `date.setUTCDate(day)` on `new Date(value)`: the new time value. The day
/// may be out of range (0 is the last day of the previous month); an invalid
/// date stays invalid.
pub fn set_utc_date(value: f64, day: f64) -> f64 {
    let Some(f) = utc_fields(value) else {
        return f64::NAN;
    };
    let in_day = time_clip(value).rem_euclid(MS_PER_DAY);
    time_clip(make_date(make_day(f.year as f64, f.month as f64, day), in_day))
}

// ---------------------------------------------------------------------------
// The local time zone

/// The zone that text without an offset is read in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Utc,
    Named(Tz),
}

/// The first and last year of the window that far-future years are mapped
/// into. The zone tables hold explicit transitions up to 2099 only; later
/// years follow the same rules, so a later instant is looked up in a year of
/// this window with the same calendar (leap or not, same weekday on 1
/// January). 28 consecutive years without a skipped leap year hold all 14
/// calendars.
///
/// A zone whose clocks no longer change by the end of the table has no such
/// rules; it keeps its last offset. (Morocco is the case that matters: its
/// table lists every Ramadan up to 2087 and nothing after.)
const EQUIVALENT_YEARS: std::ops::RangeInclusive<i64> = 2072..=2099;

/// The middle of each month of the last year of the zone tables, 2099.
const LAST_TABLE_YEAR_MONTHS: [i64; 12] = {
    let mut instants = [0; 12];
    let mut month = 0;
    while month < 12 {
        // 2099-01-15T00:00Z, then steps of a twelfth of a year.
        instants[month] = 4_072_118_400_000 + month as i64 * 2_629_800_000;
        month += 1;
    }
    instants
};

/// Instants before this (the start of 1700) read the zone's first entry,
/// its local mean time: no zone has a transition that early.
const FIRST_TABLE_INSTANT: i64 = -8_520_336_000_000;

impl Zone {
    /// The zone with an IANA name such as `Europe/Berlin` (case-insensitive).
    pub fn from_name(name: &str) -> Option<Zone> {
        Tz::from_str_insensitive(name).ok().map(Zone::Named)
    }

    /// The zone the `TZ` environment variable names, UTC when it is unset or
    /// not an IANA name.
    pub fn from_env() -> Zone {
        Zone::from_tz(std::env::var("TZ").ok().as_deref())
    }

    /// The zone for a value of `TZ`, as Bun reads it: an IANA name in any
    /// case, optionally after a colon or `posix/`; anything else (a POSIX rule
    /// such as `GMT+1`, a file path, stray spaces) is UTC.
    fn from_tz(value: Option<&str>) -> Zone {
        let Some(value) = value else {
            return Zone::Utc;
        };
        let name = value.strip_prefix(':').unwrap_or(value);
        let name = name.strip_prefix("posix/").unwrap_or(name);
        Zone::from_name(name).unwrap_or(Zone::Utc)
    }

    /// Milliseconds east of UTC at an instant.
    pub fn offset_at(&self, utc_ms: i64) -> i64 {
        let Zone::Named(tz) = self else {
            return 0;
        };
        let table = |instant: i64| match DateTime::from_timestamp_millis(instant) {
            Some(at) => i64::from(tz.offset_from_utc_datetime(&at.naive_utc()).fix().local_minus_utc()) * 1_000,
            None => 0,
        };
        let instant = utc_ms.max(FIRST_TABLE_INSTANT);
        let (year, _, _) = civil_from_days(instant.div_euclid(MS_PER_DAY_INT));
        if year <= *EQUIVALENT_YEARS.end() {
            return table(instant);
        }
        let last = table(LAST_TABLE_YEAR_MONTHS[11]);
        if LAST_TABLE_YEAR_MONTHS.iter().all(|month| table(*month) == last) {
            return last;
        }
        table(instant - days_to_equivalent_year(year) * MS_PER_DAY_INT)
    }

    /// The instant of a local wall-clock time, given as if it were UTC.
    ///
    /// A wall-clock time that a clock change skips or repeats is read with
    /// the offset in force *before* the change: 02:30 on the night clocks go
    /// forward is taken as standard time, and 01:30 on the night they go back
    /// is the first 01:30. That is what Bun does.
    ///
    /// A wall-clock time just outside the range of time values can still be
    /// a valid instant: before the first one in zones west of Greenwich,
    /// after the last one east of it. Bun does not look such a time up where
    /// it is but on the same day of a recent year with the same calendar
    /// ([`recent_equivalent`]), with whatever rules the zone had that year.
    pub fn local_to_utc(&self, local_ms: f64) -> f64 {
        if matches!(self, Zone::Utc) || !local_ms.is_finite() || local_ms.abs() > MAX_TIME_VALUE + MS_PER_DAY {
            return local_ms;
        }
        let local = local_ms as i64;
        let lookup = if local_ms.abs() > MAX_TIME_VALUE { recent_equivalent(local) } else { local };
        // The offsets a day either side bracket any change close to this time.
        let before = self.offset_at(lookup - MS_PER_DAY_INT);
        let after = self.offset_at(lookup + MS_PER_DAY_INT);
        let offset =
            if before == after || self.offset_at(lookup - before) == before || self.offset_at(lookup - after) != after { before } else { after };
        (local - offset) as f64
    }
}

/// The same month, day and time of day in a year from 2008 to 2035 that has
/// the calendar of the given time's year. Which of the candidate years it is
/// was read off Bun's answers in zones whose rules changed in that period:
/// the year of the last time value, 275760, stands in 2008 and that of the
/// first, -271821, in 2027.
fn recent_equivalent(local_ms: i64) -> i64 {
    let (year, month, day) = civil_from_days(local_ms.div_euclid(MS_PER_DAY_INT));
    let weekday = (days_from_civil(year, 1, 1) + 4).rem_euclid(7);
    let recent = if is_leap_year(year) { 1956 } else { 1967 } + weekday * 12 % 28;
    let equivalent = 2008 + (recent + 3 * 28 - 2008) % 28;
    days_from_civil(equivalent, month, day) * MS_PER_DAY_INT + local_ms.rem_euclid(MS_PER_DAY_INT)
}

/// How many days after the same calendar day of its equivalent year a day
/// of `year` falls: the year of [`EQUIVALENT_YEARS`] with the same length
/// and the same weekday on 1 January.
fn days_to_equivalent_year(year: i64) -> i64 {
    let start = days_from_civil(year, 1, 1);
    let twin = EQUIVALENT_YEARS
        .clone()
        .find(|y| is_leap_year(*y) == is_leap_year(year) && (days_from_civil(*y, 1, 1) - start).rem_euclid(7) == 0)
        .expect("28 years hold every calendar");
    start - days_from_civil(twin, 1, 1)
}

static LOCAL_ZONE: OnceLock<Zone> = OnceLock::new();

/// The process's local zone: [`Zone::from_env`], read once.
pub fn local_zone() -> Zone {
    *LOCAL_ZONE.get_or_init(Zone::from_env)
}

/// Fixes the local zone instead of reading `TZ`. Only effective before the
/// first use; returns whether the local zone now is `zone`. The tests call
/// this so their expectations do not depend on the environment.
pub fn set_local_zone(zone: Zone) -> bool {
    *LOCAL_ZONE.get_or_init(|| zone) == zone
}

// ---------------------------------------------------------------------------
// Date.parse

/// `Date.parse(text)` in the process's local zone: a time value, NaN when
/// the text is not a date.
pub fn date_parse(text: &str) -> f64 {
    date_parse_in(text, &local_zone())
}

/// `Date.parse(text)` where text without an offset is local time in `zone`.
pub fn date_parse_in(text: &str, zone: &Zone) -> f64 {
    let Some(parsed) = parse(text) else {
        return f64::NAN;
    };
    let day = make_day(f64::from(parsed.year), f64::from(parsed.month - 1), f64::from(parsed.day));
    let time = make_time(f64::from(parsed.hour), f64::from(parsed.minute), f64::from(parsed.second), f64::from(parsed.millisecond));
    let date = make_date(day, time);
    let utc = match parsed.utc_offset_seconds {
        Some(offset) => date - offset as f64 * MS_PER_SECOND,
        None => zone.local_to_utc(date),
    };
    time_clip(utc)
}

/// The largest number of digits of a numeral that count; further digits are
/// read but ignored (not even as zeros).
const MAX_SIGNIFICANT_DIGITS: i32 = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Invalid,
    MonthName,
    AmPm,
    TimeZoneName,
    TimeSeparator,
}

/// The words the parser knows, by their first three letters in lower case.
/// A month matches on its first three letters whatever follows ("Marxyz");
/// the other words must match whole.
const KEYWORDS: [(&[u8], Keyword, i32); 27] = [
    (b"jan", Keyword::MonthName, 1),
    (b"feb", Keyword::MonthName, 2),
    (b"mar", Keyword::MonthName, 3),
    (b"apr", Keyword::MonthName, 4),
    (b"may", Keyword::MonthName, 5),
    (b"jun", Keyword::MonthName, 6),
    (b"jul", Keyword::MonthName, 7),
    (b"aug", Keyword::MonthName, 8),
    (b"sep", Keyword::MonthName, 9),
    (b"oct", Keyword::MonthName, 10),
    (b"nov", Keyword::MonthName, 11),
    (b"dec", Keyword::MonthName, 12),
    (b"am", Keyword::AmPm, 0),
    (b"pm", Keyword::AmPm, 12),
    (b"ut", Keyword::TimeZoneName, 0),
    (b"utc", Keyword::TimeZoneName, 0),
    (b"z", Keyword::TimeZoneName, 0),
    (b"gmt", Keyword::TimeZoneName, 0),
    (b"cdt", Keyword::TimeZoneName, -5),
    (b"cst", Keyword::TimeZoneName, -6),
    (b"edt", Keyword::TimeZoneName, -4),
    (b"est", Keyword::TimeZoneName, -5),
    (b"mdt", Keyword::TimeZoneName, -6),
    (b"mst", Keyword::TimeZoneName, -7),
    (b"pdt", Keyword::TimeZoneName, -7),
    (b"pst", Keyword::TimeZoneName, -8),
    (b"t", Keyword::TimeSeparator, 0),
];

fn lookup_keyword(prefix: &[u32; 3], length: i32) -> (Keyword, i32) {
    for (word, kind, value) in KEYWORDS {
        let matches = (0..3).all(|i| prefix[i] == word.get(i).map_or(0, |b| u32::from(*b)));
        if matches && (length <= 3 || kind == Keyword::MonthName) {
            return (kind, value);
        }
    }
    (Keyword::Invalid, 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    Number { value: i32, length: i32 },
    Symbol(u8),
    WhiteSpace,
    Keyword { kind: Keyword, value: i32, length: i32 },
    Unknown,
    EndOfInput,
}

impl Token {
    fn is_number(self) -> bool {
        matches!(self, Token::Number { .. })
    }

    /// A numeral of exactly `digits` digits (leading zeros count).
    fn fixed_number(self, digits: i32) -> Option<i32> {
        match self {
            Token::Number { value, length } if length == digits => Some(value),
            _ => None,
        }
    }

    fn is_symbol(self, symbol: u8) -> bool {
        self == Token::Symbol(symbol)
    }

    /// `+1` or `-1` for a sign.
    fn sign(self) -> Option<i32> {
        match self {
            Token::Symbol(b'+') => Some(1),
            Token::Symbol(b'-') => Some(-1),
            _ => None,
        }
    }

    fn is_keyword_z(self) -> bool {
        matches!(self, Token::Keyword { kind: Keyword::TimeZoneName, value: 0, length: 1 })
    }
}

/// Splits the text into tokens with one token of lookahead.
///
/// A NUL character ends the input. Letters are anything from `A` up that is
/// not white space, so punctuation such as `_` or `[` and every non-ASCII
/// letter make "words" too.
struct Scanner<'a> {
    chars: std::str::Chars<'a>,
    /// The current character, 0 at the end of input.
    ch: u32,
    next: Token,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        let mut scanner = Scanner { chars: text.chars(), ch: 0, next: Token::EndOfInput };
        scanner.advance();
        scanner.next = scanner.scan();
        scanner
    }

    fn advance(&mut self) {
        self.ch = self.chars.next().map_or(0, u32::from);
    }

    /// White space to the date parser: JavaScript's, except the vertical
    /// tab (ignored like punctuation) and the line and paragraph separators
    /// U+2028 and U+2029 (letters to it).
    fn is_white_space(&self) -> bool {
        !matches!(self.ch, 0x0B | 0x2028 | 0x2029) && char::from_u32(self.ch).is_some_and(is_js_whitespace)
    }

    fn skip(&mut self, ch: u8) -> bool {
        if self.ch == u32::from(ch) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn scan(&mut self) -> Token {
        if self.ch == 0 {
            return Token::EndOfInput;
        }
        if (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch) {
            let mut value: i32 = 0;
            let mut length = 0;
            let mut significant = 0;
            while self.ch == u32::from(b'0') {
                self.advance();
                length += 1;
            }
            while (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch) {
                if significant < MAX_SIGNIFICANT_DIGITS {
                    value = value * 10 + (self.ch - u32::from(b'0')) as i32;
                }
                significant += 1;
                length += 1;
                self.advance();
            }
            return Token::Number { value, length };
        }
        for symbol in *b":-+.)" {
            if self.skip(symbol) {
                return Token::Symbol(symbol);
            }
        }
        if self.ch >= u32::from(b'A') && !self.is_white_space() {
            let mut prefix = [0u32; 3];
            let mut length = 0;
            while self.ch >= u32::from(b'A') && !self.is_white_space() {
                if length < 3 {
                    prefix[length] = self.ch | 0x20;
                }
                length += 1;
                self.advance();
            }
            let length = i32::try_from(length).unwrap_or(i32::MAX);
            let (kind, value) = lookup_keyword(&prefix, length);
            return Token::Keyword { kind, value, length };
        }
        if self.is_white_space() {
            self.advance();
            return Token::WhiteSpace;
        }
        if self.ch == u32::from(b'(') {
            // A parenthesized comment, with nesting; an unclosed one runs to the end.
            let mut balance = 0;
            loop {
                if self.ch == u32::from(b')') {
                    balance -= 1;
                } else if self.ch == u32::from(b'(') {
                    balance += 1;
                }
                self.advance();
                if balance <= 0 || self.ch == 0 {
                    break;
                }
            }
            return Token::Unknown;
        }
        self.advance();
        Token::Unknown
    }

    fn peek(&self) -> Token {
        self.next
    }

    fn next(&mut self) -> Token {
        let token = self.next;
        self.next = self.scan();
        token
    }

    fn skip_symbol(&mut self, symbol: u8) -> bool {
        if self.next.is_symbol(symbol) {
            self.next = self.scan();
            true
        } else {
            false
        }
    }
}

fn between(x: i32, low: i32, high: i32) -> bool {
    x >= low && x <= high
}
fn is_month(x: i32) -> bool {
    between(x, 1, 12)
}
fn is_day(x: i32) -> bool {
    between(x, 1, 31)
}
fn is_hour(x: i32) -> bool {
    between(x, 0, 23)
}
fn is_minute(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_second(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_millisecond(x: i32) -> bool {
    between(x, 0, 999)
}

/// Up to three numbers of a date, in the order they were written, and a
/// month given by name.
#[derive(Default)]
struct DayComposer {
    components: Vec<i32>,
    named_month: Option<i32>,
    is_iso_date: bool,
}

impl DayComposer {
    fn add(&mut self, n: i32) -> bool {
        if self.components.len() < 3 {
            self.components.push(n);
            true
        } else {
            false
        }
    }

    /// `(year, month 1-12, day)`. Missing numbers are 1. Without a month
    /// name the order is year-month-day when the first number cannot be a
    /// day, and month-day-year otherwise; with one, the first number is the
    /// day unless it cannot be. Two-digit years mean 1950..=2049, except in
    /// an ISO date.
    fn write(mut self) -> Option<(i32, i32, i32)> {
        if self.components.is_empty() {
            return None;
        }
        self.components.resize(3, 1);
        let c = &self.components;
        let (mut year, month, day) = match self.named_month {
            None if self.is_iso_date || !is_day(c[0]) => (c[0], c[1], c[2]),
            None => (c[2], c[0], c[1]),
            Some(month) if !is_day(c[0]) => (c[0], month, c[1]),
            Some(month) => (c[1], month, c[0]),
        };
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        (is_month(month) && is_day(day)).then_some((year, month, day))
    }
}

/// Up to four numbers of a clock time and an `AM`/`PM` marker.
#[derive(Default)]
struct TimeComposer {
    components: Vec<i32>,
    hour_offset: Option<i32>,
}

impl TimeComposer {
    fn is_empty(&self) -> bool {
        self.components.is_empty()
    }

    /// Whether `n` can be the next field: minutes after the hour, then
    /// seconds, then milliseconds.
    fn is_expecting(&self, n: i32) -> bool {
        match self.components.len() {
            1 => is_minute(n),
            2 => is_second(n),
            3 => is_millisecond(n),
            _ => false,
        }
    }

    fn add(&mut self, n: i32) -> bool {
        if self.components.len() < 4 {
            self.components.push(n);
            true
        } else {
            false
        }
    }

    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        self.components.resize(4, 0);
        true
    }

    fn write(mut self) -> Option<(i32, i32, i32, i32)> {
        self.components.resize(4, 0);
        let (mut hour, minute, second, millisecond) = (self.components[0], self.components[1], self.components[2], self.components[3]);
        if let Some(offset) = self.hour_offset {
            if !between(hour, 0, 12) {
                return None;
            }
            hour = hour % 12 + offset;
        }
        let in_range = is_hour(hour) && is_minute(minute) && is_second(second) && is_millisecond(millisecond);
        // 24:00:00.000 is the end of the day.
        if !in_range && (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
            return None;
        }
        Some((hour, minute, second, millisecond))
    }
}

/// A UTC offset: its sign, hours and minutes, each possibly not given.
#[derive(Default)]
struct TimeZoneComposer {
    sign: Option<i32>,
    hour: Option<i32>,
    minute: Option<i32>,
}

impl TimeZoneComposer {
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = Some(if offset_in_hours < 0 { -1 } else { 1 });
        self.hour = Some(offset_in_hours.abs());
        self.minute = Some(0);
    }

    /// Whether `n` can be the minutes of an offset whose hours were followed by a colon.
    fn is_expecting(&self, n: i32) -> bool {
        self.hour.is_some() && self.minute.is_none() && is_minute(n)
    }

    fn is_utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }

    fn is_empty(&self) -> bool {
        self.hour.is_none()
    }

    /// The offset in seconds, `Some(None)` for local time, `None` when the
    /// offset is too large to be one.
    fn write(self) -> Option<Option<i64>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        let seconds = i64::from(self.hour.unwrap_or(0)) * 3_600 + i64::from(self.minute.unwrap_or(0)) * 60;
        if seconds > i64::from(i32::MAX) {
            return None;
        }
        Some(Some(i64::from(sign) * seconds))
    }
}

/// Milliseconds from the digits after a decimal point: the first three
/// digits, the rest dropped. (With more than nine digits and leading zeros
/// the result is off, as it is in Bun: the numeral keeps its first nine
/// *significant* digits but is scaled by its full length.)
fn read_milliseconds(value: i32, length: i32) -> i32 {
    match length {
        1 => value * 100,
        2 => value * 10,
        3 => value,
        _ => {
            let mut factor = 1;
            let mut length = length.min(MAX_SIGNIFICANT_DIGITS);
            while length > 3 {
                factor *= 10;
                length -= 1;
            }
            value / factor
        }
    }
}

struct Parsed {
    year: i32,
    /// 1-12.
    month: i32,
    day: i32,
    hour: i32,
    minute: i32,
    second: i32,
    millisecond: i32,
    /// Seconds east of UTC; `None` for local time.
    utc_offset_seconds: Option<i64>,
}

/// The outcome of the strict ISO 8601 pass.
enum Iso {
    /// The whole text was an ISO date-time.
    Done,
    /// The text stopped being ISO at this token; the legacy pass continues
    /// from it with what was read so far.
    Continue(Token),
    /// The text started a time (`T`) that is malformed: not a date at all.
    Invalid,
}

/// `[+-YY]YYYY[-MM[-DD]][THH:mm[:ss[.s+]][Z|±HH:mm|±HHmm]]`. A date without
/// a time is UTC; a date-time without an offset is local time.
fn parse_iso(scanner: &mut Scanner, day: &mut DayComposer, time: &mut TimeComposer, tz: &mut TimeZoneComposer) -> Iso {
    if let Some(sign) = scanner.peek().sign() {
        let sign_token = scanner.next();
        let Some(year) = scanner.peek().fixed_number(6) else {
            return Iso::Continue(sign_token);
        };
        scanner.next();
        if sign < 0 && year == 0 {
            // "-000000" is not a year. Its digits are already consumed.
            return Iso::Continue(sign_token);
        }
        day.add(sign * year);
    } else if let Some(year) = scanner.peek().fixed_number(4) {
        scanner.next();
        day.add(year);
    } else {
        return Iso::Continue(scanner.next());
    }
    if scanner.skip_symbol(b'-') {
        match scanner.peek().fixed_number(2) {
            Some(month) if is_month(month) => {
                scanner.next();
                day.add(month);
            }
            _ => return Iso::Continue(scanner.next()),
        }
        if scanner.skip_symbol(b'-') {
            match scanner.peek().fixed_number(2) {
                Some(date) if is_day(date) => {
                    scanner.next();
                    day.add(date);
                }
                _ => return Iso::Continue(scanner.next()),
            }
        }
    }
    if !matches!(scanner.peek(), Token::Keyword { kind: Keyword::TimeSeparator, .. }) {
        if scanner.peek() != Token::EndOfInput {
            return Iso::Continue(scanner.next());
        }
    } else {
        scanner.next();
        let Some(hour) = scanner.peek().fixed_number(2).filter(|h| between(*h, 0, 24)) else {
            return Iso::Invalid;
        };
        // 24:00[:00[.0]] is allowed, nothing else in hour 24.
        let hour_is_24 = hour == 24;
        scanner.next();
        time.add(hour);
        if !scanner.skip_symbol(b':') {
            return Iso::Invalid;
        }
        let Some(minute) = scanner.peek().fixed_number(2).filter(|m| is_minute(*m) && !(hour_is_24 && *m > 0)) else {
            return Iso::Invalid;
        };
        scanner.next();
        time.add(minute);
        if scanner.skip_symbol(b':') {
            let Some(second) = scanner.peek().fixed_number(2).filter(|s| is_second(*s) && !(hour_is_24 && *s > 0)) else {
                return Iso::Invalid;
            };
            scanner.next();
            time.add(second);
            if scanner.skip_symbol(b'.') {
                let Token::Number { value, length } = scanner.peek() else {
                    return Iso::Invalid;
                };
                if hour_is_24 && value > 0 {
                    return Iso::Invalid;
                }
                scanner.next();
                time.add(read_milliseconds(value, length));
            }
        }
        if scanner.peek().is_keyword_z() {
            scanner.next();
            tz.set(0);
        } else if let Some(sign) = scanner.peek().sign() {
            scanner.next();
            tz.sign = Some(sign);
            if let Some(hour_minute) = scanner.peek().fixed_number(4) {
                scanner.next();
                let (hour, minute) = (hour_minute / 100, hour_minute % 100);
                if !is_hour(hour) || !is_minute(minute) {
                    return Iso::Invalid;
                }
                tz.hour = Some(hour);
                tz.minute = Some(minute);
            } else {
                let Some(hour) = scanner.peek().fixed_number(2).filter(|h| is_hour(*h)) else {
                    return Iso::Invalid;
                };
                scanner.next();
                tz.hour = Some(hour);
                if !scanner.skip_symbol(b':') {
                    return Iso::Invalid;
                }
                let Some(minute) = scanner.peek().fixed_number(2).filter(|m| is_minute(*m)) else {
                    return Iso::Invalid;
                };
                scanner.next();
                tz.minute = Some(minute);
            }
        }
        if scanner.peek() != Token::EndOfInput {
            return Iso::Invalid;
        }
    }
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    Iso::Done
}

/// Reads a date: the ISO pass first, then the legacy pass over whatever is
/// left.
///
/// In the legacy pass
/// - a number followed by `:` is a clock field (`::` skips the minutes), as
///   is a number after such a field; a number followed by `.` while seconds
///   are expected takes milliseconds after it;
/// - any other number is part of the date, at most three of them;
/// - a month name sets the month; `AM`/`PM` after a time adjusts the hour;
///   a zone name after a number sets the offset; a sign after a time or
///   after `UTC`/`GMT`/`Z` starts a numeric offset (`+1`, `+01:30`, `+0130`);
/// - other words are ignored before the first number (unless a number
///   follows directly) and make the text invalid after it;
/// - punctuation and parenthesized comments are ignored.
fn parse(text: &str) -> Option<Parsed> {
    let mut scanner = Scanner::new(text);
    let mut day = DayComposer::default();
    let mut time = TimeComposer::default();
    let mut tz = TimeZoneComposer::default();

    let mut token = match parse_iso(&mut scanner, &mut day, &mut time, &mut tz) {
        Iso::Invalid => return None,
        Iso::Done => Token::EndOfInput,
        Iso::Continue(token) => token,
    };
    let mut has_read_number = !day.components.is_empty();
    while token != Token::EndOfInput {
        match token {
            Token::Number { value: n, .. } => {
                has_read_number = true;
                if scanner.skip_symbol(b':') {
                    if scanner.skip_symbol(b':') {
                        if !time.is_empty() {
                            return None;
                        }
                        time.add(n);
                        time.add(0);
                    } else {
                        if !time.add(n) {
                            return None;
                        }
                        if scanner.peek().is_symbol(b'.') {
                            scanner.next();
                        }
                    }
                } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                    time.add(n);
                    let Token::Number { value, length } = scanner.peek() else {
                        return None;
                    };
                    scanner.next();
                    time.add_final(read_milliseconds(value, length));
                } else if tz.is_expecting(n) {
                    tz.minute = Some(n);
                } else if time.is_expecting(n) {
                    time.add_final(n);
                    // A finished time must be followed by the end, white space, "Z" or a sign.
                    let peek = scanner.peek();
                    if peek != Token::EndOfInput && peek != Token::WhiteSpace && !peek.is_keyword_z() && peek.sign().is_none() {
                        return None;
                    }
                } else {
                    if !day.add(n) {
                        return None;
                    }
                    scanner.skip_symbol(b'-');
                }
            }
            Token::Keyword { kind, value, .. } => {
                if kind == Keyword::AmPm && !time.is_empty() {
                    time.hour_offset = Some(value);
                } else if kind == Keyword::MonthName {
                    day.named_month = Some(value);
                    scanner.skip_symbol(b'-');
                } else if kind == Keyword::TimeZoneName && has_read_number {
                    tz.set(value);
                } else {
                    // Other words are not allowed once a number was read, nor directly before a number.
                    if has_read_number || scanner.peek().is_number() {
                        return None;
                    }
                }
            }
            Token::Symbol(_) if token.sign().is_some() && (tz.is_utc() || !time.is_empty()) => {
                tz.sign = token.sign();
                let (n, length) = match scanner.peek() {
                    Token::Number { value, length } => {
                        scanner.next();
                        (value, length)
                    }
                    _ => (0, 0),
                };
                has_read_number = true;
                if scanner.peek().is_symbol(b':') {
                    tz.hour = Some(n);
                    tz.minute = None;
                } else if length == 1 || length == 2 {
                    tz.hour = Some(n);
                    tz.minute = Some(0);
                } else if length == 3 || length == 4 {
                    tz.hour = Some(n / 100);
                    tz.minute = Some(n % 100);
                } else {
                    return None;
                }
            }
            Token::Symbol(b'+' | b'-' | b')') if has_read_number => return None,
            _ => {}
        }
        token = scanner.next();
    }

    let (year, month, day) = day.write()?;
    let (hour, minute, second, millisecond) = time.write()?;
    let utc_offset_seconds = tz.write()?;
    Some(Parsed { year, month, day, hour, minute, second, millisecond, utc_offset_seconds })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_round_trips() {
        for days in [-100_000_000i64, -719_468, -1, 0, 1, 59, 60, 11_016, 19_787, 100_000_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(100_000_000), (275_760, 9, 13));
        assert_eq!(civil_from_days(-100_000_000), (-271_821, 4, 20));
    }

    /// What Bun 1.4.4 makes of these values of `TZ` (probed by parsing a
    /// winter and a summer time without an offset under each).
    #[test]
    fn reads_tz_like_bun() {
        let offsets = |value: Option<&str>| {
            let zone = Zone::from_tz(value);
            (zone.offset_at(1_709_632_800_000) / 60_000, zone.offset_at(1_720_173_600_000) / 60_000)
        };
        assert_eq!(offsets(None), (0, 0));
        assert_eq!(offsets(Some("")), (0, 0));
        assert_eq!(offsets(Some("America/New_York")), (-300, -240));
        assert_eq!(offsets(Some(":Europe/Berlin")), (60, 120));
        assert_eq!(offsets(Some("europe/berlin")), (60, 120));
        assert_eq!(offsets(Some("posix/Europe/Berlin")), (60, 120));
        assert_eq!(offsets(Some("Europe/Berlin ")), (0, 0));
        assert_eq!(offsets(Some("/usr/share/zoneinfo/Europe/Berlin")), (0, 0));
        assert_eq!(offsets(Some("nonsense")), (0, 0));
        assert_eq!(offsets(Some("GMT+1")), (0, 0));
        assert_eq!(offsets(Some("UTC+3")), (0, 0));
        assert_eq!(offsets(Some("Etc/GMT-1")), (60, 60));
        assert_eq!(offsets(Some("CET")), (60, 120));
        assert_eq!(offsets(Some("PST8PDT")), (-480, -420));
        assert_eq!(offsets(Some("EST5EDT")), (-300, -240));
        assert_eq!(offsets(Some("Asia/Calcutta")), (330, 330));
        assert_eq!(offsets(Some("US/Eastern")), (-300, -240));
    }

    #[test]
    fn every_year_has_an_equivalent_year() {
        for year in (-271_821..=275_760).step_by(7).chain(2000..2500) {
            let days = days_to_equivalent_year(year);
            let twin = civil_from_days(days_from_civil(year, 1, 1) - days).0;
            assert!(EQUIVALENT_YEARS.contains(&twin), "{year} -> {twin}");
            assert_eq!(is_leap_year(twin), is_leap_year(year), "{year} -> {twin}");
            assert_eq!(days.rem_euclid(7), 0, "{year} -> {twin}");
            // The last day of the year lands on the last day of the twin.
            assert_eq!(civil_from_days(days_from_civil(year, 12, 31) - days), (twin, 12, 31));
        }
    }

    #[test]
    fn date_utc_like_javascript() {
        assert_eq!(date_utc(&[2024.0, 0.0, 1.9]), 1_704_067_200_000.0);
        assert_eq!(date_utc(&[99.9, 0.0, 1.0]), 915_148_800_000.0);
        assert_eq!(date_utc(&[-0.5, 0.0, 1.0]), -2_208_988_800_000.0);
        assert_eq!(date_utc(&[2024.0, 25.0, 400.0]), 1_804_377_600_000.0);
        assert_eq!(date_utc(&[275_760.0, 8.0, 13.0]), 8.64e15);
        assert!(date_utc(&[275_760.0, 8.0, 14.0]).is_nan());
        assert!(date_utc(&[]).is_nan());
        assert!(date_utc(&[2_147_483_648.0, 0.0, 1.0]).is_nan());
        assert_eq!(date_utc(&[5_000_000.0, 0.0, -1_826_212_500.0]), -62_167_305_600_000.0);
    }

    #[test]
    fn iso_strings() {
        assert_eq!(to_iso_string(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(to_iso_string(-1.0).as_deref(), Some("1969-12-31T23:59:59.999Z"));
        assert_eq!(to_iso_string(8.64e15).as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(to_iso_string(-62_198_755_200_000.0).as_deref(), Some("-000001-01-01T00:00:00.000Z"));
        assert_eq!(to_iso_string(8.64e15 + 1.0), None);
        assert_eq!(to_iso_string(f64::NAN), None);
    }

    #[test]
    fn parses_iso_and_legacy_text() {
        let utc = Zone::Utc;
        assert_eq!(date_parse_in("2024-03-05T10:00:00Z", &utc), 1_709_632_800_000.0);
        assert_eq!(date_parse_in("2024-02-30", &utc), 1_709_251_200_000.0);
        assert_eq!(date_parse_in("March 5, 2024 10:00 PM", &utc), 1_709_676_000_000.0);
        assert_eq!(date_parse_in("1", &utc), 978_307_200_000.0);
        assert_eq!(date_parse_in("-000000-01-01", &utc), 978_307_200_000.0);
        assert!(date_parse_in("2024-03-05T10:00:00 +0100", &utc).is_nan());
        assert!(date_parse_in("20240305", &utc).is_nan());
    }

    #[test]
    fn local_time_uses_the_offset_before_a_change() {
        let new_york = Zone::from_name("America/New_York").unwrap();
        assert_eq!(date_parse_in("2024-03-10T02:30:00", &new_york), 1_710_055_800_000.0);
        assert_eq!(date_parse_in("2024-11-03T01:30:00", &new_york), 1_730_611_800_000.0);
        assert_eq!(date_parse_in("2500-07-01T00:00:00", &new_york), 16_740_878_400_000.0);
        assert_eq!(date_parse_in("1800-01-01T00:00:00", &new_york), -5_364_644_638_000.0);
        let berlin = Zone::from_name("Europe/Berlin").unwrap();
        assert_eq!(date_parse_in("2024-03-31T02:30:00", &berlin), 1_711_848_600_000.0);
        assert_eq!(date_parse_in("+275760-09-13T00:00:00", &berlin), 8_639_999_992_800_000.0);
        assert!(date_parse_in("-271821-04-20T00:00:00", &berlin).is_nan());
    }
}
