//! Just enough of the ONNX file format to read a model's opset before ONNX Runtime sees it.
//!
//! Why: the only Laya export hosted today (`tozp/laya-onnx`) is a TorchScript trace at opset 14
//! with the sequence length baked into the decision head. It gives wrong answers at every
//! input length but 512 (and wrong ones at 512 too, see docs/decision-models.md), its fp16 file
//! fails ONNX Runtime's CPU provider, and with full graph optimization that failure is an
//! access violation inside ONNX Runtime, which would take the whole daemon down with it. The
//! dynamic-shape exporter Laya ships (`scripts/export_onnx.py`) writes opset 18, so the opset
//! tells the two apart, and it sits in the file's top-level fields: the 800 MB graph before it
//! is skipped with one seek, not read.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// The lowest default-domain opset a usable Laya export has (the dynamo exporter's 18, with
/// room for an exporter that writes 17).
pub const MIN_OPSET: u64 = 17;

fn varint<R: Read>(r: &mut R) -> std::io::Result<Option<u64>> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let mut b = [0u8];
        if r.read(&mut b)? == 0 {
            return Ok(None);
        }
        v |= u64::from(b[0] & 0x7f) << shift;
        if b[0] & 0x80 == 0 {
            return Ok(Some(v));
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "varint too long"))
}

/// Skip one field's payload of wire type `wt`.
fn skip<R: Read + Seek>(r: &mut R, wt: u64) -> std::io::Result<()> {
    match wt {
        0 => {
            varint(r)?;
        }
        1 => {
            r.seek(SeekFrom::Current(8))?;
        }
        2 => {
            let len = varint(r)?.unwrap_or(0);
            r.seek(SeekFrom::Current(len as i64))?;
        }
        5 => {
            r.seek(SeekFrom::Current(4))?;
        }
        _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "unsupported wire type")),
    }
    Ok(())
}

/// `OperatorSetIdProto { domain = 1; version = 2; }` -> the version, when it is the default domain.
fn opset_entry(bytes: &[u8]) -> Option<u64> {
    let mut r = std::io::Cursor::new(bytes);
    let (mut domain_default, mut version) = (true, None);
    while let Ok(Some(tag)) = varint(&mut r) {
        match (tag >> 3, tag & 7) {
            (1, 2) => {
                let len = varint(&mut r).ok()??;
                let mut s = vec![0u8; len as usize];
                r.read_exact(&mut s).ok()?;
                domain_default = s.is_empty() || s == b"ai.onnx";
            }
            (2, 0) => version = varint(&mut r).ok()?,
            (_, wt) => skip(&mut r, wt).ok()?,
        }
    }
    if domain_default { version } else { None }
}

/// The model's default-domain opset (`ModelProto.opset_import`, field 8), if it declares one.
pub fn default_opset(path: &Path) -> Result<Option<u64>, String> {
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut r = BufReader::new(file);
    let bad = |e: std::io::Error| format!("{} is not an ONNX model: {e}", path.display());
    let mut found = None;
    while let Some(tag) = varint(&mut r).map_err(bad)? {
        match (tag >> 3, tag & 7) {
            (8, 2) => {
                let len = varint(&mut r).map_err(bad)?.unwrap_or(0) as usize;
                if len > 1 << 16 {
                    return Err(format!("{} is not an ONNX model: implausible opset entry", path.display()));
                }
                let mut buf = vec![0u8; len];
                r.read_exact(&mut buf).map_err(bad)?;
                if let Some(v) = opset_entry(&buf) {
                    found = Some(v);
                }
            }
            (_, wt) => skip(&mut r, wt).map_err(bad)?,
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(num: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![((num << 3) | 2) as u8];
        let mut len = payload.len() as u64;
        loop {
            let b = (len & 0x7f) as u8;
            len >>= 7;
            out.push(if len > 0 { b | 0x80 } else { b });
            if len == 0 {
                break;
            }
        }
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn reads_the_default_opset_past_the_graph() {
        let mut model = vec![0x08, 0x08]; // ir_version = 8
        model.extend(field(2, b"pytorch"));
        model.extend(field(7, &vec![0xAB; 300])); // a "graph" to skip
        model.extend(field(8, &[0x0A, 0x0A, b'c', b'o', b'm', b'.', b'x', b'.', b'y', b'z', b'q', b'q', 0x10, 0x01]));
        model.extend(field(8, &[0x10, 0x12])); // default domain, version 18
        let path = std::env::temp_dir().join(format!("nekko-decide-opset-{}.onnx", std::process::id()));
        std::fs::write(&path, &model).unwrap();
        assert_eq!(default_opset(&path).unwrap(), Some(18));
        std::fs::remove_file(&path).unwrap();
    }
}
