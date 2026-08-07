// B4 多專案化·資料層單元測試（零依賴，node --test）。
// 隔離：HARE_DATA_DIR 指向暫存資料夾、HARE_DATA_PATH 指向暫存的預設專案檔——
// 全程不碰 repo 內真實的 roadmap-data.json 或 data/。env 在動態 import 前設好，
// store.mjs 的路徑解析（含 legacy 常數）一律落在暫存區。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hare-b4-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default-legacy.json");

const { readStore, writeStore, updateStore, dataPathFor, normalizeProjectId } = await import("../lib/store.mjs");
const { listProjects, createProject, renameProject, deleteProject } = await import("../lib/projects.mjs");
const { TOOLS } = await import("../lib/tools.mjs");
// analyze 分頁測試用：真實 lib/ 目錄（唯讀掃描）
import { resolve as resolvePath, dirname as dirnameOf } from "node:path";
import { fileURLToPath } from "node:url";
const LIB_DIR_MP = resolvePath(dirnameOf(fileURLToPath(import.meta.url)), "..", "lib");

const card = (id) => ({ id, type: "note", data: { num: id, label: id, status: "plan" } });

test("預設專案向後相容：不帶 project 沿用 HARE_DATA_PATH，rev 遞增", async () => {
  assert.equal(dataPathFor(), process.env.HARE_DATA_PATH);
  assert.equal(await readStore(), null); // 尚未建立
  const o1 = await writeStore({ nodes: [card("d1")], edges: [] }, "test");
  assert.equal(o1.rev, 1);
  const o2 = await updateStore((d) => { d.nodes.push(card("d2")); }, "test");
  assert.equal(o2.out.rev, 2);
  const cur = await readStore();
  assert.equal(cur.rev, 2);
  assert.equal(cur.nodes.length, 2);
  // 帶 project:"default" 與不帶完全等價
  assert.equal(dataPathFor("default"), dataPathFor());
  assert.equal((await readStore("default")).rev, 2);
});

test("建立／列出專案：list 含 default 與新專案，標題正確", async () => {
  const r = await createProject("alpha", { title: "Alpha 板" });
  assert.equal(r.id, "alpha");
  assert.equal(r.rev, 1);
  const { projects } = await listProjects();
  const ids = projects.map((p) => p.id).sort();
  assert.ok(ids.includes("default"));
  assert.ok(ids.includes("alpha"));
  assert.equal(projects[0].id, "default"); // 預設排第一
  const alpha = projects.find((p) => p.id === "alpha");
  assert.equal(alpha.title, "Alpha 板");
  // 資料檔落在 data/alpha.json
  assert.equal(dataPathFor("alpha"), join(process.env.HARE_DATA_DIR, "alpha.json"));
});

test("每專案 rev 獨立遞增，互不影響", async () => {
  await writeStore({ nodes: [card("b1")], edges: [] }, "test", { project: "beta" }); // beta rev1
  await writeStore({ nodes: [card("b1")], edges: [] }, "test", { project: "beta" }); // beta rev2
  await writeStore({ nodes: [card("g1")], edges: [] }, "test", { project: "gamma" }); // gamma rev1
  assert.equal((await readStore("beta")).rev, 2);
  assert.equal((await readStore("gamma")).rev, 1);
  // default 不受影響（仍為前一測試留下的 rev 2）
  assert.equal((await readStore("default")).rev, 2);
});

test("每專案資料隔離：卡片不外洩到其他專案", async () => {
  await updateStore((d) => { d.nodes.push(card("only-alpha")); }, "test", { project: "alpha" });
  await updateStore((d) => { d.nodes.push(card("only-beta")); }, "test", { project: "beta" });
  const a = (await readStore("alpha")).nodes.map((n) => n.id);
  const b = (await readStore("beta")).nodes.map((n) => n.id);
  assert.ok(a.includes("only-alpha"));
  assert.ok(!a.includes("only-beta"));
  assert.ok(b.includes("only-beta"));
  assert.ok(!b.includes("only-alpha"));
});

