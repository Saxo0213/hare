import dagre from "@dagrejs/dagre"; // 排版依賴（MIT）
import { isWorkCard } from "./graph.mjs";
import { solveOverlaps } from "./collision.mjs"; // 與前端拖曳互斥共用同一求解器
import { taskCount } from "./tasks.mjs"; // tasks 現行格式＝時間戳 dict；高度估算與資料層同一真相

// HARE 卡片自動排版（add_card 省略 x/y 時的自動落格）。
// 依循 skill hare-card-layout（分層 layered/Sugiyama 格線）與 hare-nested-architecture
// （容器子畫布垂直堆疊）。核心口訣：欄＝依賴深度（左→右），列＝同層並列（上→下）。
//
// add_card 在 x/y 皆省略時增量落格；add_cards 則先建完整關係，再以 layoutCreatedBatch
// 對本批自動卡做分層排版。任一座標明示的卡都視為人工定位，不由自動排版移動。

// ---- 格線常數（勿隨意更動）----
export const X0 = 60;                 // 首欄（第 0 層）左緣 x
export const Y0 = 60;                 // 首列上緣 y
export const COL_PITCH = 460;         // 相鄰兩層 x 間距
export const CARD_W = 360;            // 標準卡寬（水平間隙 = 460−360 = 100）
export const ROW_PITCH = 340;         // 同層相鄰兩列 y 間距（一般卡）
export const ROW_PITCH_TALL = 560;    // 前一張是「內容多」卡時改用（skill §4）

// ---- 容器子畫布（巢狀）常數（skill hare-nested-architecture §2）----
export const CHILD_X = 16;            // 子卡左緣（<8 會被前端拉回）
export const CHILD_Y0 = 60;           // 第一張子卡 y（前端量測 childTop 後整組平移對齊）
export const CHILD_PITCH = 90;        // 子卡垂直堆疊間距

/* ---------- 每專案格線設定（排版常數納入每專案設定） ----------
 * 白板 meta.layout 可逐鍵覆寫上列常數（鍵名小駝峰）；未設＝預設值，完全向後相容。
 * 只收有限數字，型別不對的鍵靜默落回預設（設定壞了不至於讓 add_card 掛掉）。
 * HARE 9r1dcf6a gridOf */
const GRID_DEFAULTS = {
  x0: X0, y0: Y0, colPitch: COL_PITCH, cardW: CARD_W,
  rowPitch: ROW_PITCH, rowPitchTall: ROW_PITCH_TALL,
  childX: CHILD_X, childY0: CHILD_Y0, childPitch: CHILD_PITCH,
};
export function gridOf(meta) {
  const src = meta && typeof meta.layout === "object" ? meta.layout : null;
  if (!src) return GRID_DEFAULTS;
  const out = { ...GRID_DEFAULTS };
  for (const k of Object.keys(GRID_DEFAULTS)) {
    if (Number.isFinite(src[k])) out[k] = src[k];
  }
  return out;
}

// 路線圖 DAG 的分層對象＝工作卡（沿 graph.mjs isWorkCard 慣例：status=note 的說明卡不入層）。

// 「內容多卡」判定（skill §4）：tasks ≥ 4、或 desc 超過約 120 字、
// 或 desc 與 tasks 皆有 → 下一張改用 ROW_PITCH_TALL（寧可高估留白）。
export function isTall(node) {
  const d = node?.data || {};
  const tasks = taskCount(d.tasks);
  const descLen = String(d.desc || "").length;
  if (tasks >= 4) return true;
  if (descLen > 120) return true;
  if (descLen > 0 && tasks > 0) return true;
  return false;
}

// 有向圖最長路徑分層的單一機制：先以 Tarjan 將環壓成 SCC，再在 condensation DAG
// 上跑拓樸最長路徑。如此每條跨 SCC 邊都嚴格 source.layer < target.layer；環內節點
// 同層（有向環不可能全部左→右）。遍歷與 queue 皆按 id 排序，輸出不受輸入陣列順序影響。
function longestPathRanks(ids, edges) {
  const ordered = [...ids].sort((a, b) => String(a).localeCompare(String(b)));
  const idSet = new Set(ordered);
  const out = new Map(ordered.map((id) => [id, []]));
  for (const e of edges || []) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
    out.get(e.source).push(e.target);
  }
  for (const list of out.values()) list.sort((a, b) => String(a).localeCompare(String(b)));

  let nextIndex = 0;
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), comps = [];
  const visit = (id) => {
    index.set(id, nextIndex); low.set(id, nextIndex); nextIndex += 1;
    stack.push(id); onStack.add(id);
    for (const to of out.get(id)) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id), low.get(to))); }
      else if (onStack.has(to)) low.set(id, Math.min(low.get(id), index.get(to)));
    }
    if (low.get(id) !== index.get(id)) return;
    const comp = [];
    while (stack.length) {
      const top = stack.pop(); onStack.delete(top); comp.push(top);
      if (top === id) break;
    }
    comp.sort((a, b) => String(a).localeCompare(String(b)));
    comps.push(comp);
  };
  ordered.forEach((id) => { if (!index.has(id)) visit(id); });

  const compOf = new Map();
  comps.forEach((comp, ci) => comp.forEach((id) => compOf.set(id, ci)));
  const dag = comps.map(() => new Set()), indeg = comps.map(() => 0);
  for (const e of edges || []) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    const a = compOf.get(e.source), b = compOf.get(e.target);
    if (a === b || dag[a].has(b)) continue;
    dag[a].add(b); indeg[b] += 1;
  }
  const compKey = (ci) => String(comps[ci][0]);
  const ready = comps.map((_, ci) => ci).filter((ci) => indeg[ci] === 0)
    .sort((a, b) => compKey(a).localeCompare(compKey(b)));
  const rank = comps.map(() => 0);
  while (ready.length) {
    const ci = ready.shift();
    const next = [...dag[ci]].sort((a, b) => compKey(a).localeCompare(compKey(b)));
    for (const to of next) {
      rank[to] = Math.max(rank[to], rank[ci] + 1);
      indeg[to] -= 1;
      if (indeg[to] === 0) {
        ready.push(to);
        ready.sort((a, b) => compKey(a).localeCompare(compKey(b)));
      }
    }
  }
  return new Map(ordered.map((id) => [id, rank[compOf.get(id)]]));
}

// 依賴深度分層：只取工作卡與兩端都在集內的邊；回傳 Map<id, layer>。
export function computeLayers(nodes, edges) {
  const cards = (nodes || []).filter(isWorkCard);
  return longestPathRanks(cards.map((n) => n.id), edges);
}

// 頂層卡自動落格：一張剛用 add_card 建立的卡片尚無任何 edge（依賴線事後才 add_edge），
// 故其依賴深度＝0 → 落最左欄（skill §2「無 incoming edge → layer 0」；亦即泳道最左的
// 下一個空列）。x 固定 X0；y＝掃描「視覺上落在該欄」的既有頂層卡，取最低者下方一個列距。
//
// 「同欄」以水平重疊判定（|x − X0| < CARD_W ＝ 會與新卡橫向相疊），比純依賴分層更能
// 直接避免重疊——不論既有卡是被手動拖到哪、computeLayers 給它幾層。該欄無卡 → y = Y0。
export function placeTopLevel(nodes, edges, grid = GRID_DEFAULTS) {
  void edges; // computeLayers 供未來擴充；新卡無邊＝layer 0，此處以欄位帶(x)直接避重疊
  const layer = 0;
  const x = grid.x0 + layer * grid.colPitch;
  const inColumn = (nodes || []).filter((n) =>
    n.type !== "lane" && !n.parentId && n.position &&
    Math.abs((n.position.x ?? 0) - x) < grid.cardW);
  if (inColumn.length === 0) return { x, y: grid.y0 };
  let lowest = inColumn[0];
  for (const n of inColumn) {
    if ((n.position.y ?? 0) > (lowest.position.y ?? 0)) lowest = n;
  }
  const pitch = isTall(lowest) ? grid.rowPitchTall : grid.rowPitch;
  return { x, y: (lowest.position.y ?? grid.y0) + pitch };
}

