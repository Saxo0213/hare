// B16 Codebase 反向分析成板：把一個目錄樹反向生成 HARE 白板結構。
// 零依賴（純 node:fs / node:path，不引任何 AST 套件——import 依賴線用正則）。
//
// 對應模型（skill hare-nested-architecture「容器·子畫布」）：
//   目錄 → 容器卡（note）；容器子畫布裡的子卡 = 該目錄底下的檔案。
//   目錄樹 → 巢狀容器樹（子目錄 = 父目錄容器的子卡，同時自己也是容器）。
//   檔案卡 refs:[{path,label}] 指回原始碼（path 相對於分析根目錄，正斜線）。
//
// 規模控制（導入流程缺口）：「架構圖」是架構、不是每個檔案——
//   · opts.gitignore（預設 true）：尊重分析根的 .gitignore（子集：*/**/?/錨定/目錄限定；
//     否定樣式 ! 不支援＝寧可少忽略）＋內建 DEFAULT_IGNORE。
//   · opts.maxDepth（預設 6）：超過深度的子目錄不展開，改一張「未展開」卡。
//   · opts.perDir（預設 25）：單一目錄檔案卡上限，超出聚合成一張「… 其餘 N 檔」摘要卡。
//   · opts.maxFiles（預設 400）：全板檔案卡總量上限，觸頂後其餘檔案計入所屬目錄摘要卡。
//
// 版面（二版，整合 dagre/Sugiyama skill 精華，見 lib/layout.mjs layoutLayered）：
//   · 頂層＝分析根的「直接子目錄」各自成獨立容器（不再全部塞進一個巨型根容器），
//     根目錄自己的檔案歸入一個以根目錄命名的容器；一條泳道框住全部（架構區）。
//   · 頂層容器依「聚合 import 依賴」跑分層排版（左→右＝被依賴→依賴者，barycenter 減交叉）。
//   · 跨頂層容器的檔案 import 聚合成「容器→容器」一條線（label import ×N）——
//     不再滿版蜘蛛網；同容器內的檔案線保留。
//   · 容器內：子目錄容器直向堆疊（bottom-up 估高），檔案多於 8 張改多欄網格。
//   · childTop/childZoneH/minW 等精確值仍交給前端量測收斂；估值只需「不低估」。
// HARE b16aa100 analyzeCodebase
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, join, relative, dirname, basename, sep } from "node:path";
import { layoutLayered } from "./layout.mjs";

const DEFAULT_IGNORE = ["node_modules", ".git", "dist"];

// 版面常數：頂層容器起點；子卡 x 固定、y 依估高堆疊。
const X0 = 60, Y0 = 60;
const CHILD_X = 16, CHILD_Y0 = 60, CHILD_GAP = 14;
// 渲染尺寸估值（寧可高估留白，不可低估重疊）：檔案卡／摘要卡／未展開目錄卡；
// 容器卡＝表頭區＋子卡堆疊＋子畫布下緣留白。多欄網格：檔案 >MAX_COL_ROWS 張換欄。
const EST_FILE_H = 100, EST_MORE_H = 100, EST_STUB_H = 110;
const EST_DIR_HEAD = 170, EST_DIR_TAIL = 60, EST_DIR_MIN = 200;
const EST_CHILD_W = 264, EST_FILE_W = 240, MAX_COL_ROWS = 8, EST_DIR_MIN_W = 300;
const INNER_RANKSEP = 110, INNER_NODESEP = 56, INNER_EDGESEP = 50; // 容器內分層間距
// （nodesep/edgesep 放大＝為直連線讓出卡片間走廊，盡量不壓線）
const EST_RES_BASE = 120, EST_RES_LINE = 17, RES_LIST_MAX = 12; // 資源卡：表頭＋清單行高
const EST_DEP_H = 96, DEP_REFS_MAX = 6;                          // 依賴卡（refs 摺疊列）

// JS 家族副檔名（DEP_LANGS 首列＝依賴線掃描；也是 CODE_LIKE 基底），
// 以及解析相對 specifier 時嘗試補的副檔名／index。
const CODE_EXT = new Set([".mjs", ".js", ".jsx", ".cjs", ".ts", ".tsx"]);
const RESOLVE_EXT = ["", ".mjs", ".js", ".jsx", ".cjs", ".ts", ".tsx", ".json"];
// 廣義「程式碼檔」副檔名——資源目錄判定用。認得夠廣，否則純 Python/Go/Java…
// 的子目錄會整棵被誤判成資源夾折疊，變成「只掃根層」。
// import 線掃 DEP_LANGS 有列的語言；這裡只影響「展開 vs 摺清單」。
const CODE_LIKE = new Set([...CODE_EXT,
  ".py", ".ipynb", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".swift", ".lua", ".scala", ".dart",
  ".vue", ".svelte", ".sh", ".bat", ".ps1", ".psm1", ".sql", ".r"]);
const MAX_SCAN_BYTES = 512 * 1024; // 超大檔不掃 import（避免讀進超大二進位/壓縮檔）

