//! The event fan-out: one serialized `{ channel, payload }` frame per event,
//! shared by every connected client.

use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub struct Event {
    /// The frame exactly as clients receive it.
    pub text: Arc<str>,
    /// Output of a daemon-owned terminal. The desktop UI reads that from the
    /// binary terminal stream instead, so its RPC socket skips these.
    pub term_data: bool,
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Event>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16 * 1024);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn publish_raw(&self, text: impl Into<Arc<str>>, term_data: bool) {
        let _ = self.tx.send(Event { text: text.into(), term_data });
    }

    /// Serialized with `channel` as the first key (serde_json keeps insertion
    /// order, and `channel` is written first), which `?only=` filtering relies on.
    pub fn publish(&self, channel: &str, payload: serde_json::Value, term_data: bool) {
        let frame = serde_json::json!({ "channel": channel, "payload": payload }).to_string();
        self.publish_raw(frame, term_data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_start_with_the_channel() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        hub.publish("terminal:event", serde_json::json!({ "zeta": 1, "alpha": 2 }), false);
        let ev = rx.recv().await.unwrap();
        assert!(ev.text.starts_with(r#"{"channel":"terminal:event""#), "{}", ev.text);
    }
}
