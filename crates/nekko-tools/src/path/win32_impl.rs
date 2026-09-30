//! `path.win32`, over UTF-16 code units as in `lib/path.js`.

use super::{BACKSLASH, COLON, DOT, SLASH, U16, at, normalize_string, string, units};

fn is_sep(c: u16) -> bool {
    c == SLASH || c == BACKSLASH
}

fn is_device_root(c: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&c) || (u16::from(b'a')..=u16::from(b'z')).contains(&c)
}

/// `String.prototype.toLowerCase`: full Unicode mapping, like Rust's.
fn lower(p: &[u16]) -> U16 {
    units(&string(p).to_lowercase())
}

fn concat(parts: &[&[u16]]) -> U16 {
    parts.concat()
}

/// A path's root, as `resolve` and `normalize` both match it: the device
/// (drive or UNC share), where the root ends, and whether it is absolute.
/// `None` for the device means none was matched.
struct Root {
    device: Option<U16>,
    root_end: usize,
    absolute: bool,
    /// `normalize` returns early for a bare UNC root.
    unc_only: Option<U16>,
}

fn match_root(path: &[u16]) -> Root {
    let len = path.len();
    let mut root = Root { device: None, root_end: 0, absolute: false, unc_only: None };
    if len == 0 {
        return root;
    }
    let code = path[0];
    if len == 1 {
        if is_sep(code) {
            root.root_end = 1;
            root.absolute = true;
        }
        return root;
    }
    if is_sep(code) {
        root.absolute = true;
        if is_sep(path[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = &path[last..j];
                last = j;
                while j < len && is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(path[j]) {
                        j += 1;
                    }
                    if j == len || j != last {
                        let bs2: &[u16] = &[BACKSLASH, BACKSLASH];
                        if first_part == [DOT] || first_part == [u16::from(b'?')] {
                            // A device root, e.g. \\.\PHYSICALDRIVE0.
                            root.device = Some(concat(&[bs2, first_part]));
                            root.root_end = 4;
                        } else {
                            if j == len {
                                root.unc_only =
                                    Some(concat(&[bs2, first_part, &[BACKSLASH], &path[last..], &[BACKSLASH]]));
                            }
                            root.device = Some(concat(&[bs2, first_part, &[BACKSLASH], &path[last..j]]));
                            root.root_end = j;
                        }
                    }
                }
            }
        } else {
            root.root_end = 1;
        }
    } else if is_device_root(code) && path[1] == COLON {
        root.device = Some(path[..2].to_vec());
        root.root_end = 2;
        if len > 2 && is_sep(path[2]) {
            root.absolute = true;
            root.root_end = 3;
        }
    }
    root
}

pub fn resolve(parts: &[U16], cwd: &dyn Fn() -> U16, drive_cwd: &dyn Fn(&[u16]) -> Option<U16>) -> U16 {
    let mut resolved_device: U16 = Vec::new();
    let mut resolved_tail: U16 = Vec::new();
    let mut resolved_absolute = false;

    let mut i = parts.len() as isize - 1;
    while i >= -1 {
        let path: U16 = if i >= 0 {
            let p = &parts[i as usize];
            if p.is_empty() {
                i -= 1;
                continue;
            }
            p.clone()
        } else if resolved_device.is_empty() {
            cwd()
        } else {
            // The drive's own working directory (`=C:`), else the process's,
            // else the drive's root.
            let p = drive_cwd(&resolved_device).filter(|p| !p.is_empty()).unwrap_or_else(cwd);
            if lower(&p[..p.len().min(2)]) != lower(&resolved_device) && at(&p, 2, BACKSLASH) {
                concat(&[&resolved_device, &[BACKSLASH]])
            } else {
                p
            }
        };

        let root = match_root(&path);
        if let Some(device) = root.device.as_ref().filter(|d| !d.is_empty()) {
            if !resolved_device.is_empty() {
                if lower(device) != lower(&resolved_device) {
                    // A path on another device does not apply.
                    i -= 1;
                    continue;
                }
            } else {
                resolved_device = device.clone();
            }
        }

        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            resolved_tail = concat(&[&path[root.root_end..], &[BACKSLASH], &resolved_tail]);
            resolved_absolute = root.absolute;
            if root.absolute && !resolved_device.is_empty() {
                break;
            }
        }
        i -= 1;
    }

    let tail = normalize_string(&resolved_tail, !resolved_absolute, BACKSLASH, is_sep);
    if resolved_absolute {
        return concat(&[&resolved_device, &[BACKSLASH], &tail]);
    }
    let out = concat(&[&resolved_device, &tail]);
    if out.is_empty() { vec![DOT] } else { out }
}

