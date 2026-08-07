#!/usr/bin/env node
// HARE → agent 平台整合安裝器（零依賴；agent 中立，不綁定單一平台）。
//
// 觀念：HARE 的 MCP server 是開放標準——任何 MCP client（Claude Code、Cursor、
// Codex、自製 agent）都能接，接上就從 initialize.instructions 得知何時應使用 HARE。
// 「skills」把建圖與工作流細節預載進各平台；正本＝本 repo `.claude/skills/hare-*`
// （HARE 自己原生吃＝第一個消費端），本安裝器把正本轉換成各平台格式。
//
// 用法（clone HARE 後）：
//   npm run install-agent                                # 自動偵測目標專案（cwd）有哪些平台設定
//   npm run install-agent -- --for claude                # Claude Code：.claude/skills/ ＋ claude mcp add
//   npm run install-agent -- --for cursor                # Cursor：.cursor/rules/*.mdc ＋ .cursor/mcp.json
//   npm run install-agent -- --for agents-md             # 通用 AGENTS.md 標準（Codex 等）：附 MCP 接法
//   npm run install-agent -- --project D:/MyApp          # 裝進指定專案（省略＝全域/目前目錄）
//   npm run install-agent -- --http https://host/mcp --token <t>   # 遠端部署：MCP 走 HTTP
//   旗標：--skip-mcp、--dry-run
//
// 發布與更新流程（後續修改一律走這條）：
//   改 `.claude/skills/hare-*` 正本或 MCP 工具 → bump package.json version →
//   目標端重跑 install-agent 即同步（目標寫 hare-agent-manifest.json 版本戳，冪等覆蓋）。
// HARE 1n57a11e install-agent
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_SRC = join(REPO, ".claude", "skills");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version || "0.0.0";

// ---- 參數 ----
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);
const project = opt("--project");
const forWhat = opt("--for");                 // claude | cursor | agents-md（省略＝偵測）
const httpUrl = opt("--http");
const token = opt("--token");
const dryRun = has("--dry-run"), skipMcp = has("--skip-mcp");
const log = (s) => console.log(`${dryRun ? "[dry-run] " : ""}${s}`);

// ---- 讀取 skill 正本（SKILL.md：frontmatter name/description ＋ 本文）----
const readSkill = (dir) => {
  const raw = readFileSync(join(SKILLS_SRC, dir, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const fm = Object.fromEntries((m ? m[1] : "").split("\n")
    .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])
    .filter(([k]) => k));
  return { dir, name: fm.name || dir, description: fm.description || "", body: (m ? m[2] : raw).trim(), raw };
};
const skills = existsSync(SKILLS_SRC)
  ? readdirSync(SKILLS_SRC).filter((d) => d.startsWith("hare-")).map(readSkill)
  : [];
if (!skills.length) { console.error(`找不到 skills 正本：${SKILLS_SRC}`); process.exit(1); }

// ---- MCP 連線描述（各平台共用）----
const mcpStdio = { command: "node", args: [join(REPO, "mcp-server.mjs")] };
const mcpHttp = httpUrl ? { url: httpUrl, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } : null;

// ---- 目標與平台偵測 ----
const targetRoot = project ? resolve(project) : process.cwd();
const detect = () => {
  const found = [];
  if (existsSync(join(targetRoot, ".claude")) || !project) found.push("claude"); // 全域安裝預設含 claude
  if (existsSync(join(targetRoot, ".cursor"))) found.push("cursor");
  if (existsSync(join(targetRoot, "AGENTS.md"))) found.push("agents-md");
  return found.length ? [...new Set(found)] : ["claude"];
};
const platforms = forWhat ? [forWhat] : detect();

const writeManifest = (dir) => {
  if (dryRun) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hare-agent-manifest.json"), JSON.stringify({
    version: VERSION, installedAt: new Date().toISOString(),
    skills: skills.map((s) => s.name), source: REPO,
  }, null, 2));
};

