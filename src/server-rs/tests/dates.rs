//! Holds `common/jsdate.rs` to Bun's `Date`, through `fixtures/dates.json`
//! and `fixtures/date-parse.json` (written by `fixtures/gen-dates.ts`).

mod support;

use doc_server::common::jsdate::{date_parse_in, date_utc, set_utc_date, time_clip, to_iso_string, utc_fields, Zone};
use serde_json::Value;
use support::{assert_none, dec_value, enc, fixture, same};

/// One zone's answers: the first zone's are listed in full, the others as
/// the `[index, answer]` pairs that differ from the first zone's.
fn answers(fixture: &Value, zone_name: &str) -> Vec<f64> {
    let zones = fixture["zones"].as_object().unwrap();
    let ms = |answer: &Value| answer.as_f64().unwrap_or(f64::NAN);
    let mut answers: Vec<f64> = zones.values().next().unwrap().as_array().unwrap().iter().map(ms).collect();
    if zones.keys().next().map(String::as_str) != Some(zone_name) {
        for pair in zones[zone_name].as_array().unwrap() {
            answers[pair[0].as_u64().unwrap() as usize] = ms(&pair[1]);
        }
    }
    answers
}

/// `Date.parse` over a corpus in one zone: the mismatches among the
/// systematic strings, those among the fuzzed ones, and how many strings
/// were fuzzed.
fn parse_mismatches(fixture: &Value, zone_name: &str) -> (Vec<String>, Vec<String>, usize) {
    let strings = fixture["strings"].as_array().unwrap();
    let fuzz_from = fixture["fuzzFrom"].as_u64().unwrap() as usize;
    let answers = answers(fixture, zone_name);
    assert_eq!(strings.len(), answers.len());
    let zone = Zone::from_name(zone_name).unwrap();
    let (mut strict, mut fuzzed) = (Vec::new(), Vec::new());
    for (index, (text, expected)) in strings.iter().zip(answers).enumerate() {
        let text = text.as_str().unwrap();
        let actual = date_parse_in(text, &zone);
        if !same(actual, expected) {
            let line = format!(
                "{zone_name} {text:?}: expected {} ({:?}), got {} ({:?})",
                enc(expected),
                to_iso_string(expected),
                enc(actual),
                to_iso_string(actual)
            );
            if index < fuzz_from { &mut strict } else { &mut fuzzed }.push(line);
        }
    }
    (strict, fuzzed, strings.len() - fuzz_from)
}

fn check_zone(zone_name: &str) {
    let (strict, fuzzed, fuzz_count) = parse_mismatches(&fixture("date-parse.json"), zone_name);
    assert_none("systematic strings", &strict);
    // The fuzzed strings are held to the same standard; the count is printed
    // so a regression shows as a rate, not only as a failure.
    println!("{zone_name}: {} of {fuzz_count} fuzzed strings differ", fuzzed.len());
    assert_none("fuzzed strings", &fuzzed);
}

/// A longer fuzz run than the repository carries: see `fixtures/gen-dates.ts`.
#[test]
#[ignore = "needs DATE_PARSE_EXTRA, the file a `gen-dates.ts --extra` run wrote"]
fn date_parse_matches_on_an_extra_corpus() {
    let path = std::env::var("DATE_PARSE_EXTRA").expect("DATE_PARSE_EXTRA");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut all = Vec::new();
    for zone_name in fixture["zones"].as_object().unwrap().keys() {
        let (strict, fuzzed, _) = parse_mismatches(&fixture, zone_name);
        println!("{zone_name}: {} of {} strings differ", strict.len() + fuzzed.len(), fixture["strings"].as_array().unwrap().len());
        all.extend(strict);
        all.extend(fuzzed);
    }
    assert_none("strings", &all);
}

#[test]
fn date_parse_matches_in_utc() {
    check_zone("UTC");
}

#[test]
fn date_parse_matches_in_new_york() {
    check_zone("America/New_York");
}

#[test]
fn date_parse_matches_in_berlin() {
    check_zone("Europe/Berlin");
}

