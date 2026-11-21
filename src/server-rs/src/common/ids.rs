//! Port of `src/common/ids.ts`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;

const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// `length` characters of `alphabet` from the operating system's random
/// source. Bytes that would favour the first characters of the alphabet are
/// thrown away (rejection sampling), so every character is equally likely.
fn random_string(alphabet: &[u8], length: usize) -> String {
    let limit = 256 - 256 % alphabet.len();
    let mut out = String::with_capacity(length);
    let mut bytes = vec![0u8; length * 2];
    while out.len() < length {
        OsRng.fill_bytes(&mut bytes);
        for &byte in &bytes {
            if usize::from(byte) >= limit {
                continue;
            }
            out.push(char::from(alphabet[usize::from(byte) % alphabet.len()]));
            if out.len() == length {
                break;
            }
        }
    }
    out
}

/// Public page identifier used in URLs: 10 base-62 characters.
pub fn slug_id() -> String {
    random_string(BASE62, 10)
}

/// Public share key: 10 characters of `[0-9a-z]`.
pub fn share_key() -> String {
    random_string(BASE36, 10)
}

/// Secret token (sessions, password resets, invitations): 32 random bytes, base64url without padding.
pub fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Short id for records scoped to one parent (base properties, choices): a prefix plus 9 of `[0-9a-z]`.
pub fn short_id(prefix: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + 9);
    out.push_str(prefix);
    out.push_str(&random_string(BASE36, 9));
    out
}

/// Random v4 UUID in lower-case hyphenated form.
pub fn uuid() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    uuid::Builder::from_random_bytes(bytes).into_uuid().hyphenated().to_string()
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`: any
/// version, either case. (The TypeScript function also answers `false` for
/// values that are not strings; here the type rules those out.)
pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// `/^[0-9A-Za-z]{1,32}$/`.
pub fn is_slug_id(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn uuid_is_a_random_v4_uuid() {
        let ids: Vec<String> = (0..200).map(|_| uuid()).collect();
        for id in &ids {
            let bytes = id.as_bytes();
            assert!(is_uuid(id), "{id}");
            assert_eq!(bytes[14], b'4', "{id}");
            assert!(b"89ab".contains(&bytes[19]), "{id}");
            assert!(bytes.iter().all(|b| !b.is_ascii_uppercase()), "{id}");
        }
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 200);
    }

    #[test]
    fn random_strings_use_their_alphabet() {
        for _ in 0..200 {
            let slug = slug_id();
            assert_eq!(slug.len(), 10);
            assert!(is_slug_id(&slug));
            let key = share_key();
            assert_eq!(key.len(), 10);
            assert!(key.bytes().all(|b| BASE36.contains(&b)));
            let short = short_id("p");
            assert_eq!(short.len(), 10);
            assert!(short.starts_with('p') && short[1..].bytes().all(|b| BASE36.contains(&b)));
        }
        // Every character of the alphabet turns up.
        let seen: HashSet<u8> = (0..400).flat_map(|_| slug_id().into_bytes()).collect();
        assert_eq!(seen.len(), 62);
    }

    #[test]
    fn tokens_are_32_bytes_of_base64url() {
        let tokens: HashSet<String> = (0..100).map(|_| token()).collect();
        assert_eq!(tokens.len(), 100);
        for token in tokens {
            assert_eq!(token.len(), 43);
            assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
    }

    #[test]
    fn recognises_ids() {
        assert!(is_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(is_uuid("123E4567-E89B-12D3-A456-426614174000"));
        assert!(!is_uuid("123e4567-e89b-12d3-a456-42661417400"));
        assert!(!is_uuid("123e4567-e89b-12d3-a456-4266141740000"));
        assert!(!is_uuid("123e4567e89b-12d3-a456-426614174000-"));
        assert!(!is_uuid("123e4567-e89b-12d3-a456-42661417400g"));
        assert!(!is_uuid("123e4567-e89b-12d3-a456-426614174000\n"));
        assert!(!is_uuid(""));
        assert!(is_slug_id("a"));
        assert!(is_slug_id("0123456789ABCDEFGHIJKLMNOPQRSTUV"));
        assert!(!is_slug_id("0123456789ABCDEFGHIJKLMNOPQRSTUVW"));
        assert!(!is_slug_id(""));
        assert!(!is_slug_id("a-b"));
        assert!(!is_slug_id("é"));
        assert!(!is_slug_id("abc\n"));
    }
}
