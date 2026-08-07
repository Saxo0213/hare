// B13 回歸測試：lib/tools.mjs 的 TOOLS（MCP 工具實作）＋ B10 DAG 工具端到端。
// 零依賴；以 HARE_DATA_PATH 覆寫隔離到 OS 暫存檔（先設 env 再 dynamic import）。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const TMP = join(tmpdir(), `hare-tools-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
// dataDir()（圖片資產落點）吃 HARE_DATA_DIR，與 HARE_DATA_PATH 不同；不隔離會寫進 repo/data。
const DATA_DIR = join(tmpdir(), `hare-tools-test-dir-${process.pid}`);
process.env.HARE_DATA_PATH = TMP;
process.env.HARE_DATA_DIR = DATA_DIR;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

const CTX = { writer: "test" };
const call = (name, args = {}) => TOOLS[name].run(args, CTX);

// 種子：一條泳道 + P1(real)→P2→P3 依賴鏈 + 容器 CT 含子卡 CH。
// DAG 邊語意：source 上游前置 → target 下游依賴者。
function seedBoard() {
  return {
    nodes: [
      { id: "L1", type: "lane", data: { title: "測試泳道" } },
      { id: "P1", type: "note", position: { x: 1, y: 2 },
        data: { num: "P1", label: "Card One", status: "real", desc: "第一張", tasks: ["做甲", "做乙"] } },
      { id: "P2", type: "note", position: { x: 300, y: 2 },
        data: { num: "P2", label: "Card Two", status: "plan", desc: "第二張獨特詞" } },
      { id: "P3", type: "note", position: { x: 600, y: 2 },
        data: { num: "P3", label: "Card Three", status: "plan", desc: "第三張" } },
      { id: "CT", type: "note", position: { x: 0, y: 400 },
        data: { num: "CT", label: "Container", status: "plan" } },
      { id: "CH", type: "note", position: { x: 10, y: 10 }, parentId: "CT", extent: "parent",
        data: { num: "CH", label: "Child", status: "plan" } },
    ],
    edges: [
      { id: "e1", source: "P1", target: "P2" },
      { id: "e2", source: "P2", target: "P3" },
    ],
  };
}
async function seed() {
  await writeStore(seedBoard(), "test-seed", { allowEmpty: true });
}
beforeEach(seed);
after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  await rm(DATA_DIR, { recursive: true, force: true });
});

/* ---------- CRUD 與查詢 ---------- */

test("add_card：新增卡，rev 遞增、可被 list 查到", async () => {
  const before = (await call("get_overview")).rev;
  const r = await call("add_card", { label: "新卡", type: "note", num: "P9", status: "plan", tasks: ["t1"] });
  assert.equal(r.ok, true);
  assert.equal(r.rev, before + 1);
  assert.equal(r.card.num, "P9");
  const list = await call("list_cards", { type: "note" });
  assert.ok(list.cards.some((c) => c.num === "P9"), "新卡在 list_cards 中");
});

test("add_card：pin 型缺 refCard 應報錯", async () => {
  await assert.rejects(() => call("add_card", { label: "壞 pin", type: "pin" }), /refCard/);
});

test("HARE 過程觸發：uuid 未埋註解→寫 refs 回 hint 點名；已埋→無 hint；validate 報斷鏈", async () => {
  const srcPath = join(tmpdir(), `mark-src-${process.pid}.mjs`);
  await writeFile(srcPath, "// HARE feedc0de demo anchor\nexport const x = 1;\n");
  const rel = basename(srcPath); // refBase＝資料檔所在目錄（tmpdir）
  try {
    // 已埋 HARE＝無 hint
    const ok = await call("update_card", { card: "P1", refs: [{ path: rel, label: "demo", uuid: "feedc0de" }] });
    assert.equal(ok.hint, undefined, "註解已埋不提醒");
    // 未埋＝hint 點名該 uuid 與路徑
    const miss = await call("update_card", { card: "P2", refs: [{ path: rel, label: "demo", uuid: "0badc0de" }] });
    assert.ok(miss.hint && miss.hint.includes("0badc0de") && miss.hint.includes(rel), "缺註解要點名");
    // add_card 同樣觸發
    const added = await call("add_card", { label: "帶懸空 uuid", type: "note",
      refs: [{ path: rel, label: "demo", uuid: "deadbea7" }] });
    assert.ok(added.hint && added.hint.includes("deadbea7"));
    // validate_cards 事後稽核：斷鏈列出、已埋不誤報
    const va = await call("validate_cards", {});
    assert.ok(va.problems.some((p) => p.issue.includes("HARE 斷鏈") && String(p.detail).includes("0badc0de")));
    assert.ok(!va.problems.some((p) => String(p.detail).includes("feedc0de")), "已埋的 uuid 不報斷鏈");
  } finally {
    await rm(srcPath, { force: true });
  }
});

