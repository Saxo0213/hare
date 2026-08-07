// 白板卡片 ↔ headless agent session 的對話通道。
// 競品驗證過的最低成本模式（Claude-Code-Board 最簡＋Vibe Kanban 工程化）：
//   每 turn spawn 一次 `claude -p --output-format=stream-json --resume=<id>`，
//   stdin 寫 prompt 即關——無常駐進程；唯一持久狀態＝claude_session_id。
// 設計鐵則：
//   - 執行實體另立（session 檔案），不塞白板卡片欄位（vibe Task/Session 分層教訓）
//   - 從第一天只有一個 stream 處理點 processLine()（ccb 三代處理器去重債為鑑）
//   - presence 事件驅動：spawn/exit/權限掛起是「事實」，不靠 agent 自報；
//     殘留 running 於載入時校正（nimbalyst SessionStateManager 模式）
//   - 權限回問＝白板持久物件：--permission-prompt-tool → hare MCP request_permission
//     → pending 落檔＋SSE 浮出 → 核准/拒絕 → 回傳 allow/deny（四家皆無的差異化）
// HARE ba5ec4a7 chat-manager
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { dataDir, normalizeProjectId, DEFAULT_PROJECT, readStore, ensurePages } from "./store.mjs";
import { getProjectRefBase } from "./projects.mjs";
import { taskTexts } from "./tasks.mjs";
import { acceptsOf, acceptLine } from "./accepts.mjs"; // 驗收項（HARE 3ac5e77b accepts）
import { ensureWorktree, removeWorktree, worktreePath, closeoutWorktree } from "./worktree.mjs"; // MA1 每卡隔離工作目錄＋MA4 自動收尾
import { autoLand, projectScripts } from "./mergequeue.mjs"; // MA5 無同步修改自動合併＋scripts 資料列
import { runGate } from "./gate.mjs"; // MA5b：land 後自動建置（npm run build）用

// ---- 可注入設定（測試注入假 executor；伺服器注入 broadcaster 與 /mcp base URL）----
const cfg = {
  execCommand: null,        // [command, ...baseArgs]；null＝預設 ["claude"]
  broadcaster: null,        // lib/sse.mjs createBroadcaster()（需支援 broadcastEvent）
  permissionBaseUrl: null,  // 例 http://localhost:5233 → 產 mcp-config 給 spawned claude
  permissionTimeoutMs: 180000, // 逾時語意＝拒絕（預設 3 分鐘）
  worktreeIsolation: false,  // 開＝各卡 agent 跑自己的 git worktree branch（非 git／失敗 fallback 回 refBase）
  autoLand: true,            // turn 收尾後無同步修改＝自動合入 main（merge commit 可 revert）；env HARE_AUTOLAND=0 關
};
export function configureChat(opts = {}) { Object.assign(cfg, opts); }

// ---- 狀態：記憶體快取＋落檔（data/chat/<project>/sessions.json、<card>.jsonl）----
const states = new Map();   // project -> Promise<{ cards: { [cardId]: {sessionId,status,updatedAt,queue,pending} } }>（in-flight 佔位防 TOCTOU）
const children = new Map(); // `${project}:${card}` -> child process（interrupt 用）
const resolvers = new Map();// permId -> { resolve, timer }

function chatDir(project) { return resolve(dataDir(), "chat", normalizeProjectId(project)); }
function sessionsPath(project) { return resolve(chatDir(project), "sessions.json"); }
function transcriptPath(project, card) { return resolve(chatDir(project), `${card}.jsonl`); }

// 載入採「同步佔位 in-flight promise」：兩個並發的首次 loadState 若各自 read→set，
// 後到的會用全新物件蓋掉前者已變更的狀態（TOCTOU 孤兒——見 test/chat.test.mjs 權限測試中：
// requestPermission 剛 push 的 pending 被輪詢端的 loadState 覆蓋而消失）。
// promise 在第一個 tick 就進 map，之後所有呼叫共用同一份解析結果。
function loadState(project) {
  const pid = normalizeProjectId(project);
  let p = states.get(pid);
  if (!p) {
    p = (async () => {
      let st = { cards: {} };
      try { st = JSON.parse(await readFile(sessionsPath(pid), "utf8")); } catch { /* 首用＝空 */ }
      if (!st.cards) st.cards = {};
      // 殘留校正（HARE ca11b007 stale-running-fix）：伺服器行程重啟後「本行程」不可能還有
      // 活 turn——running/waiting 一律校正回 idle；pending 保留為紀錄。
      // 注意：spawn 出去的 agent 子行程在硬殺伺服器時
      // 不會陪葬——那部分由 reapOrphanAgents（伺服器啟動時）整樹回收，此處只管狀態欄位。
      for (const c of Object.values(st.cards)) {
        if (c.status === "running" || c.status === "waiting") c.status = "idle";
      }
      return st;
    })();
    states.set(pid, p);
  }
  return p;
}

// persist 走 per-project 序列化佇列（沿 store.mjs 慣例）：併發 persist 共用同一個
// tmp 檔名會互搶 rename（ENOENT，見 test/chat.test.mjs）；排隊後同名 tmp 無競爭，
// 且每次寫入都序列化當下的共享狀態物件——最後一筆即最新全貌。
const persistQueues = new Map(); // project -> 尾端 promise
function persist(project) {
  const pid = normalizeProjectId(project);
  const run = (persistQueues.get(pid) || Promise.resolve()).catch(() => {}).then(async () => {
    const st = await states.get(pid);
    if (!st) return;
    await mkdir(chatDir(pid), { recursive: true });
    const p = sessionsPath(pid);
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(st, null, 2));
    await rename(tmp, p); // 原子置換，沿 store 慣例
  });
  persistQueues.set(pid, run);
  return run;
}

function emit(project, payload) {
  try { cfg.broadcaster?.broadcastEvent?.({ type: "chat", ...payload }, normalizeProjectId(project)); }
  catch { /* 廣播失敗不影響通道本體 */ }
}

function cardState(st, card) {
  if (!st.cards[card]) st.cards[card] = { sessionId: null, status: "idle", updatedAt: null, queue: [], pending: [] };
  return st.cards[card];
}

async function appendMsg(project, card, role, text) {
  const msg = { t: new Date().toISOString(), role, text };
  await mkdir(chatDir(project), { recursive: true });
  await appendFile(transcriptPath(project, card), JSON.stringify(msg) + "\n");
  emit(project, { card, event: "msg", msg });
  return msg;
}

async function setStatus(project, card, status) {
  const st = await loadState(project);
  const c = cardState(st, card);
  c.status = status;
  c.updatedAt = new Date().toISOString();
  await persist(project);
  emit(project, { card, event: "status", status });
}

// ---- 工具事件譯人話（行為→看得懂的字；後續進化成行為→圖的翻譯層）----
export function describeTool(name, input = {}) {
  const f = (p) => String(p || "").replace(/\\/g, "/").split("/").slice(-2).join("/");
  if (name === "Read") return `讀檔 ${f(input.file_path)}`;
  if (name === "Write") return `寫檔 ${f(input.file_path)}`;
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return `改檔 ${f(input.file_path)}`;
  // 指令直接顯示（「跑指令」前綴很怪）：終端慣例 $ 開頭，🔧 圖示已表達工具
  if (name === "Bash" || name === "PowerShell") return `$ ${String(input.command || "").slice(0, 120)}`;
  if (name === "Grep" || name === "Glob") return `搜尋 ${input.pattern || ""}`;
  if (name === "TodoWrite") return "更新工作清單";
  if (name === "WebSearch" || name === "WebFetch") return `查網路 ${input.query || input.url || ""}`;
  // slice 長度用字串自算（「白板操作 pdate_card」——寫死 12 但
  // "mcp__hare__" 是 11 字元，首字母被吃掉）
  if (name?.startsWith("mcp__hare__")) return `白板操作 ${name.slice("mcp__hare__".length)}`;
  if (name?.startsWith("mcp__")) return `外部工具 ${name.slice("mcp__".length)}`;
  return name || "工具";
}

