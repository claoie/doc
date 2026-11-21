//! Port of the `Authority` of `src/common/editor/collab.ts`.
//!
//! Collaboration uses a central authority: the server holds the document and
//! a version counter, and accepts a batch of steps only when it was made
//! against the current version. A client whose batch is rejected receives the
//! steps it missed, rebases its unconfirmed steps over them, and resends.
//! (`CollabClient`, the browser's half, is not ported.)

use std::collections::VecDeque;

use serde_json::Value;

use super::steps::{apply_step_in_place, StepError};
use super::tokens::content_size;
use crate::jsutil::{js_json, utf16_len};

/// Largest document, in positions: characters, leaf nodes, and two per other node.
pub const MAX_DOC_SIZE: usize = 2_000_000;

#[derive(Debug, Clone, Copy)]
pub struct AuthorityLimits {
    /// Steps kept so clients a little behind can catch up without a reload.
    pub max_history: usize,
    /// Total serialized size of the kept steps, in characters.
    pub max_history_bytes: usize,
    /// Largest document accepted, in positions (characters plus node boundaries).
    pub max_doc_size: usize,
}

impl Default for AuthorityLimits {
    fn default() -> Self {
        AuthorityLimits { max_history: 2000, max_history_bytes: 2 * 1024 * 1024, max_doc_size: MAX_DOC_SIZE }
    }
}

/// Why the last `receive` accepted nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    Stale,
    Invalid,
    TooLarge,
}

pub struct ConfirmedSteps {
    pub version: f64,
    pub steps: Vec<Value>,
    pub client_ids: Vec<String>,
}

struct Entry {
    step: Value,
    client_id: String,
    bytes: usize,
}

pub struct Authority {
    pub doc: Value,
    /// A JavaScript number: clients send versions unvalidated, and the comparisons follow.
    pub version: f64,
    pub rejection: Option<Rejection>,
    history: VecDeque<Entry>,
    history_bytes: usize,
    pub limits: AuthorityLimits,
}

impl Authority {
    pub fn new(doc: Value, version: f64) -> Authority {
        Authority::with_limits(doc, version, AuthorityLimits::default())
    }

    pub fn with_limits(doc: Value, version: f64, limits: AuthorityLimits) -> Authority {
        Authority { doc, version, rejection: None, history: VecDeque::new(), history_bytes: 0, limits }
    }

    /// Applies a client's batch. `Ok(Some(steps))` when accepted; `Ok(None)`
    /// when the client is behind (it should fetch `steps_since`), a step does
    /// not fit, or the document would grow past its size limit; `rejection`
    /// says which. `Err` is a step so malformed that the original throws
    /// something else than a step error: nothing was applied.
    pub fn receive(&mut self, version: f64, steps: Vec<Value>, client_id: &str) -> Result<Option<Vec<Value>>, StepError> {
        self.rejection = None;
        if version != self.version {
            self.rejection = Some(Rejection::Stale);
            return Ok(None);
        }
        // The batch is applied to a copy, which replaces the document only when every step fits.
        let mut doc = self.doc.clone();
        for step in &steps {
            match apply_step_in_place(&mut doc, step) {
                Ok(()) => {}
                Err(StepError::Invalid(_)) => {
                    self.rejection = Some(Rejection::Invalid);
                    return Ok(None);
                }
                Err(malformed) => return Err(malformed),
            }
        }
        let size = content_size(&doc);
        // A document over the limit may still shrink.
        if size > self.limits.max_doc_size && size > content_size(&self.doc) {
            self.rejection = Some(Rejection::TooLarge);
            return Ok(None);
        }
        self.doc = doc;
        for step in &steps {
            let bytes = utf16_len(&js_json(step));
            self.history.push_back(Entry { step: step.clone(), client_id: client_id.to_string(), bytes });
            self.history_bytes += bytes;
        }
        self.version += steps.len() as f64;
        while !self.history.is_empty() && (self.history.len() > self.limits.max_history || self.history_bytes > self.limits.max_history_bytes) {
            if let Some(dropped) = self.history.pop_front() {
                self.history_bytes -= dropped.bytes;
            }
        }
        Ok(Some(steps))
    }

