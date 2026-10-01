//! Runaway-output detection (packages/core/src/agent/runaway.ts).
//!
//! Local models occasionally degenerate and emit the same phrase until the
//! context fills. The guard watches the stream's tail and trips the moment the
//! output has collapsed into a cycle, so the stream can be cut and the user
//! told. It works in UTF-16 units, as the TS guard's `slice` and `indexOf` do,
//! so both trip on the same delta.

use nekko_js as js;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug)]
pub struct RunawayOptions {
    /// Trailing units examined.
    pub window: usize,
    /// Nothing shorter than this is judged.
    pub min_chars: usize,
    /// Re-test every this many units.
    pub check_every: usize,
    /// Occurrences of the trailing probe in the window that count as a loop.
    pub repeats: usize,
    /// Length of the trailing probe.
    pub probe: usize,
    /// Distinct non-blank lines at or below which the window reads as a loop.
    pub min_distinct_lines: usize,
    /// Non-blank lines needed before the line test applies.
    pub min_lines: usize,
}

impl Default for RunawayOptions {
    fn default() -> Self {
        Self {
            window: 8_000,
            min_chars: 1_500,
            check_every: 1_000,
            repeats: 6,
            probe: 160,
            min_distinct_lines: 3,
            min_lines: 12,
        }
    }
}

/// What the user sees when a reply is cut short for looping.
pub const RUNAWAY_NOTE: &str = "_Stopped: the model got stuck repeating itself and stopped making progress. Nothing was lost: everything before the loop is above. This is usually the model rather than the prompt: try again, lower Effort, or switch to a different model if it keeps happening._";

pub struct RunawayGuard {
    o: RunawayOptions,
    tail: Vec<u16>,
    total: usize,
    checked_at: usize,
    tripped: bool,
}

impl Default for RunawayGuard {
    fn default() -> Self {
        Self::new(RunawayOptions::default())
    }
}

impl RunawayGuard {
    pub fn new(o: RunawayOptions) -> Self {
        Self { o, tail: Vec::new(), total: 0, checked_at: 0, tripped: false }
    }

    pub fn tripped(&self) -> bool {
        self.tripped
    }

    /// Feed the next streamed delta; true the first time (and every time
    /// after) the output looks like a loop.
    pub fn push(&mut self, delta: &str) -> bool {
        if self.tripped {
            return true;
        }
        if delta.is_empty() {
            return false;
        }
        let units: Vec<u16> = delta.encode_utf16().collect();
        self.total += units.len();
        self.tail.extend(units);
        if self.tail.len() > self.o.window {
            let cut = self.tail.len() - self.o.window;
            self.tail.drain(..cut);
        }
        if self.total < self.o.min_chars || self.total - self.checked_at < self.o.check_every {
            return false;
        }
        self.checked_at = self.total;
        self.tripped = looks_like_loop(&self.tail, &self.o);
        self.tripped
    }
}

fn looks_like_loop(tail: &[u16], o: &RunawayOptions) -> bool {
    // Lines: split on '\n', trimmed, non-blank. A cut through a surrogate pair
    // at the window's start decodes lossily here, which only ever affects
    // that first line's text.
    let text = String::from_utf16_lossy(tail);
    let lines: Vec<&str> = text.split('\n').map(js::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() >= o.min_lines && lines.iter().collect::<HashSet<_>>().len() <= o.min_distinct_lines {
        return true;
    }
    if tail.len() < o.probe * 2 {
        return false;
    }
    let probe = &tail[tail.len() - o.probe..];
    let mut count = 0;
    let mut from = 0;
    while from + o.probe <= tail.len() {
        let Some(at) = tail[from..].windows(o.probe).position(|w| w == probe).map(|p| p + from) else { break };
        count += 1;
        if count >= o.repeats {
            return true;
        }
        from = at + 1;
    }
    false
}
