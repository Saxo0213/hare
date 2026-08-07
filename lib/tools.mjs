// HARE MCP 工具實作（共用模組）——stdio（mcp-server.mjs）與 HTTP（server.mjs 的 /mcp）
// 兩種 transport 共用同一份 TOOLS。查詢工具唯讀；寫入工具（write:true）由呼叫端 transport
// 決定是否需要 Bearer token 驗證（見 lib/auth.mjs）。
import { readStore, updateStore, DATA_PATH, dataPathFor, normalizeProjectId, DEFAULT_PROJECT,
  ensurePages, findPage, changelogPathFor } from "./store.mjs";
import { listProjects, createProject, renameProject, deleteProject, projectExists, getProjectRefBase,
  archiveProject, unarchiveProject, onboardingSeed } from "./projects.mjs";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve, dirname, sep, relative } from "node:path";
import { readyCards, blockers, downstream, detectCycles, criticalPath, isWorkCard, edgeSemantics, boardKindOf, impact, insights } from "./graph.mjs";
import { analyzeCodebase, scanInterfaces, fileTree, findAnchor } from "./analyze.mjs";
import { auditClaims, auditRealRefs, auditWorktrees } from "./audit.mjs"; // B25-1 訊號對帳層＋MA4 完工未整合
import { createSnapshot, listSnapshots, rollbackSnapshot } from "./snapshots.mjs";
import { placeCard, placeAfter, gridOf, layoutLayered, layoutCreatedBatch } from "./layout.mjs"; // 批次工具共用分層排版
import { recordTombs } from "./merge.mjs"; // 刪除守衛：刪卡/刪線登記墓碑
import { saveAsset, sniffRaster } from "./assets.mjs"; // 圖片資產儲存（與 /api/assets 共用）
import { requestPermission, cleanupCardWorktree } from "./chat.mjs"; // 權限回問橋；卡片刪除時清隔離 worktree
import { normalizeTasks, taskTexts, taskEntries, taskCount, addTask, removeTaskByText, mergeTaskTexts } from "./tasks.mjs"; // B19 任務 dict 化；M2c mergeTaskTexts
import { normalizeAccepts, acceptsOf } from "./accepts.mjs"; // 驗收項（HARE 3ac5e77b accepts）
import { getGuide, TOPIC_ORDER } from "./guide.mjs"; // 詳細指南按需載入（get_guide）
import { BUILTIN_STYLES, BUILTIN_IDS, validateCardStyle, isValidStyleId, isBuiltin,
  STYLE_BASES, DENSITIES, SHAPES, HEADERS, SURFACES, BORDERS, SHADOWS } from "./cardstyles.mjs"; // W1-3-8 卡片款式 registry（前後端共用）
import { branchName, branchExists, isGitRepo, defaultBase } from "./worktree.mjs"; // MA2 整合：卡→分支＋通用 base 偵測
import { previewIntegration } from "./integrate.mjs"; // MA2 read-only 合併分析
import { processQueue, projectScripts } from "./mergequeue.mjs"; // MA2 整合佇列＋閘門（scripts＝資料列）
import { makeResolverAgent } from "./resolver-agent.mjs"; // MA3 真 resolver agent（Layer 2）

const APP_TITLE = "HARE";

// MCP 說明分層（stdio 與 HTTP transport 共用）：
// 1. INSTRUCTIONS：能力觸發——何時必須使用 HARE。
// 2. get_guide：建圖慣例、讀取方式與工作流程，按需載入。
// 3. tool description/schema：單一工具的操作契約。
// 4. server validation：真正強制資料不變量，不依賴提示詞。
// HARE 7c2f90b4 INSTRUCTIONS
// version 與 package.json 同步（發布流程：改工具＝bump version，serverInfo 隨之）
let PKG_VERSION = "0.0.0";
try { PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || PKG_VERSION; } catch { /* 保底 */ }
export const SERVER_INFO = { name: "hare", version: PKG_VERSION };
// 每條連線固定注入，因此只描述決定性的使用時機；不混入特定專案、Git 或接卡工作流。
// 英文＝上線主線（對 client 中立）；中文對照版見 locales/zh/mcp-instructions.md。
export const INSTRUCTIONS =
  "Whenever you need to show how multiple items are sequenced, depend on, block, or affect one another, you must use HARE to create a directed relationship map.";
// repo 根＝資料檔所在目錄（roadmap-data.json 在 repo 根）
const REPO_ROOT = dirname(DATA_PATH);

/* ---------- 資料輔助 ---------- */
// 所有工具接受可選 project 參數（省略＝預設專案）；load/mutate 依此讀寫對應白板。
// 分頁視圖（專案分頁 v2，HARE pa9e5v21）：一專案一檔、分頁在檔內
// （store.mjs ensurePages/findPage）。工具拿到的是「綁定某一頁」的透明代理——
// nodes/edges/viewport/deletedEdges/constraints 讀寫落在該頁，meta/rev 落在 store；
// 工具程式碼照舊操作 data.nodes/data.edges，不需知道分頁存在。特殊鍵：
// __pages＝全部頁（跨頁找卡）、__page＝綁定頁。page 參數省略＝第一頁。
const PAGE_FIELDS = new Set(["nodes", "edges", "viewport", "deletedEdges", "constraints"]);
function pageViewOf(store, page, explicit) {
  return new Proxy(store, {
    get: (t, k) => (k === "__pages" ? t.pages : k === "__page" ? page
      : k === "__explicitPage" ? !!explicit : PAGE_FIELDS.has(k) ? page[k] : t[k]),
    set: (t, k, v) => { if (PAGE_FIELDS.has(k)) page[k] = v; else t[k] = v; return true; },
    has: (t, k) => PAGE_FIELDS.has(k) || k === "__pages" || k === "__page" || k === "__explicitPage" || k in t,
  });
}
const pageGiven = (key) => !(key === undefined || key === null || String(key).trim() === "");
function resolvePage(data, key) {
  const pages = ensurePages(data);
  if (!pageGiven(key)) return pages[0];
  const pg = findPage(data, key);
  if (!pg) throw new Error(`找不到分頁：${key}（現有：${pages.map((p) => `${p.name}(${p.id})`).join("、")}）`);
  return pg;
}
async function load(project, page) {
  const d = await readStore(project);
  const data = d && (Array.isArray(d.nodes) || Array.isArray(d.pages))
    ? d : { nodes: [], edges: [], viewport: null, rev: 0 };
  return pageViewOf(data, resolvePage(data, page), pageGiven(page));
}
// 整體資料觀（「資料依整體」）：不帶 page 的列舉/查詢工具
// 看「全專案」——逐頁跑、多頁時結果附分頁名；帶 page＝限定該頁。
const eachPage = (data) => (data.__explicitPage ? [data.__page] : (data.__pages || [data.__page]));
const pageTagOf = (data, p) =>
  (data.__explicitPage || (data.__pages || []).length <= 1 ? {} : { page: p.name });
// 卡片所屬頁（跨頁操作用）：node/edge id → 擁有它的頁物件；找不到回 null。
function pageOwning(data, id) {
  const pages = data.__pages || [];
  return pages.find((p) => (p.nodes || []).some((n) => n.id === id))
    || pages.find((p) => (p.edges || []).some((e) => e.id === id)) || null;
}
const labelOf = (n) => n?.data?.label ?? n?.data?.title ?? "";
// 封存任務：元素為 {text, t}（t＝封存時間 ISO）；相容舊資料的純字串
const doneTextOf = (d) => (typeof d === "string" ? d : d?.text ?? "");
// 唯一 id：同批多則寫入可落在同一毫秒，純 Date.now 會撞 id → 加單調序號
let idSeq = 0;
const freshId = (prefix) => `${prefix}${Date.now()}_${(idSeq += 1)}`;
// B19 任務 dict 化：儲存＝{時間戳:文字}；線上格式＝依時間戳排序後的文字陣列（agent 零破壞）
const tasksOf = (n) => {
  const arr = taskTexts(n?.data?.tasks);
  return arr.length ? arr : (n?.data?.memo ? [n.data.memo] : []);
};
// B14 Agent 認領協定：心跳門檻——認領（data.claim）超過此時間未刷新即視為 stale（陳舊），
// 可被其他 agent 接手；claim_card 只擋「不同 agent 且新鮮」的認領。單位毫秒。
const CLAIM_STALE_MS = 15 * 60 * 1000; // 15 分鐘
// claim 是否 stale：無 claim／無時戳／時戳不可解析／逾門檻 → true（＝可接手）。
function isStaleClaim(claim, now = Date.now()) {
  if (!claim || !claim.t) return true;
  const ts = Date.parse(claim.t);
  return Number.isNaN(ts) || now - ts > CLAIM_STALE_MS;
}
// claim 摘要（含 stale 旗標）；無認領者回 null。
function claimBrief(n, now = Date.now()) {
  const c = n?.data?.claim;
  if (!c || !c.agent) return null;
  return { agent: c.agent, t: c.t || null, stale: isStaleClaim(c, now) };
}
// 圖片卡資產 URL → repo 相對磁碟路徑（agent 用檔案讀取工具直接看圖）
function imageDiskPath(src) {
  const m = /^\/api\/assets\/([^/]+)\/(.+)$/.exec(String(src || ""));
  return m ? `data/assets/${m[1]}/${decodeURIComponent(m[2])}` : String(src || "");
}
// 範圍任務解析：「R{n} 說明」→ { region:n, text:說明 }（前綴＝結構指標，text＝純說明）
function parseRegionTask(t) {
  const m = /^R(\d+)[\s：:]+(.*)$/.exec(String(t || ""));
  return m ? { region: Number(m[1]), text: m[2] } : { region: null, text: String(t || "") };
}
// 圖片卡 gallery 正規化（與前端 imgGalleryOf 同義）：每張圖各自的 strokes/regions；
// legacy 卡層 regions 折入首圖。回傳 [{src,name,regions}]（strokes 對 agent 無用，略）。
function imgGallery(data) {
  if (Array.isArray(data?.gallery) && data.gallery.length) {
    return data.gallery.map((g) => ({ src: g.src, name: g.name,
      regions: Array.isArray(g.regions) ? g.regions : [] }));
  }
  return data?.src ? [{ src: data.src, name: data.label || "圖 1",
    regions: Array.isArray(data.regions) ? data.regions : [] }] : [];
}
// desc 清單截斷：list/search 等清單視圖只回前 DESC_PREVIEW 字＋「…」，
// 防整板 desc 全文灌爆回應（全專案 list_cards 可達 ~20k tokens）。
// 全文取得：get_card 點名查卡（預設就給全文），或任何工具 fields 指定 "desc"。
// 磁碟資料與瀏覽器白板不受影響——這是 MCP 回應的呈現層。
const DESC_PREVIEW = 120;
function descPreview(s) {
  const t = String(s);
  return t.length > DESC_PREVIEW ? t.slice(0, DESC_PREVIEW) + "…" : t;
}
function summarize(n) {
  const refs = n.data?.refs;
  return {
    id: n.id, num: n.data?.num || null, label: labelOf(n), type: n.type,
    status: n.data?.status || null, parentId: n.parentId || null,
    desc: n.data?.desc ? descPreview(n.data.desc) : null,
    // 驗收項：卡片對現實的映射（做完長什麼樣＋在哪看得到）；有才給，同 refs 慣例
    ...(acceptsOf(n.data).length ? { accepts: acceptsOf(n.data) } : {}),
    // 圖片卡任務：只回「未歸屬範圍框」的一般任務（範圍任務移到 regions[].tasks）
    tasks: n.type === "img"
      ? tasksOf(n).filter((t) => parseRegionTask(t).region == null)
      : tasksOf(n),
    // 路徑＋標籤：讓 agent 查任務時直接定位程式位置
    ...(Array.isArray(refs) && refs.length ? { refs } : {}),
    // 圖片卡（v2）：image＝目前顯示圖磁碟路徑（用 Read 看圖）；
    // regions＝範圍標示框（跨全圖片清單）：n＝R 編號指標、image＝所屬圖、shot＝範圍
    // 截圖檔、at＝座標比例、tasks＝該框任務說明（已剝 R 前綴）。
    ...(n.type === "img" && n.data?.src ? { image: imageDiskPath(n.data.src) } : {}),
    ...(n.type === "img" ? (() => {
      const rows = [];
      for (const g of imgGallery(n.data)) {
        for (const r of g.regions) {
          rows.push({
            n: `R${r.n}`, image: imageDiskPath(g.src), at: { x: r.x, y: r.y, w: r.w, h: r.h },
            ...(r.shot ? { shot: imageDiskPath(r.shot) } : {}),
            ...(r.result ? { result: imageDiskPath(r.result) } : {}), // set_region_result 貼回的改後畫面（後）
            tasks: tasksOf(n).map((t) => parseRegionTask(t)).filter((p) => p.region === r.n).map((p) => p.text),
          });
        }
      }
      return rows.length ? { regions: rows } : {};
    })() : {}),
  };
}
// 卡片「全量」表示：供 fields 篩選用的來源——先攤平原始 data（含 minW/minH/locked/hub/sub/
// title/scopeLabel/memo/refs 等任意鍵），再用 summarize() 覆蓋計算過的欄位（label/tasks 含
// title/memo 後備），最後補上 color/bg/position（這三者不在 data 攤平之外，明確指定才給）。
function fullCard(n) {
  // descFull＝desc 全文（summarize 的 desc 是截斷預覽）；pickFields 依情境擇一
  return { ...n.data, ...summarize(n), descFull: n.data?.desc ?? null,
    color: n.data?.color || null, bg: n.data?.bg || null, position: n.position || null };
}
// fields 未給 → 回傳精簡預設摘要（不含 data 全物件／color/bg/position，避免與 data 重複浪費 token）；
// fields 給了 → 只回傳指定欄位（可含 color/bg/position/minW 等任意 data 鍵，查無則給 null 明確告知）。
// listView（list_cards/search_cards 清單視圖）＝預設摘要再拔 refs（
// 佔 ~4.0k tokens；定位程式走 get_card 點名——一定有全量 refs——或 fields 明點 "refs"）。
function pickFields(full, fields, { fullDesc = false, listView = false } = {}) {
  if (!Array.isArray(fields) || fields.length === 0) {
    const { id, num, label, type, status, parentId, tasks, refs, image, regions, accepts } = full;
    // fullDesc（get_card 點名查卡）＝全文；清單視圖＝截斷預覽
    const desc = fullDesc ? (full.descFull ?? null) : full.desc;
    return { id, num, label, type, status, parentId, desc, tasks,
      ...(Array.isArray(accepts) && accepts.length ? { accepts } : {}),
      ...(!listView && Array.isArray(refs) && refs.length ? { refs } : {}),
      // 圖片卡：image（圖檔路徑）與 regions（範圍框＋任務）預設就給——agent 看圖對位所需
      ...(type === "img" && image ? { image } : {}),
      ...(type === "img" && Array.isArray(regions) && regions.length ? { regions } : {}) };
  }
  const out = {};
  fields.forEach((f) => {
    if (f === "desc") { out.desc = full.descFull ?? null; return; } // 明確指定 desc＝全文
    out[f] = Object.prototype.hasOwnProperty.call(full, f) ? full[f] : null;
  });
  return out;
}
const FIELDS_SCHEMA = { type: "array", items: { type: "string" },
  description: "Return only these fields (any card data key, e.g. color/bg/position). Omit = default summary." };
// 關係摘要（「讀一張卡要能快速抓到它在圖上的位置」）：
// get_card 回應層現算，不落地——線段/父子的唯一真相仍是 edges 陣列與 parentId，
// 這裡只是衍生視圖（存進卡片＝第二真相源＋指紋擾動，見量測值不入指紋的同一原則）。
// 值一律卡號（無號退標籤再退 id）＝HARE 溝通索引，agent 拿卡號可續查；空鍵省略節省 token。
// HARE 9e1a70f3 relOf
function relOf(data, n) {
  const home = pageOwning(data, n.id) || data.__page || data;
  const numOf = (id) => { const m = (home.nodes || []).find((x) => x.id === id);
    return m ? (m.data?.num || labelOf(m) || m.id) : id; };
  const up = (home.edges || []).filter((e) => e.target === n.id).map((e) => numOf(e.source));
  const down = (home.edges || []).filter((e) => e.source === n.id).map((e) => numOf(e.target));
  const kids = (home.nodes || []).filter((m) => m.parentId === n.id)
    .map((m) => m.data?.num || labelOf(m) || m.id);
  const pins = []; // pin 可跨頁引用（同 get_card_tree），全頁掃
  for (const p of eachPage(data)) (p.nodes || []).forEach((m) => {
    if (m.type === "pin" && m.data?.refCard === n.id) pins.push(m.data?.num || labelOf(m) || m.id);
  });
  const rel = { ...(up.length ? { up } : {}), ...(down.length ? { down } : {}),
    ...(n.parentId ? { parent: numOf(n.parentId) } : {}), ...(kids.length ? { kids } : {}),
    ...(pins.length ? { pins } : {}) };
  return Object.keys(rel).length ? rel : null;
}
// 以 id 或編號(num，忽略大小寫)或名稱找節點——綁定頁優先，其餘分頁後備
// （agent 以編號指卡不必先知道分頁；直接改 node 物件的操作跨頁天然正確，
//   陣列級操作〔刪卡/加線〕另以 pageOwning 落到所屬頁）。
function findNodeIn(nodesArr, key) {
  const k = String(key).trim();
  const kl = k.toLowerCase();
  const arr = nodesArr || [];
  return (
    arr.find((n) => n.id === k) ||
    arr.find((n) => (n.data?.num || "").toLowerCase() === kl) ||
    arr.find((n) => labelOf(n).toLowerCase() === kl) ||
    null
  );
}
function findNode(data, key, { allPages = false } = {}) {
  if (!key) return null;
  // 帶 page＝限定該頁；不帶＝整體資料觀（全專案找），跨頁撞編號丟錯要求指明
  // ——「先找到先贏」會靜默拿錯卡。
  // allPages＝無視 page 綁定、一律全專案找（refCard 解析用——pin 的設計
  // 目的就是跨頁引用，page 參數只決定 pin 卡落哪頁，不該限縮引用目標的搜尋範圍）。
  if ((data.__explicitPage && !allPages) || !data.__pages) return findNodeIn(data.nodes, key);
  const hits = [];
  for (const p of data.__pages) {
    const h = findNodeIn(p.nodes, key);
    if (h) hits.push({ h, p });
  }
  if (!hits.length) return null;
  if (hits.length > 1) {
    throw new Error(`「${key}」在多個分頁都存在（${hits.map((x) => x.p.name).join("、")}），`
      + (allPages ? "請改用卡片 id 指定" : "請帶 page 參數指定分頁"));
  }
  return hits[0].h;
}
// 以 id 找線段（帶 page＝限定該頁；不帶＝全專案找，邊 id 全檔唯一無歧義問題）
function findEdge(data, key) {
  if (!key) return null;
  const k = String(key).trim();
  if (data.__explicitPage || !data.__pages) return (data.edges || []).find((e) => e.id === k) || null;
  for (const p of data.__pages) {
    const h = (p.edges || []).find((e) => e.id === k);
    if (h) return h;
  }
  return null;
}
// 寫入端消毒層（借鑑 tldraw AgentHelpers：normalize coords／ensure valid edges，
// 見 docs/competitor-tldraw.md §5）。HARE 選「拒絕」而非「自動修正」——對 DAG 任務板更安全。
// 座標：呼叫端給了才查；非有限值（NaN/Infinity）＝丟錯（inputSchema 只擋型別，擋不了非有限）。
function assertFiniteCoords(x, y) {
  for (const [name, v] of [["x", x], ["y", y]]) {
    if (v !== undefined && !Number.isFinite(v)) throw new Error(`座標 ${name} 必須是有限數值（收到 ${v}）`);
  }
}
// 自環（source===target）＝1-cycle，DAG 板永遠非法 → 丟錯。
function assertNotSelfEdge(sId, tId, at = "") {
  if (sId === tId) throw new Error(`${at}線段起點與終點是同一張卡（自環）；DAG 板不允許`);
}
// 完全重複（同頁同 source→target）＝雜訊，不阻擋、回一句 hint（提醒不阻擋）。
function dupEdgeHint(pageEdges, sId, tId) {
  return (pageEdges || []).some((e) => e.source === sId && e.target === tId)
    ? `已存在 ${sId}→${tId} 的線段（重複，未阻擋）` : null;
}
// MA2 整合佇列排序：對選定卡片依「線段（source 為前置）」做拓撲排序（前置先落）。Kahn；有環＝殘餘附後不漏。
function topoOrder(data, nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map([...ids].map((id) => [id, 0]));
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const p of eachPage(data)) {
    for (const e of (p.edges || [])) {
      if (ids.has(e.source) && ids.has(e.target)) { adj.get(e.source).push(e.target); indeg.set(e.target, indeg.get(e.target) + 1); }
    }
  }
  const q = [...ids].filter((id) => indeg.get(id) === 0);
  const out = [];
  while (q.length) {
    const id = q.shift(); out.push(byId.get(id));
    for (const t of adj.get(id)) { indeg.set(t, indeg.get(t) - 1); if (indeg.get(t) === 0) q.push(t); }
  }
  for (const id of ids) if (!out.includes(byId.get(id))) out.push(byId.get(id)); // 有環的殘餘
  return out;
}
// 線段箭頭語意 → marker 組合。source→target 一律是動線方向（排版分欄依此），
// 箭頭另表關係語意：flow＝動線（箭頭在終點，預設）；inject＝注入（import/依賴
// ——被引用者注入引用者，箭頭畫在起點端、以 auto-start-reverse 指回引用者）；
// both＝雙向（呼叫類型：往返關係，兩端都有箭頭）。
// B17 板型規則資料列（HARE b0a2d717 board-type-rules）
// 板型自我宣告循生成慣例＝泳道 sub 標記（analyze 自動生成／模組介面圖／系統架構圖）。
// 每列一種板型：連線語意適用性（arrows；null＝不限制）＋提示語。只報告/提示、不阻擋。
// 加板型＝加一列（同 IFACE_LANGS 慣例；借鏡 VP standards engine，見 B17 卡）。
const laneSubHas = (p, s) => (p.nodes || []).some((n) => n.type === "lane" && String(n.data?.sub || "").includes(s));
const BOARD_TYPES = [
  { key: "iface", test: (p) => laneSubHas(p, "模組介面圖"), arrows: ["inject", "both"],
    hint: "模組介面圖慣例：線＝注入/呼叫（inject/both）——flow 表流程、此板少用" },
  { key: "system", test: (p) => laneSubHas(p, "系統架構圖"), arrows: ["both", "flow"],
    hint: "系統架構圖慣例：線＝請求-回應（both）或資料流（flow）——inject 不適用" },
  { key: "analysis", test: (p) => laneSubHas(p, "analyze 自動生成"), arrows: ["flow"],
    hint: "分析板慣例：線＝import 動線（flow）" },
  { key: "task", test: () => true, arrows: null, hint: null }, // 任務／自由板：不限制
];
const boardTypeOf = (p) => BOARD_TYPES.find((r) => r.test(p));
// arrow 由 markers 推導（儲存即 markerStart/End；start+end＝both、僅 start＝inject、否則 flow）
const arrowOf = (e) => (e.markerStart && e.markerEnd ? "both" : e.markerStart ? "inject" : "flow");
// B9 邊語意：evidence.source 由 transport 推導——browser 寫入→manual、MCP→mcp（不由呼叫端自報）。
const evidenceSourceOf = (ctx) => (/^browser/i.test(ctx?.writer || "") ? "manual" : "mcp");

