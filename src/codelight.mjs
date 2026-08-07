// 內建閱讀器的輕量語法上色——零依賴（不引 highlight.js/prism）。
// 粗略、跨語言：逐檔片段 tokenize，追蹤區塊註解跨行狀態。回傳「每行 → token 陣列」，
// token = { t:文字, c?:類別 }，類別 kw/str/com/num（無類別＝一般文字）。故意只求「看得出結構」。

const KEYWORDS = new Set((
  "function return if else for while const let var import from export default class extends new this " +
  "async await try catch finally throw typeof instanceof in of do switch case break continue delete " +
  "null true false undefined void yield static get set public private protected interface type enum " +
  "implements def elif except with as pass lambda print fn pub struct impl match use mod mut where " +
  "trait package func range go defer chan select and or not is None True False self len int str bool " +
  "float list dict set tuple require module namespace readonly abstract override virtual using"
).split(/\s+/));

// 依副檔名決定註解語法（其餘沿 C 系）。
function commentCfg(lang) {
  if (["py", "pyw", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "r", "pl", "conf"].includes(lang)) return { line: "#", block: null };
  if (["sql", "lua", "hs", "elm", "ada"].includes(lang)) return { line: "--", block: null };
  if (["css", "scss", "less"].includes(lang)) return { line: null, block: ["/*", "*/"] };
  return { line: "//", block: ["/*", "*/"] }; // js/ts/jsx/tsx/java/c/cpp/go/rust/cs…
}

const isWord = (ch) => ch !== undefined && /[\w$]/.test(ch);
const isDigit = (ch) => ch !== undefined && ch >= "0" && ch <= "9";

function scanLine(line, cfg, state) {
  const out = [];
  let plain = "";
  const flush = () => { if (plain) { out.push({ t: plain }); plain = ""; } };
  const push = (t, c) => { if (!t) return; flush(); out.push({ t, c }); };
  let i = 0; const n = line.length;
  while (i < n) {
    if (state.inBlock) { // 續接跨行區塊註解
      const e = line.indexOf(cfg.block[1], i);
      if (e < 0) { push(line.slice(i), "com"); i = n; }
      else { push(line.slice(i, e + 2), "com"); i = e + 2; state.inBlock = false; }
      continue;
    }
    if (cfg.block && line.startsWith(cfg.block[0], i)) { // 區塊註解開始
      const e = line.indexOf(cfg.block[1], i + 2);
      if (e < 0) { push(line.slice(i), "com"); i = n; state.inBlock = true; }
      else { push(line.slice(i, e + 2), "com"); i = e + 2; }
      continue;
    }
    if (cfg.line && line.startsWith(cfg.line, i)) { push(line.slice(i), "com"); i = n; continue; } // 行註解
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") { // 字串（含跳脫）
      let j = i + 1;
      while (j < n) { if (line[j] === "\\") { j += 2; continue; } if (line[j] === ch) { j += 1; break; } j += 1; }
      push(line.slice(i, j), "str"); i = j; continue;
    }
    if (isDigit(ch) && !isWord(line[i - 1])) { // 數字（詞首才算，避免 abc123 拆解）
      let j = i; while (j < n && /[0-9a-fA-FxX._]/.test(line[j])) j += 1;
      push(line.slice(i, j), "num"); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) { // 識別字／關鍵字
      let j = i; while (j < n && isWord(line[j])) j += 1;
      const w = line.slice(i, j);
      if (KEYWORDS.has(w)) push(w, "kw"); else plain += w;
      i = j; continue;
    }
    plain += ch; i += 1; // 其餘（空白、標點）併入一般文字
  }
  flush();
  return out;
}

// lines: 字串陣列 → 每行 token 陣列。跨行追蹤區塊註解。
export function highlight(lines, lang) {
  const cfg = commentCfg(String(lang || "").toLowerCase());
  const state = { inBlock: false };
  return (lines || []).map((l) => scanLine(l ?? "", cfg, state));
}
