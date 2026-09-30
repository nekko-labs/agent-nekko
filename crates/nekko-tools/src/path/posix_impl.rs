//! `path.posix`, over UTF-16 code units as in `lib/path.js`.

use super::{DOT, SLASH, U16, at, normalize_string};

fn is_sep(c: u16) -> bool {
    c == SLASH
}

pub fn resolve(parts: &[U16], cwd: &dyn Fn() -> U16) -> U16 {
    let mut resolved: U16 = Vec::new();
    let mut absolute = false;
    for path in parts.iter().rev() {
        if absolute {
            break;
        }
        if path.is_empty() {
            continue;
        }
        let mut next = path.clone();
        next.push(SLASH);
        next.extend_from_slice(&resolved);
        resolved = next;
        absolute = at(path, 0, SLASH);
    }
    if !absolute {
        let cwd = cwd();
        let mut next = cwd.clone();
        next.push(SLASH);
        next.extend_from_slice(&resolved);
        resolved = next;
        absolute = at(&cwd, 0, SLASH);
    }
    let resolved = normalize_string(&resolved, !absolute, SLASH, is_sep);
    if absolute {
        let mut out = vec![SLASH];
        out.extend_from_slice(&resolved);
        return out;
    }
    if resolved.is_empty() { vec![DOT] } else { resolved }
}

/// `relative` after both sides went through `resolve`.
pub fn relative(from: &[u16], to: &[u16]) -> U16 {
    if from == to {
        return Vec::new();
    }
    let from_start = 1usize;
    let from_end = from.len();
    let from_len = from_end.saturating_sub(from_start);
    let to_start = 1usize;
    let to_len = to.len().saturating_sub(to_start);
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let from_code = from[from_start + i];
        if from_code != to[to_start + i] {
            break;
        } else if from_code == SLASH {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if at(to, to_start + i, SLASH) {
                return to[to_start + i + 1..].to_vec();
            }
            if i == 0 {
                return to[to_start + i..].to_vec();
            }
        } else if from_len > length {
            if at(from, from_start + i, SLASH) {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out: U16 = Vec::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || from[j] == SLASH {
            if !out.is_empty() {
                out.push(SLASH);
            }
            out.extend_from_slice(&[DOT, DOT]);
        }
        j += 1;
    }
    let rest_from = (to_start as isize + last_common_sep).max(0) as usize;
    out.extend_from_slice(to.get(rest_from..).unwrap_or(&[]));
    out
}

pub fn is_absolute(p: &[u16]) -> bool {
    at(p, 0, SLASH)
}

pub fn normalize(p: &[u16]) -> U16 {
    if p.is_empty() {
        return vec![DOT];
    }
    let absolute = at(p, 0, SLASH);
    let trailing = p[p.len() - 1] == SLASH;
    let mut out = normalize_string(p, !absolute, SLASH, is_sep);
    if out.is_empty() {
        if absolute {
            return vec![SLASH];
        }
        return if trailing { vec![DOT, SLASH] } else { vec![DOT] };
    }
    if trailing {
        out.push(SLASH);
    }
    if absolute {
        let mut abs = vec![SLASH];
        abs.extend_from_slice(&out);
        return abs;
    }
    out
}

pub fn join(parts: &[U16]) -> U16 {
    let parts: Vec<&U16> = parts.iter().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return vec![DOT];
    }
    let mut joined: U16 = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            joined.push(SLASH);
        }
        joined.extend_from_slice(p);
    }
    normalize(&joined)
}
