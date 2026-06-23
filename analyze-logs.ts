import { readFileSync } from "node:fs";

const s = JSON.parse(readFileSync("E:/Projects/Dev/old-pc-data/state.json", "utf8"));
const logs: any[] = s.logs || [];

console.log("=== 各类型统计 ===\n");
const byKind: Record<string, { count: number; totalBody: number; totalResp: number }> = {};
for (const l of logs) {
  const k = l.kind || "unknown";
  if (!byKind[k]) byKind[k] = { count: 0, totalBody: 0, totalResp: 0 };
  byKind[k].count++;
  byKind[k].totalBody += (l.requestBody || "").length;
  byKind[k].totalResp += (l.responseBody || "").length;
}
for (const [k, v] of Object.entries(byKind)) {
  const avgBody = (v.totalBody / v.count / 1024).toFixed(1);
  const avgResp = (v.totalResp / v.count / 1024).toFixed(1);
  console.log(`  ${k.padEnd(40)} ${String(v.count).padStart(4)} 条  avg req: ${avgBody.padStart(7)} KB  resp: ${avgResp.padStart(7)} KB`);
}

// 典型大请求
const sample = logs.find((l: any) => l.kind === "provider:chat:stream" && (l.requestBody || "").length > 200000);
if (sample) {
  const body = JSON.parse(sample.requestBody);
  const totalKB = (JSON.stringify(body).length / 1024).toFixed(1);
  console.log(`\n=== 典型 chat:stream 请求 (共 ${totalKB} KB) ===`);
  console.log(`  model: ${body.model}`);
  console.log(`  messages: ${body.messages?.length} 条`);
  if (body.messages) {
    for (let i = 0; i < Math.min(body.messages.length, 8); i++) {
      const m = body.messages[i];
      const len = (JSON.stringify(m).length / 1024).toFixed(1);
      const content = typeof m.content === "string" ? m.content.slice(0, 60) : JSON.stringify(m.content).slice(0, 60);
      console.log(`    [${i}] role=${m.role}  size=${len} KB  content=${content}`);
    }
    if (body.messages.length > 8) console.log(`    ... (${body.messages.length - 8} more)`);
  }
  if (body.tools) {
    console.log(`  tools: ${body.tools.length} 个  体积: ${(JSON.stringify(body.tools).length / 1024).toFixed(1)} KB`);
    const toolNames = body.tools.map((t: any) => t.function?.name || "unnamed").slice(0, 10);
    console.log(`  tool names: ${toolNames.join(", ")}`);
  }
}

// 总览
const totalMB = JSON.stringify(logs).length / 1024 / 1024;
const reqMB = logs.reduce((s: number, l: any) => s + (l.requestBody || "").length, 0) / 1024 / 1024;
const respMB = logs.reduce((s: number, l: any) => s + (l.responseBody || "").length, 0) / 1024 / 1024;
console.log(`\n=== 总览 ===`);
console.log(`  logs 总数: ${logs.length} (上限 500)`);
console.log(`  logs 总体积: ${totalMB.toFixed(1)} MB`);
console.log(`  requestBody 合计: ${reqMB.toFixed(1)} MB`);
console.log(`  responseBody 合计: ${respMB.toFixed(1)} MB`);
console.log(`  平均每条: ${((totalMB * 1024) / logs.length).toFixed(1)} KB`);