test("同專案併發寫入序列化：3 則同時 add 全部存活", async () => {
  await Promise.all([
    updateStore((d) => { d.nodes.push(card("c1")); }, "test", { project: "concpj" }),
    updateStore((d) => { d.nodes.push(card("c2")); }, "test", { project: "concpj" }),
    updateStore((d) => { d.nodes.push(card("c3")); }, "test", { project: "concpj" }),
  ]);
  const cur = await readStore("concpj");
  assert.equal(cur.nodes.length, 3);
  assert.equal(cur.rev, 3);
  const ids = cur.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["c1", "c2", "c3"]);
});

test("種子模板：swimlane 種一張 lane 卡、prefix 存於 meta", async () => {
  const r = await createProject("tmpl", { title: "範本", prefix: "T", swimlane: "第一泳道" });
  assert.equal(r.prefix, "T");
  const cur = await readStore("tmpl");
  assert.equal(cur.meta.prefix, "T");
  const lanes = cur.nodes.filter((n) => n.type === "lane");
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].data.title, "第一泳道");
});

test("非法專案代號一律拒絕（防路徑穿越）", async () => {
  assert.throws(() => normalizeProjectId("../evil"));
  assert.throws(() => normalizeProjectId("a/b"));
  assert.throws(() => normalizeProjectId("_leading"));
  await assert.rejects(() => createProject("../evil"));
  // 保留字：不可重建或改為 default
  await assert.rejects(() => createProject("default"));
});

test("改名與刪除專案", async () => {
  await createProject("torename", { title: "待改名" });
  const rr = await renameProject("torename", "renamed");
  assert.equal(rr.id, "renamed");
  assert.ok((await listProjects()).projects.some((p) => p.id === "renamed"));
  assert.ok(!(await listProjects()).projects.some((p) => p.id === "torename"));

  await createProject("todelete");
  await deleteProject("todelete");
  assert.ok(!(await listProjects()).projects.some((p) => p.id === "todelete"));
  await assert.rejects(() => deleteProject("default")); // 預設不可刪
});

test("MCP 工具：list_projects / create_project / add_card 帶 project 隔離", async () => {
  await TOOLS.create_project.run({ id: "toolpj", title: "工具建立" }, { writer: "test" });
  const listed = await TOOLS.list_projects.run({});
  assert.ok(listed.projects.some((p) => p.id === "toolpj"));

  const added = await TOOLS.add_card.run({ label: "工具卡", project: "toolpj" }, { writer: "test" });
  assert.equal(added.ok, true);

  // 卡片只進 toolpj，不進 default
  const inTool = await TOOLS.list_cards.run({ project: "toolpj" });
  assert.ok(inTool.cards.some((c) => c.label === "工具卡"));
  const inDefault = await TOOLS.list_cards.run({});
  assert.ok(!inDefault.cards.some((c) => c.label === "工具卡"));

  // get_overview 回報正確的 project 與資料檔
  const ov = await TOOLS.get_overview.run({ project: "toolpj" });
  assert.equal(ov.project, "toolpj");
  assert.equal(ov.data_file, dataPathFor("toolpj"));
});