function edgeMarkers(arrow, color) {
  const end = { markerEnd: { type: "arrowclosed", color } };
  const start = { markerStart: { type: "arrowclosed", color, orient: "auto-start-reverse" } };
  if (arrow === "inject") return start;
  if (arrow === "both") return { ...start, ...end };
  return end;
}
// 純函式：把 refs.path（可含反斜線、開頭斜線）相對 baseRoot 解析成絕對路徑。
// 路徑穿越防護：解析後若逸出 baseRoot（如 "../foo"）回 null；落在根內回絕對路徑。
// baseRoot 本身（rel 為空）也視為合法（等同 base）。
function resolveWithin(baseRoot, p) {
  const rel = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = resolve(baseRoot, rel);
  if (abs !== baseRoot && !abs.startsWith(baseRoot + sep)) return null; // 逸出 refBase＝拒絕
  return abs;
}
// 卡片 refs.path → 實體檔案絕對路徑，相對「該專案的 refBase」解析（每專案可設定，
// 未設＝repo 根＝今日行為）。逸出 refBase 的穿越路徑回 null。project 省略＝預設專案。
// （舊 CoTechne 的 src/cotechne/ 前綴對應已於遷移時移除。）
export async function resolveRefPath(p, project) {
  const base = await getProjectRefBase(project);
  return resolveWithin(base, p);
}
// refs 路徑正規化（路徑一律針對專案 refBase 處理，寫入當下轉換）：
// 落在 refBase 內的絕對路徑（碟符/UNC）＝存成相對路徑（正斜線）；refBase 外＝原樣保留
// （validate_cards 照樣標穿越）；開頭斜線沿既有語意視為相對。機制層保證慣例，不靠 agent 自覺。
// HARE 5c1f7e2a normalizeRefs
async function normalizeRefs(refs, project) {
  if (!Array.isArray(refs)) return refs;
  const base = await getProjectRefBase(project);
  const isAbs = (s) => /^[A-Za-z]:\//.test(s) || s.startsWith("//");
  return refs.map((r) => {
    if (!r || typeof r.path !== "string") return r;
    const p = r.path.replace(/\\/g, "/");
    if (!isAbs(p)) return p === r.path ? r : { ...r, path: p };
    const rel = relative(base, p).replace(/\\/g, "/");
    const inside = rel && !rel.startsWith("..") && !isAbs(rel);
    return { ...r, path: inside ? rel : p };
  });
}
// HARE 慣例的過程觸發：
// 寫入 refs 的當下＝agent 知道程式位置的當下——帶 uuid 的 ref 立即開檔驗證
// 「HARE <uuid>」註解是否已埋，缺的隨回應 hint 點名。路徑不存在等問題歸 validate_cards。
// HARE e3f09a4c missingMarks
async function missingMarks(refs, project) {
  const out = [];
  for (const r of (Array.isArray(refs) ? refs : [])) {
    const u = String(r?.uuid || "").trim();
    if (!u) continue;
    try {
      const abs = await resolveRefPath(r.path, project);
      if (!abs || !existsSync(abs)) continue;
      // 雙標準（改名）：HARE 為新制；BANLU 為 legacy（他專案舊錨照認，不逼遷移）
      const txt0 = readFileSync(abs, "utf8");
      if (!txt0.includes(`HARE ${u}`) && !txt0.includes(`BANLU ${u}`)) out.push({ path: r.path, uuid: u });
    } catch { /* 讀檔失敗＝略過（稽核歸 validate_cards） */ }
  }
  return out;
}
const markHint = (miss) => ({
  hint: "Embed the HARE comment at each code site (same change as the refs): "
    + miss.map((m) => `'// HARE ${m.uuid} <label>' in ${m.path}`).join("; ")
    + " (/* */ in CSS). The uuid links card and code both ways."
    + " For a block-level ref, optionally close the range with '// HARE-END <same-uuid>' after its last line.",
});
const LEGACY_KEYS = ["need", "build", "tech", "out", "file", "note"]; // 已遷移的舊欄位

// 寫入輔助：ctx = { writer, onWrite }。writer 標記變更日誌身分（"mcp"/"mcp-http"）；
// onWrite(rev) 選填——HTTP transport 用它做 in-process SSE 廣播（同進程直呼，不靠 fs.watch）。
// mutator 在 store 佇列內收到「最新」資料並就地修改（驗證失敗 throw＝不寫入）；
// 工具不可在佇列外先 load() 再寫回，否則併發呼叫互吃更新（見 store.updateStore）。
async function mutate(ctx, mutator, project) {
  // 分頁：ctx.page 由 schema 注入器從 args.page 帶入——mutator 收到綁定該頁的代理視圖
  const { out, result } = await updateStore(
    (data) => mutator(pageViewOf(data, resolvePage(data, ctx?.page), pageGiven(ctx?.page))),
    ctx?.writer || "mcp", { project });
  if (typeof ctx?.onWrite === "function") ctx.onWrite(out.rev, project);
  return { out, result };
}

// 共用：所有工具的 project 參數 schema（省略＝預設專案 default）。
// 注意：這兩個 schema 會注入全部單板工具（33 個）——描述每多一字＝tools/list 多 33 字。
const PROJECT_SCHEMA = { type: "string", description: "Project id (omit = default)." };
// 分頁語意細節放 get_guide projects（一份），各工具 schema 只留局部提示。
const PAGE_SCHEMA = { type: "string", description: "Page id or name (omit = whole-project view)." };

/* ---------- 專案入口卡（G0）萃取與過期偵測 ---------- */
// 通用慣例（任何專案適用）：入口卡＝編號 G0 的非泳道卡；desc 第一段（到第一個空行）＝專案摘要。
// 不寫死 HARE 專屬內容——G0 的語意由「編號慣例」承載，非字串比對；behind_revs 靠變更日誌算過期。
// HARE b9a2761e entry_helpers
const ENTRY_DIGEST_MAX = 300; // digest 上限字元數（chars，CJK 安全）
// 統一取「全部分頁」：代理視圖（__pages）、原始 store（pages）、單頁物件皆可通吃。
function entryPagesOf(data) {
  if (Array.isArray(data?.__pages)) return data.__pages;
  if (Array.isArray(data?.pages)) return data.pages;
  if (data?.__page) return [data.__page];
  return [data];
}
// 跨全部分頁找編號 G0 的非泳道卡；回 { node, page }，找不到回 null。
export function findEntryCard(data) {
  for (const p of entryPagesOf(data)) {
    const node = (p?.nodes || []).find((n) =>
      n.type !== "lane" && String(n.data?.num || "").trim().toUpperCase() === "G0");
    if (node) return { node, page: p };
  }
  return null;
}
// desc 第一段（到第一個空行為止）＝摘要；上限 ENTRY_DIGEST_MAX 字元（用 code point 計數＝CJK 安全），超過截斷加「…」。
export function entryDigestOf(desc) {
  const first = String(desc || "").split(/\n[ \t]*\n/)[0].trim();
  const chars = [...first]; // 展開為 code point 陣列，避免切壞 CJK／emoji
  return chars.length > ENTRY_DIGEST_MAX ? chars.slice(0, ENTRY_DIGEST_MAX).join("") + "…" : first;
}
// behind_revs＝目前 rev − 最後一次「異動該卡」的 rev（changelog 由檔尾往前掃）。
// M2a 逐卡事件化後，changelog 行帶 changed:{a,r,u,ea,er}——比對 changed.a/r/u 是否含本卡 id
// ＝精準判「這筆有無動到本卡」；bulk 行（只記數量、無 id 清單）＝可能有動，保守跳過往前找
// （不匹配）。無 changed 欄位的舊行（向後相容）退回「整行含卡 id」的原啟發式。
function entryBehindRevs(currentRev, cardId, changelogPath) {
  try {
    if (!cardId || !existsSync(changelogPath)) return null;
    const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.rev !== "number") continue; // 格式不符
      const ch = e.changed;
      if (ch && ch.bulk) continue; // bulk：可能含本卡但無清單，保守跳過往前找
      if (ch && typeof ch === "object") {
        const hit = ["a", "r", "u"].some((k) => Array.isArray(ch[k]) && ch[k].includes(cardId));
        if (hit) return Math.max(0, currentRev - e.rev);
        continue; // 有逐卡明細但不含本卡＝確定無關
      }
      if (line.includes(cardId)) return Math.max(0, currentRev - e.rev); // 舊格式後備
    }
    return null; // 掃不到
  } catch { return null; }
}
// 組入口資訊：{ num, label, page, digest, desc, behind_revs, stale }；無 G0 卡回 null。
// stale＝behind_revs>30（behind_revs 為 null 時 stale 亦為 null）。
export function entryInfo(data, project) {
  const found = findEntryCard(data);
  if (!found) return null;
  const { node, page } = found;
  const desc = node.data?.desc || "";
  const currentRev = Number(data?.rev) || 0;
  const behind_revs = entryBehindRevs(currentRev, node.id, changelogPathFor(project));
  return { num: node.data?.num || null, label: labelOf(node), page: page?.name || null,
    digest: entryDigestOf(desc), desc, behind_revs, stale: behind_revs == null ? null : behind_revs > 30 };
}
// 啟動狀態機顯示（程式判定完成）。meta.onboarding 存在且檢核卡有開放
// 任務時回 { mode, checklist:<卡num>, open:n }；n===0／meta 懸空／檢核卡被刪＝回 null（容忍，
// 視同無入職）。唯讀——不清 meta（歸零清理由 complete_task 負責）。
// HARE b6c40d19 onboarding_status
export function onboardingStatus(data) {
  const ob = data?.meta?.onboarding;
  if (!ob || !ob.card) return null;
  let node = null;
  for (const p of entryPagesOf(data)) {
    const f = (p?.nodes || []).find((n) => n.id === ob.card);
    if (f) { node = f; break; }
  }
  if (!node) return null; // 檢核卡被刪＝meta 懸空 → 視同無
  const open = tasksOf(node).length;
  if (!open) return null; // 歸零＝啟動完成 → 省略欄位
  return { mode: ob.mode || null, checklist: node.data?.num || node.id, open };
}
// complete_task 銷完檢核卡最後一條任務時順手清 meta.onboarding
// （啟動完成＝檢核卡開放任務歸零）。只在「被銷的卡＝檢核卡且已歸零」時動作，其餘不碰。
function clearOnboardingIfDone(data, node) {
  const ob = data?.meta?.onboarding;
  if (ob && ob.card === node.id && tasksOf(node).length === 0) delete data.meta.onboarding;
}
// initialize instructions＝能力觸發，不附 G0 brief 或工作流程。專案語意由 project-aware
// 首次注入承接（stdio first_call_inject 錨 82950acc；HTTP 由 get_overview.entry）。
// 函式保留供兩種 transport 共用，目前固定回傳靜態 INSTRUCTIONS。
// project 參數保留供相容，目前不使用。
export async function buildInstructions(_project) {
  return INSTRUCTIONS;
}

/* ---------- 省讀協定：get_graph 打包輔助（純函式，操作單一頁物件）---------- */
// HARE 7a3c9f21 get_graph
const GRAPH_CARD_CAP = 800; // 單頁卡數上限：超過則 text 截斷並註明（防未來巨板灌爆回應）
const idTail = (id) => `#${String(id || "").slice(-4)}`; // 無 num 卡的代稱＝id 尾碼
const graphTag = (n) => (n?.data?.num || (n ? idTail(n.id) : "?")); // 邊/outline 一律用 num，無則 id 尾碼
// 卡型過濾（與 graph.mjs build 同語意）：types 指定＝依 type 集合；省略＝工作卡（isWorkCard）。
const graphPick = (types) => (Array.isArray(types) && types.length
  ? ((set) => (n) => set.has(n.type))(new Set(types)) : isWorkCard);
const isRealNode = (n) => (n?.data?.status || "") === "real";
// desc 首行（截斷用）；code point 計數＝CJK 安全。
const firstLine = (s, max) => {
  const line = String(s || "").split(/\r?\n/)[0];
  const cp = [...line];
  return cp.length > max ? cp.slice(0, max).join("") : line;
};

// pack 視圖（地圖）：泳道標題（前置脈絡）＋容器巢狀 outline＋邊集＋ready/blocked/critical 註記。
function graphPack(p, types) {
  const nodes = p.nodes || [];
  const edges = p.edges || [];
  const cards = nodes.filter((n) => n.type !== "lane");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines = [`## ${p.name || "（未命名頁）"}`];
  if (cards.length > GRAPH_CARD_CAP) {
    lines.push(`（本頁 ${cards.length} 卡，超過 ${GRAPH_CARD_CAP} 上限——outline 僅列前 ${GRAPH_CARD_CAP} 張）`);
  }
  // 泳道標題列＝前置脈絡（無幾何歸屬判斷，見 get_graph 檔頭取捨說明；不做 lane 分組）。
  for (const l of nodes.filter((n) => n.type === "lane")) {
    const title = l.data?.title || l.data?.label || "";
    const sub = l.data?.sub ? ` — ${l.data.sub}` : "";
    if (title || sub) lines.push(`泳道：${title}${sub}`);
  }
  // 容器巢狀 outline（parentId 樹）：每卡一行 `num label [status]`，開放任務加 (T:n)。
  const byParent = new Map();
  for (const n of cards) {
    const k = n.parentId || null;
    (byParent.get(k) || byParent.set(k, []).get(k)).push(n);
  }
  let shown = 0;
  const emit = (n, depth) => {
    if (shown >= GRAPH_CARD_CAP) return;
    shown += 1;
    const t = tasksOf(n).length;
    lines.push(`${"  ".repeat(depth)}- ${graphTag(n)} ${labelOf(n) || "(無標題)"} [${n.data?.status || "note"}]`
      + (t ? ` (T:${t})` : ""));
    for (const c of byParent.get(n.id) || []) emit(c, depth + 1);
  };
  for (const n of byParent.get(null) || []) emit(n, 0);
  // 邊集：num 化（無 num 用 id 尾碼），source→target＝上游前置→下游依賴者。
  if (edges.length) {
    lines.push(`依賴: ${edges.map((e) => `${graphTag(byId.get(e.source))}→${graphTag(byId.get(e.target))}`).join(", ")}`);
  }
  // 註記（重用 graph.mjs，語意與 get_ready_cards／critical_path 一致）。
  const pg = { nodes, edges };
  const pick = graphPick(types);
  const ready = readyCards(pg, types).ready;
  if (ready.length) lines.push(`ready: ${ready.map((c) => graphTag(byId.get(c.id))).join(", ")}`);
  // blocked：入 DAG 的非 real 卡且未就緒者，附直接上游未 real 者（＝擋於誰）。
  const readyIds = new Set(ready.map((c) => c.id));
  const blocked = [];
  for (const n of cards.filter(pick)) {
    if (isRealNode(n) || readyIds.has(n.id)) continue;
    const ups = edges.filter((e) => e.target === n.id).map((e) => byId.get(e.source))
      .filter((u) => u && pick(u) && !isRealNode(u));
    blocked.push(`${graphTag(n)}(擋於 ${ups.map(graphTag).join(",") || "?"})`);
  }
  if (blocked.length) lines.push(`blocked: ${blocked.join(", ")}`);
  const cp = criticalPath(pg, types);
  if (cp.error) lines.push("critical: （存在依賴環，無法計算）");
  else if (cp.path?.length) lines.push(`critical: ${cp.path.map((c) => graphTag(byId.get(c.id))).join("→")}`);
  return lines.join("\n");
}

// steps 視圖（軌道）：Kahn 分層拓撲＝建置順序。預設只含 work 卡（isWorkCard），types 可覆蓋；
// 有環時明講哪幾張成環（未能排入的節點）、其餘照排。
function graphSteps(p, types) {
  const nodes = p.nodes || [];
  const edges = p.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pick = graphPick(types);
  let dag = nodes.filter(pick);
  const lines = [`## ${p.name || "（未命名頁）"}`];
  if (dag.length > GRAPH_CARD_CAP) {
    lines.push(`（本頁工作卡 ${dag.length} 張，超過 ${GRAPH_CARD_CAP} 上限——僅排前 ${GRAPH_CARD_CAP} 張）`);
    dag = dag.slice(0, GRAPH_CARD_CAP);
  }
  if (!dag.length) { lines.push("（無工作卡）"); return lines.join("\n"); }
  const inSet = new Set(dag.map((n) => n.id));
  const indeg = new Map(dag.map((n) => [n.id, 0]));
  const succ = new Map(dag.map((n) => [n.id, []]));
  const preds = new Map(dag.map((n) => [n.id, []]));
  for (const e of edges) {
    if (inSet.has(e.source) && inSet.has(e.target)) {
      indeg.set(e.target, indeg.get(e.target) + 1);
      succ.get(e.source).push(e.target);
      preds.get(e.target).push(e.source);
    }
  }
  const placed = new Set();
  let frontier = dag.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  let step = 1;
  while (frontier.length) {
    frontier.forEach((id) => placed.add(id));
    const items = frontier.map((id) => {
      const deps = preds.get(id).map((pid) => graphTag(byId.get(pid)));
      return `${graphTag(byId.get(id))}${deps.length ? `（依 ${deps.join("、")}）` : ""}`;
    });
    lines.push(`第 ${step} 步：${items.join("、")}${frontier.length > 1 ? "（可並行）" : ""}`);
    const next = [];
    for (const id of frontier) for (const s of succ.get(id)) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) next.push(s);
    }
    frontier = next; step += 1;
  }
  const cyclic = dag.filter((n) => !placed.has(n.id));
  if (cyclic.length) lines.push(`成環（未能排入）：${cyclic.map((n) => graphTag(n)).join("、")}`);
  return lines.join("\n");
}

// 查詢工具伺服器端截斷：省略 limit＝套預設上限，防巨板
// 一發灌爆回應；明確傳 limit 可放寬，但硬上限 MAX_QUERY_LIMIT 防呆（誤傳超大值）。
// HARE 6d1e0b7f query_limit
const MAX_QUERY_LIMIT = 5000;
const queryLimit = (limit, dflt) =>
  (Number.isFinite(limit) && limit >= 0 ? Math.min(Math.floor(limit), MAX_QUERY_LIMIT) : dflt);

