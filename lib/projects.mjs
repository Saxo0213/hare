// B4 多專案化·專案登錄表（registry）。零依賴，純 node:fs。
// 負責：列出／建立／改名／刪除專案。專案的中繼資料（顯示標題、編號前綴、建立時間）
// 存在 data/projects.json；實際白板資料檔／變更日誌由 store.mjs 依 projectId 解析。
//
// 設計要點：
// - 預設專案（"default"）永遠存在，不入 registry（其資料檔是 legacy 的 roadmap-data.json，
//   或遷移後的 data/default.json），listProjects() 一律補上。
// - listProjects() 以「registry ∪ 檔案系統掃描」為準：手動丟進 data/ 的 <id>.json 也認得。
// - 種子模板：空白板；可選 prefix（自動編號前綴）與 swimlane（初始泳道標題）寫進 meta。
import { readFile, writeFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, basename, dirname, isAbsolute, join } from "node:path";
import {
  DEFAULT_PROJECT, normalizeProjectId, dataDir, dataPathFor, changelogPathFor,
  readStore, writeStore, DATA_PATH,
} from "./store.mjs";
import { normalizeTasks } from "./tasks.mjs"; // 入職狀態機種子：檢核卡任務 dict 化

const registryPath = () => resolve(dataDir(), "projects.json");

// repo 根＝預設專案 legacy 資料檔所在目錄；相對 refBase 與「未設 refBase」的預設基準都用它。
const REPO_ROOT = dirname(DATA_PATH);

async function readRegistry() {
  try {
    const r = JSON.parse(await readFile(registryPath(), "utf8"));
    return Array.isArray(r?.projects) ? r : { projects: [] };
  } catch {
    return { projects: [] };
  }
}

async function writeRegistry(reg) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(reg, null, 2), "utf8");
}

/* ---------- B2 去 CoTechne 化：per 專案 refBase（卡片 refs.path 解析基準根） ----------
 * 每個專案的 refs.path 相對「哪個根」解析＝該專案的 refBase。設定來源優先序：
 *   1) registry 專案條目的 refBase（createProject 時可帶入）
 *   2) 白板 store meta.refBase（連沒有 registry 條目的預設專案也能設）
 *   3) 皆未設 ⇒ repo 根（＝今日行為，完全向後相容）
 * 相對 refBase 一律相對 repo 根解析；絕對路徑照原樣。回傳絕對路徑字串。
 * 路徑穿越防護（refs.path 必須落在 refBase 內）由呼叫端（tools.mjs resolveRefPath／
 * roadmap-api.mjs /api/locate）以 startsWith(base+sep) 把關。
 * HARE b2refbase PROJECT_REFBASE */
export async function getProjectRefBase(projectId) {
  const pid = normalizeProjectId(projectId);
  let raw = null;
  const reg = await readRegistry();
  const entry = reg.projects.find((p) => p.id === pid);
  if (entry && entry.refBase) raw = entry.refBase;
  if (!raw) {
    const store = await readStore(pid);
    if (store?.meta?.refBase) raw = store.meta.refBase;
  }
  if (!raw) return REPO_ROOT;
  return isAbsolute(raw) ? resolve(raw) : resolve(REPO_ROOT, raw);
}

/* ---------- B12 認證授權：per 專案 token／角色設定（存於 registry 的 auth 映射） ----------
 * 形狀：reg.auth = { "<projectId>": { private: bool, tokens: { "<token>": { role, identity } } } }
 * - 與 projects 陣列獨立 ⇒ 連預設專案（default，不入 projects 陣列）也能設 token／私有讀。
 * - 未設（null／無 tokens）＝該專案沿用今日行為：讀公開、寫看全域 ROADMAP_TOKEN／開發模式恆真。
 * - role：read < write < admin（admin＝建立／改名／刪除專案）。private:true ⇒ 連讀都要 token。
 * HARE b12auth01 PROJECT_AUTH */