/* ---------- 2026-07-13 專案管理頁配套：封存/解封＋清單欄位（refBase/langs） ---------- */
test("archive_project：封存後清單不列、檔案搬 data/archive/；unarchive 還原", async () => {
  await TOOLS.create_project.run({ id: "arctest", title: "封存測試" }, { writer: "test" });
  const r = await TOOLS.archive_project.run({ id: "arctest" }, { writer: "test" });
  assert.equal(r.ok, true);
  const list1 = await TOOLS.list_projects.run({}, { writer: "test" });
  assert.ok(!list1.projects.some((p) => p.id === "arctest"), "封存後不應列出");
  // 資料檔已搬走
  const { dataPathFor } = await import("../lib/store.mjs");
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(dataPathFor("arctest")), "原位資料檔應已搬走");
  // 同 id 再建立→拒絕（id 保留防撞名）
  await assert.rejects(() => TOOLS.create_project.run({ id: "arctest" }, { writer: "test" }), /已存在/);
  // 解封→恢復列出、資料檔回原位
  const u = await TOOLS.unarchive_project.run({ id: "arctest" }, { writer: "test" });
  assert.equal(u.ok, true);
  const list2 = await TOOLS.list_projects.run({}, { writer: "test" });
  assert.ok(list2.projects.some((p) => p.id === "arctest"), "解封後應恢復列出");
  assert.ok(existsSync(dataPathFor("arctest")), "資料檔應回原位");
  // 預設專案不可封存
  await assert.rejects(() => TOOLS.archive_project.run({ id: "default" }, { writer: "test" }), /不可封存/);
});

test("list_projects：每筆帶 refBase（對應資料夾）與 langs（程式碼類型）", async () => {
  const list = await TOOLS.list_projects.run({}, { writer: "test" });
  const def = list.projects.find((p) => p.isDefault);
  assert.ok(def.refBase, "default 應有 refBase");
  assert.equal(typeof def.langs, "string"); // 內容依實際資料夾而定，型別正確即可
});

test("專案分頁 v2：單頁 collapse v1、多頁寫出 pages；page 參數落頁、跨頁找卡/刪卡", async () => {
  const { ensurePages } = await import("../lib/store.mjs");
  await createProject("pgproj", { title: "分頁測試" });
  await TOOLS.add_card.run({ label: "首頁卡", num: "A1", project: "pgproj" }, { writer: "test" });
  let cur = await readStore("pgproj");
  assert.ok(Array.isArray(cur.nodes), "單頁專案應維持 v1 形狀（nodes 在頂層）");
  // 開第二頁（pageOps 的底層等價操作）→ 檔案升級為 v2 pages
  await updateStore((d) => { ensurePages(d); d.pages.push({ id: "p2", name: "分析",
    nodes: [], edges: [], viewport: null, deletedEdges: [], constraints: [] }); }, "test", { project: "pgproj" });
  cur = await readStore("pgproj");
  assert.ok(Array.isArray(cur.pages) && cur.pages.length === 2, "兩頁應寫出 v2 pages");
  assert.equal(cur.pages[0].nodes.length, 1, "第一頁保留原卡");
  // page 參數：卡片落到指定分頁（以分頁名指定）
  await TOOLS.add_card.run({ label: "分析卡", num: "B1", project: "pgproj", page: "分析" }, { writer: "test" });
  cur = await readStore("pgproj");
  assert.equal(cur.pages.find((p) => p.id === "p2").nodes.length, 1, "新卡應落在分析頁");
  // 跨頁找卡：不帶 page 也找得到第二頁的卡
  const g = await TOOLS.get_card.run({ card: "B1", project: "pgproj" }, { writer: "test" });
  assert.equal(g.label, "分析卡");
  // search_cards 跨全頁且附分頁名
  const sr = await TOOLS.search_cards.run({ query: "分析卡", project: "pgproj" }, { writer: "test" });
  assert.equal(sr.count, 1);
  assert.equal(sr.cards[0].page, "分析");
  // 線段不可跨分頁
  await assert.rejects(() => TOOLS.add_edge.run({ source: "A1", target: "B1", project: "pgproj" }, { writer: "test" }),
    /不可跨分頁/);
  // 跨頁刪卡：刪除落在所屬頁
  await TOOLS.delete_card.run({ card: "B1", project: "pgproj" }, { writer: "test" });
  cur = await readStore("pgproj");
  assert.equal(cur.pages.find((p) => p.id === "p2").nodes.length, 0);
  assert.equal(cur.pages[0].nodes.length, 1, "第一頁不受影響");
});

