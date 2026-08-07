// /api/roadmap 橋接（GET/PUT）＋ SSE（GET /api/roadmap/events）共用實作。
// 被 vite.config.js（開發用 middleware）與 server.mjs（正式對外服務）共用，
// 兩邊行為保證一致：讀取公開；寫入視 ROADMAP_TOKEN 決定是否需要 Bearer；
// PUT 支援 expectedRev 樂觀鎖（多人並發保護，見 lib/store.mjs 的 RevConflictError）。
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  readStore, updateStore, DATA_PATH, dataDir, dataPathFor, normalizeProjectId, DEFAULT_PROJECT,
  RevConflictError, EmptyWriteError, ensurePages, findPage,
} from "./store.mjs";
import { mergeBoard } from "./merge.mjs";
import { saveAsset, ASSET_MAX_BYTES } from "./assets.mjs";
import { authorize } from "./auth.mjs";
import { listProjects, createProject, getProjectRefBase, archiveProject, unarchiveProject } from "./projects.mjs";
import { configureChat, sendMessage, getChat, interrupt, resolvePermission, listPending, listChats,
  getAgentSettings, setProjSettings, clearProjWhitelist, setProjWhitelist, openAuthTerminal,
  reapOrphanAgents } from "./chat.mjs";

// /api/locate 的路徑解析基準（refBase）由 getProjectRefBase(project) per 專案提供，
// 不再固定 REPO_ROOT（DATA_PATH 仍用於預設專案外部變更的 mtime 輪詢後備）。

// 從 URL query 取專案代號（非法／缺省一律回退預設專案，讀取端不因壞參數噴錯）。
function projectOf(url) {
  try { return normalizeProjectId(new URL(url, "http://x").searchParams.get("project")); }
  catch { return DEFAULT_PROJECT; }
}

// N6 閱讀器「只顯示目標區塊」：由錨點行（// HARE <uuid> <label>）推斷該區塊的結尾行 index。
// 先用標籤定位宣告行，再大括號平衡（C 系）或縮排回退（Python 系）找區塊尾；單行語句止於分號。
// 回傳 0-based 結尾行 index（含）；找不到就給小範圍保底。純字元掃描（粗略，字串/註解內的括號可能誤判，可接受）。
export function blockEndFrom(lines, ai, lang) {
  const n = lines.length;
  const cap = Math.min(n - 1, ai + 500);
  // 標籤 → 宣告行：取標籤中的識別字（複合標籤如「BG_COLORS／setNodeBg」由末段函數名優先）
  const label = ((lines[ai] || "").match(/HARE\s+\w+\s+(.+?)\s*$/) || [])[1] || "";
  const tokens = label.split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 2);
  let ds = -1;
  for (let ti = tokens.length - 1; ti >= 0; ti -= 1) {
    const idx = lines.findIndex((l, k) => k > ai && l.includes(tokens[ti]));
    if (idx > ai && idx <= cap) { ds = idx; break; }
  }
  if (ds < 0) { ds = ai + 1; while (ds <= cap && (lines[ds] || "").trim() === "") ds += 1; } // 退回：錨點後第一行程式碼
  if (ds > cap) return Math.min(n - 1, ai + 1);
  const braceLang = !["py", "pyw", "rb", "yaml", "yml", "toml", "ini", "cfg", "conf"].includes(String(lang || "").toLowerCase());
  if (braceLang) {
    // 逐行累計大括號淨深度，只在「行尾」判斷——行內參數解構 `({...})` 的 `}` 會被同行 `{` 抵消，
    // 不致提前收（如 `function F({a,b}) {` 淨 +1）。單行語句（未開區塊、以 ; 結尾）即止。
    let depth = 0, opened = false;
    for (let k = ds; k <= cap; k++) {
      const line = lines[k];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === "{") { depth += 1; opened = true; }
        else if (ch === "}") depth -= 1;
      }
      if (opened && depth <= 0) return k;
      if (!opened && /;\s*$/.test(line)) return k;
    }
    return Math.min(cap, ds + 30);
  }
  const indentOf = (s) => (s.match(/^\s*/)[0] || "").length; // 縮排語言：回到 ≤ 宣告行縮排＝區塊結束
  const di = indentOf(lines[ds]);
  for (let k = ds + 1; k <= cap; k++) {
    if (lines[k].trim() === "") continue;
    if (indentOf(lines[k]) <= di) return k - 1;
  }
  return Math.min(cap, ds + 30);
}

