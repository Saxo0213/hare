// B16 Codebase 反向分析成板：單元測試（零依賴，node --test）。
// 隔離：HARE_DATA_DIR / HARE_DATA_PATH 指向暫存區，全程不碰 repo 真實資料檔。
// 用 HARE 自己的 lib/ 當分析對象：驗證「lib 容器 + 每個 .mjs 一張子卡 + refs 可解析」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = mkdtempSync(join(tmpdir(), "hare-b16-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default-legacy.json");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const LIB_DIR = resolve(REPO_ROOT, "lib");

const { analyzeCodebase } = await import("../lib/analyze.mjs");
const { TOOLS } = await import("../lib/tools.mjs");
const { readStore } = await import("../lib/store.mjs");
const { taskTexts } = await import("../lib/tasks.mjs");

// lib/ 下的 .mjs 檔數（分析對象；lib 是扁平目錄，無子目錄）。
const libMjs = readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"));

test("analyzeCodebase(lib)：lib 容器 + 每個 .mjs 一張檔案子卡，count 相符", () => {
  // perDir 拉高＝測「每檔一卡」的映射本身，與 lib/ 實際檔數脫鉤
  // （2026-08-02 lib 達 26 檔撞上預設 25 聚合上限；聚合行為由 perDir 專屬測試涵蓋）
  const { nodes, stats } = analyzeCodebase(LIB_DIR, { imports: false, perDir: 500 });
  // 頂層容器＝lib 目錄
  const containers = nodes.filter((n) => n.data?.kind === "dir");
  const root = containers.find((n) => !n.parentId);
  assert.ok(root, "應有一個頂層目錄容器");
  assert.equal(root.data.label, "lib");
  assert.equal(root.type, "note");

  // lib 是扁平目錄 → 只有一個容器
  assert.equal(stats.dirCount, 1, "lib 無子目錄，容器數應為 1");

  // 檔案子卡：全部掛在 lib 容器底下
  const fileCards = nodes.filter((n) => n.data?.kind === "file");
  fileCards.forEach((n) => {
    assert.equal(n.parentId, root.id);
    assert.equal(n.extent, "parent");
    // 多欄網格（2026-07-13）：x＝16＋欄序×欄寬（>8 張檔案自動換欄）
    assert.equal((n.position.x - 16) % 264, 0, `x=${n.position.x} 應落在網格欄位上`);
  });

  // .mjs 檔案子卡數 == lib/ 內 .mjs 檔數
  const mjsCards = fileCards.filter((n) => n.data.label.endsWith(".mjs"));
  assert.equal(mjsCards.length, libMjs.length,
    `lib .mjs 子卡數(${mjsCards.length}) 應等於實際 .mjs 檔數(${libMjs.length})`);

  // 檔案子卡 refs 指回原始碼，且路徑（相對分析根）可解析到實體檔
  mjsCards.forEach((n) => {
    assert.ok(Array.isArray(n.data.refs) && n.data.refs.length === 1);
    const p = n.data.refs[0].path;
    assert.ok(existsSync(resolve(LIB_DIR, p)), `refs 路徑應解析到實體檔：${p}`);
  });

  // analyze.mjs 這支檔本身應在子卡裡（sanity）
  assert.ok(mjsCards.some((n) => n.data.label === "analyze.mjs"));
});

test("analyzeCodebase：import 依賴線（正則）——tools.mjs → store.mjs 有連線", () => {
  // perDir 放寬：本測驗的是 import 連線，不是規模控制（那有獨立測試）。預設上限 25 會
  // 把字母序最後幾支聚合成「… 其餘 N 檔」——lib/ 一旦超過 25 支，tools.mjs 就掃不到。
  const { nodes, edges } = analyzeCodebase(LIB_DIR, { imports: true, perDir: 200 });
  const byLabel = (l) => nodes.find((n) => n.data?.kind === "file" && n.data.label === l);
  const tools = byLabel("tools.mjs"), store = byLabel("store.mjs");
  assert.ok(tools && store);
  // tools.mjs 匯入 ./store.mjs → 應有一條 tools→store 依賴線
  assert.ok(edges.some((e) => e.source === tools.id && e.target === store.id),
    "tools.mjs → store.mjs 的 import 依賴線應存在");
  // 邊端點皆指向存在的 node
  const ids = new Set(nodes.map((n) => n.id));
  edges.forEach((e) => { assert.ok(ids.has(e.source) && ids.has(e.target)); });
});