// 子卡（parentId 已解析）自動落格：x 固定 CHILD_X；y 取所有兄弟的「實際底緣＋16px」
// 與舊格線步距 childPitch 的較大值。未量測的一般卡以 childPitch−16 估高，保持舊版
// 90px 步距；高內容卡保守估 480px。這避免動態高度卡只看 top y 而互相重疊。
export function placeChild(nodes, parentId, grid = GRID_DEFAULTS) {
  const siblings = (nodes || []).filter((n) => n.parentId === parentId && n.position);
  if (siblings.length === 0) return { x: grid.childX, y: grid.childY0 };
  const GAP = 16;
  let nextY = -Infinity;
  for (const n of siblings) {
    const y = n.position.y ?? 0;
    const fallbackH = isTall(n) ? 480 : Math.max(1, grid.childPitch - GAP);
    const h = n.measured?.height || n.height || fallbackH;
    nextY = Math.max(nextY, y + grid.childPitch, y + h + GAP);
  }
  return { x: grid.childX, y: nextY };
}

// 重排可以把鎖定卡納入關係與碰撞計算，但套用結果前必須把它們恢復成鎖定前的位置。
// 回傳新 Map，不修改演算法原結果或節點。
export function preserveLockedPositions(pos, nodes) {
  const out = new Map(pos);
  for (const n of nodes || []) {
    if (n.data?.locked === true && n.position && out.has(n.id)) {
      out.set(n.id, { x: n.position.x, y: n.position.y });
    }
  }
  return out;
}

// add_cards 的批次排版入口：只移動「本批建立且未明示座標」的卡；既有卡、locked 卡與
// 明示 x/y 的新卡都是固定邊界。每個 parentId 是獨立座標系，必須各自排版；完整 edges
// 建好後才呼叫，讓批內關係真正決定左右層級。結果只回 Map，由呼叫端在同一 mutate 套用。
//
// 為避免批次新增擾動既有版面，新子圖會落在同層既有卡的下方；若它與固定卡有
// incoming/outgoing edge，再整組水平平移，使固定 source 在左、固定 target 在右。
// HARE 4batchlay layoutCreatedBatch
export function layoutCreatedBatch(nodes, edges, createdIds, explicitIds = [], grid = GRID_DEFAULTS) {
  const created = new Set(createdIds || []);
  const explicit = new Set(explicitIds || []);
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const movable = (nodes || []).filter((n) =>
    created.has(n.id) && !explicit.has(n.id) && n.data?.locked !== true);
  const result = new Map();
  if (!movable.length) return result;

  const sizeOf = (n) => ({
    w: n.measured?.width || n.width || grid.cardW,
    h: n.measured?.height || n.height || (isTall(n) ? 480 : 240),
  });
  const parentKey = (n) => n.parentId || "";
  const groups = new Map();
  for (const n of movable) {
    const key = parentKey(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }

  for (const key of [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
    const group = groups.get(key);
    const ids = new Set(group.map((n) => n.id));
    const fixed = (nodes || []).filter((n) =>
      parentKey(n) === key && !ids.has(n.id) && n.type !== "lane" && n.position);
    let y0 = key ? grid.childY0 : grid.y0;
    if (fixed.length) {
      y0 = Math.max(...fixed.map((n) => (n.position.y || 0) + sizeOf(n).h)) + (key ? 16 : 40);
    }
    const x0 = key ? grid.childX : grid.x0;
    const items = group.map((n) => ({ id: n.id, ...sizeOf(n) }));
    const inner = (edges || []).filter((e) => ids.has(e.source) && ids.has(e.target));
    const { pos } = layoutLayered(items, inner, {
      x0, y0,
      ranksep: Math.max(60, grid.colPitch - grid.cardW),
      nodesep: key ? 26 : 56,
      compsep: key ? 60 : 100,
    });

    // 與同座標系固定端點相連時，整批水平校準到正確方向；不移動固定端點。
    let minDx = -Infinity, maxDx = Infinity;
    for (const e of edges || []) {
      const source = byId.get(e.source);
      const target = byId.get(e.target);
      if (!source || !target || parentKey(source) !== key || parentKey(target) !== key) continue;
      const sourceMovable = ids.has(source.id), targetMovable = ids.has(target.id);
      if (sourceMovable === targetMovable) continue;
      const gap = Math.max(40, grid.colPitch - grid.cardW);
      if (!sourceMovable && targetMovable && source.position) {
        const need = source.position.x + sizeOf(source).w + gap - pos.get(target.id).x;
        minDx = Math.max(minDx, need);
      } else if (sourceMovable && !targetMovable && target.position) {
        const allowed = target.position.x - gap - (pos.get(source.id).x + sizeOf(source).w);
        maxDx = Math.min(maxDx, allowed);
      }
    }
    let dx = 0;
    if (minDx !== -Infinity && maxDx !== Infinity && minDx > maxDx) dx = minDx;
    else {
      if (minDx !== -Infinity) dx = Math.max(dx, minDx);
      if (maxDx !== Infinity) dx = Math.min(dx, maxDx);
    }
    for (const n of group) {
      const p = pos.get(n.id);
      result.set(n.id, { x: Math.round(p.x + dx), y: Math.round(p.y) });
    }
  }
  return result;
}

// 線段與矩形相交判定（Liang-Barsky 裁剪）。r = {x, y, w, h}。
function segHitsRect(x1, y1, x2, y2, r) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - r.x) && clip(dx, r.x + r.w - x1) &&
         clip(-dy, y1 - r.y) && clip(dy, r.y + r.h - y1);
}

/* ---------- 端點側定案＋線段近似（共用機制）----------
 * 「排版避的線＝畫出來的線」的唯一真相：與 doRelayoutContainer 的 handleFor 同一套規則
 * ——對齊/緩斜（垂直偏移 ≤ 沿線淨距）＝對向直連（facing）；會扭轉＝轉角對（corner，
 * 度數高的一端接左右、另一端接上下），但彎位 (V.x, H.y) 必須在兩卡緣外，否則退回對向直連。
 * 三處共用同一份原語：檢討用的線必須等於畫出來的線，否則分層重排會漏掉線段通道。
 * centerOf(id)→中心 {x,y}；dims.get(id)→{w,h}；deg.get(id)→連線數。 */
