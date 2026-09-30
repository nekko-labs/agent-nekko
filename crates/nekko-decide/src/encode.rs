//! The model input: one token sequence per question.
//!
//! A port of `laya.common.build_sequence` (laya 0.3.22), which is the contract the checkpoint
//! was trained on:
//!
//! ```text
//! [CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]
//! ```
//!
//! Each option starts at its own `[MASK]`, the marker the head scores it at. The options share
//! `head_max_len` tokens (each capped at 48, then all cut evenly when they overflow), the
//! instruction gets what is left of that budget (at least 8), and the state gets whatever
//! remains of `max_len`: from the front for text, from the back for a conversation list so the
//! newest turn survives.

use crate::config::AgentConfig;
use crate::pyjson::dumps;
use crate::question::{Question, sanitize};
use serde_json::Value;
use std::path::Path;
use tokenizers::Tokenizer;

/// Per-option token cap before any budget sharing (`truncation=True, max_length=48`).
const OPTION_TOKENS: usize = 48;

/// One question's row of the batch.
#[derive(Clone, Debug)]
pub struct Row {
    pub ids: Vec<i64>,
    /// Position of each option's marker, in slot order.
    pub markers: Vec<i64>,
    pub qtype: i64,
    /// The state's token count before truncation, and how many of them this row kept.
    pub state_tokens: usize,
    pub state_used: usize,
    /// How many options still have a token span of their own after the head budget cut.
    pub options_distinct: usize,
    /// The per-option cap the head budget forced, when it forced one.
    pub tokens_per_option: Option<usize>,
}

/// Tokenizer plus the checkpoint's budgets and special tokens.
pub struct Encoder {
    tokenizer: Tokenizer,
    pub config: AgentConfig,
    cls: i64,
    sep: i64,
    mask: i64,
    pub pad: i64,
    mask_token: String,
}

/// The state as the model reads it, and whether to keep its tail when it is too long.
pub fn serialize_state(state: &Value) -> (String, bool) {
    match state {
        Value::String(s) => (s.clone(), false),
        Value::Array(_) => (dumps(state), true),
        other => (dumps(other), false),
    }
}

impl Encoder {
    /// Load `tokenizer.json` (at the model dir's root or under `tokenizer/`) and
    /// `rl_agent_config.json`.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let cfg_path = dir.join("rl_agent_config.json");
        let raw = std::fs::read_to_string(&cfg_path).map_err(|e| format!("{}: {e}", cfg_path.display()))?;
        let cfg: Value = serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", cfg_path.display()))?;
        let config = AgentConfig::parse(&cfg)?;

