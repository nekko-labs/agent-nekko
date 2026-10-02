//! Tool-loop detection (`packages/core/src/agent/progress.ts`): trips when the
//! same call keeps coming back with the same result, or one tool keeps failing
//! in a row. Mirror any change in the TS file; the golden runs hold both to the
//! same behavior.

use serde_json::Value;
use std::collections::VecDeque;

/// `LOOP_WINDOW`.
pub const LOOP_WINDOW: usize = 12;
/// `LOOP_REPEATS`.
pub const LOOP_REPEATS: usize = 3;
/// `LOOP_ERROR_STREAK`.
pub const LOOP_ERROR_STREAK: usize = 5;

/// `LOOP_WRAP_UP_PROMPT`.
pub const LOOP_WRAP_UP_PROMPT: &str = "You kept repeating tool calls without making progress, so no further tool calls are possible. Answer now with what you already know: what you did, what you found, what is blocking you, and the concrete next steps. Do not ask to run more tools.";

/// `loopNudge`.
pub fn loop_nudge(reason: &str) -> String {
    format!(
        "You appear to be stuck in a loop: {reason}. Repeating it will not change the result. Try a different approach, or if you are blocked, stop calling tools and explain what is blocking you."
    )
}

/// `loopNote`.
pub fn loop_note(reason: &str) -> String {
    format!(
        "_Stopped early: the agent kept repeating itself ({reason}). Ask me to continue and I'll try a different approach._"
    )
}

/// `createLoopDetector`.
#[derive(Default)]
pub struct LoopDetector {
    recent: VecDeque<String>,
    streak_tool: String,
    streak: usize,
}

impl LoopDetector {
    /// Record one finished call; `Some(reason)` when the run looks stuck.
    pub fn push(&mut self, call: &Value, result: &Value) -> Option<String> {
        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
        let is_error = result.get("isError") == Some(&Value::Bool(true));
        let input = call.get("input").cloned().unwrap_or(Value::Null);
        let output = result.get("output").and_then(Value::as_str).unwrap_or("");
        let key = format!("{name}\u{0}{input}\u{0}{}\u{0}{output}", if is_error { 1 } else { 0 });
        self.recent.push_back(key.clone());
        while self.recent.len() > LOOP_WINDOW {
            self.recent.pop_front();
        }

        if is_error && name == self.streak_tool {
            self.streak += 1;
        } else if is_error {
            self.streak_tool = name.to_string();
            self.streak = 1;
        } else {
            self.streak_tool.clear();
            self.streak = 0;
        }

        if self.streak >= LOOP_ERROR_STREAK {
            return Some(format!("{name} failing {} times in a row", self.streak));
        }
        let same = self.recent.iter().filter(|k| **k == key).count();
        if same >= LOOP_REPEATS {
            return Some(format!("{name} with the same input and the same result {same} times"));
        }
        None
    }

    /// Forget the window, so a nudged model gets a clean slate.
    pub fn reset(&mut self) {
        self.recent.clear();
        self.streak_tool.clear();
        self.streak = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trips_on_repeats_but_not_on_changing_results() {
        let mut d = LoopDetector::default();
        let c = json!({ "name": "bash", "input": { "command": "npm test" } });
        for i in 0..10 {
            assert_eq!(d.push(&c, &json!({ "output": format!("{i} failing") })), None);
        }
        let mut d = LoopDetector::default();
        assert_eq!(d.push(&c, &json!({ "output": "1 failing" })), None);
        assert_eq!(d.push(&c, &json!({ "output": "1 failing" })), None);
        assert!(d.push(&c, &json!({ "output": "1 failing" })).unwrap().contains("same input"));
    }

    #[test]
    fn trips_on_an_error_streak() {
        let mut d = LoopDetector::default();
        for i in 1..LOOP_ERROR_STREAK {
            let c = json!({ "name": "bash", "input": { "command": format!("try {i}") } });
            assert_eq!(d.push(&c, &json!({ "output": format!("e{i}"), "isError": true })), None);
        }
        let c = json!({ "name": "bash", "input": { "command": "last" } });
        assert_eq!(d.push(&c, &json!({ "output": "e", "isError": true })).as_deref(), Some("bash failing 5 times in a row"));
    }
}
