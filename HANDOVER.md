# Rikkahub 存储优化 —— 交接报告

**日期**：2026-06-23

---

## 目录结构

```
Rikkahub-StorageOptimize/
├── HANDOVER.md                  # 本文件
├── analyze-logs.ts              # logs 体积分析脚本
├── Rikkahub-Desktop/            # 修改后的项目源码
│   ├── pc-server/server.ts      #   主要修改文件（+~400 行）
│   ├── pc-server/convert.ts     #   新增：转换器源码
│   ├── convert-pc-data.exe      #   编译产物：转换器 CLI
│   └── ...                      #   其余项目文件
└── old-pc-data/                 # 旧版 pc-data 样本（85MB state.json）
    ├── state.json               #   原始单文件（77 对话，500 logs）
    ├── state.json.backup        #   转换时自动备份
    ├── conversations/           #   转换后提取的 77 个会话文件
    ├── conversations.db         #   FTS 全文索引
    └── ...
```

---

## 问题背景

RikkaHub PC 将所有数据（配置 + 对话 + 日志）存储在单一 `state.json` 中。流式对话期间每 200ms 全量重写该文件。用户面临的问题：

1. **流式写入阻塞**：序列化数百 MB JSON 阻塞事件循环
2. **SSD 磨损**：高频全量写入大文件
3. **不可持续增长**：随着对话积累，问题会不断恶化

---

## 已完成的工作

### 一、对话体拆分（核心改造）

**修改文件**：`pc-server/server.ts`（+~400 行，现 16,059 行）

**磁盘布局变化**：

```
改造前                              改造后

pc-data/                            pc-data/
  state.json   [全部数据]             state.json          [不含对话体]
                                     conversations/
                                       2026/
                                         2026-06-23/
                                           <uuid>.json   [单个会话]
                                     conversations.db     [FTS 全文索引]
```

**流式写入行为**：

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 流式对话 (每 200ms) | 全量写 state.json | 仅写当前会话文件 |
| 对话结束 | 全量写 state.json | 写 state.json + 当前会话文件 + 更新 FTS |
| 修改设置 | 全量写 state.json | 写 state.json |

**新增函数**：
- `ConversationIndex` 类型 — 对话元数据索引
- `conversationFilePath()` — `YYYY/YYYY-MM-DD/<id>.json` 路径生成
- `writeConversationFile()` / `readConversationFile()` / `deleteConversationFile()` — 会话文件 I/O
- `loadAllConversationsFromFiles()` — 启动时从文件扫描加载
- `migrateConversationsToFiles()` — 旧格式迁移
- `saveConversationFile()` — 公开 API：写文件 + 同步索引 + 更新 FTS
- `scheduleThrottledSaveConversation()` — 流时节流（200ms）
- FTS 相关：`initFts()` / `indexConversation()` / `deindexConversation()` / `searchConversationsFts()` / `rebuildAllFtsIndex()`

**修改的函数**：

| 函数 | 改动 |
|---|---|
| `State` 接口 | 新增 `conversationIndices`、`schemaVersion` 字段 |
| `performStateSave()` | 序列化时跳过 `conversations`，只写 `conversationIndices` |
| `scheduleThrottledSaveState(conv?)` | 接受可选 Conversation，流式时分支到会话文件保存 |
| `touchStream()` | 传入 `hooks.conversation` |
| `loadState()` | 新格式直接加载 + 旧格式自动迁移（含 .backup） |
| `deleteConversationsById()` | 同步删除文件 + FTS 反索引 |
| `generateAnswer()` | 5 处 saveState 前追加 saveConversationFile |
| 8 个路由 (pin/title/move/stop/fork/regenerate/select/delete) | 调用 saveConversationFile |
| `importAndroidConversations()` | 导入的对话写独立文件 |
| `applyBackupPayload()` / `applyPcBackupFromExtractDir()` | 恢复的对话写独立文件 |
| `createSettingsBackupZipToPath()` | ZIP 包含 conversations/ 目录 |
| `/api/conversations/search` | 优先 FTS，fallback 线性扫描 |

**向后兼容**：首次启动检测 `schemaVersion` < 2 → 自动迁移（创建 backup → 提取对话 → 写新 state.json）

### 二、JSON 格式化输出

