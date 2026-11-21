//! JavaScript-compatible building blocks.
//!
//! The Bun server (`src/server`) is the reference implementation, and a lot of
//! what it answers is defined by what JavaScript does: string lengths count
//! UTF-16 code units, `String(value)` and `Number(value)` coerce, numbers print
//! the way `Number.prototype.toString` prints them, and JSON written with
//! `JSON.stringify` orders integer-like keys first. Everything ported from
//! `src/common` and `src/server` goes through these helpers instead of the
//! nearest Rust equivalent, so both servers give the same answers.

use serde_json::{Map, Number, Value};

// ---------------------------------------------------------------------------
// Strings

// A JavaScript string is a sequence of UTF-16 code units and may hold half a
// surrogate pair: `"\ud83d"` parses, and `"😀".slice(0, 1)` is one. What Bun
// does with such a string is observable: written as UTF-8 (a text parameter,
// a mail) the half becomes U+FFFD, and `JSON.stringify` writes it as an
// escape, which Postgres refuses in `jsonb`. A Rust string cannot hold a lone
// surrogate, so one rides in a "carrier": the private-use code point
// U+10D800..=U+10DFFF with the same low bits. Everything here that counts or
// cuts UTF-16 units treats a carrier as the single unit it stands for.
// (A real character from that corner of the private-use plane is therefore
// read as a lone surrogate; nothing assigns meaning to those code points.)

const CARRIER_BASE: u32 = 0x10_0000;

/// The carrier of a lone surrogate.
pub fn carrier(unit: u16) -> char {
    debug_assert!((0xD800..=0xDFFF).contains(&unit));
    char::from_u32(CARRIER_BASE + u32::from(unit)).unwrap_or('\u{FFFD}')
}

/// The lone surrogate a carrier stands for.
pub fn carried(ch: char) -> Option<u16> {
    let code = ch as u32;
    (0x10_D800..=0x10_DFFF).contains(&code).then(|| (code - CARRIER_BASE) as u16)
}

fn units_of(ch: char) -> usize {
    if carried(ch).is_some() {
        1
    } else {
        ch.len_utf16()
    }
}

/// The UTF-16 code units of a JavaScript string.
pub fn utf16_units(s: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(s.len());
    let mut pair = [0u16; 2];
    for ch in s.chars() {
        match carried(ch) {
            Some(unit) => units.push(unit),
            None => units.extend_from_slice(ch.encode_utf16(&mut pair)),
        }
    }
    units
}

/// The JavaScript string with these UTF-16 code units; lone surrogates become carriers.
pub fn from_utf16_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied()).map(|unit| unit.unwrap_or_else(|lone| carrier(lone.unpaired_surrogate()))).collect()
}

/// The string as UTF-8 text leaves JavaScript: lone surrogates become U+FFFD
/// (two halves that have come to stand next to each other are a character again).
pub fn to_text(s: &str) -> std::borrow::Cow<'_, str> {
    if s.chars().any(|ch| carried(ch).is_some()) {
        std::borrow::Cow::Owned(char::decode_utf16(utf16_units(s)).map(|unit| unit.unwrap_or('\u{FFFD}')).collect())
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

/// `s.length`: the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(units_of).sum()
}

/// `[...s].length`: the number of code points.
pub fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// The byte offset of the UTF-16 offset `units` in `s`. `None` when it is past
/// the end or falls between the two halves of a surrogate pair.
pub fn utf16_to_byte(s: &str, units: usize) -> Option<usize> {
    if units == 0 {
        return Some(0);
    }
    let mut seen = 0;
    for (index, ch) in s.char_indices() {
        if seen == units {
            return Some(index);
        }
        seen += units_of(ch);
        if seen > units {
            return None;
        }
    }
    if seen == units {
        Some(s.len())
    } else {
        None
    }
}