test("validate_cards：summary＝只回分類計數；limit/offset 分頁＋truncated（讀取金字塔補遺）", async () => {
  // 種子有多張缺 refs 的工作卡（P2/P3/CT/CH）→ 至少數筆問題可分頁。
  const full = await call("validate_cards", {});
  assert.ok(full.total >= 2, "有多筆問題可測分頁");
  assert.equal(full.count, full.problems.length);
  // summary：只回計數、無逐筆清單。
  const sm = await call("validate_cards", { summary: true });
  assert.equal(sm.problems, undefined, "summary 不回逐筆");
  assert.equal(typeof sm.summary, "object");
  assert.equal(sm.total, full.total, "summary.total 與逐筆 total 一致");
  const summed = Object.values(sm.summary).reduce((a, b) => a + b, 0);
  assert.equal(summed, full.total, "各分類計數合計＝總數");
  // limit/offset：第一頁截斷、第二頁接續。
  const p1 = await call("validate_cards", { limit: 1, offset: 0 });
  assert.equal(p1.problems.length, 1);
  assert.equal(p1.truncated, true);
  assert.equal(p1.total, full.total);
  const p2 = await call("validate_cards", { limit: 1, offset: 1 });
  assert.notDeepEqual(p2.problems[0], p1.problems[0], "offset 換頁");
});

test("HARE 範圍錨：起訖成對不報；起點重複、END 無起點／先於起點要報", async () => {
  const srcPath = join(tmpdir(), `mark-range-${process.pid}.mjs`);
  await writeFile(srcPath, [
    "// HARE 900dbeef paired block", "export const a = 1;", "// HARE-END 900dbeef", // 成對
    "// HARE d0d0aaaa dup", "// HARE d0d0aaaa dup again",                           // 起點重複
    "// HARE-END 0badbeef",                                                          // END 無起點
    "// HARE-END facef00d early end", "// HARE facef00d start after end",           // END 先於起點
  ].join("\n") + "\n");
  const rel = basename(srcPath);
  try {
    await call("update_card", { card: "P1", refs: [
      { path: rel, label: "paired", uuid: "900dbeef" },
      { path: rel, label: "dup", uuid: "d0d0aaaa" },
      { path: rel, label: "endonly", uuid: "0badbeef" },
      { path: rel, label: "reversed", uuid: "facef00d" },
    ] });
    const va = await call("validate_cards", {});
    const issuesOf = (u) => va.problems.filter((p) => String(p.detail).includes(u)).map((p) => p.issue);
    assert.deepEqual(issuesOf("900dbeef"), [], "成對範圍錨不報問題");
    assert.ok(issuesOf("d0d0aaaa").some((s) => s.includes("錨點重複")), "同檔重複起點要報");
    assert.ok(issuesOf("0badbeef").some((s) => s.includes("HARE-END 不成對")), "END 無起點要報");
    assert.ok(issuesOf("facef00d").some((s) => s.includes("HARE-END 不成對")), "END 先於起點要報");
  } finally {
    await rm(srcPath, { force: true });
  }
});

test("get_card rel 關係摘要：上下游/父子/pin 一發看到；無關係不帶鍵；fields 模式尊重指定", async () => {
  // P1→P2→P3 依賴鏈：P2 同時有上下游
  const p2 = await call("get_card", { card: "P2" });
  assert.deepEqual(p2.rel, { up: ["P1"], down: ["P3"] }, "P2 上游 P1、下游 P3");
  // 容器與子卡：CT 看到 kids、CH 看到 parent
  const ct = await call("get_card", { card: "CT" });
  assert.deepEqual(ct.rel.kids, ["CH"], "CT 帶子卡編號");
  const ch = await call("get_card", { card: "CH" });
  assert.equal(ch.rel.parent, "CT", "CH 指回父容器編號");
  // pin 引用列入
  await call("add_card", { label: "釘住容器", type: "pin", refCard: "CT", num: "PIN1" });
  const ct2 = await call("get_card", { card: "CT" });
  assert.deepEqual(ct2.rel.pins, ["PIN1"], "引用它的 pin 卡號列入");
  // 無任何關係＝不帶 rel 鍵（省 token）
  const lone = await call("add_card", { label: "孤島測試卡" });
  const loneRead = await call("get_card", { card: lone.card.num });
  assert.equal(loneRead.rel, undefined, "無關係不帶 rel");
  // fields 模式：未點名不給；點名 rel 就給
  const noRel = await call("get_card", { card: "P2", fields: ["label"] });
  assert.equal(noRel.rel, undefined, "fields 未含 rel 不附");
  const withRel = await call("get_card", { card: "P2", fields: ["label", "rel"] });
  assert.deepEqual(withRel.rel, { up: ["P1"], down: ["P3"] }, "fields 點名 rel 附上");
});

