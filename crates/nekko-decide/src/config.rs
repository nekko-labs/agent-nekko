//! `rl_agent_config.json`: the token budgets and calibration temperatures a checkpoint ships.

use crate::question::Kind;
use serde_json::Value;
use std::collections::BTreeMap;

/// laya 0.3.22 refuses to apply a fitted temperature outside this range: the English
/// checkpoint's `choice:11+` bucket is 0.1006, a 10x sharpener that turns a 0.24 top
/// probability into 0.99. Clamping here keeps this runtime's probabilities equal to the
/// reference package's, which is what the golden tests compare against.
pub const TEMP_MIN: f64 = 0.5;
pub const TEMP_MAX: f64 = 5.0;

#[derive(Clone, Debug)]
pub struct AgentConfig {
    pub max_len: usize,
    pub head_max_len: usize,
    /// Per question type (choice, score, noul), after clamping.
    pub temperature: [f64; 3],
    /// Per `"<type>:<size bucket>"`, after clamping.
    pub temperature_by_options: BTreeMap<String, f64>,
    /// Buckets the clamp changed, as `name=raw -> applied`, so status can say which
    /// confidences are uncalibrated.
    pub clamped: Vec<String>,
}

fn clamp(t: f64) -> f64 {
    if t.is_finite() { t.clamp(TEMP_MIN, TEMP_MAX) } else { 1.0 }
}

impl AgentConfig {
    pub fn parse(v: &Value) -> Result<Self, String> {
        let num = |k: &str, d: usize| v.get(k).and_then(Value::as_u64).map(|n| n as usize).unwrap_or(d);
        let max_len = num("max_len", 512);
        let head_max_len = num("head_max_len", 192);
        if max_len < 16 || head_max_len >= max_len {
            return Err(format!("rl_agent_config.json: bad budgets max_len={max_len} head_max_len={head_max_len}"));
        }
        let mut clamped = Vec::new();
        let mut temperature = [1.0; 3];
        match v.get("temperature") {
            None => {}
            Some(Value::Array(t)) if t.len() == 3 => {
                for (i, raw) in t.iter().enumerate() {
                    let raw = raw.as_f64().unwrap_or(f64::NAN);
                    temperature[i] = clamp(raw);
                    if temperature[i] != raw {
                        clamped.push(format!("temperature[{i}]={raw} -> {}", temperature[i]));
                    }
                }
            }
            Some(other) => {
                return Err(format!("rl_agent_config.json: temperature must be a list of 3 floats, got {other}"));
            }
        }
        let mut temperature_by_options = BTreeMap::new();
        if let Some(map) = v.get("temperature_by_options").and_then(Value::as_object) {
            for (k, raw) in map {
                let raw = raw.as_f64().unwrap_or(f64::NAN);
                let t = clamp(raw);
                if t != raw {
                    clamped.push(format!("{k}={raw} -> {t}"));
                }
                temperature_by_options.insert(k.clone(), t);
            }
        }
        Ok(Self { max_len, head_max_len, temperature, temperature_by_options, clamped })
    }

    /// `temp_bucket` + lookup: the bucket's temperature, else the question type's.
    pub fn temperature_for(&self, kind: Kind, k: usize) -> f64 {
        let size = match k {
            0..=2 => "2",
            3..=5 => "3-5",
            6..=10 => "6-10",
            _ => "11+",
        };
        let key = format!("{}:{size}", kind.name());
        self.temperature_by_options.get(&key).copied().unwrap_or(self.temperature[kind as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamps_and_buckets_like_laya() {
        let cfg = AgentConfig::parse(&json!({
            "max_len": 512, "head_max_len": 192,
            "temperature": [1.6, 1.25, 1.98],
            "temperature_by_options": {"choice:11+": 0.1006, "choice:2": 1.9}
        }))
        .unwrap();
        assert_eq!(cfg.temperature_for(Kind::Choice, 13), 0.5);
        assert_eq!(cfg.temperature_for(Kind::Choice, 2), 1.9);
        assert_eq!(cfg.temperature_for(Kind::Choice, 4), 1.6);
        assert_eq!(cfg.temperature_for(Kind::Noul, 2), 1.98);
        assert_eq!(cfg.clamped.len(), 1);
    }
}
