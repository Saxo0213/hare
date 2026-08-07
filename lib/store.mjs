// 路線圖資料檔（瀏覽器 App 與 MCP 共用的單一真相來源）。
// 多專案：一台伺服器可服務多個白板（專案）。每個專案一個資料檔
//   data/<projectId>.json ＋ 變更日誌 data/<projectId>-changelog.jsonl。
// 預設專案（"default"）向後相容——沿用 repo 根的 roadmap-data.json（非破壞式：
// 未搬進 data/default.json 前，讀寫都還在原檔，正式服務不中斷）。
// rev 為單調遞增協調碼（避免時鐘偏移）；每專案獨立遞增、獨立廣播、獨立變更日誌。
import { readFile, writeFile, mkdir, appendFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "./lock.mjs";
import { hasTombs } from "./merge.mjs"; // 刪除墓碑——merge.mjs 零依賴，無循環
import { migrateTasksInPlace } from "./tasks.mjs"; // 任務 dict 化：讀取遷移
import { projectRelation, boardKindOf } from "./graph.mjs"; // changelog 邊端點語意（有效 relation）——graph.mjs 零依賴，無循環

// 父先於子的穩定排序（「剪下貼進容器失敗」根修）：React Flow 要求 parent
// 排在 child 之前；剪貼/搬移把頂層卡變子卡時，陣列殘留原始檔序（子在父前），重載或
// 同步回流即報「Parent node not found」——parentId 被忽略、子卡以相對座標彈飛。
// 寫入前逐頁正規化：以父鏈深度為鍵穩定排序；環/斷鏈以深度上限 40 保底不無窮迴圈。
// HARE 50r7pa2e sortParentsFirst
export function sortParentsFirst(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n) => {
    let d = 0, p = n;
    while (p && p.parentId && byId.has(p.parentId) && d < 40) { p = byId.get(p.parentId); d += 1; }
    return d;
  };
  return nodes.map((n, i) => ({ n, i, d: depthOf(n) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.n);
}

const here = dirname(fileURLToPath(import.meta.url));

// 預設專案代號；未帶 project 參數的所有既有呼叫端都對應到它（完全向後相容）。
export const DEFAULT_PROJECT = "default";
// 專案代號白名單：英數起頭，後接英數/底線/連字號——同時當作檔名，擋路徑穿越。
const PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// 空／未給＝預設專案；非法字元一律拒絕（防 ../ 路徑穿越，因為 id 直接當檔名）。
export function normalizeProjectId(project) {
  if (project === undefined || project === null) return DEFAULT_PROJECT;
  const p = String(project).trim();
  if (p === "") return DEFAULT_PROJECT;
  if (!PROJECT_RE.test(p)) {
    throw new Error(`不合法的專案代號：${project}（只允許英數、-、_，且需以英數起頭）`);
  }
  return p;
}

// 多專案資料夾根：預設 repo/data；HARE_DATA_DIR 環境變數可覆寫（測試隔離用，
// 指向暫存夾就不會動到 repo 內的真實專案檔）。lazy 讀取 env，讓測試可切換。
export function dataDir() {
  return (process.env.HARE_DATA_DIR || process.env.BANLU_DATA_DIR)
    ? resolve(process.env.HARE_DATA_DIR || process.env.BANLU_DATA_DIR)
    : resolve(here, "..", "data");
}

// 專案資料檔絕對路徑。
// 預設專案的解析順序（非破壞式遷移）：
//   1) HARE_DATA_PATH 覆寫（測試隔離／自訂位置）
//   2) data/default.json（若已遷入）
//   3) repo 根 roadmap-data.json（legacy；未遷移前的正式白板，讀寫都留在這裡）
// 其他專案：data/<projectId>.json。
export function dataPathFor(project) {
  const pid = normalizeProjectId(project);
  if (pid === DEFAULT_PROJECT) {
    const envPath = process.env.HARE_DATA_PATH || process.env.BANLU_DATA_PATH; // 雙標準：legacy 名稱照認
    if (envPath) return resolve(envPath);
    const inDir = resolve(dataDir(), "default.json");
    if (existsSync(inDir)) return inDir;
    return resolve(here, "..", "roadmap-data.json");
  }
  return resolve(dataDir(), `${pid}.json`);
}

// 專案變更日誌路徑（與資料檔同目錄同名 -changelog.jsonl）。
export function changelogPathFor(project) {
  const pid = normalizeProjectId(project);
  if (pid === DEFAULT_PROJECT) {
    const envPath = process.env.HARE_DATA_PATH || process.env.BANLU_DATA_PATH;
    if (envPath) {
      return resolve(envPath).replace(/\.json$/i, "-changelog.jsonl");
    }
    const inDir = resolve(dataDir(), "default.json");
    if (existsSync(inDir)) return resolve(dataDir(), "default-changelog.jsonl");
    return resolve(here, "..", "roadmap-changelog.jsonl");
  }
  return resolve(dataDir(), `${pid}-changelog.jsonl`);
}

// 向後相容匯出：預設專案的 legacy 路徑常數（import 期即解析），供既有模組推導 REPO_ROOT
// （tools.mjs / roadmap-api.mjs 用它算 repo 根與 resolveRefPath）。多專案路徑一律走上面的 lazy 函式。
export const DATA_PATH = (process.env.HARE_DATA_PATH || process.env.BANLU_DATA_PATH)
  ? resolve(process.env.HARE_DATA_PATH || process.env.BANLU_DATA_PATH)
  : resolve(here, "..", "roadmap-data.json");
export const CHANGELOG_PATH = (process.env.HARE_DATA_PATH || process.env.BANLU_DATA_PATH)
  ? DATA_PATH.replace(/\.json$/i, "-changelog.jsonl")
  : resolve(here, "..", "roadmap-changelog.jsonl");

// 讀取某專案的資料（省略 project＝預設專案）。檔案不存在／非法代號一律回 null（呼叫端當空板）。
export async function readStore(project) {
  try {
    const data = JSON.parse(await readFile(dataPathFor(project), "utf8"));
    // 任務 dict 化：舊資料（陣列）讀取時就地遷移為確定性 dict（lib/tasks.mjs）
    const migrate = (ns) => { if (Array.isArray(ns)) ns.forEach(migrateTasksInPlace); };
    if (Array.isArray(data?.pages)) data.pages.forEach((p) => migrate(p.nodes));
    else migrate(data?.nodes);
    return data;
  } catch {
    return null;
  }
}

/* ---------- 專案分頁（v2：一專案一檔，分頁在檔內） ----------
 * v2 檔案：{ rev, meta, pages: [{ id, name, nodes, edges, viewport, deletedEdges, constraints }] }
 * v1 檔案（單板，nodes 在頂層）：讀入後 ensurePages() 就地正規化為單一分頁；
 * 寫出時 collapse——只有一頁就寫回 v1 形狀（單板專案/既有工具/舊客戶端完全不受影響），
 * 兩頁以上才落 v2。分頁 id 穩定（v1 包裝固定 "p1"），name 供顯示與尋頁。
 * HARE pa9e5v20 pages */
export function ensurePages(data) {
  if (Array.isArray(data.pages)) {
    data.pages.forEach((p) => {
      p.nodes = Array.isArray(p.nodes) ? p.nodes : [];
      p.edges = Array.isArray(p.edges) ? p.edges : [];
      p.deletedEdges = Array.isArray(p.deletedEdges) ? p.deletedEdges : [];
      p.constraints = Array.isArray(p.constraints) ? p.constraints : [];
      if (p.viewport === undefined) p.viewport = null;
      // 刪除墓碑：選配鍵——有才留，無不補（防資料檔噪音）
      if (p.tombs && typeof p.tombs !== "object") delete p.tombs;
    });
    return data.pages;
  }
  const page = {
    id: "p1", name: "主板",
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    viewport: data.viewport ?? null,
    deletedEdges: Array.isArray(data.deletedEdges) ? data.deletedEdges : [],
    constraints: Array.isArray(data.constraints) ? data.constraints : [],
    ...(data.tombs && typeof data.tombs === "object" ? { tombs: data.tombs } : {}),
  };
  data.pages = [page];
  delete data.nodes; delete data.edges; delete data.viewport;
  delete data.deletedEdges; delete data.constraints; delete data.tombs;
  return data.pages;
}

// 尋頁：id 優先、name 次之；key 空＝第一頁。找不到回 null（呼叫端決定丟錯或建頁）。
export function findPage(data, key) {
  if (!Array.isArray(data?.pages)) return null;
  if (key === undefined || key === null || String(key).trim() === "") return data.pages[0] || null;
  const k = String(key).trim();
  return data.pages.find((p) => p.id === k) || data.pages.find((p) => p.name === k) || null;
}

// 全專案卡片數（v1/v2 通吃）：變更日誌、空板防呆、縮水備份共用。
export function countNodes(d) {
  if (Array.isArray(d?.pages)) return d.pages.reduce((s, p) => s + (p.nodes || []).length, 0);
  return (d?.nodes || []).length;
}

// 變更日誌：每次寫入 append 一行 JSON（時間、writer 身分、rev、nodes/edges 數）。
// 單行 append，失敗只警示不阻斷主寫入（日誌非關鍵路徑）。
async function appendChangelog(changelogPath, entry) {
  try {
    await appendFile(changelogPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // 忽略：日誌失敗不得影響資料寫入
  }
}

// 多人並發寫入保護：呼叫端可帶 expectedRev（呼叫時認定的現值）；與實際現值不符即拒寫。
// 不帶 expectedRev（舊客戶端／MCP 單步工具）＝照舊接受，不做衝突檢查，完全向後相容。
export class RevConflictError extends Error {
  constructor(currentRev) {
    super(`rev 衝突：現值 ${currentRev}，與呼叫端認定值不符`);
    this.code = "REV_CONFLICT";
    this.currentRev = currentRev;
  }
}

// 空板寫入拒絕：既有 ≥5 張卡而新寫入 0 張＝幾乎必是 client 端狀態異常——伺服器不信任 client。
// 合法清空要走 opts.allowEmpty（例如建立空白新專案）。
export class EmptyWriteError extends Error {
  constructor(oldCount) {
    super(`拒絕空板寫入：現有 ${oldCount} 張卡片，寫入 0 張視為異常（合法清空需 allowEmpty）`);
    this.code = "EMPTY_WRITE";
  }
}

// 寫入時：若帶 expectedRev 且不符現值 → 丟 RevConflictError（呼叫端 catch 後改用最新資料，不覆蓋）；
// 否則一律以「目前 rev + 1」寫回並回傳，作為協調碼。
// writer：寫入身分（"browser" / "mcp" / "mcp-http"），僅用於變更日誌，不入資料檔。
// opts.project：目標專案（省略＝預設專案）。
//
// 同 process 寫入序列化佇列（**per 專案** 一條佇列，鍵為解析後的資料檔路徑）：
// read-modify-write 不可交錯，否則同批多則 MCP tools/call 會互吃更新（last-writer-wins）、
// writeFile 交錯致檔案殘尾損毀。改成 per 專案佇列後，不同專案的寫入
// 彼此不再互相排隊阻塞，同專案內仍嚴格序列化。
//
// 跨 process 互斥：同 process 佇列只序列化「本行程內」的寫入。兩支不同 process
// （例如跑著的 server.mjs ＋ 另開的 stdio MCP）同時寫同一專案時，各自「讀 rev→寫 rev+1」
// 之間仍有 TOCTOU 窗口會互吃更新。故在佇列 job 內再套一層 withLock（以資料檔路徑為鍵的
// 檔案系統 advisory 鎖，見 lock.mjs），把「讀→改→寫」整段對跨 process 也變成臨界區。
// 兩層是 belt-and-suspenders：同 process 靠佇列（快、免搶檔鎖競爭），跨 process 靠檔鎖。
// 不同專案 → 不同鎖檔 → 互不阻塞。原子 tmp+rename 仍保證檔案本身任何時點都是完整 JSON。
const queues = new Map();
const enqueue = (key, job) => {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(job);
  queues.set(key, run.catch(() => {})); // 佇列吞錯繼續前進；呼叫端仍收到原始 rejection
  return run;
};

export function writeStore(data, writer = "unknown", opts = {}) {
  const project = normalizeProjectId(opts.project);
  const dataPath = dataPathFor(project);
  return enqueue(dataPath, () =>
    withLock(dataPath, () => writeStoreSerialized(data, writer, opts, project))
  );
}

// read-modify-write 整段序列化：mutator(data) 在佇列內收到最新資料、直接就地修改並
// 回傳結果；throw 則不寫入。單靠 writeStore 排隊不夠——併發呼叫端各自先 load() 再排隊
// 寫入，彼此仍互吃更新（last-writer-wins）。回傳 { out, result }。
export function updateStore(mutator, writer = "unknown", opts = {}) {
  const project = normalizeProjectId(opts.project);
  const dataPath = dataPathFor(project);
  // withLock 包住「讀→改→寫」整段：mutator 讀到的 data 與其後的 rev 計算/落地必須對
  // 跨 process 也不可交錯，否則另一 process 在我讀完、寫回前插入寫入 → lost update。
  return enqueue(dataPath, () =>
    withLock(dataPath, async () => {
      const cur = await readStore(project);
      const data = cur && (Array.isArray(cur.nodes) || Array.isArray(cur.pages))
        ? cur : { nodes: [], edges: [], viewport: null, rev: 0 };
      const result = await mutator(data);
      const out = await writeStoreSerialized(data, writer, opts, project);
      return { out, result };
    })
  );
}

// 逐卡內容指紋（changelog diff 判 updated 用）：只取 type / parentId / data。
// 揮發欄位不觸發 updated——node 級 position／measured／width／height／selected／dragging／
// zIndex 本就不在取樣範圍（此處只取 data）；data 內剔除 claim（認領心跳＝雜訊）與量測
// 衍生值 childTop／childZoneH。與 merge.mjs／App.jsx 指紋同語意（量測衍生值不入指紋，
// 防跨分頁量測差異誤判 updated）；merge.mjs 無現成指紋函式，故在此自寫一小份。
// HARE 18d9155b changelog_diff
function nodeFingerprint(n) {
  if (!n || typeof n !== "object") return "";
  const { claim, childTop, childZoneH, ...data } = n.data || {};
  return JSON.stringify({ type: n.type ?? null, parentId: n.parentId ?? null, data });
}
// 攤平全專案節點（id→node）與邊 id 集：v1（頂層 nodes/edges）與 v2（pages 陣列）通吃。
function flatNodes(d) {
  const m = new Map();
  const add = (ns) => (ns || []).forEach((n) => m.set(n.id, n));
  if (Array.isArray(d?.pages)) d.pages.forEach((p) => add(p.nodes));
  else add(d?.nodes);
  return m;
}
// 攤平全專案邊（id→{edge, nodes:同頁節點}）：投影有效 relation、解析端點卡號時共用。
function flatEdges(d) {
  const m = new Map();
  const add = (es, ns) => (es || []).forEach((e) => m.set(e.id, { edge: e, nodes: ns || [] }));
  if (Array.isArray(d?.pages)) d.pages.forEach((p) => add(p.edges, p.nodes));
  else add(d?.edges, d?.nodes);
  return m;
}
// 邊端點語意描述 {i:id, s:source 卡 num 或 id 尾碼, t:target 同, r:有效 relation（板型投影）}。
const idTail = (id) => `#${String(id || "").slice(-4)}`;
function edgeEndpoints(info) {
  const { edge, nodes } = info;
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const numOf = (nid) => byId.get(nid)?.data?.num || idTail(nid);
  return { i: edge.id, s: numOf(edge.source), t: numOf(edge.target), r: projectRelation(edge, boardKindOf({ nodes })) };
}
// 邊語意指紋（判 updated 用）——端點＋有效 relation／tier／evidence／label／marker。
// relation/tier/evidence 任一變動都要進 changelog（呼應「關係是一等事實、變更可對帳」）。
function edgeFingerprint(e) {
  if (!e || typeof e !== "object") return "";
  const d = e.data || {};
  return JSON.stringify({
    source: e.source ?? null, target: e.target ?? null, label: e.label ?? null,
    relation: d.relation ?? null, confidenceTier: d.confidenceTier ?? null, evidence: d.evidence ?? null,
    ms: !!e.markerStart, me: !!e.markerEnd,
  });
}
// 邊更新差異 {i:id, s,t:新端點 num, from,to:舊→新有效 relation（板型投影）}。
function edgeUpdate(oldInfo, newInfo) {
  const ep = edgeEndpoints(newInfo);
  const from = projectRelation(oldInfo.edge, boardKindOf({ nodes: oldInfo.nodes }));
  return { i: ep.i, s: ep.s, t: ep.t, from, to: ep.r };
}
// cur→out 逐卡／逐邊差異：{ a:新增卡, r:移除卡, u:更新卡, ea:新增邊, er:移除邊, eu:更新邊 }。
// 邊記端點語意（ea/er＝{i,s,t,r}、eu＝{i,s,t,from,to}）；讀取端須容忍舊的純字串 id。
// 六陣列合計 > CHANGED_BULK_CAP 個 id → 改記 { bulk:true, a,r,u,ea,er,eu:數量 }（只記數，防巨量灌爆日誌）。
const CHANGED_BULK_CAP = 50;
function diffChanges(cur, out) {
  const oldN = flatNodes(cur), newN = flatNodes(out);
  const a = [], r = [], u = [];
  for (const [id, n] of newN) {
    if (!oldN.has(id)) a.push(id);
    else if (nodeFingerprint(oldN.get(id)) !== nodeFingerprint(n)) u.push(id);
  }
  for (const id of oldN.keys()) if (!newN.has(id)) r.push(id);
  const oldE = flatEdges(cur), newE = flatEdges(out);
  const ea = [], er = [], eu = [];
  for (const [id, info] of newE) {
    if (!oldE.has(id)) ea.push(edgeEndpoints(info));
    else if (edgeFingerprint(oldE.get(id).edge) !== edgeFingerprint(info.edge)) eu.push(edgeUpdate(oldE.get(id), info));
  }
  for (const [id, info] of oldE) if (!newE.has(id)) er.push(edgeEndpoints(info));
  const total = a.length + r.length + u.length + ea.length + er.length + eu.length;
  if (total > CHANGED_BULK_CAP) {
    return { bulk: true, a: a.length, r: r.length, u: u.length, ea: ea.length, er: er.length, eu: eu.length };
  }
  return { a, r, u, ea, er, eu };
}

async function writeStoreSerialized(data, writer, opts, project) {
  const dataPath = dataPathFor(project);
  const changelogPath = changelogPathFor(project);
  const cur = await readStore(project);
  const curRev = cur && typeof cur.rev === "number" ? cur.rev : 0;
  if (typeof opts.expectedRev === "number" && opts.expectedRev !== curRev) {
    throw new RevConflictError(curRev);
  }
  const rev = curRev + 1;
  // 分頁 collapse（HARE pa9e5v20）：只有一頁＝寫回 v1 形狀（單板專案完全不變）；
  // 兩頁以上＝v2（pages 陣列，欄位白名單逐頁套用）。
  const pageShape = (p) => ({
    id: String(p.id || "p1"), name: String(p.name || "主板"),
    nodes: sortParentsFirst(Array.isArray(p.nodes) ? p.nodes : []),
    edges: Array.isArray(p.edges) ? p.edges : [],
    viewport: p.viewport ?? null,
    deletedEdges: Array.isArray(p.deletedEdges) ? p.deletedEdges : [],
    constraints: Array.isArray(p.constraints) ? p.constraints : [],
    // 刪除墓碑持久化——有內容才寫，防每頁掛空物件
    ...(hasTombs(p.tombs) ? { tombs: p.tombs } : {}),
  });
  let out;
  if (Array.isArray(data?.pages) && data.pages.length > 1) {
    out = { pages: data.pages.map(pageShape), meta: data?.meta ?? null, rev };
  } else {
    const src = Array.isArray(data?.pages) ? (data.pages[0] || {}) : (data || {});
    out = {
      nodes: sortParentsFirst(Array.isArray(src.nodes) ? src.nodes : []),
      edges: Array.isArray(src.edges) ? src.edges : [],
      meta: data?.meta ?? null, // 白板標題等共享中繼資料
      viewport: src.viewport ?? null,
      deletedEdges: Array.isArray(src.deletedEdges) ? src.deletedEdges : [], // 已刪除的預設邊墓碑
      constraints: Array.isArray(src.constraints) ? src.constraints : [], // 持續性約束群組
      ...(hasTombs(src.tombs) ? { tombs: src.tombs } : {}), // 刪除墓碑
      rev,
    };
  }
  const newCount = countNodes(out);
  const oldCount = countNodes(cur);
  if (oldCount >= 5 && newCount === 0 && !opts.allowEmpty) {
    throw new EmptyWriteError(oldCount);
  }
  await mkdir(dirname(dataPath), { recursive: true });
  // 大幅縮水（<50%）自動備份舊檔（保留最近 5 份），防大規模誤刪災難
  const base = basename(dataPath);
  if (oldCount >= 5 && newCount < oldCount * 0.5) {
    try {
      await writeFile(`${dataPath}.bak-${curRev}`, JSON.stringify(cur, null, 2), "utf8");
      const { readdir, unlink } = await import("node:fs/promises");
      const dir = dirname(dataPath);
      const baks = (await readdir(dir)).filter((f) => f.startsWith(`${base}.bak-`))
        .sort((a, b) => Number(b.split("bak-")[1]) - Number(a.split("bak-")[1]));
      for (const f of baks.slice(5)) await unlink(resolve(dir, f)).catch(() => {});
    } catch { /* 備份失敗不阻斷主寫入 */ }
  }
  // 原子寫入：先寫暫存檔再 rename 覆蓋，任何時點讀到的都是完整 JSON（tmp 名帶 pid 防跨 process 相撞）
  const tmp = `${dataPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
  await rename(tmp, dataPath);
  // 逐卡事件化：cur（舊）→ out（新）差異算成 changed（向後相容——
  // 舊行無此欄位，讀取端須容忍）。get_changes 增量回訪與 entryInfo.behind_revs 都靠它。
  const changed = diffChanges(cur, out);
  await appendChangelog(changelogPath, {
    t: new Date().toISOString(), writer, project, rev,
    nodes: newCount,
    edges: Array.isArray(out.pages) ? out.pages.reduce((s, p) => s + p.edges.length, 0) : out.edges.length,
    ...(Array.isArray(out.pages) ? { pages: out.pages.length } : {}),
    changed,
  });
  return out;
}
