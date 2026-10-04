//! The session writes the UI makes directly, ported from `sessions.ts`:
//! create, delete, and the small patches (options, workspaces, attachments,
//! the spec link, truncating for edit-and-resend, the run queue).
//!
//! Each is a read-modify-write of one file, saved the way `saveSession` saves:
//! `updatedAt` set to now, `JSON.stringify(s, null, 2)` layout, written to a
//! temp name and renamed over the file. The TS agent loop still writes the same
//! files for its own turns (PF14), atomically too, so either side's reader
//! only ever sees a whole chat. Where a TS patch assigns `undefined` the key is
//! removed here, since that is what `JSON.stringify` leaves behind.

use crate::{SessionStore, valid_id};
use nekko_js as js;
use serde_json::{Map, Value, json};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// The fields `setSessionOptions` takes (its `Pick<Session, ...>`).
const OPTION_KEYS: &[&str] = &[
    "title",
    "pinned",
    "tags",
    "order",
    "mode",
    "disabledTools",
    "offline",
    "incognito",
    "gitIsolation",
    "autoModel",
    "autoQuality",
    "autoProviderSwitch",
    "thinking",
    "providerId",
    "modelId",
    "plan",
    "chatType",
    "imageParams",
    "archivedAt",
];

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn base64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// Write whole or not at all, as `writeAtomic` in sessions.ts does.
fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    let tmp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text)?;
    let mut attempt = 0;
    loop {
        match std::fs::rename(&tmp, file) {
            Ok(()) => return Ok(()),
            // Windows refuses a rename over a file another process holds open
            // without delete sharing; that clears in moments.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5 * attempt));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

impl SessionStore {
    fn path(&self, id: &str) -> std::path::PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// `saveSession`.
    fn save(&self, s: &mut Map<String, Value>) -> Result<(), String> {
        s.insert("updatedAt".into(), json!(now_ms()));
        let id = s.get("id").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or("a session without a valid id")?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&Value::Object(s.clone())).map_err(|e| e.to_string())?;
        write_atomic(&self.path(id), &text).map_err(|e| format!("could not save the chat: {e}"))
    }

    /// Read, change, save; `None` when there is no such chat. Writes made here
    /// are serialized, so two UI patches never lose one another.
    fn patch(&self, id: &str, change: impl FnOnce(&mut Map<String, Value>) -> bool) -> Result<Option<Value>, String> {
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        let Some(Value::Object(mut s)) = self.get(id) else { return Ok(None) };
        if change(&mut s) {
            self.save(&mut s)?;
        }
        Ok(Some(Value::Object(s)))
    }

    /// `createSession(workspaceId)`.
    pub fn create(&self, workspace_id: Option<&str>) -> Result<Value, String> {
        let now = now_ms();
        let mut rand = [0u8; 6];
        getrandom::fill(&mut rand).map_err(|e| e.to_string())?;
        let mut s = Map::new();
        s.insert("id".into(), json!(format!("s_{}_{}", base36(now), base64url(&rand))));
        s.insert("title".into(), json!("New chat"));
        // Provisioning lives in the host at first send, after project selection.
        // Absent on existing chats, so their checkouts never change implicitly.
        s.insert("gitIsolation".into(), json!(true));
        if let Some(w) = workspace_id {
            s.insert("workspaceId".into(), json!(w));
        }
        s.insert("messages".into(), json!([]));
        s.insert("createdAt".into(), json!(now));
        s.insert("updatedAt".into(), json!(now));
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        self.save(&mut s)?;
        Ok(Value::Object(s))
    }

    /// `deleteSession`.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Ok(());
        }
        let _guard = self.writes.lock().unwrap_or_else(|e| e.into_inner());
        match std::fs::remove_file(self.path(id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// `setSessionOptions`.
    pub fn set_options(&self, id: &str, patch: &Value) -> Result<Option<Value>, String> {
        let patch = patch.as_object().cloned().unwrap_or_default();
        self.patch(id, |s| {
            for (k, v) in &patch {
                if OPTION_KEYS.contains(&k.as_str()) {
                    s.insert(k.clone(), v.clone());
                }
            }
            // A title the user typed is theirs; the auto-title pass may not overwrite it.
            if patch.contains_key("title") {
                s.insert("titleAuto".into(), json!(false));
            }
            true
        })
    }

    /// `setSessionWorkspace`.
    pub fn set_workspace(&self, id: &str, workspace_id: Option<&str>) -> Result<Option<Value>, String> {
        self.patch(id, |s| {
            match workspace_id {
                Some(w) => s.insert("workspaceId".into(), json!(w)),
                None => s.shift_remove("workspaceId"),
            };
            if let Some(Value::Array(sup)) = s.get("supportingWorkspaceIds").cloned()
                && !sup.is_empty()
            {
                let kept: Vec<Value> = sup.into_iter().filter(|w| w.as_str() != workspace_id).collect();
                if kept.is_empty() {
                    s.shift_remove("supportingWorkspaceIds");
                } else {
                    s.insert("supportingWorkspaceIds".into(), Value::Array(kept));
                }
            }
            true
        })
    }

    /// `setSessionSupportingWorkspaces`: unique, non-empty, never the primary.
    pub fn set_supporting(&self, id: &str, ids: &Value) -> Result<Option<Value>, String> {
        let wanted: Vec<String> =
            ids.as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(str::to_string).collect();
        self.patch(id, |s| {
            let primary = s.get("workspaceId").and_then(Value::as_str).map(str::to_string);
            let mut next: Vec<String> = Vec::new();
            for w in wanted {
                if !w.is_empty() && Some(&w) != primary.as_ref() && !next.contains(&w) {
                    next.push(w);
                }
            }
            if next.is_empty() {
                s.shift_remove("supportingWorkspaceIds");
            } else {
                s.insert("supportingWorkspaceIds".into(), json!(next));
            }
            true
        })
    }

    /// `setSessionAttachments`.
    pub fn set_attachments(&self, id: &str, paths: &Value) -> Result<Option<Value>, String> {
        let paths = paths.clone();
        self.patch(id, |s| {
            s.insert("attachedPaths".into(), paths);
            true
        })
    }

    /// `setSpecLinked`.
    pub fn set_spec_linked(&self, id: &str, linked: &Value) -> Result<Option<Value>, String> {
        let linked = linked.clone();
        self.patch(id, |s| {
            s.insert("specLinked".into(), linked);
            true
        })
    }

    /// `truncateSession`: drop a message and everything after it.
    pub fn truncate(&self, id: &str, message_id: &Value) -> Result<Option<Value>, String> {
        let message_id = message_id.clone();
        self.patch(id, |s| {
            if let Some(Value::Array(messages)) = s.get_mut("messages")
                && let Some(i) = messages.iter().position(|m| m.get("id") == Some(&message_id))
            {
                messages.truncate(i);
            }
            true
        })
    }

    /// `queuePrompt`: a blank prompt changes nothing and is not saved.
    pub fn queue(&self, id: &str, input: &Value) -> Result<Option<Value>, String> {
        let item = match input {
            Value::String(text) => {
                let text = js::trim(text).to_string();
                if text.is_empty() { None } else { Some(json!(text)) }
            }
            Value::Object(obj) => {
                let text = obj.get("text").and_then(Value::as_str).map(js::trim).unwrap_or_default().to_string();
                let images: Vec<Value> = obj
                    .get("images")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter(|v| matches!(v.as_str(), Some(s) if !s.is_empty())).cloned().collect())
                    .unwrap_or_default();
                let skill = obj.get("skill").cloned();
                if text.is_empty() && images.is_empty() && skill.is_none() {
                    None
                } else if images.is_empty() && skill.is_none() {
                    Some(json!(text))
                } else {
                    let mut out = serde_json::Map::new();
                    out.insert("text".into(), json!(text));
                    if !images.is_empty() {
                        out.insert("images".into(), Value::Array(images));
                    }
                    if let Some(skill) = skill {
                        out.insert("skill".into(), skill);
                    }
                    Some(Value::Object(out))
                }
            }
            _ => None,
        };
        self.patch(id, |s| {
            let Some(item) = item.clone() else { return false };
            let mut q = s.get("queue").and_then(Value::as_array).cloned().unwrap_or_default();
            q.push(item);
            s.insert("queue".into(), Value::Array(q));
            true
        })
    }

    /// `dequeuePrompt`: a chat with no queue comes back unchanged and unsaved.
    pub fn dequeue(&self, id: &str, index: &Value) -> Result<Option<Value>, String> {
        let index = index.as_f64();
        self.patch(id, |s| {
            let Some(Value::Array(q)) = s.get("queue").cloned() else { return false };
            let kept: Vec<Value> =
                q.into_iter().enumerate().filter(|(i, _)| Some(*i as f64) != index).map(|(_, v)| v).collect();
            s.insert("queue".into(), Value::Array(kept));
            true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_look_like_the_ts_ones() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(1_790_782_518_274), "muo9oagy");
        assert_eq!(base64url(&[0xfb, 0xff, 0xbf, 0x00, 0x10, 0x83]), "-_-_ABCD");
    }
}
