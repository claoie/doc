//! Holds `common/jsnum.rs` (and `number_text` of `common/bases.rs`) to
//! Bun's numbers, through `fixtures/numbers.json` (written by
//! `fixtures/gen-numbers.ts`).

mod support;

use doc_server::common::bases::number_text;
use doc_server::common::jsnum::{math_max, math_min, math_round, math_sign, pow, to_precision};
use support::{assert_none, dec_value, enc, fixture, same};

#[test]
fn to_precision_matches() {
    let fixture = fixture("numbers.json");
    let cases = fixture["toPrecision"].as_array().unwrap();
    assert!(cases.len() > 4_000);
    let mut mismatches = Vec::new();
    for case in cases {
        let (n, precision, expected) = (dec_value(&case[0]), case[1].as_u64().unwrap() as usize, case[2].as_str().unwrap());
        let actual = to_precision(n, precision);
        if actual != expected {
            mismatches.push(format!("({}).toPrecision({precision}): expected {expected}, got {actual}", enc(n)));
        }
    }
    assert_none("toPrecision calls", &mismatches);
}

#[test]
fn math_round_matches() {
    let fixture = fixture("numbers.json");
    let mut mismatches = Vec::new();
    for case in fixture["round"].as_array().unwrap() {
        let (n, expected) = (dec_value(&case[0]), dec_value(&case[1]));
        if !same(math_round(n), expected) {
            mismatches.push(format!("Math.round({}): expected {}, got {}", enc(n), enc(expected), enc(math_round(n))));
        }
    }
    assert_none("Math.round calls", &mismatches);
}

#[test]
fn pow_matches() {
    let fixture = fixture("numbers.json");
    let cases = fixture["pow"].as_array().unwrap();
    let mut mismatches = Vec::new();
    for case in cases {
        let (x, y, expected) = (dec_value(&case[0]), dec_value(&case[1]), dec_value(&case[2]));
        let actual = pow(x, y);
        if !same(actual, expected) {
            mismatches.push(format!("{} ** {}: expected {}, got {}", enc(x), enc(y), enc(expected), enc(actual)));
        }
    }
    println!("pow: {} of {} differ", mismatches.len(), cases.len());
    assert_none("powers", &mismatches);
}

#[test]
fn sign_min_max_match() {
    let fixture = fixture("numbers.json");
    let mut mismatches = Vec::new();
    for case in fixture["sign"].as_array().unwrap() {
        let (n, expected) = (dec_value(&case[0]), dec_value(&case[1]));
        if !same(math_sign(n), expected) {
            mismatches.push(format!("Math.sign({}): expected {}, got {}", enc(n), enc(expected), enc(math_sign(n))));
        }
    }
    for case in fixture["minMax"].as_array().unwrap() {
        let values: Vec<f64> = case[0].as_array().unwrap().iter().map(dec_value).collect();
        let (min, max) = (dec_value(&case[1]), dec_value(&case[2]));
        if !same(math_min(&values), min) || !same(math_max(&values), max) {
            mismatches.push(format!(
                "min/max of {}: expected {} and {}, got {} and {}",
                case[0],
                enc(min),
                enc(max),
                enc(math_min(&values)),
                enc(math_max(&values))
            ));
        }
    }
    assert_none("Math.sign, Math.min and Math.max calls", &mismatches);
}

/// `Math.exp`, `Math.log`, `Math.log10` and `Math.sqrt` are the platform's
/// maths library on both sides. Only the square root is defined bit for bit;
/// for the others JavaScriptCore and Rust could differ in the last place on
/// some platform, so the comparison counts instead of assuming. On the
/// machine the fixtures were made on, nothing differs.
#[test]
fn transcendental_functions_match() {
    let fixture = fixture("numbers.json");
    let cases = fixture["transcendental"].as_array().unwrap();
    let mut mismatches = Vec::new();
    let mut worst: u64 = 0;
    for case in cases {
        let (name, x, expected) = (case[0].as_str().unwrap(), dec_value(&case[1]), dec_value(&case[2]));
        let actual = match name {
            "exp" => x.exp(),
            "log" => x.ln(),
            "log10" => x.log10(),
            "sqrt" => x.sqrt(),
            other => panic!("{other}"),
        };
        if !same(actual, expected) {
            if actual.is_finite() && expected.is_finite() {
                worst = worst.max(actual.to_bits().abs_diff(expected.to_bits()));
            } else {
                worst = u64::MAX;
            }
            mismatches.push(format!("Math.{name}({}): expected {}, got {}", enc(x), enc(expected), enc(actual)));
        }
    }
    println!("transcendental: {} of {} differ, by at most {worst} units in the last place", mismatches.len(), cases.len());
    assert!(worst <= 1, "{}", mismatches.join("\n"));
    assert!(mismatches.iter().all(|line| !line.contains("sqrt")), "{}", mismatches.join("\n"));
}

#[test]
fn number_text_matches() {
    let fixture = fixture("numbers.json");
    let mut mismatches = Vec::new();
    for case in fixture["numberText"].as_array().unwrap() {
        let (n, expected) = (dec_value(&case[0]), case[1].as_str().unwrap());
        if number_text(n) != expected {
            mismatches.push(format!("numberText({}): expected {expected}, got {}", enc(n), number_text(n)));
        }
    }
    assert_none("numberText calls", &mismatches);
}
