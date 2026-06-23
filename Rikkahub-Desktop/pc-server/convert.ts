import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";

// === 类型定义 ===

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Message {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  parts: JsonValue[];
  annotations: JsonValue[];
  createdAt: string;
  finishedAt: string | null;
  modelId: string | null;
  usage: JsonValue | null;
  translation: string | null;
}

interface MessageNode {
  id: string;
  messages: Message[];
  selectIndex: number;
}

interface Conversation {
  id: string;
  assistantId: string;
  systemPrompt: string | null;
  title: string;
  messages: MessageNode[];
  truncateIndex: number;
  chatSuggestions: string[];
  isPinned: boolean;
  createAt: number;
  updateAt: number;
}

interface ConversationIndex {
  id: string;
  assistantId: string;
  title: string;
  isPinned: boolean;
  createAt: number;
  updateAt: number;
  messageCount: number;
  filePath: string;
}

// === 工具函数 ===

function toConversationIndex(conversation: Conversation): ConversationIndex {
  return {
    id: conversation.id,
    assistantId: conversation.assistantId,
    title: conversation.title,
    isPinned: conversation.isPinned,
    createAt: conversation.createAt,
    updateAt: conversation.updateAt,
    messageCount: conversation.messages.length,
    filePath: conversationFilePath(conversation.createAt, conversation.id),
  };
}

function conversationFilePath(createAt: number, id: string): string {
  const date = new Date(createAt);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return join(year, `${year}-${month}-${day}`, `${id}.json`);
}