export async function getProjectAuth(projectId) {
  const pid = normalizeProjectId(projectId);
  const reg = await readRegistry();
  const a = reg.auth && reg.auth[pid];
  return a && typeof a === "object" ? a : null;
}

// 設定（config=null＝清除）某專案的 auth 設定。回傳寫入後的設定。
export async function setProjectAuth(projectId, config) {
  const pid = normalizeProjectId(projectId);
  const reg = await readRegistry();
  reg.auth = reg.auth && typeof reg.auth === "object" ? reg.auth : {};
  if (config === null || config === undefined) delete reg.auth[pid];
  else reg.auth[pid] = config;
  await writeRegistry(reg);
  return { ok: true, project: pid, auth: reg.auth[pid] || null };
}

// 反查：某 token 在「任一專案」是否有效（跨專案越權辨識用）。回傳 {project,role,identity} 或 null。
export async function findTokenGrant(token) {
  if (!token) return null;
  const reg = await readRegistry();
  const auth = reg.auth && typeof reg.auth === "object" ? reg.auth : {};
  for (const [pid, cfg] of Object.entries(auth)) {
    const t = cfg?.tokens?.[token];
    if (t) return { project: pid, role: t.role || "write", identity: t.identity || null };
  }
  return null;
}

// 掃描 data/ 內的 <id>.json（排除 registry、changelog、備份、暫存檔），回傳 id 陣列。
async function scanProjectIds() {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;             // changelog 是 .jsonl，天然排除
    if (f === "projects.json") continue;
    if (f.includes(".bak-") || f.endsWith(".tmp")) continue;
    out.push(f.slice(0, -5));
  }
  return out;
}

// 讀某專案摘要（rev／卡片數／標題）。讀不到就給零值，不讓單一壞檔擋住整份清單。
/* ---------- 程式碼類型偵測（專案管理頁用；GitHub linguist 的迷你版） ----------
 * 掃 refBase 目錄樹，依副檔名累計位元組，回傳占比前 3 的語言字串（如
 * 「JavaScript 82%・CSS 12%」）。只算程式碼類副檔名（資料/文件不計）；
 * node_modules/.git/dist 跳過；深度/檔數設限（清單頁不必精確，夠辨識即可）。
 * HARE 1an9de7c detectLanguages */
const LANG_BY_EXT = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", py: "Python", css: "CSS", scss: "CSS",
  less: "CSS", html: "HTML", htm: "HTML", vue: "Vue", svelte: "Svelte",
  go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", c: "C", h: "C",
  cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", rb: "Ruby", php: "PHP",
  swift: "Swift", sh: "Shell", bash: "Shell", ps1: "PowerShell",
  sql: "SQL", dart: "Dart", lua: "Lua", r: "R", scala: "Scala",
};
const LANG_IGNORE = new Set(["node_modules", ".git", "dist", "data", "data-archive"]);
export function detectLanguages(dir, { maxDepth = 5, maxFiles = 3000 } = {}) {
  const bytes = new Map();
  let seen = 0;
  const walk = (abs, depth) => {
    if (depth > maxDepth || seen >= maxFiles) return;
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= maxFiles) return;
      if (LANG_IGNORE.has(e.name)) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const ext = e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      if (!lang) continue;
      seen += 1;
      try { bytes.set(lang, (bytes.get(lang) || 0) + statSync(p).size); } catch { /* 略過 */ }
    }
  };
  try { walk(resolve(dir), 0); } catch { /* 目錄不存在等 */ }
  const total = [...bytes.values()].reduce((s, b) => s + b, 0);
  if (!total) return "";
  return [...bytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .filter(([, b]) => Math.round((b / total) * 100) >= 1) // <1% 不列（雜訊）
    .map(([lang, b]) => `${lang} ${Math.round((b / total) * 100)}%`).join("・");
}

