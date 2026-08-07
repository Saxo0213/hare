// 合併寫入（多方檢視防互抹，零依賴純函數）：瀏覽器 PUT 從「整份覆蓋」改為
// 「逐卡合併」——client 快照舊也抹不掉別人的並發變更（整份覆蓋會清空白板）。
//
// 語意：
// - incoming.nodes 逐 id upsert（client 見過並可能改過的卡＝以 client 為準，per-node last-writer）
// - current 有而 incoming 沒有的卡：保留（client 快照舊），除非 id 在 incoming.removedNodeIds
//   墓碑（client 明確刪除）才移除
// - edges 同理（墓碑＝removedEdgeIds；相容既有 deletedEdges 種子墓碑機制，兩者並集）
// - viewport／constraints：全量 last-writer（低衝突頻率，暫不細分）
// - 舊客戶端（無墓碑欄位）＝只能增改不能刪，方向安全
//
// 刪除守衛：上面「client 新增的卡照收」有一個洞——stale 分頁的快照裡還留著
// 「別人已刪的舊卡」，推送時被當成新增卡 upsert 回來。
// 修法＝伺服器端刪除墓碑持久化＋板世代檢核：
// - 每次刪除（merge 的 removed*Ids 或 MCP delete_card/delete_edge）在頁上記
//   tombs = { nodes: { id: {rev, t} }, edges: {...} }，rev＝刪除落地後的 store rev。
// - incoming「新增」某卡時查墓碑：client 自報的 rev（buildState 附帶）≥ 墓碑 rev
//   ＝它見過這次刪除、仍要加回（undo 復原、跨頁搬回）→ 放行並清墓碑；
//   < 墓碑 rev（或沒帶 rev）＝陳舊快照重推 → 擋下。
// - 墓碑修剪：活卡 id 一律清除；逾 TTL 或超量修剪，防無限增長。
const TOMB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天：涵蓋「放很久的陳舊分頁」場景
const TOMB_MAX = 1000;                        // 單頁單類上限（保新去舊）

// 正規化墓碑物件（缺鍵補空表；不改動傳入物件）。
const tombsOf = (src) => ({
  nodes: { ...(src && typeof src.nodes === "object" ? src.nodes : {}) },
  edges: { ...(src && typeof src.edges === "object" ? src.edges : {}) },
});

// 修剪：逾 TTL 刪除；超過 TOMB_MAX 保留最新（rev 大者新）。回傳新物件。
export function pruneTombs(tombs, now = Date.now()) {
  const out = { nodes: {}, edges: {} };
  for (const kind of ["nodes", "edges"]) {
    const entries = Object.entries(tombs?.[kind] || {}).filter(([, v]) => {
      const ts = Date.parse(v?.t || "");
      return !Number.isNaN(ts) && now - ts <= TOMB_TTL_MS;
    });
    entries.sort((a, b) => (b[1].rev || 0) - (a[1].rev || 0));
    out[kind] = Object.fromEntries(entries.slice(0, TOMB_MAX));
  }
  return out;
}

// 有內容才值得持久化（避免每頁都掛空 tombs 造成資料檔噪音）。
export const hasTombs = (t) =>
  !!t && (Object.keys(t.nodes || {}).length > 0 || Object.keys(t.edges || {}).length > 0);

// 在頁物件上登記刪除墓碑（MCP delete_card／delete_edge 用；merge 路徑由 mergeBoard 內建）。
// rev＝本次刪除「落地後」的 store rev（mutator 內＝data.rev + 1）。
// HARE t0mb5d31 recordTombs
export function recordTombs(page, { nodeIds = [], edgeIds = [], rev = 0 } = {}, now = Date.now()) {
  const t = new Date(now).toISOString();
  const tombs = tombsOf(page.tombs);
  for (const id of nodeIds) tombs.nodes[id] = { rev, t };
  for (const id of edgeIds) tombs.edges[id] = { rev, t };
  page.tombs = pruneTombs(tombs, now);
  return page.tombs;
}

// HARE 3c9d51f7 mergeBoard
export function mergeBoard(current, incoming) {
  const cur = current && Array.isArray(current.nodes) ? current : { nodes: [], edges: [] };
  const inc = incoming || {};
  const incNodes = Array.isArray(inc.nodes) ? inc.nodes : [];
  const incEdges = Array.isArray(inc.edges) ? inc.edges : [];
  const rmN = new Set(Array.isArray(inc.removedNodeIds) ? inc.removedNodeIds : []);
  const rmE = new Set(Array.isArray(inc.removedEdgeIds) ? inc.removedEdgeIds : []);

  // 刪除守衛：client 自報世代（buildState 的 rev；沒帶＝-1，一律視為陳舊）＋既有墓碑。
  const baseRev = typeof inc.rev === "number" ? inc.rev : -1;
  const tombs = tombsOf(cur.tombs);
  const blockedN = (id) => tombs.nodes[id] && baseRev < tombs.nodes[id].rev;
  const blockedE = (id) => tombs.edges[id] && baseRev < tombs.edges[id].rev;

  const nodeById = new Map(incNodes.map((n) => [n.id, n]));
  const nodes = [];
  const seen = new Set();
  // current 順序為基底：client 見過的用 client 版；沒見過的保留；墓碑刪除
  for (const n of (cur.nodes || [])) {
    if (rmN.has(n.id)) continue;
    nodes.push(nodeById.get(n.id) || n);
    seen.add(n.id);
  }
  // client 新增的卡（current 沒有）——陳舊快照重推「已刪卡」在此擋下
  for (const n of incNodes) if (!seen.has(n.id) && !rmN.has(n.id) && !blockedN(n.id)) nodes.push(n);

  const edgeById = new Map(incEdges.map((e) => [e.id, e]));
  const edges = [];
  const seenE = new Set();
  for (const e of (cur.edges || [])) {
    if (rmE.has(e.id)) continue;
    // 端點卡被刪 → 連線一併移除
    const ids = new Set(nodes.map((n) => n.id));
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    edges.push(edgeById.get(e.id) || e);
    seenE.add(e.id);
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of incEdges) {
    if (!seenE.has(e.id) && !rmE.has(e.id) && !blockedE(e.id) && ids.has(e.source) && ids.has(e.target)) edges.push(e);
  }

  // 墓碑更新：本次刪除入墓碑（rev＝這次寫入落地後的 rev＝current.rev + 1）；
  // 活卡 id 清墓碑（undo 放行加回、或 MCP 直寫重建同 id 後不留殘碑）；再修剪。
  const nextRev = (typeof cur.rev === "number" ? cur.rev : 0) + 1;
  const now = Date.now();
  const t = new Date(now).toISOString();
  for (const id of rmN) tombs.nodes[id] = { rev: nextRev, t };
  for (const id of rmE) tombs.edges[id] = { rev: nextRev, t };
  for (const n of nodes) delete tombs.nodes[n.id];
  for (const e of edges) delete tombs.edges[e.id];

  return {
    nodes, edges,
    meta: inc.meta !== undefined ? inc.meta : (cur.meta ?? null), // 白板標題等共享中繼資料
    viewport: inc.viewport ?? cur.viewport ?? null,
    deletedEdges: Array.isArray(inc.deletedEdges) ? inc.deletedEdges : (cur.deletedEdges || []),
    constraints: Array.isArray(inc.constraints) ? inc.constraints : (cur.constraints || []),
    tombs: pruneTombs(tombs, now),
  };
}