test("add_card：工作卡（status≠note）缺 refs 回應帶 hint；說明卡或有 refs 不帶", async () => {
  const p = await call("add_card", { label: "程式卡", status: "plan" });
  assert.ok(p.hint && /refs/.test(p.hint), "工作卡無 refs 應帶補 refs 提醒");
  const ok = await call("add_card", { label: "有連結", status: "plan", refs: [{ path: "lib/tools.mjs", label: "TOOLS" }] });
  assert.equal(ok.hint, undefined, "帶 refs 不提醒");
  const note = await call("add_card", { label: "純筆記" });
  assert.equal(note.hint, undefined, "說明卡（預設 status=note）不提醒");
});

test("get_card_tree：一發回子卡樹＋相連線段＋引用 pin", async () => {
  await call("add_card", { label: "孫卡", parentId: "CH" });   // CT > CH > 孫卡（測遞迴）
  await call("add_card", { label: "釘", type: "pin", refCard: "CT" });
  const r = await call("get_card_tree", { card: "CT" });
  assert.equal(r.card.num, "CT");
  assert.equal(r.children.length, 1, "直屬子卡 CH");
  assert.equal(r.children[0].num, "CH");
  assert.equal(r.children[0].children.length, 1, "孫卡在 CH 之下（遞迴）");
  assert.ok(r.pins && r.pins.length === 1, "引用 CT 的 pin 卡列出");
  // depth 限制：depth 1 只到直屬子卡
  const shallow = await call("get_card_tree", { card: "CT", depth: 1 });
  assert.equal(shallow.children[0].children.length, 0, "depth=1 不含孫卡");
  // 線段鄰域：P1 的樹（無子卡）帶出 P1→P2 線
  const p1 = await call("get_card_tree", { card: "P1" });
  assert.ok(p1.edges.some((e) => e.from.num === "P1" && e.to.num === "P2"), "相連線段附對端編號");
});

test("add_card：子卡編號自動繼承「父號-序號」；頂層仍 N 類（2026-07-16 與前端對齊）", async () => {
  const r1 = await call("add_card", { label: "子一", parentId: "CT" });
  assert.equal(r1.card.num, "CT-1", "首張子卡＝父號-1");
  const r2 = await call("add_card", { label: "子二", parentId: "CT" });
  assert.equal(r2.card.num, "CT-2", "序號遞補");
  // 明給 num 仍尊重呼叫端
  const r3 = await call("add_card", { label: "子三", parentId: "CT", num: "CT-9" });
  assert.equal(r3.card.num, "CT-9");
  const r4 = await call("add_card", { label: "子四", parentId: "CT" });
  assert.equal(r4.card.num, "CT-3", "補最小空號（1、2、9 已用）");
  // 頂層卡不受影響
  const t = await call("add_card", { label: "頂層卡" });
  assert.match(t.card.num, /^N\d+$/);
});

test("get_card：預設精簡摘要（不含 data/color/bg/position）；fields 可指定欄位", async () => {
  const def = await call("get_card", { card: "P1" });
  assert.equal(def.num, "P1");
  assert.equal(def.label, "Card One");
  assert.deepEqual(def.tasks, ["做甲", "做乙"]);
  assert.ok(!("color" in def) && !("position" in def), "預設不回傳 color/position");
  // fields 指定 status + position
  const picked = await call("get_card", { card: "P1", fields: ["status", "position"] });
  assert.deepEqual(picked, { status: "real", position: { x: 1, y: 2 } });
  // 查無的欄位給 null（明確告知）
  const nil = await call("get_card", { card: "P1", fields: ["nonexistent"] });
  assert.deepEqual(nil, { nonexistent: null });
});

test("get_card：找不到卡片拋錯", async () => {
  await assert.rejects(() => call("get_card", { card: "ZZ9" }), /找不到卡片/);
});

test("add_page：建空分頁、add_card 可落頁；撞名拒絕", async () => {
  const r = await call("add_page", { name: "分析" });
  assert.equal(r.ok, true);
  assert.equal(r.page.name, "分析");
  const ov = await call("get_overview");
  assert.ok(Array.isArray(ov.pages) && ov.pages.length === 2, "overview 應列兩個分頁");
  await call("add_card", { label: "頁二卡", num: "X1", page: "分析" });
  const inPage = await call("list_cards", { page: "分析" });
  assert.ok(inPage.cards.some((c) => c.num === "X1"), "新卡落在新分頁");
  await assert.rejects(() => call("add_page", { name: "分析" }), /分頁已存在/);
});

test("delete_page：整頁連卡刪除並回報數量；最後一頁/找不到拒絕", async () => {
  await call("add_page", { name: "待刪頁" });
  await call("add_card", { label: "頁上卡", num: "DEL1", page: "待刪頁" });
  const r = await call("delete_page", { name: "待刪頁" });
  assert.equal(r.ok, true);
  assert.equal(r.removed, "待刪頁");
  assert.equal(r.cards, 1);
  const ov = await call("get_overview");
  assert.ok(!(ov.pages || []).some((p) => p.name === "待刪頁"), "分頁已移除");
  await assert.rejects(() => call("delete_page", { name: "待刪頁" }), /找不到分頁/);
  // 只剩種子頁（單頁時 overview 省略 pages 欄位）→ 最後一頁必擋
  assert.ok(!ov.pages || ov.pages.length === 1, "只剩種子頁");
  await assert.rejects(() => call("delete_page", { name: "主板" }), /最後一頁不可刪除/);
});