test("整體資料觀：不帶 page＝列舉全專案（附分頁名）；跨頁撞編號點名丟錯、帶 page 限定", async () => {
  // 先長出「架構」分頁（下一個 test 的前置也順便驗證一次）——見下方 analyze 分頁測試
  await TOOLS.analyze_codebase.run({ path: LIB_DIR_MP, project: "pgproj", page: "架構" }, { writer: "test" });
  const lc = await TOOLS.list_cards.run({ project: "pgproj" }, { writer: "test" });
  assert.ok(lc.cards.some((c) => c.page === "架構"), "列舉應含其他分頁卡片並附 page 名");
  assert.ok(lc.cards.some((c) => c.page === "主板" && c.label === "首頁卡"));
  // 明確製造跨頁撞號（add_card 已擋撞號——編號制度 2026-07-18，legacy 撞號以底層寫入模擬）→
  // 不帶 page 點名應丟歧義錯，不准靜默拿錯卡
  const { updateStore } = await import("../lib/store.mjs");
  await updateStore((d) => {
    d.pages.find((p) => p.name === "架構").nodes.push({ id: "dupA1", type: "note",
      position: { x: 0, y: 0 }, data: { num: "A1", label: "撞號卡" } });
  }, "test-seed", { project: "pgproj" });
  await assert.rejects(() => TOOLS.get_card.run({ card: "A1", project: "pgproj" }, { writer: "test" }), /多個分頁/);
  const g = await TOOLS.get_card.run({ card: "A1", project: "pgproj", page: "主板" }, { writer: "test" });
  assert.equal(g.label, "首頁卡", "帶 page＝限定該頁，無歧義");
  const ov = await TOOLS.get_overview.run({ project: "pgproj" }, { writer: "test" });
  assert.ok(Array.isArray(ov.pages) && ov.pages.length === 3, "overview 附各分頁摘要");
  const va = await TOOLS.validate_cards.run({ project: "pgproj" }, { writer: "test" });
  assert.ok(va.problems.some((p) => p.issue === "編號跨分頁重複" && p.card === "A1"), "lint 應報跨分頁撞號");
});

test("analyze_codebase 帶 page：在既有專案長出分析分頁；同頁有卡拒絕", async () => {
  const r = await TOOLS.analyze_codebase.run({ path: LIB_DIR_MP, project: "pgproj", page: "架構二" }, { writer: "test" });
  assert.equal(r.ok, true);
  const cur = await readStore("pgproj");
  const pg = cur.pages.find((p) => p.name === "架構二");
  assert.ok(pg, "應長出「架構二」分頁");
  assert.ok(!pg.nodes.some((n) => /^G\d+$/.test(n.data?.num || "")),
    "不預種導入說明卡（2026-07-16 使用者裁定：分析板只留結果本體）");
  // 分類跨分頁唯一：架構二的類別不得與 架構/主板 既有類別重複
  const catsOf = (p) => new Set((p.nodes || []).map((n) => /^([A-Za-z]+)/.exec(n.data?.num || "")?.[1]).filter(Boolean));
  const newCats = [...catsOf(pg)].filter((c) => c !== "G");
  const oldCats = new Set(cur.pages.filter((p) => p !== pg).flatMap((p) => [...catsOf(p)]));
  assert.ok(newCats.every((c) => !oldCats.has(c)), `新分頁類別 ${newCats} 不得與既有 ${[...oldCats]} 重複`);
  assert.equal(cur.pages[0].nodes.length, 1, "第一頁不受影響");
  await assert.rejects(() => TOOLS.analyze_codebase.run({ path: LIB_DIR_MP, project: "pgproj", page: "架構二" }, { writer: "test" }),
    /已有卡片/);
});

/* ---------- 種子模板（B4「空白或範本」）＋排版設定入 meta ---------- */