/// `s.slice(start, end)` for offsets already clamped to `0..=s.length`, in
/// UTF-16 units. `None` when an offset splits a surrogate pair.
pub fn utf16_slice(s: &str, start: usize, end: usize) -> Option<&str> {
    if start >= end {
        // Still validate the offsets so callers see the same failure.
        utf16_to_byte(s, start.min(utf16_len(s)))?;
        return Some("");
    }
    let a = utf16_to_byte(s, start)?;
    let b = utf16_to_byte(s, end)?;
    Some(&s[a..b])
}

/// `s.slice(start, end)` with JavaScript's clamping and negative offsets. A
/// boundary inside a surrogate pair leaves half of it, as a carrier.
pub fn js_slice(s: &str, start: i64, end: Option<i64>) -> String {
    let len = utf16_len(s) as i64;
    let clamp = |v: i64| if v < 0 { (len + v).max(0) } else { v.min(len) };
    let from = clamp(start);
    let to = clamp(end.unwrap_or(len));
    if from >= to {
        return String::new();
    }
    if let Some(whole) = utf16_slice(s, from as usize, to as usize) {
        return whole.to_string();
    }
    from_utf16_units(&utf16_units(s)[from as usize..to as usize])
}

/// The first `count` code points: `[...s].slice(0, count).join("")`.
pub fn take_chars(s: &str, count: usize) -> &str {
    match s.char_indices().nth(count) {
        Some((index, _)) => &s[..index],
        None => s,
    }
}

/// What `String.prototype.trim` strips: ECMAScript WhiteSpace and LineTerminator.
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}' | '\u{000A}' | '\u{000B}' | '\u{000C}' | '\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.trim()`. Rust's `trim` differs on U+0085 and U+FEFF.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// The regular expression class `\s`: the same set `trim` strips.
pub fn is_regex_space(ch: char) -> bool {
    is_js_whitespace(ch)
}

/// `escapeHtml` of `common/editor/html.ts`.
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

const URI_UNRESERVED: &[u8] = b"-_.!~*'()";

/// Whether the JavaScript string holds half a surrogate pair (see the carriers above).
pub fn has_lone_surrogate(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match carried(ch) {
            Some(0xD800..=0xDBFF) => match chars.peek().and_then(|next| carried(*next)) {
                Some(0xDC00..=0xDFFF) => {
                    chars.next();
                }
                _ => return true,
            },
            Some(_) => return true,
            None => {}
        }
    }
    false
}

/// `encodeURIComponent(s)`, or `None` where JavaScript throws a `URIError`:
/// for a string that holds half a surrogate pair.
pub fn try_encode_uri_component(s: &str) -> Option<String> {
    if has_lone_surrogate(s) {
        return None;
    }
    Some(encode_uri_component(&to_text(s)))
}

/// `encodeURIComponent(s)` for a string without half surrogate pairs.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &byte in s.as_bytes() {
        if byte.is_ascii_alphanumeric() || URI_UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(char::from_digit((byte >> 4) as u32, 16).unwrap().to_ascii_uppercase());
            out.push(char::from_digit((byte & 15) as u32, 16).unwrap().to_ascii_uppercase());
        }
    }
    out
}

/// `decodeURIComponent(s)`; `None` where JavaScript throws a `URIError`.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let hex = bytes.get(i + 1..i + 3)?;
        let hi = (hex[0] as char).to_digit(16)?;
        let lo = (hex[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 3;
    }
    // Every escape sequence must decode to well-formed UTF-8; the unescaped
    // parts already are, and a sequence cannot straddle the two.
    String::from_utf8(out).ok()
}

// ---------------------------------------------------------------------------
// Numbers

/// `String(n)` / `n.toString()`.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    // Rust's `{:e}` prints the shortest digits that round-trip, which is what
    // the specification asks for; only the layout differs.
    let formatted = format!("{:e}", n.abs());
    let (mantissa, exponent) = formatted.split_once('e').expect("exponent form");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let point = exponent.parse::<i32>().expect("exponent") + 1;
    let mut out = String::new();
    if n < 0.0 {
        out.push('-');
    }
    if k <= point && point <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(&digits);
    } else {
        let e = point - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// `Number(s)` for a string: the StringToNumber grammar.
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let bytes = t.as_bytes();
    if bytes.len() > 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            let mut value = 0f64;
            for &b in &bytes[2..] {
                match (b as char).to_digit(radix) {
                    Some(d) => value = value * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return value;
        }
    }
    // [+-] (digits [. digits?] | . digits) ([eE] [+-]? digits)?
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return f64::NAN;
        }
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JSON number as a double.
pub fn number_value(n: &Number) -> f64 {
    n.as_f64().unwrap_or(f64::NAN)
}

/// A double as the JSON value JavaScript would write: whole numbers without a
/// fraction, `null` for NaN and the infinities (as `JSON.stringify` does).
pub fn number_json(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n == n.trunc() && n.abs() < 9_007_199_254_740_992.0 {
        return Value::Number(Number::from(n as i64));
    }
    Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)
}

/// `Number.isInteger(value)` for a JSON value.
pub fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            let f = number_value(n);
            f.is_finite() && f == f.trunc()
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Coercions over JSON values. `undefined` is `None` where it can occur.

/// `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(number_value(n)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value)` where the value may be `undefined`.
pub fn js_string_opt(value: Option<&Value>) -> String {
    match value {
        Some(v) => js_string(v),
        None => "undefined".into(),
    }
}

/// `Number(value)`.
pub fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => number_value(n),
        Value::String(s) => string_to_number(s),
        Value::Array(_) => string_to_number(&js_string(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(value)` where the value may be `undefined` (which is NaN).