// 從一段原始碼抽出所有 import/require specifier（字串字面值）。純正則，不解析語法。
function extractSpecifiers(src) {
  const specs = [];
  const patterns = [
    /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g, // import x from 'y' / export ... from 'y'
    /import\s*['"]([^'"]+)['"]/g,                          // import 'y'（副作用匯入）
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,                  // require('y')
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,                   // 動態 import('y')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

// 把相對 specifier 解析成分析範圍內的實體檔絕對路徑（命中 fileNodeByPath 才算數）。
function resolveRelative(importerAbs, spec, fileNodeByPath) {
  if (!spec.startsWith(".")) return null; // 只認相對匯入；套件略過
  const baseAbs = resolve(dirname(importerAbs), spec);
  for (const ext of RESOLVE_EXT) {
    const p = baseAbs + ext;
    if (fileNodeByPath.has(p)) return p;
  }
  // 目錄匯入 → index.*
  for (const ext of RESOLVE_EXT) {
    if (!ext) continue;
    const p = join(baseAbs, "index" + ext);
    if (fileNodeByPath.has(p)) return p;
  }
  return null;
}

// ---- 依賴線語言表：語言＝資料列，加語言＝加一列，主流程只查表。
// extract(src)→specifier 字串陣列；resolveLocal(importerAbs, spec, byAbs, ctx)→分析範圍內
// 實體檔絕對路徑（byAbs 命中才算數）或 null；externalName(spec, ctx)→外部套件名（依賴卡）
// 或 null＝略過。ctx＝{root, cache}（每次分析一份，放 go.mod 這類每 run 事實）。
// 主流程保證 resolveLocal 先於 externalName（沒解析到本地檔才問外部名）。
// 純正則、抽不出的誠實跳過，不猜語意。
// HARE d3pl4ng5 depLangs
const DEP_LANGS = [
  {
    // JS/TS 家族：相對 specifier＝檔內解析；其餘＝外部套件（node: 原樣、@scope 取兩段）
    exts: CODE_EXT,
    extract: extractSpecifiers,
    resolveLocal: (importerAbs, spec, byAbs) => resolveRelative(importerAbs, spec, byAbs),
    externalName: (spec) => {
      if (spec.startsWith(".")) return null;
      return spec.startsWith("node:") ? spec
        : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0] || null;
    },
  },
  {
    // Python：import a.b／from a.b import x；點號模組路徑→ a/b.py 或套件 a/b/__init__.py
    exts: new Set([".py"]),
    extract: (src) => {
      const specs = [];
      let m;
      const fromRe = /^\s*from\s+([.\w]+)\s+import\s+/gm;
      while ((m = fromRe.exec(src))) specs.push(m[1]);
      const impRe = /^\s*import\s+(.+)$/gm; // import a, b.c as d → 逗號切段、去 as 別名
      while ((m = impRe.exec(src))) {
        for (const part of m[1].split(",")) {
          const name = part.trim().split(/\s+/)[0];
          if (/^[\w.]+$/.test(name)) specs.push(name);
        }
      }
      return specs;
    },
    resolveLocal: (importerAbs, spec, byAbs, ctx) => {
      const tryMod = (baseAbs, parts) => {
        const stem = parts.length ? join(baseAbs, ...parts) : baseAbs;
        const cands = parts.length
          ? [stem + ".py", join(stem, "__init__.py")]
          : [join(stem, "__init__.py")]; // from . import x ＝本套件 __init__
        for (const p of cands) if (byAbs.has(p)) return p;
        return null;
      };
      const dots = (spec.match(/^\.+/) || [""])[0].length;
      const parts = spec.slice(dots).split(".").filter(Boolean);
      if (dots) { // 相對匯入：一點＝本套件，之後每多一點上一層
        let base = dirname(importerAbs);
        for (let i = 1; i < dots; i += 1) base = dirname(base);
        return tryMod(base, parts);
      }
      // 絕對模組路徑：先從分析根找，再退回引用檔同層（sys.path 常見兩種佈局）
      return tryMod(ctx.root, parts) || tryMod(dirname(importerAbs), parts);
    },
    externalName: (spec) => (spec.startsWith(".") ? null : spec.split(".")[0] || null),
  },
  {
    // Go：import 單行＋( ) 區塊；同 module（go.mod module 前綴）→ 套件目錄→代表檔
    exts: new Set([".go"]),
    extract: (src) => {
      const specs = [];
      let m;
      const single = /^import\s+(?:[A-Za-z_]\w*\s+|\.\s+)?"([^"]+)"/gm;
      while ((m = single.exec(src))) specs.push(m[1]);
      const block = /^import\s*\(([^)]*)\)/gm;
      while ((m = block.exec(src))) {
        const qre = /"([^"]+)"/g;
        let q;
        while ((q = qre.exec(m[1]))) specs.push(q[1]);
      }
      return specs;
    },
    resolveLocal: (importerAbs, spec, byAbs, ctx) => {
      if (!ctx.cache.has("goModule")) {
        let mod = null;
        try { mod = (readFileSync(join(ctx.root, "go.mod"), "utf8").match(/^module\s+(\S+)/m) || [])[1] || null; } catch { /* 無 go.mod */ }
        ctx.cache.set("goModule", mod);
      }
      const mod = ctx.cache.get("goModule");
      if (!mod || (spec !== mod && !spec.startsWith(mod + "/"))) return null;
      const relParts = spec === mod ? [] : spec.slice(mod.length + 1).split("/");
      const dirAbs = join(ctx.root, ...relParts);
      // 套件＝目錄：代表檔取「目錄同名.go」，否則字典序第一個直屬 .go 檔
      const named = join(dirAbs, basename(dirAbs) + ".go");
      if (byAbs.has(named)) return named;
      const prefix = dirAbs + sep;
      const cands = [...byAbs.keys()]
        .filter((p) => p.startsWith(prefix) && p.endsWith(".go") && !p.slice(prefix.length).includes(sep))
        .sort();
      return cands[0] || null;
    },
    externalName: (spec, ctx) => {
      const mod = ctx.cache.get("goModule");
      if (mod && (spec === mod || spec.startsWith(mod + "/"))) return null; // 同 module 沒命中＝檔不在板上，不算外部
      const segs = spec.split("/");
      return segs[0].includes(".") ? segs.slice(0, 3).join("/") : spec; // 網域開頭取前三段；其餘＝標準庫路徑
    },
  },
  {
    // Rust：mod 宣告→同層檔/子目錄；use crate/self/super 路徑→ .rs 或 mod.rs；其餘＝外部 crate
    exts: new Set([".rs"]),
    extract: (src) => {
      const specs = [];
      let m;
      const modRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;
      while ((m = modRe.exec(src))) specs.push(`mod ${m[1]}`);
      const useRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm;
      while ((m = useRe.exec(src))) specs.push(m[1]);
      return specs;
    },
    resolveLocal: (importerAbs, spec, byAbs, ctx) => {
      const dir = dirname(importerAbs);
      if (spec.startsWith("mod ")) {
        const name = spec.slice(4);
        const cands = [join(dir, `${name}.rs`), join(dir, name, "mod.rs"),
          join(dir, basename(importerAbs, ".rs"), `${name}.rs`)]; // Rust 2018：foo.rs 的子模組在 foo/ 下
        for (const p of cands) if (byAbs.has(p)) return p;
        return null;
      }
      const segs = spec.split("::").filter(Boolean);
      const head = segs[0];
      const bases = head === "crate" ? [join(ctx.root, "src"), ctx.root]
        : head === "self" ? [dir]
        : head === "super" ? [dirname(dir)]
        : null; // 外部 crate——交給 externalName
      if (!bases) return null;
      const parts = segs.slice(1);
      // 尾段可能是符號不是模組：整段與去尾各試 <path>.rs 與 <path>/mod.rs
      for (const cut of [parts, parts.slice(0, -1)]) {
        if (!cut.length) continue;
        for (const base of bases) {
          const stem = join(base, ...cut);
          for (const p of [`${stem}.rs`, join(stem, "mod.rs")]) if (byAbs.has(p)) return p;
        }
      }
      return null;
    },
    externalName: (spec) => {
      if (spec.startsWith("mod ")) return null;
      const head = spec.split("::")[0];
      return head && !["crate", "self", "super"].includes(head) ? head : null;
    },
  },
  {
    // Java/Kotlin：import a.b.C → 檔案路徑尾綴 a/b/C.java|.kt 比對；a.b.* 不猜代表檔
    exts: new Set([".java", ".kt", ".kts"]),
    extract: (src) => {
      const specs = [];
      let m;
      const re = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/gm;
      while ((m = re.exec(src))) specs.push(m[1]);
      return specs;
    },
    resolveLocal: (importerAbs, spec, byAbs) => {
      if (spec.endsWith(".*")) return null;
      const parts = spec.split(".").filter(Boolean);
      // static import 尾段可能是成員名：整段與去尾各試一次
      for (const cut of [parts, parts.slice(0, -1)]) {
        if (!cut.length) continue;
        for (const ext of [".java", ".kt"]) {
          const suffix = sep + cut.join(sep) + ext;
          for (const p of byAbs.keys()) if (p.endsWith(suffix)) return p;
        }
      }
      return null;
    },
    externalName: (spec) => {
      const segs = spec.replace(/\.\*$/, "").split(".").filter(Boolean);
      return segs.slice(0, 2).join(".") || null; // 依賴卡聚在前兩段（java.util、com.google…）
    },
  },
];
// HARE-END d3pl4ng5

