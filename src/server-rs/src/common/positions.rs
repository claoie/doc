//! Port of `src/common/positions.ts`.
//!
//! Fractional ordering keys over the digits `0-9A-Za-z`, compared bytewise
//! (`COLLATE "C"`). Well-formed keys have a variable-length integer part whose
//! head character encodes its length (`a0`, `a1`, `b10`, `Zz`, ...) followed by
//! an optional fraction, so appending and prepending grow keys logarithmically.
//! Keys that do not follow that format are still accepted and ordered by
//! treating them as plain base-62 fractions.
//!
//! Every key is checked to be made of the 62 digits before anything else
//! happens, so the rest of the module works on ASCII bytes; JavaScript's
//! string comparison (by UTF-16 code unit) and Rust's (by byte) agree there.

use serde_json::Value;

use crate::jsutil::js_json;

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = DIGITS.len();
/// `"A" + "0".repeat(26)`: the smallest integer part there is.
const SMALLEST_INTEGER: &str = "A00000000000000000000000000";

/// `JSON.stringify(text)`.
fn quote(text: &str) -> String {
    js_json(&Value::String(text.to_owned()))
}

fn digit_value(ch: u8) -> Result<usize, String> {
    DIGITS.iter().position(|d| *d == ch).ok_or_else(|| format!("invalid position character: {}", quote(&char::from(ch).to_string())))
}

fn digit(value: usize) -> char {
    char::from(DIGITS[value])
}

/// A key strictly between `a` and `b`, treating both as base-62 fractions
/// (`a` may be `""`, `b == None` means no upper bound).
///
/// The TypeScript function recurses once per character; this is the same
/// computation as a loop, so a long key cannot exhaust the stack.
fn midpoint(a: &str, b: Option<&str>) -> Result<String, String> {
    let mut out = String::new();
    let mut a = a.as_bytes();
    let mut b = b.map(str::as_bytes);
    loop {
        if let Some(upper) = b {
            let mut n = 0;
            while n < upper.len() && a.get(n).copied().unwrap_or(b'0') == upper[n] {
                n += 1;
            }
            if n > 0 {
                if n == upper.len() {
                    return Err(format!(
                        "no key exists between {} and {}",
                        quote(&String::from_utf8_lossy(a)),
                        quote(&String::from_utf8_lossy(upper))
                    ));
                }
                out.push_str(&String::from_utf8_lossy(&upper[..n]));
                a = a.get(n..).unwrap_or(&[]);
                b = Some(&upper[n..]);
                continue;
            }
        }
        let low = match a.first() {
            Some(ch) => digit_value(*ch)?,
            None => 0,
        };
        let high = match b {
            // An empty upper bound has no first character; JavaScript looks up `undefined`.
            Some(upper) => match upper.first() {
                Some(ch) => digit_value(*ch)?,
                None => return Err("invalid position character: undefined".to_owned()),
            },
            None => BASE,
        };
        if high > low + 1 {
            // Math.round((low + high) / 2): halves round up.
            out.push(digit((low + high).div_ceil(2)));
            return Ok(out);
        }
        if let Some(upper) = b {
            if upper.len() > 1 {
                out.push(char::from(upper[0]));
                return Ok(out);
            }
        }
        out.push(digit(low));
        a = a.get(1..).unwrap_or(&[]);
        b = None;
    }
}

/// The length of the integer part a head character announces: `a` is 2,
/// `b` is 3, ... and downwards `Z` is 2, `Y` is 3, ...
fn integer_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Some(usize::from(b'Z' - head) + 2),
        _ => None,
    }
}

/// The integer part of a well-formed key.
fn integer_part(key: &str) -> &str {
    &key[..integer_length(key.as_bytes()[0]).expect("well-formed key")]
}

fn is_well_formed(key: &str) -> bool {
    if key.is_empty() || key == SMALLEST_INTEGER {
        return false;
    }
    match integer_length(key.as_bytes()[0]) {
        Some(length) if key.len() >= length => !key[length..].ends_with('0'),
        _ => false,
    }
}

fn increment_integer(integer: &str) -> Result<Option<String>, String> {
    let head = integer.as_bytes()[0];
    let mut digits = integer.as_bytes()[1..].to_vec();
    for i in (0..digits.len()).rev() {
        let next = digit_value(digits[i])? + 1;
        if next < BASE {
            digits[i] = DIGITS[next];
            return Ok(Some(join(head, &digits)));
        }
        digits[i] = b'0';
    }
    if head == b'Z' {
        return Ok(Some("a0".to_owned()));
    }
    if head == b'z' {
        return Ok(None);
    }
    let next_head = head + 1;
    if next_head > b'a' {
        digits.push(b'0');
    } else {
        digits.pop();
    }
    Ok(Some(join(next_head, &digits)))
}