/// Zones whose rules changed lately, end without a rule or have unusual
/// offsets, on a short list of far-future times and of wall-clock times at
/// the two ends of the range of time values.
#[test]
fn date_parse_matches_at_the_edges_of_other_zones() {
    let fixture = fixture("date-parse.json");
    let strings = fixture["edges"]["strings"].as_array().unwrap();
    let zones = fixture["edges"]["zones"].as_object().unwrap();
    assert!(zones.len() >= 10 && strings.len() > 150);
    let mut mismatches = Vec::new();
    for (zone_name, answers) in zones {
        let zone = Zone::from_name(zone_name).unwrap();
        for (text, expected) in strings.iter().zip(answers.as_array().unwrap()) {
            let text = text.as_str().unwrap();
            let expected = expected.as_f64().unwrap_or(f64::NAN);
            let actual = date_parse_in(text, &zone);
            if !same(actual, expected) {
                mismatches.push(format!(
                    "{zone_name} {text:?}: expected {} ({:?}), got {} ({:?})",
                    enc(expected),
                    to_iso_string(expected),
                    enc(actual),
                    to_iso_string(actual)
                ));
            }
        }
    }
    assert_none("strings", &mismatches);
}

#[test]
fn corpus_is_large_and_varied() {
    let fixture = fixture("date-parse.json");
    let strings = fixture["strings"].as_array().unwrap();
    let fuzz_from = fixture["fuzzFrom"].as_u64().unwrap() as usize;
    assert!(fuzz_from > 5_000 && strings.len() - fuzz_from > 5_000);
    for zone in ["UTC", "America/New_York", "Europe/Berlin"] {
        let answers = answers(&fixture, zone);
        let valid = answers.iter().filter(|a| !a.is_nan()).count();
        assert!(valid > answers.len() / 5 && valid < answers.len() * 4 / 5, "{zone}: {valid} of {} valid", answers.len());
    }
    // The zones disagree where text has no offset, so the corpus does exercise local time.
    for zone in ["America/New_York", "Europe/Berlin"] {
        let differing = fixture["zones"][zone].as_array().unwrap().len();
        assert!(differing > 3_000, "{zone}: {differing}");
    }
}

#[test]
fn date_utc_matches() {
    let fixture = fixture("dates.json");
    let mut mismatches = Vec::new();
    for case in fixture["utc"].as_array().unwrap() {
        let args: Vec<f64> = case[0].as_array().unwrap().iter().map(dec_value).collect();
        let expected = dec_value(&case[1]);
        let actual = date_utc(&args);
        if !same(actual, expected) {
            mismatches.push(format!("Date.UTC({}): expected {}, got {}", case[0], enc(expected), enc(actual)));
        }
    }
    assert_none("Date.UTC calls", &mismatches);
}

#[test]
fn fields_and_iso_strings_match() {
    let fixture = fixture("dates.json");
    let mut mismatches = Vec::new();
    for case in fixture["fields"].as_array().unwrap() {
        let value = dec_value(&case[0]);
        let time = dec_value(&case[1]);
        if !same(time_clip(value), time) {
            mismatches.push(format!("new Date({}).getTime(): expected {}, got {}", enc(value), enc(time), enc(time_clip(value))));
        }
        let fields = utc_fields(value).map(|f| vec![f.year, f.month, f.date, f.hours, f.minutes, f.seconds, f.milliseconds, f.weekday]);
        let expected: Option<Vec<i64>> = case[2].as_array().map(|items| items.iter().map(|n| n.as_i64().unwrap()).collect());
        if fields != expected {
            mismatches.push(format!("fields of {}: expected {expected:?}, got {fields:?}", enc(value)));
        }
        let iso = to_iso_string(value);
        if iso.as_deref() != case[3].as_str() {
            mismatches.push(format!("toISOString of {}: expected {}, got {iso:?}", enc(value), case[3]));
        }
        // An ISO string reads back as the same instant.
        if let Some(iso) = &iso {
            let back = date_parse_in(iso, &Zone::Utc);
            if !same(back, time) {
                mismatches.push(format!("Date.parse({iso:?}): expected {}, got {}", enc(time), enc(back)));
            }
        }
    }
    assert_none("time values", &mismatches);
}

#[test]
fn set_utc_date_matches() {
    let fixture = fixture("dates.json");
    let mut mismatches = Vec::new();
    for case in fixture["setUtcDate"].as_array().unwrap() {
        let (value, day, expected) = (dec_value(&case[0]), dec_value(&case[1]), dec_value(&case[2]));
        let actual = set_utc_date(value, day);
        if !same(actual, expected) {
            mismatches.push(format!("new Date({}).setUTCDate({}): expected {}, got {}", enc(value), enc(day), enc(expected), enc(actual)));
        }
    }
    assert_none("setUTCDate calls", &mismatches);
}

#[test]
fn zone_names() {
    assert_eq!(Zone::from_name("europe/berlin"), Zone::from_name("Europe/Berlin"));
    assert!(Zone::from_name("Europe/Berlin").is_some());
    assert!(Zone::from_name("Not/AZone").is_none());
    assert!(Zone::from_name("").is_none());
}