// ---- 介面掃描（scan_interfaces 資料工具）----
// 機械抽取「語法層事實」：每檔的對外宣告（exports）與 import 進來的符號名，
// 給 agent 畫模組介面圖等語意板用——agent 拿掃描事實分組取捨，不重讀全部原始碼。
// 純正則、語言＝資料列（表格驅動）；抽不出的誠實跳過，不猜語意。
// HARE 5c4nifa1 scanInterfaces
const IFACE_LANGS = [
  {
    exts: new Set([".mjs", ".js", ".jsx", ".cjs", ".ts", ".tsx"]),
    exportRes: [
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /export\s+class\s+([A-Za-z_$][\w$]*)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
      /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g,
    ],
    exportListRe: /export\s*\{([^}]*)\}/g,   // export { a, b as c }
    exportDefaultRe: /export\s+default\b/,
    importRes: [
      { re: /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g, list: 1, from: 2 },
      { re: /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g, name: 1, list: 2, from: 3 },
      { re: /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g, name: 1, from: 2 },
      { re: /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g, list: 1, from: 2 },
      { re: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g, name: 1, from: 2 },
      { re: /import\s*['"]([^'"]+)['"]/g, from: 1 }, // 副作用匯入：symbols 空
    ],
  },
  {
    exts: new Set([".py"]),
    exportRes: [/^def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
    importRes: [
      { re: /^from\s+(\S+)\s+import\s+(.+)$/gm, from: 1, list: 2 },
      { re: /^import\s+(\S+)(?:\s+as\s+(\w+))?/gm, from: 1, name: 2 },
    ],
  },
  {
    // Go：匯出＝大寫開頭的頂層 func/type；import 單行與 ( ) 區塊內逐行（別名＝symbol，無別名＝整包）
    exts: new Set([".go"]),
    exportRes: [/^func\s+([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
    importRes: [
      { re: /^import\s+(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm, name: 1, from: 2 },
      // 區塊內一行一句：行首縮排＋可選別名＋路徑字串收尾（Go 語法裡字串不能單獨成陳述式，撞衫風險低）
      { re: /^[ \t]+(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"\s*(?:\/\/.*)?$/gm, name: 1, from: 2 },
    ],
  },
  {
    // Rust：匯出＝pub fn/struct/enum（pub(crate) 不算對外）；use 路徑（{...} 清單、單項含 as、::* 整包）
    exts: new Set([".rs"]),
    exportRes: [
      /pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/g,
      /pub\s+struct\s+([A-Za-z_]\w*)/g,
      /pub\s+enum\s+([A-Za-z_]\w*)/g,
    ],
    importRes: [
      { re: /^\s*use\s+([A-Za-z_][\w:]*)::\{([^}]*)\}\s*;/gm, from: 1, list: 2 },
      { re: /^\s*use\s+([A-Za-z_][\w:]*)::\*\s*;/gm, from: 1 },
      { re: /^\s*use\s+([A-Za-z_][\w:]*)::(\w+(?:\s+as\s+\w+)?)\s*;/gm, from: 1, list: 2 },
    ],
  },
  {
    // Java/Kotlin：匯出＝public class/interface；import a.b.C（Kotlin 可無分號、as 別名）、a.b.* 整包
    exts: new Set([".java", ".kt", ".kts"]),
    exportRes: [
      /public\s+(?:(?:abstract|final|static|sealed|open|data)\s+)*class\s+([A-Za-z_]\w*)/g,
      /public\s+(?:(?:abstract|sealed)\s+)*interface\s+([A-Za-z_]\w*)/g,
    ],
    importRes: [
      { re: /^import\s+(?:static\s+)?([\w.]+)\.\*\s*;?\s*$/gm, from: 1 },
      { re: /^import\s+(?:static\s+)?([\w.]+)\.(\w+(?:\s+as\s+\w+)?)\s*;?\s*$/gm, from: 1, list: 2 },
    ],
  },
];
// 「a, b as c」→ ["a","c"]（取 as 後別名；過濾非識別字，寧缺勿濫）
const splitNames = (s) => String(s || "").split(",")
  .map((x) => x.trim().split(/\s+as\s+/).pop().trim())
  .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));

/**
 * 掃描目錄樹的模組介面：每檔 exports 與 import 符號。回傳
 * { root, files: [{path, exports, imports:[{from, symbols}]}], stats }。
 * symbols 空陣列＝整包引入（import x / 副作用匯入）。
 */
export function scanInterfaces(rootPath, opts = {}) {
  const root = resolve(rootPath);
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`scanInterfaces 需要目錄路徑：${rootPath}`);
  const ignore = new Set(opts.ignore || DEFAULT_IGNORE);
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 400;
  const ignoreMatch = (opts.gitignore !== false) ? gitignoreMatcher(loadGitignore(root)) : () => false;
  const files = [];
  const extOf = (name) => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i).toLowerCase(); };
  const walk = (absDir) => {
    if (files.length >= maxFiles) return;
    let entries = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (ignore.has(e.name)) continue;
      const abs = join(absDir, e.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (ignoreMatch(rel, e.isDirectory())) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      const lang = IFACE_LANGS.find((l) => l.exts.has(extOf(e.name)));
      if (!lang) continue;
      let src = "";
      try {
        if (statSync(abs).size > MAX_SCAN_BYTES) continue;
        src = readFileSync(abs, "utf8");
      } catch { continue; }
      const exportsSet = new Set();
      for (const re of lang.exportRes) { re.lastIndex = 0; let m; while ((m = re.exec(src))) exportsSet.add(m[1]); }
      if (lang.exportListRe) { lang.exportListRe.lastIndex = 0; let m; while ((m = lang.exportListRe.exec(src))) splitNames(m[1]).forEach((n) => exportsSet.add(n)); }
      if (lang.exportDefaultRe && lang.exportDefaultRe.test(src)) exportsSet.add("default");
      const imports = new Map(); // from → Set<symbol>
      for (const spec of lang.importRes) {
        spec.re.lastIndex = 0; let m;
        while ((m = spec.re.exec(src))) {
          const from = m[spec.from];
          if (!from) continue;
          if (!imports.has(from)) imports.set(from, new Set());
          const set = imports.get(from);
          if (spec.name && m[spec.name]) set.add(m[spec.name]);
          if (spec.list && m[spec.list]) splitNames(m[spec.list]).forEach((n) => set.add(n));
        }
      }
      files.push({ path: rel, exports: [...exportsSet],
        imports: [...imports.entries()].map(([from, set]) => ({ from, symbols: [...set] })) });
    }
  };
  walk(root);
  return {
    root: root.split("\\").join("/"), files,
    stats: { files: files.length,
      exports: files.reduce((s, f) => s + f.exports.length, 0),
      imports: files.reduce((s, f) => s + f.imports.length, 0), maxFiles },
  };
}

// ---- .gitignore 子集比對（零依賴；HARE b16g17i9 gitignore）----
// 支援：註解/空行略過、* ? **、結尾 /（目錄限定）、開頭 /（root 錨定）、含斜線＝路徑比對、
// 無斜線＝任一層名稱比對。不支援否定 !（略過該行＝寧可少忽略，不誤殺）。
function loadGitignore(root) {
  try {
    return readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
  } catch { return []; }
}
function gitignoreMatcher(patterns) {
  const rules = patterns.map((p) => {
    const dirOnly = p.endsWith("/");
    let pat = dirOnly ? p.slice(0, -1) : p;
    const anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);
    const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const rx = pat.split("**").map((seg) =>
      seg.split("*").map((star) => star.split("?").map(esc).join("[^/]")).join("[^/]*")
    ).join(".*");
    const hasSlash = pat.includes("/");
    const re = (anchored || hasSlash) ? new RegExp(`^${rx}(/|$)`) : new RegExp(`(^|/)${rx}(/|$)`);
    return { re, dirOnly };
  });
  return (relPath, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(relPath));
}

