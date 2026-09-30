//! End-to-end: the real `nekkod` binary, with this test binary re-run as a fake
//! TS backend (see `fake_backend`), exercised over HTTP and both sockets.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const TOKEN: &str = "test-token-0123456789abcdef";
const FAKE_ENV: &str = "NEKKOD_TEST_FAKE_BACKEND";

/// Not a test of its own: with the env var set, this process is the backend.
/// It answers every channel with an echo, serves `settings:get`, and pushes
/// one event (plus a terminal echo the daemon must drop) to each events socket.
#[test]
fn fake_backend() {
    if std::env::var(FAKE_ENV).is_err() {
        return;
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        use axum::extract::ws::{Message as AMessage, WebSocketUpgrade};
        use axum::extract::{Path, Query};
        use axum::routing::{get, post};
        use std::collections::HashMap;
        let token = std::env::var("NEKKO_BACKEND_TOKEN").unwrap();
        assert!(std::env::var("NEKKOD_URL").unwrap().starts_with("http://127.0.0.1:"));
        let t1 = token.clone();
        let app = axum::Router::new()
            .route(
                "/api/{channel}",
                post(move |Path(channel): Path<String>, headers: axum::http::HeaderMap, body: axum::Json<Value>| {
                    let ok = headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {t1}"));
                    async move {
                        if !ok {
                            return (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({"error":"bad token"})));
                        }
                        match channel.as_str() {
                            "settings:get" => (axum::http::StatusCode::OK, axum::Json(json!({ "workspaces": [] }))),
                            "terminals:list:agent" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!([{ "id": "agent_s1", "title": "Agent commands" }])),
                            ),
                            "fail:please" => {
                                (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "asked to fail" })))
                            }
                            _ => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!({ "echo": channel, "args": body.0.get("args") })),
                            ),
                        }
                    }
                }),
            )
            .route(
                "/api/events",
                get(move |ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>| {
                    let ok = q.get("token") == Some(&token);
                    async move {
                        ws.on_upgrade(move |mut socket| async move {
                            if !ok {
                                return;
                            }
                            let echo = json!({"channel":"terminal:event","payload":{"type":"data","terminalId":"term_x","data":"dup"}});
                            let _ = socket.send(AMessage::Text(echo.to_string().into())).await;
                            // Repeated, not sent once: a client that subscribes to the
                            // daemon after this socket opened must still see one.
                            let ev = json!({"channel":"agent:event","payload":{"type":"hello-from-backend"}});
                            let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                            loop {
                                tokio::select! {
                                    _ = tick.tick() => {
                                        if socket.send(AMessage::Text(ev.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    msg = socket.recv() => {
                                        if !matches!(msg, Some(Ok(_))) {
                                            break;
                                        }
                                    }
                                }
                            }
                        })
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        println!("NEKKO_BACKEND_READY {}", json!({ "port": port }));
        // Exit when the daemon closes our stdin, like the real backend.
        let stdin_closed = async {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            std::thread::spawn(move || {
                let mut b = [0u8; 64];
                while matches!(std::io::Read::read(&mut std::io::stdin(), &mut b), Ok(n) if n > 0) {}
                let _ = tx.send(());
            });
            let _ = rx.await;
        };
        axum::serve(listener, app).with_graceful_shutdown(stdin_closed).await.unwrap();
    });
}

struct Daemon {
    child: Child,
    port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn start(with_backend: bool) -> Daemon {
    start_with(with_backend, None)
}

fn start_with(with_backend: bool, data_dir: Option<&std::path::Path>) -> Daemon {
    let backend = with_backend.then(|| {
        json!({
            "exe": std::env::current_exe().unwrap(),
            "args": ["--exact", "fake_backend", "--nocapture", "--test-threads=1"],
            "env": { FAKE_ENV: "1" },
        })
    });
    let config = json!({ "token": TOKEN, "backend": backend, "allowedOrigins": ["null"], "dataDir": data_dir });
    let mut child = Command::new(env!("CARGO_BIN_EXE_nekkod"))
        .env("NEKKOD_CONFIG", config.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("nekkod starts");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = lines.next().expect("a ready line").unwrap();
    let ready: Value = serde_json::from_str(line.strip_prefix("NEKKOD_READY ").expect("ready prefix")).unwrap();
    std::thread::spawn(move || for _ in lines {});
    Daemon { child, port: ready["port"].as_u64().unwrap() as u16 }
}

async fn post(port: u16, channel: &str, args: Value, token: Option<&str>) -> (u16, Value) {
    let mut req =
        reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/{channel}")).json(&json!({ "args": args }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, or say why not (as a string: tungstenite's error type is large).
async fn ws(port: u16, path: &str, origin: Option<&str>) -> Result<Socket, String> {
    let mut req = format!("ws://127.0.0.1:{port}{path}").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s).map_err(|e| e.to_string())
}

async fn next_json<S>(socket: &mut S, limit: Duration) -> Option<Value>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, socket.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn forwards_unported_channels_and_serves_owned_ones() {
    let d = start(true);
    let (status, body) = post(d.port, "sessions:list", json!([1, "two"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "echo": "sessions:list", "args": [1, "two"] }));

    let (status, body) = post(d.port, "fail:please", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "asked to fail");

    let (status, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(info["app"], "nekkod");

    // Owned list merges the backend's agent logs.
    let (_, list) = post(d.port, "terminals:list", json!([]), Some(TOKEN)).await;
    assert!(list.as_array().unwrap().iter().any(|t| t["id"] == "agent_s1"));

    // Decision models are the daemon's, never forwarded; with none loaded they say so.
    assert!(info["owned"].as_array().unwrap().iter().any(|c| c == "decide:run"));
    let (status, st) = post(d.port, "decide:status", json!([]), Some(TOKEN)).await;
    assert_eq!((status, st["loaded"].clone()), (200, json!(false)));
    let (status, body) = post(d.port, "decide:run", json!([{ "state": "x", "questions": {} }]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("No decision model"), "{body}");
    let (status, _) = post(d.port, "decide:load", json!(["/no/such/model/dir"]), Some(TOKEN)).await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_missing_tokens_and_foreign_origins() {
    let d = start(false);
    let (status, _) = post(d.port, "daemon:info", json!([]), None).await;
    assert_eq!(status, 401);
    let (status, _) = post(d.port, "daemon:info", json!([]), Some("wrong-token-0123456789")).await;
    assert_eq!(status, 401);
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("https://evil.example")).await.is_err());
    assert!(ws(d.port, "/api/ws?token=nope", Some("null")).await.is_err());
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn rpc_socket_carries_replies_and_relayed_events() {
    let d = start(true);
    let mut sock = ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.unwrap();
    sock.send(Message::Text(json!({ "id": 7, "channel": "models:list", "args": ["p1"] }).to_string().into()))
        .await
        .unwrap();
    let mut got_reply = false;
    let mut got_event = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !(got_reply && got_event) && Instant::now() < deadline {
        let Some(v) = next_json(&mut sock, Duration::from_secs(30)).await else { break };
        if v["id"] == 7 {
            assert_eq!(v["result"], json!({ "echo": "models:list", "args": ["p1"] }));
            got_reply = true;
        } else if v["channel"] == "agent:event" {
            got_event = true;
        } else {
            // The daemon must never relay the backend's echo of its own terminals.
            assert_ne!(v["payload"]["data"], "dup", "echoed a daemon terminal back: {v}");
        }
    }
    assert!(got_reply, "no reply");
    assert!(got_event, "backend event was not relayed");
}

fn echo_shell(text: &str) -> Value {
    if cfg!(windows) {
        json!({ "shell": "C:\\Windows\\System32\\cmd.exe" , "title": text })
    } else {
        json!({ "shell": "/bin/sh", "title": text })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_stream_echoes_typed_input() {
    let d = start(false);
    let (status, info) = post(d.port, "terminal:create", json!([echo_shell("t")]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{info}");
    let id = info["id"].as_str().unwrap().to_string();
    assert!(info["running"].as_bool().unwrap());

    let mut sock = ws(d.port, &format!("/api/term/{id}?token={TOKEN}"), Some("null")).await.unwrap();
    let hello = next_json(&mut sock, Duration::from_secs(10)).await.unwrap();
    assert_eq!(hello["type"], "hello");

    let mut typed = vec![0u8];
    typed.extend_from_slice(b"echo nekko-stream-ok\r");
    sock.send(Message::Binary(typed.into())).await.unwrap();

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), sock.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => {
                let mut ack = vec![2u8];
                ack.extend_from_slice(&(b.len() as u32).to_be_bytes());
                sock.send(Message::Binary(ack.into())).await.unwrap();
                seen.extend_from_slice(&b);
                // The command's output, not only the echo of what we typed.
                if String::from_utf8_lossy(&seen).matches("nekko-stream-ok").count() >= 2 {
                    break;
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&seen);
    assert!(text.matches("nekko-stream-ok").count() >= 2, "terminal said {text:?}");

    let (_, _) = post(d.port, "terminal:close", json!([id]), Some(TOKEN)).await;
    let (_, list) = post(d.port, "terminals:list:native", json!([]), Some(TOKEN)).await;
    assert!(list.as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn exits_when_stdin_closes_and_takes_the_backend_with_it() {
    let mut d = start(true);
    // Make sure the backend is up before pulling the plug.
    let (status, _) = post(d.port, "anything:here", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    drop(d.child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = d.child.try_wait().unwrap() {
            assert!(status.success(), "nekkod exited with {status}");
            break;
        }
        assert!(Instant::now() < deadline, "nekkod kept running after its stdin closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_session_reads_from_disk_when_it_knows_the_data_dir() {
    let data = std::env::temp_dir().join(format!("nekkod-sessions-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = json!({ "id": "s_one", "title": "One", "updatedAt": 5, "messages": [
        { "id": "u", "role": "user", "content": "hello", "createdAt": 1 },
        { "id": "a", "role": "assistant", "content": "", "images": ["data:x"], "generated": { "width": 8, "height": 8, "seed": 3 }, "createdAt": 2 },
    ] });
    std::fs::write(sessions.join("s_one.json"), serde_json::to_vec_pretty(&chat).unwrap()).unwrap();
    let d = start_with(true, Some(&data));

    let (status, list) = post(d.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(list[0]["id"], "s_one");
    assert_eq!(list[0]["imageCount"], 1);
    assert!(list[0].get("messages").is_none(), "a summary carries no transcript");
    let (_, got) = post(d.port, "session:get", json!(["s_one"]), Some(TOKEN)).await;
    assert_eq!(got, chat);
    let (_, missing) = post(d.port, "session:get", json!(["../escape"]), Some(TOKEN)).await;
    assert_eq!(missing, Value::Null);
    let (_, images) = post(d.port, "session:images", json!(["s_one", 4]), Some(TOKEN)).await;
    assert_eq!(images, json!([{ "messageId": "a", "src": "data:x" }]));
    // Not a read: still the backend's.
    let (_, created) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    assert_eq!(created["echo"], "session:create");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
