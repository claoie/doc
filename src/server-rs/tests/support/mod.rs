//! Shared by the fixture-driven tests: reading the fixtures the Bun
//! generators in `fixtures/` write.
#![allow(dead_code)]

use doc_server::common::jsdate::{set_local_zone, Zone};
use doc_server::jsutil::number_json;
use serde_json::{Map, Value};

/// Reads a fixture file next to the generators.
pub fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let text = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A double from the generators' exact text form (`enc` in `rng.ts`).
pub fn dec(text: &str) -> f64 {
    match text {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => text.parse().unwrap_or_else(|_| panic!("not a number: {text}")),
    }
}

pub fn dec_value(value: &Value) -> f64 {
    dec(value.as_str().expect("a number as text"))
}

/// Whether two doubles are the same value: same bits, with every NaN alike.
pub fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

/// The exact text form of a double, the inverse of [`dec`].
pub fn enc(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() {
        "-0".to_owned()
    } else {
        doc_server::jsutil::number_to_string(n)
    }
}

/// Undoes `exact` of `rng.ts`: every `{"$n": "<text>"}` becomes the number.
pub fn inexact(value: &Value) -> Value {
    match value {
        Value::Object(fields) if fields.len() == 1 && fields.contains_key("$n") => number_json(dec_value(&fields["$n"])),
        Value::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), inexact(v))).collect::<Map<_, _>>()),
        Value::Array(items) => Value::Array(items.iter().map(inexact).collect()),
        other => other.clone(),
    }
}

/// The fixtures were generated with UTC as the local zone; pin it so the
/// tests do not depend on the `TZ` they run under.
pub fn use_utc() {
    assert!(set_local_zone(Zone::Utc), "the local zone was already set to something else");
}

/// Undoes `encode` of `gen-bases.ts` and `gen-formula.ts`: `{"$n": text}` is
/// a number, `{"$repeat": [prefix, unit, count, suffix]}` a long string and
/// `{"$o": [[key, value], ...]}` an object with its keys in that order.
pub fn decode(value: &Value) -> Value {
    match value {
        Value::Object(fields) if fields.len() == 1 => {
            let (key, inner) = fields.iter().next().unwrap();
            match key.as_str() {
                "$n" => number_json(dec_value(inner)),
                "$repeat" => {
                    let text = |i: usize| inner[i].as_str().unwrap();
                    Value::String(format!("{}{}{}", text(0), text(1).repeat(inner[2].as_u64().unwrap() as usize), text(3)))
                }
                "$o" => Value::Object(
                    inner.as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_owned(), decode(&pair[1]))).collect::<Map<_, _>>(),
                ),
                other => panic!("unexpected encoding {other}"),
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(decode).collect()),
        Value::Object(_) => panic!("objects are encoded as $o"),
        other => other.clone(),
    }
}

/// How the generators write a result: `=<JSON>`, with long JSON replaced by
/// its length and both ends (in code points).
pub fn outcome_of(value: &Value) -> String {
    let json = doc_server::jsutil::js_json(value);
    let points: Vec<char> = json.chars().collect();
    if points.len() > 400 {
        format!("=#{}:{}\u{2026}{}", points.len(), points[..60].iter().collect::<String>(), points[points.len() - 60..].iter().collect::<String>())
    } else {
        format!("={json}")
    }
}

/// Fails with the first few of `mismatches`, if there are any.
pub fn assert_none(what: &str, mismatches: &[String]) {
    assert!(
        mismatches.is_empty(),
        "{} {what} differ, first:\n{}",
        mismatches.len(),
        mismatches.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
}