test("巢狀（2026-07-13 二版）：根的直接子目錄各自成頂層容器＋泳道背景", () => {
  const { nodes, stats } = analyzeCodebase(REPO_ROOT, { imports: false, ignore: ["node_modules", ".git", "dist", ".claude"] });
  // lib 應是「頂層容器」（不再塞進巨型根容器）
  const libContainer = nodes.find((n) => n.data?.kind === "dir" && n.data.label === "lib" && !n.parentId);
  assert.ok(libContainer, "lib 應是頂層容器");
  // 分類河道背景（v3：一帶一分類；標題＝拓樸/卡型分類，sub 帶根目錄名）
  const lanesArr = nodes.filter((n) => n.type === "lane");
  assert.ok(lanesArr.length >= 1, "應有分類河道背景");
  assert.ok(lanesArr.some((l) => l.data.title === "程式"), "無依賴線時程式容器歸「程式」帶");
  // 動態取實體資料夾名（禁寫死：改名遷移時測試曾因寫死品牌名而誤紅——資料夾名≠品牌名）
  const ROOT_NAME = basename(REPO_ROOT);
  assert.ok(lanesArr.every((l) => String(l.data.sub).includes(ROOT_NAME)), "河道 sub 應帶根目錄名");
  // 根目錄自己的檔案歸入以根命名的容器
  const rootFilesBox = nodes.find((n) => n.data?.kind === "dir" && !n.parentId && n.data.label === ROOT_NAME);
  assert.ok(rootFilesBox, "根檔案容器（以根目錄命名）應存在");
  // lib 容器底下應有 .mjs 檔案子卡
  const libFiles = nodes.filter((n) => n.data?.kind === "file" && n.parentId === libContainer.id);
  assert.ok(libFiles.length >= Math.min(libMjs.length, 25));
  assert.ok(stats.topCount >= 3, `頂層容器數 ${stats.topCount} 應 ≥ 3`);
});

test("analyze_codebase 工具：拒絕 default、寫進獨立專案、非破壞", async () => {
  const CTX = { writer: "test" };
  // 未給 project → 拒絕
  await assert.rejects(() => TOOLS.analyze_codebase.run({ path: LIB_DIR }, CTX), /必須指定 project/);
  // project=default → 拒絕（不動正式白板）
  await assert.rejects(() => TOOLS.analyze_codebase.run({ path: LIB_DIR, project: "default" }, CTX), /default/);

  // 正常：寫進新專案 scan1（perDir 拉高理由同上——測工具落盤，不測聚合上限）
  const r = await TOOLS.analyze_codebase.run({ path: LIB_DIR, project: "scan1", imports: true, perDir: 500 }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.project, "scan1");
  assert.equal(r.dirCount, 1);
  assert.equal(r.fileCount >= libMjs.length, true);

  // 資料真的落進 scan1 專案的資料檔（入職系統 M3：機械板落第一頁，導覽頁另種 → v2 pages）
  const cur = await readStore("scan1");
  const board = Array.isArray(cur.pages) ? cur.pages[0] : cur;
  const fileCards = board.nodes.filter((n) => n.data?.kind === "file");
  assert.equal(fileCards.length, r.fileCount);
  const containers = board.nodes.filter((n) => n.data?.kind === "dir");
  assert.equal(containers.length, 1);
  // 入職系統 M3（B8）：全新專案路線種啟動狀態機——導覽頁＋G0＋啟動檢核卡，meta.onboarding
  const guidePage = cur.pages.find((p) => p.name === "導覽");
  assert.ok(guidePage, "應種導覽分頁");
  assert.ok(guidePage.nodes.some((n) => (n.data?.num || "") === "G0"), "導覽頁應有 G0 模板卡");
  assert.equal(cur.meta.onboarding?.mode, "existing");
  const chk = guidePage.nodes.find((n) => n.id === cur.meta.onboarding.card);
  assert.equal(taskTexts(chk.data.tasks).length, 4, "五步、第一步已自銷 → 開放 4 條");
  assert.equal((chk.data.doneTasks || []).length, 1, "掃描步已由系統代銷");

  // 非破壞：同專案再分析（已有卡片）→ 拒絕
  await assert.rejects(() => TOOLS.analyze_codebase.run({ path: LIB_DIR, project: "scan1" }, CTX), /已有/);
});

