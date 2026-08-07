// HARE b10a6a04 GRAPH
// 依賴圖分析——零依賴純函式，操作 { nodes, edges }。
// 邊語意（沿 hare-card-layout skill）：source＝上游前置（prerequisite，畫面在左），
// target＝下游依賴者（畫面在右）；source.layer < target.layer。因此一張卡的「上游依賴」
// ＝所有指向它的邊（incoming）之 source；「下游影響」＝它射出的邊（outgoing）之 target。
//
// 卡型收斂後（plan/exec/chip/object 併入 note），工作/結構的分野在 status：
// 預設看「有工作狀態的 note 卡」——status=note（自訂）＝說明/結構卡，不入 DAG，
// 讓 get_ready_cards／detect_cycles 不被說明樹的箭頭污染；real/wait/draft/block/plan
// ＝路線圖工作卡。呼叫端傳 types＝明確指定卡型（此時不看 status，舊行為保留）。

export const isWorkCard = (n) => n.type === "note" && (n.data?.status || "note") !== "note";
const isReal = (n) => (n.data?.status || "") === "real";
const numOf = (n) => n.data?.num || n.id;
const labelOf = (n) => n.data?.label ?? n.data?.title ?? "";
const brief = (n) => ({ id: n.id, num: numOf(n), label: labelOf(n), status: n.data?.status || null });

// HARE b9e1d0c7 relation_project
// B9 邊語意化（Edge Schema v2）：邊有型別 relation ∈ 4 種——prerequisite（工作前置／解鎖）／
// reference（一般參照，不擋工作）／imports（模組引用／注入）／validates（驗收證據）。
// 工作 DAG 只吃「有效 relation=prerequisite」的邊——含未標示、經板型投影＝prerequisite 的
// 舊邊（任務板行為完全守恆）；明示 reference/validates/imports 的邊不進工作子圖。
const WORK_RELATIONS = new Set(["prerequisite"]);
// 可信層級強弱排序（低可信要害裁定用）：明示 > 機械抽取 > 推論 > 歧義。
const TIER_RANK = { asserted: 3, extracted: 2, inferred: 1, ambiguous: 0 };
// 板型偵測（純函式；重用泳道 sub 標記慣例，與 tools.mjs BOARD_TYPES 同源，零依賴不互 import）：
// 模組介面圖→iface、系統架構圖→system、analyze 自動生成→analysis、其餘→task。
export function boardKindOf(data) {
  const nodes = data?.nodes || [];
  const laneHas = (s) => nodes.some((n) => n.type === "lane" && String(n.data?.sub || "").includes(s));
  if (laneHas("模組介面圖")) return "iface";
  if (laneHas("系統架構圖")) return "system";
  if (laneHas("analyze 自動生成")) return "analysis";
  return "task";
}
// 邊 arrow 推導（與 tools.mjs arrowOf 同源）：markerStart+End＝both、僅 start＝inject、否則 flow。
const arrowOf = (e) => (e.markerStart && e.markerEnd ? "both" : e.markerStart ? "inject" : "flow");
// 板型投影（舊邊相容，不人工回填、不改舊資料）：edge.data.relation 存在＝原樣；否則依板型＋
// arrow 推導——分析板→imports；模組介面板 inject/both→imports（flow 少用→reference）；
// 系統架構板→reference；任務／自由板→prerequisite。投影結果 tier＝extracted（見 edgeSemantics）。
export function projectRelation(edge, boardKind) {
  const explicit = edge?.data?.relation;
  if (explicit) return explicit;
  if (boardKind === "analysis") return "imports";
  if (boardKind === "iface") { const a = arrowOf(edge); return (a === "inject" || a === "both") ? "imports" : "reference"; }
  if (boardKind === "system") return "reference";
  return "prerequisite";
}
// 邊有效語意（list_edges 用）：存了 relation＝原樣＋原 tier/source；未存＝投影＋tier=extracted、無 source。
export function edgeSemantics(edge, boardKind) {
  const d = edge?.data || {};
  if (d.relation) {
    return { relation: d.relation, confidenceTier: d.confidenceTier || "asserted", source: d.evidence?.source || null };
  }
  return { relation: projectRelation(edge, boardKind), confidenceTier: "extracted", source: null };
}