    /// Steps after `version`, or `None` when they have aged out of history.
    pub fn steps_since(&self, version: f64) -> Option<ConfirmedSteps> {
        let start = self.version - self.history.len() as f64;
        // NaN compares false both ways, as in JavaScript, and then slices from 0.
        if version < start || version > self.version {
            return None;
        }
        // `history.slice(version - start)`: a fractional index is truncated.
        let skip = (version - start).trunc();
        let skip = if skip.is_nan() || skip < 0.0 { 0 } else { skip as usize };
        let slice: Vec<&Entry> = self.history.iter().skip(skip).collect();
        Some(ConfirmedSteps {
            version: self.version,
            steps: slice.iter().map(|entry| entry.step.clone()).collect(),
            client_ids: slice.iter().map(|entry| entry.client_id.clone()).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] }] })
    }

    fn insert(at: usize, text: &str) -> Value {
        json!({ "stepType": "replace", "from": at, "to": at, "slice": [{ "t": text }] })
    }

    #[test]
    fn accepts_batches_against_the_current_version_only() {
        let mut authority = Authority::new(doc(), 3.0);
        assert!(authority.receive(2.0, vec![insert(1, "a")], "x").unwrap().is_none());
        assert_eq!(authority.rejection, Some(Rejection::Stale));
        assert_eq!(authority.receive(3.0, vec![insert(1, "a"), insert(2, "b")], "x").unwrap().unwrap().len(), 2);
        assert_eq!(authority.version, 5.0);
        assert_eq!(authority.doc["content"][0]["content"][0]["text"], "abhello");
        assert!(authority.receive(5.0, vec![insert(1, "c"), insert(99, "d")], "y").unwrap().is_none());
        assert_eq!(authority.rejection, Some(Rejection::Invalid));
        assert_eq!(authority.doc["content"][0]["content"][0]["text"], "abhello");
        assert!(authority.receive(5.0, vec![json!({ "stepType": "replace", "from": 1, "to": 1, "slice": [5] })], "y").is_err());
        assert_eq!(authority.receive(5.0, vec![], "y").unwrap().unwrap().len(), 0);
    }

    #[test]
    fn catches_clients_up_from_history() {
        let mut authority = Authority::with_limits(doc(), 0.0, AuthorityLimits { max_history: 3, ..Default::default() });
        for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
            authority.receive(i as f64, vec![insert(1, id)], id).unwrap().unwrap();
        }
        assert!(authority.steps_since(0.0).is_none());
        let missed = authority.steps_since(2.0).unwrap();
        assert_eq!((missed.version, missed.client_ids), (4.0, vec!["c".to_string(), "d".to_string()]));
        assert_eq!(authority.steps_since(1.5).unwrap().steps.len(), 3);
        assert_eq!(authority.steps_since(4.0).unwrap().steps.len(), 0);
        assert!(authority.steps_since(5.0).is_none());
        assert!(authority.steps_since(-1.0).is_none());
    }

    #[test]
    fn bounds_history_bytes_and_document_size() {
        let mut authority = Authority::with_limits(doc(), 0.0, AuthorityLimits { max_history_bytes: 150, max_doc_size: 12, max_history: 2000 });
        authority.receive(0.0, vec![insert(1, "ab")], "x").unwrap().unwrap();
        authority.receive(1.0, vec![insert(1, "cd")], "x").unwrap().unwrap();
        assert!(authority.steps_since(0.0).is_some());
        authority.receive(2.0, vec![insert(1, "e")], "x").unwrap().unwrap();
        assert!(authority.steps_since(0.0).is_none());
        assert!(authority.receive(3.0, vec![insert(1, "fg")], "x").unwrap().is_none());
        assert_eq!(authority.rejection, Some(Rejection::TooLarge));
        // Over the limit, a document may still shrink.
        let mut big = Authority::with_limits(doc(), 0.0, AuthorityLimits { max_doc_size: 3, ..Default::default() });
        assert!(big.receive(0.0, vec![json!({ "stepType": "replace", "from": 1, "to": 2, "slice": [] })], "x").unwrap().is_some());
    }
}