/* ---------- 2026-07-13 導入流程強化：規模控制／版面估高／refBase／首用標記 ---------- */
import { mkdirSync, writeFileSync } from "node:fs";

// 建一個受控的假 codebase：
//   fake/
//   ├─ .gitignore（忽略 secret/ 與 *.log）
//   ├─ a.mjs … j.mjs（10 個檔）＋ x1.log
//   ├─ secret/hidden.txt
//   └─ deep/l1/l2/l3/leaf.txt（測 maxDepth）
const FAKE = join(TMP, "fake");
mkdirSync(join(FAKE, "secret"), { recursive: true });
mkdirSync(join(FAKE, "deep", "l1", "l2", "l3"), { recursive: true });
mkdirSync(join(FAKE, "assets"), { recursive: true });
writeFileSync(join(FAKE, ".gitignore"), "secret/\n*.log\n");
for (let i = 0; i < 10; i++) writeFileSync(join(FAKE, `${String.fromCharCode(97 + i)}.mjs`), "export const x = 1;\n");
// a.mjs 帶外部 import（依賴卡素材：node 內建＋套件＋scoped 套件）
writeFileSync(join(FAKE, "a.mjs"), "import fs from \"node:fs\";\nimport react from \"react\";\nimport dagre from \"@dagrejs/dagre\";\nexport const x = 1;\n");
writeFileSync(join(FAKE, "x1.log"), "log\n");
writeFileSync(join(FAKE, "secret", "hidden.txt"), "s\n");
// deep 鏈帶程式碼（維持容器巢狀行為；純資源目錄另測 assets）
writeFileSync(join(FAKE, "deep", "l1", "l2", "l3", "leaf.mjs"), "export const leaf = 1;\n");
// assets＝純資源目錄（無程式碼）→ 應生成資源卡
writeFileSync(join(FAKE, "assets", "logo.svg"), "<svg/>\n");
writeFileSync(join(FAKE, "assets", "readme.txt"), "res\n");

test("規模控制：.gitignore（secret/、*.log）被尊重；gitignore:false 則照掃", () => {
  const { nodes } = analyzeCodebase(FAKE, { imports: false });
  assert.ok(!nodes.some((n) => n.data?.label === "secret"), "secret/ 應被 .gitignore 排除");
  assert.ok(!nodes.some((n) => n.data?.label === "x1.log"), "*.log 應被排除");
  assert.ok(!nodes.some((n) => n.data?.label === ".gitignore" && false), "noop");
  const off = analyzeCodebase(FAKE, { imports: false, gitignore: false });
  assert.ok(off.nodes.some((n) => n.data?.label === "secret"), "關閉 gitignore 應掃到 secret/");
});

test("規模控制：maxDepth 未展開卡；perDir 聚合「… 其餘 N 檔」；maxFiles 全板上限", () => {
  // maxDepth=1：deep(1) 可展開，l1(2) 應為未展開卡
  const d = analyzeCodebase(FAKE, { imports: false, maxDepth: 1 });
  const stub = d.nodes.find((n) => n.data?.label === "l1/");
  assert.ok(stub, "l1 應為未展開卡（label 帶斜線）");
  assert.match(stub.data.desc, /未展開/);
  assert.ok(d.stats.prunedDirs >= 1);
  // perDir=4：根目錄 10+1 檔（.gitignore 檔本身也算）→ 4 張檔案卡＋摘要卡
  // （新結構：根檔案歸入以根目錄命名的頂層容器 'fake'）
  const p = analyzeCodebase(FAKE, { imports: false, perDir: 4 });
  const root = p.nodes.find((n) => n.data?.kind === "dir" && !n.parentId && n.data.label === "fake");
  const rootFiles = p.nodes.filter((n) => n.parentId === root.id && n.data?.kind === "file");
  assert.equal(rootFiles.length, 4);
  const more = p.nodes.find((n) => n.parentId === root.id && n.data?.kind === "more");
  assert.ok(more, "應有聚合摘要卡");
  assert.match(more.data.label, /… 其餘 \d+ 檔/);
  assert.ok(p.stats.skippedFiles >= 6);
  // maxFiles=3：全板檔案卡 ≤ 3
  const m = analyzeCodebase(FAKE, { imports: false, maxFiles: 3 });
  assert.ok(m.stats.fileCount <= 3, `fileCount=${m.stats.fileCount} 應 ≤ 3`);
});