test("createProject 模板：roadmap＝泳道＋使用說明卡；明給 swimlane 優先；layout 入 meta", async () => {
  const r = await createProject("tpl-a", { template: "roadmap" });
  assert.equal(r.cardCount, 1, "範本含一張說明卡（泳道不計卡數）");
  const cur = await readStore("tpl-a");
  assert.ok(cur.nodes.some((n) => n.type === "lane" && n.data.title === "產品路線"), "模板預設泳道");
  assert.ok(cur.nodes.some((n) => n.data?.label === "白板使用說明"), "種子說明卡");
  // 明給 swimlane 蓋過模板預設；layout 覆寫入 meta（add_card 自動落格用）
  await createProject("tpl-b", { template: "roadmap", swimlane: "自訂道", layout: { x0: 200 } });
  const b = await readStore("tpl-b");
  assert.ok(b.nodes.some((n) => n.type === "lane" && n.data.title === "自訂道"), "明給 swimlane 優先");
  assert.equal(b.meta.layout.x0, 200, "layout 覆寫存入白板 meta");
  // 空白模板（預設）不種卡；未知模板丟錯列出可用值
  const blank = await createProject("tpl-c", {});
  assert.equal(blank.cardCount, 0);
  await assert.rejects(() => createProject("tpl-x", { template: "nope" }), /未知模板/);
});

test("pageOps move/force-remove（分頁管理窗）：排序搬移、帶卡強刪、空頁照舊、最後一頁不可刪", async () => {
  const { createRoadmapHandler } = await import("../lib/roadmap-api.mjs");
  const { handler } = createRoadmapHandler({ broadcaster: { broadcast() {}, handleSse() {} } });
  const put = (body) => new Promise((resolve) => {
    // 訂閱即回放：PUT 在 await authorize 之後才掛 req.on，真 EventEmitter 會漏拍
    const payload = JSON.stringify(body);
    const req = { method: "PUT", url: "/api/roadmap?project=pgops", headers: {},
      on(ev, fn) { if (ev === "data") fn(payload); if (ev === "end") fn(); return req; } };
    const res = { statusCode: 200, setHeader() {}, end(p) {
      let j = null; try { j = JSON.parse(p); } catch { /* noop */ }
      resolve({ status: this.statusCode, json: j });
    } };
    handler(req, res);
  });
  await createProject("pgops", { title: "分頁管理測試" });
  await TOOLS.add_card.run({ label: "占位卡", num: "A1", project: "pgops" }, { writer: "test" });
  let r = await put({ pageOps: [{ op: "add", id: "p2", name: "乙" }, { op: "add", id: "p3", name: "丙" }] });
  assert.equal(r.json?.ok, true);
  // 排序：丙搬到最前
  await put({ pageOps: [{ op: "move", id: "p3", to: 0 }] });
  let cur = await readStore("pgops");
  assert.deepEqual(cur.pages.map((p) => p.name), ["丙", "主板", "乙"]);
  // 不帶 force：有卡的主板不刪；空頁乙可刪
  await put({ pageOps: [{ op: "remove", id: cur.pages[1].id }, { op: "remove", id: "p2" }] });
  cur = await readStore("pgops");
  assert.deepEqual(cur.pages.map((p) => p.name), ["丙", "主板"]);
  // force：連卡帶線刪主板
  await put({ pageOps: [{ op: "remove", id: cur.pages[1].id, force: true }] });
  cur = await readStore("pgops");
  assert.deepEqual((cur.pages || [{ name: "丙" }]).map((p) => p.name), ["丙"]);
  // 最後一頁不可刪（force 也不行）
  await put({ pageOps: [{ op: "remove", id: "p3", force: true }] });
  cur = await readStore("pgops");
  const names = Array.isArray(cur.pages) ? cur.pages.map((p) => p.name) : ["丙"];
  assert.deepEqual(names, ["丙"]);
});