        let tok_path = [dir.join("tokenizer.json"), dir.join("tokenizer").join("tokenizer.json")]
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| format!("no tokenizer.json in {}", dir.display()))?;
        let mut tokenizer = Tokenizer::from_file(&tok_path).map_err(|e| format!("{}: {e}", tok_path.display()))?;
        // The reference calls the tokenizer without padding and truncates only where it says
        // so; a tokenizer.json saved with either enabled must not apply it behind our back.
        tokenizer.with_padding(None);
        tokenizer.with_truncation(None).map_err(|e| e.to_string())?;

        // Special tokens by name, as tokenizer_config.json names them (ModernBERT's defaults).
        let tcfg: Value = [dir.join("tokenizer_config.json"), dir.join("tokenizer").join("tokenizer_config.json")]
            .iter()
            .find_map(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let name = |key: &str, default: &str| {
            tcfg.get(key)
                .and_then(|v| v.as_str().or_else(|| v.get("content").and_then(Value::as_str)))
                .unwrap_or(default)
                .to_string()
        };
        let id = |token: &str| {
            tokenizer.token_to_id(token).map(i64::from).ok_or_else(|| format!("the tokenizer has no {token} token"))
        };
        let mask_token = name("mask_token", "[MASK]");
        Ok(Self {
            cls: id(&name("cls_token", "[CLS]"))?,
            sep: id(&name("sep_token", "[SEP]"))?,
            mask: id(&mask_token)?,
            pad: id(&name("pad_token", "[PAD]"))?,
            mask_token,
            tokenizer,
            config,
        })
    }

    fn tokens(&self, text: &str) -> Result<Vec<i64>, String> {
        let enc = self.tokenizer.encode(text, false).map_err(|e| format!("tokenizer: {e}"))?;
        Ok(enc.get_ids().iter().map(|&t| i64::from(t)).collect())
    }

    /// The state's tokens, computed once and shared by every question.
    pub fn state_tokens(&self, state: &Value) -> Result<(Vec<i64>, bool), String> {
        let (text, left) = serialize_state(state);
        Ok((self.tokens(&sanitize(&text, &self.mask_token))?, left))
    }

    /// `build_sequence` for one question.
    pub fn row(&self, q: &Question, state: &[i64], truncate_left: bool) -> Result<Row, String> {
        let (max_len, head_max_len) = (self.config.max_len, self.config.head_max_len);
        let mut head =
            self.tokens(&format!("{} question: {}", q.kind.name(), sanitize(&q.instructions, &self.mask_token)))?;
        let slots: Vec<usize> = q.order.clone().unwrap_or_else(|| (0..q.options.len()).collect());
        let mut opts = Vec::with_capacity(slots.len());
        for &i in &slots {
            let mut t = self.tokens(&format!(" {}", sanitize(&q.options[i], &self.mask_token)))?;
            t.truncate(OPTION_TOKENS);
            let mut o = Vec::with_capacity(t.len() + 1);
            o.push(self.mask);
            o.extend(t);
            opts.push(o);
        }
        let used = |opts: &[Vec<i64>]| opts.iter().map(Vec::len).sum::<usize>() as i64;
        let mut budget = head_max_len as i64 - used(&opts);
        let mut tokens_per_option = None;
        if budget < 16 {
            let per = 4.max((head_max_len.saturating_sub(16)) / opts.len().max(1));
            tokens_per_option = Some(per);
            for o in &mut opts {
                o.truncate(per);
            }
            budget = head_max_len as i64 - used(&opts);
        }
        head.truncate(budget.max(8) as usize);

        let mut ids = Vec::with_capacity(max_len);
        ids.push(self.cls);
        ids.extend(head);
        ids.push(self.sep);
        let mut markers = Vec::with_capacity(opts.len());
        for o in &opts {
            markers.push(ids.len() as i64);
            ids.extend_from_slice(o);
        }
        ids.push(self.sep);
        let room = max_len.saturating_sub(ids.len() + 1);
        let kept =
            if truncate_left { &state[state.len().saturating_sub(room)..] } else { &state[..state.len().min(room)] };
        ids.extend_from_slice(kept);
        ids.push(self.sep);
        ids.truncate(max_len);
        markers.retain(|&m| (m as usize) < max_len);
        if markers.len() != q.options.len() {
            return Err(format!(
                "question {:?}: only {} of its {} option markers fit in max_len={max_len} with head_max_len={head_max_len} spent on the question; use fewer or shorter options",
                q.id,
                markers.len(),
                q.options.len()
            ));
        }
        let mut distinct = opts.clone();
        distinct.sort();
        distinct.dedup();
        Ok(Row {
            ids,
            markers,
            qtype: q.kind as i64,
            state_tokens: state.len(),
            state_used: kept.len(),
            options_distinct: distinct.len(),
            tokens_per_option,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversations_keep_their_tail_and_text_its_head() {
        assert_eq!(serialize_state(&json!("hi")), ("hi".to_string(), false));
        assert_eq!(serialize_state(&json!([{"role": "user"}])), (r#"[{"role": "user"}]"#.to_string(), true));
        assert_eq!(serialize_state(&json!({"a": 1})).0, r#"{"a": 1}"#);
        assert_eq!(serialize_state(&json!(42)).0, "42");
    }
}
