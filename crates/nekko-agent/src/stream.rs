//! How a chat streams: a spawned task feeding a bounded channel.
//!
//! The TS providers are async generators, which stop the moment their
//! consumer stops pulling. The same holds here: dropping the [`ChunkStream`]
//! closes the channel, and the task notices at its next await (reading the
//! body included), stops, and drops the HTTP response, which closes the
//! connection. The request's [`AbortSignal`] ends it the same way, with the
//! error the TS side would have thrown.

use crate::http::{AbortSignal, HttpRequest, HttpResponse, Transport, TransportError};
use crate::types::{ProviderChunk, ProviderError};
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio::sync::mpsc;

pub type ChunkResult = Result<ProviderChunk, ProviderError>;

/// A chat in flight. Yields chunks until `Done` or an error, then `None`.
pub struct ChunkStream {
    rx: mpsc::Receiver<ChunkResult>,
}

impl ChunkStream {
    pub async fn next(&mut self) -> Option<ChunkResult> {
        self.rx.recv().await
    }

    /// Everything the chat yields, and the error it ended on, if any.
    pub async fn collect(mut self) -> (Vec<ProviderChunk>, Option<ProviderError>) {
        let mut chunks = Vec::new();
        while let Some(item) = self.next().await {
            match item {
                Ok(c) => chunks.push(c),
                Err(e) => return (chunks, Some(e)),
            }
        }
        (chunks, None)
    }
}

/// Why a chat task stopped early.
pub(crate) enum Stop {
    /// The chat failed; the consumer gets this as its last item.
    Failed(ProviderError),
    /// Nobody is listening any more.
    Gone,
}

impl From<ProviderError> for Stop {
    fn from(e: ProviderError) -> Self {
        Self::Failed(e)
    }
}

/// The task's end of the channel.
pub(crate) struct Sink {
    tx: mpsc::Sender<ChunkResult>,
    abort: AbortSignal,
}

impl Sink {
    pub(crate) async fn emit(&self, chunk: ProviderChunk) -> Result<(), Stop> {
        self.tx.send(Ok(chunk)).await.map_err(|_| Stop::Gone)
    }

    /// Send a request, unless the consumer leaves first. An abort becomes the
    /// transport error a cancelled fetch rejects with, so each provider maps
    /// it exactly as it maps any other fetch failure.
    pub(crate) async fn send(
        &self,
        transport: &dyn Transport,
        req: &HttpRequest,
    ) -> Result<Result<HttpResponse, TransportError>, Stop> {
        if self.abort.aborted() {
            return Ok(Err(TransportError::aborted()));
        }
        tokio::select! {
            biased;
            _ = self.abort.fired() => Ok(Err(TransportError::aborted())),
            _ = self.tx.closed() => Err(Stop::Gone),
            res = transport.send(req) => Ok(res),
        }
    }

    /// The next piece of a streaming body. Failures here reach the consumer
    /// raw, as a rejected `reader.read()` does in TS.
    pub(crate) async fn read(&self, res: &mut HttpResponse) -> Result<Option<Vec<u8>>, Stop> {
        let failed = |e: TransportError| Stop::Failed(ProviderError::new(e.message));
        if self.abort.aborted() {
            return Err(failed(TransportError::aborted()));
        }
        tokio::select! {
            biased;
            _ = self.abort.fired() => Err(failed(TransportError::aborted())),
            _ = self.tx.closed() => Err(Stop::Gone),
            chunk = res.body.chunk() => chunk.map_err(failed),
        }
    }

    /// `res.text().catch(() => '')`, abandoned if the consumer leaves.
    pub(crate) async fn text(&self, res: &mut HttpResponse) -> Result<String, Stop> {
        tokio::select! {
            biased;
            _ = self.abort.fired() => Ok(String::new()),
            _ = self.tx.closed() => Err(Stop::Gone),
            text = res.text() => Ok(text),
        }
    }
}

/// Run a chat body on the runtime, streaming what it emits.
pub(crate) fn spawn<F, Fut>(signal: Option<AbortSignal>, body: F) -> ChunkStream
where
    F: FnOnce(Sink) -> Fut,
    Fut: Future<Output = Result<(), Stop>> + Send + 'static,
{
    let (tx, rx) = mpsc::channel(64);
    let sink = Sink { tx: tx.clone(), abort: signal.unwrap_or_default() };
    let fut = body(sink);
    tokio::spawn(async move {
        if let Err(Stop::Failed(e)) = fut.await {
            let _ = tx.send(Err(e)).await;
        }
    });
    ChunkStream { rx }
}

/// Milliseconds on a monotonic clock. Injectable so the golden tests can
/// freeze time the way the TS recorder freezes `Date.now`.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    static START: LazyLock<Instant> = LazyLock::new(Instant::now);
    Arc::new(|| START.elapsed().as_millis() as u64)
}

/// Times the decode phase of one streamed response, for the tokens/second
/// figure (a port of `decode-clock.ts`).
///
/// Throughput is tokens over the time spent *generating* them, not the wall
/// clock of the request, which also covers queueing and prompt processing
/// (most of the wait on a local model with a long context). So the clock
/// starts at the first generated chunk and stops when usage arrives.
pub(crate) struct DecodeClock {
    clock: Clock,
    started: Option<u64>,
    stopped: Option<u64>,
}

impl DecodeClock {
    pub(crate) fn new(clock: Clock) -> Self {
        Self { clock, started: None, stopped: None }
    }

    /// Call on every generated chunk (text, reasoning, or tool-call arguments).
    pub(crate) fn mark(&mut self) {
        if self.started.is_none() {
            self.started = Some((self.clock)());
        }
    }

    /// Freeze the clock, so a usage chunk that trails the stream doesn't inflate it.
    pub(crate) fn stop(&mut self) {
        if self.started.is_some() && self.stopped.is_none() {
            self.stopped = Some((self.clock)());
        }
    }

    /// Decode milliseconds so far, or `None` when nothing was generated. A
    /// response faster than a millisecond still counts as 1, so the rate stays
    /// bounded.
    pub(crate) fn elapsed(&self) -> Option<u64> {
        let started = self.started?;
        let end = self.stopped.unwrap_or_else(|| (self.clock)());
        Some(end.saturating_sub(started).max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn decode_clock_times_first_mark_to_stop() {
        let now = Arc::new(AtomicU64::new(100));
        let n = now.clone();
        let mut c = DecodeClock::new(Arc::new(move || n.load(Ordering::SeqCst)));
        assert_eq!(c.elapsed(), None);
        c.stop();
        assert_eq!(c.elapsed(), None, "stopping before a mark measures nothing");
        c.mark();
        now.store(130, Ordering::SeqCst);
        c.mark();
        now.store(160, Ordering::SeqCst);
        c.stop();
        now.store(999, Ordering::SeqCst);
        assert_eq!(c.elapsed(), Some(60));
    }

    #[test]
    fn decode_clock_floors_at_one_millisecond() {
        let mut c = DecodeClock::new(Arc::new(|| 5));
        c.mark();
        c.stop();
        assert_eq!(c.elapsed(), Some(1));
    }
}