// watchFile：是否啟用「外部行程直接改檔案」（如 stdio MCP、另一個服務行程）的後備通知。
// 本行程自己的 PUT／/mcp 寫入一律 in-process 直呼 broadcaster.broadcast()（零延遲），
// 這裡只是後備路徑。
// mtime 輪詢取代 fs.watch（fs.watch 漏事件會讓 agent 改了白板但前端沒反應）：
//   (1) win32 對 data/ 資料夾 fs.watch 會踩 libuv 硬斷言（fs-event.c:72）abort，先前只能
//       整個停用——等於 stdio MCP 的外部寫入在 Windows 完全沒有 SSE 通知；而前端
//       「SSE 連線活著就暫停輪詢」，兩者疊加＝畫面永遠不更新。
//   (2) 原子寫入（tmp＋rename 置換）也可能讓單檔 watcher 盯著舊 inode 失聲。
// 輪詢法：每秒只 stat「有訂閱者的專案」資料檔（含預設專案），mtime 變了才 readStore
// 廣播；無人訂閱＝迴圈空轉零 I/O。跨平台、無 libuv 地雷、對 rename 置換免疫。
// HARE 55ew4tch mtime-poll
export function createRoadmapHandler({ broadcaster, watchFile = false } = {}) {
  // chat 事件（msg/status/perm）走同一條 SSE。
  // MA1 啟用（「啟用＋驗收」）：worktreeIsolation 開＝各卡 agent 跑自己的
  // git worktree branch（hare/chat/*），非 git／失敗 fallback 回 refBase。停用＝env HARE_WORKTREE=0。
  // autoLand（無同步修改自動合入 main）預設開；env HARE_AUTOLAND=0 關。
  configureChat({ broadcaster, worktreeIsolation: process.env.HARE_WORKTREE !== "0",
    autoLand: process.env.HARE_AUTOLAND !== "0" });
  // 孤兒 agent 回收：上一代伺服器被硬殺時 spawn 的
  // agent 不會陪葬——啟動即整樹終止殘留登記行程，防新舊兩代同目錄雙寫。
  reapOrphanAgents().catch(() => { /* 回收失敗不擋啟動 */ });

  if (watchFile) {
    const mtimes = new Map(); // project -> 上次看到的 mtimeMs
    const tick = async () => {
      const pids = new Set(broadcaster.projects ? broadcaster.projects() : []);
      for (const pid of pids) {
        let m;
        try { m = statSync(pid === DEFAULT_PROJECT ? DATA_PATH : dataPathFor(pid)).mtimeMs; }
        catch { continue; } // 檔案不存在/暫時鎖住＝下輪再看
        if (mtimes.get(pid) === m) continue;
        mtimes.set(pid, m);
        try {
          const d = await readStore(pid);
          if (d && typeof d.rev === "number") broadcaster.broadcast(d.rev, pid); // lastRev 去重
        } catch { /* 讀取失敗＝下輪再試 */ }
      }
    };
    setInterval(tick, 1000).unref(); // unref：不擋行程退出（測試/CLI 情境）
  }

  async function handler(req, res, next) {
    const url = req.url || "";

    // 標籤定位：GET /api/locate?path=<refBase 相對路徑>&q=<標籤文字>&project=<id>
    // 回傳含 q 的第一行行號（前端組 vscode://file/<abs>:<line> 跳到該行）。唯讀、限該專案 refBase 內。
    // path 相對「該專案 refBase」解析（未設 refBase＝repo 根＝今日行為），穿越（../）擋掉。
    if (req.method === "GET" && url.startsWith("/api/locate")) {
      res.setHeader("Content-Type", "application/json");
      try {
        const u = new URL(url, "http://x");
        const rel = String(u.searchParams.get("path") || "").replace(/\\/g, "/").replace(/^\/+/, "");
        const q = String(u.searchParams.get("q") || "").trim();
        let project;
        try { project = normalizeProjectId(u.searchParams.get("project")); } catch { project = DEFAULT_PROJECT; }
        const baseRoot = await getProjectRefBase(project);
        const abs = resolve(baseRoot, rel);
        if (!abs.startsWith(baseRoot + sep) || !rel || !q) {
          res.statusCode = 400; res.end(JSON.stringify({ error: "bad path/q" })); return;
        }
        const lines = (await readFile(abs, "utf8")).split("\n");
        // 標籤可能含（）補注，只拿第一段識別符比對；全文不中再放寬為原字串
        const key = q.split(/[（(]/)[0].trim();
        let line = lines.findIndex((l) => key && l.includes(key)) + 1;
        if (!line) line = lines.findIndex((l) => l.includes(q)) + 1;
        res.end(JSON.stringify({ line: line || null }));
      } catch (e) {
        res.statusCode = 404; res.end(JSON.stringify({ error: String(e && e.code || e) }));
      }
      return;
    }

    // 內建程式碼閱讀器：GET /api/read-file?path=<refBase 相對>&q=<錨點文字>&project=&ctx=<前後行>
    // 回傳「錨點片段」：q 命中行為中心，若同 uuid 有 `HARE-END` 收尾＝整塊，否則錨點行 ±ctx。
    // 無 q＝檔首片段。唯讀、限該專案 refBase 內、穿越（../）擋掉；大檔上限保護。
    if (req.method === "GET" && url.startsWith("/api/read-file")) {
      res.setHeader("Content-Type", "application/json");
      try {
        const u = new URL(url, "http://x");
        const rel = String(u.searchParams.get("path") || "").replace(/\\/g, "/").replace(/^\/+/, "");
        const q = String(u.searchParams.get("q") || "").trim();
        const ctx = Math.min(Math.max(parseInt(u.searchParams.get("ctx") || "12", 10) || 12, 2), 60);
        let project;
        try { project = normalizeProjectId(u.searchParams.get("project")); } catch { project = DEFAULT_PROJECT; }
        const baseRoot = await getProjectRefBase(project);
        const abs = resolve(baseRoot, rel);
        if (!rel || !(abs.startsWith(baseRoot + sep) || abs === baseRoot)) {
          res.statusCode = 400; res.end(JSON.stringify({ error: "bad path" })); return;
        }
        const { readFile: rf, stat } = await import("node:fs/promises");
        const info = await stat(abs).catch(() => null);
        if (!info || !info.isFile()) { res.statusCode = 404; res.end(JSON.stringify({ error: "not a file" })); return; }
        if (info.size > 2_000_000) { res.statusCode = 413; res.end(JSON.stringify({ error: "file too large" })); return; }
        const lines = (await rf(abs, "utf8")).split("\n");
        const lang = (rel.split(".").pop() || "").toLowerCase();
        const MAX = 2000; // 閱讀器單次行數上限：防超大檔一次渲染凍結（超過＝截斷並回報）
        let anchor = null, start = 0, end = lines.length - 1; // 無 q（檔案級）＝整檔（受上限保護）
        if (q) {
          const key = q.split(/[（(]/)[0].trim(); // 標籤可能帶（）補注，取識別段
          let ai = key ? lines.findIndex((l) => l.includes(key)) : -1;
          if (ai < 0) ai = lines.findIndex((l) => l.includes(q));
          if (ai >= 0) {
            anchor = ai + 1;
            // 只顯示目標區塊：優先顯式 `// HARE-END <uuid>`，否則由標籤定位宣告行、推斷區塊尾（不再 ±ctx 展開）
            const uuid = (q.match(/HARE\s+(\w+)/) || [])[1];
            const ei = uuid ? lines.findIndex((l, i) => i > ai && l.includes(`HARE-END ${uuid}`)) : -1;
            start = ai;
            end = ei > ai ? ei : blockEndFrom(lines, ai, lang);
          }
        }
        let truncated = false;
        if (end - start + 1 > MAX) { end = start + MAX - 1; truncated = true; }
        res.end(JSON.stringify({ ok: true, path: rel, abs: abs.replace(/\\/g, "/"), lang, total: lines.length, truncated,
          start: start + 1, end: end + 1, anchor, lines: lines.slice(start, end + 1) }));
      } catch (e) {
        res.statusCode = 404; res.end(JSON.stringify({ error: String(e && e.code || e) }));
      }
      return;
    }

    // 目錄清單（資源卡資料夾選擇器）：GET /api/list-dirs?path=<rel>&project=
    // 只列子資料夾名（唯讀）、限 refBase 內；path 空＝refBase 根
    if (req.method === "GET" && url.startsWith("/api/list-dirs")) {
      res.setHeader("Content-Type", "application/json");
      try {
        const u = new URL(url, "http://x");
        const rel = String(u.searchParams.get("path") || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        let project;
        try { project = normalizeProjectId(u.searchParams.get("project")); } catch { project = DEFAULT_PROJECT; }
        const baseRoot = await getProjectRefBase(project);
        const abs = resolve(baseRoot, rel);
        if (!(abs === baseRoot || abs.startsWith(baseRoot + sep))) {
          res.statusCode = 400; res.end(JSON.stringify({ error: "bad path" })); return;
        }
        const { readdirSync } = await import("node:fs");
        const entries = readdirSync(abs, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        // files 一併回（資源卡選定資料夾自動掃描內容入清單）
        const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
        res.end(JSON.stringify({ path: rel, dirs, files }));
      } catch (e) { res.statusCode = 404; res.end(JSON.stringify({ error: String(e && e.code || e) })); }
      return;
    }

    // 系統預設開檔（檔案總管：資源卡檔案列雙擊）：POST /api/open-path
    // {path: refBase 相對路徑}——限該專案 refBase 內（穿越擋掉）、檔案必須存在；
    // 以各平台系統預設程式開啟（HARE 閱讀器落地前的過渡，見白板構想卡）。寫入級授權。
    if (req.method === "POST" && url.startsWith("/api/open-path")) {
      res.setHeader("Content-Type", "application/json");
      let project;
      try { project = normalizeProjectId(new URL(url, "http://x").searchParams.get("project")); }
      catch { project = DEFAULT_PROJECT; }
      const auth = await authorize(req, { project, need: "write" });
      if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const p = JSON.parse(body || "{}");
          const rel = String(p.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
          const baseRoot = await getProjectRefBase(project);
          const abs = resolve(baseRoot, rel);
          if (!rel || !(abs.startsWith(baseRoot + sep) || abs === baseRoot)) {
            res.statusCode = 400; res.end(JSON.stringify({ error: "bad path" })); return;
          }
          // 檔案或資料夾皆可（資料夾用檔案總管開啟）
          const { stat } = await import("node:fs/promises");
          await stat(abs).catch(() => { throw new Error("路徑不存在或不可讀"); });
          const { spawn } = await import("node:child_process");
          const cmd = process.platform === "win32"
            ? ["cmd", ["/c", "start", "", abs]]
            : process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]];
          spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      });
      return;
    }

    // 圖片資產（圖片卡，HARE 1ma55e70 assets）：板 JSON 只存 URL、
    // 二進位落 data/assets/<project>/——板檔與 localStorage 快取不被 base64 撐爆。
    // POST /api/assets?project=&name=（需 write 角色）body＝二進位 → {url}
    // GET  /api/assets/<project>/<file>（公開，沿讀取慣例）；只收點陣圖（svg 可夾腳本，拒收）。
    if (url.startsWith("/api/assets")) {
      const assetsRoot = resolve(dataDir(), "assets");
      if (req.method === "POST") {
        res.setHeader("Content-Type", "application/json");
        const project = projectOf(url);
        const auth = await authorize(req, { project, need: "write" });
        if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
        let name = "img";
        try { name = new URL(url, "http://x").searchParams.get("name") || "img"; } catch { /* 沿預設 */ }
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size <= ASSET_MAX_BYTES) chunks.push(c); });
        req.on("end", async () => {
          try {
            if (size > ASSET_MAX_BYTES) { res.statusCode = 413; res.end(JSON.stringify({ error: "檔案過大（上限 8MB）" })); return; }
            if (!size) { res.statusCode = 400; res.end(JSON.stringify({ error: "空內容" })); return; }
            // 存檔邏輯抽到 lib/assets.mjs（與 MCP attach_image 共用同一份）
            const { url: assetUrl } = await saveAsset(project, name, Buffer.concat(chunks));
            res.end(JSON.stringify({ ok: true, url: assetUrl }));
          } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
        });
        return;
      }
      if (req.method === "GET") {
        try {
          const parts = url.split("?")[0].split("/").filter(Boolean); // ["api","assets",<project>,<file>]
          const pid = normalizeProjectId(parts[2]);
          const file = decodeURIComponent(parts[3] || "");
          const base = resolve(assetsRoot, pid);
          const abs = resolve(base, file);
          if (!file || !abs.startsWith(base + sep)) { res.statusCode = 400; res.end("bad path"); return; }
          const buf = await readFile(abs);
          const fext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
          const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
          res.setHeader("Content-Type", MIME[fext] || "application/octet-stream");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // 檔名帶時戳＝內容不變
          res.end(buf);
        } catch { res.statusCode = 404; res.end("not found"); }
        return;
      }
      res.statusCode = 405; res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    // 專案清單／建立／封存 REST（前端切換器＋專案管理頁用）。
    // GET 列出專案（公開，沿讀取慣例）；POST 建立與封存需 admin 角色（dev 無 token＝恆真）。
    if (url.startsWith("/api/projects")) {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        try { res.end(JSON.stringify(await listProjects())); }
        catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
        return;
      }
      if (req.method === "POST") {
        const auth = await authorize(req, { project: DEFAULT_PROJECT, need: "admin" });
        if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
        // 子路徑：/api/projects/archive、/api/projects/unarchive（專案管理頁 − 鈕）
        const sub = url.replace(/\?.*$/, "").replace(/\/+$/, "").split("/").pop();
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const p = JSON.parse(body || "{}");
            if (!p.id) { res.statusCode = 400; res.end(JSON.stringify({ error: "缺少 id" })); return; }
            if (sub === "archive") { res.end(JSON.stringify(await archiveProject(p.id))); return; }
            if (sub === "unarchive") { res.end(JSON.stringify(await unarchiveProject(p.id))); return; }
            const created = await createProject(p.id,
              // 瀏覽器建專案與 MCP 同樣種啟動檢核（導覽頁＋G0 模板＋O1 四步）
              { title: p.title, prefix: p.prefix, swimlane: p.swimlane, template: p.template, layout: p.layout,
                onboarding: "new" },
              auth.writer || "browser");
            res.end(JSON.stringify({ ok: true, project: created }));
          } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
        });
        return;
      }
      res.statusCode = 405; res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    // 白板卡片 ↔ headless agent 對話（HARE c7a7a915 chat-routes）。
    //   GET  /api/chat/pending?project=            全專案待裁定（權限回問）清單
    //   GET  /api/chat/<card>?project=             單卡狀態＋轉錄
    //   POST /api/chat/<card>?project=  {text}     送訊息（busy＝排隊）
    //   POST /api/chat/<card>/interrupt?project=   中斷進行中的 turn
    //   POST /api/chat/permission/<id>  {allow}    裁定權限回問
    if (url.startsWith("/api/chat/")) {
      res.setHeader("Content-Type", "application/json");
      const project = projectOf(url);
      const parts = url.split("?")[0].split("/").filter(Boolean); // ["api","chat",...]
      try {
        if (req.method === "GET" && parts[2] === "pending") {
          const auth = await authorize(req, { project, need: "read" });
          if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
          res.end(JSON.stringify({ pending: await listPending(project) })); return;
        }
        if (req.method === "GET" && parts[2] === "active") {
          const auth = await authorize(req, { project, need: "read" });
          if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
          res.end(JSON.stringify({ chats: await listChats(project) })); return;
        }
        // Agent 設定：GET＝設定值＋executor 偵測＋永久白名單；POST＝寫設定/清白名單
        if (parts[2] === "settings") {
          if (req.method === "GET") {
            const auth = await authorize(req, { project, need: "read" });
            if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
            res.end(JSON.stringify(await getAgentSettings(project))); return;
          }
          if (req.method === "POST") {
            const auth = await authorize(req, { project, need: "write" });
            if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", async () => {
              try {
                const p = JSON.parse(body || "{}");
                if (p.clearWhitelist) { res.end(JSON.stringify(await clearProjWhitelist(project))); return; }
                const out = { ok: true };
                // 白名單整份覆寫（安全性頁清單編輯：儲存制）；W1-6-2 起可與
                // 設定 patch 同批（安全性頁一次儲存白名單＋核可政策＋逾時）
                if (p.whitelist) out.whitelist = (await setProjWhitelist(project, p.whitelist)).whitelist;
                const patch = {};
                if (p.executor !== undefined) patch.executor = p.executor || undefined;
                if (p.permissionTimeoutMs !== undefined) patch.permissionTimeoutMs = Number(p.permissionTimeoutMs) || undefined;
                // Bash 核可政策：strict / safe-auto / trust
                if (p.bashPolicy !== undefined) patch.bashPolicy = ["strict", "safe-auto", "trust", "all"].includes(p.bashPolicy) ? p.bashPolicy : undefined;
                if (Object.keys(patch).length || !p.whitelist) out.settings = await setProjSettings(project, patch);
                res.end(JSON.stringify(out));
              } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
            });
            return;
          }
          res.statusCode = 405; res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        // agent 帳號登入/登出：開系統終端機視窗跑互動流程（OAuth 不能 headless 代跑）
        if (req.method === "POST" && parts[2] === "agent-auth") {
          const auth = await authorize(req, { project, need: "write" });
          if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const p = JSON.parse(body || "{}");
              const r = openAuthTerminal(String(p.executor || ""), p.action === "logout" ? "logout" : "login");
              if (!r.ok) res.statusCode = 400;
              res.end(JSON.stringify(r));
            } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
          });
          return;
        }
        if (req.method === "GET" && parts[2]) {
          const auth = await authorize(req, { project, need: "read" });
          if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
          res.end(JSON.stringify(await getChat(project, decodeURIComponent(parts[2])))); return;
        }
        if (req.method === "POST") {
          // 保留字路徑不是卡片：否則 POST /api/chat/active 會掉進
          // 通用卡片處理，生出叫 active 的無主 chat 狀態）
          if (["active", "pending", "settings", "agent-auth"].includes(parts[2])) {
            res.statusCode = 405; res.end(JSON.stringify({ error: `保留路徑不可 POST：${parts[2]}` })); return;
          }
          const auth = await authorize(req, { project, need: "write" });
          if (!auth.ok) { res.statusCode = auth.status; res.end(JSON.stringify({ error: auth.error })); return; }
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", async () => {
            try {
              const p = JSON.parse(body || "{}");
              if (parts[2] === "permission" && parts[3]) {
                // scope：once（預設）/session/always——三檔核可
                const ok = await resolvePermission(project, decodeURIComponent(parts[3]), !!p.allow, p.scope || "once");
                res.end(JSON.stringify({ ok })); return;
              }
              const card = decodeURIComponent(parts[2] || "");
              if (parts[3] === "interrupt") { res.end(JSON.stringify(await interrupt(project, card))); return; }
              // spawned claude 的權限回呼要打回本服務的 /mcp——base URL 取自本次請求的 host
              if (req.headers.host) configureChat({ permissionBaseUrl: `http://${req.headers.host}` });
              res.end(JSON.stringify(await sendMessage(project, card, p.text, { writer: auth.writer || "browser" })));
            } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
          });
          return;
        }
        res.statusCode = 405; res.end(JSON.stringify({ error: "method not allowed" }));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      return;
    }

    if (!url.startsWith("/api/roadmap")) {
      if (typeof next === "function") return next();
      res.statusCode = 404; res.end(); return;
    }

    // 目標專案：?project=<id>（省略＝預設專案）。GET/PUT/SSE 皆依此隔離。
    const project = projectOf(url);

    // SSE 事件流：寫入時廣播新 rev（讀取端點，公開，不驗證）。訂閱僅收同專案的 rev 事件。
    if (req.method === "GET" && url.startsWith("/api/roadmap/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const cur = await readStore(project);
      if (cur && typeof cur.rev === "number") res.write(`data: ${JSON.stringify({ rev: cur.rev, project })}\n\n`);
      // N39 斷線補放：?after=<seq> 優先於瀏覽器自動的 Last-Event-ID（Heddle 模式）
      let after = null;
      try { after = new URL(url, "http://x").searchParams.get("after"); } catch { /* noop */ }
      if (after == null && req.headers["last-event-id"]) after = req.headers["last-event-id"];
      const handle = broadcaster.addClient(res, project, after);
      const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch { /* noop */ } }, 25000);
      req.on("close", () => { clearInterval(hb); broadcaster.removeClient(handle); });
      return;
    }

    res.setHeader("Content-Type", "application/json");
    try {
      if (req.method === "GET") {
        // 私有專案的讀取需 read 角色（非私有一律公開，沿襲今日行為）。
        const auth = await authorize(req, { project, need: "read" });
        if (!auth.ok) {
          res.statusCode = auth.status;
          res.end(JSON.stringify({ error: auth.error }));
          return;
        }
        const data = await readStore(project) || { nodes: [], edges: [], viewport: null, rev: 0 };
        // 分頁正規化（HARE pa9e5v20）：回應一律 v2 形狀（pages 陣列）——v1 檔案包成單頁；
        // 前端載入一次全專案、分頁切換純記憶體（不再整頁重載）。
        ensurePages(data);
        // 附上本專案 refs.path 的解析基準根（絕對路徑）——前端用它組 VSCode 連結，
        // 取代寫死的 repo 根（外部專案分析板的程式連結才指得對）。
        const refBase = (await getProjectRefBase(project)).split(sep).join("/");
        res.end(JSON.stringify({ pages: data.pages, meta: data.meta ?? null, rev: data.rev ?? 0, refBase }));
        return;
      }
      if (req.method === "PUT" || req.method === "POST") {
        // 寫入需 write 角色；writer 由 token 反查（防偽），無 identity 時沿用預設 browser。
        const auth = await authorize(req, { project, need: "write" });
        if (!auth.ok) {
          res.statusCode = auth.status;
          res.end(JSON.stringify({ error: auth.error }));
          return;
        }
        const writer = auth.writer || "browser";
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            // 合併寫入（多方檢視防互抹）：逐卡 upsert＋墓碑刪除——client 快照舊
            // 也抹不掉別人的並發變更；空快照無害（見 lib/merge.mjs 與其單元測試）。
            // rev 僅作協調碼遞增回傳，不再以 409 拒絕（不同卡的並發已不衝突）。
            // 分頁（HARE pa9e5v20）：parsed.page＝目標分頁 id（省略＝第一頁，舊客戶端相容）；
            // parsed.pageOps＝頁面管理（add/rename/remove），先處理再合併卡片。
            const { out } = await updateStore((data) => {
              ensurePages(data);
              for (const op of Array.isArray(parsed.pageOps) ? parsed.pageOps : []) {
                if (op?.op === "add" && op.id && !findPage(data, op.id)) {
                  data.pages.push({ id: String(op.id), name: String(op.name || op.id),
                    nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] });
                } else if (op?.op === "rename") {
                  const pg = findPage(data, op.id);
                  if (pg && op.name) pg.name = String(op.name);
                } else if (op?.op === "remove" && data.pages.length > 1) {
                  const pg = findPage(data, op.id);
                  // 預設只准刪空頁（防誤刪整板）；分頁管理窗帶 force＝
                  // 已確認連卡帶線刪除
                  if (pg && (op.force === true
                    || (pg.nodes || []).filter((n) => n.type !== "lane").length === 0)) {
                    data.pages = data.pages.filter((p) => p !== pg);
                  }
                } else if (op?.op === "move") {
                  // 分頁排序（分頁管理窗）：搬到索引 to（越界忽略）
                  const pg = findPage(data, op.id);
                  const to = Number(op.to);
                  if (pg && Number.isInteger(to) && to >= 0 && to < data.pages.length) {
                    data.pages = data.pages.filter((p) => p !== pg);
                    data.pages.splice(to, 0, pg);
                  }
                } else if (op?.op === "merge") {
                  // 分頁合併（分頁管理窗）：來源頁全部卡/線/約束搬進目標頁
                  // 「空白處」（現有內容正下方 +120），來源頁隨後移除；id 撞號＝整批拒絕（誠實不亂搬）
                  const src = findPage(data, op.id), dst = findPage(data, op.into);
                  if (src && dst && src !== dst && data.pages.length > 1) {
                    const dstIds = new Set((dst.nodes || []).map((n) => n.id));
                    const clash = (src.nodes || []).find((n) => dstIds.has(n.id));
                    if (clash) throw new Error(`合併失敗：兩頁存在相同 id 的卡片（${clash.id}）`);
                    const tops = (a) => (a || []).filter((n) => !n.parentId);
                    const dstMaxY = tops(dst.nodes).reduce((m, n) =>
                      Math.max(m, (n.position?.y || 0) + (n.height || n.measured?.height || n.data?.h || 200)), 0);
                    const srcMinY = tops(src.nodes).reduce((m, n) => Math.min(m, n.position?.y || 0), Infinity);
                    const off = Number.isFinite(srcMinY) ? dstMaxY + 120 - srcMinY : 0;
                    for (const n of tops(src.nodes)) {
                      if (n.position) n.position = { x: n.position.x, y: n.position.y + off };
                    }
                    dst.nodes = [...(dst.nodes || []), ...(src.nodes || [])];
                    dst.edges = [...(dst.edges || []), ...(src.edges || [])];
                    dst.constraints = [...(dst.constraints || []), ...(src.constraints || [])];
                    dst.deletedEdges = [...(dst.deletedEdges || []), ...(src.deletedEdges || [])];
                    if (src.tombs) {
                      dst.tombs = { nodes: { ...(dst.tombs?.nodes || {}), ...(src.tombs.nodes || {}) },
                        edges: { ...(dst.tombs?.edges || {}), ...(src.tombs.edges || {}) } };
                    }
                    data.pages = data.pages.filter((p) => p !== src);
                  }
                }
              }
              if (parsed.nodes !== undefined || parsed.edges !== undefined || parsed.viewport !== undefined
                || parsed.meta !== undefined || parsed.removedNodeIds || parsed.removedEdgeIds) {
                const pg = findPage(data, parsed.page) || data.pages[0];
                // tombs＋rev（刪除守衛）：墓碑隨頁傳入；rev＝世代檢核基準
                // （client 自報的 parsed.rev ≥ 墓碑 rev 才准把已刪卡加回）。
                const view = { nodes: pg.nodes, edges: pg.edges, viewport: pg.viewport,
                  deletedEdges: pg.deletedEdges, constraints: pg.constraints, meta: data.meta,
                  tombs: pg.tombs, rev: data.rev };
                const m = mergeBoard(view, parsed);
                pg.nodes = m.nodes; pg.edges = m.edges; pg.viewport = m.viewport;
                pg.deletedEdges = m.deletedEdges; pg.constraints = m.constraints;
                pg.tombs = m.tombs;
                data.meta = m.meta;
              }
              return null;
            }, writer, { project });
            broadcaster.broadcast(out.rev, project); // in-process 立即廣播（限本專案訂閱者）
            res.end(JSON.stringify({ ok: true, rev: out.rev }));
          } catch (e) {
            if (e instanceof RevConflictError) {
              res.statusCode = 409;
              res.end(JSON.stringify({ error: "rev_conflict", rev: e.currentRev }));
              return;
            }
            if (e instanceof EmptyWriteError) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "empty_write_rejected", message: e.message }));
              return;
            }
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  }

  return { handler };
}