pub fn js_number_opt(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, js_number)
}

/// `!!value`.
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            let f = number_value(n);
            f != 0.0 && !f.is_nan()
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn js_truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(js_truthy)
}

/// `value ?? fallback` over an attribute lookup: `None` for a missing key or a JSON null.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

// ---------------------------------------------------------------------------
// JSON

/// Rewrites every number the way a round trip through JavaScript would:
/// whole doubles become integers (`1.0` → `1`, `-0` → `0`) and integers past
/// 2^53 become the nearest double.
pub fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            let needs = n.is_f64() || n.as_i64().is_none_or(|i| i.unsigned_abs() > (1u64 << 53));
            if needs {
                let f = number_value(n);
                *value = number_json(f);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(map) => map.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

fn hex4(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 4 {
        return None;
    }
    let mut value = 0u16;
    for byte in &bytes[..4] {
        value = value * 16 + (*byte as char).to_digit(16)? as u16;
    }
    Some(value)
}

/// Rewrites `\uXXXX` escapes of lone surrogates in a JSON text as carriers,
/// which a JSON parser for Rust strings would otherwise refuse.
pub fn carry_lone_surrogates(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("\\ud") && !text.contains("\\uD") {
        return std::borrow::Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) != Some(&b'u') {
            // An escaped character, possibly the backslash itself.
            i += 2;
            continue;
        }
        let Some(unit) = hex4(&bytes[i + 2..]) else {
            i += 2;
            continue;
        };
        if (0xD800..=0xDBFF).contains(&unit) {
            let low = (bytes.get(i + 6) == Some(&b'\\') && bytes.get(i + 7) == Some(&b'u')).then(|| hex4(&bytes[i + 8..])).flatten();
            if low.is_some_and(|low| (0xDC00..=0xDFFF).contains(&low)) {
                i += 12;
                continue;
            }
        }
        if (0xD800..=0xDFFF).contains(&unit) {
            out.push_str(&text[copied..i]);
            out.push(carrier(unit));
            copied = i + 6;
        }
        i += 6;
    }
    out.push_str(&text[copied..]);
    std::borrow::Cow::Owned(out)
}