// HARE 5e9c4a11 channelPrimitives（classifySide／edgeSegs／segHitsRect 共用線段通道原語）
function classifySide(e, centerOf, dims, deg) {
  const s = centerOf(e.source), t = centerOf(e.target);
  const sd = dims.get(e.source), td = dims.get(e.target);
  const dx = t.x - s.x, dy = t.y - s.y, adx = Math.abs(dx), ady = Math.abs(dy);
  const vertical = ady >= adx;
  const perp = vertical ? adx : ady;
  const along = vertical ? ady - (sd.h + td.h) / 2 : adx - (sd.w + td.w) / 2;
  const [fs, ft] = vertical ? (dy >= 0 ? ["b", "t"] : ["t", "b"]) : (dx >= 0 ? ["r", "l"] : ["l", "r"]);
  if (perp <= Math.max(8, along)) return { kind: "facing", ss: fs, ts: ft };
  const srcHoriz = (deg.get(e.source) || 0) > (deg.get(e.target) || 0);
  const [V, Vd, H, Hd] = srcHoriz ? [t, td, s, sd] : [s, sd, t, td];
  if (!(Math.abs(V.x - H.x) > Hd.w / 2 + 12 && Math.abs(H.y - V.y) > Vd.h / 2 + 12))
    return { kind: "facing", ss: fs, ts: ft };
  return srcHoriz
    ? { kind: "corner", srcHoriz, ss: dx >= 0 ? "r" : "l", ts: dy >= 0 ? "t" : "b" }
    : { kind: "corner", srcHoriz, ss: dy >= 0 ? "b" : "t", ts: dx >= 0 ? "l" : "r" };
}
// 卡緣把手座標（p＝中心、d＝{w,h}、side＝l/r/t/b）
const handleAt = (p, d, side) =>
  side === "l" ? [p.x - d.w / 2, p.y] : side === "r" ? [p.x + d.w / 2, p.y]
    : side === "t" ? [p.x, p.y - d.h / 2] : [p.x, p.y + d.h / 2];
// 依定案端點側取線段近似：facing 一段（把手到把手）、corner L 兩段（把手→彎位→把手）
function edgeSegs(e, cls, centerOf, dims) {
  const s = centerOf(e.source), t = centerOf(e.target);
  if (!s || !t || !cls) return [];
  const a = handleAt(s, dims.get(e.source), cls.ss), b = handleAt(t, dims.get(e.target), cls.ts);
  if (cls.kind === "facing") return [[a[0], a[1], b[0], b[1]]];
  const [vP, hP] = cls.srcHoriz ? [b, a] : [a, b];       // srcHoriz＝source 接左右、target 接上下
  return [[vP[0], vP[1], vP[0], hP[1]], [vP[0], hP[1], hP[0], hP[1]]];
}

/* ---------- 分層自動排版（二版：包裝 dagre）----------
 *引入 @dagrejs/dagre（MIT）為 runtime 依賴（鐵律 1 例外條款）。
 * 分工：欄座標／減交叉＝dagre（Sugiyama 成熟實作，rankdir LR）；
 *       連通元件切分＋shelf packing＝自己做（dagre 沒有——不相連節點會全落 rank 0
 *       疊成一長條 1380×6580；打包後 2996×2930 近方形）。
 * 注意 dagre 回「中心點」座標，須減半寬高轉 React Flow 的左上角（skill react-flow-layout）。
 * 用途：analyze_codebase 頂層容器依 import 依賴 DAG 排欄；任何 items+edges 皆可用。 */
