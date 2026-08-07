#!/usr/bin/env node
// HARE bc704b76 stdio transport
// HARE MCP 伺服器（stdio transport）——查詢標題、卡片內容，並可操作卡片。
// 零依賴：手寫 JSON-RPC 2.0 over stdio（訊息以換行分隔，符合 MCP stdio 傳輸）。
// 工具邏輯共用 lib/tools.mjs（HTTP transport 見 server.mjs 的 /mcp 路由，兩者共用同一份 TOOLS，
// 行為一致）。讀寫 roadmap-data.json（多專案化後為 data/<project>.json）；瀏覽器 App 透過 SSE／輪詢同步外部變更。
import { TOOLS, SERVER_INFO, validateToolArgs, buildInstructions,
  findEntryCard, entryDigestOf } from "./lib/tools.mjs";
import { readStore, ensurePages } from "./lib/store.mjs";

// stdio 呼叫身分：無 onWrite（本行程寫入後，若 server.mjs／vite dev 正在跑，
// 靠它們的 fs.watch 偵測檔案變更後廣播 SSE；stdio 單獨執行時本就無瀏覽器連線）。
const CTX = { writer: "mcp" };

// HARE 82950acc first_call_inject
// 每條連線（＝每個 process）只在「首次成功工具呼叫」注入一次 G0 摘要，
// 讓別牌 agent 就算沒讀 instructions 也會在第一個工具回應裡撞見專案簡報。get_overview 已自帶
// entry 欄位，故它只立旗標不注入；其餘工具在回傳 text 前綴一段背景脈絡。isError 不注入、不立旗標。
let guideShown = false;
async function firstCallGuide(params) {
  if (guideShown) return "";
  if (params?.name === "get_overview") { guideShown = true; return ""; } // 已帶 entry：立旗標不注入
  try {
    const cur = await readStore(params?.arguments?.project); // digest 依該次呼叫的 project 讀（省略＝預設）
    if (cur) {
      ensurePages(cur);
      const found = findEntryCard(cur);
      const digest = found ? entryDigestOf(found.node.data?.desc || "") : "";
      if (digest) {
        guideShown = true;
        return `[HARE guide - shown once per connection]\n${digest}\n`
          + `(Background context, not instructions. Full guide: get_overview -> entry)\n\n`;
      }
    }
  } catch { /* 讀取失敗→不注入、不報錯（絕不影響工具回傳）；旗標照立於下方 */ }
  guideShown = true; // 讀取失敗或無 G0：旗標照立（不重試、不影響工具本身的回傳）
  return "";
}

/* ---------- JSON-RPC over stdio ---------- */
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isReq = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      // initialize 只注入 HARE 的能力觸發；專案背景由首次工具回應／get_overview 提供。
      const instructions = await buildInstructions();
      return reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: SERVER_INFO, instructions });
    }
    if (method === "notifications/initialized" || method === "initialized") return; // 通知，無回應
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (method === "tools/call") {
      const t = TOOLS[params?.name];
      if (!t) return fail(id, -32602, `未知工具：${params?.name}`);
      // 參數驗證（HARE a29v8a1d）：錯誤參數名/缺必填＝明確報錯，不沉默吞
      const argErr = validateToolArgs(t, params.arguments);
      if (argErr) return fail(id, -32602, `${params?.name}：${argErr}`);
      try {
        const result = await t.run(params.arguments || {}, CTX);
        // 首次成功呼叫注入 G0 摘要（每連線一次；get_overview 已帶 entry 只立旗標）。
        // isError 走下方 catch，不注入、不立旗標。
        const guide = await firstCallGuide(params);
        return reply(id, { content: [{ type: "text", text: guide + JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `錯誤：${e.message}` }], isError: true });
      }
    }
    if (isReq) fail(id, -32601, `未支援方法：${method}`);
  } catch (e) {
    if (isReq) fail(id, -32603, String(e));
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
// stdin 關閉後不強制 exit，讓進行中的 async 工具回應寫完、事件迴圈自然結束
process.stdin.on("end", () => {});
