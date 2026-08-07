// HARE 4316a202 線段元件模組
// 線段元件模組（多段正交）：自算正交折線路由（含來回/三折），
// 每個「內部可動段」在選取時各出一個拖把（水平段上下拖、垂直段左右拖），調整量存 data.bends。
import { memo, useState } from "react";
import { useReactFlow, useStore, useStoreApi, BaseEdge, EdgeLabelRenderer } from "@xyflow/react";
import { findClearCenter } from "./edgeroute.mjs";
import { t as T } from "./i18n.mjs";

// HARE ed9e7105 edge_tier_style
// 邊可信層級視覺分層：只對「明示了 data.confidenceTier」的邊分層——板型投影邊
// （無 data.confidenceTier）＝無標示＝不變（保留自選線型）。inferred＝虛線＋透明 0.75；
// ambiguous＝點線＋透明 0.6；asserted/extracted＝實線照舊（回 null，不覆寫自訂樣式）。
// 回 null＝不加樣式（呼叫端據此保留原 style 物件同一參考，維持 memo 早退）。
export function tierEdgeStyle(data) {
  const tier = data?.confidenceTier;
  if (tier === "inferred") return { strokeDasharray: "6 4", opacity: 0.75 };
  if (tier === "ambiguous") return { strokeDasharray: "1 5", opacity: 0.6 };
  return null; // asserted/extracted/未明示：不覆寫
}
// hover/選取 tooltip 文字：relation · tier · evidence.note（無明示 tier 回 null＝不加 title）。
export function tierTitle(data) {
  if (!data?.confidenceTier) return null;
  const parts = [data.relation, data.confidenceTier].filter(Boolean);
  const note = data.evidence?.note;
  if (note) parts.push(note);
  return parts.join(" · ") || null;
}

// 端點法向量（指向卡片外側）＋出線軸向。React Flow Position 值＝ 'left'|'right'|'top'|'bottom'。
const NORMALS = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
const axisOf = (pos) => (pos === "left" || pos === "right" ? "H" : "V"); // H＝水平出線，V＝垂直出線

/* 自算正交路由（零依賴）：由 source/target 座標＋出線面，產生點列 [S,…折點…,T]。
   - 兩端皆水平（HH，看板預設 右→左）：順向＝H-V-H（中間一條垂直可左右拖）；
     逆向（目標在後方，S 形）＝H(短)-V-H(主)-V-H(短)，三段內部各出拖把。
   - 兩端皆垂直（VV）：與 HH 對稱（xy 對調）。
   - 混向（HV／VH）：單一 L 形轉角（兩段皆端點短段，無可拖中段）。
   findClearCenter 供「主折段」在使用者未拖時的預設避障位置；一旦有 data.bends 覆寫即以使用者為準。
   每個內部可動段記一組 {key,axis,ref}：key 依「在內部段中的序號＋軸向」穩定命名，
   位移量 = coord − ref（ref＝該段的幾何參考：主段用中點、貼端點的短段用 stub 位置），存 data.bends[key]。*/
