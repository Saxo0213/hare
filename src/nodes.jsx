// HARE 42e4d590 節點元件模組
// 節點元件模組：卡片／泳道／範圍框／節點卡＋共用樣式與小元件
import { memo, useState, useEffect, useRef, useContext, createContext } from "react";
import { Handle, Position, NodeResizer, useReactFlow, useStore, useConnection,
  useUpdateNodeInternals } from "@xyflow/react";
import { Md } from "./md.jsx";
import { t as T } from "./i18n.mjs";
import { confirmDialog } from "./confirm.mjs"; // 置中確認對話框（取代 window.confirm）
import { taskTexts, setTaskAt } from "../lib/tasks.mjs"; // B19 任務 dict 化（前後端共用）
import { acceptsOf } from "../lib/accepts.mjs"; // 驗收項（HARE 3ac5e77b accepts）
import { resolveStyle, styleToAttrs, effectiveAppearance } from "../lib/cardstyles.mjs"; // W1-3-8 卡片款式（前後端共用 registry）

// refs.path → 絕對路徑（每專案可設定）：解析基準根 refBase 由伺服器提供
// （GET /api/roadmap 回傳、App 於 applyServerState 時 setRefBase）——外部專案的
// 分析板（analyze_codebase）程式連結才指得到正確位置。未取得前退回 HARE repo 根。
let REF_BASE = "d:/HARE";
const setRefBase = (base) => { if (base && typeof base === "string") REF_BASE = base.replace(/\\/g, "/").replace(/\/+$/, ""); };
// 絕對路徑（碟符/UNC）原樣放行（接在 refBase 後變 D:/BanLu/D:/...）
const toAbsPath = (p) => {
  const s = String(p || "").replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(s) || s.startsWith("//")) return s;
  return `${REF_BASE}/${s.replace(/^\/+/, "")}`;
};

/* 容器節點（泳道/技術範圍框）可雙軸調整大小 */
const RZ = ({ show, w = 130, h = 48 }) => (
  <NodeResizer isVisible={show} minWidth={w} minHeight={h} lineClassName="rz-line" handleClassName="rz-handle" />
);

/* 內容卡四邊控制條（統一樣式的圓角短條）。
   寬度＝node.width（左/右，左邊同時移動 x）；高度＝data.minH（上/下），
   節點高度永遠自適應內容 → 實際高＝max(內容, minH)：內容為最小、調大就以大的為準。 */