// ---- 單一 stream 處理點：所有串流行都只經過這一個函數（解析→落盤→推送）----
// N35 表格化後：JSON 行解析在此、**格式知識委派給 executor 列的 parseEvent**——
// 換 agent 不動這裡（ccb 三代處理器債的反面教材恆為戒）。
// HARE 57ea3901 stream-single-point
async function processLine(project, card, line, turn, row) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; } // 非 JSON 行（暖身輸出）忽略
  const act = row.parseEvent(ev);
  if (!act) return;
  if (act.sessionId) {
    const st = await loadState(project);
    cardState(st, card).sessionId = act.sessionId; // 唯一要持久化的接續狀態
    await persist(project);
  }
  for (const m of act.msgs || []) await appendMsg(project, card, m.role, m.text);
  if (act.result) {
    turn.gotResult = true;
    if (act.error) await appendMsg(project, card, "error", String(act.error).slice(0, 2000));
  }
}

// ---- 權限回問（HARE 9e21a110 permission-board-object）----
// spawned claude 經 --permission-prompt-tool 呼叫 hare MCP 的 request_permission，
// 走到這裡掛起等白板上裁定；逾時＝拒絕。pending 落檔＝跨重啟仍看得到紀錄。
export async function requestPermission(project, card, toolName, input) {
  // HARE 自家工具自動放行：agent 讀寫自己的白板是本分——
  // stdio 接入的 agent 本就無此關卡，chat 通道不應更嚴；writer 身分＋變更日誌＋快照
  // 已提供對帳與回滾。hare 系 skill（Skill 工具載入 hare-* 指引）同理放行。
  if (String(toolName || "").startsWith("mcp__hare__") ||
      (toolName === "Skill" && String(input?.skill || "").startsWith("hare"))) {
    return { behavior: "allow", updatedInput: input ?? {} };
  }
  const pid = normalizeProjectId(project || DEFAULT_PROJECT);
  const cid = card || "unknown";
  // 啟動檢核是執行閘門，不只是提示：規劃未經核可前，HARE 白板操作與唯讀工具
  // 可繼續，程式寫入／非唯讀指令即使已在永久白名單也拒絕。白名單不能越過專案狀態。
  const onboarding = await onboardingGate(pid);
  if (onboarding) {
    if (planningSafeTool(toolName, input)) return { behavior: "allow", updatedInput: input ?? {} };
    const message = `專案仍在啟動檢核（${onboarding.checklist}，尚餘 ${onboarding.open.length} 項）；` +
      "請先完整建立規劃／任務卡，並請使用者親自核可後再執行程式寫入。";
    await appendMsg(pid, cid, "perm", `⛔ 啟動閘門：${describeTool(toolName, input)}`);
    return { behavior: "deny", message };
  }
  // 白名單命中＝直接放行不浮出（工具行仍在轉錄可見）；危險 Bash 樣式永遠浮出
  if (await isWhitelisted(pid, cid, toolName, input)) {
    return { behavior: "allow", updatedInput: input ?? {} };
  }
  const st = await loadState(pid);
  const c = cardState(st, cid);
  const entry = { id: randomUUID().slice(0, 8), card: cid, tool: toolName, input: input ?? {}, t: new Date().toISOString(),
    // 危險旗標：UI 據此改紅色系統提醒＋僅此次/15 分鐘放行雙鈕
    ...((toolName === "Bash" || toolName === "PowerShell") && analyzeBashHeads(input?.command).danger ? { danger: true } : {}) };
  // resolver 必須在 pending 可見（persist/emit）之前註冊——否則「落檔→秒裁定」
  // 的間隙裡 resolvePermission 會撲空，請求只能等逾時（見 test/chat.test.mjs）。
  // 逾時秒數：專案設定（Agent 設定頁）優先於全域預設
  const timeoutMs = (await loadProjSettings(pid)).permissionTimeoutMs || cfg.permissionTimeoutMs;
  const allowP = new Promise((res) => {
    const timer = setTimeout(() => { resolvers.delete(entry.id); finalize(false, "逾時未裁定"); }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    let done = false;
    const finalize = async (ok, why, scope) => {
      if (done) return; done = true;
      clearTimeout(timer);
      const cur = await loadState(pid);
      const cc = cardState(cur, cid);
      cc.pending = cc.pending.filter((p) => p.id !== entry.id);
      await persist(pid);
      // 三檔核可：session/always 記入白名單，之後同類請求自動放行；
      // 危險指令 15 分鐘放行窗：scope=15min＝開窗，窗內危險樣式免問
      if (ok && scope === "15min") {
        await setProjSettings(pid, { dangerAllowUntil: Date.now() + 15 * 60 * 1000 });
        await appendMsg(pid, cid, "perm", "⚠✅ 已核准（危險指令 15 分鐘放行窗已開）");
      } else if (ok && (scope === "session" || scope === "always")) {
        await addAllow(pid, cid, entry.tool, entry.input, scope);
        await appendMsg(pid, cid, "perm", `✅ 已核准（${scope === "always" ? "永久" : "本會話"}白名單）`);
        // 連帶放行：入白名單當下重掃排隊中的待裁定（同工具連發不再逐一問）
        try { await resweepPending(pid); } catch { /* noop */ }
      } else {
        await appendMsg(pid, cid, "perm", ok ? "✅ 已核准" : `⛔ 已拒絕（${why || "使用者裁定"}）`);
      }
      if (cc.status === "waiting") await setStatus(pid, cid, "running");
      res(ok);
    };
    resolvers.set(entry.id, { resolve: finalize });
  });
  c.pending.push(entry);
  await persist(pid);
  await appendMsg(pid, cid, "perm", `等待核准：${describeTool(toolName, input)}`);
  await setStatus(pid, cid, "waiting");
  emit(pid, { card: cid, event: "perm", perm: entry });
  const allow = await allowP;
  return allow
    ? { behavior: "allow", updatedInput: input ?? {} }
    : { behavior: "deny", message: "使用者於白板拒絕（或逾時）" };
}

export async function resolvePermission(project, permId, allow, scope = "once") {
  const r = resolvers.get(permId);
  if (r) { resolvers.delete(permId); await r.resolve(!!allow, undefined, scope); return true; }
  // 沒有活 resolver（重啟後殘留紀錄）：只清紀錄
  const pid = normalizeProjectId(project);
  const st = await loadState(pid);
  let hit = false;
  for (const c of Object.values(st.cards)) {
    const before = c.pending.length;
    c.pending = c.pending.filter((p) => p.id !== permId);
    if (c.pending.length !== before) hit = true;
  }
  if (hit) await persist(pid);
  return hit;
}

// claude session 遺失徵狀（對話轉生觸發條件；宣告在 EXECUTORS 前防 TDZ）
const SESSION_LOST_RE = [/session|conversation/i, /not\s*found|no\s+conversation|invalid|does\s+not\s+exist/i];

// ---- 孤兒 agent 行程回收（HARE 0a9fa9e5 orphan-reap）----
// 伺服器被硬殺（taskkill /F）時 spawn 出去的 agent 子行程不會陪葬——孤兒繼續改檔，
// 重啟後新 turn 再開工＝同目錄雙寫互蓋。對策：spawn 即登記 pid（data/chat/agent-pids.json）、
// close 即除名；伺服器啟動時把「還活著且映像名吻合」的登記行程整樹終止，該卡轉錄留系統訊息。
const pidsPath = () => resolve(dataDir(), "chat", "agent-pids.json");
async function loadPids() { try { return JSON.parse(await readFile(pidsPath(), "utf8")) || []; } catch { return []; } }
let pidsQ = Promise.resolve(); // 讀改寫序列化（多 turn 並發登記/除名不互抹）
function mutatePids(fn) {
  pidsQ = pidsQ.then(async () => {
    const list = await loadPids();
    const next = fn(list) || list;
    await mkdir(resolve(dataDir(), "chat"), { recursive: true });
    await writeFile(pidsPath(), JSON.stringify(next));
  }).catch(() => { /* 登記失敗不影響 turn */ });
  return pidsQ;
}
function killTree(pid) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch { /* 已死＝目的達成 */ }
}
// pid 現任映像名（身分核對防 PID 重用誤殺）：win＝tasklist CSV、posix＝ps comm
function imageNameOf(pid) {
  return new Promise((res) => {
    const done = (o) => res(o || null);
    let c;
    try {
      c = process.platform === "win32"
        ? spawn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true })
        : spawn("ps", ["-p", String(pid), "-o", "comm="]);
    } catch { return done(null); }
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("close", () => {
      if (process.platform === "win32") { const m = o.match(/^"([^"]+)"/); done(m ? m[1] : null); }
      else done(o.trim());
    });
    c.on("error", () => done(null));
  });
}
export async function reapOrphanAgents() {
  const list = await loadPids();
  if (!list.length) return { reaped: [] };
  const reaped = [];
  for (const e of list) {
    const img = await imageNameOf(e.pid);
    // 映像名限 agent spawn 會出現的殼/執行檔；不吻合＝PID 已被別人重用，放過
    if (img && /^(cmd(\.exe)?|claude(\.exe|\.cmd)?|codex(\.exe|\.cmd)?|node(\.exe)?)$/i.test(img)) {
      killTree(e.pid);
      reaped.push(e);
      try {
        await appendMsg(e.project, e.card, "system",
          `♻ 伺服器重啟：終止上一代殘留 agent 行程（pid ${e.pid}）——防同目錄雙寫`);
      } catch { /* 轉錄失敗不擋回收 */ }
    }
  }
  await mutatePids(() => []);
  return { reaped };
}