// HARE 8f2b31aa buildRoute
function buildRoute(sx, sy, tx, ty, nS, nT, sAxis, tAxis, nodes, exclude, bends) {
  const stub = 20;
  const off = (key) => (bends && bends[key] != null ? bends[key] : null);
  // def 可為函數（惰性避障）：拖過折點（bends 有值）就完全不算 findClearCenter——
  // 避障掃描是 O(候選×全卡片)，大板上每條邊每次重繪都算會拖垮互動（效能）。
  const coord = (key, ref, def) => (off(key) != null ? ref + off(key) : (typeof def === "function" ? def() : def));
  const s1x = sx + nS.x * stub, s1y = sy + nS.y * stub;   // 來源短段端
  const t1x = tx + nT.x * stub, t1y = ty + nT.y * stub;   // 目標短段端
  const points = [{ x: sx, y: sy }];
  const push = (x, y) => points.push({ x, y });
  const segs = [];   // 內部可動段：{ key, axis:'H'|'V', ref, i }（i＝points[i]→points[i+1]）

  if (sAxis === "H" && tAxis === "H") {
    const sdx = nS.x, tax = -nT.x;                          // 出線 x 向、進入目標 x 向
    if (sdx === tax) {                                      // 同向水平流（右→左最常見）
      const forward = (t1x - s1x) * sdx >= 0;
      if (forward && Math.abs(sy - ty) >= 1) {              // 順向 H-V-H：一條垂直中段
        const ref = (sx + tx) / 2;
        const mx = coord("0V", ref, () => findClearCenter(nodes, exclude, sx, sy, tx, ty, true));
        push(mx, sy); push(mx, ty);
        segs.push({ key: "0V", axis: "V", ref, i: 1 });
      } else if (forward) {                                 // 順向且幾乎同高（直線）：給可上下拉的凸折
        const x1 = sx + (tx - sx) * 0.34, x2 = sx + (tx - sx) * 0.66;
        const my = coord("1H", sy, sy);                     // 預設 = sy（畫成直線）；一拉即凸出
        push(x1, sy); push(x1, my); push(x2, my); push(x2, sy);
        segs.push({ key: "0V", axis: "V", ref: x1, i: 1 });
        segs.push({ key: "1H", axis: "H", ref: sy, i: 2 });
        segs.push({ key: "2V", axis: "V", ref: x2, i: 3 });
      } else {                                              // 逆向 S 形 V-H-V：三段內部
        const x1 = coord("0V", s1x, s1x);
        const refY = (sy + ty) / 2;
        const y2 = coord("1H", refY, () => findClearCenter(nodes, exclude, sx, sy, tx, ty, false));
        const x3 = coord("2V", t1x, t1x);
        push(x1, sy); push(x1, y2); push(x3, y2); push(x3, ty);
        segs.push({ key: "0V", axis: "V", ref: s1x, i: 1 });
        segs.push({ key: "1H", axis: "H", ref: refY, i: 2 });
        segs.push({ key: "2V", axis: "V", ref: t1x, i: 3 });
      }
    } else {                                                // 反向面（兩端同側）C 形
      const extDef = sdx > 0 ? Math.max(s1x, t1x) : Math.min(s1x, t1x);
      const ext = coord("0V", extDef, extDef);
      push(ext, sy); push(ext, ty);
      segs.push({ key: "0V", axis: "V", ref: extDef, i: 1 });
    }
  } else if (sAxis === "V" && tAxis === "V") {
    const sdy = nS.y, tay = -nT.y;
    if (sdy === tay) {
      const forward = (t1y - s1y) * sdy >= 0;
      if (forward && Math.abs(sx - tx) >= 1) {              // 順向 V-H-V：一條水平中段
        const ref = (sy + ty) / 2;
        const my = coord("0H", ref, () => findClearCenter(nodes, exclude, sx, sy, tx, ty, false));
        push(sx, my); push(tx, my);
        segs.push({ key: "0H", axis: "H", ref, i: 1 });
      } else if (forward) {                                 // 順向且幾乎同 x（直線）：給可左右拉的凸折
        const y1 = sy + (ty - sy) * 0.34, y2 = sy + (ty - sy) * 0.66;
        const mx = coord("1V", sx, sx);                     // 預設 = sx（畫成直線）；一拉即凸出
        push(sx, y1); push(mx, y1); push(mx, y2); push(sx, y2);
        segs.push({ key: "0H", axis: "H", ref: y1, i: 1 });
        segs.push({ key: "1V", axis: "V", ref: sx, i: 2 });
        segs.push({ key: "2H", axis: "H", ref: y2, i: 3 });
      } else {                                              // 逆向 H-V-H：三段內部
        const y1 = coord("0H", s1y, s1y);
        const refX = (sx + tx) / 2;
        const x2 = coord("1V", refX, () => findClearCenter(nodes, exclude, sx, sy, tx, ty, true));
        const y3 = coord("2H", t1y, t1y);
        push(sx, y1); push(x2, y1); push(x2, y3); push(tx, y3);
        segs.push({ key: "0H", axis: "H", ref: s1y, i: 1 });
        segs.push({ key: "1V", axis: "V", ref: refX, i: 2 });
        segs.push({ key: "2H", axis: "H", ref: t1y, i: 3 });
      }
    } else {                                                // C 形
      const extDef = sdy > 0 ? Math.max(s1y, t1y) : Math.min(s1y, t1y);
      const ext = coord("0H", extDef, extDef);
      push(sx, ext); push(tx, ext);
      segs.push({ key: "0H", axis: "H", ref: extDef, i: 1 });
    }
  } else if (sAxis === "H" && tAxis === "V") {              // 混向：水平出線→垂直進入（H-V-H-V 樓梯）
    const vx = coord("0V", s1x, s1x);                       // 內部垂直段 x（預設＝來源短段端；拉動＝伸縮）
    const hy = coord("1H", t1y, t1y);                       // 內部水平段 y（預設＝目標短段端）
    push(vx, sy); push(vx, hy); push(tx, hy);              // H(短)→V→H→V(短，接 T)
    segs.push({ key: "0V", axis: "V", ref: s1x, i: 1 });
    segs.push({ key: "1H", axis: "H", ref: t1y, i: 2 });
  } else {                                                  // 混向：垂直出線→水平進入（V-H-V-H 樓梯）
    const hy = coord("0H", s1y, s1y);                       // 內部水平段 y（預設＝來源短段端）
    const vx = coord("1V", t1x, t1x);                       // 內部垂直段 x（預設＝目標短段端）
    push(sx, hy); push(vx, hy); push(vx, ty);              // V(短)→H→V→H(短，接 T)
    segs.push({ key: "0H", axis: "H", ref: s1y, i: 1 });
    segs.push({ key: "1V", axis: "V", ref: t1x, i: 2 });
  }
  push(tx, ty);
  return { points, segs };
}

