//! Typed questions: validation and the option texts the model reads.
//!
//! Mirrors `laya.agent.Agent._check_question`, `_to_internal` and `laya.common.render_options`
//! (laya 0.3.22), with one deliberate difference: a malformed question is reported as that
//! question's error instead of failing the whole call, so one bad question in a batch of ten
//! still leaves nine answers.

use crate::pyjson::{dumps, py_json_key, py_str};
use serde_json::Value;

/// Decision head question family; the discriminant is the model's `qtype` input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Choice = 0,
    Score = 1,
    Noul = 2,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Choice => "choice",
            Kind::Score => "score",
            Kind::Noul => "noul",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "choice" => Some(Kind::Choice),
            "score" => Some(Kind::Score),
            "noul" => Some(Kind::Noul),
            _ => None,
        }
    }
}

/// HTTP-facing caps, the same as `laya-serve`'s: they bound what one request can make the
/// tokenizer and the session do. Beyond them a question is refused rather than silently cut.
pub const MAX_CHOICE_OPTIONS: usize = 100;
pub const MAX_SCORE_LEVELS: usize = 32;

/// A validated question, ready to encode.
#[derive(Clone, Debug)]
pub struct Question {
    pub id: String,
    pub kind: Kind,
    /// The instruction text as the model reads it (a structured one is serialized).
    pub instructions: String,
    /// One rendered text per option, in the caller's option order.
    pub options: Vec<String>,
    /// `option_order`: slot `s` shows option `order[s]`.
    pub order: Option<Vec<usize>>,
    /// Choice only: the answer value for each option (the caller's label, JSON type kept).
    pub labels: Vec<Value>,
    /// Choice only: each label as a `probabilities` key.
    pub keys: Vec<String>,
    /// Score only: each level's text, for `legend`.
    pub legend: Vec<String>,
}

const DEFAULT_FALSE: &str = "no, the statement does not hold";
const DEFAULT_TRUE: &str = "yes, the statement holds";

/// `render_criterion`: a string passes through, anything structured becomes compact JSON.
fn render_criterion(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => dumps(other),
    }
}

/// `v is None or v == ""`: the two values that mean "no description".
fn is_blank(v: &Value) -> bool {
    matches!(v, Value::Null) || v.as_str() == Some("")
}

/// Python equality for scalar labels: `1`, `1.0` and `True` are one dict key; `"1"` is not.
fn label_identity(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(format!("s:{s}")),
        Value::Bool(b) => Some(format!("n:{}", if *b { 1.0 } else { 0.0 })),
        Value::Number(n) => n.as_f64().map(|f| format!("n:{f}")),
        _ => None,
    }
}

impl Question {
    /// Validate one `{type, instructions, criteria, labels?, option_order?}` definition.
    pub fn parse(id: &str, def: &Value) -> Result<Self, String> {
        if id.trim().is_empty() {
            return Err(format!("question id must be a non-empty string, got {id:?}"));
        }
        let Some(obj) = def.as_object() else {
            return Err(format!("question {id:?}: definition must be an object"));
        };
        let kind = match obj.get("type").and_then(Value::as_str).and_then(Kind::parse) {
            Some(k) => k,
            None => {
                let got = obj.get("type").map(|t| t.to_string()).unwrap_or_else(|| "none".into());
                return Err(format!("question {id:?}: unknown type {got}; use one of choice, noul, score"));
            }
        };
        let instructions = match obj.get("instructions") {
            None | Some(Value::Null) => {
                return Err(format!("question {id:?}: no 'instructions'; add the text the model should answer"));
            }
            Some(Value::String(s)) if s.trim().is_empty() => {
                return Err(format!("question {id:?}: 'instructions' must not be empty"));
            }
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) if a.is_empty() => {
                return Err(format!("question {id:?}: 'instructions' must not be empty"));
            }
            Some(Value::Object(o)) if o.is_empty() => {
                return Err(format!("question {id:?}: 'instructions' must not be empty"));
            }
            Some(other) => dumps(other),
        };

