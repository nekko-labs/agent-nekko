//! JavaScript semantics the tools depend on, beyond what `nekko-js` has.
//!
//! The TS host coerces tool arguments with `String(x)`, edits with `split`
//! and `replace` (which read `$&` in the replacement), and reports bad
//! arguments with Node's `ERR_INVALID_ARG_TYPE` wording. A result that must
//! equal the host's byte for byte has to do the same. Lengths, cuts, `trim`
//! and truthiness come from `nekko-js`.

use serde_json::Value;

pub use nekko_js::{len16, slice16, trim, truthy};

/// `Number.prototype.toString()` for a finite double: shortest round-trip
/// digits, positional between 1e-7 and 1e21, exponent (with its sign) outside.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    // `{:e}` prints the shortest digits that round-trip, as `d.ddde<exp>`.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let (head, rest) = digits.split_at(1);
        let frac = if rest.is_empty() { String::new() } else { format!(".{rest}") };
        format!("{head}{frac}e{sign}{}", e.abs())
    }
}

fn number(n: &serde_json::Number) -> f64 {
    // JavaScript holds every number as a double, big integers included.
    n.as_f64().unwrap_or(0.0)
}

/// `String(x)` (ECMAScript `ToString`) for a JSON value; `None` is `undefined`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(number(n)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.toString joins with commas, null and undefined as ''.
        Some(Value::Array(a)) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { to_string(Some(x)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `x ?? fallback` for a JSON field.
pub fn nullish(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// Node's `ERR_INVALID_ARG_TYPE` message for an argument that must be a string.
pub fn invalid_string_arg(name: &str, v: Option<&Value>) -> String {
    let received = match v {
        None => "Received undefined".to_string(),
        Some(Value::Null) => "Received null".to_string(),
        Some(Value::Array(_)) => "Received an instance of Array".to_string(),
        Some(Value::Object(_)) => "Received an instance of Object".to_string(),
        Some(Value::Bool(b)) => format!("Received type boolean ({b})"),
        Some(Value::Number(n)) => format!("Received type number ({})", number_to_string(number(n))),
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
    fn numbers_print_like_javascript() {
        let cases = [
            (0.0, "0"),
            (5.0, "5"),
            (1.5, "1.5"),
            (-2.25, "-2.25"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123456789.125, "123456789.125"),
            (1.2345e-10, "1.2345e-10"),
            (2.5e25, "2.5e+25"),
            (0.1, "0.1"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(x), want, "{x}");
        }
        assert_eq!(to_string(Some(&json!(12345678901234567890u64))), "12345678901234567000");
    }

    #[test]
    fn coerces_like_string() {
        assert_eq!(to_string(None), "undefined");
        assert_eq!(to_string(Some(&json!(null))), "null");
        assert_eq!(to_string(Some(&json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(to_string(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(to_string(Some(&json!(true))), "true");
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