test("pin/refCard 跨頁解析（W1-9）：帶 page 建 pin 可引用別頁卡；跨頁撞號要求用 id", async () => {
  await call("add_page", { name: "頁二" });
  // 帶 page 落頁二的 pin，引用第一頁的 P1 —— 修前 findNode 被 __explicitPage 限在頁二找不到
  const r = await call("add_card", { label: "跨頁釘", type: "pin", refCard: "P1", page: "頁二" });
  assert.equal(r.ok, true);
  const pin = await call("get_card", { card: r.card.num, fields: ["refCard", "type"] });
  assert.deepEqual(pin, { refCard: "P1", type: "pin" }, "refCard 解析為目標卡 id（種子 P1 的 id 即 P1）");
  // update_card 同路徑：帶 page 也能把 refCard 指到別頁
  await call("add_card", { label: "頁二素卡", num: "X2", page: "頁二" });
  const u = await call("update_card", { card: "X2", type: "pin", refCard: "P2", page: "頁二" });
  assert.equal(u.ok, true);
  assert.equal((await call("get_card", { card: "X2", fields: ["refCard"] })).refCard, "P2");
  // 跨頁撞號：add_card 已擋（編號制度 2026-07-18），legacy 撞號用底層寫入模擬——
  // 兩頁各有一張同號卡 → refCard 用編號指定要拋錯、訊息建議用 id
  const { updateStore } = await import("../lib/store.mjs");
  await updateStore((d) => {
    d.pages.find((p) => p.name === "頁二").nodes.push({ id: "dupP3", type: "note",
      position: { x: 0, y: 0 }, data: { num: "P3", label: "撞號卡" } });
  }, "test-seed");
  await assert.rejects(
    () => call("add_card", { label: "歧義釘", type: "pin", refCard: "P3", page: "頁二" }),
    /多個分頁|卡片 id/);
});

test("delete_card 批次：cards 清單整批刪除；任一找不到＝整批不動（原子性）", async () => {
  // P2、P3＋容器 CT（連坐子卡 CH）一次刪
  const r = await call("delete_card", { cards: ["P2", "P3", "CT"] });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.removed].sort(), ["CH", "CT", "P2", "P3"]);
  const left = await call("list_cards", {});
  assert.ok(!left.cards.some((c) => ["P2", "P3", "CT", "CH"].includes(c.num)), "四張皆已刪");
  // 原子性：批次含不存在的卡 → 整批拒絕，P1 仍在
  await assert.rejects(() => call("delete_card", { cards: ["P1", "ZZ9"] }), /找不到卡片/);
  assert.equal((await call("get_card", { card: "P1" })).num, "P1", "P1 未被刪（整批回滾）");
  // 兩參數皆缺＝報錯
  await assert.rejects(() => call("delete_card", {}), /card/);
});

test("desc 呈現：list_cards 預設回 desc_head 首行 80 字；search 回 120 字預覽；get_card/fields 回全文", async () => {
  const LONG = "甲".repeat(300);
  await call("update_card", { card: "P2", desc: LONG });
  // list_cards 預設瘦身列＝desc_head 首行 80 字（無省略號，不再帶 desc 預覽欄）
  const inList = (await call("list_cards", { type: "note" })).cards.find((c) => c.num === "P2");
  assert.equal(inList.desc_head, "甲".repeat(80));
  assert.equal(inList.desc, undefined, "瘦身列不再帶 desc 預覽欄");
  // search_cards 仍為 120 字截斷預覽
  const inSearch = (await call("search_cards", { query: "Card Two" })).cards[0];
  assert.equal(inSearch.desc, "甲".repeat(120) + "…");
  // 點名查卡＝全文
  assert.equal((await call("get_card", { card: "P2" })).desc, LONG);
  // list_cards fields 指定 desc＝全文（opt-in 全量欄位）
  const picked = await call("list_cards", { type: "note", fields: ["num", "desc"] });
  assert.equal(picked.cards.find((c) => c.num === "P2").desc, LONG);
  // 短 desc：desc_head 原樣（單行、未逾 80 字）
  assert.equal((await call("list_cards", { type: "note" })).cards.find((c) => c.num === "P3").desc_head, "第三張");
});

test("update_card：改狀態並持久化；null 刪除欄位鍵", async () => {
  const r = await call("update_card", { card: "P2", status: "real" });
  assert.equal(r.ok, true);
  assert.equal((await call("get_card", { card: "P2" })).status, "real");
  // desc 設 null → 刪鍵
  await call("update_card", { card: "P2", desc: null });
  assert.equal((await call("get_card", { card: "P2" })).desc, null);
});