// B21 Phase 2：HARE 錨點反查（uuid → 檔案＋行號）。walk 沿 scanInterfaces 慣例
// （DEFAULT_IGNORE＋.gitignore 子集、MAX_SCAN_BYTES 大檔保護）；逐行找「HARE <uuid>」
// 宣告行（HARE-END 行不算宣告），一併回 end_line（成對區塊終點）。正常恰一筆命中；
// >1＝錨點重複（誠實全部回報，交呼叫端處置）。
// HARE b21a4c02 findAnchor
export function findAnchor(rootPath, uuid, opts = {}) {
  const root = resolve(rootPath);
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`findAnchor 需要目錄路徑：${rootPath}`);
  const ignore = new Set(opts.ignore || DEFAULT_IGNORE);
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 4000;
  const ignoreMatch = (opts.gitignore !== false) ? gitignoreMatcher(loadGitignore(root)) : () => false;
  const needle = `HARE ${uuid}`;
  const endNeedle = `HARE-END ${uuid}`;
  const hits = [];
  let scanned = 0;
  const walk = (absDir) => {
    if (scanned >= maxFiles) return;
    let entries = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (scanned >= maxFiles) return;
      if (ignore.has(e.name)) continue;
      const abs = join(absDir, e.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (ignoreMatch(rel, e.isDirectory())) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      let src = "";
      try {
        if (statSync(abs).size > MAX_SCAN_BYTES) continue;
        scanned += 1;
        src = readFileSync(abs, "utf8");
      } catch { continue; }
      if (!src.includes(needle) || src.includes("\u0000")) continue; // \0＝二進位保險
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const idx = lines[i].indexOf(needle);
        if (idx < 0 || lines[i].includes(endNeedle)) continue;
        // 標籤＝needle 之後的文字，剝掉註解收尾符（CSS */、HTML -->）
        const label = lines[i].slice(idx + needle.length).replace(/\*\/\s*$|-->\s*$/, "").trim() || null;
        const ei = lines.findIndex((l, k) => k > i && l.includes(endNeedle));
        hits.push({ path: rel, line: i + 1, label, ...(ei > i ? { end_line: ei + 1 } : {}) });
      }
    }
  };
  walk(root);
  return { uuid, count: hits.length, matches: hits, scanned };
}

/**
 * 反向分析一個目錄樹，產出可直接寫入 store 的白板結構。
 * @param {string} rootPath 要分析的目錄（絕對或相對；內部一律 resolve 成絕對）。
 * @param {object} [opts]
 * @param {string[]} [opts.ignore] 忽略的目錄/檔名（預設 node_modules/.git/dist）。
 * @param {boolean} [opts.imports=true] 是否用正則生成 import/require 依賴線。
 * @param {boolean} [opts.gitignore=true] 是否尊重分析根的 .gitignore（子集）。
 * @param {number} [opts.maxDepth=6] 目錄展開深度上限（根＝0）；超過改「未展開」卡。
 * @param {number} [opts.perDir=25] 單一目錄檔案卡上限；超出聚合「… 其餘 N 檔」摘要卡。
 * @param {number} [opts.maxFiles=400] 全板檔案卡總量上限；觸頂後計入摘要卡。
 * @returns {{ nodes: object[], edges: object[], stats: object }}
 */
