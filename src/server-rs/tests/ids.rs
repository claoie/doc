//! The cases of `src/common/ids.test.ts` that apply to a server, and the
//! shapes of the other ids. (The two other TypeScript tests guard the
//! browser against `crypto.randomUUID`, which has no counterpart here.)

use std::collections::HashSet;

use doc_server::common::ids::{is_slug_id, is_uuid, share_key, short_id, slug_id, token, uuid};

#[test]
fn uuid_is_a_random_v4_uuid() {
    let ids: Vec<String> = (0..200).map(|_| uuid()).collect();
    for id in &ids {
        // /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        let bytes = id.as_bytes();
        assert_eq!(bytes.len(), 36, "{id}");
        for (index, byte) in bytes.iter().enumerate() {
            match index {
                8 | 13 | 18 | 23 => assert_eq!(*byte, b'-', "{id}"),
                14 => assert_eq!(*byte, b'4', "{id}"),
                19 => assert!(b"89ab".contains(byte), "{id}"),
                _ => assert!(byte.is_ascii_digit() || (b'a'..=b'f').contains(byte), "{id}"),
            }
        }
        assert!(is_uuid(id));
    }
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 200);
}

#[test]
fn ids_have_their_shapes() {
    let lower = |s: &str| s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
    for _ in 0..500 {
        let slug = slug_id();
        assert!(slug.len() == 10 && slug.bytes().all(|b| b.is_ascii_alphanumeric()) && is_slug_id(&slug), "{slug}");
        let key = share_key();
        assert!(key.len() == 10 && lower(&key), "{key}");
        let short = short_id("prop_");
        assert!(short.len() == 14 && short.starts_with("prop_") && lower(&short[5..]), "{short}");
        // 32 bytes as base64url without padding
        let secret = token();
        assert!(secret.len() == 43 && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "{secret}");
    }
}

/// Rejection sampling: no character of the alphabet is favoured. With 62,000
/// draws each character is expected 1,000 times; a biased sampler (bytes
/// taken modulo 62) would give the first eight characters about 1,250.
#[test]
fn slug_characters_are_evenly_spread() {
    let mut counts: std::collections::HashMap<u8, u32> = std::collections::HashMap::new();
    for _ in 0..6_200 {
        for byte in slug_id().bytes() {
            *counts.entry(byte).or_default() += 1;
        }
    }
    assert_eq!(counts.len(), 62);
    for (byte, count) in counts {
        assert!((800..1_200).contains(&count), "{} drawn {count} times", byte as char);
    }
}

#[test]
fn recognises_uuids_and_slug_ids() {
    assert!(is_uuid("123e4567-e89b-12d3-a456-426614174000"));
    assert!(is_uuid("123E4567-E89B-12D3-A456-426614174000"));
    for bad in [
        "",
        "123e4567-e89b-12d3-a456-42661417400",
        "123e4567-e89b-12d3-a456-4266141740000",
        "123e4567-e89b-12d3-a456-42661417400g",
        "123e4567-e89b-12d3-a456-426614174000\n",
        "123e4567e89b-12d3-a456-4266-14174000",
    ] {
        assert!(!is_uuid(bad), "{bad:?}");
    }
    assert!(is_slug_id("a") && is_slug_id("0123456789ABCDEFGHIJKLMNOPQRSTUV"));
    for bad in ["", "0123456789ABCDEFGHIJKLMNOPQRSTUVW", "a-b", "é", "abc\n", "a b"] {
        assert!(!is_slug_id(bad), "{bad:?}");
    }
}