function Grips({ id, show }) {
  const rf = useReactFlow();
  if (!show) return null;
  const start = (pos) => (e) => {
    e.stopPropagation(); e.preventDefault();
    const wrap = e.currentTarget.closest(".react-flow__node");
    const zoom = rf.getViewport().zoom || 1;
    const sx = e.clientX, sy = e.clientY;
    const w0 = wrap ? wrap.offsetWidth : 200, h0 = wrap ? wrap.offsetHeight : 100;
    const n0 = rf.getNode(id);
    const x0 = n0?.position?.x || 0, y0 = n0?.position?.y || 0;
    const zone0 = n0?.data?.childZoneH ?? null; // 有子卡片區的卡：下緣把手改調畫布區高度
    // 多選調整大小：拖任一選取卡的把手＝全組同步調整——左右＝同寬、
    // 上下＝同高（各卡仍受自身內容最小尺寸影響）；left/top 拖時位置補償，
    // 讓各成員的對邊（右緣/下緣）各自定住。
    // HARE 3f8a1d06 groupResize
    const selCards = rf.getNodes().filter((n) => n.selected && n.type !== "lane");
    const group = n0?.selected && selCards.length >= 2
      ? new Map(selCards.map((n) => [n.id, { x0: n.position.x, y0: n.position.y,
          w0: n.measured?.width || n.width || 200, h0: n.measured?.height || n.height || 100 }]))
      : null;
    // 角點（「所有卡片都要有角點」）：nw/ne/sw/se＝
    // 水平＋垂直兩軸合成——沿用邊條語意（minW/minH、left/top 位置補償、群組同步），
    // 邊條行為完全不變。
    const H_OF = { left: "left", right: "right", nw: "left", sw: "left", ne: "right", se: "right" };
    const V_OF = { top: "top", bottom: "bottom", nw: "top", ne: "top", sw: "bottom", se: "bottom" };
    const move = (ev) => {
      const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
      const hz = H_OF[pos] || null, vt = V_OF[pos] || null;
      if (group) {
        // 多選同步：寬/高調成同值；left/top 各成員位置補償定住對邊
        const wT = hz ? Math.max(120, Math.round(hz === "right" ? w0 + dx : w0 - dx)) : null;
        const hT = vt ? Math.max(40, Math.round(vt === "bottom" ? h0 + dy : h0 - dy)) : null;
        rf.setNodes((ns) => ns.map((n) => {
          const m = group.get(n.id);
          if (!m) return n;
          let data = n.data, position = n.position;
          if (wT != null) { data = { ...data, minW: wT }; if (hz === "left") position = { ...position, x: m.x0 + (m.w0 - wT) }; }
          if (hT != null) { data = { ...data, minH: hT }; if (vt === "top") position = { ...position, y: m.y0 + (m.h0 - hT) }; }
          return { ...n, data, position };
        }));
        return;
      }
      rf.setNodes((ns) => ns.map((n) => {
        if (n.id !== id) return n;
        let data = n.data, position = n.position;
        if (hz === "right") data = { ...data, minW: Math.max(120, Math.round(w0 + dx)) };
        if (hz === "left") { const w = Math.max(120, Math.round(w0 - dx)); data = { ...data, minW: w }; position = { ...position, x: x0 + (w0 - w) }; }
        if (vt === "bottom") {
          // 子卡片畫布縮放由拖曳決定：有畫布區的卡，「下緣邊條」直接調畫布區高度
          // （可縮小；子卡若仍超出，維護 effect 會擋住縮過頭）。角點不動畫布區、只調 minH。
          if (pos === "bottom" && zone0 != null && n.data.childTop != null) {
            data = { ...data, childZoneH: Math.max(48, Math.round(zone0 + dy)) };
          } else {
            data = { ...data, minH: Math.max(40, Math.round(h0 + dy)) };
          }
        }
        if (vt === "top") { const h = Math.max(40, Math.round(h0 - dy)); data = { ...data, minH: h }; position = { ...position, y: y0 + (h0 - h) }; }
        return { ...n, data, position };
      }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      // 放開後通知 App 重新對齊涉及的約束群組（保持約束狀態，W1-3）
      window.dispatchEvent(new CustomEvent("hare:resized", { detail: group ? [...group.keys()] : [id] }));
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  return (<>
    <div className="grip grip-t nodrag" onMouseDown={start("top")} title={T("n_gripH")} />
    <div className="grip grip-b nodrag" onMouseDown={start("bottom")} title={T("n_gripH")} />
    <div className="grip grip-l nodrag" onMouseDown={start("left")} title={T("n_gripW")} />
    <div className="grip grip-r nodrag" onMouseDown={start("right")} title={T("n_gripW")} />
    <div className="grip grip-c grip-nw nodrag" onMouseDown={start("nw")} title={T("n_gripCorner")} />
    <div className="grip grip-c grip-ne nodrag" onMouseDown={start("ne")} title={T("n_gripCorner")} />
    <div className="grip grip-c grip-sw nodrag" onMouseDown={start("sw")} title={T("n_gripCorner")} />
    <div className="grip grip-c grip-se nodrag" onMouseDown={start("se")} title={T("n_gripCorner")} />
  </>);
}

/* 狀態表。g＝狀態記號（卡片 UI 架構階段二）：狀態原本只走顏色，人得記色票，
   而且 per-card 自訂色（data.color）會蓋掉狀態色＝語意失效。改成「形狀可辨」——色盲、
   縮到最小、截圖轉灰，記號都還在。顏色仍在，但不再是唯一線索。 */
const S = {
  real:  { c: "#0f9d6b", bg: "rgba(15,157,107,.12)", g: "●", label: T("n_stReal") },
  wait:  { c: "#c47d0a", bg: "rgba(196,125,10,.12)", g: "⏸", label: T("n_stWait") },
  draft: { c: "#7c53d6", bg: "rgba(124,83,214,.14)", g: "◐", label: T("n_stDraft") },
  block: { c: "#d23b39", bg: "rgba(210,59,57,.14)", g: "⊘", label: T("n_stBlock") },
  plan:  { c: "#5f7286", bg: "rgba(95,114,134,.12)", g: "○", label: T("n_stPlan") },
  hub:   { c: "#0a6fb0", bg: "rgba(10,111,176,.10)", g: "◆", label: T("n_stHub") },
  note:  { c: "#c47d0a", bg: "rgba(196,125,10,.12)", g: "▪", label: T("n_stNote") },
};
/* 狀態記號元件（階段二）：卡頭最左，顏色一律取 st.c（純狀態色，不吃 data.color）。
   與左緣色條同屬「狀態專用通道」——自訂款式只能動卡片底色/邊框，動不到這兩樣。 */
function StatusMark({ st }) {
  return <span className="st-mark" style={{ color: st.c }} title={st.label}>{st.g}</span>;
}

// hex → rgba（自訂卡片顏色時，推導淡底色給狀態膠囊）
const rgba = (hex, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
// 卡片實際顏色：自訂 data.color 優先，否則跟隨狀態色
const colorOf = (data, st) => data?.color || st.c;
const bgOf = (data, st) => (data?.color ? rgba(data.color, 0.13) : st.bg);
// 卡片外框樣式：--sc＝邊緣色（可被 data.color 自訂）；data.bg＝自訂背景色；
// data.minH＝高度下限（內容仍為最小）。
// --stc＝純狀態色（階段二新增）：只給左緣狀態色條與狀態記號用，
// 恆等於 st.c——自訂色改得動 --sc，改不動 --stc，兩條通道就此分家。
const cardStyle = (data, c, stc) => ({ "--sc": c, ...(stc ? { "--stc": stc } : {}),
  ...(data?.bg ? { background: data.bg } : {}),
  ...(data?.minW ? { minWidth: data.minW } : {}),
  ...(data?.minH ? { minHeight: data.minH } : {}) });
// 任務清單（dict 化：依時間戳排序輸出純文字；相容舊陣列與 data.memo 單筆註記）
const getTasks = (data) => {
  const arr = taskTexts(data?.tasks);
  return arr.length ? arr : (data?.memo ? [data.memo] : []);
};

// 圖片卡 gallery 正規化（標記/範圍框內嵌各圖，切圖不共用）。
// 回傳 { gallery:[{src,name,strokes,regions}], cur }。legacy（卡層 strokes/regions）
// 折入首圖；無 gallery 但有 src ＝單圖清單。cur＝data.src 對應的索引。
export function imgGalleryOf(data) {
  const g = Array.isArray(data?.gallery) && data.gallery.length
    ? data.gallery.map((x) => ({ src: x.src, name: x.name,
        strokes: Array.isArray(x.strokes) ? x.strokes : [],
        regions: Array.isArray(x.regions) ? x.regions : [],
        shapes: Array.isArray(x.shapes) ? x.shapes : [] }))
    : (data?.src ? [{ src: data.src, name: data.label || T("n_imgName", { n: 1 }),
        strokes: Array.isArray(data.strokes) ? data.strokes : [],
        regions: Array.isArray(data.regions) ? data.regions : [],
        shapes: Array.isArray(data.shapes) ? data.shapes : [] }] : []);
  const cur = Math.max(0, g.findIndex((x) => x.src === data?.src));
  return { gallery: g, cur };
}
// 範圍任務解析：文字以「R{n} 說明」表示歸屬範圍框 R{n}——
// 前綴＝結構指標（顯示膠囊、MCP 回 region 欄），text＝純任務說明。
export function parseRegionTask(t) {
  const m = /^R(\d+)[\s：:]+(.*)$/.exec(String(t || ""));
  return m ? { region: Number(m[1]), text: m[2] } : { region: null, text: String(t || "") };
}
// 封存任務元素：{text, t}（t＝封存時間 ISO）；相容舊資料純字串
const doneTextOf = (d) => (typeof d === "string" ? d : d?.text ?? "");
const doneTimeOf = (d) => (typeof d === "string" ? null : d?.t || null);

// HandlesCtx＝App 提供的 { src, tgt } 每卡每邊使用中端點集合；H 用它判斷單/雙角色顯示。
const HandlesCtx = createContext({});
// SingleSelCtx＝App 提供的「目前是否恰好單選一張卡」布林（Desc 判斷可否就地編輯）。
// 效能：原本每個 Desc 各自 useStore reduce 掃全卡片＝每次 store 變動
// O(N²)；改成 App 算一次、只在「單選⇄非單選」翻轉時才變動的 context。
const SingleSelCtx = createContext(true);
// PagesCtx＝App 提供的「其他分頁」快照 [{id, page, nodes}]（節點卡跨頁引用解析用，
// React Flow store 只有本頁節點，跨頁目標由此查。
const PagesCtx = createContext([]);
// StyleCtx＝App 提供的卡片款式解析語境：{ styles: meta.cardStyles, def: 板預設 appearance }。
// 款式是專案級（存 meta），board default 是 UI 設定；per-card 只存 data.appearance（款式 id）。
const StyleCtx = createContext({ styles: null, def: "classic" });
// useAppearance：讀 data.appearance → 經 StyleCtx 解析成 { cls, vars }（純渲染衍生、不持久化，
// 不入內容指紋——沿量測衍生值慣例，防跨分頁回寫循環）。未知/被刪 id 安全退回板預設→classic。
function useAppearance(data) {
  const { styles, def } = useContext(StyleCtx) || {};
  const id = effectiveAppearance(data?.appearance, def, styles);
  return styleToAttrs(resolveStyle(id, styles));
}
/* 卡片 hover 預覽（peek_preview）：
   原本只有節點卡（pin）有。新架構把說明全文移出卡面後，peek 成為「不點開也能確認
   這張是不是我要的」的主要手段，故推廣到全部卡型。
   · view＝預覽內容來源（pin＝本尊 data、其餘＝自身 data）；null＝不預覽
   · 已選取的卡不預覽（內容就在眼前，再浮一個框只是遮擋）
   · 延遲 400ms 才發事件——滑鼠掃過整排卡不會沿路亂閃 */
// HARE b22a0c02 peek_preview
function usePeek(view, selected) {
  const timer = useRef(null);
  const hide = () => window.dispatchEvent(new CustomEvent("hare:peek", { detail: { hide: true } }));
  useEffect(() => () => clearTimeout(timer.current), []);
  // 選取瞬間收預覽：hover 早於 mousedown 觸發，計時器可能在選取後才到期
  useEffect(() => { if (selected) { clearTimeout(timer.current); hide(); } }, [selected]);
  if (!view || selected) return {};
  return {
    onMouseEnter: (e) => {
      const x = e.clientX, y = e.clientY;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        window.dispatchEvent(new CustomEvent("hare:peek", { detail: {
          x, y, num: view.num || "?", label: view.label || view.title || "",
          status: view.status || "note", desc: String(view.desc || "").split("\n")[0] } }));
      }, 400);
    },
    onMouseLeave: () => { clearTimeout(timer.current); hide(); },
  };
}

const SIDE_POS = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom };

// 每張卡＝「四邊 × 2 角色」＝8 個固定連接點：
//   每一邊（左/右/上/下）都各有「起點」src（實心藍點）＋「終點」tgt（空心藍圈）兩個端點，
//   讓線段的起端/終端都能接到任一邊、也能自由重連（reconnect）到任一邊的對應點——
//   解決「線段從左邊移不到下方」（先前只有右 src／左 tgt 兩點，其他邊無端點可接）。
//   端點 id＝`${side}-src` / `${side}-tgt`；同邊上 src(38%)/tgt(62%) 錯開不重疊。
//   皆 isConnectableStart+End（可起拉、可接收），配合 loose 模式；新線由任一端點拉出即可。
function H({ id }) {
  // handlesCtx = { src, tgt }：本卡各邊「有出線的起點」/「有入線的終點」hid 集合。
  //   src 用於 CSS「未選取只顯示有線段的起點」；兩者合判每邊角色數（見下方 solo 邏輯）。
  const hc = useContext(HandlesCtx) || {};
  const usedS = hc.src?.[id];
  const usedT = hc.tgt?.[id];
  // data.swapSides：已「互換起點/終點位置」的邊集合（該邊的 src/tgt 兩點對調上下/左右位置）。
  const swapSides = useStore((s) => s.nodeLookup?.get(id)?.data?.swapSides);
  const selected = useStore((s) => !!s.nodeLookup?.get(id)?.selected);
  const rf = useReactFlow();
  // 建立/重連線段時，把「進行中的連線」也算進角色判斷：起拉端所在邊＝本卡多一個起點、
  // 目前吸附的目標端所在邊＝本卡多一個終點 → 該邊即時預顯（單點置中或雙點），不必等連線完成。
  // 回傳字串（本卡不涉入時＝""）→ 只有起拉卡與當前吸附卡會重繪，其餘卡不動（效能）。
  const pend = useConnection((c) => {
    if (!c.inProgress) return "";
    const f = c.fromHandle?.nodeId === id && c.fromHandle?.id ? c.fromHandle.id[0] : "";
    const t = c.toHandle?.nodeId === id && c.toHandle?.id ? c.toHandle.id[0] : "";
    return `${f}|${t}`;
  });
  const pi = pend.indexOf("|");
  const pendSrcSide = pi >= 0 ? pend.slice(0, pi) : "";   // 進行中連線：本卡「多出起點」的邊
  const pendTgtSide = pi >= 0 ? pend.slice(pi + 1) : "";  // 進行中連線：本卡「多出終點」的邊
  // 端點佈局變動（⇄ 互換、單點↔雙點、新線改變角色）→ 重量測 handleBounds
  //（「切換/新增線後要 F5 線才跟」：React Flow 只在掛載時量
  // handle 位置，之後改 style 偏移不會自動重量——用 useUpdateNodeInternals 主動更新，
  // 線段當下即重新接到新端點座標。佈局簽名涵蓋所有會移動端點的輸入。）
  const updateInternals = useUpdateNodeInternals();
  // 卡片尺寸也入簽名（實回報「線段端點距卡很遠，搬動卡片後才正確」）：
  // 角點縮放/內容增減改變尺寸時，handle 像素位置全變，但 React Flow 不會自動重量
  // handleBounds——尺寸一變就主動 updateNodeInternals，線段當下貼回卡緣。
  const dims = useStore((s) => {
    const m = s.nodeLookup?.get(id)?.measured;
    return m ? `${m.width}x${m.height}` : "";
  });
  const layoutSig = JSON.stringify([swapSides || null,
    usedS ? [...usedS].sort() : null, usedT ? [...usedT].sort() : null, pend, dims]);
  useEffect(() => { updateInternals(id); }, [layoutSig, id, updateInternals]);
  const toggleSwap = (side) => rf.setNodes((ns) => ns.map((n) => {
    if (n.id !== id) return n;
    const cur = n.data?.swapSides || [];
    const next = cur.includes(side) ? cur.filter((x) => x !== side) : [...cur, side];
    return { ...n, data: { ...n.data, swapSides: next } };
  }));
  // 迴轉鈕位置：與該邊兩端點「同一條線、置中」（起點 −15、迴轉 0、終點 +15 三者共線）——
  // 直接壓在卡片外緣中點上（非外推），與 src/tgt 排成一水平/垂直線；resize grip 已外移讓位。
  const swapStyle = (side) => {
    if (side === "l") return { position: "absolute", left: 0, top: "50%", transform: "translate(-50%,-50%)" };
    if (side === "r") return { position: "absolute", right: 0, top: "50%", transform: "translate(50%,-50%)" };
    if (side === "t") return { position: "absolute", top: 0, left: "50%", transform: "translate(-50%,-50%)" };
    return { position: "absolute", bottom: 0, left: "50%", transform: "translate(-50%,50%)" };
  };
  return (<>
    {["l", "r", "t", "b"].flatMap((side) => {
      const pos = SIDE_POS[side];
      // 端點位置＝距該邊「中央」的固定像素（不用百分比→間距不隨卡片大小變動）：
      // 起點 −15px、終點 +15px（互換時對調）；迴轉鈕在正中央（0）＝兩點正中間。三者共線、間距永遠固定。
      const off = (dpx) => (side === "l" || side === "r" ? { top: `calc(50% + ${dpx}px)` } : { left: `calc(50% + ${dpx}px)` });
      const sw = swapSides && swapSides.includes(side);
      const srcId = `${side}-src`, tgtId = `${side}-tgt`;
      // 此邊角色＝已存邊 ∪ 進行中連線（建立線段時即時預顯）
      const hasSrc = !!(usedS && usedS.has(srcId)) || pendSrcSide === side;   // 有出線（起點）
      const hasTgt = !!(usedT && usedT.has(tgtId)) || pendTgtSide === side;   // 有入線（終點）
      // 預設＝單點置中：每邊只露一個端點（offset 0）。唯有同一邊「起點＋終點都有」
      //（新建連線多出對向角色）才拆成雙點（±15）＋切換鈕。其餘一律單點、不出鈕。
      const showDouble = hasSrc && hasTgt;
      const soloTgt = hasTgt && !hasSrc;              // 純入線邊：露終點；否則預設露起點
      const srcVisible = !soloTgt;                    // 起點：雙角色/起點單點/空側皆顯示；純入線才讓位
      const tgtVisible = hasTgt;                      // 終點：僅有入線才顯示（雙角色選取才現，soloTgt 恆現）
      // h-used＝未選取也恆顯示（有線段的端點）；h-mute＝強制隱藏讓位的對側端點（選取態也不現）。
      const srcCls = `h-conn h-src${hasSrc ? " h-used" : ""}${srcVisible ? "" : " h-mute"}`;
      const tgtCls = `h-conn h-tgt${soloTgt ? " h-used" : ""}${tgtVisible ? "" : " h-mute"}`;
      const srcOff = showDouble ? (sw ? 15 : -15) : 0;   // 單點模式一律置中（0）
      const tgtOff = showDouble ? (sw ? -15 : 15) : 0;
      const out = [
        <Handle key={srcId} type="source" id={srcId} position={pos}
          isConnectableStart isConnectableEnd className={srcCls} style={off(srcOff)} />,
        <Handle key={tgtId} type="source" id={tgtId} position={pos}
          isConnectableStart isConnectableEnd className={tgtCls} style={off(tgtOff)} />,
      ];
      // 選取時：兩端點中間放迴轉鈕——僅雙點模式（同邊起點＋終點都有）才出；單點不出鈕。
      if (selected && showDouble) out.push(
        <button key={`${side}-swap`} className="h-swap nodrag nopan" style={swapStyle(side)}
          title={T("n_swapSide")}
          onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); toggleSwap(side); }}
          onClick={(e) => e.stopPropagation()}>⇄</button>
      );
      return out;
    })}
  </>);
}