/// `relative` after both sides went through `resolve` (`from_orig`, `to_orig`).
pub fn relative(from_orig: &[u16], to_orig: &[u16]) -> U16 {
    if from_orig == to_orig {
        return Vec::new();
    }
    let from = lower(from_orig);
    let to = lower(to_orig);
    if from == to {
        return Vec::new();
    }

    if from_orig.len() != from.len() || to_orig.len() != to.len() {
        // Lowercasing changed a length, so indexes into the lowered strings no
        // longer line up with the originals: compare segment by segment.
        let split = |p: &[u16]| -> Vec<U16> {
            let mut v: Vec<U16> = p.split(|&c| c == BACKSLASH).map(<[u16]>::to_vec).collect();
            if v.last().is_some_and(Vec::is_empty) {
                v.pop();
            }
            v
        };
        let from_split = split(from_orig);
        let to_split = split(to_orig);
        let length = from_split.len().min(to_split.len());
        let mut i = 0;
        while i < length && lower(&from_split[i]) == lower(&to_split[i]) {
            i += 1;
        }
        let join = |segs: &[U16]| segs.join(&BACKSLASH);
        if i == 0 {
            return to_orig.to_vec();
        } else if i == length {
            if to_split.len() > length {
                return join(&to_split[i..]);
            }
            if from_split.len() > length {
                let mut out = units(&"..\\".repeat(from_split.len() - 1 - i));
                out.extend_from_slice(&[DOT, DOT]);
                return out;
            }
            return Vec::new();
        }
        let mut out = units(&"..\\".repeat(from_split.len() - i));
        out.extend_from_slice(&join(&to_split[i..]));
        return out;
    }

    let mut from_start = 0;
    while from_start < from.len() && from[from_start] == BACKSLASH {
        from_start += 1;
    }
    let mut from_end = from.len();
    while from_end > 0 && from_end - 1 > from_start && from[from_end - 1] == BACKSLASH {
        from_end -= 1;
    }
    let from_len = from_end - from_start;

    let mut to_start = 0;
    while to_start < to.len() && to[to_start] == BACKSLASH {
        to_start += 1;
    }
    let mut to_end = to.len();
    while to_end > 0 && to_end - 1 > to_start && to[to_end - 1] == BACKSLASH {
        to_end -= 1;
    }
    let to_len = to_end - to_start;

    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0;
    while i < length {
        let from_code = from[from_start + i];
        if from_code != to[to_start + i] {
            break;
        } else if from_code == BACKSLASH {
            last_common_sep = i as isize;
        }
        i += 1;
    }

    if i != length {
        if last_common_sep == -1 {
            return to_orig.to_vec();
        }
    } else {
        if to_len > length {
            if at(&to, to_start + i, BACKSLASH) {
                return to_orig[to_start + i + 1..].to_vec();
            }
            if i == 2 {
                return to_orig[to_start + i..].to_vec();
            }
        }
        if from_len > length {
            if at(&from, from_start + i, BACKSLASH) {
                last_common_sep = i as isize;
            } else if i == 2 {
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }

    let mut out: U16 = Vec::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || from[j] == BACKSLASH {
            if !out.is_empty() {
                out.push(BACKSLASH);
            }
            out.extend_from_slice(&[DOT, DOT]);
        }
        j += 1;
    }

    let mut to_start = (to_start as isize + last_common_sep) as usize;
    if !out.is_empty() {
        out.extend_from_slice(to_orig.get(to_start..to_end).unwrap_or(&[]));
        return out;
    }
    if at(to_orig, to_start, BACKSLASH) {
        to_start += 1;
    }
    to_orig.get(to_start..to_end).unwrap_or(&[]).to_vec()
}

pub fn is_absolute(p: &[u16]) -> bool {
    let len = p.len();
    if len == 0 {
        return false;
    }
    is_sep(p[0]) || (len > 2 && is_device_root(p[0]) && p[1] == COLON && is_sep(p[2]))
}

pub fn normalize(path: &[u16]) -> U16 {
    let len = path.len();
    if len == 0 {
        return vec![DOT];
    }
    if len == 1 {
        return if path[0] == SLASH { vec![BACKSLASH] } else { path.to_vec() };
    }
    let root = match_root(path);
    if let Some(unc) = root.unc_only {
        return unc;
    }
    let absolute = root.absolute;
    let mut tail = if root.root_end < len {
        normalize_string(&path[root.root_end..], !absolute, BACKSLASH, is_sep)
    } else {
        Vec::new()
    };
    if tail.is_empty() && !absolute {
        tail = vec![DOT];
    }
    if !tail.is_empty() && is_sep(path[len - 1]) {
        tail.push(BACKSLASH);
    }
    if !absolute && root.device.is_none() && path.contains(&COLON) {
        // CVE-2024-36139: a relative result must not read as a drive path.
        let dot_prefixed = || concat(&[&[DOT, BACKSLASH], &tail]);
        if tail.len() >= 2 && is_device_root(tail[0]) && tail[1] == COLON {
            return dot_prefixed();
        }
        for (index, &c) in path.iter().enumerate() {
            if c == COLON && (index == len - 1 || is_sep(path[index + 1])) {
                return dot_prefixed();
            }
        }
    }
    match root.device {
        None => {
            if absolute {
                concat(&[&[BACKSLASH], &tail])
            } else {
                tail
            }
        }
        Some(device) => {
            if absolute {
                concat(&[&device, &[BACKSLASH], &tail])
            } else {
                concat(&[&device, &tail])
            }
        }
    }
}

pub fn join(parts: &[U16]) -> U16 {
    let mut joined: Option<U16> = None;
    let mut first_part: U16 = Vec::new();
    for p in parts.iter().filter(|p| !p.is_empty()) {
        match joined.as_mut() {
            None => {
                joined = Some(p.clone());
                first_part = p.clone();
            }
            Some(j) => {
                j.push(BACKSLASH);
                j.extend_from_slice(p);
            }
        }
    }
    let Some(mut joined) = joined else { return vec![DOT] };

    // Keep a leading `\\` only when the first part clearly meant a UNC path.
    let mut needs_replace = true;
    let mut slash_count = 0;
    if first_part.first().is_some_and(|&c| is_sep(c)) {
        slash_count += 1;
        let first_len = first_part.len();
        if first_len > 1 && is_sep(first_part[1]) {
            slash_count += 1;
            if first_len > 2 {
                if is_sep(first_part[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        while slash_count < joined.len() && is_sep(joined[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined = concat(&[&[BACKSLASH], &joined[slash_count..]]);
        }
    }
    normalize(&joined)
}
