//! Holds `common/positions.rs` to the TypeScript `keyBetween`, through
//! `fixtures/positions.json` (written by `fixtures/gen-positions.ts`), and
//! ports the cases of `src/common/positions.test.ts`.

mod support;

use doc_server::common::positions::key_between;
use support::{assert_none, fixture};

const DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[test]
fn key_between_matches() {
    let fixture = fixture("positions.json");
    let cases = fixture.as_array().unwrap();
    assert!(cases.len() > 5_000);
    let mut mismatches = Vec::new();
    let mut errors = 0;
    for case in cases {
        let (a, b) = (case[0].as_str(), case[1].as_str());
        let expected = match (case[2].as_str(), case[3].as_str()) {
            (Some(key), _) => Ok(key.to_owned()),
            (None, Some(message)) => Err(message.to_owned()),
            // The generator writes this one message, which repeats both keys, as 0.
            (None, None) => Err(format!("position {} is not before {}", case[0], case[1])),
        };
        errors += usize::from(expected.is_err());
        let actual = key_between(a, b);
        if actual != expected {
            mismatches.push(format!("keyBetween({a:?}, {b:?}): expected {expected:?}, got {actual:?}"));
        }
    }
    assert!(errors > 500, "{errors} error cases");
    assert_none("keyBetween calls", &mismatches);
}

/// A key between the bounds that sorts strictly between them and uses only the 62 digits.
fn assert_between(a: Option<&str>, b: Option<&str>) -> String {
    let key = key_between(a, b).unwrap_or_else(|e| panic!("keyBetween({a:?}, {b:?}): {e}"));
    if let Some(a) = a {
        assert!(a < key.as_str(), "{a} < {key}");
    }
    if let Some(b) = b {
        assert!(key.as_str() < b, "{key} < {b}");
    }
    assert!(key.chars().all(|ch| DIGITS.contains(ch)), "{key}");
    key
}

/// The generator of the TypeScript tests.
fn seeded(mut seed: i64) -> impl FnMut() -> f64 {
    move || {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
        seed as f64 / 2_147_483_647.0
    }
}

#[test]
fn works_between_existing_keys_of_the_alphabet() {
    let mut existing = vec![
        "0001",
        "A00000000000000000000000001",
        "Zy",
        "Zz",
        "Zz8",
        "a0",
        "a00V",
        "a0V",
        "a0VW3k",
        "a1",
        "a1V",
        "a1Vx3",
        "a2",
        "a21",
        "a3",
        "b0Ab",
        "b10",
        "m",
        "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzV",
    ];
    existing.sort_unstable();
    assert_between(None, Some(existing[0]));
    for pair in existing.windows(2) {
        assert_between(Some(pair[0]), Some(pair[1]));
    }
    assert_between(Some(existing[existing.len() - 1]), None);
}

#[test]
fn random_adjacent_pairs_of_arbitrary_keys() {
    let mut random = seeded(7);
    let digits: Vec<char> = DIGITS.chars().collect();
    let mut keys = std::collections::BTreeSet::new();
    while keys.len() < 500 {
        let length = 1 + (random() * 6.0).floor() as usize;
        let key: String = (0..length).map(|_| digits[(random() * 62.0).floor() as usize]).collect();
        if !key.ends_with('0') {
            keys.insert(key);
        }
    }
    let sorted: Vec<String> = keys.into_iter().collect();
    for pair in sorted.windows(2) {
        assert_between(Some(&pair[0]), Some(&pair[1]));
    }
}

#[test]
fn random_insert_sequences_keep_order() {
    for seed in 1..=5 {
        let mut random = seeded(seed);
        let mut list: Vec<String> = Vec::new();
        for _ in 0..400 {
            let index = (random() * (list.len() + 1) as f64).floor() as usize;
            let before = index.checked_sub(1).map(|i| list[i].clone());
            let key = assert_between(before.as_deref(), list.get(index).map(String::as_str));
            list.insert(index, key);
        }
        let mut sorted = list.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, list);
        sorted.dedup();
        assert_eq!(sorted.len(), list.len());
    }
}

#[test]
fn append_and_prepend_forever_stay_short() {
    let mut last: Option<String> = None;
    let mut first: Option<String> = None;
    for _ in 0..10_000 {
        last = Some(assert_between(last.as_deref(), None));
        first = Some(assert_between(None, first.as_deref()));
    }
    assert!(last.unwrap().len() < 6);
    assert!(first.unwrap().len() < 6);
}

#[test]
fn repeatedly_inserting_at_the_same_spot_works() {
    let (mut low, mut high) = ("a0".to_owned(), "a1".to_owned());
    for i in 0..300 {
        let key = assert_between(Some(&low), Some(&high));
        if i % 2 == 1 {
            low = key;
        } else {
            high = key;
        }
    }
    let mut after = "Zz".to_owned();
    for _ in 0..300 {
        after = assert_between(Some("Zz"), Some(if after == "Zz" { "a0" } else { &after }));
    }
}
