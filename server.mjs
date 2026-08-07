#!/usr/bin/env node
// HARE 伺服器（正式對外服務）——純 node:http，零依賴。
// 統一服務：dist/ 靜態檔（React Flow 前端）＋ /api/roadmap（GET/PUT）＋
// SSE /api/roadmap/events ＋ /mcp（MCP Streamable HTTP transport）。
// 部署前先 `npm run build` 產出 dist/；Vite dev server（vite.config.js）僅供開發，
// 對外請跑這支：`npm run serve`（= `node server.mjs`）。
//
// 環境變數：
//   PORT           監聽埠（預設 5233；與 vite dev 同埠時兩者不可同時跑，各自獨立即可）
//   ROADMAP_TOKEN  設定後，/api/roadmap 的 PUT 與 /mcp 的寫入工具都需要
//                  `Authorization: Bearer <ROADMAP_TOKEN>`；未設＝本機開發模式，寫入不驗證
//                  （開發模式恆真慣例）。讀取一律公開。
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBroadcaster } from "./lib/sse.mjs";
import { readStore, ensurePages } from "./lib/store.mjs";
import { taskTexts } from "./lib/tasks.mjs";
import { listPending } from "./lib/chat.mjs";
import { createRoadmapHandler } from "./lib/roadmap-api.mjs";
import { createMcpHttpHandler } from "./lib/mcp-http.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "dist");
const PORT = Number(process.env.PORT) || 5233;

// 版號顯示：小黑窗印 version＋啟動時間，一眼判斷跑的是哪一版
// 行程（重啟生效問題的對帳依據）；/api/version 供程式端探測（見 roadmap-api）。
let VERSION = "?";
try { VERSION = JSON.parse(await readFile(resolve(here, "package.json"), "utf8")).version || "?"; }
catch { /* 讀不到就顯示 ? */ }

// 單一廣播器：/api/roadmap 的 PUT 與 /mcp 的寫入工具都 in-process 直呼它，
// SSE 訂閱者立即收到新 rev；fs.watch 只作外部行程（如 stdio MCP 另開一支 process）的後備。
const broadcaster = createBroadcaster();
const roadmap = createRoadmapHandler({ broadcaster, watchFile: true });
const mcpHandler = createMcpHttpHandler({ broadcaster });

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8", // W3 PWA
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = normalize(join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) { res.statusCode = 403; res.end("forbidden"); return; }
  try {
    const data = await readFile(filePath);
    res.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
    // html 不准快取（舊 index.html 指舊 bundle，F5 會看不到新功能）；
    // /assets 檔名帶內容 hash，可長快取
    if (extname(filePath) === ".html") res.setHeader("Cache-Control", "no-cache");
    else if (urlPath.startsWith("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(data);
  } catch {
    // SPA fallback → index.html（React Flow 單頁 App，非 /assets 路徑一律當作前端路由）
    try {
      const idx = await readFile(join(DIST, "index.html"));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(idx);
    } catch {
      res.statusCode = 404;
      res.end("not found：請先執行 `npm run build` 產出 dist/");
    }
  }
}

const STARTED_AT = new Date().toISOString();

// 儀錶板（伺服器改隱藏啟動、小黑窗退場——狀態/日誌/額度偵測
// 改在白板設定框「儀錶板」頁看）。額度偵測源＝自訂 URL 清單（data/dash.json），
// 由伺服器代抓（免 CORS）、回應原樣展示——不寫死任何服務（通用化慣例）。
// HARE da5hb0a2 dashboard
const DASH_PATH = resolve(here, "data", "dash.json");
async function readDash() {
  try { return JSON.parse(await readFile(DASH_PATH, "utf8")) || {}; } catch { return {}; }
}
async function handleDash(req, res, url) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (url === "/api/dash" && req.method === "GET") {
    // CORS 開放（僅此唯讀狀態端點）：迷你浮窗是 null-origin 內嵌頁，不開會被瀏覽器
    // 擋下＝永遠顯示未連線（狀態錯誤的真因）
    res.setHeader("Access-Control-Allow-Origin", "*");
    let logTail = "";
    try {
      const raw = await readFile(resolve(here, "data", "server.log"), "utf8");
      logTail = raw.split(/\r?\n/).slice(-80).join("\n");
    } catch { /* 尚無 log（前景啟動＝輸出在主控台） */ }
    // 迷你狀態浮窗：開放任務數＋待裁定數（預設專案）
    let openTasks = null, pendingPerms = null;
    try {
      const pages = ensurePages((await readStore()) || {});
      openTasks = pages.reduce((s, p) => s + (p.nodes || [])
        .filter((n) => n.type !== "lane")
        .reduce((k, n) => k + taskTexts(n.data?.tasks).length, 0), 0);
    } catch { /* 板讀不到＝null */ }
    try { pendingPerms = (await listPending("default")).length; } catch { /* noop */ }
    return res.end(JSON.stringify({ version: VERSION, startedAt: STARTED_AT, pid: process.pid,
      uptimeSec: Math.round(process.uptime()), openTasks, pendingPerms, logTail }));
  }
  if (url === "/api/dash/probes" && req.method === "GET") {
    return res.end(JSON.stringify({ probes: (await readDash()).probes || [] }));
  }
  if (url === "/api/dash/probes" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const p = JSON.parse(body || "{}");
        const probes = (Array.isArray(p.probes) ? p.probes : [])
          .map((x) => ({ name: String(x?.name || "").slice(0, 60), url: String(x?.url || "").slice(0, 500) }))
          .filter((x) => x.url);
        const cur = await readDash();
        await writeFile(DASH_PATH, JSON.stringify({ ...cur, probes }, null, 2));
        res.end(JSON.stringify({ ok: true, probes }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
    });
    return;
  }
  const m = /^\/api\/dash\/probe\/(\d+)$/.exec(url);
  if (m && req.method === "GET") {
    const probes = (await readDash()).probes || [];
    const probe = probes[Number(m[1])];
    if (!probe) { res.statusCode = 404; return res.end(JSON.stringify({ error: "查無此偵測源" })); }
    try {
      // 代抓（免 CORS）：5 秒逾時、回應截 100KB、原樣回傳給前端展示
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const r = await fetch(probe.url, { signal: ac.signal });
      clearTimeout(timer);
      const text = (await r.text()).slice(0, 100 * 1024);
      return res.end(JSON.stringify({ ok: true, status: r.status,
        contentType: r.headers.get("content-type") || "", body: text }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  }
  res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
}

const server = createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  // 版號探測：{version, startedAt}——「重啟生效了沒」的機器可讀對帳點
  if (url === "/api/version") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ version: VERSION, startedAt: STARTED_AT }));
  }
  if (url === "/api/dash" || url.startsWith("/api/dash/")) return handleDash(req, res, url);
  // 全部 /api/* 交給共用 handler（roadmap/locate/projects/assets 都在裡面），
  // 它認不得的路徑走 next → 404，不落入 SPA fallback。
  if (url.startsWith("/api/")) {
    return roadmap.handler(req, res, () => { res.statusCode = 404; res.end(); });
  }
  if (url === "/mcp") return mcpHandler(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`HARE 伺服器（正式）v${VERSION}｜啟動於 ${new Date().toLocaleString()}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  靜態檔＝dist/ · /api/roadmap（GET/PUT）＋ SSE /api/roadmap/events · /mcp（MCP Streamable HTTP）`);
  console.log(process.env.ROADMAP_TOKEN
    ? "  ROADMAP_TOKEN 已設定：寫入端點需 Authorization: Bearer <token>"
    : "  ROADMAP_TOKEN 未設定：本機開發模式，寫入端點不驗證");
});