// 訊息圖片→內容塊（「同 VSCode 帶入 prompt，而非收到後才讀取」）：
// 文字裡的 /api/assets/<專案>/<檔> 圖片連結→讀實體檔轉 base64 image 塊，隨訊息直接進模型。
// 上限 4 張防 context 爆、單張 >4MB 跳過（連結文字保留＝agent 仍可用 Read 讀）；
// executor 不支援（imageStdin 缺，如 codex）＝維持現行連結模式。export 供單元測試。
// HARE 1ma9e2p7 promptImages
const PROMPT_IMG_RE = /\/api\/assets\/([\w-]+)\/([\w.-]+\.(?:png|jpe?g|gif|webp))/gi;
export async function loadPromptImages(text) {
  const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(PROMPT_IMG_RE)) {
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key) || out.length >= 4) continue;
    seen.add(key);
    try {
      const buf = await readFile(resolve(dataDir(), "assets", m[1], m[2]));
      if (buf.length > 4 * 1024 * 1024) continue;
      const ext = m[2].slice(m[2].lastIndexOf(".") + 1).toLowerCase();
      out.push({ type: "image", source: { type: "base64", media_type: MIME[ext] || "image/png", data: buf.toString("base64") } });
    } catch { /* 檔不存在＝留連結給 Read */ }
  }
  return out;
}

// ---- executor 資料列（HARE e8ec7ab1 executors-table）----
// 「agent 當外掛」＝資料列驅動（同 IFACE_LANGS 慣例）：一列一家 agent——
// 指令組裝（buildArgs）／串流解析（parseEvent）／session 續接／權限橋接
// （permissionBridge）四件事都是列欄位。加一家＝加一列＋測試，主流程不動。
export const EXECUTORS = {
  claude: {
    command: "claude",
    permissionBridge: true, // 走每卡 mcp-config＋--permission-prompt-tool 回問橋
    // 帳號切換：claude 無 login 子命令，斜線命令當初始 prompt 進 REPL 執行
    auth: { login: ["/login"], logout: ["/logout"] },
    sessionLostRe: SESSION_LOST_RE,
    imageStdin: true, // 圖片可經 --input-format stream-json 以內容塊隨訊息進模型
    buildArgs({ sessionId, mcpCfgPath, allowedTools, withImages }) {
      const a = ["-p", "--output-format", "stream-json", "--verbose"];
      if (withImages) a.push("--input-format", "stream-json"); // 圖片訊息＝stream-json 使用者訊息
      if (sessionId) a.push("--resume", sessionId); // follow_up＝同一條路帶 --resume
      if (mcpCfgPath) a.push("--mcp-config", mcpCfgPath, "--permission-prompt-tool", "mcp__hare__request_permission");
      // 子 agent 權限繼承：白名單/政策編譯成 allowedTools——主迴圈照走
      // prompt-tool 回問，子 agent 對照此清單不再被靜默拒絕
      if (allowedTools && allowedTools.length) a.push("--allowedTools", allowedTools.join(","));
      return a;
    },
    // 串流格式知識（單一處理點 processLine 委派）：回 {sessionId?|msgs?|result?,error?}
    parseEvent(ev) {
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) return { sessionId: ev.session_id };
      if (ev.type === "assistant") {
        const msgs = [];
        for (const b of ev.message?.content || []) {
          if (b.type === "text" && b.text?.trim()) msgs.push({ role: "assistant", text: b.text });
          else if (b.type === "tool_use") msgs.push({ role: "tool", text: describeTool(b.name, b.input) });
        }
        return { msgs };
      }
      if (ev.type === "result") return { result: true, error: ev.is_error ? String(ev.result || ev.error || "agent 回報錯誤（無詳情）") : null }; // 空詳情也要浮出，不得靜默
      return null;
    },
  },
  // codex 列：格式依實機 `codex exec --json` 結構冒煙（thread.started/turn.*）。
  // 本機 CLI 0.133.0 過舊（帳號預設模型回 400 需升級 CLI），full 對話冒煙待升級後補——
  // 依 N35 卡任務自訂標準「實機冒煙後才標 real」。權限橋＝codex 自身 sandbox/approval
  // 設定（不走 prompt-tool），故 permissionBridge:false。
  codex: {
    command: "codex",
    permissionBridge: false,
    auth: { login: ["login"], logout: ["logout"] }, // 實子命令（以 --help 核對）
    sessionLostRe: [/session|thread|conversation/i, /not\s*found|invalid|no\s+such/i],
    buildArgs({ sessionId }) {
      return sessionId ? ["exec", "resume", sessionId, "--json", "-"] : ["exec", "--json", "-"]; // '-'＝prompt 走 stdin
    },
    parseEvent(ev) {
      if (ev.type === "thread.started" && ev.thread_id) return { sessionId: ev.thread_id };
      if (ev.type === "item.completed" && ev.item) {
        const it = ev.item;
        if (it.type === "agent_message" && it.text) return { msgs: [{ role: "assistant", text: it.text }] };
        if (it.type === "command_execution") return { msgs: [{ role: "tool", text: `$ ${String(it.command || "").slice(0, 120)}` }] };
        return null;
      }
      if (ev.type === "turn.completed") return { result: true, error: null };
      if (ev.type === "turn.failed") return { result: true, error: String(ev.error?.message || "turn failed").slice(0, 500) };
      if (ev.type === "error") return { msgs: [{ role: "error", text: String(ev.message || "").slice(0, 500) }] };
      return null;
    },
  },
  // 擴列（cursor/droid/amp，vibe 考據結構列）已依 W1-6-2移除——
  // 只留實機冒煙過的 claude/codex；需要時從 git 歷史還原。
};
// 專案級 executor 選擇（Agent 設定頁讀寫）：data/chat/<pid>/settings.json {executor}
const projSettings = new Map(); // pid -> Promise<{executor?, permissionTimeoutMs?}>（in-flight 佔位）
function settingsPath(pid) { return resolve(chatDir(pid), "settings.json"); }
export function loadProjSettings(pid) {
  let p = projSettings.get(pid);
  if (!p) {
    p = (async () => {
      try { return JSON.parse(await readFile(settingsPath(pid), "utf8")) || {}; } catch { return {}; }
    })();
    projSettings.set(pid, p);
  }
  return p;
}
export async function setProjSettings(pid0, patch) {
  const pid = normalizeProjectId(pid0);
  const cur = await loadProjSettings(pid);
  const next = { ...cur, ...patch };
  projSettings.set(pid, Promise.resolve(next));
  await mkdir(chatDir(pid), { recursive: true });
  await writeFile(settingsPath(pid), JSON.stringify(next, null, 2));
  // 政策/放行窗變動＝重掃待裁定（連帶放行）：切成「全部放行」的當下，排隊中的請求即刻解
  try { await resweepPending(pid); } catch { /* noop */ }
  return next;
}

