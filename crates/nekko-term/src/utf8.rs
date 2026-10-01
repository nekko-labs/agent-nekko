//! Chunk-boundary-safe UTF-8 decoding for the JSON event path.
//!
//! The binary stream carries raw bytes, but the legacy `terminal:event` channel
//! carries strings. A multibyte character split across two pty reads would
//! decode as two replacement characters if each chunk were decoded alone, so
//! an incomplete trailing sequence is carried into the next chunk.

#[derive(Default)]
pub struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    // `valid_up_to` guarantees this prefix decodes.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        // Incomplete sequence at the end: keep it for next time.
                        None => {
                            self.pending = after.to_vec();
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
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_a_split_character() {
        let mut c = Utf8Carry::default();
        let snowman = "\u{2603}".as_bytes();
        assert_eq!(c.decode(&snowman[..1]), "");
        assert_eq!(c.decode(&snowman[1..]), "\u{2603}");
    }

    #[test]
    fn replaces_invalid_bytes() {
        let mut c = Utf8Carry::default();
        assert_eq!(c.decode(b"a\xffb"), "a\u{FFFD}b");
    }
}
