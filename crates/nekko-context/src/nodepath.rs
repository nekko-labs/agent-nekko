//! `path.join` as Node does it on this platform.
//!
//! The context records carry paths the TS host built with `path.join`, which
//! normalizes: on Windows forward slashes become backslashes, repeated
//! separators collapse, and `.` and `..` segments resolve. A path shown in the
//! Context Inspector or used as an item id has to come out the same.

#[cfg(windows)]
const SEP: char = '\\';
#[cfg(not(windows))]
const SEP: char = '/';

fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `path.normalize`, for the drive-letter, rooted and relative forms (UNC
/// paths keep their leading double separator but are otherwise treated alike).
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let mut rest = p;
    let mut prefix = String::new();
    if cfg!(windows) {
        let b = p.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            prefix.push_str(&p[..2]);
            rest = &p[2..];
        } else if p.len() >= 2 && p.chars().take(2).all(is_sep) {
            prefix.push(SEP);
            rest = &p[1..];
        }
    }
    let rooted = rest.starts_with(is_sep);
    let trailing = rest.ends_with(is_sep) && rest.len() > 1;
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let mut out = prefix;
    if rooted {
        out.push(SEP);
    }
    out.push_str(&parts.join(&SEP.to_string()));
    if out.is_empty() {
        return ".".into();
    }
    if trailing && !out.ends_with(SEP) {
        out.push(SEP);
    }
    out
}

/// `path.join(a, b)`.
pub fn join(a: &str, b: &str) -> String {
    let joined = match (a.is_empty(), b.is_empty()) {
        (true, true) => String::new(),
        (true, false) => b.to_string(),
        (false, true) => a.to_string(),
        (false, false) => format!("{a}{SEP}{b}"),
    };
    normalize(&joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn joins_like_node_on_windows() {
        assert_eq!(join("C:\\code\\", "AGENTS.md"), "C:\\code\\AGENTS.md");
        assert_eq!(join("C:/code/sub/../app", "AGENTS.md"), "C:\\code\\app\\AGENTS.md");
        assert_eq!(join("C:\\a\\\\b", "./x"), "C:\\a\\b\\x");
    }

    #[test]
    #[cfg(not(windows))]
    fn joins_like_node_on_posix() {
        assert_eq!(join("/code/", "AGENTS.md"), "/code/AGENTS.md");
        assert_eq!(join("/code/sub/../app", "./AGENTS.md"), "/code/app/AGENTS.md");
        assert_eq!(join("rel//a", "../b"), "rel/b");
    }
}