/* ---------- 工具實作 ---------- */
// HARE 55cda112 TOOLS
export const TOOLS = {
  get_overview: {
    description: "Project overview: G0 entry brief, pages, lanes, card/edge counts, status/type stats, open-task counts. Call this first when project context has not been loaded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run({ project, page } = {}) {
      const data = await load(project, page);
      // 整體資料觀：不帶 page＝統計全專案（附各分頁摘要）；帶 page＝只看該頁
      const lanes = [];
      const byStatus = {}, byType = {};
      let cardCount = 0, edgeCount = 0, openTasks = 0, cardsWithTasks = 0;
      const pagesBrief = [];
      for (const p of eachPage(data)) {
        const cards = (p.nodes || []).filter((n) => n.type !== "lane");
        (p.nodes || []).filter((n) => n.type === "lane").forEach((n) => lanes.push({
          id: n.id, title: n.data?.title || "", sub: n.data?.sub || "", ...pageTagOf(data, p) }));
        cards.forEach((n) => {
          const s = n.data?.status || "(none)"; byStatus[s] = (byStatus[s] || 0) + 1;
          byType[n.type] = (byType[n.type] || 0) + 1;
          const t = tasksOf(n).length;
          if (t) { openTasks += t; cardsWithTasks += 1; }
        });
        cardCount += cards.length; edgeCount += (p.edges || []).length;
        pagesBrief.push({ id: p.id, name: p.name, cards: cards.length, edges: (p.edges || []).length });
      }
      // entry＝專案入口卡（G0）簡報＋過期標記；無 G0 卡＝null。
      const entry = entryInfo(data, project);
      // 啟動狀態機——meta.onboarding 存在且檢核卡尚有開放任務時附
      // onboarding:{mode, checklist, open}；歸零／懸空＝省略（onboardingStatus 回 null）。
      const onboarding = onboardingStatus(data);
      return { app_title: APP_TITLE, project: project || "default", data_file: dataPathFor(project), rev: data.rev || 0,
        ...(pagesBrief.length > 1 || data.__explicitPage ? { pages: pagesBrief } : {}),
        lanes, card_count: cardCount, edge_count: edgeCount,
        open_tasks: openTasks, cards_with_tasks: cardsWithTasks, byStatus, byType,
        ...(onboarding ? { onboarding } : {}), entry };
    },
  },
  // 精簡慣例按需載入：INSTRUCTIONS 只負責能力觸發，建圖原則與工作流程由此工具提供。
  // 內容單一來源 lib/guide.mjs（錨 4b8e1f07）。topic 省略＝主題索引；給 topic＝該主題準則。
  // enum＝TOPIC_ORDER（新增主題只動 guide.mjs，此處自動跟上）。
  get_guide: {
    description: "Load one concise HARE convention topic. Omit topic = one-line topic index; pass topic = its decision rules.",
    inputSchema: { type: "object", properties: {
      topic: { type: "string", enum: TOPIC_ORDER, description: "Topic to load; omit = index of all topics" },
    }, additionalProperties: false },
    async run({ topic } = {}) { return getGuide(topic); },
  },
  // ---- B10 依賴圖智慧工具（唯讀 DAG 分析；邊語意＝source 上游前置→target 下游依賴者）----
  // HARE b10da61a DAG_TOOLS
  get_ready_cards: {
    description: "List cards ready to work on (all upstream real, self not). Each carries kind (work/guide/container), open_tasks, and claim state; claimed:false = claimable only.",
    inputSchema: { type: "object", properties: {
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards: note-type with status other than note)" },
      claimed: { type: "boolean", description: "false = unclaimed or stale only (claimable); true = actively claimed only; omit = all" },
    }, additionalProperties: false },
    async run({ types, claimed, project, page } = {}) {
      const data = await load(project, page);
      const now = Date.now();
      // 整體資料觀：不帶 page＝逐頁分析合併（線不跨頁，各頁 DAG 天然獨立），結果附分頁名
      let ready = [];
      for (const p of eachPage(data)) {
        const r = readyCards({ nodes: p.nodes || [], edges: p.edges || [] }, types);
        const byId = new Map((p.nodes || []).map((n) => [n.id, n]));
        // 為每張就緒卡附上認領狀態＋訊號分類；available＝無新鮮認領（可安全接手）。
        // kind＝通用慣例（不寫死專案內容）：guide＝編號循 /^G\d+$/ 的導覽卡（G0 入口同慣例）；
        // container＝板上有其他卡 parentId 指向它（＝容器／子畫布根）；其餘＝一般工作卡。
        ready = ready.concat(r.ready.map((c) => {
          const node = byId.get(c.id);
          const claim = claimBrief(node, now);
          const kind = /^G\d+$/i.test(String(node?.data?.num || "")) ? "guide"
            : (p.nodes || []).some((m) => m.parentId === c.id) ? "container" : "work";
          return { ...c, kind, open_tasks: tasksOf(node).length, claim,
            available: !claim || claim.stale, ...pageTagOf(data, p) };
        }));
      }
      if (claimed === true) ready = ready.filter((c) => !c.available);
      else if (claimed === false) ready = ready.filter((c) => c.available);
      // 機械板 ready 告示：板為 analyze 導入（meta.onboarded）、或 ready 全為 0 開放
      // 任務時，明講「這只反映依賴就緒、不是可動工的活」——防 agent 把純結構卡當任務認領。
      const noTaskBoard = !!data.meta?.onboarded
        || (ready.length > 0 && ready.every((c) => c.open_tasks === 0));
      const notice = "board has no task-bearing cards; this list reflects dependency-readiness only, "
        + "not claimable work - read G0 / repo roadmap for real tasks";
      return { count: ready.length, ready, ...(noTaskBoard ? { notice } : {}) };
    },
  },
  get_blockers: {
    description: "A card's blockers: upstream cards not yet real, recursive. Empty = ready.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number (e.g. B14), or label" },
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards: note-type with status other than note)" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, types, project, page }) {
      // 整體資料觀：先全專案定位卡片所屬頁，再對該頁 DAG 分析（線不跨頁）
      const data = await load(project, page);
      const n = findNode(data, card);
      const home = n ? (pageOwning(data, n.id) || data.__page) : data.__page;
      const r = blockers({ nodes: home.nodes || [], edges: home.edges || [] }, card, types);
      return { ...r, ...(n ? pageTagOf(data, home) : {}) };
    },
  },
  get_downstream: {
    description: "A card's downstream impact (recursive). Optional relations/max_depth/max_cards; detail:true = scored blast radius with via-paths and reasons, sorted by score.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number, or label" },
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards: note-type with status other than note)" },
      relations: { type: "array", items: { type: "string", enum: ["prerequisite", "validates", "imports", "reference"] }, description: "Edge relations to traverse (default [prerequisite] = current behavior)" },
      max_depth: { type: "number", description: "Max BFS depth (default 6)" },
      max_cards: { type: "integer", minimum: 1, maximum: 5000, description: "Max affected cards before truncation (default 50; positive integer, cap 5000)" },
      detail: { type: "boolean", description: "true = per-card {num,label,depth,score,via,reasons} sorted by score" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, types, relations, max_depth, max_cards, detail, project, page }) {
      const data = await load(project, page);
      const n = findNode(data, card);
      const home = n ? (pageOwning(data, n.id) || data.__page) : data.__page;
      const pg = { nodes: home.nodes || [], edges: home.edges || [] };
      // 守恆：不帶任何新參數＝走舊 downstream，輸出形狀與行為完全不變。
      const usingImpact = relations !== undefined || max_depth !== undefined || max_cards !== undefined || !!detail;
      const r = usingImpact
        ? impact(pg, card, { types, relations, maxDepth: max_depth, maxCards: max_cards, detail })
        : downstream(pg, card, types);
      return { ...r, ...(n ? pageTagOf(data, home) : {}) };
    },
  },
  detect_cycles: {
    description: "Detect dependency cycles (card-number sequences). hasCycle:false = clean DAG.",
    inputSchema: { type: "object", properties: {
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards: note-type with status other than note)" },
    }, additionalProperties: false },
    async run({ types, project, page } = {}) {
      const data = await load(project, page);
      // 逐頁偵測合併（線不跨頁）；環序列附分頁名
      let cycles = [];
      for (const p of eachPage(data)) {
        const r = detectCycles({ nodes: p.nodes || [], edges: p.edges || [] }, types);
        cycles = cycles.concat((r.cycles || []).map((c) => (pageTagOf(data, p).page ? { page: p.name, cycle: c } : c)));
      }
      return { hasCycle: cycles.length > 0, count: cycles.length, cycles };
    },
  },
  critical_path: {
    description: "Critical path: longest dependency chain (by card count). Reports cycles if computation is impossible.",
    inputSchema: { type: "object", properties: {
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards: note-type with status other than note)" },
    }, additionalProperties: false },
    async run({ types, project, page } = {}) {
      const data = await load(project, page);
      // 逐頁計算取最長（線不跨頁）；多頁時附路徑所在分頁
      let best = null;
      for (const p of eachPage(data)) {
        const r = criticalPath({ nodes: p.nodes || [], edges: p.edges || [] }, types);
        if (r.error) return r; // 有環＝整體無法計算，照舊回報
        if (!best || (r.length || 0) > (best.length || 0)) best = { ...r, ...pageTagOf(data, p) };
      }
      return best || { length: 0, path: [] };
    },
  },
  // ---- 省讀協定：get_graph——一發打包整張圖，token 密度優先 ----
  // 「快速理解流程」：pack＝地圖（容器巢狀 outline＋邊集＋ready/blocked/critical 註記）；
  // steps＝軌道（Kahn 分層拓撲的建置順序）。機器欄位只留統計，主體為 markdown 打包字串。
  // lane 歸屬取捨：lib/layout.mjs 無「卡片→泳道」的幾何歸屬判斷函式（泳道僅 type:"lane"
  // 視覺框，卡片座標與泳道的落點關係未被任何現成函式解算）——故不做 lane 分組，泳道
  // 標題僅列為前置脈絡；容器巢狀（parentId）與頂層清單才是結構主體。
  // 註記重用 graph.mjs（readyCards/criticalPath/detectCycles），語意與 get_ready_cards
  // ／critical_path 一致。單頁卡數 > GRAPH_CARD_CAP 時截斷並註明（防未來巨板灌爆）。
  // 打包邏輯＝輔助函式 graphPack/graphSteps（錨 uuid 7a3c9f21，見本檔工具實作區之前）。
  get_graph: {
    description: "Understand a board in one call (token-dense): pack = structure map, steps = build order, insights = structural health check. Cheaper than a full list_cards dump.",
    inputSchema: { type: "object", properties: {
      view: { type: "string", enum: ["pack", "steps", "insights"], description: "pack = structure map (default); steps = topological build order; insights = read-only structural health (hubs/bridges/orphans/inversions/low-confidence/dangling pins)" },
      types: { type: "array", items: { type: "string" }, description: "Card types to analyze (omit = work cards, same semantics as get_ready_cards)" },
    }, additionalProperties: false },
    async run({ view, types, project, page } = {}) {
      const data = await load(project, page);
      const pages = eachPage(data);
      // insights 視圖：逐頁純程式健康檢查，唯讀只報告不改圖（錨 graph_insights）。
      // 懸空 pin 需全專案 id 集（pin 可跨頁引用），先彙整 knownIds 再逐頁算。
      if (view === "insights") {
        const knownIds = new Set();
        for (const p of pages) for (const n of (p.nodes || [])) knownIds.add(n.id);
        const results = pages.map((p) => insights({ name: p.name, nodes: p.nodes || [], edges: p.edges || [] }, { types, knownIds }));
        const stats = results.reduce((acc, r) => {
          for (const [k, v] of Object.entries(r.stats)) acc[k] = typeof v === "number" ? (acc[k] || 0) + v : v;
          return acc;
        }, {});
        // B9 P4 待裁定：跨頁彙整 questions，依 priority 重排、全專案上限 10（超過截斷註明）。
        let questions = results.flatMap((r) => r.questions || []);
        questions.sort((a, b) => a.priority - b.priority || String(a.target).localeCompare(String(b.target)));
        const questionsTotal = questions.length;
        if (questionsTotal > 10) { questions = questions.slice(0, 10); stats.questionsTruncated = true; stats.questionsTotal = questionsTotal; }
        stats.questions = questions.length;
        return { view: "insights", project: project || "default", pages: pages.length, text: results.map((r) => r.text).join("\n\n"), stats, questions };
      }
      const v = view === "steps" ? "steps" : "pack";
      const parts = pages.map((p) => (v === "steps" ? graphSteps(p, types) : graphPack(p, types)));
      return { view: v, project: project || "default", pages: pages.length, text: parts.join("\n\n") };
    },
  },
  // ---- get_changes——回訪 agent 只讀增量，不必重新入職 ----
  // 讀 changelog 中 rev>since_rev 的逐卡事件（store.mjs 的 changed:{a,r,u,ea,er}），聚合成
  // 「哪些卡 added/updated/removed、邊增減、誰寫的」。id→num/label/status 由現行板解析；
  // 已 removed 的卡板上解析不到＝以 id 尾碼標示。同卡多筆取最新事件（changelog 遞增，取最大 rev）。
  // bulk 行（>50 個 id 只記數量）無 id 清單，計入 bulk_revs＋邊數，卡層略過（誠實：無明細）。
  // HARE 4e4a08a1 get_changes
  get_changes: {
    description: "Incremental board changes since a rev: a revisiting agent reads only the delta, not a re-onboard. Per-card added/updated/removed + edge counts + writers. limit caps cards.",
    inputSchema: { type: "object", properties: {
      since_rev: { type: "number", description: "Return changes with rev > this (required)" },
      limit: { type: "number", description: "Max cards to return (default 100); on overflow returns truncated:true" },
    }, required: ["since_rev"], additionalProperties: false },
    async run({ since_rev, limit, project } = {}) {
      const since = Number(since_rev) || 0;
      const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
      const data = await readStore(project);
      if (data) ensurePages(data);
      // 現行板 id→卡（跨全部分頁）：解析卡號/標籤/狀態
      const byId = new Map();
      for (const p of entryPagesOf(data || {})) for (const n of (p?.nodes || [])) byId.set(n.id, n);
      // changelog 掃描（遞增行序）：聚合逐卡最新事件、邊增減、writers、bulk 行 rev。
      let lines = [];
      try { const clp = changelogPathFor(project); if (existsSync(clp)) lines = readFileSync(clp, "utf8").split(/\r?\n/); }
      catch { /* 無日誌＝空增量 */ }
      const cardEvents = new Map(); // id → { change, last_rev }
      const bulkRevs = [];
      const writers = new Set();
      // 邊增減記端點語意 {source,target,relation}（store.mjs ea/er 新形 {i,s,t,r}）；
      // B9-1 修正2：邊更新 eu 新形 {i,s,t,from,to} → edges.updated{source,target,from,to}。
      // 舊格式（純字串 id）與 bulk 行（只有計數）無明細＝退回計數並標 legacy。
      const edgesAdded = [], edgesRemoved = [], edgesUpdated = [];
      let legacyEdges = false, legacyAddN = 0, legacyRemN = 0, legacyUpdN = 0;
      let entries = 0, fromRev = null, toRev = null;
      const setEv = (id, change, rev) => {
        const prev = cardEvents.get(id);
        if (!prev || rev >= prev.last_rev) cardEvents.set(id, { change, last_rev: rev });
      };
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (typeof e.rev !== "number" || e.rev <= since) continue;
        entries += 1;
        fromRev = fromRev == null ? e.rev : Math.min(fromRev, e.rev);
        toRev = toRev == null ? e.rev : Math.max(toRev, e.rev);
        if (e.writer) writers.add(e.writer);
        const ch = e.changed;
        if (!ch) continue; // 舊格式（無逐卡明細）：計入 entries/writers，卡層無資料
        if (ch.bulk) {
          bulkRevs.push(e.rev);
          legacyEdges = true;
          legacyAddN += Number(ch.ea) || 0; legacyRemN += Number(ch.er) || 0; legacyUpdN += Number(ch.eu) || 0;
          continue;
        }
        (ch.a || []).forEach((id) => setEv(id, "added", e.rev));
        (ch.u || []).forEach((id) => setEv(id, "updated", e.rev));
        (ch.r || []).forEach((id) => setEv(id, "removed", e.rev));
        const collectEdge = (x, dst) => {
          if (x && typeof x === "object") dst.push({ source: x.s, target: x.t, relation: x.r });
          else { legacyEdges = true; if (dst === edgesAdded) legacyAddN += 1; else legacyRemN += 1; } // 舊純字串 id：無明細
        };
        (ch.ea || []).forEach((x) => collectEdge(x, edgesAdded));
        (ch.er || []).forEach((x) => collectEdge(x, edgesRemoved));
        // 邊更新：eu 新形 {i,s,t,from,to}；舊格式/無 from-to＝退回計數並標 legacy。
        (ch.eu || []).forEach((x) => {
          if (x && typeof x === "object" && x.from !== undefined && x.to !== undefined) {
            edgesUpdated.push({ source: x.s, target: x.t, from: x.from, to: x.to });
          } else { legacyEdges = true; legacyUpdN += 1; }
        });
      }
      // 卡片解析＋排序（last_rev 降冪）：板上有＝num/label/status；已移除＝id 尾碼。
      let cards = [...cardEvents.entries()].map(([id, ev]) => {
        const n = byId.get(id);
        if (n) return { num: n.data?.num || null, label: labelOf(n), status: n.data?.status || null,
          change: ev.change, last_rev: ev.last_rev };
        return { id: idTail(id), change: ev.change, last_rev: ev.last_rev };
      }).sort((x, y) => y.last_rev - x.last_rev);
      const truncated = cards.length > cap;
      if (truncated) cards = cards.slice(0, cap);
      // 邊明細沿用同一 limit 上限；溢出標 edges.truncated；有舊/bulk 行退回計數並標 legacy。
      const edges = { added: edgesAdded.slice(0, cap), removed: edgesRemoved.slice(0, cap), updated: edgesUpdated.slice(0, cap) };
      if (edgesAdded.length > cap || edgesRemoved.length > cap || edgesUpdated.length > cap) edges.truncated = true;
      if (legacyEdges) {
        edges.legacy = true;
        edges.added_count = edgesAdded.length + legacyAddN;
        edges.removed_count = edgesRemoved.length + legacyRemN;
        edges.updated_count = edgesUpdated.length + legacyUpdN;
      }
      return { from_rev: fromRev, to_rev: toRev, entries, writers: [...writers], cards,
        edges, bulk_revs: bulkRevs,
        ...(truncated ? { truncated: true } : {}) };
    },
  },
  // ---- B22 第三波：card_history——單卡時間線（changelog 逐行過濾）----
  // 前端 Timeline 浮窗與 agent 對帳共用：掃 changed.a/u/r 含該卡 id 的行（誰改的、何時、
  // 哪種變更），觸及該卡的邊事件（ea/er/eu 端點＝卡號或 id 尾碼）計數附上。
  // bulk 行無逐卡明細＝誠實跳過並回報 bulk_skipped；newest-first，limit 預設 30。
  // HARE b22ca4d1 card_history
  card_history: {
    description: "Single-card changelog timeline: entries that touched the card (rev/time/writer/change), newest first, with edge-event counts; bulk rows lack per-card detail (bulk_skipped).",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number (e.g. B4/W1-3), or label" },
      limit: { type: "number", description: "Max entries to return (default 30)" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, limit, project } = {}) {
      const data = await readStore(project);
      if (data) ensurePages(data);
      let node = null;
      for (const p of entryPagesOf(data || {})) { const h = findNodeIn(p?.nodes, card); if (h) { node = h; break; } }
      if (!node) throw new Error(`找不到卡片：${card}`);
      const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30;
      const id = node.id, num = node.data?.num || null, tail = idTail(id);
      let lines = [];
      try { const clp = changelogPathFor(project); if (existsSync(clp)) lines = readFileSync(clp, "utf8").split(/\r?\n/); }
      catch { /* 無日誌＝空歷史 */ }
      const touches = (x) => !!x && typeof x === "object"
        && ((num && (x.s === num || x.t === num)) || x.s === tail || x.t === tail);
      const out = []; let bulkSkipped = 0;
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const ch = e.changed; if (!ch) continue; // 舊格式行無逐卡明細＝略過
        if (ch.bulk) { bulkSkipped += 1; continue; }
        const change = (ch.a || []).includes(id) ? "added"
          : (ch.u || []).includes(id) ? "updated"
            : (ch.r || []).includes(id) ? "removed" : null;
        const ea = (ch.ea || []).filter(touches).length;
        const er = (ch.er || []).filter(touches).length;
        const eu = (ch.eu || []).filter(touches).length;
        if (!change && !ea && !er && !eu) continue;
        out.push({ rev: e.rev ?? null, t: e.t || null, writer: e.writer || null, change,
          ...(ea || er || eu ? { edges: { added: ea, removed: er, updated: eu } } : {}) });
      }
      out.reverse(); // changelog 遞增行序 → newest-first
      const truncated = out.length > cap;
      return { card: num || id, label: labelOf(node), entries: out.length, bulk_skipped: bulkSkipped,
        history: out.slice(0, cap), ...(truncated ? { truncated: true } : {}) };
    },
  },
  // ---- B21 Phase 2：resolve_anchor——HARE 錨點反查（uuid → 檔案＋行號）----
  // 卡→程式反向連結的機制層：看到 `// HARE <uuid> <label>` 或卡片 refs 的 uuid，
  // 不必知道檔案就能定位到行（前端組 vscode://file/<abs>:<line>、agent 直接讀行）。
  // 掃描邏輯在 analyze.mjs findAnchor（DEFAULT_IGNORE＋.gitignore 慣例）。
  // HARE b21a4c02 resolve_anchor
  resolve_anchor: {
    description: "Reverse-lookup a HARE anchor: uuid -> file path + line (+ end_line when a HARE-END pair exists) under the project refBase. count>1 = duplicated anchor (all matches reported).",
    inputSchema: { type: "object", properties: {
      uuid: { type: "string", description: "Anchor hex id as embedded in `// HARE <uuid> <label>`" },
    }, required: ["uuid"], additionalProperties: false },
    async run({ uuid, project } = {}) {
      // 格式：英數 4–16 位——repo 實務錨點含 leet 拼寫（55ew4tch、pa9e5v20），不限純 hex
      const id = String(uuid || "").trim();
      if (!/^[0-9a-z]{4,16}$/i.test(id)) throw new Error(`uuid 格式不對（4–16 位英數）：${uuid}`);
      const root = await getProjectRefBase(project);
      const out = findAnchor(root, id);
      return { root: root.split("\\").join("/"), ...out };
    },
  },
  // ---- B25-1 訊號對帳層：audit_signals——宣稱 vs 事實的唯讀對質 ----
  // 兩檢查（邏輯在 lib/audit.mjs）：A claim 逾時且 claim 後 changelog 零觸卡＝認領無產出；
  // B real 卡 refs 檔案在 doneTasks 標記 commit 之後又被 git 改動＝驗證宣稱可能過期。
  // 矛盾只浮出（板面健康面板／agent 讀取），永不自動改卡片狀態。
  // HARE b25a0d17 audit_signals
  audit_signals: {
    description: "Read-only claim-vs-evidence audit: stale claims with zero board writes since claim, and real cards whose refs files changed after their tagged commit. Surfaces only, never mutates.",
    inputSchema: { type: "object", properties: {
      stale_minutes: { type: "number", description: "Claim stale threshold in minutes (default 15 = claim heartbeat timeout)" },
    }, additionalProperties: false },
    async run({ stale_minutes, project } = {}) {
      const data = await readStore(project);
      if (data) ensurePages(data);
      const pages = entryPagesOf(data || {});
      let lines = [];
      try { const clp = changelogPathFor(project); if (existsSync(clp)) lines = readFileSync(clp, "utf8").split(/\r?\n/); }
      catch { /* 無日誌＝A 檢查全數視為無產出證據，仍照 claim 時間判 */ }
      const staleMs = (Number.isFinite(stale_minutes) && stale_minutes > 0 ? stale_minutes : 15) * 60000;
      const claims = auditClaims(pages, lines, { staleMs });
      const refBase = await getProjectRefBase(project);
      const refs = await auditRealRefs(pages, refBase);
      // MA4 收尾自動閉環③：完工未整合分支（chat 分支領先 main）＋MA5 同檔並行一併浮出
      const wt = await auditWorktrees(pages, refBase, normalizeProjectId(project));
      const mismatches = [...claims, ...refs.mismatches, ...wt.unintegrated, ...wt.concurrent];
      return { count: mismatches.length, mismatches,
        git_available: refs.available, skipped: refs.skipped, stale_minutes: staleMs / 60000 };
    },
  },
  // ---- B14 Agent 認領協定（輕量「誰在做哪張卡」；非拖曳執行）----
  // 資料形狀：卡片 data.claim = { agent, t: ISO }。心跳＝t；逾 CLAIM_STALE_MS 未刷新＝stale，
  // 可被別的 agent 接手。認領一律走 mutate/updateStore（寫入佇列＋變更日誌 writer 記身分）。
  // HARE b14c1a1m CLAIM_TOOLS
  claim_card: {
    write: true,
    description: "Claim a card (\"I'm working on this\"): sets data.claim={agent,t}. Rejected if another agent holds a fresh claim (<15 min); same-agent re-claim refreshes the heartbeat; stale claims can be taken over.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number (e.g. B14), or label" },
      agent: { type: "string", description: "Claiming agent's name - recorded honestly on the card and in the changelog" },
    }, required: ["card", "agent"], additionalProperties: false },
    async run({ card, agent, project }, ctx) {
      const who = String(agent || "").trim();
      if (!who) throw new Error("claim_card 必須提供 agent（認領者身分）");
      const { out, result: n } = await mutate(ctx, (data) => {
        const nd = findNode(data, card);
        if (!nd) throw new Error(`找不到卡片：${card}`);
        const cur = nd.data.claim;
        if (cur && cur.agent && cur.agent !== who && !isStaleClaim(cur)) {
          throw new Error(`卡片已被 ${cur.agent} 認領（於 ${cur.t}，心跳未逾時）；如需接手請待其心跳逾時（${CLAIM_STALE_MS / 60000} 分）或請對方 release_card`);
        }
        nd.data.claim = { agent: who, t: new Date().toISOString() };
        return nd;
      }, project);
      return { ok: true, rev: out.rev, card: n.data?.num || n.id, claim: n.data.claim };
    },
  },
  release_card: {
    write: true,
    description: "Release a card's claim (deletes data.claim) - call when done or giving up, so others can take it.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number, or label" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, project }, ctx) {
      const { out, result: n } = await mutate(ctx, (data) => {
        const nd = findNode(data, card);
        if (!nd) throw new Error(`找不到卡片：${card}`);
        delete nd.data.claim;
        return nd;
      }, project);
      return { ok: true, rev: out.rev, card: n.data?.num || n.id, released: true };
    },
  },
  list_active: {
    description: "List claimed cards: num/label/status/agent/timestamp/stale flag (heartbeat >15 min = takeable). Who is working on what, at a glance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run({ project, page } = {}) {
      const data = await load(project, page);
      const now = Date.now();
      const active = [];
      for (const p of eachPage(data)) {
        (p.nodes || []).filter((n) => n.data?.claim?.agent).forEach((n) => {
          const c = claimBrief(n, now);
          active.push({ id: n.id, num: n.data?.num || null, label: labelOf(n),
            status: n.data?.status || null, agent: c.agent, t: c.t, stale: c.stale,
            ...pageTagOf(data, p) });
        });
      }
      return { count: active.length, staleThresholdMin: CLAIM_STALE_MS / 60000, active };
    },
  },
  // 省讀瘦身：預設列＝結構定位欄位（num/label/status/type/parent/
  // open_tasks/desc_head），不再帶 120 字 desc 預覽與 tasks 全文（任務走 list_tasks；
  // desc 全文走 get_card 或 fields:["desc"]）。limit/offset 分頁截斷防巨板灌爆。
  // HARE 6d2b8e40 list_cards
  list_cards: {
    description: "List cards (filter status/type): lean rows (num/label/status/type/parent/open_tasks/desc_head), no task bodies. fields opt-in; limit/offset paginate (default 200, cap 5000).",
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Filter: real/wait/draft/block/plan/note/hub" },
      type: { type: "string", description: "Filter: note/pin/dep/res/img/lane" },
      fields: FIELDS_SCHEMA,
      limit: { type: "number", description: "Max cards to return (default 200, cap 5000)" },
      offset: { type: "number", description: "Skip this many cards first (default 0)" },
    }, additionalProperties: false },
    async run({ status, type, fields, limit, offset, project, page } = {}) {
      const data = await load(project, page);
      const full = Array.isArray(fields) && fields.length; // fields opt-in＝走全量欄位路徑
      const cards = [];
      for (const p of eachPage(data)) {
        let ns = p.nodes || [];
        if (status) ns = ns.filter((n) => n.data?.status === status);
        if (type) ns = ns.filter((n) => n.type === type);
        else ns = ns.filter((n) => n.type !== "lane");
        ns.forEach((n) => {
          // 預設瘦身列：parent＝父卡 num（無 num 退 id）；open_tasks＝開放任務數；desc_head＝desc 首行 80 字。
          const par = n.parentId ? (p.nodes || []).find((x) => x.id === n.parentId) : null;
          const row = full ? pickFields(fullCard(n), fields, { listView: true }) : {
            num: n.data?.num || null, label: labelOf(n), status: n.data?.status || null, type: n.type,
            parent: n.parentId ? (par?.data?.num || n.parentId) : null,
            open_tasks: tasksOf(n).length,
            desc_head: n.data?.desc ? firstLine(n.data.desc, 80) : null,
          };
          cards.push({ ...row, ...pageTagOf(data, p) });
        });
      }
      const total = cards.length;
      const off = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
      const lim = queryLimit(limit, 200); // 省略＝預設 200（原無上限，巨板灌爆風險）
      const sliced = cards.slice(off, off + lim);
      const res = { count: sliced.length, cards: sliced };
      if (sliced.length < total) { res.truncated = true; res.total = total; }
      return res;
    },
  },
  // 任務視圖：只回「帶開放任務的卡」——盤點待辦不必拉全板。
  // HARE 115tta5k list_tasks
  list_tasks: {
    description: "List only cards carrying open tasks: num/label/status/page + tasks (+ per-card count). The task-focused view; list_cards returns everything.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Filter: real/wait/draft/block/plan/note/hub" },
    }, additionalProperties: false },
    async run({ status, project, page } = {}) {
      const data = await load(project, page);
      const cards = [];
      let total = 0;
      for (const p of eachPage(data)) {
        for (const n of p.nodes || []) {
          if (n.type === "lane") continue;
          if (status && n.data?.status !== status) continue;
          const tasks = taskTexts(n.data?.tasks); // dict→排序文字陣列（舊陣列亦相容）
          if (!tasks.length) continue;
          total += tasks.length;
          cards.push({ num: n.data?.num || null, label: labelOf(n), status: n.data?.status || "note",
            tasks, ...pageTagOf(data, p) });
        }
      }
      return { cards: cards.length, open_tasks: total, list: cards };
    },
  },
  get_card: {
    description: "Get one card by id/number/label. Default = compact summary + rel (up/down/parent/kids/pins = neighbor card numbers); use fields for color/bg/position etc.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number (e.g. E6/N1), or label" },
      fields: FIELDS_SCHEMA,
    }, required: ["card"], additionalProperties: false },
    async run({ card, fields, project, page }) {
      const data = await load(project, page);
      const n = findNode(data, card);
      if (!n) throw new Error(`找不到卡片：${card}`);
      const out = pickFields(fullCard(n), fields, { fullDesc: true }); // 點名查卡＝desc 全文
      // 預設摘要（或明點 rel 欄位）附關係——只在點名查卡給；清單視圖不給（token）
      if (!Array.isArray(fields) || !fields.length || fields.includes("rel")) {
        const rel = relOf(data, n);
        if (rel) out.rel = rel; else if (Array.isArray(fields) && fields.includes("rel")) out.rel = null;
      }
      return out;
    },
  },
  // 以卡為根的鄰域樹（提問「你查 N5 的方式」暴露缺口：原需
  // get_card＋list_cards＋list_edges 三發自拼，遠端 agent 又讀不到資料檔）。
  // 一發回：卡片＋子卡樹（遞迴）＋碰到子樹的線段（附對端編號/名稱）＋引用它的 pin 卡。
  // HARE 97ee5d21 get_card_tree
  get_card_tree: {
    description: "A card's neighborhood in one call: the card, its child subtree (recursive, depth-limited), edges touching the subtree (with far-end num/label), and pin cards referencing it.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Root card id/number/label" },
      depth: { type: "number", description: "Subtree depth limit (default 3)" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, depth, project, page }) {
      const data = await load(project, page);
      const root = findNode(data, card);
      if (!root) throw new Error(`找不到卡片：${card}`);
      const home = pageOwning(data, root.id) || data.__page;
      const maxD = Number.isFinite(depth) ? Math.max(1, depth) : 3;
      const inTree = new Set([root.id]);
      const buildKids = (pid, d) => {
        if (d > maxD) return [];
        return (home.nodes || []).filter((m) => m.parentId === pid).map((m) => {
          inTree.add(m.id);
          return { ...summarize(m), children: buildKids(m.id, d + 1) };
        });
      };
      const children = buildKids(root.id, 1);
      const brief = (id) => { const m = (home.nodes || []).find((x) => x.id === id);
        return m ? { num: m.data?.num || null, label: labelOf(m) } : { num: null, label: id }; };
      const edges = (home.edges || []).filter((e) => inTree.has(e.source) || inTree.has(e.target))
        .map((e) => ({ from: brief(e.source), to: brief(e.target), ...(e.label ? { label: e.label } : {}) }));
      // 引用根卡的 pin（跨全頁找——pin 本就可跨頁引用）
      const pins = [];
      for (const p of eachPage(data)) {
        (p.nodes || []).filter((m) => m.type === "pin" && m.data?.refCard === root.id)
          .forEach((m) => pins.push({ num: m.data?.num || null, label: labelOf(m), ...pageTagOf(data, p) }));
      }
      return { card: summarize(root), ...(home.name ? { page: home.name } : {}),
        children, edges, ...(pins.length ? { pins } : {}) };
    },
  },
  // HARE 03351c94 search_cards
  search_cards: {
    description: "Keyword search across num/label/desc/tasks/refs/commit hashes (a commit hash finds the cards behind that change). Results omit refs. limit default 100, cap 5000.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Keyword" },
      limit: { type: "number", description: "Max cards to return (default 100, cap 5000)" },
    }, required: ["query"], additionalProperties: false },
    async run({ query, limit, project, page }) {
      const data = await load(project, page);
      const q = String(query).toLowerCase();
      // 搜尋跨全部分頁（page 給了＝只搜該頁）；多頁時結果附 page 名
      const pagesArr = page !== undefined ? [data.__page] : (data.__pages || [data.__page]);
      const hit = [];
      for (const p of pagesArr) {
        for (const n of (p.nodes || [])) {
          const hay = [n.data?.num, labelOf(n), n.data?.desc, ...tasksOf(n),
            // refs 的路徑/標籤/uuid 也可搜（以 uuid 反查程式碼標註對應卡片）
            ...(n.data?.refs || []).flatMap((r) => [r?.path, r?.label, r?.uuid]),
            // 封存任務內文與 commit 編號也可搜（任務封存＝任務紀錄，hash 反查卡片）
            ...(n.data?.doneTasks || []).flatMap((d) => [doneTextOf(d), d?.commit]),
          ].filter(Boolean).join(" ").toLowerCase();
          // 清單視圖拔 refs（與 list_cards 同裁定）：refs 仍可搜，只是不隨清單回傳
          if (hay.includes(q)) {
            const { refs, ...s } = summarize(n);
            hit.push({ ...s, ...(pagesArr.length > 1 ? { page: p.name } : {}) });
          }
        }
      }
      const total = hit.length;
      const cards = hit.slice(0, queryLimit(limit, 100)); // 省略＝預設 100
      const res = { count: cards.length, cards };
      if (cards.length < total) { res.truncated = true; res.total = total; }
      return res;
    },
  },
  // 分頁管理（MCP 缺「建分頁」工具，agent 曾被迫用 analyze
  // 種頁再清卡）。與前端 pageOps add 同語意：建空頁，撞名拒絕。
  // HARE ad9pa9e1 add_page
  add_page: {
    write: true,
    description: "Add an empty page to the project. Rejected if a page with the same name already exists.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "New page name" },
    }, required: ["name"], additionalProperties: false },
    async run({ name, project }, ctx) {
      const nm = String(name || "").trim();
      if (!nm) throw new Error("add_page 必須提供 name（分頁名）");
      // 不綁分頁視圖（ctx.page 剝除）：操作對象是 pages 陣列本身
      const id = `pg${Date.now().toString(36)}`;
      const { out } = await mutate({ ...ctx, page: undefined }, (data) => {
        const pages = data.__pages;
        if (pages.some((p) => p.id === nm || p.name === nm)) throw new Error(`分頁已存在：${nm}`);
        pages.push({ id, name: nm, nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] });
      }, project);
      return { ok: true, rev: out.rev, page: { id, name: nm } };
    },
  },
  // 刪整頁（刪測試版面複製頁時補上的對稱工具——add_page 有、
  // delete_page 缺）。整頁連卡帶線刪除＝破壞性操作：必回報刪了幾卡幾線；最後一頁不可刪。
  // HARE de1pa9e1 delete_page
  delete_page: {
    write: true,
    description: "Delete a whole page including all its cards and edges (destructive; reports counts). The last remaining page cannot be deleted.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Page id or name to delete" },
    }, required: ["name"], additionalProperties: false },
    async run({ name, project }, ctx) {
      const nm = String(name || "").trim();
      if (!nm) throw new Error("delete_page 必須提供 name（分頁 id 或名稱）");
      const { out, result } = await mutate({ ...ctx, page: undefined }, (data) => {
        const pages = data.__pages;
        const i = pages.findIndex((p) => p.id === nm || p.name === nm);
        if (i < 0) throw new Error(`找不到分頁：${nm}（現有：${pages.map((p) => p.name).join("、")}）`);
        if (pages.length === 1) throw new Error("最後一頁不可刪除");
        const [pg] = pages.splice(i, 1);
        return { removed: pg.name, cards: (pg.nodes || []).length, edges: (pg.edges || []).length };
      }, project);
      return { ok: true, rev: out.rev, ...result };
    },
  },
  // Mermaid 子集匯入（HARE 3e2ma1d0 import-mermaid）：免費 DSL 生態
  // 當外部介接口（VPasCode 路線啟發）。子集＝graph/flowchart TD|TB|LR|RL|BT、節點 A／
  // A[文字]／A(文字)、連線 A-->B／A---B／A-->|標籤|B、%% 註解。其餘語法逐行回報跳過
  //（誠實：不猜語意）。排版走 layoutLayered（各方向皆以分層橫排呈現，方向另註記）。
  import_mermaid: {
    write: true,
    description: "Import a Mermaid flowchart subset (graph TD/LR; A[label]; A-->B; A-->|lbl|B; %% comments) into a NEW page as cards + edges with layered layout. Unsupported lines are reported as skipped, never guessed.",
    inputSchema: { type: "object", properties: {
      text: { type: "string", description: "Mermaid source" },
      name: { type: "string", description: "New page name (default: Mermaid 匯入)" },
    }, required: ["text"], additionalProperties: false },
    async run({ text, name, project }, ctx) {
      const NODE = String.raw`([A-Za-z0-9_.-]+)\s*(?:\[([^\]]*)\]|\(([^()]*)\))?`;
      const edgeRe = new RegExp(`^${NODE}\\s*[-=]{2,}>?\\s*(?:\\|([^|]*)\\|\\s*)?${NODE}\\s*;?$`);
      const nodeRe = new RegExp(`^${NODE}\\s*;?$`);
      const decl = new Map(); // key -> label
      const links = [];
      const skipped = [];
      let dir = "LR";
      const noteNode = (key, br, par) => {
        const label = (br ?? par ?? "").trim() || key;
        if (!decl.has(key) || (br ?? par)) decl.set(key, label);
        return key;
      };
      for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("%%")) continue;
        const g = /^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\b/i.exec(line);
        if (g) { dir = g[1].toUpperCase(); continue; }
        const em = edgeRe.exec(line);
        if (em) {
          const s = noteNode(em[1], em[2], em[3]);
          const t = noteNode(em[5], em[6], em[7]);
          links.push({ source: s, target: t, label: (em[4] || "").trim() || null });
          continue;
        }
        const nm = nodeRe.exec(line);
        // 裸關鍵字（end/subgraph…）不是節點——落 skipped 誠實回報
        if (nm && !/^(end|subgraph|direction|classDef|class|style|click|linkStyle)$/i.test(nm[1])) {
          noteNode(nm[1], nm[2], nm[3]); continue;
        }
        skipped.push(line); // 不支援語法：誠實回報、不猜
      }
      if (!decl.size) throw new Error("解析不到任何節點（支援子集：graph TD/LR、A[標籤]、A-->B、%%註解）");
      const pageName = String(name || "").trim() || `Mermaid 匯入`;
      const runTag = Date.now().toString(36); // per-run 戳記（生成板鐵則：防跨次撞 id）
      const items = [...decl.keys()].map((k) => ({ id: k, w: 360, h: 120 }));
      const { pos } = layoutLayered(items, links, {});
      const { out, result } = await mutate({ ...ctx, page: undefined }, (data) => {
        const pages = data.__pages;
        if (pages.some((p) => p.id === pageName || p.name === pageName)) throw new Error(`分頁已存在：${pageName}`);
        const pg = { id: `pg${runTag}`, name: pageName, nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] };
        let i = 0;
        const idOf = new Map();
        for (const [k, label] of decl) {
          i += 1;
          const id = `mmd_${runTag}_${i}`;
          idOf.set(k, id);
          const p = pos.get(k) || { x: 60 + (i - 1) * 460, y: 60 };
          pg.nodes.push({ id, type: "note", position: { x: Math.round(p.x), y: Math.round(p.y) },
            data: { num: `M${i}`, label, status: "note" } });
        }
        links.forEach((l, j) => {
          pg.edges.push({ id: `mmd_e_${runTag}_${j}`, source: idOf.get(l.source), target: idOf.get(l.target),
            type: "default", style: { stroke: "#c47d0a", strokeWidth: 1.8 },
            ...edgeMarkers("flow", "#c47d0a"), ...(l.label ? { label: l.label } : {}),
            sourceHandle: "r", targetHandle: "l" });
        });
        pages.push(pg);
        return { page: pg.name, cards: pg.nodes.length, edges: pg.edges.length };
      }, project);
      return { ok: true, rev: out.rev, ...result, skipped,
        ...(dir !== "LR" ? { note: `原圖方向 ${dir}：以分層橫排（LR）呈現` } : {}) };
    },
  },
  add_card: {
    write: true,
    description: "Add a card (omit x/y = auto grid placement; after=<card> lands it downstream and auto-creates the edge after->new). Code cards need refs: file-level {path} or function-level {path,label,uuid}. See get_guide mapping/code.",
    inputSchema: { type: "object", properties: {
      label: { type: "string", description: "Card title" },
      type: { type: "string", enum: ["note", "pin", "dep", "res"], description: "Default note. pin re-enters another card in this page's flow (requires refCard); dep = external dependency; res = folder resource (listing + refs)" },
      refCard: { type: "string", description: "The card this pin re-enters (id or number). Draw the edges that continue from the pin." },
      accepts: { type: "array", description: "What done looks like: [{state,desc,anchor}]. anchor = R3 (image region) | path or path#label (code) | card number.",
        items: { type: "object", properties: { state: { type: "string" }, desc: { type: "string" }, anchor: { type: "string" } }, required: ["state", "desc"] } },
      status: { type: "string", description: "real/wait/draft/block/plan/note" },
      desc: { type: "string", description: "Details of the label. Markdown-lite." },
      cat: { type: "string", description: "Category letters (e.g. \"W\"): system assigns the next free number in that category. Preferred way to number cards." },
      num: { type: "string", description: "Explicit number (compat only; collision = error). Prefer cat. Child cards auto-inherit parentNum-N." },
      parentId: { type: "string", description: "Parent card id. Child is a part of the parent (required for chip)." },
      tasks: { type: ["array", "object"], items: { type: "string" },
        description: "Tasks: array of strings (auto-timestamped) or {ISO-timestamp: text} dict" },
      refs: { type: "array", description: "Code refs, two tiers: file-level {path} only; function-level {path,label,uuid} where label = the HARE anchor name at the code line (see get_guide code)",
        items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" }, uuid: { type: "string" } } } },
      after: { type: "string", description: "Upstream card (id/number/label): new card lands downstream of it (collision-avoided) and the edge after->new is created in the same write; same layer/parent as after. If x/y given, only the edge is created." },
      x: { type: "number" }, y: { type: "number" },
    }, required: ["label"], additionalProperties: false },
    async run({ label, type, status, desc, num, cat, parentId, tasks, refs, refCard, accepts, after, x, y, project }, ctx) {
      assertFiniteCoords(x, y); // 寫入端消毒：呼叫端給了座標就必須是有限數值
      refs = await normalizeRefs(refs, project); // 寫入前針對專案 refBase 正規化路徑
      const kind = ["note", "pin", "dep", "res"].includes(type) ? type : "note";
      if (kind === "pin" && !refCard) throw new Error("pin 型節點卡必須指定 refCard（引用的目標卡 id 或編號）");
      const { out, result } = await mutate(ctx, (data) => {
        let parentNode = parentId ? findNode(data, parentId) : null;
        if (parentId && !parentNode) throw new Error(`找不到父卡片：${parentId}`);
        // refCard 全專案解析：pin 本就設計為跨頁引用，帶 page 建卡也要找得到別頁目標
        const refNode = kind === "pin" ? findNode(data, refCard, { allPages: true }) : null;
        if (kind === "pin" && !refNode) throw new Error(`找不到 refCard 目標卡片：${refCard}`);
        // after＝上游卡（增量落點＋同寫入建線）：新卡與 after 卡同層——未給 parentId 時
        // 繼承 after 卡的父容器；兩者都給且不同層＝矛盾，拒絕（after 只支援同層落卡）。
        const afterNode = after ? findNode(data, after) : null;
        if (after && !afterNode) throw new Error(`找不到 after 卡片：${after}`);
        if (afterNode) {
          const aParent = afterNode.parentId || null;
          if (parentNode && aParent !== parentNode.id) {
            throw new Error(`after 卡與 parentId 不同層（after 卡屬 ${aParent || "頂層"}）：after 只支援同層落卡`);
          }
          if (!parentNode && aParent) parentNode = findNode(data, aParent); // 繼承＝成為 after 的兄弟卡
        }
        // 落頁：有父卡＝跟著父卡所屬頁（findNode 可能在別頁找到父卡）；再來跟 after 卡；
        // 否則綁定頁。編號補號與自動排版都以落頁為範圍（編號是頁內索引）。
        const anchor = parentNode || afterNode;
        const home = anchor ? (pageOwning(data, anchor.id) || data.__page) : data.__page;
        // 編號制度：卡號由系統自編（避免撞號），
        // 建卡只指定分類（cat）。手動 num 降級為相容參數且**撞號即拒**（全專案掃描）。
        let n = num;
        if (n) {
          const clash = (data.__pages || [data.__page]).some((p) =>
            (p.nodes || []).some((m) => (m.data?.num || "") === String(n).trim()));
          if (clash) throw new Error(`編號 ${n} 已存在（編號由系統自編：改用 cat 指定分類，或省略）`);
        }
        if (!n) {
          if (parentNode && (parentNode.data?.num || "").trim()) {
            // 子卡編號＝「父號-序號」（與前端 addCard 對齊；一律補 N 類會
            // agent 建的子卡編號不繼承父卡）：掃同父直屬子卡的 -N 尾碼補最小空號。
            const used = new Set();
            home.nodes.filter((m) => m.parentId === parentNode.id)
              .forEach((m) => { const g = /-(\d+)$/.exec(m.data?.num || ""); if (g) used.add(+g[1]); });
            let i = 1; while (used.has(i)) i += 1;
            n = `${parentNode.data.num.trim()}-${i}`;
          } else {
            // 頂層（或父卡無編號）：依 cat（省略＝N）補最小空號——掃「全專案」（編號跨分頁唯一）
            const CAT = String(cat || "N").trim().replace(/[^A-Za-z]/g, "").toUpperCase() || "N";
            const used = new Set();
            const re = new RegExp(`^${CAT}\\s*(\\d+)$`, "i");
            const scanN = (arr) => (arr || []).forEach((m) => { const g = re.exec((m.data?.num || "").trim()); if (g) used.add(+g[1]); });
            (data.__pages || [data.__page]).forEach((p) => scanN(p.nodes));
            let i = 1; while (used.has(i)) i += 1; n = `${CAT}${i}`;
          }
        }
        const id = freshId("mcp_");
        // 自動排版（skill hare-card-layout / hare-nested-architecture）：x、y 皆省略＝依
        // 格線落點（有 after→落 after 下游、碰撞讓位；頂層卡→依賴欄下一空列；子卡→兄弟卡
        // 下方堆疊），避免多卡疊在預設點；任一給了就尊重呼叫端（向後相容）。
        const bothOmitted = typeof x !== "number" && typeof y !== "number";
        const position = afterNode && bothOmitted
          ? placeAfter(home.nodes, afterNode, gridOf(data.meta), { data: { desc, tasks } })
          : placeCard({ nodes: home.nodes, edges: home.edges },
            { parentId: parentNode?.id, x, y, grid: gridOf(data.meta) }); // 格線可被專案 meta.layout 覆寫
        const nd = { id, type: kind, position,
          data: { num: n, label, ...(status ? { status } : { status: "note" }),
            ...(desc ? { desc } : {}), ...(tasks ? { tasks: normalizeTasks(tasks) } : {}), ...(refs ? { refs } : {}),
            ...(accepts && normalizeAccepts(accepts).length ? { accepts: normalizeAccepts(accepts) } : {}),
            ...(refNode ? { refCard: refNode.id } : {}) },
          ...(parentNode ? { parentId: parentNode.id, extent: "parent" } : {}) };
        home.nodes.push(nd);
        // after＝同一次寫入建線（與 add_edge 同形）：上游→新卡＝動線方向。
        // 頂層走 r→l（水平穿越欄間隙，skill §6）；容器內垂直堆疊，端點留給前端自動判side。
        let edge = null;
        if (afterNode) {
          edge = { id: freshId("mcp_e_"), source: afterNode.id, target: id, type: "default",
            style: { stroke: "#c47d0a", strokeWidth: 1.8 }, ...edgeMarkers(undefined, "#c47d0a"),
            ...(afterNode.parentId ? {} : { sourceHandle: "r", targetHandle: "l" }) };
          home.edges = home.edges || [];
          home.edges.push(edge);
        }
        return { nd, edge };
      }, project);
      const { nd: node, edge } = result;
      // 機制性 nudge：工作卡缺 refs、或 uuid 宣告了註解尚未埋，回應點名。
      const miss = refs && refs.length ? await missingMarks(refs, project) : [];
      return { ok: true, rev: out.rev, card: summarize(node),
        ...(edge ? { edge: { id: edge.id, source: edge.source, target: edge.target } } : {}),
        ...(kind === "note" && status && status !== "note" && !(refs && refs.length) ? {
          hint: "This card has no refs. Cards describing code should carry refs:[{path,label,uuid?}] (path relative to project refBase) at creation time - backfill via update_card so humans and the next agent can locate the code.",
        } : miss.length ? markHint(miss) : {}) };
    },
  },
  // 批次建卡＋拉線——一次呼叫、單一 rev，卡與線同一步落地。
  // 動機：agent 一次建 N 張卡不必 N 次呼叫；整批卡與線在同一次 mutate 完成（changelog 的 changed
  // 自然帶整批）。解析順序＝先逐卡建（依陣列序，parent/after 可引用同批 key，key 須先於引用出現）、
  // 再建 edges（可引用任一批內 key 或既有卡號/id）。任一步失敗＝mutator throw＝整批不落地（不做半套）。
  // 編號/refs 驗證沿 add_card；卡與線全部建完後才批次排版，讓完整關係決定層級。
  // cat 自動連號靠「逐張 push 後掃號」自然遞補（同批多張同 cat 不撞）。
  // HARE acdb1207 add_cards_batch
  add_cards: {
    write: true,
    description: "Batch-create cards + edges in one write (single rev), then auto-layout omitted coordinates from the complete batch graph. Existing cards and cards with x/y stay fixed. Batch keys wire parent/after/source/target (key must precede use); any error fails the whole batch. See get_guide mapping.",
    inputSchema: { type: "object", properties: {
      cards: { type: "array", minItems: 1, maxItems: 50,
        description: "1-50 cards, built in array order and auto-laid out after edges exist. Each: {key? (batch alias for wiring), label (req), desc?, status?, type? (note/dep/res), cat?, num?, parent? (key or existing card), after? (key or existing card; edge created same write), refs?, tasks?, x?, y? (either coordinate opts that card out of auto-layout)}",
        items: { type: "object", properties: {
          key: { type: "string", description: "Batch-local alias, referenced by later cards/edges" },
          label: { type: "string" }, desc: { type: "string", description: "Details of the label. Markdown-lite." }, status: { type: "string" },
          type: { type: "string", enum: ["note", "dep", "res"] },
          cat: { type: "string" }, num: { type: "string" },
          parent: { type: "string", description: "Parent key or id. Child is a part of the parent." }, after: { type: "string" },
          refs: { type: "array", items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" }, uuid: { type: "string" } } } },
          tasks: { type: ["array", "object"], items: { type: "string" } },
          x: { type: "number" }, y: { type: "number" },
        }, required: ["label"] } },
      edges: { type: "array", maxItems: 100,
        description: "0-100 edges (semantics = add_edge). Each: {source, target (key or existing card), relation?, note?, label?, inferred?}",
        items: { type: "object", properties: {
          source: { type: "string" }, target: { type: "string" },
          relation: { type: "string", enum: ["prerequisite", "reference", "imports", "validates"] },
          note: { type: "string" }, label: { type: "string" }, inferred: { type: "boolean" },
        }, required: ["source", "target"] } },
    }, required: ["cards"], additionalProperties: false },
    async run({ cards, edges, project }, ctx) {
      // 上限防呆（早退，不進 store）
      if (!Array.isArray(cards) || cards.length === 0) throw new Error("add_cards 必須提供 cards（1–50 張）");
      if (cards.length > 50) throw new Error(`cards 上限 50，收到 ${cards.length}`);
      // 寫入前針對專案 refBase 正規化各卡 refs（mutator 內不可 await，先在此處理）
      cards = await Promise.all(cards.map(async (c) =>
        (c && Array.isArray(c.refs) ? { ...c, refs: await normalizeRefs(c.refs, project) } : c)));
      const edgeList = Array.isArray(edges) ? edges : [];
      if (edgeList.length > 100) throw new Error(`edges 上限 100，收到 ${edgeList.length}`);
      const { out, result } = await mutate(ctx, (data) => {
        const grid = gridOf(data.meta);
        const keyMap = new Map();  // 批內臨時代號 → 剛建的節點物件
        const created = [];        // 回傳列 {key?, num, id, label}
        const createdIds = [];     // 批次排版範圍（只含本次建立）
        const explicitIds = [];    // 任一 x/y 明示＝人工定位，批次排版不可移動
        const allMiss = [];        // refs 帶 uuid 者彙整，稍後一次 missingMarks
        const edgeDupHints = [];   // 消毒：顯式 edges 中的重複邊（不阻擋，彙整回 hint）
        let edgeCount = 0;         // 本次建立的線總數（after 成線＋顯式 edges）
        // key 解析：先查本批 key map，再查板上 num/id（key 優先）；findNode 跨頁歧義自會拋錯。
        const resolveRef = (ref) => {
          const k = String(ref).trim();
          return keyMap.has(k) ? keyMap.get(k) : findNode(data, k);
        };
        // 逐卡建（依陣列序）——parent/after 可引用同批 key（須已定義）或既有卡號/id。
        cards.forEach((c, i) => {
          const at = `第 ${i + 1} 項`;
          const label = c?.label;
          if (typeof label !== "string" || !label.trim()) throw new Error(`${at} 缺 label`);
          assertFiniteCoords(c.x, c.y); // 寫入端消毒：座標給了就必須是有限數值
          const kind = ["note", "dep", "res"].includes(c.type) ? c.type : "note";
          // 批內 key 唯一
          const myKey = c.key != null && String(c.key).trim() !== "" ? String(c.key).trim() : null;
          if (myKey && keyMap.has(myKey)) throw new Error(`${at} key「${myKey}」重複（批內 key 須唯一）`);
          // parent / after 解析（key 優先；未定義的 key＝先引用後定義＝報錯）
          let parentNode = null;
          if (c.parent != null && String(c.parent).trim() !== "") {
            parentNode = resolveRef(c.parent);
            if (!parentNode) throw new Error(`${at} parent「${c.parent}」找不到（批內 key 須先於引用出現，或為既有卡號/id）`);
          }
          let afterNode = null;
          if (c.after != null && String(c.after).trim() !== "") {
            afterNode = resolveRef(c.after);
            if (!afterNode) throw new Error(`${at} after「${c.after}」找不到（批內 key 須先於引用出現，或為既有卡號/id）`);
          }
          // 同層規則沿 add_card：after 與 parent 不同層＝拒；未給 parent 則繼承 after 的父容器
          if (afterNode) {
            const aParent = afterNode.parentId || null;
            if (parentNode && aParent !== parentNode.id) throw new Error(`${at} after 卡與 parent 不同層：after 只支援同層落卡`);
            if (!parentNode && aParent) parentNode = findNode(data, aParent);
          }
          const anchor = parentNode || afterNode;
          const home = anchor ? (pageOwning(data, anchor.id) || data.__page) : data.__page;
          // 編號（沿 add_card）：手動 num 撞號拒（全專案掃）；否則子卡＝父號-序、頂層＝cat 補最小空號
          let n = c.num;
          if (n) {
            const clash = (data.__pages || [data.__page]).some((p) =>
              (p.nodes || []).some((m) => (m.data?.num || "") === String(n).trim()));
            if (clash) throw new Error(`${at} 編號 ${n} 已存在（改用 cat 指定分類，或省略）`);
          }
          if (!n) {
            if (parentNode && (parentNode.data?.num || "").trim()) {
              const used = new Set();
              home.nodes.filter((m) => m.parentId === parentNode.id)
                .forEach((m) => { const g = /-(\d+)$/.exec(m.data?.num || ""); if (g) used.add(+g[1]); });
              let j = 1; while (used.has(j)) j += 1;
              n = `${parentNode.data.num.trim()}-${j}`;
            } else {
              const CAT = String(c.cat || "N").trim().replace(/[^A-Za-z]/g, "").toUpperCase() || "N";
              const used = new Set();
              const re = new RegExp(`^${CAT}\\s*(\\d+)$`, "i");
              (data.__pages || [data.__page]).forEach((p) => (p.nodes || []).forEach((m) => {
                const g = re.exec((m.data?.num || "").trim()); if (g) used.add(+g[1]);
              }));
              let j = 1; while (used.has(j)) j += 1; n = `${CAT}${j}`;
            }
          }
          const id = freshId("mcp_");
          // 佈局沿 add_card：x、y 皆省略＝格線落點（有 after→落其下游、碰撞讓位）；任一給了就尊重呼叫端。
          const bothOmitted = typeof c.x !== "number" && typeof c.y !== "number";
          const position = afterNode && bothOmitted
            ? placeAfter(home.nodes, afterNode, grid, { data: { desc: c.desc, tasks: c.tasks } })
            : placeCard({ nodes: home.nodes, edges: home.edges },
              { parentId: parentNode?.id, x: c.x, y: c.y, grid });
          const nd = { id, type: kind, position,
            data: { num: n, label, status: c.status || "note",
              ...(c.desc ? { desc: c.desc } : {}), ...(c.tasks ? { tasks: normalizeTasks(c.tasks) } : {}),
              ...(c.refs ? { refs: c.refs } : {}) },
            ...(parentNode ? { parentId: parentNode.id, extent: "parent" } : {}) };
          home.nodes.push(nd);
          createdIds.push(id);
          if (!bothOmitted) explicitIds.push(id);
          // after＝同一次寫入建線（上游→新卡＝動線方向），端點慣例沿 add_card
          if (afterNode) {
            home.edges = home.edges || [];
            home.edges.push({ id: freshId("mcp_e_"), source: afterNode.id, target: id, type: "default",
              style: { stroke: "#c47d0a", strokeWidth: 1.8 }, ...edgeMarkers(undefined, "#c47d0a"),
              ...(afterNode.parentId ? {} : { sourceHandle: "r", targetHandle: "l" }) });
            edgeCount += 1;
          }
          if (myKey) keyMap.set(myKey, nd);
          if (Array.isArray(c.refs)) for (const r of c.refs) if (r && r.uuid) allMiss.push(r);
          created.push({ ...(myKey ? { key: myKey } : {}), num: n, id, label });
        });
        // edges 階段：可引用任一批內 key 或既有卡號/id（語意同 add_edge：relation/note/inferred）。
        edgeList.forEach((e, i) => {
          const at = `第 ${i + 1} 條 edge`;
          const s = resolveRef(e.source);
          if (!s) throw new Error(`${at} 的 source「${e.source}」找不到（批內 key 或既有卡號/id）`);
          const t = resolveRef(e.target);
          if (!t) throw new Error(`${at} 的 target「${e.target}」找不到（批內 key 或既有卡號/id）`);
          assertNotSelfEdge(s.id, t.id, `${at} `); // 消毒：自環（DAG 非法）
          const sp = pageOwning(data, s.id) || data.__page;
          const tp = pageOwning(data, t.id) || data.__page;
          if (sp !== tp) throw new Error(`${at} 起訖不在同一分頁（${sp?.name}／${tp?.name}），線段不可跨分頁`);
          const dh = dupEdgeHint(sp.edges, s.id, t.id); // 消毒：重複邊彙整 hint（不阻擋）
          if (dh) edgeDupHints.push(`${at}：${dh}`);
          const edgeData = e.relation ? { relation: e.relation, confidenceTier: e.inferred ? "inferred" : "asserted",
            evidence: { source: evidenceSourceOf(ctx), writer: ctx?.writer || "mcp", ...(e.note ? { note: e.note } : {}) } } : null;
          sp.edges = sp.edges || [];
          sp.edges.push({ id: freshId("mcp_e_"), source: s.id, target: t.id, type: "default",
            style: { stroke: "#c47d0a", strokeWidth: 1.8 }, ...edgeMarkers(undefined, "#c47d0a"),
            ...(e.label ? { label: e.label } : {}), ...(edgeData ? { data: edgeData } : {}) });
          edgeCount += 1;
        });
        // 所有卡與線已齊備後才排版：按 parent 座標系分組，只移動本批省略座標的卡。
        // agent 負責語意關係，座標由後端統一決定；既有卡與人工座標不被擾動。
        for (const page of (data.__pages || [data.__page])) {
          const pageIds = new Set((page.nodes || []).map((n) => n.id));
          const pageCreated = createdIds.filter((id) => pageIds.has(id));
          if (!pageCreated.length) continue;
          const batchPos = layoutCreatedBatch(
            page.nodes || [], page.edges || [], pageCreated,
            explicitIds.filter((id) => pageIds.has(id)), grid,
          );
          for (const node of page.nodes || []) {
            if (batchPos.has(node.id)) node.position = batchPos.get(node.id);
          }
        }
        return { created, edgeCount, allMiss, edgeDupHints };
      }, project);
      // refs 缺錨 hint 彙整（過程觸發，不擋）——沿 add_card 的 missingMarks
      const miss = result.allMiss.length ? await missingMarks(result.allMiss, project) : [];
      // 兩類 hint（refs 缺錨＋重複邊）併成單一 hint，避免後者覆蓋前者
      const hints = [miss.length ? markHint(miss).hint : null, ...result.edgeDupHints].filter(Boolean);
      return { ok: true, rev: out.rev, count: result.created.length, cards: result.created,
        edges: result.edgeCount, ...(hints.length ? { hint: hints.join("；") } : {}) };
    },
  },
  update_card: {
    write: true,
    description: "Update card fields by id/number/label; null deletes a key, \"\"/[] clears. Code refs are two-tier: file-level {path} or function-level {path,label,uuid}. See get_guide code.",
    inputSchema: { type: "object", properties: {
      card: { type: "string" },
      type: { type: "string", enum: ["note", "pin", "dep", "res"],
        description: "Change card type (content cards only; lane/img can't convert). pin needs refCard" },
      refCard: { type: ["string", "null"], description: "Card referenced by a pin node (id or number)" },
      label: { type: ["string", "null"] }, status: { type: ["string", "null"] },
      desc: { type: ["string", "null"], description: "Details of the label. Markdown-lite; null deletes." },
      num: { type: ["string", "null"] }, color: { type: ["string", "null"] }, bg: { type: ["string", "null"] },
      tasks: { type: ["array", "object", "null"], items: { type: "string" },
        description: "Array = text-align merge (unchanged texts keep their key, new get fresh stamps, dropped removed) or {ISO-timestamp:text} dict = raw overwrite; null deletes" },
      doneTasks: { type: ["array", "null"], items: { type: "string" },
        description: "Archived (completed) tasks; prefer complete_task over editing this directly" },
      refs: { type: ["array", "null"], description: "Code refs, two tiers: file-level {path} only; function-level {path,label,uuid}",
        items: { type: "object", properties: { path: { type: "string" }, label: { type: "string" }, uuid: { type: "string" } } } },
      listing: { type: ["array", "null"], items: { type: "string" },
        description: "Folder listing for res cards" },
      appearance: { type: ["string", "null"],
        description: "Card style id (W1-3-8): built-in or project meta.cardStyles id; null clears (follow board default). Unknown ids safely fall back at render." },
    }, required: ["card"], additionalProperties: false },
    async run({ card, project, type, ...patch }, ctx) {
      if (Array.isArray(patch.refs)) patch.refs = await normalizeRefs(patch.refs, project); // 針對專案 refBase 正規化
      const { out, result: n } = await mutate(ctx, (data) => {
        const nd = findNode(data, card);
        if (!nd) throw new Error(`找不到卡片：${card}`);
        // 啟動檢核的 task 狀態只能走 complete_task 的順序閘門；禁止 agent 用 update_card
        // 整包覆寫／清空 tasks 來繞過核可。瀏覽器勾選走板資料同步，不經此工具。
        if (data.meta?.onboarding?.card === nd.id &&
            (patch.tasks !== undefined || patch.doneTasks !== undefined)) {
          throw new Error("啟動檢核任務不可用 update_card 改寫；請依序用 complete_task，最後「使用者核可」必須由使用者在白板親自完成");
        }
        // refCard 以 id/編號/名稱引用 → 一律解析存目標卡 id，全專案觀（與 add_card 對齊；
        // W1-9 修：pin 跨頁引用，帶 page 也要找得到別頁目標）
        if (patch.refCard != null) {
          const t = findNode(data, patch.refCard, { allPages: true });
          if (!t) throw new Error(`找不到 refCard 目標卡片：${patch.refCard}`);
          patch.refCard = t.id;
        }
        // 改卡型（節點層級鍵）：只在內容卡之間轉換——lane/img 結構與資料形狀
        // 不相容（容器、圖庫），拒轉。pin 的前置條件與 add_card 相同。
        if (type !== undefined) {
          if (["lane", "img"].includes(nd.type)) throw new Error(`此卡型不可轉換：${nd.type}`);
          if (type === "pin" && !(patch.refCard || nd.data?.refCard)) throw new Error("pin 型節點卡必須有 refCard（同呼叫帶上或卡上已有）");
          nd.type = type;
        }
        // 改號撞號檢查（編號制度：卡號系統自編）：新號已被他卡占用＝拒
        if (typeof patch.num === "string" && patch.num.trim()) {
          const nn = patch.num.trim();
          const clash = (data.__pages || [data.__page]).some((p) =>
            (p.nodes || []).some((m) => m.id !== nd.id && (m.data?.num || "") === nn));
          if (clash) throw new Error(`編號 ${nn} 已存在（編號由系統自編，不可撞號）`);
        }
        const allow = ["label", "status", "desc", "num", "color", "bg", "tasks", "refs", "doneTasks", "refCard", "listing", "appearance", "accepts"];
        allow.forEach((k) => {
          if (patch[k] === undefined) return;
          if (patch[k] === null) { delete nd.data[k]; return; } // null＝刪除欄位鍵
          if (k === "tasks") {
            // M2c：陣列＝與既有任務文字對齊合併（保鍵不毀建立時間，見 tasks_merge）；
            // dict＝原樣覆蓋（agent 明確帶鍵＝自負排序，同 B19 語意）。
            nd.data.tasks = Array.isArray(patch.tasks)
              ? mergeTaskTexts(nd.data.tasks, patch.tasks)
              : normalizeTasks(patch.tasks);
            return;
          }
          if (k === "accepts") { nd.data.accepts = normalizeAccepts(patch.accepts); return; }
          nd.data[k] = patch[k];
        });
        return nd;
      }, project);
      // 寫入 refs 當下驗 HARE（過程觸發）：uuid 宣告了、註解沒埋＝回應點名
      const miss = Array.isArray(patch.refs) && patch.refs.length ? await missingMarks(patch.refs, project) : [];
      return { ok: true, rev: out.rev, card: summarize(n), ...(miss.length ? markHint(miss) : {}) };
    },
  },
  // W1-3-8 P4 卡片款式 MCP（agent 與瀏覽器走同一條 meta.cardStyles 資料路徑）。
  list_card_styles: {
    description: "List card styles: built-in (classic/compact/outlined/sticky/headerband) + project custom (meta.cardStyles). Use ids as update_card {appearance}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run({ project } = {}) {
      const data = await load(project);
      const custom = (data.meta && data.meta.cardStyles) || {};
      const builtin = Object.fromEntries(BUILTIN_IDS.map((id) => [id, { ...BUILTIN_STYLES[id], builtin: true }]));
      return { ok: true, builtinIds: BUILTIN_IDS, customIds: Object.keys(custom),
        styles: { ...builtin, ...custom } };
    },
  },
  set_card_style: {
    write: true,
    description: "Create or update a project card style (meta.cardStyles[id]). Tokens are whitelist-validated (enums + hex accent); unknown keys dropped. id: lowercase alnum/hyphen 1-40, cannot shadow a built-in.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Style id: lowercase alnum/hyphen (1-40); not a built-in id" },
      name: { type: "string", description: "Display name (1-60 chars)" },
      base: { type: "string", enum: STYLE_BASES, description: "Base preset (default classic)" },
      density: { type: "string", enum: DENSITIES, description: "Padding density (default comfortable)" },
      shape: { type: "string", enum: SHAPES, description: "Corner shape (default rounded)" },
      header: { type: "string", enum: HEADERS, description: "Header band (default plain)" },
      tokens: { type: "object", additionalProperties: false, description: "Style tokens (all optional)", properties: {
        accent: { type: "string", description: "Hex color (#rgb/#rrggbb) = top accent stripe" },
        surface: { type: "string", enum: SURFACES }, border: { type: "string", enum: BORDERS }, shadow: { type: "string", enum: SHADOWS } } },
    }, required: ["id", "name"], additionalProperties: false },
    async run({ id, project, ...style }, ctx) {
      if (!isValidStyleId(id)) throw new Error(`款式 id 格式不合（小寫英數與連字號、1–40）：${id}`);
      if (isBuiltin(id)) throw new Error(`不可覆寫內建款式 id：${id}`);
      const clean = validateCardStyle(style); // 消毒＋正規化（惡意/未知 token 丟棄）
      const { out } = await mutate(ctx, (data) => {
        data.meta = { ...(data.meta || {}), cardStyles: { ...((data.meta && data.meta.cardStyles) || {}), [id]: clean } };
        return clean;
      }, project);
      return { ok: true, rev: out.rev, id, style: clean };
    },
  },
  delete_card_style: {
    write: true,
    description: "Delete a project card style. Cards still referencing it are migrated to the board default across all pages (and unknown ids fall back safely anyway).",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Custom style id to delete" },
    }, required: ["id"], additionalProperties: false },
    async run({ id, project }, ctx) {
      const { out, result } = await mutate(ctx, (data) => {
        const cs = (data.meta && data.meta.cardStyles) || {};
        if (!cs[id]) throw new Error(`找不到自訂款式：${id}`);
        const next = { ...cs }; delete next[id];
        data.meta = { ...(data.meta || {}), cardStyles: next };
        let migrated = 0; // 清全專案引用（可選遷移；未清也靠 render 端安全退回，裁定 4）
        for (const p of (data.__pages || [data.__page])) {
          for (const nd of (p.nodes || [])) {
            if (nd.data && nd.data.appearance === id) { delete nd.data.appearance; migrated += 1; }
          }
        }
        return { migrated };
      }, project);
      return { ok: true, rev: out.rev, removed: id, migrated: result.migrated };
    },
  },
  // 視覺回饋迴圈（skill hare-ui-feedback）：agent 用 playwright 操作跑起來的畫面、
  // 截圖後把圖寫回白板——補上「MCP 能讀圖不能寫圖」的缺口（get_card 已能讀，
  // 存圖端點 /api/assets 存在但只給 HTTP，未給 MCP）。存檔重用 lib/assets.mjs。
  // HARE a77ac417 attach_image
  attach_image: {
    write: true,
    description: "Save a local raster image (png/jpg/gif/webp; e.g. a playwright screenshot) into board assets. card given = append to that image card's gallery and show it; omitted = create a new image card.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Absolute path of the local image file" },
      card: { type: "string", description: "Existing image card id/number/label (append to gallery); omit = new image card" },
      label: { type: "string", description: "Title for a new image card (default: source filename)" },
      name: { type: "string", description: "Asset filename hint (default: source filename)" },
      num: { type: "string", description: "Card number for a new card (default: next free N-number)" },
    }, required: ["path"], additionalProperties: false },
    async run({ path, card, label, name, num, project }, ctx) {
      let buf;
      try { buf = readFileSync(path); }
      catch (e) { throw new Error(`讀不到圖檔：${path}（${(e && e.code) || e}）`); }
      if (!sniffRaster(buf)) throw new Error("只收點陣圖（png/jpg/gif/webp）；svg／非圖檔拒收");
      const baseName = name || String(path).replace(/\\/g, "/").split("/").filter(Boolean).pop() || "img";
      const { url } = await saveAsset(project, baseName, buf);
      const imgName = String(baseName).replace(/\.(png|jpe?g|gif|webp)$/i, "");
      const galleryItem = { src: url, name: imgName, strokes: [], regions: [] };
      const { out, result } = await mutate(ctx, (data) => {
        if (card) {
          const nd = findNode(data, card);
          if (!nd) throw new Error(`找不到卡片：${card}`);
          if (nd.type !== "img") throw new Error(`卡片 ${card} 不是圖片卡（type:img），無法追加圖片`);
          // 既有 gallery，或 legacy 卡層（src/regions）先折成首圖再追加（與前端 imgGallery 同義）
          const gallery = Array.isArray(nd.data.gallery) && nd.data.gallery.length
            ? nd.data.gallery
            : (nd.data.src ? [{ src: nd.data.src, name: nd.data.label || "圖 1", strokes: [],
                regions: Array.isArray(nd.data.regions) ? nd.data.regions : [] }] : []);
          nd.data.gallery = [...gallery, galleryItem];
          nd.data.src = url; // 切換顯示為新圖（與前端 addImgToGallery 一致）
          delete nd.data.strokes; delete nd.data.regions; // legacy 卡層折入 gallery 後清掉
          return nd;
        }
        // 新建圖片卡（型別/資料形狀與前端 insertImageBlob 一致）
        const home = data.__page;
        let n = num;
        if (!n) {
          const used = new Set();
          const scanN = (arr) => (arr || []).forEach((m) => { const g = /^N\s*(\d+)/i.exec(m.data?.num || ""); if (g) used.add(+g[1]); });
          (data.__pages || [data.__page]).forEach((p) => scanN(p.nodes));
          let i = 1; while (used.has(i)) i += 1; n = `N${i}`;
        }
        const id = freshId("img_");
        const position = placeCard({ nodes: home.nodes, edges: home.edges }, { grid: gridOf(data.meta) });
        const nd = { id, type: "img", position,
          data: { num: n, label: label || imgName, status: "note", src: url, gallery: [galleryItem] } };
        home.nodes.push(nd);
        return nd;
      }, project);
      return { ok: true, rev: out.rev, url, image: imageDiskPath(url), card: summarize(result) };
    },
  },
  // HARE 5e701e50 set_region_result
  set_region_result: {
    write: true,
    description: "Set a screenshot as a region's result (after) image, shown beside its shot (intent/before) for user comparison. Attaching it never justifies status=real - the user judges UI correctness.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Image card id/number/label" },
      region: { type: ["string", "number"], description: "Region number from get_card (e.g. \"R1\" or 1)" },
      image: { type: "string", description: "Absolute path of the after-screenshot" },
      name: { type: "string", description: "Asset filename hint (default: source filename)" },
    }, required: ["card", "region", "image"], additionalProperties: false },
    async run({ card, region, image, name, project }, ctx) {
      const rn = Number(String(region).replace(/^R/i, ""));
      if (!Number.isInteger(rn) || rn <= 0) throw new Error(`region 需為 R 編號（如 R1），收到：${region}`);
      let buf;
      try { buf = readFileSync(image); }
      catch (e) { throw new Error(`讀不到圖檔：${image}（${(e && e.code) || e}）`); }
      if (!sniffRaster(buf)) throw new Error("只收點陣圖（png/jpg/gif/webp）；svg／非圖檔拒收");
      const baseName = name || String(image).replace(/\\/g, "/").split("/").filter(Boolean).pop() || `region-R${rn}`;
      const { url } = await saveAsset(project, baseName, buf);
      const { out, result } = await mutate(ctx, (data) => {
        const nd = findNode(data, card);
        if (!nd) throw new Error(`找不到卡片：${card}`);
        if (nd.type !== "img") throw new Error(`卡片 ${card} 不是圖片卡（type:img）`);
        // 範圍框存在每張 gallery 圖的 regions（或 legacy 卡層 regions）；R 編號跨全圖片清單連續。
        const buckets = (Array.isArray(nd.data.gallery) && nd.data.gallery.length)
          ? nd.data.gallery.map((g) => (g.regions ||= []))
          : [(nd.data.regions ||= [])];
        const target = buckets.flat().find((r) => r.n === rn);
        if (!target) throw new Error(`卡片 ${card} 找不到範圍框 R${rn}（用 get_card 查現有 R 編號）`);
        target.result = url; // 結果圖（後），與 target.shot（前）並列
        return { nd, region: target };
      }, project);
      return { ok: true, rev: out.rev, url, image: imageDiskPath(url),
        region: `R${rn}`, card: summarize(result.nd) };
    },
  },
  // HARE a17b0c93 move_card
  move_card: {
    write: true,
    description: "Move a card: reparent (into a container's sub-canvas) and/or set coords. parentId null = detach to top level (position converted to absolute, no jump). See skill hare-nested-architecture.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id/number/label" },
      parentId: { type: ["string", "null"], description: "New parent container; null = detach; omit = coords only" },
      x: { type: "number", description: "New x (relative to parent if nested; suggest >=8)" },
      y: { type: "number", description: "New y (relative to parent if nested; suggest >= parent childTop)" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, parentId, x, y, project }, ctx) {
      assertFiniteCoords(x, y); // 寫入端消毒：座標給了就必須是有限數值
      const { out, result: n } = await mutate(ctx, (data) => {
        const nd = findNode(data, card);
        if (!nd) throw new Error(`找不到卡片：${card}`);
        // 累加祖先鏈 position＝絕對座標（脫離時用，避免跳位）
        const home = pageOwning(data, nd.id) || data.__page; // 卡片所屬頁（祖先鏈/搬頁都以它為準）
        const absOf = (node) => {
          let ax = node.position?.x || 0, ay = node.position?.y || 0, p = node.parentId;
          while (p) { const pn = home.nodes.find((m) => m.id === p); if (!pn) break; ax += pn.position?.x || 0; ay += pn.position?.y || 0; p = pn.parentId; }
          return { x: ax, y: ay };
        };
        if (parentId === null) {
          if (nd.parentId) nd.position = absOf(nd); // 轉絕對
          delete nd.parentId; delete nd.extent;
        } else if (parentId !== undefined) {
          const parent = findNode(data, parentId);
          if (!parent) throw new Error(`找不到父容器：${parentId}`);
          if (parent.id === nd.id) throw new Error("卡片不能設為自己的子卡");
          const targetHome = pageOwning(data, parent.id) || data.__page;
          // 防環：新父不可是自己的後代
          let p = parent.parentId;
          while (p) { if (p === nd.id) throw new Error("不可搬入自己的子孫（會成環）"); p = targetHome.nodes.find((m) => m.id === p)?.parentId; }
          // 跨頁搬卡：新父在別的分頁 → 整棵子樹（含樹內線段）搬到目標頁；
          // 一端留在原頁的線段刪除（線段不可跨分頁）。
          if (targetHome !== home) {
            const moving = new Set([nd.id]);
            let grew = true;
            while (grew) {
              grew = false;
              home.nodes.forEach((m) => { if (m.parentId && moving.has(m.parentId) && !moving.has(m.id)) { moving.add(m.id); grew = true; } });
            }
            targetHome.nodes.push(...home.nodes.filter((m) => moving.has(m.id)));
            home.nodes = home.nodes.filter((m) => !moving.has(m.id));
            const innerEdges = (home.edges || []).filter((e) => moving.has(e.source) && moving.has(e.target));
            home.edges = (home.edges || []).filter((e) => !moving.has(e.source) && !moving.has(e.target));
            targetHome.edges = (targetHome.edges || []).concat(innerEdges);
          }
          nd.parentId = parent.id; nd.extent = "parent";
        }
        if (typeof x === "number" || typeof y === "number") {
          nd.position = { x: typeof x === "number" ? x : (nd.position?.x || 0), y: typeof y === "number" ? y : (nd.position?.y || 0) };
        }
        return nd;
      }, project);
      return { ok: true, rev: out.rev, card: { ...summarize(n), parentId: n.parentId || null, position: n.position } };
    },
  },
  // HARE f9af180e complete_task
  // B19 dict 化擴充：task 可用「ISO 時間戳鍵」點名；all:true＝全部封存/還原
  complete_task: {
    write: true,
    description: "Complete (archive) or restore task(s) on a card. task = index / keyword / ISO-timestamp key; all:true handles all tasks, except onboarding must advance one-by-one and its final user-approval item cannot be completed by an agent. Archives with a timestamp.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number (e.g. B4/W1-3), or label" },
      task: { type: ["string", "number"], description: "Task index (0-based), uniquely matching keyword, or ISO-timestamp key" },
      all: { type: "boolean", description: "true = archive/restore ALL tasks on the card (task not required)" },
      restore: { type: "boolean", description: "true = restore from archive back to tasks (default false)" },
      commit: { type: "string", description: "Optional git commit hash (backfill later with tag_commit)" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, task, all, restore, commit, project }, ctx) {
      if (!all && task === undefined) throw new Error("需要 task（索引/關鍵字/時間戳鍵）或 all:true");
      const { out, result } = await mutate(ctx, (data) => {
        const n = findNode(data, card);
        if (!n) throw new Error(`找不到卡片：${card}`);
        const stamp = new Date().toISOString();
        const isOnboarding = data.meta?.onboarding?.card === n.id;
        // 全部封存／全部還原
        if (all) {
          if (restore) {
            const done = n.data.doneTasks || [];
            for (const d of done) n.data.tasks = addTask(n.data.tasks, doneTextOf(d), (typeof d === "object" && d?.t) || undefined);
            n.data.doneTasks = [];
            return { n, t: `（全部還原 ${done.length} 條）`, batch: done.length };
          }
          if (isOnboarding) {
            throw new Error("啟動檢核不可 all:true 一次銷完；必須依序完成，最後「使用者核可」由使用者在白板親自勾選");
          }
          const entries = taskEntries(n.data.tasks);
          if (!entries.length && !n.data.memo) throw new Error("沒有可封存的任務");
          n.data.doneTasks = [...(n.data.doneTasks || []),
            ...entries.map((e) => ({ text: e.text, t: stamp, ...(commit ? { commit: String(commit) } : {}) })),
            ...(n.data.memo ? [{ text: n.data.memo, t: stamp }] : [])];
          n.data.tasks = {};
          delete n.data.memo;
          clearOnboardingIfDone(data, n); // 檢核卡歸零＝啟動完成，清 meta.onboarding
          return { n, t: `（全部封存 ${entries.length} 條）`, batch: entries.length };
        }
        const from = restore ? (n.data.doneTasks || []) : tasksOf(n);
        const listName = restore ? "doneTasks（封存）" : "tasks（待辦）";
        const textOf = restore ? doneTextOf : (t) => t;
        let idx;
        if (typeof task === "number") {
          idx = task;
          if (idx < 0 || idx >= from.length) throw new Error(`索引超出範圍：${listName} 共 ${from.length} 條`);
        } else if (!restore && /^\d{4}-\d{2}-\d{2}T/.test(task)) {
          // 時間戳鍵點名（dict 化）：直接找該鍵的排序位置
          const entries = taskEntries(n.data.tasks);
          idx = entries.findIndex((e) => e.k === task);
          if (idx < 0) throw new Error(`tasks 沒有時間戳鍵「${task}」`);
        } else {
          const hits = from.map((t, i) => [textOf(t), i]).filter(([t]) => t.includes(task));
          if (!hits.length) throw new Error(`${listName} 找不到含「${task}」的任務`);
          if (hits.length > 1) throw new Error(`「${task}」匹配到 ${hits.length} 條任務，請給更精確的關鍵字或索引`);
          idx = hits[0][1];
        }
        if (isOnboarding && !restore) {
          if (idx !== 0) throw new Error("啟動檢核必須依序完成；請先處理目前第一項");
          const selected = textOf(from[idx]);
          if (String(selected).includes("使用者核可")) {
            throw new Error("「使用者核可」不可由 agent 代銷；請停止實作並請使用者在白板親自勾選");
          }
        }
        const src = from.slice();
        const [t] = src.splice(idx, 1);
        if (restore) {
          n.data.doneTasks = src;
          // 還原回 dict：以封存時間戳當鍵（保時序）；無戳退回現在
          n.data.tasks = addTask(n.data.tasks, doneTextOf(t), (typeof t === "object" && t?.t) || undefined);
        } else {
          // dict 移除：依文字刪首筆吻合鍵；memo 情境（dict 空）＝清 memo
          if (taskCount(n.data.tasks)) n.data.tasks = removeTaskByText(n.data.tasks, (x) => x === t).dict;
          // 封存帶時間戳（封存頁顯示日期時間）＋選填 commit 編號（任務紀錄可索引）
          n.data.doneTasks = [...(n.data.doneTasks || []),
            { text: t, t: stamp, ...(commit ? { commit: String(commit) } : {}) }];
          delete n.data.memo;
        }
        clearOnboardingIfDone(data, n); // 檢核卡最後一條銷完＝啟動完成，清 meta.onboarding
        return { n, t };
      }, project);
      return { ok: true, rev: out.rev, card: result.n.data?.num || result.n.id,
        [restore ? "restored" : "completed"]: doneTextOf(result.t) || result.t,
        tasks: tasksOf(result.n), doneTasks: (result.n.data.doneTasks || []).map(doneTextOf),
        // 缺 refs 提醒（機制性 nudge：所有 agent 完成任務時都會看到）
        ...(!restore && !(result.n.data.refs || []).length ? {
          hint: "This card has no refs yet. Backfill via update_card {refs:[{path,label,uuid}]} and embed '// HARE <uuid> <label>' at the code site, so humans and the next agent can locate the code.",
        } : {}) };
    },
  },
  // 任務封存＝任務紀錄：commit 通常在銷卡之後才發生（要求才 commit），
  // 此工具讓 agent 在 commit 後把 commit 編號回填到本輪封存任務——封存項即可
  // 索引到程式變更（search_cards 搜 hash 反查卡片；git show <hash> 看 diff）。
  // 只補「尚無 commit」的封存項，不覆蓋既有紀錄。
  // HARE a37ac0de tag_commit
  tag_commit: {
    write: true,
    description: "Backfill a git commit hash into cards' archived tasks (task-complete first, commit later). Only fills entries without a commit; contains filters by text.",
    inputSchema: { type: "object", properties: {
      commit: { type: "string", description: "Commit hash (full or short)" },
      cards: { type: "array", items: { type: "string" }, description: "Card ids/numbers (e.g. [\"B4\",\"W1-3\"])" },
      contains: { type: "string", description: "Only entries whose text contains this keyword" },
    }, required: ["commit", "cards"], additionalProperties: false },
    async run({ commit, cards, contains, project, page }, ctx) {
      const { out, result } = await mutate(ctx, (data) => {
        const tagged = [];
        for (const card of cards) {
          const n = findNode(data, card);
          if (!n) throw new Error(`找不到卡片：${card}`);
          n.data.doneTasks = (n.data.doneTasks || []).map((d) => {
            const text = doneTextOf(d);
            if (contains && !text.includes(contains)) return d;
            if (typeof d !== "string" && d?.commit) return d; // 既有 commit 不覆蓋
            tagged.push(`${n.data?.num || n.id}: ${text}`);
            return typeof d === "string"
              ? { text: d, t: null, commit: String(commit) }
              : { ...d, commit: String(commit) };
          });
        }
        return { tagged };
      }, project);
      return { ok: true, rev: out.rev, commit: String(commit),
        count: result.tagged.length, tagged: result.tagged };
    },
  },
  /* ---------- B15 卡片討論串：與 tasks（待辦）/desc（說明）分離的留言頻道 ---------- */
  // 資料形狀：卡片 data.comments = [{ writer, t(ISO), text }, …]（時間序 append）。
  // writer 一律取自 transport 身分（ctx.writer；HTTP 來自 token，stdio＝"mcp"），
  // 呼叫端無法偽造——run 只解構 { card, text, project }，任何 writer 參數都被忽略。
  // HARE b15c0d3a comments
  add_comment: {
    write: true,
    description: "Append a comment {writer,t,text} to a card's discussion thread (decision context / evidence / questions - separate from tasks and desc). writer comes from the connection identity, not the caller.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number, or label" },
      text: { type: "string", description: "Comment text (non-empty)" },
    }, required: ["card", "text"], additionalProperties: false },
    async run({ card, text, project }, ctx) {
      if (typeof text !== "string" || !text.trim()) throw new Error("留言內容不可為空");
      const { out, result } = await mutate(ctx, (data) => {
        const n = findNode(data, card);
        if (!n) throw new Error(`找不到卡片：${card}`);
        // writer 取自 ctx（寫入身分），非呼叫端傳入——防偽造
        const comment = { writer: ctx?.writer || "mcp", t: new Date().toISOString(), text };
        n.data.comments = [...(Array.isArray(n.data.comments) ? n.data.comments : []), comment];
        return { n, comment };
      }, project);
      return { ok: true, rev: out.rev, card: result.n.data?.num || result.n.id,
        comment: result.comment, count: result.n.data.comments.length };
    },
  },
  list_comments: {
    description: "List a card's comment thread (oldest first): each {writer, t, text}.",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number, or label" },
    }, required: ["card"], additionalProperties: false },
    async run({ card, project, page }) {
      const data = await load(project, page);
      const n = findNode(data, card);
      if (!n) throw new Error(`找不到卡片：${card}`);
      const comments = Array.isArray(n.data?.comments) ? n.data.comments : [];
      return { card: n.data?.num || n.id, count: comments.length, comments };
    },
  },
  delete_comment: {
    write: true,
    description: "Delete one comment from a card's thread by index (0 = oldest).",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Card id, number, or label" },
      index: { type: "number", description: "Comment index (0-based)" },
    }, required: ["card", "index"], additionalProperties: false },
    async run({ card, index, project }, ctx) {
      const { out, result } = await mutate(ctx, (data) => {
        const n = findNode(data, card);
        if (!n) throw new Error(`找不到卡片：${card}`);
        const list = Array.isArray(n.data.comments) ? n.data.comments : [];
        if (typeof index !== "number" || index < 0 || index >= list.length) {
          throw new Error(`索引超出範圍：討論串共 ${list.length} 則`);
        }
        const src = list.slice();
        const [removed] = src.splice(index, 1);
        n.data.comments = src;
        return { n, removed };
      }, project);
      return { ok: true, rev: out.rev, card: result.n.data?.num || result.n.id,
        removed: result.removed, count: result.n.data.comments.length };
    },
  },
  delete_card: {
    write: true,
    description: "Delete card(s), each with its child cards and connected edges. card = single id/number/label; cards = batch (all-or-nothing: any unknown card aborts the whole batch).",
    inputSchema: { type: "object", properties: {
      card: { type: "string", description: "Single card id/number/label" },
      cards: { type: "array", items: { type: "string" }, description: "Batch: card ids/numbers/labels" },
    }, additionalProperties: false },
    async run({ card, cards, project }, ctx) {
      const keys = Array.isArray(cards) && cards.length ? cards : (card ? [card] : []);
      if (!keys.length) throw new Error("delete_card 需提供 card（單張）或 cards（批次清單）");
      const { out, result: remove } = await mutate(ctx, (data) => {
        // 先全部解析再刪（原子性：任一找不到＝整批不寫入；也避免「父卡先刪、
        // 子卡點名就找不到」的順序問題——批次裡指到已連坐刪除的卡直接略過）
        const targets = keys.map((key) => {
          const n = findNode(data, key);
          if (!n) throw new Error(`找不到卡片：${key}`);
          if (data.meta?.onboarding?.card === n.id) {
            throw new Error("啟動檢核進行中，不可刪除檢核卡；完成最後的使用者核可後再處理");
          }
          return n;
        });
        const removed = new Set();
        for (const n of targets) {
          if (removed.has(n.id)) continue; // 已隨父卡連坐刪除
          // 跨頁正確性：陣列級刪除落在「卡片所屬頁」（findNode 可能在別頁找到）
          const home = pageOwning(data, n.id) || data.__page;
          const rm = new Set([n.id, ...home.nodes.filter((m) => m.parentId === n.id).map((m) => m.id)]);
          const rmEdges = (home.edges || []).filter((e) => rm.has(e.source) || rm.has(e.target)).map((e) => e.id);
          home.nodes = home.nodes.filter((m) => !rm.has(m.id));
          home.edges = (home.edges || []).filter((e) => !rm.has(e.source) && !rm.has(e.target));
          // 刪除守衛：登記墓碑——stale 瀏覽器分頁的合併推送不得把這批卡 upsert 回來
          recordTombs(home, { nodeIds: [...rm], edgeIds: rmEdges, rev: (data.rev ?? 0) + 1 });
          rm.forEach((id) => removed.add(id));
        }
        // 懸空 pin 警示（重建刪卡後節點卡「引用卡不存在」）：
        // 刪除後掃全部分頁，點名引用被刪卡的 pin——重建流程要把它們重指新卡或一併刪除
        const dangling = [];
        for (const p of (data.__pages || [data.__page])) {
          for (const m of p.nodes || []) {
            if (m.type === "pin" && removed.has(m.data?.refCard)) {
              dangling.push({ num: m.data?.num || m.id, label: m.data?.label || "", page: p.name });
            }
          }
        }
        return { removed, dangling };
      }, project);
      // MA1 生命週期：卡刪除後清其隔離 worktree（best-effort、不 await；非 git／OFF／無 worktree＝快速略過）
      for (const id of remove.removed) cleanupCardWorktree(project, id);
      return { ok: true, rev: out.rev, removed: [...remove.removed],
        ...(remove.dangling.length ? { dangling_pins: remove.dangling,
          hint: "These pin cards referenced the deleted card(s) - re-point each (update_card {card,refCard:<new target>}) or delete them." } : {}) };
    },
  },
  list_edges: {
    description: "List all edges (source->target, label, handles). limit defaults to 200 (pass a bigger value to widen, capped 5000); on truncation returns truncated:true + total.",
    inputSchema: { type: "object", properties: {
      limit: { type: "number", description: "Max edges to return (default 200, cap 5000)" },
    }, additionalProperties: false },
    async run({ limit, project, page } = {}) {
      const data = await load(project, page);
      const edges = [];
      for (const p of eachPage(data)) {
        const kind = boardKindOf({ nodes: p.nodes || [] }); // 板型投影基準（有效語意）
        (p.edges || []).forEach((e) => {
          const sem = edgeSemantics(e, kind); // relation/confidenceTier/evidence.source（未存＝板型投影）
          edges.push({
            id: e.id, source: e.source, target: e.target, label: e.label || null,
            sourceHandle: e.sourceHandle || null, targetHandle: e.targetHandle || null,
            relation: sem.relation, confidenceTier: sem.confidenceTier, evidenceSource: sem.source,
            note: e.data?.evidence?.note || null,
            ...pageTagOf(data, p) });
        });
      }
      const total = edges.length;
      const sliced = edges.slice(0, queryLimit(limit, 200)); // 省略＝預設 200
      const res = { count: sliced.length, edges: sliced };
      if (sliced.length < total) { res.truncated = true; res.total = total; }
      return res;
    },
  },
  // MA2 整合佇列（多 agent 並行改碼）：卡片的工作分支＝MA1 隔離 worktree 的 hare/chat/<project>__<id>。
  preview_integration: {
    description: "Read-only MA2 merge preview: analyze each card's work-branch vs base (default main) — clean?/conflict files/diff summary. No mutation; no branch = exists:false.",
    inputSchema: { type: "object", properties: {
      cards: { type: "array", items: { type: "string" }, description: "Card ids/numbers/labels to preview" },
      base: { type: "string", description: "Base ref to merge into (default main)" },
    }, required: ["cards"], additionalProperties: false },
    async run({ cards, base, project }) {
      const pid = normalizeProjectId(project);
      const refBase = await getProjectRefBase(pid);
      if (!(await isGitRepo(refBase))) throw new Error("preview_integration 需 git 專案");
      const data = await load(project);
      const b = base || "main";
      const previews = [];
      for (const key of (cards || [])) {
        const n = findNode(data, key);
        if (!n) { previews.push({ card: key, error: "找不到卡片" }); continue; }
        const branch = branchName(pid, n.id);
        const num = n.data?.num || n.id;
        if (!(await branchExists(refBase, branch))) { previews.push({ card: num, branch, exists: false }); continue; }
        previews.push({ card: num, branch, exists: true, ...(await previewIntegration(refBase, b, branch)) });
      }
      return { ok: true, base: b, previews };
    },
  },
  run_integration_queue: {
    write: true,
    description: "MA2 integration queue: DAG-ordered merge of card work-branches into a dedicated integration worktree (never main), post-merge gate (test/build argv), land on green / bounce on conflict/gate-fail/high-risk. No branch = skipped. Returns per-card outcome + review preview.",
    inputSchema: { type: "object", properties: {
      cards: { type: "array", items: { type: "string" }, description: "Card ids/numbers/labels to integrate" },
      base: { type: "string", description: "Base ref (default main)" },
      gate: { type: "array", items: { type: "string" }, description: "Gate command argv. Omit = npm test when the project declares a test script, else no gate (land on clean merge); [] = explicitly skip" },
      highRisk: { type: "array", items: { type: "string" }, description: "Card ids/numbers to force human review even if clean (§four high-risk tiers)" },
      resolverAgent: { type: "array", items: { type: "string" }, description: "Optional coding-agent argv (e.g. [\"claude\",\"-p\",\"--allowedTools\",\"Edit Write Read\"]) — on conflict, spawn it in the integration worktree with both cards' intent to auto-resolve (Layer 2). Omit = conflicts go straight to human." },
    }, required: ["cards"], additionalProperties: false },
    async run({ cards, base, gate, highRisk, resolverAgent, project }) {
      const pid = normalizeProjectId(project);
      const refBase = await getProjectRefBase(pid);
      if (!(await isGitRepo(refBase))) throw new Error("run_integration_queue 需 git 專案");
      const data = await load(project);
      const nodes = (cards || []).map((k) => findNode(data, k)).filter(Boolean);
      const highSet = new Set((highRisk || []).map((k) => findNode(data, k)?.id).filter(Boolean));
      // 卡片意圖（HARE 差異化：餵給解衝突 agent，非只給文字標記）＝編號＋標題＋說明＋驗收任務
      const intentOf = (n) => [`${n.data?.num || n.id} ${n.data?.label || ""}`, n.data?.desc || "",
        `驗收: ${taskTexts(n.data?.tasks).join("; ")}`].filter(Boolean).join("\n");
      const items = [];
      for (const n of topoOrder(data, nodes)) { // DAG 排序：前置先落
        const branch = branchName(pid, n.id);
        if (!(await branchExists(refBase, branch))) continue; // 尚未在隔離 worktree 提交＝略過
        items.push({ card: n.data?.num || n.id, branch, riskTier: highSet.has(n.id) ? "high" : "low", intent: intentOf(n) });
      }
      if (!items.length) return { ok: true, results: [], note: "無可整合分支（卡片尚未在隔離 worktree 提交工作，或未啟用 worktreeIsolation）" };
      const resolver = resolverAgent && resolverAgent.length ? makeResolverAgent({ execCommand: resolverAgent }) : null;
      // MA4 閘門預設開＋通用化：base＝偵測專案預設分支；閘門＝專案宣告
      // scripts.test 才跑 npm test（資料列，不寫死棧）。明給 []＝明示跳過。
      const gateCmd = gate === undefined
        ? ((await projectScripts(refBase)).test ? ["npm", "test"] : null)
        : (gate.length ? gate : null);
      const r = await processQueue(refBase, items,
        { project: pid, base: base || await defaultBase(refBase), gateCommand: gateCmd, resolver });
      const landedN = (r.results || []).filter((x) => x.landed).length;
      return { ok: r.ok, ...(r.integrationBranch ? { integrationBranch: r.integrationBranch } : {}),
        results: r.results, ...(r.error ? { error: r.error } : {}),
        // 落地≠上線：伺服器跑舊碼、前端 dist 未重建——回應提示收尾
        ...(landedN ? { restart_hint: `已 land ${landedN} 張卡的分支——後端需重啟伺服器（匣選單「重啟伺服器」）、前端需 npx vite build 後重整才會生效` } : {}) };
    },
  },
  add_edge: {
    write: true,
    description: "Add an edge (source = upstream; layout columns follow this). arrow: flow (default), inject (import), both. relation semantics: prerequisite/reference/imports/validates (omit = board-type projection); inferred:true = a guess (tier inferred), else asserted.",
    inputSchema: { type: "object", properties: {
      source: { type: "string", description: "Source card (id/number/label)" },
      target: { type: "string", description: "Target card (id/number/label)" },
      label: { type: "string", description: "Edge label" },
      handles: { type: "object", description: "Endpoint sides {source,target}: l/r/t/b",
        properties: { source: { type: "string" }, target: { type: "string" } } },
      arrow: { type: "string", enum: ["flow", "inject", "both"], description: "Arrow semantics (default flow)" },
      relation: { type: "string", enum: ["prerequisite", "reference", "imports", "validates"], description: "Relation type (omit = board-type projection)" },
      note: { type: "string", description: "One-line evidence note (optional)" },
      inferred: { type: "boolean", description: "true = agent guess (tier inferred); default asserted" },
    }, required: ["source", "target"], additionalProperties: false },
    async run({ source, target, label, handles, arrow, relation, note, inferred, project }, ctx) {
      const { out, result: edge } = await mutate(ctx, (data) => {
        const s = findNode(data, source); if (!s) throw new Error(`找不到起點卡片：${source}`);
        const t = findNode(data, target); if (!t) throw new Error(`找不到終點卡片：${target}`);
        assertNotSelfEdge(s.id, t.id); // 寫入端消毒：自環（DAG 非法）
        // 線段不可跨分頁：兩端必須同頁，線落在該頁（findNode 可能在別頁找到端點）
        const sp = pageOwning(data, s.id) || data.__page;
        const tp = pageOwning(data, t.id) || data.__page;
        if (sp !== tp) throw new Error(`起點與終點不在同一分頁（${sp?.name}／${tp?.name}），線段不可跨分頁`);
        // B9 邊語意：明示 relation 才落 data；tier 由 inferred 決定，evidence.source 依 transport、writer 蓋 ctx。
        const edgeData = relation ? { relation, confidenceTier: inferred ? "inferred" : "asserted",
          evidence: { source: evidenceSourceOf(ctx), writer: ctx?.writer || "mcp", ...(note ? { note } : {}) } } : null;
        const e = { id: freshId("mcp_e_"), source: s.id, target: t.id, type: "default",
          style: { stroke: "#c47d0a", strokeWidth: 1.8 },
          ...edgeMarkers(arrow, "#c47d0a"),
          ...(label ? { label } : {}),
          ...(edgeData ? { data: edgeData } : {}),
          ...(handles?.source ? { sourceHandle: handles.source } : {}),
          ...(handles?.target ? { targetHandle: handles.target } : {}) };
        const dup = dupEdgeHint(sp.edges, s.id, t.id); // 消毒：重複邊回 hint（不阻擋）
        sp.edges = sp.edges || []; sp.edges.push(e);
        // B17 即時 hint：違反板型連線語意慣例＝提醒（不阻擋）
        const bt = boardTypeOf(sp);
        const a = arrowOf(e);
        const btHint = bt?.arrows && !bt.arrows.includes(a) ? `arrow=${a}：${bt.hint}` : null;
        return { e, hint: [dup, btHint].filter(Boolean).join("；") || null };
      }, project);
      return { ok: true, rev: out.rev,
        edge: { id: edge.e.id, source: edge.e.source, target: edge.e.target, label: label || null,
          relation: edge.e.data?.relation || null },
        ...(edge.hint ? { hint: edge.hint } : {}) };
    },
  },
  update_edge: {
    write: true,
    description: "Update an edge by id: label (null clears) / source / target / arrow (flow/inject/both) / relation (prerequisite/reference/imports/validates; setting it stamps tier asserted unless inferred:true) / note.",
    inputSchema: { type: "object", properties: {
      edge: { type: "string", description: "Edge id" },
      label: { type: ["string", "null"], description: "New label (null clears)" },
      source: { type: "string", description: "New source card (id/number/label)" },
      target: { type: "string", description: "New target card (id/number/label)" },
      arrow: { type: "string", enum: ["flow", "inject", "both"], description: "Arrow semantics" },
      relation: { type: "string", enum: ["prerequisite", "reference", "imports", "validates"], description: "Relation type (tier asserted unless inferred)" },
      note: { type: "string", description: "One-line evidence note (optional)" },
      inferred: { type: "boolean", description: "true = agent guess (tier inferred); default asserted" },
    }, required: ["edge"], additionalProperties: false },
    async run({ edge, label, source, target, arrow, relation, note, inferred, project }, ctx) {
      // B9-1 修正1：完全無可更新欄位（只帶 edge）＝no-op，不進 mutate、不徒增 rev。
      const anyField = [label, source, target, arrow, relation, note].some((v) => v !== undefined);
      if (!anyField) {
        return { ok: true, noop: true, edge,
          reason: "未提供任何可更新欄位（label/source/target/arrow/relation/note）；未變更" };
      }
      const { out, result: e } = await mutate(ctx, (data) => {
        const ed = findEdge(data, edge); if (!ed) throw new Error(`找不到線段：${edge}`);
        const home = pageOwning(data, ed.id) || data.__page; // 線段所屬頁：新端點必須同頁
        if (source !== undefined) {
          const s = findNode(data, source); if (!s) throw new Error(`找不到起點卡片：${source}`);
          if ((pageOwning(data, s.id) || data.__page) !== home) throw new Error("新起點不在線段所屬分頁（線段不可跨分頁）");
          ed.source = s.id;
        }
        if (target !== undefined) {
          const t = findNode(data, target); if (!t) throw new Error(`找不到終點卡片：${target}`);
          if ((pageOwning(data, t.id) || data.__page) !== home) throw new Error("新終點不在線段所屬分頁（線段不可跨分頁）");
          ed.target = t.id;
        }
        assertNotSelfEdge(ed.source, ed.target); // 消毒：改端點後不得成自環
        if (label === null) delete ed.label; else if (label !== undefined) ed.label = label;
        if (arrow !== undefined) {
          delete ed.markerStart; delete ed.markerEnd;
          Object.assign(ed, edgeMarkers(arrow, ed.style?.stroke || "#c47d0a"));
        }
        // B9 邊語意：改 relation＝人/agent 明示過，tier 升 asserted（除非 inferred:true）。
        if (relation !== undefined) {
          ed.data = ed.data || {};
          ed.data.relation = relation;
          ed.data.confidenceTier = inferred ? "inferred" : "asserted";
        }
        // B9-1 修正1：evidence（note＋來源蓋章）獨立於 relation 分支——只帶 note 也要寫入，不再被靜默忽略。
        if (relation !== undefined || note !== undefined) {
          ed.data = ed.data || {};
          ed.data.evidence = { ...(ed.data.evidence || {}), source: evidenceSourceOf(ctx), writer: ctx?.writer || "mcp",
            ...(note !== undefined ? { note } : {}) };
        }
        return ed;
      }, project);
      return { ok: true, rev: out.rev,
        edge: { id: e.id, source: e.source, target: e.target, label: e.label || null,
          relation: e.data?.relation || null, note: e.data?.evidence?.note || null } };
    },
  },
  delete_edge: {
    write: true,
    description: "Delete an edge by id.",
    inputSchema: { type: "object", properties: {
      edge: { type: "string", description: "Edge id" },
    }, required: ["edge"], additionalProperties: false },
    async run({ edge, project }, ctx) {
      const { out, result: e } = await mutate(ctx, (data) => {
        const ed = findEdge(data, edge); if (!ed) throw new Error(`找不到線段：${edge}`);
        const home = pageOwning(data, ed.id) || data.__page; // 刪除落在線段所屬頁
        home.edges = (home.edges || []).filter((x) => x.id !== ed.id);
        recordTombs(home, { edgeIds: [ed.id], rev: (data.rev ?? 0) + 1 }); // 刪除守衛
        return ed;
      }, project);
      return { ok: true, rev: out.rev, removed: e.id };
    },
  },
  validate_cards: {
    description: "Lint cards: missing desc/refs, broken refs/anchors, dup numbers, board-type hints, legacy fields. Reports only. summary:true = per-issue counts; limit/offset paginate (def 100).",
    inputSchema: { type: "object", properties: {
      summary: { type: "boolean", description: "true = only per-issue counts, no per-item list" },
      limit: { type: "integer", minimum: 1, description: "Max problems returned (default 100)" },
      offset: { type: "integer", minimum: 0, description: "Skip first N problems (default 0)" },
    }, additionalProperties: false },
    async run({ project, page, summary, limit, offset } = {}) {
      const data = await load(project, page);
      const refBase = await getProjectRefBase(project); // 本專案 refs.path 解析基準根
      const problems = [];
      // B17 板型規則：各頁依板型列檢查連線語意（只報告；task/自由板不限制）
      for (const pg of eachPage(data)) {
        const bt = boardTypeOf(pg);
        if (!bt?.arrows) continue;
        const byId = new Map((pg.nodes || []).map((n) => [n.id, n]));
        (pg.edges || []).forEach((e) => {
          const a = arrowOf(e);
          if (!bt.arrows.includes(a)) {
            const nm = (id) => { const n = byId.get(id); return n?.data?.num || labelOf(n) || id; };
            problems.push({ issue: "板型連線語意提示", page: pg.name,
              detail: `${nm(e.source)}→${nm(e.target)}${e.label ? `（${e.label}）` : ""} arrow=${a}；${bt.hint}` });
          }
        });
      }
      // 編號重複（頁內＝真重複；跨頁重複另報——不帶 page 的點名查卡會歧義）
      const globalNum = new Map(); // num → Set<pageName>
      for (const pg of eachPage(data)) {
        const numMap = new Map();
        (pg.nodes || []).forEach((n) => {
          const num = (n.data?.num || "").trim(); if (!num) return;
          numMap.set(num, (numMap.get(num) || []).concat(n.id));
          if (!globalNum.has(num)) globalNum.set(num, new Set());
          globalNum.get(num).add(pg.name);
        });
        numMap.forEach((ids, num) => {
          if (ids.length > 1) problems.push({ card: num, issue: "編號重複",
            detail: `${ids.length} 張：${ids.join(", ")}`, ...pageTagOf(data, pg) });
        });
      }
      if (!data.__explicitPage) {
        globalNum.forEach((pageNames, num) => {
          if (pageNames.size > 1) problems.push({ card: num, issue: "編號跨分頁重複",
            detail: `出現於：${[...pageNames].join("、")}（不帶 page 的點名查卡會要求指明分頁）` });
        });
      }
      for (const pg of eachPage(data)) (pg.nodes || []).forEach((n) => {
        if (n.type === "lane") return;
        const addP = (node, issue, detail) => problems.push({
          card: node.data?.num || node.id, label: labelOf(node) || null, type: node.type, issue,
          ...(detail ? { detail } : {}), ...pageTagOf(data, pg) });
        // 缺 desc：note 卡皆該有；缺 refs：只稽核工作卡（status≠note，沿 graph.mjs 分野）
        // 機械生成卡（analyze 的 kind:file/dir…）本設計就不寫 desc——免檢，
        // 否則每次生成板都貢獻數十筆永久噪音，validate 失去可讀性（清掃裁定）
        if (n.type === "note" && !n.data?.kind && !(n.data?.desc || "").trim()) addP(n, "缺 desc 說明");
        if (isWorkCard(n) && !(Array.isArray(n.data?.refs) && n.data.refs.length)) addP(n, "缺 refs 程式對應");
        // refs.path 檔案不存在；uuid 宣告卻沒埋 HARE 註解＝斷鏈（過程觸發的事後稽核面）
        (n.data?.refs || []).forEach((r, i) => {
          const p = (r?.path || "").trim();
          if (!p) { addP(n, "refs.path 空白", `#${i + 1}`); return; }
          const abs = resolveWithin(refBase, p); // 相對本專案 refBase 解析（穿越回 null）
          if (!abs) { addP(n, "refs.path 逸出 refBase（路徑穿越）", `#${i + 1} ${p}`); return; }
          if (!existsSync(abs)) { addP(n, "refs.path 檔案不存在", `#${i + 1} ${p}`); return; }
          const u = String(r?.uuid || "").trim();
          // 雙層制：檔案級＝只 path；帶標籤必為函式級（標籤＝
          // 錨點名＋uuid）。有 label 沒 uuid＝層級違規（卡片端已不顯示這種標籤）
          if (!u && String(r?.label || "").trim()) {
            addP(n, "refs 層級違規：有標籤無 uuid（檔案級只留 path；函式級補錨點）", `#${i + 1} ${p}`);
          }
          if (u) {
            try {
              // 範圍錨：起點「HARE <uuid>」必埋且同檔唯一；終點「HARE-END <uuid>」
              // 選埋（標記區塊結尾）——埋了就必須有起點、唯一、且在起點之後。
              // 雙標準（改名）：HARE 新制＋BANLU legacy 皆認（他專案舊錨不逼遷移）
              const txt = readFileSync(abs, "utf8");
              const cnt = (s) => txt.split(s).length - 1;
              const idx = (s) => { const k = txt.indexOf(s); return k < 0 ? Infinity : k; };
              const starts = cnt(`HARE ${u}`) + cnt(`BANLU ${u}`);
              const ends = cnt(`HARE-END ${u}`) + cnt(`BANLU-END ${u}`);
              if (!starts) {
                addP(n, "HARE 斷鏈（uuid 無對應註解）", `#${i + 1} ${p} uuid=${u}`);
              } else if (starts > 1) {
                addP(n, "HARE 錨點重複（同檔多筆同 uuid）", `#${i + 1} ${p} uuid=${u} ×${starts}`);
              }
              const firstStart = Math.min(idx(`HARE ${u}`), idx(`BANLU ${u}`));
              const firstEnd = Math.min(idx(`HARE-END ${u}`), idx(`BANLU-END ${u}`));
              if (ends && (ends > 1 || !starts || firstEnd < firstStart)) {
                addP(n, "HARE-END 不成對（無起點／重複／先於起點）", `#${i + 1} ${p} uuid=${u}`);
              }
            } catch { /* 讀檔失敗不報（存在性已過）*/ }
          }
        });
        // 殘留舊欄位非空
        const legacy = LEGACY_KEYS.filter((k) => n.data?.[k] !== undefined && n.data[k] !== "");
        if (legacy.length) addP(n, "殘留舊欄位非空", legacy.join(", "));
      });
      // 讀取金字塔補遺：summary＝只回分類計數（何種問題各幾件）；否則 offset/limit 分頁＋truncated/total。
      const total = problems.length;
      if (summary) {
        const byIssue = {};
        for (const p of problems) byIssue[p.issue] = (byIssue[p.issue] || 0) + 1;
        return { ok: total === 0, total, summary: byIssue };
      }
      const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
      const cap = Number.isInteger(limit) && limit > 0 ? limit : 100;
      const page_ = problems.slice(off, off + cap);
      return { ok: total === 0, count: page_.length, total, problems: page_,
        ...(off + page_.length < total ? { truncated: true } : {}) };
    },
  },
  /* ---------- B4 多專案化：專案管理工具 ---------- */
  // HARE b4pr0j01 PROJECT_TOOLS
  list_projects: {
    description: "List all board projects: id/title/prefix/rev/card count/data file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return listProjects(); },
  },
  create_project: {
    write: true,
    description: "Create a project. Pages live inside the project file - add them via each tool's page param, not here. For a project about a codebase, set refBase so card refs.path resolve there (relative, no absolute paths).",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Project id (alnum/-/_, must start alnum; used as filename)" },
      title: { type: "string", description: "Display title (default: id)" },
      prefix: { type: "string", description: "Auto card-number prefix" },
      swimlane: { type: "string", description: "Initial lane title (seeds a lane card)" },
      template: { type: "string", enum: ["blank", "roadmap"], description: "Seed template (default blank; roadmap = lane + how-to card)" },
      layout: { type: "object", description: "Grid overrides stored in meta.layout (x0/y0/colPitch/cardW/rowPitch/rowPitchTall/childX/childY0/childPitch)" },
      refBase: { type: "string", description: "Absolute folder that refs.path resolve against (omit = HARE repo root). Set this when the project tracks another codebase." },
    }, required: ["id"], additionalProperties: false },
    async run({ id, title, prefix, swimlane, template, layout, refBase }, ctx) {
      // 新專案自動種啟動狀態機（導覽頁＋G0 模板＋啟動檢核卡，Spec Kit 四步）。
      // refBase 開放給 MCP（agent 建外部 codebase 專案設不了基準根，
      // 只能寫絕對路徑 refs，前端點擊解析成 refBase+絕對路徑而壞）。
      const r = await createProject(id, { title, prefix, swimlane, template, layout, refBase, onboarding: "new" }, ctx?.writer || "mcp");
      if (typeof ctx?.onWrite === "function") ctx.onWrite(r.rev, r.id);
      return { ok: true, project: r };
    },
  },
  rename_project: {
    write: true,
    description: "Rename a project id (moves data file and changelog). 'default' cannot be renamed.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Current project id" },
      newId: { type: "string", description: "New project id (alnum/-/_)" },
    }, required: ["id", "newId"], additionalProperties: false },
    async run({ id, newId }, ctx) { return renameProject(id, newId, ctx?.writer || "mcp"); },
  },
  delete_project: {
    write: true,
    description: "Delete a project permanently (data/changelog/backups). Irreversible - prefer archive_project. 'default' cannot be deleted.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Project id to delete" },
    }, required: ["id"], additionalProperties: false },
    async run({ id }) { return deleteProject(id); },
  },
  // HARE a9c41v3p archive_project（專案管理頁 − 鈕；非破壞，可用 unarchive_project 還原）
  archive_project: {
    write: true,
    description: "Archive a project (non-destructive: moved to data/archive/, hidden from the list, id reserved). Restore with unarchive_project. 'default' cannot be archived.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Project id to archive" },
    }, required: ["id"], additionalProperties: false },
    async run({ id }) { return archiveProject(id); },
  },
  unarchive_project: {
    write: true,
    description: "Restore an archived project back to the project list.",
    inputSchema: { type: "object", properties: {
      id: { type: "string", description: "Project id to unarchive" },
    }, required: ["id"], additionalProperties: false },
    async run({ id }) { return unarchiveProject(id); },
  },
  /* ---------- B16 Codebase 反向分析成板 ---------- */
  // HARE b16t001c analyze_codebase
  analyze_codebase: {
    write: true,
    description: "Analyze a directory tree into an architecture board (dirs = container cards, files = child cards with refs, import edges); sets project refBase. With page = grow an existing project (rejected if the page has cards); without page = a brand-new project id (not 'default').",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to analyze (absolute path preferred)" },
      imports: { type: "boolean", description: "Generate import/require edges (default true)" },
      gitignore: { type: "boolean", description: "Respect .gitignore (default true)" },
      maxDepth: { type: "number", description: "Max directory depth (default 6; deeper dirs become unexpanded cards)" },
      perDir: { type: "number", description: "Max file cards per directory (default 25; rest aggregated)" },
      maxFiles: { type: "number", description: "Max file cards total (default 400)" },
    }, required: ["path"], additionalProperties: false },
    async run({ path, project, imports, gitignore, maxDepth, perDir, maxFiles, page }, ctx) {
      // project 由下方 schema 注入器補為選填；page 給了＝寫進該分頁（可為既有專案），
      // page 省略＝維持舊規則：必須全新專案代號、不可 default（不得誤寫正式白板）。
      const raw = project == null ? "" : String(project).trim();
      if (!raw) throw new Error("analyze_codebase 必須指定 project（目標專案代號，不可省略）");
      const pid = normalizeProjectId(raw); // 非法代號在此丟錯
      const pageName = page == null ? "" : String(page).trim();
      if (!pageName && pid === DEFAULT_PROJECT) {
        throw new Error("analyze_codebase 不帶 page 時不可寫入預設專案 default；要在既有專案長出分析分頁請帶 page（如 page:\"分析\"）");
      }

      const abs = resolve(REPO_ROOT, String(path || ""));
      if (!existsSync(abs)) throw new Error(`路徑不存在：${path}`);
      if (!statSync(abs).isDirectory()) throw new Error(`需要目錄路徑（非檔案）：${path}`);

      // 分類跨分頁唯一：先收集專案既有分頁已用的類別字首，配號器整批跳過
      const usedCats = new Set();
      if (await projectExists(pid)) {
        const cur0 = await readStore(pid);
        const pagesArr = Array.isArray(cur0?.pages) ? cur0.pages : (cur0 ? [cur0] : []);
        for (const p of pagesArr) {
          (p.nodes || []).forEach((n) => {
            const m = /^([A-Za-z]+)/.exec(n.data?.num || "");
            if (m) usedCats.add(m[1].toUpperCase());
          });
        }
      }

      const board = analyzeCodebase(abs, { imports: imports !== false, gitignore, maxDepth, perDir, maxFiles, usedCats });
      const refBase = abs.replace(/\\/g, "/"); // 本板 refs 的解析基準根＝分析根

      // 非破壞：不存在就建空專案（refBase 一併入 registry）；已存在＝
      // 無 page 時整專案有卡即拒絕；有 page 時到分頁層檢查（見下方 mutate）。
      if (await projectExists(pid)) {
        if (!pageName) {
          const cur = await readStore(pid);
          const existing = Array.isArray(cur?.pages)
            ? cur.pages.reduce((s, p) => s + (p.nodes || []).filter((n) => n.type !== "lane").length, 0)
            : (cur?.nodes || []).filter((n) => n.type !== "lane").length;
          if (existing) throw new Error(`專案 ${pid} 已有 ${existing} 張卡片，為避免覆蓋拒絕分析（請帶 page 寫進新分頁，或改用新的 project 代號）`);
        }
      } else {
        await createProject(pid, { title: `分析：${refBase.split("/").filter(Boolean).pop() || pid}`, refBase },
          ctx?.writer || "mcp");
      }
      const now = new Date().toISOString();
      const s = board.stats;
      // 分析板只留結果本體，
      // 導入後如何整理由呼叫端自主；機器可讀標記走 meta.onboarded。
      // 分頁寫入：mutate 的 ctx.page 走「找不到就丟錯」，分析板要「不存在就建頁」，
      // 故這裡剝掉 ctx.page 自行落頁（__pages 由分頁視圖提供）。
      const { out } = await mutate({ ...ctx, page: undefined }, (data) => {
        let pg = data.__page; // 預設＝第一頁（全新專案的空板）
        if (pageName) {
          const pages = data.__pages;
          pg = pages.find((p) => p.id === pageName || p.name === pageName) || null;
          if (pg && (pg.nodes || []).some((n) => n.type !== "lane")) {
            throw new Error(`分頁「${pageName}」已有卡片，為避免覆蓋拒絕分析（請改用新的分頁名）`);
          }
          if (!pg) {
            pg = { id: `pg${Date.now().toString(36)}`, name: pageName,
              nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] };
            pages.push(pg);
          }
        }
        pg.nodes = board.nodes;
        pg.edges = board.edges;
        // 首用標記（機器可讀面）：agent/人一看 meta 就知道這板剛導入、尚未整理；
        // refBase 同步入 meta（getProjectRefBase 的第二來源，隨板匯出也帶著走）。
        // 既有專案已有 refBase 時不覆寫（分析分頁沿用本專案根）。
        data.meta = { ...(data.meta || {}), ...(data.meta?.refBase ? {} : { refBase }),
          onboarded: { t: now, by: ctx?.writer || "mcp", root: refBase, ...(pageName ? { page: pageName } : {}),
            dirCount: s.dirCount, fileCount: s.fileCount, edgeCount: s.edgeCount,
            skippedFiles: s.skippedFiles, prunedDirs: s.prunedDirs } };
        // 全新專案路線（無 page＝專案首次入職）在機械板旁種啟動狀態機——
        // 導覽頁＋G0 模板＋啟動檢核卡（DeepWiki 五步，第一步「掃描」已由系統代銷）。
        // 有 page 路線（往既有專案長分析頁）不種：專案已入職過。
        if (!pageName) {
          const { page: onbPage, meta: onbMeta } = onboardingSeed("existing");
          data.__pages.push(onbPage);
          data.meta.onboarding = onbMeta;
        }
      }, pid);

      return { ok: true, project: pid, rev: out.rev, root: s.root, refBase,
        dirCount: s.dirCount, fileCount: s.fileCount, edgeCount: s.edgeCount,
        skippedFiles: s.skippedFiles, prunedDirs: s.prunedDirs, dataFile: dataPathFor(pid) };
    },
  },
  // 檔案總管建構：圖像級檔案總管——與 analyze_codebase（連結
  // 分析）分屬兩件事。資料夾＝巢狀資源卡（資源包資源）、檔案進卡內清單不建獨立卡。
  // HARE f11e7ee1 scan_file_tree
  scan_file_tree: {
    write: true,
    description: "Build a visual file-explorer page (folders = nested resource cards, files = listing rows, no standalone file cards) - unlike analyze_codebase (link analysis). Same page rules as analyze_codebase. See get_guide code.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (absolute path preferred)" },
      gitignore: { type: "boolean", description: "Respect .gitignore (default true)" },
      maxDepth: { type: "number", description: "Max nesting depth (default 5; deeper folders stay as listing rows)" },
      maxList: { type: "number", description: "Max file rows per card (default 60; rest aggregated)" },
    }, required: ["path"], additionalProperties: false },
    async run({ path, project, gitignore, maxDepth, maxList, page }, ctx) {
      const raw = project == null ? "" : String(project).trim();
      if (!raw) throw new Error("scan_file_tree 必須指定 project（目標專案代號，不可省略）");
      const pid = normalizeProjectId(raw);
      const pageName = page == null ? "" : String(page).trim();
      if (!pageName && pid === DEFAULT_PROJECT) {
        throw new Error("scan_file_tree 不帶 page 時不可寫入預設專案 default；要在既有專案長出總管分頁請帶 page（如 page:\"檔案總管\"）");
      }
      const abs = resolve(REPO_ROOT, String(path || ""));
      if (!existsSync(abs)) throw new Error(`路徑不存在：${path}`);
      if (!statSync(abs).isDirectory()) throw new Error(`需要目錄路徑（非檔案）：${path}`);
      const usedCats = new Set();
      if (await projectExists(pid)) {
        const cur0 = await readStore(pid);
        const pagesArr = Array.isArray(cur0?.pages) ? cur0.pages : (cur0 ? [cur0] : []);
        for (const p of pagesArr) {
          (p.nodes || []).forEach((n) => {
            const m = /^([A-Za-z]+)/.exec(n.data?.num || "");
            if (m) usedCats.add(m[1].toUpperCase());
          });
        }
      } else {
        await createProject(pid, { title: `總管：${abs.replace(/\\/g, "/").split("/").filter(Boolean).pop() || pid}`,
          refBase: abs.replace(/\\/g, "/") }, ctx?.writer || "mcp");
      }
      const board = fileTree(abs, { gitignore, maxDepth, maxList, usedCats });
      const { out } = await mutate({ ...ctx, page: undefined }, (data) => {
        let pg = data.__page;
        if (pageName) {
          const pages = data.__pages;
          pg = pages.find((p) => p.id === pageName || p.name === pageName) || null;
          if (pg && (pg.nodes || []).some((n) => n.type !== "lane")) {
            throw new Error(`分頁「${pageName}」已有卡片，為避免覆蓋拒絕建構（請改用新的分頁名）`);
          }
          if (!pg) {
            pg = { id: `pg${Date.now().toString(36)}`, name: pageName,
              nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] };
            pages.push(pg);
          }
        } else if ((pg.nodes || []).some((n) => n.type !== "lane")) {
          throw new Error(`專案 ${pid} 已有卡片，為避免覆蓋拒絕建構（請帶 page 寫進新分頁）`);
        }
        pg.nodes = board.nodes;
        pg.edges = [];
        if (!data.meta?.refBase) data.meta = { ...(data.meta || {}), refBase: abs.replace(/\\/g, "/") };
        return null;
      }, pid);
      return { ok: true, project: pid, rev: out.rev, ...board.stats, dataFile: dataPathFor(pid) };
    },
  },
  scan_interfaces: {
    description: "Read-only interface scan: per-file exports and imported symbols. Facts for agent-drawn semantic maps (grouping is the agent's judgment). path omitted = project refBase.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (omit = project refBase)" },
      maxFiles: { type: "number", description: "Max files (default 400)" },
      gitignore: { type: "boolean", description: "Respect .gitignore (default true)" },
    }, additionalProperties: false },
    async run({ path, maxFiles, gitignore, project }) {
      const root = path ? resolve(REPO_ROOT, String(path)) : await getProjectRefBase(project);
      if (!existsSync(root)) throw new Error(`路徑不存在：${path || root}`);
      return scanInterfaces(root, { maxFiles, gitignore });
    },
  },
  /* ---------- B5 快照／回滾：整版非破壞式快照（per 專案） ---------- */
  // 儲存：data/<project>-snapshots.jsonl（append-only，一列一筆 {id,t,rev,writer,label,board}）。
  // 回滾＝把某快照的整版 board 以「新 rev」寫回（廣播＋可再被回滾）；歷史永不抹除。
  // 實作在 lib/snapshots.mjs（建構於 store 之上，未改 store.mjs）。
  // HARE b5snap001 SNAPSHOT_TOOLS
  create_snapshot: {
    write: true,
    description: "Snapshot the whole board (append-only, non-destructive). Roll back with rollback_snapshot.",
    inputSchema: { type: "object", properties: {
      label: { type: "string", description: "Snapshot label (purpose)" },
    }, additionalProperties: false },
    async run({ label, project }, ctx) {
      const snap = await createSnapshot(project, { label }, ctx?.writer || "mcp");
      return { ok: true, snapshot: snap };
    },
  },
  list_snapshots: {
    description: "List snapshots (id/rev/label/time/writer/card count), oldest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run({ project, page } = {}) { return listSnapshots(project); },
  },
  rollback_snapshot: {
    write: true,
    description: "Roll back to a snapshot by writing it as a new rev (itself revertible; history never erased). Consider create_snapshot first.",
    inputSchema: { type: "object", properties: {
      snapshot: { type: "string", description: "Snapshot id (see list_snapshots)" },
    }, required: ["snapshot"], additionalProperties: false },
    async run({ snapshot, project }, ctx) {
      const r = await rollbackSnapshot(project, snapshot, ctx?.writer || "mcp");
      if (typeof ctx?.onWrite === "function") ctx.onWrite(r.rev, normalizeProjectId(project));
      return { ok: true, ...r };
    },
  },

  // headless turn 的權限回問橋（HARE 9e77a5c0 request-permission）。
  // spawned claude 以 --permission-prompt-tool=mcp__hare__request_permission 呼叫；
  // 請求持久化成白板物件（卡片待答區）→ 等白板上核准/拒絕（逾時＝拒絕）→
  // 回傳 {behavior:"allow"|"deny"}。設為 read 角色：呼叫端是本機 spawned agent，無 Bearer token。
  // 一般 agent 請勿手動呼叫（會掛起等裁定）。
  request_permission: {
    description: "Permission bridge for headless chat turns (--permission-prompt-tool): persists the request, waits for the user's decision, returns {behavior:allow|deny}. Not for regular agent use.",
    inputSchema: { type: "object", properties: {
      tool_name: { type: "string", description: "Tool the agent wants to run" },
      input: { type: "object", description: "Tool input", additionalProperties: true },
      tool_use_id: { type: "string", description: "Tool use id (optional)" },
    }, required: ["tool_name"], additionalProperties: true },
    async run({ tool_name, input }, ctx) {
      return requestPermission(ctx?.chatProject, ctx?.chatCard, tool_name, input);
    },
  },
};