fn decrement_integer(integer: &str) -> Result<Option<String>, String> {
    let head = integer.as_bytes()[0];
    let mut digits = integer.as_bytes()[1..].to_vec();
    for i in (0..digits.len()).rev() {
        let value = digit_value(digits[i])?;
        if value >= 1 {
            digits[i] = DIGITS[value - 1];
            return Ok(Some(join(head, &digits)));
        }
        digits[i] = DIGITS[BASE - 1];
    }
    if head == b'a' {
        return Ok(Some("Zz".to_owned()));
    }
    if head == b'A' {
        return Ok(None);
    }
    let next_head = head - 1;
    if next_head < b'Z' {
        digits.push(DIGITS[BASE - 1]);
    } else {
        digits.pop();
    }
    Ok(Some(join(next_head, &digits)))
}

fn join(head: u8, digits: &[u8]) -> String {
    let mut out = String::with_capacity(digits.len() + 1);
    out.push(char::from(head));
    out.extend(digits.iter().map(|d| char::from(*d)));
    out
}

fn well_formed_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    let Some(a) = a else {
        let Some(b) = b else {
            return Ok("a0".to_owned());
        };
        let ib = integer_part(b);
        if ib == SMALLEST_INTEGER {
            return Ok(format!("{ib}{}", midpoint("", Some(&b[ib.len()..]))?));
        }
        if ib < b {
            return Ok(ib.to_owned());
        }
        return match decrement_integer(ib)? {
            Some(decremented) => Ok(decremented),
            None => Ok(format!("{ib}{}", midpoint("", Some(&b[ib.len()..]))?)),
        };
    };
    let ia = integer_part(a);
    let fa = &a[ia.len()..];
    let Some(b) = b else {
        return match increment_integer(ia)? {
            Some(incremented) => Ok(incremented),
            None => Ok(format!("{ia}{}", midpoint(fa, None)?)),
        };
    };
    let ib = integer_part(b);
    if ia == ib {
        return Ok(format!("{ia}{}", midpoint(fa, Some(&b[ib.len()..]))?));
    }
    match increment_integer(ia)? {
        Some(incremented) if incremented.as_str() < b => Ok(incremented),
        _ => Ok(format!("{ia}{}", midpoint(fa, None)?)),
    }
}

/// Returns a key that sorts strictly after `a` and strictly before `b`
/// (`None` = unbounded on that side). `Err` carries the message of the
/// `Error` the TypeScript function throws: a character outside the 62
/// digits, bounds that are not in order, or no room between them.
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    for key in [a, b].into_iter().flatten() {
        // JavaScript iterates by code point, so the message quotes a whole character.
        if let Some(ch) = key.chars().find(|ch| !ch.is_ascii_alphanumeric()) {
            return Err(format!("invalid position character: {}", quote(&ch.to_string())));
        }
    }
    if let (Some(a), Some(b)) = (a, b) {
        if a >= b {
            return Err(format!("position {} is not before {}", quote(a), quote(b)));
        }
    }
    let well_formed = a.is_none_or(is_well_formed) && b.is_none_or(is_well_formed);
    if well_formed {
        well_formed_between(a, b)
    } else {
        midpoint(a.unwrap_or(""), b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_key_and_simple_neighbours() {
        assert_eq!(key_between(None, None).unwrap(), "a0");
        assert_eq!(key_between(Some("a0"), None).unwrap(), "a1");
        assert_eq!(key_between(None, Some("a0")).unwrap(), "Zz");
        assert_eq!(key_between(Some("a0"), Some("a1")).unwrap(), "a0V");
        assert_eq!(key_between(Some("az"), None).unwrap(), "b00");
        assert_eq!(key_between(None, Some("b00")).unwrap(), "az");
    }

    #[test]
    fn rejects_out_of_order_and_invalid_input() {
        assert_eq!(key_between(Some("a1"), Some("a0")).unwrap_err(), "position \"a1\" is not before \"a0\"");
        assert!(key_between(Some("a1"), Some("a1")).is_err());
        assert_eq!(key_between(Some("a-"), None).unwrap_err(), "invalid position character: \"-\"");
        assert_eq!(key_between(Some("a"), Some("a0")).unwrap_err(), "no key exists between \"a\" and \"a0\"");
        assert_eq!(key_between(None, Some("")).unwrap_err(), "invalid position character: undefined");
    }

    #[test]
    fn a_very_long_key_does_not_exhaust_the_stack() {
        let low = "z".repeat(200_000);
        let key = key_between(Some(&low), None).unwrap();
        assert!(key.as_str() > low.as_str());
    }
}
