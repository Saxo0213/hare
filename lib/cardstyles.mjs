// 卡片款式共用 registry —— 前端渲染、屬性框、MCP 工具、匯入匯出共用同一份真相。
// 純 JS、零依賴、無 node API：src（vite 打包）與 lib（伺服器）皆可 import（沿 collision/graph/tasks 慣例）。
//
// 四條規則：
//  1. 外觀≠型別：款式只決定視覺，不另造 node type。
//  2. 不開放任意 CSS/JS：token 一律白名單 enum＋色碼；渲染轉成 class＋CSS variables，絕不拼 CSS 字串。
//  3. 專案級：自訂款式存 data.meta.cardStyles，跟專案同步；per-card 只存款式 id（data.appearance）。
//  4. 未知/被刪 id 安全退回 classic，不破壞卡片內容。

// ---- 白名單（token 只認這些；其餘一律丟棄或正規化為預設） ----
export const STYLE_BASES = ["classic", "compact", "outlined", "sticky", "headerband"];
export const DENSITIES = ["comfortable", "cozy", "compact"];
export const SHAPES = ["rounded", "sharp", "pill"];
export const HEADERS = ["plain", "band"];
export const SURFACES = ["default", "semantic-panel", "muted"];
export const BORDERS = ["solid", "dashed", "none"];
export const SHADOWS = ["none", "low", "medium"];

// ---- 內建款式（classic＝相容基線，零覆寫） ----
export const BUILTIN_STYLES = {
  classic: { name: "Classic", base: "classic", density: "comfortable", shape: "rounded", header: "plain", tokens: {} },
  compact: { name: "Compact", base: "compact", density: "compact", shape: "rounded", header: "plain", tokens: {} },
  outlined: { name: "Outlined", base: "outlined", density: "comfortable", shape: "rounded", header: "plain", tokens: { border: "solid", shadow: "none" } },
  sticky: { name: "Sticky", base: "sticky", density: "comfortable", shape: "rounded", header: "plain", tokens: {} },
  headerband: { name: "Header Band", base: "headerband", density: "comfortable", shape: "rounded", header: "band", tokens: {} },
};
export const BUILTIN_IDS = Object.keys(BUILTIN_STYLES);
export const DEFAULT_APPEARANCE = "classic";

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const pick = (v, allow, def) => (allow.includes(v) ? v : def);

export function isBuiltin(id) {
  return Object.prototype.hasOwnProperty.call(BUILTIN_STYLES, id);
}

// 款式 id 命名規則：小寫英數與連字號，1–40 字元；不得撞內建 id（避免覆寫基線語意）。
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function isValidStyleId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

// 驗證＋消毒單一自訂款式（裁定 2：結構壞＝拒；enum 不合＝正規化為預設；未知 token key＝丟棄）。
// 回傳乾淨的 style 物件；input 非物件或缺 name＝throw（呼叫端負責回報）。
export function validateCardStyle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("款式必須是物件");
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("款式缺 name");
  if (name.length > 60) throw new Error("款式 name 上限 60 字元");
  const t = input.tokens && typeof input.tokens === "object" && !Array.isArray(input.tokens) ? input.tokens : {};
  const tokens = {};
  if (typeof t.accent === "string" && HEX.test(t.accent.trim())) tokens.accent = t.accent.trim().toLowerCase();
  if (SURFACES.includes(t.surface)) tokens.surface = t.surface;
  if (BORDERS.includes(t.border)) tokens.border = t.border;
  if (SHADOWS.includes(t.shadow)) tokens.shadow = t.shadow;
  return {
    name,
    base: pick(input.base, STYLE_BASES, "classic"),
    density: pick(input.density, DENSITIES, "comfortable"),
    shape: pick(input.shape, SHAPES, "rounded"),
    header: pick(input.header, HEADERS, "plain"),
    tokens,
  };
}

// 驗證整份 cardStyles map（匯入/寫 meta 前）：逐 id 驗 id 格式與 style；壞的略過並記錄。
// 回傳 { styles, dropped:[{id,reason}] }。不 throw（匯入寧可部分成功也附報告）。
export function sanitizeCardStyles(map) {
  const styles = {};
  const dropped = [];
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [id, style] of Object.entries(map)) {
      if (!isValidStyleId(id)) { dropped.push({ id, reason: "id 格式不合（小寫英數與連字號、1–40）" }); continue; }
      if (isBuiltin(id)) { dropped.push({ id, reason: "撞內建款式 id" }); continue; }
      try { styles[id] = validateCardStyle(style); } catch (e) { dropped.push({ id, reason: String(e.message || e) }); }
    }
  }
  return { styles, dropped };
}

// 解析 appearance id → style 物件（內建優先，再查專案自訂）；查無＝null（呼叫端退回預設）。
export function resolveStyle(id, cardStyles) {
  if (isBuiltin(id)) return BUILTIN_STYLES[id];
  if (id && cardStyles && typeof cardStyles === "object" && cardStyles[id]) return cardStyles[id];
  return null;
}

// 純函式：style 物件 → { cls, vars }（前端套用；裁定 2 只出 class 與 CSS 變數）。
// style 為 null/classic＝零覆寫（cls 空、vars 空），舊卡完全不變。
export function styleToAttrs(style) {
  if (!style || style.base === "classic" && !Object.keys(style.tokens || {}).length
      && style.density === "comfortable" && style.shape === "rounded" && style.header === "plain") {
    return { cls: "", vars: {} };
  }
  const cls = ["sty",
    `sty-base-${style.base}`,
    `sty-density-${style.density}`,
    `sty-shape-${style.shape}`,
    `sty-header-${style.header}`];
  const tk = style.tokens || {};
  if (tk.border) cls.push(`sty-border-${tk.border}`);
  if (tk.shadow) cls.push(`sty-shadow-${tk.shadow}`);
  if (tk.surface) cls.push(`sty-surface-${tk.surface}`);
  const vars = {};
  if (tk.accent) { cls.push("sty-accent"); vars["--sty-accent"] = tk.accent; } // 唯一色碼變數，已驗為 hex
  return { cls: cls.join(" "), vars };
}

// 有效 appearance id：card.data.appearance → 板預設 → classic（裁定 4 的退回鏈）。
export function effectiveAppearance(cardAppearance, boardDefault, cardStyles) {
  for (const id of [cardAppearance, boardDefault, DEFAULT_APPEARANCE]) {
    if (id && resolveStyle(id, cardStyles)) return id;
  }
  return DEFAULT_APPEARANCE;
}
