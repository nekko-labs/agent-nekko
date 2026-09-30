//! `nekkod`, the Agent Nekko engine daemon.
//!
//! Started by the desktop app with a JSON config in `NEKKOD_CONFIG` (see
//! `config.rs`). Prints one line, `NEKKOD_READY {"port":N,"pid":P}`, once it
//! is listening; everything else goes to stderr. Exits when its stdin closes.

mod backend;
mod config;
mod hub;
mod procgroup;
mod routes;
mod wire;

use backend::Backend;
use hub::Hub;
use nekko_term::Registry;
use routes::Ctx;
use std::io::Write;
use std::sync::Arc;

/// 32 random bytes as hex.
pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("the OS random source is available");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() -> std::process::ExitCode {
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("nekkod: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    // The token must not leak into the environment of every shell we start.
    // SAFETY: no other thread exists yet.
    unsafe { std::env::remove_var("NEKKOD_CONFIG") };
    procgroup::init();

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(run(cfg)) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("nekkod: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run(cfg: config::Config) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(&cfg.listen).await?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}");

    let hub = Hub::new();
    let terminals = Arc::new(Registry::new());
    let backend = match cfg.backend.clone() {
        Some(cmd) => Backend::spawn(cmd, url.clone(), cfg.token.clone(), hub.clone()),
        None => Backend::disabled(),
    };
    let ctx = Ctx { terminals: terminals.clone(), backend: backend.clone(), hub };
    routes::forward_terminal_events(&ctx);

    let app = wire::App { ctx, token: cfg.token.clone().into(), origins: Arc::new(cfg.allowed_origins.clone()) };
    let router = wire::router(app);

    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "NEKKOD_READY {}", serde_json::json!({ "port": port, "pid": std::process::id() }))?;
        out.flush()?;
    }

    axum::serve(listener, router).with_graceful_shutdown(shutdown_signal(cfg.exit_on_stdin_close)).await?;

    backend.shutdown().await;
    terminals.close_all();
    Ok(())
}

/// Resolves when the app that started us is gone (stdin closed) or on Ctrl-C.
async fn shutdown_signal(watch_stdin: bool) {
    let stdin_closed = async {
        if !watch_stdin {
            return std::future::pending::<()>().await;
        }
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin();
            loop {
                match std::io::Read::read(&mut stdin, &mut sink) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = tx.send(());
        });
        let _ = rx.await;
    };
    tokio::select! {
        _ = stdin_closed => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