// HARE 5u91y4ma layoutLayered
export function layoutLayered(items, edges, opts = {}) {
  const ranksep = opts.ranksep ?? 140; // 欄距（dagre 慣例 50–100；容器板放大）
  const nodesep = opts.nodesep ?? 70;  // 同欄節點距
  const edgesep = opts.edgesep ?? 40;  // 過境線通道寬（dagre 虛擬節點間距；預設 10 太擠，
                                       // 放大＝跨欄長線經過的欄位會把卡片推開讓出走廊）
  const compsep = opts.compsep ?? 120; // 不相連元件間距
  const x0 = opts.x0 ?? X0, y0 = opts.y0 ?? Y0;
  const byId = new Map(items.map((it) => [it.id, it]));
  const nbrs = new Map(items.map((it) => [it.id, []]));
  const realEdges = (edges || []).filter((e) =>
    byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
  realEdges.forEach((e) => {
    nbrs.get(e.source).push(e.target);
    nbrs.get(e.target).push(e.source);
  });

  // ⓪ 連通元件切分（dagre 缺、ELK 才有的行為）
  const compOf = new Map();
  let compN = 0;
  for (const it of items) {
    if (compOf.has(it.id)) continue;
    const q = [it.id];
    compOf.set(it.id, compN);
    while (q.length) {
      const cur = q.shift();
      for (const nb of nbrs.get(cur)) {
        if (!compOf.has(nb)) { compOf.set(nb, compN); q.push(nb); }
      }
    }
    compN += 1;
  }
  const comps = Array.from({ length: compN }, () => []);
  items.forEach((it) => comps[compOf.get(it.id)].push(it));

  // ① 單一元件交給 dagre（LR 左→右）；輸出正規化為相對 (0,0) 的左上角座標。
  //    邊路徑（卡壓線修正）：dagre 用虛擬節點為跨欄長線保留通道並回傳
  //    edge.points——一併正規化帶出，線沿通道走、不穿中間欄的卡片。
  const layoutComponent = (compItems) => {
    const idSet = new Set(compItems.map((it) => it.id));
    const compEdges = realEdges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep, ranksep, edgesep, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    compItems.forEach((it) => g.setNode(it.id, { width: it.w || 300, height: it.h || 100 }));
    compEdges.forEach((e) => g.setEdge(e.source, e.target));
    dagre.layout(g);
    const dim = new Map(compItems.map((it) => [it.id, { w: it.w || 300, h: it.h || 100 }]));
    const pos = new Map();
    compItems.forEach((it) => {
      const n = g.node(it.id);
      const d = dim.get(it.id);
      pos.set(it.id, { x: n.x - d.w / 2, y: n.y - d.h / 2 }); // 中心點→左上角
    });

    // 卡片避線（幾何感知； 通道檢討補齊）：dagre 同
    // rank 卡片排同一直欄不是硬約束——線擦過中間卡片時，把被壓的卡片移開（排版只動
    // 卡片，不彎折線段）。線形近似＝classifySide/edgeSegs 定案的端點側（與 handleFor
    // 同一套；corner L 形兩段都查——單直線近似查不到轉角折腳，重排就會漏掉線段通道。
    // 每輪開頭重定案（位置變、側跟著變）；收斂那輪
    // 的側＝畫出來的側，隨 sides 回傳呼叫端沿用。位移候選同時給水平（清垂直線）與
    // 垂直（清水平線）——成本 dx+2|dy| 低者先試；移動後幾何再變，迭代數輪收斂。
    const MARGIN = 12;                                  // 線離卡緣的安全距
    const STEP = 16;                                    // 位移試探步長
    const MAXX = Math.max(Math.round(ranksep * 3), 200); // 右移上限（撞卡檢查另擋竄欄）
    const MAXY = Math.max(Math.round(nodesep * 2), 96);  // 垂直位移上限（清水平線需夠大）
    // 位移候選：向右為主（延續 dagre 動線＋「讓走廊」哲學、cascade 只補右欄），
    // 垂直放寬到能整個穿過一張卡（清水平線）。向右優先、垂直次之（成本 dx＋2|dy|）。
    const cands = [];
    for (let dx = 0; dx <= MAXX; dx += STEP) {
      for (let dy = -MAXY; dy <= MAXY; dy += STEP) {
        if (dx > 0 || dy !== 0) cands.push([dx, dy, dx + 2 * Math.abs(dy)]);
      }
    }
    cands.sort((a, b) => a[2] - b[2]);
    // ② 端點側定案（classifySide 共用機制）：每輪重算一次；deg＝連線數（corner 的
    //    水平側給度數高的一端，與 App handleFor 的 degIn 同義）
    const degC = new Map();
    for (const e of compEdges) {
      degC.set(e.source, (degC.get(e.source) || 0) + 1);
      degC.set(e.target, (degC.get(e.target) || 0) + 1);
    }
    const centerOf = (id) => {
      const p = pos.get(id), d = dim.get(id);
      return p && d ? { x: p.x + d.w / 2, y: p.y + d.h / 2 } : null;
    };
    let sideOf = new Map();
    const reclassify = () => {
      sideOf = new Map(compEdges.map((e) => [e, classifySide(e, centerOf, dim, degC)]));
    };
    const clearAt = (id, x, y) => {                     // 該卡放在 (x,y) 時無線壓過？
      const d = dim.get(id);
      const rect = { x: x - MARGIN, y: y - MARGIN, w: d.w + MARGIN * 2, h: d.h + MARGIN * 2 };
      for (const e of compEdges) {
        if (e.source === id || e.target === id) continue;
        for (const sg of edgeSegs(e, sideOf.get(e), centerOf, dim)) {
          if (segHitsRect(sg[0], sg[1], sg[2], sg[3], rect)) return false;
        }
      }
      return true;
    };
    const cardClash = (id, x, y) => {                   // 該卡放在 (x,y) 時撞到別張卡？
      const d = dim.get(id);
      for (const o of compItems) {
        if (o.id === id) continue;
        const op = pos.get(o.id), od = dim.get(o.id);
        if (x < op.x + od.w + STEP && op.x < x + d.w + STEP &&
            y < op.y + od.h + STEP && op.y < y + d.h + STEP) return true;
      }
      return false;
    };
    const dodgePass = () => {
      let moved = false;
      for (const it of compItems) {
        const p = pos.get(it.id);
        if (clearAt(it.id, p.x, p.y)) continue;
        for (const [dx, dy] of cands) {
          const nx = p.x + dx, ny = p.y + dy;
          if (cardClash(it.id, nx, ny)) continue;
          if (clearAt(it.id, nx, ny)) { pos.set(it.id, { x: nx, y: ny }); moved = true; break; }
        }
      }
      return moved;
    };

    // 位移連鎖（下一層的卡片要配合調整、一路檢討過去）：
    // 右移的卡片會吃掉與下一欄之間的走廊，故每輪位移後由左至右逐欄檢討——
    // 前面所有卡的最右緣＋ranksep 超過本欄左緣時，本欄整欄右移補回走廊，
    // 連鎖推到最右欄。LR 下同 rank 節點共用 dagre 中心 x，以此分欄。
    const centers = [...new Set(compItems.map((it) => Math.round(g.node(it.id).x)))].sort((a, b) => a - b);
    const rankOf = new Map(compItems.map((it) =>
      [it.id, centers.findIndex((c) => Math.abs(c - Math.round(g.node(it.id).x)) < 2)]));
    const cascadePass = () => {
      let any = false;
      let prevMaxRight = -Infinity;
      for (let r = 0; r < centers.length; r++) {
        const members = compItems.filter((it) => rankOf.get(it.id) === r);
        if (!members.length) continue;
        const colLeft = Math.min(...members.map((it) => pos.get(it.id).x));
        if (prevMaxRight > -Infinity) {
          const deficit = prevMaxRight + ranksep - colLeft;
          if (deficit > 0) {
            members.forEach((it) => { pos.get(it.id).x += deficit; });
            any = true;
          }
        }
        prevMaxRight = Math.max(prevMaxRight,
          ...members.map((it) => pos.get(it.id).x + dim.get(it.id).w));
      }
      return any;
    };

    // ③ 轉角淨空（radial ④③ 同款， 移植）：轉角線的彎位要轉得開——
    //    垂直端中線讓過水平端上下緣、水平端中線讓過垂直端左右緣＋CLEAR，
    //    不足沿該軸推開（面積＝可動性，大卡多讓）。
    const CLEAR = Math.max(24, nodesep * 0.5);
    const moveBy = (id, ddx, ddy) => { const p = pos.get(id); pos.set(id, { x: p.x + ddx, y: p.y + ddy }); };
    const cornerPass = () => {
      let any = false;
      for (const e of compEdges) {
        const cls = sideOf.get(e);
        if (!cls || cls.kind !== "corner") continue;
        const [Vi, Hi] = cls.srcHoriz ? [e.target, e.source] : [e.source, e.target];
        const Vd = dim.get(Vi), Hd = dim.get(Hi);
        const mv = Vd.w * Vd.h, mh = Hd.w * Hd.h, tot = mv + mh;
        let V = centerOf(Vi), H = centerOf(Hi);
        const defY = Vd.h / 2 + CLEAR - Math.abs(H.y - V.y);
        if (defY > 0) {
          const st = Math.min(defY, 40), dv = Math.sign(V.y - H.y) || -1;
          moveBy(Vi, 0, dv * st * (mv / tot)); moveBy(Hi, 0, -dv * st * (mh / tot));
          any = true; V = centerOf(Vi); H = centerOf(Hi);
        }
        const defX = Hd.w / 2 + CLEAR - Math.abs(V.x - H.x);
        if (defX > 0) {
          const st = Math.min(defX, 40), dv = Math.sign(V.x - H.x) || 1;
          moveBy(Vi, dv * st * (mv / tot), 0); moveBy(Hi, -dv * st * (mh / tot), 0);
          any = true;
        }
      }
      return any;
    };
    // 轉角淨空推出的重疊就地攤開（AABB 最小穿透軸；dagre 原始版面無重疊，只收拾③的推擠）
    const collidePass = () => {
      let moved = false;
      for (let i = 0; i < compItems.length; i++) {
        for (let j = i + 1; j < compItems.length; j++) {
          const a = compItems[i].id, b = compItems[j].id;
          const ca = centerOf(a), cb = centerOf(b), da = dim.get(a), db = dim.get(b);
          const ox = (da.w + db.w) / 2 + STEP - Math.abs(ca.x - cb.x);
          const oy = (da.h + db.h) / 2 + STEP - Math.abs(ca.y - cb.y);
          if (ox > 0 && oy > 0) {
            const wa = da.w * da.h, wb = db.w * db.h, tot = wa + wb || 1;
            if (ox <= oy) {
              const s = ca.x < cb.x ? -ox : ox;
              moveBy(a, s * (wa / tot), 0); moveBy(b, -s * (wb / tot), 0);
            } else {
              const s = ca.y < cb.y ? -oy : oy;
              moveBy(a, 0, s * (wa / tot)); moveBy(b, 0, -s * (wb / tot));
            }
            moved = true;
          }
        }
      }
      return moved;
    };

    // 主迴圈（radial ④ 同款）：①碰撞（dagre 保證＋③後攤開）
    // → ②端點側（每輪重定案）→ ③線段通道（避線 dodge＋轉角淨空＋位移連鎖）。
    // 收斂那輪（無任何移動）＝定案側與最終位置一致。
    for (let round = 0; round < 6; round++) {
      reclassify();
      const moved = dodgePass();
      const eased = cornerPass();
      let collided = false;
      for (let i = 0; i < 30; i++) { if (!collidePass()) break; collided = true; }
      const shifted = cascadePass();
      if (!moved && !eased && !collided && !shifted) break;
    }
    reclassify(); // 最終定案＝回傳給呼叫端畫線的側（未收斂時盡力值）

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of compItems) {
      const p = pos.get(it.id), d = dim.get(it.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + d.w); maxY = Math.max(maxY, p.y + d.h);
    }
    for (const [id, p] of pos) pos.set(id, { x: p.x - minX, y: p.y - minY });
    const routes = new Map(); // `${source}->${target}` → [{x,y}…]（同一座標系）
    g.edges().forEach((ek) => {
      const pts = (g.edge(ek)?.points || []).map((p) => ({ x: p.x - minX, y: p.y - minY }));
      if (pts.length) routes.set(`${ek.v}->${ek.w}`, pts);
    });
    return { pos, routes, sides: sideOf, w: maxX - minX, h: maxY - minY };
  };

  // ② 元件 shelf packing：大元件在前，往右擺、超過目標寬換列（近 16:9 視覺）
  const laid = comps.map(layoutComponent);
  const totalArea = laid.reduce((s, c) => s + (c.w + compsep) * (c.h + compsep), 0);
  const targetW = Math.max(Math.sqrt(totalArea * 1.9), ...laid.map((c) => c.w));
  const order = [...laid].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const out = new Map();
  const outRoutes = new Map();
  // 端點側定案彙整（通道檢討補齊）：鍵 `${source}|${target}`＝與 radial 回傳
  // 同一格式，呼叫端（doRelayoutContainer）直接沿用＝排版避的線就是畫出來的線。
  const outSides = new Map();
  let px = 0, py = 0, rowH = 0;
  for (const c of order) {
    if (px > 0 && px + c.w > targetW) { px = 0; py += rowH + compsep; rowH = 0; }
    for (const [id, p] of c.pos) out.set(id, { x: Math.round(x0 + px + p.x), y: Math.round(y0 + py + p.y) });
    for (const [k, pts] of c.routes) outRoutes.set(k, pts.map((p) => ({ x: Math.round(x0 + px + p.x), y: Math.round(y0 + py + p.y) })));
    for (const [e, cls] of c.sides) outSides.set(`${e.source}|${e.target}`, { ss: cls.ss, ts: cls.ts });
    px += c.w + compsep;
    rowH = Math.max(rowH, c.h);
  }
  return { pos: out, routes: outRoutes, sides: outSides };
}