// Agent 設定頁：executor CLI 偵測（有無/版本），結果快取 60 秒——設定框開啟時顯示
let execInfoCache = { t: 0, list: null };
export async function executorsStatus() {
  if (execInfoCache.list && Date.now() - execInfoCache.t < 60000) return execInfoCache.list;
  const list = await Promise.all(Object.entries(EXECUTORS).map(([name, row]) => new Promise((res) => {
    let out = "";
    let ch;
    // win32：npm 全域 shim 是 .cmd（如 codex），無 shell spawn 不到——偵測用 shell（參數固定字串，無注入面）
    const note = row.note || null; // 列註記（權限模式/冒煙狀態）隨偵測結果帶給設定頁
    // win32 走 shell（npm shim 是 .cmd）＝傳單一字串，不配 args 陣列（DEP0190）
    const winShim = process.platform === "win32";
    try {
      ch = winShim
        ? spawn(`${row.command} --version`, { windowsHide: true, shell: true })
        : spawn(row.command, ["--version"], { windowsHide: true });
    }
    catch { return res({ name, available: false, note }); }
    const timer = setTimeout(() => { try { ch.kill(); } catch { /* noop */ } }, 4000);
    ch.stdout?.on("data", (d) => (out += d));
    ch.on("error", () => { clearTimeout(timer); res({ name, available: false, note }); });
    ch.on("close", (code) => {
      clearTimeout(timer);
      res({ name, available: code === 0, version: out.trim().split("\n")[0].slice(0, 60) || null, note });
    });
  })));
  execInfoCache = { t: Date.now(), list };
  return list;
}
// 帳號登入/登出：CLI 帳號切換是互動流程（瀏覽器 OAuth／貼碼），不能 headless
// 代跑——開系統終端機視窗完成互動流程；指令來源＝EXECUTORS 列 auth 欄（資料列驅動）。
// HARE c4f7a812 agent-auth-terminal
export function agentAuthCommand(executor, action) {
  const row = EXECUTORS[executor];
  const args = row?.auth?.[action];
  return args ? [row.command, ...args].join(" ") : null;
}
// 平台開窗對照（資料列）：回傳 spawn 參數；cmdline 只來自 agentAuthCommand（固定字串，無注入面）
// win32 空字串＝start 的視窗標題佔位（首個引號參數會被 start 吃成標題）
const TERM_SPAWN = {
  win32: (c) => ["cmd", ["/c", "start", "", "cmd", "/k", ...c.split(" ")]],
  darwin: (c) => ["osascript", ["-e", `tell app "Terminal" to do script "${c}"`, "-e", 'tell app "Terminal" to activate']],
  linux: (c) => ["x-terminal-emulator", ["-e", "sh", "-c", `${c}; exec sh`]],
};
export function openAuthTerminal(executor, action) {
  const cmdline = agentAuthCommand(executor, action);
  if (!cmdline) return { ok: false, error: `不支援的 executor/action：${executor}/${action}` };
  const mk = TERM_SPAWN[process.platform] || TERM_SPAWN.linux;
  const [cmd, args] = mk(cmdline);
  try {
    const ch = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    ch.on("error", () => { /* 開窗失敗不炸伺服器；回應已送出，指令原樣給使用者手動跑 */ });
    ch.unref();
    return { ok: true, command: cmdline };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), command: cmdline };
  }
}

// Agent 設定彙整（GET /api/chat/settings）：設定值＋偵測結果＋永久白名單內容
export async function getAgentSettings(project) {
  const pid = normalizeProjectId(project);
  const settings = await loadProjSettings(pid);
  const perms = await loadProjPerms(pid);
  return { settings, executors: await executorsStatus(), whitelist: { tools: perms.tools || [], bash: perms.bash || [] } };
}
// 白名單整份覆寫（安全性頁清單編輯：儲存制）——只收字串陣列、修剪去重；
// 危險指令樣式（BASH_DANGER_RE）不因入列而放行，runtime 裁決照舊
export async function setProjWhitelist(project, wl) {
  const pid = normalizeProjectId(project);
  const clean = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean))];
  const next = { tools: clean(wl?.tools), bash: clean(wl?.bash) };
  projPerms.set(pid, Promise.resolve(next));
  await persistProjPerms(pid);
  return { ok: true, whitelist: next };
}
export async function clearProjWhitelist(project) {
  const pid = normalizeProjectId(project);
  projPerms.set(pid, Promise.resolve({ tools: [], bash: [] }));
  await persistProjPerms(pid);
  return { ok: true };
}

// 組旗標＋spawn：列驅動；cfg.execCommand（測試注入）覆寫 command＋前置參數、格式沿作用列
// HARE 4e9ab5c3 spawn-turn
// 白名單→ --allowedTools 規格（子 agent 權限繼承）：mcp__hare 全開＋已核工具名＋
// Bash 依政策（trust＝整顆；否則白名單頭＋safe-auto 安全頭逐一 Bash(<head>:*)）。
// 規格字元白名單化（頭來自已核指令，仍過濾防注入）；危險樣式不在任何白名單內。
export async function allowedToolsFor(pid, cid) {
  const st = await loadState(pid);
  const sess = cardState(st, cid).allow || { tools: [], bash: [] };
  const proj = await loadProjPerms(pid);
  const policy = (await loadProjSettings(pid)).bashPolicy || "safe-auto";
  const specs = new Set(["mcp__hare", "Task", "TodoWrite", "ToolSearch"]);
  const onboarding = await onboardingGate(pid);
  for (const t of [...(sess.tools || []), ...(proj.tools || [])]) {
    if (/^[\w-]+$/.test(t) && (!onboarding || PLANNING_SAFE_TOOLS.has(t))) specs.add(t);
  }
  // 啟動期不把任何 Bash 規格預先交給子 agent：每次實際命令都回到 requestPermission，
  // 由 planningSafeTool 檢查完整字串，避免永久 Bash 白名單繞過執行閘門。
  if (onboarding) return [...specs];
  if (policy === "trust" || policy === "all") specs.add("Bash");
  else {
    const heads = new Set([...(sess.bash || []), ...(proj.bash || [])]);
    if (policy === "safe-auto") for (const h of SAFE_BASH_HEADS) heads.add(h);
    for (const h of heads) if (/^[\w .-]+$/.test(h)) specs.add(`Bash(${h}:*)`);
  }
  return [...specs];
}

