//! The Rust summarizer against the TS one.
//!
//! `golden/summaries.json` is written by the real `summarizeSession`
//! (packages/host/src/session-summary.golden.test.ts, which also fails if it
//! goes stale), from the fixtures in `golden/sessions` (make-fixtures.mjs).
//! Every summary must match exactly: key order included, since the renderer
//! may be handed either side's output.

use nekko_store::{SessionStore, summarize};
use serde_json::Value;
use std::path::Path;

fn golden() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

#[test]
fn every_fixture_summarizes_exactly_as_the_ts_host_does() {
    let expected: serde_json::Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("summaries.json")).unwrap()).unwrap();
    assert!(expected.len() >= 10, "the golden set is too small to mean anything");
    for (id, want) in &expected {
        let raw = std::fs::read_to_string(golden().join("sessions").join(format!("{id}.json"))).unwrap();
        let session: Value = serde_json::from_str(&raw).unwrap();
        let got = summarize(&session).unwrap_or(Value::Null);
        assert_eq!(&got, want, "summary of {id} differs");
        // Same keys in the same order, not just equal maps.
        if let (Some(g), Some(w)) = (got.as_object(), want.as_object()) {
            assert_eq!(g.keys().collect::<Vec<_>>(), w.keys().collect::<Vec<_>>(), "key order of {id} differs");
        }
    }
}

#[test]
fn the_store_lists_the_golden_set_as_the_ts_lister_would() {
    // SessionStore reads `<data>/sessions`; the fixtures dir is laid out that way.
    let store = SessionStore::new(golden());
    let summaries = store.summaries();
    // The one fixture summarizeSession throws on is skipped, as the TS lister skips it.
    assert!(summaries.iter().all(|s| s["id"] != "s_nomsgs"));
    assert_eq!(summaries.len(), std::fs::read_dir(golden().join("sessions")).unwrap().count() - 1);
    assert!(summaries.iter().all(|s| s.get("messages").is_none()));
}