test("版面 bottom-up 估高＋分層排版：頂層容器不重疊（間距 ≥ 子樹估高）", () => {
  const { nodes } = analyzeCodebase(FAKE, { imports: false });
  // 新結構：deep 與 fake（根檔案容器）皆為頂層容器，由 layoutLayered 定位；
  // 無依賴線＝同欄直向堆疊，垂直間距必須反映 bottom-up 估高（deep 巢狀 3 層很高）
  const tops = nodes.filter((n) => n.data?.kind === "dir" && !n.parentId)
    .sort((a, b) => a.position.y - b.position.y);
  assert.ok(tops.length >= 2, "應有 ≥2 個頂層容器（deep＋根檔案）");
  // 元件打包（shelf packing）：頂層容器可能橫排也可能換列——斷言兩兩「矩形不重疊」
  // （保守最小尺寸 300×500：deep 巢狀 3 層與根檔案容器實際都遠大於此）
  for (let i = 0; i < tops.length; i++) {
    for (let j = i + 1; j < tops.length; j++) {
      const a = tops[i].position, b = tops[j].position;
      const overlapX = Math.abs(a.x - b.x) < 300, overlapY = Math.abs(a.y - b.y) < 500;
      assert.ok(!(overlapX && overlapY),
        `頂層容器 ${tops[i].data.label} 與 ${tops[j].data.label} 不應重疊（Δx=${Math.round(Math.abs(a.x - b.x))}, Δy=${Math.round(Math.abs(a.y - b.y))}）`);
    }
  }
  // deep 內的 l1 仍是巢狀子容器（x=16 直向堆疊）
  const deep = tops.find((n) => n.data.label === "deep");
  const l1 = nodes.find((n) => n.parentId === deep.id && n.data?.kind === "dir");
  assert.ok(l1, "deep 內應有 l1 子容器");
  assert.equal(l1.position.x, 16);
});

test("導入標記：analyze_codebase 設 refBase＝分析根、meta.onboarded；不預種導入卡", async () => {
  const CTX = { writer: "test" };
  const r = await TOOLS.analyze_codebase.run({ path: FAKE, project: "scan2" }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.refBase, FAKE.split("\\").join("/"));
  const cur = await readStore("scan2");
  const board = Array.isArray(cur.pages) ? cur.pages[0] : cur;
  // meta.onboarded 首用標記
  assert.ok(cur.meta?.onboarded, "meta.onboarded 應存在");
  assert.equal(cur.meta.onboarded.by, "test");
  assert.equal(cur.meta.refBase, FAKE.split("\\").join("/"));
  // 機械板本身不預種導入說明卡（2026-07-16 使用者裁定：分析結果頁只留結果本體）——
  // 入職系統 M3 的 G0 導覽卡另落「導覽」分頁，不在機械板上。
  const guide = board.nodes.find((n) => /^G\d+$/i.test((n.data?.num || "").trim()));
  assert.equal(guide, undefined, "機械板不應有 G 類導入說明卡");
  assert.equal(cur.meta.onboarding?.mode, "existing", "入職系統 M3：全新專案路線種 existing 狀態機");
  // registry refBase → getProjectRefBase 解析正確
  const { getProjectRefBase } = await import("../lib/projects.mjs");
  const rb = await getProjectRefBase("scan2");
  assert.equal(rb.split("\\").join("/"), FAKE.split("\\").join("/"));
});