        let crit = obj.get("criteria").unwrap_or(&Value::Null);
        if obj.contains_key("labels") && kind != Kind::Noul {
            return Err(format!("question {id:?}: 'labels' is only supported for noul questions"));
        }
        let mut q = Question {
            id: id.to_string(),
            kind,
            instructions,
            options: Vec::new(),
            order: None,
            labels: Vec::new(),
            keys: Vec::new(),
            legend: Vec::new(),
        };
        match kind {
            Kind::Choice => q.parse_choice(crit)?,
            Kind::Score => q.parse_score(crit)?,
            Kind::Noul => q.parse_noul(crit, obj.get("labels"))?,
        }
        if let Some(order) = obj.get("option_order") {
            q.order = Some(parse_order(id, order, q.options.len())?);
        }
        Ok(q)
    }

    fn parse_choice(&mut self, crit: &Value) -> Result<(), String> {
        let id = &self.id;
        let entries: Vec<(Value, Value)> = match crit {
            Value::Object(map) => map.iter().map(|(k, v)| (Value::String(k.clone()), v.clone())).collect(),
            Value::Array(list) => {
                let mut seen: Vec<(String, usize)> = Vec::new();
                for (i, label) in list.iter().enumerate() {
                    if label.is_null() {
                        return Err(format!(
                            "question {id:?}: choice label {i} is null; a label is option text and the answer key, so it must be a string, number or bool"
                        ));
                    }
                    let Some(ident) = label_identity(label) else {
                        return Err(format!(
                            "question {id:?}: choice label {i} is structured; a label must be a scalar (a string, number or bool), got {label}"
                        ));
                    };
                    if let Some((_, first)) = seen.iter().find(|(s, _)| *s == ident) {
                        return Err(format!(
                            "question {id:?}: choice label {i} ({}) repeats label {first}; every option needs its own label (1, 1.0 and true are one key)",
                            label
                        ));
                    }
                    seen.push((ident, i));
                }
                list.iter().map(|l| (l.clone(), Value::Null)).collect()
            }
            _ => {
                return Err(format!(
                    "question {id:?}: a choice question takes 'criteria' as an object of label -> description, or a list of labels"
                ));
            }
        };
        if entries.is_empty() {
            return Err(format!("question {id:?}: a choice question needs at least one criterion"));
        }
        if entries.len() > MAX_CHOICE_OPTIONS {
            return Err(format!("question {id:?}: too many choice options ({} > {MAX_CHOICE_OPTIONS})", entries.len()));
        }
        for (label, desc) in entries {
            let text = py_str(&label);
            self.options.push(if is_blank(&desc) { text } else { format!("{text}: {}", render_criterion(&desc)) });
            self.keys.push(py_json_key(&label));
            self.labels.push(label);
        }
        Ok(())
    }

    fn parse_score(&mut self, crit: &Value) -> Result<(), String> {
        let id = &self.id;
        let Some(levels) = crit.as_array() else {
            return Err(format!(
                "question {id:?}: a score question takes 'criteria' as a list of level descriptions, index 0 first"
            ));
        };
        if levels.is_empty() {
            return Err(format!("question {id:?}: a score question needs at least one level"));
        }
        if levels.len() > MAX_SCORE_LEVELS {
            return Err(format!("question {id:?}: too many score levels ({} > {MAX_SCORE_LEVELS})", levels.len()));
        }
        if let Some(i) = levels.iter().position(Value::is_null) {
            return Err(format!("question {id:?}: score level {i} is null; give every level a description"));
        }
        for (i, level) in levels.iter().enumerate() {
            let text = render_criterion(level);
            self.options.push(format!("level {i}: {text}"));
            self.legend.push(text);
        }
        Ok(())
    }

    fn parse_noul(&mut self, crit: &Value, labels: Option<&Value>) -> Result<(), String> {
        let id = &self.id;
        let (mut false_crit, mut true_crit) = (Value::Null, Value::Null);
        match crit {
            Value::Null => {}
            Value::Object(map) => {
                for (k, v) in map {
                    match k.to_lowercase().as_str() {
                        "false" => false_crit = v.clone(),
                        "true" => true_crit = v.clone(),
                        _ => {
                            return Err(format!(
                                "question {id:?}: a noul question takes 'criteria' keyed only 'true'/'false', got {k:?}; set 'labels' to reword the answer"
                            ));
                        }
                    }
                }
            }
            _ => {
                return Err(format!(
                    "question {id:?}: a noul question takes 'criteria' as an object with optional 'true'/'false' descriptions, or omits it"
                ));
            }
        }
        let (false_label, true_label) = match labels {
            None => ("false".to_string(), "true".to_string()),
            Some(v) => noul_labels(v).map_err(|e| format!("question {id:?}: {e}"))?,
        };
        let describe = |c: &Value, default: &str| if is_blank(c) { default.to_string() } else { render_criterion(c) };
        self.options = vec![
            format!("{false_label}: {}", describe(&false_crit, DEFAULT_FALSE)),
            format!("{true_label}: {}", describe(&true_crit, DEFAULT_TRUE)),
        ];
        Ok(())
    }
}