/* ---------- 放射佈局（中心發散、hub-and-spoke）----------
 * 分層（dagre）是「主幹鋪成直線」的家族，做不出放射狀。這裡另做一套：
 *   ① hub＝連線最多的卡（同分取面積最大——中央大圖優先）置中心。
 *   ② BFS 樹分環：與 hub 的距離＝第幾圈；每圈半徑遞增、且至少容納該圈卡片周長。
 *   ③ 角度依「子樹葉數」遞迴切分（radial tree），子節點聚在父節點的角度扇形內
 *      ——同一分支的卡呈放射狀集中，不同分支散開，減少交叉。
 *   ④ 未連通的卡放最外圈平均分佈。
 * 端點側由呼叫端（doRelayoutContainer）依最終位置重配＝線從各自那一側直接連中心。
 * HARE 5rad1a1z layoutRadial */
export function layoutRadial(items, edges, opts = {}) {
  const x0 = opts.x0 ?? X0, y0 = opts.y0 ?? Y0;
  const gap = opts.gap ?? 44;                 // 卡與卡之間的最小間隙（緊湊度主旋鈕）
  if (!items.length) return { pos: new Map() };
  const byId = new Map(items.map((it) => [it.id, it]));
  const nbrs = new Map(items.map((it) => [it.id, []]));
  (edges || []).forEach((e) => {
    if (byId.has(e.source) && byId.has(e.target) && e.source !== e.target) {
      nbrs.get(e.source).push(e.target);
      nbrs.get(e.target).push(e.source);
    }
  });
  // ① hub：指定 hubId（錨卡放射）優先；否則 degree 最高、同分取面積最大
  let hub = (opts.hubId && byId.get(opts.hubId)) || items[0];
  if (!opts.hubId || !byId.get(opts.hubId)) {
    for (const it of items) {
      const d = nbrs.get(it.id).length, dh = nbrs.get(hub.id).length;
      if (d > dh || (d === dh && (it.w * it.h) > (hub.w * hub.h))) hub = it;
    }
  }
  // ② BFS 樹（記 parent 與 tree edge 供跨邊降層）
  const depth = new Map([[hub.id, 0]]);
  const parent = new Map();
  const children = new Map(items.map((it) => [it.id, []]));
  const key2 = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const treeEdge = new Set();
  const q = [hub.id];
  while (q.length) {
    const cur = q.shift();
    for (const nb of nbrs.get(cur)) {
      if (!depth.has(nb)) {
        depth.set(nb, depth.get(cur) + 1);
        parent.set(nb, cur);
        children.get(cur).push(nb);
        treeEdge.add(key2(cur, nb));
        q.push(nb);
      }
    }
  }
  const disconnected = items.filter((it) => !depth.has(it.id)).map((it) => it.id);
  // 子樹葉數（角度權重）——重算函數（降層改動樹後要清 memo 重算）
  let leaves = new Map();
  const leafCount = (id) => {
    if (leaves.has(id)) return leaves.get(id);
    const ch = children.get(id);
    const v = ch.length ? ch.reduce((s, c) => s + leafCount(c), 0) : 1;
    leaves.set(id, v); return v;
  };
  leafCount(hub.id);
  // ②b 跨邊降層：兩個相連節點被 BFS 分到同一層＝跨邊（線繞）。
  //     把「子樹較大」的那個降為對方的子節點——大叢集掛外圍、跨邊變樹邊，減少交纏。
  const isDesc = (root, x) => { let c = x; while (c != null) { if (c === root) return true; c = parent.get(c); } return false; };
  const shiftDepth = (root, d) => { // 重設 root 子樹深度（BFS 掃）
    const st = [root]; depth.set(root, d);
    while (st.length) { const c = st.pop(); for (const ch of children.get(c)) { depth.set(ch, depth.get(c) + 1); st.push(ch); } }
  };
  let reparented = false;
  for (const nb of nbrs.keys()) {
    for (const other of nbrs.get(nb)) {
      if (nb >= other) continue;                       // 每條無向邊處理一次
      if (treeEdge.has(key2(nb, other))) continue;     // 樹邊不動
      if (!depth.has(nb) || !depth.has(other)) continue;
      if (depth.get(nb) !== depth.get(other)) continue; // 只處理同層跨邊
      let big = leafCount(nb) >= leafCount(other) ? nb : other;
      let small = big === nb ? other : nb;
      if (isDesc(big, small)) { const t = big; big = small; small = t; } // 避免把祖先掛到後代
      if (isDesc(big, small)) continue;                // 仍成環＝跳過
      // big 改掛到 small 底下
      const oldP = parent.get(big);
      if (oldP != null) children.set(oldP, children.get(oldP).filter((c) => c !== big));
      parent.set(big, small);
      children.get(small).push(big);
      treeEdge.add(key2(big, small));
      shiftDepth(big, depth.get(small) + 1);
      reparented = true;
    }
  }
  if (reparented) { leaves = new Map(); leafCount(hub.id); } // 樹改了→重算葉數
  const halfOf = (it) => Math.max(it.w, it.h) / 2;
  // ③ 氣球式局部放射（重寫，W2→W4 研究定案）：
  //    角度改按「角寬需求」分（＝卡/子樹的切向尺寸在其貼緊半徑的張角），不按葉數——
  //    巨卡與大子樹先天佔大角、鋪滿整圈；葉卡角需求小、貼緊填縫。
  //    步長＝貼緊（父半徑＋子半徑＋gap）；只有「分到的角裝不下切向尺寸」才外推
  //    （小卡守內圈、大卡自然浮外）。pos 存中心座標（hub 於原點）。
  const pos = new Map([[hub.id, { x: 0, y: 0 }]]);
  const dirOf = new Map();
  const tangOf = (id) => Math.max(byId.get(id).w, byId.get(id).h); // 切向尺寸近似（不知朝向取大邊）
  // 子樹扇寬＝自身切向尺寸 vs 直屬小孩扇寬總和，取大者（子樹要多寬的「傘面」）
  const fanW = new Map();
  const fanWidth = (id) => {
    if (fanW.has(id)) return fanW.get(id);
    const ch = children.get(id);
    const own = tangOf(id) + gap;
    const v = ch.length ? Math.max(own, ch.reduce((s, c) => s + fanWidth(c), 0)) : own;
    fanW.set(id, v); return v;
  };
  const place = (id, sectorHalf) => {
    const ch = children.get(id);
    if (!ch.length) return;
    const p = pos.get(id);
    const isHub = id === hub.id;
    const base = isHub ? 0 : dirOf.get(id);
    const full = isHub ? 2 * Math.PI : Math.min(2 * sectorHalf, Math.PI * 0.85); // 深層扇形上限，避免包一圈
    const parentHalf = halfOf(byId.get(id));
    // 每個孩子：貼緊步長＋角寬需求（傘面寬 / 貼緊半徑＝張角）
    const need = ch.map((c) => {
      const tight = parentHalf + halfOf(byId.get(c)) + gap;
      return { c, tight, ang: Math.min(full, fanWidth(c) / tight) };
    });
    const totalNeed = need.reduce((s, n) => s + n.ang, 0) || 1;
    let a = base - full / 2;
    for (const n of need) {
      const span = full * (n.ang / totalNeed);
      const ang = a + span / 2;
      // 一律貼緊就位（「先排小的再排大的，配碰撞檢查，大的托在外面」）：
      // 角度縫裝不下的不外推去遠圈，交給 ④ 碰撞解算把卡橫向攤開/托出
      // （形狀＝子卡在父卡外側攤成一排貼著，不是更遠的同心圓）。
      const step = n.tight;
      pos.set(n.c, { x: p.x + step * Math.cos(ang), y: p.y + step * Math.sin(ang) });
      dirOf.set(n.c, ang);
      place(n.c, span / 2);
      a += span;
    }
  };
  place(hub.id, Math.PI);
  // 未連通（改）：不上大外圈——當 hub 的葉卡處理，塞進 hub 小孩之間
  // 「最大的角度縫」、貼緊半徑就位（擠了同樣交給碰撞攤開），版面才不會被撐大。
  if (disconnected.length) {
    const used = children.get(hub.id).map((c) => dirOf.get(c)).sort((m, n) => m - n);
    let g0 = 0, gLen = 2 * Math.PI;                        // 沒有小孩＝整圈都是縫
    if (used.length) {
      gLen = 0;
      for (let i = 0; i < used.length; i++) {
        const a1 = used[i], a2 = i + 1 < used.length ? used[i + 1] : used[0] + 2 * Math.PI;
        if (a2 - a1 > gLen) { gLen = a2 - a1; g0 = a1; }
      }
    }
    disconnected.forEach((id, i) => {
      const ang = g0 + gLen * ((i + 1) / (disconnected.length + 1));
      const step = halfOf(hub) + halfOf(byId.get(id)) + gap;
      pos.set(id, { x: step * Math.cos(ang), y: step * Math.sin(ang) });
    });
  }
  // ④ 重排後檢核：①卡片碰撞 → ②線段連線的邊（端點側定案）
  //    → ③線段通道（避線＋轉角淨空，邊不再變、位置微調）。hub 釘住（權重 0），
  //    其餘卡越大越「讓」（面積＝可動性）——小卡守內圈、大卡托外圈。
  const idList = items.map((it) => it.id);
  const mobility = (id) => (id === hub.id ? 0 : byId.get(id).w * byId.get(id).h);
  const MARGIN = 14;
  const graphEdges = (edges || []).filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
  const degG = new Map();
  for (const e of graphEdges) {
    degG.set(e.source, (degG.get(e.source) || 0) + 1);
    degG.set(e.target, (degG.get(e.target) || 0) + 1);
  }
  // 碰撞一輪：AABB 最小穿透軸分離；回傳是否有移動
  const collidePass = () => {
    let moved = false;
    for (let i = 0; i < idList.length; i++) {
      for (let j = i + 1; j < idList.length; j++) {
        const a = idList[i], b = idList[j];
        const pa = pos.get(a), pb = pos.get(b), da = byId.get(a), db = byId.get(b);
        const ox = (da.w + db.w) / 2 + gap - Math.abs(pa.x - pb.x);
        const oy = (da.h + db.h) / 2 + gap - Math.abs(pa.y - pb.y);
        if (ox > 0 && oy > 0) {
          const wa = mobility(a), wb = mobility(b), tot = wa + wb || 1;
          const fa = wa / tot, fb = wb / tot;
          if (ox <= oy) {
            const s = pa.x < pb.x ? -ox : ox;
            pos.set(a, { x: pa.x + s * fa, y: pa.y }); pos.set(b, { x: pb.x - s * fb, y: pb.y });
          } else {
            const s = pa.y < pb.y ? -oy : oy;
            pos.set(a, { x: pa.x, y: pa.y + s * fa }); pos.set(b, { x: pb.x, y: pb.y - s * fb });
          }
          moved = true;
        }
      }
    }
    return moved;
  };
  // ④① 卡片碰撞先收斂（位置穩定，端點側才有意義）
  for (let i = 0; i < 60; i++) if (!collidePass()) break;
  // ④② 端點側定案（與 doRelayoutContainer 的 handleFor 同一套規則，之後回傳給呼叫端）：
  //     對齊/緩斜（垂直偏移≤沿線淨距）＝對向直連；會扭轉＝轉角對（度數高的一端接左右、
  //     另一端接上下），但彎位 (V.x, H.y) 必須在兩卡緣外，否則退回對向直連。
  //（classifySide/edgeSegs＝模組層共用機制，與 layered、App handleFor 同一套規則）
  const centerAt = (id) => pos.get(id);
  const sideOf = new Map(graphEdges.map((e) => [e, classifySide(e, centerAt, byId, degG)]));
  const segsOf = (e) => edgeSegs(e, sideOf.get(e), centerAt, byId);
  // ④③ 線段通道檢視（避線＋轉角淨空），每輪補跑碰撞；端點側不再變、只微調位置
  const CLEAR = Math.max(24, gap * 0.5);
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    // 避線：把壓在別人線上的卡沿該段法線推開（hub 不動、大卡讓；L 形兩段都檢查）
    for (const id of idList) {
      if (id === hub.id) continue;
      const p = pos.get(id), d = byId.get(id);
      const hw = d.w / 2 + MARGIN, hh = d.h / 2 + MARGIN;
      let pushed = false;
      for (const e of graphEdges) {
        if (e.source === id || e.target === id) continue;
        for (const sg of segsOf(e)) {
          const [x1, y1, x2, y2] = sg;
          if (!segHitsRect(x1, y1, x2, y2, { x: p.x - hw, y: p.y - hh, w: hw * 2, h: hh * 2 })) continue;
          const ex = x2 - x1, ey = y2 - y1, len = Math.hypot(ex, ey) || 1;
          const nx = -ey / len, ny = ex / len;               // 線段單位法線
          const perp = (p.x - x1) * nx + (p.y - y1) * ny;    // 卡中心到線的帶號距離
          const ext = Math.abs(hw * nx) + Math.abs(hh * ny); // 卡沿法線的半佔用
          const push = (ext - Math.abs(perp)) + 1;
          const dir = perp >= 0 ? 1 : -1;
          pos.set(id, { x: p.x + nx * push * dir, y: p.y + ny * push * dir });
          moved = true; pushed = true;
          break;                                             // 一次處理一條，下一輪再看
        }
        if (pushed) break;
      }
    }
    // 轉角淨空（下緣壓過下緣＝曲線壓扁，應往上）：
    // 轉角線的彎位要轉得開——水平端中線讓過垂直端上下緣、垂直端中線讓過水平端左右緣
    // ＋CLEAR，不足就沿該軸推開（hub 釘住＝衛星自己讓）。
    for (const e of graphEdges) {
      const cls = sideOf.get(e);
      if (cls.kind !== "corner") continue;
      const [Vi, Hi] = cls.srcHoriz ? [e.target, e.source] : [e.source, e.target];
      const Vd = byId.get(Vi), Hd = byId.get(Hi);
      let V = pos.get(Vi), H = pos.get(Hi);
      const mv = mobility(Vi), mh = mobility(Hi), tot = mv + mh;
      if (tot === 0) continue;
      const defY = Vd.h / 2 + CLEAR - Math.abs(H.y - V.y);
      if (defY > 0) {
        const st = Math.min(defY, 40), dv = Math.sign(V.y - H.y) || -1;
        pos.set(Vi, { x: V.x, y: V.y + dv * st * (mv / tot) });
        pos.set(Hi, { x: H.x, y: H.y - dv * st * (mh / tot) });
        moved = true; V = pos.get(Vi); H = pos.get(Hi);
      }
      const defX = Hd.w / 2 + CLEAR - Math.abs(V.x - H.x);
      if (defX > 0) {
        const st = Math.min(defX, 40), dv = Math.sign(V.x - H.x) || 1;
        pos.set(Vi, { x: V.x + dv * st * (mv / tot), y: V.y });
        pos.set(Hi, { x: H.x - dv * st * (mh / tot), y: H.y });
        moved = true;
      }
    }
    if (collidePass()) moved = true;
    if (!moved) break;
  }
  // 端點側定案回傳（呼叫端直接沿用＝排版避的線就是畫出來的線）
  const sides = new Map(graphEdges.map((e) => {
    const c = sideOf.get(e);
    return [`${e.source}|${e.target}`, { ss: c.ss, ts: c.ts }];
  }));
  // 中心座標→左上角，正規化到 (x0, y0)
  let minX = Infinity, minY = Infinity;
  const tl = new Map();
  for (const [id, p] of pos) {
    const it = byId.get(id);
    const x = p.x - it.w / 2, y = p.y - it.h / 2;
    tl.set(id, { x, y }); minX = Math.min(minX, x); minY = Math.min(minY, y);
  }
  const out = new Map();
  for (const [id, p] of tl) out.set(id, { x: Math.round(x0 + p.x - minX), y: Math.round(y0 + p.y - minY) });
  return { pos: out, sides };
}