async function spawnTurn(project, card, prompt) {
  const pid = normalizeProjectId(project);
  const st = await loadState(pid);
  const c = cardState(st, card);
  const settings = await loadProjSettings(pid);
  const row = EXECUTORS[settings.executor || cfg.executor || "claude"] || EXECUTORS.claude;
  let mcpCfgPath = null;
  if (row.permissionBridge && cfg.permissionBaseUrl) {
    // 每卡一份 mcp-config：/mcp?chat=<card> 讓 request_permission 知道回哪張卡
    mcpCfgPath = resolve(chatDir(pid), `mcp-${card}.json`);
    await mkdir(chatDir(pid), { recursive: true });
    await writeFile(mcpCfgPath, JSON.stringify({ mcpServers: { hare: {
      type: "http", url: `${cfg.permissionBaseUrl}/mcp?chat=${encodeURIComponent(card)}&chatProject=${encodeURIComponent(pid)}`,
    } } }));
  }
  // 子 agent 權限繼承（調查定案）：CC 對 Task 子 agent 的權限檢查不走
  // permission-prompt-tool（轉錄實證：子 agent 呼叫零 perm 事件、被靜默拒絕）——
  // 把 HARE 白名單＋政策編譯成 --allowedTools 傳入，子 agent 循同一套授權。
  const allowedTools = row.permissionBridge ? await allowedToolsFor(pid, card) : null;
  // 圖片入 prompt（HARE 1ma9e2p7）：支援 imageStdin 的 executor 才抽圖轉內容塊
  const imgs = row.imageStdin ? await loadPromptImages(prompt) : [];
  const [command, ...baseArgs] = cfg.execCommand || [row.command];
  const args = [...baseArgs, ...row.buildArgs({ sessionId: c.sessionId, mcpCfgPath, allowedTools,
    withImages: imgs.length > 0 })];
  // MA1 每卡隔離：開 worktreeIsolation 時各卡跑自己的 git worktree branch（重用同分支＝session 續接）；
  // 非 git／建立失敗一律 fallback 回 refBase——隔離絕不弄壞通道。首次切 cwd 可能觸發一次 session 轉生
  // （runTurn 收尾已處理「cwd 變更」→ 以板側轉錄開新對話）。
  const refBase = await getProjectRefBase(pid);
  let cwd = refBase;
  if (cfg.worktreeIsolation) {
    const wt = await ensureWorktree(refBase, pid, card);
    if (wt) cwd = wt;
  }
  // win32 npm shim（.cmd，如 codex）需 shell 才 spawn 得到；shell 模式下對參數做安檢
  // （prompt 走 stdin 不經 shell；殼中繼字元一律拒；空白/括號等（allowedTools 規格）
  // 由下方引號包裹處理）
  const shell = process.platform === "win32" && !cfg.execCommand;
  if (shell && args.some((a) => !/^[\w\s(),:*.=\/\\-]+$/.test(a))) {
    throw new Error("spawn 參數含 shell 特殊字元，拒絕啟動（資料異常）");
  }
  // shell 模式傳單一字串（shell 配 args 陣列＝DEP0190）；參數已過上方白名單安檢，
  // 含空白者以引號包裹。非 shell 模式維持陣列＝不經 shell 解析。
  const shellArgs = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const child = shell
    ? spawn([command, ...shellArgs].join(" "), { cwd, windowsHide: true, shell: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, shellArgs, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  // 孤兒回收登記（HARE 0a9fa9e5）：shell 模式下 pid＝cmd 殼，killTree /T 涵蓋真身
  if (child.pid) {
    mutatePids((l) => [...l.filter((x) => x.pid !== child.pid),
      { pid: child.pid, project: pid, card, t: new Date().toISOString() }]);
    child.on("close", () => mutatePids((l) => l.filter((x) => x.pid !== child.pid)));
  }
  if (imgs.length) {
    // stream-json 的 user 訊息：文字＋圖片內容塊同一則（連結文字保留＝轉錄/引用仍可追）
    child.stdin.write(JSON.stringify({ type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }, ...imgs] } }) + "\n");
  } else {
    child.stdin.write(prompt);
  }
  child.stdin.end(); // 寫完即關：無常駐進程模式
  return { child, row };
}

// HARE 7c31f0d2 turn-run
// 綁定語境注入（HARE c0e7ex71 context-prefix）：每 turn prompt 前綴「本對話綁定
// 哪張卡」——agent 聽懂「這張卡」等指示代詞，不再全板大海撈針（ccb stage 前綴模式）。
// 慣例注入：板上若有「協作約定」卡（label 含「協作約定」），其 desc 一併前綴——
// 教一次、所有卡的 agent 都會；記憶形態＝看得見的卡片，不建隱藏記憶庫。
// 讀板失敗＝不注入（通道不因板況壞掉）；轉錄只記原話，前綴不進轉錄。
// 專案級對話保留 id（沒選卡＝跟「專案助理」講話）——
// 不綁單卡、驗卡放行、綁定前綴改成全板視角
export const PROJECT_CHAT_ID = "__project__";

// 入職狀態的單一讀法：meta 指向的檢核卡仍有 open tasks 才算閘門關閉前。
// 在瀏覽器完成最後一項後，tasks 歸零即放行；meta 稍後清理不影響判定。
export function onboardingGateFrom(data) {
  const ob = data?.meta?.onboarding;
  if (!ob?.card) return null;
  const pages = ensurePages(data || {});
  const card = pages.flatMap((p) => p.nodes || []).find((n) => n.id === ob.card);
  if (!card) return null;
  const open = taskTexts(card.data?.tasks);
  if (!open.length) return null;
  return { mode: ob.mode, card: card.id, checklist: card.data?.num || "O1", open };
}

async function onboardingGate(pid) {
  try { return onboardingGateFrom((await readStore(pid)) || {}); }
  catch { return null; }
}

const PLANNING_SAFE_TOOLS = new Set([
  "Read", "NotebookRead", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite", "ToolSearch", "Skill",
]);
const PLANNING_SAFE_BASH_HEADS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "grep", "rg", "findstr", "wc", "pwd", "whoami",
  "date", "tasklist", "netstat", "where", "which", "env", "printenv", "sort", "uniq",
  "git status", "git log", "git diff", "git show", "git branch", "git remote", "npm ls", "npm view",
]);

// 啟動期只准可判定為唯讀的操作；不明工具採安全方向拒絕。Bash 不允許重導向、
// command substitution 或寫入型頭綴；純版本查詢是環境盤點，視為唯讀。
export function planningSafeTool(toolName, input = {}) {
  if (PLANNING_SAFE_TOOLS.has(toolName)) return true;
  if (toolName !== "Bash" && toolName !== "PowerShell") return false;
  const command = String(input?.command || "").trim();
  if (!command || /[><`]|\$\(/.test(command)) return false;
  const segments = command.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((segment) => {
    if (/^(node|npm|npx|python|python3|cargo|rustc|git)\s+(--version|-v|version)$/i.test(segment)) return true;
    const { heads, danger } = analyzeBashHeads(segment);
    return !danger && heads.length === 1 && PLANNING_SAFE_BASH_HEADS.has(heads[0]);
  });
}

async function contextPrefix(pid, card) {
  try {
    const data = (await readStore(pid)) || {};
    const pages = ensurePages(data); // ensurePages 回傳頁「陣列」
    let bind = "", conv = "", gate = "";
    const ob = onboardingGateFrom(data);
    if (ob) {
      gate = `【啟動閘門】${ob.checklist} 尚有 ${ob.open.length} 項未完成。` +
        "在使用者親自完成「使用者核可」前，只能讀取、釐清需求、建立完整的規劃／架構／任務卡與依賴；" +
        "禁止建立或修改專案程式檔、安裝依賴、執行實作。完成 Specify／Plan／Tasks 後必須停下來請使用者檢視白板，" +
        "不得由 agent 呼叫 complete_task 代替使用者核可。\n";
    }
    if (card === PROJECT_CHAT_ID) {
      // 綁定專案講死（agent 另開專案建卡會讓原專案看不到）
      const title = data?.meta?.title ? `〈${data.meta.title}〉` : "";
      bind = `【專案級對話】本對話綁定專案「${pid}」${title}——你是這個白板專案的助理，` +
        "hare 工具省略 project 參數即落在本專案；所有規劃與卡片預設建在這裡。" +
        "除非使用者明確要求，不得建立新專案。" +
        "先用 get_overview／list_cards 掌握全板，涉及特定卡片時以卡號溝通。\n";
    }
    for (const p of pages || []) {
      for (const n of p.nodes || []) {
        if (n.id === card && !bind) {
          const num = n.data?.num || card;
          const label = n.data?.label || n.data?.title || "";
          // 卡片精華隨綁定注入（點入卡片＝卡片資訊帶入 agent，
          // 不必為基本事實再查一輪）：status＋desc 首段＋refs＋開放任務；rel/全文才走 get_card。
          const d0 = String(n.data?.desc || "").split(/\n[ \t]*\n/)[0].trim().slice(0, 200);
          const refs = (n.data?.refs || [])
            .map((r) => (r?.label ? `${r.path}#${r.label}` : r?.path)).filter(Boolean).slice(0, 6).join("、");
          const open = taskTexts(n.data?.tasks).slice(0, 5);
          // 驗收項＝這張卡對現實的映射（做完長什麼樣、在哪看得到）。比開放任務更接近規格，
          // 所以整份給——一張卡的驗收項本來就該少而準，不像任務要截前 5 條。
          const acc = acceptsOf(n.data).map(acceptLine);
          bind = `【對話綁定】本對話綁定白板卡片 ${num}〈${label}〉（分頁「${p.name || ""}」）。` +
            `使用者說的「這張卡／本卡」即此卡。\n` +
            `【卡片現況】status=${n.data?.status || "note"}${d0 ? `｜${d0}` : ""}\n` +
            (refs ? `【程式對應】${refs}\n` : "") +
            (acc.length ? `【驗收】做完長這樣（錨點＝現實位置）：\n　　${acc.join("\n　　")}\n` : "") +
            (open.length ? `【開放任務】${open.join("；")}\n` : "") +
            `關係鄰居（rel）或全文需要時再用 get_card ${num}。\n` +
            // 歸屬紀律（超出綁定卡範圍的工作全記在綁定卡＝板腐敗）
            `【歸屬紀律】只有本卡範圍內的工作才記在本卡；超出範圍的變更（改到別的功能區）` +
            `先 search_cards 找對應卡記錄，找不到就 add_card 開新卡（掛對容器、拉線），不得堆在本卡。\n`;
        }
        if (!conv && n.type === "note" && String(n.data?.label || "").includes("協作約定") && (n.data?.desc || "").trim()) {
          conv = `【專案約定】${String(n.data.desc).slice(0, 1200)}\n`;
        }
      }
    }
    return gate || bind || conv ? `${gate}${bind}${conv}\n` : "";
  } catch { return ""; }
}

