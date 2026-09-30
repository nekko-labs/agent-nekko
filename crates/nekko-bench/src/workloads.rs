//! The workloads. Each one is what a local model is actually asked to do by
//! an agent, not a synthetic best case, and each is identical for every server.

use crate::client::{Sample, Target, chat};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Instant;

/// Deterministic filler that tokenizes like source code and project notes.
/// Same bytes on every run and every machine.
pub fn synthetic_context(approx_tokens: usize) -> String {
    const WORDS: &[&str] = &[
        "const",
        "let",
        "function",
        "return",
        "await",
        "session",
        "workspace",
        "provider",
        "model",
        "config",
        "request",
        "response",
        "stream",
        "token",
        "cache",
        "index",
        "render",
        "update",
        "error",
        "value",
        "=>",
        "{",
        "}",
        "(",
        ")",
        ";",
        "if",
        "else",
        "for",
        "of",
        "import",
        "export",
        "type",
        "interface",
    ];
    let mut seed: u64 = 0x5eed;
    let mut out = String::with_capacity(approx_tokens * 5);
    let mut n = 0;
    let mut line = 0;
    while n < approx_tokens {
        line += 1;
        out.push_str(&format!("// line {line}: "));
        for _ in 0..12 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            out.push_str(WORDS[(seed >> 33) as usize % WORDS.len()]);
            out.push(' ');
            n += 1;
        }
        out.push('\n');
        n += 4;
    }
    out
}

/// A ~200-line TypeScript module an edit request can repeat back.
pub fn code_file() -> String {
    let mut out = String::from("import { db } from './db';\n\n");
    for i in 0..24 {
        out.push_str(&format!(
            "export async function fetchUser{i}(id: string) {{\n  const row = await db.users.find(id);\n  if (!row) throw new Error(`user ${{id}} not found`);\n  const profile = await fetchUserProfile(row.profileId);\n  return {{ ...row, profile, index: {i} }};\n}}\n\n"
        ));
    }
    out.push_str("export async function fetchUserProfile(id: string) {\n  return db.profiles.find(id);\n}\n");
    out
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub prefill_tps: Option<f64>,
    /// Multi-turn: time to first token on the first turn, then on later turns.
    pub first_turn_ttft_ms: Option<f64>,
    pub later_turns_ttft_ms: Option<f64>,
    pub total_ms: Option<f64>,
    /// Concurrent: generated tokens per second across all requests.
    pub aggregate_tps: Option<f64>,
    pub exact_token_counts: bool,
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(v[v.len() / 2])
}

fn user(text: impl Into<String>) -> Value {
    json!({ "role": "user", "content": text.into() })
}

pub async fn warm_up(http: &reqwest::Client, t: &Target) -> anyhow::Result<()> {
    chat(http, t, &[user("Say ok.")], 4).await.map(|_| ())
}

pub async fn decode(http: &reqwest::Client, t: &Target, repeats: usize) -> anyhow::Result<Metrics> {
    let msg = [user("Explain in about 400 words how a hash map works, with a short worked example.")];
    let mut samples = Vec::new();
    for _ in 0..repeats {
        samples.push(chat(http, t, &msg, 512).await?.0);
    }
    Ok(summarize(&samples))
}

pub async fn prefill(http: &reqwest::Client, t: &Target, repeats: usize) -> anyhow::Result<Metrics> {
    let mut samples = Vec::new();
    for r in 0..repeats {
        // A different leading line each repeat, so a prompt cache cannot turn
        // a prefill measurement into a cache-hit measurement.
        let body = format!("Run {r}.\n{}\nSummarize the code above in one sentence.", synthetic_context(8000));
        samples.push(chat(http, t, &[user(body)], 16).await?.0);
    }
    Ok(summarize(&samples))
}