/// Rewrites number literals too large for a double as the strings
/// `"Infinity"` and `"-Infinity"`. `JSON.parse` reads such a literal as an
/// infinite number, which JSON values here cannot hold; the text reads the
/// same wherever the number is then converted (`Number("Infinity")`,
/// `String(Infinity)`), which is what the server does with numbers it takes.
fn overflowing_numbers_as_text(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    let mut in_string = false;
    let mut copied = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            match byte {
                b'\\' => i += 1,
                b'"' => in_string = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if byte == b'-' || byte.is_ascii_digit() {
            let start = i;
            while i < bytes.len() && matches!(bytes[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                i += 1;
            }
            if text[start..i].parse::<f64>().is_ok_and(f64::is_infinite) {
                out.push_str(&text[copied..start]);
                out.push_str(if byte == b'-' { "\"-Infinity\"" } else { "\"Infinity\"" });
                copied = i;
            }
            continue;
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

fn parse_text_once(text: &str, any_depth: bool) -> Result<Value, serde_json::Error> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    if any_depth {
        deserializer.disable_recursion_limit();
    }
    let value: Value = serde::Deserialize::deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(value)
}

/// `JSON.parse(text)`: half surrogate pairs in escapes are kept (as
/// carriers), numbers are normalized, and a number too large for a double
/// reads as text (see `overflowing_numbers_as_text`). With `any_depth` the
/// caller has bounded the nesting itself.
pub fn parse_json_text(text: &str, any_depth: bool) -> Result<Value, serde_json::Error> {
    let text = carry_lone_surrogates(text);
    let mut value = match parse_text_once(&text, any_depth) {
        Err(error) if error.to_string().starts_with("number out of range") => parse_text_once(&overflowing_numbers_as_text(&text), any_depth)?,
        other => other?,
    };
    normalize_numbers(&mut value);
    Ok(value)
}

/// `JSON.parse(text)`, with numbers normalized.
pub fn parse_json(text: &[u8]) -> Result<Value, serde_json::Error> {
    parse_json_text(&String::from_utf8_lossy(text), false)
}

/// A canonical array index (`"0"`, `"42"`), which JavaScript objects list
/// before their other keys, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>().ok().filter(|n| *n < u64::from(u32::MAX)).map(|n| n as u32)
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => match carried(c) {
                // Half a surrogate pair: well-formed `JSON.stringify` escapes it,
                // unless the other half follows, which makes the character whole.
                Some(high @ 0xD800..=0xDBFF) => match chars.peek().and_then(|next| carried(*next)).filter(|low| (0xDC00..=0xDFFF).contains(low)) {
                    Some(low) => {
                        chars.next();
                        out.push_str(&from_utf16_units(&[high, low]));
                    }
                    None => out.push_str(&format!("\\u{high:04x}")),
                },
                Some(low) => out.push_str(&format!("\\u{low:04x}")),
                None => out.push(c),
            },
        }
    }
    out.push('"');
}

fn write_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = number_value(n);
            if f.is_finite() {
                out.push_str(&number_to_string(f));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => write_json_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_json_object(out, map),
    }
}

fn write_json_object(out: &mut String, map: &Map<String, Value>) {
    out.push('{');
    let mut first = true;
    let mut entry = |out: &mut String, key: &str, value: &Value| {
        if !first {
            out.push(',');
        }
        first = false;
        write_json_string(out, key);
        out.push(':');
        write_json(out, value);
    };
    if map.keys().any(|k| array_index(k).is_some()) {
        let mut indexed: Vec<(u32, &String, &Value)> =
            map.iter().filter_map(|(k, v)| array_index(k).map(|i| (i, k, v))).collect();
        indexed.sort_by_key(|(i, _, _)| *i);
        for (_, key, value) in indexed {
            entry(out, key, value);
        }
        for (key, value) in map.iter().filter(|(k, _)| array_index(k).is_none()) {
            entry(out, key, value);
        }
    } else {
        for (key, value) in map {
            entry(out, key, value);
        }
    }
    out.push('}');
}