/* ---------- 2026-07-13 新卡型：依賴卡（dep）／資源卡（res） ---------- */
test("資源卡：無程式碼的目錄（assets）→ res 卡，listing 列內容、refs 指向資料夾、不建子卡", () => {
  const { nodes, stats } = analyzeCodebase(FAKE, { imports: false });
  const res = nodes.find((n) => n.type === "res" && n.data.label === "assets");
  assert.ok(res, "assets 應為資源卡");
  assert.ok(res.data.listing.includes("logo.svg") && res.data.listing.includes("readme.txt"), "清單列出內容");
  assert.equal(res.data.refs[0].path, "assets");
  assert.ok(!nodes.some((n) => n.parentId === res.id), "資源卡不建立子資源");
  assert.ok(stats.resCount >= 1);
});

/* ---------- 2026-07-13 介面掃描（scan_interfaces 資料工具） ---------- */
test("scanInterfaces：exports 宣告與 import 符號（含 as 別名、整包引入）", async () => {
  const { scanInterfaces } = await import("../lib/analyze.mjs");
  const IF = join(TMP, "iface");
  mkdirSync(IF, { recursive: true });
  writeFileSync(join(IF, "m.mjs"),
    "import { layoutLayered, placeCard as pc } from \"./layout.mjs\";\n"
    + "import dagre from \"@dagrejs/dagre\";\nimport \"./side.mjs\";\n"
    + "export function alpha() {}\nexport const BETA = 1;\nexport class Gamma {}\n"
    + "const g = 2;\nexport { g as gamma2 };\nexport default alpha;\n");
  const r = scanInterfaces(IF);
  const m = r.files.find((f) => f.path === "m.mjs");
  assert.ok(m, "應掃到 m.mjs");
  assert.deepEqual([...m.exports].sort(), ["BETA", "Gamma", "alpha", "default", "gamma2"]);
  const lay = m.imports.find((i) => i.from === "./layout.mjs");
  assert.deepEqual([...lay.symbols].sort(), ["layoutLayered", "pc"], "as 別名取別名");
  const dg = m.imports.find((i) => i.from === "@dagrejs/dagre");
  assert.deepEqual(dg.symbols, ["dagre"]);
  const side = m.imports.find((i) => i.from === "./side.mjs");
  assert.deepEqual(side.symbols, [], "副作用匯入＝symbols 空");
  assert.equal(r.stats.files, 1);
});

test("scanInterfaces：Go 列——大寫 func/type 匯出、import 單行與區塊（別名／整包）", async () => {
  const { scanInterfaces } = await import("../lib/analyze.mjs");
  const IF = join(TMP, "iface-go");
  mkdirSync(IF, { recursive: true });
  writeFileSync(join(IF, "m.go"),
    "package m\n\nimport \"fmt\"\nimport f2 \"os\"\n"
    + "import (\n\t\"strings\"\n\tio2 \"io\"\n)\n"
    + "func Alpha() {}\nfunc beta() {}\ntype Gamma struct{}\ntype delta int\n"
    + "var xs = []string{\n\t\"not-an-import\",\n}\n");
  const r = scanInterfaces(IF);
  const m = r.files.find((f) => f.path === "m.go");
  assert.deepEqual([...m.exports].sort(), ["Alpha", "Gamma"], "只收大寫開頭的 func/type");
  assert.deepEqual(m.imports.find((i) => i.from === "fmt").symbols, [], "無別名＝整包");
  assert.deepEqual(m.imports.find((i) => i.from === "os").symbols, ["f2"], "單行別名");
  assert.deepEqual(m.imports.find((i) => i.from === "strings").symbols, [], "區塊內無別名");
  assert.deepEqual(m.imports.find((i) => i.from === "io").symbols, ["io2"], "區塊內別名");
  assert.ok(!m.imports.some((i) => i.from === "not-an-import"), "字面字串（帶逗號）不誤收");
});