// 建子圖：依 types 選節點（省略＝工作卡判準），只保留兩端都在集內的邊；
// 回傳鄰接表（preds＝上游、succs＝下游）。
function build(data, types) {
  const pick = Array.isArray(types) && types.length
    ? ((set) => (n) => set.has(n.type))(new Set(types)) : isWorkCard;
  const nodes = (data?.nodes || []).filter(pick);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map(nodes.map((n) => [n.id, []]));
  const succs = new Map(nodes.map((n) => [n.id, []]));
  const kind = boardKindOf(data); // 工作 DAG 只納入有效 relation=prerequisite 的邊
  (data?.edges || []).forEach((e) => {
    if (byId.has(e.source) && byId.has(e.target) && WORK_RELATIONS.has(projectRelation(e, kind))) {
      succs.get(e.source).push(e.target);
      preds.get(e.target).push(e.source);
    }
  });
  return { nodes, byId, preds, succs };
}

// 以 id / 編號（忽略大小寫）/ 名稱找節點
function resolve(g, key) {
  if (!key) return null;
  const k = String(key).trim();
  const kl = k.toLowerCase();
  return (
    g.nodes.find((n) => n.id === k) ||
    g.nodes.find((n) => (n.data?.num || "").toLowerCase() === kl) ||
    g.nodes.find((n) => labelOf(n).toLowerCase() === kl) ||
    null
  );
}

// 就緒卡：所有上游前置皆 real、自身未 real（無前置且未 real 也算就緒）。
// prerequisites 列出直接上游編號；status 一併回傳（block＝依賴已備但等外部授權，仍可見）。
export function readyCards(data, types) {
  const g = build(data, types);
  const out = [];
  g.nodes.forEach((n) => {
    if (isReal(n)) return;
    const ups = g.preds.get(n.id).map((id) => g.byId.get(id));
    if (ups.every(isReal)) out.push({ ...brief(n), prerequisites: ups.map(numOf) });
  });
  return { count: out.length, ready: out };
}

// 阻塞鏈：card 的遞迴上游中未 real 者（＝要先做完哪些卡才輪到它）。blockers 空＝就緒。
export function blockers(data, card, types) {
  const g = build(data, types);
  const start = resolve(g, card);
  if (!start) throw new Error(`找不到卡片：${card}`);
  const seen = new Set();
  const block = [];
  const dfs = (id) => {
    for (const up of g.preds.get(id) || []) {
      if (seen.has(up)) continue;
      seen.add(up);
      const n = g.byId.get(up);
      if (!isReal(n)) block.push(brief(n));
      dfs(up);
    }
  };
  dfs(start.id);
  return { card: numOf(start), ready: block.length === 0, count: block.length, blockers: block };
}

// 下游影響：card 的遞迴下游（它轉 real 後會解鎖／影響哪些卡）。
export function downstream(data, card, types) {
  const g = build(data, types);
  const start = resolve(g, card);
  if (!start) throw new Error(`找不到卡片：${card}`);
  const seen = new Set();
  const out = [];
  const dfs = (id) => {
    for (const dn of g.succs.get(id) || []) {
      if (seen.has(dn)) continue;
      seen.add(dn);
      out.push(brief(g.byId.get(dn)));
      dfs(dn);
    }
  };
  dfs(start.id);
  return { card: numOf(start), count: out.length, downstream: out };
}

