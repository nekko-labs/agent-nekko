//! JavaScript semantics the providers depend on.
//!
//! The TS providers decide what to send and what to yield with JavaScript's
//! rules: truthiness (`if (delta?.content)`), nullish coalescing
//! (`reasoning_content ?? reasoning`, where an empty string wins), `trim()`'s
//! whitespace set, `Number(...)` coercion, UTF-16 `.slice`, and
//! `JSON.stringify`'s number format for tool arguments. A port that must send
//! the same bytes and yield the same chunks has to use the same rules, so these
//! are ports of exactly those operations rather than Rust's nearest
//! equivalents.

use serde_json::Value;

/// ECMAScript `WhiteSpace` plus `LineTerminator`: what `trim()` removes.
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

/// `s.trimStart()`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// A line terminator, which a regex `.` does not match.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s.slice(0, n)` in UTF-16 code units.
///
/// One divergence, on purpose (the same one `nekko-store` makes): where
/// JavaScript would cut a surrogate pair in half, this stops before the pair,
/// since a Rust string cannot hold half a character.
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

/// Is this value `null` or `undefined` (absent)?
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `a ?? b`.
pub fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(a) { b } else { a }
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

/// A truthy string, the shape nearly every `if (x) yield x` guards.
pub fn truthy_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A number as JavaScript prints it (`String(n)`, and `JSON.stringify` for
/// finite values).
pub fn number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return "0".into();
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{f:.0}");
    }
    // Shortest round-trip digits, as both runtimes use; JavaScript writes a
    // positive exponent with its sign and switches to exponents only at 1e21.
    let s = serde_json::Number::from_f64(f).map(|n| n.to_string()).unwrap_or_default();
    match s.find('e') {
        Some(i) if !s[i + 1..].starts_with('-') && !s[i + 1..].starts_with('+') => {
            format!("{}e+{}", &s[..i], &s[i + 1..])
        }
        _ => s,
    }
}

fn json_number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    number_to_string(n.as_f64().unwrap_or(0.0))
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
        Value::Number(n) => out.push_str(&json_number(n)),
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

/// A value as a template literal prints it (`${v}`).
pub fn display(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => json_number(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { display(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(v)`: `undefined` is NaN, `null` is 0, strings are parsed as
/// JavaScript's StringToNumber does (whitespace-trimmed, empty is 0, hex and
/// `Infinity` accepted, anything else NaN).
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        // An array converts through its string form: `[]` is "", so 0.
        Some(a @ Value::Array(_)) => string_to_number(&display(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)) {
                digits.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)))
            } else {
                f64::NAN
            };
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // A StrDecimalLiteral: digits, one optional dot, an optional exponent.
    // Rust's parser also takes `inf`, `nan` and friends, which JavaScript does
    // not, so the shape is checked before it is handed over.
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - frac_start;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map(|f| sign * f).unwrap_or(f64::NAN)
}

/// `JSON.parse(s)` when `s` is truthy, else `{}`, and `{}` on a parse error:
/// the providers' `safeParse`. Whatever parses is kept, object or not.
pub fn safe_parse(s: &str) -> Value {
    if s.is_empty() {
        return Value::Object(Default::default());
    }
    serde_json::from_str(s).unwrap_or_else(|_| Value::Object(Default::default()))
}

/// A string's bytes decoded as `TextDecoder('utf-8')` would decode them in
/// one piece: a leading BOM dropped, malformed sequences replaced. This is
/// `Response.text()`.
pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringifies_like_json_stringify() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"a":[1e21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"b":1,"a":[1e+21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#);
        assert_eq!(stringify(&json!(1e16)), "10000000000000000");
    }

    #[test]
    fn coerces_like_number() {
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Value::Null)), 0.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert_eq!(to_number(Some(&json!(" 0.000003 "))), 0.000003);
        assert_eq!(to_number(Some(&json!("0x1A"))), 26.0);
        assert_eq!(to_number(Some(&json!("-Infinity"))), f64::NEG_INFINITY);
        assert_eq!(to_number(Some(&json!(".5"))), 0.5);
        assert_eq!(to_number(Some(&json!("5."))), 5.0);
        for bad in ["inf", "nan", "1e", "1.2.3", "abc", "1_000", "."] {
            assert!(to_number(Some(&json!(bad))).is_nan(), "{bad}");
        }
        assert_eq!(to_number(Some(&json!(["7"]))), 7.0);
    }

    #[test]
    fn displays_like_a_template_literal() {
        assert_eq!(display(&json!("x")), "x");
        assert_eq!(display(&json!(3.0)), "3");
        assert_eq!(display(&json!({"a": 1})), "[object Object]");
        assert_eq!(display(&json!([1, null, "b"])), "1,,b");
    }

    #[test]
    fn slices_and_trims_like_javascript() {
        assert_eq!(slice16("abcdef", 3), "abc");
        assert_eq!(slice16("a😀b", 2), "a");
        assert_eq!(slice16("ab", 5), "ab");
        assert_eq!(trim("\u{FEFF}\u{A0} hi \u{3000}"), "hi");
        assert_eq!(trim("\u{85}hi"), "\u{85}hi");
    }

    #[test]
    fn coalesces_only_past_nullish() {
        let empty = json!("");
        let text = json!("t");
        assert_eq!(coalesce(Some(&empty), Some(&text)), Some(&empty));
        assert_eq!(coalesce(Some(&Value::Null), Some(&text)), Some(&text));
        assert_eq!(coalesce(None, None), None);
    }

    #[test]
    fn safe_parse_keeps_what_parses() {
        assert_eq!(safe_parse(""), json!({}));
        assert_eq!(safe_parse("{\"a\":1}"), json!({"a": 1}));
        assert_eq!(safe_parse("[1]"), json!([1]));
        assert_eq!(safe_parse("{bad"), json!({}));
    }
}
