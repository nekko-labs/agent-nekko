//! Framing for streamed bodies: Server-Sent Events (OpenAI-compatible,
//! Anthropic, ChatGPT) and newline-delimited JSON (Ollama).
//!
//! Ports of `sse.ts` and Ollama's line loop, quirks included, because the
//! chunks a provider yields depend on them:
//!
//! - Events split on a blank line written as `\n\n` only. A stream framed
//!   with `\r\n\r\n` never contains that, so the TS parser buffers it all and
//!   yields nothing; so does this one (a golden fixture pins it).
//! - Every `data:` line is its own payload; lines of one event are not joined.
//! - `[DONE]` ends the stream at once, even mid-event.
//! - Whatever is left in the buffer when the body ends (an event with no
//!   trailing blank line, a last NDJSON line with no newline) is dropped.
//! - Bytes decode like `TextDecoder` with `stream: true`: a character split
//!   across network chunks is joined, malformed bytes become U+FFFD, and an
//!   incomplete character at the very end is dropped (the TS side never
//!   flushes its decoder).

use crate::js;

/// Incremental UTF-8 decoding, as `TextDecoder.decode(bytes, { stream: true })`.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // The first `valid_up_to` bytes are valid UTF-8 by definition.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        // An incomplete sequence at the end: wait for more bytes.
                        None => {
                            rest = after;
                            break;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }
}

/// What one piece of an SSE body produced.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct SseBatch {
    /// `data:` payloads, in order.
    pub data: Vec<String>,
    /// `[DONE]` arrived: stop reading.
    pub done: bool,
}

#[derive(Default)]
pub(crate) struct SseParser {
    utf8: Utf8Stream,
    buffer: String,
}

impl SseParser {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> SseBatch {
        self.buffer.push_str(&self.utf8.decode(bytes));
        let mut batch = SseBatch::default();
        while let Some(idx) = self.buffer.find("\n\n") {
            let raw: String = self.buffer[..idx].to_string();
            self.buffer.drain(..idx + 2);
            for line in raw.split('\n') {
                let Some(rest) = js::trim_start(line).strip_prefix("data:") else { continue };
                let data = js::trim(rest);
                if data == "[DONE]" {
                    batch.done = true;
                    return batch;
                }
                if !data.is_empty() {
                    batch.data.push(data.to_string());
                }
            }
        }
        batch
    }
}

/// Ollama's framing: one JSON value per line, blank lines skipped.
#[derive(Default)]
pub(crate) struct LineParser {
    utf8: Utf8Stream,
    buffer: String,
}

impl LineParser {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.push_str(&self.utf8.decode(bytes));
        let mut out = Vec::new();
        while let Some(nl) = self.buffer.find('\n') {
            let line = js::trim(&self.buffer[..nl]).to_string();
            self.buffer.drain(..=nl);
            if !line.is_empty() {
                out.push(line);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_a_character_split_across_chunks() {
        let bytes = "é😀".as_bytes();
        let mut d = Utf8Stream::default();
        let mut s = String::new();
        for b in bytes {
            s.push_str(&d.decode(std::slice::from_ref(b)));
        }
        assert_eq!(s, "é😀");
    }

    #[test]
    fn replaces_malformed_bytes() {
        let mut d = Utf8Stream::default();
        assert_eq!(d.decode(b"a\xFFb\xE2\x82"), "a\u{FFFD}b");
        assert_eq!(d.decode(b"x"), "\u{FFFD}x");
    }

    #[test]
    fn frames_sse_like_parse_sse() {
        let mut p = SseParser::default();
        let b = p.feed(b"event: x\ndata: one\n  data:two \ndata:\n\nda");
        assert_eq!(b, SseBatch { data: vec!["one".into(), "two".into()], done: false });
        let b = p.feed(b"ta: three\n\ndata: [DONE]\ndata: lost\n\n");
        assert_eq!(b, SseBatch { data: vec!["three".into()], done: true });
    }

    #[test]
    fn crlf_framing_never_splits() {
        let mut p = SseParser::default();
        assert_eq!(p.feed(b"data: a\r\n\r\ndata: b\r\n\r\n"), SseBatch::default());
    }

    #[test]
    fn frames_lines_like_ollama() {
        let mut p = LineParser::default();
        assert_eq!(p.feed(b"{\"a\":1}\n\n  {\"b\":2}  \n{\"c\""), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(p.feed(b":3}\n"), vec!["{\"c\":3}"]);
    }
}