// ---- 適配器 ----
const ADAPTERS = {
  // Claude Code：skills 資料夾原样複製；MCP 用 claude CLI 註冊
  claude() {
    const dst = project ? join(targetRoot, ".claude", "skills") : join(homedir(), ".claude", "skills");
    for (const s of skills) {
      log(`[claude] skill：${s.name} → ${join(dst, s.dir)}`);
      if (!dryRun) { mkdirSync(dst, { recursive: true }); cpSync(join(SKILLS_SRC, s.dir), join(dst, s.dir), { recursive: true }); }
    }
    writeManifest(dst);
    if (skipMcp) return;
    const scope = project ? [] : ["-s", "user"];
    const add = mcpHttp
      ? ["mcp", "add", ...scope, "--transport", "http", "hare", httpUrl, ...(token ? ["--header", `Authorization: Bearer ${token}`] : [])]
      : ["mcp", "add", ...scope, "hare", "--", "node", join(REPO, "mcp-server.mjs")];
    log(`[claude] MCP：claude ${add.join(" ")}`);
    if (dryRun) return;
    // shell 模式傳單一字串（shell 配 args 陣列＝DEP0190）；參數由本檔自組，無外來輸入
    const run = (a) => spawnSync(["claude", ...a].join(" "), { cwd: targetRoot, shell: true, encoding: "utf8" });
    run(["mcp", "remove", ...scope, "hare"]); // 冪等
    const r = run(add);
    if (r.error || r.status !== 0) console.error(`⚠ claude CLI 不可用，請手動執行：claude ${add.join(" ")}`);
    else console.log((r.stdout || "").trim());
  },
  // Cursor：rules/*.mdc（description 觸發）＋ .cursor/mcp.json 合併
  cursor() {
    const rulesDir = join(targetRoot, ".cursor", "rules");
    for (const s of skills) {
      const mdc = `---\ndescription: ${s.description}\nalwaysApply: false\n---\n\n${s.body}\n`;
      log(`[cursor] rule：${s.name} → ${join(rulesDir, `${s.name}.mdc`)}`);
      if (!dryRun) { mkdirSync(rulesDir, { recursive: true }); writeFileSync(join(rulesDir, `${s.name}.mdc`), mdc); }
    }
    writeManifest(join(targetRoot, ".cursor"));
    if (skipMcp) return;
    const mcpPath = join(targetRoot, ".cursor", "mcp.json");
    let cfg = {}; try { cfg = JSON.parse(readFileSync(mcpPath, "utf8")); } catch { /* 新檔 */ }
    cfg.mcpServers = { ...(cfg.mcpServers || {}), hare: mcpHttp || mcpStdio };
    log(`[cursor] MCP：hare → ${mcpPath}`);
    if (!dryRun) writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
  },
  // 通用 AGENTS.md 標準（Codex 等）：以標記區塊冪等併入，含 MCP 接法
  "agents-md"() {
    const p = join(targetRoot, "AGENTS.md");
    const START = "<!-- HARE-AGENT-INTEGRATION start", END = "<!-- HARE-AGENT-INTEGRATION end -->";
    const block = [
      `${START} v${VERSION}（由 HARE install-agent 產生，重跑即更新，勿手改） -->`,
      "",
      "## HARE 白板（人＋AI agent 共用依賴圖路線白板）",
      "",
      "MCP 接入（開放標準，任一 MCP client）：",
      "```json",
      JSON.stringify({ mcpServers: { hare: mcpHttp || mcpStdio } }, null, 2),
      "```",
      "連上後 initialize.instructions 提供 HARE 的能力觸發；以下 skills 提供工作流細節：",
      "",
      ...skills.flatMap((s) => [`### ${s.name}`, `> ${s.description}`, "", s.body, ""]),
      END,
    ].join("\n");
    let cur = ""; try { cur = readFileSync(p, "utf8"); } catch { /* 新檔 */ }
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    const next = re.test(cur) ? cur.replace(re, block) : `${cur ? cur.trimEnd() + "\n\n" : ""}${block}\n`;
    log(`[agents-md] ${re.test(cur) ? "更新" : "併入"}區塊 → ${p}`);
    if (!dryRun) writeFileSync(p, next);
    writeManifest(targetRoot === REPO ? join(targetRoot, ".claude") : targetRoot);
  },
};

for (const pf of platforms) {
  const fn = ADAPTERS[pf];
  if (!fn) { console.error(`未知平台：${pf}（可用：${Object.keys(ADAPTERS).join(" / ")}）`); process.exit(1); }
  fn();
}
log(`完成 v${VERSION}：平台 [${platforms.join(", ")}]、skills ×${skills.length}${skipMcp ? "" : "、MCP"}。重開 agent session 生效。`);