// 環偵測：DFS 三色法，回報所有依賴環（卡片編號序列）。DAG 完整性 lint。
export function detectCycles(data, types) {
  const g = build(data, types);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(g.nodes.map((n) => [n.id, WHITE]));
  const stack = [];
  const cycles = [];
  const dfs = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const nx of g.succs.get(id) || []) {
      if (color.get(nx) === GRAY) {
        const i = stack.indexOf(nx);
        cycles.push(stack.slice(i).map((x) => numOf(g.byId.get(x))));
      } else if (color.get(nx) === WHITE) {
        dfs(nx);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  g.nodes.forEach((n) => { if (color.get(n.id) === WHITE) dfs(n.id); });
  return { hasCycle: cycles.length > 0, count: cycles.length, cycles };
}

// 關鍵路徑：最長依賴鏈（以卡片數計）。有環則回報無法計算並附環。
export function criticalPath(data, types) {
  const g = build(data, types);
  const cyc = detectCycles(data, types);
  if (cyc.hasCycle) return { error: "存在依賴環，無法計算關鍵路徑", cycles: cyc.cycles };
  const memo = new Map();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    let best = [];
    for (const nx of g.succs.get(id) || []) {
      const p = longest(nx);
      if (p.length > best.length) best = p;
    }
    const path = [id, ...best];
    memo.set(id, path);
    return path;
  };
  let best = [];
  g.nodes.forEach((n) => { const p = longest(n.id); if (p.length > best.length) best = p; });
  return { length: best.length, path: best.map((id) => brief(g.byId.get(id))) };
}

// HARE b3f0a91d impact_bfs
// 加權影響力查詢：從 card 沿「有效 relation ∈ relations」的下游邊
// 擴散，算每張受影響卡的分數。邊權 prerequisite 1.0／validates 0.7／imports 0.5／
// reference 0.3；每深一層 ×0.7 衰減；同卡多路徑只保留最高分並記該路徑；有環時同一
// 路徑不重訪（既有 DAG 工具同慣例）。bounded：maxDepth（預設 6）限路徑長、maxCards
// （預設 50）限輸出——超過回 truncated:true。relations 預設 ["prerequisite"]＝現行下游語意。
const RELATION_WEIGHT = { prerequisite: 1.0, validates: 0.7, imports: 0.5, reference: 0.3 };
const IMPACT_DECAY = 0.7;
// B9-1 修正3：max_cards 上限與遍歷硬預算。上限＝schema 同源（正整數 1..5000）；
// 硬預算＝佇列出隊次數上限，防密集圖在 slice 前先跑爆——超過即停並標 truncated。
const IMPACT_MAX_CARDS_CAP = 5000;
const IMPACT_EXPAND_BUDGET = 200000;
export function impact(data, card, opts = {}) {
  const relations = Array.isArray(opts.relations) && opts.relations.length ? opts.relations : ["prerequisite"];
  const relSet = new Set(relations);
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 6;
  // 負數/0/非整數/超上限＝參數錯誤（不再只截輸出、不再誤把 -1 當「回一筆並 truncated」）。
  if (opts.maxCards !== undefined
    && (!Number.isInteger(opts.maxCards) || opts.maxCards < 1 || opts.maxCards > IMPACT_MAX_CARDS_CAP)) {
    throw new Error(`max_cards 必須是 1–${IMPACT_MAX_CARDS_CAP} 的正整數（收到 ${opts.maxCards}）`);
  }
  const maxCards = Number.isFinite(opts.maxCards) ? opts.maxCards : 50;
  const detail = !!opts.detail;
  const pick = Array.isArray(opts.types) && opts.types.length
    ? ((set) => (n) => set.has(n.type))(new Set(opts.types)) : isWorkCard;
  const nodes = (data?.nodes || []).filter(pick);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = resolve({ nodes }, card);
  if (!start) throw new Error(`找不到卡片：${card}`);
  const kind = boardKindOf(data);
  // 依 relations 過濾建下游鄰接（帶邊的有效 relation 與權重）；兩端都須在選定節點集內。
  const succs = new Map(nodes.map((n) => [n.id, []]));
  (data?.edges || []).forEach((e) => {
    if (!byId.has(e.source) || !byId.has(e.target)) return;
    const rel = projectRelation(e, kind);
    if (relSet.has(rel)) succs.get(e.source).push({ to: e.target, rel, w: RELATION_WEIGHT[rel] ?? 0.3 });
  });
  // bounded BFS：queue 帶 {深度,分數,路徑,經過的 relation}；best 記每卡最高分那條路徑。
  const best = new Map(); // id -> { score, depth, path:[ids], reasons:[rel] }
  const queue = [{ id: start.id, depth: 0, score: 1, path: [start.id], reasons: [] }];
  let expands = 0; let budgetHit = false; // 遍歷硬預算：出隊次數上限，防密集圖爆炸
  while (queue.length) {
    if (expands >= IMPACT_EXPAND_BUDGET) { budgetHit = true; break; }
    expands += 1;
    const cur = queue.shift();
    if (cur.depth >= maxDepth) continue;
    for (const { to, rel, w } of succs.get(cur.id) || []) {
      if (cur.path.includes(to)) continue; // 環：同一路徑不重訪
      const score = cur.score * w * IMPACT_DECAY;
      const prev = best.get(to);
      if (prev && prev.score >= score) continue; // 多路徑：保留最高分
      const entry = { score, depth: cur.depth + 1, path: [...cur.path, to], reasons: [...cur.reasons, rel] };
      best.set(to, entry);
      queue.push({ id: to, ...entry });
    }
  }
  let rows = [...best.entries()].map(([id, e]) => {
    const node = byId.get(id);
    return { node, num: numOf(node), label: labelOf(node), depth: e.depth,
      score: Math.round(e.score * 1000) / 1000,
      via: e.path.map((pid) => numOf(byId.get(pid))),
      reasons: [...new Set(e.reasons)] };
  });
  rows.sort((a, b) => b.score - a.score || a.depth - b.depth || String(a.num).localeCompare(String(b.num)));
  const truncated = rows.length > maxCards || budgetHit; // 輸出溢出或遍歷觸頂皆算截斷
  if (rows.length > maxCards) rows = rows.slice(0, maxCards);
  const list = detail
    ? rows.map(({ node, ...r }) => r) // detail：{num,label,depth,score,via,reasons}
    : rows.map(({ node }) => brief(node)); // 精簡：{id,num,label,status}
  return { card: numOf(start), count: list.length, ...(truncated ? { truncated: true } : {}), downstream: list };
}

