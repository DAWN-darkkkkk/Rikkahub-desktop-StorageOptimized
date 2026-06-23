# Rikkahub Storage Optimization — 交接报告

**致**：yuh-G（Rikkahub 原作者）
**来自**：DAWN
**日期**：2026-06-24
**版本**：v1.2.5-Refcat-0.1.0-beta

---

## 一、动机

Rikkahub PC 将所有数据（配置 + 对话 + 日志）存储在单一 `state.json` 中，流式对话期间每 200ms 全量重写该文件。随着使用时间增长，这导致：

1. **流式写入阻塞** — 序列化数百 MB JSON 阻塞事件循环
2. **SSD 磨损** — 高频全量写入大文件
3. **日志冗余膨胀** — `requestBody` 和 `requestPreview` 各自存储相同的完整请求体（对话不超 256KB 时截断不生效），相当于每份请求存了两遍

本次重构围绕"存储减负"展开，目标：**让 Rikkahub 跑得更轻、更久、更干净**。

---

## 二、修改的文件

### `pc-server/server.ts`（核心后端）

#### 2.1 智能字段截断 (`smartTruncate`)

替换了原有的字符级盲截断（256KB 一刀切），新增递归 JSON 截断函数：

```typescript
function smartTruncate(value, maxStrLen = 100, maxArrayLen = 200, depth = 0, maxDepth = 10)
```

- **字符串**：超过 100 chars 截断并标记 `…[truncated N chars]`
- **数组**：超过 200 项截断并追加占位元素
- **对象**：递归处理每个 value，保留完整结构
- **number/boolean/null**：原样透传

这将 `jsonPreview()` 改为先截断再序列化：

```
jsonPreview(body) → JSON.stringify(smartTruncate(body), null, 2)
```

效果：日志保留完整 JSON 结构（所有 key、message role、tool name），仅长文本被截断，调试价值远高于盲截断。

#### 2.2 纯文本截断收紧

`textPreview()` 默认截断值从 32KB 降至 **100 chars**，与 `smartTruncate` 的字符串截断保持一致。

#### 2.3 消除 requestBody/responseBody 冗余

`addLog()` 不再将 `requestPreview` 复制到 `requestBody`，反之亦然。每条日志只保留一份智能截断后的内容：

```
改造前: requestPreview = "完整请求"  +  requestBody = "完整请求"（相同内容存两遍）
改造后: requestPreview = smartTruncate(请求)  （仅一份）
```

`RequestLog` 接口中 `requestBody`/`responseBody` 保留为可选字段以兼容旧数据读取。

#### 2.4 运行时旧数据迁移

`loadState()` 两个分支（新格式 + 旧格式迁移）均添加了日志清理逻辑：

```typescript
// 遍历 state.logs，删除每条日志的 requestBody/responseBody
for (const log of state.logs) {
  delete log.requestBody;
  delete log.responseBody;
}
```

下次 `saveState()` 时自然写出不含冗余字段的紧凑版本。

---

## 三、新增的文件

### `pc-server/convert.ts`（TypeScript 原型）

独立 CLI 工具，提供日志瘦身功能。已被 Rust 版本替代，保留作为参考实现。

### `pc-converter/`（Rust 重构，1.4 MB）

全新独立转换器，用 Rust 重写，产物仅 **1.4 MB**（对比 Bun 编译的 114 MB）。

**使用方式**：
1. 将 `convert-pc-data.exe` 放到 `rikkahub.exe` 同级（与 `pc-data` 目录并列）
2. 双击运行
3. 自动执行以下流程：

```
[1/4] 创建备份     pc-data → pc-data-backup-日期时间.zip
[2/4] 读取数据     识别 schemaVersion, 日志数量
[3/4] 拆分对话     v1 → v2, 每个会话独立文件
[4/4] 日志清除 + FTS 重建
```

**功能**：
- **ZIP 全量备份** — 处理前自动创建带时间戳的备份
- **对话拆分** — v1 格式的 `conversations[]` 按 `YYYY/YYYY-MM-DD/id.json` 提取
- **日志清除** — 直接删除所有历史日志（反正新日志会以智能截断格式重新生成）
- **FTS 重建** — 重建 `conversations.db` 全文索引
- **原地操作** — 不再在 pc-data 内生成 `.backup` 文件

### `web-ui/build/client/icons/`

将 `icons/` 目录复制到前端 build 输出中，修复了供应商图标和任务栏图标丢失的问题。

---

## 四、效果对比

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 单条 chat:stream 日志 | ~150-200 KB | ~3-8 KB |
| 日志总体积（500 条上限） | ~79 MB | ~5-8 MB（预估） |
| state.json（含对话） | ~85 MB | ~435 KB（仅索引） |
| 对话存储 | state.json 内嵌 | `conversations/YYYY/YYYY-MM-DD/` 独立文件 |
| 流式写入 | 全量写 state.json | 仅写当前会话文件 |
| requestBody/responseBody 冗余 | 每条存两遍 | 已消除 |
| 日志截断策略 | 256KB 盲截断（几乎不触发） | 100 chars 智能字段截断 |
| 转换器大小 | — | 1.4 MB（Rust） |

---

## 五、目录结构变化

```
pc-data/
  改造前                            改造后
  ├── state.json  [全部数据]         ├── state.json        [不含对话, 434 KB]
  └── ...                            ├── conversations/
                                     │    └── 2026/
                                     │         └── 2026-06-24/
                                     │              └── <id>.json  [单个会话]
                                     ├── conversations.db  [FTS 全文索引]
                                     └── ...
```

---

## 六、技术选型说明

- **`smartTruncate` 放在 `jsonPreview` 内部**：所有 ~40 个 `addLog` 调用方无需修改，自动生效
- **Rust 重写转换器**：Bun `--compile` 会将整个 JS 运行时（JavaScriptCore + API）打包进 exe，导致产物 ~114MB。Rust 编译为原生二进制，配合 `opt-level = "s"` + LTO + strip，产物仅 1.4 MB
- **向后兼容**：`loadState()` 自动检测 `schemaVersion`，旧格式自动迁移，新格式直接加载

---

## 七、后续建议

1. **NSIS 打包** — Tauri 内建 NSIS 下载在墙内经常超时。需要在 `%LOCALAPPDATA%\tauri\NSIS\` 下准备好 `nsis-3.11` 解压目录 + `Plugins\x86-unicode\additional\nsis_tauri_utils.dll`。详见博文：https://blog.csdn.net/Ricost/article/details/161190652
2. **logs 上限** — 当前 `addLog()` 保留最近 500 条（`state.logs.slice(0, 500)`），智能截断后即使 500 条也仅占用数 MB
3. **转换器增强** — 可考虑添加只读模式（显示统计不修改）和选择性日志保留（如保留最近 N 条错误日志）

---

感谢你创造了 Rikkahub，这是一个非常棒的 LLM 客户端。希望这些改动能对你有所帮助。

— DAWN
