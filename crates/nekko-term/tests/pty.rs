//! Real-pty tests. The flood tests re-run this test binary as the program in
//! the terminal (see `producer`), so they need no platform-specific tool that
//! can write megabytes quickly.

use nekko_term::{CreateSpec, HIGH_WATER, Registry, ShellOption, StreamMsg};
use std::time::{Duration, Instant};

const PRODUCE_ENV: &str = "NEKKO_TERM_TEST_PRODUCE";

/// Not a test of its own: when the env var is set, this process is the
/// program inside the pty and writes that many bytes of output.
#[test]
fn producer() {
    let Ok(n) = std::env::var(PRODUCE_ENV) else {
        return;
    };
    use std::io::Write;
    let n: usize = n.parse().unwrap();
    let line = [b'x'; 1023];
    let mut out = std::io::stdout().lock();
    let mut written = 0;
    while written < n {
        out.write_all(&line).unwrap();
        out.write_all(b"\n").unwrap();
        written += 1024;
    }
    out.flush().unwrap();
}

fn self_as_producer() -> ShellOption {
    ShellOption {
        id: "producer".into(),
        label: "producer".into(),
        path: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
        args: Some(vec!["--exact".into(), "producer".into(), "--nocapture".into(), "--test-threads=1".into()]),
    }
}

fn echo(text: &str) -> ShellOption {
    if cfg!(windows) {
        ShellOption {
            id: "cmd".into(),
            label: "cmd".into(),
            path: "cmd.exe".into(),
            args: Some(vec!["/c".into(), format!("echo {text}")]),
        }
    } else {
        ShellOption {
            id: "sh".into(),
            label: "sh".into(),
            path: "/bin/sh".into(),
            args: Some(vec!["-c".into(), format!("echo {text}")]),
        }
    }
}

fn spec(shell: ShellOption) -> CreateSpec {
    CreateSpec { title: None, workspace_id: None, cwd: std::env::temp_dir(), shell, cols: 120, rows: 30, env: vec![] }
}

fn producing(bytes: usize) -> CreateSpec {
    CreateSpec { env: vec![(PRODUCE_ENV.into(), bytes.to_string())], ..spec(self_as_producer()) }
}

/// Collect a subscription until exit, acking as it goes.
async fn drain(sub: &mut nekko_term::Subscription, limit: Duration) -> (Vec<u8>, Option<Option<i32>>) {
    let mut out = sub.snapshot.clone();
    if let Some(code) = sub.exit {
        return (out, Some(code));
    }
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, sub.rx.recv()).await {
            Ok(Some(StreamMsg::Data(b))) => {
                sub.ack(b.len());
                out.extend_from_slice(&b);
            }
            Ok(Some(StreamMsg::Exit(code))) => return (out, Some(code)),
            _ => return (out, None),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_output_and_reports_exit() {
    let reg = Registry::new();
    let info = reg.create(spec(echo("hello-nekko")));
    assert!(info.running);
    let mut sub = reg.subscribe(&info.id).expect("subscribes");
    let (out, exit) = drain(&mut sub, Duration::from_secs(20)).await;
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("hello-nekko"), "output was {text:?}");
    assert_eq!(exit, Some(Some(0)));
    let listed = reg.list();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].running);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_subscriber_gets_the_scrollback() {
    let reg = Registry::new();
    let info = reg.create(spec(echo("late-joiner")));
    let mut first = reg.subscribe(&info.id).unwrap();
    drain(&mut first, Duration::from_secs(20)).await;
    let late = reg.subscribe(&info.id).unwrap();
    assert!(String::from_utf8_lossy(&late.snapshot).contains("late-joiner"));
    assert!(late.exit.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subscriber_that_does_not_ack_holds_the_program_back() {
    let reg = Registry::new();
    let total = 32 * 1024 * 1024;
    let info = reg.create(producing(total));
    let mut sub = reg.subscribe(&info.id).unwrap();

    // Read without acknowledging for well under the stall window.
    let mut received = 0usize;
    let until = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < until {
        match tokio::time::timeout(Duration::from_millis(50), sub.rx.recv()).await {
            Ok(Some(StreamMsg::Data(b))) => received += b.len(),
            Ok(Some(StreamMsg::Exit(_))) => panic!("producer finished without backpressure"),
            _ => {}
        }
    }
    // The pump may overshoot by one batch per recheck, never by the flood.
    assert!(received <= HIGH_WATER * 2, "received {received} unacked bytes");
    assert!(received > 0);

    // Acknowledge and the rest arrives.
    sub.ack(received);
    let (rest, exit) = drain(&mut sub, Duration::from_secs(60)).await;
    assert!(exit.is_some(), "producer never finished");
    assert!(received + rest.len() >= total, "got {} of {total}", received + rest.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_subscriber_stops_blocking_the_program() {
    let reg = Registry::new();
    let total = 8 * 1024 * 1024;
    let info = reg.create(producing(total));
    let _stuck = reg.subscribe(&info.id).unwrap();
    // Never ack. After the stall window the program must be allowed to finish.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !reg.list().iter().any(|t| t.id == info.id && t.running) {
            break;
        }
        assert!(Instant::now() < deadline, "a stalled viewer froze the program");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_shell_reports_failure_instead_of_panicking() {
    let reg = Registry::new();
    let info = reg.create(spec(ShellOption {
        id: "nope".into(),
        label: "nope".into(),
        path: "/no/such/shell-for-nekko".into(),
        args: None,
    }));
    // Either spawn fails up front, or the child exits non-zero at once.
    let mut sub = reg.subscribe(&info.id).unwrap();
    let (_, exit) = drain(&mut sub, Duration::from_secs(10)).await;
    let code = exit.expect("reports an exit").unwrap_or(-1);
    assert_ne!(code, 0);
}

/// Keystroke-to-echo through the pty alone (no socket, no renderer): the
/// floor the terminal path sits on. Ignored by default; run with
/// `cargo test -p nekko-term --release -- --ignored --nocapture echo_latency`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn echo_latency_floor() {
    let shells: Vec<ShellOption> = nekko_term::detect_shells();
    for shell in shells {
        let reg = Registry::new();
        let info = reg.create(spec(shell.clone()));
        let mut sub = reg.subscribe(&info.id).unwrap();
        // Let the prompt settle.
        let settle = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < settle {
            if let Ok(Some(StreamMsg::Data(b))) = tokio::time::timeout(Duration::from_millis(100), sub.rx.recv()).await
            {
                sub.ack(b.len());
            }
        }
        let mut samples = Vec::new();
        for i in 0..40u8 {
            let ch = b'a' + (i % 26);
            let t = Instant::now();
            sub.handle.write(&[ch]);
            let deadline = t + Duration::from_millis(500);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, sub.rx.recv()).await {
                    Ok(Some(StreamMsg::Data(b))) => {
                        sub.ack(b.len());
                        if b.contains(&ch) {
                            samples.push(t.elapsed().as_secs_f64() * 1000.0);
                            break;
                        }
                    }
                    _ => break,
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        reg.write(&info.id, b"\x15");
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| samples.get(((samples.len() as f64) * q) as usize).copied().unwrap_or(f64::NAN);
        println!("{:<20} n={:<3} p50={:>6.2}ms p95={:>6.2}ms", shell.label, samples.len(), p(0.5), p(0.95));
        reg.close(&info.id);
    }
}
