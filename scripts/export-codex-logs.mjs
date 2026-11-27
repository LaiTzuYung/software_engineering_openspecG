// 將 Codex 對話紀錄（~/.codex/sessions/**/*.jsonl）轉成 Markdown，存到 docs/ai-logs/
// 用法：node scripts/export-codex-logs.mjs
// 只匯出工作目錄屬於本專案的對話；輸出前遮蔽金鑰類字串。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_KEYWORD = "software_engineering_openspecg";
const outDir = path.resolve("docs", "ai-logs");
const roots = [
  path.join(os.homedir(), ".codex", "sessions"),
  path.join(os.homedir(), ".codex", "archived_sessions"),
];

function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listJsonl(full));
    else if (entry.name.endsWith(".jsonl")) result.push(full);
  }
  return result;
}

function redact(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[已遮蔽：私鑰]")
    .replace(/("private_key(?:_id)?"\s*:\s*")[^"]*(")/g, "$1[已遮蔽]$2")
    .replace(/AIza[0-9A-Za-z_\-]{30,}/g, "[已遮蔽：API 金鑰]")
    .replace(/ya29\.[0-9A-Za-z_\-.]+/g, "[已遮蔽：存取權杖]");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function isBoilerplate(text) {
  const t = text.trimStart();
  return (
    t.startsWith("<environment_context>") ||
    t.startsWith("<user_instructions>") ||
    t.startsWith("<permissions") ||
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<INSTRUCTIONS>")
  );
}

function parseSession(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  let cwd = "";
  const items = [];
  const fallback = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row.payload ?? row;
    if (row.type === "session_meta" || payload.cwd) cwd ||= payload.cwd ?? "";
    if (typeof payload.text === "string" && payload.text.includes("<cwd>")) {
      const m = payload.text.match(/<cwd>([^<]+)<\/cwd>/);
      if (m) cwd ||= m[1];
    }
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const text = textOf(payload.content).trim();
      if (!text) continue;
      const m = text.match(/<cwd>([^<]+)<\/cwd>/);
      if (m) cwd ||= m[1];
      if (isBoilerplate(text)) continue;
      items.push({ kind: payload.role, text });
    } else if (payload.type === "function_call" || payload.type === "local_shell_call" || payload.type === "custom_tool_call") {
      let cmd = payload.arguments ?? payload.input ?? JSON.stringify(payload.action ?? "");
      try {
        const parsed = JSON.parse(cmd);
        if (Array.isArray(parsed.command)) cmd = parsed.command.join(" ");
        else if (typeof parsed.command === "string") cmd = parsed.command;
      } catch {}
      cmd = String(cmd);
      if (cmd.length > 400) cmd = cmd.slice(0, 400) + " …（略）";
      items.push({ kind: "tool", text: `${payload.name ?? "工具"}：${cmd}` });
    } else if (payload.type === "user_message" && typeof payload.message === "string") {
      if (!isBoilerplate(payload.message)) fallback.push({ kind: "user", text: payload.message.trim() });
    } else if (payload.type === "agent_message" && typeof payload.message === "string") {
      fallback.push({ kind: "assistant", text: payload.message.trim() });
    }
  }
  const hasMessages = items.some((i) => i.kind !== "tool");
  return { cwd, items: hasMessages ? items : fallback.concat(items) };
}

function render(file, session) {
  const base = path.basename(file, ".jsonl");
  const stamp = (base.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/) ?? []).slice(1);
  const firstUser = session.items.find((i) => i.kind === "user")?.text.split("\n")[0] ?? "（無使用者訊息）";
  const out = [
    `# Codex 對話紀錄：${firstUser.slice(0, 60)}`,
    "",
    `- 開始時間：${stamp.length ? `${stamp[0]} ${stamp[1]}:${stamp[2]}` : "未知"}`,
    `- 工作目錄：${session.cwd || "未知"}`,
    `- 原始檔：${path.basename(file)}`,
    `- 說明：由 scripts/export-codex-logs.mjs 自動轉出；工具呼叫只列指令、不列輸出；金鑰類字串已遮蔽。`,
    "",
  ];
  for (const item of session.items) {
    if (item.kind === "user") out.push("## 使用者", "", item.text, "");
    else if (item.kind === "assistant") out.push("## Codex", "", item.text, "");
    else out.push(`> 執行 ${item.text.replace(/\n/g, " ")}`, "");
  }
  const name = stamp.length ? `codex-${stamp[0]}-${stamp[1]}${stamp[2]}` : `codex-${base}`;
  return { name, body: redact(out.join("\n")) };
}

fs.mkdirSync(outDir, { recursive: true });
const files = roots.flatMap(listJsonl).sort();
const used = new Set();
let exported = 0;
for (const file of files) {
  const session = parseSession(file);
  const inProject = session.cwd.toLowerCase().includes(PROJECT_KEYWORD);
  if (!inProject) {
    console.log(`略過（非本專案或無工作目錄）：${path.basename(file)}  cwd=${session.cwd || "未知"}`);
    continue;
  }
  if (session.items.length === 0) {
    console.log(`略過（沒有對話內容）：${path.basename(file)}`);
    continue;
  }
  let { name, body } = render(file, session);
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${name}-${n}`;
  used.add(candidate);
  fs.writeFileSync(path.join(outDir, `${candidate}.md`), body, "utf8");
  const users = session.items.filter((i) => i.kind === "user").length;
  console.log(`已匯出：${candidate}.md（使用者訊息 ${users} 則）`);
  exported++;
}
console.log(`\n共找到 ${files.length} 個對話檔，匯出 ${exported} 個到 ${outDir}`);
