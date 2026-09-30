//! Logits to answers: temperature, softmax, confidence, and the Jev response shape.
//!
//! Mirrors `laya.agent.Agent._decode_answers` (laya 0.3.22). Every answer carries the Jev
//! fields (`choice` + `probabilities` + `confidence`, `score` + `legend` + `probabilities` +
//! `confidence`, `noul`) plus Laya's two extras: `answer_confidence` (max probability, the
//! quantity the temperatures were fitted on) and `action.act_probability` (the act/escalate
//! head; Laya's own README says it carries no usable signal yet).

use crate::config::AgentConfig;
use crate::question::{Kind, Question};
use serde_json::{Map, Value, json};

/// Python's `round(x, 4)` closely enough for a probability (ties are measure-zero here).
fn r4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

/// `1 - H(p) / ln(k)`: how concentrated the whole distribution is.
fn entropy_confidence(p: &[f64]) -> f64 {
    let k = p.len();
    if k < 2 {
        return 1.0;
    }
    let h: f64 = -p.iter().map(|&x| x * x.clamp(1e-12, 1.0).ln()).sum::<f64>();
    (1.0 - h / (k as f64).ln()).clamp(0.0, 1.0)
}

/// Temperature-scaled softmax over one row's first `k` logits.
pub fn probabilities(logits: &[f32], temperature: f64) -> Vec<f64> {
    let z: Vec<f64> = logits.iter().map(|&l| f64::from(l) / temperature).collect();
    let max = z.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let e: Vec<f64> = z.iter().map(|&v| (v - max).exp()).collect();
    let sum: f64 = e.iter().sum();
    e.iter().map(|v| v / sum).collect()
}

/// One question's answer from its logit row (slot order) and act logits.
pub fn answer(q: &Question, cfg: &AgentConfig, logits: &[f32], act: &[f32]) -> Value {
    let k = logits.len();
    let slot_p = probabilities(logits, cfg.temperature_for(q.kind, k));
    // Slot s showed option order[s]; put each probability back on its option.
    let p = match &q.order {
        Some(order) if order.len() == k => {
            let mut canonical = vec![0.0; k];
            for (slot, &option) in order.iter().enumerate() {
                canonical[option] = slot_p[slot];
            }
            canonical
        }
        _ => slot_p,
    };
    let act_p = probabilities(act, 1.0).first().copied().unwrap_or(0.0);
    let action = json!({ "act_probability": r4(act_p) });
    let top = p.iter().copied().fold(0.0, f64::max).clamp(0.0, 1.0);
    match q.kind {
        Kind::Choice => {
            // First maximum, like numpy's argmax.
            let best = p.iter().enumerate().fold(0, |b, (i, &v)| if v > p[b] { i } else { b });
            let probs: Map<String, Value> =
                q.keys.iter().zip(&p).map(|(key, &v)| (key.clone(), json!(r4(v)))).collect();
            json!({
                "type": "choice",
                "choice": q.labels[best],
                "probabilities": probs,
                "confidence": r4(entropy_confidence(&p)),
                "answer_confidence": r4(top),
                "action": action,
            })
        }
        Kind::Score => {
            let expected: f64 = p.iter().enumerate().map(|(i, v)| i as f64 * v).sum();
            let legend: Map<String, Value> =
                q.legend.iter().enumerate().map(|(i, text)| (i.to_string(), json!(text))).collect();
            let probs: Map<String, Value> = p.iter().enumerate().map(|(i, &v)| (i.to_string(), json!(r4(v)))).collect();
            json!({
                "type": "score",
                "score": r4(expected),
                "legend": legend,
                "probabilities": probs,
                "confidence": r4(entropy_confidence(&p)),
                "answer_confidence": r4(top),
                "action": action,
            })
        }
        Kind::Noul => {
            let yes = p.get(1).copied().unwrap_or(0.0);
            json!({
                "type": "noul",
                "noul": r4(yes),
                "confidence": r4(yes.max(1.0 - yes)),
                "answer_confidence": r4(top),
                "action": action,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn softmax_is_temperature_scaled_and_normalised() {
        let p = probabilities(&[2.0, 0.0], 2.0);
        assert!((p[0] - 1.0 / (1.0 + (-1.0f64).exp())).abs() < 1e-12);
        assert!((p.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        assert_eq!(probabilities(&[5.0], 1.0), vec![1.0]);
    }

    #[test]
    fn confidence_is_normalised_entropy() {
        assert_eq!(entropy_confidence(&[1.0]), 1.0);
        assert!(entropy_confidence(&[0.5, 0.5]).abs() < 1e-12);
        assert!((entropy_confidence(&[1.0, 0.0]) - 1.0).abs() < 1e-9);
    }
}