/* 程式對應（路徑＋標籤）唯讀顯示：路徑＝涉及檔案；標籤＝func 入口上方 HARE 註解。
   多組時每組上方補 #N。編輯一律在屬性框內。 */
// HARE 6af26593 Refs
function Refs({ data, selected }) {
  const refs = data?.refs || [];
  // 路徑預設折疊：只顯示「程式 N 組 ▸」一行，點擊展開，避免長路徑影響卡片閱讀
  const [open, setOpen] = useState(false);
  // 取消選取卡片＝自動收合：展開只在選取態下有意義，離開就還原摺疊
  useEffect(() => { if (!selected) setOpen(false); }, [selected]);
  if (!refs.length) return null;
  const multi = refs.length > 1;
  // 卡片未選取前折疊鈕無動作：點擊只選卡，不誤觸展開/收合
  if (!open) return (
    <button className={`refs-fold ${selected ? "nodrag" : ""}`}
      title={selected ? T("n_refsExpand") : T("n_refsSelectFirst")}
      onClick={selected ? (e) => { e.stopPropagation(); setOpen(true); } : undefined}>▸ {T("n_refsCount", { n: refs.length })}</button>
  );
  return (
    <div className="refs">
      <button className={`refs-fold on ${selected ? "nodrag" : ""}`} title={T("n_refsCollapse")}
        onClick={selected ? (e) => { e.stopPropagation(); setOpen(false); } : undefined}>▾ {T("n_refsCount", { n: refs.length })}</button>
      {refs.map((r, i) => (
        <div className="ref-item" key={i}>
          {multi && <div className="ref-n">#{i + 1}</div>}
          {r.path && <div className="kv code"><span className="k">{T("n_labelPath")}</span>
            {/* N6：檔案級路徑點擊也開內建閱讀器（無 uuid＝從檔首起、可捲；VSCode/系統開啟走窗內鈕） */}
            <a className="v ref-link nodrag" href="#" title={T("n_openReader")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation();
                window.dispatchEvent(new CustomEvent("hare:open-reader", { detail: { path: r.path || "" } }));
              }}>{r.path}</a></div>}
          {/* 雙層制：檔案級（無 uuid）只顯示路徑；
              函式級（帶 uuid＝程式碼有 HARE 錨點）才顯示標籤（＝錨點名，點擊跳行） */}
          {r.label && r.uuid && <div className="kv code"><span className="k">{T("n_labelTag")}</span>
            {/* N6 內建閱讀器：點函數級標籤＝開浮動閱讀器顯示錨點片段（VSCode/系統開啟改為窗內按鈕）。
                與 peek 同慣例：nodes 只發 window 事件，App 承接抓片段並渲染浮動窗。 */}
            <a className="v ref-link nodrag" href="#" title={T("n_openReader")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault(); e.stopPropagation();
                window.dispatchEvent(new CustomEvent("hare:open-reader",
                  { detail: { path: r.path || "", uuid: r.uuid, label: r.label } }));
              }}>{r.label}</a></div>}
        </div>
      ))}
    </div>
  );
}

/* 開啟任務封存頁：node 元件與 Flow 之間用 window 事件解耦（零依賴） */
const openArchive = (cardId) => window.dispatchEvent(new CustomEvent("hare:open-archive", { detail: cardId ?? null }));

/* 說明欄已退場（卡片 UI 架構階段四）：說明全文改由 L3 側欄（雙擊卡片）讀寫。
   原因＝長文放在卡面上，卡高必然被文字長度決定，一板大小不一的方塊正是掃視時沒有落點的
   主因。連帶移除的補丁：進編輯時鎖卡寬（lockW）——那是「卡片會因內容換成輸入框而跳動」
   的補救，寬度失控的根因隨說明一起搬走後就不需要了。
   卡面上仍看得到「有沒有說明」：徽章列的『有說明』；要看首行＝hover peek（階段一）。 */

/* 任務欄（所有節點共用；W1-2-9：任務輸入/編輯統一走畫面下緣的輸入列）：
   · 每項任務 hover 顯示 ✓（完成→封存）；點任務文字＝載入底部輸入列編輯回存
   · 卡片內不再有輸入框與「＋ 加入」
   · 封存任務不列出，只留「✓ 已完成 N 項」徽章開任務封存頁 */
