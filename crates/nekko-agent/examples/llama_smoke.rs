//! Live smoke test: stream one completion from a running llama.cpp server
//! (or anything OpenAI-compatible) through the `llamacpp` provider, over the
//! real wire. Not run in CI.
//!
//! ```text
//! LLAMA_URL=http://127.0.0.1:8080 cargo run -p nekko-agent --example llama_smoke
//! ```
//!
//! `LLAMA_MODEL` names the model (llama-server serves whatever it loaded, so
//! any name works there) and `LLAMA_THINK=0|1` sets the reasoning toggle.

use nekko_agent::*;
use serde_json::json;
use std::io::Write;
use std::time::Instant;

#[tokio::main]
async fn main() {
    let Ok(url) = std::env::var("LLAMA_URL") else {
        eprintln!("set LLAMA_URL to a running llama.cpp server, e.g. http://127.0.0.1:8080");
        std::process::exit(2);
    };
    let config: ProviderConfig = match serde_json::from_value(json!({
        "id": "smoke", "kind": "llamacpp", "label": "smoke", "baseUrl": url, "enabled": true,
    })) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bad config: {e}");
            std::process::exit(2);
        }
    };
    let provider = create_provider(config);

    match provider.list_models().await {
        Ok(models) => println!("models: {:?}", models.iter().map(|m| &m.id).collect::<Vec<_>>()),
        Err(e) => println!("list_models failed: {e}"),
    }

    let req = ChatRequest {
        model: std::env::var("LLAMA_MODEL").unwrap_or_else(|_| "default".into()),
        system: Some("You are terse.".into()),
        messages: vec![ChatMessage::new(Role::User, "In one sentence: why is the sky blue?")],
        think: std::env::var("LLAMA_THINK").ok().map(|v| v == "1"),
        max_output_tokens: Some(256),
        temperature: Some(0.2),
        ..Default::default()
    };
    let started = Instant::now();
    let mut first = None;
    let mut stream = provider.chat(req);
    let mut failed = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(ProviderChunk::Text { delta }) | Ok(ProviderChunk::Reasoning { delta }) => {
                first.get_or_insert_with(|| started.elapsed());
                print!("{delta}");
                let _ = std::io::stdout().flush();
            }
            Ok(ProviderChunk::Usage { input_tokens, output_tokens, output_ms }) => {
                let rate = output_ms.map(|ms| output_tokens as f64 * 1000.0 / ms as f64);
                println!(
                    "\n\nusage: {input_tokens} in, {output_tokens} out, decode {output_ms:?} ms, {rate:.1?} tok/s"
                );
            }
            Ok(other) => println!("\n{other:?}"),
            Err(e) => {
                println!("\nerror: {e}");
                failed = true;
            }
        }
    }
    println!("first token after {first:?}, total {:?}", started.elapsed());
    if failed {
        std::process::exit(1);
    }
}