test("update_card：改卡型（type）＋前置條件驗證", async () => {
  // note → dep（內容卡互轉）
  const r = await call("update_card", { card: "P3", type: "dep" });
  assert.equal(r.ok, true);
  assert.equal((await call("get_card", { card: "P3" })).type, "dep");
  await call("update_card", { card: "P3", type: "note" }); // 還原
  // pin 需 refCard：同呼叫帶編號 → 解析存目標卡 id；轉回 note 還原
  await assert.rejects(call("update_card", { card: "P3", type: "pin" }), /refCard/);
  await call("update_card", { card: "P3", type: "pin", refCard: "P1" });
  const p3 = await call("get_card", { card: "P3", fields: ["type", "refCard"] });
  assert.deepEqual(p3, { type: "pin", refCard: "P1" }); // P1＝目標卡 id（種子卡 id 即 P1）
  await call("update_card", { card: "P3", type: "note", refCard: null });
  // 容器不可轉
  await assert.rejects(call("update_card", { card: "L1", type: "note" }), /不可轉換/);
});

test("清單視圖拔 refs（W1-9 裁定）：list/search 預設不回 refs；get_card 與 fields 明點仍給", async () => {
  await call("update_card", { card: "P1", refs: [{ path: "lib/tools.mjs", label: "TOOLS" }] });
  const inList = (await call("list_cards", {})).cards.find((c) => c.num === "P1");
  assert.equal(inList.refs, undefined, "list_cards 預設摘要不含 refs");
  const inSearch = (await call("search_cards", { query: "Card One" })).cards[0];
  assert.equal(inSearch.refs, undefined, "search_cards 結果不含 refs");
  // refs 內容仍可被搜到（只是不隨清單回傳）
  assert.equal((await call("search_cards", { query: "lib/tools.mjs" })).cards[0].num, "P1");
  // get_card 點名＝全量 refs；list_cards fields 明點 refs 也給
  assert.equal((await call("get_card", { card: "P1" })).refs.length, 1);
  const picked = (await call("list_cards", { fields: ["num", "refs"] })).cards.find((c) => c.num === "P1");
  assert.equal(picked.refs.length, 1, "fields 明點 refs 仍回傳");
});

test("search_cards：命中編號/名稱/說明/任務", async () => {
  const r = await call("search_cards", { query: "獨特詞" });
  assert.equal(r.count, 1);
  assert.equal(r.cards[0].num, "P2");
  assert.equal((await call("search_cards", { query: "做甲" })).cards[0].num, "P1");
});

test("complete_task：從 tasks 移到 doneTasks（帶時間戳）", async () => {
  const r = await call("complete_task", { card: "P1", task: "做甲" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks, ["做乙"], "剩餘待辦");
  assert.deepEqual(r.doneTasks, ["做甲"], "已封存");
  // 索引越界報錯
  await assert.rejects(() => call("complete_task", { card: "P1", task: 99 }), /索引超出範圍/);
});

test("complete_task 帶 commit：封存項存 commit 編號；search_cards 以 hash 反查", async () => {
  await call("complete_task", { card: "P1", task: "做甲", commit: "abc1234def" });
  const g = await call("get_card", { card: "P1", fields: ["doneTasks"] });
  // get_card 的 doneTasks 可能是文字摘要；直接查 search（涵蓋封存與 commit）
  const s = await call("search_cards", { query: "abc1234def" });
  assert.equal(s.count, 1);
  assert.equal(s.cards[0].num, "P1", "commit hash 反查到卡片");
  void g;
});

test("tag_commit：回填 commit 到無 commit 的封存項，不覆蓋既有；contains 過濾", async () => {
  await call("complete_task", { card: "P1", task: "做甲" });                       // 無 commit
  await call("complete_task", { card: "P1", task: "做乙", commit: "old9999" });    // 已有 commit
  const r = await call("tag_commit", { commit: "fff0000", cards: ["P1"] });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1, "只補無 commit 的那條");
  assert.match(r.tagged[0], /做甲/);
  // 既有 commit 不被覆蓋
  assert.equal((await call("search_cards", { query: "old9999" })).count, 1);
  assert.equal((await call("search_cards", { query: "fff0000" })).count, 1);
  // 卡片不存在→報錯
  await assert.rejects(() => call("tag_commit", { commit: "x", cards: ["NOPE"] }), /找不到卡片/);
});

test("delete_card：刪容器連同子卡；相連邊一併移除", async () => {
  const r = await call("delete_card", { card: "CT" });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.removed].sort(), ["CH", "CT"], "容器與子卡一起刪");
  const list = await call("list_cards", {});
  assert.ok(!list.cards.some((c) => ["CT", "CH"].includes(c.num)));
});

/* ---------- move_card：attach / detach / reposition / 防環 ---------- */