// HARE f146f162 Tasks
function Tasks({ data, id, selected }) {
  const rf = useReactFlow();
  const list = getTasks(data);
  const done = data?.doneTasks || [];
  // 未選取＝一切滑鼠動作只做選卡（同 refs 折疊鈕慣例）：
  // 任務列的編輯/完成/刪除只在卡片已選取時啟用；pin 預覽（selected undefined）恆唯讀
  const editable = selected === true;
  if (!list.length && !done.length) return null;
  const patch = (p) => rf.setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)));
  // HARE 9a1c22e0 complete
  // B19 dict 化：依排序索引刪鍵（保其餘任務原時間戳）；memo 情境由 setTaskAt 對空 dict 無害
  const complete = async (i) => {
    if (!(await confirmDialog(T("n_confirmArchiveTask", { t: String(list[i]).slice(0, 30) })))) return;
    const t = list[i];
    patch({ tasks: setTaskAt(data?.tasks, i, null),
      doneTasks: [...done, { text: t, t: new Date().toISOString() }], memo: undefined });
  };
  const removeTask = async (i) => {
    if (!(await confirmDialog(T("n_confirmDeleteTask", { t: String(list[i]).slice(0, 30) })))) return;
    patch({ tasks: setTaskAt(data?.tasks, i, null), memo: undefined });
  };
  // 點任務→通知底部輸入列載入編輯（window 事件解耦）
  // HARE 14dab2b7 editInBar
  const editInBar = (i, t) => window.dispatchEvent(
    new CustomEvent("hare:edit-task", { detail: { cardId: id, index: i, text: t } }));
  return (<>
    {list.length > 0 && (
      <div className="tasks">
        <span className="tasks-label">{T("n_task")}</span>
        <ul className="task-list task-editor">
          {list.map((t, i) => {
            const rp = parseRegionTask(t); // 範圍任務：R 編號改膠囊、說明剝前綴
            return (
            <li className="task-item" key={i}>
              <span className={`tk-body ${editable ? "nodrag" : ""}`} title={editable ? T("n_taskEditHint") : undefined}
                onClick={editable ? (e) => { e.stopPropagation(); editInBar(i, t); } : undefined}>
                {rp.region != null && <span className="tk-region">R{rp.region}</span>}
                <Md text={rp.text} /></span>
              {editable && (<>
                <button className="tk-done" title={T("n_taskDone")}
                  onClick={(e) => { e.stopPropagation(); complete(i); }}>🗄</button>
                <button className="tk-del2" title={T("n_taskDel")}
                  onClick={(e) => { e.stopPropagation(); removeTask(i); }}>✕</button>
              </>)}
            </li>
            );
          })}
        </ul>
      </div>
    )}
    {done.length > 0 && (
      <button className="done-badge nodrag" title={T("n_doneBadge")}
        onClick={(e) => { e.stopPropagation(); openArchive(id); }}>{T("n_doneCount", { n: done.length })}</button>
    )}
  </>);
}


/* L1 徽章列（卡片 UI 架構階段三）：卡片收起時的「內容索引」——
   這張卡有說明嗎、幾項任務、幾則留言、幾張子卡。數字取代掃描：使用者不必把內文攤在
   卡面上才知道裡面有東西。全空的卡不畫這列（免得一排 0 反而變噪音）。
   kids 走 parentLookup（O(1)），與 ChildSpacer 同慣例——不用 O(N) 選擇器掃全卡。 */
// HARE 3b7d51c9 CardBadges
function CardBadges({ id, data }) {
  const kids = useStore((s) => (id ? s.parentLookup?.get(id)?.size ?? 0 : 0));
  const nTask = getTasks(data).length;
  const nDone = Array.isArray(data?.doneTasks) ? data.doneTasks.length : 0;
  const nCmt = Array.isArray(data?.comments) ? data.comments.length : 0;
  const nAcc = acceptsOf(data).length;
  // 「有說明」徽章移除：它只說明「有東西」卻不帶量，
  // 對掃視沒有幫助；要看說明＝hover peek 或點卡片開資訊頁。其餘徽章都帶數字，留著。
  if (!nAcc && !nTask && !nDone && !nCmt && !kids) return null;
  return (
    <div className="cb-row">
      {nAcc > 0 && <span className="cb cb-acc">{T("cb_accept")} {nAcc}</span>}
      {nTask > 0 && <span className="cb">{T("cb_task")} {nTask}</span>}
      {nDone > 0 && <span className="cb cb-done">{T("cb_done")} {nDone}</span>}
      {nCmt > 0 && <span className="cb">{T("cb_comment")} {nCmt}</span>}
      {kids > 0 && <span className="cb">{T("cb_kids")} {kids}</span>}
    </div>
  );
}

/* 鎖：鎖定＝只能看，不能刪除/移動。lane（泳道背景）解鎖時可移動＋調大小
   （selectable 才能顯示縮放控制點）、且永不可刪除。點鎖切換。 */
function Lock({ id, locked, lane }) {
  const rf = useReactFlow();
  const toggle = (e) => {
    e.stopPropagation();
    rf.setNodes((ns) => ns.map((n) => (n.id === id
      ? {
          ...n, draggable: locked,
          selectable: lane ? locked : (n.selectable ?? true),
          deletable: lane ? false : locked,
          data: { ...n.data, locked: !locked },
        }
      : n)));
  };
  const title = lane
    ? (locked ? T("n_laneLocked") : T("n_laneUnlock"))
    : (locked ? T("n_cardLocked") : T("n_cardUnlock"));
  // 純線段鎖圖示（emoji 換線條、外框同其他按鈕）——
  // feather 風格：鎖體矩形＋鎖梁弧線；開鎖＝弧線不閉合
  return (
    <button className={`lock nodrag ${locked ? "on" : ""}`} onMouseDown={(e) => e.stopPropagation()}
      onClick={toggle} title={title}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="9" rx="2" />
        {locked
          ? <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          : <path d="M8 11V7a4 4 0 0 1 7.8-1.3" />}
      </svg>
    </button>
  );
}

// B14 認領徽章：卡片被 agent 認領（data.claim={agent,t}）時，於卡頭顯示小徽章
// （彩點＋認領者短名）。認領心跳逾 15 分（stale）→ 淡化顯示（＝可被別的 agent 接手）。
// 純顯示元件，不攔截點擊/拖曳，維持既有卡頭排版。
// HARE b14c1a1e ClaimBadge
const CLAIM_STALE_MS = 15 * 60 * 1000;
function ClaimBadge({ claim }) {
  if (!claim || !claim.agent) return null;
  const ts = Date.parse(claim.t || "");
  const stale = !ts || (Date.now() - ts > CLAIM_STALE_MS);
  const name = String(claim.agent);
  const short = name.length > 10 ? `${name.slice(0, 9)}…` : name;
  return (
    <span className={`claim-badge ${stale ? "stale" : ""}`}
      title={stale ? T("n_claimStale", { name }) : T("n_claimActive", { name })}>
      <span className="claim-dot" />{short}
    </span>
  );
}

// HARE 84ec5a46 LaneNode
function LaneNode({ id, data, selected }) {
  return (
    <div className={`lane ${data.locked === false ? "unlocked" : ""}`} style={{ "--lc": data.color }}>
      <RZ show={selected} w={500} h={240} />
      <span className="lane-title">{data.title}<span className="lane-sub">{data.sub}</span></span>
      <span className="lane-lock"><Lock id={id} locked={data.locked !== false} lane /></span>
    </div>
  );
}

/* 子卡片區：位於「標籤區（說明/程式）」與「任務區」中間的獨立畫布，
   有子卡片才出現。spacer 在 DOM 流內佔位（任務區自然被推到子卡區之下、不重疊），
   並量測自己的 offsetTop 回寫 data.childTop（子卡片 y 下限），高度由
   auto-grow effect 依子卡 bounding 維護（data.childZoneH）。 */
function ChildSpacer({ id, data }) {
  const rf = useReactFlow();
  const ref = useRef(null);
  // parentLookup＝O(1) 查「有無子卡」；舊寫法 s.nodes.some 是 O(N) 選擇器，
  // 每個節點各掛一個＝每次 store 變動 O(N²)（效能）
  const hasKids = useStore((s) => (s.parentLookup?.get(id)?.size ?? 0) > 0);
  useEffect(() => {
    if (!hasKids || !ref.current) return;
    const top = ref.current.offsetTop;
    // 閾值放寬：跨分頁字體渲染有 px 級差異，太敏感會互相改寫（量測值亦不入指紋）
    if (Math.abs((data.childTop || 0) - top) > 6) {
      rf.setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, childTop: top } } : n)));
    }
  });
  if (!hasKids) return null;
  return <div ref={ref} className="child-spacer nodrag" style={{ height: data.childZoneH || 70 }} title={T("n_childZone")} />;
}

/* 自訂卡：名稱＝編號右邊文字；說明以「需要」樣式的 kv 列顯示；皆於屬性框編輯 */
// HARE c3d7498c NoteNode
function NoteNode({ id, data, selected }) {
  const st = S[data.status] || S.note;
  const c = colorOf(data, st);
  const app = useAppearance(data); // W1-3-8 per-card 款式
  const peek = usePeek(data, selected); // 階段一：hover 預覽推廣到主卡
  return (
    <div className={`card note-card st-${data.status || "note"} ${app.cls}`} style={{ ...cardStyle(data, c, st.c), ...app.vars }} {...peek}>
      {/* N11-3 鏡像投影：唯讀罩層——擋掉所有卡內互動，點擊＝跳本尊（跨頁沿 pin 傳送慣例） */}
      {data.mirror && (
        <div className="mir-ovl nodrag" title={T("n_mirrorGo")}
          onClick={(e) => {
            e.stopPropagation();
            if (data.mirrorPid) window.dispatchEvent(new CustomEvent("hare:focus-page-card",
              { detail: { pid: data.mirrorPid, cardId: data.mirrorSrc } }));
            else window.dispatchEvent(new CustomEvent("hare:focus-card", { detail: data.mirrorSrc }));
          }}>
          <span className="mir-tag">⧉ {T("n_mirrorTag")}</span>
        </div>
      )}
      <Grips id={id} show={selected} />
      <H id={id} />
      <div className="note-head card-top">
        <StatusMark st={st} />
        <span className="num" style={{ color: c, borderColor: c }}>{data.num}</span>
        <span className="title">{data.label}</span>
        <ClaimBadge claim={data.claim} />
        {/* 投影卡不顯示鎖：唯讀由罩層保證，鎖是本尊的事 */}
        {!data.mirror && <Lock id={id} locked={data.locked} />}
      </div>
      {/* L1 徽章列＝收起時的內容索引（階段三）；L1/L2 皆顯示 */}
      <CardBadges id={id} data={data} />
      {/* 卡身（L2）：未選取時整塊 display:none——卡高不再被說明長度決定。
          內層 div 才是捲動容器，避免 overflow 剪掉卡外的把手/端點。 */}
      {/* 說明全文已移出卡面（階段四）：長文是卡高失控的主因，改由 L3 側欄（雙擊）讀寫。
          卡面上「有沒有說明」由徽章列的『有說明』指示；要看首行＝hover peek。 */}
      <div className="card-body">
        <Refs data={data} selected={selected} />
        {/* 投影卡子卡統計（子卡不鋪樹、以數字說明） */}
        {data.mirror && (data.mirrorDeep || 0) > 0 && (
          <div className="mir-stats">{T("n_mirrorKids", { n: data.mirrorKids || 0 })}
            {(data.mirrorDeep || 0) > (data.mirrorKids || 0) ? T("n_mirrorDeep", { n: data.mirrorDeep }) : ""}</div>
        )}
      </div>
      <ChildSpacer id={id} data={data} />
      <Tasks data={data} id={id} selected={selected} />
    </div>
  );
}