function writeConversationFile(conversationsDir: string, conversation: Conversation): string {
  const relPath = conversationFilePath(conversation.createAt, conversation.id);
  const absPath = join(conversationsDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(conversation, null, 2));
  return relPath;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countMessages(conversations: Conversation[]): number {
  let count = 0;
  for (const conv of conversations) {
    count += conv.messages.reduce((sum, node) => sum + node.messages.length, 0);
  }
  return count;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

// === FTS ===

function initFts(ftsDbPath: string): Database | null {
  try {
    const db = new Database(ftsDbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
        conversation_id, title, content, tokenize='unicode61'
      )
    `);
    return db;
  } catch {
    return null;
  }
}

function extractText(conversation: Conversation): string {
  const parts: string[] = [];
  for (const node of conversation.messages) {
    const msg = node.messages[node.selectIndex];
    if (!msg) continue;
    for (const part of msg.parts) {
      if (part && typeof part === "object" && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === "string") {
        parts.push((part as Record<string, string>).text);
      }
    }
  }
  return parts.join("\n");
}

function indexConversation(db: Database, conversation: Conversation): void {
  try {
    db.exec("DELETE FROM conversation_fts WHERE conversation_id = ?", [conversation.id]);
    const text = extractText(conversation);
    db.exec("INSERT INTO conversation_fts VALUES (?, ?, ?)", [conversation.id, conversation.title, text]);
  } catch { /* skip */ }
}

// === 日志瘦身 ===

function smartTruncate(value: unknown, maxStrLen = 100, maxArrayLen = 200, depth = 0, maxDepth = 10): unknown {
  if (depth > maxDepth) return "[max depth]";
  if (typeof value === "string") {
    return value.length > maxStrLen ? `${value.slice(0, maxStrLen)}…[truncated ${value.length - maxStrLen} chars]` : value;
  }
  if (Array.isArray(value)) {
    const truncated = value.slice(0, maxArrayLen).map((item) => smartTruncate(item, maxStrLen, maxArrayLen, depth + 1, maxDepth));
    if (value.length > maxArrayLen) {
      truncated.push(`…[${value.length - maxArrayLen} more items]`);
    }
    return truncated;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = smartTruncate(val, maxStrLen, maxArrayLen, depth + 1, maxDepth);
    }
    return result;
  }
  return value;
}

function slimLogs(logs: unknown[]): { logs: unknown[]; removedBody: number; removedResp: number; smartTruncated: number } {
  let removedBody = 0;
  let removedResp = 0;
  let smartTruncated = 0;
  for (const log of logs) {
    const entry = log as Record<string, unknown>;
    if (entry.requestBody) {
      if (!entry.requestPreview) {
        const raw = entry.requestBody as string;
        try {
          entry.requestPreview = JSON.stringify(smartTruncate(JSON.parse(raw)), null, 2);
          smartTruncated++;
        } catch {
          entry.requestPreview = raw.length > 100 ? `${raw.slice(0, 100)}…[truncated ${raw.length - 100} chars]` : raw;
        }
      }
      delete entry.requestBody;
      removedBody++;
    }
    if (entry.responseBody) {
      if (!entry.responsePreview) {
        const raw = entry.responseBody as string;
        try {
          entry.responsePreview = JSON.stringify(smartTruncate(JSON.parse(raw)), null, 2);
          smartTruncated++;
        } catch {
          entry.responsePreview = raw.length > 100 ? `${raw.slice(0, 100)}…[truncated ${raw.length - 100} chars]` : raw;
        }
      }
      delete entry.responseBody;
      removedResp++;
    }
  }
  return { logs, removedBody, removedResp, smartTruncated };
}

// === ZIP 备份 ===

function zipBackup(dataDir: string): string | null {
  const parentDir = dirname(dataDir);
  const folderName = basename(dataDir);
  // 生成带时间戳的备份文件名
  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  const zipName = `${folderName}-backup-${ts}.zip`;
  const zipPath = join(parentDir, zipName);

  console.log(`\n[1/4] 创建备份: ${zipName}`);
  try {
    // 使用 PowerShell Compress-Archive（Windows 自带，无需额外依赖）
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${dataDir}' -DestinationPath '${zipPath}' -Force"`,
      { stdio: "pipe", timeout: 120_000 },
    );
    const size = statSync(zipPath).size;
    console.log(`       备份完成: ${formatBytes(size)}`);
    return zipPath;
  } catch (err) {
    console.log(`       备份失败: ${err}，继续处理...`);
    return null;
  }
}

// === 主逻辑 ===

interface ProcessResult {
  conversationsSplit: number;
  conversationsFailed: number;
  messagesTotal: number;
  logsDeleted: number;
  ftsRebuilt: boolean;
  stateBefore: number;
  stateAfter: number;
}

function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Rikkahub pc-data 转换器 v2            ║");
  console.log("╚══════════════════════════════════════════╝");

  const exeDir = dirname(process.execPath);
  const dataDir = join(exeDir, "pc-data");
  const statePath = join(dataDir, "state.json");

  console.log(`\n工作目录: ${dataDir}`);

  if (!existsSync(statePath)) {
    console.log("\n未找到 pc-data/state.json，无需处理。");
    console.log("请将本程序放在 rikkahub.exe 同级目录下运行。");
    console.log("\n按回车键退出...");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(0));
    return;
  }

  // 1. ZIP 备份
  zipBackup(dataDir);

  // 2. 读取
  console.log(`\n[2/4] 读取 state.json`);
  const rawContent = readFileSync(statePath, "utf8");
  const stateBefore = rawContent.length;
  const raw = JSON.parse(rawContent) as Record<string, unknown>;
  const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;

  const logsCount = Array.isArray(raw.logs) ? (raw.logs as unknown[]).length : 0;
  console.log(`       schemaVersion: v${schemaVersion}, 日志: ${logsCount} 条`);

  const result: ProcessResult = {
    conversationsSplit: 0,
    conversationsFailed: 0,
    messagesTotal: 0,
    logsDeleted: logsCount,
    ftsRebuilt: false,
    stateBefore,
    stateAfter: 0,
  };

  // 3. 对话拆分（仅 v1）
  const conversations = Array.isArray(raw.conversations) ? raw.conversations as Conversation[] : [];
  const conversationsDir = join(dataDir, "conversations");

  if (schemaVersion < 2 && conversations.length > 0) {
    console.log(`\n[3/4] 拆分对话 (v1 → v2)`);
    const msgCount = countMessages(conversations);
    console.log(`       会话: ${conversations.length} 个, 消息: ${msgCount} 条`);
    result.messagesTotal = msgCount;

    mkdirSync(conversationsDir, { recursive: true });
    const indices: ConversationIndex[] = [];

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      try {
        writeConversationFile(conversationsDir, conv);
        indices.push(toConversationIndex(conv));
        result.conversationsSplit++;
      } catch (err) {
        result.conversationsFailed++;
      }
    }

    raw.schemaVersion = 2;
    raw.conversationIndices = indices;
    delete raw.conversations;
    console.log(`       成功: ${result.conversationsSplit} 个, 失败: ${result.conversationsFailed} 个`);
  } else {
    console.log(`\n[3/4] 对话格式已是 v2，跳过拆分`);
    // 从文件加载对话用于后续 FTS 重建
    if (schemaVersion >= 2) {
      const loaded = loadConversationsFromFiles(conversationsDir);
      result.messagesTotal = countMessages(loaded);
      // 把加载的对话放回 raw.conversations 供 FTS 使用
      (raw as Record<string, unknown>).conversations = loaded;
    }
  }

  // 4. 清除日志
  if (Array.isArray(raw.logs)) {
    raw.logs = [];
  }

  // 写入 state.json
  const newContent = JSON.stringify(raw, null, 2);
  writeFileSync(statePath, newContent);
  result.stateAfter = newContent.length;

  console.log(`\n[4/4] 重建 FTS 全文索引`);
  const ftsDbPath = join(dataDir, "conversations.db");
  const db = initFts(ftsDbPath);
  if (db) {
    const convsForFts = Array.isArray((raw as Record<string, unknown>).conversations)
      ? (raw as Record<string, unknown>).conversations as Conversation[]
      : [];
    db.exec("DELETE FROM conversation_fts");
    for (const conv of convsForFts) {
      indexConversation(db, conv);
    }
    db.close();
    result.ftsRebuilt = true;
    console.log("       FTS 索引已重建");
  } else {
    console.log("       FTS 索引创建失败（可忽略）");
  }

  // === 汇总报告 ===
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║              处理完成                   ║");
  console.log("╚══════════════════════════════════════════╝");

  if (result.conversationsSplit > 0) {
    console.log(`\n 📁 对话拆分 (v1 → v2):`);
    console.log(`     ${result.conversationsSplit} 个会话 → conversations/`);
    console.log(`     ${result.messagesTotal} 条消息已提取`);
    if (result.conversationsFailed > 0) {
      console.log(`     ⚠ ${result.conversationsFailed} 个失败`);
    }
  } else {
    console.log(`\n 📁 对话格式: 已是 v2，无需拆分`);
  }

  if (result.logsDeleted > 0) {
    console.log(`\n 🗑 日志已清除: ${result.logsDeleted} 条`);
  } else {
    console.log(`\n 🗑 日志: 无`);
  }

  if (result.ftsRebuilt) {
    console.log(`\n 🔍 FTS 全文索引: 已重建`);
  }

  console.log(`\n 💾 state.json: ${formatBytes(result.stateBefore)} → ${formatBytes(result.stateAfter)}`);

  const backupFiles = safeReaddir(dirname(dataDir)).filter((f) => f.startsWith("pc-data-backup-") && f.endsWith(".zip"));
  if (backupFiles.length > 0) {
    console.log(`\n 📦 备份文件: ${backupFiles[backupFiles.length - 1]}`);
  }

  console.log("\n按回车键退出...");
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(0));
}

// === v2 对话加载（仅用于 FTS 重建） ===

function loadConversationsFromFiles(conversationsDir: string): Conversation[] {
  const results: Conversation[] = [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const yearDirs = safeReaddir(conversationsDir);
  for (const year of yearDirs) {
    const yearDir = join(conversationsDir, year);
    if (!isDir(yearDir)) continue;
    const dateDirs = safeReaddir(yearDir);
    for (const dateDir of dateDirs) {
      if (!dateRe.test(dateDir)) continue;
      const fullDateDir = join(yearDir, dateDir);
      if (!isDir(fullDateDir)) continue;
      const files = safeReaddir(fullDateDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const absPath = join(fullDateDir, file);
          results.push(JSON.parse(readFileSync(absPath, "utf8")) as Conversation);
        } catch { /* skip */ }
      }
    }
  }
  return results;
}

main();