test("move_card attach：設父容器 → parentId 與 extent 生效", async () => {
  const r = await call("move_card", { card: "P3", parentId: "CT" });
  assert.equal(r.ok, true);
  assert.equal(r.card.parentId, "CT");
  assert.equal((await call("get_card", { card: "P3", fields: ["parentId"] })).parentId, "CT");
});

test("move_card detach：parentId=null 脫離成頂層並轉絕對座標（不跳位）", async () => {
  // CH 在 CT(0,400) 內相對 (10,10) → 絕對 (10,410)
  const r = await call("move_card", { card: "CH", parentId: null });
  assert.equal(r.card.parentId, null);
  assert.deepEqual(r.card.position, { x: 10, y: 410 }, "脫離後座標轉絕對");
});

test("move_card reposition：只改 x/y", async () => {
  const r = await call("move_card", { card: "P2", x: 42, y: 99 });
  assert.deepEqual(r.card.position, { x: 42, y: 99 });
});

test("move_card 防環：不可搬入自己的子孫；不可設為自己的子卡", async () => {
  await assert.rejects(() => call("move_card", { card: "CT", parentId: "CH" }), /子孫|成環/);
  await assert.rejects(() => call("move_card", { card: "CT", parentId: "CT" }), /自己的子卡/);
});

/* ---------- B10 DAG 智慧工具 ---------- */

test("get_ready_cards：上游全 real 且自身未 real（P2 就緒，P1 real 排除，P3 被 P2 擋）", async () => {
  const r = await call("get_ready_cards");
  const nums = r.ready.map((c) => c.num);
  assert.ok(nums.includes("P2"), "P2 就緒（上游 P1 real）");
  assert.ok(!nums.includes("P1"), "P1 已 real 排除");
  assert.ok(!nums.includes("P3"), "P3 上游 P2 未 real → 未就緒");
});

test("get_blockers：P3 的阻塞鏈為 [P2]（P1 real 不計）", async () => {
  const r = await call("get_blockers", { card: "P3" });
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers.map((c) => c.num), ["P2"]);
  assert.equal((await call("get_blockers", { card: "P2" })).ready, true);
});

test("get_downstream：P1 的下游為 P2、P3", async () => {
  const r = await call("get_downstream", { card: "P1" });
  assert.deepEqual(r.downstream.map((c) => c.num).sort(), ["P2", "P3"]);
});

test("detect_cycles：種子為乾淨 DAG（無環）", async () => {
  assert.equal((await call("detect_cycles")).hasCycle, false);
});

test("detect_cycles：加一條 P3→P1 造環後偵測到", async () => {
  await call("add_edge", { source: "P3", target: "P1" });
  const r = await call("detect_cycles");
  assert.equal(r.hasCycle, true);
  assert.ok(r.count >= 1);
});

test("critical_path：最長依賴鏈 P1→P2→P3（長度 3）", async () => {
  const cp = await call("critical_path");
  assert.equal(cp.length, 3);
  assert.deepEqual(cp.path.map((c) => c.num), ["P1", "P2", "P3"]);
});

/* ---------- 入職系統 M2b 省讀協定：get_graph / list_cards 瘦身 / kind 分類 ---------- */

test("get_graph pack：容器巢狀 outline、邊 num 化、ready/blocked/critical 註記", async () => {
  const r = await call("get_graph", {}); // 預設 view=pack
  assert.equal(r.view, "pack");
  const t = r.text;
  assert.ok(t.includes("測試泳道"), "泳道標題列為前置脈絡");
  // 頂層卡與容器巢狀（CT 容器、CH 子卡縮排）
  assert.ok(/- CT Container \[plan\]/.test(t), "容器卡一行");
  assert.ok(/ {2}- CH Child \[plan\]/.test(t), "子卡縮排一層");
  assert.ok(/- P1 Card One \[real\] \(T:2\)/.test(t), "開放任務數 (T:2)");
  // 邊集 num 化
  assert.ok(t.includes("依賴: P1→P2, P2→P3"), "邊集以 num 表示");
  // 註記：P2 就緒（上游 P1 real）；P3 被 P2 擋；critical 鏈
  assert.ok(/ready: .*P2/.test(t), "ready 含 P2");
  assert.ok(/blocked: .*P3\(擋於 P2\)/.test(t), "blocked 標出 P3 擋於 P2");
  assert.ok(t.includes("critical: P1→P2→P3"), "critical 鏈");
});

test("get_graph steps：Kahn 並行分層 + 依賴註記", async () => {
  // 加一張與 P1 同層（無依賴）的獨立工作卡 P0，驗「可並行」
  await call("add_card", { label: "Zero", num: "P0", status: "plan" });
  const r = await call("get_graph", { view: "steps" });
  assert.equal(r.view, "steps");
  const t = r.text;
  assert.ok(/第 1 步：/.test(t), "有第 1 步");
  assert.ok(/第 2 步：.*P2（依 P1）/.test(t), "P2 在後續步且註記依 P1");
  // P0 與 P1 同為無依賴 → 第 1 步含「可並行」
  assert.ok(/第 1 步：.*可並行/.test(t), "多張無依賴卡標可並行");
});