/* 節點卡：引用另一張卡片的輕量圖釘卡。未選取＝只顯示目標卡編號＋標題；
   選取＝於卡片外側（右方）彈出目標卡完整內容（說明/程式/任務，唯讀）。
   目標卡以 id 或編號（num）引用；目標更新時（useStore 訂閱）即時反映。 */
// HARE 5eae08cc PinNode
function PinNode({ id, data, selected }) {
  const target = useStore((s) => s.nodes.find(
    (n) => n.id === data.refCard || (data.refCard && n.data?.num === data.refCard)));
  // 跨頁引用：本頁找不到→掃其他分頁（PagesCtx）。找到＝正常
  // 顯示＋分頁籤、傳送鈕改「切頁＋跳卡」；兩邊都沒有才是真的「引用卡不存在」。
  const pages = useContext(PagesCtx) || [];
  let remote = null;
  if (!target && data.refCard) {
    for (const p of pages) {
      const m = (p.nodes || []).find((n) => n.id === data.refCard || n.data?.num === data.refCard);
      if (m) { remote = { n: m, page: p }; break; }
    }
  }
  const tnode = target || remote?.n || null;
  const td = tnode?.data || {};
  const st = S[td.status] || S.note;
  // 未指定（剛建立）＝灰色提示「選擇後新增」；有指定但目標消失＝紅色警示
  const unassigned = !data.refCard;
  const c = tnode ? colorOf(td, st) : unassigned ? "#9aa7b5" : "#d23b39";
  const app = useAppearance(data); // W1-3-8 per-card 款式
  // 版面（重排）：◈ 置左垂直置中｜第一行＝編號靠左＋按鈕群靠右
  //（流式排版，根除絕對定位疊鈕）｜第二行＝目標卡標題。
  // ☰ 預覽視窗已移除（同指示）：按鈕保留、預留後續功能；投影＝單鈕 ⊞/⊟ 切換
  //（treeOpen 由 App displayNodes 注入）。
  const treeOpen = !!data.treeOpen;
  // B22 hover 預覽：預覽內容取本尊 td（只有目標存在才預覽）；實作共用 usePeek
  const peek = usePeek(tnode ? td : null, selected);
  return (
    <div className={`card pin-card st-${(tnode ? td.status : data.status) || "note"} ${app.cls}`} style={{ ...cardStyle(data, c, st.c), ...app.vars }} {...peek}>
      <Grips id={id} show={selected} />
      <H id={id} />
      <div className="note-head card-top pin-head">
        <span className="pin-ico" title={T("n_pinIco")}>◈</span>
        <div className="pin-main">
          <div className="pin-row1">
            {tnode && <StatusMark st={st} />}
            <span className="num" style={{ color: c, borderColor: c }}>{td.num || "?"}</span>
            <span className="pin-btns nodrag">
              {tnode && (
                <button className="pin-btn nodrag" title={treeOpen ? T("n_treeCollapse") : T("n_treeExpand")}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent("hare:pin-tree",
                      { detail: { pinId: id, delta: treeOpen ? -99 : 1 } }));
                  }}>{treeOpen ? "⊟" : "⊞"}</button>
              )}
              {/* ☰＝預留鈕（保留按鈕，後續接新功能） */}
              <button className="pin-btn nodrag" title={T("n_pinReserved")}
                onClick={(e) => e.stopPropagation()}>☰</button>
              {tnode && (
                <button className="pin-btn pin-btn-go nodrag"
                  title={remote ? T("n_pinGoPage", { name: remote.page.page }) : T("n_pinGo")}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (remote) window.dispatchEvent(new CustomEvent("hare:focus-page-card",
                      { detail: { pid: remote.page.id, cardId: remote.n.id } }));
                    else window.dispatchEvent(new CustomEvent("hare:focus-card", { detail: target.id }));
                  }}>➤</button>
              )}
              {!tnode && (
                <button className="pin-btn pin-btn-go nodrag" title={T("n_pinReassign")}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent("hare:assign-pin", { detail: id }));
                  }}>⌖</button>
              )}
              <Lock id={id} locked={data.locked} />
            </span>
          </div>
          <div className="pin-row2">
            <span className="title" style={!tnode && unassigned ? { color: "#9aa7b5" } : undefined}>
              {tnode ? (td.label || td.title || "") : unassigned ? T("n_pinUnassigned") : T("n_pinMissing")}
              {/* 引用到資源卡內特定檔案（refFile）：標題後綴檔名 */}
              {tnode && data.refFile ? `／${data.refFile}` : ""}
              {remote && <span className="tl-pg">{remote.page.page}</span>}</span>
          </div>
        </div>
      </div>
      {/* 徽章列取本尊內容（階段三）：pin 是引用卡，索引要反映被引用的那張 */}
      {tnode && <CardBadges id={tnode.id} data={td} />}
      {/* 本尊任務直接顯示：純展示、不可調整——
          selected=false＝列恆為靜態，任務名稱後的編輯/封存鈕一律不出現 */}
      {tnode && <div className="card-body"><Tasks data={td} id={tnode.id} selected={false} /></div>}
    </div>
  );
}

// memo：React Flow 對未變動的節點沿用同一組 props（App 端也保留未變卡片的物件身分），
// memo 讓這些卡完全跳過重繪——大板上拖一張卡不再重繪全部卡片（效能）。
/* 依賴卡：非主程式的外部 import（套件/內建模組）。
   只顯示套件/函式名稱＋引用它的程式路徑標籤（refs）；不建立子資源（無 ChildSpacer/任務）。 */
// HARE d3p0c4d1 DepNode
function DepNode({ id, data, selected }) {
  const st = S[data.status] || S.plan;
  const c = colorOf(data, st);
  const app = useAppearance(data); // W1-3-8 per-card 款式
  const peek = usePeek(data, selected); // 階段一：hover 預覽推廣
  return (
    <div className={`card dep-card st-${data.status || "plan"} ${app.cls}`} style={{ ...cardStyle(data, c, st.c), ...app.vars }} {...peek}>
      <Grips id={id} show={selected} />
      <H id={id} />
      <div className="card-top">
        <StatusMark st={st} />
        <span className="num" style={{ color: c, borderColor: c }}>{data.num}</span>
        <span className="title dep-name">{data.label}</span>
        <span className="pill" style={{ color: c, background: bgOf(data, st) }}>{T("n_depLabel")}</span>
        <Lock id={id} locked={data.locked} />
      </div>
      <div className="card-body"><Refs data={data} selected={selected} /></div>
    </div>
  );
}

/* 資源卡（檔案總管改版）：圖像級檔案總管的節點。
   - listing 每檔案一個虛線框列：單擊選取、雙擊系統預設開啟（/api/open-path）；
     列右緣隱藏端點（選取卡時顯現）可與其他卡連線（handle id＝f:檔名，穩定鍵）。
   - 首行固定「子資料夾」（有才顯示）：點擊在卡右掛清單（同圖片卡 gallery 模式）——
     同頁有對應卡（label 相符）＝白色點擊跳卡，沒有＝灰度。
   - 可建子卡（ChildSpacer）：檔案總管建構時子卡通常＝子資料夾資源卡。
   listing 相容：舊字串陣列＝檔案；物件形 {name, kind: "file"|"dir", path?}。 */