test("scanInterfaces：Rust 列——pub fn/struct/enum 匯出、use 清單/單項 as/整包", async () => {
  const { scanInterfaces } = await import("../lib/analyze.mjs");
  const IF = join(TMP, "iface-rs");
  mkdirSync(IF, { recursive: true });
  writeFileSync(join(IF, "m.rs"),
    "use std::collections::{HashMap, BTreeMap};\n"
    + "use std::fmt::Debug as Dbg;\nuse serde::*;\n"
    + "pub fn alpha() {}\npub async fn beta() {}\nfn hidden() {}\n"
    + "pub struct Gamma;\npub enum Delta { A }\npub(crate) fn internal() {}\n");
  const r = scanInterfaces(IF);
  const m = r.files.find((f) => f.path === "m.rs");
  assert.deepEqual([...m.exports].sort(), ["Delta", "Gamma", "alpha", "beta"], "pub(crate) 與私有不算");
  assert.deepEqual([...m.imports.find((i) => i.from === "std::collections").symbols].sort(),
    ["BTreeMap", "HashMap"]);
  assert.deepEqual(m.imports.find((i) => i.from === "std::fmt").symbols, ["Dbg"], "as 取別名");
  assert.deepEqual(m.imports.find((i) => i.from === "serde").symbols, [], "::* 整包");
});

test("scanInterfaces：Java/Kotlin 列——public class/interface 匯出、import（含 static、萬用、Kotlin as）", async () => {
  const { scanInterfaces } = await import("../lib/analyze.mjs");
  const IF = join(TMP, "iface-jk");
  mkdirSync(IF, { recursive: true });
  writeFileSync(join(IF, "M.java"),
    "import java.util.List;\nimport static java.util.Arrays.asList;\nimport java.io.*;\n"
    + "public class Main {}\npublic abstract class Base {}\npublic interface Api {}\nclass PkgOnly {}\n");
  writeFileSync(join(IF, "K.kt"),
    "import kotlin.io.path.Path as KPath\npublic data class Item(val x: Int)\n");
  const r = scanInterfaces(IF);
  const j = r.files.find((f) => f.path === "M.java");
  assert.deepEqual([...j.exports].sort(), ["Api", "Base", "Main"], "package-private 不算");
  assert.deepEqual(j.imports.find((i) => i.from === "java.util").symbols, ["List"]);
  assert.deepEqual(j.imports.find((i) => i.from === "java.util.Arrays").symbols, ["asList"], "static import");
  assert.deepEqual(j.imports.find((i) => i.from === "java.io").symbols, [], ".* 整包");
  const k = r.files.find((f) => f.path === "K.kt");
  assert.deepEqual(k.exports, ["Item"]);
  assert.deepEqual(k.imports.find((i) => i.from === "kotlin.io.path").symbols, ["KPath"], "Kotlin 無分號＋as 別名");
});

test("scan_interfaces 工具：path 掃描回傳事實、不寫入任何專案", async () => {
  const r = await TOOLS.scan_interfaces.run({ path: LIB_DIR }, { writer: "test" });
  assert.ok(r.files.length >= 5, "lib/ 應掃到多個檔");
  const layout = r.files.find((f) => f.path === "layout.mjs");
  assert.ok(layout.exports.includes("layoutLayered"));
  const tools = r.files.find((f) => f.path === "tools.mjs");
  assert.ok(tools.imports.some((i) => i.from === "./analyze.mjs" && i.symbols.includes("scanInterfaces")));
});

/* ---------- 2026-07-13 河道分類 v3：rank 分帶＋跨帶節點卡代理 ---------- */
// lanesfx/：a → b → c 依賴鏈（a 另直接 import c ＝ 跨兩帶，應改代理卡）
const LANESFX = join(TMP, "lanesfx");
mkdirSync(join(LANESFX, "a"), { recursive: true });
mkdirSync(join(LANESFX, "b"), { recursive: true });
mkdirSync(join(LANESFX, "c"), { recursive: true });
writeFileSync(join(LANESFX, "a", "x.mjs"), "import \"../b/y.mjs\";\nimport \"../c/z.mjs\";\n");
writeFileSync(join(LANESFX, "b", "y.mjs"), "import \"../c/z.mjs\";\n");
writeFileSync(join(LANESFX, "c", "z.mjs"), "export const z = 1;\n");