/* ---------- 生態系偵測（通用化） ----------
 * 原則：不做「依賴名→框架名」白名單（寫死、永遠追不完、只認單一生態系）。
 * 改為通用兩段式：① 生態系＝偵測各語言圈的「依賴宣告檔」慣例（檔名即宣告）；
 * ② 依賴＝從宣告檔原樣抽出 runtime 依賴名稱，取前幾個直接展示（react 就顯示
 * react、django 就顯示 django——不翻譯、不挑選、不維護名單）。
 * ECOSYSTEMS 是「宣告檔格式表」（資料，非邏輯）：新增生態系＝加一列，不改程式。
 * HARE f2a8e9b1 detectEcosystems */
const ECOSYSTEMS = [
  { file: "package.json", eco: "Node.js",
    deps: (t) => Object.keys(JSON.parse(t).dependencies || {}) },
  { file: "pyproject.toml", eco: "Python",
    deps: (t) => (t.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] || "")
      .split(",").map((s) => s.replace(/['"\s]/g, "").split(/[><=~[!;]/)[0]).filter(Boolean) },
  { file: "requirements.txt", eco: "Python",
    deps: (t) => t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"))
      .map((l) => l.split(/[><=~[!;\s]/)[0]).filter(Boolean) },
  { file: "go.mod", eco: "Go",
    deps: (t) => [...t.matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+v[\w.-]+/gm)].map((m) => m[1]) },
  { file: "Cargo.toml", eco: "Rust",
    deps: (t) => (t.split(/^\[dependencies\]/m)[1] || "").split(/^\[/m)[0]
      .split(/\r?\n/).map((l) => l.split("=")[0].trim()).filter((l) => l && !l.startsWith("#")) },
  { file: "Gemfile", eco: "Ruby",
    deps: (t) => [...t.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]) },
  { file: "composer.json", eco: "PHP",
    deps: (t) => Object.keys(JSON.parse(t).require || {}).filter((k) => k !== "php" && !k.startsWith("ext-")) },
  { file: "pom.xml", eco: "Java",
    deps: (t) => [...t.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]).slice(1) },
  { file: "build.gradle", eco: "Java",
    deps: (t) => [...t.matchAll(/implementation[\s(]+['"]([^'":]+)/g)].map((m) => m[1]) },
  { file: "pubspec.yaml", eco: "Dart",
    deps: (t) => (t.split(/^dependencies:/m)[1] || "").split(/^\w/m)[0]
      .split(/\r?\n/).map((l) => /^\s{2}(\w[\w-]*):/.exec(l)?.[1]).filter(Boolean) },
];
export function detectEcosystems(dir, { maxDeps = 4 } = {}) {
  const out = [];
  for (const { file, eco, deps } of ECOSYSTEMS) {
    const p = join(resolve(dir), file);
    if (!existsSync(p)) continue;
    let list = [];
    try { list = deps(readFileSync(p, "utf8")) || []; } catch { /* 格式異常＝只報生態系 */ }
    if (out.some((o) => o.eco === eco)) { // 同生態系多宣告檔（如 pyproject＋requirements）→ 併依賴
      const prev = out.find((o) => o.eco === eco);
      prev.deps = [...new Set([...prev.deps, ...list])].slice(0, maxDeps);
      continue;
    }
    out.push({ eco, deps: [...new Set(list)].slice(0, maxDeps) });
  }
  return out;
}

async function projectSummary(id, regEntry) {
  const store = await readStore(id);
  const nodes = Array.isArray(store?.nodes) ? store.nodes : [];
  const cardCount = nodes.filter((n) => n.type !== "lane").length;
  const title = store?.meta?.title || regEntry?.title || (id === DEFAULT_PROJECT ? "預設專案" : id);
  const refBase = (await getProjectRefBase(id)).split("\\").join("/");
  return {
    id,
    title,
    prefix: store?.meta?.prefix ?? regEntry?.prefix ?? "",
    isDefault: id === DEFAULT_PROJECT,
    rev: typeof store?.rev === "number" ? store.rev : 0,
    cardCount,
    dataFile: dataPathFor(id),
    refBase,                              // 對應資料夾（專案管理頁）
    langs: detectLanguages(refBase),      // 程式碼類型（GitHub 式副檔名分析）
    ecosystems: detectEcosystems(refBase), // 生態系＋主要依賴（宣告檔通用偵測，原樣展示）
    // 分頁（v2：分頁在檔內）：回報頁數與頁名供前端/管理頁顯示
    ...(Array.isArray(store?.pages) ? { pages: store.pages.map((p) => ({ id: p.id, name: p.name })) } : {}),
    ...(regEntry?.createdAt ? { createdAt: regEntry.createdAt } : {}),
  };
}

// 列出所有專案（預設專案排第一，其餘依 id 排序）。封存中的專案不列（見 archiveProject）。
export async function listProjects() {
  const reg = await readRegistry();
  const regById = new Map(reg.projects.map((p) => [p.id, p]));
  const ids = new Set([DEFAULT_PROJECT, ...regById.keys(), ...(await scanProjectIds())]);
  for (const p of reg.projects) if (p.archived) ids.delete(p.id); // 封存排除
  const list = await Promise.all([...ids].map((id) => projectSummary(id, regById.get(id))));
  list.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.id.localeCompare(b.id)));
  return { count: list.length, projects: list };
}

/* ---------- 專案封存／解封（專案管理頁 − 鈕；非破壞——檔案搬 data/archive/） ----------
 * 封存＝資料檔/變更日誌/快照搬到 data/archive/、registry 標 archived 時戳；
 * 清單不列、id 保留（防撞名）。解封＝反向搬回、去除標記。預設專案不可封存。
 * HARE a9c41v3p archiveProject */
export async function archiveProject(id) {
  const pid = normalizeProjectId(id);
  if (pid === DEFAULT_PROJECT) throw new Error("預設專案（default）不可封存");
  if (!(await projectExists(pid))) throw new Error(`找不到專案：${pid}`);
  const reg = await readRegistry();
  const entry = reg.projects.find((p) => p.id === pid);
  if (entry?.archived) throw new Error(`專案已在封存中：${pid}`);
  const arDir = resolve(dataDir(), "archive");
  await mkdir(arDir, { recursive: true });
  for (const from of [dataPathFor(pid), changelogPathFor(pid),
    changelogPathFor(pid).replace(/-changelog\.jsonl$/i, "-snapshots.jsonl")]) {
    if (existsSync(from)) await rename(from, resolve(arDir, basename(from))).catch(() => {});
  }
  const t = new Date().toISOString();
  if (entry) entry.archived = t;
  else reg.projects.push({ id: pid, title: pid, archived: t });
  await writeRegistry(reg);
  return { ok: true, archived: pid, at: t };
}

export async function unarchiveProject(id) {
  const pid = normalizeProjectId(id);
  const reg = await readRegistry();
  const entry = reg.projects.find((p) => p.id === pid);
  if (!entry?.archived) throw new Error(`專案不在封存中：${pid}`);
  const arDir = resolve(dataDir(), "archive");
  for (const to of [dataPathFor(pid), changelogPathFor(pid),
    changelogPathFor(pid).replace(/-changelog\.jsonl$/i, "-snapshots.jsonl")]) {
    const from = resolve(arDir, basename(to));
    if (existsSync(from)) await rename(from, to).catch(() => {});
  }
  delete entry.archived;
  await writeRegistry(reg);
  return { ok: true, restored: pid };
}

export async function projectExists(id) {
  const pid = normalizeProjectId(id);
  if (pid === DEFAULT_PROJECT) return true;
  if (existsSync(dataPathFor(pid))) return true;
  const reg = await readRegistry();
  return reg.projects.some((p) => p.id === pid);
}

/* ---------- 種子模板（空白或範本）——模板寫成資料列，新增模板＝加一列不改程式 ----------
 * 每列：label（顯示名）＋可選 swimlane（未明給時的預設泳道）＋可選 seeds（種子卡，
 * node 形狀但不含 id——建立時配發）。模板給的是預設值，呼叫端明給的 prefix/swimlane 優先。
 * HARE 5eedtp1a TEMPLATES */
export const TEMPLATES = {
  blank: { label: "空白板" },
  roadmap: {
    label: "路線範本（泳道＋使用說明卡）",
    swimlane: "產品路線",
    seeds: [{
      type: "note", position: { x: 60, y: 120 },
      data: { num: "N1", label: "白板使用說明", status: "note",
        desc: "卡片＝任務，依賴線＝先後順序（上游→下游）。人拖卡片、agent 用 MCP 讀寫，雙方以卡片編號溝通。",
        tasks: ["把第一個目標拆成幾張卡（status=plan 規劃）", "用線段串出依賴順序（get_ready_cards 即可接工）", "做完的卡標 status=real（實跑驗證過才標）"] },
    }],
  },
};

/* ---------- 專案啟動狀態機種子 ----------
 * 分工：程式管流程與狀態轉移、agent 管語意、白板＝共享 state。
 * 兩條入職路線各自種一份：
 *   new（create_project 新專案，Spec Kit 式）＝四步；
 *   existing（analyze 全新專案／舊碼庫，DeepWiki 式）＝五步，第一步「掃描」由系統代銷。
 * 種入物：導覽分頁＋G0 模板卡（模板骨架，待填）＋啟動檢核卡（after G0 拉邊），
 * 專案 meta.onboarding = { mode, card:<檢核卡id> }。進度真相＝檢核卡開放任務數，
 * 歸零＝啟動完成（complete_task 順手清 meta.onboarding；get_overview 據此顯示/省略）。
 * HARE a3f1c8e2 onboarding_seed */
export const ONBOARDING_STEPS = {
  new: [
    "Specify：與使用者對談定「做什麼／為什麼」，寫進 G0 首段與路線",
    "Plan：技術方案與架構草圖上板（架構卡＋依賴邊）",
    "Tasks：拆可認領任務卡（依賴邊＋驗收條件）",
    "使用者核可 G0 定稿（銷此任務＝啟動完成）",
  ],
  existing: [
    "掃描：機械板已生成（本步由系統代銷）",
    "大意：與使用者對談校正——這專案給誰用、核心流程哪條、哪裡是雷",
    "語意板：依 scan_interfaces 建模組介面／系統架構頁（見 get_guide code）",
    "任務遷入：把 repo ROADMAP/TODO 未完成項遷成任務卡（依賴＋驗收條件；待使用者執行的標 block）",
    "使用者核可 G0 定稿（銷此任務＝啟動完成）",
  ],
};

// G0 模板 desc：首行佔位一句話＋固定段落骨架（各段一行佔位提示），待填實。
const G0_TEMPLATE_DESC = [
  "（一句話：這專案是什麼、為誰、為什麼）",
  "",
  "## 路線",
  "（現在做什麼、下一步做什麼——一行）",
  "",
  "## 架構怎麼讀",
  "（從哪張卡／哪個模組開始看懂——一行）",
  "",
  "## 計畫現況",
  "（任務分頁在哪、進行中的卡——一行）",
  "",
  "## 規矩摘要",
  "（開發鐵律／禁區——一行）",
  "",
  "## 關鍵裁決（D 系列）",
  "（重大決定的編號索引——一行）",
].join("\n");

// 建導覽頁物件（G0 模板卡＋啟動檢核卡＋G0→檢核邊）。回 { page, checklistId, meta }。
// existing 模式第一步「掃描」由系統代銷＝直接落 doneTasks（示範狀態機在走：種完即有一步已完成）。
export function onboardingSeed(mode) {
  const steps = ONBOARDING_STEPS[mode] || ONBOARDING_STEPS.new;
  const isExisting = mode === "existing";
  const openSteps = isExisting ? steps.slice(1) : steps.slice(); // 開放任務（existing 少了已代銷的首步）
  const now = Date.now();
  const uid = now.toString(36);
  const g0Id = `seed_g0_${uid}`;
  const chkId = `seed_chk_${uid}`;
  const g0 = {
    id: g0Id, type: "note", position: { x: 60, y: 60 },
    data: { num: "G0", label: "專案導覽（G0）", status: "plan", desc: G0_TEMPLATE_DESC },
  };
  const chk = {
    id: chkId, type: "note", position: { x: 600, y: 60 },
    data: {
      num: "O1", label: "啟動檢核", status: "plan",
      desc: "專案啟動閘門：依序完成 Specify／Plan／Tasks 後停止，等待使用者親自核可；核可前不得開始程式實作。",
      tasks: normalizeTasks(openSteps, now),
      ...(isExisting ? { doneTasks: [{ text: steps[0], t: new Date().toISOString() }] } : {}),
    },
  };
  const edge = {
    id: `seed_e_${uid}`, source: g0Id, target: chkId, type: "default",
    style: { stroke: "#c47d0a", strokeWidth: 1.8 },
    markerEnd: { type: "arrowclosed", color: "#c47d0a" },
    sourceHandle: "r", targetHandle: "l",
  };
  const page = {
    id: `pg_onb_${uid}`, name: "導覽",
    nodes: [g0, chk], edges: [edge], viewport: null, deletedEdges: [], constraints: [],
  };
  return { page, checklistId: chkId, meta: { mode, card: chkId } };
}

// 建立新專案：種子板（空白或範本 template，可帶 prefix／swimlane／layout），寫入 registry。
// writer 標記變更日誌身分。回傳專案摘要。
// 分頁不在這層（v2）：一專案一檔、分頁在檔內（store.mjs pages），
// 新分頁走 /api/roadmap 的 pageOps 或工具的 page 參數。
export async function createProject(id, { title, prefix, swimlane, refBase, template, layout, onboarding } = {}, writer = "system") {
  const pid = normalizeProjectId(id); // 非法 id 在此丟錯
  if (pid === DEFAULT_PROJECT) throw new Error("預設專案（default）已存在，無法重建");
  if (await projectExists(pid)) throw new Error(`專案已存在：${pid}`);
  const tplKey = template || "blank";
  const tpl = TEMPLATES[tplKey];
  if (!tpl) throw new Error(`未知模板：${template}（可用：${Object.keys(TEMPLATES).join("、")}）`);

  // refBase＝本專案 refs.path 的解析基準根（省略＝repo 根）。寫進白板 meta 與 registry。
  // 首用標記（導入流程）：meta.created＝建立時間與身分，agent 可判斷板齡。
  // layout＝排版格線覆寫（add_card 自動落格用，見 layout.mjs gridOf）。
  const meta = { title: title || pid, ...(prefix ? { prefix } : {}), ...(refBase ? { refBase } : {}),
    ...(layout && typeof layout === "object" ? { layout } : {}),
    created: { t: new Date().toISOString(), by: writer } };
  const nodes = [];
  const laneTitle = swimlane || tpl.swimlane; // 明給優先，模板次之
  if (laneTitle) {
    nodes.push({
      id: `lane_${Date.now()}`, type: "lane",
      position: { x: 0, y: 0 },
      data: { title: String(laneTitle), sub: "" },
      style: { width: 1200, height: 480 },
    });
  }
  (tpl.seeds || []).forEach((s, i) => nodes.push({
    id: `seed_${Date.now()}_${i}`, type: s.type || "note",
    position: s.position || { x: 60, y: 120 + i * 340 },
    data: { ...s.data },
  }));
  // onboarding 指定時（create_project 走 "new"）自動種導覽頁＋G0 模板＋
  // 啟動檢核卡＋meta.onboarding；否則維持單板 v1 形狀（analyze／scan_file_tree 不由此種）。
  let seed;
  let seedCards = 0;
  if (onboarding) {
    const { page: onbPage, meta: onbMeta } = onboardingSeed(onboarding);
    meta.onboarding = onbMeta;
    const mainPage = { id: "p1", name: "主板", nodes, edges: [], viewport: null, deletedEdges: [], constraints: [] };
    seed = { pages: [mainPage, onbPage], meta, rev: 0 };
    seedCards = onbPage.nodes.length;
  } else {
    seed = { nodes, edges: [], meta, viewport: null, deletedEdges: [], constraints: [] };
  }
  // allowEmpty：新專案本就從 0 卡開始，須繞過空板寫入防呆。
  const out = await writeStore(seed, writer, { project: pid, allowEmpty: true });

  const reg = await readRegistry();
  reg.projects = reg.projects.filter((p) => p.id !== pid);
  reg.projects.push({ id: pid, title: meta.title, prefix: prefix || "", ...(refBase ? { refBase } : {}), createdAt: new Date().toISOString() });
  await writeRegistry(reg);

  return { id: pid, title: meta.title, prefix: prefix || "", ...(refBase ? { refBase } : {}), rev: out.rev, cardCount: nodes.filter((n) => n.type !== "lane").length + seedCards, dataFile: dataPathFor(pid) };
}

// 改名（改 id）：搬資料檔與變更日誌、更新 registry。不可改預設專案（其檔為 legacy）。
export async function renameProject(id, newId, writer = "system") {
  const pid = normalizeProjectId(id);
  const npid = normalizeProjectId(newId);
  if (pid === DEFAULT_PROJECT) throw new Error("預設專案不可改名");
  if (npid === DEFAULT_PROJECT) throw new Error("不可改名為 default");
  if (!(await projectExists(pid))) throw new Error(`找不到專案：${pid}`);
  if (await projectExists(npid)) throw new Error(`目標專案已存在：${npid}`);

  const from = dataPathFor(pid), to = dataPathFor(npid);
  if (existsSync(from)) await rename(from, to);
  const fromLog = changelogPathFor(pid), toLog = changelogPathFor(npid);
  if (existsSync(fromLog)) await rename(fromLog, toLog).catch(() => {});

  const reg = await readRegistry();
  const entry = reg.projects.find((p) => p.id === pid) || { createdAt: new Date().toISOString() };
  reg.projects = reg.projects.filter((p) => p.id !== pid && p.id !== npid);
  reg.projects.push({ ...entry, id: npid });
  // auth 設定隨專案代號搬移，避免舊 id 殘留孤兒 token 設定
  if (reg.auth && reg.auth[pid]) { reg.auth[npid] = reg.auth[pid]; delete reg.auth[pid]; }
  await writeRegistry(reg);
  return { ok: true, id: npid, from: pid, dataFile: to };
}

// 刪除專案：移除資料檔／變更日誌／備份／registry 條目。預設專案禁刪。
export async function deleteProject(id) {
  const pid = normalizeProjectId(id);
  if (pid === DEFAULT_PROJECT) throw new Error("預設專案不可刪除");
  if (!(await projectExists(pid))) throw new Error(`找不到專案：${pid}`);

  const dp = dataPathFor(pid);
  await unlink(dp).catch(() => {});
  await unlink(changelogPathFor(pid)).catch(() => {});
  // 清備份檔
  const dir = dataDir();
  const base = basename(dp);
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) {
      if (f.startsWith(`${base}.bak-`)) await unlink(resolve(dir, f)).catch(() => {});
    }
  }
  const reg = await readRegistry();
  reg.projects = reg.projects.filter((p) => p.id !== pid);
  if (reg.auth && reg.auth[pid]) delete reg.auth[pid]; // 一併清除 auth 設定
  await writeRegistry(reg);
  return { ok: true, deleted: pid };
}
