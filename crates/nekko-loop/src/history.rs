//! What of the transcript a model is sent: `windowHistory` and
//! `asSeenByChatModel` (packages/core/src/agent/loop.ts).

use nekko_js as js;
use serde_json::Value;

/// The last `turns` user-turn groups, cut on a user message so a tool call is
/// never split from its result. Unlimited when `turns` is `None` or under 1.
pub fn window_history(history: &[Value], turns: Option<f64>) -> &[Value] {
    let Some(turns) = turns.filter(|t| *t >= 1.0) else { return history };
    let users: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(Value::as_str) == Some("user"))
        .map(|(i, _)| i)
        .collect();
    // `userIdx.length <= turns`, and `userIdx[length - turns]` indexes with a
    // number, so a fractional limit reads nothing and keeps the whole history.
    if (users.len() as f64) <= turns || turns.fract() != 0.0 {
        return history;
    }
    &history[users[users.len() - turns as usize]..]
}

/// A picture-only reply from an image chat, as one line a chat model can read.
pub fn as_seen_by_chat_model(m: &Value) -> Value {
    let generated = m.get("generated").filter(|g| js::truthy(Some(g)));
    let content = m.get("content").and_then(Value::as_str).unwrap_or("");
    if m.get("role").and_then(Value::as_str) != Some("assistant")
        || generated.is_none()
        || !js::trim(content).is_empty()
    {
        return m.clone();
    }
    let g = generated.expect("checked");
    let text = |k: &str| match g.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(v) => js::stringify(v),
        None => "undefined".into(),
    };
    let model = g.get("modelId").and_then(Value::as_str).unwrap_or("").rsplit('/').next().unwrap_or("").to_string();
    let mut out = m.clone();
    out["content"] = Value::String(format!(
        "[Generated a {}×{} image with {model}, seed {}.]",
        text("width"),
        text("height"),
        text("seed")
    ));
    out
}