// HARE 2e50c4d2 ResNode
function ResNode({ id, data, selected }) {
  const st = S[data.status] || S.note;
  const c = colorOf(data, st);
  const app = useAppearance(data); // W1-3-8 per-card 款式
  const peek = usePeek(data, selected); // 階段一：hover 預覽推廣
  const upd = useUpdateNodeInternals();
  // 正規化（含舊字串清單）：`xxx/`＝資料夾、`…` 開頭＝聚合列（不可點、無端點）、其餘＝檔案
  const items = (Array.isArray(data.listing) ? data.listing : []).map((x) => {
    if (typeof x !== "string") return x || {};
    if (x.endsWith("/")) return { name: x.slice(0, -1), kind: "dir" };
    if (x.startsWith("…")) return { name: x, kind: "more" };
    return { name: x, kind: "file" };
  }).map((x) => (x.kind === "file" && String(x.name).startsWith("…") ? { ...x, kind: "more" } : x));
  const files = items.filter((x) => x.kind === "file");
  const dirs = items.filter((x) => x.kind === "dir");
  const legacyMore = items.filter((x) => x.kind === "more");
  // 有線的列端點（HandlesCtx.rowSrc）：恆顯示（實心換色）＋摺疊豁免——線的起點必須連在
  // 看得見的端點上（終點端照舊不顯示）
  const usedRows = (useContext(HandlesCtx) || {}).rowSrc?.[id] || new Set();
  // 連線中規則：從「他處」起線＝本卡整排列端點亮起可接；
  // 從「本卡的列」起線＝其他列不顯示（列不可接自己資源卡內的列）
  const conn = useConnection();
  const inConn = !!conn?.inProgress;
  const connFromSelf = inConn && conn.fromNode?.id === id;
  // 檔案 >10＝摺疊：最下方一列為摺疊列（點擊展開/收合、不給端點）
  const MAX_ROWS = 10;
  const [expand, setExpand] = useState(false);
  const shown = expand ? files
    : files.filter((f, i) => i < MAX_ROWS || usedRows.has(`f:${f.name}`));
  const foldedN = files.length - shown.length;
  const [selRow, setSelRow] = useState(null);      // 單擊選取列（檔名）
  const [dirsOpen, setDirsOpen] = useState(false); // 子資料夾右掛清單
  useEffect(() => { if (!selected) { setSelRow(null); setDirsOpen(false); } }, [selected]);
  // 點列外自動取消列選取：pointerdown 委派——點到的不是
  // 本卡的「同一列」（含列上端點）就清掉；點別列由該列 onClick 接手改選
  useEffect(() => {
    if (!selRow) return;
    const h = (e) => {
      const el = e.target instanceof Element ? e.target.closest(".res-item") : null;
      if (!el || el.dataset.rid !== `${id}:${selRow}`) setSelRow(null);
    };
    window.addEventListener("pointerdown", h, true);
    return () => window.removeEventListener("pointerdown", h, true);
  }, [selRow, id]);
  useEffect(() => { upd(id); }, [shown.length, id, upd]); // 列端點增減（含展開/收合）→重量測
  // 子資料夾對應卡（同頁）：label 相符＝已建（白色可跳）；用 useStore 即時反映
  const dirCards = useStore((s) => dirs.map((d) =>
    s.nodes.find((n) => n.id !== id && (n.type === "res" || n.type === "note")
      && n.data?.label === d.name)?.id || null), (a, b) => a.join() === (b || []).join());
  const basePath = (data.refs || []).find((r) => r.path)?.path || "";
  const openFile = async (it) => {
    const p = it.path || (basePath ? `${basePath}/${it.name}` : it.name);
    try {
      const proj = new URLSearchParams(window.location.search).get("project");
      await fetch(`/api/open-path${proj ? `?project=${encodeURIComponent(proj)}` : ""}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }) });
    } catch { /* 伺服器未起：無法開檔 */ }
  };
  return (
    <div className={`card res-card st-${data.status || "note"} ${app.cls}`} style={{ ...cardStyle(data, c, st.c), ...app.vars }} {...peek}>
      <Grips id={id} show={selected} />
      <H id={id} />
      <div className="card-top">
        <StatusMark st={st} />
        <span className="num" style={{ color: c, borderColor: c }}>{data.num}</span>
        <span className="title">{data.label}</span>
        <span className="pill" style={{ color: c, background: bgOf(data, st) }}>{T("n_resLabel")}</span>
        <Lock id={id} locked={data.locked} />
      </div>
      {/* 資源卡／圖片卡不收卡身：檔案清單與圖就是它們的識別本體，收起來等於看不出是哪張。
          只加徽章列，享有同一套索引語彙（階段三） */}
      <CardBadges id={id} data={data} />
      {dirs.length > 0 && (
        <button className={`res-dirs-btn nodrag${dirsOpen ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); setDirsOpen((v) => !v); }}>
          📁 {T("n_resSubdirs")}（{dirs.length}）
        </button>
      )}
      {dirsOpen && (
        <div className="res-subdirs nodrag nopan">
          <div className="ig-head">{T("n_resSubdirs")}</div>
          {dirs.map((d, i) => (
            <button key={d.name} className="rs-item" disabled={!dirCards[i]}
              title={dirCards[i] ? T("n_resGoDir", { name: d.name }) : T("n_resNoDirCard")}
              onClick={(e) => {
                e.stopPropagation();
                if (dirCards[i]) window.dispatchEvent(new CustomEvent("hare:focus-card", { detail: dirCards[i] }));
              }}>{d.name}</button>
          ))}
        </div>
      )}
      {(files.length > 0 || legacyMore.length > 0) && (
        <div className="res-items nodrag">
          {shown.map((f) => (
            <div key={f.name} className={`res-item${selRow === f.name ? " on" : ""}`}
              data-rid={`${id}:${f.name}`} title={T("n_resItemTip")}
              onClick={(e) => {
                e.stopPropagation(); setSelRow(f.name);
                // 指定目標模式的畫布直選：列點擊上報 App——
                // assign 模式中＝confirm 綁定該檔案（非 assign 模式 App 端不理會）
                window.dispatchEvent(new CustomEvent("hare:res-row-pick", { detail: { nodeId: id, file: f.name } }));
              }}
              onDoubleClick={(e) => { e.stopPropagation(); openFile(f); }}>
              <span className="ri-name">{f.name}</span>
              {/* 列級端點：點選「該列」才顯示端點——
                  選卡只顯示卡片自身端點，不整排亮 */}
              <Handle type="source" position={Position.Right} id={`f:${f.name}`}
                className={`ri-handle${selRow === f.name ? " show" : ""}${usedRows.has(`f:${f.name}`) ? " used" : ""}${inConn && !connFromSelf ? " cshow" : ""}${connFromSelf && conn.fromHandle?.id !== `f:${f.name}` ? " cmute" : ""}`} />
            </div>
          ))}
          {(foldedN > 0 || expand) && files.length > MAX_ROWS && (
            <div className="res-item res-more"
              onClick={(e) => { e.stopPropagation(); setExpand((v) => !v); }}>
              <span className="ri-name">{expand ? T("n_resFold") : T("n_resMore", { n: foldedN })}</span>
            </div>
          )}
          {legacyMore.map((m, i) => (
            <div key={`m${i}`} className="res-item res-more res-more-static"><span className="ri-name">{m.name}</span></div>
          ))}
        </div>
      )}
      {/* 路徑列改檔案總管開啟（資料夾不走 VSCode） */}
      {(data.refs || []).filter((r) => r.path).map((r, i) => (
        <div className="kv code res-path" key={i}><span className="k">{T("n_labelPath")}</span>
          <a className="v ref-link nodrag" href="#" title={T("n_openInExplorer", { path: toAbsPath(r.path) })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openFile({ path: r.path }); }}>{r.path}</a></div>
      ))}
      <ChildSpacer id={id} data={data} />
    </div>
  );
}

/* 圖片卡 v2：貼上 UI 截圖 → 拉「範圍標示框」（虛線框、
   自動編號 R1、R2…）→ 點框/編號＝任務輸入自動帶編號（R{n} 前綴入 data.tasks）——
   agent 讀卡時拿到圖檔路徑＋各範圍框任務，看圖對位。可手繪標記；選取時右側掛
   「圖片清單」浮動框（一卡多圖、點選切換）。
   資料形狀：data.src＝目前顯示圖（資產 URL）；data.gallery＝[{src,name}]；
   data.strokes＝[[[x,y]…]…]；data.regions＝[{id,n,x,y,w,h}]——座標一律相對（0..1），
   等比縮放不跑位。任務歸屬＝文字以「R{n}」開頭。 */