// 對話轉生（HARE 4ebir7h1 session-rebirth）：--resume 指向的 session 檔失效
// （被清理/換機）時，清掉 sessionId、以板側轉錄尾段當「重生記憶」重試一次——
// 記憶從自家副本重生，轉錄留「轉生」系統訊息。僅在 stderr 明確指向 session 遺失時觸發
// （其他失敗照舊報 error，不誤吃 session）。
async function transcriptTail(pid, card, maxMsgs = 40, maxChars = 4000) {
  try {
    const raw = await readFile(transcriptPath(pid, card), "utf8");
    const msgs = raw.split("\n").filter(Boolean).slice(-maxMsgs)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((m) => m && (m.role === "user" || m.role === "assistant"));
    let out = "【轉生記憶】原 session 遺失，以下為板側轉錄節選（供延續脈絡）：\n";
    for (const m of msgs) {
      const line = `- ${m.role === "user" ? "使用者" : "助理"}：${String(m.text).replace(/\s+/g, " ").slice(0, 200)}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return out + "\n";
  } catch { return ""; }
}
// （SESSION_LOST_RE 宣告已上移至 EXECUTORS 表前——表格列於模組載入期即引用，防 TDZ）

// ---- 權限白名單層（HARE a110w115 permission-whitelist）----
// 三檔核可：once（僅此次，不記）／session（記入該卡 session 實體 allow）／always（記入
// 專案級 data/chat/<pid>/permissions.json）。requestPermission 先查白名單，命中＝直接
// allow 不浮出。Bash 走結構化判定（nimbalyst BashCommandAnalyzer 模式的精簡版）：
// 指令拆段（&& || | ; 分隔），每段取「頭綴」比對；危險樣式（rm -rf 類）永不自動放行。
const projPerms = new Map(); // pid -> Promise<{tools:[],bash:[]}>（in-flight 佔位，同 states 慣例）
function permsPath(pid) { return resolve(chatDir(pid), "permissions.json"); }
function loadProjPerms(pid) {
  let p = projPerms.get(pid);
  if (!p) {
    p = (async () => {
      try { const d = JSON.parse(await readFile(permsPath(pid), "utf8")); return { tools: d.tools || [], bash: d.bash || [] }; }
      catch { return { tools: [], bash: [] }; }
    })();
    projPerms.set(pid, p);
  }
  return p;
}
async function persistProjPerms(pid) {
  const d = await projPerms.get(pid);
  if (!d) return;
  await mkdir(chatDir(pid), { recursive: true });
  await writeFile(permsPath(pid), JSON.stringify(d, null, 2));
}
// 危險樣式：無論白名單為何，一律浮出讓人裁定（結構化底線）
// 危險樣式（擴充：「agent 清掉整個資料庫/磁碟」經典款一併入網）
const BASH_DANGER_RE = /(^|[;&|]\s*)(rm\s+-r|rm\s+-f|rmdir\s+\/s|del\s+\/[fqs]|format\s|mkfs|dd\s+if=|taskkill\s+\/f|git\s+push\s+--force|git\s+reset\s+--hard|git\s+clean\s+-[fdx]+)|drop\s+(database|table)\s|truncate\s+table\s/i;
// 兩詞頭綴家族：這些指令的第一個子指令語意差異大（npm test vs npm publish），頭綴取兩詞
const TWO_WORD_HEADS = new Set(["npm", "npx", "node", "git", "python", "pip", "cargo", "docker"]);
export function analyzeBashHeads(command) {
  const danger = BASH_DANGER_RE.test(String(command || ""));
  const heads = [];
  for (const seg of String(command || "").split(/&&|\|\||[;|]/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w)); // 跳過 ENV=x 前綴
    if (!words.length) continue;
    const head = TWO_WORD_HEADS.has(words[0]) && words[1] && !words[1].startsWith("-")
      ? `${words[0]} ${words[1]}` : words[0];
    if (!heads.includes(head)) heads.push(head);
  }
  return { heads, danger };
}
// 安全唯讀指令頭（重複核可太吵，系統自動裁決）——
// 只列「看不壞東西」的診斷/讀取類；寫入/安裝/網路類不入列，危險樣式另有 DANGER 網
export const SAFE_BASH_HEADS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "grep", "findstr", "wc", "echo", "pwd",
  "whoami", "date", "tasklist", "netstat", "where", "which", "env", "printenv", "sort", "uniq",
  "git status", "git log", "git diff", "git show", "git branch", "git remote",
  "npm ls", "npm view",
]);
// 核可政策（Agent 設定頁可調）：strict＝全部回問（白名單除外）；
// safe-auto（預設）＝安全唯讀頭自動放行；trust＝指令除危險樣式全放行；
// all＝所有工具與指令全放行（修正：原本只涵蓋 Bash，
// Read／外部 MCP 工具仍逐一回問）——危險 Bash 樣式在任何政策下照舊系統決斷。
// 檔案工具（「改個檔案不該還要核准」，HARE f11ea110 file-tool-policy）：
// 唯讀工具＝無副作用一律放行（沿 PLANNING_SAFE_TOOLS 同一份安全判定——入職期都放了，
// 平時更沒理由問）；編輯工具＝目標落在本卡 worktree／專案 refBase 內即放行（隔離分支
// ＋MA5 閘門＋git revert 是真正的安全邊界，回問不是）；界外路徑照舊回問。
const EDIT_FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export async function isWhitelisted(pid, cid, toolName, input) {
  const st = await loadState(pid);
  const sess = cardState(st, cid).allow || { tools: [], bash: [] };
  const proj = await loadProjPerms(pid);
  const settings = await loadProjSettings(pid);
  const policy = settings.bashPolicy || "safe-auto";
  if (toolName === "Bash" || toolName === "PowerShell") {
    const { heads, danger } = analyzeBashHeads(input?.command);
    if (danger) {
      // 危險樣式＝系統級決斷：任何政策/白名單都不自動放行；
      // 唯一例外＝剛裁定過的「15 分鐘放行窗」
      return Date.now() < (settings.dangerAllowUntil || 0);
    }
    if (!heads.length) return false; // 解析不出＝浮出
    if (policy === "trust" || policy === "all") return true;
    const allowed = new Set([...(sess.bash || []), ...(proj.bash || [])]);
    if (policy === "safe-auto") for (const h of SAFE_BASH_HEADS) allowed.add(h);
    return heads.every((h) => allowed.has(h));
  }
  if (PLANNING_SAFE_TOOLS.has(toolName)) return true; // 唯讀＝無副作用，任何政策都放
  if (EDIT_FILE_TOOLS.has(toolName)) {
    if (policy === "trust" || policy === "all") return true;
    const p = String(input?.file_path || input?.path || input?.notebook_path || "");
    if (p) {
      const rb = await getProjectRefBase(pid);
      const rawWt = worktreePath(rb, pid, cid);
      const norm = (s) => resolve(s).replace(/\\/g, "/").toLowerCase();
      const inside = (child, parent) => child === parent || child.startsWith(`${parent}/`);
      // 相對路徑＝相對 turn cwd（隔離開＝worktree、關＝refBase）——兩個基準都算界內
      const abs = norm(/^(?:[A-Za-z]:[\\/]|[\\/])/.test(p) ? p : resolve(cfg.worktreeIsolation ? rawWt : rb, p));
      if (inside(abs, norm(rawWt)) || inside(abs, norm(rb))) return true;
    }
    // 無路徑欄位／界外＝落回白名單與回問
  }
  if (policy === "all") return true; // 全部放行＝非指令工具也自動核可（入職閘門在上游仍優先）
  return (sess.tools || []).includes(toolName) || (proj.tools || []).includes(toolName);
}
async function addAllow(pid, cid, toolName, input, scope) {
  const put = (bag) => {
    if (toolName === "Bash" || toolName === "PowerShell") {
      bag.bash = bag.bash || [];
      for (const h of analyzeBashHeads(input?.command).heads) if (!bag.bash.includes(h)) bag.bash.push(h);
    } else {
      bag.tools = bag.tools || [];
      if (!bag.tools.includes(toolName)) bag.tools.push(toolName);
    }
  };
  if (scope === "session") {
    const st = await loadState(pid);
    const c = cardState(st, cid);
    c.allow = c.allow || { tools: [], bash: [] };
    put(c.allow);
    await persist(pid);
  } else if (scope === "always") {
    put(await loadProjPerms(pid));
    await persistProjPerms(pid);
  }
}

// 連帶放行（agent 連發同工具請求，核准第一個後其餘排隊中的仍逐一問）：
// 白名單或政策變動後重掃全部待裁定，以現行規則重判（isWhitelisted 單一真相），
// 符合者自動核准——危險樣式仍只認 15 分鐘窗，不會被一般白名單掃掉。
async function resweepPending(pid) {
  const st = await loadState(pid);
  for (const [cid, c] of Object.entries(st.cards || {})) {
    for (const p of [...(c.pending || [])]) {
      const r = resolvers.get(p.id);
      if (!r) continue;
      try {
        if (await isWhitelisted(pid, cid, p.tool, p.input)) { resolvers.delete(p.id); await r.resolve(true); }
      } catch { /* 單筆失敗不擋整掃 */ }
    }
  }
}

async function runTurn(project, card, prompt, { rebirth = false } = {}) {
  const pid = normalizeProjectId(project);
  const runId = randomUUID(); // Orca §6.2：每次派工一個 run 身分，防舊 run 收尾誤動新 run（同卡重試/轉生）
  await setStatus(pid, card, "running");
  const turn = { gotResult: false, interrupted: false };
  let child, row;
  try {
    // 綁定語境＋專案約定前綴只給 agent，不進轉錄（轉錄＝原話）
    ({ child, row } = await spawnTurn(pid, card, (await contextPrefix(pid, card)) + prompt));
  } catch (e) {
    await appendMsg(pid, card, "error", `無法啟動 agent：${e.message}`);
    await setStatus(pid, card, "error");
    return;
  }
  children.set(`${pid}:${card}`, { child, turn, runId });
  let errTail = "";
  child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  const rl = createInterface({ input: child.stdout });
  const lineJobs = [];
  rl.on("line", (line) => { lineJobs.push(processLine(pid, card, line, turn, row)); });
  // HARE d270c8f1 turn-close
  await new Promise((res) => child.on("close", res)).then(async (code) => {
    await Promise.allSettled(lineJobs);
    // Orca §6.2：本 run 已被新 run 取代（同卡重試/轉生已 children.set 新 runId）＝舊收尾，
    // 不得再碰 children/status/queue（否則舊 run 的 idle 會誤結束新 run）。
    if (children.get(`${pid}:${card}`)?.runId !== runId) return;
    children.delete(`${pid}:${card}`);
    // 診斷（turn 靜默死亡調查）：每輪收尾記 exit code／收到幾行／stderr 尾段
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(resolve(dataDir(), "turn-debug.log"),
        `${new Date().toISOString()} ${pid}:${card} code=${code} lines=${lineJobs.length} gotResult=${turn.gotResult} err=${errTail.slice(0, 300).replace(/\n/g, "⏎")}\n`);
    } catch { /* 診斷失敗不影響主流程 */ }
    if (turn.interrupted) {
      await appendMsg(pid, card, "system", "⏹ 已被使用者中斷");
      await setStatus(pid, card, "idle");
    } else if (code !== 0) {
      // session 遺失偵測不被 gotResult 短路（CLI 錯誤時也會發
      // 一行 is_error result，gotResult=true 曾讓轉生與報錯雙雙跳過＝靜默死亡）
      const st0 = await loadState(pid);
      const c0 = cardState(st0, card);
      const sessionLost = !rebirth && c0.sessionId && (row.sessionLostRe || SESSION_LOST_RE).every((re) => re.test(errTail));
      if (sessionLost) {
        c0.sessionId = null; // 失效 session 丟棄；新 turn 會抓回新 id（cwd 變更/檔案被清/換機皆同）
        await persist(pid);
        await appendMsg(pid, card, "system", "♻ 轉生：原 session 已失效（cwd 變更、檔案被清或換機），以板側轉錄記憶開新對話");
        const mem = await transcriptTail(pid, card);
        setImmediate(() => runTurn(pid, card, mem + prompt, { rebirth: true }));
        return; // 不落 error、不 drain（轉生 turn 收尾時處理）
      }
      if (!turn.gotResult) {
        await appendMsg(pid, card, "error", `agent 異常結束（code ${code}）${errTail ? "：" + errTail : ""}`);
        await setStatus(pid, card, "error");
      } else {
        await setStatus(pid, card, "idle"); // 有 result 的非零退出：錯誤已由 result 事件浮出
      }
    } else {
      // MA4 收尾自動閉環①：成功 turn 結束＝worktree 未 commit 變更自動收進卡片分支
      // （隔離分支豁免「要求才 commit」；main 歷史仍不動）。
      // MA5 無同步修改自動合併（裁定）：收進分支後緊接 autoLand——
      // 無他卡同檔、不撞主樹未提交檔、閘門綠 → 自動合入 main（merge commit 可 revert）；
      // 任一關不過＝分支保留、退佇列人審，轉錄如實記原因。
      // __project__ 一視同仁：否則專案助理殘留的未 commit 草稿會變成永久同檔封鎖。
      if (cfg.worktreeIsolation) {
        try {
          const rb = await getProjectRefBase(pid);
          const co = await closeoutWorktree(rb, pid, card,
            `通道自動收尾（${card}）：turn 完成變更入卡片分支`);
          if (co?.ok) await appendMsg(pid, card, "system", `🧾 自動收尾：worktree 變更已 commit ${co.commit}（${co.branch}）`);
          else if (co && !co.ok) await appendMsg(pid, card, "system", `⚠ 自動收尾失敗：${co.error || "未知"}——變更仍留在 worktree`);
          if (cfg.autoLand !== false) {
            const al = await autoLand(rb, { project: pid, card });
            if (al.landed) {
              await appendMsg(pid, card, "system",
                `✅ 自動整合：無同步修改，已合入 main（${al.commit}，git revert -m 1 可整卡復原）`);
              // 上線自動化（通用化：建置指令＝目標專案 package.json scripts.build
              // 的宣告，資料列不寫死任何棧；沒宣告 build＝不跑）。伺服器逐請求讀產物，重整即生效。
              const scripts = await projectScripts(rb);
              if (scripts.build) {
                const b = await runGate(rb, ["npm", "run", "build"]);
                await appendMsg(pid, card, "system", b.pass
                  ? "🏗 已自動建置（npm run build）——重整頁面即可看到"
                  : `⚠ 自動建置失敗（code ${b.code}）：${(b.output || "").slice(-200)}——請手動 npm run build`);
              }
              // 自我演進情境限定：land 的是「本 HARE 伺服器自己的 repo」且動到伺服器碼＝需重啟
              // （別的專案的後端是它自己的事，這提示與它無關）
              const selfRepo = resolve(rb).replace(/\\/g, "/").toLowerCase()
                === resolve(process.cwd()).replace(/\\/g, "/").toLowerCase();
              if (selfRepo && (al.files || []).some((f) => f.startsWith("lib/")
                || f === "server.mjs" || f === "mcp-server.mjs")) {
                await appendMsg(pid, card, "system", "🔁 含本伺服器後端改動——匣選單「重啟伺服器」後生效");
              }
            } else if (al.reason === "concurrent-edit") {
              const who = al.overlaps.map((o) => o.card).join("、");
              const fs = [...new Set(al.overlaps.flatMap((o) => o.files))].slice(0, 3).join("、");
              await appendMsg(pid, card, "system", `⏸ 未自動整合：與 ${who} 同檔並行（${fs}…）——分支保留，退整合佇列人審`);
            } else if (al.reason === "main-dirty-overlap") {
              await appendMsg(pid, card, "system", `⏸ 未自動整合：主工作樹有未提交的同檔改動（${al.files.slice(0, 3).join("、")}…）——分支保留待收`);
            } else if (al.reason === "diverged-conflict") {
              await appendMsg(pid, card, "system", `⏸ 未自動整合：與主線同檔演進衝突（${(al.files || []).slice(0, 3).join("、")}…）——分支保留，退整合佇列人審`);
            } else if (!["no-branch", "no-changes", "not-git"].includes(al.reason)) {
              // 閘門紅要附輸出尾段（只寫 gate-fail 無從對帳）
              const tail = al.gate && !al.gate.pass
                ? `\n閘門輸出尾段：${String(al.gate.output || "").slice(-400)}` : "";
              await appendMsg(pid, card, "system", `⏸ 未自動整合（${al.reason}）——分支保留，可走 run_integration_queue 人審${tail}`);
            }
          }
        } catch { /* 收尾/整合失敗不影響 turn 收束 */ }
      }
      await setStatus(pid, card, "idle");
    }
    // 排隊 prompt：Stop 後自動送出下一則（kanban-code queuedPrompts 模式）
    const st = await loadState(pid);
    const c = cardState(st, card);
    if (c.queue.length && !turn.interrupted) {
      const next = c.queue.shift();
      await persist(pid);
      emit(pid, { card, event: "queue", queue: c.queue.length });
      setImmediate(() => runTurn(pid, card, next));
    }
  });
}

// ---- 對外 API ----
// 送訊息：busy → 排隊；否則跑 turn。回 {started} 或 {queued: n}。
export async function sendMessage(project, card, text, { writer = "browser" } = {}) {
  const pid = normalizeProjectId(project);
  if (!card || !String(text || "").trim()) throw new Error("缺少卡片或訊息內容");
  // 卡片必須真在板上：否則打錯路徑的 POST 會建出無主 chat 狀態；
  // 已有狀態的卡放行——卡片事後被刪，既有轉錄仍可續讀續談
  const st = await loadState(pid);
  if (card !== PROJECT_CHAT_ID && !st.cards[card] && (await boardCardInfo(pid, card)) === null) {
    throw new Error(`板上找不到卡片：${card}（chat 只綁真實卡片）`);
  }
  const c = cardState(st, card);
  await appendMsg(pid, card, "user", String(text));
  if (c.status === "running" || c.status === "waiting") {
    c.queue.push(String(text));
    await persist(pid);
    emit(pid, { card, event: "queue", queue: c.queue.length });
    return { queued: c.queue.length };
  }
  runTurn(pid, card, String(text)); // 不 await：turn 在背景跑，呼叫端立即回
  return { started: true, writer };
}

// HARE a63e17b9 turn-interrupt
export async function interrupt(project, card) {
  const pid = normalizeProjectId(project);
  // spawn 起步競速：status 先轉 running、child 隨後才註冊——短暫等待再判定沒有 turn
  let h = children.get(`${pid}:${card}`);
  for (let i = 0; !h && i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    h = children.get(`${pid}:${card}`);
  }
  if (!h) return { ok: false, error: "沒有進行中的 turn" };
  h.turn.interrupted = true;
  if (process.platform === "win32") {
    // Windows：整棵行程樹砍掉（child.kill 只殺殼）
    spawn("taskkill", ["/F", "/T", "/PID", String(h.child.pid)], { windowsHide: true });
  } else {
    h.child.kill("SIGTERM");
  }
  return { ok: true };
}

// MA1 生命週期：卡片刪除/封存時清其隔離 worktree（best-effort）。
// force:false → 有未提交變更則保留（不毀工，留待手動或整合後清）；非 git／OFF／失敗＝安靜略過。
export async function cleanupCardWorktree(project, card) {
  try {
    const pid = normalizeProjectId(project);
    const refBase = await getProjectRefBase(pid);
    try { await access(worktreePath(refBase, pid, card)); } catch { return false; } // 無此 worktree＝快速略過，不 spawn git
    return await removeWorktree(refBase, pid, card);
  } catch { return false; }
}

// 讀取單卡狀態＋轉錄（limit＝尾端 N 則）。
// 讀取不建檔（側欄爆量根因）：原本借 cardState 取值＝看過的卡全種進
// 記憶體狀態、隨下次 persist 落 sessions.json，側欄堆滿從沒對話過的 idle 卡。
export async function getChat(project, card, { limit = 200 } = {}) {
  const pid = normalizeProjectId(project);
  const st = await loadState(pid);
  const c = st.cards[card] || { sessionId: null, status: "idle", queue: [], pending: [] };
  let messages = [];
  try {
    const raw = await readFile(transcriptPath(pid, card), "utf8");
    messages = raw.split("\n").filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* 尚無轉錄 */ }
  return { card, status: c.status, sessionId: c.sessionId, queue: c.queue.length, pending: c.pending, messages };
}

// 全專案待裁定清單（白板總覽「等你」浮出用）。
export async function listPending(project) {
  const st = await loadState(project);
  return Object.entries(st.cards).flatMap(([card, c]) => c.pending.map((p) => ({ ...p, card })));
}

// 板上查卡（id→編號/標題/分頁）：chat 標籤解析與 sendMessage 驗卡共用。
// 標籤解析放伺服器端（側欄只剩 mcp_* 原始 id）——前端原本只查
// 「當前分頁」節點，跨頁卡全部落空；這裡讀全店一次到位，前端不再自行猜。
// 回傳：找到＝{num,label,page,pageId}；板存在但查無此卡＝null；無板/空板＝undefined
//（不可考就不擋——測試專案與新專案沒板，chat 照常可用）
async function boardCardInfo(pid, cardId) {
  let pages;
  try { pages = ensurePages((await readStore(pid)) || {}); } catch { return undefined; }
  if (!pages.some((p) => (p.nodes || []).length)) return undefined;
  for (const pg of pages) {
    const n = (pg.nodes || []).find((x) => x.id === cardId);
    if (n) {
      return { num: n.data?.num || "", label: n.data?.label || n.data?.title || "",
        page: pg.name, pageId: pg.id };
    }
  }
  return null;
}

// 對話卡清單（chat 面板側欄）：所有「有聊天狀態」的卡都列——
// 作業中（waiting/running）排最前，其餘依最近更新排序；側欄點標籤＝快速切換對話。
// 每列附板上解析（num/label/page/pageId）；卡已不在板上＝missing:true（轉錄仍可讀）。
export async function listChats(project) {
  const pid = normalizeProjectId(project);
  const st = await loadState(pid);
  let pages = [];
  try { pages = ensurePages((await readStore(pid)) || {}); } catch { /* 板讀不到就全標 missing */ }
  const byId = new Map();
  for (const pg of pages) {
    for (const n of pg.nodes || []) {
      byId.set(n.id, { num: n.data?.num || "", label: n.data?.label || n.data?.title || "",
        page: pg.name, pageId: pg.id });
    }
  }
  const rank = (s) => (s === "waiting" ? 0 : s === "running" ? 1 : 2);
  return Object.entries(st.cards)
    // 只列真有對話證據的卡：歷史遺留的「看過就種檔」空 entry（含幽靈 active）不進側欄
    .filter(([, c]) => c.sessionId || c.updatedAt || (c.queue || []).length ||
      (c.pending || []).length || (c.status && c.status !== "idle"))
    .map(([card, c]) => ({ card, status: c.status, queue: (c.queue || []).length, updatedAt: c.updatedAt,
      ...(card === PROJECT_CHAT_ID ? { num: "", label: "", projectChat: true }
        : byId.get(card) || { missing: true }) }))
    .sort((a, b) => (rank(a.status) - rank(b.status)) ||
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}