test("河道分類：rank 分帶（入口/中間/基礎）、相鄰主體相連、跨 ≥2 帶改節點卡代理", () => {
  const { nodes, edges, stats } = analyzeCodebase(LANESFX, { imports: true });
  const titles = nodes.filter((n) => n.type === "lane").map((l) => l.data.title);
  assert.ok(titles.includes("入口層") && titles.includes("中間層") && titles.includes("基礎層"),
    `河道標題應含入口/中間/基礎，實得 ${titles.join(",")}`);
  const box = (name) => nodes.find((n) => n.data?.kind === "dir" && !n.parentId && n.data.label === name);
  const A = box("a"), B = box("b"), C = box("c");
  assert.ok(A.position.x < B.position.x && B.position.x < C.position.x, "入口在左、基礎在右");
  // 相鄰河道：主體相連
  assert.ok(edges.some((e) => e.source === A.id && e.target === B.id), "a→b 容器線");
  assert.ok(edges.some((e) => e.source === B.id && e.target === C.id), "b→c 容器線");
  // 跨兩帶：不直連，改代理卡
  assert.ok(!edges.some((e) => e.source === A.id && e.target === C.id), "a→c 不應直連");
  const proxy = nodes.find((n) => n.data?.kind === "proxy");
  assert.ok(proxy, "應有節點卡代理");
  assert.equal(proxy.data.proxyFor, C.id, "proxyFor 指向本尊容器");
  assert.match(proxy.data.label, /⇒ \S+ c/, "代理卡 label＝⇒ 本尊編號＋名稱");
  assert.ok(edges.some((e) => e.source === A.id && e.target === proxy.id), "a→代理卡 線");
  assert.equal(stats.proxyCount, 1);
  assert.equal(stats.laneCount, 3);
});

test("依賴卡：外部 import（node:fs/react/@scope）→「外部依賴」容器＋dep 卡（名稱＋引用路徑）", () => {
  const { nodes, stats } = analyzeCodebase(FAKE, { imports: true });
  const box = nodes.find((n) => n.data?.kind === "deps");
  assert.ok(box, "應有外部依賴容器");
  const deps = nodes.filter((n) => n.type === "dep" && n.parentId === box.id);
  const names = deps.map((d) => d.data.label).sort();
  assert.deepEqual(names, ["@dagrejs/dagre", "node:fs", "react"], "套件名去重、scoped 取兩段");
  const react = deps.find((d) => d.data.label === "react");
  assert.equal(react.data.refs[0].path, "a.mjs", "refs＝引用它的程式路徑");
  assert.ok(!nodes.some((n) => n.parentId === react.id), "依賴卡不建立子資源");
  assert.equal(stats.depCount, 3);
  // 依賴卡也有編號（頂層容器字母＋子卡序號）
  assert.ok(box.data.num && react.data.num?.startsWith(box.data.num));
});

/* ---------- 2026-07-17 依賴線多語言（S7-2 DEP_LANGS 表格化） ---------- */
const dlFile = (nodes, refPath) => nodes.find((n) => n.data?.refs?.[0]?.path === refPath)?.id;
const dlEdge = (edges, s, t) => edges.some((e) => e.source === s && e.target === t);
const dlDeps = (nodes) => {
  const box = nodes.find((n) => n.data?.kind === "deps");
  return nodes.filter((n) => n.type === "dep" && n.parentId === box?.id).map((d) => d.data.label);
};

test("依賴線 Python 列：模組路徑→檔案邊、相對匯入→__init__、外部→依賴卡", () => {
  const D = join(TMP, "depspy");
  mkdirSync(join(D, "pkg"), { recursive: true });
  writeFileSync(join(D, "app.py"), "import util\nfrom pkg.mod import thing\nimport numpy\n");
  writeFileSync(join(D, "util.py"), "X = 1\n");
  writeFileSync(join(D, "pkg", "__init__.py"), "\n");
  writeFileSync(join(D, "pkg", "mod.py"), "from . import x\nimport os\n");
  const { nodes, edges } = analyzeCodebase(D, { imports: true });
  assert.ok(dlEdge(edges, dlFile(nodes, "app.py"), dlFile(nodes, "util.py")), "import util → util.py");
  assert.ok(dlEdge(edges, dlFile(nodes, "pkg/mod.py"), dlFile(nodes, "pkg/__init__.py")), "from . import → 本套件 __init__.py");
  const names = dlDeps(nodes);
  assert.ok(names.includes("numpy") && names.includes("os"), "外部模組成依賴卡");
  assert.ok(!names.includes("util") && !names.includes("pkg"), "本地解析到的不進依賴卡");
});