test("get_graph steps：有環時明講成環卡，其餘照排", async () => {
  await call("add_edge", { source: "P3", target: "P1" }); // P1→P2→P3→P1 成環
  const r = await call("get_graph", { view: "steps" });
  assert.ok(/成環（未能排入）/.test(r.text), "回報成環");
  assert.ok(/P1|P2|P3/.test(r.text));
});

test("list_cards 瘦身：預設新欄位（type/parent/open_tasks/desc_head），不帶 tasks 全文", async () => {
  const r = await call("list_cards", {});
  const ch = r.cards.find((c) => c.num === "CH");
  assert.equal(ch.type, "note");
  assert.equal(ch.parent, "CT", "parent 以父卡 num 表示");
  const p1 = r.cards.find((c) => c.num === "P1");
  assert.equal(p1.open_tasks, 2, "開放任務數");
  assert.equal(p1.tasks, undefined, "預設列不帶 tasks 全文");
  assert.equal(p1.desc_head, "第一張", "desc_head 首行");
});

test("list_cards limit/offset：截斷回 truncated + total", async () => {
  const all = await call("list_cards", {});
  const total = all.count;
  const r = await call("list_cards", { limit: 2 });
  assert.equal(r.cards.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.total, total);
  // offset 跳過
  const r2 = await call("list_cards", { offset: 1, limit: 100 });
  assert.equal(r2.cards.length, total - 1);
  assert.equal(r2.truncated, true);
  // 全量無截斷＝無 truncated 旗標
  const full = await call("list_cards", { limit: total });
  assert.equal(full.truncated, undefined);
});

test("get_ready_cards kind 分類：G 慣例卡=guide、容器=container、工作卡=work", async () => {
  // G1（導覽慣例）、其上游 P1 real → 就緒；CT 為容器（CH 指向它）但需上游 real 才就緒
  await call("add_card", { label: "導覽", num: "G1", status: "plan" });
  await call("add_edge", { source: "P1", target: "G1" }); // 上游 P1 real → G1 就緒
  const r = await call("get_ready_cards", {});
  const g1 = r.ready.find((c) => c.num === "G1");
  assert.equal(g1.kind, "guide", "G 慣例卡＝guide");
  assert.ok(typeof g1.open_tasks === "number", "帶 open_tasks");
  const p2 = r.ready.find((c) => c.num === "P2");
  assert.equal(p2.kind, "work", "一般工作卡＝work");
  // CT 容器：無上游 → 就緒，kind=container
  const ct = r.ready.find((c) => c.num === "CT");
  assert.equal(ct.kind, "container", "板上有卡 parentId 指向它＝container");
});

/* ---------- 圖片卡：attach_image / set_region_result（視覺回饋迴圈 hare-ui-feedback） ---------- */

// 最小點陣圖：PNG magic + 補足 12 bytes（sniffRaster 只驗前綴、saveAsset 只寫檔，不需完整 PNG）
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const TXT_BYTES = Buffer.from("this is not an image, only text bytes here — should be rejected");
async function tmpImage(name, bytes = PNG_BYTES) {
  const p = join(tmpdir(), `hare-test-${process.pid}-${name}`);
  await writeFile(p, bytes);
  return p;
}

test("attach_image：省略 card＝新建 img 卡，回 URL、可被 get_card 讀回", async () => {
  const path = await tmpImage("shot1.png");
  const r = await call("attach_image", { path, label: "登入頁截圖" });
  assert.equal(r.ok, true);
  assert.equal(r.card.type, "img");
  assert.match(r.url, /^\/api\/assets\/default\/.+\.png$/);
  const got = await call("get_card", { card: r.card.num });
  assert.equal(got.type, "img");
  assert.ok(got.image && got.image.includes("assets"), "get_card 回圖檔磁碟路徑");
});

test("attach_image：card 給既有 img 卡＝追加到 gallery、切換顯示圖", async () => {
  const first = await call("attach_image", { path: await tmpImage("a.png"), label: "圖卡" });
  const r = await call("attach_image", { path: await tmpImage("b.png"), card: first.card.num });
  assert.equal(r.ok, true);
  const full = await call("get_card", { card: first.card.num, fields: ["gallery", "src"] });
  assert.equal(full.gallery.length, 2, "gallery 應有兩張圖");
  assert.equal(full.src, r.url, "顯示圖切到最新一張");
});

test("attach_image：對非圖片卡追加應報錯", async () => {
  const path = await tmpImage("x.png");
  await assert.rejects(() => call("attach_image", { path, card: "P1" }), /不是圖片卡/);
});

test("attach_image：非點陣圖（文字/svg）拒收", async () => {
  const path = await tmpImage("fake.png", TXT_BYTES);
  await assert.rejects(() => call("attach_image", { path }), /點陣圖/);
});

