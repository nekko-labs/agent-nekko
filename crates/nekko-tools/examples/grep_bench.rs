//! Time `grep_files` on a generated tree: cargo run --release -p nekko-tools --example grep_bench
use std::time::Instant;

#[tokio::main]
async fn main() {
    let ctx = nekko_tools::ToolContext::new(nekko_tools::approver_fn(|_, _, _| async { true }));
    let root = std::env::temp_dir().join("nekko-grep-bench");
    if !root.exists() {
        for d in 0..60 {
            let dir = root.join(format!("pkg{d}"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..50 {
                let body: Vec<String> = (0..80)
                    .map(|i| {
                        let tail = if d == 37 && f == 11 && i == 40 { "zanzibar" } else { "plain line" };
                        format!("export const value{i} = {}; // {tail}", d * f + i)
                    })
                    .collect();
                std::fs::write(dir.join(format!("mod{f}.ts")), body.join("\n")).unwrap();
            }
        }
    }
    let root = root.to_string_lossy().to_string();
    for pattern in ["zanzibar", "value4[0-9]", "ZANZIBAR", "zanz[i]bar"] {
        for _ in 0..3 {
            let t = Instant::now();
            let call = nekko_tools::ToolCall {
                id: "c".into(),
                name: "grep".into(),
                input: serde_json::json!({ "path": root, "pattern": pattern }),
            };
            let out = nekko_tools::execute(&call, &ctx).await;
            println!("{pattern}: {} lines in {:?}", out.output.lines().count(), t.elapsed());
        }
    }
    // Pieces: walking and reading only.
    let t = Instant::now();
    let mut bytes = 0;
    for d in std::fs::read_dir(&root).unwrap() {
        for f in std::fs::read_dir(d.unwrap().path()).unwrap() {
            bytes += std::fs::read(f.unwrap().path()).unwrap().len();
        }
    }
    println!("plain walk+read: {bytes} bytes in {:?}", t.elapsed());
    pieces(&root);
}

#[allow(dead_code)]
fn pieces(root: &str) {
    let files: Vec<std::path::PathBuf> = std::fs::read_dir(root)
        .unwrap()
        .flat_map(|d| std::fs::read_dir(d.unwrap().path()).unwrap().map(|f| f.unwrap().path()))
        .collect();
    let t = Instant::now();
    for f in &files {
        let _ = std::fs::metadata(f).unwrap().len();
    }
    println!("one metadata per file: {:?}", t.elapsed());
    let t = Instant::now();
    for d in std::fs::read_dir(root).unwrap() {
        for e in std::fs::read_dir(d.unwrap().path()).unwrap() {
            let _ = e.unwrap().metadata().unwrap().is_dir();
        }
    }
    println!("entry.metadata per entry: {:?}", t.elapsed());
    let t = Instant::now();
    let mut n = 0;
    for f in &files {
        let b = std::fs::read(f).unwrap();
        let s = String::from_utf8_lossy(&b).into_owned();
        n += s.to_ascii_lowercase().len();
    }
    println!("read+lossy+lowercase: {n} in {:?}", t.elapsed());
}
