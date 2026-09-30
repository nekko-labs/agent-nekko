//! JavaScript string, number and JSON semantics, for Rust ports whose output
//! must equal the TS host's.
//!
//! The TS host measures strings in UTF-16 code units (`.length`, `.slice`),
//! trims with ECMAScript's whitespace set, and sizes tool arguments with
//! `JSON.stringify`. A summary that must equal the host's byte for byte has to
//! do the same, so these are ports of exactly those operations rather than
//! Rust's nearest equivalents (`char::is_whitespace` includes U+0085 and not
//! U+FEFF; `serde_json` prints `1e21` where JavaScript prints `1e+21`).

use serde_json::Value;

/// `s.length` in JavaScript: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// ECMAScript `WhiteSpace` plus `LineTerminator`: what `trim()` and `\s` match.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.replace(/\s+/g, ' ')`.
pub fn fold_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `s.length > n ? s.slice(0, n) + '…' : s`.
///
/// One divergence, on purpose: where JavaScript would cut a surrogate pair in
/// half and keep a lone high surrogate, this stops before the pair, since a
/// Rust string cannot hold half a character.
pub fn cap(s: &str, n: usize) -> String {
    if len16(s) <= n {
        return s.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            break;
        }
        used += w;
        out.push(c);
    }
    out.push('…');
    out
}

/// `s.slice(0, n)`, in UTF-16 units (with `cap`'s surrogate-pair caveat).
pub fn slice16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > n {
            return &s[..i];
        }
        used += w;
    }
    s
}

/// `Number(s)` for a string: whitespace-trimmed, empty is 0, `0x`/`0o`/`0b`
/// integers, `Infinity`, decimals with exponents; anything else is NaN.
pub fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| u64::from_str_radix(p, r).map(|v| v as f64).unwrap_or(f64::NAN);
    match t.get(..2) {
        Some("0x" | "0X") => return radix(&t[2..], 16),
        Some("0o" | "0O") => return radix(&t[2..], 8),
        Some("0b" | "0B") => return radix(&t[2..], 2),
        _ => {}
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also reads "inf" and "NaN", which JavaScript does not.
    if t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// JavaScript truthiness of a number.
pub fn truthy_number(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

/// A number as `JSON.stringify` prints it.
fn number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if !f.is_finite() {
        return "null".into();
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{f:.0}");
    }
    // Shortest round-trip digits, as both runtimes use; JavaScript writes a
    // positive exponent with its sign and switches to exponents only at 1e21.
    let s = n.to_string();
    match s.find('e') {
        Some(i) if !s[i + 1..].starts_with('-') && !s[i + 1..].starts_with('+') => {
            format!("{}e+{}", &s[..i], &s[i + 1..])
        }
        _ => s,
    }
}

/// `JSON.stringify(value)` for a value that came out of `JSON.parse`.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        // serde_json escapes the same set JSON.stringify does: quote,
        // backslash, and control characters (short forms where JSON has them).
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write(x, out);
            }
            out.push('}');
        }
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn measures_and_caps_like_javascript() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(cap("abcdef", 3), "abc…");
        assert_eq!(cap("abc", 3), "abc");
        assert_eq!(cap("😀😀", 3), "😀…");
        assert_eq!(trim("\u{FEFF}\u{A0} hi \u{3000}"), "hi");
        // U+0085 is not JavaScript whitespace.
        assert_eq!(trim("\u{85}hi"), "\u{85}hi");
        assert_eq!(fold_space("a \n\t b\u{2028}c"), "a b c");
    }

    #[test]
    fn parses_numbers_like_number() {
        assert_eq!(to_number(" 12 "), 12.0);
        assert_eq!(to_number(""), 0.0);
        assert_eq!(to_number("0x1A"), 26.0);
        assert_eq!(to_number("1e3"), 1000.0);
        assert!(to_number("12abc").is_nan() && to_number("inf").is_nan() && to_number("NaN").is_nan());
        assert_eq!(slice16("a😀b", 2), "a");
        assert_eq!(slice16("abc", 10), "abc");
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"a":[1e21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"b":1,"a":[1e+21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#);
        assert_eq!(stringify(&json!(1e16)), "10000000000000000");
    }
}