// 卡內形狀標註（方框/圓圈/文字）可選色盤
const SHAPE_COLORS = ["#e5484d", "#f5a623", "#2ba24c", "#0a6fb0", "#8b5cf6", "#111827", "#ffffff"];
// HARE 1ma9e0d3 ImgNode
function ImgNode({ id, data, selected }) {
  const rf = useReactFlow();
  const peek = usePeek(data, selected); // 階段一：hover 預覽推廣（未選取才作用，不干擾繪圖）
  const [mode, setMode] = useState(null);     // null｜"draw"（手繪）｜"region"（拉範圍框）
  const [cur, setCur] = useState(null);       // 手繪中的筆畫（相對點陣列）
  const [curBox, setCurBox] = useState(null); // 拉框中 {x0,y0,x1,y1}（僅預覽用）
  const [selRegion, setSelRegion] = useState(null); // 選取中的範圍框 id（顯示 ✕ 可刪）
  const [shapeColor, setShapeColor] = useState("#e5484d"); // 形狀（方框/圓圈/文字）顏色
  const [textDraft, setTextDraft] = useState(null); // 文字輸入中 {x,y,value}
  const boxRef = useRef(null);
  const toolsRef = useRef(null);       // 工具列量測：卡片最小寬＝工具列總寬
  const [toolsW, setToolsW] = useState(0);
  // 拖曳真相存 ref（硬化）：快速拖曳時 pointerdown/up 可能落在同一 React
  // 批次，state 未 flush 會漏建框/漏建筆畫——pointerup 一律讀 ref，免批次競態。
  const dragRef = useRef(null);
  // 標記/範圍框「跟著圖片跑」：strokes 與 regions 內嵌各張
  // gallery 圖片，切圖＝換該圖自己的一組（不共用）；範圍框 R 編號則跨全清單連續。
  const { gallery, cur: curIdx } = imgGalleryOf(data);
  const curItem = gallery[curIdx] || { src: data.src, name: data.label, strokes: [], regions: [], shapes: [] };
  const strokes = curItem.strokes;
  const regions = curItem.regions;
  const shapes = curItem.shapes || []; // 卡內就地標註：方框/圓圈/文字（畫在顯示圖上，隨圖走）
  const allRegions = gallery.flatMap((g) => g.regions); // 連續編號用：跨全清單取最大 n
  const hasMarks = strokes.length || shapes.length;
  useEffect(() => { if (!selected) { setMode(null); setCur(null); setCurBox(null); setSelRegion(null); setTextDraft(null); } }, [selected]);
  // 卡片最小寬以下方工具列總寬為準：量測工具列按鈕總寬＋卡片內距，
  // 作為 NodeResizer 下限與寬度地板。按鈕 flex:none 不縮，量測穩定；標籤固定，量一次即可。
  useEffect(() => {
    const el = toolsRef.current;
    if (!el) return;
    const card = el.closest(".img-card");
    const cs = card ? getComputedStyle(card) : null;
    const padX = cs ? (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)) : 24;
    const w = [...el.children].reduce((s, b) => s + b.offsetWidth, 0) + 4 * Math.max(0, el.children.length - 1);
    setToolsW(Math.ceil(w + padX));
  }, []);
  const patch = (p) => rf.setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)));
  // 只改「目前顯示圖」的 strokes/regions/shapes，寫回 gallery（並清掉 legacy 卡層同名鍵）
  const patchCur = (fields) => patch({
    gallery: gallery.map((g, i) => (i === curIdx ? { ...g, ...fields } : g)),
    strokes: undefined, regions: undefined, shapes: undefined,
  });
  // 刪除圖片清單中的一張（帶提醒）：連同該圖的標記/範圍框移除；刪的是目前顯示圖就切到相鄰一張。
  const removeImg = async (i) => {
    const g = gallery[i];
    if (!(await confirmDialog(T("n_confirmDelImg", { name: g?.name || T("n_imgName", { n: i + 1 }) })))) return;
    const next = gallery.filter((_, k) => k !== i);
    const newSrc = g?.src === data.src ? (next[Math.min(i, next.length - 1)]?.src) : data.src;
    patch({ gallery: next, src: newSrc, strokes: undefined, regions: undefined, shapes: undefined });
  };
  const relPt = (e) => {
    const r = boxRef.current.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  // 範圍框任務：data.tasks 內以「R{n}」開頭者（顯示時剝前綴，前綴改膠囊）
  const tasksOfRegion = (rn) => getTasks(data)
    .map((t) => parseRegionTask(t)).filter((p) => p.region === rn);
  // 物件橡皮擦：點/劃過筆畫＝整筆刪除（物件級，非像素擦）
  const eraseAt = (x, y) => {
    const th = 0.02; // 相對距離門檻
    const hit = strokes.findIndex((s) => s.some(([px, py]) => Math.hypot(px - x, py - y) < th));
    if (hit >= 0) { patchCur({ strokes: strokes.filter((_, i) => i !== hit) }); return; }
    // 形狀：點在範圍內（文字用鄰近）＝刪除該形狀（由上而下取最後畫的）
    for (let i = shapes.length - 1; i >= 0; i -= 1) {
      const s = shapes[i];
      const inside = s.type === "text" ? Math.hypot(s.x - x, s.y - y) < 0.05
        : (x >= s.x && x <= s.x + (s.w || 0) && y >= s.y && y <= s.y + (s.h || 0));
      if (inside) { patchCur({ shapes: shapes.filter((_, k) => k !== i) }); return; }
    }
  };
  // 文字形狀提交（Enter/失焦）：非空才建立，錨點＝點擊處
  const commitText = () => {
    const t = textDraft;
    if (t && t.value.trim()) patchCur({ shapes: [...shapes, { type: "text", x: t.x, y: t.y, text: t.value.trim(), color: shapeColor, size: 0.05 }] });
    setTextDraft(null);
  };
  const undoMark = () => { if (shapes.length) patchCur({ shapes: shapes.slice(0, -1) }); else if (strokes.length) patchCur({ strokes: strokes.slice(0, -1) }); };
  const clearMarks = () => patchCur({ strokes: [], shapes: [] });
  const st = S[data.status] || S.note;
  const c = colorOf(data, st);
  return (
    <div className={`card img-card st-${data.status || "note"} ${mode ? "img-editing" : ""}`} {...peek}
      style={{ ...cardStyle(data, c, st.c), width: Math.max(data.w || 360, toolsW) }}>
      {/* 等比縮放（單軸拖曳另一軸自動跟、上下限放到極寬）。
          keepAspectRatio＝邊線把手也連動另一軸；寬度真相＝data.w（高度隨圖比例）。
          下限＝工具列總寬（toolsW）：卡片不會窄到工具列被截斷。 */}
      <NodeResizer isVisible={selected} keepAspectRatio minWidth={Math.max(48, toolsW)} minHeight={32}
        maxWidth={4000} maxHeight={4000}
        lineClassName="img-rz-line" handleClassName="img-rz-handle"
        onResize={(_, p) => patch({ w: p.width })} />
      <H id={id} />
      <div className="card-top">
        <StatusMark st={st} />
        <span className="num" style={{ color: c, borderColor: c }}>{data.num}</span>
        <span className="title">{data.label}</span>
        <Lock id={id} locked={data.locked} />
      </div>
      <CardBadges id={id} data={data} />
      {/* 編輯模式掛 nodrag＋nopan：nodrag 擋節點拖曳；nopan 擋畫布平移——
          鎖定卡 draggable=false 時 React Flow 不會替節點掛 nopan，手勢會被 pan 搶走 */}
      <div ref={boxRef} className={`img-wrap ${mode ? `nodrag nopan img-mode-${mode}` : ""}`}
        onPointerDown={(e) => {
          if (!mode) return;
          e.stopPropagation();
          try { boxRef.current.setPointerCapture(e.pointerId); } catch { /* 舊瀏覽器 */ }
          const [x, y] = relPt(e);
          if (mode === "draw") { dragRef.current = { pts: [[x, y]] }; setCur([[x, y]]); }
          else if (mode === "erase") eraseAt(x, y);
          else if (mode === "text") { if (!textDraft) setTextDraft({ x, y, value: "" }); }
          else { dragRef.current = { x0: x, y0: y, x1: x, y1: y }; setCurBox({ x0: x, y0: y, x1: x, y1: y }); } // region/rect/ellipse
        }}
        onPointerMove={(e) => {
          if (mode === "draw" && dragRef.current) {
            e.stopPropagation();
            const p = relPt(e); dragRef.current.pts.push(p); setCur((s) => [...(s || []), p]);
          } else if (mode === "erase" && e.buttons) { e.stopPropagation(); const [x, y] = relPt(e); eraseAt(x, y); }
          else if ((mode === "region" || mode === "rect" || mode === "ellipse") && dragRef.current) {
            e.stopPropagation();
            const [x, y] = relPt(e);
            dragRef.current.x1 = x; dragRef.current.y1 = y;
            setCurBox({ ...dragRef.current });
          }
        }}
        onPointerUp={(e) => {
          const d = dragRef.current; // 讀 ref＝免批次競態（快速拖曳也不漏）
          dragRef.current = null;
          if (mode === "draw" && d) {
            e.stopPropagation();
            if (d.pts.length > 1) patchCur({ strokes: [...strokes, d.pts] });
            setCur(null);
          } else if (mode === "region" && d) {
            e.stopPropagation();
            const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
            const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
            if (w < 0.02 && h < 0.02) {
              // 視為點擊：點在既有框內＝刪除該框（編號不回收，順序不亂）
              const hit = [...regions].reverse().find((r) =>
                d.x0 >= r.x && d.x0 <= r.x + r.w && d.y0 >= r.y && d.y0 <= r.y + r.h);
              if (hit) patchCur({ regions: regions.filter((r) => r.id !== hit.id) });
            } else {
              // 編號跨全圖片清單連續：取所有圖的最大 n +1（範圍框標記全卡共同踵繼）
              const rn = allRegions.reduce((m, r) => Math.max(m, r.n || 0), 0) + 1;
              patchCur({ regions: [...regions, { id: `rg${Date.now().toString(36)}`, n: rn, x, y, w, h }] });
            }
            setCurBox(null);
          } else if ((mode === "rect" || mode === "ellipse") && d) {
            e.stopPropagation();
            const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
            const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
            if (w > 0.01 && h > 0.01) patchCur({ shapes: [...shapes, { type: mode, x, y, w, h, color: shapeColor }] });
            setCurBox(null);
          }
        }}>
        {data.src
          ? <img src={data.src} alt={data.label || T("n_imgAlt")} draggable={false} />
          : <div className="img-empty">{T("n_imgEmpty")}</div>}
        <svg className="img-marks" viewBox="0 0 100 100" preserveAspectRatio="none">
          {[...strokes, ...(cur && cur.length > 1 ? [cur] : [])].map((s, i) => (
            <polyline key={i} points={s.map(([x, y]) => `${x * 100},${y * 100}`).join(" ")} />
          ))}
        </svg>
        {/* 卡內就地形狀標註（方框/圓圈/文字）：覆蓋在顯示圖上、隨圖走（存 gallery item.shapes） */}
        {shapes.map((s, i) => (s.type === "text" ? (
          <span key={i} className="img-shape img-text"
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, color: s.color, fontSize: `${(s.size || 0.05) * 100}cqi` }}>{s.text}</span>
        ) : (
          <div key={i} className={`img-shape ${s.type === "ellipse" ? "img-ellipse" : "img-rect"}`}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%`, borderColor: s.color }} />
        )))}
        {textDraft && (
          <input className="img-textinput nodrag nopan" autoFocus value={textDraft.value}
            style={{ left: `${textDraft.x * 100}%`, top: `${textDraft.y * 100}%`, color: shapeColor }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTextDraft((t) => ({ ...t, value: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitText(); } if (e.key === "Escape") setTextDraft(null); }}
            onBlur={commitText} placeholder={T("n_imgTextPh")} />
        )}
        {/* 範圍標示框：點框＝選取該框（高亮＋✕ 可刪），同時把
            範圍截圖標籤掛到輸入列上方（不搶輸入焦點）；虛線框＋R 編號＋下方任務標籤 */}
        {regions.map((r) => (
          <div key={r.id}
            className={`img-region ${mode ? "img-region-pass" : "nodrag nopan"} ${selRegion === r.id ? "sel" : ""}`}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            title={mode === "region" ? T("n_regionDelHint") : T("n_regionSelHint", { n: r.n })}
            onClick={(e) => {
              if (mode) return;
              e.stopPropagation();
              setSelRegion(r.id);
              window.dispatchEvent(new CustomEvent("hare:region-task", { detail: { cardId: id, n: r.n } }));
            }}>
            <span className="img-region-n">R{r.n}</span>
            {selRegion === r.id && !mode && (
              <button className="img-region-x nodrag nopan" title={T("n_regionDelBtn")}
                onClick={(e) => {
                  e.stopPropagation();
                  patchCur({ regions: regions.filter((x) => x.id !== r.id) });
                  setSelRegion(null);
                }}>✕</button>
            )}
            {tasksOfRegion(r.n).length > 0 && (
              <ul className="img-region-tasks">
                {tasksOfRegion(r.n).map((p, i) => <li key={i}>{p.text}</li>)}
              </ul>
            )}
          </div>
        ))}
        {curBox && (() => {
          const style = {
            left: `${Math.min(curBox.x0, curBox.x1) * 100}%`, top: `${Math.min(curBox.y0, curBox.y1) * 100}%`,
            width: `${Math.abs(curBox.x1 - curBox.x0) * 100}%`, height: `${Math.abs(curBox.y1 - curBox.y0) * 100}%` };
          if (mode === "rect" || mode === "ellipse") {
            return <div className={`img-shape ${mode === "ellipse" ? "img-ellipse" : "img-rect"}`} style={{ ...style, borderColor: shapeColor }} />;
          }
          return <div className="img-region img-region-pass" style={style} />;
        })()}
      </div>
      {/* 工具列常駐顯示（不隨選取隱藏） */}
      <div ref={toolsRef} className="img-tools nodrag nopan">
        <button title={T("n_toolShotTitle")}
          onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("hare:img-shot", { detail: { cardId: id } })); }}>{T("n_toolShot")}</button>
        <button className={mode === "draw" ? "on" : ""} title={T("n_toolDrawTitle")}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "draw" ? null : "draw"); }}>{T("n_toolDraw")}</button>
        <button className={mode === "rect" ? "on" : ""} title={T("n_toolRectTitle")}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "rect" ? null : "rect"); }}>{T("n_toolRect")}</button>
        <button className={mode === "ellipse" ? "on" : ""} title={T("n_toolEllipseTitle")}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "ellipse" ? null : "ellipse"); }}>{T("n_toolEllipse")}</button>
        <button className={mode === "text" ? "on" : ""} title={T("n_toolTextTitle")}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "text" ? null : "text"); }}>{T("n_toolText")}</button>
        <button className={mode === "region" ? "on" : ""}
          title={T("n_toolRegionTitle")}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "region" ? null : "region"); }}>{T("n_toolRegion")}</button>
        <button className={mode === "erase" ? "on" : ""} title={T("n_toolEraseTitle")} disabled={!hasMarks}
          onClick={(e) => { e.stopPropagation(); setMode(mode === "erase" ? null : "erase"); }}>{T("n_toolErase")}</button>
        <button title={T("n_toolUndoTitle")} disabled={!hasMarks}
          onClick={(e) => { e.stopPropagation(); undoMark(); }}>↩</button>
        <button title={T("n_toolClearTitle")} disabled={!hasMarks}
          onClick={(e) => { e.stopPropagation(); clearMarks(); }}>✕</button>
      </div>
      {/* 形狀顏色列：在方框/圓圈/文字模式時出現，選色套用到接著畫的形狀 */}
      {(mode === "rect" || mode === "ellipse" || mode === "text") && (
        <div className="img-colors nodrag nopan">
          {SHAPE_COLORS.map((cc) => (
            <button key={cc} className={`img-sw ${cc === shapeColor ? "on" : ""}`} style={{ background: cc }}
              onClick={(e) => { e.stopPropagation(); setShapeColor(cc); }} title={cc} />
          ))}
        </div>
      )}
      {/* 任務（同標準卡片）：底部輸入列選卡輸入；點範圍框＝自動帶 R 編號前綴 */}
      <Tasks data={data} id={id} selected={selected} />
      {/* 圖片清單浮動框（選取時，掛卡片右側）：一卡多圖、點選切換、＋加入 */}
      {selected && (
        <div className="img-gallery nodrag nopan">
          <div className="ig-head">{T("n_galleryHead", { n: gallery.length })}</div>
          {gallery.map((g, i) => (
            <div key={i} className={`ig-row ${g.src === data.src ? "on" : ""}`}>
              <button className="ig-item" title={g.name || T("n_imgName", { n: i + 1 })}
                onClick={(e) => { e.stopPropagation(); if (g.src !== data.src) patch({ src: g.src }); }}>
                {i + 1}. {(g.name || T("n_imgName", { n: i + 1 })).slice(0, 18)}
              </button>
              <button className="ig-del nodrag nopan" title={T("n_galleryDel")}
                onClick={(e) => { e.stopPropagation(); removeImg(i); }}>−</button>
            </div>
          ))}
          <button className="ig-add"
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("hare:img-pick", { detail: { cardId: id } })); }}>
            {T("n_galleryAdd")}</button>
        </div>
      )}
    </div>
  );
}


const nodeTypes = { lane: memo(LaneNode),
  note: memo(NoteNode), pin: memo(PinNode), dep: memo(DepNode), res: memo(ResNode),
  img: memo(ImgNode) };
/* 自動長高的輸入框（隨文字段落調整高度） */
function AutoTextarea({ value, onChange, placeholder, className, ...rest }) {
  const ref = useRef(null);
  const resize = () => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(() => { resize(); }, [value]);
  return (
    <textarea ref={ref} className={className} value={value} placeholder={placeholder} rows={1}
      onChange={(e) => { onChange(e); resize(); }} {...rest} />
  );
}

/* 對齊/分佈小圖示（16px SVG，currentColor 隨按鈕文字色） */
function Ico({ k }) {
  const bar = (x1, y1, x2, y2) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />;
  const box = (x, y, w, h) => <rect x={x} y={y} width={w} height={h} rx="0.6" fill="currentColor" />;
  const wrap = (kids) => <svg width="17" height="17" viewBox="0 0 16 16">{kids}</svg>;
  switch (k) {
    case "left": return wrap(<>{bar(1.5, 1, 1.5, 15)}{box(3, 3.4, 9, 2.4)}{box(3, 9.4, 6, 2.4)}</>);
    case "right": return wrap(<>{bar(14.5, 1, 14.5, 15)}{box(4, 3.4, 9, 2.4)}{box(7, 9.4, 6, 2.4)}</>);
    case "hcenter": return wrap(<>{bar(8, 1, 8, 15)}{box(3.5, 3.4, 9, 2.4)}{box(5, 9.4, 6, 2.4)}</>);
    case "top": return wrap(<>{bar(1, 1.5, 15, 1.5)}{box(3.4, 3, 2.4, 9)}{box(9.4, 3, 2.4, 6)}</>);
    case "bottom": return wrap(<>{bar(1, 14.5, 15, 14.5)}{box(3.4, 4, 2.4, 9)}{box(9.4, 7, 2.4, 6)}</>);
    case "vcenter": return wrap(<>{bar(1, 8, 15, 8)}{box(3.4, 3.5, 2.4, 9)}{box(9.4, 5, 2.4, 6)}</>);
    case "disth": return wrap(<>{box(1.5, 3, 2.4, 10)}{box(6.8, 3, 2.4, 10)}{box(12.1, 3, 2.4, 10)}</>);
    case "distv": return wrap(<>{box(3, 1.5, 10, 2.4)}{box(3, 6.8, 10, 2.4)}{box(3, 12.1, 10, 2.4)}</>);
    default: return null;
  }
}

export { S, colorOf, bgOf, cardStyle, getTasks, doneTextOf, doneTimeOf,
  HandlesCtx, SingleSelCtx, PagesCtx, StyleCtx, nodeTypes, openArchive, AutoTextarea, Ico, Grips, setRefBase };