`state.json` 和会话文件均使用 `JSON.stringify(x, null, 2)` 缩进输出，便于人工查阅和 diff。

### 三、会话文件路径简化

从 `YYYY/MM/DD/<id>.json`（4 层级）简化为 `YYYY/YYYY-MM-DD/<id>.json`（3 层级）。目录扫描从 3 层嵌套循环减为 2 层。

### 四、旧版 pc-data 转换器

**产物**：`convert-pc-data.exe`（CLI 工具，`pc-server/convert.ts` 源码）

**用法**：
```bash
convert-pc-data.exe <pc-data目录路径> [--dry-run] [--no-backup] [--reindex-fts]
```

**功能**：
- 读取旧版单文件 state.json
- 自动创建 state.json.backup
- 提取对话到 `conversations/YYYY/YYYY-MM-DD/<id>.json`
- 重写 state.json（去掉 conversations，加入 conversationIndices）
- 可选重建 FTS 全文索引
- `--dry-run` 预览不写入

**测试结果**（old-pc-data 样本）：77 个对话成功转换，0 失败

### 五、Tauri 桌面应用

**构建产物**：`web-ui/src-tauri/target/release/rikkahub.exe`

**架构**：Tauri 壳 + Bun 编译的侧车二进制（`binaries/rikkahub-server-x86_64-pc-windows-msvc.exe`）。壳负责原生窗口和 WebView2 渲染，所有业务逻辑在后端侧车中。

**构建步骤**：
```bash
cd web-ui && bun install && bun run build          # 前端 SPA
cd pc-server && bun build --compile server.ts       # 编译侧车
    --outfile ../web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe
cd web-ui && bun run tauri:build                    # Tauri 编译 + NSIS 打包
```

**注意**：NSIS 安装器未成功生成（环境缺少 NSIS 工具），但 `rikkahub.exe` 可执行文件已编译完成并实测运行正常。

---

## 未完成的工作

### Logs 瘦身（高优先级）

**现状**：`state.json` 中 `logs[]` 数组占 77-79 MB（500 条日志上限），是 state.json 体积的主要构成。

**根因**：`addLog()` 同时存储 `requestBody`（完整请求体，含对话历史）和 `requestPreview`（前 256KB 裁剪预览）。两者内容冗余。每条 chat:stream 请求的 requestBody 约 150-200 KB。

**方案**：去掉 `requestBody`/`responseBody`，只保留 `requestPreview`/`responsePreview`。

**改动位置**：`server.ts` 中 `addLog()` 函数（~2105 行），约 4 行改动。

**预期效果**：logs 从 79 MB 降至 3-5 MB，state.json 总大小从 85 MB 降至 <10 MB。

**风险评估**：低。`requestPreview`/`responsePreview` 是日志 UI 面板实际展示的内容。`requestBody`/`responseBody` 仅被烟雾测试断言使用，移除后烟雾测试需对应调整。

### 烟雾测试修复

`scripts/request-chain-smoke.ts` 中图片生成测试断言 `requestBody` 存在——这是已有问题（原始代码也失败）。

### NSIS 安装器

需安装 NSIS 工具后重新执行 `bun run tauri:build`。

---

## 关键文件索引

| 文件 | 路径 | 说明 |
|---|---|---|
| 后端主文件 | `Rikkahub-Desktop/pc-server/server.ts` | 所有业务逻辑，唯一被修改的文件 |
| 转换器源码 | `Rikkahub-Desktop/pc-server/convert.ts` | 独立的 CLI 转换工具 |
| 转换器 exe | `Rikkahub-Desktop/convert-pc-data.exe` | 编译产物，可直接分发 |
| 日志分析 | `analyze-logs.ts` | `bun run analyze-logs.ts` 运行 |
| 旧版数据 | `old-pc-data/` | 85MB state.json 样本，77 对话 |
| 转换后数据 | `old-pc-data/conversations/` | 77 个格式化会话 JSON |
| Tauri 壳 | `Rikkahub-Desktop/web-ui/src-tauri/` | Rust 原生窗口工程 |
| Tauri 产物 | `Rikkahub-Desktop/web-ui/src-tauri/target/release/rikkahub.exe` | 编译完成的桌面应用 |