// 種一張帶範圍框 R1 的圖片卡（regions 由前端畫出，測試直接寫入板）
async function seedImgCardWithRegion(num, regions) {
  await writeStore({
    nodes: [{ id: `IMG_${num}`, type: "img", position: { x: 0, y: 0 },
      data: { num, label: "頁面", status: "note", src: `/api/assets/default/${num}-seed.png`,
        gallery: [{ src: `/api/assets/default/${num}-seed.png`, name: "頁面", strokes: [], regions }] } }],
    edges: [],
  }, "test", { allowEmpty: true });
}

test("set_region_result：把截圖設為 R1 結果圖，get_card 該框回 result", async () => {
  await seedImgCardWithRegion("N1", [{ id: "rg1", n: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
  const r = await call("set_region_result", { card: "N1", region: "R1", image: await tmpImage("after.png") });
  assert.equal(r.ok, true);
  assert.equal(r.region, "R1");
  const got = await call("get_card", { card: "N1" });
  const reg = got.regions.find((x) => x.n === "R1");
  assert.ok(reg && reg.result && reg.result.includes("assets"), "R1 有 result（改後畫面）欄位");
});

test("set_region_result：找不到的 R 編號報錯", async () => {
  await seedImgCardWithRegion("N2", []);
  const image = await tmpImage("z.png");
  await assert.rejects(() => call("set_region_result", { card: "N2", region: "R9", image }), /找不到範圍框/);
});

test("validateToolArgs：缺必填/未知參數明確報錯（q vs query 事故防線）", async () => {
  const { validateToolArgs } = await import("../lib/tools.mjs");
  const t = TOOLS.search_cards;
  assert.match(validateToolArgs(t, { q: "F3" }) || "", /缺少必要參數：query/);
  assert.match(validateToolArgs(t, { query: "F3", q: "F3" }) || "", /未知參數：q/);
  assert.equal(validateToolArgs(t, { query: "F3" }), null);
  assert.equal(validateToolArgs(t, { query: "F3", project: "x", page: "y" }), null); // 注入參數合法
});

test("編號制度（2026-07-18 裁定）：cat 指定分類系統自編；手動 num 撞號拒絕（add/update）", async () => {
  // cat：P 類已有 P1..P3 → 自編 P4
  const r = await call("add_card", { label: "分類自編", cat: "P" });
  assert.equal(r.card.num, "P4");
  // cat 新分類＝從 1 起
  const w = await call("add_card", { label: "新分類", cat: "w" }); // 小寫正規化
  assert.equal(w.card.num, "W1");
  // 手動 num 撞號＝拒
  await assert.rejects(() => call("add_card", { label: "撞號卡", num: "P1" }), /已存在/);
  // update_card 改號撞號＝拒；改成空號可
  await assert.rejects(() => call("update_card", { card: "P2", num: "P3" }), /已存在/);
  const mv = await call("update_card", { card: "P2", num: "P9" });
  assert.equal(mv.ok, true);
});

test("scan_file_tree（檔案總管建構）：資源包資源、檔案進清單不建卡、單類別編號、拒絕覆蓋", async () => {
  const { fileURLToPath } = await import("node:url");
  const { resolve: rp, dirname: dn } = await import("node:path");
  const { readStore } = await import("../lib/store.mjs");
  const repoRoot = rp(dn(fileURLToPath(import.meta.url)), "..");
  const r = await TOOLS.scan_file_tree.run({ path: rp(repoRoot, ".claude", "skills"), project: "ftproj" }, { writer: "test" });
  assert.equal(r.ok, true);
  assert.ok(r.dirCount >= 2, "skills 下有子資料夾＝至少 2 個目錄");
  const cur = await readStore("ftproj");
  const nodes = Array.isArray(cur.pages) ? cur.pages[0].nodes : cur.nodes;
  assert.ok(nodes.every((n) => n.type === "res"), "全部都是資源卡、無獨立檔案卡");
  const root = nodes.find((n) => !n.parentId);
  assert.ok(nodes.some((n) => n.parentId === root.id), "子資料夾＝巢狀子資源卡");
  const kid = nodes.find((n) => n.parentId === root.id);
  assert.ok(kid.data.listing.every((x) => typeof x === "object" && x.name), "清單為物件列");
  assert.ok(kid.data.listing.some((x) => x.kind === "file" && x.path), "檔案列帶 path");
  assert.ok(/^[A-Z]+$/.test(root.data.num), "根＝類別字母");
  assert.ok(new RegExp("^" + root.data.num + "[0-9]+$").test(kid.data.num),
    "子孫＝類別+序號（root=" + root.data.num + " kid=" + kid.data.num + "）");
  await assert.rejects(() => TOOLS.scan_file_tree.run({ path: rp(repoRoot, "lib"), project: "ftproj" }, { writer: "test" }), /已有.*卡片/);
});