test("依賴線 Go 列：go.mod module 前綴→套件目錄代表檔、標準庫/網域→依賴卡", () => {
  const D = join(TMP, "depsgo");
  mkdirSync(join(D, "app", "util"), { recursive: true });
  writeFileSync(join(D, "go.mod"), "module example.com/myapp\n\ngo 1.22\n");
  writeFileSync(join(D, "app", "main.go"),
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/myapp/app/util"\n\tperr "github.com/pkg/errors"\n)\n');
  writeFileSync(join(D, "app", "util", "util.go"), "package util\n");
  const { nodes, edges } = analyzeCodebase(D, { imports: true });
  assert.ok(dlEdge(edges, dlFile(nodes, "app/main.go"), dlFile(nodes, "app/util/util.go")),
    "同 module import → 套件目錄同名代表檔");
  const names = dlDeps(nodes);
  assert.ok(names.includes("fmt") && names.includes("github.com/pkg/errors"), "標準庫全路徑；網域取前三段");
  assert.ok(!names.some((n) => n.startsWith("example.com/myapp")), "同 module 不進依賴卡");
});

test("依賴線 Rust 列：mod 宣告→同層檔、crate/super 路徑→mod.rs/.rs、外部 crate→依賴卡", () => {
  const D = join(TMP, "depsrs");
  mkdirSync(join(D, "src", "pkg"), { recursive: true });
  writeFileSync(join(D, "src", "main.rs"), "mod util;\nuse crate::pkg::thing;\nuse serde::Deserialize;\n");
  writeFileSync(join(D, "src", "util.rs"), "pub fn u() {}\n");
  writeFileSync(join(D, "src", "pkg", "mod.rs"), "use super::util;\n");
  const { nodes, edges } = analyzeCodebase(D, { imports: true });
  assert.ok(dlEdge(edges, dlFile(nodes, "src/main.rs"), dlFile(nodes, "src/util.rs")), "mod util; → util.rs");
  assert.ok(dlEdge(edges, dlFile(nodes, "src/main.rs"), dlFile(nodes, "src/pkg/mod.rs")), "use crate::pkg::… → pkg/mod.rs（去尾段）");
  assert.ok(dlEdge(edges, dlFile(nodes, "src/pkg/mod.rs"), dlFile(nodes, "src/util.rs")), "use super::util → 上層 util.rs");
  const names = dlDeps(nodes);
  assert.ok(names.includes("serde"), "外部 crate 成依賴卡");
  assert.ok(!names.includes("crate") && !names.includes("super"), "crate/self/super 不進依賴卡");
});

test("依賴線 Java 列：import a.b.C→檔案尾綴比對、外部/萬用→依賴卡（前兩段）", () => {
  const D = join(TMP, "depsjk");
  mkdirSync(join(D, "app", "util"), { recursive: true });
  writeFileSync(join(D, "app", "Main.java"),
    "package app;\n\nimport app.util.Helper;\nimport java.util.List;\nimport java.io.*;\n\npublic class Main {}\n");
  writeFileSync(join(D, "app", "util", "Helper.java"), "package app.util;\n\npublic class Helper {}\n");
  const { nodes, edges } = analyzeCodebase(D, { imports: true });
  assert.ok(dlEdge(edges, dlFile(nodes, "app/Main.java"), dlFile(nodes, "app/util/Helper.java")),
    "import app.util.Helper → 檔案尾綴比對");
  const names = dlDeps(nodes);
  assert.ok(names.includes("java.util") && names.includes("java.io"), "外部＋萬用聚前兩段");
  assert.ok(!names.includes("app.util"), "本地解析到的不進依賴卡");
});
