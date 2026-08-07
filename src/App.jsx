import { memo, useCallback, useRef, useEffect, useReducer, useState, useMemo } from "react";
import { createPortal } from "react-dom"; // 右側 dock：既有面板內容原地 portal 進 dock，不搬 JSX
import {
  ReactFlow, ReactFlowProvider, Background, MiniMap, Panel,
  MarkerType, ConnectionMode, addEdge, reconnectEdge,
  useNodesState, useEdgesState, useReactFlow, useStore, ViewportPortal,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { solveOverlaps } from "../lib/collision.mjs"; // 前後端共用（add_card after 落點也用它讓位）
import { arrange, align, distribute } from "./arrange.mjs";
import { propagate, pruneConstraints } from "./constraints.mjs";
import { S, colorOf, getTasks, doneTextOf, doneTimeOf, HandlesCtx, SingleSelCtx, PagesCtx, StyleCtx, nodeTypes,
  AutoTextarea, Ico, setRefBase, imgGalleryOf } from "./nodes.jsx";
import { BUILTIN_STYLES, BUILTIN_IDS, validateCardStyle, isBuiltin, sanitizeCardStyles,
  STYLE_BASES, DENSITIES, SHAPES, HEADERS, SURFACES, BORDERS, SHADOWS } from "../lib/cardstyles.mjs"; // W1-3-8 卡片款式 registry
import { highlight } from "./codelight.mjs"; // N6 內建閱讀器：零依賴輕量語法上色
import { layoutLayered, layoutRadial, layoutAnchor, preserveLockedPositions } from "../lib/layout.mjs"; // 佈局鈕：分層（dagre）＋放射＋錨卡中心
import { edgeTypes, tierEdgeStyle } from "./edges.jsx";
import { insights, edgeSemantics, boardKindOf, impact } from "../lib/graph.mjs"; // B22 板面健康＋影響聚焦：純函式、前後端共用（同 tasks.mjs 慣例）
import { Md } from "./md.jsx";
import { captureDisplayFrame } from "./shot.jsx"; // 截圖：擷取視窗一幀（📷 截圖鈕）
import { ChatPanel, AgentSettingsPane, SecurityPane } from "./chat.jsx"; // 卡片對話面板＋Agent 設定頁＋安全性（見 chat.jsx 錨 c7a7face）
import { addTask, setTaskAt, taskTexts } from "../lib/tasks.mjs"; // B19 任務 dict 化（前後端共用）
import { acceptsOf, anchorKind } from "../lib/accepts.mjs"; // 驗收項（HARE 3ac5e77b accepts）
import { registerConfirm, confirmDialog, promptDialog } from "./confirm.mjs"; // 置中對話框（取代原生彈窗）
import { t as T, getLang, setLang, langs } from "./i18n.mjs";


/* 種子：HARE 白板以資料檔（roadmap-data.json / 伺服器）為真相來源，
   前端不再內建任何專案卡片；無資料時顯示空白板。
   （每專案可設定種子模板） */
const initialNodes = [];
const initialEdges = [];
const INIT_EDGE_IDS = initialEdges.map((e) => e.id); // 預設邊 id（供刪除墓碑判定）

// B6 多專案化·前端：目前專案代號取自 URL ?project=（省略／非法＝default）。
// 白名單與後端 store.mjs 的 PROJECT_RE 一致（英數起頭，後接英數/-/_）。
// 所有 /api/roadmap GET/PUT 與 SSE 都帶此參數；切換專案＝改 URL 重新載入該白板。
const PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const readProjectFromUrl = () => {
  try {
    const p = new URLSearchParams(window.location.search).get("project");
    return p && PROJECT_RE.test(p) ? p : "default";
  } catch { return "default"; }
};
const PROJECT = readProjectFromUrl();
// 帶專案參數的 API 路徑：default 不加參數（維持單專案時代的原始 URL，行為完全不變）。
const withProject = (path) =>
  (PROJECT === "default" ? path : `${path}?project=${encodeURIComponent(PROJECT)}`);

// 每專案獨立的本地快取鍵（避免切換專案時 A 板快取污染 B 板；default 沿用舊鍵保留相容）。
const LS = PROJECT === "default" ? "hare-roadmap-v1" : `hare-roadmap-v1:${PROJECT}`;
const UI_LS = "hare-roadmap-ui-v1"; // 浮動面板位置等 UI 狀態（專案無關，全域共用）
// 改名遷移（BanLu→HARE）：新鍵不存在就搬舊鍵內容——板快取與
// 面板佈局不因改名歸零；舊鍵留著不刪（回滾安全）。
try {
  for (const [nk, ok] of [[LS, LS.replace("hare-", "banlu-")], [UI_LS, "banlu-roadmap-ui-v1"]]) {
    if (!localStorage.getItem(nk) && localStorage.getItem(ok)) localStorage.setItem(nk, localStorage.getItem(ok));
  }
} catch { /* localStorage 不可用＝略過 */ }

// B6：切換專案＝改 URL ?project= 後整頁重載——最乾淨地「重抓資料、重置 REV/指紋、重訂 SSE」。
const switchProject = (id) => {
  if (!id || id === PROJECT) return;
  const u = new URL(window.location.href);
  if (id === "default") u.searchParams.delete("project");
  else u.searchParams.set("project", id);
  u.searchParams.delete("page"); // 換專案＝回到該專案記憶的分頁（見 INIT_PAGE）
  window.location.assign(u.toString());
};

// 專案分頁（v2）：分頁在專案檔內（伺服器回 pages 陣列），切分頁純記憶體。
// 初始作用頁：URL ?page= 優先，其次本專案上次開啟的分頁（localStorage），最後第一頁。
const INIT_PAGE = (() => {
  try {
    const u = new URL(window.location.href).searchParams.get("page");
    if (u) return u;
    return localStorage.getItem(`hare-page:${PROJECT}`) || null;
  } catch { return null; }
})();

// B6：呼叫 MCP 工具（POST /mcp，JSON-RPC）。專案清單／建立目前只由 MCP 工具暴露
// （lib/tools.mjs 的 list_projects／create_project），/mcp 由 server.mjs 提供；
// vite dev 未接 /mcp，故開發模式下會失敗→前端自動降級（見 fetchProjectList）。
async function mcpToolCall(name, args) {
  const r = await fetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call",
      params: { name, arguments: args || {} } }),
  });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) { const e = new Error(`mcp 不可用（${r.status}）`); e.status = r.status; throw e; }
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message || "mcp error"); e.status = j.error.code === -32001 ? 401 : 0; throw e; }
  const text = j.result?.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : j.result;
  if (parsed && parsed.isError) throw new Error(parsed.text || T("a_errTool"));
  return parsed;
}

// B6：讀取專案清單。優先 REST（若後端日後補上 GET /api/projects），退回 MCP list_projects。
// 兩者皆不可用（dev 無 /mcp）→ 丟錯，呼叫端保留「僅目前專案」的降級清單。
async function fetchProjectList() {
  try {
    const r = await fetch("/api/projects", { headers: { Accept: "application/json" } });
    const ct = r.headers.get("content-type") || "";
    if (r.ok && ct.includes("application/json")) {
      const j = await r.json();
      if (Array.isArray(j?.projects)) return j.projects;
    }
  } catch { /* REST 未提供→改走 MCP */ }
  const j = await mcpToolCall("list_projects", {});
  if (Array.isArray(j?.projects)) return j.projects;
  throw new Error("無專案清單來源");
}

// B6：建立新專案。優先 REST（POST /api/projects），退回 MCP create_project。回傳專案摘要。
// extra：{ group, page }＝分頁歸屬（專案分頁）；{ template }＝種子模板。
async function createProjectRemote(id, title, extra = {}) {
  const payload = { id, title: title || undefined,
    ...(extra.group ? { group: extra.group } : {}), ...(extra.page ? { page: extra.page } : {}),
    ...(extra.template && extra.template !== "blank" ? { template: extra.template } : {}) };
  try {
    const r = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await r.json();
      if (r.ok && j && !j.error) return j.project || j;
      if (j?.error) throw new Error(typeof j.error === "string" ? j.error : (j.error.message || T("a_errCreateFail")));
    }
  } catch (e) {
    if (e && e.message && !/mcp|不可用|Unexpected|JSON/.test(e.message)) throw e; // 真實後端錯誤才中止
  }
  const j = await mcpToolCall("create_project", payload);
  if (j && j.ok === false) throw new Error(T("a_errCreateFail"));
  return j?.project || j;
}
// 封存專案（專案管理頁 − 鈕）：優先 REST（POST /api/projects/archive），退回 MCP。
// 非破壞——資料搬 data/archive/，可用 unarchive_project 還原。
async function archiveProjectRemote(id) {
  try {
    const r = await fetch("/api/projects/archive", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id }),
    });
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await r.json();
      if (r.ok && j && !j.error) return j;
      if (j?.error) throw new Error(typeof j.error === "string" ? j.error : T("a_errArchiveFail"));
    }
  } catch (e) {
    if (e && e.message && !/mcp|不可用|Unexpected|JSON|fetch/i.test(e.message)) throw e; // 真實後端錯誤才中止
  }
  return mcpToolCall("archive_project", { id });
}

/* 膠囊寬度量化（最少 4 字寬，被撐開時取 4 的倍數，對齊才漂亮）。
   純 CSS 做不到——`round()` 拿不到「內容的固有寬度」。改用固定 4 字寬的欄格線
   （.tl-tabs 是 grid），每顆膠囊跨 N 欄，N 由標籤字數算出來。
   字數權重：全形（CJK／全形標點）＝1，其餘（拉丁、數字、空白）＝0.5——這是等寬字型
   下的實際 advance 比例。算完無條件進位到 4 的倍數再除以 4，即為跨欄數。 */
// HARE 8d2f5b71 chipSpan
const chipUnits = (s) => [...String(s || "")].reduce(
  (n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 1 : 0.5), 0);
const chipSpan = (s) => Math.max(1, Math.ceil(chipUnits(s) / 4));

const loadUi = () => { try { return JSON.parse(localStorage.getItem(UI_LS) || "{}"); } catch { return {}; } };
const saveUi = (patch) => localStorage.setItem(UI_LS, JSON.stringify({ ...loadUi(), ...patch }));
// 預設版面 v2：計算移至 App 掛載後（BAR／圖例／排列框
// 高度——估值曾造成上下邊距不一致），見 applyDefaultLayoutV2 effect。

// 熱鍵表（設定框可改綁）：combo＝{ctrl,alt,shift,code,key}——比對用 code（實體鍵位），
// del 交給 React Flow deleteKeyCode 用 key。改綁存 UI_LS.hotkeys（逐鍵覆蓋預設）。
// HARE 7c3e9b12 hotkeyDefaults
const HOTKEY_DEFAULT = {
  selMode: { code: "Space", key: " " },
  undo: { ctrl: true, code: "KeyZ", key: "z" },
  redo: { ctrl: true, code: "KeyY", key: "y" },
  focusTask: { code: "Enter", key: "Enter" },
  ortho: { code: "F3", key: "F3" },
  lock: { code: "KeyL", key: "l" },
  del: { code: "Delete", key: "Delete" },
};
const HOTKEY_META = {
  selMode: { label: T("a_hkSelMode") },
  undo: { label: T("a_hkUndo") },
  redo: { label: T("a_hkRedo") },
  focusTask: { label: T("a_hkFocusTask") },
  ortho: { label: T("a_hkOrtho") },
  lock: { label: T("a_hkLock") },
  del: { label: T("a_hkDel") },
};
const comboMatch = (e, c) => !!c && e.code === c.code &&
  (e.ctrlKey || e.metaKey) === !!c.ctrl && e.shiftKey === !!c.shift && e.altKey === !!c.alt;
const comboLabel = (c) => {
  if (!c) return "—";
  const k = c.code === "Space" ? "Space"
    : c.code.startsWith("Key") ? c.code.slice(3)
    : c.code.startsWith("Digit") ? c.code.slice(5)
    : (c.key && c.key.length === 1 ? c.key.toUpperCase() : c.key || c.code);
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", k].filter(Boolean).join("+");
};
// B15 討論串時戳格式（短：月/日 時:分）；不可解析→原字串
const fmtCmtTime = (t) => {
  const d = new Date(t || "");
  return Number.isNaN(d.getTime()) ? (t || "")
    : d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
// HARE 6b9d5dc5 legend
// 標題卡（標題框）未設 meta.title 時的預設標題——專案切換選單同步用它，讓「選單專案名」
// 與「標題卡標題」一致（MENU 專案名以標題卡的標題為準）。
const BOARD_TITLE = T("a_boardTitle");
// 標題框預設專案說明（meta.body 未設定時顯示；點擊可現地編輯，W1-2-1）
const DEFAULT_BODY = T("a_defaultBody");
// W2-16 統一：狀態標籤單一來源＝nodes.jsx S 表（n_st* 鍵）——圖例與卡面
// 膠囊永遠同字，不再維護 a_lg* 第二套（雙來源曾造成「實跑驗證」vs「程式完成・待真資料」不一致）
const legend = ["real", "wait", "draft", "block", "plan", "note"].map((k) => [k, S[k].label]);
// 狀態篩選可 dim 的卡片型別（容器與終點物件不 dim）
const DIMMABLE = new Set(["note", "dep", "res"]);
const loadPersisted = () => { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch { return null; } };
// 路徑縮短顯示（專案管理頁「對應資料夾」欄；完整路徑放 title）
const shortDir = (p) => {
  if (!p) return "—";
  const seg = String(p).split("/").filter(Boolean);
  return seg.length > 2 ? `…/${seg.slice(-2).join("/")}` : p;
};

// 新線段內建預設樣式（設定框「重置」還原用）
//預設曲線（default bezier）；折線（smoothstep＝PolyEdge，
// 含折點擎點）仍可在線段屬性框選用。後續再加「自動排列修正」鈕處理卡壓線。
// 卡片型別顯示名（卡片屬性框標題用：屬性（一般/節點/圖片…））
const NODE_TYPE_LABEL = { note: T("a_ntNote"), pin: T("a_ntPin"), img: T("a_ntImg"),
  dep: T("a_ntDep"), res: T("a_ntRes") };
const EDGE_DEFAULT = {
  type: "default", animated: false, style: { stroke: "#c47d0a", strokeWidth: 1.8 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "#c47d0a" },
};

// 浮動框拖曳＋位置持久化（每個框各自的 UI_LS 鍵，互相獨立）
/* dock 內容槽：把既有面板的內容原地送進右側 dock 的內容區。
   刻意用 portal 而不是把 JSX 大搬家——各面板的 state、handler、閉包全部原封不動，
   只換外殼。這讓「12 個浮動框整合成一個 dock」變成每個面板改一兩行的機械工，
   而不是一次重寫 1500 行的高風險手術。
   tab 不是當前頁、或 host 還沒掛上＝不渲染（面板自身的顯示條件仍由呼叫端把關）。 */
/* 右側 dock 的頁籤定義：預設順序＝這個陣列的順序；可在
   設定▸功能視窗調整順序與顯示（存 UI_LS dockOrder／dockHidden）。
   k＝頁鍵（同 DockSlot 的 tab）、ico＝軌上圖示、lb＝i18n 標籤鍵、
   hint＝該頁沒有內容可顯示時的說明（頁籤一律可點——不可點的頁籤等於沒解釋的死路）。 */
const DOCK_DEFS = [
  { k: "read", ico: "≡", lb: "dock_read", hint: "dock_hintRead" },
  { k: "props", ico: "⚙", lb: "dock_props", hint: "dock_hintProps" },
  { k: "cards", ico: "▭", lb: "dock_cards", hint: "dock_hintCards" },
  { k: "tasks", ico: "☑", lb: "dock_tasks", hint: "dock_hintTasks" },
  { k: "archive", ico: "🗄", lb: "dock_archive", hint: "dock_hintArchive" },
  { k: "arrange", ico: "⊞", lb: "dock_arrange", hint: "dock_hintArrange" },
  { k: "health", ico: "♥", lb: "dock_health", hint: "dock_hintHealth" },
];
const DOCK_KEYS = DOCK_DEFS.map((d) => d.k);
// 排序＋新增頁籤的合流：存檔裡沒有的鍵（版本更新後新增的頁）自動補到尾端
const dockOrderOf = (saved) => {
  const kept = (Array.isArray(saved) ? saved : []).filter((k) => DOCK_KEYS.includes(k));
  return [...kept, ...DOCK_KEYS.filter((k) => !kept.includes(k))];
};

// HARE 1c6b0f7e DockSlot
function DockSlot({ tab, active, host, cls = "", children }) {
  if (tab !== active || !host) return null;
  // 保留面板原本的 class：index.css 有大量後代樣式掛在上面（.tl-panel .tl-body、
  // .health-panel .hp-body、.props-box .ep-body…），拿掉 wrapper class 內容會散掉。
  // 浮動時代的固定尺寸另由 .dock-pane.<cls> 中和（見 index.css）。
  return createPortal(<div className={`dock-pane ${cls}`}>{children}</div>, host);
}

/* 版面列插槽：畫面直向順序＝功能列／分頁列／畫布＋DOCK／圖例列。
   功能列與圖例列本來是 React Flow 的 Panel，浮在畫布上；畫布被 dock 擠窄後它們就跟著被切短。
   改成 portal 進畫布上下的真版面列——內容與其 state/handler 原封不動，只換落點。 */
function BarSlot({ host, cls, children }) {
  if (!host) return null;
  // cls 必須帶上原本 Panel 的 class：.tools/.tools-bar/.legend-bar 決定了這兩條 bar 的
  // 橫向排列與間距。少了它，內容會落進無樣式的 div，繼承不到任何 flex 設定。
  return createPortal(<div className={cls}>{children}</div>, host);
}

// HARE cab9d83b usePanelPos
function usePanelPos(key, def) {
  const [pos, setPos] = useState(() => loadUi()[key] || def);
  const ref = useRef(pos); ref.current = pos;
  const startDrag = useCallback((e) => {
    // .nodrag＝內容互動區（chat 訊息/權限列等）：不啟動面板拖曳、保留文字選取複製
    if (e.target.closest("input, textarea, button, .sw, .tk-item, .nodrag")) return;
    // 讓位給 CSS resize 拉把（右下角）：可調大小的框，角落 mousedown 交給瀏覽器 resize，不啟動移動
    const el = e.currentTarget, r = el.getBoundingClientRect();
    if (getComputedStyle(el).resize !== "none" && e.clientX > r.right - 18 && e.clientY > r.bottom - 18) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, orig = ref.current;
    const move = (ev) => setPos({ x: orig.x + ev.clientX - sx, y: orig.y + ev.clientY - sy });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveUi({ [key]: ref.current });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [key]);
  return [pos, startDrag, setPos];
}

// 標題列點擊折疊（折疊鈕全移除、點標題切換）：
// mousedown 記座標，click 位移 >3px＝拖曳不觸發；點到按鈕/輸入元件也不觸發。
// HARE f01dhead useFoldHead
function useFoldHead(onDown, toggle) {
  const at = useRef(null);
  return {
    onMouseDown: (e) => { at.current = { x: e.clientX, y: e.clientY }; if (onDown) onDown(e); },
    onClick: (e) => {
      if (e.target.closest("button, input, select, textarea")) return;
      const d = at.current;
      if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) return;
      toggle();
    },
  };
}

// 浮動框邊緣調整大小（同卡片 NodeResizer 的邊緣把手，八向）：
// dir 為 t/b/l/r/tl/tr/bl/br；拖右/下緣只改尺寸，拖左/上緣同步移動框位（視覺上對邊固定）。
// key＝尺寸持久化欄位（UI_LS）；posKey/pos/setPos＝框位（usePanelPos 同款）一併持久化。
// HARE 3f8e2c1d useEdgeResize
function useEdgeResize(key, def, posKey, pos, setPos) {
  const [size, setSize] = useState(() => loadUi()[key] || def);
  const sRef = useRef(size); sRef.current = size;
  const pRef = useRef(pos); pRef.current = pos;
  const start = useCallback((e, dir) => {
    e.preventDefault(); e.stopPropagation(); // 不讓面板的移動拖曳（onHeadDown）接手
    const sx = e.clientX, sy = e.clientY, s0 = sRef.current, p0 = pRef.current;
    const move = (ev) => {
      let w = s0.w, h = s0.h;
      if (dir.includes("r")) w = s0.w + ev.clientX - sx;
      if (dir.includes("l")) w = s0.w - (ev.clientX - sx);
      if (dir.includes("b")) h = s0.h + ev.clientY - sy;
      if (dir.includes("t")) h = s0.h - (ev.clientY - sy);
      w = Math.max(300, w); h = Math.max(220, h);
      setSize({ w, h });
      if (dir.includes("l") || dir.includes("t")) setPos({
        x: dir.includes("l") ? p0.x + (s0.w - w) : p0.x,
        y: dir.includes("t") ? p0.y + (s0.h - h) : p0.y,
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveUi({ [key]: sRef.current, [posKey]: pRef.current });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [key, posKey, setPos]);
  return [size, start, setSize];
}

// 任務列表框拆成 memo 元件（效能）：自訂比較只看「卡片 data/type
// 物件身分」與分類/位置——拖曳卡片只改 position（data 物件不換），常駐的大清單完全
// 跳過重繪；改任務/編號時 data 物件必然更換，清單照常更新。回呼 props 刻意不比較
// （皆為穩定閉包：focusNode useCallback、setState 系）。
// 結構化匯出（下載的 JSON 要可讀可還原，不是機器狀態傾倒）：
// ① 帶 format/version/project/exportedAt 標頭 ② 去渲染瞬態（measured/selected/
//    className/derived 旗標、data.childTop 量測值），座標取整
// ③ 排序：泳道 → 頂層卡依編號自然序 → 子卡緊隨父卡（符合 React Flow 父先於子規則）
// ④ 每張卡欄位固定順序（id/type/parentId/position/…/data）。
// 形狀仍與資料檔相容（nodes/edges/viewport/constraints/meta/rev）——
// 放回 data/<專案>.json 或 roadmap-data.json 即可整板還原。
// HARE e4b04a7d exportBoard
function exportBoard(nodes, edges, vp, constraints, meta, rev) {
  const numCmp = (a, b) => String(a.data?.num || "").localeCompare(String(b.data?.num || ""), undefined, { numeric: true });
  const cleanNode = (n) => {
    const { childTop, ...data } = n.data || {};
    return {
      id: n.id, type: n.type,
      ...(n.parentId ? { parentId: n.parentId, ...(n.extent ? { extent: n.extent } : {}) } : {}),
      position: { x: Math.round(n.position?.x || 0), y: Math.round(n.position?.y || 0) },
      ...(n.width != null ? { width: n.width } : {}),
      ...(n.height != null ? { height: n.height } : {}),
      ...(n.zIndex != null ? { zIndex: n.zIndex } : {}),
      ...(n.dragHandle && n.type !== "lane" ? { dragHandle: n.dragHandle } : {}), // 泳道整片可拖，不再存標題限定 handle
      data,
    };
  };
  // 泳道 → 頂層卡（編號序）→ 各自子卡遞迴緊隨（父先於子）
  const kids = new Map();
  nodes.forEach((n) => {
    if (!n.parentId) return;
    if (!kids.has(n.parentId)) kids.set(n.parentId, []);
    kids.get(n.parentId).push(n);
  });
  const ordered = [];
  const walk = (n) => { ordered.push(n); (kids.get(n.id) || []).sort(numCmp).forEach(walk); };
  nodes.filter((n) => n.type === "lane").sort(numCmp).forEach((n) => ordered.push(n));
  nodes.filter((n) => !n.parentId && n.type !== "lane").sort(numCmp).forEach(walk);
  const cleanEdge = (e) => {
    const { selected, reconnectable, id, source, sourceHandle, target, targetHandle, type, ...rest } = e;
    return { id, source, ...(sourceHandle ? { sourceHandle } : {}), target,
      ...(targetHandle ? { targetHandle } : {}), ...(type ? { type } : {}), ...rest };
  };
  return {
    format: "hare-board", version: 1, project: PROJECT,
    exportedAt: new Date().toISOString(), rev,
    meta: meta ?? null, viewport: vp || null, constraints: constraints || [],
    nodes: ordered.map(cleanNode),
    edges: [...edges].sort((a, b) => `${a.source}|${a.target}|${a.id}`.localeCompare(`${b.source}|${b.target}|${b.id}`)).map(cleanEdge),
  };
}

// mode："tasks"＝任務列表（原行為）；"cards"＝卡片列表——
// 只列全部卡片的編號＋標題（不含任務），點擊列即跳至該卡；標題左側 ⇄ 鈕切換。
// HARE 7c2f19aa TaskListPanel
// 分頁資料共通：任務/卡片列表彙整「同專案全部分頁」——本分頁在前，
// 其他分頁依序列出（標分頁名），點其他分頁的卡＝切板＋focus 選卡（onFocusRemote）。
const tlBuildGroups = (entries, mode) => {
  // entries：[{ n: 節點, p: 所屬分頁（{id,name,current}） }]——「全部」模式跨頁彙整時
  // 每筆保留分頁歸屬，點擊才能路由到對的分頁。
  // mode："tasks"＝待辦任務；"cards"＝全部卡片；"archive"＝封存紀錄（doneTasks， 併入）
  const groups = new Map();
  (entries || []).forEach(({ n, p }) => {
    if (n.type === "lane" || n.type === "pin") return;
    // 任務模式：只列帶任務的卡；已封存（doneTasks）與【已做】標記的任務不列入
    const tasks = mode === "tasks" ? getTasks(n.data).filter((t) => !String(t).startsWith("【已做")) : [];
    const done = mode === "archive" ? (n.data?.doneTasks || []) : [];
    if (mode === "tasks" && !tasks.length) return;
    if (mode === "archive" && !done.length) return;
    const c = (/^([A-Za-z]+)/.exec(n.data?.num || "")?.[1] || T("a_uncategorized")).toUpperCase();
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push({ id: n.id, num: n.data?.num || "", label: n.data?.label || n.data?.title || "", tasks, done, p });
  });
  const cats = [...groups.keys()].sort();
  cats.forEach((c) => groups.get(c).sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true })));
  return { groups, cats };
};
// 封存時間格式（原封存頁）：YYYY-MM-DD HH:mm
const tlFmtT = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const TaskListPanel = memo(function TaskListPanel({ nodes, cat, setCat, dockTab, dockHost, onClose, onFocus,
  mode, pages, curPageName, onFocusRemote, arCard, setArCard, onRestore }) {
  const cardsMode = mode === "cards", archMode = mode === "archive";
  // 折疊剩標題已退場：那是浮動框的概念。進 dock 後「收起來」＝切別的頁籤
  // 或收軌；留著只會讓人誤點標題把內容藏掉（症狀＝卡片/任務/倉庫三頁一片空白）。
  // 尺寸改 CHAT 同款八向邊緣把手：size/onResizeStart 由
  // App useEdgeResize 供給（UI_LS tlSize 持久化沿用），原生 resize 拉把與 ResizeObserver 退場
  // 分頁列：列表最上方先選分頁（預設本分頁），
  // 切分頁鈕＝換顯示內容，分類籤跟著重建。__cur＝作用中分頁；__all＝全部分頁彙整。
  const [viewPage, setViewPage] = useState("__cur");
  const pageList = [{ id: "__cur", name: curPageName || T("a_thisPage"), nodes, current: true },
    ...(pages || []).map((pb) => ({ id: pb.id, name: pb.page, nodes: pb.nodes, current: false }))];
  const allMode = viewPage === "__all";
  const srcPages = allMode ? pageList : [pageList.find((p) => p.id === viewPage) || pageList[0]];
  const entries0 = srcPages.flatMap((p) => (p.nodes || []).map((n) => ({ n, p })));
  // 倉庫模式單卡視圖（卡片 🗄 徽章進入）：只列該卡；「全部」鈕清除過濾
  const entries = archMode && arCard ? entries0.filter(({ n }) => n.id === arCard) : entries0;
  const { groups, cats } = tlBuildGroups(entries, mode);
  const singleAr = archMode && !!arCard;
  const focusFn = (g) => (g.p.current ? onFocus(g.id) : onFocusRemote(g.p.id, g.id));
  // 拖曳移動只掛標題列：掛整個框會跟右下角 resize 拉把打架
  return (
    <DockSlot tab={mode} cls="tl-panel" active={dockTab} host={dockHost}>
      <div className="fb-head">
        {/* 三模式分段鈕移除：卡片／任務／倉庫已拆成 dock 的三個
            獨立頁籤，mode 由頁籤決定（見 App 的 dockTab effect），這裡不再重複一套切換。 */}
        {/* 標題改帶頁名：原本靠三個分段籤的高亮辨識現在是哪一模式，籤移到
            dock 軌上之後標題就空了——補回頁名，單卡視圖仍以「單卡」字樣標示 */}
        <span className="fb-title">{singleAr ? T("a_singleCard") : T(`dock_${mode}`)}</span>
        {singleAr && (
          <button className="fb-round nodrag" title={T("a_showAllArchive")}
            onClick={(e) => { e.stopPropagation(); setArCard(null); }}>{T("a_allShort")}</button>
        )}
        {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
      </div>
      <div className="ep-body tl-body">
        {/* 分頁列：多分頁才顯示（單頁專案維持舊觀感）；全部＝跨頁彙整（卡片附分頁籤） */}
        {/* 膠囊 GRID 化：3 欄整齊對齊、過長標籤獨占整列 */}
        {pageList.length > 1 && (
          <div className="tl-tabs tl-pages nodrag">
            <button className={allMode ? "on" : ""} title={T("a_allPagesTitle")}
              style={{ "--span": chipSpan(T("all")) }}
              onClick={() => { setViewPage("__all"); setCat(null); }}>{T("all")}</button>
            {pageList.map((p) => (
              <button key={p.id}
                className={!allMode && srcPages[0]?.id === p.id ? "on" : ""}
                style={{ "--span": chipSpan(p.name) }}
                title={p.current ? T("a_thisPage") : T("a_pageName", { name: p.name })}
                onClick={() => { setViewPage(p.id); setCat(null); }}>{p.name}</button>
            ))}
          </div>
        )}
        {cats.length === 0 &&
          <div className="tl-empty">
            {archMode ? T("a_noArchive") : cardsMode ? T("a_noCardsInPage") : T("a_noTaskCardsInPage")}</div>}
        {/* 分類頁籤恆顯示（有任務即在），不因分類數變化消失；作用於所選分頁；
            倉庫單卡視圖不需要（原封存頁行為） */}
        {cats.length > 0 && !singleAr && (
          <div className="tl-tabs nodrag">
            <button style={{ "--span": chipSpan(T("all")) }}
              className={cat == null || !cats.includes(cat) ? "on" : ""} onClick={() => setCat(null)}>{T("all")}</button>
            {cats.map((c) => (
              <button key={c} style={{ "--span": chipSpan(c) }} className={cat === c ? "on" : ""}
                onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
        )}
        {(cat != null && cats.includes(cat) ? [cat] : cats).map((c) => (
          <div key={c} className="tl-group">
            {/* 已切到單一分類時頁籤即標明類別，列表內不重複顯示分組標題 */}
            {!(cat != null && cats.includes(cat)) && <div className="tl-cat">{c}</div>}
            {groups.get(c).map((g) => (
              <div key={g.id} className={`tl-item ${cardsMode ? "tl-card-row" : ""}`}>
                <button className="tl-focus nodrag" onClick={() => focusFn(g)}
                  title={g.p.current ? T("a_jumpToCard") : T("a_jumpToCardOnPage", { name: g.p.name })}>
                  <span className="tl-num">{g.num || "—"}</span>{g.label}
                  {allMode && <span className="tl-pg">{g.p.name}</span>}
                </button>
                {mode === "tasks" && (
                  <ul className="tl-tasks">
                    {g.tasks.map((t, i) => (
                      <li key={i}><button className="tl-task nodrag" onClick={() => focusFn(g)}>{t}</button></li>
                    ))}
                  </ul>
                )}
                {archMode && (
                  /* 封存紀錄表（原封存頁）：日期時間＋任務內容＋還原。
                     還原走本頁 setNodes——其他分頁的卡不出 ↩ 鈕（跳過去再還原） */
                  /* HARE cabd5adb ar-table */
                  <table className="ar-table">
                    <thead><tr><th>{T("a_thDatetime")}</th><th>{T("a_thTaskContent")}</th><th /></tr></thead>
                    <tbody>
                      {g.done.map((d, i) => (
                        <tr key={i}>
                          {/* 日期時間兩行：年月日／時:分 */}
                          <td className="ar-time">
                            <span className="ar-date">{tlFmtT(doneTimeOf(d)).split(" ")[0]}</span>
                            <span className="ar-clock">{tlFmtT(doneTimeOf(d)).split(" ")[1] || ""}</span>
                          </td>
                          {/* 任務封存＝任務紀錄：commit 標記移到內容上方（同指示） */}
                          <td className="ar-text">
                            {d && typeof d === "object" && d.commit && (
                              <code className="ar-commit" title={`git commit ${d.commit}`}>
                                COMMIT {String(d.commit).slice(0, 10)}</code>
                            )}
                            <span className="ar-body">{doneTextOf(d)}</span>
                          </td>
                          <td>{g.p.current && <button className="tk-restore nodrag" title={T("a_restoreTask")}
                            onClick={() => onRestore(g.id, i)}>↩</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </DockSlot>
  );
  /* dockTab／dockHost 必須進比較器（修）：漏比＝切走頁籤時本元件不重繪，
     它的 DockSlot portal 就不會卸載，殘留面板會一直掛在 dock 內容區裡（症狀＝dock 上方
     一大段帶 ✕ 的空白）。pos/size 隨浮動框退場，已不是 props。 */
}, (a, b) => a.cat === b.cat && a.dockTab === b.dockTab && a.dockHost === b.dockHost
  && a.mode === b.mode && a.arCard === b.arCard && a.pages === b.pages
  && a.curPageName === b.curPageName && a.nodes.length === b.nodes.length
  && a.nodes.every((n, i) => n === b.nodes[i]
    || (n.id === b.nodes[i].id && n.data === b.nodes[i].data && n.type === b.nodes[i].type)));

// 指定目標選卡框（點 ⌖ 後可從卡片列表選目標）：assignMode
// 進行中顯示，列本頁內容卡（不含泳道/節點卡/自己——顯示端 PinNode 只解析本頁節點，
// 跨頁引用另屬 N11 樹狀圖議題），可搜編號/名稱；點列＝直接綁定（列表點選已是明確
// 意圖，不再 confirm；畫布點卡的 confirm 流程照舊並行，Esc 取消同樣有效）。
// HARE a551c9p1 AssignPickPanel
const AssignPickPanel = memo(function AssignPickPanel({ nodes, pages, selfId, pos, onHeadDown, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(null);    // 分類籤（同任務卡）
  const [openRes, setOpenRes] = useState(null); // 展開中的資源卡（子選單：卡片本身＋檔案）
  const ql = q.trim().toLowerCase();
  // 本頁在前、其他分頁附分頁籤（節點卡跨頁引用，N11 ③）
  const all = [
    ...(nodes || []).map((n) => ({ n, pg: null })),
    ...(pages || []).flatMap((pb) => (pb.nodes || []).map((n) => ({ n, pg: pb.page }))),
  ]
    .filter(({ n }) => n.type !== "lane" && n.type !== "pin" && n.id !== selfId)
    .map(({ n, pg }) => ({ id: n.id, num: n.data?.num || "", label: n.data?.label || n.data?.title || "",
      pg, isRes: n.type === "res",
      files: n.type === "res"
        ? (Array.isArray(n.data?.listing) ? n.data.listing : [])
          .map((x) => (typeof x === "string" ? x : x?.kind === "file" ? x.name : null))
          .filter((x) => x && !String(x).startsWith("…") && !String(x).endsWith("/"))
        : null }));
  const cats = [...new Set(all.map((r) => /^([A-Za-z]+)/.exec(r.num)?.[1]?.toUpperCase()).filter(Boolean))].sort();
  const rows = all
    .filter((r) => !cat || (/^([A-Za-z]+)/.exec(r.num)?.[1]?.toUpperCase() === cat))
    .filter((r) => !ql || r.num.toLowerCase().includes(ql) || r.label.toLowerCase().includes(ql))
    .sort((a, b) => (a.pg === b.pg ? 0 : a.pg === null ? -1 : b.pg === null ? 1 : a.pg.localeCompare(b.pg))
      || a.num.localeCompare(b.num, undefined, { numeric: true }));
  return (
    <Panel position="top-left" className="float-box edge-panel pick-panel"
      style={{ left: pos.x, top: pos.y, right: "auto", transform: "none", margin: 0 }}>
      <div className="fb-head" style={{ cursor: "move" }} onMouseDown={onHeadDown}>
        <span className="fb-title">{T("a_assignPickTitle")}</span>
        <button className="fb-toggle" title={T("a_close")} onClick={onClose}>✕</button>
      </div>
      <div className="ep-body tl-body">
        <input className="ap-search nodrag" value={q} placeholder={T("a_assignSearchPh")}
          autoFocus onChange={(e) => setQ(e.target.value)} />
        {/* 分類籤（同任務卡膠囊；.tl-body .tl-tabs 既有 GRID 三欄規則直接吃到） */}
        {cats.length > 0 && (
          <div className="tl-tabs nodrag">
            <button style={{ "--span": chipSpan(T("all")) }}
              className={cat == null ? "on" : ""} onClick={() => setCat(null)}>{T("all")}</button>
            {cats.map((c) => (
              <button key={c} style={{ "--span": chipSpan(c) }} className={cat === c ? "on" : ""}
                onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
        )}
        {rows.length === 0 && <div className="tl-empty">{T("a_noCardsInPage")}</div>}
        {rows.map((r) => (
          <div key={r.id} className="tl-item tl-card-row">
            {/* 資源卡：標籤換色；點擊展開子選單＝卡片本身＋卡內檔案 */}
            <button className="tl-focus nodrag"
              onClick={() => (r.isRes
                ? setOpenRes((v) => (v === r.id ? null : r.id))
                : onPick(r.id, `${r.num} ${r.label}`.trim()))}>
              <span className={`tl-num${r.isRes ? " ap-res-num" : ""}`}>{r.num || "—"}</span>{r.label}
              {r.pg && <span className="tl-pg">{r.pg}</span>}
            </button>
            {r.isRes && openRes === r.id && (
              <div className="ap-sub nodrag">
                <button className="ap-sub-item ap-sub-self"
                  onClick={() => onPick(r.id, `${r.num} ${r.label}`.trim())}>{T("a_apResSelf")}</button>
                {(r.files || []).map((f) => (
                  <button key={f} className="ap-sub-item"
                    onClick={() => onPick(r.id, `${r.num} ${r.label}／${f}`, f)}>{f}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
});

// far 視圖導覽層：縮到最遠（lod-far）卡片只剩框時，
// 依卡片編號的字母前綴分類（P、PB、W…），在各分類卡片的中心點放大標示「分類＋張數」，
// 在鳥瞰視角仍看得出每一片是什麼。只算頂層卡（子卡跟父卡同區）；
// ViewportPortal＝畫布座標系（隨縮放平移），字級以 far 縮放範圍（0.12–0.25）設計。
// memo＋自訂比較（同任務列表：只看 data/position 身分）——非 far 時根本不掛載。
// HARE 4e9baf77 FarOverlay
const FarOverlay = memo(function FarOverlay({ nodes }) {
  const groups = new Map();
  nodes.forEach((n) => {
    if (n.parentId || n.type === "lane") return;
    const cat = /^([A-Za-z]+)/.exec(n.data?.num || "")?.[1]?.toUpperCase();
    if (!cat) return;
    const w = n.measured?.width || 200, h = n.measured?.height || 100;
    const g = groups.get(cat) || { x: 0, y: 0, c: 0 };
    g.x += n.position.x + w / 2; g.y += n.position.y + h / 2; g.c += 1;
    groups.set(cat, g);
  });
  return (
    <ViewportPortal>
      {[...groups.entries()].map(([cat, g]) => (
        <div key={cat} className="lod-cat-label"
          style={{ transform: `translate(-50%,-50%) translate(${g.x / g.c}px, ${g.y / g.c}px)` }}>
          {cat}{g.c > 1 && <span className="lod-cat-n">×{g.c}</span>}
        </div>
      ))}
    </ViewportPortal>
  );
}, (a, b) => a.nodes.length === b.nodes.length
  && a.nodes.every((n, i) => n === b.nodes[i]
    || (n.id === b.nodes[i].id && n.data === b.nodes[i].data && n.position === b.nodes[i].position)));

// 每型別初始寬高（供 NodeResizer；避免 width:100% 塌陷）。已有 width/height（拉過大小）的節點不覆寫，故不影響持久化的自訂尺寸與位置。
const LEGACY_TYPES = new Set(["plan", "exec", "chip", "object", "scope"]); // 卡型收斂前的舊型別
const withSize = (arr) => arr.map((n) => {
  if (LEGACY_TYPES.has(n.type)) n = { ...n, type: "note" }; // 舊檔安全網：未註冊型別會讓 React Flow 崩，載入即併入 note
  if (n.type === "lane") return n.width && n.height ? n : { ...n, width: n.data.w, height: n.data.h };
  // 內容卡：寬高皆交給 React Flow 依內容量測（去掉 width/height/measured，否則 v12 會沿用舊尺寸）。
  // 手動放大改存 data.minW / data.minH（見 Grips），不受此清除影響。
  const { width, height, measured, ...rest } = n;
  return rest;
});

// 瞬態剝除（buildState 與 serverBase 基準必須用同一套，差異比對才對得上）。
// 選取/拖曳等瞬態不入資料檔：selected 若持久化會跨分頁同步，A 的點選會把 B 的
// 選取與屬性框洗掉。選取純本地（applyServerState 套用時回填）。
const stripNodeT = ({ selected, dragging, resizing, draggable, selectable, deletable, ...n }) => n;
const stripEdgeT = ({ selected, reconnectable, ...e }) => e;
// 「內容身分」序列化（效能＋W1-9 復活根治）：瞬態之外再排除
// measured 與 data.childTop/childZoneH——量測/渲染衍生值各客戶端有 px 級差異，
// 不算內容差異。差異推送若把它算進去（舊行為），另一分頁光是量測飄移就會把
// 「沒動過的卡」誤判有變而整卡重推，被別人剛刪掉的卡就這樣復活。
// WeakMap 快取：物件身分沒換就不重算。applyServerState 也用它判斷「伺服器沒改
// 這張卡」→ 沿用本地物件（memo 節點跳過重繪、量測不重來）。
const nodeCmpCache = new WeakMap();
const nodeCmpStr = (n) => {
  let s = nodeCmpCache.get(n);
  if (s === undefined) {
    const { selected, dragging, resizing, draggable, selectable, deletable, measured, data, ...r } = n;
    r.data = data ? (({ childTop, childZoneH, ...d }) => d)(data) : data;
    s = JSON.stringify(r);
    nodeCmpCache.set(n, s);
  }
  return s;
};
const edgeCmpCache = new WeakMap();
const edgeCmpStr = (e) => {
  let s = edgeCmpCache.get(e);
  if (s === undefined) { s = JSON.stringify(stripEdgeT(e)); edgeCmpCache.set(e, s); }
  return s;
};

/* 資料檔（伺服器/存檔）即真相：有卡片就原樣採用，種子 initialNodes 只在
   「完全沒有資料」時當初始畫面。舊版曾以種子為基底做覆蓋式合併——資料檔
   換成非種子板（HARE B 卡）後會把種子卡併回並自動保存寫回，污染資料檔
   ，故廢除；種子可設定化見 B2。 */
const mergeDefaults = (saved) => {
  if (Array.isArray(saved.nodes) && saved.nodes.length) {
    return { nodes: saved.nodes, edges: Array.isArray(saved.edges) ? saved.edges : [] };
  }
  return { nodes: initialNodes, edges: initialEdges };
};
// 父先於子的穩定排序（「剪下貼進容器失敗」修正）：剪貼/搬移把頂層卡變子卡
// 後，資料檔殘留「子在父前」原始序，React Flow 報 Parent node not found 並忽略
// parentId（子卡以相對座標彈飛）。store 寫入端已正規化（lib/store.mjs
// sortParentsFirst）；這裡防禦「尚未被任何寫入重整」的舊資料檔。
const sortParentsFirst = (nodes) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n) => {
    let d = 0, p = n;
    while (p && p.parentId && byId.has(p.parentId) && d < 40) { p = byId.get(p.parentId); d += 1; }
    return d;
  };
  return nodes.map((n, i) => ({ n, i, d: depthOf(n) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.n);
};

// HARE 5e2f8a11 style_samples —— 卡片款式（選型落地
// 四款可選【現行/緊湊/描邊/便利貼】、預設描邊、Header Band 落選）。
// 點樣品即套用整板（data-cardstyle，存 UI_LS 本機）；樣式全在 index.css。
function StyleSampleCard({ cls }) {
  return (
    <div className={`ss-card ${cls}`}>
      <div className="ss-top">
        <span className="ss-lamp" />
        <span className="ss-num">W1-3</span>
        <span className="ss-title">{T("a_ssSampleTitle")}</span>
      </div>
      <div className="ss-desc">{T("a_ssSampleDesc")}</div>
      <div className="ss-task"><span className="ss-tk">{T("a_ssSampleTask")}</span></div>
    </div>
  );
}
function StyleSamples({ value, onPick }) {
  const items = [
    ["classic", "ss-classic", "a_ssClassic"], ["compact", "ss-compact", "a_ssCompact"],
    ["outlined", "ss-outlined", "a_ssOutlined"], ["sticky", "ss-sticky", "a_ssSticky"],
  ];
  return (
    <details className="ss-wrap nodrag" open>
      <summary className="ss-summary">{T("a_setStyleSamples")}</summary>
      <div className="ss-grid">
        {items.map(([key, cls, capKey]) => (
          <figure className={`ss-fig${value === key ? " on" : ""}`} key={key}
            onClick={() => onPick && onPick(key)}>
            <figcaption className="ss-cap">{value === key ? "● " : ""}{T(capKey)}</figcaption>
            <StyleSampleCard cls={cls} />
          </figure>
        ))}
      </div>
    </details>
  );
}

// W1-3-8 P3 款式管理器：一列一自訂款式，欄位＝白名單下拉＋accent 色碼；存 meta.cardStyles。
function StyleRow({ id, style, onPatch, onDup, onDelete }) {
  const sel = (key, opts) => (
    <select className="sty-sel nodrag" value={style[key]} onChange={(e) => onPatch(id, { [key]: e.target.value })}>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  const tokSel = (key, opts) => (
    <select className="sty-sel nodrag" value={style.tokens?.[key] || ""}
      onChange={(e) => onPatch(id, { tokens: { [key]: e.target.value || undefined } })}>
      <option value="">—</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  return (
    <div className="sty-mrow">
      <div className="sty-mhead">
        <input className="sty-name nodrag" value={style.name}
          onChange={(e) => onPatch(id, { name: e.target.value })} title={T("a_styleName")} />
        <span className="sty-id" title={id}>{id}</span>
        <button className="sty-mbtn nodrag" title={T("a_styleDup")} onClick={() => onDup(id)}>⿻</button>
        <button className="sty-mbtn nodrag" title={T("a_styleDelete")} onClick={() => onDelete(id)}>🗑</button>
      </div>
      <div className="sty-fields">
        <label>{T("a_styleBase")}{sel("base", STYLE_BASES)}</label>
        <label>{T("a_styleDensity")}{sel("density", DENSITIES)}</label>
        <label>{T("a_styleShape")}{sel("shape", SHAPES)}</label>
        <label>{T("a_styleHeader")}{sel("header", HEADERS)}</label>
        <label>{T("a_styleBorder")}{tokSel("border", BORDERS)}</label>
        <label>{T("a_styleShadow")}{tokSel("shadow", SHADOWS)}</label>
        <label>{T("a_styleSurface")}{tokSel("surface", SURFACES)}</label>
        <label>{T("a_styleAccent")}
          <input type="color" className="sty-color nodrag" value={style.tokens?.accent || "#0a6fb0"}
            onChange={(e) => onPatch(id, { tokens: { accent: e.target.value } })} />
          {style.tokens?.accent && <button className="sty-mbtn nodrag" title="✕"
            onClick={() => onPatch(id, { tokens: { accent: undefined } })}>✕</button>}
        </label>
      </div>
    </div>
  );
}
function StyleManager({ styles, onAdd, onPatch, onDup, onDelete, onImport, onExport }) {
  const ids = Object.keys(styles || {});
  return (
    <details className="ss-wrap nodrag">
      <summary className="ss-summary">{T("a_styleMgr")}{ids.length ? `（${ids.length}）` : ""}</summary>
      <div className="ss-hint">{T("a_styleMgrHint")}</div>
      <div className="sty-toolbar">
        <button className="sty-btn nodrag" onClick={() => onAdd(null)}>＋ {T("a_styleNew")}</button>
        <button className="sty-btn nodrag" onClick={onImport}>{T("a_styleImport")}</button>
        <button className="sty-btn nodrag" onClick={onExport}>{T("a_styleExport")}</button>
      </div>
      {ids.map((id) => (
        <StyleRow key={id} id={id} style={styles[id]} onPatch={onPatch} onDup={onDup} onDelete={onDelete} />
      ))}
    </details>
  );
}

// N6 內建程式碼閱讀器：GitHub 式浮動窗顯示錨點片段（輕量上色、行號、錨點行高亮）。
// 套浮動窗規範（float-box＋fb-head 拖曳＋fb-toggle ✕）；標題 ✕ 左邊放「其他開啟」鈕。
// HARE a6b21f0c code_reader
function CodeReader({ reader, pos, size, headProps, onResizeStart, onClose, onSystem, onVscode }) {
  const d = reader.data;
  const rows = d ? highlight(d.lines, d.lang) : [];
  const fname = String(reader.path || "").split("/").pop();
  return (
    <Panel position="top-left" className="float-box cr-box"
      style={{ left: pos.x, top: pos.y, right: "auto", transform: "none", margin: 0,
        ...(size ? { width: size.w, height: size.h } : {}) }}>
      {/* 八向邊緣把手（同其他浮動框規範，useEdgeResize） */}
      {["t", "b", "l", "r", "tl", "tr", "bl", "br"].map((dir) => (
        <div key={dir} className={`pr-rz pr-rz-${dir} nodrag`} onMouseDown={(e) => onResizeStart?.(e, dir)} />
      ))}
      <div className="fb-head" style={{ cursor: "move" }} {...headProps}>
        <span className="fb-title cr-title" title={reader.path}>
          📄 {fname}{d?.anchor ? <span className="cr-ln">:{d.anchor}</span> : null}</span>
        {/* B21 Phase 2：vscode://file/<abs>:<line> 直開定位（函數級帶錨點行）；片段載回前停用 */}
        <button className="cr-hbtn nodrag" title={T("cr_openVscode")} onClick={onVscode} disabled={!d?.abs}
          onMouseDown={(e) => e.stopPropagation()}>VS</button>
        <button className="cr-hbtn nodrag" title={T("cr_openSystem")} onClick={onSystem}
          onMouseDown={(e) => e.stopPropagation()}>⧉</button>
        <button className="fb-toggle nodrag" title={T("a_close")} onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}>✕</button>
      </div>
      <div className="cr-body nodrag">
        {reader.loading && <div className="cr-msg">{T("cr_loading")}</div>}
        {reader.error && <div className="cr-msg cr-err">{reader.error}</div>}
        {d && (
          <div className="cr-code">
            {rows.map((toks, i) => {
              const lineNo = d.start + i;
              const on = d.anchor && lineNo === d.anchor;
              return (
                <div className={`cr-line${on ? " on" : ""}`} key={i}>
                  <span className="cr-gutter">{lineNo}</span>
                  <span className="cr-src">{toks.map((t, j) => (t.c
                    ? <span key={j} className={`tok-${t.c}`}>{t.t}</span> : t.t))}</span>
                </div>
              );
            })}
          </div>
        )}
        {d && <div className="cr-foot" title={reader.path}>{reader.path} · {T("cr_totalLines", { n: d.total })}
          {d.truncated ? ` · ${T("cr_truncated", { n: d.end })}` : ""}</div>}
      </div>
    </Panel>
  );
}

// HARE 2df17d1d Flow
function Flow() {
  const persisted = loadPersisted();
  // 結構版本守衛：存檔若缺新版才有的 scope_s3（獨立技術範圍框），視為舊結構、
  // 改用最新預設，避免自動保存把舊版佈局蓋回來（schema 變更後的相容處理）。
  const valid = persisted && Array.isArray(persisted.nodes) && persisted.nodes.length > 0;
  const merged = valid ? mergeDefaults(persisted) : { nodes: initialNodes, edges: initialEdges };
  const [ns, setNodes, onNodesChange] = useNodesState(withSize(sortParentsFirst(merged.nodes)));
  // 持續性約束群組：與 nodes/edges 一同持久化/同步
  const [constraints, setConstraints] = useState(() => (Array.isArray(persisted?.constraints) ? persisted.constraints : []));
  const constraintsRef = useRef(constraints); constraintsRef.current = constraints;
  // 白板標題等共享中繼資料：{title, sub}，隨資料檔同步
  const [boardMeta, setBoardMeta] = useState(() => persisted?.meta || null);
  const boardMetaRef = useRef(boardMeta); boardMetaRef.current = boardMeta;
  const [es, setEdges, onEdgesChange] = useEdgesState(merged.edges);
  const { screenToFlowPosition, setCenter, getViewport, setViewport: rfSetViewport,
    fitView, deleteElements: rfDeleteElements } = useReactFlow();
  const counter = useRef(1 + ns.filter((n) => n.type === "note").length);
  const vpRef = useRef(valid ? (persisted.viewport || null) : null);
  const hydrated = useRef(false);
  // MCP/檔案同步協調
  const REV = useRef(0);          // 檔案 rev（外部變更偵測）
  const skipSave = useRef(false); // 套用外部變更後略過一次回寫，避免 echo
  const pushNow = useRef(false);  // 下一次持久化 effect 跳過去抖立即推送（新增卡片等離散事件）
  // 刪除墓碑（多方合併寫入用）：client 明確刪除的卡/線 id，隨 PUT 上報、成功後清空
  const removedIdsRef = useRef({ nodes: new Set(), edges: new Set() });
  const syncOn = useRef(true);    // 無 /api（如 dist file://）→ 自動關閉同步
  const pendingPush = useRef(0);  // 進行中的推送數；>0 時暫停輪詢（避免套用自己剛寫、rev 尚未回填而誤判外部變更 → 洗掉選取）
  // 掛載競速守衛：首次成功拉回伺服器狀態前，一律不推送——
  // 否則 localStorage 舊快取會搶在「掛載先拉」完成前被去抖推送出去，合併寫入把
  // 舊代整板加回伺服器（卡數會翻倍）。localStorage 照常寫。
  const bootPulled = useRef(false);
  const sseAlive = useRef(false);  // SSE 連線存活時暫停輪詢（SSE 失敗→退回 2.5s 輪詢）
  // 專案分頁（v2，HARE 9a6e5b21）：pages＝全專案分頁（伺服器最新＋本地覆蓋，
  // ns/es 只承載作用中那頁）；activePage＝作用頁 id。切頁見 switchPage（純記憶體，不重載）。
  const [pages, setPages] = useState([]);
  const pagesRef = useRef(pages); pagesRef.current = pages;
  const [activePage, setActivePage] = useState(null); // 首拉完成後定案
  const activePageRef = useRef(activePage); activePageRef.current = activePage;

  // 復原/重做（Undo/Redo）：快照堆疊。用 ref 存即時 ns/es 避免閉包過時。
  const nsRef = useRef(ns); nsRef.current = ns;
  const esRef = useRef(es); esRef.current = es;
  const past = useRef([]);
  const future = useRef([]);
  const [, force] = useReducer((x) => x + 1, 0);
  const snapshot = useCallback(() => {
    past.current.push({ nodes: nsRef.current, edges: esRef.current });
    if (past.current.length > 100) past.current.shift();
    future.current = []; force();
  }, []);
  // 復原/重做的墓碑同步（「Ctrl+Z 復原建立，卡片消失又冒回來」）：
  // undo 只整包換回舊狀態，不會像 DEL 走 onNodesDelete 記刪除墓碑——已推上伺服器的
  // 新卡沒被通知刪除，下一輪同步就屍還魂。這裡對「還原前 vs 還原後」做 id 差集：
  // 現在有、還原後沒有＝隱式刪除→補記墓碑；現在沒有、還原後有＝救回→取消未送出的墓碑
  // （否則 DEL 後立刻 Ctrl+Z，殘留墓碑會在下次推送反殺救回的卡）。
  const syncTombs = useCallback((target) => {
    const tn = new Set(target.nodes.map((n) => n.id));
    const te = new Set(target.edges.map((e) => e.id));
    nsRef.current.forEach((n) => { if (!tn.has(n.id)) removedIdsRef.current.nodes.add(n.id); });
    esRef.current.forEach((e) => { if (!te.has(e.id)) removedIdsRef.current.edges.add(e.id); });
    target.nodes.forEach((n) => removedIdsRef.current.nodes.delete(n.id));
    target.edges.forEach((e) => removedIdsRef.current.edges.delete(e.id));
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes: nsRef.current, edges: esRef.current });
    syncTombs(prev);
    setNodes(prev.nodes); setEdges(prev.edges); force();
  }, [setNodes, setEdges, syncTombs]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes: nsRef.current, edges: esRef.current });
    syncTombs(next);
    setNodes(next.nodes); setEdges(next.edges); force();
  }, [setNodes, setEdges, syncTombs]);
  // 熱鍵現值＝預設逐鍵覆蓋設定值；rebind＝設定框「請按新按鍵」中的動作鍵名
  // HARE 4b8d21ce hotkeysRef
  const hotkeysRef = useRef({ ...HOTKEY_DEFAULT, ...(loadUi().hotkeys || {}) });
  const [rebind, setRebind] = useState(null);
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const hk = hotkeysRef.current;
      if (comboMatch(e, hk.undo)) { e.preventDefault(); undo(); }
      // 重做＝自訂重做鍵，或「復原鍵＋Shift」變體（沿用 Ctrl+Shift+Z 慣例，隨改綁跟動）
      else if (comboMatch(e, hk.redo) || (hk.undo && !hk.undo.shift && comboMatch(e, { ...hk.undo, shift: true }))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [undo, redo]);
  // 刪除前先快照（可 Undo 救回，例如誤刪 E4·5）
  const onBeforeDelete = useCallback(async () => { snapshot(); return true; }, [snapshot]);

  // 組裝持久化狀態，附上「已刪除的預設邊」墓碑（＝目前 es 缺少的預設邊 id）＋目前認定的 rev
  // （供伺服器做樂觀鎖：與現值不符即 409，見 pushServer 的衝突處理）。
  // 瞬態剝除函數（stripNodeT/stripEdgeT）已移到模組層（見 nodeCmpStr 一帶）。
  const buildState = useCallback((nodes, edges, vp) => ({
    page: activePageRef.current || undefined, // 分頁 v2：合併寫入落在作用頁（省略＝第一頁）
    nodes: nodes.map(stripNodeT),
    edges: edges.map(stripEdgeT),
    viewport: vp,
    deletedEdges: INIT_EDGE_IDS.filter((id) => !edges.some((e) => e.id === id)),
    constraints: constraintsRef.current,
    meta: boardMetaRef.current,
    removedNodeIds: [...removedIdsRef.current.nodes],
    removedEdgeIds: [...removedIdsRef.current.edges],
    rev: REV.current,
  }), []);

  // 套用伺服器目前資料到畫面（不覆蓋、不回寫）：MCP/其他分頁寫入後或 409 衝突時共用。
  // 內容指紋：去除瞬態欄位（量測/選取/拖曳），只比對會持久化的內容。
  // 套用外部變更後 React Flow 重新量測會觸發 ns 變動，若把它當成編輯回寫，
  // 多分頁會「廣播→套用→量測→回寫」無限循環（rev 暴增、本地編輯被外部
  // rev 超前洗掉＝畫面一直復原）。內容相同→不推送。
  // childTop/childZoneH 是渲染量測衍生值（ChildSpacer/子卡區 effect 回寫），各分頁
  // 量測可有 px 級差異——若算「內容編輯」會觸發推送→廣播→重量測→回寫的循環
  // （約 2.2 寫/秒），故一併視為瞬態排除；其變更搭下一次真編輯順路入檔。
  const fingerprint = (nodes, edges, cons, metaFp) => JSON.stringify({
    n: nodes.map(({ measured, selected, dragging, resizing, data, ...r }) => ({
      ...r, data: data ? (({ childTop, childZoneH, ...d }) => d)(data) : data,
    })),
    e: edges.map(({ selected, ...r }) => r),
    c: cons || [],
    m: metaFp || null,
  });
  const lastSynced = useRef("");
  // 伺服器基準（差異推送用）：上次套用的伺服器狀態逐卡序列化。
  // 推送時只送與基準不同的卡/線——沒動過的卡不進 payload，舊分頁的快照
  // 蓋不掉 MCP/其他分頁對那些卡的變更（「已封存任務被復活」的根治）。
  const serverBase = useRef({ nodes: new Map(), edges: new Map(), cons: "[]", meta: "null" });

  const applyServerState = useCallback((cur) => {
    // 分頁 v2：伺服器回全專案 pages；套用作用頁到畫布，全部頁存進 pages state
    //（任務/卡片列表跨分頁彙整、切頁快取都吃它）。
    if (!(cur && typeof cur.rev === "number" && Array.isArray(cur.pages))) return;
    REV.current = cur.rev;
    if (cur.refBase) setRefBase(cur.refBase); // B2：per-專案程式連結基準根（伺服器提供）
    const wanted = activePageRef.current || INIT_PAGE;
    const pg = cur.pages.find((p) => p.id === wanted) || cur.pages.find((p) => p.name === wanted) || cur.pages[0];
    if (!pg) return;
    if (activePageRef.current !== pg.id) { activePageRef.current = pg.id; setActivePage(pg.id); }
    setPages(cur.pages);
    skipSave.current = true;
    // 種子只給第一頁的空板（預設板首用畫面）；新分頁空板就是空板，不種示範卡
    const m0 = pg === cur.pages[0] ? mergeDefaults(pg) : { nodes: pg.nodes || [], edges: pg.edges || [] };
    const m = { ...m0, nodes: sortParentsFirst(m0.nodes) }; // 防「子在父前」舊序（剪貼修正）
    // 回填本地選取（選取不入資料檔，見 buildState）：套用外部變更不洗掉自己的選取
    const selN = new Set(nsRef.current.filter((n) => n.selected).map((n) => n.id));
    const selE = new Set(esRef.current.filter((e) => e.selected).map((e) => e.id));
    // 身分保留（效能）：內容相同（忽略瞬態與量測）的卡/線沿用本地物件——
    // memo 節點/邊跳過重繪、量測不重來；外部只改一張卡就真的只重繪那一張，
    // 不再是每次 SSE 同步全板重渲染。
    const prevN = new Map(nsRef.current.map((n) => [n.id, n]));
    const prevE = new Map(esRef.current.map((e) => [e.id, e]));
    const sized = withSize(m.nodes).map((n) => {
      const withSel = selN.has(n.id) ? { ...n, selected: true } : n;
      const prev = prevN.get(n.id);
      return prev && nodeCmpStr(prev) === nodeCmpStr(withSel) ? prev : withSel;
    });
    const edges = m.edges.map((e) => {
      const withSel = selE.has(e.id) ? { ...e, selected: true } : e;
      const prev = prevE.get(e.id);
      return prev && edgeCmpStr(prev) === edgeCmpStr(withSel) ? prev : withSel;
    });
    const cons = Array.isArray(pg.constraints) ? pg.constraints : []; // 約束是頁層資料
    lastSynced.current = fingerprint(sized, edges, cons, cur.meta ?? null);
    // 基準用「內容身分」序列化（不含量測值）——與 pushServer 的差異比對同一套，
    // 量測飄移不會讓沒動過的卡被誤判有變
    serverBase.current = {
      nodes: new Map(sized.map((n) => [n.id, nodeCmpStr(n)])),
      edges: new Map(edges.map((e) => [e.id, edgeCmpStr(e)])),
      cons: JSON.stringify(cons),
      meta: JSON.stringify(cur.meta ?? null),
    };
    setNodes(sized);
    setEdges(edges);
    setConstraints(cons);
    setBoardMeta(cur.meta ?? null);
  }, [setNodes, setEdges]);

  // 推送到 /api/roadmap。伺服器端為合併寫入（lib/merge.mjs）——推送永遠安全，
  // 不會抹掉別人的並發變更，因此「先推後拉」：推完把伺服器合併結果拉回本地，
  // 一次帶回自己與別人的變更。舊時代的「rev 超前→放棄推送/丟棄 payload」防禦
  // 已移除——那是整份覆蓋時代防互抹用的，在合併語意下反而把本地變更放棄
  // 再拉舊狀態蓋回（＝「調整一直被復原」， 實回報）。
  // 此處為 pushServer；barSubmit 的錨點（09b9615a）在後面——這裡不放 HARE 錨，維持 uuid 全檔唯一
  const pushServer = useCallback(async (payload) => {
    if (!syncOn.current || !payload || !Array.isArray(payload.nodes)) return;
    // 差異推送：只送與 serverBase 基準不同的卡/線；meta/constraints
    // 未變即省略（merge 端 undefined＝維持現值）。什麼都沒變＝不打伺服器。
    // 空板（HMR re-mount 瞬間）自然推不出東西——無墓碑即無刪除，天然安全。
    const base = serverBase.current;
    // 差異比對用「內容身分」（nodeCmpStr/edgeCmpStr，不含量測值）：只有真正被編輯
    // 的卡才進 payload。量測飄移的卡不再被重推——別人刪掉的卡不會被本分頁復活。
    // （進 payload 的卡仍帶完整欄位，childZoneH 等衍生值照舊「搭真編輯順路入檔」。）
    const body = {
      page: payload.page, // 分頁 v2：合併寫入落在作用頁
      nodes: payload.nodes.filter((n) => base.nodes.get(n.id) !== nodeCmpStr(n)),
      edges: payload.edges.filter((e) => base.edges.get(e.id) !== edgeCmpStr(e)),
      viewport: payload.viewport,
      deletedEdges: payload.deletedEdges,
      removedNodeIds: payload.removedNodeIds,
      removedEdgeIds: payload.removedEdgeIds,
      rev: payload.rev,
    };
    if (JSON.stringify(payload.constraints) !== base.cons) body.constraints = payload.constraints;
    if (JSON.stringify(payload.meta ?? null) !== base.meta) body.meta = payload.meta ?? null;
    if (!body.nodes.length && !body.edges.length && !body.removedNodeIds.length
      && !body.removedEdgeIds.length && body.constraints === undefined && body.meta === undefined) return;
    pendingPush.current += 1;
    try {
      const r = await fetch(withProject("/api/roadmap"), { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        if (typeof j.rev === "number") REV.current = Math.max(REV.current, j.rev);
        // lastSynced 交由推後拉回的 applyServerState 刷新（差異 payload 算不出全板指紋）
        // 墓碑已由伺服器合併處理——清空（其後的新刪除會再累積並觸發新推送）
        removedIdsRef.current.nodes.clear(); removedIdsRef.current.edges.clear();
        // 拉回合併結果（含別人的並發變更）。若期間本地又有新編輯，
        // applyServerState 更新 lastSynced 後 fingerprint 不同，effect 會再推——收斂。
        const g = await fetch(withProject("/api/roadmap"), { headers: { Accept: "application/json" } });
        if (g.ok) {
          const cur = await g.json();
          if (cur && cur.rev >= REV.current) applyServerState(cur);
        }
      }
    } catch { syncOn.current = false; }
    finally { pendingPush.current -= 1; }
  }, [setNodes, setEdges]);

  // 去抖持久化＋推送（效能重構）：舊版每次 ns/es 變動（拖曳每一格、量測抖動）
  // 都同步做 buildState＋localStorage.setItem＋fingerprint＝三次全量序列化，大板一拖就卡。
  // 改為「變動只排程 400ms 計時器」，到期才從 refs 取最新狀態做一次序列化；
  // 內容沒變（量測/選取抖動）只存 localStorage、不推送。
  const pushTimer = useRef(null);
  const flushPersist = useCallback(() => {
    if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }
    const payload = buildState(nsRef.current, esRef.current, vpRef.current);
    localStorage.setItem(LS, JSON.stringify(payload));
    if (!bootPulled.current) return null; // 首拉未完成→只落快取，不推送（防舊快取搶跑復活）
    if (fingerprint(nsRef.current, esRef.current, constraintsRef.current, boardMetaRef.current)
      === lastSynced.current) return null; // 非內容編輯→不推送
    return pushServer(payload);
  }, [pushServer, buildState]);

  // 持久化：節點（含拖移位置/改字）＋邊 變動→排程去抖 flush；跳過首次掛載
  useEffect(() => {
    if (!hydrated.current) { hydrated.current = true; return; }
    if (skipSave.current) {
      // 剛套用外部變更→不回寫伺服器，但 localStorage 快取要跟上（維持舊版行為：
      // 下次載入的初始畫面才不會是舊狀態）
      skipSave.current = false;
      localStorage.setItem(LS, JSON.stringify(buildState(nsRef.current, esRef.current, vpRef.current)));
      return;
    }
    if (pushNow.current) {
      // 離散事件（新增卡片/區域）：跳過去抖立即推送，縮短「本地新增尚未推送、
      // 被外部套用洗掉」的窗口（多寫者細粒度合併是 B4 課題，這裡先把窗口壓到毫秒級）
      pushNow.current = false;
      flushPersist();
      return;
    }
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => { pushTimer.current = null; flushPersist(); }, 400);
  }, [ns, es, constraints, boardMeta, flushPersist]);

  // 頁面關閉/切頁前：把去抖中的變更同步落 localStorage（伺服器端交給下次載入的合併寫入；
  // 舊版每次變動都同步寫 localStorage，去抖後需要這道保險維持同等的資料保全）。
  useEffect(() => {
    const h = () => {
      if (!pushTimer.current) return;
      clearTimeout(pushTimer.current); pushTimer.current = null;
      localStorage.setItem(LS, JSON.stringify(buildState(nsRef.current, esRef.current, vpRef.current)));
    };
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, [buildState]);

  // 抓取檔案並套用（rev 超前才套）；EventSource 與輪詢共用。pendingPush>0 時跳過（避免套自己剛寫）。
  // 本地有 debounce 中的待推變更→改為先推送（合併寫入安全；推完自帶拉回），
  // 不直接套用——否則會把剛做的編輯蓋掉（＝「調整一直被復原」）。
  // HARE 8d5f6230 App
  const fetchAndApply = useCallback(async () => {
    if (!syncOn.current || pendingPush.current > 0) return;
    if (pushTimer.current) {
      const pushed = flushPersist(); // 有真編輯→推（推完自帶拉回）；只是抖動→往下照常拉
      if (pushed) { await pushed; return; }
    }
    try {
      const r = await fetch(withProject("/api/roadmap"), { headers: { Accept: "application/json" } });
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j.rev === "number" && Array.isArray(j.pages)) {
        // 資料檔即真相：首拉一律套用（含 rev 相同/空板——localStorage 只是快取，
        // 不得作為推送來源復活舊卡）；其後只在 rev 超前時套用。
        if (j.rev > REV.current || !bootPulled.current) applyServerState(j);
        bootPulled.current = true; // 首拉完成→解鎖推送
      }
    } catch { syncOn.current = false; }
  }, [applyServerState, flushPersist]);

  // MCP 同步：掛載時先「拉」伺服器資料套用（資料檔為真相來源；舊版掛載即推送，
  // 種子清空後會把空板寫進檔案，已廢除）；之後每 2.5s 輪詢，
  // 若檔案 rev 超前（MCP 改過）→ 套用到畫面。
  // 輪詢＝SSE 的後備：SSE 連線存活（sseAlive）時暫停輪詢。
  useEffect(() => {
    let stop = false;
    fetchAndApply();
    const poll = async () => {
      if (stop || sseAlive.current) return; // SSE 存活→交給 SSE，不輪詢
      await fetchAndApply();
    };
    const iv = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(iv); };
  }, [pushServer, fetchAndApply, buildState]);

  // SSE 即時同步：收到 rev 超前才 fetch 套用（取代 2.5s 輪詢）。
  // 連線建立→暫停輪詢；連線失敗（onerror）→ sseAlive=false 退回輪詢，EventSource 亦會自動重連。
  useEffect(() => {
    if (!syncOn.current || typeof EventSource === "undefined") return;
    let es;
    try { es = new EventSource(withProject("/api/roadmap/events")); } catch { return; }
    es.onopen = () => { sseAlive.current = true; };
    es.onmessage = (ev) => {
      try {
        const { rev } = JSON.parse(ev.data);
        if (typeof rev === "number" && rev > REV.current) fetchAndApply();
      } catch { /* 心跳/非 JSON→忽略 */ }
    };
    es.onerror = () => { sseAlive.current = false; }; // 退回輪詢
    return () => { sseAlive.current = false; try { es.close(); } catch { /* noop */ } };
  }, [fetchAndApply]);

  const persistViewport = useCallback((_, vp) => {
    vpRef.current = vp;
    localStorage.setItem(LS, JSON.stringify(buildState(ns, es, vp)));
  }, [ns, es, buildState]);

  // 新線段的預設樣式（可由屬性框「設為預設」按鈕覆寫，存 localStorage）
  const edgeDefaultRef = useRef(loadUi().edgeDefault || EDGE_DEFAULT);
  const applyEdgeDefault = () => {
    const d = edgeDefaultRef.current;
    return {
      type: d.type || "default", animated: !!d.animated, style: { ...(d.style || {}) },
      ...(d.markerStart ? { markerStart: { ...d.markerStart } } : {}),
      ...(d.markerEnd ? { markerEnd: { ...d.markerEnd } } : {}),
    };
  };

  // 記住拉線起點，確保連線方向＝拖曳方向（箭頭在放開的終點端）
  const connectStart = useRef(null);
  // HARE 37c0b64f onConnect
  const onConnectStart = useCallback((_, params) => { connectStart.current = params; setConnecting(true); }, []);
  const onConnectEnd = useCallback(() => setConnecting(false), []);
  // 邊端點重量測（調整線段後箭頭會懸空）：新建/重連/反轉/
  // 刪除線段都會改端點的單雙點佈局（±15px 錯開⇄置中），React Flow 的 handleBounds 快取
  // 若吃到舊 DOM 線就懸空——等兩個 frame（渲染定稿）強制重量測兩端卡片。
  const updateInternals = useUpdateNodeInternals();
  const remeasureEnds = useCallback((...nodeIds) => {
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length) requestAnimationFrame(() => requestAnimationFrame(() => updateInternals(ids)));
  }, [updateInternals]);
  const onConnect = useCallback((c) => {
    // 列端點保險（規則）：列不可接回自己資源卡（CSS 已滅點，這裡雙保險）
    if (c.source === c.target
      && ((c.sourceHandle || "").startsWith("f:") || (c.targetHandle || "").startsWith("f:"))) return;
    snapshot();
    let conn = c;
    const start = connectStart.current;
    // loose 模式下若從「終點端」handle 起拉，React Flow 會把起點當 target →
    // 方向反、箭頭跑到起點。偵測到就換回來，讓 source＝起點、target＝終點。
    if (start && start.nodeId && c.source !== start.nodeId && c.target === start.nodeId) {
      conn = { source: c.target, sourceHandle: c.targetHandle, target: c.source, targetHandle: c.sourceHandle };
    }
    // 新線段自動選取（顯示線段屬性框）：給定 id＋selected，並清掉其它選取
    const id = `e_${Date.now()}`;
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((eds) => {
      const cleared = eds.map((e) => (e.selected ? { ...e, selected: false } : e));
      return addEdge({ ...conn, id, selected: true, ...applyEdgeDefault() }, cleared);
    });
    remeasureEnds(conn.source, conn.target);
  }, [setEdges, setNodes, snapshot, remeasureEnds]);

  // 邊重連：起點或終點都可拖去接別的 handle。核心保險——重連開始先記住原邊，
  // 若這次沒成功接上（onReconnect 未觸發），在 onReconnectEnd 把原邊補回，
  // 保證整條線永遠不會因端點沒接上而消失。
  const reconnecting = useRef(null);
  const onReconnectStart = useCallback((_, edge) => { snapshot(); reconnecting.current = edge; setConnecting(true); }, [snapshot]);
  const onReconnect = useCallback((oldEdge, newConn) => {
    reconnecting.current = null; // 成功接上
    setEdges((els) => {
      const next = reconnectEdge(oldEdge, newConn, els, { shouldReplaceId: false });
      if (next.some((e) => e.id === oldEdge.id)) return next;
      // reconnectEdge 掉了這條邊（同節點換 handle 等）→ 手動更新 source/target/handle
      return els.map((e) => (e.id === oldEdge.id
        ? { ...e, source: newConn.source, target: newConn.target,
            sourceHandle: newConn.sourceHandle, targetHandle: newConn.targetHandle }
        : e));
    });
    remeasureEnds(oldEdge.source, oldEdge.target, newConn.source, newConn.target);
  }, [setEdges, remeasureEnds]);
  const onReconnectEnd = useCallback(() => {
    setConnecting(false);
    const edge = reconnecting.current;
    reconnecting.current = null;
    if (edge) { // 失敗→補回原邊
      setEdges((els) => (els.some((e) => e.id === edge.id) ? els : [...els, edge]));
      remeasureEnds(edge.source, edge.target);
    }
  }, [setEdges, remeasureEnds]);

  // 新卡片預設狀態/顏色（可由卡片屬性框「★」設定，存 localStorage）
  const nodeDefaultRef = useRef(loadUi().nodeDefault || { status: "note" });
  // 子卡落點：父卡子畫布在視窗內＝新卡落在「視窗中央」
  // （換算父相對座標，extent:parent 會自動夾回框內）；父卡不在視窗內＝落子畫布左上、
  // 鏡頭帶過去。所有新增卡種（卡片/節點/代理/圖片）共用。HARE ch11d5p0 childDropSpot
  const childDropSpot = useCallback((parent) => {
    let ax = parent.position.x, ay = parent.position.y, pp = parent;
    while (pp.parentId) { pp = nsRef.current.find((z) => z.id === pp.parentId); if (!pp) break; ax += pp.position.x; ay += pp.position.y; }
    const pw = parent.measured?.width || parent.width || 260;
    const ph = parent.measured?.height || parent.height || 160;
    const childTop = parent.data?.childTop ?? ((parent.measured?.height || parent.height || 120) + 10);
    const vp = getViewport();
    const zoom = vp.zoom || 1;
    const vx = -vp.x / zoom, vy = -vp.y / zoom;
    const vw = window.innerWidth / zoom, vh = window.innerHeight / zoom;
    const visible = ax < vx + vw && ax + pw > vx && ay < vy + vh && ay + ph > vy;
    if (visible) {
      const c = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      return { pos: { x: Math.max(8, c.x - ax - 110), y: Math.max(childTop, c.y - ay - 40) }, jump: null };
    }
    return { pos: { x: 16, y: childTop }, jump: { x: ax + 16 + 110, y: ay + childTop + 40 } };
  }, [getViewport, screenToFlowPosition]);
  // at＝畫布座標放置中心（右鍵新增以右鍵點為中心）；省略＝視窗中央
  const addCard = useCallback((at) => {
    snapshot();
    pushNow.current = true;
    // N 類補最小空號——掃「全專案所有分頁」（編號跨分頁唯一）
    const usedN = new Set();
    const scanN = (arr) => (arr || []).forEach((x) => { const m = /^N\s*(\d+)$/i.exec(x.data?.num || ""); if (m) usedN.add(+m[1]); });
    scanN(nsRef.current);
    pagesRef.current.forEach((p) => { if (p.id !== activePageRef.current) scanN(p.nodes); });
    let n = 1; while (usedN.has(n)) n += 1;
    const d = nodeDefaultRef.current;
    const base = { id: `note_${Date.now()}`, type: "note",
      // 預設名稱「名稱」（子卡同）
      data: { num: `N${n}`, label: T("a_defaultCardName"), status: d.status || "note",
        ...(d.color ? { color: d.color } : {}), ...(d.bg ? { bg: d.bg } : {}) } };
    // 選取單一卡片時 → 放成該卡的子卡片（parentId＋extent 限制在框內）
    const selected = nsRef.current.filter((x) => x.selected && x.type !== "lane");
    const parent = selected.length === 1 ? selected[0] : null;
    if (parent) {
      const kidsArr = nsRef.current.filter((x) => x.parentId === parent.id);
      // 子卡片編號＝父卡片編號-序號（補最小空號）
      const used = new Set();
      kidsArr.forEach((k) => { const m = /-(\d+)$/.exec(k.data?.num || ""); if (m) used.add(parseInt(m[1], 10)); });
      let cn = 1; while (used.has(cn)) cn += 1;
      const childNum = `${parent.data?.num || "?"}-${cn}`;
      // 落點（HARE ch11d5p0）：父卡在視窗內＝視窗中央；
      // 不在視窗內＝子畫布左上＋鏡頭帶過去。
      const spot = childDropSpot(parent);
      setNodes((nds) => nds
        .map((n) => (n.selected ? { ...n, selected: false } : n))
        .concat({ ...base, parentId: parent.id, extent: "parent", selected: true,
          data: { ...base.data, num: childNum, label: T("a_defaultCardName") },
          position: spot.pos }));
      if (spot.jump) setCenter(spot.jump.x, spot.jump.y, { zoom: Math.max(getViewport().zoom || 0.9, 0.7), duration: 350 });
    } else {
      // at＝右鍵點（畫布座標）；否則視窗正中央。扣卡片半寬半高讓卡「中心」對正落點
      const p = at || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n))
        .concat({ ...base, position: { x: p.x - 110, y: p.y - 40 }, selected: true }));
      // 右鍵點已在視野內＝不搶鏡頭；視窗中央新增才帶鏡頭（避免被浮動框遮擋，W1-2-2）
      if (!at) setCenter(p.x, p.y, { zoom: Math.max(getViewport().zoom || 0.9, 0.7), duration: 350 });
    }
  }, [screenToFlowPosition, setCenter, setNodes, snapshot, getViewport]);

  // ---- 圖片卡（HARE 1ma9e0d4 insertImage）----
  // 用途：貼上 UI 截圖 → 圖面設錨點 → 錨點連線到編號卡＝視覺索引。
  // 來源二擇：剪貼簿貼上（window paste）／右鍵「插入圖片…」（檔案選擇器）。
  // 二進位走 POST /api/assets（板 JSON 只存 URL，快取不被 base64 撐爆）。
  const fileInputRef = useRef(null);
  const pendingImgAt = useRef(null);   // 右鍵插入時的畫布落點
  const pendingImgCard = useRef(null); // 空圖片卡點空白處挑檔：目標卡 id
  // 上傳圖片（型別檢查共用）：回 { url, natW }；非圖片直接丟錯
  const uploadImage = useCallback(async (blob) => {
    if (!blob || !String(blob.type || "").startsWith("image/")) throw new Error(T("a_errNotImage"));
    const name = blob.name || "clipboard.png";
    const q = PROJECT === "default" ? "" : `project=${encodeURIComponent(PROJECT)}&`;
    const r = await fetch(`/api/assets?${q}name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error(j.error || `HTTP ${r.status}`);
    const dim = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im.naturalWidth || 360);
      im.onerror = () => res(360);
      im.src = j.url;
    });
    return { url: j.url, natW: dim, name };
  }, []);
  // N 類補號掃全專案（編號跨分頁唯一）
  const nextN = useCallback(() => {
    const usedN = new Set();
    const scanN = (arr) => (arr || []).forEach((x) => { const m = /^N\s*(\d+)$/i.exec(x.data?.num || ""); if (m) usedN.add(+m[1]); });
    scanN(nsRef.current);
    pagesRef.current.forEach((p) => { if (p.id !== activePageRef.current) scanN(p.nodes); });
    let nn = 1; while (usedN.has(nn)) nn += 1;
    return nn;
  }, []);
  const insertImageBlob = useCallback(async (blob, at) => {
    if (!blob) return;
    try {
      const { url, natW, name } = await uploadImage(blob);
      const w = Math.min(480, Math.max(240, natW)); // 顯示寬度縮進 240–480（可再角點縮放）
      snapshot();
      pushNow.current = true;
      const nm = name.replace(/\.(png|jpe?g|gif|webp)$/i, "");
      // 編號＆落點：與 addSpecialCard("img") 同規則——貼上時單選一張卡＝繼承其編號成子卡
      // 「父號-序號」並落進其子畫布；否則頂層 N 類補號（放在 at 或畫面中央）。落點帶 at＝
      // 拖放/右鍵插入到指定位置，不吃父層繼承。
      const sel = nsRef.current.filter((x) => x.selected && x.type !== "lane");
      const parent = !at && sel.length === 1 ? sel[0] : null;
      const id = `img_${Date.now()}`;
      const base = { id, type: "img", selected: true,
        data: { label: nm, status: "note", src: url, w,
          gallery: [{ src: url, name: nm, strokes: [], regions: [], shapes: [] }] } };
      let node;
      if (parent) {
        const used = new Set();
        nsRef.current.filter((x) => x.parentId === parent.id)
          .forEach((k) => { const m = /-(\d+)$/.exec(k.data?.num || ""); if (m) used.add(parseInt(m[1], 10)); });
        let cn = 1; while (used.has(cn)) cn += 1;
        const spot = childDropSpot(parent);
        node = { ...base, parentId: parent.id, extent: "parent", position: spot.pos,
          data: { ...base.data, num: `${parent.data?.num || "?"}-${cn}` } };
        if (spot.jump) setCenter(spot.jump.x, spot.jump.y, { zoom: Math.max(getViewport().zoom || 0.9, 0.7), duration: 350 });
      } else {
        const p = at || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        node = { ...base, position: { x: p.x - w / 2, y: p.y - 80 }, data: { ...base.data, num: `N${nextN()}` } };
      }
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(node));
      flash(T("a_flashImgInserted"));
    } catch (e) {
      flash(T("a_flashImgUploadFail", { e: String(e && e.message || e) }));
    }
  }, [uploadImage, nextN, snapshot, setNodes, screenToFlowPosition, childDropSpot, setCenter, getViewport]);
  // 把圖片放進「既有的空圖片卡」（點卡片空白處挑檔／選取時 Ctrl+V）；一併種 gallery
  const setImgCardSrc = useCallback(async (cardId, blob) => {
    try {
      const { url, natW, name } = await uploadImage(blob);
      snapshot();
      pushNow.current = true;
      setNodes((nds) => nds.map((n) => (n.id === cardId
        ? { ...n, data: { ...n.data, src: url, w: Math.min(480, Math.max(240, natW)),
            gallery: [{ src: url, name, strokes: [], regions: [] }] } } : n)));
      flash(T("a_flashImgLoaded"));
    } catch (e) {
      flash(T("a_flashImgLoadFail", { e: String(e && e.message || e) }));
    }
  }, [uploadImage, snapshot, setNodes]);
  // 圖片清單（HARE 1ma9a11e）：一卡多圖——加入新圖並切換顯示
  const pendingImgGallery = useRef(null);
  const addImgToGallery = useCallback(async (cardId, blob) => {
    try {
      const { url, natW, name } = await uploadImage(blob);
      snapshot();
      pushNow.current = true;
      setNodes((nds) => nds.map((n) => {
        if (n.id !== cardId) return n;
        // 正規化既有清單（含 legacy 卡層 strokes/regions 折入首圖），append 新圖並切換顯示
        const { gallery } = imgGalleryOf(n.data);
        return { ...n, data: { ...n.data, gallery: [...gallery, { src: url, name, strokes: [], regions: [] }],
          src: url, strokes: undefined, regions: undefined,
          w: n.data.w || Math.min(480, Math.max(240, natW)) } };
      }));
      flash(T("a_flashImgAddedGallery"));
    } catch (e) {
      flash(T("a_flashImgAddFail", { e: String(e && e.message || e) }));
    }
  }, [uploadImage, snapshot, setNodes]);
  useEffect(() => { // 圖片清單 ＋鈕（ImgNode 發事件）→ 開檔案選擇器
    const h = (e) => {
      const cardId = e.detail?.cardId;
      if (!cardId) return;
      pendingImgGallery.current = cardId;
      fileInputRef.current?.click();
    };
    window.addEventListener("hare:img-pick", h);
    return () => window.removeEventListener("hare:img-pick", h);
  }, []);
  useEffect(() => { // 截圖鈕（ImgNode 📷 發事件）→ getDisplayMedia 擷取一幀 → 開標註編輯器
    const h = async (e) => {
      const cardId = e.detail?.cardId;
      if (!cardId) return;
      try {
        // getDisplayMedia 需在手勢的同步呼叫堆疊內觸發——事件在點擊 handler 內同步派發，符合。
        // 直接把擷取的一幀加進該卡圖片清單（就地標註改在卡片內圖片上做，見 ImgNode 形狀工具）。
        const blob = await captureDisplayFrame();
        if (blob) await addImgToGallery(cardId, blob);
      } catch (err) {
        // 取消分享（NotAllowedError/AbortError）＝不算錯，靜默；其餘才提示
        if (err && err.name !== "NotAllowedError" && err.name !== "AbortError") {
          flash(T("a_flashShotFail", { e: String((err && err.message) || err) }));
        }
      }
    };
    window.addEventListener("hare:img-shot", h);
    return () => window.removeEventListener("hare:img-shot", h);
  }, []);
  // 剪貼簿貼圖：畫布焦點時攔 image 型剪貼內容（輸入框內不攔，讓文字貼上照常）。
  // 選取中的「空圖片卡」優先吃貼上（圖片卡流程）；否則建新圖片卡。
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const items = [...(e.clipboardData?.items || [])];
      const it = items.find((x) => x.type && x.type.startsWith("image/"));
      if (!it) return;
      e.preventDefault();
      const blob = it.getAsFile();
      const sel = nsRef.current.filter((n) => n.selected);
      if (sel.length === 1 && sel[0].type === "img") {
        // 選取中的圖片卡：空卡＝填圖；已有圖＝加入圖片清單並切換（一卡多圖）
        if (!sel[0].data?.src) setImgCardSrc(sel[0].id, blob);
        else addImgToGallery(sel[0].id, blob);
      } else {
        insertImageBlob(blob);
      }
    };
    window.addEventListener("paste", h);
    return () => window.removeEventListener("paste", h);
  }, [insertImageBlob, setImgCardSrc]);
  // ---- 特殊卡三鈕（HARE 5p3c1a1d specialCards）----
  // 節點/代理：建卡後進「指定目標」模式——點另一張卡（不可點自己）→ confirm 後綁定；
  // 圖片：建空圖片卡，選取後點卡面空白處挑檔或 Ctrl+V 貼上。位置＝畫面中央，
  // 單選一張內容卡時＝放進其子畫布（沿 卡片/子卡片 鈕慣例）。
  const [assignMode, setAssignMode] = useState(null); // { kind:"pin"|"proxy", cardId }
  const assignModeRef = useRef(null); assignModeRef.current = assignMode; // 事件監聽用（畫布直選檔案列）
  useEffect(() => {
    if (!assignMode) return;
    const h = (e) => { if (e.key === "Escape") setAssignMode(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [assignMode]);
  // 畫面中央確認卡（不用原生視窗警告）：{ text, onOk }
  // HARE c0nf1rm5 confirmCard
  const [confirmAsk, setConfirmAsk] = useState(null);
  useEffect(() => {
    if (!confirmAsk) return;
    const h = (e) => { if (e.key === "Escape") { confirmAsk.onCancel?.(); setConfirmAsk(null); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [confirmAsk]);
  // 置中確認對話框：任何元件（含 nodes.jsx）呼叫 confirmDialog(text) → 走這個置中卡片，
  // 取代瀏覽器原生 window.confirm（統一置中、不用瀏覽器彈窗）。
  useEffect(() => {
    // 三模式：confirm/alert/prompt——prompt 的值由 onOk 收
    registerConfirm((opts, resolve) => setConfirmAsk({
      ...(typeof opts === "string" ? { mode: "confirm", text: opts } : opts),
      onOk: (val) => resolve((opts.mode || "confirm") === "prompt" ? val : true),
      onCancel: () => resolve((opts.mode || "confirm") === "prompt" ? null : false),
    }));
  }, []);
  const promptInputRef = useRef(null);
  const addSpecialCard = useCallback((kind, at) => {
    snapshot();
    pushNow.current = true;
    const selected = nsRef.current.filter((x) => x.selected && x.type !== "lane");
    const parent = selected.length === 1 ? selected[0] : null;
    // 編號：只有「圖片卡」占編號——放進父卡＝繼承父編號
    // 「父號-序號」、頂層＝N 類補號（跨分頁唯一）。節點/代理是引用卡，身分跟著
    // 目標卡（顯示目標卡編號），自己不占編號。
    let num;
    if (kind === "img" || kind === "res") {
      if (parent) {
        const used = new Set();
        nsRef.current.filter((x) => x.parentId === parent.id)
          .forEach((k) => { const m = /-(\d+)$/.exec(k.data?.num || ""); if (m) used.add(parseInt(m[1], 10)); });
        let cn = 1; while (used.has(cn)) cn += 1;
        num = `${parent.data?.num || "?"}-${cn}`;
      } else {
        num = `N${nextN()}`;
      }
    }
    const id = `${kind}_${Date.now()}`;
    const spec = kind === "pin"
      ? { type: "pin", data: { label: "節點", status: "note" } }
      : kind === "res"
        ? { type: "res", data: { num, label: "資源", status: "note", listing: [] } }
        : { type: "img", data: { num, label: "圖片", status: "note", src: "", w: 320,
            gallery: [] } };
    let node;
    if (parent) { // 放進選取卡的子畫布（落點規則同卡片鈕，HARE ch11d5p0）
      const spot = childDropSpot(parent);
      node = { id, ...spec, parentId: parent.id, extent: "parent", position: spot.pos, selected: true };
      if (spot.jump) setCenter(spot.jump.x, spot.jump.y, { zoom: Math.max(getViewport().zoom || 0.9, 0.7), duration: 350 });
    } else {
      // at＝右鍵點（畫布座標）；否則視窗正中央
      const p = at || screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      node = { id, ...spec, position: { x: p.x - 110, y: p.y - 40 }, selected: true };
    }
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(node));
    if (kind === "img") {
      flash(T("a_flashImgCardCreated"));
    } else {
      setAssignMode({ kind, cardId: id }); // kind＝pin
      flash(T("a_flashPinCreated"));
    }
  }, [nextN, snapshot, setNodes, screenToFlowPosition]);

  // 新增區域（泳道）：放在現有頂層內容正下方，預設解鎖（可移動/調大小），
  // 名稱/副標/顏色在選取後的「區域屬性」框編輯。泳道永不可刪（沿 Lock 規則）。
  // HARE 3fb27e57 addLane
  const addLane = useCallback(() => {
    snapshot();
    pushNow.current = true;
    let x = -40, bottom = 0;
    nsRef.current.forEach((n) => {
      if (n.parentId) return;
      const h = n.height || n.measured?.height || n.data?.h || 0;
      if (n.position.y + h > bottom) bottom = n.position.y + h;
      if (n.type === "lane") x = Math.min(x, n.position.x);
    });
    setNodes((nds) => nds.concat({
      id: `lane_${Date.now()}`, type: "lane",
      position: { x, y: bottom + 60 },
      draggable: true, selectable: true, deletable: false,
      zIndex: -1, // 無 dragHandle＝整片可拖（跟卡片一樣）
      width: 2350, height: 800,
      data: { w: 2350, h: 800, color: "#0f9d6b", locked: false,
        title: "新區域", sub: "" },
    }));
  }, [setNodes, snapshot]);

  // 正交模式：開啟時卡片拖曳只沿水平或垂直移動——
  // 依拖曳當下的主方向（|dx| vs |dy|）鎖另一軸，多選拖曳整組同鎖。持久化 UI_LS。
  // HARE 0r7h0m0d orthoMode
  const [ortho, setOrtho] = useState(() => loadUi().ortho === true);
  const orthoRef = useRef(ortho); orthoRef.current = ortho;
  const dragStartPos = useRef(new Map()); // 本次拖曳各節點起始位置（正交鎖定基準）
  const laneCarry = useRef(new Map()); // 泳道帶卡：拖曳中要一起搬的成員卡 id → 起始位置
  const onNodeDragStart = useCallback((_, node) => {
    snapshot();
    dragStartPos.current = new Map(nsRef.current
      .filter((n) => n.selected || n.id === node?.id)
      .map((n) => [n.id, { ...n.position }]));
    // 泳道帶卡：拖曳（未鎖）泳道時，落在其範圍內、非選取的頂層卡一起搬。
    // 成員＝卡片中心落在泳道矩形內（同 fitLanes 判定）；選取卡由 React Flow 自身多選拖曳處理，不重複。
    laneCarry.current = new Map();
    const lanes = nsRef.current.filter((n) => (n.selected || n.id === node?.id) && n.type === "lane" && n.data?.locked !== true);
    if (lanes.length) {
      const tops = nsRef.current.filter((n) => !n.parentId && n.type !== "lane" && !n.selected);
      for (const ln of lanes) {
        const lx = ln.position.x, ly = ln.position.y;
        const lw = ln.measured?.width || ln.width || ln.data?.w || 500;
        const lh = ln.measured?.height || ln.height || ln.data?.h || 240;
        for (const c of tops) {
          if (laneCarry.current.has(c.id)) continue;
          const cx = c.position.x + (c.measured?.width || 200) / 2, cy = c.position.y + (c.measured?.height || 100) / 2;
          if (cx >= lx && cx <= lx + lw && cy >= ly && cy <= ly + lh) laneCarry.current.set(c.id, { ...c.position });
        }
      }
    }
  }, [snapshot]);
  // 依正交模式回傳鎖軸後的位置補丁（Map<id,{x,y}>）；未開啟回 null。
  // tempOrtho：拖曳中按住 Shift＝臨時正交——事件的
  // shiftKey 由 onNodeDrag/onNodeDragStop 傳入，放開即恢復自由拖曳，與 F3 常駐模式並存。
  const orthoPatch = useCallback((node, tempOrtho = false) => {
    if ((!orthoRef.current && !tempOrtho) || !node) return null;
    const st = dragStartPos.current.get(node.id);
    if (!st) return null;
    const dx = node.position.x - st.x, dy = node.position.y - st.y;
    const lockY = Math.abs(dx) >= Math.abs(dy); // 主方向水平→鎖 y；主方向垂直→鎖 x
    const patch = new Map();
    nsRef.current.forEach((n) => {
      const s = dragStartPos.current.get(n.id);
      if (!s) return;
      if (n.id !== node.id && !n.dragging && !n.selected) return;
      patch.set(n.id, lockY ? { x: s.x + dx, y: s.y } : { x: s.x, y: s.y + dy });
    });
    return patch;
  }, []);

  // 區域自動擴張（「不然區域根本是做好玩的」）：卡片中心落在
  // 泳道範圍內＝成員；成員超出右/下緣→泳道長大容納（只長不縮，含 24px 邊距）。
  // 掛在碰撞解算與重排之後——區域是第一個被檢討調整大小的項目。
  // HARE 1a9efa11 fitLanes
  const fitLanes = useCallback(() => {
    const all = nsRef.current;
    const lanes = all.filter((n) => n.type === "lane");
    if (!lanes.length) return;
    const tops = all.filter((n) => !n.parentId && n.type !== "lane");
    const upd = new Map();
    for (const ln of lanes) {
      const lx = ln.position.x, ly = ln.position.y;
      const lw = ln.measured?.width || ln.width || ln.data?.w || 500;
      const lh = ln.measured?.height || ln.height || ln.data?.h || 240;
      let maxR = lx + lw, maxB = ly + lh, hit = false;
      for (const c of tops) {
        const w = c.measured?.width || 200, h = c.measured?.height || 100;
        const cx = c.position.x + w / 2, cy = c.position.y + h / 2;
        if (cx < lx || cx > lx + lw || cy < ly || cy > ly + lh) continue;
        hit = true;
        maxR = Math.max(maxR, c.position.x + w + 24);
        maxB = Math.max(maxB, c.position.y + h + 24);
      }
      if (!hit) continue;
      const nw = Math.round(maxR - lx), nh = Math.round(maxB - ly);
      if (nw > lw + 1 || nh > lh + 1) upd.set(ln.id, { width: nw, height: nh });
    }
    if (upd.size) {
      pushNow.current = true;
      setNodes((nds) => nds.map((n) => {
        const u = upd.get(n.id);
        return u ? { ...n, width: u.width, height: u.height,
          data: { ...n.data, w: u.width, h: u.height } } : n;
      }));
    }
  }, [setNodes]);

  // 卡片互斥：拖曳結束時以迭代鬆弛求解器解重疊（lib/collision.mjs，
  // 物理引擎式、程式化計算、可單元測試）。被拖卡＝固定源以其為中心向外擴散連鎖；
  // 鎖定卡不可被動。只在同一父層互斥；泳道/技術範圍框是背景不參與。
  const resolveCollisions = useCallback((startId, startPos) => {
    const all = nsRef.current;
    const startNode = all.find((n) => n.id === startId);
    if (!startNode) return;
    const layer = startNode.parentId || null;
    // 約束優先、群組視為一整體：拖曳卡的約束連通成員
    // 位置由約束決定（拖曳中 onNodeDrag 已即時傳播），碰撞不得推動 → 一併固定；
    // 碰撞只推無關卡。被推開的卡若屬其他約束群組，解算後全組按約束跟隨（見下）。
    const cons = constraintsRef.current || [];
    const conFixed = new Set([startId]);
    {
      const q = [startId];
      while (q.length) {
        const cur = q.shift();
        for (const c of cons) {
          if (!Array.isArray(c.members) || !c.members.includes(cur)) continue;
          for (const m of c.members) if (!conFixed.has(m)) { conFixed.add(m); q.push(m); }
        }
      }
    }
    // 被拖卡最新位置由 dragStop 的 node 參數帶入（state 批次更新有延遲，
    // nsRef 此刻可能還是拖曳中途的位置）。
    const bodies = [];
    const orig = new Map();
    all.forEach((n) => {
      if (n.type === "lane") return;
      if ((n.parentId || null) !== layer) return;
      const p = n.id === startId && startPos ? startPos : n.position;
      orig.set(n.id, n.position);
      bodies.push({
        id: n.id, fx: conFixed.has(n.id) || n.data?.locked === true,
        x: p.x, y: p.y,
        w: n.measured?.width || n.width || 200, h: n.measured?.height || n.height || 100,
      });
    });
    // 子卡片層：子卡片之間同樣互斥，且子卡片區邊界視為固定牆——
    // 被推的子卡到左/右/上邊界即被牆反推回來，不會被擠出區域（下方由 zone 自動放大承接）。
    if (layer) {
      const p = all.find((n) => n.id === layer);
      if (!p || !p.measured?.width) return; // 父卡量測未就緒＝牆位不可信，跳過（防大批誤推）
      const top = p?.data?.childTop || 0;
      // 量測值可能短暫落後（SSE 套用後重量），以 minW 為下限，避免右牆縮到內容裡
      const pw = Math.max(p.measured.width, p.data?.minW || 0);
      bodies.push(
        { id: "__wallL", fx: true, x: -9992, y: -99000, w: 10000, h: 200000 },
        { id: "__wallR", fx: true, x: pw - 8, y: -99000, w: 10000, h: 200000 },
        { id: "__wallT", fx: true, x: -99000, y: top - 200000, w: 200000, h: 200000 },
      );
    }
    const { movedIds } = solveOverlaps(bodies, { pad: 12 });
    // 碰撞後約束跟隨：被推開的卡若屬約束群組，全組成員按約束帶動（群組不被碰撞拆散）。
    // 跟隨引入的新重疊接受為代價——約束一致性優先於零重疊（的順序語意）。
    if (cons.length) {
      const posNow = bodies.filter((b) => orig.has(b.id)).map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
      for (const mid of [...movedIds]) {
        if (!orig.has(mid)) continue;
        const follow = propagate(posNow, cons, mid);
        follow.forEach((q, fid) => {
          if (conFixed.has(fid)) return; // 拖曳群組本身不動
          const b = bodies.find((x) => x.id === fid);
          if (b) { b.x = q.x; b.y = q.y; movedIds.add(fid); }
          const pn = posNow.find((x) => x.id === fid);
          if (pn) { pn.x = q.x; pn.y = q.y; }
        });
      }
    }
    const out = new Map();
    bodies.forEach((b) => {
      if (!orig.has(b.id)) return; // 邊界牆非真實節點
      const o = orig.get(b.id);
      if (movedIds.has(b.id) && (Math.abs(b.x - o.x) > 0.5 || Math.abs(b.y - o.y) > 0.5)) out.set(b.id, { x: b.x, y: b.y });
    });
    if (out.size) setNodes((nds) => nds.map((n) => (out.has(n.id) ? { ...n, position: out.get(n.id) } : n)));
    // 區域第一個檢討：解算落定後泳道擴張容納成員（等 setNodes 提交）
    setTimeout(fitLanes, 80);
  }, [setNodes, fitLanes]);
  const onNodeDragStop = useCallback((e, node) => {
    if (!node) return;
    // 正交模式：最終位置也套軸鎖（拖曳中已逐格鎖定，這裡取鎖後座標交給碰撞解算）
    const patch = orthoPatch(node, !!e?.shiftKey);
    const pos = patch?.get(node.id) || node.position;
    resolveCollisions(node.id, pos);
    dragStartPos.current = new Map();
    laneCarry.current = new Map(); // 泳道帶卡：本次拖曳結束，清成員快取
  }, [resolveCollisions, orthoPatch]);

  // （已回退）尺寸變更自動碰撞檢討：兩度造成卡片整片下漂——
  // 量測是非同步的，SSE 套用外部變更瞬間 measured 為舊值/空值，此時解算會用
  // 錯誤的牆位（父卡量測寬）把子卡大批推走，且 zone 只增不減地放大。
  // 碰撞解算只保留在「拖曳結束」（onNodeDragStop）這一條同步、明確的路徑。
  // HARE 66b5a2d9 sizeCollision

  // 約束即時傳播：拖曳中群組成員沿約束軸跟隨（多重群組 BFS 連鎖）。
  // 正交模式先行：先把拖曳中節點鎖回主軸，再以鎖後座標做約束傳播。
  // HARE 20a55e17 onNodeDrag
  const onNodeDrag = useCallback((e, node) => {
    if (!node) return;
    const patch = orthoPatch(node, !!e?.shiftKey);
    if (patch?.size) setNodes((nds) => nds.map((n) => (patch.has(n.id) ? { ...n, position: patch.get(n.id) } : n)));
    // 泳道帶卡：成員卡依泳道拖曳位移一起搬（delta 用正交鎖後的有效位置算）
    if (laneCarry.current.size && node.type === "lane") {
      const st = dragStartPos.current.get(node.id);
      if (st) {
        const eff = patch?.get(node.id) || node.position;
        const dx = eff.x - st.x, dy = eff.y - st.y;
        setNodes((nds) => nds.map((n) => (laneCarry.current.has(n.id)
          ? { ...n, position: { x: laneCarry.current.get(n.id).x + dx, y: laneCarry.current.get(n.id).y + dy } } : n)));
      }
    }
    if (!constraintsRef.current.length) return;
    const lockPos = patch?.get(node.id) || node.position;
    const layer = node.parentId || null;
    const bodies = nsRef.current
      .filter((n) => (n.parentId || null) === layer && n.type !== "lane")
      .map((n) => ({
        id: n.id,
        x: n.id === node.id ? lockPos.x : (patch?.get(n.id)?.x ?? n.position.x),
        y: n.id === node.id ? lockPos.y : (patch?.get(n.id)?.y ?? n.position.y),
        w: n.measured?.width || 200, h: n.measured?.height || 100,
      }));
    const moved = propagate(bodies, constraintsRef.current, node.id);
    if (moved.size) setNodes((nds) => nds.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id) } : n)));
  }, [setNodes, orthoPatch]);

  // 子卡片絕對座標（相對座標沿父鏈累加；剪下/貼上與節點卡共用）
  const absPosOf = useCallback((n, all) => {
    let x = n.position.x, y = n.position.y, p = n;
    while (p.parentId) { p = all.find((z) => z.id === p.parentId); if (!p) break; x += p.position.x; y += p.position.y; }
    return { x, y };
  }, []);

  // 節點卡（兩段式）：srcId＝被引用的列選卡；建立位置＝目標卡右外側 +16、
  // 與目標卡「同層」（目標是父 A 的子卡片→節點卡也建立在 A 的
  // 子畫布，座標直接沿用目標卡的相對座標系），並建立節點卡←目標卡的連結線。
  // HARE d6023013 addPin
  const addPinBeside = useCallback((srcId, targetNode) => {
    snapshot();
    pushNow.current = true;
    const w = targetNode.measured?.width || targetNode.width || 200;
    const pinId = `pin_${Date.now()}`;
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat({
      id: pinId, type: "pin",
      position: { x: targetNode.position.x + w + 16, y: targetNode.position.y },
      ...(targetNode.parentId ? { parentId: targetNode.parentId } : {}),
      data: { refCard: srcId }, selected: true,
    }));
    setEdges((es) => es.concat({ id: `e_${pinId}`, source: targetNode.id, target: pinId,
      // 端點 id 必須是合法的 `${side}-src`/`${side}-tgt`（舊值 "r"/"l" 不存在——
      // 角色計算誤判單/雙點、線段接不上正確端點）
      sourceHandle: "r-src", targetHandle: "l-tgt", ...applyEdgeDefault() }));
  }, [setNodes, setEdges, snapshot]);

  // 重排鈕：對「選取的父卡」重排其子卡——與 analyze 同一套
  // 分層演算（layoutLayered：入口在左、barycenter 減交叉、dagre 邊通道 via 不穿卡）。
  // 內部線改 type poly＋data.via 沿通道走；按下先確認（會移動整組子卡，可 Ctrl+Z 復原）。
  // HARE 5e14y0u7 doRelayoutContainer
  // 重排流程：按鈕→跳線型選項（曲線/直線/折線/取消）→依選擇重排。
  // 排版只動卡片；內部線一律改為選定的線型（直線可略過卡壓線問題）。
  const [relayoutAsk, setRelayoutAsk] = useState(false);
  // 新增卡選擇框（主卡/子卡・節點・圖片・資源整合進「卡片」鈕）
  const [addAsk, setAddAsk] = useState(false);
  const [relayoutMode, setRelayoutMode] = useState("layered"); // 排列方式：layered｜radial
  const [relayoutTarget, setRelayoutTarget] = useState("children"); // children｜multi｜anchor
  const [relayoutChoice, setRelayoutChoice] = useState(false); // 有子卡時「排子卡/以此卡為中心」選擇
  // 框選會連容器的子卡一起選到：重排前自動剔除
  // 「祖先也在選取中」的卡，只留最上層那批——框選整個容器（含子卡）剔完剩
  // 容器一張＝自然落回「單選容器」模式（重排其子卡），行為直覺。
  const topLevelSel = () => {
    const raw = nsRef.current.filter((n) => n.selected && n.type !== "lane");
    const ids = new Set(raw.map((n) => n.id));
    const byId = new Map(nsRef.current.map((n) => [n.id, n]));
    return raw.filter((n) => {
      let p = n.parentId, g = 0;
      while (p && g++ < 40) { if (ids.has(p)) return false; p = byId.get(p)?.parentId; }
      return true;
    });
  };
  // HARE 0pen1ay0 openRelayout
  const openRelayout = useCallback(() => {
    setRelayoutChoice(false);
    const sel = topLevelSel(); // 框選含子卡＝自動排除子卡
    // 多選：≥2 張「同階層」卡片＝排列選取的那批。
    if (sel.length >= 2) {
      const pid = sel[0].parentId || null;
      if (!sel.every((n) => (n.parentId || null) === pid)) { flash(T("a_flashRelayoutSameLevel")); return; }
      setRelayoutTarget("multi"); setRelayoutAsk(true);
      return;
    }
    if (sel.length !== 1) { flash(T("a_flashRelayoutNeedParent")); return; }
    // 單選：有子卡（≥2）→ 跳提醒選「排列子卡 / 以此卡為中心」；
    // 無子卡 → 直接「以此卡為中心」錨模式。
    const kids = nsRef.current.filter((n) => n.parentId === sel[0].id && n.type !== "lane");
    if (kids.length >= 2) { setRelayoutChoice(true); return; }
    setRelayoutTarget("anchor"); setRelayoutAsk(true);
  }, []);
  // target：'children'＝重排選取卡的子卡（單選預設）｜'multi'＝多選同階層｜
  // 'anchor'＝以選取卡為中心排列其相連同階層卡
  const doRelayoutContainer = useCallback((lineType, mode = "layered", target = null) => {
    setRelayoutAsk(false);
    const sel = topLevelSel(); // 框選含子卡＝自動排除子卡（與 openRelayout 同步）
    if (!sel.length) return;
    const multi = target === "anchor" ? false : sel.length >= 2;
    const anchorMode = target === "anchor";
    let parent = null;
    let kids;
    let anchor = null;
    if (anchorMode) {
      // 錨卡中心：錨＋同階層、與錨連通的卡（BFS 沿邊）；錨不動、其餘繞錨排
      anchor = sel[0];
      const pid = anchor.parentId || null;
      const sib = new Map(nsRef.current.filter((n) => (n.parentId || null) === pid
        && n.type !== "lane").map((n) => [n.id, n]));
      const adj = new Map([...sib.keys()].map((k) => [k, []]));
      esRef.current.forEach((e) => {
        if (sib.has(e.source) && sib.has(e.target)) { adj.get(e.source).push(e.target); adj.get(e.target).push(e.source); }
      });
      const seen = new Set([anchor.id]); const q = [anchor.id];
      while (q.length) { const c = q.shift(); for (const nb of adj.get(c) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
      kids = [...seen].map((idk) => sib.get(idk));
      if (kids.length < 2) { flash(T("a_flashAnchorNoNeighbor")); return; }
      parent = pid ? nsRef.current.find((n) => n.id === pid) || null : null;
    } else if (multi) {
      const pid = sel[0].parentId || null;
      if (!sel.every((n) => (n.parentId || null) === pid)) { flash(T("a_flashRelayoutSameLevel")); return; }
      kids = sel;
      if (kids.length < 2) return;
      parent = pid ? nsRef.current.find((n) => n.id === pid) || null : null;
    } else {
      parent = sel[0];
      kids = nsRef.current.filter((n) => n.parentId === parent.id && n.type !== "lane");
      if (kids.length < 2) return;
    }
    // 三種重排都把鎖定卡留在關係圖中，但只有未鎖定且非錨卡者可移動。
    const movable = kids.filter((n) => n.data?.locked !== true && (!anchorMode || n.id !== anchor.id));
    if (!movable.length) return;
    const ids = new Set(kids.map((k) => k.id));
    const inner = esRef.current.filter((e) => ids.has(e.source) && ids.has(e.target));
    snapshot();
    pushNow.current = true;
    const items = kids.map((k) => ({ id: k.id,
      w: k.measured?.width || k.data?.minW || 240, h: k.measured?.height || 100 }));
    // 版面原點：容器模式＝子畫布左上（childTop 之下）；多選/錨模式＝選取群目前的
    // 左上角當錨（原地重排、不跳位；頂層＝絕對座標、容器內＝相對父卡座標皆成立）
    const floorY = (multi || anchorMode)
      ? Math.min(...kids.map((k) => k.position?.y || 0))
      : (parent.data?.childTop || 54) + 6;
    const originX = (multi || anchorMode) ? Math.min(...kids.map((k) => k.position?.x || 0)) : 16;
    // 聚合孫卡跨層邊：一張卡對映到它所屬的
    // 直接子卡（沿 parentId 上溯）；孫卡→別的子卡聚合成容器級邊
    // W1-3↔W1-8——否則放射佈局看不到這層關係，線繞。
    const byIdAll = new Map(nsRef.current.map((n) => [n.id, n]));
    const toKid = (nodeId) => {
      let c = byIdAll.get(nodeId), g = 0;
      while (c && g++ < 40) { if (ids.has(c.id)) return c.id; c = c.parentId ? byIdAll.get(c.parentId) : null; }
      return null;
    };
    const aggSeen = new Set();
    const innerE = [];       // 去向無關（分層/放射用）
    const innerDir = [];     // 保留方向（錨分層用：下游右、上游左）
    for (const e of esRef.current) {
      const s = toKid(e.source), t = toKid(e.target);
      if (s && t && s !== t) {
        const key = s < t ? `${s}|${t}` : `${t}|${s}`;
        if (!aggSeen.has(key)) { aggSeen.add(key); innerE.push({ source: s, target: t }); innerDir.push({ source: s, target: t }); }
      }
    }
    // 排列方式：分層＝dagre 主幹直線；放射＝中心發散；
    // 錨模式：分層＝以錨為中心雙向（下游右/上游左）；放射＝錨為 hub。
    let pos, sides;
    if (anchorMode) {
      if (mode === "radial") {
        ({ pos, sides } = layoutRadial(items, innerE, { x0: originX, y0: floorY, gap: 90, hubId: anchor.id }));
      } else {
        // 錨分層：layoutAnchor 已含通道檢討並回傳定案 sides（排的線＝畫的線）
        const r = layoutAnchor(items, innerDir, anchor.id, { colGap: 130, rowGap: 46 });
        pos = r.pos; sides = r.sides;
      }
      // 錨固定：把整組平移，讓錨落回原座標（不跳位）
      const cur = anchor.position, got = pos.get(anchor.id) || { x: 0, y: 0 };
      const dx = (cur?.x || 0) - got.x, dy = (cur?.y || 0) - got.y;
      for (const [k, p] of pos) pos.set(k, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
    } else {
      ({ pos, sides } = mode === "radial"
        ? layoutRadial(items, innerE, { x0: originX, y0: floorY, gap: 90 })
        : layoutLayered(items, innerE, { x0: originX, y0: floorY, ranksep: 110, nodesep: 56, edgesep: 50, compsep: 60 }));
    }
    // 鎖定卡是固定障礙：參與關係與端點計算，但座標永遠恢復成重排前的位置。
    const hasLocked = kids.some((n) => n.data?.locked === true);
    pos = preserveLockedPositions(pos, kids);
    if (hasLocked) sides = null; // 鎖定座標覆回後，端點側必須依實際位置重算，不能沿用排版暫態。
    let right = 0, kidsBottom = 0;
    for (const it of items) {
      const p = pos.get(it.id);
      right = Math.max(right, p.x + it.w);
      kidsBottom = Math.max(kidsBottom, p.y + it.h);
    }
    // 幾何感知端點重配：dagre 只算卡片位置、不管線接哪一側，
    // 沿用固定「右出左進」在垂直/回邊時會繞一大圈。這裡依兩卡「排完後的相對位置」
    // 挑「朝向對方那一側」的端點對——目標在右＝r→l、在下＝b→t、在左上＝l→r…
    const dim = new Map(items.map((it) => [it.id, it]));
    // 幾何感知端點二態：
    // ・對齊/緩斜（垂直偏移 ≤ 沿線邊到邊淨距）→ 對向端點＝直線/緩彎。
    // ・會扭轉（垂直偏移 > 淨距，對向端點必出 S 雙彎）→「轉角對」：一端出水平側、
    //   另一端進垂直側＝90 度進出的單 C 彎，無反曲點（1 個貝茲不要 2 個）。
    //   水平側給「度數較高」的一端——hub 左右接、衛星上下接（優先序 l>b、t>r、t>l）。
    const degIn = new Map();
    innerE.forEach((e) => {
      degIn.set(e.source, (degIn.get(e.source) || 0) + 1);
      degIn.set(e.target, (degIn.get(e.target) || 0) + 1);
    });
    const handleFor = (e) => {
      // 放射模式：layoutRadial ④② 已定案端點側（含轉角驗證＋淨空微調），直接沿用；
      // 聚合邊 innerE 可能與實際邊方向相反→反查時 src/tgt 對調。
      if (sides) {
        let k = sides.get(`${e.source}|${e.target}`);
        if (k) return { sourceHandle: `${k.ss}-src`, targetHandle: `${k.ts}-tgt` };
        k = sides.get(`${e.target}|${e.source}`);
        if (k) return { sourceHandle: `${k.ts}-src`, targetHandle: `${k.ss}-tgt` };
      }
      const sp = pos.get(e.source), tp = pos.get(e.target);
      const sd = dim.get(e.source), td = dim.get(e.target);
      if (!sp || !tp || !sd || !td) return {};
      const sc = { x: sp.x + sd.w / 2, y: sp.y + sd.h / 2 };
      const tc = { x: tp.x + td.w / 2, y: tp.y + td.h / 2 };
      const dx = tc.x - sc.x, dy = tc.y - sc.y;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      const vertical = ady >= adx;
      const perp = vertical ? adx : ady;                                        // 垂直於連線的偏移
      const along = vertical ? ady - (sd.h + td.h) / 2 : adx - (sd.w + td.w) / 2; // 沿線邊到邊淨距
      const facing = () => {
        const [ss, ts] = vertical
          ? (dy >= 0 ? ["b", "t"] : ["t", "b"])
          : (dx >= 0 ? ["r", "l"] : ["l", "r"]);
        return { sourceHandle: `${ss}-src`, targetHandle: `${ts}-tgt` };
      };
      if (perp <= Math.max(8, along)) return facing();
      // 彎位淨空驗證（應 b>t）：轉角線的彎點＝(V.x, H.y)，
      // 必須落在兩卡邊緣外（V.x 在 H 左右緣外、H.y 在 V 上下緣外），否則線會貼著/穿過
      // 卡片（如來源在容器寬度範圍內）→退回對向直連。
      const srcHoriz = (degIn.get(e.source) || 0) > (degIn.get(e.target) || 0);
      const [V, Vd, H, Hd] = srcHoriz ? [tc, td, sc, sd] : [sc, sd, tc, td];
      const elbowOK = Math.abs(V.x - H.x) > Hd.w / 2 + 12 && Math.abs(H.y - V.y) > Vd.h / 2 + 12;
      if (!elbowOK) return facing();
      return srcHoriz
        ? { sourceHandle: `${dx >= 0 ? "r" : "l"}-src`, targetHandle: `${dy >= 0 ? "t" : "b"}-tgt` }
        : { sourceHandle: `${dy >= 0 ? "b" : "t"}-src`, targetHandle: `${dx >= 0 ? "l" : "r"}-tgt` };
    };
    // 同邊進出交叉自動互換（「單邊的終點起點線交叉」）：某側同時有
    // 出線＋入線時，預設 src 在中央偏前（l/r＝上、t/b＝左，-15px）、tgt 偏後（+15px）；
    // 若「出線遠端」平均比「入線遠端」更靠後（l/r 比 y、t/b 比 x），兩線必在卡邊交叉
    // →該側記入 swapSides 對調兩點（與手動迴轉鈕同一機制，nodes.jsx 會 updateInternals）。
    const centerOf = (cid) => { const p = pos.get(cid), d = dim.get(cid); return p && d ? { x: p.x + d.w / 2, y: p.y + d.h / 2 } : null; };
    const sideUse = new Map(); // 卡 id → side → { src:[遠端中心], tgt:[遠端中心] }
    for (const e of inner) {
      const h = handleFor(e);
      if (!h.sourceHandle) continue;
      const tc = centerOf(e.target), sc = centerOf(e.source);
      if (tc) { if (!sideUse.has(e.source)) sideUse.set(e.source, {}); const u = sideUse.get(e.source); (u[h.sourceHandle[0]] ||= { src: [], tgt: [] }).src.push(tc); }
      if (sc) { if (!sideUse.has(e.target)) sideUse.set(e.target, {}); const u = sideUse.get(e.target); (u[h.targetHandle[0]] ||= { src: [], tgt: [] }).tgt.push(sc); }
    }
    const swapOf = new Map();
    for (const [nid, u] of sideUse) {
      const sw = [];
      for (const side of Object.keys(u)) {
        const { src, tgt } = u[side];
        if (!src.length || !tgt.length) continue;      // 同側同時有進出才可能交叉
        const axis = side === "l" || side === "r" ? "y" : "x";
        const avg = (arr) => arr.reduce((s, c) => s + c[axis], 0) / arr.length;
        if (avg(src) > avg(tgt)) sw.push(side);         // 出線遠端更靠後＝交叉→互換
      }
      if (sw.length) swapOf.set(nid, sw);
    }
    // 設位置＋寫入/清除 swapSides（沒交叉的側清掉，端點回預設）
    setNodes((nds) => nds.map((n) => {
      if (pos.has(n.id)) {
        if (n.data?.locked === true) return n;
        const { swapSides, ...restData } = n.data || {};
        const sw = swapOf.get(n.id);
        return { ...n, position: pos.get(n.id), data: sw ? { ...restData, swapSides: sw } : restData };
      }
      // 容器尺寸主動配合（重排完先調大小、才檢討碰撞）：
      // 寬＝minW 撐到最右子卡；高＝childZoneH 直接算到最低子卡（不等量測回寫）
      if (parent && n.id === parent.id) {
        const zoneH = Math.max(70, Math.round(kidsBottom + 16 - ((n.data?.childTop || 54) + 6)));
        return { ...n, data: { ...n.data, minW: Math.max(n.data?.minW || 0, Math.round(right + 16)),
          childZoneH: zoneH } };
      }
      return n;
    }));
    // 內部線改為選定的線型＋幾何端點；清掉演算殘留（via）與折點，回自然路由
    if (inner.length) setEdges((els) => els.map((e) => {
      if (!(ids.has(e.source) && ids.has(e.target))) return e;
      const { via, bends, ...rest } = e.data || {};
      return { ...e, type: lineType, ...handleFor(e), data: rest };
    }));
    // 端點重新量測（重排後箭頭會懸空，要手動 resize 卡片才貼回）：
    // 重排一口氣改位置＋端點側＋swapSides，React Flow 內部 handleBounds 會吃到舊 DOM
    // ——等兩個 frame（渲染定稿）後強制重量測（＝手動 resize 觸發的同一條路），
    // 邊的錨點直接貼回卡緣。
    requestAnimationFrame(() => requestAnimationFrame(() => updateInternals([...ids, ...(parent ? [parent.id] : [])])));
    // 重排後碰撞檢討（容器變大沒推開鄰卡）——等重繪量測落定
    // （450ms）以容器/選群首卡為固定源解重疊，接著泳道擴張容納（fitLanes 在解算尾端自動跑）
    // 錨模式＝錨為固定源（錨不動、鄰卡被推開）；否則容器/選群首卡
    const anchorId = anchorMode ? anchor.id : (parent ? parent.id : kids[0]?.id);
    if (anchorId) setTimeout(() => resolveCollisions(anchorId), 450);
    flash(T("a_flashRelayoutDone", { n: kids.length, mode: T(mode === "radial" ? "a_arrRadial" : "a_arrLayered") }));
  }, [setNodes, setEdges, snapshot, updateInternals, resolveCollisions]);

  // 排列功能：對多選卡片套用垂直/橫向/圓形/方陣排列（src/arrange.mjs 純函數）。
  // 只排同一父層的選取卡（跨層混排會弄壞相對座標）；鎖定卡不動。
  // HARE 45d2fe3e doArrange
  const doArrange = useCallback((mode) => {
    snapshot();
    // 泳道也可多選排列：未鎖節點（含泳道）皆可排。
    // locked 語意與全站一致＝data.locked === true 才鎖（undefined/false＝未鎖）；鎖定者排除
    //（arrange 直接設座標會繞過 draggable，真鎖定的不得被移動）。
    const sel = nsRef.current.filter((n) => n.selected && n.data?.locked !== true);
    if (sel.length < 2) return;
    const byLayer = new Map();
    sel.forEach((n) => { const k = n.parentId || ""; byLayer.set(k, (byLayer.get(k) || 0) + 1); });
    const layer = [...byLayer.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const items = sel.filter((n) => (n.parentId || "") === layer).map((n) => ({
      id: n.id, x: n.position.x, y: n.position.y,
      w: n.measured?.width || n.width || 200, h: n.measured?.height || n.height || 100,
    }));
    // 對齊基準＝「第一張選取的卡」（selOrderRef 追蹤選取順序；
    // 其餘卡片對到基準卡，不取集合平均/極值中心）
    const anchorId = selOrderRef.current.find((id) => items.some((i) => i.id === id)) || items[0]?.id;
    const pos = mode.startsWith("align:") ? align(items, mode.slice(6), anchorId)
      : mode.startsWith("con:") ? align(items, mode.slice(4), anchorId)
      : mode.startsWith("dist:") ? distribute(items, mode.slice(5))
      : arrange(items, mode);
    if (pos.size) setNodes((nds) => nds.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id) } : n)));
    // 約束＝持續性群組（只有 con:* 建立）：成員拖曳互相跟隨，可多重群組；
    // align:* 為一次性對齊，不留群組
    if (mode.startsWith("con:")) {
      const type = mode.slice(4);
      const con = { id: `con_${Date.now()}`, type, members: items.map((i) => i.id) };
      // 間格約束：記錄建立當下各成員偏移，之後維持間距跟隨（不做初始對齊）
      if (type === "gapv") con.off = Object.fromEntries(items.map((i) => [i.id, i.y]));
      if (type === "gaph") con.off = Object.fromEntries(items.map((i) => [i.id, i.x]));
      setConstraints((cs) => [...cs, con]);
    }
  }, [setNodes, snapshot]);

  // 子卡片區維護：子卡片畫布位於「標籤區」與「任務區」中間（ChildSpacer 佔位，
  // 任務區被自然推到子卡區之下、永不重疊）。此 effect 依子卡實際 bounding：
  // ① 維護 spacer 高度 childZoneH（父卡總高隨之自動調整，含長高與縮回）
  // ② 父卡寬度不足時擴 minW ③ 子卡越界（x<8 或高於子卡區上緣 childTop）拉回。
  // 值收斂後不再觸發，不與推送循環激盪。泳道/技術範圍框（lane/scope）不套用。
  useEffect(() => {
    // 拖曳中不做維護：此 effect 的 setNodes 會在拖曳中重建節點物件，
    // 打斷 React Flow 的拖曳工作階段——會造成「有子卡片的卡片拖不動」
    if (ns.some((n) => n.dragging)) return;
    const byId = new Map(ns.map((n) => [n.id, n])); // O(1) 查父卡（原 ns.find 是 O(父數×N)）
    const byParent = new Map();
    ns.forEach((n) => {
      if (!n.parentId) return;
      if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
      byParent.get(n.parentId).push(n);
    });
    const grow = new Map(); // pid → {childZoneH?, minW?}
    const unclamp = new Map(); // 越界子卡 id → floorY（拉回子卡區內；floorY 於此處定案，套用時不再查父卡）
    const unclampShift = new Map(); // 首次遷移：子卡 id → y 平移量
    byParent.forEach((kids, pid) => {
      const p = byId.get(pid);
      if (!p || p.type === "lane") return;
      const floorY = p.data?.childTop || 0; // 子卡片區上緣（ChildSpacer 量測回寫）
      let bottom = 0, right = 0;
      kids.forEach((k) => {
        const b = k.position.y + (k.measured?.height || 0); if (b > bottom) bottom = b;
        const r = Math.max(k.position.x, 8) + (k.measured?.width || 0); if (r > right) right = r;
        if (k.position.x < 0 || (floorY && k.position.y < floorY)) unclamp.set(k.id, floorY);
      });
      if (!bottom) return;
      // 首次（spacer 剛量測出 childTop、zone 高未建立）：把子卡整組平移進子卡片區
      if (floorY && p.data?.childZoneH == null) {
        const minY = Math.min(...kids.map((k) => k.position.y));
        const shift = minY - floorY;
        if (Math.abs(shift) > 4) { kids.forEach((k) => unclampShift.set(k.id, shift)); return; } // 先遷移，zone 高下一輪算
      }
      const patch = {};
      const wantZone = Math.max(48, Math.round(bottom - floorY + 6)); // 子卡區高度（隨子卡增減；底邊貼虛線）
      const wantW = Math.round(right + 16);
      // 只配合子卡片「放大」，不自動縮小——縮小交給拖曳卡片下緣把手
      if (floorY && wantZone > (p.data?.childZoneH || 0) + 12) patch.childZoneH = wantZone;
      if (wantW > (p.data?.minW || 0) + 4 && wantW > (p.measured?.width || 0)) patch.minW = wantW;
      if (Object.keys(patch).length) grow.set(pid, patch);
    });
    if (grow.size || unclamp.size || unclampShift.size) setNodes((nds) => nds.map((n) => {
      if (grow.has(n.id)) return { ...n, data: { ...n.data, ...grow.get(n.id) } };
      if (unclampShift.has(n.id)) return { ...n, position: { ...n.position, y: n.position.y - unclampShift.get(n.id) } };
      if (unclamp.has(n.id)) {
        const floorY = unclamp.get(n.id);
        return { ...n, position: { x: Math.max(n.position.x, 8), y: Math.max(n.position.y, floorY) } };
      }
      return n;
    }));
  }, [ns, setNodes]);

  // 調整大小後保持約束：涉及成員的約束群組依原類型重新對齊
  // （等重新量測一拍後套用；約束群組本身不因 resize 消失）
  // HARE 5c1de7a4 realignAfterResize
  useEffect(() => {
    const h = (e) => {
      const ids = new Set(e.detail || []);
      const groups = constraintsRef.current.filter((c) => c.members.some((m) => ids.has(m)));
      if (!groups.length) return;
      setTimeout(() => {
        setNodes((nds) => {
          let out = nds;
          for (const g of groups) {
            const items = out.filter((n) => g.members.includes(n.id)).map((n) => ({
              id: n.id, x: n.position.x, y: n.position.y,
              w: n.measured?.width || 200, h: n.measured?.height || 100,
            }));
            const pos = align(items, g.type);
            if (pos.size) out = out.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id) } : n));
          }
          return out;
        });
      }, 120);
    };
    window.addEventListener("hare:resized", h);
    return () => window.removeEventListener("hare:resized", h);
  }, [setNodes]);

  // 卡片刪除後清理約束（成員剔除、<2 人整條移除）
  useEffect(() => {
    setConstraints((cs) => {
      if (!cs.length) return cs;
      const ids = new Set(ns.map((n) => n.id));
      const pruned = pruneConstraints(cs, ids);
      const same = pruned.length === cs.length && pruned.every((c, i) => c.members.length === cs[i].members.length);
      return same ? cs : pruned;
    });
  }, [ns]);

  const flash = (msg) => {
    const el = document.getElementById("toast"); if (!el) return;
    el.textContent = msg; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1800);
  };
  // 下載 JSON 備份（改版）：先確認再下載；內容走 exportBoard 結構化匯出
  // （可讀、可放回 data/<專案>.json 還原），不再傾倒含量測瞬態的機器狀態。
  const save = useCallback(async () => {
    const count = nsRef.current.filter((n) => n.type !== "lane").length;
    if (!(await confirmDialog(T("a_confirmDownload", { project: PROJECT, count })))) return;
    const data = JSON.stringify(exportBoard(nsRef.current, esRef.current, vpRef.current,
      constraintsRef.current, boardMetaRef.current, REV.current), null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    a.download = `hare-${PROJECT}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(T("a_flashJsonDownloaded"));
  }, []);

  const [selMode, setSelMode] = useState(false); // 框選模式：左鍵拖曳＝框選多卡（平移改右鍵）
  // AutoCAD 操作手勢：
  // ① 框選方向語意：左→右＝窗選（全包才選中，藍實線）、右→左＝框選（碰到即選中，綠虛線）
  // ② 點選累加：點卡片直接加入選取（免 Ctrl/Shift）；點空白清空；Shift/Ctrl 點卡反選（內建）
  // HARE 1c5dbf60 selBoxMode
  const [selBoxMode, setSelBoxMode] = useState("partial");
  const selStartX = useRef(null);
  // HARE d6cb4b21 onSelectionStart
  const onSelectionStart = useCallback((e) => { selStartX.current = e.clientX; }, []);
  useEffect(() => {
    const mv = (e) => {
      if (selStartX.current == null) return;
      const mode = e.clientX >= selStartX.current ? "full" : "partial";
      setSelBoxMode((m) => (m === mode ? m : mode));
    };
    const up = () => { selStartX.current = null; };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
  }, []);
  // （點卡片＝一般單選；多選用 Shift/Ctrl 或框選）
  // HARE c22e23e2 showTasks
  const [showTasks, setShowTasks] = useState(() => loadUi().showTasks !== false); // 任務列表框（預設常駐顯示）
  // HARE 1d594c6c showSettings
  // 開關持久化（重載後不消失）＋尺寸持久化（原生 resize 把手）
  const [showSettings, setShowSettings] = useState(() => loadUi().showSettings === true); // 設定框
  useEffect(() => { saveUi({ showSettings }); }, [showSettings]);
  const setPanelSize = useRef(loadUi().setSize || null);
  useEffect(() => {
    if (!showSettings) return;
    const el = document.querySelector(".set-panel");
    if (!el) return;
    let t;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (el.classList.contains("collapsed")) return;
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) {
          setPanelSize.current = { w: Math.round(r.width), h: Math.round(r.height) };
          saveUi({ setSize: setPanelSize.current });
        }
      }, 300);
    });
    ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [showSettings]);
  /* ══ 右側 DOCK（參考 CorelDRAW 泊塢窗）══
     所有長駐功能框整合進同一個右側 dock，以垂直軌切頁；地圖固定在 dock 下方；
     對話框（ChatPanel）維持獨立浮動。
     為什麼是垂直軌而不是水平頁籤：水平放不下 8–10 個面板，垂直軌可以，而且
     **收起來時軌還在**——你永遠看得到系統有哪些面板。可發現性正是「無所適從」的解藥。
     dockTab＝目前顯示哪一頁；dockOpen＝內容區展開或只剩軌；dockHost＝內容區 DOM
     （各面板以 portal 送進來，見 DockSlot——外殼換掉、內容與其 state/handler 原封不動）。 */
  // HARE 4a71e6c2 right_dock
  const [dockTab, setDockTab] = useState(() => loadUi().dockTab || "read");
  const [dockOpen, setDockOpen] = useState(() => loadUi().dockOpen === true);
  const [dockHost, setDockHost] = useState(null);
  const [topHost, setTopHost] = useState(null); // 功能列＋分頁列的版面列落點
  const [botHost, setBotHost] = useState(null); // 圖例列的版面列落點
  // 軌上頁籤的順序與顯示（設定▸功能視窗可調；存 UI_LS）
  const [dockOrder, setDockOrder] = useState(() => dockOrderOf(loadUi().dockOrder));
  const [dockHidden, setDockHidden] = useState(() =>
    (Array.isArray(loadUi().dockHidden) ? loadUi().dockHidden : []).filter((k) => DOCK_KEYS.includes(k)));
  const moveDockTab = useCallback((k, dir) => setDockOrder((cur) => {
    const i = cur.indexOf(k), j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return cur;
    const next = cur.slice();
    next[i] = next[j]; next[j] = k;
    saveUi({ dockOrder: next });
    return next;
  }), []);
  const toggleDockTabShown = useCallback((k) => setDockHidden((cur) => {
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    saveUi({ dockHidden: next });
    return next;
  }), []);
  const pickDockTab = useCallback((k) => {
    setDockTab(k); setDockOpen(true); saveUi({ dockTab: k, dockOpen: true });
  }, []);
  const toggleDock = useCallback(() => setDockOpen((v) => { saveUi({ dockOpen: !v }); return !v; }), []);
  // toggleTasks／toggleArrPanel 退場：工具列鈕已移除，開關語意由 dock 頁籤承擔
  // 排列框折疊退場：進 dock 後點標題折疊只會把內容藏掉（同任務面板的坑）
  // 排列/分布框整框開關（BAR 上設定左邊的 ▤ 鈕）
  const [showArrPanel, setShowArrPanel] = useState(() => loadUi().showArrPanel !== false);
  // 圖例·狀態篩選 BAR 開關（固定下緣 BAR＋◉ 鈕開關）
  const [showLegend, setShowLegend] = useState(() => loadUi().showLegend !== false);
  const toggleLegend = () => setShowLegend((v) => { saveUi({ showLegend: !v }); return !v; });
  // 導覽地圖開關（BAR 🗺 鈕）
  const [showMiniMap, setShowMiniMap] = useState(() => loadUi().showMiniMap !== false);
  const toggleMiniMap = () => setShowMiniMap((v) => { saveUi({ showMiniMap: !v }); return !v; });
  // 浮動框點擊置頂：pointerdown 委派，重排 z-index（上限受控，
  // 不會蓋過 toast(50)/右鍵選單(60)）；React 不管理 zIndex，外部設值不被重繪洗掉。
  // raiseFloatBox 亦供 BAR 開關使用：開哪個框＝那個框浮到最上（補充指示）
  const raiseFloatBox = useCallback((box) => {
    if (!box) return;
    const others = [...document.querySelectorAll(".float-box")].filter((b) => b !== box)
      .sort((a, b) => (Number(a.style.zIndex) || 30) - (Number(b.style.zIndex) || 30));
    others.forEach((b, i) => { b.style.zIndex = String(31 + i); });
    box.style.zIndex = String(31 + others.length);
  }, []);
  const raiseByClass = useCallback((cls) => {
    setTimeout(() => raiseFloatBox(document.querySelector(`.float-box.${cls}`)), 60);
  }, [raiseFloatBox]);
  useEffect(() => {
    const h = (e) => {
      const box = e.target?.closest?.(".float-box");
      if (box) raiseFloatBox(box);
    };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [raiseFloatBox]);
  const [tlCat, setTlCat] = useState(null); // 任務列表分類頁籤：null＝全部
  // 任務列表框顯示模式：tasks＝任務列表 / cards＝卡片列表（持久化於 UI_LS）
  const [tlMode, setTlMode] = useState(() => loadUi().tlMode || "tasks");
  const switchTlMode = useCallback((m) => { setTlMode(m); saveUi({ tlMode: m }); }, []);
  // 任務封存（併入卡片/任務列表面板，不另開框）：
  // 封存＝列表面板的 archive 模式（倉庫籤）；arCard＝單卡過濾（卡片 🗄 徽章進入），null＝全部
  // HARE 51bc997c archive-in-list
  const [arCard, setArCard] = useState(null);
  useEffect(() => {
    const h = (e) => {
      setArCard(e.detail ?? null);
      setTlMode("archive"); setShowTasks(true);
      saveUi({ tlMode: "archive", showTasks: true });
    };
    window.addEventListener("hare:open-archive", h);
    return () => window.removeEventListener("hare:open-archive", h);
  }, []);
  // 還原封存任務（封存頁是唯一還原入口）
  const restoreArchived = useCallback((cardId, i) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== cardId) return n;
      const done = (n.data.doneTasks || []).slice();
      const [t] = done.splice(i, 1);
      // B19 dict 化：還原以封存時間戳當鍵（保時序）；無戳退回現在
      return { ...n, data: { ...n.data, doneTasks: done,
        tasks: addTask(n.data.tasks, doneTextOf(t), doneTimeOf(t) || undefined), memo: undefined } };
    }));
  }, [setNodes]);
  // 聚焦卡片：畫布平移置中＋選取（任務列表點擊用）。子卡片座標相對父卡→換算絕對座標。
  const focusNode = useCallback((id) => {
    const all = nsRef.current;
    const n = all.find((x) => x.id === id); if (!n) return;
    let x = n.position.x, y = n.position.y, p = n;
    while (p.parentId) { p = all.find((z) => z.id === p.parentId); if (!p) break; x += p.position.x; y += p.position.y; }
    const w = n.measured?.width || 200, h = n.measured?.height || 100;
    // 大卡涵蓋：超過畫面就縮到可整卡入鏡，最大仍 0.9
    const z = Math.max(0.2, Math.min(0.9, (window.innerWidth * 0.85) / w, (window.innerHeight * 0.8) / h));
    setCenter(x + w / 2, y + h / 2, { zoom: z, duration: 500 });
    setNodes((nds) => nds.map((m) => (!!m.selected !== (m.id === id) ? { ...m, selected: m.id === id } : m)));
  }, [setCenter, setNodes]);
  // 節點卡 👁 跳轉（nodes.jsx 以 window 事件解耦）：平移置中並選取目標卡
  useEffect(() => {
    const h = (e) => { if (e.detail) focusNode(e.detail); };
    window.addEventListener("hare:focus-card", h);
    return () => window.removeEventListener("hare:focus-card", h);
  }, [focusNode]);
  // 節點卡「重新指定」（引用卡不存在時要能重指）：
  // 重進指定目標模式，點另一張卡綁定（confirm 流程與新建 pin 共用，Esc 取消）。
  useEffect(() => {
    const h = (e) => {
      if (!e.detail) return;
      setAssignMode({ kind: "pin", cardId: e.detail });
      flash(T("a_flashPinReassign"));
    };
    window.addEventListener("hare:assign-pin", h);
    return () => window.removeEventListener("hare:assign-pin", h);
  }, []);
  // 指定目標寫入（切到目標分頁後指定＝pin 不在當前頁、setNodes
  // 靜默無效）：pin 在本頁走 setNodes（正常存檔管線）；在他頁＝改 pages 快取＋page 級
  // PUT 直寫該頁——三條指定流程（畫布點卡/檔案列/列表點選）共用，跨頁一律有效。
  // HARE a55i9np1 assignPinTarget
  const assignPinTarget = useCallback((pinId, targetId, name, file) => {
    snapshot();
    const patch = (n) => ({ ...n, data: { ...n.data, refCard: targetId, refFile: file || undefined } });
    if (nsRef.current.some((n) => n.id === pinId)) {
      pushNow.current = true;
      setNodes((nds) => nds.map((n) => (n.id === pinId ? patch(n) : n)));
    } else {
      const pg = pagesRef.current.find((p) => (p.nodes || []).some((n) => n.id === pinId));
      if (!pg) { flash(T("a_flashPinAssignFail")); return; }
      const upd = patch(pg.nodes.find((n) => n.id === pinId));
      const updatedPages = pagesRef.current.map((p) => (p.id === pg.id
        ? { ...p, nodes: p.nodes.map((n) => (n.id === pinId ? upd : n)) } : p));
      setPages(updatedPages); pagesRef.current = updatedPages;
      fetch(withProject("/api/roadmap"), { method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: pg.id, nodes: [upd], edges: [] }) })
        .catch(() => flash(T("a_flashPinAssignFail")));
    }
    flash(T("a_flashPinPointed", { name }));
    setAssignMode(null);
  }, [snapshot, setNodes, flash]);
  // 指定目標的畫布直選·檔案列：assign 模式中點資源卡的檔案列
  // ＝confirm 綁定該檔案（refCard＋refFile）；非 assign 模式不理會
  useEffect(() => {
    const h = (e) => {
      const { nodeId, file } = e.detail || {};
      const mode = assignModeRef.current;
      if (!mode || mode.kind !== "pin" || !nodeId || !file) return;
      if (nodeId === mode.cardId) return;
      const tgt = nsRef.current.find((x) => x.id === nodeId);
      const name = `${tgt?.data?.num || ""} ${tgt?.data?.label || ""}／${file}`.trim();
      setConfirmAsk({
        text: T("a_confirmAssignPin", { name }),
        onOk: () => assignPinTarget(mode.cardId, nodeId, name, file),
      });
    };
    window.addEventListener("hare:res-row-pick", h);
    return () => window.removeEventListener("hare:res-row-pick", h);
  }, [assignPinTarget]);
  const [titleEdit, setTitleEdit] = useState(false); // 標題框編輯模式
  const [bodyEdit, setBodyEdit] = useState(false); // 專案說明現地編輯
  const [bodyText, setBodyText] = useState("");
  const [bodyW, setBodyW] = useState(null); // 編輯期間鎖定標題框寬度（框寬不得跟著輸入框縮放）
  // 右鍵選單＋剪下/貼上：ctxMenu＝{sx,sy,fx,fy}（螢幕/畫布座標）；
  // cutIds＝剪下狀態卡片（透明化＋取消選取，貼上時整組移動——非複製）
  const [ctxMenu, setCtxMenu] = useState(null);
  // 右鍵選單改版：新增卡片子選項展開態＋剪貼簿圖片偵測
  const [ctxAddOpen, setCtxAddOpen] = useState(false);
  const [ctxClipImg, setCtxClipImg] = useState(null); // Blob｜null（有圖才顯示「貼上圖片」）
  useEffect(() => {
    setCtxAddOpen(false);
    setCtxClipImg(null);
    if (!ctxMenu) return;
    let dead = false;
    (async () => {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const t = (it.types || []).find((x) => x.startsWith("image/"));
          if (t) {
            const b = await it.getType(t);
            if (!dead) setCtxClipImg(b);
            return;
          }
        }
      } catch { /* 權限拒絕/不支援＝不顯示貼上圖片 */ }
    })();
    return () => { dead = true; };
  }, [ctxMenu]);
  const [cutIds, setCutIds] = useState([]);
  const cutIdsRef = useRef(cutIds); cutIdsRef.current = cutIds;
  // 複製：右鍵「複製」→ 右鍵「貼上」＝整卡（含子卡樹、內部連線）
  // 克隆一份新卡；編號依類別自動補號、子卡編號跟著新父卡改。
  // 與剪下互斥（設定其一清空另一）；可連續貼上（每次都補下一個號）。
  const [copyIds, setCopyIds] = useState([]);
  const copyIdsRef = useRef(copyIds); copyIdsRef.current = copyIds;
  // 節點卡兩段式建立：◈ 列選來源卡 → 點目標卡，在其外側建立引用節點卡
  const [pinSource, setPinSource] = useState(null);
  // 約束群組「點卡加入」模式（詳見 conListBlock 的 addCardToCon）
  const [conAdd, setConAdd] = useState(null); // 加入模式中的約束群組 id
  const [connecting, setConnecting] = useState(false); // 拉線中→顯示所有端點

  // B22 VSCode 型態借鑑（卡號 F12 全家桶＋板面健康）——全部「開啟時算」，不進渲染熱路徑。
  // HARE b22a0c01 vscode_borrow
  const [quickOpen, setQuickOpen] = useState(null);   // {q, sel}｜null：Ctrl+P 快速跳卡覆蓋框
  const qoInputRef = useRef(null);
  const [refPanel, setRefPanel] = useState(null);     // {kind:'who'|'file', ...payload, x, y}：誰引用我／同檔引用浮動面板
  const [peek, setPeek] = useState(null);             // {x,y,num,label,status,desc}｜null：pin hover 預覽浮窗
  const [reader, setReader] = useState(null);         // N6 內建閱讀器：{path,label,uuid,loading,error,data}｜null
  const [health, setHealth] = useState(null);         // {fold} | null：板面健康面板（開＝物件，關＝null）
  // B22 第三波（Timeline＋影響聚焦）：histPanel＝卡片歷史浮窗；impactFocus＝聚焦模式
  // （rows/edgeIds 只進 <style> 濾鏡，不碰 node data——量測/標記不落地、不進內容指紋）。
  const [histPanel, setHistPanel] = useState(null);   // {cardId,num,label,x,y,loading,error,data}｜null
  const [impactFocus, setImpactFocus] = useState(null); // {cardId,num,label,rows,edgeIds,count,truncated}｜null
  const impactFocusRef = useRef(null); impactFocusRef.current = impactFocus;
  const [healthDebt, setHealthDebt] = useState(null); // validate_cards 結果：{summary,total}｜'error'｜'loading'｜null
  const [healthDebtRows, setHealthDebtRows] = useState(null); // 維護債明細（按需載入）
  const [healthStruct, setHealthStruct] = useState(null); // 結構體檢快照（開啟當下算一次，不進渲染熱路徑）
  const [healthAudit, setHealthAudit] = useState(null); // B25-1 訊號對帳：null｜'loading'｜'error'｜audit_signals 結果

  // 剪下/貼上。貼上位置：有選取其他卡＝貼進其子畫布；無選取＝貼到畫布右鍵處。
  // 剪下集合保持彼此相對位置；子卡（parentId 指向剪下卡且不在集合內）隨父卡自動跟走。
  // 跨分頁（分頁 v2）：剪下/複製記住「來源分頁」——換頁貼上時內容取自
  // 來源頁快取（pages state）；複製＝克隆進本頁，剪下＝真搬移（來源頁刪除同步回伺服器）。
  // HARE e59f21c4 cutPaste
  const clipSrcPage = useRef(null); // 剪下/複製當下的來源分頁 id
  const doCut = useCallback(() => {
    const ids = nsRef.current.filter((n) => n.selected && n.type !== "lane").map((n) => n.id);
    if (!ids.length) return;
    setCutIds(ids); setCopyIds([]);
    clipSrcPage.current = activePageRef.current;
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setCtxMenu(null);
  }, [setNodes]);
  const cancelCut = useCallback(() => { setCutIds([]); setCopyIds([]); setCtxMenu(null); }, []);
  // 複製：記選取卡（保持選取與外觀，不透明化——複製不動原卡）
  const doCopy = useCallback(() => {
    const ids = nsRef.current.filter((n) => n.selected && n.type !== "lane").map((n) => n.id);
    if (!ids.length) return;
    setCopyIds(ids); setCutIds([]);
    clipSrcPage.current = activePageRef.current;
    setCtxMenu(null);
    flash(T("a_flashCopied", { n: ids.length }));
  }, []);
  // 貼上複製（克隆）：整棵子卡樹＋集合內部連線；編號依類別全板補號（同區畫布沿用
  // 全板唯一編號——num 是 MCP 溝通索引，跨畫布撞號會讓 get_card 歧義）。
  // HARE c10ne7a2 doPasteCopy
  const doPasteCopy = useCallback((fx, fy) => {
    const ids = copyIdsRef.current; if (!ids.length) return;
    const cur = nsRef.current; // 作用頁＝貼上目的地
    // 跨分頁：來源內容取自來源頁快取（pages state；離開該頁時已寫回最新）
    const sameP = !clipSrcPage.current || clipSrcPage.current === activePageRef.current;
    const srcPg = sameP ? null : pagesRef.current.find((p) => p.id === clipSrcPage.current);
    if (!sameP && !srcPg) { flash(T("a_flashNoCopySrcPage")); return; }
    const all = sameP ? cur : (srcPg.nodes || []);
    const srcEdgesArr = sameP ? esRef.current : (srcPg.edges || []);
    const inSet = new Set(ids);
    // roots＝集合中不被集合內其他卡包含者（選了父又選子→以父為準克隆整棵）
    const isNested = (n) => { let p = n; while (p && p.parentId) { if (inSet.has(p.parentId)) return true; p = all.find((z) => z.id === p.parentId); } return false; };
    const roots = ids.map((id) => all.find((n) => n.id === id)).filter((n) => n && !isNested(n));
    if (!roots.length) return;
    // 貼上目標＝作用頁目前選取的其他內容卡（貼進其子畫布）；目標在複製集子孫鏈上＝無目標
    let target = cur.find((n) => n.selected && !inSet.has(n.id) && n.type !== "lane") || null;
    if (target) {
      let p = target;
      while (p) { if (inSet.has(p.parentId)) { target = null; break; } p = cur.find((z) => z.id === p.parentId); }
    }
    snapshot();
    pushNow.current = true;
    // 類別已用號碼表（掃「全專案所有分頁」——編號跨分頁唯一），批次配號遞增
    const numScan = [...cur, ...pagesRef.current
      .filter((p) => p.id !== activePageRef.current).flatMap((p) => p.nodes || [])];
    const used = new Map(); // cat → Set<int>
    numScan.forEach((n) => {
      const m = /^([A-Za-z]+)\s*(\d+)/.exec(n.data?.num || "");
      if (!m) return;
      const cat = m[1].toUpperCase();
      if (!used.has(cat)) used.set(cat, new Set());
      used.get(cat).add(parseInt(m[2], 10));
    });
    const nextNumOf = (cat) => { const s = used.get(cat) || used.set(cat, new Set()).get(cat); let i = 1; while (s.has(i)) i += 1; s.add(i); return i; };
    // 位置：多根保持相對位置；進子畫布＝子卡區起點、貼畫布＝右鍵處
    const abs = new Map(roots.map((n) => [n.id, absPosOf(n, all)]));
    const minX = Math.min(...[...abs.values()].map((q) => q.x));
    const minY = Math.min(...[...abs.values()].map((q) => q.y));
    const baseX = target ? 12 : fx;
    const baseY = target ? (target.data?.childTop || 40) + 6 : fy;
    const kidsOf = (pid) => all.filter((n) => n.parentId === pid);
    let seq = 0;
    const newNodes = []; const idMap = new Map();
    const cloneTree = (node, newParentId, pos, rootOldNum, rootNewNum) => {
      const nid = `cp_${Date.now()}_${(seq += 1)}`;
      idMap.set(node.id, nid);
      const d = JSON.parse(JSON.stringify(node.data || {}));
      delete d.claim; // 認領是執行狀態，不隨克隆
      // 編號：根卡＝類別補號後帶入；子孫卡＝「舊根編號-」前綴換「新根編號-」
      if (d.num && rootOldNum != null && rootNewNum != null) {
        if (d.num === rootOldNum) d.num = rootNewNum;
        else if (d.num.startsWith(`${rootOldNum}-`)) d.num = `${rootNewNum}${d.num.slice(rootOldNum.length)}`;
      }
      const { id, parentId, position, selected, dragging, measured, ...rest } = node;
      newNodes.push({
        ...JSON.parse(JSON.stringify(rest)), id: nid, data: d,
        position: pos || { ...node.position },
        ...(newParentId ? { parentId: newParentId, extent: "parent" } : {}),
        selected: !newParentId, // 根克隆自動選取（貼進子畫布者不搶選取）
      });
      kidsOf(node.id).forEach((k) => cloneTree(k, nid, null, rootOldNum, rootNewNum));
    };
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
    roots.forEach((root) => {
      const m = /^([A-Za-z]+)\s*(\d+)/.exec(root.data?.num || "");
      const newNum = m ? `${m[1].toUpperCase()}${nextNumOf(m[1].toUpperCase())}` : (root.data?.num ?? null);
      const a = abs.get(root.id);
      const pos = { x: baseX + (a.x - minX), y: baseY + (a.y - minY) };
      cloneTree(root, target ? target.id : null, pos, root.data?.num ?? null, newNum);
    });
    // 集合內部連線一併克隆（兩端都在克隆映射內；來源＝複製當下那一頁）
    const copiedEdges = srcEdgesArr.filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e, i) => ({ ...JSON.parse(JSON.stringify(stripEdgeT(e))), id: `cpe_${Date.now()}_${i}`,
        source: idMap.get(e.source), target: idMap.get(e.target) }));
    setNodes((nds) => nds.concat(newNodes));
    if (copiedEdges.length) setEdges((els) => els.concat(copiedEdges));
    setCtxMenu(null);
    flash(T("a_flashPastedCopy", { n: roots.length }) + (copiedEdges.length ? T("a_flashPlusEdges", { m: copiedEdges.length }) : ""));
  }, [setNodes, setEdges, snapshot, absPosOf]);
  const doPaste = useCallback((fx, fy) => {
    const ids = cutIdsRef.current; if (!ids.length) return;
    // ---- 跨分頁剪下＝真搬移（分頁 v2）----
    // 整棵子樹（含樹內線段）搬進作用頁；一端留在原頁的線段刪除（線不可跨分頁）。
    // 順序保命：先把「本頁已含搬入卡」推上伺服器，再送來源頁刪除——反過來的話
    // SSE 拉回會在推送落地前用「兩頁都沒有這些卡」的伺服器狀態蓋掉本地（卡消失）。
    if (clipSrcPage.current && clipSrcPage.current !== activePageRef.current) {
      const srcPg = pagesRef.current.find((p) => p.id === clipSrcPage.current);
      if (!srcPg) { flash(T("a_flashNoCutSrcPage")); setCutIds([]); setCtxMenu(null); return; }
      const src = srcPg.nodes || [];
      const cur = nsRef.current;
      const cutSet = new Set(ids.filter((id) => src.some((n) => n.id === id)));
      if (!cutSet.size) { setCutIds([]); setCtxMenu(null); return; }
      const target = cur.find((n) => n.selected && n.type !== "lane") || null;
      snapshot(); // 註：跨頁搬移的來源頁刪除不在 undo 範圍（undo 只復原本頁）
      const moving = new Set(cutSet);
      let grew = true;
      while (grew) {
        grew = false;
        src.forEach((n) => { if (n.parentId && moving.has(n.parentId) && !moving.has(n.id)) { moving.add(n.id); grew = true; } });
      }
      const abs = new Map([...cutSet].map((id) => [id, absPosOf(src.find((z) => z.id === id), src)]));
      const minX = Math.min(...[...abs.values()].map((q) => q.x));
      const minY = Math.min(...[...abs.values()].map((q) => q.y));
      const baseX = target ? 12 : fx;
      const baseY = target ? (target.data?.childTop || 40) + 6 : fy;
      const movedNodes = src.filter((n) => moving.has(n.id)).map((n) => (cutSet.has(n.id)
        ? { ...n, parentId: target ? target.id : undefined, ...(target ? { extent: "parent" } : {}),
            position: { x: baseX + (abs.get(n.id).x - minX), y: baseY + (abs.get(n.id).y - minY) } }
        : { ...n })); // 子孫：相對座標不動，跟父走（來源檔序＝父先於子，直接沿用）
      const srcE = srcPg.edges || [];
      const movedEdges = srcE.filter((e) => moving.has(e.source) && moving.has(e.target));
      const dropEdges = srcE.filter((e) => moving.has(e.source) !== moving.has(e.target));
      const updatedPages = pagesRef.current.map((p) => (p.id === srcPg.id
        ? { ...p, nodes: src.filter((n) => !moving.has(n.id)),
            edges: srcE.filter((e) => !moving.has(e.source) && !moving.has(e.target)) }
        : p));
      setPages(updatedPages); pagesRef.current = updatedPages;
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(movedNodes));
      if (movedEdges.length) setEdges((els) => els.concat(movedEdges.map((e) => ({ ...e }))));
      setCutIds([]); setCtxMenu(null);
      setTimeout(async () => {
        try { const p = flushPersist(); if (p) await p; } catch { /* 推送失敗走下一輪去抖 */ }
        fetch(withProject("/api/roadmap"), { method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: srcPg.id, nodes: [], edges: [],
            removedNodeIds: [...moving], removedEdgeIds: dropEdges.map((e) => e.id) }) })
          .catch(() => flash(T("a_flashSrcPageDelFail")));
      }, 0);
      flash(T("a_flashMoved", { n: cutSet.size, name: srcPg.name }));
      return;
    }
    const all = nsRef.current;
    const cutSet = new Set(ids);
    // 貼上目標＝目前選取的其他內容卡；防循環：目標在剪下卡子孫鏈上＝視為無目標
    let target = all.find((n) => n.selected && !cutSet.has(n.id) && n.type !== "lane") || null;
    if (target) {
      let p = target;
      while (p) { if (cutSet.has(p.parentId)) { target = null; break; } p = all.find((z) => z.id === p.parentId); }
    }
    snapshot();
    const abs = new Map(ids.map((id) => [id, absPosOf(all.find((z) => z.id === id), all)]));
    const minX = Math.min(...[...abs.values()].map((q) => q.x));
    const minY = Math.min(...[...abs.values()].map((q) => q.y));
    // 進子畫布＝相對座標（子卡區上緣起）；貼畫布＝右鍵處絕對座標
    const baseX = target ? 12 : fx;
    const baseY = target ? (target.data?.childTop || 40) + 6 : fy;
    setNodes((nds) => {
      const next = nds.map((n) => (cutSet.has(n.id) ? {
        ...n,
        parentId: target ? target.id : undefined,
        position: { x: baseX + (abs.get(n.id).x - minX), y: baseY + (abs.get(n.id).y - minY) },
      } : n));
      // React Flow 規則：父節點必須排在子節點前 → 依父鏈深度穩定排序
      const byId = new Map(next.map((n) => [n.id, n]));
      const depth = (n) => { let d = 0, p = n; while (p && p.parentId && byId.has(p.parentId)) { p = byId.get(p.parentId); d++; if (d > 20) break; } return d; };
      return next.map((n, i) => ({ n, i, d: depth(n) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.n);
    });
    setCutIds([]); setCtxMenu(null);
  }, [setNodes, setEdges, snapshot, absPosOf, flushPersist]);
  // 選單開啟時：點其他處關閉；Esc＝關選單→再按取消剪下。
  // 用 pointerdown（實回報「點空白處不會關」）：React Flow 畫布在
  // pointerdown preventDefault，瀏覽器不再派發相容 mousedown——掛 mousedown 等不到事件。
  useEffect(() => {
    if (!ctxMenu && !cutIds.length && !copyIds.length && !pinSource && !conAdd) return;
    const down = (e) => {
      // 點在選單內不關（讓按鈕的 click 進得來）
      if (e.target instanceof Element && e.target.closest(".ctx-menu")) return;
      setCtxMenu(null);
    };
    const key = (e) => {
      if (e.key !== "Escape") return;
      if (ctxMenu) setCtxMenu(null);
      else if (conAdd) setConAdd(null);
      else if (pinSource) setPinSource(null);
      else if (cutIds.length) setCutIds([]);
      else if (copyIds.length) setCopyIds([]);
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key); };
  }, [ctxMenu, cutIds, copyIds, pinSource, conAdd]);
  // 子畫布框選：框選模式下，在「容器卡內部」拖曳＝畫選取框，選取該卡之下
  // 與框相交的子卡片。用 capture 攔截避免其他手勢。
  // 觸發區（從卡片內部起動的框選選不到子卡）：原本只認 child-spacer，
  // 容器其他內部空白（標題下方、說明/任務列旁、內距）都會變成拖曳容器——改成整張容器卡
  // 都可起框，只排除：標題列（保留點選/拖曳容器）、輸入與按鈕、端點、resize 把手、
  // 節點卡預覽；點在子卡上＝子卡自己的點選/拖曳（框選子卡請從空白處起拉）。
  // HARE 7b3e94d5 childMarquee
  useEffect(() => {
    if (!selMode) return;
    const onDown = (e) => {
      if (e.button !== 0) return;
      const nodeEl = e.target.closest?.(".react-flow__node");
      if (!nodeEl || !nodeEl.classList.contains("parent")) return;   // 只在容器卡內起框
      if (e.target.closest(".card-top, .note-head, .obj-head, button, input, textarea, select, [contenteditable], .h-conn, .react-flow__handle, .react-flow__resize-control, .pin-pop")) return;
      const pid = nodeEl.getAttribute("data-id");
      if (!pid) return;
      e.preventDefault(); e.stopPropagation();
      const box = document.createElement("div");
      box.className = "child-marquee";
      document.body.appendChild(box);
      const sx = e.clientX, sy = e.clientY;
      const draw = (ev) => Object.assign(box.style, {
        left: `${Math.min(sx, ev.clientX)}px`, top: `${Math.min(sy, ev.clientY)}px`,
        width: `${Math.abs(ev.clientX - sx)}px`, height: `${Math.abs(ev.clientY - sy)}px`,
      });
      draw(e);
      const up = (ev) => {
        window.removeEventListener("mousemove", draw, true); window.removeEventListener("mouseup", up, true);
        box.remove();
        const r = { x1: Math.min(sx, ev.clientX), y1: Math.min(sy, ev.clientY), x2: Math.max(sx, ev.clientX), y2: Math.max(sy, ev.clientY) };
        if (r.x2 - r.x1 < 4 && r.y2 - r.y1 < 4) return; // 太小＝視為點擊
        // 吞掉後續合成 click（修「框到的卡沒被選取」）：mouseup 選好子卡後，
        // 瀏覽器會再發 click 到容器節點→React Flow 視為點擊容器＝改選容器、清掉子卡選取。
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        // 方向語意與大畫布一致：左→右＝窗選（全包才選）、右→左＝碰到即選
        const windowSel = ev.clientX >= sx;
        const hit = new Set();
        nsRef.current.forEach((n) => {
          if (n.parentId !== pid) return;
          const el = document.querySelector(`.react-flow__node[data-id="${n.id}"]`);
          if (!el) return;
          const b = el.getBoundingClientRect();
          const ok = windowSel
            ? (b.left >= r.x1 && b.right <= r.x2 && b.top >= r.y1 && b.bottom <= r.y2)
            : (b.right >= r.x1 && b.left <= r.x2 && b.bottom >= r.y1 && b.top <= r.y2);
          if (ok) hit.add(n.id);
        });
        setNodes((nds) => nds.map((n) => (!!n.selected !== hit.has(n.id) ? { ...n, selected: hit.has(n.id) } : n)));
      };
      window.addEventListener("mousemove", draw, true); window.addEventListener("mouseup", up, true);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [selMode, setNodes]);

  // 屬性框由 React Flow 的「實際選取狀態」驅動：有選取才顯示，取消選取即消失。
  // 單選一張卡才顯示卡片屬性框（多選時不顯示，避免歧義）。
  const selectedNodes = ns.filter((n) => n.selected);
  // 約束群組清單（卡片屬性框最下方； 改互動列表）：
  // 群組名稱可點＝自動選取全部成員；右側 ＋＝把目前選取的卡加入群組、▸/▾＝折疊；
  // 展開列出成員卡名稱，各列 −＝自群組移除（少於 2 張自動整組解散）。
  // HARE 4f1c22d7 conListBlock
  const CON_LABEL = { left: T("a_conLeft"), right: T("a_conRight"), top: T("a_conTop"),
    bottom: T("a_conBottom"), hcenter: T("a_conHcenter"), vcenter: T("a_conVcenter"),
    gapv: T("a_conGapv"), gaph: T("a_conGaph") };
  const [conOpen, setConOpen] = useState({}); // 群組展開狀態（預設收合）
  // 點名稱＝選取該群組全部成員
  const selectConMembers = (members) => {
    const s = new Set(members);
    setNodes((nds) => nds.map((n) => (!!n.selected !== s.has(n.id) ? { ...n, selected: s.has(n.id) } : n)));
  };
  // ＋＝進入「點卡加入」模式（修正）：按 ＋ 後點擊畫布上的卡片即加入
  // 該群組（可連續點多張），Esc/點空白結束。間格約束每次加入以「目前位置」
  // 重定全組基準（鎖定當下視覺間距）。
  const addCardToCon = (conId, nodeId) => {
    setConstraints((cs) => cs.map((c) => {
      if (c.id !== conId || c.members.includes(nodeId)) return c;
      const members = [...c.members, nodeId];
      const next = { ...c, members };
      if (c.type === "gapv" || c.type === "gaph") {
        next.off = Object.fromEntries(members.map((id) => {
          const n = nsRef.current.find((x) => x.id === id);
          return [id, n ? (c.type === "gapv" ? n.position.y : n.position.x) : (c.off?.[id] ?? 0)];
        }));
      }
      return next;
    }));
  };
  // −＝自群組移除該卡（成員 <2 整組解散）
  const removeConMember = (conId, mid) => {
    setConstraints((cs) => cs
      .map((c) => (c.id === conId ? { ...c, members: c.members.filter((m) => m !== mid) } : c))
      .filter((c) => c.members.length >= 2));
  };
  const renderConList = (selIds) => {
    const related = constraints.filter((c) => c.members.some((m) => selIds.has(m)));
    if (!related.length) return null;
    return (
      <div className="con-list con-in-props">
        <div className="arr-zone-t">{T("a_conGroups")}</div>
        {related.map((c) => {
          const open = !!conOpen[c.id];
          return (
            <div key={c.id} className="con-group">
              <div className="con-item">
                <button className="con-name nodrag" title={T("a_conSelectTitle")}
                  onClick={() => selectConMembers(c.members)}>
                  {CON_LABEL[c.type] || c.type}{T("a_cardsParen", { n: c.members.length })}</button>
                <span className="con-acts">
                  <button className={`nodrag ${conAdd === c.id ? "on" : ""}`}
                    title={T("a_conAddTitle")}
                    onClick={() => {
                      const on = conAdd !== c.id;
                      setConAdd(on ? c.id : null);
                      if (on) flash(T("a_flashConAddMode"));
                    }}>＋</button>
                  <button className="nodrag" title={open ? T("a_collapseMembers") : T("a_expandMembers")}
                    onClick={() => setConOpen((o) => ({ ...o, [c.id]: !open }))}>{open ? "▾" : "▸"}</button>
                </span>
              </div>
              {open && (
                <div className="con-members">
                  {c.members.map((mid) => {
                    const n = ns.find((x) => x.id === mid);
                    return (
                      <div key={mid} className="con-member">
                        <span className="con-mname">{n ? `${n.data?.num || "—"} ${n.data?.label || ""}` : mid}</span>
                        <button className="nodrag" title={T("a_conRemoveCard")}
                          onClick={() => removeConMember(c.id, mid)}>−</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  const selNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const selNodeId = selNode?.id || null;
  const clearNodeSel = () => setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  // HARE 6564be7b patchNodeData
  // 屬性編輯進復原態：改前先 snapshot；同一張卡 1.2s 內的
  // 連續改動（名稱逐字輸入）併為同一筆，不灌爆 undo 疊
  const propSnapAt = useRef({ id: null, t: 0 });
  const patchNodeData = (patch) => {
    const now = Date.now();
    if (propSnapAt.current.id !== selNodeId || now - propSnapAt.current.t > 1200) snapshot();
    propSnapAt.current = { id: selNodeId, t: now };
    setNodes((nds) => nds.map((n) => (n.id === selNodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
  };

  // 資料夾選擇器（資源卡：點路徑框開啟）：伺服器列 refBase 內子資料夾逐層瀏覽
  const [dirPick, setDirPick] = useState(null); // {cur, dirs}
  const loadDirPick = useCallback(async (rel) => {
    try {
      const base = withProject("/api/list-dirs");
      const r = await fetch(`${base}${base.includes("?") ? "&" : "?"}path=${encodeURIComponent(rel || "")}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setDirPick({ cur: j.path || "", dirs: j.dirs || [] });
    } catch (e) { flash(T("a_flashDirListFail", { e: String(e && e.message || e) })); }
  }, []);
  // B15 討論串（卡片屬性框「討論」區）：新增留言優先走後端 add_comment（writer＝連線身分，
  // 防偽造），拉回顯示；/mcp 不可用（dev vite 未接）或寫入失敗→退回一般 board PUT
  // （patchNodeData 本地追加，writer＝browser），與屬性框其它編輯同一持久化路徑。
  // HARE b15c0mmt addComment
  const [commentText, setCommentText] = useState("");
  useEffect(() => { setCommentText(""); }, [selNodeId]);
  const cmtProject = PROJECT === "default" ? undefined : PROJECT;
  const addComment = async (textIn) => {
    const text = String(textIn ?? commentText).trim();
    if (!text || !selNode) return;
    // pin 歸位：留言落本尊卡（跨頁本尊只走 MCP 路徑，本地 fallback 僅同卡適用）
    const card = chatTarget?.node.data?.num || chatTarget?.node.id || selNode.data?.num || selNodeId;
    setCommentText("");
    try {
      await mcpToolCall("add_comment", { card, text, project: cmtProject });
      fetchAndApply(); // 伺服器已寫入（真實 writer 身分）→ 拉回顯示
    } catch {
      // dev 無 /mcp 或寫入被拒→本地追加，走既有 board PUT 持久化
      patchNodeData({ comments: [...(selNode.data?.comments || []),
        { writer: "browser", t: new Date().toISOString(), text }] });
    }
  };
  const delComment = async (index) => {
    if (!selNode) return;
    const card = chatTarget?.node.data?.num || chatTarget?.node.id || selNode.data?.num || selNodeId;
    try {
      await mcpToolCall("delete_comment", { card, index, project: cmtProject });
      fetchAndApply();
    } catch {
      const list = (selNode.data?.comments || []).slice();
      if (index < 0 || index >= list.length) return;
      list.splice(index, 1);
      patchNodeData({ comments: list });
    }
  };

  // （任務編輯已搬到卡片本體 Tasks 元件；屬性框任務區塊移除——W1-3）
  // 程式對應（路徑＋標籤）編輯：兩欄草稿＋編輯索引
  const [refPath, setRefPath] = useState("");
  const [refLabel, setRefLabel] = useState("");
  useEffect(() => {
    setRefPath(""); setRefLabel("");
  }, [selNodeId]);
  const selRefs = selNode?.data?.refs || [];
  // 純新增（路徑列表已移除；細部編輯/刪除交給 MCP update_card refs）
  const commitRef = () => {
    const path = refPath.trim(), label = refLabel.trim();
    if (!path && !label) return;
    patchNodeData({ refs: [...selRefs, { path, label }] });
    setRefPath(""); setRefLabel("");
  };
  // B22 補強：refs path 檔案樹補全（準則「path＝匯入路徑」UI 化）——聚焦輸入時
  // 以最後一個「/」切目錄與前綴，打 /api/list-dirs 列該層（結果按目錄快取），
  // 前綴過濾出資料夾＋檔案候選；↑↓ 選、Enter/Tab 帶入（資料夾補「/」續層）、Esc 關。
  // HARE b22fa7c0 refPathSuggest
  const [refPathFocus, setRefPathFocus] = useState(false);
  const [refSug, setRefSug] = useState(null); // {rows:[{name,dir}], sel}｜null
  const dirCacheRef = useRef(new Map()); // dir → {dirs,files}（本次開板有效；F5 重來）
  useEffect(() => {
    if (!refPathFocus) { setRefSug(null); return; }
    const raw = refPath.replace(/\\/g, "/");
    const cut = raw.lastIndexOf("/");
    const dir = cut >= 0 ? raw.slice(0, cut) : "";
    const base = (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase();
    let dead = false;
    const apply = (j) => {
      if (dead) return;
      const rows = [
        ...(j.dirs || []).map((n) => ({ name: n, dir: true })),
        ...(j.files || []).map((n) => ({ name: n, dir: false })),
      ].filter((r) => !base || r.name.toLowerCase().includes(base)).slice(0, 8);
      setRefSug(rows.length ? { rows, sel: 0 } : null);
    };
    const hit = dirCacheRef.current.get(dir);
    if (hit) { apply(hit); return () => { dead = true; }; }
    (async () => {
      try {
        const b = withProject("/api/list-dirs");
        const r = await fetch(`${b}${b.includes("?") ? "&" : "?"}path=${encodeURIComponent(dir)}`);
        if (!r.ok) throw new Error();
        const j = await r.json();
        dirCacheRef.current.set(dir, j);
        apply(j);
      } catch { if (!dead) setRefSug(null); } // 目錄不存在/離線＝無候選（不干擾輸入）
    })();
    return () => { dead = true; };
  }, [refPath, refPathFocus]);
  const applyRefSug = (row) => {
    const raw = refPath.replace(/\\/g, "/");
    const cut = raw.lastIndexOf("/");
    setRefPath((cut >= 0 ? raw.slice(0, cut + 1) : "") + row.name + (row.dir ? "/" : ""));
  };
  const setNodeColor = (c) => patchNodeData({ color: c });
  const setNodeBg = (c) => patchNodeData({ bg: c });
  // HARE c26b6084 BG_COLORS
  const BG_COLORS = ["#ffffff", "#fff6e6", "#e9f6ef", "#e8f1fb", "#fbecec", "#f1eafb"]; // 首色白＝預設

  // 編號類別：掃描全部節點的 num 前綴字母，供選擇；選類別自動補號
  // 分類膠囊＝全專案彙整（不是只掃本頁）——編號跨分頁唯一，
  // 分類與補號自然也要以全專案為範圍
  const numCats = useMemo(() => {
    const s = new Set();
    const scan = (nodes) => (nodes || []).forEach((n) => {
      const m = /^([A-Za-z]+)/.exec(n.data?.num || ""); if (m) s.add(m[1].toUpperCase());
    });
    scan(ns);
    pages.forEach((p) => { if (p.id !== activePage) scan(p.nodes); });
    return [...s].sort();
  }, [ns, pages, activePage]);
  // 補號規則：掃描該分類已用數字（全專案），回傳「最小缺號」（如缺 4 補 4），無缺號則接最大＋1
  const nextNum = (cat) => {
    const used = new Set();
    const scan = (nodes) => (nodes || []).forEach((n) => {
      if (n.id === selNodeId) return; // 排除自己
      const m = /^([A-Za-z]+)\s*(\d+)/.exec(n.data?.num || "");
      if (m && m[1].toUpperCase() === cat.toUpperCase()) used.add(parseInt(m[2], 10));
    });
    scan(ns);
    pagesRef.current.forEach((p) => { if (p.id !== activePageRef.current) scan(p.nodes); });
    let i = 1; while (used.has(i)) i += 1; return i;
  };
  const assignCat = (cat) => patchNodeData({ num: `${cat}${nextNum(cat)}` });
  const addCat = async () => {
    const v = await promptDialog(T("a_promptNewCat"));
    const cat = (v || "").trim().replace(/[^A-Za-z]/g, "").toUpperCase();
    if (cat) assignCat(cat);
  };

  // 選取順序追蹤：保留先後，取消選取者剔除、新選取者接在後面。
  // 對齊「基準」＝仍在選取中的第一張（最早被選的那張）。
  const selOrderRef = useRef([]);
  const onSelectionChange = useCallback(({ nodes: sel }) => {
    const ids = sel.map((n) => n.id);
    const idSet = new Set(ids);
    const kept = selOrderRef.current.filter((id) => idSet.has(id));
    const added = ids.filter((id) => !kept.includes(id));
    selOrderRef.current = [...kept, ...added];
  }, []);

  // 多選排列：對齊以「第一張（基準）」為準；分佈依位置頭尾等距
  // （本地 arrange(kind) 已移除：它會遮蔽 arrange.mjs 的同名匯入，
  //   使排列面板的 ⬇➡◯▦ 實際呼叫到簽名不合的舊函數。對齊/分布/排列一律走
  //   arrange.mjs 純函數（基準卡邏輯已內建於 align 的 anchorId 參數）。）
  const [descOpen, setDescOpen] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  // 狀態篩選聚焦：選取的狀態高亮、其餘卡片降透明度（純視圖 CSS class，不改資料）
  const [focusStatuses, setFocusStatuses] = useState([]);
  const toggleFocus = (k) => setFocusStatuses((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]));
  const FILTER_KEYS = ["real", "wait", "draft", "block", "plan", "note"];
  // 各狀態卡片計數
  const statusCounts = useMemo(() => {
    const c = {};
    ns.forEach((n) => { if (n.type === "lane") return; const s = n.data?.status; if (s) c[s] = (c[s] || 0) + 1; });
    return c;
  }, [ns]);
  // 專案啟動指引面板資料——就地從已載入 boardMeta.onboarding＋檢核卡
  /* L3 閱讀層側欄（卡片 UI 架構階段四）：說明全文／程式／任務／留言離開畫布。
     為什麼要離開：長文放在卡面上，卡高必然被文字長度決定，一板大小不一的方塊就是主要的
     視覺噪音——這是「畫面上無所適從」的根。留在卡上做摺疊也不行，展開仍會把版面推歪。
     代價：看說明從「一眼」變成「雙擊」兩步。
     補償在階段一：hover peek 看首行、Ctrl/⌘+K 搜內文。
     inspId＝被閱讀的卡 id（本頁 ns 解析；切頁自然失效＝面板收起）。 */
  // 「輪到你」逐張跳轉游標（階段五）：每按一次前進一張，繞回開頭
  const [turnIdx, setTurnIdx] = useState(0);
  // HARE 9f2c47b1 inspector_panel（閱讀頁：dock 的 read tab）
  const [inspId, setInspId] = useState(null);
  const [inspTab, setInspTab] = useState("read");   // read｜comments｜history（閱讀頁內的子頁籤）
  const [inspDraft, setInspDraft] = useState(null); // 說明編輯中的草稿字串｜null＝唯讀顯示
  const [inspHist, setInspHist] = useState(null);   // {loading,error,data}｜null：歷史子頁才抓
  /* dock 佔版面而非浮動（對照 FORMULA／CorelDRAW 版面）：
     · 面板是拿來「對照」的——一邊讀、一邊看圖上那張卡。會遮住卡片的浮動框從根上違背它。
     · 工程收益是置中會算對：setCenter 置中的是 React Flow 容器中心。浮動面板不改變容器
       寬度，跳卡就會落在面板底下；dock 讓容器本身變窄，focusNode／fitView／Ctrl+K
       跳卡全部天生正確，一行數學都不用加。
     窄視窗（<1100px）：軌照舊釘在右邊（可發現性不能犧牲），但展開的內容區改成覆蓋，
     不推擠畫布——否則畫布會被擠到不能用。 */
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const h = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  // dock 寬度（拖左緣單軸，240–720，持久化）
  const [dockW, setDockW] = useState(() => loadUi().dockW || 360);
  const dockWRef = useRef(dockW); dockWRef.current = dockW;
  const startDockW = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, w0 = dockWRef.current;
    const move = (ev) => setDockW(Math.max(240, Math.min(720, w0 - (ev.clientX - sx))));
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      saveUi({ dockW: dockWRef.current });
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }, []);
  // （作用頁 ns 或其他分頁 pages）派生，不加新請求。檢核卡有開放任務才回非 null。
  // HARE d7b4e9a1 onboarding_panel
  const [onbFold, setOnbFold] = useState(false); // 面板收合（不擋操作）
  // 標準浮動框規格（同其他浮動框——標題列、點標題折疊、可拖、八向調大小）
  const [onbPos, startDragOnb, setOnbPos] = usePanelPos("onbPos",
    { x: Math.max(12, window.innerWidth - 292), y: Math.max(60, window.innerHeight - 560) });
  const [onbSize, startOnbResize] = useEdgeResize("onbSize", { w: 280, h: 340 }, "onbPos", onbPos, setOnbPos);
  const onbHead = useFoldHead(null, () => setOnbFold((v) => !v));
  const onboarding = useMemo(() => {
    const ob = boardMeta?.onboarding;
    if (!ob || !ob.card) return null;
    const all = [...ns, ...pages.filter((p) => p.id !== activePage).flatMap((p) => p.nodes || [])];
    const card = all.find((n) => n.id === ob.card);
    if (!card) return null; // 檢核卡被刪＝懸空 → 不顯示
    const open = taskTexts(card.data?.tasks);
    if (!open.length) return null; // 歸零＝啟動完成 → 不顯示
    const done = Array.isArray(card.data?.doneTasks) ? card.data.doneTasks.length : 0;
    return { mode: ob.mode, num: card.data?.num || "", open, done, total: open.length + done };
  }, [boardMeta, ns, pages, activePage]);
  // （圖例的「①開發/②執行」泳道統計已依 W1-2-3 移除——CoTechne 舊板遺留）
  // HARE a8fc61ce 線段屬性框（原 edgePanelPos 已重構——改由實際選取驅動，點選線段才顯示）
  const selEdge = es.find((e) => e.selected) || null;
  const selEdgeId = selEdge?.id || null;
  const clearEdgeSel = () => setEdges((els) => els.map((e) => (e.selected ? { ...e, selected: false } : e)));
  const patchEdge = useCallback((fn) => {
    setEdges((els) => els.map((e) => (e.id === selEdgeId ? fn(e) : e)));
    // 線段屬性調整（線款/反轉…）可能改端點佈局→重量測兩端（顏色等無關調整也跑，成本低）
    const cur = esRef.current.find((e) => e.id === selEdgeId);
    if (cur) remeasureEnds(cur.source, cur.target);
  }, [setEdges, selEdgeId, remeasureEnds]);
  // HARE 9f1ef618 EDGE_COLORS
  const EDGE_COLORS = ["#9db1c9", "#0a6fb0", "#0f9d6b", "#c47d0a", "#d23b39", "#7c53d6"];
  const setEdgeColor = (c) => patchEdge((e) => ({
    ...e, style: { ...e.style, stroke: c },
    markerStart: e.markerStart ? { ...e.markerStart, color: c } : undefined,
    markerEnd: e.markerEnd ? { ...e.markerEnd, color: c } : undefined,
    labelStyle: { ...(e.labelStyle || {}), fill: c },
  }));
  const toggleMarker = (which) => patchEdge((e) => {
    const key = which === "start" ? "markerStart" : "markerEnd";
    const on = !e[key];
    // 起點箭頭要「指回起點卡」（注入語意）：SVG marker-start 的 auto 是順路徑方向，
    // 需 auto-start-reverse 反轉，否則畫成貼在起點的向前箭頭。
    const orient = which === "start" ? { orient: "auto-start-reverse" } : {};
    return { ...e, [key]: on ? { type: MarkerType.ArrowClosed, color: e.style?.stroke || "#9db1c9", ...orient } : undefined };
  });
  const setLineStyle = (kind) => patchEdge((e) => {
    const style = { ...e.style };
    if (kind === "dashed" || kind === "animated") style.strokeDasharray = "5 4";
    else delete style.strokeDasharray;
    return { ...e, style, animated: kind === "animated" };
  });
  const setEdgeLabel = (text) => patchEdge((e) => ({
    ...e, label: text || undefined,
    labelStyle: { fontSize: 11, fontFamily: "monospace", fill: e.style?.stroke || "#4a5b73", fontWeight: 700, ...(e.labelStyle || {}) },
    labelBgStyle: { fill: "rgba(255,255,255,.88)" }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
  }));
  // 線款：曲線(default bezier)／直線(straight)／折線(smoothstep)
  const setEdgeShape = (kind) => patchEdge((e) => ({
    ...e, type: kind === "straight" ? "straight" : kind === "step" ? "smoothstep" : "default",
  }));
  // 反轉方向：對調 起點↔終點（含 handle），箭頭端隨之翻到另一端
  const reverseEdge = () => patchEdge((e) => ({
    ...e, source: e.target, target: e.source,
    sourceHandle: e.targetHandle ?? null, targetHandle: e.sourceHandle ?? null,
  }));

  // 浮動框可拖曳（點空白處拖）＋位置各自持久化（不同功能框獨立）
  /* 浮動框位置/尺寸 state 已隨面板搬進右側 dock 而退場：屬性、任務列表、
     排列、板面健康、專案管理——位置由 dock 決定，不再各自記憶座標。
     仍為浮動的是設定框、對話框、程式閱讀器（閱讀器不併入 dock），
     它們的位置/尺寸 state 原封不動。 */
  const [projMgrPos, startDragProjMgr] = usePanelPos("projMgrPanel", { x: 90, y: 56 }); // 專案管理（浮動框）
  const [pmFold, setPmFold] = useState(() => loadUi().pmFold === true);
  const pmHead = useFoldHead(null, () => setPmFold((v) => { saveUi({ pmFold: !v }); return !v; }));
  const [readerPos, startDragReader, setReaderPos] = usePanelPos("readerPanel", { x: 140, y: 96 }); // N6 閱讀器浮動窗位置（記憶）
  const [readerSize, startReaderResize] = useEdgeResize("readerSize", { w: 620, h: 460 }, "readerPanel", readerPos, setReaderPos); // 八向調大小
  // 合成一框（「全部整合進屬性」）：卡片／區域（泳道）／線段／多選
  // 四種選取屬性框互斥（一次只選到一種），故共用同一個位置與拖曳狀態、同一套「屬性（子類）」
  // 外殼——選到什麼就在同一格顯示什麼，讀起來像單一屬性面板。
  const [assignPickPos, startDragAssignPick] = usePanelPos("assignPickPanel", { x: 380, y: 120 });
  const [settingsPos, startDragSettings] = usePanelPos("settingsPanel", { x: 720, y: 60 }); // 預設避開任務列表框（x380）
  // W1-6 設定 TAB：general＝原設定內容、agent＝Agent 設定頁
  //（dash 儀錶板頁已依 W1-6-2  移除；殘存持久化值退回 general）
  // 頁籤持久化：選擇即落 UI_LS
  const [settingsTab, setSettingsTabRaw] = useState(() => {
    const v = loadUi().settingsTab;
    return ["general", "style", "windows", "agent", "security"].includes(v) ? v : "general";
  });
  const setSettingsTab = useCallback((t) => { setSettingsTabRaw(t); saveUi({ settingsTab: t }); }, []);
  // HARE 7c3a1f8e theme_switch —— 主題雙選（淺色/深色；電腦版
  // 移除「跟隨系統」），偏好存 UI_LS。舊值 system／未設＝依當下系統色一次性落定，
  // 之後固定明指；套用寫 <html> 的 data-theme。
  const [theme, setThemeRaw] = useState(() => {
    const v = loadUi().theme;
    if (v === "light" || v === "dark") return v;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const setTheme = useCallback((v) => { setThemeRaw(v); saveUi({ theme: v }); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  // HARE 5e2f8a11 style_samples —— 卡片款式。cardStyle＝「板預設 appearance」，
  // 存 UI_LS 本機；per-card 覆寫存 data.appearance（款式 id），專案自訂款式存 meta.cardStyles。
  // 真卡樣式由 nodes.jsx useAppearance 經 StyleCtx 逐卡解析（不再靠 <html> data-cardstyle 全域覆寫）。
  const [cardStyle, setCardStyleRaw] = useState(() => {
    const v = loadUi().cardStyle;
    return ["classic", "compact", "outlined", "sticky", "headerband"].includes(v) ? v : "outlined";
  });
  const setCardStyle = useCallback((v) => { setCardStyleRaw(v); saveUi({ cardStyle: v }); }, []);
  // StyleCtx 值 memo：只在 meta.cardStyles 或板預設變動時翻新，避免每次 App render 讓全卡重繪。
  const styleCtxVal = useMemo(() => ({ styles: boardMeta?.cardStyles || null, def: cardStyle }), [boardMeta, cardStyle]);
  // 可選款式清單（屬性框圖庫用）：內建＋專案自訂（meta.cardStyles）。
  const styleOptions = useMemo(() => [
    ...BUILTIN_IDS.map((id) => ({ id, name: BUILTIN_STYLES[id].name, builtin: true })),
    ...Object.entries(boardMeta?.cardStyles || {}).map(([id, s]) => ({ id, name: s?.name || id, builtin: false })),
  ], [boardMeta]);
  // W1-3-8 P3 款式管理器：自訂款式存 meta.cardStyles（專案級，隨 PUT 同步、匯出）。
  const writeCardStyles = useCallback((updater) => {
    snapshot();
    setBoardMeta((m) => {
      const cur = (m && m.cardStyles) || {};
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...(m || {}), cardStyles: next };
    });
  }, [snapshot]);
  const addCardStyle = useCallback((from) => writeCardStyles((cur) => {
    const src = from ? (BUILTIN_STYLES[from] || cur[from]) : null;
    let i = 1, id; do { id = `s${i}`; i += 1; } while (cur[id] || isBuiltin(id));
    const draft = src ? { ...src, name: `${src.name} copy` } : { name: "New style", base: "classic" };
    return { ...cur, [id]: validateCardStyle(draft) };
  }), [writeCardStyles]);
  const patchCardStyle = useCallback((id, patch) => writeCardStyles((cur) => {
    if (!cur[id]) return cur;
    try {
      return { ...cur, [id]: validateCardStyle({ ...cur[id], ...patch,
        tokens: { ...(cur[id].tokens || {}), ...(patch.tokens || {}) } }) };
    } catch { return cur; }
  }), [writeCardStyles]);
  const deleteCardStyle = useCallback(async (id) => {
    const name = boardMeta?.cardStyles?.[id]?.name || id;
    const used = nsRef.current.filter((n) => n.data?.appearance === id).length;
    if (!(await confirmDialog(T("a_styleDeleteMigrate", { name, n: used })))) return;
    writeCardStyles((cur) => { const x = { ...cur }; delete x[id]; return x; });
    // 本頁引用清為板預設；他頁 dangling id 靠 effectiveAppearance 安全退回（裁定 4），不必逐頁掃
    setNodes((nds) => nds.map((n) => (n.data?.appearance === id ? { ...n, data: { ...n.data, appearance: undefined } } : n)));
  }, [boardMeta, writeCardStyles, setNodes]);
  const exportCardStyles = useCallback(async () => {
    const json = JSON.stringify(boardMeta?.cardStyles || {}, null, 2);
    try { await navigator.clipboard.writeText(json); flash(T("a_styleExport")); }
    catch { await promptDialog(T("a_styleExport"), json); }
  }, [boardMeta]);
  const importCardStyles = useCallback(async () => {
    const raw = await promptDialog(T("a_styleImportPrompt"), "");
    if (!raw) return;
    let parsed; try { parsed = JSON.parse(raw); } catch { flash(T("a_styleImported", { n: 0, d: 0 })); return; }
    const { styles, dropped } = sanitizeCardStyles(parsed);
    if (Object.keys(styles).length) writeCardStyles((cur) => ({ ...cur, ...styles }));
    flash(T("a_styleImported", { n: Object.keys(styles).length, d: dropped.length }));
  }, [writeCardStyles]);
  // （匣選單「伺服器儀錶板」直達已移除—— ；儀錶板入口＝⚙ 設定籤）
  // 屬性類框折疊：收剩標題列、點標題切換（卡/線/多選/泳道共用）
  // 屬性框折疊已退場：搬進 dock 後「收起來」＝切到別的 tab 或收軌
  // 設定框/專案管理框折疊（同指示：所有視窗點標題折疊）
  // 設定頁儲存制：各頁籤回報髒狀態＋註冊 save/cancel，
  // 頁尾一組「儲存/取消」全頁籤共用；✕ 關閉前檢查提醒
  const [paneDirty, setPaneDirty] = useState({});
  const paneOps = useRef({});
  const dirtyOf = useMemo(() => {
    const cache = {};
    return (k) => (cache[k] ||= ((v) => setPaneDirty((m) => (!!m[k] === !!v ? m : { ...m, [k]: !!v }))));
  }, []);
  const bindOf = useMemo(() => {
    const cache = {};
    return (k) => (cache[k] ||= ((ops) => { paneOps.current[k] = ops; }));
  }, []);
  const anySetDirty = Object.values(paneDirty).some(Boolean);
  const [settingsFold, setSettingsFold] = useState(() => loadUi().settingsFold === true);
  const setHead = useFoldHead(null, () => setSettingsFold((v) => { saveUi({ settingsFold: !v }); return !v; }));
  // 卡片對話面板（HARE c7a7b711 chat-wiring）：💬 綁定目前選取的卡
  // 開關持久化：
  // 沿 showTasks 慣例存 UI_LS；預設關閉（chat 屬進階面板，首用不搶畫面）
  const [showChat, setShowChat] = useState(() => loadUi().showChat === true);
  useEffect(() => { saveUi({ showChat }); }, [showChat]);
  // chat 折疊狀態上提（輸入狀態模式）：關閉或折疊＝選卡出迷你輸入列
  const [chatFold, setChatFold] = useState(() => loadUi().chatFold === true);
  const toggleChatFold = useCallback(() => {
    setChatFold((v) => { saveUi({ chatFold: !v }); return !v; });
  }, []);
  // 已刪卡對話直綁：側欄點到板上已不存在的卡＝面板直接綁該 id 讀轉錄
  // 綁定持久化：每專案各記各的對象
  // chatBind＝{ 專案id: 卡id } map，還原本專案上次的對話對象；選卡即解除覆寫
  const [chatOrphan, setChatOrphan] = useState(() => {
    const cb = loadUi().chatBind;
    return (cb && typeof cb === "object" ? cb[PROJECT] : null) || null;
  });
  const saveChatBind = useCallback((id) => {
    const cb = loadUi().chatBind;
    saveUi({ chatBind: { ...(cb && typeof cb === "object" ? cb : {}), [PROJECT]: id } });
  }, []);
  // 對話釘選（側欄釘選唯一一張卡＝對話固定，點板上卡片不再切走）；
  // 每專案各記各的，存 UI_LS。釘選時同步設覆寫與 chatBind，F5／解除釘選行為皆一致。
  const [chatPin, setChatPinRaw] = useState(() => {
    const m = loadUi().chatPin;
    return (m && typeof m === "object" ? m[PROJECT] : null) || null;
  });
  const toggleChatPin = useCallback((id) => {
    setChatPinRaw((cur) => {
      const next = cur === id ? null : id; // 唯一：釘別張＝移過去；釘同張＝解除
      const m0 = loadUi().chatPin;
      saveUi({ chatPin: { ...(m0 && typeof m0 === "object" ? m0 : {}), [PROJECT]: next } });
      if (next) { setChatOrphan(next); saveChatBind(next); }
      return next;
    });
  }, [saveChatBind]);
  // N11-3 樹狀展開：pin 卡投影深度（pinId→層數；顯示層狀態，不持久化）
  const [pinDepth, setPinDepth] = useState({});
  useEffect(() => {
    const h = (e) => {
      const { pinId, delta } = e.detail || {};
      if (!pinId) return;
      setPinDepth((m) => ({ ...m, [pinId]: Math.max(0, (m[pinId] || 0) + (delta || 0)) }));
      // ⊞ 展開＝同時選取該節點卡（投影跟隨選取：取消選取即收合，展開當下必須是選取態）
      if ((delta || 0) > 0) setNodes((nds) => nds.map((n) =>
        (n.selected !== (n.id === pinId) ? { ...n, selected: n.id === pinId } : n)));
    };
    window.addEventListener("hare:pin-tree", h);
    return () => window.removeEventListener("hare:pin-tree", h);
  }, []);
  // 投影跟隨選取：節點卡被取消選取＝投影收合
  useEffect(() => {
    setPinDepth((m) => {
      let changed = false;
      const next = { ...m };
      for (const pid of Object.keys(m)) {
        if (!m[pid]) continue;
        const n = ns.find((x) => x.id === pid);
        if (!n || !n.selected) { next[pid] = 0; changed = true; }
      }
      return changed ? next : m;
    });
  }, [ns]);
  const [chatPos, startDragChat, setChatPos] = usePanelPos("chatPanel", { x: 480, y: 120 });
  // 對話框可調大小：邊緣把手；預設 380×500（原 chat-body 380 上限＋頭尾）
  const [chatSize, startChatResize, setChatSize] = useEdgeResize("chatSize", { w: 380, h: 500 }, "chatPanel", chatPos, setChatPos);
  // 任務窗尺寸（改 CHAT 同款四邊八向把手；UI_LS tlSize 沿用）
  // 作業中側欄的卡片標籤解析（id→編號/名稱）：伺服器 listChats 已帶標籤，這裡是後備——
  // 查當前頁再掃全部分頁（修：原本只查本頁，跨頁卡全退回原始 id）
  const resolveChatCard = useCallback((id) => {
    const n = (nsRef.current || []).find((x) => x.id === id);
    if (n) return { num: n.data?.num || "", label: n.data?.label || n.data?.title || "" };
    for (const p of pagesRef.current || []) {
      const m = (p.nodes || []).find((x) => x.id === id);
      if (m) return { num: m.data?.num || "", label: m.data?.label || m.data?.title || "", pageId: p.id };
    }
    return { num: "", label: id };
  }, []);
  /* 預設版面 v2 已退場：原本要替「右欄一整排浮動框（地圖／排列／任務／屬性）」
     量測後排位。這些框全部搬進右側 dock、位置由 dock 決定，這段量測與定位就沒有對象了。
     chat 仍是浮動框，但它的預設位置沿用既有記憶值即可，不需要整排連動計算。 */
  // 點擊卡片是否自動置中縮放（👁 工具列鈕，；預設開、持久化於 UI_LS）
  const [autoZoom, setAutoZoom] = useState(() => loadUi().autoZoom !== false);
  // 效能模式：onlyRenderVisibleElements——只把可視範圍內的卡片/線段
  // 放進 DOM。auto＝卡片數 ≥150 自動開；設定框可強制開/關（持久化於 UI_LS）。
  // 初次載入仍會全量渲染一次取得量測（React Flow 對未量測節點 forceInitialRender），
  // 之後平移/縮放/拖曳只渲染可視者——大板 DOM 從數千張卡降到螢幕上那幾十張。
  const [perfMode, setPerfMode] = useState(() => loadUi().perfMode || "auto");
  const perfOn = perfMode === "on" || (perfMode === "auto" && ns.length >= 150);
  // LOD 縮放分級渲染：縮得越小、卡片畫得越簡——
  // mid（zoom<0.5）只留編號/標題列、far（zoom<0.25）只剩卡片色框（似導覽地圖）。
  // 與虛擬化互補：拉遠＝可視卡變多、虛擬化失效，改由 LOD 省繪製。實作純 CSS
  // （index.css .lod-*，visibility:hidden 保留佔位＝卡片尺寸/量測不變）；此選擇器
  // 只回傳分級字串，跨越門檻才觸發一次重繪，平移/縮放過程零 React 成本。
  // 卡片 UI 架構階段三：LOD 從「效能開關」升格為資訊架構——原本綁 perfOn
  // （≥150 卡才開），一般板永遠是全內容渲染，拉遠也還在畫說明/任務，掃視毫無幫助。
  // 現在恆常生效：遠＝地圖、中＝編號標題、近＝L1/L2 分層（見 index.css）。效能是副產品。
  const lod = useStore((s) => (s.transform[2] < 0.25 ? "far" : s.transform[2] < 0.5 ? "mid" : "near"));
  const lodCls = lod !== "near" ? `lod-${lod}` : "";

  // B6 多專案化·前端：專案切換器狀態。projects＝清單（降級時至少含目前專案）；
  // projOpen＝新專案表單展開；newProj*＝表單草稿；projErr＝錯誤/狀態訊息。
  const [projects, setProjects] = useState([{
    id: PROJECT, title: PROJECT === "default" ? T("a_defaultProject") : PROJECT, isDefault: PROJECT === "default",
  }]);
  // 專案管理頁：工具列鈕改開關，開啟列表面板
  //（名稱／對應資料夾／程式碼類型＋「＋」新增、「−」封存）
  const [projOpen, setProjOpen] = useState(false);
  const [projCreateOpen, setProjCreateOpen] = useState(false); // 面板內的新增表單折疊
  const [newProjId, setNewProjId] = useState("");
  const [newProjTitle, setNewProjTitle] = useState("");
  const [newProjTpl, setNewProjTpl] = useState("blank"); // 種子模板（空白或範本）
  const [projErr, setProjErr] = useState("");
  const refreshProjects = useCallback(() => {
    fetchProjectList().then((list) => { if (Array.isArray(list) && list.length) setProjects(list); })
      .catch(() => { /* dev 無 /mcp／無清單來源→維持降級清單 */ });
  }, []);
  // 掛載時抓一次（選單用）；面板每次開啟再刷新（拿最新 refBase/程式碼類型/卡數）
  useEffect(() => { refreshProjects(); }, [refreshProjects]);
  useEffect(() => { if (projOpen) refreshProjects(); }, [projOpen, refreshProjects]);
  const doArchiveProject = useCallback(async (id) => {
    if (!(await confirmDialog(T("a_confirmArchiveProj", { id })))) return;
    setProjErr(T("a_projArchiving"));
    try {
      await archiveProjectRemote(id);
      setProjErr("");
      if (id === PROJECT) { switchProject("default"); return; } // 封存目前專案→回預設板
      refreshProjects();
      flash(T("a_flashProjArchived", { id }));
    } catch (e) {
      setProjErr(T("a_projArchiveFail", { e: String(e && e.message || e) }));
    }
  }, [refreshProjects]);
  const doCreateProject = useCallback(async () => {
    const id = newProjId.trim();
    const title = newProjTitle.trim();
    if (!id) { setProjErr(T("a_projNeedId")); return; }
    if (!PROJECT_RE.test(id)) { setProjErr(T("a_projIdInvalid")); return; }
    if (id === "default") { setProjErr(T("a_projDefaultExists")); return; }
    setProjErr(T("a_projCreating"));
    try {
      await createProjectRemote(id, title, { template: newProjTpl });
      switchProject(id); // 建立成功＝切換到新板（整頁重載）
    } catch (e) {
      const msg = String(e && e.message || e);
      setProjErr(e && e.status === 401 ? T("a_projNeedToken")
        : /不可用|mcp/.test(msg) ? T("a_projNoChannel")
        : T("a_projCreateFail", { msg }));
    }
  }, [newProjId, newProjTitle, newProjTpl]);

  // ---- 專案分頁（v2）：分頁在專案檔內（pages state），切頁純記憶體不重載。
  // HARE 9a6e5b21 pageTabs
  const switchPage = useCallback((pid) => {
    if (!pid || pid === activePageRef.current) return;
    flushPersist(); // 本頁未推變更先送（合併寫入安全；伺服器按 body.page 落頁）
    // 本頁最新內容寫回 pages 快取（切回來/面板彙整用；伺服器真相由下次 rev 廣播刷新）
    const curId = activePageRef.current;
    const updated = pagesRef.current.map((p) => (p.id === curId
      ? { ...p, nodes: nsRef.current.map(stripNodeT), edges: esRef.current.map(stripEdgeT),
          viewport: vpRef.current, constraints: constraintsRef.current }
      : p));
    const target = updated.find((p) => p.id === pid || p.name === pid);
    if (!target) return;
    setPages(updated); pagesRef.current = updated;
    activePageRef.current = target.id; setActivePage(target.id);
    try { localStorage.setItem(`hare-page:${PROJECT}`, target.id); } catch { /* 忽略 */ }
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("page", target.id);
      window.history.replaceState(null, "", u.toString());
    } catch { /* 忽略 */ }
    // 載入目標頁：同步基準（lastSynced/serverBase）一併重建成目標頁內容——
    // 否則持久化 effect 會把「換頁」誤判成「編輯」整批重推。undo/redo 不跨頁。
    past.current = []; future.current = []; force();
    skipSave.current = true;
    const sized = withSize(target.nodes || []);
    const tEdges = target.edges || [];
    const tCons = target.constraints || [];
    lastSynced.current = fingerprint(sized, tEdges, tCons, boardMetaRef.current);
    serverBase.current = {
      nodes: new Map(sized.map((n) => [n.id, nodeCmpStr(n)])),
      edges: new Map(tEdges.map((e) => [e.id, edgeCmpStr(e)])),
      cons: JSON.stringify(tCons),
      meta: JSON.stringify(boardMetaRef.current ?? null),
    };
    setNodes(sized);
    setEdges(tEdges);
    setConstraints(tCons);
    vpRef.current = target.viewport || null;
    if (target.viewport) rfSetViewport(target.viewport); // 每分頁記住各自視角
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushPersist, setNodes, setEdges]);
  const [pageAsk, setPageAsk] = useState(false);
  // 分頁管理窗開關：宣告在點外關閉 effect 之前（TDZ）
  const [pageMgr, setPageMgr] = useState(false);
  // 臨時彈窗點外自動關（所有臨時性視窗一律點外即關）——
  // relayout-ask 系（卡片選擇/重排/新分頁）共用一個 pointerdown 委派
  useEffect(() => {
    if (!addAsk && !relayoutAsk && !pageAsk && !pageMgr && !relayoutChoice) return;
    const h = (e) => {
      if (e.target instanceof Element && e.target.closest(".relayout-wrap, .confirm-mask")) return;
      setAddAsk(false); setRelayoutAsk(false); setPageAsk(false); setPageMgr(false); setRelayoutChoice(false);
    };
    window.addEventListener("pointerdown", h, true);
    return () => window.removeEventListener("pointerdown", h, true);
  }, [addAsk, relayoutAsk, pageAsk, pageMgr, relayoutChoice]);
  // 工具列彈窗自動置頂（分頁管理被設定框壓住）：
  // 彈窗開啟期間把工具列 z 拉到 49——高於浮動框置頂上限（<50）、低於 toast(50)/右鍵(60)
  useEffect(() => {
    if (!addAsk && !relayoutAsk && !pageAsk && !pageMgr) return;
    const bar = document.querySelector(".tools-bar");
    if (!bar) return;
    const prev = bar.style.zIndex;
    bar.style.zIndex = "49";
    return () => { bar.style.zIndex = prev; };
  }, [addAsk, relayoutAsk, pageAsk, pageMgr]);
  // 分頁管理窗操作：清單＝名稱/卡片數/移除/排序
  const doPageOps = useCallback(async (ops) => {
    try {
      const r = await fetch(withProject("/api/roadmap"), { method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageOps: ops }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await fetchAndApply();
      return true;
    } catch (e) { flash(T("a_flashPageOpFail", { e: String(e && e.message || e) })); return false; }
  }, [fetchAndApply]);
  const movePage = useCallback((pid, to) => { doPageOps([{ op: "move", id: pid, to }]); }, [doPageOps]);
  // 拖曳排序（↑↓ 改拖曳桿）：把手 pointerdown 起拖，
  // 拖曳中該列跟指標位移、目標列虛線示意；放開＝pageOps move 落檔
  const startPmDrag = useCallback((e, i) => {
    e.preventDefault(); e.stopPropagation();
    const list = e.currentTarget.closest(".pm-ask");
    if (!list) return;
    const rows = [...list.querySelectorAll(".pm-row")];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const row = rows[i], startY = e.clientY;
    let target = i;
    row.classList.add("pm-dragging");
    const move = (ev) => {
      row.style.transform = `translateY(${ev.clientY - startY}px)`;
      const y = ev.clientY;
      target = y < rects[0].top ? 0
        : y > rects[rects.length - 1].bottom ? rects.length - 1
          : rects.findIndex((r) => y >= r.top && y <= r.bottom);
      if (target < 0) target = i;
      rows.forEach((r, j) => r.classList.toggle("pm-over", j === target && j !== i));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      row.classList.remove("pm-dragging"); row.style.transform = "";
      rows.forEach((r) => r.classList.remove("pm-over"));
      if (target !== i) movePage(pagesRef.current[i]?.id, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [movePage]);
  // 刪除鈕三選（提醒時新增「合併」選項）：移除／合併進他頁／取消
  const [pmDel, setPmDel] = useState(null); // {pg, n}
  const [pmMerge, setPmMerge] = useState(null); // 來源頁（待選合併目標）
  const removePage = useCallback((pg) => {
    if (pagesRef.current.length < 2) return;
    const n = pg.id === activePageRef.current
      ? nsRef.current.filter((x) => x.type !== "lane").length
      : (pg.nodes || []).filter((x) => x.type !== "lane").length;
    setPmDel({ pg, n });
  }, []);
  const doRemovePage = useCallback(async () => {
    const pg = pmDel?.pg;
    setPmDel(null);
    if (!pg) return;
    // 移除作用頁：先切去別頁（切頁會 flush 本頁，避免刪除後又被推回）
    if (pg.id === activePageRef.current) {
      const other = pagesRef.current.find((p) => p.id !== pg.id);
      if (other) switchPage(other.id);
    }
    if (await doPageOps([{ op: "remove", id: pg.id, force: true }])) {
      flash(T("a_flashPageRemoved", { name: pg.name }));
    }
  }, [pmDel, doPageOps, switchPage]);
  const doMergePage = useCallback(async (into) => {
    const pg = pmMerge;
    setPmMerge(null);
    if (!pg || !into || into.id === pg.id) return;
    // 合併作用頁：先等未推變更落地（伺服器上才是最新內容），否則 flush 晚到會把
    // 已移除頁的內容誤落第一頁（PUT 找不到頁的 fallback）
    if (pg.id === activePageRef.current) { try { await flushPersist(); } catch { /* 斷線照舊嘗試 */ } }
    if (await doPageOps([{ op: "merge", id: pg.id, into: into.id }])) {
      flash(T("a_flashPageMerged", { name: pg.name, into: into.name }));
      if (pg.id === activePageRef.current) switchPage(into.id);
    }
  }, [pmMerge, doPageOps, switchPage, flushPersist]);
  const [newPageName, setNewPageName] = useState("");
  const doCreatePage = useCallback(async () => {
    const name = newPageName.trim();
    if (!name) return;
    setPageAsk(false);
    const id = `pg${Date.now().toString(36)}`;
    try {
      const r = await fetch(withProject("/api/roadmap"), { method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageOps: [{ op: "add", id, name }] }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await fetchAndApply(); // 拉回含新頁的最新狀態（rev 已 bump）
      switchPage(id);
      flash(T("a_flashPageCreated", { name }));
    } catch (e) {
      flash(T("a_flashPageCreateFail", { e: String(e && e.message || e) }));
    }
  }, [newPageName, fetchAndApply, switchPage]);
  // 跨分頁跳卡（任務/卡片列表）：記憶體切頁＋輪詢選取置中（等 setNodes 落地）
  const focusPageCard = useCallback((pid, cardId) => {
    switchPage(pid);
    let tries = 0;
    const timer = setInterval(() => {
      const n = nsRef.current.find((x) => x.id === cardId);
      if (n) {
        clearInterval(timer);
        setNodes((nds) => nds.map((x) => (!!x.selected !== (x.id === cardId) ? { ...x, selected: x.id === cardId } : x)));
        const abs = absPosOf(n, nsRef.current);
        const w = n.measured?.width || 260, h = n.measured?.height || 120;
        // 大卡涵蓋：同 focusNode——超過畫面就縮到整卡入鏡
        const z = Math.max(0.2, Math.min(0.9, (window.innerWidth * 0.85) / w, (window.innerHeight * 0.8) / h));
        setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: z, duration: 400 });
      } else if ((tries += 1) > 20) clearInterval(timer);
    }, 150);
  }, [switchPage, setNodes, setCenter, absPosOf]);
  // 面板彙整（分頁資料共通）：其他分頁直接讀本地 pages state，零網路
  const otherPages = useMemo(
    () => pages.filter((p) => p.id !== activePage).map((p) => ({ id: p.id, page: p.name, nodes: p.nodes || [] })),
    [pages, activePage]);
  // B22：全專案跨分頁資料（作用頁用即時 ns/es，其餘讀 pages 快取）——供快速跳卡／誰引用我／板面健康
  // 就地取用。淺層 map（O(頁數)），不做重運算；重運算（搜尋/insights）一律在面板開啟時才跑。
  const boardPages = useMemo(() => pages.map((p) => (p.id === activePage
    ? { id: p.id, name: p.name, nodes: ns, edges: es }
    : { id: p.id, name: p.name, nodes: p.nodes || [], edges: p.edges || [] })),
    [pages, activePage, ns, es]);
  const boardPagesRef = useRef(boardPages); boardPagesRef.current = boardPages;
  // 按卡號跳卡（選取＋置中；跨頁自動切頁）：本頁走 focusNode，他頁走 focusPageCard。
  const jumpToNum = useCallback((num) => {
    if (!num) return false;
    const key = String(num).trim();
    for (const p of boardPagesRef.current) {
      const hit = (p.nodes || []).find((n) => (n.data?.num || "") === key || n.id === key);
      if (hit) { if (p.id === activePageRef.current) focusNode(hit.id); else focusPageCard(p.id, hit.id); return true; }
    }
    return false;
  }, [focusNode, focusPageCard]);
  // 按卡片 id 跳卡（誰引用我／同檔引用點列用）：跨頁解析頁面。
  const jumpToCardId = useCallback((cardId, pid) => {
    if (!cardId) return;
    const page = pid || boardPagesRef.current.find((p) => (p.nodes || []).some((n) => n.id === cardId))?.id;
    if (!page) return;
    if (page === activePageRef.current) focusNode(cardId); else focusPageCard(page, cardId);
  }, [focusNode, focusPageCard]);
  /* 「輪到你」清單（卡片 UI 架構階段五）：全專案跨分頁的 wait／block 卡。
     兩者都是「需要人介入才會動」的狀態——wait 在等決定、block 被擋住。跨分頁計數是刻意的：
     在等你的卡不會因為你切了頁就不存在。固定按編號排序，逐張跳才有穩定順序。 */
  // HARE 5e8a3c74 turn_bar
  const turnCards = useMemo(() => {
    const out = [];
    for (const p of boardPages) {
      for (const n of p.nodes || []) {
        if (n.type === "lane") continue;
        const s = n.data?.status;
        if (s === "wait" || s === "block") out.push({ id: n.id, pageId: p.id, num: n.data?.num || "", status: s });
      }
    }
    return out.sort((a, b) => String(a.num).localeCompare(String(b.num), undefined, { numeric: true }));
  }, [boardPages]);
  /* dock 垂直軌的頁籤清單：k＝頁鍵、ico＝軌上圖示、label＝直排標籤、
     avail＝這頁現在有沒有東西可看（沒有就 disabled，但**仍然列出來**——軌的價值是
     「看得到系統有哪些面板」，藏起來就毀了可發現性）。
     設定框依使用者指示不列入，維持獨立浮動；對話框（ChatPanel）同。 */
  const dockTabs = useMemo(() => {
    const selCards = selectedNodes.filter((n) => n.type !== "lane");
    /* 頁籤恆開：工具列不再有這些窗的開關鈕，頁籤點過去就看得到。
       仍有 avail=false 的只剩「內容取決於當下選取」的兩頁——沒選卡就是沒東西可顯示，
       以及排列（本質上需要兩張以上）。其餘一律 true，並由 dockTab 變更時自動備妥資料。 */
    const AVAIL = {
      read: !!inspId,
      props: !!(selNode || selEdge || selCards.length > 1),
      cards: true, tasks: true, archive: true,
      arrange: selCards.length >= 2,
      health: true,
    };
    return dockOrder.filter((k) => !dockHidden.includes(k)).map((k) => {
      const def = DOCK_DEFS.find((d) => d.k === k);
      return { ...def, label: T(def.lb), hintText: T(def.hint), avail: !!AVAIL[k] };
    });
  }, [dockOrder, dockHidden, selectedNodes, selNode, selEdge, inspId]);
  /* 節點卡（pin）＝引用卡，本身沒有說明/任務/留言——點它要帶出「本尊」那張的資訊
     （與 chatTarget 一致：對話也是連回本尊）。
     refCard 可能是 id 或編號，先查本頁再查其他分頁；查不到就退回引用卡自己。 */
  // HARE 5eae08cc PinNode（本尊解析）
  const inspTargetOf = useCallback((node) => {
    if (!node) return null;
    if (node.type !== "pin") return node.id;
    const key = node.data?.refCard;
    if (!key) return node.id;
    const hit = (nsRef.current || []).find((x) => x.id === key || x.data?.num === key);
    if (hit) return hit.id;
    for (const pg of boardPagesRef.current || []) {
      const m = (pg.nodes || []).find((x) => x.id === key || x.data?.num === key);
      if (m) return m.id;
    }
    return node.id;
  }, []);
  // 目前這一頁有沒有東西可顯示（沒有就在內容區給一句說明，而不是留一片空白）
  const dockActive = dockTabs.find((t) => t.k === dockTab) || null;
  /* 切到某頁＝自動把該頁的資料備妥：工具列的開關鈕移除後，這些窗的
     「開啟」語意就由頁籤本身承擔——點過去就該看得到東西，不必再有另一個地方去打開它。
     卡片／任務／倉庫三頁共用同一個面板，差別只在 mode，所以順手把 mode 對齊頁籤。 */
  useEffect(() => {
    if (["cards", "tasks", "archive"].includes(dockTab)) {
      if (!showTasks) setShowTasks(true);
      if (tlMode !== dockTab) switchTlMode(dockTab);
    }
    if (dockTab === "arrange" && !showArrPanel) setShowArrPanel(true);
    if (dockTab === "health" && !health) openHealth();
  }, [dockTab]); // eslint-disable-line react-hooks/exhaustive-deps
  // B22 快速跳卡（Ctrl+P）：蓋掉瀏覽器列印；再按或 Esc 關。輸入框內也攔（quick_open 是全域導航）。
  // 階段一：擴成全板搜尋後加開 Ctrl/⌘+K 別名——搜尋的通用手勢，不必記 P。
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[pk]$/i.test(e.key)) {
        e.preventDefault();
        setQuickOpen((v) => (v ? null : { q: "", sel: 0 }));
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  useEffect(() => { if (quickOpen) setTimeout(() => qoInputRef.current?.focus(), 20); }, [quickOpen]);
  // B22 pin hover 預覽（peek_preview）：nodes.jsx 以 window 事件解耦；延遲出現由 PinNode 端計時。
  useEffect(() => {
    const h = (e) => setPeek(e.detail?.hide ? null : (e.detail || null));
    window.addEventListener("hare:peek", h);
    return () => window.removeEventListener("hare:peek", h);
  }, []);
  // N6 內建閱讀器：nodes.jsx 函數級標籤點擊發 hare:open-reader → 抓錨點片段渲染浮動窗。
  const openReader = useCallback(async (detail) => {
    const path = detail?.path || "";
    const q = detail?.uuid ? `HARE ${detail.uuid}` : (detail?.label || "");
    if (!path) return;
    setReader({ path, label: detail?.label, uuid: detail?.uuid, loading: true, error: null, data: null });
    try {
      const base = withProject("/api/read-file");
      const url = `${base}${base.includes("?") ? "&" : "?"}path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      const text = await r.text();
      // 空 body／非 JSON＝端點不存在（伺服器未重啟）——給明確訊息，不吐 'Unexpected end of JSON input'
      let j;
      try { j = text ? JSON.parse(text) : {}; }
      catch { throw new Error(T("cr_noEndpoint", { status: r.status })); }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setReader((cur) => (cur && cur.path === path ? { ...cur, loading: false, data: j } : cur));
    } catch (e) {
      setReader((cur) => (cur ? { ...cur, loading: false, error: String((e && e.message) || e) } : cur));
    }
  }, []);
  useEffect(() => {
    const h = (e) => openReader(e.detail || {});
    window.addEventListener("hare:open-reader", h);
    return () => window.removeEventListener("hare:open-reader", h);
  }, [openReader]);
  // B21 Phase 2：閱讀器「VSCode 開啟」——vscode://file/<abs>:<line>（錨點行優先，
  // 無錨點＝片段起始行）。協定交由系統的 VSCode handler 接手；未裝 VSCode＝無反應。
  // HARE b21a4c02 readerVscode
  const readerVscode = useCallback(() => {
    const d = reader?.data;
    if (!d?.abs) return;
    window.location.href = `vscode://file/${d.abs}:${d.anchor || d.start || 1}`;
  }, [reader]);
  // 閱讀器「其他開啟」：以系統預設程式開啟（POST /api/open-path）。
  const readerSystem = useCallback(async () => {
    if (!reader?.path) return;
    try {
      const base = withProject("/api/open-path");
      const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: reader.path }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
    } catch (e) { flash(String((e && e.message) || e)); }
  }, [reader]);
  // B22 誰引用我／同檔引用面板：點面板外或按 Esc 關閉（臨時性浮框慣例）。
  useEffect(() => {
    if (!refPanel) return;
    const down = (e) => { if (!(e.target instanceof Element && e.target.closest(".ref-pop"))) setRefPanel(null); };
    const key = (e) => { if (e.key === "Escape") setRefPanel(null); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key); };
  }, [refPanel]);
  // B22 維護債（validate_cards）：面板開啟時打本站 /mcp；失敗（401/離線等）→ 標 error 顯示「需伺服器連線」。
  const callMcp = useCallback(async (name, args) => {
    const r = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call",
        params: { name, arguments: { ...(PROJECT === "default" ? {} : { project: PROJECT }), ...args } } }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "mcp error");
    const txt = j.result?.content?.[0]?.text;
    return txt ? JSON.parse(txt) : null;
  }, []);
  const loadHealthDebt = useCallback(async () => {
    setHealthDebt("loading");
    try { const out = await callMcp("validate_cards", { summary: true }); setHealthDebt(out || { total: 0, summary: {} }); }
    catch { setHealthDebt("error"); }
  }, [callMcp]);
  const loadHealthDebtRows = useCallback(async () => {
    setHealthDebtRows("loading");
    try { const out = await callMcp("validate_cards", { limit: 50 }); setHealthDebtRows(out?.problems || []); }
    catch { setHealthDebtRows("error"); }
  }, [callMcp]);
  // B25-1 訊號對帳（audit_signals）：宣稱 vs 事實矛盾——認領逾時無產出＋real 卡 refs 其後被改。
  // 只浮出不改狀態；面板開啟時拉一次（同維護債慣例）。
  // HARE b25a0d17 loadHealthAudit
  const loadHealthAudit = useCallback(async () => {
    setHealthAudit("loading");
    try { setHealthAudit((await callMcp("audit_signals", {})) || { count: 0, mismatches: [] }); }
    catch { setHealthAudit("error"); }
  }, [callMcp]);
  // 結構體檢（開啟當下算一次）：逐頁跑 insights（純函式），把 markdown 拆成「頁→區段→列」。
  // 卡號用「全專案 num 集」驗證後才可點（避免把待裁定行首的 P{priority} 誤當卡號）——通用不寫死格式。
  const computeHealthStruct = useCallback(() => {
    const pgs = boardPagesRef.current;
    const numSet = new Set(); const knownIds = new Set();
    for (const p of pgs) for (const n of p.nodes || []) { if (n.data?.num) numSet.add(n.data.num); knownIds.add(n.id); }
    const NUM_RE = /[A-Za-z]+\d[A-Za-z0-9-]*/g;
    const firstValidNum = (line) => { for (const m of line.match(NUM_RE) || []) if (numSet.has(m)) return m; return null; };
    const PROBLEM_KEYS = ["orphans", "noEvidence", "inverted", "lowConfidence", "danglingPins", "cohesion", "questions"];
    const pageOut = []; let total = 0;
    for (const p of pgs) {
      let res; try { res = insights({ name: p.name, nodes: p.nodes, edges: p.edges }, { knownIds }); } catch { res = null; }
      if (!res) continue;
      total += PROBLEM_KEYS.reduce((s, k) => s + (res.stats?.[k] || 0), 0);
      const sections = []; let cur = null;
      for (const raw of (res.text || "").split("\n")) {
        if (raw.startsWith("### ")) { cur = { title: raw.slice(4), rows: [] }; sections.push(cur); }
        else if (raw.startsWith("- ") && cur) cur.rows.push({ text: raw.slice(2), num: firstValidNum(raw) });
      }
      pageOut.push({ pageId: p.id, pageName: p.name, sections });
    }
    return { pages: pageOut, total };
  }, []);
  // 標準浮動框規格（指示補齊健康面板）：
  // 可拖（usePanelPos）＋八向調大小（useEdgeResize）＋點標題折疊（useFoldHead）＋位置/尺寸持久化。
  // 健康面板已搬進 dock：位置由 dock 決定，折疊由 tab 切換取代
  // 開板面健康＝當下計算：結構體檢就地跑一次 insights；維護債觸發一次 /mcp 拉取。
  const openHealth = useCallback(() => {
    if (health) { setHealth(null); setHealthStruct(null); return; }
    setHealth({ fold: false }); setHealthDebtRows(null);
    setHealthStruct(computeHealthStruct()); loadHealthDebt(); loadHealthAudit();
    pickDockTab("health");
  }, [health, computeHealthStruct, loadHealthDebt, loadHealthAudit, raiseByClass]);
  // B22 第三波 ── 卡片歷史（Timeline）：右鍵開浮窗，打 /mcp card_history 列
  // 「誰改的、何時、哪種變更」；失敗＝需伺服器連線（同維護債慣例）。
  // HARE b22ca4d1 openHistory（後端同錨：lib/tools.mjs card_history）
  const openHistory = useCallback(async (card, at) => {
    setHistPanel({ ...card, x: at.x, y: at.y, loading: true, error: false, data: null });
    try {
      const out = await callMcp("card_history", { card: card.cardId });
      setHistPanel((cur) => (cur && cur.cardId === card.cardId ? { ...cur, loading: false, data: out } : cur));
    } catch {
      setHistPanel((cur) => (cur && cur.cardId === card.cardId ? { ...cur, loading: false, error: true } : cur));
    }
  }, [callMcp]);
  /* L3 側欄「歷史」頁籤：切到該頁籤才打 card_history——沒人看就不發請求。
     換卡先清舊資料，免得看到上一張卡的歷史（inspHist 進 deps＋非空即返，不會迴圈）。 */
  useEffect(() => { setInspHist(null); }, [inspId]);
  useEffect(() => {
    if (!inspId || inspTab !== "history" || inspHist) return;
    let live = true;
    setInspHist({ loading: true });
    callMcp("card_history", { card: inspId })
      .then((out) => { if (live) setInspHist({ data: out }); })
      .catch(() => { if (live) setInspHist({ error: true }); });
    return () => { live = false; };
  }, [inspId, inspTab, inspHist, callMcp]);
  useEffect(() => { // 浮窗慣例：點外面或 Esc 關（同 ref-pop）
    if (!histPanel) return;
    const down = (e) => { if (!(e.target instanceof Element && e.target.closest(".hist-pop"))) setHistPanel(null); };
    const key = (e) => { if (e.key === "Escape") setHistPanel(null); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key); };
  }, [histPanel]);
  // B22 第三波 ── 影響聚焦：impact() 就地算本頁下游波及（四種 relation 全開、分數帶衰減），
  // 結果只生成 <style> 濾鏡選擇器（node data 零改動）；同卡再點＝退出，Esc／切頁也退出。
  // HARE b22f0c05 impactFocus
  const startImpactFocus = useCallback((cardId) => {
    if (impactFocusRef.current?.cardId === cardId) { setImpactFocus(null); return; }
    const nodes = nsRef.current, edges = esRef.current;
    let out;
    try {
      out = impact({ nodes, edges }, cardId,
        { relations: ["prerequisite", "validates", "imports", "reference"], detail: true, maxCards: 500 });
    } catch { flash(T("if_noDag")); return; } // 說明卡（status=note）不入工作圖
    // detail 列以 num 表示（無 num 卡＝id），映回本頁 node id 供選擇器使用
    const byNum = new Map(nodes.map((n) => [n.data?.num || n.id, n.id]));
    const rows = (out.downstream || []).map((r) => ({ id: byNum.get(r.num), score: r.score }))
      .filter((r) => r.id);
    if (!rows.length) { flash(T("if_none")); return; }
    const idSet = new Set([cardId, ...rows.map((r) => r.id)]);
    const edgeIds = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target)).map((e) => e.id);
    const src = nodes.find((n) => n.id === cardId);
    setImpactFocus({ cardId, num: src?.data?.num || "", label: src?.data?.label || src?.data?.title || "",
      rows, edgeIds, count: rows.length, truncated: !!out.truncated });
  }, []);
  useEffect(() => {
    if (!impactFocus) return;
    const key = (e) => { if (e.key === "Escape") setImpactFocus(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [impactFocus]);
  useEffect(() => { setImpactFocus(null); setHistPanel(null); }, [activePage]); // 切頁＝離開聚焦/關浮窗
  const impactCss = useMemo(() => {
    if (!impactFocus) return "";
    const esc = (s) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/"/g, ""));
    const nSel = (id) => `.react-flow__node[data-id="${esc(id)}"]`;
    const eSel = (id) => `.react-flow__edge[data-id="${esc(id)}"]`;
    let css = ".react-flow__node:not(.react-flow__node-lane){opacity:.12;transition:opacity .15s ease}"
      + ".react-flow__edge{opacity:.06}";
    css += `${nSel(impactFocus.cardId)}{opacity:1;border-radius:10px;box-shadow:0 0 0 3px var(--accent)}`;
    for (const r of impactFocus.rows) {
      const pct = Math.max(25, Math.min(100, Math.round((r.score || 0) * 100))); // 分數→描邊濃度（衰減看得見）
      css += `${nSel(r.id)}{opacity:1;border-radius:10px;box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) ${pct}%, transparent)}`;
    }
    if (impactFocus.edgeIds.length) css += `${impactFocus.edgeIds.map(eSel).join(",")}{opacity:1}`;
    return css;
  }, [impactFocus]);
  // B22 補強 ── 建卡 label 相似卡提示（建卡準則第 1 步「先搜板」UI 化，防重複開卡）：
  // 名稱輸入聚焦時就地比對全專案卡標題——全等 1.0／子串 0.8／雙字組 Dice 係數，
  // 門檻 0.45 取前 3；點提示跳該卡確認。O(卡數) 純記憶體，無網路。
  // HARE b22a51df simCards
  const [labelFocus, setLabelFocus] = useState(false);
  const simCards = useMemo(() => {
    if (!labelFocus || !selNode || selNode.type === "lane") return [];
    const q = (selNode.data?.label || "").trim().toLowerCase();
    if (q.length < 2) return [];
    const bigrams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2)); return set; };
    const qb = bigrams(q);
    const out = [];
    for (const p of boardPages) {
      for (const n of p.nodes || []) {
        if (n.id === selNode.id || n.type === "lane") continue;
        const l = (n.data?.label || n.data?.title || "").trim().toLowerCase();
        if (!l) continue;
        let score;
        if (l === q) score = 1;
        else if (l.includes(q) || q.includes(l)) score = 0.8;
        else { const lb = bigrams(l); let hit = 0; for (const g of qb) if (lb.has(g)) hit += 1; score = (2 * hit) / (qb.size + lb.size || 1); }
        if (score >= 0.45) out.push({ id: n.id, pageId: p.id, pageName: p.name,
          num: n.data?.num || "", label: n.data?.label || n.data?.title || "", score });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 3);
  }, [labelFocus, selNode, boardPages]);
  // 有留言的卡清單（討論整併進 chat 框）：全分頁彙整供「討論」頁籤
  const commentCards = useMemo(() => {
    const out = [];
    const scan = (nodes, page, pageId) => nodes.forEach((n) => {
      const c = n.data?.comments;
      if (Array.isArray(c) && c.length) out.push({ card: n.id, num: n.data?.num || "",
        label: n.data?.label || n.data?.title || "", count: c.length, ...(page ? { page, pageId } : {}) });
    });
    scan(ns);
    otherPages.forEach((p) => scan(p.nodes, p.page, p.id));
    // 固定按編號排序（清單跳動）：原本「本頁在前」——切頁/點卡
    // 就重洗牌；穩定序＝與作用頁無關
    return out.sort((a, b) => String(a.num || a.label).localeCompare(String(b.num || b.label), undefined, { numeric: true }));
  }, [ns, otherPages]);
  // pin 卡綁定歸位（點節點卡，agent 應連回本尊那張）：
  // chat/討論/任務都以被引用卡為對象——對話狀態跟著本尊走，不會斷成兩條
  const chatTarget = useMemo(() => {
    if (selNode?.type !== "pin" || !selNode.data?.refCard) return null;
    const key = selNode.data.refCard;
    const hit = ns.find((x) => x.id === key || x.data?.num === key);
    if (hit) return { node: hit, onPage: true };
    for (const p of otherPages) {
      const m = (p.nodes || []).find((x) => x.id === key || x.data?.num === key);
      if (m) return { node: m, onPage: false, pageId: p.id };
    }
    return null;
  }, [selNode, ns, otherPages]);
  // 節點卡跨頁傳送（nodes.jsx 以 window 事件解耦）：切分頁＋跳卡選取置中
  useEffect(() => {
    const h = (e) => { if (e.detail?.pid) focusPageCard(e.detail.pid, e.detail.cardId); };
    window.addEventListener("hare:focus-page-card", h);
    return () => window.removeEventListener("hare:focus-page-card", h);
  }, [focusPageCard]);
  // 鏡頭平移到卡（不選取， 「只移動不選取」）：本頁直接置中；
  // 跨頁先切頁再置中——全程不動選取狀態（chat 綁定另走覆寫）
  const panToCard = useCallback((id, pid) => {
    const center = (n) => {
      const abs = absPosOf(n, nsRef.current);
      const w = n.measured?.width || 260, h = n.measured?.height || 120;
      const z = Math.max(0.2, Math.min(0.9, (window.innerWidth * 0.85) / w, (window.innerHeight * 0.8) / h));
      setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: z, duration: 400 });
    };
    const inNs = nsRef.current.find((x) => x.id === id);
    if (inNs) { center(inNs); return true; }
    const page = pid || pagesRef.current.find((p) => (p.nodes || []).some((x) => x.id === id))?.id;
    if (!page) return false;
    switchPage(page);
    let tries = 0;
    const timer = setInterval(() => {
      const n = nsRef.current.find((x) => x.id === id);
      if (n) { clearInterval(timer); center(n); }
      else if ((tries += 1) > 20) clearInterval(timer);
    }, 150);
    return true;
  }, [setCenter, switchPage, absPosOf]);
  // chat 側欄點對話卡（指示改版）：鏡頭平移＋綁定覆寫，不選取板上卡
  const pickChatCard = useCallback((a) => {
    const id = typeof a === "string" ? a : a?.card;
    if (!id) return;
    setChatOrphan(id); // 綁定覆寫（含專案助理/已刪卡）；選取別的卡即解除
    saveChatBind(id); // F5 後還原同一個對話對象（本專案）
    if (id !== "__project__") panToCard(id, typeof a === "object" ? a.pageId : undefined);
  }, [panToCard, saveChatBind]);
  // chat 綁定覆寫的顯示資訊（編號/標題）：真卡＝板上解析；專案助理/已刪卡＝專名。
  // 覆寫優先序：點選覆寫 > 釘選——釘選存在時選板上卡片也不切走。
  const chatBindOv = chatOrphan || chatPin;
  const chatBindInfo = useMemo(() => {
    if (!chatBindOv) return null;
    if (chatBindOv === "__project__") return { num: "", label: T("c_projAssistant") };
    const r = resolveChatCard(chatBindOv);
    return r.label && r.label !== chatBindOv ? { num: r.num || "", label: r.label }
      : { num: "", label: `${T("c_cardGone")}・${chatBindOv.slice(0, 10)}` };
  }, [chatBindOv, resolveChatCard]);
  useEffect(() => {
    if (!selNodeId) return;
    setChatOrphan(null); // 選卡＝解除點選覆寫；有釘選時綁定落回釘選卡（不跟隨選取）
    if (!chatPin) saveChatBind(selNodeId); // 無釘選才跟隨選取並持久化
  }, [selNodeId, chatPin, saveChatBind]);
  // 卡號連結跳卡（chat 內卡號可點）：以編號解析（本頁→全分頁）——
  // 只平移鏡頭不選取，對話綁定不受影響；查無＝靜默
  useEffect(() => {
    const h = (e) => {
      const num = String(e.detail || "").trim();
      if (!num) return;
      const hit = (nsRef.current || []).find((x) => (x.data?.num || "") === num);
      if (hit) { panToCard(hit.id); return; }
      for (const p of pagesRef.current || []) {
        const m = (p.nodes || []).find((x) => (x.data?.num || "") === num);
        if (m) { panToCard(m.id, p.id); return; }
      }
    };
    window.addEventListener("hare:focus-num", h);
    return () => window.removeEventListener("hare:focus-num", h);
  }, [panToCard]);
  const activePageName = pages.find((p) => p.id === activePage)?.name || null;

  // B22 ── 快速跳卡候選（開啟時才算）：num 前綴優先、label 子串次之；跨分頁全專案。
  // 卡片 UI 架構階段一：搜尋範圍擴到「卡片內文」——說明／任務／程式路徑／留言。
  // 這是把「掃卡面找東西」換成「搜尋找東西」的正解：L1 收斂卡面之後，內文只能靠這裡找回來。
  // 命中內文時附 hit（哪個欄位）與 snip（前後文片段）——才知道這張為什麼被列出來。
  // HARE 7c1e93aa qo_content_search
  const qoResults = useMemo(() => {
    if (!quickOpen) return [];
    const q = (quickOpen.q || "").trim().toLowerCase();
    // 命中片段：以命中處為中心取前後各 28 字，兩端視情況加省略號（換行壓成空白，維持單行）
    const snipOf = (s, i) => {
      const a = Math.max(0, i - 28), b = Math.min(s.length, i + q.length + 28);
      return `${a > 0 ? "…" : ""}${s.slice(a, b).replace(/\s+/g, " ")}${b < s.length ? "…" : ""}`;
    };
    const rows = [];
    for (const p of boardPages) {
      for (const n of p.nodes || []) {
        if (n.type === "lane") continue;
        const d = n.data || {};
        const num = (d.num || "").toString();
        const label = (d.label || d.title || "").toString();
        if (!num && !label) continue;
        const nl = num.toLowerCase(), ll = label.toLowerCase();
        let rank = -1, hit = null, snip = "";
        if (!q) rank = 3;
        else if (nl.startsWith(q)) rank = 0;
        else if (nl.includes(q)) rank = 1;
        else if (ll.includes(q)) rank = 2;
        else {
          // 內文比對（說明→任務→程式→留言）：命中即停，記下欄位與片段。rank 4+ ＝內文命中
          const fields = [
            ["desc", String(d.desc || "")],
            ["task", taskTexts(d.tasks).join(" ／ ") || String(d.memo || "")],
            ["ref", (Array.isArray(d.refs) ? d.refs : []).map((r) => r?.path || "").join(" ")],
            ["comment", (Array.isArray(d.comments) ? d.comments : []).map((c) => c?.text || "").join(" ")],
          ];
          for (let k = 0; k < fields.length; k += 1) {
            const i = fields[k][1].toLowerCase().indexOf(q);
            if (i >= 0) { rank = 4 + k; hit = fields[k][0]; snip = snipOf(fields[k][1], i); break; }
          }
        }
        if (rank < 0) continue;
        rows.push({ id: n.id, pageId: p.id, pageName: p.name, num, label,
          status: d.status || "note", rank, hit, snip });
      }
    }
    rows.sort((a, b) => a.rank - b.rank || String(a.num).localeCompare(String(b.num), undefined, { numeric: true }));
    // 內文搜尋命中數比純編號多，上限自 10 放寬到 20（清單本身可捲）
    return rows.slice(0, 20);
  }, [quickOpen, boardPages]);

  // B22 ── 誰引用我／同檔引用（開啟時才算）：入邊來源＋跨頁 pin｜同 refs.path 的其他卡。
  const refPanelData = useMemo(() => {
    if (!refPanel) return null;
    if (refPanel.kind === "who") {
      const cardId = refPanel.cardId;
      const host = boardPages.find((p) => (p.nodes || []).some((n) => n.id === cardId));
      const inEdges = [];
      if (host) {
        const byId = new Map((host.nodes || []).map((n) => [n.id, n]));
        const kind = boardKindOf({ nodes: host.nodes, edges: host.edges });
        for (const e of host.edges || []) {
          if (e.target !== cardId) continue;
          const src = byId.get(e.source); if (!src || src.type === "lane") continue;
          inEdges.push({ id: src.id, pageId: host.id, num: src.data?.num || "?",
            label: src.data?.label || src.data?.title || "", rel: edgeSemantics(e, kind).relation });
        }
      }
      const target = host?.nodes.find((n) => n.id === cardId);
      const num = target?.data?.num || null;
      const pins = [];
      for (const p of boardPages) {
        for (const n of p.nodes || []) {
          if (n.type !== "pin" || !n.data?.refCard) continue;
          if (n.data.refCard === cardId || (num && n.data.refCard === num)) {
            pins.push({ id: n.id, pageId: p.id, pageName: p.name,
              num: n.data?.num || "◈", label: n.data?.label || n.data?.title || "" });
          }
        }
      }
      return { kind: "who", inEdges, pins };
    }
    // kind: 'file'
    const path = refPanel.path;
    const rows = [];
    for (const p of boardPages) {
      for (const n of p.nodes || []) {
        if (n.id === refPanel.selfId) continue;
        if ((n.data?.refs || []).some((r) => r?.path === path)) {
          rows.push({ id: n.id, pageId: p.id, pageName: p.name,
            num: n.data?.num || "?", label: n.data?.label || n.data?.title || "" });
        }
      }
    }
    return { kind: "file", path, rows };
  }, [refPanel, boardPages]);

  // B22 ── 麵包屑（單選時）：分頁 › 容器鏈 › 卡號 標題。多選／無選取＝null。
  const breadcrumb = useMemo(() => {
    if (!selNode || selNode.type === "lane") return null;
    const chain = [];
    let cur = selNode, guard = 0;
    while (cur?.parentId && guard < 50) {
      const par = ns.find((n) => n.id === cur.parentId);
      if (!par) break;
      chain.unshift({ id: par.id, num: par.data?.num || "", label: par.data?.label || par.data?.title || "" });
      cur = par; guard += 1;
    }
    return { pageName: activePageName, containers: chain,
      self: { num: selNode.data?.num || "", label: selNode.data?.label || selNode.data?.title || "" } };
  }, [selNode, ns, activePageName]);

  // 底部輸入列：常設於畫面中間下緣。選卡→輸入新任務；點卡內任務→載入編輯回存
  const [barText, setBarText] = useState("");
  const [barEdit, setBarEdit] = useState(null); // {cardId, index}＝編輯模式；null＝新增模式
  // 圖片卡範圍框 → 範圍標籤（修訂，HARE 1ma9e0d5）：點框＝選取該框
  // （卡片同時選取），當下裁切該範圍截圖存檔（region.shot，僅首次），把「縮圖標籤」
  // 掛在輸入列上方——**不搶輸入焦點**、不塞文字進輸入框。之後送出的任務自動以
  // R{n} 前綴歸屬該框（顯示與 agent 讀取都靠這個慣例）。
  const [regionTag, setRegionTag] = useState(null); // { cardId, cardNum, n, shot }
  const cropRegionShot = useCallback(async (node, region) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = node.data.src; });
    const W = img.naturalWidth || 1, H = img.naturalHeight || 1;
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(region.w * W));
    cv.height = Math.max(1, Math.round(region.h * H));
    cv.getContext("2d").drawImage(img, region.x * W, region.y * H, cv.width, cv.height, 0, 0, cv.width, cv.height);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("裁切失敗");
    const { url } = await uploadImage(new File([blob], `region-R${region.n}.png`, { type: "image/png" }));
    return url;
  }, [uploadImage]);
  // 範圍任務標籤：載入（必要時裁切並存檔）該範圍框截圖，掛到輸入列上方。點範圍框或點
  // 範圍任務（R{n} …）都走這裡——修正「點具截圖的範圍任務不載入圖檔」。
  const showRegionTag = useCallback(async (cardId, rn) => {
    const node = nsRef.current.find((x) => x.id === cardId);
    if (!node || node.type !== "img") { setRegionTag(null); return; }
    const { gallery } = imgGalleryOf(node.data);
    // 範圍框可能屬於任一 gallery 圖（R 編號跨全清單）——連同所屬圖一起找
    let region = null, gi = -1;
    gallery.forEach((g, i) => { const r = (g.regions || []).find((x) => x.n === rn); if (r) { region = r; gi = i; } });
    if (!region) { setRegionTag(null); return; }
    let shot = region.shot || null;
    if (!shot && gallery[gi]?.src) {
      try {
        shot = await cropRegionShot({ data: { src: gallery[gi].src } }, region); // 用該框所屬圖裁切
        pushNow.current = true;
        setNodes((nds) => nds.map((x) => {
          if (x.id !== cardId) return x;
          const gg = imgGalleryOf(x.data);
          const ng = gg.gallery.map((g, i) => (i === gi
            ? { ...g, regions: g.regions.map((r) => (r.id === region.id ? { ...r, shot } : r)) } : g));
          return { ...x, data: { ...x.data, gallery: ng, strokes: undefined, regions: undefined } };
        }));
      } catch { /* 裁切失敗仍掛標籤（無縮圖） */ }
    }
    setRegionTag({ cardId, cardNum: node.data?.num || "", n: rn, shot });
  }, [cropRegionShot, setNodes]);
  useEffect(() => { // 點範圍框（ImgNode 發 hare:region-task）→ 選取該卡＋載入範圍截圖標籤
    const h = (e) => {
      const { cardId, n } = e.detail || {};
      if (!cardId) return;
      setNodes((nds) => nds.map((x) => (!!x.selected !== (x.id === cardId) ? { ...x, selected: x.id === cardId } : x)));
      setBarEdit(null);
      setShowChat(true); // 範圍任務也走 chat 框輸入（整併）
      raiseByClass("chat-panel");
      showRegionTag(cardId, n);
    };
    window.addEventListener("hare:region-task", h);
    return () => window.removeEventListener("hare:region-task", h);
  }, [setNodes, showRegionTag]);
  // 範圍標籤失效：該卡取消選取即清（換卡/點空白）
  useEffect(() => {
    if (regionTag && !ns.some((x) => x.id === regionTag.cardId && x.selected)) setRegionTag(null);
  }, [ns, regionTag]);
  useEffect(() => {
    const h = (e) => {
      const { cardId, index, text } = e.detail;
      setBarEdit({ cardId, index });
      setBarText(text);
      setShowChat(true); // 任務輸入整併進 chat 框：點任務編輯＝開 chat 框
      raiseByClass("chat-panel");
      // 點範圍任務（R{n} …）→ 載入該範圍截圖（必要時裁切；標籤掛輸入列上方，HARE 1ma9e0d5）
      const m = /^R(\d+)[\s：:]/.exec(String(text || ""));
      const node = nsRef.current.find((x) => x.id === cardId);
      if (m && node?.type === "img") showRegionTag(cardId, Number(m[1]));
      else setRegionTag(null);
    };
    window.addEventListener("hare:edit-task", h);
    return () => window.removeEventListener("hare:edit-task", h);
  }, [showRegionTag]);
  // HARE 09b9615a barSubmit（整併進 chat 框：文字由 chat 輸入框帶入）
  const barSubmit = useCallback((textIn) => {
    const t = String(textIn ?? barText).trim();
    if (barEdit) {
      setNodes((nds) => nds.map((n) => {
        if (n.id !== barEdit.cardId) return n;
        // B19 dict 化：依排序索引改值（保留原時間戳）；清空回存＝刪鍵
        if (barEdit.index < 0 || barEdit.index >= getTasks(n.data).length) return n;
        return { ...n, data: { ...n.data, tasks: setTaskAt(n.data.tasks, barEdit.index, t || null), memo: undefined } };
      }));
      setBarEdit(null); setBarText("");
    } else {
      const sel = nsRef.current.filter((n) => n.selected && n.type !== "lane");
      if (sel.length !== 1 || !t) return false;
      // pin 歸位：選的是節點卡＝任務一律落到本尊
      let tgt = sel[0];
      if (tgt.type === "pin" && tgt.data?.refCard) {
        const key = tgt.data.refCard;
        const hit = nsRef.current.find((x) => x.id === key || x.data?.num === key);
        if (hit) tgt = hit;
        else {
          // 跨頁本尊：單卡 upsert 寫到本尊所在頁
          //（merge 整卡 last-writer、不動他卡），成功後 fetchAndApply 回灌快取
          for (const p of pagesRef.current) {
            if (p.id === activePageRef.current) continue;
            const m = (p.nodes || []).find((x) => x.id === key || x.data?.num === key);
            if (!m) continue;
            const upd = stripNodeT({ ...m, data: { ...m.data, tasks: addTask(m.data.tasks, t), memo: undefined } });
            fetch(withProject("/api/roadmap"), { method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ page: p.id, nodes: [upd] }) })
              .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return fetchAndApply(); })
              .then(() => flash(T("a_flashTaskToRemote", { num: m.data?.num || "" })))
              .catch((e) => flash(T("a_flashTaskAddFail", { e: String(e && e.message || e) })));
            setBarText("");
            return true;
          }
          return false;
        }
      }
      // 範圍標籤（HARE 1ma9e0d5）：任務結構性歸屬範圍框——存檔時自動帶 R{n} 前綴，
      // 輸入框本身保持乾淨文字
      const text = regionTag && regionTag.cardId === tgt.id ? `R${regionTag.n} ${t}` : t;
      // B19 dict 化：輸入框輸出自帶時間戳（addTask）
      setNodes((nds) => nds.map((n) => (n.id === tgt.id
        ? { ...n, data: { ...n.data, tasks: addTask(n.data.tasks, text), memo: undefined } } : n)));
      setBarText("");
    }
    return true;
  }, [barText, barEdit, setNodes, regionTag, fetchAndApply]);
  const barCancel = () => { setBarEdit(null); setBarText(""); };
  // 選取變更（換卡/取消選取/選了子卡片）→ 退出任務編輯模式，讓輸入列標籤跟著當前選取走
  useEffect(() => {
    if (barEdit && selNodeId !== barEdit.cardId) { setBarEdit(null); setBarText(""); }
  }, [selNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 圖例框可拖移：預設仍置底中央（pos=null），拖過才轉絕對定位並記憶
  const [legendPos, setLegendPos] = useState(() => loadUi().legendPanel || null);
  const legendPosRef = useRef(legendPos); legendPosRef.current = legendPos;
  const legendDragged = useRef(false); // 拖曳後抑制這次 click（避免誤觸收合）
  const startDragLegend = useCallback((e) => {
    if (e.target.closest("input, textarea, button")) return;
    const r = e.currentTarget.closest(".float-legend").getBoundingClientRect();
    const orig = legendPosRef.current || { x: r.x, y: r.y };
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) legendDragged.current = true;
      setLegendPos({ x: orig.x + ev.clientX - sx, y: orig.y + ev.clientY - sy });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (legendDragged.current) saveUi({ legendPanel: legendPosRef.current });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, []);
  // 空白鍵切換 框選 ⇄ 移動；L＝切換選取卡的鎖定——各鍵可於設定框改綁（hotkeysRef）
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const hk = hotkeysRef.current;
      // BUTTON 只擋 Space（避免空白鍵觸發聚焦中的按鈕），其他熱鍵照常生效
      if (comboMatch(e, hk.selMode) && !e.repeat) {
        if (t && t.tagName === "BUTTON" && hk.selMode.code === "Space") return;
        e.preventDefault(); setSelMode((v) => !v);
      }
      // Enter＝聚焦任務輸入框（取代「點卡自動聚焦」——自動聚焦會吃掉
      // Del 鍵會讓卡刪不掉；改成選卡後按 Enter 才進入輸入狀態）
      if (comboMatch(e, hk.focusTask) && !e.repeat) {
        const sel = nsRef.current.filter((n) => n.selected && n.type !== "lane");
        if (sel.length === 1) {
          e.preventDefault();
          document.querySelector(".ib-input")?.focus();
        }
      }
      // F3＝切換正交模式（熱鍵通知同 L 慣例）
      if (comboMatch(e, hk.ortho)) {
        e.preventDefault();
        setOrtho((v) => {
          const nv = !v; saveUi({ ortho: nv });
          const el = document.getElementById("toast");
          if (el) { el.textContent = `${comboLabel(hk.ortho)}：${T(nv ? "a_orthoOn" : "a_orthoOff")}`; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1600); }
          return nv;
        });
      }
      // HARE e52b7ac6 熱鍵L鎖定
      if (comboMatch(e, hk.lock) && !e.repeat) {
        const sel = nsRef.current.filter((n) => n.selected && n.type !== "lane");
        if (!sel.length) return;
        e.preventDefault();
        const toLock = sel.some((s) => s.data?.locked !== true);
        setNodes((nds) => nds.map((n) => {
          if (!sel.some((s) => s.id === n.id)) return n;
          const locked = n.data?.locked === true;
          return { ...n, draggable: locked, deletable: locked, data: { ...n.data, locked: !locked } };
        }));
        // 熱鍵通知：輸入框上方短暫顯示後消失。
        // 超過 6 張只列前 5 個編號＋「等 N 張」，避免訊息過長。
        const nums = sel.map((s) => s.data?.num || s.data?.label || "—");
        const shown = nums.length > 6 ? `${nums.slice(0, 5).join("、")}${T("a_lockShownMore", { n: nums.length })}` : nums.join("、");
        const el = document.getElementById("toast");
        if (el) { el.textContent = `${T(toLock ? "a_locked" : "a_unlocked")}：${shown}`; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1600); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setNodes]);
  // 熱鍵改綁擷取：設定框點清單項後，下一個按鍵＝新綁定；Esc 取消。
  // capture＋stopPropagation：擷取期間不觸發原熱鍵與其他 window 監聽。
  // HARE 8e2f5a3d hotkeyRebind
  useEffect(() => {
    if (!rebind) return;
    const h = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRebind(null); return; }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // 修飾鍵先略過，等實鍵
      const combo = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, code: e.code, key: e.key };
      hotkeysRef.current = { ...hotkeysRef.current, [rebind]: combo };
      saveUi({ hotkeys: hotkeysRef.current });
      setRebind(null);
      flash(T("a_flashRebound", { label: HOTKEY_META[rebind].label, key: comboLabel(combo) }));
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rebind]);
  // 標題框與上方工具列間距＝左邊界間距：量測工具列實高（可能換行）寫入
  // CSS 變數 --barh，.float-desc 以 calc(--barh + 8px) 貼齊；地圖框標題用 attr 帶 i18n 字。
  // HARE b47c09e2 barHeightVar
  useEffect(() => {
    const bar = document.querySelector(".tools-bar");
    if (!bar) return;
    const apply = () => document.documentElement.style.setProperty("--barh", `${bar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    document.querySelector(".react-flow__minimap")?.setAttribute("data-title", T("miniMap"));
    return () => ro.disconnect();
  }, []);

  /* 導覽地圖住在右側 dock 下方，位置固定——不提供拖曳定位，
     拖曳與位置持久化（miniMapPanel）都沒有意義了。這裡只留標題帶右端 ✕＝關閉地圖
     （🗺 鈕可重開），維持既有浮動框慣例的關閉手勢。 */
  // HARE 5a91cd38 miniMapDrag
  useEffect(() => {
    if (!showMiniMap) return;
    const el = document.querySelector(".react-flow__minimap");
    if (!el) return;
    el.setAttribute("data-title", T("miniMap"));
    const down = (e) => {
      const r = el.getBoundingClientRect();
      if (e.clientY - r.top > 34 || r.right - e.clientX > 34) return; // 只認標題帶右端 ✕
      e.preventDefault(); e.stopPropagation();
      toggleMiniMap();
    };
    el.addEventListener("mousedown", down);
    return () => el.removeEventListener("mousedown", down);
  }, [showMiniMap, dockOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodeColor = useCallback((n) => (n.type === "lane" ? "transparent" : (S[n.data?.status]?.c || S.note.c)), []);
  const fitOpt = { padding: 0.08 };
  // 端點分佈佈局（每張卡每一邊的多條線各得一個獨立連接點，沿邊均分，不再全擠一點）：
  //   端點模型：每張卡最多「2 個接點」——
  //   「起點」src＝所有出線（本卡為 source）集中於此一點（右側中央）；
  //   「終點」tgt＝所有入線（本卡為 target）集中於此一點（左側中央）。兩點分開、不共用。
  //   ＊不是每條邊各自分散＊。edgeHandles 把所有邊覆寫為 source→來源卡 src、target→目標卡 tgt。
  //   只在顯示層計算，絕不寫回 roadmap-data.json 的邊資料。
  // HARE 7b1e9c40 handleLayout
  // 每張卡固定 8 端點（四邊 × src/tgt，見 nodes.jsx H）。這裡只需把每條邊覆寫到
  // 「來源卡·該邊 src 點」與「目標卡·該邊 tgt 點」——side 取自 stored handle 首字
  // （預設 source→r、target→l；重連後 handle 可能已是 `b-tgt` 等，取首字仍對）。僅顯示層。
  // usedSrc[nodeId] = 該卡「有線段的起點」hid 集合——未選取時只顯示這些點（見 CSS）。
  // 拓撲鍵（效能）：端點佈局只跟「誰連誰、接哪一側」有關——選取線段、
  // 拖折點（bends）、改樣式都不該重算全卡片的端點 context（否則點一下線＝全板 H
  // 重繪，大板上點擊反應慢）。以拓撲字串為 memo 鍵，非拓撲變動零成本。
  const edgeTopoKey = useMemo(() => es.map((e) =>
    `${e.id}|${e.source}|${e.sourceHandle || ""}|${e.target}|${e.targetHandle || ""}`).join(";"), [es]);
  const { edgeHandles, handlesCtx } = useMemo(() => {
    const eh = {}; const us = {}; const ut = {}; const rs = {};
    const sideOf = (h, def) => (h && "lrtb".includes(h[0]) ? h[0] : def);
    esRef.current.forEach((e) => {
      if (!e.source || !e.target) return;
      // 資源卡列端點（f:檔名， 檔案總管）：固定握把原樣保留——
      // 不映射成卡級分佈端點（否則列連線被卡片端點搶走）、也不入卡級端點統計；
      // rowSrc＝各卡「有線的列端點」（列端點恆顯示規則＋摺疊豁免用）
      const sRow = (e.sourceHandle || "").startsWith("f:");
      const tRow = (e.targetHandle || "").startsWith("f:");
      const s = sRow ? e.sourceHandle : `${sideOf(e.sourceHandle, "r")}-src`;
      const t = tRow ? e.targetHandle : `${sideOf(e.targetHandle, "l")}-tgt`;
      eh[e.id] = { s, t };
      if (sRow) (rs[e.source] || (rs[e.source] = new Set())).add(e.sourceHandle);
      else (us[e.source] || (us[e.source] = new Set())).add(s); // 該卡「有出線的起點」
      if (!tRow) (ut[e.target] || (ut[e.target] = new Set())).add(t); // 該卡「有入線的終點」
    });
    // handlesCtx：供 H 判斷每邊「有起點/有終點」以決定顯示單點置中或雙點＋切換鈕（見 nodes.jsx）
    return { edgeHandles: eh, handlesCtx: { src: us, tgt: ut, rowSrc: rs } };
  }, [edgeTopoKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 只有「被選取」的線段可重連（顯示可拖端點）；其餘不可動，避免滑過誤動。
  // 同時把 source/targetHandle 覆寫成分佈佈局算出的獨立端點（僅顯示層，不動存檔資料）。
  // useMemo（效能）：display 派生只在真正的依賴變動時重算——否則任何
  // 無關 state（輸入框打字、面板拖曳）都會重建整個陣列、迫使 React Flow 重新同步。
  // 選取集鍵：點選卡片＝該卡所有連線墊高到其他卡片之上——卡壓線時
  // 「點卡即見其線段動態」（排版級避讓屬之後的自動排列修正鈕）。
  const selNodeKey = useMemo(() => ns.filter((n) => n.selected && n.type !== "lane")
    .map((n) => n.id).sort().join(","), [ns]);
  const displayEdges = useMemo(() => {
    const selSet = new Set(selNodeKey ? selNodeKey.split(",") : []);
    return es.map((e) => {
      const on = !!e.selected; // 一定要選取才可調整（端點重連＋折點）：避免滑過誤動
      const eh = edgeHandles[e.id];
      const sH = eh?.s ?? e.sourceHandle ?? null;
      const tH = eh?.t ?? e.targetHandle ?? null;
      // 保留選定的線型（曲線 default／直線 straight／折線 smoothstep 等）——絕不強改 type。
      // 墊高（顯示層 zIndex，不入資料檔）：選取線（滑鼠命中優先）或觸及選取卡的線。
      // 列連線（f: 端點）恆墊高：起點在卡片「內部」的列上，沉下去會被卡身遮住
      //（取消選取後線被卡片蓋掉）
      const lift = on || selSet.has(e.source) || selSet.has(e.target)
        || (e.sourceHandle || "").startsWith("f:") || (e.targetHandle || "").startsWith("f:");
      // 1001＝壓過 React Flow「選取卡自動抬升」的 1000（
      // 選卡後線段跑到卡片後面）——同層時節點蓋線，墊高一階讓線恆在上
      const z = lift ? 1001 : (e.zIndex ?? 0);
      // B9-P5b 邊分層：明示 data.confidenceTier 的邊套虛/點線＋透明度（tierEdgeStyle 回 null＝
      // 不覆寫，style 維持原參考、下方早退保留）。板型投影邊無標示＝不變。
      const ts = tierEdgeStyle(e.data);
      const style = ts ? { ...e.style, ...ts } : e.style;
      // 選卡連線虛線動畫（點卡即見資料對應；點線本身亦動畫）——顯示層 animated，不落地
      const anim = !!e.animated || on || selSet.has(e.source) || selSet.has(e.target);
      if (e.reconnectable === on && e.sourceHandle === sH && e.targetHandle === tH
        && (e.zIndex ?? 0) === z && style === e.style && !!e.animated === anim) return e;
      return { ...e, reconnectable: on, sourceHandle: sH, targetHandle: tH, zIndex: z, style, animated: anim };
    });
  }, [es, edgeHandles, selNodeKey]);
  // 鎖定唯一真相＝data.locked，draggable/deletable 每次渲染派生（
  // 鎖定曾有兩個來源——L 熱鍵/卡上鎖 icon 改 draggable、屬性框鎖鈕只改 data.locked，
  // 混用後脫鉤：卡片顯示未鎖但 draggable=false 殘留在資料檔 → 永遠拖不動）
  // N11-3 樹狀展開（鏡像投影）：pin 卡展開被引用卡的子樹為唯讀投影。
  // 投影節點只存在於顯示層（displayNodes 附掛）——絕不進 ns／持久化／碰撞管線
  //（回寫循環坑的血訓：衍生物不落地）。深度狀態同理放 App state 不進 node data。
  // 本尊變＝pages/ns 變＝useMemo 重算＝樹跟著變；LOD/效能模式對投影節點自然生效。
  // HARE 9e11a3d0 pin-tree
  const mirrorNodes = useMemo(() => {
    const out = [];
    for (const pin of ns) {
      if (pin.type !== "pin") continue;
      const depth = pinDepth[pin.id] || 0;
      if (!depth || !pin.data?.refCard) continue;
      // 找本尊：本頁優先，再掃其他分頁（沿 PinNode 慣例，id 或編號皆可）
      const key = pin.data.refCard;
      let src = ns, pid = null,
        target = ns.find((x) => x.id === key || x.data?.num === key);
      if (!target) {
        for (const p of otherPages) {
          const m = (p.nodes || []).find((x) => x.id === key || x.data?.num === key);
          if (m) { target = m; src = p.nodes; pid = p.id; break; }
        }
      }
      if (!target) continue;
      const base = absPosOf(pin, ns);
      // 單卡投影（只投本尊的說明與路徑標籤，子卡不鋪樹、
      // 改以統計數字呈現）；尺寸/子卡區衍生欄位剝除，投影卡回自然緊湊尺寸
      const kidsOf = (nid) => src.filter((x) => x.parentId === nid && x.type !== "lane");
      let total = 0, level = [target.id];
      while (level.length) {
        const next = [];
        for (const pidOf of level) for (const ch of kidsOf(pidOf)) next.push(ch.id);
        total += next.length; level = next;
      }
      const { w, h, minW, minH, childTop, childZoneH, ...td } = target.data || {};
      out.push({
        id: `mir_${pin.id}_${target.id}`, type: "note",
        position: { x: base.x, y: base.y + 100 },
        draggable: false, selectable: false, deletable: false, connectable: false,
        className: "mirror-node",
        data: { ...td, mirror: true, mirrorSrc: target.id, mirrorPid: pid, locked: true,
          tasks: undefined, mirrorKids: kidsOf(target.id).length, mirrorDeep: total },
      });
    }
    return out;
  }, [ns, otherPages, pinDepth, absPosOf]);
  // 選卡鄰居高亮：與選取卡有線相連的對端卡＝顯示層 className，不落地
  const nbSet = useMemo(() => {
    const sel = new Set(selNodeKey ? selNodeKey.split(",") : []);
    const s = new Set();
    es.forEach((e) => {
      if (e.selected) { s.add(e.source); s.add(e.target); } // 點選線段＝兩端卡光暈
      if (!sel.size) return;
      if (sel.has(e.source) && !sel.has(e.target)) s.add(e.target);
      if (sel.has(e.target) && !sel.has(e.source)) s.add(e.source);
    });
    return s;
  }, [es, selNodeKey]);
  const displayNodes = useMemo(() => ns.map((n) => {
    const locked = n.data?.locked === true;
    const cls = [
      (focusStatuses.length > 0 && DIMMABLE.has(n.type) && !focusStatuses.includes(n.data?.status)) ? "dim" : "",
      cutIds.includes(n.id) ? "cut-ghost" : "", // 剪下狀態透明化
      n.id === pinSource ? "pin-source" : "", // 節點卡列選標示
      nbSet.has(n.id) ? "nb-hl" : "", // 選卡鄰居高亮
      n.id === inspId ? "insp-on" : "", // L3 側欄正在讀這張（階段四）：畫布上標出對應卡
    ].filter(Boolean).join(" ");
    const want = {
      draggable: !locked,
      deletable: n.type === "lane" ? false : !locked,
      selectable: n.type === "lane" ? !locked : (n.selectable ?? true),
    };
    // 泳道整片可拖（跟卡片一樣）：清掉舊存檔殘留的標題限定 dragHandle
    const wantHandle = n.type === "lane" ? undefined : n.dragHandle;
    // pin 投影開關狀態注入（單鈕 ⊞/⊟ 切換）：顯示層 data.treeOpen，不落地
    const tOpen = n.type === "pin" ? (pinDepth[n.id] || 0) > 0 : undefined;
    if ((n.className || "") === cls && n.draggable === want.draggable
      && n.deletable === want.deletable && n.selectable === want.selectable
      && n.dragHandle === wantHandle
      && (n.type !== "pin" || !!n.data?.treeOpen === tOpen)) return n;
    return { ...n, className: cls, ...want, dragHandle: wantHandle,
      ...(n.type === "pin" ? { data: { ...n.data, treeOpen: tOpen } } : {}) };
  }).concat(mirrorNodes), [ns, focusStatuses, cutIds, pinSource, mirrorNodes, pinDepth, nbSet, inspId]);
  return (
    <HandlesCtx.Provider value={handlesCtx}>
    <SingleSelCtx.Provider value={selectedNodes.length === 1}>
    <StyleCtx.Provider value={styleCtxVal}>
    <PagesCtx.Provider value={otherPages}>
    {/* stage＝橫向舞台：畫布與 L3 側欄並排，側欄佔版面寬度而非蓋在畫布上。
        畫布 flex:1 收縮，React Flow 容器因此變窄——setCenter/fitView 的置中天生落在可見區。 */}
    <div className="shell">
    <div className="topbar" ref={setTopHost} />
    <div className="stage">
    <div className="stage-flow">
    {/* HARE 5e08c3fd ReactFlow */}
    {/* HARE 9b4e6d20 attribution_hidden —— B7：proOptions.hideAttribution 隱藏；MIT 不強制 UI attribution，授權紀錄保留於 THIRD-PARTY-LICENSES.md */}
    {/* selectNodesOnDrag=false：拖曳移動不選取，單點無位移才選取 */}
    <ReactFlow nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      selectNodesOnDrag={false}
      colorMode={theme}
      proOptions={{ hideAttribution: true }}
      className={`${connecting ? "rf-connecting" : ""} sel-${selBoxMode} ${selMode ? "selmode" : ""} ${lodCls}`}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
      onReconnect={onReconnect} onReconnectStart={onReconnectStart} onReconnectEnd={onReconnectEnd}
      onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop} onBeforeDelete={onBeforeDelete}
      onNodesDelete={(nds) => nds.forEach((n) => removedIdsRef.current.nodes.add(n.id))}
      onEdgesDelete={(eds) => {
        eds.forEach((e) => removedIdsRef.current.edges.add(e.id));
        remeasureEnds(...eds.flatMap((e) => [e.source, e.target])); // 刪線→同側端點回單點，重量測
      }}
      onSelectionChange={onSelectionChange}
      onSelectionStart={onSelectionStart}
      onPaneClick={() => { setCtxMenu(null); setPinSource(null); setConAdd(null); }}
      onNodeDoubleClick={(e, node) => {
        // L3 閱讀層（階段四）：雙擊＝開側欄讀說明/程式/任務/留言。泳道無內容可讀，不開。
        if (node.type === "lane") return;
        setInspId(inspTargetOf(node)); setInspDraft(null); setInspTab("read"); pickDockTab("read");
      }}
      onNodeClick={(e, node) => {
        // 卡片點擊＝資訊頁直接顯示：不必再雙擊才看得到說明。
        // 泳道／指定目標模式除外（下面各自 return，不會走到這裡）。
        if (node.type !== "lane" && !assignMode) {
          setInspId(inspTargetOf(node)); setInspDraft(null); setInspTab("read"); pickDockTab("read");
        }
        if (node.type === "lane") {
          // 泳道＝跟卡片一樣可點選：點任一處即選取，交給
          // React Flow 內建選取處理；這裡只收掉浮層，不再把「點區域空白」當取消選取。
          // （要清空選取＝點真正的畫布空白，由 onPaneClick 處理。）
          setCtxMenu(null); setPinSource(null); setConAdd(null);
          return;
        }
        // 指定目標模式（節點卡，HARE 5p3c1a1d）：建立後點另一張卡＝confirm 綁定；
        // 不可點自己。
        if (assignMode) {
          if (node.id === assignMode.cardId) { flash(T("a_flashCantAssignSelf")); return; }
          const numLabel = `${node.data?.num || ""} ${node.data?.label || node.data?.title || ""}`.trim();
          const mode = assignMode; // 捕捉當下模式（確認卡是非同步關閉）
          setConfirmAsk({
            text: T("a_confirmAssignPin", { name: numLabel }),
            // 跨頁安全寫入：pin 不在當前頁也能正確落地
            onOk: () => assignPinTarget(mode.cardId, node.id, numLabel),
            // 取消＝維持指定模式，可改點其他卡（Esc 退出）
          });
          return;
        }
        // 空圖片卡：已選取狀態下再點卡面＝開檔案選擇器（圖片卡流程）
        if (node.type === "img" && !node.data?.src && node.selected) {
          pendingImgCard.current = node.id;
          fileInputRef.current?.click();
          return;
        }
        // 約束群組加入模式（優先）：點一張加入即退出（不可連續點）；
        // 只能加入「同一畫布」的卡片——群組成員所在層（parentId）與點擊卡必須一致，
        // 父卡片區群組不收子卡片區的卡、反之亦然。
        if (conAdd) {
          const c = constraintsRef.current.find((x) => x.id === conAdd);
          if (c && !c.members.includes(node.id)) {
            const groupLayer = nsRef.current.find((x) => x.id === c.members[0])?.parentId || null;
            if ((node.parentId || null) !== groupLayer) {
              flash(T("a_flashConSameCanvas")); // 保持模式，讓使用者重點
              return;
            }
            addCardToCon(conAdd, node.id);
            flash(T("a_flashConAdded", { n: c.members.length + 1 }));
          }
          setConAdd(null); // 一次加入即退出加入模式
          return;
        }
        if (pinSource && node.id !== pinSource) {
          addPinBeside(pinSource, node);
          setPinSource(null);
          return;
        }
        // 節點卡代理（河道 off-page connector，HARE 1a2ne5v4）：點代理卡＝跳到本尊
        // （選取＋置中）——代理卡只是跨河道長線的替身，本體在別的河道。
        if (node.data?.proxyFor) {
          const real = nsRef.current.find((n) => n.id === node.data.proxyFor);
          if (real) {
            setNodes((nds) => nds.map((n) => (!!n.selected !== (n.id === real.id) ? { ...n, selected: n.id === real.id } : n)));
            const abs = absPosOf(real, nsRef.current);
            const w = real.measured?.width || real.data?.w || 300, h = real.measured?.height || real.data?.h || 200;
            setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: Math.max(getViewport().zoom || 0.6, 0.5), duration: 400 });
            flash(T("a_flashJumpTo", { num: real.data?.num || "", label: real.data?.label || "" }).trim());
          } else {
            flash(T("a_flashNoProxyTarget"));
          }
          return;
        }
        // 單選點擊＝把卡片移動/縮放到畫面中央合適大小；
        // 多選（Ctrl/Shift 加選、框選）不調整視角；👁 關閉時完全不動視角（autoZoom）
        if (autoZoom && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
          const abs = absPosOf(node, nsRef.current);
          const w = node.measured?.width || 200, h = node.measured?.height || 100;
          const z = Math.max(0.2, Math.min(0.9, (window.innerWidth * 0.7) / w, (window.innerHeight * 0.7) / h));
          // 「比實際大不縮小」：合適縮放 z 只用來「放大就位」；
          // 但卡片在當前縮放下超出畫面時，縮到 z 涵蓋整張卡。
          const cur = getViewport().zoom || z;
          const fits = w * cur <= window.innerWidth * 0.95 && h * cur <= window.innerHeight * 0.85;
          setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: fits ? Math.max(cur, z) : z, duration: 400 });
        }
        // （取消）點卡不再自動聚焦任務輸入框——聚焦會吃掉
        // Del/Backspace，卡就刪不掉。改為選卡後按 Enter 才進輸入框（見熱鍵 effect）。
      }}
      onPaneContextMenu={(e) => { e.preventDefault(); const q = screenToFlowPosition({ x: e.clientX, y: e.clientY }); setCtxMenu({ sx: e.clientX, sy: e.clientY, fx: q.x, fy: q.y }); }}
      onNodeContextMenu={(e, node) => {
        // 右鍵不改變選取（保持原有選擇狀態）——只開選單
        e.preventDefault();
        const q = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        // B22：記右鍵所在卡（非泳道），供「誰引用我」對該卡開面板（免先選取）
        const on = node.type !== "lane"
          ? { id: node.id, num: node.data?.num || "", label: node.data?.label || node.data?.title || "" } : null;
        setCtxMenu({ sx: e.clientX, sy: e.clientY, fx: q.x, fy: q.y, node: on });
      }}
      onSelectionContextMenu={(e) => { e.preventDefault(); const q = screenToFlowPosition({ x: e.clientX, y: e.clientY }); setCtxMenu({ sx: e.clientX, sy: e.clientY, fx: q.x, fy: q.y }); }}
      connectionMode={ConnectionMode.Loose} edgesReconnectable reconnectRadius={20}
      connectionRadius={32} /* 外開端點已移除（量測安全）→用吸附半徑補對接手感 */
      onMoveEnd={persistViewport} deleteKeyCode={hotkeysRef.current.del?.key === "Delete" ? ["Backspace", "Delete"] : [hotkeysRef.current.del?.key || "Delete"]}
      selectionOnDrag={selMode} panOnDrag={selMode ? [1, 2] : true} selectionMode={selBoxMode}
      // HARE 9aaf1f03 multiSelectionKeyCode
      //多選只留 Ctrl（Meta 供 mac 對應鍵）；Shift 讓給
      // 「拖曳中按住＝臨時正交」（見 orthoPatch tempOrtho），兩者不再搶鍵。
      multiSelectionKeyCode={["Meta", "Control"]}
      defaultViewport={vpRef.current || undefined} fitView={!vpRef.current} fitViewOptions={fitOpt}
      onlyRenderVisibleElements={perfOn}
      minZoom={0.12} maxZoom={1.8}>
      <Background gap={30} color="var(--grid)" />
      {/* far 導覽層：縮到最遠時標示各編號分類的中心點（泳道標題放大由 CSS .lod-far 處理） */}
      {lod === "far" && <FarOverlay nodes={ns} />}
      {/* HARE 6935aca0 MiniMap */}
      {/* 地圖已移出畫布浮層，固定在右側 dock 下方——見 .dock-map。
          寬度隨 dock、高度由 CSS 固定；原本的「可拖曳定位」隨之退場（dock 位置本來就固定）。 */}
      {/* 視圖控制鈕移右下：墊高 175px 讓開預設在右下角的
          導覽地圖（150 高＋邊距；地圖被拖走也只是留一點空，無害） */}
      {/* Controls 四鈕已移除：縮放＝滾輪/觸控板、
          視野置中＝BAR「縮放」鈕；互動鎖極少用，需要時再議 */}

      {/* 專案啟動指引面板——meta.onboarding 存在且檢核卡有開放任務時，
          右下角浮現小面板（不擋操作、可收合）：叫使用者的 agent 連 MCP 接手，列開放任務＋進度。 */}
      {onboarding && (
        <Panel position="top-left" className={`float-box edge-panel onb-panel ${onbFold ? "collapsed" : ""}`}
          style={{ left: onbPos.x, top: onbPos.y, right: "auto", transform: "none", margin: 0,
            width: onbSize.w, height: onbSize.h, zIndex: 20 }}
          onMouseDown={startDragOnb}>
          {/* 標準浮動框規格：八向把手＋fb-head 標題列（點標題折疊） */}
          {["t", "b", "l", "r", "tl", "tr", "bl", "br"].map((d) => (
            <div key={d} className={`pr-rz pr-rz-${d} nodrag`} onMouseDown={(e) => startOnbResize(e, d)} />
          ))}
          <div className="fb-head" style={{ cursor: "move" }} {...onbHead}>
            <span className="fb-title">🚀 專案啟動中</span>
            <span className="onb-prog" style={{ opacity: 0.7, fontSize: 12 }}>
              {onboarding.done}/{onboarding.total}
            </span>
          </div>
          <div className="onb-body nodrag">
            <p className="onb-hint" style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.85 }}>
              叫你的 AI agent 連上 HARE MCP 接手啟動檢核
            </p>
            <ul className="onb-list" style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
              {onboarding.open.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
            <div className="onb-foot" style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
              進度 {onboarding.done}/{onboarding.total}
            </div>
          </div>
        </Panel>
      )}

      {/* 右鍵選單：剪下（有選卡時可用）／貼上（剪下狀態時可用；依選取決定貼進子畫布或畫布） */}
      {/* HARE 8d3f6b21 ctxMenu */}
      {ctxMenu && (() => {
        const selCards = selectedNodes.filter((n) => n.type !== "lane" && !cutIds.includes(n.id));
        const pasteTarget = selCards[0] || null;
        const canPaste = cutIds.length > 0 || copyIds.length > 0;
        const selAll = selectedNodes.filter((n) => n.type !== "lane");
        const selEdgesN = esRef.current.filter((e) => e.selected).length;
        return (
          <div className="ctx-menu" style={{ left: ctxMenu.sx, top: ctxMenu.sy }}
            onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
            {/* 新增：卡片子選項改「右側飛出子選單」（hover/點擊開） */}
            <div className="ctx-subwrap"
              onMouseEnter={() => setCtxAddOpen(true)} onMouseLeave={() => setCtxAddOpen(false)}>
              <button onClick={() => setCtxAddOpen((v) => !v)}>
                <span>{T("a_ctxAddCard")}</span><span className="ctx-arrow">▸</span></button>
              {ctxAddOpen && (
                <div className="ctx-flyout">
                  {/* 右鍵點＝放置中心；選了單卡＝子卡不吃 at */}
                  <button onClick={() => { const a = { x: ctxMenu.fx, y: ctxMenu.fy }; setCtxMenu(null); addCard(a); }}>
                    {selCards.length === 1 ? T("addChild") : T("a_mainCard")}</button>
                  <button onClick={() => { const a = { x: ctxMenu.fx, y: ctxMenu.fy }; setCtxMenu(null); addSpecialCard("pin", a); }}>{T("a_pinBtn")}</button>
                  <button onClick={() => { const a = { x: ctxMenu.fx, y: ctxMenu.fy }; setCtxMenu(null); addSpecialCard("img", a); }}>{T("a_imgBtn")}</button>
                  <button onClick={() => { const a = { x: ctxMenu.fx, y: ctxMenu.fy }; setCtxMenu(null); addSpecialCard("res", a); }}>{T("a_resBtn")}</button>
                </div>
              )}
            </div>
            <button onClick={() => { setCtxMenu(null); addLane(); }}>{T("a_ctxAddLane")}</button>
            {/* B22 誰引用我：優先右鍵所在卡，否則單一選取卡；對其開浮動面板 */}
            {(() => {
              const sel1 = selCards.length === 1 ? { id: selCards[0].id, num: selCards[0].data?.num || "",
                label: selCards[0].data?.label || selCards[0].data?.title || "" } : null;
              const one = ctxMenu.node || sel1;
              if (!one) return null;
              return (
                <>
                  <div className="ctx-sep" />
                  <button onClick={() => { const at = { x: ctxMenu.sx, y: ctxMenu.sy }; setCtxMenu(null);
                    setRefPanel({ kind: "who", cardId: one.id, num: one.num, label: one.label, x: at.x, y: at.y }); }}>
                    {T("who_ctx")}</button>
                  {/* B22 第三波：卡片歷史（Timeline）＋影響聚焦——同「誰引用我」的單卡入口 */}
                  <button onClick={() => { const at = { x: ctxMenu.sx, y: ctxMenu.sy }; setCtxMenu(null);
                    openHistory({ cardId: one.id, num: one.num, label: one.label }, at); }}>
                    {T("hist_ctx")}</button>
                  <button onClick={() => { setCtxMenu(null); startImpactFocus(one.id); }}>
                    {T("if_ctx")}</button>
                </>
              );
            })()}
            <div className="ctx-sep" />
            <button disabled={!selCards.length} onClick={doCut}>
              {T("a_ctxCut")}{selCards.length ? T("a_cardsParen", { n: selCards.length }) : ""}</button>
            <button disabled={!selCards.length} onClick={doCopy}>
              {T("a_ctxCopy")}{selCards.length ? T("a_cardsParen", { n: selCards.length }) : ""}</button>
            <button disabled={!canPaste}
              onClick={() => (cutIds.length ? doPaste(ctxMenu.fx, ctxMenu.fy) : doPasteCopy(ctxMenu.fx, ctxMenu.fy))}>
              {T("a_ctxPaste")}{canPaste ? `${copyIds.length ? T("a_ctxPasteCopy") : ""}${pasteTarget ? T("a_ctxPasteToChild", { num: pasteTarget.data?.num || T("a_selectedCard") }) : T("a_ctxPasteHere")}` : ""}</button>
            <button onClick={() => { pendingImgAt.current = { x: ctxMenu.fx, y: ctxMenu.fy }; fileInputRef.current?.click(); setCtxMenu(null); }}>
              {T("a_ctxInsertImg")}</button>
            {/* 貼上圖片：剪貼簿有圖片資料才顯示 */}
            {ctxClipImg && (
              <button onClick={() => { const b = ctxClipImg; setCtxMenu(null); insertImageBlob(b, { x: ctxMenu.fx, y: ctxMenu.fy }); }}>
                {T("a_ctxPasteImg")}</button>
            )}
            {(cutIds.length > 0 || copyIds.length > 0) && (
              <button onClick={cancelCut}>{T("a_ctxCancel")}{cutIds.length ? T("a_ctxCancelCut", { n: cutIds.length }) : T("a_ctxCancelCopy", { n: copyIds.length })}</button>
            )}
            {/* 刪除：上方分隔線＋確認提醒 */}
            <div className="ctx-sep" />
            <button className="ctx-del" disabled={!selAll.length && !selEdgesN}
              onClick={async () => {
                setCtxMenu(null);
                const sel = nsRef.current.filter((n) => n.selected && n.type !== "lane");
                const selE = esRef.current.filter((e) => e.selected);
                if (!sel.length && !selE.length) return;
                if (!(await confirmDialog(T("a_ctxDelAsk", { n: sel.length, e: selE.length })))) return;
                rfDeleteElements({ nodes: sel.map((n) => ({ id: n.id })), edges: selE.map((e) => ({ id: e.id })) });
              }}>
              {T("a_ctxDelete")}{selAll.length ? T("a_cardsParen", { n: selAll.length }) : ""}</button>
          </div>
        );
      })()}
      {/* B22 麵包屑（breadcrumbs）：單選卡時頂部顯示「分頁 › 容器鏈 › 卡」，各段可點。 */}
      {breadcrumb && (
        <Panel position="top-center" className="bc-bar nodrag" style={{ marginTop: 8 }}>
          <button className="bc-seg bc-page" title={T("bc_overview")}
            onClick={() => { setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
              setEdges((els) => els.map((el) => (el.selected ? { ...el, selected: false } : el)));
              fitView({ duration: 400, padding: 0.2 }); }}>{breadcrumb.pageName || "—"}</button>
          {breadcrumb.containers.map((c) => (
            <span key={c.id} className="bc-part">
              <span className="bc-arw">›</span>
              <button className="bc-seg" onClick={() => focusNode(c.id)}>{c.num ? `${c.num} ${c.label}` : c.label}</button>
            </span>
          ))}
          <span className="bc-arw">›</span>
          <span className="bc-seg bc-self">{breadcrumb.self.num ? `${breadcrumb.self.num} ${breadcrumb.self.label}` : breadcrumb.self.label}</span>
        </Panel>
      )}
      {/* B22 快速跳卡（Ctrl+P，quick_open）：置中覆蓋輸入框＋前 10 候選；↑↓ 選、Enter 跳、Esc 關。 */}
      {quickOpen && (
        <div className="qo-mask" onMouseDown={() => setQuickOpen(null)}>
          <div className="qo-box" onMouseDown={(e) => e.stopPropagation()}>
            <input ref={qoInputRef} className="qo-input nodrag" value={quickOpen.q}
              placeholder={T("qo_ph")}
              onChange={(e) => setQuickOpen((v) => ({ ...v, q: e.target.value, sel: 0 }))}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setQuickOpen(null); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setQuickOpen((v) => ({ ...v, sel: Math.min(v.sel + 1, Math.max(0, qoResults.length - 1)) })); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setQuickOpen((v) => ({ ...v, sel: Math.max(v.sel - 1, 0) })); }
                else if (e.key === "Enter") { e.preventDefault(); const r = qoResults[quickOpen.sel];
                  if (r) { setQuickOpen(null); jumpToCardId(r.id, r.pageId); } }
              }} />
            <div className="qo-list">
              {qoResults.length === 0 && <div className="qo-empty">{T("qo_empty")}</div>}
              {qoResults.map((r, i) => (
                <button key={`${r.pageId}:${r.id}`} className={`qo-item ${i === quickOpen.sel ? "on" : ""}`}
                  onMouseEnter={() => setQuickOpen((v) => (v.sel === i ? v : { ...v, sel: i }))}
                  onClick={() => { setQuickOpen(null); jumpToCardId(r.id, r.pageId); }}>
                  <span className="qo-num">{r.num || "—"}</span>
                  <span className="qo-label">{r.label}</span>
                  <span className="qo-pg">{r.pageName}</span>
                  <span className="qo-dot" style={{ background: (S[r.status] || S.note).c }} title={(S[r.status] || S.note).label} />
                  {/* 內文命中（階段一）：第二行顯示命中欄位標籤＋前後文片段——說明為什麼列出這張 */}
                  {r.snip && (
                    <span className="qo-snip">
                      <span className="qo-field">{T(`qo_f_${r.hit}`)}</span>{r.snip}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="qo-hint">{T("qo_hint")}</div>
          </div>
        </div>
      )}
      {/* B22 誰引用我／同檔引用（who_refs_me）：浮動小面板，點列跳卡；點外／✕ 關。 */}
      {refPanel && refPanelData && (
        <div className="ref-pop" style={{ left: Math.min(refPanel.x, window.innerWidth - 300), top: Math.min(refPanel.y, window.innerHeight - 260) }}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="ref-pop-head">
            <span className="ref-pop-title">
              {refPanelData.kind === "who" ? `${T("who_title")}：${refPanel.num || ""} ${refPanel.label || ""}` : `${T("who_fileTitle")}：${refPanel.path}`}
            </span>
            <button className="fb-round" title={T("a_close")} onClick={() => setRefPanel(null)}>✕</button>
          </div>
          <div className="ref-pop-body">
            {refPanelData.kind === "who" ? (
              (refPanelData.inEdges.length === 0 && refPanelData.pins.length === 0) ? (
                <div className="ref-pop-empty">{T("who_empty")}</div>
              ) : (
                <>
                  {refPanelData.inEdges.length > 0 && (
                    <div className="ref-pop-sec"><div className="ref-pop-sh">{T("who_inEdges")}（{refPanelData.inEdges.length}）</div>
                      {refPanelData.inEdges.map((r, i) => (
                        <button key={`e${i}`} className="ref-pop-row" onClick={() => { setRefPanel(null); jumpToCardId(r.id, r.pageId); }}>
                          <span className="ref-pop-num">{r.num}</span><span className="ref-pop-lb">{r.label}</span>
                          <span className="ref-pop-rel">{T(`rel_${r.rel}`)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {refPanelData.pins.length > 0 && (
                    <div className="ref-pop-sec"><div className="ref-pop-sh">{T("who_pins")}（{refPanelData.pins.length}）</div>
                      {refPanelData.pins.map((r, i) => (
                        <button key={`p${i}`} className="ref-pop-row" onClick={() => { setRefPanel(null); jumpToCardId(r.id, r.pageId); }}>
                          <span className="ref-pop-num">◈ {r.num}</span><span className="ref-pop-lb">{r.label}</span>
                          <span className="ref-pop-pg">{r.pageName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )
            ) : (
              refPanelData.rows.length === 0 ? <div className="ref-pop-empty">{T("who_fileEmpty")}</div> : (
                <div className="ref-pop-sec">
                  {refPanelData.rows.map((r, i) => (
                    <button key={`f${i}`} className="ref-pop-row" onClick={() => { setRefPanel(null); jumpToCardId(r.id, r.pageId); }}>
                      <span className="ref-pop-num">{r.num}</span><span className="ref-pop-lb">{r.label}</span>
                      <span className="ref-pop-pg">{r.pageName}</span>
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}
      {/* B22 第三波：卡片歷史（Timeline）浮窗——changelog 逐筆（時間・writer・變更・rev），newest-first。 */}
      {histPanel && (
        <div className="ref-pop hist-pop"
          style={{ left: Math.min(histPanel.x, window.innerWidth - 340), top: Math.min(histPanel.y, window.innerHeight - 300) }}
          onMouseDown={(e) => e.stopPropagation()}>
          <div className="ref-pop-head">
            <span className="ref-pop-title">{T("hist_title")}：{histPanel.num || ""} {histPanel.label || ""}</span>
            <button className="fb-toggle" title={T("a_close")} onClick={() => setHistPanel(null)}>✕</button>
          </div>
          <div className="ref-pop-body">
            {histPanel.loading && <div className="ref-pop-empty">{T("health_loading")}</div>}
            {histPanel.error && <div className="ref-pop-empty">{T("health_needServer")}</div>}
            {histPanel.data && (histPanel.data.history || []).length === 0 && (
              <div className="ref-pop-empty">{T("hist_empty")}</div>
            )}
            {histPanel.data && (histPanel.data.history || []).length > 0 && (
              <div className="ref-pop-sec">
                {histPanel.data.history.map((h, i) => (
                  <div className="hist-row" key={i}>
                    <span className="hist-t">{(h.t || "").slice(5, 16).replace("T", " ")}</span>
                    <span className={`hist-w ${h.writer === "browser" ? "" : "hist-w-m"}`}>{h.writer || "?"}</span>
                    <span className="hist-c">
                      {h.change ? T(`hist_${h.change}`) : ""}
                      {h.edges ? `${h.change ? "・" : ""}${T("hist_edges", { n: (h.edges.added || 0) + (h.edges.removed || 0) + (h.edges.updated || 0) })}` : ""}
                    </span>
                    <span className="hist-rev">r{h.rev}</span>
                  </div>
                ))}
                {(histPanel.data.truncated || histPanel.data.bulk_skipped > 0) && (
                  <div className="hist-note">
                    {histPanel.data.bulk_skipped > 0 ? T("hist_bulk", { n: histPanel.data.bulk_skipped }) : ""}
                    {histPanel.data.truncated ? `${histPanel.data.bulk_skipped > 0 ? "・" : ""}${T("hist_trunc")}` : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {/* B22 第三波：影響聚焦濾鏡＋徽章——選擇器級 <style> 淡化無關卡、按 impact 分數描邊波及卡。 */}
      {impactFocus && <style>{impactCss}</style>}
      {impactFocus && (
        <Panel position="top-center" className="if-badge nodrag" style={{ marginTop: breadcrumb ? 44 : 8 }}>
          <span className="if-txt">{T("if_badge", { num: impactFocus.num || impactFocus.label || "?", n: impactFocus.count })}</span>
          {impactFocus.truncated && <span className="if-trunc">{T("hist_trunc")}</span>}
          <button className="fb-toggle" title={T("if_exit")} onClick={() => setImpactFocus(null)}>✕</button>
        </Panel>
      )}
      {/* 「輪到你」常駐計數：wait／block 早就是一等狀態
          （legend 六色之一），但從來沒被「畫出來」——等待中的卡跟計畫中的卡在畫面上只是換個
          顏色，人看不出哪張在等自己。這一列把它變成畫面級的存在：右上常駐、點擊逐張跳。
          全專案跨分頁計數（boardPages），不是只算作用頁——在等你的卡不會因為你切了頁就不存在。 */}
      {turnCards.length > 0 && (
        <Panel position="top-right" className="turn-bar nodrag" style={{ marginTop: 8, marginRight: 8 }}>
          <button className="turn-btn" title={T("turn_tip")}
            onClick={() => {
              // 逐張跳：每按一次前進一張，繞回開頭；跨分頁自動切頁（jumpToCardId 已處理）
              const i = turnIdx % turnCards.length;
              const r = turnCards[i];
              setTurnIdx(i + 1);
              jumpToCardId(r.id, r.pageId);
            }}>
            <span className="turn-g" style={{ color: S.wait.c }}>{S.wait.g}</span>
            <span className="turn-n">{turnCards.length}</span>
            <span className="turn-t">{T("turn_label")}</span>
          </button>
        </Panel>
      )}
      {/* B22 pin hover 預覽（peek_preview）：本尊 num＋label＋status＋desc 首行；純展示、不擋互動。 */}
      {peek && (
        <div className="peek-pop" style={{ left: Math.min(peek.x + 14, window.innerWidth - 280), top: Math.min(peek.y + 14, window.innerHeight - 120) }}>
          <div className="peek-head">
            <span className="peek-num" style={{ color: (S[peek.status] || S.note).c, borderColor: (S[peek.status] || S.note).c }}>{peek.num || "?"}</span>
            <span className="peek-lb">{peek.label}</span>
            <span className="peek-dot" style={{ background: (S[peek.status] || S.note).c }} title={(S[peek.status] || S.note).label} />
          </div>
          {peek.desc && <div className="peek-desc">{peek.desc}</div>}
        </div>
      )}
      {/* N6 內建程式碼閱讀器（code_reader）：點函數級標籤開的浮動窗，顯示錨點片段。 */}
      {reader && (
        <CodeReader reader={reader} pos={readerPos} size={readerSize} onResizeStart={startReaderResize}
          headProps={{ onMouseDown: startDragReader }}
          onClose={() => setReader(null)} onSystem={readerSystem} onVscode={readerVscode} />
      )}
      {/* B22 板面健康（health_panel）：結構體檢（insights 就地跑）＋維護債（validate_cards）。 */}
      {health && (
        <DockSlot tab="health" cls="health-panel" active={dockTab} host={dockHost}>
          {/* 標準浮動框規格：八向把手＋fb-head 拖曳＋
              點標題折疊（useFoldHead 位移防誤觸）；折疊鈕依 2026-07-18 慣例不設 */}
          <div className="fb-head">
            <span className="fb-title">{T("health_title")}</span>
            {healthStruct && <span className="hp-count">{T("health_structTotal", { n: healthStruct.total })}</span>}
            {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
          </div>
          <div className="hp-body nodrag">
            {/* 結構體檢：逐頁區段，每列卡號＋一句、點擊跳卡 */}
            <div className="hp-sec-title">{T("health_structure")}</div>
            {healthStruct && (healthStruct.total === 0 ? (
              <div className="hp-clean">{T("health_clean")}</div>
            ) : (
              healthStruct.pages.filter((pg) => pg.sections.length).map((pg) => (
                <div className="hp-page" key={pg.pageId}>
                  <div className="hp-page-name">{pg.pageName}</div>
                  {pg.sections.map((s, si) => (
                    <div className="hp-group" key={si}>
                      <div className="hp-group-h">{s.title}</div>
                      {s.rows.map((row, ri) => (
                        <button key={ri} className={`hp-row ${row.num ? "" : "hp-row-flat"}`}
                          onClick={row.num ? () => jumpToNum(row.num) : undefined} disabled={!row.num}>
                          {row.text}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ))
            ))}
            {/* 維護債：validate_cards summary；/mcp 失敗＝需伺服器連線（不擋結構體檢） */}
            <div className="hp-sec-title hp-debt-title">{T("health_debt")}
              {healthDebt && healthDebt !== "loading" && healthDebt !== "error" && (
                <span className="hp-count">{T("health_debtTotal", { n: healthDebt.total || 0 })}</span>
              )}
            </div>
            {healthDebt === "loading" && <div className="hp-note">{T("health_loading")}</div>}
            {healthDebt === "error" && <div className="hp-note hp-warn">{T("health_needServer")}</div>}
            {healthDebt && healthDebt !== "loading" && healthDebt !== "error" && (
              (healthDebt.total || 0) === 0 ? <div className="hp-clean">{T("health_clean")}</div> : (
                <>
                  <div className="hp-debt-cats">
                    {Object.entries(healthDebt.summary || {}).map(([issue, n]) => (
                      <div className="hp-cat" key={issue}><span className="hp-cat-n">{n}</span><span className="hp-cat-k">{issue}</span></div>
                    ))}
                  </div>
                  {healthDebtRows === null && (
                    <button className="hp-detail-btn nodrag" onClick={loadHealthDebtRows}>{T("health_loadDetail")}</button>
                  )}
                  {healthDebtRows === "loading" && <div className="hp-note">{T("health_loading")}</div>}
                  {healthDebtRows === "error" && <div className="hp-note hp-warn">{T("health_needServer")}</div>}
                  {Array.isArray(healthDebtRows) && (
                    <div className="hp-debt-rows">
                      {healthDebtRows.map((p, i) => (
                        <button key={i} className={`hp-row ${p.card ? "" : "hp-row-flat"}`}
                          onClick={p.card ? () => jumpToNum(p.card) : undefined} disabled={!p.card}>
                          <span className="hp-issue">{p.issue}</span>
                          <span className="hp-card">{p.card || ""}{p.detail ? ` · ${p.detail}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )
            )}
            {/* B25-1 訊號對帳：宣稱 vs 事實矛盾（audit_signals）——只浮出、點列跳卡、不改狀態 */}
            <div className="hp-sec-title hp-debt-title">{T("audit_title")}
              {healthAudit && healthAudit !== "loading" && healthAudit !== "error" && (
                <span className="hp-count">{T("audit_total", { n: healthAudit.count || 0 })}</span>
              )}
            </div>
            {healthAudit === "loading" && <div className="hp-note">{T("health_loading")}</div>}
            {healthAudit === "error" && <div className="hp-note hp-warn">{T("health_needServer")}</div>}
            {healthAudit && healthAudit !== "loading" && healthAudit !== "error" && (
              <>
                {(healthAudit.count || 0) === 0 ? <div className="hp-clean">{T("audit_clean")}</div> : (
                  <div className="hp-debt-rows">
                    {(healthAudit.mismatches || []).map((m, i) => (
                      <button key={i} className={`hp-row ${m.id ? "" : "hp-row-flat"}`}
                        onClick={m.id ? () => jumpToCardId(m.id) : undefined} disabled={!m.id}>
                        <span className="hp-issue">{m.kind === "claim_stale_no_output" ? T("audit_kindClaim")
                          : m.kind === "branch_unintegrated" ? T("audit_kindBranch")
                            : m.kind === "concurrent_edit" ? T("audit_kindConcurrent") : T("audit_kindRefs")}</span>
                        <span className="hp-card">{m.card}{m.kind === "claim_stale_no_output"
                          ? ` · ${m.agent}・${T("audit_min", { n: m.stale_minutes })}`
                          : m.kind === "branch_unintegrated"
                            ? ` · ${T("audit_ahead", { n: m.ahead })}`
                            : m.kind === "concurrent_edit"
                              ? ` · ${m.file}`
                              : ` · ${(m.files || []).join("、")}`}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!healthAudit.git_available && <div className="hp-note">{T("audit_gitOff")}</div>}
                {(healthAudit.skipped?.no_commit_tag || 0) > 0 && (
                  <div className="hp-note">{T("audit_skipped", { n: healthAudit.skipped.no_commit_tag })}</div>
                )}
              </>
            )}
          </div>
                </DockSlot>
      )}
      {/* 畫面中央確認卡（HARE c0nf1rm5）：取代原生 confirm——點遮罩/取消/Esc 關閉 */}
      {confirmAsk && (
        <div className="confirm-mask" onMouseDown={() => { const f = confirmAsk.onCancel; setConfirmAsk(null); if (f) f(); }}>
          <div className="confirm-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-text">{confirmAsk.text}</div>
            {confirmAsk.mode === "prompt" && (
              <input ref={promptInputRef} className="ep-input nodrag confirm-input" autoFocus
                defaultValue={confirmAsk.def || ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); const f = confirmAsk.onOk; const v = e.currentTarget.value; setConfirmAsk(null); if (f) f(v); }
                  if (e.key === "Escape") { const f = confirmAsk.onCancel; setConfirmAsk(null); if (f) f(); }
                }} />
            )}
            <div className="confirm-btns">
              <button className="cf-ok" onClick={() => { const f = confirmAsk.onOk; const v = promptInputRef.current?.value; setConfirmAsk(null); if (f) f(v); }}>{T("a_confirmOk")}</button>
              {confirmAsk.mode !== "alert" && (
                <button className="cf-cancel" onClick={() => { const f = confirmAsk.onCancel; setConfirmAsk(null); if (f) f(); }}>{T("cancel")}</button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 分頁刪除三選（提醒時新增「合併」選項）＋合併目標選擇 */}
      {pmDel && (
        <div className="confirm-mask" onMouseDown={() => setPmDel(null)}>
          <div className="confirm-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-text">{T("a_pmDelAsk", { name: pmDel.pg.name, n: pmDel.n })}</div>
            <div className="confirm-btns">
              <button className="cf-ok" onClick={doRemovePage}>{T("a_pmDelGo")}</button>
              <button onClick={() => { setPmMerge(pmDel.pg); setPmDel(null); }}>{T("a_pmMergeGo")}</button>
              <button className="cf-cancel" onClick={() => setPmDel(null)}>{T("cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {pmMerge && (
        <div className="confirm-mask" onMouseDown={() => setPmMerge(null)}>
          <div className="confirm-card" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-text">{T("a_pmMergePick", { name: pmMerge.name })}</div>
            <div className="pm-merge-list">
              {pages.filter((p) => p.id !== pmMerge.id).map((p) => (
                <button key={p.id} onClick={() => doMergePage(p)}>{p.name}</button>
              ))}
            </div>
            <div className="confirm-btns">
              <button className="cf-cancel" onClick={() => setPmMerge(null)}>{T("cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {/* 資料夾選擇器（資源卡）：逐層瀏覽 refBase 內子資料夾、選用寫回 refs */}
      {dirPick && (
        <div className="confirm-mask" onMouseDown={() => setDirPick(null)}>
          <div className="confirm-card dir-pick" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-text">{T("a_dirPickTitle")}</div>
            <div className="dp-cur">📁 {dirPick.cur || "."}</div>
            <div className="dp-list">
              {dirPick.cur && (
                <button className="dp-item" onClick={() => loadDirPick(dirPick.cur.split("/").slice(0, -1).join("/"))}>⬆ ..</button>
              )}
              {dirPick.dirs.map((d) => (
                <button key={d} className="dp-item"
                  onClick={() => loadDirPick(dirPick.cur ? `${dirPick.cur}/${d}` : d)}>📁 {d}</button>
              ))}
              {!dirPick.dirs.length && <span className="set-hint">{T("a_dirPickEmpty")}</span>}
            </div>
            <div className="confirm-btns">
              <button className="cf-ok" onClick={async () => {
                // 選定即自動掃描：抓該夾內容入清單
                //（資料夾＋檔案物件列；顯示端 >10 自動摺疊）
                const rel = dirPick.cur || "";
                let listing;
                try {
                  const base = withProject("/api/list-dirs");
                  const r = await fetch(`${base}${base.includes("?") ? "&" : "?"}path=${encodeURIComponent(rel)}`);
                  if (r.ok) {
                    const j = await r.json();
                    listing = [
                      ...(j.dirs || []).map((d) => ({ name: d, kind: "dir" })),
                      ...(j.files || []).map((f) => ({ name: f, kind: "file", path: rel ? `${rel}/${f}` : f })),
                    ];
                  }
                } catch { /* 掃不到＝只寫路徑 */ }
                patchNodeData({ refs: [{ path: rel || "." }], ...(listing ? { listing } : {}) });
                setDirPick(null);
              }}>{T("a_dirPickUse")}</button>
              <button className="cf-cancel" onClick={() => setDirPick(null)}>{T("cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {/* 圖片卡插入用的隱藏檔案選擇器（HARE 1ma9e0d4） */}
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = "";
          const galId = pendingImgGallery.current;
          pendingImgGallery.current = null;
          const cardId = pendingImgCard.current;
          pendingImgCard.current = null;
          const at = pendingImgAt.current;
          pendingImgAt.current = null;
          if (!f) return;
          if (!String(f.type || "").startsWith("image/")) { flash(T("a_flashNotImageFile")); return; }
          if (galId) addImgToGallery(galId, f);      // 圖片清單 ＋
          else if (cardId) setImgCardSrc(cardId, f); // 空圖片卡選檔
          else insertImageBlob(f, at);               // 右鍵插入新圖片卡
        }} />

      {/* HARE f3d4e5e8 float-desc：專案框已移除——
          標題/副標改在專案管理框內編輯（boardMeta 資料與持久化路徑不變） */}

      {selEdge && (() => {
        const color = selEdge.style?.stroke || "#9db1c9";
        const lineKind = selEdge.animated ? "animated" : (selEdge.style?.strokeDasharray ? "dashed" : "solid");
        const shape = selEdge.type === "straight" ? "straight"
          : (selEdge.type === "smoothstep" || selEdge.type === "step") ? "step" : "curve";
        return (
          <DockSlot tab="props" cls="props-box" active={dockTab} host={dockHost}>
            <div className="fb-head">
              <span className="fb-title">{T("edgeProps")}</span>
              <button className="fb-round" title={T("a_setEdgeDefault")}
                onClick={async (ev) => {
                  ev.stopPropagation();
                  if (!(await confirmDialog(T("a_confirmEdgeDefault")))) return;
                  edgeDefaultRef.current = {
                    type: selEdge.type || "default", animated: !!selEdge.animated,
                    style: { ...(selEdge.style || {}) },
                    markerStart: selEdge.markerStart ? { ...selEdge.markerStart } : undefined,
                    markerEnd: selEdge.markerEnd ? { ...selEdge.markerEnd } : undefined,
                  };
                  saveUi({ edgeDefault: edgeDefaultRef.current });
                  flash(T("a_flashEdgeDefaultSet"));
                }}>★</button>
              {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
            </div>
            <div className="ep-body">
              <label className="ep-row">
                <span className="ep-k">{T("kName")}</span>
                <input className="ep-input nodrag" type="text" value={selEdge.label || ""}
                  placeholder={T("a_phEdgeLabel")} onChange={(e) => setEdgeLabel(e.target.value)} />
              </label>
              <div className="ep-row">
                <span className="ep-k">{T("a_kColor")}</span>
                <div className="ep-colors">
                  {EDGE_COLORS.map((c) => (
                    <button key={c} className={`sw ${c === color ? "on" : ""}`} style={{ background: c }}
                      onClick={() => setEdgeColor(c)} title={c} />
                  ))}
                  <input className="sw-pick nodrag" type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#9db1c9"}
                    onChange={(e) => setEdgeColor(e.target.value)} title={T("a_customColor")} />
                </div>
              </div>
              <div className="ep-row">
                <span className="ep-k">{T("a_kArrow")}</span>
                <div className="ep-btns">
                  <button className={selEdge.markerStart ? "on" : ""} onClick={() => toggleMarker("start")}>{T("a_arrowStart")}</button>
                  <button className={selEdge.markerEnd ? "on" : ""} onClick={() => toggleMarker("end")}>{T("a_arrowEnd")}</button>
                  <button className="ep-rev" title={T("a_reverseEdge")} onClick={reverseEdge}>⇄</button>
                </div>
              </div>
              <div className="ep-row">
                <span className="ep-k">{T("a_kLineType")}</span>
                <div className="ep-btns">
                  <button className={lineKind === "solid" ? "on" : ""} onClick={() => setLineStyle("solid")}>{T("a_lineSolid")}</button>
                  <button className={lineKind === "dashed" ? "on" : ""} onClick={() => setLineStyle("dashed")}>{T("a_lineDashed")}</button>
                  <button className={lineKind === "animated" ? "on" : ""} onClick={() => setLineStyle("animated")}>{T("a_lineAnimated")}</button>
                </div>
              </div>
              <div className="ep-row">
                <span className="ep-k">{T("a_kLineShape")}</span>
                <div className="ep-btns">
                  <button className={shape === "curve" ? "on" : ""} onClick={() => setEdgeShape("curve")}>{T("a_shapeCurve")}</button>
                  <button className={shape === "straight" ? "on" : ""} onClick={() => setEdgeShape("straight")}>{T("a_shapeStraight")}</button>
                  <button className={shape === "step" ? "on" : ""} onClick={() => setEdgeShape("step")}>{T("a_shapeStep")}</button>
                </div>
              </div>
            </div>
                    </DockSlot>
        );
      })()}

      {/* 底部輸入列：常設中間下緣；選卡＝新增任務、點卡內任務＝編輯回存。
          名稱標籤獨立於輸入框上方；寬約畫面 1/2 */}
      {/* 底部任務輸入列已整併進 chat 框（HARE 37c88c95 input-bar
          機制保留：barEdit/regionTag/barSubmit 狀態機在上方，UI 由 ChatPanel 承接） */}

      {/* 圖例·狀態篩選：固定於視窗下緣的橫向 BAR（非浮動框），
          BAR 上 ◉ 鈕開關；點狀態膠囊＝篩選（同前），「全部」清除篩選 */}
      {showLegend && (
        <BarSlot host={botHost} cls="tools legend-bar">
          <span className="lg-title">{T("legend")}</span>
          {legend.map(([k, label]) => {
            const on = focusStatuses.includes(k);
            const dim = focusStatuses.length > 0 && !on;
            return (
              <button key={k} className={`li li-chip ${on ? "on" : ""} ${dim ? "dim" : ""}`}
                style={{ "--sc": S[k].c }} title={T("a_focusStatusTitle", { label })}
                onClick={() => toggleFocus(k)}>
                <span className="dot" style={{ background: S[k].c }} />{label}
                <span className="li-n">{statusCounts[k] || 0}</span>
              </button>
            );
          })}
          {focusStatuses.length > 0 && (
            <button className="fb-round lg-clear" title={T("a_clearFilter")}
              onClick={() => setFocusStatuses([])}>{T("all")}</button>
          )}
          <span className="li"><span className="edge-s dep" />{T("a_legendDepEdge")}</span>
        </BarSlot>
      )}

      {/* HARE 4d7b91aa 工具列 */}
      {/* 佈局：專案 → 復原/重做 → 視窗鈕 → 區域卡片
          （含畫布工具）→ 分頁列（吃滿剩餘寬度，＋鈕固定列左緣） */}
      <BarSlot host={topHost} cls="tools tools-bar">
        {/* 專案切換＋新專案＋⬇ 備份 */}
        <div className="proj-tools">
          {/* 專案切換：一專案一檔；分頁在檔內（分頁鈕列見重做右側 HARE 9a6e5b21） */}
          <select className="proj-select nodrag" value={PROJECT} onChange={(e) => switchProject(e.target.value)}
            title={T("a_switchProjTitle")}>
            {!projects.some((p) => p.id === PROJECT) && <option value={PROJECT}>{boardMeta?.title || BOARD_TITLE}</option>}
            {projects.map((p) => (
              // 專案名稱＝標題卡標題（meta.title）。目前專案用即時 boardMeta 並套用與標題卡
              // 相同的預設（BOARD_TITLE），未設 title 時選單與標題卡一致；其餘專案用其 meta.title（p.title）。
              <option key={p.id} value={p.id}>
                {p.id === PROJECT ? (boardMeta?.title || BOARD_TITLE) : (p.title || p.id)}
                {Array.isArray(p.pages) && p.pages.length > 1 ? T("a_pagesSuffix", { n: p.pages.length }) : ""}
              </option>
            ))}
          </select>
          <button className={`proj-new-btn nodrag ${projOpen ? "t-on" : ""}`} title={T("a_projMgrTitle")}
            onClick={() => { setProjOpen((v) => { if (!v) raiseByClass("pm-panel"); return !v; }); setProjErr(""); }}>{T("a_projBtn")}</button>
        </div>
        <button onClick={save} title={T("a_saveTitle")}>⬇</button>
        <span className="t-sep" aria-hidden="true" />
        <div className="t-undo">
          <button onClick={undo} disabled={!past.current.length} title={T("a_undoTitle")}>{T("undo")}</button>
          <button onClick={redo} disabled={!future.current.length} title={T("a_redoTitle")}>{T("redo")}</button>
        </div>
        <span className="t-sep" aria-hidden="true" />
        {/* 視窗開關鈕組：列表/對話/排列/圖例/地圖/設定 */}
        <div className="t-undo">
          {/* ☰任務／▤排列／🩺健康 鈕移除：已是 dock 頁籤 */}
          <button className={showChat ? "t-on" : ""}
            onClick={() => setShowChat((v) => { if (!v) raiseByClass("chat-panel"); return !v; })}
            title={T("a_chatBtnTitle")}>💬</button>
          <button className={showLegend ? "t-on" : ""} onClick={toggleLegend} title={T("a_legendToggle")}>◉</button>
          <button className={showMiniMap ? "t-on" : ""} onClick={toggleMiniMap} title={T("a_miniMapToggle")}>🗺</button>
          <button className={showSettings ? "t-on" : ""}
            onClick={() => setShowSettings((v) => { if (!v) raiseByClass("set-panel"); return !v; })} title={T("a_settingsTitle")}>⚙</button>
          {/* B22：快速跳卡（同 Ctrl+P 入口）＋板面健康 */}
          <button className={quickOpen ? "t-on" : ""} onClick={() => setQuickOpen((v) => (v ? null : { q: "", sel: 0 }))}
            title={T("qo_btnTitle")}>🔍</button>
        </div>
        <span className="t-sep" aria-hidden="true" />
        <button onClick={addLane} title={T("a_addLaneTitle")}>
          {T("addLane")}
        </button>
        {/* 新增卡整合選擇框（BAR 只留「卡片」，點開選型——
            主卡/子卡、節點、圖片、資源；底色移除、同重排的彈出框模式） */}
        <span className="relayout-wrap">
          <button className={addAsk || assignMode?.kind === "pin" ? "t-on" : ""}
            onClick={() => setAddAsk((v) => !v)}
            title={T("a_addCardTitle")}>{T("addCard")}</button>
          {addAsk && (
            <div className="relayout-ask nodrag">
              <span className="ra-t">{T("a_addKind")}</span>
              <button onClick={() => { setAddAsk(false); addCard(); }}
                title={selNode ? T("a_addChildTitle", { name: selNode.data?.label || T("a_selectedCardName") }) : T("a_addCardTitle")}>
                {selNode ? T("addChild") : T("a_mainCard")}</button>
              <button onClick={() => { setAddAsk(false); addSpecialCard("pin"); }}
                title={T("a_addPinTitle")}>{T("a_pinBtn")}</button>
              <button onClick={() => { setAddAsk(false); addSpecialCard("img"); }}
                title={T("a_addImgTitle")}>{T("a_imgBtn")}</button>
              <button onClick={() => { setAddAsk(false); addSpecialCard("res"); }}
                title={T("a_addResTitle")}>{T("a_resBtn")}</button>
            </div>
          )}
        </span>
        <span className="t-sep" aria-hidden="true" />
        <button className={selMode ? "t-on" : ""} onClick={() => setSelMode((v) => !v)}
          title={T("a_selModeTitle")}>
          {selMode ? T("selModeOn") : T("selModeOff")}
        </button>
        <button className={autoZoom ? "t-on" : ""}
          onClick={() => setAutoZoom((v) => { const nv = !v; saveUi({ autoZoom: nv }); return nv; })}
          title={T("a_zoomTitle")}>{T("a_zoomBtn")}</button>
        <button className={ortho ? "t-on" : ""}
          onClick={() => setOrtho((v) => { const nv = !v; saveUi({ ortho: nv }); return nv; })}
          title={T("a_orthoTitle")}>{T("a_orthoBtn")}</button>
        {/* 佈局＋線型選項（錨定在按鈕正下方，仿 proj-tools 彈出層模式） */}
        <span className="relayout-wrap">
          <button className={relayoutAsk || relayoutChoice ? "t-on" : ""} onClick={openRelayout}
            title={T("a_relayoutTitle")}>{T("a_relayoutBtn")}</button>
          {/* 單選有子卡：先選「排列子卡 / 以此卡為中心」 */}
          {relayoutChoice && (
            <div className="relayout-ask nodrag">
              <span className="ra-t">{T("a_relayoutChoose")}</span>
              <button onClick={() => { setRelayoutChoice(false); setRelayoutTarget("children"); setRelayoutAsk(true); }}>{T("a_relayoutKids")}</button>
              <button onClick={() => { setRelayoutChoice(false); setRelayoutTarget("anchor"); setRelayoutAsk(true); }}>{T("a_relayoutAnchor")}</button>
              <button className="ra-cancel" onClick={() => setRelayoutChoice(false)}>{T("cancel")}</button>
            </div>
          )}
          {relayoutAsk && (
            <div className="relayout-ask ra-2row nodrag">
              {/* 兩段式：先選排列方式，再點線型套用。
                  錨模式：分層＝以此卡為中心雙向、放射＝以此卡為 hub */}
              <div className="ra-line">
                <span className="ra-t">{relayoutTarget === "anchor" ? T("a_arrMethodAnchor") : T("a_arrMethod")}</span>
                <button className={relayoutMode === "layered" ? "on" : ""}
                  title={T("a_layeredTitle")} onClick={() => setRelayoutMode("layered")}>{T("a_arrLayered")}</button>
                <button className={relayoutMode === "radial" ? "on" : ""}
                  title={T("a_radialTitle")} onClick={() => setRelayoutMode("radial")}>{T("a_arrRadial")}</button>
              </div>
              <div className="ra-line">
                <span className="ra-t">{T("a_lineApply")}</span>
                <button onClick={() => doRelayoutContainer("default", relayoutMode, relayoutTarget)}>{T("a_shapeCurve")}</button>
                <button onClick={() => doRelayoutContainer("straight", relayoutMode, relayoutTarget)}>{T("a_shapeStraight")}</button>
                <button onClick={() => doRelayoutContainer("smoothstep", relayoutMode, relayoutTarget)}>{T("a_shapeStep")}</button>
                <button className="ra-cancel" onClick={() => setRelayoutAsk(false)}>{T("cancel")}</button>
              </div>
            </div>
          )}
        </span>
        <span className="t-sep" aria-hidden="true" />
        {/* 專案分頁鈕列（HARE 9a6e5b21）：分頁在專案檔內，切頁純記憶體；
            ＋鈕固定在列最左、在捲動列外不跟捲（跳出框也不被
            overflow 裁掉，框錨在＋正下方）；分頁列吃滿 BAR 剩餘寬度 */}
        <div className="page-tabs-wrap nodrag">
          {/* 分頁管理窗（PAGE 鈕左）：名稱/卡片數/移除/排序 */}
          <span className="relayout-wrap">
            <button title={T("a_pageMgrTitle")} className={pageMgr ? "t-on" : ""}
              onClick={() => setPageMgr((v) => !v)}>☰</button>
            {pageMgr && (
              <div className="relayout-ask pm-ask nodrag">
                <span className="ra-t">{T("a_pageMgrTitle")}</span>
                {pages.map((p, i) => {
                  const n = p.id === activePage
                    ? ns.filter((x) => x.type !== "lane").length
                    : (p.nodes || []).filter((x) => x.type !== "lane").length;
                  return (
                    <div key={p.id} className="pm-row">
                      <span className="pm-grip" title={T("a_pmDragTip")}
                        onPointerDown={(e) => startPmDrag(e, i)}>⠿</span>
                      <button className={`pm-name${p.id === activePage ? " on" : ""}`}
                        title={p.name} onClick={() => switchPage(p.id)}>{p.name}</button>
                      <span className="pm-n">{T("a_pmCards", { n })}</span>
                      <button className="pm-sq pm-del" title={T("a_pmRemove")} disabled={pages.length < 2}
                        onClick={() => removePage(p)}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </span>
          <span className="relayout-wrap">
            <button title={T("a_addPageTitle")} className={pageAsk ? "t-on" : ""}
              onClick={() => { setPageAsk((v) => !v); setNewPageName(""); }}>＋</button>
            {pageAsk && (
              <div className="relayout-ask nodrag">
                <span className="ra-t">{T("a_newPageName")}</span>
                <input className="pt-name" value={newPageName} autoFocus placeholder={T("a_phPageName")}
                  onChange={(e) => setNewPageName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") doCreatePage(); if (e.key === "Escape") setPageAsk(false); }} />
                <button onClick={doCreatePage}>{T("a_create")}</button>
                <button className="ra-cancel" onClick={() => setPageAsk(false)}>{T("cancel")}</button>
              </div>
            )}
          </span>
          <div className="page-tabs">
            {pages.map((p) => (
              <button key={p.id} className={p.id === activePage ? "t-on" : ""}
                title={T("a_pageTabTitle", { name: p.name, n: (p.nodes || []).filter((n) => n.type !== "lane").length })}
                onClick={() => switchPage(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </BarSlot>

      {showSettings && (
        <Panel position="top-left" className={`float-box edge-panel set-panel ${settingsFold ? "collapsed" : ""}`}
          style={{ left: settingsPos.x, top: settingsPos.y, right: "auto", transform: "none", margin: 0,
            ...(setPanelSize.current && !settingsFold ? { width: setPanelSize.current.w, height: setPanelSize.current.h } : {}) }}
          onMouseDown={startDragSettings}>
          <div className="fb-head" style={{ cursor: "move" }} {...setHead}>
            <span className="fb-title">{T("settings")}</span>
            <button className="fb-toggle" title={T("a_close")} onClick={async () => {
              // 儲存制提醒：有未儲存的設定草稿，關閉前先確認（關＝放棄草稿）
              if (anySetDirty && !(await confirmDialog(T("a_setDirtyClose")))) return;
              setPaneDirty({});
              setShowSettings(false);
            }}>✕</button>
          </div>
          {/* W1-6 TAB 化：一般設定＝原內容；Agent 設定＝通道 executor/權限/逾時 */}
          <div className="tl-tabs nodrag set-tabs">
            <button className={settingsTab === "general" ? "on" : ""}
              onClick={() => setSettingsTab("general")}>{T("a_setTabGeneral")}</button>
            {/* 卡片樣式獨立頁籤：款式區塊自「一般設定」抽出 */}
            <button className={settingsTab === "style" ? "on" : ""}
              onClick={() => setSettingsTab("style")}>{T("a_setTabStyle")}</button>
            {/* 功能視窗：右側 dock 的頁籤順序與顯示 */}
            <button className={settingsTab === "windows" ? "on" : ""}
              onClick={() => setSettingsTab("windows")}>{T("a_setTabWindows")}</button>
            <button className={settingsTab === "agent" ? "on" : ""}
              onClick={() => setSettingsTab("agent")}>{T("a_setTabAgent")}</button>
            {/* 安全性：永久白名單移入 */}
            <button className={settingsTab === "security" ? "on" : ""}
              onClick={() => setSettingsTab("security")}>{T("a_setTabSecurity")}</button>
          </div>
          {/* 儲存制：Agent/安全性常駐掛載（display:none 藏），切頁籤不掉草稿 */}
          <div className="set-tabwrap" style={settingsTab !== "agent" ? { display: "none" } : undefined}>
            <AgentSettingsPane api={withProject} onDirty={dirtyOf("agent")} bind={bindOf("agent")} />
          </div>
          <div className="set-tabwrap" style={settingsTab !== "security" ? { display: "none" } : undefined}>
            <SecurityPane api={withProject} onDirty={dirtyOf("security")} bind={bindOf("security")} />
          </div>
          {/* 功能視窗：列出右側 dock 的頁籤，可調順序、可關閉顯示。
              關掉的頁籤只是不出現在軌上——功能本身仍在（工具列鈕照樣會把它叫出來並自動開啟）。 */}
          <div className="ep-body dockcfg" style={settingsTab !== "windows" ? { display: "none" } : undefined}>
            <div className="ep-note">{T("a_dockCfgNote")}</div>
            {dockOrder.map((k, i) => {
              const def = DOCK_DEFS.find((d) => d.k === k);
              const shown = !dockHidden.includes(k);
              return (
                <div className="dockcfg-row" key={k}>
                  <span className="dockcfg-ico">{def.ico}</span>
                  <span className="dockcfg-lb">{T(def.lb)}</span>
                  <button className="dockcfg-mv nodrag" title={T("a_dockCfgUp")} disabled={i === 0}
                    onClick={() => moveDockTab(k, -1)}>↑</button>
                  <button className="dockcfg-mv nodrag" title={T("a_dockCfgDown")} disabled={i === dockOrder.length - 1}
                    onClick={() => moveDockTab(k, 1)}>↓</button>
                  <label className="dockcfg-show nodrag" title={T("a_dockCfgShow")}>
                    <input type="checkbox" checked={shown} onChange={() => toggleDockTabShown(k)} />
                    <span>{T("a_dockCfgShow")}</span>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="ep-body" style={settingsTab !== "general" ? { display: "none" } : undefined}>
            <div className="ep-row">
              <span className="ep-k">{T("a_setNewCard")}</span>
              <div className="set-line">
                <span>{T("a_defaultStatus")}{(S[nodeDefaultRef.current.status] || S.note).label}
                  {nodeDefaultRef.current.color ? T("a_withCustomColor") : ""}</span>
                <button className="nodrag" onClick={() => {
                  nodeDefaultRef.current = { status: "note" };
                  saveUi({ nodeDefault: nodeDefaultRef.current }); force(); flash(T("a_flashResetNewCard"));
                }}>{T("a_reset")}</button>
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("a_setNewEdge")}</span>
              <div className="set-line">
                <span>{T("a_edgeDefaultDesc")}</span>
                <button className="nodrag" onClick={() => {
                  edgeDefaultRef.current = EDGE_DEFAULT;
                  saveUi({ edgeDefault: EDGE_DEFAULT }); force(); flash(T("a_flashResetNewEdge"));
                }}>{T("a_reset")}</button>
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("a_setFloatBox")}</span>
              <div className="set-line">
                <span>{T("a_floatBoxDesc")}</span>
                <button className="nodrag" onClick={async () => {
                  if (!(await confirmDialog(T("a_confirmResetPanels")))) return;
                  // 重置＝清全部版面鍵＋layoutV2 旗標→重載時預設版面 v2 重算落檔
                  //（修：舊鍵名清單漏 chat/props/地圖等，也沒清旗標＝按了沒效果）
                  const ui = loadUi();
                  ["layoutV2", "chatPanel", "chatSize", "tasksPanel", "tlSize", "arrangePanel",
                    "miniMapPanel", "propsPanel", "settingsPanel", "projMgrPanel",
                    "assignPickPanel", "edgePanel", "cardPanel", "lanePanel", "legendPanel"]
                    .forEach((k) => delete ui[k]);
                  localStorage.setItem(UI_LS, JSON.stringify(ui));
                  location.reload();
                }}>{T("a_reset")}</button>
              </div>
            </div>
            {/* HARE 7c3a1f8e theme_switch —— 主題三選；切換即時套用（寫 data-theme），偏好持久化 */}
            <div className="ep-row">
              <span className="ep-k">{T("a_setTheme")}</span>
              <div className="set-line">
                <span>{T("a_themeLight")} / {T("a_themeDark")}</span>
                <select className="nodrag" value={theme}
                  onChange={(e) => setTheme(e.target.value)}>
                  <option value="light">{T("a_themeLight")}</option>
                  <option value="dark">{T("a_themeDark")}</option>
                </select>
              </div>
            </div>
            {/* HARE 3d9b2c4a lang_menu —— 語系選單由 i18n.dicts 自動產生（新增語系＝加字典即現）；
                setLang 會重載頁面套用 */}
            <div className="ep-row">
              <span className="ep-k">{T("langLabel")}</span>
              <div className="set-line">
                <span />
                <select className="nodrag" value={getLang()}
                  onChange={(e) => { if (e.target.value !== getLang()) setLang(e.target.value); }}>
                  {langs().map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("a_setPerf")}</span>
              <div className="set-line">
                <span>{T("a_perfDesc")}{perfOn ? T("a_perfActive") : ""}</span>
                <select className="nodrag" value={perfMode}
                  onChange={(e) => { setPerfMode(e.target.value); saveUi({ perfMode: e.target.value }); }}>
                  <option value="auto">{T("a_perfAuto")}</option>
                  <option value="on">{T("a_perfOn")}</option>
                  <option value="off">{T("a_perfOff")}</option>
                </select>
              </div>
            </div>
            <div className="ep-row" style={{ alignItems: "flex-start" }}>
              <span className="ep-k">{T("a_setOps")}</span>
              <div className="hk-wrap">
                <div className="hk-list">
                  {Object.keys(HOTKEY_META).map((k) => (
                    <button key={k} className={"hk-item nodrag" + (rebind === k ? " rebinding" : "")}
                      title={T("a_hkItemTitle")}
                      onClick={() => setRebind(rebind === k ? null : k)}>
                      <span className="hk-name">{HOTKEY_META[k].label}</span>
                      <span className="hk-key">{rebind === k ? T("a_pressNewKey") : comboLabel(hotkeysRef.current[k])}</span>
                    </button>
                  ))}
                </div>
                {/* 說明文字已移除；重置鈕維持靠右 */}
                <div className="set-line">
                  <button className="nodrag" style={{ marginLeft: "auto" }} onClick={() => {
                    hotkeysRef.current = { ...HOTKEY_DEFAULT };
                    saveUi({ hotkeys: hotkeysRef.current }); setRebind(null); force(); flash(T("a_flashResetHotkeys"));
                  }}>{T("a_reset")}</button>
                </div>
              </div>
            </div>
          </div>
          {/* HARE 5e2f8a11 style_samples —— 卡片款式（點樣品套用；獨立頁籤） */}
          {/* 左側欄位標籤已移除（滿版；摺疊頭自帶同名標題） */}
          <div className="ep-body" style={settingsTab !== "style" ? { display: "none" } : undefined}>
            <div className="ep-row" style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <StyleSamples value={cardStyle} onPick={setCardStyle} />
                <StyleManager styles={boardMeta?.cardStyles || {}} onAdd={addCardStyle} onPatch={patchCardStyle}
                  onDup={addCardStyle} onDelete={deleteCardStyle} onImport={importCardStyles} onExport={exportCardStyles} />
              </div>
            </div>
          </div>
          {/* 共用頁尾（儲存/取消統一放設定頁下方、全頁籤共用）；
              儲存/取消只作用在有草稿的頁籤 */}
          <div className="set-foot nodrag">
            <span className="sec-gap" />
            <button disabled={!anySetDirty} onClick={async () => {
              for (const k of Object.keys(paneDirty)) if (paneDirty[k]) await paneOps.current[k]?.save?.();
            }}>{T("sec_save")}</button>
            <button disabled={!anySetDirty} onClick={() => {
              for (const k of Object.keys(paneDirty)) if (paneDirty[k]) paneOps.current[k]?.cancel?.();
            }}>{T("cancel")}</button>
          </div>
        </Panel>
      )}

      {/* 專案管理頁：列表＝名稱／對應資料夾／程式碼類型；
          標題列 ＋＝新增表單、各列 −＝封存（非破壞）。點名稱切換專案。 */}
      {/* HARE 9d7c31fa projMgrPanel */}
      {projOpen && (
        <Panel position="top-left" className={`float-box edge-panel pm-panel ${pmFold ? "collapsed" : ""}`}
          style={{ left: projMgrPos.x, top: projMgrPos.y, right: "auto", transform: "none", margin: 0 }}
          onMouseDown={startDragProjMgr}>
          <div className="fb-head" style={{ cursor: "move" }} {...pmHead}>
            <span className="fb-title">{T("a_projMgrTitleP", { n: projects.length })}</span>
            <button className={`fb-round nodrag ${projCreateOpen ? "on" : ""}`} title={T("a_addProjTitle")}
              onClick={(e) => { e.stopPropagation(); setProjCreateOpen((v) => !v); setProjErr(""); }}>＋</button>
            <button className="fb-toggle" title={T("a_close")} onClick={() => setProjOpen(false)}>✕</button>
          </div>
          <div className="ep-body pm-body">
            {/* 本專案名稱/副標編輯（寫 boardMeta 同原路徑） */}
            <div className="pm-create nodrag" style={{ marginBottom: 6 }}>
              <input className="ep-input nodrag" defaultValue={boardMeta?.title || BOARD_TITLE}
                placeholder={T("a_phTitle")} title={T("a_editTitleSub")}
                onBlur={(e) => setBoardMeta((m) => ({ ...(m || {}), title: e.target.value }))} />
              <input className="ep-input nodrag" defaultValue={boardMeta?.sub || T("a_boardSub")}
                placeholder={T("a_phSub")}
                onBlur={(e) => setBoardMeta((m) => ({ ...(m || {}), sub: e.target.value }))} />
            </div>
            {projCreateOpen && (
              <div className="pm-create nodrag">
                <input className="ep-input nodrag" value={newProjId} autoFocus
                  placeholder={T("a_phProjId")}
                  onChange={(e) => setNewProjId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doCreateProject(); } }} />
                <input className="ep-input nodrag" value={newProjTitle} placeholder={T("a_phProjTitle")}
                  onChange={(e) => setNewProjTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doCreateProject(); } }} />
                <select className="ep-input nodrag" value={newProjTpl} title={T("a_seedTpl")}
                  onChange={(e) => setNewProjTpl(e.target.value)}>
                  <option value="blank">{T("a_tplBlank")}</option>
                  <option value="roadmap">{T("a_tplRoadmap")}</option>
                </select>
                <button className="tk-add nodrag" onClick={doCreateProject}>{T("a_createSwitch")}</button>
              </div>
            )}
            <table className="pm-table">
              <thead><tr><th>{T("a_thProject")}</th><th>{T("a_thFolder")}</th><th>{T("a_thCodeType")}</th><th /></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className={p.id === PROJECT ? "cur" : ""}>
                    <td>
                      <button className="pm-name nodrag" title={p.id === PROJECT ? T("a_curProject") : T("a_switchTo", { id: p.id })}
                        onClick={() => switchProject(p.id)}>
                        {p.title || p.id}
                        <span className="pm-id">{p.id}{typeof p.cardCount === "number" ? T("a_cardCountSuffix", { n: p.cardCount }) : ""}</span>
                      </button>
                    </td>
                    <td className="pm-dir" title={p.refBase || ""}>{shortDir(p.refBase)}</td>
                    <td className="pm-langs">
                      {p.langs || "—"}
                      {Array.isArray(p.ecosystems) && p.ecosystems.map((e) => (
                        <span key={e.eco} className="pm-fw">
                          {e.eco}{e.deps.length ? `：${e.deps.join("・")}` : ""}</span>
                      ))}
                    </td>
                    <td>
                      {!p.isDefault && (
                        <button className="pm-archive nodrag" title={T("a_archiveProjTitle")}
                          onClick={() => doArchiveProject(p.id)}>−</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projErr && <div className="proj-err">{projErr}</div>}
          </div>
        </Panel>
      )}

      {/* HARE b3e7a90c 多選精簡屬性框 */}
      {/* 多選精簡屬性框：僅邊緣色/背景色，批次套用到全部選取卡 */}
      {selectedNodes.filter((n) => n.type !== "lane").length >= 2 && !selEdge && (() => {
        const count = selectedNodes.filter((n) => n.type !== "lane").length;
        const patchSelected = (patch) => setNodes((nds) => nds.map((n) =>
          (n.selected && n.type !== "lane" ? { ...n, data: { ...n.data, ...patch } } : n)));
        return (
          <DockSlot tab="props" cls="props-box" active={dockTab} host={dockHost}>
            <div className="fb-head">
              <span className="fb-title">{T("a_propsMulti", { n: count })}</span>
              {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
            </div>
            <div className="ep-body">
              <div className="ep-row">
                <span className="ep-k">{T("kEdgeColor")}</span>
                <div className="ep-colors">
                  {EDGE_COLORS.map((c) => (
                    <button key={c} className="sw" style={{ background: c }}
                      onClick={() => patchSelected({ color: c })} title={c} />
                  ))}
                  <input className="sw-pick nodrag" type="color" defaultValue="#5f7286"
                    onChange={(e) => patchSelected({ color: e.target.value })} title={T("a_customEdgeColor")} />
                </div>
              </div>
              <div className="ep-row">
                <span className="ep-k">{T("kBgColor")}</span>
                <div className="ep-colors">
                  {BG_COLORS.map((c) => (
                    <button key={c} className="sw" style={{ background: c }}
                      onClick={() => patchSelected({ bg: c === "#ffffff" ? undefined : c })} title={c} />
                  ))}
                  <input className="sw-pick nodrag" type="color" defaultValue="#ffffff"
                    onChange={(e) => patchSelected({ bg: e.target.value })} title={T("a_customBgColor")} />
                </div>
              </div>
              {/* W1-3-8 款式批次套用到全部選取卡 */}
              <div className="ep-row">
                <span className="ep-k">{T("a_cardStyle")}</span>
                <div className="ep-colors sty-chips">
                  <button className="sty-chip" onClick={() => { snapshot(); patchSelected({ appearance: undefined }); }}
                    title={T("a_styleInheritHint")}>{T("a_styleInherit")}</button>
                  {styleOptions.map((o) => (
                    <button key={o.id} className={`sty-chip ${o.builtin ? "" : "custom"}`}
                      onClick={() => { snapshot(); patchSelected({ appearance: o.id }); }} title={o.id}>{o.name}</button>
                  ))}
                </div>
              </div>
              {/* 各卡片群組狀態：多選時每張卡一列，
                  顯示所屬約束群組（可多個）或「無群組」——一眼看出選取集的群組關係 */}
              <div className="con-list con-in-props">
                <div className="arr-zone-t">{T("a_cardGroupStates")}</div>
                {selectedNodes.filter((n) => n.type !== "lane").map((n) => {
                  const gs = constraints.filter((c) => c.members.includes(n.id));
                  return (
                    <div key={n.id} className="con-member sel-state-row">
                      <span className="con-mname"><span className="tl-num">{n.data?.num || "—"}</span>{n.data?.label || n.data?.title || ""}</span>
                      <span className={`sel-state-groups ${gs.length ? "" : "none"}`}>
                        {gs.length ? gs.map((g) => CON_LABEL[g.type] || g.type).join("、") : T("a_noGroup")}</span>
                    </div>
                  );
                })}
              </div>
              {renderConList(new Set(selectedNodes.filter((n) => n.type !== "lane").map((n) => n.id)))}
            </div>
                    </DockSlot>
        );
      })()}

      {(() => {
        // 排列/分布框：常態顯示、可折疊；▤ 鈕整框開關
        if (!showArrPanel) return null;
        // 可排列數＝與 doArrange 一致：未鎖節點（含泳道），locked === true 才排除
        const arrN = selectedNodes.filter((n) => n.data?.locked !== true).length;
        const dis2 = arrN < 2, dis3 = arrN < 3;
        return (
        <DockSlot tab="arrange" cls="arr-panel" active={dockTab} host={dockHost}>
          {/* 標題列：拖曳移動框；點標題折疊剩標題（按下/放開座標比對 >3px 視為拖曳，不誤觸折疊） */}
          <div className="fb-head">
            <span className="fb-title">{T("a_arrTitle")}{arrN >= 2 ? T("a_selectedN", { n: arrN }) : ""}</span>
            {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗 */}
          </div>
          <div className="ep-body">
            {/* 上區＝對齊功能（一次性，不留群組）；下區＝約束功能（持續群組）（分區） */}
            <div className="arr-zone">
              <div className="arr-zone-t">{T("a_zoneAlign")}</div>
              <div className="arr-btns arr-sec">
                <span className="arr-k">{T("arrange")}</span>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("v")} title={T("a_arrVTitle")}>⬇</button>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("h")} title={T("a_arrHTitle")}>➡</button>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("circle")} title={T("a_arrCircleTitle")}>◯</button>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("grid")} title={T("a_arrGridTitle")}>▦</button>
              </div>
              <div className="arr-btns arr-sec">
                <span className="arr-k">{T("a_arrBoundary")}</span>
                <div className="arr-b6">
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:left")} title={T("a_alignLeft")}>⇤</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:hcenter")} title={T("a_alignHcenter")}>⇹</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:right")} title={T("a_alignRight")}>⇥</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:top")} title={T("a_alignTop")}>⤒</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:vcenter")} title={T("a_alignVcenter")}>⇳</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("align:bottom")} title={T("a_alignBottom")}>⤓</button>
                </div>
              </div>
              <div className="arr-btns arr-sec">
                <span className="arr-k">{T("a_arrDist")}</span>
                <button className="nodrag" disabled={dis3} onClick={() => doArrange("dist:h")} title={T("a_distH")}>↔</button>
                <button className="nodrag" disabled={dis3} onClick={() => doArrange("dist:v")} title={T("a_distV")}>↕</button>
              </div>
            </div>
            <div className="arr-zone arr-zone-con">
              <div className="arr-zone-t">{T("a_zoneConstraint")}</div>
              <div className="arr-btns arr-sec">
                <span className="arr-k">{T("a_arrBoundary")}</span>
                <div className="arr-b6">
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:left")} title={T("a_conLeftTitle")}>⇤</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:hcenter")} title={T("a_conHcenterTitle")}>⇹</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:right")} title={T("a_conRightTitle")}>⇥</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:top")} title={T("a_conTopTitle")}>⤒</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:vcenter")} title={T("a_conVcenterTitle")}>⇳</button>
                  <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:bottom")} title={T("a_conBottomTitle")}>⤓</button>
                </div>
              </div>
              <div className="arr-btns arr-sec">
                <span className="arr-k">{T("a_arrGap")}</span>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:gapv")}
                  title={T("a_gapVTitle")}>↕</button>
                <button className="nodrag" disabled={dis2} onClick={() => doArrange("con:gaph")}
                  title={T("a_gapHTitle")}>↔</button>
              </div>
            </div>
          </div>}
                </DockSlot>
        );
      })()}

      {/* 任務列表：memo 元件（見 TaskListPanel）——拖曳卡片時不重建大清單。
          任務封存頁已併入：mode=archive（倉庫籤），arCard＝單卡過濾 */}
      {showTasks && (
        <TaskListPanel nodes={ns} cat={tlCat} setCat={setTlCat} dockTab={dockTab} dockHost={dockHost}
          onClose={toggleDock} onFocus={focusNode}
          mode={tlMode}
          arCard={arCard} setArCard={setArCard} onRestore={restoreArchived}
          pages={otherPages} onFocusRemote={focusPageCard}
          curPageName={activePageName} />
      )}

      {/* 卡片對話面板（💬）——綁定目前選取的卡；未選卡時顯示提示 */}
      {(() => {
        const chatProps = {
          cardId: chatBindOv || chatTarget?.node.id || selNode?.id || "__project__",
          pinned: chatPin, onTogglePin: toggleChatPin,
          cardNum: chatBindInfo ? chatBindInfo.num : chatTarget?.node.data?.num ?? selNode?.data?.num ?? "",
          cardLabel: chatBindInfo ? chatBindInfo.label
            : (!chatTarget && !selNode) ? T("c_projAssistant")
              : chatTarget?.node.data?.label || chatTarget?.node.data?.title
                || selNode?.data?.label || selNode?.data?.title || "",
          pos: chatPos, onHeadDown: startDragChat,
          size: chatSize, onResizeStart: startChatResize,
          resolveCard: resolveChatCard, onPickCard: pickChatCard,
          taskApi: {
            edit: barEdit ? { num: ns.find((n) => n.id === barEdit.cardId)?.data?.num || "", text: barText } : null,
            canAdd: !!selNode && (selNode.type !== "pin" || !!chatTarget),
            submit: barSubmit, cancel: barCancel,
            regionTag, cancelRegion: () => setRegionTag(null), upload: uploadImage,
          },
          commentApi: { cards: commentCards, list: (chatTarget?.node || selNode)?.data?.comments || [],
            add: addComment, del: delComment, canUse: !!selNode },
          api: withProject,
        };
        return (
          <>
            {showChat && (
              <ChatPanel {...chatProps} fold={chatFold} onToggleFold={toggleChatFold}
                onClose={() => setShowChat(false)} />
            )}
            {/* 輸入狀態模式：CHAT 關閉或折疊＋有選卡＝迷你輸入列 */}
            {(!showChat || chatFold) && (chatTarget?.node || (selNode && selNode.type !== "lane")) && (
              <ChatPanel {...chatProps} mini />
            )}
          </>
        );
      })()}

      {/* 指定目標選卡框：assignMode 進行中顯示——點畫布上的卡（confirm）
          或從此列表點選（直接綁定）二擇一；關閉框＝退出指定模式（同 Esc） */}
      {assignMode?.kind === "pin" && (
        <AssignPickPanel nodes={ns} pages={otherPages} selfId={assignMode.cardId} pos={assignPickPos}
          onHeadDown={startDragAssignPick} onClose={() => setAssignMode(null)}
          onPick={(targetId, name, file) => assignPinTarget(assignMode.cardId, targetId, name, file)} />
      )}

      {selNode && !selEdge && (() => {
        const nst = S[selNode.data?.status] || S.note;
        const nColor = colorOf(selNode.data, nst);
        const nCat = (/^([A-Za-z]+)/.exec(selNode.data?.num || "")?.[1] || "").toUpperCase();
        // 泳道（區域）：精簡屬性框，只編輯名稱/副標/顏色（泳道無編號/狀態/任務）
        if (selNode.type === "lane") return (
        <DockSlot tab="props" cls="props-box" active={dockTab} host={dockHost}>
          <div className="fb-head">
            <span className="fb-title">{T("laneProps")}</span>
            {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
          </div>
          <div className="ep-body">
            <label className="ep-row">
              <span className="ep-k">{T("kName")}</span>
              <input className="ep-input nodrag" type="text" value={selNode.data?.title || ""}
                placeholder={T("a_phLaneName")} onChange={(e) => patchNodeData({ title: e.target.value })} />
            </label>
            <label className="ep-row">
              <span className="ep-k">{T("a_kSub")}</span>
              <input className="ep-input nodrag" type="text" value={selNode.data?.sub || ""}
                placeholder={T("a_phLaneSub")} onChange={(e) => patchNodeData({ sub: e.target.value })} />
            </label>
            <div className="ep-row">
              <span className="ep-k">{T("a_kColor")}</span>
              <div className="ep-colors">
                {EDGE_COLORS.map((c) => (
                  <button key={c} className={`sw ${c === selNode.data?.color ? "on" : ""}`} style={{ background: c }}
                    onClick={() => patchNodeData({ color: c })} title={c} />
                ))}
                <input className="sw-pick nodrag" type="color"
                  value={/^#[0-9a-f]{6}$/i.test(selNode.data?.color || "") ? selNode.data.color : "#0a6fb0"}
                  onChange={(e) => patchNodeData({ color: e.target.value })} title={T("a_customColor")} />
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("kDelete")}</span>
              <button className="ep-input nodrag" style={{ cursor: "pointer" }}
                title={T("a_delLaneTitle")}
                onClick={async () => {
                  if (!(await confirmDialog(T("a_confirmDelLane", { name: selNode.data?.title || "" })))) return;
                  snapshot();
                  removedIdsRef.current.nodes.add(selNode.id);
                  setNodes((nds) => nds.filter((n) => n.id !== selNode.id));
                }}>{T("a_delLaneBtn")}</button>
            </div>
          </div>
                </DockSlot>
        );
        return (
        <DockSlot tab="props" cls="props-box" active={dockTab} host={dockHost}>
          <div className="fb-head">
            {/* 鎖狀態顯示＋切換：鎖住時標題同步變色 */}
            <span className="fb-title" style={selNode.data?.locked ? { color: "var(--err)" } : undefined}>
              {T("a_propsType", { t: NODE_TYPE_LABEL[selNode.type] || selNode.type })}</span>
            <button className="fb-round" title={selNode.data?.locked ? T("a_lockedTitle") : T("a_unlockedTitle")}
              style={selNode.data?.locked ? { borderColor: "var(--err)", color: "var(--err)" } : undefined}
              onClick={(ev) => { ev.stopPropagation(); patchNodeData({ locked: !selNode.data?.locked }); }}>
              {selNode.data?.locked ? "🔒" : "🔓"}</button>
            <button className={`fb-round ${pinSource === selNode.id ? "on" : ""}`}
              title={T("a_pinSourceTitle")}
              onClick={(ev) => {
                ev.stopPropagation();
                setPinSource(selNode.id);
                flash(T("a_flashPinSelected"));
              }}>◈</button>
            <button className="fb-round" title={T("a_setNodeDefaultTitle")}
              onClick={async (ev) => {
                ev.stopPropagation();
                if (!(await confirmDialog(T("a_confirmNodeDefault")))) return;
                nodeDefaultRef.current = { status: selNode.data?.status || "note",
                  ...(selNode.data?.color ? { color: selNode.data.color } : {}),
                  ...(selNode.data?.bg ? { bg: selNode.data.bg } : {}) };
                saveUi({ nodeDefault: nodeDefaultRef.current });
                flash(T("a_flashNodeDefaultSet"));
              }}>★</button>
            {/* 折疊鈕已移除：點標題列切換折疊（useFoldHead） */}
            {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗，關閉語意由收軌承擔 */}
          </div>
          <div className="ep-body">
            <div className="ep-row" style={{ alignItems: "flex-start" }}>
              <span className="ep-k">{T("a_kCat")}</span>
              {selNode.parentId ? (
                <div className="ep-num">
                  <span className="ep-num-cur">{selNode.data?.num || "—"}</span>
                  <span className="ep-childhint">{T("a_childHint")}</span>
                </div>
              ) : (
                <div className="ep-num">
                  <div className="ep-cats">
                    {/* 占格數＝內容寬/基準格 26px（+5 間距）向上取整，封頂 3（GRID v2 規格） */}
                    {numCats.map((cat) => (
                      <button key={cat} className={`cat ${nCat === cat ? "on" : ""}`}
                        style={{ gridColumn: `span ${Math.min(3, Math.max(1, Math.ceil((String(cat).length * 9 + 8) / 31)))}` }}
                        title={T("a_catTitle", { cat })} onClick={() => assignCat(cat)}>{cat}</button>
                    ))}
                    <button className="cat cat-add" title={T("a_addCatTitle")} onClick={addCat}>＋</button>
                  </div>
                </div>
              )}
            </div>
            <label className="ep-row">
              <span className="ep-k">{T("kName")}</span>
              <input className="ep-input nodrag" type="text" value={selNode.data?.label || ""}
                placeholder={T("a_phCardName")} onChange={(e) => patchNodeData({ label: e.target.value })}
                onFocus={() => setLabelFocus(true)} onBlur={() => setLabelFocus(false)} />
            </label>
            {/* B22 補強：相似卡提示（防重複開卡）——輸入名稱時列出板上相似卡，
                onMouseDown 先於 blur 觸發＝點提示可跳卡確認 */}
            {simCards.length > 0 && (
              <div className="ep-row ep-simrow">
                <span className="ep-k ep-sim-k">{T("sim_hint")}</span>
                <div className="ep-sims">
                  {simCards.map((s) => (
                    <button key={s.id} className="ep-sim nodrag" title={s.pageName}
                      onMouseDown={(e) => { e.preventDefault(); jumpToCardId(s.id, s.pageId); }}>
                      {s.num ? `${s.num} ` : ""}{s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 說明列已移除——說明改在卡片上就地編輯（W2；點卡片說明文字即可） */}
            {/* 資源卡：只提供路徑——標籤欄與加入鈕移除，
                點路徑框開資料夾選擇器（伺服器列 refBase 內子資料夾） */}
            {selNode.type === "res" ? (
              <div className="ep-row">
                <span className="ep-k">{T("a_refPath")}</span>
                <input className="ep-input nodrag" type="text" readOnly
                  value={(selNode.data?.refs || []).find((r) => r.path)?.path || ""}
                  placeholder={T("a_dirPickPh")} style={{ cursor: "pointer" }}
                  onClick={() => loadDirPick((selNode.data?.refs || []).find((r) => r.path)?.path || "")} />
              </div>
            ) : (
            <div className="ep-row" style={{ alignItems: "flex-start" }}>
              <span className="ep-k">{T("kRefs")}</span>
              <div className="ep-refs">
                <div className="ref-field"><span className="ref-fk">{T("a_refPath")}</span>
                  <input className="ep-input nodrag" type="text" value={refPath}
                    placeholder={T("a_phRefPath")}
                    onChange={(e) => setRefPath(e.target.value)}
                    onFocus={() => setRefPathFocus(true)}
                    onBlur={() => setRefPathFocus(false)}
                    onKeyDown={(e) => { // B22 補強：檔案樹補全鍵盤流（↑↓ 選、Enter/Tab 帶入、Esc 關）
                      if (!refSug) return;
                      if (e.key === "ArrowDown") { e.preventDefault(); setRefSug((v) => ({ ...v, sel: Math.min(v.sel + 1, v.rows.length - 1) })); }
                      else if (e.key === "ArrowUp") { e.preventDefault(); setRefSug((v) => ({ ...v, sel: Math.max(v.sel - 1, 0) })); }
                      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyRefSug(refSug.rows[refSug.sel]); }
                      else if (e.key === "Escape") { e.preventDefault(); setRefSug(null); }
                    }} />
                  {refSug && (
                    <div className="ref-sug nodrag">
                      {refSug.rows.map((row, i) => (
                        <button key={`${row.dir ? "d" : "f"}:${row.name}`}
                          className={`ref-sug-row ${i === refSug.sel ? "on" : ""}`}
                          onMouseDown={(e) => { e.preventDefault(); applyRefSug(row); }}>
                          <span className="ref-sug-ico">{row.dir ? "📁" : "📄"}</span>
                          <span className="ref-sug-name">{row.name}{row.dir ? "/" : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="ref-field"><span className="ref-fk">{T("a_refLabel")}</span>
                  <input className="ep-input nodrag" type="text" value={refLabel}
                    placeholder={T("a_phRefLabel")}
                    onChange={(e) => setRefLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitRef(); } }} /></div>
                <div className="tk-btn-row">
                  <button className="tk-add" onClick={commitRef}>{T("a_addRefBtn")}</button>
                </div>
                {/* 路徑列表：每筆 refs.path 一列＋「同檔引用」小鈕——反查全專案同檔卡；
                    細部編輯/刪除仍交給 MCP update_card refs */}
                {selRefs.length > 0 && (
                  <div className="ep-reflist">
                    {selRefs.map((r, i) => (
                      <div className="ep-refrow" key={i}>
                        <span className="ep-refpath" title={r.path}>{r.label ? `${r.path}｜${r.label}` : r.path}</span>
                        {r.path && (
                          <button className="ep-samefile nodrag" title={T("who_sameFile")}
                            onClick={(ev) => setRefPanel({ kind: "file", path: r.path, selfId: selNode.id,
                              x: ev.clientX, y: ev.clientY })}>⿻</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            )}
            <div className="ep-row" style={{ alignItems: "flex-start" }}>
              <span className="ep-k">{T("kStatus")}</span>
              <div className="ep-status">
                {["real", "wait", "draft", "block", "plan", "note"].map((k) => (
                  <button key={k} className={`stt ${(selNode.data?.status || "note") === k && !selNode.data?.color ? "on" : ""}`}
                    style={{ "--sc": S[k].c }} onClick={() => patchNodeData({ status: k, color: undefined })}>{S[k].label}</button>
                ))}
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("kEdgeColor")}</span>
              <div className="ep-colors">
                {EDGE_COLORS.map((c) => (
                  <button key={c} className={`sw ${c === nColor ? "on" : ""}`} style={{ background: c }}
                    onClick={() => setNodeColor(c)} title={c} />
                ))}
                <input className="sw-pick nodrag" type="color" value={/^#[0-9a-f]{6}$/i.test(nColor) ? nColor : "#5f7286"}
                  onChange={(e) => setNodeColor(e.target.value)} title={T("a_customEdgeColor")} />
              </div>
            </div>
            <div className="ep-row">
              <span className="ep-k">{T("kBgColor")}</span>
              <div className="ep-colors">
                {BG_COLORS.map((c) => {
                  const on = c === "#ffffff" ? (!selNode.data?.bg || selNode.data?.bg === "#ffffff") : c === selNode.data?.bg;
                  return (<button key={c} className={`sw ${on ? "on" : ""}`} style={{ background: c }}
                    onClick={() => setNodeBg(c)} title={c} />);
                })}
                <input className="sw-pick nodrag" type="color"
                  value={/^#[0-9a-f]{6}$/i.test(selNode.data?.bg || "") ? selNode.data.bg : "#ffffff"}
                  onChange={(e) => setNodeBg(e.target.value)} title={T("a_customBgColor")} />
              </div>
            </div>
            {/* W1-3-8 卡片款式（per-card）：空＝跟板預設；點款式＝寫 data.appearance */}
            <div className="ep-row">
              <span className="ep-k">{T("a_cardStyle")}</span>
              <div className="ep-colors sty-chips">
                <button className={`sty-chip ${!selNode.data?.appearance ? "on" : ""}`}
                  onClick={() => patchNodeData({ appearance: undefined })}
                  title={T("a_styleInheritHint")}>{T("a_styleInherit")}</button>
                {styleOptions.map((o) => (
                  <button key={o.id} className={`sty-chip ${selNode.data?.appearance === o.id ? "on" : ""} ${o.builtin ? "" : "custom"}`}
                    onClick={() => patchNodeData({ appearance: o.id })} title={o.id}>{o.name}</button>
                ))}
              </div>
            </div>
            {renderConList(new Set([selNode.id]))}
            {/* 討論區已整併進 chat 框「討論」頁籤——
                addComment/delComment 機制保留在上方，UI 由 ChatPanel 承接 */}
          </div>
                </DockSlot>
        );
      })()}
    </ReactFlow>
    </div>
    {/* ══ 右側 DOCK（參考 CorelDRAW 泊塢窗）══
        垂直軌恆常可見（可發現性）＋單槽內容區＋地圖固定於下方。
        各面板以 DockSlot（portal）把內容送進 .dock-body——外殼統一，內容原封不動。
        窄視窗：軌照舊釘在右邊，展開的內容區改成覆蓋（不推擠畫布）。 */}
    <aside className={`dock${dockOpen ? " dock-open" : ""}${narrow ? " dock-narrow" : ""}`}
      style={dockOpen && !narrow ? { width: dockW } : undefined}>
      {dockOpen && (
        <div className="dock-col" style={narrow ? { width: dockW } : undefined}>
          <div className="dock-grip nodrag" onMouseDown={startDockW} title={T("dock_resize")} />
          <div className="dock-body nodrag" ref={setDockHost}>
            {/* 該頁沒有內容時給一句說明。頁籤一律可點——
                不可點的頁籤是沒解釋的死路，點得進去、告訴你為什麼空的才叫可用。 */}
            {dockActive && !dockActive.avail && (
              <div className="dock-empty">
                <div className="dock-empty-t">{dockActive.label}</div>
                <div className="dock-empty-h">{dockActive.hintText}</div>
              </div>
            )}
          </div>
          {/* 地圖固定於 dock 下方：不再是可拖曳的畫布浮層 */}
          {showMiniMap && (
            <div className="dock-map nodrag">
              <MiniMap nodeColor={nodeColor} nodeStrokeWidth={2} pannable zoomable />
            </div>
          )}
        </div>
      )}
      <div className="dock-rail">
        {dockTabs.map((tb) => (
          <button key={tb.k}
            className={`dock-tabbtn${dockOpen && dockTab === tb.k ? " on" : ""}${tb.avail ? "" : " idle"}`}
            title={tb.avail ? tb.label : T("dock_unavail", { name: tb.label })}
            onClick={() => (dockOpen && dockTab === tb.k ? toggleDock() : pickDockTab(tb.k))}>
            <span className="dt-ico">{tb.ico}</span>
            <span className="dt-lb">{tb.label}</span>
          </button>
        ))}
      </div>
    </aside>
    {/* ── 閱讀頁（L3）：說明全文／留言／歷史。dock 的第一個 tab。 ── */}
    {inspId && (() => {
      // 本頁找不到就掃其他分頁（節點卡的本尊可能不在作用頁）；跨頁時說明唯讀，
      // 因為 setNodes 只寫得到作用頁——能顯示但不假裝能存。
      let n = ns.find((x) => x.id === inspId), onPage = !!n;
      if (!n) {
        for (const pg of boardPages) {
          const m = (pg.nodes || []).find((x) => x.id === inspId);
          if (m) { n = m; break; }
        }
      }
      if (!n) return null;                      // 卡被刪＝內容自然消失
      const d = n.data || {};
      const st = S[d.status] || S.note;
      const tasks = getTasks(d);
      const done = Array.isArray(d.doneTasks) ? d.doneTasks : [];
      const cmts = Array.isArray(d.comments) ? d.comments : [];
      const refs = (Array.isArray(d.refs) ? d.refs : []).filter((r) => r?.path);
      const accepts = acceptsOf(d);
      const saveDesc = () => {
        const t = String(inspDraft ?? "").trim();
        setNodes((nds) => nds.map((x) => (x.id === inspId
          ? { ...x, data: { ...x.data, desc: t || undefined } } : x)));
        setInspDraft(null);
      };
      const TABS = [["read", T("insp_tabRead")],
        ["comments", `${T("insp_tabCmt")}${cmts.length ? ` ${cmts.length}` : ""}`],
        ["history", T("insp_tabHist")]];
      return (
        <DockSlot tab="read" cls="insp-pane" active={dockTab} host={dockHost}>
          <div className="fb-head insp-head">
            <span className="st-mark" style={{ color: st.c }} title={st.label}>{st.g}</span>
            <span className="insp-num" style={{ color: st.c, borderColor: st.c }}>{d.num || "—"}</span>
            <span className="fb-title insp-title">{d.label || d.title || ""}</span>
            {/* 頁籤標題不設 ✕：dock 是頁籤不是視窗 */}
          </div>
          <div className="insp-tabs nodrag">
            {TABS.map(([k, lb]) => (
              <button key={k} className={`insp-tab${inspTab === k ? " on" : ""}`}
                onClick={() => setInspTab(k)}>{lb}</button>
            ))}
          </div>
          <div className="insp-body nodrag">
            {inspTab === "read" && (<>
              <div className="insp-sec">
                <div className="insp-k">{T("insp_desc")}</div>
                {inspDraft === null ? (
                  <div className="insp-desc" title={T("insp_descEdit")}
                    onClick={() => setInspDraft(d.desc || "")}>
                    {d.desc ? <Md text={d.desc} /> : <span className="insp-empty">{T("insp_descEmpty")}</span>}
                  </div>
                ) : (
                  <AutoTextarea className="insp-ta nodrag" value={inspDraft} autoFocus
                    onChange={(e) => setInspDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDesc(); }
                      if (e.key === "Escape") setInspDraft(null);
                    }}
                    onBlur={saveDesc} placeholder={T("insp_descPh")} />
                )}
              </div>
              {accepts.length > 0 && (
                <div className="insp-sec">
                  <div className="insp-k">{T("insp_accepts")}</div>
                  {accepts.map((ac, i) => (
                    <div key={i} className="insp-acc">
                      <span className="insp-acc-s">{ac.state}</span>
                      <span className="insp-acc-d">{ac.desc}</span>
                      {ac.anchor && <span className={`insp-acc-a ak-${anchorKind(ac.anchor)}`}>{ac.anchor}</span>}
                    </div>
                  ))}
                </div>
              )}
              {refs.length > 0 && (
                <div className="insp-sec">
                  <div className="insp-k">{T("insp_refs")}</div>
                  {refs.map((r, i) => <div key={i} className="insp-ref">{r.path}</div>)}
                </div>
              )}
              {(tasks.length > 0 || done.length > 0) && (
                <div className="insp-sec">
                  <div className="insp-k">{T("insp_tasks")}</div>
                  {tasks.map((t, i) => <div key={i} className="insp-task">{t}</div>)}
                  {done.map((x, i) => <div key={`d${i}`} className="insp-task insp-task-done">{doneTextOf(x)}</div>)}
                </div>
              )}
            </>)}
            {inspTab === "comments" && (
              <div className="insp-sec">
                {cmts.length === 0 && <div className="insp-empty">{T("insp_cmtEmpty")}</div>}
                {cmts.map((cm, i) => (
                  <div key={i} className="insp-cmt">
                    <span className="insp-cmt-w">{cm.writer || "?"}</span>
                    <span className="insp-cmt-t">{String(cm.t || "").slice(0, 16).replace("T", " ")}</span>
                    <div className="insp-cmt-b">{cm.text}</div>
                  </div>
                ))}
              </div>
            )}
            {inspTab === "history" && (
              <div className="insp-sec">
                {(!inspHist || inspHist.loading) && <div className="insp-empty">{T("hist_loading")}</div>}
                {inspHist?.error && <div className="insp-empty">{T("hist_error")}</div>}
                {inspHist?.data && (inspHist.data.history || []).length === 0 && (
                  <div className="insp-empty">{T("hist_empty")}</div>
                )}
                {(inspHist?.data?.history || []).map((h, i) => (
                  <div key={i} className="insp-cmt">
                    <span className="insp-cmt-w">{h.writer || "?"}</span>
                    <span className="insp-cmt-t">{String(h.t || "").slice(0, 16).replace("T", " ")}</span>
                    <div className="insp-cmt-b">{h.change ? T(`hist_${h.change}`) : ""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DockSlot>
      );
    })()}
    </div>
    <div className="legendbar" ref={setBotHost} />
    </div>
    </PagesCtx.Provider>
    </StyleCtx.Provider>
    </SingleSelCtx.Provider>
    </HandlesCtx.Provider>
  );
}

export default function App() {
  return (
    <div className="app">
      <div className="canvas">
        <ReactFlowProvider><Flow /></ReactFlowProvider>
      </div>
      <div id="toast"></div>
    </div>
  );
}
