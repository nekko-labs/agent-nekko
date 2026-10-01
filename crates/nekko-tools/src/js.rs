//! The JavaScript operations the tools depend on that are theirs alone.
//!
//! The TS host coerces tool arguments with `String(x)`, edits with `split`
//! and `replace` (which read `$&` in the replacement), and reports bad
//! arguments in Node's `ERR_INVALID_ARG_TYPE` wording. A result that must
//! equal the host's byte for byte has to do the same. Everything general
//! (UTF-16 lengths and cuts, `trim`, truthiness, number printing) is
//! `nekko-js`.

use serde_json::Value;

pub use nekko_js::{len16, nullish, slice16, trim, truthy};

/// `String(x)` for a JSON field; `None` is `undefined`.
pub fn to_string(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), nekko_js::display)
}

/// Node's `ERR_INVALID_ARG_TYPE` message for an argument that must be a string.
pub fn invalid_string_arg(name: &str, v: Option<&Value>) -> String {
    let received = match v {
        None => "Received undefined".to_string(),
        Some(Value::Null) => "Received null".to_string(),
        Some(Value::Array(_)) => "Received an instance of Array".to_string(),
        Some(Value::Object(_)) => "Received an instance of Object".to_string(),
        Some(Value::Bool(b)) => format!("Received type boolean ({b})"),
        Some(n @ Value::Number(_)) => format!("Received type number ({})", nekko_js::display(n)),
        // Not reached for a string, which is valid; kept total.
        Some(Value::String(s)) => format!("Received type string ('{s}')"),
    };
    format!("The \"{name}\" argument must be of type string. {received}")
}

/// `haystack.split(sep).length - 1` for a string separator, which is how the
/// host counts matches. An empty separator splits into code units, and an
/// empty string split by an empty string is `[]`, so this can be -1.
pub fn split_count(haystack: &str, sep: &str) -> i64 {
    if sep.is_empty() {
        return len16(haystack) as i64 - 1;
    }
    haystack.matches(sep).count() as i64
}

/// `haystack.replace(search, replacement)` for a string search: the first
/// occurrence only, with the replacement's `$$`, `$&`, `` $` `` and `$'`
/// expanded (a string search has no captures, so `$1` stays as written).
pub fn replace_first(haystack: &str, search: &str, replacement: &str) -> String {
    let Some(at) = haystack.find(search) else { return haystack.to_string() };
    let (before, rest) = haystack.split_at(at);
    let after = &rest[search.len()..];
    let mut out = String::with_capacity(haystack.len() + replacement.len());
    out.push_str(before);
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('$') => out.push('$'),
            Some('&') => out.push_str(search),
            Some('`') => out.push_str(before),
            Some('\'') => out.push_str(after),
            _ => {
                out.push('$');
                continue;
            }
        }
        chars.next();
    }
    out.push_str(after);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_like_string() {
        assert_eq!(to_string(None), "undefined");
        assert_eq!(to_string(Some(&json!(null))), "null");
        assert_eq!(to_string(Some(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(to_string(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(to_string(Some(&json!(0.000001))), "0.000001");
        assert_eq!(
            invalid_string_arg("path", Some(&json!(1.5))),
            "The \"path\" argument must be of type string. Received type number (1.5)"
        );
    }

    #[test]
    fn counts_and_replaces_like_split_and_replace() {
        assert_eq!(split_count("", ""), -1);
        assert_eq!(split_count("a", ""), 0);
        assert_eq!(split_count("ab", ""), 1);
        assert_eq!(split_count("a😀", ""), 2);
        assert_eq!(split_count("aaaa", "aa"), 2);
        assert_eq!(replace_first("abc", "b", "[$$|$&|$`|$'|$1|$<x>|$]"), "a[$|b|a|c|$1|$<x>|$]c");
        assert_eq!(replace_first("", "", "x$&"), "x");
        assert_eq!(replace_first("abab", "b", "X"), "aXab");
    }
}
