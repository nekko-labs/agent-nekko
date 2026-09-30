//! Shell detection, the same list and order the TS host offered.

use serde::Serialize;
use std::path::Path;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

fn add(out: &mut Vec<ShellOption>, id: &str, label: &str, paths: &[String], args: Option<&[&str]>) {
    if out.iter().any(|o| o.id == id) {
        return;
    }
    if let Some(hit) = paths.iter().find(|p| !p.is_empty() && Path::new(p).exists()) {
        out.push(ShellOption {
            id: id.into(),
            label: label.into(),
            path: hit.clone(),
            args: args.map(|a| a.iter().map(|s| s.to_string()).collect()),
        });
    }
}

/// Shells installed on this machine, best first.
pub fn detect_shells() -> Vec<ShellOption> {
    let mut out = Vec::new();
    if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        add(&mut out, "pwsh", "PowerShell 7", &[format!(r"{pf}\PowerShell\7\pwsh.exe")], None);
        add(
            &mut out,
            "powershell",
            "Windows PowerShell",
            &[format!(r"{sys}\System32\WindowsPowerShell\v1.0\powershell.exe")],
            None,
        );
        add(&mut out, "cmd", "Command Prompt", &[format!(r"{sys}\System32\cmd.exe")], None);
        add(&mut out, "gitbash", "Git Bash", &[format!(r"{pf}\Git\bin\bash.exe")], Some(&["--login", "-i"]));
    } else {
        if let Ok(env) = std::env::var("SHELL") {
            add(&mut out, "login", "Login shell", &[env], Some(&["-l"]));
        }
        add(&mut out, "zsh", "zsh", &["/bin/zsh".into(), "/usr/bin/zsh".into()], None);
        add(&mut out, "bash", "bash", &["/bin/bash".into(), "/usr/bin/bash".into()], None);
        add(
            &mut out,
            "fish",
            "fish",
            &["/opt/homebrew/bin/fish".into(), "/usr/local/bin/fish".into(), "/usr/bin/fish".into()],
            None,
        );
    }
    out
}

/// The shell a new terminal launches: the explicit choice, else the saved
/// default, else the best detected, else the platform's last resort.
pub fn resolve_shell(explicit: Option<&str>, saved_default: Option<&str>) -> ShellOption {
    let shells = detect_shells();
    let wanted = explicit.or(saved_default).filter(|w| !w.is_empty());
    if let Some(w) = wanted {
        if let Some(found) = shells.iter().find(|s| s.path == w) {
            return found.clone();
        }
        if Path::new(w).exists() {
            return ShellOption { id: "custom".into(), label: "Shell".into(), path: w.into(), args: None };
        }
    }
    if let Some(first) = shells.into_iter().next() {
        return first;
    }
    if cfg!(windows) {
        ShellOption { id: "cmd".into(), label: "Command Prompt".into(), path: "cmd.exe".into(), args: None }
    } else {
        ShellOption { id: "sh".into(), label: "sh".into(), path: "/bin/sh".into(), args: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_resolves_something_runnable() {
        let s = resolve_shell(None, None);
        assert!(!s.path.is_empty());
    }

    #[test]
    fn an_unknown_explicit_path_falls_back() {
        let s = resolve_shell(Some("/definitely/not/a/shell"), None);
        assert_ne!(s.path, "/definitely/not/a/shell");
    }
}