// Brandes betweenness（未加權有向圖，純 JS；供 insights Bridge 用）。回傳 id→中心度。
function brandes(ids, succs) {
  const bc = new Map(ids.map((id) => [id, 0]));
  for (const s of ids) {
    const stack = [];
    const pred = new Map(ids.map((id) => [id, []]));
    const sigma = new Map(ids.map((id) => [id, 0])); sigma.set(s, 1);
    const dist = new Map(ids.map((id) => [id, -1])); dist.set(s, 0);
    const q = [s];
    while (q.length) {
      const v = q.shift(); stack.push(v);
      for (const w of succs.get(v) || []) {
        if (dist.get(w) < 0) { dist.set(w, dist.get(v) + 1); q.push(w); }
        if (dist.get(w) === dist.get(v) + 1) { sigma.set(w, sigma.get(w) + sigma.get(v)); pred.get(w).push(v); }
      }
    }
    const delta = new Map(ids.map((id) => [id, 0]));
    while (stack.length) {
      const w = stack.pop();
      for (const v of pred.get(w)) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      }
      if (w !== s) bc.set(w, bc.get(w) + delta.get(w));
    }
  }
  return bc;
}

// HARE c1e7d4a2 graph_insights
// 結構健康檢查（get_graph view=insights）：純唯讀分析、只報告不改圖。逐頁計算
// 七類訊號並回 { text（markdown，對齊 pack 風格）, stats }：Hub（工作邊入＋出度前 5）／Bridge
// （Brandes betweenness 前 5，單頁節點 >1500 跳過並註明）／工作孤兒（isWorkCard 無任何邊、無
// parentId、無 pin 指向）／缺證據高連接（工作邊度數 ≥3 且無 refs 的 work 卡）／依賴倒掛
// （status=real 卻有未完成 prerequisite 上游）／低可信要害（關鍵路徑上 tier inferred/ambiguous
// 的邊）／懸空 pin（refCard 目標不存在——跨頁優先用 knownIds 全專案 id 集）。每類最多 5 筆＋
// 總數，空類省略。工作邊＝有效 relation=prerequisite；度數以工作邊計（與 Hub 一致）。
// P4 追加「待裁定」段（surprise_questions）：五條規則產生「待人裁定問題」清單，純提問絕不改圖。
const BRIDGE_NODE_CAP = 1500;
export function insights(data, opts = {}) {
  const nodes = data?.nodes || [];
  const edges = data?.edges || [];
  const cards = nodes.filter((n) => n.type !== "lane");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kind = boardKindOf(data);
  const pick = Array.isArray(opts.types) && opts.types.length
    ? ((set) => (n) => set.has(n.type))(new Set(opts.types)) : isWorkCard;
  const dag = cards.filter(pick);
  const inDag = new Set(dag.map((n) => n.id));
  // 工作邊＝有效 relation=prerequisite 且兩端在 DAG 內。
  const workEdges = edges.filter((e) => inDag.has(e.source) && inDag.has(e.target)
    && projectRelation(e, kind) === "prerequisite");
  const indeg = new Map(dag.map((n) => [n.id, 0]));
  const outdeg = new Map(dag.map((n) => [n.id, 0]));
  const succs = new Map(dag.map((n) => [n.id, []]));
  const preds = new Map(dag.map((n) => [n.id, []]));
  for (const e of workEdges) {
    outdeg.set(e.source, outdeg.get(e.source) + 1);
    indeg.set(e.target, indeg.get(e.target) + 1);
    succs.get(e.source).push(e.target);
    preds.get(e.target).push(e.source);
  }
  const deg = (id) => indeg.get(id) + outdeg.get(id);
  const tag = (id) => numOf(byId.get(id));
  const lab = (id) => labelOf(byId.get(id));

  // Hub：入＋出度前 5（度數 >0）。
  const hubsAll = dag.map((n) => n.id).filter((id) => deg(id) > 0)
    .sort((a, b) => deg(b) - deg(a));
  const hubs = hubsAll.map((id) => ({ num: tag(id), label: lab(id), inDeg: indeg.get(id), outDeg: outdeg.get(id) }));

  // Bridge：Brandes betweenness 前 5；單頁節點 >1500 跳過。
  let bridges = []; let bridgeSkipped = false;
  if (dag.length > BRIDGE_NODE_CAP) bridgeSkipped = true;
  else {
    const bc = brandes(dag.map((n) => n.id), succs);
    bridges = [...bc.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .map(([id, v]) => ({ num: tag(id), label: lab(id), score: Math.round(v * 100) / 100 }));
  }

  // 工作孤兒：isWorkCard 無任何邊、無 parentId、無 pin 指向、且自身非容器（無子卡）。
  // 容器排除：卡片若是其他卡的 parentId 目標＝有子卡，子卡＝天然關聯，不算孤兒——
  // 否則有 13 張子卡的容器（如 W2 前端內容）會被誤判成孤兒。
  const touched = new Set();
  for (const e of edges) { touched.add(e.source); touched.add(e.target); }
  const pinTargets = new Set(nodes.filter((n) => n.type === "pin" && n.data?.refCard).map((n) => n.data.refCard));
  const parentIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId)); // 有子卡者＝容器
  const orphans = cards.filter(isWorkCard)
    .filter((n) => !touched.has(n.id) && !n.parentId && !pinTargets.has(n.id) && !parentIds.has(n.id))
    .map((n) => ({ num: numOf(n), label: labelOf(n) }));

  // 缺證據高連接：工作邊度數 ≥3 且無 refs 的 work 卡。
  const noEvidence = dag.filter(isWorkCard)
    .filter((n) => deg(n.id) >= 3 && !(Array.isArray(n.data?.refs) && n.data.refs.length))
    .map((n) => ({ num: numOf(n), label: labelOf(n), degree: deg(n.id) }));

  // 依賴倒掛：status=real 卻有未完成 prerequisite 上游。
  const inverted = [];
  for (const n of dag) {
    if (!isReal(n)) continue;
    const bad = preds.get(n.id).map((id) => byId.get(id)).filter((u) => u && !isReal(u));
    if (bad.length) inverted.push({ num: numOf(n), label: labelOf(n), upstream: bad.map(numOf) });
  }

  // 低可信要害：關鍵路徑上 tier inferred/ambiguous 的邊。B9-1 修正4：關鍵路徑由 prerequisite
  // 組成，故只看有效 prerequisite 邊（不再用 .find() 抓到平行的 reference 邊誤判）；同端點多條
  // prerequisite 依最強 tier 裁定（asserted>extracted>inferred>ambiguous，取最強者），最強仍低才報。
  const lowConfidence = [];
  const cp = criticalPath(data, opts.types);
  if (!cp.error && (cp.path?.length || 0) > 1) {
    for (let i = 0; i < cp.path.length - 1; i += 1) {
      const s = cp.path[i].id, t = cp.path[i + 1].id;
      const prereqs = edges.filter((x) => x.source === s && x.target === t
        && projectRelation(x, kind) === "prerequisite");
      if (!prereqs.length) continue;
      let best = null; // 最強 tier
      for (const e of prereqs) {
        const tier = edgeSemantics(e, kind).confidenceTier;
        if (best === null || (TIER_RANK[tier] ?? -1) > (TIER_RANK[best] ?? -1)) best = tier;
      }
      if (best === "inferred" || best === "ambiguous") lowConfidence.push({ from: tag(s), to: tag(t), tier: best });
    }
  }

  // 懸空 pin：refCard 目標不存在（跨頁：優先用 knownIds 全專案 id 集，退回本頁節點集）。
  const known = opts.knownIds instanceof Set ? opts.knownIds : new Set(nodes.map((n) => n.id));
  const danglingPins = nodes.filter((n) => n.type === "pin" && n.data?.refCard && !known.has(n.data.refCard))
    .map((n) => ({ num: numOf(n), label: labelOf(n), refCard: n.data.refCard }));

  // HARE f2c8a5d1 surprise_questions
  // 待裁定問題：純提問、絕不改圖。五條規則各附觸發理由，依 priority 排序、上限 10。
  // 板型投影 tier=extracted 屬正常舊資料，不算低可信——僅 inferred/ambiguous 觸發規則 1。
  const QUESTION_CAP = 10;
  // 頂層容器 id：沿 parentId 鏈上溯到最頂祖先（無 parentId＝不在容器內，回 null）。
  const topContainer = (id) => {
    let cur = byId.get(id); let top = null; let guard = 0;
    while (cur && cur.parentId && guard < 100) { cur = byId.get(cur.parentId); if (cur) top = cur.id; guard += 1; }
    return top;
  };
  const questions = [];
  // 規則 1（priority 1）：某工作卡唯一 prerequisite 上游邊 tier=inferred/ambiguous（extracted 不算）。
  for (const n of dag) {
    if (indeg.get(n.id) !== 1) continue;
    const e = workEdges.find((x) => x.target === n.id);
    if (!e) continue;
    const tier = edgeSemantics(e, kind).confidenceTier;
    if (tier === "inferred" || tier === "ambiguous") {
      questions.push({ question: `${numOf(n)} 的唯一前置來自推論線，是否由人確認？`, target: numOf(n),
        reasons: [`唯一前置邊 tier=${tier}`, `上游 ${tag(e.source)}`], priority: 1 });
    }
  }
  // 規則 2（priority 3）：prerequisite 邊兩端頂層容器不同且皆非 null（同對容器只問一次）。
  const seenContainerPair = new Set();
  for (const e of workEdges) {
    const cs = topContainer(e.source); const ct = topContainer(e.target);
    if (!cs || !ct || cs === ct) continue;
    const key = `${cs}|${ct}`;
    if (seenContainerPair.has(key)) continue;
    seenContainerPair.add(key);
    questions.push({ question: `容器 ${tag(cs)} 與 ${tag(ct)} 出現強依賴，邊界是否合理？`, target: `${tag(e.source)}→${tag(e.target)}`,
      reasons: [`源 ${tag(e.source)}@容器${tag(cs)}`, `標的 ${tag(e.target)}@容器${tag(ct)}`], priority: 3 });
  }
  // 規則 3（priority 2）：status=real 且工作邊度數 ≥3 且無 refs（缺證據高連接的 real 樞紐）。
  for (const n of dag) {
    if (!isReal(n) || deg(n.id) < 3) continue;
    if (Array.isArray(n.data?.refs) && n.data.refs.length) continue;
    questions.push({ question: `${numOf(n)} 已標 real 但無程式參照，證據在哪？`, target: numOf(n),
      reasons: ["status=real", `工作邊度數 ${deg(n.id)}`, "無 refs"], priority: 2 });
  }
  // 規則 4（priority 1）：同一對卡同向同時有明示 prerequisite 與 reference 邊（投影邊不算，須 data.relation）。
  const pairRel = new Map();
  for (const e of edges) {
    const r = e?.data?.relation; if (!r) continue;
    const k = `${e.source}|${e.target}`;
    if (!pairRel.has(k)) pairRel.set(k, new Set());
    pairRel.get(k).add(r);
  }
  for (const [k, set] of pairRel) {
    if (!(set.has("prerequisite") && set.has("reference"))) continue;
    const [s, t] = k.split("|");
    questions.push({ question: `${tag(s)}→${tag(t)} 同時是前置與參照，留哪條？`, target: `${tag(s)}→${tag(t)}`,
      reasons: ["明示 prerequisite 邊", "明示 reference 邊"], priority: 1 });
  }
  // 規則 5（priority 2）：懸空 pin（沿用上方既有偵測結果）。
  for (const p of danglingPins) {
    questions.push({ question: `pin ${p.num || "?"} 指向的卡已不存在，刪除或改指？`, target: p.num || p.refCard,
      reasons: [`refCard=${p.refCard} 不存在`], priority: 2 });
  }
  // 排序（priority 升冪＝高優先在前，同優先按 target 穩定）＋上限 10（超過截斷註明）。
  questions.sort((a, b) => a.priority - b.priority || String(a.target).localeCompare(String(b.target)));
  const questionsTotal = questions.length;
  const questionsTruncated = questionsTotal > QUESTION_CAP;
  const shownQuestions = questions.slice(0, QUESTION_CAP);

  // HARE c0e51001 container_cohesion
  // 容器內聚建議：以「頂層容器」為群落（沿 topContainer），逐容器算工作邊的
  // internal/(internal+external) 內聚比。純建議不搬卡：cohesion<0.5 且對外邊 ≥3＝
  // 內聚偏低（考慮拆分或搬卡）；容器對之間跨界工作邊 ≥5＝耦合偏高。各類最多 5 筆。
  const COHESION_LOW = 0.5, COHESION_EXT_MIN = 3, COUPLE_MIN = 5;
  const contAgg = new Map(); // cid -> { internal, external }
  const ensureC = (cid) => { let s = contAgg.get(cid); if (!s) { s = { internal: 0, external: 0 }; contAgg.set(cid, s); } return s; };
  const pairAgg = new Map(); // "a|b"（id 排序）-> 跨界工作邊數
  for (const e of workEdges) {
    const gs = topContainer(e.source), gt = topContainer(e.target);
    if (gs && gs === gt) { ensureC(gs).internal += 1; continue; } // 同容器內部邊
    if (gs) ensureC(gs).external += 1;
    if (gt) ensureC(gt).external += 1;
    if (gs && gt) { const key = gs < gt ? `${gs}|${gt}` : `${gt}|${gs}`; pairAgg.set(key, (pairAgg.get(key) || 0) + 1); }
  }
  const lowCohesion = [...contAgg.entries()]
    .map(([cid, s]) => ({ num: tag(cid), label: lab(cid), external: s.external,
      cohesion: Math.round((s.internal / (s.internal + s.external)) * 100) / 100 }))
    .filter((r) => r.external >= COHESION_EXT_MIN && r.cohesion < COHESION_LOW)
    .sort((a, b) => a.cohesion - b.cohesion || String(a.num).localeCompare(String(b.num)))
    .slice(0, 5);
  const highCoupling = [...pairAgg.entries()]
    .filter(([, c]) => c >= COUPLE_MIN)
    .map(([k, c]) => { const [a, b] = k.split("|"); return { a: tag(a), b: tag(b), count: c }; })
    .sort((x, y) => y.count - x.count || String(x.a).localeCompare(String(y.a)))
    .slice(0, 5);

  // markdown（對齊 pack 風格：## 頁名，### 類別（總數），最多列 5 筆；空類省略）。
  const lines = [`## ${data?.name || "（未命名頁）"}`];
  const section = (title, rows, fmt) => {
    if (!rows.length) return;
    lines.push(`### ${title}（${rows.length}）`);
    rows.slice(0, 5).forEach((r) => lines.push(`- ${fmt(r)}`));
  };
  section("Hub 樞紐", hubs, (r) => `${r.num} ${r.label}（入${r.inDeg}/出${r.outDeg}）`);
  if (bridgeSkipped) {
    lines.push("### Bridge 橋接");
    lines.push(`- （節點 ${dag.length} > ${BRIDGE_NODE_CAP}，略過 betweenness）`);
  } else section("Bridge 橋接", bridges, (r) => `${r.num} ${r.label}（betweenness ${r.score}）`);
  section("工作孤兒", orphans, (r) => `${r.num} ${r.label}`);
  section("缺證據高連接", noEvidence, (r) => `${r.num} ${r.label}（度數 ${r.degree}）`);
  section("依賴倒掛", inverted, (r) => `${r.num} ${r.label}（未完成上游 ${r.upstream.join("、")}）`);
  section("低可信要害", lowConfidence, (r) => `${r.from}→${r.to}（${r.tier}）`);
  section("懸空 pin", danglingPins, (r) => `${r.num || "?"} ${r.label}（refCard=${r.refCard}）`);
  // 容器內聚（P5a）：內聚偏低容器＋耦合偏高容器對；空則省略。純建議不搬卡。
  if (lowCohesion.length || highCoupling.length) {
    lines.push(`### 容器內聚（${lowCohesion.length + highCoupling.length}）`);
    lowCohesion.forEach((r) => lines.push(`- ${r.num} ${r.label} 內聚偏低（cohesion ${r.cohesion}／對外邊 ${r.external}），考慮拆分或搬卡`));
    highCoupling.forEach((r) => lines.push(`- ${r.a} × ${r.b} 耦合偏高（跨界工作邊 ${r.count}）`));
  }
  // 待裁定（P4）：列至多 10 筆，超過附截斷註記；空則省略。每筆帶 P{priority} 與觸發理由。
  if (shownQuestions.length) {
    lines.push(`### 待裁定（${questionsTotal}）`);
    shownQuestions.forEach((q) => lines.push(`- P${q.priority} ${q.question}（${q.reasons.join("、")}）`));
    if (questionsTruncated) lines.push(`- （超過 ${QUESTION_CAP} 筆，其餘 ${questionsTotal - QUESTION_CAP} 題略過）`);
  }
  if (lines.length === 1) lines.push("（無結構訊號）");

  const stats = { hubs: hubs.length, bridges: bridges.length, orphans: orphans.length,
    noEvidence: noEvidence.length, inverted: inverted.length, lowConfidence: lowConfidence.length,
    danglingPins: danglingPins.length, cohesion: lowCohesion.length + highCoupling.length,
    questions: shownQuestions.length,
    ...(bridgeSkipped ? { bridgeSkipped: true } : {}) };
  return { text: lines.join("\n"), stats, questions: shownQuestions };
}