// 把可選 project 參數注入所有「操作單一白板」的工具 schema（專案管理工具本身除外，
// 它們的目標即專案清單，不吃 project 參數）。工具實作已各自從 args 取用 project。
// 分頁（HARE pa9e5v21）：page 參數一併注入，並包一層 run 把 args.page 帶進 ctx——
// mutate 讀 ctx.page 綁定分頁視圖，讀取工具自行以 load(project, page) 取頁。
const PROJECT_MGMT_TOOLS = new Set(["list_projects", "create_project", "rename_project", "delete_project",
  "archive_project", "unarchive_project"]);
for (const [name, t] of Object.entries(TOOLS)) {
  if (PROJECT_MGMT_TOOLS.has(name)) continue;
  t.inputSchema.properties = { ...t.inputSchema.properties, project: PROJECT_SCHEMA, page: PAGE_SCHEMA };
  const rawRun = t.run;
  t.run = (args, ctx) => rawRun(args || {}, { ...(ctx || {}), page: args?.page });
}

// 參數驗證：錯誤參數名（如 search_cards 傳 q）會讓 undefined 當關鍵字
// 吞掉回 0 筆——誤判「查無此卡」導致 F3 重複建卡。手寫 JSON-RPC 不驗 schema＝沉默吞錯，
// 這裡補通用檢查：required 缺＝拒；additionalProperties:false 的未知鍵＝拒。兩 transport 共用。
// HARE a29v8a1d validateToolArgs
export function validateToolArgs(tool, args) {
  const schema = tool?.inputSchema || {};
  const a = args || {};
  for (const k of schema.required || []) {
    if (a[k] === undefined) return `缺少必要參數：${k}`;
  }
  if (schema.additionalProperties === false && schema.properties) {
    const known = new Set(Object.keys(schema.properties));
    const unknown = Object.keys(a).filter((k) => !known.has(k) && a[k] !== undefined);
    if (unknown.length) return `未知參數：${unknown.join("、")}（可用：${[...known].join("、")}）`;
  }
  return null;
}

// 供 transport 判斷寫入工具集合（HTTP 需 Bearer 驗證）
export const WRITE_TOOL_NAMES = new Set(
  Object.entries(TOOLS).filter(([, t]) => t.write).map(([name]) => name)
);

// 需 admin 角色的工具＝改動專案清單本身（建立／改名／刪除）。list_projects 屬讀。
export const ADMIN_TOOL_NAMES = new Set(["create_project", "rename_project", "delete_project",
  "archive_project", "unarchive_project", "analyze_codebase"]);

// 某工具所需的最低角色：admin > write > read。HTTP／MCP-HTTP transport 用它決定 authorize 的 need。
export function roleFor(name) {
  if (ADMIN_TOOL_NAMES.has(name)) return "admin";
  if (WRITE_TOOL_NAMES.has(name)) return "write";
  return "read";
}