// 去重＋去共線中點（供路徑繪製；不影響拖把定位——拖把用未合併的原始 points＋seg.i）
function clean(pts) {
  const p = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) p.push(q);
  }
  if (p.length <= 2) return p;
  const r = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = r[r.length - 1], b = p[i], c = p[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const sameDir = (b.x - a.x) * (c.x - b.x) >= 0 && (b.y - a.y) * (c.y - b.y) >= 0;
    if (Math.abs(cross) < 0.01 && sameDir) continue;       // a-b-c 共線同向 → 丟掉 b
    r.push(b);
  }
  r.push(p[p.length - 1]);
  return r;
}

// 小圓角折線 SVG path（radius r；轉角用短 Q 貝茲擬 smoothstep 觀感）
function roundedPath(pts, r) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const len1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const len2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const rr = Math.min(r, len1 / 2, len2 / 2);
    const ax = p1.x - ((p1.x - p0.x) / len1) * rr, ay = p1.y - ((p1.y - p0.y) / len1) * rr;
    const bx = p1.x + ((p2.x - p1.x) / len2) * rr, by = p1.y + ((p2.y - p1.y) / len2) * rr;
    d += ` L ${ax} ${ay} Q ${p1.x} ${p1.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// 折線幾何中點（沿線長一半）供 label 定位
function midPoint(pts) {
  const segLen = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); segLen.push(l); total += l; }
  let half = total / 2;
  for (let i = 0; i < segLen.length; i++) {
    if (half <= segLen[i]) { const t = segLen[i] ? half / segLen[i] : 0; return [pts[i].x + (pts[i + 1].x - pts[i].x) * t, pts[i].y + (pts[i + 1].y - pts[i].y) * t]; }
    half -= segLen[i];
  }
  return [pts[0].x, pts[0].y];
}

// HARE 1dd2383d PolyEdge（互動層重做）：
//   ① 擎點「只有選取時」顯示——無任何 hover 偵測行為。
//   ② 拖擎點期間折點存「本地狀態」即時跟手，放開才一次 commit 進全域 edges——
//      拖曳中全板零重繪（舊版每 mousemove 寫全域＝所有卡片端點跟著重算，大板必卡）。
function PolyEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, markerStart, label, selected, data }) {
  const rf = useReactFlow();
  // 效能：不訂閱 s.nodes——訂閱會讓「每一條折線邊」在任何節點變動
  //（拖曳每一格、量測、選取）時全部重繪，大板上＝O(邊數×卡數) 每格。改成渲染當下
  // 直接取 store 現值：邊自己的端點移動時 props 會變、自然重繪並拿到新節點位置。
  const storeApi = useStoreApi();
  const nodes = storeApi.getState().nodes;
  // 拖曳中的折點本地覆寫（null＝沒在拖）；放開時 commit 到 edges 後歸 null
  const [dragBends, setDragBends] = useState(null);
  const bends = dragBends || data?.bends;
  const tip = tierTitle(data); // 明示 tier 邊的 hover tooltip（無明示＝null＝不加 title）
  const showGrabs = !!selected; // 鐵則：只有選取的線段才顯示擎點
  // 擎點螢幕恆定 8px：以 zoom 倒數反向縮放。
  // 只有選取中的線才訂閱 zoom（未選取回傳常數 1＝縮放過程零重繪）。
  const zoom = useStore((s) => (selected ? s.transform[2] : 1));
  const nS = NORMALS[sourcePosition] || NORMALS.right;
  const nT = NORMALS[targetPosition] || NORMALS.left;
  const sAxis = axisOf(sourcePosition || "right"), tAxis = axisOf(targetPosition || "left");
  const exclude = new Set([source, target]);
  // （設計定案：演算法不得彎折線段——線的乾淨與否由「卡片位置」負責，
  //   排版只調卡片座標；線一律走選定的線型自然路由。）
  const { points, segs } = buildRoute(sourceX, sourceY, targetX, targetY, nS, nT, sAxis, tAxis, nodes, exclude, bends);

  const pathPts = clean(points);
  const path = roundedPath(pathPts, 8);
  const [labelX, labelY] = midPoint(pathPts);

  // 每個內部可動段的拖把描述（跳過退化零長段，例如順向且無高低差時的垂直中段）
  const grabs = showGrabs ? segs.map((s) => {
    const a = points[s.i], b = points[s.i + 1];
    if (!a || !b) return null;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1) return null;
    return { key: s.key, axis: s.axis, ref: s.ref, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cur: s.axis === "V" ? a.x : a.y };
  }).filter(Boolean) : [];

  const onGrab = (e, g) => {
    e.stopPropagation(); e.preventDefault();
    const zoom = rf.getViewport().zoom || 1;
    const sx0 = e.clientX, sy0 = e.clientY, base = g.cur;
    let next = { ...(data?.bends || {}) };
    const move = (ev) => {
      const delta = (g.axis === "V" ? ev.clientX - sx0 : ev.clientY - sy0) / zoom;
      next = { ...(data?.bends || {}), [g.key]: Math.round(base + delta - g.ref) };
      setDragBends(next); // 只重繪這一條邊
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      // 放開才寫進全域（單次 App 更新＝單次持久化/同步）；同批清掉本地覆寫
      rf.setEdges((es) => es.map((ed) => (ed.id === id
        ? { ...ed, data: { ...ed.data, bends: next } } : ed)));
      setDragBends(null);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  return (<>
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} markerStart={markerStart} />
    {/* 透明感應線（比可視線寬）：只負責讓線容易被「點選」（事件冒泡給 React Flow 選取），
        無 hover 行為。z 序在卡片下，不影響點卡。 */}
    <path className="poly-hit nopan" d={path} fill="none" stroke="transparent" strokeWidth={22}
      style={{ pointerEvents: "stroke" }}>
      {/* B9-P5b：明示 tier 的邊，hover 感應線顯示 relation · tier · evidence.note（SVG title 原生 tooltip） */}
      {tip && <title>{tip}</title>}
    </path>
    {/* 擎點＝與線段「共生」的 SVG 元素：畫在同一個 edge <g> 內——
        選取的同一幀出現、線段墊高(zIndex)擎點跟著墊高、無跨圖層時序/層級問題。 */}
    {grabs.map((g) => (
      <rect key={g.key} className={`poly-grab nodrag nopan ${g.axis === "V" ? "grab-x" : "grab-y"}`}
        x={-5} y={-5} width={10} height={10} rx={3}
        transform={`translate(${g.mx} ${g.my}) scale(${1 / (zoom || 1)})`}
        style={{ pointerEvents: "all" }}
        onMouseDown={(e) => onGrab(e, g)}>
        <title>{g.axis === "V" ? T("e_dragH") : T("e_dragV")}</title>
      </rect>
    ))}
    {label && (
      <EdgeLabelRenderer>
        <div className="poly-wrap nodrag nopan"
          style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "all" }}>
          <span className="poly-label" style={{ color: style?.stroke }}>{label}</span>
        </div>
      </EdgeLabelRenderer>
    )}
  </>);
}

// memo：props 沒變（端點/樣式/選取都相同）就跳過重繪——React Flow 對未變的邊會沿用
// 同一組 props，大板上可把「無關邊」的重繪成本降為零。
const PolyEdgeM = memo(PolyEdge);
export const edgeTypes = { smoothstep: PolyEdgeM, step: PolyEdgeM, poly: PolyEdgeM };
