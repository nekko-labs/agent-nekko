//! Native prefix caching only, never answer memoization or context omission.
use serde_json::{Map, Value, json};

pub(crate) fn anthropic_prefix(body: &mut Map<String, Value>) {
    fn mark(block: &mut Value) {
        block.as_object_mut().unwrap().insert("cache_control".into(), json!({ "type": "ephemeral" }));
    }
    if let Some(last) = body.get_mut("tools").and_then(Value::as_array_mut).and_then(|a| a.last_mut()) {
        mark(last);
    }
    if let Some(system) = body.get_mut("system") {
        if let Some(text) = system.as_str().filter(|s| !s.is_empty()) {
            *system = json!([{ "type": "text", "text": text }]);
        }
        if let Some(last) = system.as_array_mut().and_then(|a| a.last_mut()) {
            mark(last);
        }
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        let previous = messages.len().checked_sub(2);
        if let Some(content) = previous.and_then(|i| messages[i].get_mut("content")) {
            if let Some(text) = content.as_str().filter(|s| !s.is_empty()) {
                *content = json!([{ "type": "text", "text": text }]);
            }
            if let Some(last) = content.as_array_mut().and_then(|a| a.last_mut()) {
                mark(last);
            }
        }
    }
}

/// Conservative documented text families, not image/audio/live or unknown future models.
/// https://openrouter.ai/docs/guides/best-practices/prompt-caching#google-gemini
pub(crate) fn gemini_model(model: &str) -> bool {
    let model = model.strip_prefix('~').unwrap_or(model);
    [
        "google/gemini-2.0-flash-001",
        "google/gemini-2.5-pro",
        "google/gemini-2.5-flash",
        "google/gemini-2.5-flash-lite",
        "google/gemini-3-pro",
        "google/gemini-3-flash",
        "google/gemini-3.1-pro",
        "google/gemini-3.1-flash",
    ]
    .iter()
    .any(|base| {
        model.strip_prefix(base).is_some_and(|tail| {
            let (tail, variant) = tail.split_once(':').map_or((tail, None), |(t, v)| (t, Some(v)));
            if variant.is_some_and(|v| v.is_empty() || v.contains('/')) {
                return false;
            }
            tail.is_empty()
                || tail == "-latest"
                || tail == "-preview"
                || tail.strip_prefix("-preview-").is_some_and(|date| {
                    date.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                })
        })
    })
}

/// Preserve all context. Gemini uses the last normal-message marker, with an immutable system instruction.
/// Off omits explicit markers; it cannot disable Google's implicit caching.
pub(crate) fn gemini_prefix(body: &mut Map<String, Value>) {
    fn mark(message: &mut Value) {
        let Some(content) = message.get_mut("content") else { return };
        if let Some(text) = content.as_str().filter(|s| !s.is_empty()) {
            *content = json!([{ "type": "text", "text": text }]);
        }
        if let Some(block) = content.as_array_mut().and_then(|blocks| {
            blocks.iter_mut().rev().find(|b| b["type"] == "text" && b["text"].as_str().is_some_and(|s| !s.is_empty()))
        }) {
            block.as_object_mut().unwrap().insert("cache_control".into(), json!({ "type": "ephemeral" }));
        }
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        if messages.len() > 1 && matches!(messages[0]["role"].as_str(), Some("system" | "developer")) {
            mark(&mut messages[0]);
        }
        if let Some(i) =
            messages.len().checked_sub(1).and_then(|end| (0..end).rev().find(|&i| messages[i]["role"] == "user"))
        {
            mark(&mut messages[i]);
        }
    }
}

/// Inclusive OpenAI/Responses totals, unlike Anthropic's already noncached input.
pub(crate) fn usage(usage: &Value, input_field: &str) -> (u64, Option<u64>, Option<u64>) {
    let details = usage.get(format!("{input_field}_details"));
    let read = details.and_then(|d| d.get("cached_tokens")).and_then(token_count);
    let write = details.and_then(|d| d.get("cache_write_tokens")).and_then(token_count);
    let input = usage
        .get(input_field)
        .and_then(token_count)
        .unwrap_or(0)
        .saturating_sub(read.unwrap_or(0))
        .saturating_sub(write.unwrap_or(0));
    (input, read, write)
}

/// Match Number.isSafeInteger on the TS wire, including integral JSON floats.
pub(crate) fn token_count(value: &Value) -> Option<u64> {
    let n = value.as_f64()?;
    (n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0).then_some(n as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gemini_gating_excludes_specialized_and_unknown_models() {
        for model in [
            "google/gemini-2.0-flash-001",
            "google/gemini-2.5-pro",
            "~google/gemini-2.5-flash-lite",
            "google/gemini-3-pro-preview:free",
            "google/gemini-3.1-pro-preview",
            "google/gemini-2.5-flash-preview-09-2025",
        ] {
            assert!(gemini_model(model), "{model}");
        }
        for model in [
            "google/gemini-2.0-flash-lite",
            "google/gemini-2.5-flash-image",
            "google/gemini-2.5-flash-preview-image",
            "google/gemini-2.5-flash-preview-tts",
            "google/gemini-3-pro-image-preview",
            "google/gemini-99-pro",
            "openrouter/auto",
        ] {
            assert!(!gemini_model(model), "{model}");
        }
    }

    #[test]
    fn counters_are_optional_and_nonoverlapping() {
        assert_eq!(
            usage(
                &json!({ "prompt_tokens": 100, "prompt_tokens_details": { "cached_tokens": 60, "cache_write_tokens": 10 } }),
                "prompt_tokens"
            ),
            (30, Some(60), Some(10))
        );
        assert_eq!(
            usage(&json!({ "input_tokens": 10, "input_tokens_details": { "cached_tokens": 99 } }), "input_tokens"),
            (0, Some(99), None)
        );
        assert_eq!(
            usage(
                &json!({ "prompt_tokens": 10, "prompt_tokens_details": { "cached_tokens": -1, "cache_write_tokens": "5" } }),
                "prompt_tokens"
            ),
            (10, None, None)
        );
        assert_eq!(token_count(&json!(3.0)), Some(3));
        assert_eq!(token_count(&json!(9007199254740992u64)), None);
    }
}