fn noul_labels(v: &Value) -> Result<(String, String), String> {
    const MSG: &str = "noul labels must map exactly 'false' and 'true' to distinct non-empty strings";
    let map = v.as_object().filter(|m| m.len() == 2).ok_or(MSG)?;
    let get = |k: &str| map.get(k).and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    match (get("false"), get("true")) {
        (Some(f), Some(t)) if f != t => Ok((f, t)),
        _ => Err(MSG.into()),
    }
}

fn parse_order(id: &str, order: &Value, n: usize) -> Result<Vec<usize>, String> {
    let bad =
        || format!("question {id:?}: 'option_order' must be a permutation of 0..{n}, one slot per option, got {order}");
    let list = order.as_array().ok_or_else(bad)?;
    let slots: Vec<usize> =
        list.iter().map(|v| v.as_u64().map(|x| x as usize)).collect::<Option<_>>().ok_or_else(bad)?;
    let mut sorted = slots.clone();
    sorted.sort_unstable();
    if sorted != (0..n).collect::<Vec<_>>() {
        return Err(bad());
    }
    Ok(slots)
}

/// The instruction `laya` strips from every text it tokenizes: a literal mask token in user text
/// would otherwise become an extra option marker.
pub fn sanitize(text: &str, mask: &str) -> String {
    text.replace(mask, " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_options_like_laya() {
        let q = Question::parse(
            "d",
            &json!({"type": "choice", "instructions": "x", "criteria": {"a": "first", "b": "", "c": null, "d": 0, "e": {"k": [1]}}}),
        )
        .unwrap();
        assert_eq!(q.options, vec!["a: first", "b", "c", "d: 0", "e: {\"k\": [1]}"]);
        let s = Question::parse("s", &json!({"type": "score", "instructions": "x", "criteria": ["low", {"l": 1}]}))
            .unwrap();
        assert_eq!(s.options, vec!["level 0: low", "level 1: {\"l\": 1}"]);
        assert_eq!(s.legend, vec!["low", "{\"l\": 1}"]);
        let n = Question::parse("n", &json!({"type": "noul", "instructions": "x", "criteria": {"True": "yes it is"}}))
            .unwrap();
        assert_eq!(n.options, vec!["false: no, the statement does not hold", "true: yes it is"]);
        let l = Question::parse(
            "l",
            &json!({"type": "noul", "instructions": "x", "labels": {"false": " no ", "true": "yes"}}),
        )
        .unwrap();
        assert_eq!(l.options[0], "no: no, the statement does not hold");
    }

    #[test]
    fn list_labels_keep_their_type() {
        let q = Question::parse("q", &json!({"type": "choice", "instructions": "x", "criteria": [true, 2.5, 3, "z"]}))
            .unwrap();
        assert_eq!(q.options, vec!["True", "2.5", "3", "z"]);
        assert_eq!(q.keys, vec!["true", "2.5", "3", "z"]);
        assert_eq!(q.labels[0], json!(true));
    }

    #[test]
    fn bad_questions_name_the_problem() {
        let cases = [
            json!({"type": "maybe", "instructions": "x"}),
            json!({"type": "noul"}),
            json!({"type": "noul", "instructions": "  "}),
            json!({"type": "choice", "instructions": "x"}),
            json!({"type": "choice", "instructions": "x", "criteria": []}),
            json!({"type": "choice", "instructions": "x", "criteria": [1, 1.0]}),
            json!({"type": "choice", "instructions": "x", "criteria": [null]}),
            json!({"type": "choice", "instructions": "x", "criteria": [[1]]}),
            json!({"type": "score", "instructions": "x", "criteria": {"a": 1}}),
            json!({"type": "score", "instructions": "x", "criteria": ["a", null]}),
            json!({"type": "noul", "instructions": "x", "criteria": {"maybe": "?"}}),
            json!({"type": "noul", "instructions": "x", "labels": {"false": "same", "true": "same"}}),
            json!({"type": "choice", "instructions": "x", "criteria": ["a"], "labels": {}}),
            json!({"type": "choice", "instructions": "x", "criteria": ["a", "b"], "option_order": [0, 0]}),
            json!("not an object"),
        ];
        for def in cases {
            let err = Question::parse("q", &def).unwrap_err();
            assert!(err.contains("\"q\""), "{err}");
        }
        assert!(Question::parse(" ", &json!({"type": "noul", "instructions": "x"})).is_err());
    }
}
