//! Byte ring for terminal scrollback.
//!
//! The TS host kept scrollback as a string and did `(buffer + data).slice(-MAX)`
//! on every chunk, which copies up to the whole buffer per chunk. This ring
//! appends in place and trims from the front, so a chunk costs its own length.

use std::collections::VecDeque;

/// How far past the cut we look for a newline to restart on. A snapshot that
/// begins mid escape sequence or mid UTF-8 character replays as garbage, so a
/// trim moves the start to a line boundary when one is close.
const LINE_SEEK: usize = 4096;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::with_capacity(cap.min(64 * 1024)), cap }
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            self.realign();
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.buf.extend(data);
            self.realign();
        } else {
            self.buf.extend(data);
        }
    }

    /// After a trim, drop the partial line at the front if a newline is near.
    fn realign(&mut self) {
        let limit = self.buf.len().min(LINE_SEEK);
        if let Some(pos) = self.buf.iter().take(limit).position(|&b| b == b'\n') {
            self.buf.drain(..=pos);
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_under_capacity() {
        let mut r = Ring::new(16);
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.snapshot(), b"hello world");
    }

    #[test]
    fn trims_to_a_line_boundary() {
        let mut r = Ring::new(16);
        r.push(b"line one\nline two\n");
        let snap = r.snapshot();
        assert!(snap.len() <= 16);
        assert_eq!(snap, b"line two\n");
    }

    #[test]
    fn keeps_the_tail_of_an_oversized_chunk() {
        let mut r = Ring::new(4);
        r.push(b"abcdefgh");
        assert_eq!(r.snapshot(), b"efgh");
    }

    #[test]
    fn never_exceeds_capacity() {
        let mut r = Ring::new(100);
        for i in 0..1000 {
            r.push(format!("{i} ").as_bytes());
            assert!(r.len() <= 100);
        }
    }
}