// 以錨卡為中心的分層佈局：選取單卡＝錨，其「下游」（出線）
// 往右分層、「上游」（入線）往左分層，錨固定在中央、同層卡片對錨的 y 垂直置中堆疊。
// edges 需帶方向（source→target）。回傳 { pos, anchorAt }（anchorAt＝錨的左上角，供
// 呼叫端把整組平移到錨原位、錨不跳位）。無方向可循的孤立卡沿右側續接。
// HARE 1ay0an0r layoutAnchor
export function layoutAnchor(items, edges, anchorId, opts = {}) {
  const colGap = opts.colGap ?? 120;  // 相鄰層 x 間隙
  const rowGap = opts.rowGap ?? 40;   // 同層卡片 y 間隙
  const byId = new Map(items.map((it) => [it.id, it]));
  if (!byId.has(anchorId) || items.length < 2) {
    const pos = new Map(items.map((it) => [it.id, { x: opts.x0 ?? 0, y: opts.y0 ?? 0 }]));
    return { pos, anchorAt: pos.get(anchorId) || { x: 0, y: 0 } };
  }
  const undirected = new Map(items.map((it) => [it.id, []]));
  edges.forEach((e) => {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) return;
    undirected.get(e.source).push(e.target);
    undirected.get(e.target).push(e.source);
  });
  // SCC 壓縮後的全圖最長路徑 rank，以錨 rank 為 0：所有跨 SCC 邊保持左→右；
  // 錨的祖先自然為負欄、後代為正欄。同一有向環在同欄，因為環不可能全數左→右。
  const ranks = longestPathRanks(items.map((it) => it.id), edges);
  const connected = new Set([anchorId]), cq = [anchorId];
  while (cq.length) {
    const cur = cq.shift();
    for (const nx of undirected.get(cur) || []) {
      if (!connected.has(nx)) { connected.add(nx); cq.push(nx); }
    }
  }
  const anchorRank = ranks.get(anchorId) || 0;
  const col = new Map();
  items.forEach((it) => { if (connected.has(it.id)) col.set(it.id, (ranks.get(it.id) || 0) - anchorRank); });
  // 真正未連通卡才接在最右層之外，按 id 穩定排列。
  let maxCol = Math.max(0, ...col.values());
  items.filter((it) => !connected.has(it.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .forEach((it) => col.set(it.id, (maxCol += 1)));
  // 依層分組、層內以 id 穩定排序（可重現）
  const cols = new Map();
  items.forEach((it) => { const c = col.get(it.id); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(it); });
  for (const arr of cols.values()) arr.sort((a, b) => String(a.id).localeCompare(b.id));
  // 各層 x：由錨層往兩側累加（層寬＝該層最寬卡）；各層內 y：對「錨 y」垂直置中
  const sortedCols = [...cols.keys()].sort((a, b) => a - b);
  const anchorH = byId.get(anchorId).h;
  const colX = new Map([[0, 0]]);
  const widthOf = (c) => Math.max(...cols.get(c).map((it) => it.w));
  for (let c = 1; sortedCols.includes(c); c += 1) colX.set(c, colX.get(c - 1) + widthOf(c - 1) + colGap);
  for (let c = -1; sortedCols.includes(c); c -= 1) colX.set(c, colX.get(c + 1) - widthOf(c) - colGap);
  // 初始置中座標（中心系，供通道檢討；錨中心＝原點基準）
  const cpos = new Map();
  for (const c of sortedCols) {
    const arr = cols.get(c);
    const totalH = arr.reduce((s, it) => s + it.h, 0) + rowGap * (arr.length - 1);
    let y = -totalH / 2;                 // 對「錨中心 y=0」對稱堆疊
    const cx = colX.get(c) + widthOf(c) / 2;
    for (const it of arr) { cpos.set(it.id, { x: cx, y: y + it.h / 2 }); y += it.h + rowGap; }
  }
  // 通道檢討（錨分層也要避線，否則線疊一起）——與 layered/radial
  // 同一套端點側/線段近似（classifySide/edgeSegs），跑「避線位移＋轉角淨空＋卡片分離」
  // 多輪，錨釘死不動（mobility 0）。回傳定案 sides，呼叫端沿用＝排的線＝畫的線。
  const gEdges = edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);
  const deg = new Map();
  gEdges.forEach((e) => { deg.set(e.source, (deg.get(e.source) || 0) + 1); deg.set(e.target, (deg.get(e.target) || 0) + 1); });
  const centerOf = (id) => cpos.get(id);
  const mobility = (id) => (id === anchorId ? 0 : byId.get(id).w * byId.get(id).h);
  const MARGIN = 12, CLEAR = Math.max(24, rowGap * 0.6);
  const idList = items.map((it) => it.id);
  for (let iter = 0; iter < 120; iter += 1) {
    let moved = false;
    const sideOf = new Map(gEdges.map((e) => [e, classifySide(e, centerOf, byId, deg)]));
    const segsOf = (e) => edgeSegs(e, sideOf.get(e), centerOf, byId);
    // ① 避線：壓在別人線上的卡沿該段法線推開（錨不動）
    for (const id of idList) {
      if (id === anchorId) continue;
      const p = cpos.get(id), d = byId.get(id);
      const hw = d.w / 2 + MARGIN, hh = d.h / 2 + MARGIN;
      let hit = false;
      for (const e of gEdges) {
        if (e.source === id || e.target === id) continue;
        for (const sg of segsOf(e)) {
          const [x1, y1, x2, y2] = sg;
          if (!segHitsRect(x1, y1, x2, y2, { x: p.x - hw, y: p.y - hh, w: hw * 2, h: hh * 2 })) continue;
          const ex = x2 - x1, ey = y2 - y1, len = Math.hypot(ex, ey) || 1;
          const nx = -ey / len, ny = ex / len;
          const perp = (p.x - x1) * nx + (p.y - y1) * ny;
          const ext = Math.abs(hw * nx) + Math.abs(hh * ny);
          const push = (ext - Math.abs(perp)) + 1, dir = perp >= 0 ? 1 : -1;
          cpos.set(id, { x: p.x + nx * push * dir, y: p.y + ny * push * dir });
          moved = true; hit = true; break;
        }
        if (hit) break;
      }
    }
    // ② 轉角淨空：轉角線彎位要轉得開（水平端讓過垂直端上下緣、反之），不足沿軸推開
    for (const e of gEdges) {
      const cls = sideOf.get(e);
      if (cls.kind !== "corner") continue;
      const [Vi, Hi] = cls.srcHoriz ? [e.target, e.source] : [e.source, e.target];
      const Vd = byId.get(Vi), Hd = byId.get(Hi);
      let V = cpos.get(Vi), H = cpos.get(Hi);
      const mv = mobility(Vi), mh = mobility(Hi), tot = mv + mh;
      if (tot === 0) continue;
      const defY = Vd.h / 2 + CLEAR - Math.abs(H.y - V.y);
      if (defY > 0) {
        const st = Math.min(defY, 40), dv = Math.sign(V.y - H.y) || -1;
        cpos.set(Vi, { x: V.x, y: V.y + dv * st * (mv / tot) });
        cpos.set(Hi, { x: H.x, y: H.y - dv * st * (mh / tot) });
        moved = true; V = cpos.get(Vi); H = cpos.get(Hi);
      }
      const defX = Hd.w / 2 + CLEAR - Math.abs(V.x - H.x);
      if (defX > 0) {
        const st = Math.min(defX, 40), dv = Math.sign(V.x - H.x) || 1;
        cpos.set(Vi, { x: V.x + dv * st * (mv / tot), y: V.y });
        cpos.set(Hi, { x: H.x - dv * st * (mh / tot), y: H.y });
        moved = true;
      }
    }
    // ③ 卡片分離：AABB 重疊沿最短軸推開（可動端讓，錨全不讓）
    for (let i = 0; i < idList.length; i += 1) {
      for (let j = i + 1; j < idList.length; j += 1) {
        const a = idList[i], b = idList[j];
        const pa = cpos.get(a), pb = cpos.get(b), da = byId.get(a), db = byId.get(b);
        const ox = (da.w + db.w) / 2 + MARGIN - Math.abs(pa.x - pb.x);
        const oy = (da.h + db.h) / 2 + MARGIN - Math.abs(pa.y - pb.y);
        if (ox <= 0 || oy <= 0) continue;
        const ma = mobility(a) ? 1 : 0, mb = mobility(b) ? 1 : 0, tot = ma + mb;
        if (!tot) continue;
        if (ox < oy) { const s = Math.sign(pa.x - pb.x) || 1; cpos.set(a, { x: pa.x + s * ox * (ma / tot), y: pa.y }); cpos.set(b, { x: pb.x - s * ox * (mb / tot), y: pb.y }); }
        else { const s = Math.sign(pa.y - pb.y) || 1; cpos.set(a, { x: pa.x, y: pa.y + s * oy * (ma / tot) }); cpos.set(b, { x: pb.x, y: pb.y - s * oy * (mb / tot) }); }
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 定案端點側＋中心→左上角
  const sides = new Map(gEdges.map((e) => {
    const c = classifySide(e, centerOf, byId, deg);
    return [`${e.source}|${e.target}`, { ss: c.ss, ts: c.ts }];
  }));
  const pos = new Map();
  for (const [id, c] of cpos) { const d = byId.get(id); pos.set(id, { x: Math.round(c.x - d.w / 2), y: Math.round(c.y - d.h / 2) }); }
  return { pos, anchorAt: pos.get(anchorId), sides };
}

// add_card 落點入口：x 或 y 任一為數字＝尊重呼叫端（沿舊行為，缺的一邊回退 120，向後相容）；
// 兩者皆省略＝自動落格（有 parentId 走子卡堆疊、否則走頂層格線）。
// parentId 需為「已解析的節點 id」（呼叫端在 mutator 內先 findNode 解析）。
export function placeCard(data, { parentId, x, y, grid } = {}) {
  const bothOmitted = typeof x !== "number" && typeof y !== "number";
  if (!bothOmitted) {
    return { x: typeof x === "number" ? x : 120, y: typeof y === "number" ? y : 120 };
  }
  const g = grid || GRID_DEFAULTS; // 每專案覆寫：呼叫端以 gridOf(meta) 傳入
  const nodes = data?.nodes || [];
  if (parentId) return placeChild(nodes, parentId, g);
  return placeTopLevel(nodes, data?.edges || [], g);
}

// add_card after=<卡> 的增量落點：建卡→連線→碰撞檢討，不跑全局重排（定案）。
// 初始位＝after 卡右一欄同列（頂層，順動線）／正下方（容器內，垂直堆疊慣例），
// 再以 solveOverlaps 讓位——既有卡全固定（質量無限大），只有新卡可動 → 新卡沿最短
// 分離軸滑進最近空位，手擺的卡誰都不被推動。未收斂（被夾死）→ 回退掃初始欄：
// 既有卡最低者下方留 40px。尺寸沿前端 fallback 鏈（measured → width → 內容量估，寧可高估）。
// HARE 3afc9e21 placeAfter
export function placeAfter(nodes, afterNode, grid = GRID_DEFAULTS, newCard = null) {
  const g = grid;
  const layer = afterNode.parentId || null;
  const ap = afterNode.position || { x: 0, y: 0 };
  const estH = (n) => (isTall(n) ? 480 : 240);
  const sizeOf = (n) => ({
    w: n.measured?.width || n.width || g.cardW,
    h: n.measured?.height || n.height || estH(n),
  });
  const aSize = sizeOf(afterNode);
  const start = layer
    ? { x: ap.x, y: ap.y + aSize.h + 16 }        // 容器內：落 after 正下方
    : { x: ap.x + g.colPitch, y: ap.y };          // 頂層：右一欄、同列對齊
  // 既有卡在前、新卡在最後：求解器中心重合時把「後者」往右/下讓——新卡當後者，
  // 讓位方向與堆疊慣例（往下）一致，不會被推到既有卡上方。
  const bodies = [];
  for (const n of nodes) {
    if (n.type === "lane") continue;
    if ((n.parentId || null) !== layer) continue;
    if (!n.position) continue;
    bodies.push({ id: n.id, fx: true, x: n.position.x, y: n.position.y, ...sizeOf(n) });
  }
  const nb = { id: "__new", fx: false, x: start.x, y: start.y, w: g.cardW, h: estH(newCard) };
  bodies.push(nb);
  const { converged } = solveOverlaps(bodies, { pad: 12 });
  if (converged) return { x: Math.round(nb.x), y: Math.round(nb.y) };
  // 夾死回退：掃「初始欄」（水平重疊判定，同 placeTopLevel）既有卡最低者下方
  const inColumn = bodies.filter((b) => b.fx && Math.abs(b.x - start.x) < g.cardW);
  if (inColumn.length === 0) return start;
  let low = inColumn[0];
  for (const b of inColumn) if (b.y + b.h > low.y + low.h) low = b;
  return { x: start.x, y: Math.round(low.y + low.h + 40) };
}