export function analyzeCodebase(rootPath, opts = {}) {
  const root = resolve(rootPath);
  const st = statSync(root); // 不存在會丟錯——交給呼叫端
  if (!st.isDirectory()) throw new Error(`analyzeCodebase 需要目錄路徑：${rootPath}`);

  const ignore = new Set(opts.ignore || DEFAULT_IGNORE);
  const doImports = opts.imports !== false;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 6;
  const perDir = Number.isFinite(opts.perDir) ? opts.perDir : 25;
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 400;
  const ignoreMatch = (opts.gitignore !== false) ? gitignoreMatcher(loadGitignore(root)) : () => false;

  const nodes = [];
  const edges = [];
  const fileNodeByPath = new Map(); // 絕對檔案路徑 → { id, topId }（topId＝所屬頂層容器）
  const codeFiles = [];             // {abs, id, topId, specs, lang} 待掃 import 的程式碼檔
  const langCtx = { root, cache: new Map() }; // DEP_LANGS 解析器共用（go.mod 等每 run 事實）
  // id 帶 per-run 戳記：確定性 an_1..an_N 會讓跨次生成的 id 相同，若有瀏覽器分頁
  // 還開著舊板，其推送會經合併寫入「同 id 覆寫」新卡——新舊版面攪混。
  const runTag = Date.now().toString(36);
  let seq = 0;
  const nextId = () => `an${runTag}_${(seq += 1)}`;
  let filesAdded = 0;               // 全板檔案卡數（maxFiles 上限用）
  let skippedFiles = 0;             // 聚合/觸頂而未成卡的檔案數
  let prunedDirs = 0;               // 因 maxDepth 未展開的目錄數

  // 相對於分析根、正斜線路徑（root 自身則用其 basename）。
  const toRel = (abs) => {
    const r = relative(root, abs).split("\\").join("/");
    return r === "" ? basename(root) : r;
  };
  // import 線（共用建構）：source→target＝引用者→被引用（入口在左、順查詢動線
  // 左→右，排版分欄依此）。箭頭＝注入方向——被引用者注入引用者，故畫在起點端、
  // 指向引用者（markerStart + auto-start-reverse）。線型＝一般曲線——演算法只調
  // 卡片位置、不彎折線段。
  const seenEdge = new Set(); // 去重：同一對 source→target 只連一條（含容器內先建的）
  const mkEdge = (source, target, label) => {
    const e = {
      id: `e_${edges.length + 1}`, source, target,
      type: "default", label,
      style: { stroke: "#c47d0a", strokeWidth: 1.6 },
      markerStart: { type: "arrowclosed", color: "#c47d0a", orient: "auto-start-reverse" },
      sourceHandle: "r-src", targetHandle: "l-tgt",
      // B9 邊語意：機械抽取的 import 線落盤 relation=imports、evidence.source=scan、tier=extracted。
      data: { relation: "imports", confidenceTier: "extracted", evidence: { source: "scan" } },
    };
    edges.push(e);
    return e;
  };
  // .gitignore 比對用：root 自身＝空字串（不比對）。
  const toRelRaw = (abs) => relative(root, abs).split("\\").join("/");

  const listEntries = (absDir) => {
    let entries = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { /* 權限等＝空 */ }
    const keep = (e, isDir) => {
      if (ignore.has(e.name)) return false;
      return !ignoreMatch(toRelRaw(join(absDir, e.name)), isDir);
    };
    return {
      dirs: entries.filter((e) => e.isDirectory() && keep(e, true)).sort((a, b) => a.name.localeCompare(b.name)),
      files: entries.filter((e) => e.isFile() && keep(e, false)).sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  // 資源目錄判定：目錄樹內完全沒有程式碼檔
  // ＝資源類內容（docs/、data/、assets/…）→ 不展開成容器＋子卡，改一張資源卡
  // 列出內容清單。預算/深度保護：掃不完＝保守當「含程式碼」照常展開。
  // HARE 2e50c4d3 isResourceDir
  const isResourceDir = (absDir) => {
    let budget = 400;
    const noCode = (d, depth) => {
      if (depth > 4 || budget <= 0) return false;
      let entries = [];
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return true; }
      for (const e of entries) {
        if (budget-- <= 0) return false;
        if (ignore.has(e.name)) continue;
        if (ignoreMatch(toRelRaw(join(d, e.name)), e.isDirectory())) continue;
        if (e.isFile()) {
          // 廣義程式碼副檔名（CODE_LIKE）——只認 JS 會把純 Python/Go… 子樹誤判成資源夾
          if (CODE_LIKE.has(e.name.slice(e.name.lastIndexOf(".")).toLowerCase())) return false;
        } else if (e.isDirectory() && !noCode(join(d, e.name), depth + 1)) return false;
      }
      return true;
    };
    return noCode(absDir, 0);
  };

  // 資源卡：資料夾內容清單（前 RES_LIST_MAX 項＋「…其餘 N 項」）。回傳 {node, estH, estW}。
  const buildResCard = (absDir, parentId) => {
    const { dirs, files } = listEntries(absDir);
    const names = [...dirs.map((d) => `${d.name}/`), ...files.map((f) => f.name)];
    const listing = names.slice(0, RES_LIST_MAX);
    if (names.length > listing.length) listing.push(`… 其餘 ${names.length - listing.length} 項`);
    const node = {
      id: nextId(), type: "res", position: { x: CHILD_X, y: CHILD_Y0 },
      data: { label: basename(absDir) || absDir, status: "note", kind: "res", listing,
        refs: [{ path: toRel(absDir) }] }, // 資源卡 ref 只有路徑——標籤是程式碼定位用，資料夾無意義
      ...(parentId ? { parentId, extent: "parent" } : {}),
    };
    nodes.push(node);
    return { node, estH: EST_RES_BASE + listing.length * EST_RES_LINE, estW: EST_DIR_MIN_W };
  };

  // 目錄容器（可含子目錄容器＋檔案網格）。files 可由呼叫端指定（根檔案容器用）。
  // 回傳 { node, estH, estW }（bottom-up 估尺寸——排版與兄弟堆疊都靠它）。
  function buildDir(absDir, parentId, depth, topId, filesOverride, labelOverride) {
    const dirId = nextId();
    const top = topId || dirId; // 頂層容器＝自己
    const dirNode = {
      id: dirId,
      type: "note",
      position: { x: X0, y: Y0 }, // 頂層座標由 layoutLayered 事後決定；子容器由父層 place
      data: {
        label: labelOverride || basename(absDir) || absDir,
        status: "note",
        kind: "dir",
        refs: [{ path: toRel(absDir), label: basename(absDir) || absDir }],
      },
      ...(parentId ? { parentId, extent: "parent" } : {}),
    };
    nodes.push(dirNode);

    const listed = filesOverride ? { dirs: [], files: filesOverride } : listEntries(absDir);
    const { dirs, files } = listed;

    // ① 子目錄容器：直向堆疊（全寬）；資源目錄改資源卡；達 maxDepth 改「未展開」卡
    let y = CHILD_Y0;
    let maxW = EST_DIR_MIN_W;
    for (const d of dirs) {
      const absSub = join(absDir, d.name);
      if (isResourceDir(absSub)) {
        const r = buildResCard(absSub, dirId);
        r.node.position = { x: CHILD_X, y };
        y += r.estH + CHILD_GAP;
        maxW = Math.max(maxW, r.estW + CHILD_X * 2);
        continue;
      }
      if (depth + 1 > maxDepth) {
        prunedDirs += 1;
        let inner = 0;
        try { inner = readdirSync(absSub).length; } catch { /* 讀不到＝0 */ }
        nodes.push({
          id: nextId(), type: "note", position: { x: CHILD_X, y },
          data: { label: `${d.name}/`, status: "plan", kind: "dir",
            desc: `未展開（達 maxDepth=${maxDepth}；內含約 ${inner} 項）。需要時對此目錄另跑 analyze_codebase。`,
            refs: [{ path: toRel(absSub), label: d.name }] },
          parentId: dirId, extent: "parent",
        });
        y += EST_STUB_H + CHILD_GAP;
        continue;
      }
      const sub = buildDir(absSub, dirId, depth + 1, top);
      sub.node.position = { x: CHILD_X, y };
      y += sub.estH + CHILD_GAP;
      maxW = Math.max(maxW, sub.estW + CHILD_X * 2);
    }

    // ② 檔案（FX3 樣態）：先就地解析「同目錄 import」——有內部依賴的
    //    目錄改用 layoutLayered 分層排欄（入口在左、線沿 dagre 通道走不穿卡）；
    //    無內部依賴才走多欄網格。perDir/maxFiles 之外聚合成「… 其餘 N 檔」摘要卡。
    const rest = [];
    const gridItems = [];
    const dirFiles = []; // {id, abs, specs}（specs 快取給第二遍跨目錄解析重用）
    let shown = 0;
    for (const f of files) {
      if (shown >= perDir || filesAdded >= maxFiles) { rest.push(f.name); continue; }
      const abs = join(absDir, f.name);
      const fid = nextId();
      const fileNode = {
        id: fid, type: "note",
        data: { label: f.name, status: "note", kind: "file",
          refs: [{ path: toRel(abs), label: f.name }] },
        parentId: dirId, extent: "parent",
      };
      nodes.push(fileNode);
      gridItems.push({ node: fileNode, h: EST_FILE_H });
      shown += 1; filesAdded += 1;
      fileNodeByPath.set(abs, { id: fid, topId: top });
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      const depLang = doImports ? DEP_LANGS.find((l) => l.exts.has(ext)) : null;
      if (depLang) {
        let specs = [];
        try { if (statSync(abs).size <= MAX_SCAN_BYTES) specs = depLang.extract(readFileSync(abs, "utf8")); } catch { /* 略過 */ }
        dirFiles.push({ id: fid, abs, specs, lang: depLang });
        codeFiles.push({ abs, id: fid, topId: top, specs, lang: depLang });
      }
    }
    if (rest.length) {
      skippedFiles += rest.length;
      const names = rest.join("、");
      const moreNode = {
        id: nextId(), type: "note",
        data: { label: `… 其餘 ${rest.length} 檔`, status: "plan", kind: "more",
          desc: names.length > 300 ? `${names.slice(0, 300)}…` : names },
        parentId: dirId, extent: "parent",
      };
      nodes.push(moreNode);
      gridItems.push({ node: moreNode, h: EST_MORE_H });
    }
    if (gridItems.length) {
      // 同目錄內部依賴（相對 specifier 解析到本目錄檔案）
      const localByAbs = new Map(dirFiles.map((df) => [df.abs, { id: df.id }]));
      const inner = [];
      if (doImports) {
        for (const df of dirFiles) {
          for (const spec of df.specs) {
            const t = df.lang.resolveLocal(df.abs, spec, localByAbs, langCtx);
            if (!t) continue;
            const tid = localByAbs.get(t).id;
            if (tid === df.id) continue;
            const key = `${df.id}->${tid}`;
            if (seenEdge.has(key)) continue;
            seenEdge.add(key);
            inner.push({ source: df.id, target: tid });
          }
        }
      }
      if (inner.length) {
        // 有內部依賴＝分層排欄（入口在左、barycenter 減交叉）；線＝一般曲線，
        // 乾淨與否由卡片位置與間距負責（演算法不彎折線段）
        const items = gridItems.map((g) => ({ id: g.node.id, w: EST_FILE_W, h: g.h }));
        const { pos } = layoutLayered(items, inner,
          { x0: CHILD_X, y0: y, ranksep: INNER_RANKSEP, nodesep: INNER_NODESEP,
            edgesep: INNER_EDGESEP, compsep: 60 });
        let right = 0, bottom = y;
        gridItems.forEach((g) => {
          const p = pos.get(g.node.id);
          g.node.position = p;
          right = Math.max(right, p.x + EST_FILE_W);
          bottom = Math.max(bottom, p.y + g.h);
        });
        inner.forEach((e) => mkEdge(e.source, e.target, "import"));
        y = bottom + CHILD_GAP;
        maxW = Math.max(maxW, right + CHILD_X);
      } else {
        const cols = Math.max(1, Math.ceil(gridItems.length / MAX_COL_ROWS));
        const rows = Math.ceil(gridItems.length / cols);
        const gridY0 = y;
        let colBottom = 0;
        gridItems.forEach((g, i) => {
          const c = Math.floor(i / rows), r = i % rows;
          g.node.position = { x: CHILD_X + c * EST_CHILD_W, y: gridY0 + r * (EST_FILE_H + CHILD_GAP) };
          colBottom = Math.max(colBottom, g.node.position.y + g.h);
        });
        y = colBottom + CHILD_GAP;
        maxW = Math.max(maxW, CHILD_X * 2 + cols * EST_CHILD_W);
      }
    }

    // 容器估尺寸：表頭＋子卡堆疊＋下緣留白（無子卡＝最小容器）
    const stackH = y - CHILD_Y0;
    const estH = stackH > 0 ? EST_DIR_HEAD + stackH + EST_DIR_TAIL : EST_DIR_MIN;
    if (maxW > EST_DIR_MIN_W) dirNode.data.minW = maxW; // 預告寬度（前端 minW 只增不減）
    return { node: dirNode, estH, estW: maxW };
  }

  // ---- 頂層組裝（HARE b16t0p10 topAssembly）----
  // 根的直接子目錄各自成頂層容器；根自己的檔案歸入以根命名的容器；
  // 扁平目錄（無子目錄）＝單一根容器（向後相容，lib/ 這類小目錄最常見）。
  const rootListed = listEntries(root);
  const tops = []; // { node, estH, estW }
  if (rootListed.dirs.length === 0) {
    tops.push(buildDir(root, null, 0, null, rootListed.files));
  } else {
    for (const d of rootListed.dirs) {
      const absSub = join(root, d.name);
      if (isResourceDir(absSub)) { tops.push(buildResCard(absSub, null)); continue; }
      if (1 > maxDepth) { // maxDepth=0 的極端：全部縮成未展開——直接掛成頂層 stub 容器
        prunedDirs += 1;
        const t = buildDir(absSub, null, 1, null, []);
        tops.push(t);
        continue;
      }
      tops.push(buildDir(absSub, null, 1));
    }
    if (rootListed.files.length) {
      tops.push(buildDir(root, null, 0, null, rootListed.files, basename(root)));
    }
  }

  // 第二遍：全部檔案卡就緒後解析「跨目錄」import（同目錄的已在 buildDir 就地建線）。
  // 跨頂層容器的檔案線聚合成「容器→容器」一條（label import ×N）——滿版蜘蛛網的解方；
  // 同頂層容器內的跨目錄檔案線保留。specs 已於 buildDir 讀檔時快取，不重讀。
  const aggregate = new Map();  // `${srcTop}->${tgtTop}` → count
  const extDeps = new Map();    // 外部套件名 → Set<引用檔相對路徑>（依賴卡用）
  if (doImports) {
    for (const { abs, id, topId, specs, lang } of codeFiles) {
      for (const spec of specs || []) {
        const targetAbs = lang.resolveLocal(abs, spec, fileNodeByPath, langCtx);
        // 沒解析到本地檔＝外部 import（套件/內建模組）→ 記入依賴卡（各語言自訂套件名）
        if (!targetAbs) {
          const pkg = lang.externalName(spec, langCtx);
          if (pkg) {
            if (!extDeps.has(pkg)) extDeps.set(pkg, new Set());
            extDeps.get(pkg).add(toRel(abs));
          }
          continue;
        }
        const t = fileNodeByPath.get(targetAbs);
        if (t.id === id) continue; // 不自連
        if (t.topId !== topId) {   // 跨頂層容器 → 聚合
          const k = `${topId}->${t.topId}`;
          aggregate.set(k, (aggregate.get(k) || 0) + 1);
          continue;
        }
        const key = `${id}->${t.id}`;
        if (seenEdge.has(key)) continue; // 同目錄邊已建（buildDir）或重複
        seenEdge.add(key);
        mkEdge(id, t.id, "import");
      }
    }
    // 容器級聚合線的實際建線延後到河道分類之後——跨 ≥2 河道的改節點卡代理，
    // 不在這裡直畫（見 HARE 1a2ne5v3）。
  }

  // ---- 外部依賴容器（「依賴卡」）：一個套件一張 dep 卡（名稱＋引用程式
  // 路徑 refs，前 DEP_REFS_MAX 個），掛在「外部依賴」容器子畫布內網格堆疊；
  // 不建立子資源、不畫依賴線（refs 即連結）。參與頂層排版與編號。
  // HARE d3p0c4d3 depContainer
  if (extDeps.size) {
    const depBoxId = nextId();
    const depBox = {
      id: depBoxId, type: "note", position: { x: X0, y: Y0 },
      data: { label: "外部依賴", status: "plan", kind: "deps",
        desc: `程式 import 的外部套件／內建模組（自動偵測，共 ${extDeps.size} 個）` },
    };
    nodes.push(depBox);
    const pkgs = [...extDeps.entries()].sort((a, b) => b[1].size - a[1].size);
    const cols = Math.max(1, Math.ceil(pkgs.length / MAX_COL_ROWS));
    const rows = Math.ceil(pkgs.length / cols);
    let stackH = 0;
    pkgs.forEach(([pkg, importers], i) => {
      const c = Math.floor(i / rows), r = i % rows;
      nodes.push({
        id: nextId(), type: "dep",
        position: { x: CHILD_X + c * EST_CHILD_W, y: CHILD_Y0 + r * (EST_DEP_H + CHILD_GAP) },
        data: { label: pkg, status: "plan", kind: "dep",
          refs: [...importers].slice(0, DEP_REFS_MAX).map((p) => ({ path: p, label: p.split("/").pop() })) },
        parentId: depBoxId, extent: "parent",
      });
      stackH = Math.max(stackH, (r + 1) * (EST_DEP_H + CHILD_GAP));
    });
    const estW = Math.max(EST_DIR_MIN_W, CHILD_X * 2 + cols * EST_CHILD_W);
    if (cols > 1) depBox.data.minW = estW;
    tops.push({ node: depBox, estH: EST_DIR_HEAD + stackH + EST_DIR_TAIL, estW });
  }

  // ---- 頂層排版 v3（河道分類）：垂直河道＝分類帶，左→右＝
  // 入口層→（中間層…）→基礎層→外部依賴→資源。分類只用機械事實：
  //   · 程式容器依「容器級聚合依賴」的 rank 分河道（入口＝沒人引用它；環→回退 0）。
  //   · 資源卡、外部依賴容器各自成河道（不參與動線的先抽離主畫面）。
  // 跨河道連線：相鄰河道（span ≤1）主體相連（聚合 ×N 線照畫）；跨 ≥2 河道改
  // 節點卡代理（off-page connector）——來源主體右側就地放代理卡（data.proxyFor
  // ＝本尊 id，label 顯示本尊編號＋名稱），長線不再橫穿整個版面。
  // HARE 1a2ne5v3 topLanes
  const topEdges = [...aggregate.keys()].map((k) => { const [s, t] = k.split("->"); return { source: s, target: t }; });
  const isRes = (t) => t.node.type === "res";
  const isDeps = (t) => t.node.data?.kind === "deps";
  const codeTops = tops.filter((t) => !isRes(t) && !isDeps(t));
  // rank：入口（無 incoming）＝0，其餘＝max(引用者 rank)+1（走訪保護防環）
  const topPreds = new Map(codeTops.map((t) => [t.node.id, []]));
  topEdges.forEach((e) => { if (topPreds.has(e.source) && topPreds.has(e.target)) topPreds.get(e.target).push(e.source); });
  const rankMemo = new Map();
  const rankOf = (id, seen) => {
    if (rankMemo.has(id)) return rankMemo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    let r = 0;
    for (const p of topPreds.get(id) || []) r = Math.max(r, rankOf(p, seen) + 1);
    seen.delete(id);
    rankMemo.set(id, r);
    return r;
  };
  codeTops.forEach((t) => rankOf(t.node.id, new Set()));
  const maxRank = codeTops.length ? Math.max(...codeTops.map((t) => rankMemo.get(t.node.id))) : 0;

  // 河道序列（左→右）。標題只用拓樸/卡型事實，不猜語意名稱。
  const lanes = []; // { title, members: tops 子集, x, w, bottom }
  for (let r = 0; r <= maxRank; r++) {
    const members = codeTops.filter((t) => rankMemo.get(t.node.id) === r);
    if (!members.length) continue;
    const title = maxRank === 0 ? "程式"
      : r === 0 ? "入口層" : r === maxRank ? "基礎層"
      : maxRank === 2 ? "中間層" : `中間層 ${r}`;
    lanes.push({ title, members });
  }
  const depTops = tops.filter(isDeps);
  if (depTops.length) lanes.push({ title: "外部依賴", members: depTops });
  const resTops = tops.filter(isRes);
  if (resTops.length) lanes.push({ title: "資源", members: resTops });
  const laneIdxOf = new Map();
  lanes.forEach((ln, i) => ln.members.forEach((t) => laneIdxOf.set(t.node.id, i)));

  // 河道內排序：依前一河道相連主體的平均序位（barycenter）減少跨帶交叉；無線者殿後。
  const orderIdx = new Map();
  lanes.forEach((ln, li) => {
    if (li > 0) {
      const score = (t) => {
        const ps = topEdges.filter((e) => e.target === t.node.id)
          .map((e) => orderIdx.get(e.source)).filter((v) => v !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
      };
      ln.members.sort((a, b) => score(a) - score(b)
        || String(a.node.data.label).localeCompare(String(b.node.data.label)));
    }
    ln.members.forEach((t, i) => orderIdx.set(t.node.id, i));
  });

  // 跨河道連線取捨：span ≤1 主體相連；span ≥2 記入代理清單（建卡於版面階段）。
  const PROXY_W = 264, PROXY_H = 88, PROXY_GAP = 12;
  const proxiesBySource = new Map(); // srcTopId → [{targetId, label}]
  for (const [k, n] of aggregate) {
    const [s, t] = k.split("->");
    const label = n > 1 ? `import ×${n}` : "import";
    const span = Math.abs((laneIdxOf.get(t) ?? 0) - (laneIdxOf.get(s) ?? 0));
    if (span >= 2) {
      if (!proxiesBySource.has(s)) proxiesBySource.set(s, []);
      proxiesBySource.get(s).push({ targetId: t, label });
    } else {
      mkEdge(s, t, label);
    }
  }

  // 版面：河道由左至右排帶；帶內主體直向堆疊、代理卡貼本體右側。全帶等高＝視覺河道。
  const LANE_PAD = 40, LANE_HEAD = 100, LANE_FOOT = 60, LANE_GAP = 110, TOP_VGAP = 60;
  let laneX = X0;
  let maxBottom = Y0;
  lanes.forEach((ln) => {
    const proxW = ln.members.some((t) => proxiesBySource.has(t.node.id)) ? PROXY_W + 24 : 0;
    ln.x = laneX;
    ln.w = Math.max(...ln.members.map((t) => t.estW)) + proxW;
    let y = Y0;
    ln.members.forEach((t) => {
      t.node.position = { x: laneX, y };
      const plist = proxiesBySource.get(t.node.id) || [];
      plist.forEach((p, i) => {
        const pid = nextId();
        nodes.push({
          id: pid, type: "note",
          position: { x: laneX + t.estW + 24, y: y + 40 + i * (PROXY_H + PROXY_GAP) },
          data: { label: "⇒", status: "note", kind: "proxy", proxyFor: p.targetId },
        });
        mkEdge(t.node.id, pid, p.label);
      });
      const proxStackH = plist.length ? 40 + plist.length * (PROXY_H + PROXY_GAP) : 0;
      y += Math.max(t.estH, proxStackH) + TOP_VGAP;
    });
    maxBottom = Math.max(maxBottom, y - TOP_VGAP);
    laneX += ln.w + LANE_GAP;
  });

  // ---- 編號（HARE b16num01）：卡片編號＝HARE 溝通索引（agent 以 A3/B7 指卡；
  // far 導覽層也靠編號前綴標示分類群）。頂層主體依「河道左→右、帶內上→下」配類別，
  // 其子孫依序 A1、A2…（含巢狀目錄與檔案）。
  // 分類跨分頁唯一：opts.usedCats＝專案其他分頁已用的類別，
  // 配號器跳過（單字母 A–Z 跳 G 用罄後接雙字母 AA、AB…）——多分頁不再撞編號。
  const seqEnd = new Map(); // topId → 子孫編號用到的最後序號（代理卡續編用）
  {
    const usedCats = new Set([...(opts.usedCats || [])].map((s) => String(s).toUpperCase()));
    // 無 G、D：G 系列＝導覽卡（G0 入口／far 導覽層）、
    // D 系列＝決策卡（D-series ruling）——機械板配號避讓這兩類慣例，不與人工卡撞前綴。
    const LETTERS = "ABCEFHIJKLMNOPQRSTUVWXYZ";
    function* catSeq() {
      for (const c of LETTERS) yield c;
      for (const a of LETTERS) for (const b of LETTERS) yield a + b;
    }
    const gen = catSeq();
    const nextCat = () => {
      let c = gen.next().value;
      while (c && usedCats.has(c)) c = gen.next().value;
      if (c) usedCats.add(c);
      return c || `T${nodes.length}`;
    };
    const kids = new Map();
    nodes.forEach((n) => {
      if (!n.parentId) return;
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId).push(n);
    });
    const orderedTops = lanes.flatMap((ln) => ln.members);
    orderedTops.forEach((t) => {
      const cat = nextCat();
      t.node.data.num = cat;
      let seq = 0;
      const walk = (id) => (kids.get(id) || []).forEach((n) => { n.data.num = `${cat}${(seq += 1)}`; walk(n.id); });
      walk(t.node.id);
      seqEnd.set(t.node.id, seq);
    });
  }
  // 代理卡：也要編號（掛在來源主體的類別下續編）＋label＝⇒ 本尊編號 名稱
  {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const srcOfProxy = new Map(); // proxyId → 來源主體 node（由連到代理卡的邊反查）
    edges.forEach((e) => {
      const t = byId.get(e.target);
      if (t?.data?.kind === "proxy") srcOfProxy.set(t.id, byId.get(e.source));
    });
    nodes.forEach((n) => {
      if (n.data?.kind !== "proxy") return;
      const real = byId.get(n.data.proxyFor);
      n.data.label = real ? `⇒ ${real.data?.num || ""} ${real.data?.label || real.data?.title || ""}`.trim() : "⇒ ?";
      const src = srcOfProxy.get(n.id);
      if (src?.data?.num) {
        const cat = src.data.num;
        const seq = (seqEnd.get(src.id) || 0) + 1;
        seqEnd.set(src.id, seq);
        n.data.num = `${cat}${seq}`;
      }
    });
  }

  // 河道背景（zIndex -1、鎖定防誤拖；lane 無子，父先於子規則不受影響）：
  // 一帶一分類、全帶等高——縮到最遠看到的就是分類帶標題。
  const laneH = Math.round(maxBottom - Y0 + LANE_HEAD + LANE_FOOT);
  lanes.forEach((ln, i) => {
    nodes.unshift({
      id: `an${runTag}_lane${i + 1}`, type: "lane",
      position: { x: ln.x - LANE_PAD, y: Y0 - LANE_HEAD },
      dragHandle: ".lane-title", zIndex: -1,
      width: Math.round(ln.w + LANE_PAD * 2), height: laneH,
      data: { w: Math.round(ln.w + LANE_PAD * 2), h: laneH,
        color: "#0a6fb0", locked: true,
        title: ln.title, sub: `${basename(root) || root}·analyze 自動生成` },
    });
  });

  // 邊 id 帶 run 戳記（防跨次生成撞 id）——代理線也建完了才統一編
  edges.forEach((e, i) => { e.id = `an${runTag}_e${i + 1}`; });

  const dirCount = nodes.filter((n) => n.data?.kind === "dir").length;
  const fileCount = nodes.filter((n) => n.data?.kind === "file").length;
  const resCount = nodes.filter((n) => n.type === "res").length;
  const proxyCount = nodes.filter((n) => n.data?.kind === "proxy").length;
  return { nodes, edges, stats: { root, dirCount, fileCount, edgeCount: edges.length,
    topCount: tops.length, aggEdges: aggregate.size,
    laneCount: lanes.length, proxyCount,
    depCount: extDeps.size, resCount,
    skippedFiles, prunedDirs, maxDepth, perDir, maxFiles } };
}

/**
 * 檔案總管建構：圖像級檔案總管——與 analyzeCodebase 分屬兩件事
 *（後者是連結分析、照舊不動）。資料夾＝資源卡（listing 物件列 {name, kind, path}）、
 * 子資料夾＝巢狀子資源卡（資源包資源）；檔案一律進清單、不建獨立卡。
 * @param {string} rootPath 目錄（絕對或相對）
 * @param {object} [opts] ignore / gitignore（同 analyzeCodebase）；maxDepth 預設 5、
 *   maxList 每卡檔案列上限預設 60（超出聚合「… 其餘 N 檔」列）
 * @returns {{ nodes: object[], edges: object[], stats: object }}
 */
// HARE f11e7ee0 fileTree
export function fileTree(rootPath, opts = {}) {
  const root = resolve(rootPath);
  if (!statSync(root).isDirectory()) throw new Error(`fileTree 需要目錄路徑：${rootPath}`);
  const ignore = new Set(opts.ignore || DEFAULT_IGNORE);
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 5;
  const maxList = Number.isFinite(opts.maxList) ? opts.maxList : 60;
  const ignoreMatch = (opts.gitignore !== false) ? gitignoreMatcher(loadGitignore(root)) : () => false;
  const run = Date.now().toString(36).slice(-6); // id 帶 per-run 戳記（同 analyze 的教訓）
  let seq = 0;
  const nodes = [];
  let dirCount = 0, fileCount = 0, prunedDirs = 0;
  const HEAD_H = 96, ROW_H = 22, DIRS_BTN_H = 30, TAIL = 24, MIN_W = 280;
  // 遞迴建卡：回傳 { node, estH, estW }
  function build(absDir, parentId, depth) {
    const id = `ft${run}_${(seq += 1)}`;
    const rel = relative(root, absDir).split(sep).join("/");
    let entries = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { /* 讀不到＝空卡 */ }
    entries = entries
      .filter((e) => !ignore.has(e.name)
        && !ignoreMatch((rel ? `${rel}/` : "") + e.name, e.isDirectory()))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirsE = entries.filter((e) => e.isDirectory());
    const filesE = entries.filter((e) => e.isFile());
    const listing = [
      ...dirsE.map((e) => ({ name: e.name, kind: "dir" })),
      ...filesE.slice(0, maxList).map((e) => ({ name: e.name, kind: "file",
        path: (rel ? `${rel}/` : "") + e.name })),
    ];
    if (filesE.length > maxList) listing.push({ name: `… 其餘 ${filesE.length - maxList} 檔`, kind: "file" });
    fileCount += filesE.length;
    dirCount += 1;
    const node = {
      id, type: "res", position: { x: X0, y: Y0 },
      data: { label: basename(absDir) || absDir, status: "note", kind: "res",
        listing, refs: [{ path: rel || "." }] },
      ...(parentId ? { parentId, extent: "parent" } : {}),
    };
    nodes.push(node);
    const rows = Math.min(filesE.length, maxList) + (filesE.length > maxList ? 1 : 0);
    let estH = HEAD_H + (dirsE.length ? DIRS_BTN_H : 0) + rows * ROW_H + TAIL;
    let maxW = MIN_W;
    // 子資料夾＝子資源卡直向堆疊（資源包資源）；達 maxDepth 不再展開（清單仍列名）
    if (depth < maxDepth) {
      let y = CHILD_Y0 + (dirsE.length ? DIRS_BTN_H : 0) + rows * ROW_H;
      for (const d of dirsE) {
        const sub = build(join(absDir, d.name), id, depth + 1);
        sub.node.position = { x: CHILD_X, y };
        y += sub.estH + CHILD_GAP;
        maxW = Math.max(maxW, sub.estW + CHILD_X * 2);
      }
      if (dirsE.length) estH = y + TAIL;
    } else if (dirsE.length) prunedDirs += dirsE.length;
    return { node, estH, estW: maxW };
  }
  build(root, null, 0);
  // 編號：整棵樹一個類別（根＝類別字母、子孫依建構序 1..n）——總管是單一主體；
  // opts.usedCats 跳過專案既有類別（同 analyzeCodebase 規則、同字母表避 G）
  {
    const usedCats = new Set([...(opts.usedCats || [])].map((s) => String(s).toUpperCase()));
    const LETTERS = "ABCEFHIJKLMNOPQRSTUVWXYZ"; // 無 G、D（導覽 G／決策 D 為保留字段）
    function* catSeq() { for (const c of LETTERS) yield c; for (const a of LETTERS) for (const b of LETTERS) yield a + b; }
    const gen = catSeq();
    let cat = gen.next().value;
    while (cat && usedCats.has(cat)) cat = gen.next().value;
    cat = cat || "FT";
    nodes.forEach((n, i) => { n.data.num = i === 0 ? cat : `${cat}${i}`; });
  }
  return { nodes, edges: [], stats: { dirCount, fileCount, prunedDirs, maxDepth, maxList } };
}
