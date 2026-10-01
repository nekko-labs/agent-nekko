//! Text exactly as Laya's Python reference renders it.
//!
//! The model reads a JSON state, a structured instruction or a structured criterion as the
//! text `json.dumps(value, ensure_ascii=False)` produces, and it was trained on that text. A
//! different but equivalent rendering (`{"a":1}` instead of `{"a": 1}`, `1e-5` instead of
//! `1e-05`, `é` instead of `é`) tokenizes differently and moves the answer, so this
//! module reproduces Python's formatting rather than serde_json's.

use serde_json::Value;

/// `json.dumps(value, ensure_ascii=False)` with the default `(", ", ": ")` separators.
pub fn dumps(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `str(label)` for a scalar choice label: what the option text shows.
pub fn py_str(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        Value::Number(n) => number(n),
        other => dumps(other),
    }
}

/// The key Python's `json.dumps` writes for a dict key of this scalar: what a label becomes in
/// `probabilities` (`True` -> `"true"`, `2.5` -> `"2.5"`).
pub fn py_json_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Null => "null".into(),
        Value::Number(n) => number(n),
        other => dumps(other),
    }
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_string(out, k);
                out.push_str(": ");
                write_value(out, v);
            }
            out.push('}');
        }
    }
}

/// Python's `py_encode_basestring`: only `"`, `\` and C0 controls are escaped.
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    n.as_f64().map(float_repr).unwrap_or_else(|| n.to_string())
}

/// `repr(float)`: the shortest round-tripping digits (Rust's `{:e}` gives the same digits),
/// laid out the way CPython does: positional for decimal exponents in `[-4, 16)`, otherwise
/// scientific with a signed, at least two-digit exponent (`1e-05`, `1e+16`), and a `.0` on
/// whole positional values.
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let sign = if x.is_sign_negative() { "-" } else { "" };
    // value = 0.d1d2...dn * 10^decpt
    let decpt = exp + 1;
    let body = if !(-4 < decpt && decpt <= 16) {
        let (first, rest) = digits.split_at(1);
        let mant = if rest.is_empty() { first.to_string() } else { format!("{first}.{rest}") };
        let e = decpt - 1;
        format!("{mant}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
    } else if decpt <= 0 {
        format!("0.{}{}", "0".repeat((-decpt) as usize), digits)
    } else if decpt as usize >= digits.len() {
        format!("{}{}.0", digits, "0".repeat(decpt as usize - digits.len()))
    } else {
        let (int, frac) = digits.split_at(decpt as usize);
        format!("{int}.{frac}")
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_match_python_repr() {
        for (x, want) in [
            (0.5, "0.5"),
            (1e-05, "1e-05"),
            (0.0001, "0.0001"),
            (1e16, "1e+16"),
            (1e15, "1000000000000000.0"),
            (129.99, "129.99"),
            (100.0, "100.0"),
            (-2.5, "-2.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1.5e300, "1.5e+300"),
            (-0.0, "-0.0"),
            (123456789.125, "123456789.125"),
        ] {
            assert_eq!(float_repr(x), want, "{x}");
        }
    }

    #[test]
    fn dumps_matches_python_layout_and_escapes() {
        let v = json!({"b": [1, 2.0, null, true], "a": "Zoë \"q\" \\ \n\t\u{7}", "e": {}, "l": []});
        assert_eq!(dumps(&v), r#"{"b": [1, 2.0, null, true], "a": "Zoë \"q\" \\ \n\t\u0007", "e": {}, "l": []}"#);
    }

    #[test]
    fn labels_render_like_python_str_and_json_keys() {
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_json_key(&json!(true)), "true");
        assert_eq!(py_str(&json!(2.5)), "2.5");
        assert_eq!(py_str(&json!(3)), "3");
        assert_eq!(py_str(&json!("x")), "x");
    }
}
