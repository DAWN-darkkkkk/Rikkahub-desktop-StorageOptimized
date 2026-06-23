use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// === types ===

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ConversationIndex {
    id: String,
    #[serde(rename = "assistantId")]
    assistant_id: String,
    title: String,
    #[serde(rename = "isPinned")]
    is_pinned: bool,
    #[serde(rename = "createAt")]
    create_at: i64,
    #[serde(rename = "updateAt")]
    update_at: i64,
    #[serde(rename = "messageCount")]
    message_count: usize,
    #[serde(rename = "filePath")]
    file_path: String,
}

// === helpers ===

fn fmt_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn ts_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let secs = d % 60;
    let mins = (d / 60) % 60;
    let hours = (d / 3600) % 24;
    // approximate date from epoch (good enough for a filename timestamp)
    let days = d / 86400;
    let (y, m, day) = days_since_epoch(days as i64);
    format!(
        "{}{:02}{:02}-{:02}{:02}{:02}",
        y, m, day, hours, mins, secs
    )
}

fn days_since_epoch(days: i64) -> (i64, i64, i64) {
    let mut y = 1970i64;
    let mut remaining = days;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let months_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0;
    while m < 12 && remaining >= months_days[m] as i64 {
        remaining -= months_days[m] as i64;
        m += 1;
    }
    (y, m as i64 + 1, remaining + 1)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn conversation_file_path(create_at: i64, id: &str) -> String {
    let day_secs = create_at / 1000;
    let days = day_secs / 86400;
    let (y, m, d) = days_since_epoch(days);
    format!("{}/{}-{:02}-{:02}/{}.json", y, y, m, d, id)
}

fn count_messages(conv: &Value) -> usize {
    conv.get("messages")
        .and_then(|msgs| msgs.as_array())
        .map(|arr| {
            arr.iter()
                .map(|node| {
                    node.get("messages")
                        .and_then(|m| m.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

// === ZIP backup ===

fn zip_backup(data_dir: &Path) -> Option<PathBuf> {
    let parent = data_dir.parent().unwrap();
    let zip_name = format!("pc-data-backup-{}.zip", ts_now());
    let zip_path = parent.join(&zip_name);

    println!("\n[1/4] 创建备份: {}", zip_name);

    let file = match fs::File::create(&zip_path) {
        Ok(f) => f,
        Err(e) => {
            println!("       备份失败: {}, 继续处理...", e);
            return None;
        }
    };

    let mut zw = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    match add_dir_to_zip(&mut zw, &options, data_dir, data_dir) {
        Ok(_) => {
            zw.finish().ok();
            let size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
            println!("       备份完成: {}", fmt_bytes(size));
            Some(zip_path)
        }
        Err(e) => {
            println!("       备份失败: {}, 继续处理...", e);
            None
        }
    }
}

fn add_dir_to_zip<T: Write + io::Seek>(
    zw: &mut zip::ZipWriter<T>,
    options: &zip::write::SimpleFileOptions,
    base: &Path,
    dir: &Path,
) -> zip::result::ZipResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zw.add_directory(name, *options)?;
            add_dir_to_zip(zw, options, base, &path)?;
        } else {
            zw.start_file(name, *options)?;
            let data = fs::read(&path)?;
            zw.write_all(&data)?;
        }
    }
    Ok(())
}

// === FTS ===

fn rebuild_fts(data_dir: &Path, conversations: &[Value]) {
    println!("\n[4/4] 重建 FTS 全文索引");
    let db_path = data_dir.join("conversations.db");
    let _ = fs::remove_file(&db_path);
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            println!("       FTS 索引创建失败: {}", e);
            return;
        }
    };
    conn.execute_batch("PRAGMA journal_mode=WAL").ok();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(\
         conversation_id, title, content, tokenize='unicode61')",
    ).ok();

    for conv in conversations {
        let id = conv["id"].as_str().unwrap_or("");
        let title = conv["title"].as_str().unwrap_or("");
        let text = extract_text(conv);
        conn.execute(
            "INSERT INTO conversation_fts VALUES (?1, ?2, ?3)",
            rusqlite::params![id, title, text],
        ).ok();
    }
    println!("       FTS 索引已重建");
}

fn extract_text(conv: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(nodes) = conv["messages"].as_array() {
        for node in nodes {
            if let Some(msgs) = node["messages"].as_array() {
                let si = node["selectIndex"].as_u64().unwrap_or(0) as usize;
                if let Some(msg) = msgs.get(si) {
                    if let Some(msg_parts) = msg["parts"].as_array() {
                        for part in msg_parts {
                            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                                parts.push(t.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    parts.join("\n")
}

// === main ===

fn main() {
    println!("╔══════════════════════════════════════════╗");
    println!("║   Rikkahub pc-data 转换器 v2 (Rust)     ║");
    println!("╚══════════════════════════════════════════╝");

    let exe_dir: PathBuf = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let data_dir = exe_dir.join("pc-data");
    let state_path = data_dir.join("state.json");

    println!("\n工作目录: {}", data_dir.display());

    if !state_path.exists() {
        println!("\n未找到 pc-data/state.json，无需处理。");
        println!("请将本程序放在 rikkahub.exe 同级目录下运行。");
        println!("\n按回车键退出...");
        wait_enter();
        return;
    }

    // 1. ZIP backup
    zip_backup(&data_dir);

    // 2. Read state.json
    println!("\n[2/4] 读取 state.json");
    let raw_content = fs::read_to_string(&state_path).expect("Failed to read state.json");
    let state_before = raw_content.len() as u64;
    let mut raw: Value = serde_json::from_str(&raw_content).expect("Invalid JSON");
    let schema_version = raw["schemaVersion"].as_u64().unwrap_or(0);
    let logs_count = raw["logs"].as_array().map(|a| a.len()).unwrap_or(0);
    println!("       schemaVersion: v{}, 日志: {} 条", schema_version, logs_count);

    let mut conversations_split = 0u32;
    let mut messages_total = 0u32;
    let convs_dir = data_dir.join("conversations");

    // 3. Split conversations (v1 only)
    if schema_version < 2 {
        if let Some(conversations) = raw["conversations"].as_array().cloned() {
            if !conversations.is_empty() {
                println!("\n[3/4] 拆分对话 (v1 → v2)");
                messages_total = conversations.iter().map(|c| count_messages(c) as u32).sum();
                println!("       会话: {} 个, 消息: {} 条", conversations.len(), messages_total);

                fs::create_dir_all(&convs_dir).ok();
                let mut indices: Vec<ConversationIndex> = Vec::new();

                for conv in &conversations {
                    let cid = conv["id"].as_str().unwrap_or("");
                    let create_at = conv["createAt"].as_i64().unwrap_or(0);
                    let rel = conversation_file_path(create_at, cid);
                    let abs = convs_dir.join(&rel);
                    if let Some(parent) = abs.parent() {
                        fs::create_dir_all(parent).ok();
                    }
                    if let Ok(json) = serde_json::to_string_pretty(conv) {
                        fs::write(&abs, json).ok();
                    }
                    indices.push(ConversationIndex {
                        id: cid.to_string(),
                        assistant_id: conv["assistantId"].as_str().unwrap_or("").to_string(),
                        title: conv["title"].as_str().unwrap_or("").to_string(),
                        is_pinned: conv["isPinned"].as_bool().unwrap_or(false),
                        create_at,
                        update_at: conv["updateAt"].as_i64().unwrap_or(create_at),
                        message_count: count_messages(conv),
                        file_path: rel,
                    });
                    conversations_split += 1;
                }

                let indices_val = serde_json::to_value(&indices).unwrap_or_default();
                raw["conversationIndices"] = indices_val;
                raw.as_object_mut().unwrap().remove("conversations");
                println!("       成功: {} 个", conversations_split);
            }
        }
        raw["schemaVersion"] = serde_json::json!(2);
    } else {
        println!("\n[3/4] 对话格式已是 v2，跳过拆分");
        // load from files for FTS
        let loaded = load_convs_from_files(&convs_dir);
        messages_total = loaded.iter().map(|c| count_messages(c) as u32).sum();
        raw["conversations"] = serde_json::to_value(&loaded).unwrap_or_default();
    }

    // 4. Delete logs
    raw["logs"] = serde_json::json!([]);

    // Write state.json
    let new_content = serde_json::to_string_pretty(&raw).unwrap_or_default();
    fs::write(&state_path, &new_content).ok();
    let state_after = new_content.len() as u64;

    // FTS
    let fts_conv: Vec<Value> = raw["conversations"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| serde_json::from_str("[]").unwrap());
    rebuild_fts(&data_dir, &fts_conv);

    // Summary
    println!("\n╔══════════════════════════════════════════╗");
    println!("║              处理完成                   ║");
    println!("╚══════════════════════════════════════════╝");

    if conversations_split > 0 {
        println!("\n 📁 对话拆分 (v1 → v2):");
        println!("     {} 个会话 → conversations/", conversations_split);
        println!("     {} 条消息已提取", messages_total);
    } else {
        println!("\n 📁 对话格式: 已是 v2，无需拆分");
    }

    if logs_count > 0 {
        println!("\n 🗑 日志已清除: {} 条", logs_count);
    } else {
        println!("\n 🗑 日志: 无");
    }

    println!("\n 🔍 FTS 全文索引: 已重建");
    println!("\n 💾 state.json: {} → {}", fmt_bytes(state_before), fmt_bytes(state_after));

    // find backup file
    let parent = data_dir.parent().unwrap();
    if let Ok(entries) = fs::read_dir(parent) {
        let mut backups: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("pc-data-backup-") && n.ends_with(".zip"))
            .collect();
        backups.sort();
        if let Some(last) = backups.last() {
            println!("\n 📦 备份文件: {}", last);
        }
    }

    println!("\n按回车键退出...");
    wait_enter();
}

fn wait_enter() {
    let stdin = io::stdin();
    let mut line = String::new();
    let _ = stdin.lock().read_line(&mut line);
}

fn load_convs_from_files(dir: &Path) -> Vec<Value> {
    let mut results = Vec::new();
    if !dir.exists() {
        return results;
    }
    if let Ok(years) = fs::read_dir(dir) {
        for year_entry in years.flatten() {
            let year_dir = year_entry.path();
            if !year_dir.is_dir() { continue; }
            if let Ok(dates) = fs::read_dir(&year_dir) {
                for date_entry in dates.flatten() {
                    let date_dir = date_entry.path();
                    let date_name = date_entry.file_name().to_string_lossy().to_string();
                    if !is_date_dir(&date_name) { continue; }
                    if !date_dir.is_dir() { continue; }
                    if let Ok(files) = fs::read_dir(&date_dir) {
                        for file_entry in files.flatten() {
                            let path = file_entry.path();
                            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                            if let Ok(content) = fs::read_to_string(&path) {
                                if let Ok(v) = serde_json::from_str(&content) {
                                    results.push(v);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    results
}

fn is_date_dir(s: &str) -> bool {
    if s.len() != 10 { return false; }
    let bytes = s.as_bytes();
    bytes[4] == b'-' && bytes[7] == b'-'
        && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit() && bytes[3].is_ascii_digit()
        && bytes[5].is_ascii_digit() && bytes[6].is_ascii_digit()
        && bytes[8].is_ascii_digit() && bytes[9].is_ascii_digit()
}