test("pageOps merge（刪除三選之合併）：整頁卡/線搬到目標頁空白處、來源頁移除、id 撞號拒絕", async () => {
  const { createRoadmapHandler } = await import("../lib/roadmap-api.mjs");
  const { handler } = createRoadmapHandler({ broadcaster: { broadcast() {}, handleSse() {} } });
  const put = (body) => new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = { method: "PUT", url: "/api/roadmap?project=pgmerge", headers: {},
      on(ev, fn) { if (ev === "data") fn(payload); if (ev === "end") fn(); return req; } };
    const res = { statusCode: 200, setHeader() {}, end(p) {
      let j = null; try { j = JSON.parse(p); } catch { /* noop */ }
      resolve({ status: this.statusCode, json: j });
    } };
    handler(req, res);
  });
  await createProject("pgmerge", { title: "分頁合併測試" });
  await TOOLS.add_card.run({ label: "甲卡", num: "A1", project: "pgmerge" }, { writer: "test" });
  await put({ pageOps: [{ op: "add", id: "p2", name: "乙" }] });
  await TOOLS.add_card.run({ label: "乙卡", num: "B1", project: "pgmerge", page: "乙" }, { writer: "test" });
  // 合併 乙 → 主板：卡片搬過去（y 位移到主板內容下方）、來源頁消失
  let r = await put({ pageOps: [{ op: "merge", id: "p2", into: (await readStore("pgmerge")).pages[0].id }] });
  assert.equal(r.json?.ok, true);
  let cur = await readStore("pgmerge");
  const pages = cur.pages || [{ nodes: cur.nodes, name: "主板" }];
  assert.equal(pages.length, 1, "來源頁應被移除");
  const labels = pages[0].nodes.map((n) => n.data?.label);
  assert.ok(labels.includes("甲卡") && labels.includes("乙卡"), "兩頁卡片應同在目標頁");
  const jia = pages[0].nodes.find((n) => n.data?.label === "甲卡");
  const yi = pages[0].nodes.find((n) => n.data?.label === "乙卡");
  assert.ok(yi.position.y > jia.position.y, "搬入卡應落在既有內容下方（空白處）");
  // id 撞號＝拒絕：造兩頁同 id 卡
  const { ensurePages } = await import("../lib/store.mjs");
  await updateStore((d) => { ensurePages(d); d.pages.push({ id: "px", name: "撞",
    nodes: [{ id: jia.id, type: "note", position: { x: 0, y: 0 }, data: { label: "分身" } }],
    edges: [], viewport: null, deletedEdges: [], constraints: [] }); }, "test", { project: "pgmerge" });
  r = await put({ pageOps: [{ op: "merge", id: "px", into: (await readStore("pgmerge")).pages[0].id }] });
  assert.ok(r.status >= 400 || r.json?.error, "撞 id 合併應拒絕");
  cur = await readStore("pgmerge");
  assert.equal(cur.pages.length, 2, "拒絕後兩頁都應原樣保留");
});

test("delete_card 懸空 pin 警示（2026-07-26）：刪被引用卡回應點名 pin；無引用不附欄位", async () => {
  await createProject("pindang", { title: "懸空測試" }, "test");
  await TOOLS.add_card.run({ label: "本尊", project: "pindang" }, { writer: "test" });
  await TOOLS.add_card.run({ label: "圖釘", type: "pin", refCard: "本尊", project: "pindang" }, { writer: "test" });
  const r = await TOOLS.delete_card.run({ card: "本尊", project: "pindang" }, { writer: "test" });
  assert.ok(Array.isArray(r.dangling_pins) && r.dangling_pins.length === 1, "應點名 1 張懸空 pin");
  assert.equal(r.dangling_pins[0].label, "圖釘");
  assert.ok(r.hint.includes("re-point"), "hint 應指引重指");
  // 刪沒被引用的卡＝不附欄位
  await TOOLS.add_card.run({ label: "孤卡", project: "pindang" }, { writer: "test" });
  const r2 = await TOOLS.delete_card.run({ card: "孤卡", project: "pindang" }, { writer: "test" });
  assert.equal(r2.dangling_pins, undefined);
});