/// An agent session: a large system prompt, then turns that each resend the
/// whole conversation. This is where a prompt cache that survives between
/// turns shows up, as a later-turn time to first token near zero.
pub async fn agent(http: &reqwest::Client, t: &Target, repeats: usize) -> anyhow::Result<Metrics> {
    let questions = [
        "Which functions touch the session cache?",
        "What would you rename first, and why?",
        "Write a one-paragraph plan for the refactor.",
        "List the risks of that plan.",
        "Summarize everything so far in three bullets.",
        "What is the first command you would run?",
    ];
    let mut firsts = Vec::new();
    let mut laters = Vec::new();
    let mut totals = Vec::new();
    for r in 0..repeats {
        let mut messages = vec![json!({
            "role": "system",
            "content": format!("Session {r}. You are a coding agent. Project context follows.\n{}", synthetic_context(6000)),
        })];
        let started = Instant::now();
        for (i, q) in questions.iter().enumerate() {
            messages.push(user(*q));
            let (s, reply) = chat(http, t, &messages, 96).await?;
            if i == 0 {
                firsts.push(s.ttft_ms);
            } else {
                laters.push(s.ttft_ms);
            }
            messages.push(json!({ "role": "assistant", "content": reply }));
        }
        totals.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(Metrics {
        first_turn_ttft_ms: median(firsts),
        later_turns_ttft_ms: median(laters),
        total_ms: median(totals),
        ..Default::default()
    })
}

/// More chats than the server has slots, visited in turn: what a person with
/// several agent chats open does. A chat's cache has usually been pushed out
/// of its slot by the time it is visited again, so this measures how well a
/// server gets it back (a RAM prompt cache) instead of re-reading it.
pub async fn rotate(http: &reqwest::Client, t: &Target, _repeats: usize) -> anyhow::Result<Metrics> {
    const CHATS: usize = 6;
    const ROUNDS: usize = 3;
    let mut chats: Vec<Vec<Value>> = (0..CHATS)
        .map(|c| {
            vec![json!({
                "role": "system",
                "content": format!("Chat {c}. You are a coding agent. Project context follows.
            {}", synthetic_context(6000)),
            })]
        })
        .collect();
    let mut first_visits = Vec::new();
    let mut revisits = Vec::new();
    let started = Instant::now();
    for round in 0..ROUNDS {
        for chat in chats.iter_mut() {
            chat.push(user(format!("Round {round}: what should change next?")));
            let (s, reply) = crate::client::chat(http, t, chat, 48).await?;
            if round == 0 {
                first_visits.push(s.ttft_ms)
            } else {
                revisits.push(s.ttft_ms)
            }
            chat.push(json!({ "role": "assistant", "content": reply }));
        }
    }
    Ok(Metrics {
        first_turn_ttft_ms: median(first_visits),
        later_turns_ttft_ms: median(revisits),
        total_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
        ..Default::default()
    })
}

/// An edit whose answer repeats most of its input: the case speculative
/// decoding from the prompt (n-gram lookup) is built for.
pub async fn code_edit(http: &reqwest::Client, t: &Target, repeats: usize) -> anyhow::Result<Metrics> {
    let prompt = format!(
        "Here is a file:\n```ts\n{}```\nReturn the complete file with every `fetchUserProfile` renamed to `loadUserProfile`. Output only the code.",
        code_file()
    );
    let mut samples = Vec::new();
    for _ in 0..repeats {
        samples.push(chat(http, t, &[user(prompt.clone())], 3000).await?.0);
    }
    Ok(summarize(&samples))
}

/// Four requests at once, the shape of parallel sub-agents.
pub async fn concurrent(http: &reqwest::Client, t: &Target, repeats: usize) -> anyhow::Result<Metrics> {
    const N: usize = 4;
    let mut aggregates = Vec::new();
    for _ in 0..repeats {
        let started = Instant::now();
        let runs = (0..N).map(|i| {
            let msg = vec![user(format!("Request {i}. Explain in about 300 words how TCP congestion control works."))];
            async move { chat(http, t, &msg, 384).await }
        });
        let results = futures_util::future::join_all(runs).await;
        let tokens: u64 = results.iter().filter_map(|r| r.as_ref().ok()).map(|(s, _)| s.completion_tokens).sum();
        if let Some(Err(e)) = results.into_iter().find(|r| r.is_err()) {
            return Err(e);
        }
        aggregates.push(tokens as f64 / started.elapsed().as_secs_f64());
    }
    Ok(Metrics { aggregate_tps: median(aggregates), ..Default::default() })
}

fn summarize(samples: &[Sample]) -> Metrics {
    Metrics {
        ttft_ms: median(samples.iter().map(|s| s.ttft_ms).collect()),
        decode_tps: median(samples.iter().filter_map(Sample::decode_tps).collect()),
        prefill_tps: median(samples.iter().filter_map(Sample::prefill_tps).collect()),
        total_ms: median(samples.iter().map(|s| s.total_ms).collect()),
        exact_token_counts: samples.iter().all(|s| s.counted_by_server),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_context_is_deterministic_and_roughly_sized() {
        let a = synthetic_context(1000);
        assert_eq!(a, synthetic_context(1000));
        let words = a.split_whitespace().count();
        assert!((700..1600).contains(&words), "{words} words");
    }

    #[test]
    fn median_ignores_nan() {
        assert_eq!(median(vec![3.0, f64::NAN, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(vec![]), None);
    }

    #[test]
    fn decode_rate_excludes_the_first_token() {
        let s = Sample {
            ttft_ms: 100.0,
            total_ms: 1100.0,
            prompt_tokens: Some(50),
            completion_tokens: 101,
            counted_by_server: true,
        };
        assert_eq!(s.decode_tps(), Some(100.0));
        assert_eq!(s.prefill_tps(), Some(500.0));
    }
}