/// `JSON.stringify(value)`: byte for byte what the Bun server writes.
pub fn js_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

/// `JSON.stringify(a ?? null) === JSON.stringify(b ?? null)`.
pub fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    const NULL: Value = Value::Null;
    js_json(a.unwrap_or(&NULL)) == js_json(b.unwrap_or(&NULL))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_offsets() {
        let s = "a😀b";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(char_len(s), 3);
        assert_eq!(utf16_slice(s, 0, 1), Some("a"));
        assert_eq!(utf16_slice(s, 1, 3), Some("😀"));
        assert_eq!(utf16_slice(s, 1, 2), None);
        assert_eq!(utf16_slice(s, 3, 4), Some("b"));
        assert_eq!(utf16_slice(s, 4, 4), Some(""));
        assert_eq!(utf16_to_byte(s, 5), None);
        assert_eq!(js_slice("hello", -3, None), "llo");
        assert_eq!(js_slice("hello", 1, Some(-1)), "ell");
        assert_eq!(js_slice("hello", 4, Some(2)), "");
        assert_eq!(take_chars("a😀b", 2), "a😀");
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{FEFF} a \u{00A0}\n"), "a");
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
    }

    #[test]
    fn numbers_print_like_javascript() {
        for (n, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.5e300, "1.5e+300"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.00000123, "0.00000123"),
            (123.456, "123.456"),
            (0.1 + 0.2, "0.30000000000000004"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(number_to_string(n), text);
        }
    }

    #[test]
    fn strings_read_as_numbers_like_javascript() {
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("  42  "), 42.0);
        assert_eq!(string_to_number("-1.5e3"), -1500.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert_eq!(string_to_number("0x1F"), 31.0);
        assert_eq!(string_to_number("0b101"), 5.0);
        assert_eq!(string_to_number("0o17"), 15.0);
        assert_eq!(string_to_number("Infinity"), f64::INFINITY);
        for bad in [".", "1_000", "1,5", "inf", "nan", "NaN", "1e", "e5", "--1", "+-1", "0x", "-0x1F", "12px", "infinity"] {
            assert!(string_to_number(bad).is_nan(), "{bad}");
        }
    }

    #[test]
    fn coerces_like_javascript() {
        assert_eq!(js_string(&json!(null)), "null");
        assert_eq!(js_string(&json!([1, [2, null], "a"])), "1,2,,a");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(1.0)), "1");
        assert_eq!(js_number(&json!("")), 0.0);
        assert_eq!(js_number(&json!([])), 0.0);
        assert_eq!(js_number(&json!(["7"])), 7.0);
        assert!(js_number(&json!([1, 2])).is_nan());
        assert!(js_number(&json!({})).is_nan());
        assert_eq!(js_number(&json!(true)), 1.0);
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!([])));
        assert!(!js_truthy(&json!(0)));
    }

    #[test]
    fn uri_components() {
        assert_eq!(encode_uri_component("a b/ü(1)!"), "a%20b%2F%C3%BC(1)!");
        assert_eq!(decode_uri_component("a%20b%2F%C3%BC").as_deref(), Some("a b/ü"));
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%C3"), None);
        assert_eq!(decode_uri_component("%FF"), None);
    }

    #[test]
    fn json_matches_json_stringify() {
        let value = parse_json(br#"{"b":1.0,"10":"x","2":[1.50,-0,1e21,12345678901234567890],"a":"q\"\n\u0001\u007f/"}"#).unwrap();
        assert_eq!(js_json(&value), "{\"2\":[1.5,0,1e+21,12345678901234567000],\"10\":\"x\",\"b\":1,\"a\":\"q\\\"\\n\\u0001\u{7f}/\"}");
        assert!(same_json(Some(&json!(1)), Some(&parse_json(b"1.0").unwrap())));
        assert!(same_json(None, Some(&json!(null))));
    }
}
