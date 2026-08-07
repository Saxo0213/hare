// 入職系統 M2c 機制修復批次測試：
//  1) mergeTaskTexts 純函式（保鍵/新戳/刪除/重複文字配對/舊陣列輸入）
//  2) update_card tasks 陣列路徑端到端（暫存檔）——未變文字的鍵不變、新文字新鍵
//  3) 查詢工具 limit 預設與放寬（list_cards/search_cards/list_edges）
//  4) get_ready_cards notice 觸發／不觸發
//  5) analyzeCodebase 卡號跳過 G/D cat
// 隔離：HARE_DATA_PATH 暫存檔、先設 env 再 dynamic import（沿 tasksdict/onboarding 慣例）。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-m2c-test-${process.pid}.json`);
const TMP_LOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { mergeTaskTexts, taskEntries, taskTexts, normalizeTasks, LEGACY_BASE } =
  await import("../lib/tasks.mjs");
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");
const { analyzeCodebase } = await import("../lib/analyze.mjs");

const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });

/* ---------- 1) mergeTaskTexts 純函式 ---------- */
test("mergeTaskTexts：未變文字保原鍵、全新文字打新戳、消失文字刪除", () => {
  const existing = { // 兩條既有任務，各有建立戳
    "2026-01-01T00:00:00.000Z": "甲",
    "2026-01-02T00:00:00.000Z": "乙",
  };
  const now = Date.parse("2026-07-18T00:00:00.000Z");
  const out = mergeTaskTexts(existing, ["甲", "丙"], now); // 乙刪除、甲保留、丙新增
  assert.equal(out["2026-01-01T00:00:00.000Z"], "甲", "甲保留原鍵");
  assert.equal(out["2026-01-02T00:00:00.000Z"], undefined, "乙消失＝刪除");
  const bingKey = Object.keys(out).find((k) => out[k] === "丙");
  assert.equal(bingKey, new Date(now).toISOString(), "丙打新戳＝now");
  assert.deepEqual(taskTexts(out), ["甲", "丙"]); // 排序後：甲（舊）在前、丙（新）在後
});

test("mergeTaskTexts：多筆新文字同毫秒 +1ms 遞推保插入序", () => {
  const now = Date.parse("2026-07-18T00:00:00.000Z");
  const out = mergeTaskTexts({}, ["新一", "新二", "新三"], now);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    new Date(now).toISOString(),
    new Date(now + 1).toISOString(),
    new Date(now + 2).toISOString(),
  ]);
  assert.deepEqual(taskTexts(out), ["新一", "新二", "新三"]);
});

test("mergeTaskTexts：重複文字按出現次數配對，保留鍵較小者", () => {
  const existing = { // 既有兩條同文字「重」，鍵一大一小
    "2026-01-01T00:00:00.000Z": "重",
    "2026-03-03T00:00:00.000Z": "重",
    "2026-02-02T00:00:00.000Z": "獨",
  };
  const out = mergeTaskTexts(existing, ["重", "獨"], Date.now());
  assert.equal(out["2026-01-01T00:00:00.000Z"], "重", "保留鍵較小（建立較早）的那條重");
  assert.equal(out["2026-03-03T00:00:00.000Z"], undefined, "多出來的重被刪");
  assert.equal(out["2026-02-02T00:00:00.000Z"], "獨");
});

test("mergeTaskTexts：既有為舊陣列輸入（先 LEGACY 對齊），仍能保鍵合併", () => {
  const legacyArr = ["一", "二"]; // 舊格式陣列
  const legacyDict = normalizeTasks(legacyArr, LEGACY_BASE);
  const out = mergeTaskTexts(legacyArr, ["一", "三"], Date.parse("2026-07-18T00:00:00.000Z"));
  const oneKey = Object.keys(legacyDict).find((k) => legacyDict[k] === "一");
  assert.equal(out[oneKey], "一", "舊陣列的「一」對齊後保留 LEGACY 鍵");
  assert.equal(Object.values(out).includes("二"), false, "二消失＝刪除");
  assert.ok(taskTexts(out).includes("三"));
});

/* ---------- 2) update_card tasks 陣列路徑端到端 ---------- */
beforeEach(() => writeStore({ nodes: [
  { id: "S1", type: "note", position: { x: 0, y: 0 },
    data: { num: "S1", label: "任務卡", status: "plan", tasks: ["原甲", "原乙"] } },
], edges: [] }, "seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP_LOG, { force: true });
});

test("update_card 陣列路徑：未變文字的鍵不變、新文字得新鍵、消失文字刪除", async () => {
  // 建卡帶任務（add_card 正規化為真實時間戳 dict）；讀磁碟取原鍵
  await call("add_card", { label: "端到端卡", num: "S2", tasks: ["原甲", "原乙"] });
  const readDisk = async () => {
    const raw = JSON.parse(await readFile(TMP, "utf8"));
    const pages = raw.pages || [{ nodes: raw.nodes }];
    return pages.flatMap((p) => p.nodes).find((n) => n.data?.num === "S2");
  };
  const before = await readDisk();
  const keys0 = Object.keys(before.data.tasks).sort();
  const kJia = keys0.find((k) => before.data.tasks[k] === "原甲");
  // 送修改過的陣列：保留「原甲」、刪「原乙」、加「新丙」
  await call("update_card", { card: "S2", tasks: ["原甲", "新丙"] });
  const after1 = await readDisk();
  assert.ok(!Array.isArray(after1.data.tasks) && typeof after1.data.tasks === "object", "磁碟仍存 dict");
  assert.equal(after1.data.tasks[kJia], "原甲", "未變文字「原甲」的鍵不變（建立時間未毀）");
  assert.equal(Object.values(after1.data.tasks).includes("原乙"), false, "原乙消失＝刪除");
  const kBing = Object.keys(after1.data.tasks).find((k) => after1.data.tasks[k] === "新丙");
  assert.ok(kBing && !keys0.includes(kBing), "新丙得全新鍵");
  // 線上格式仍是排序文字陣列
  const c = await call("get_card", { card: "S2" });
  assert.deepEqual(c.tasks, ["原甲", "新丙"]);
});

test("update_card dict 路徑：原樣覆蓋（帶鍵＝agent 自負排序）", async () => {
  const dict = { "2030-01-01T00:00:00.000Z": "手甲", "2030-02-01T00:00:00.000Z": "手乙" };
  await call("update_card", { card: "S1", tasks: dict });
  const raw = JSON.parse(await readFile(TMP, "utf8"));
  const s1 = (raw.pages || [{ nodes: raw.nodes }]).flatMap((p) => p.nodes).find((n) => n.data?.num === "S1");
  assert.deepEqual(s1.data.tasks, dict, "dict 原樣落地");
});

/* ---------- 3) 查詢工具 limit 預設與放寬 ---------- */
test("list_cards/search_cards/list_edges：limit 預設與明確放寬、truncated+total", async () => {
  // 種 3 張卡＋2 條線於暫存板（beforeEach 只種 S1，這裡補足）
  await call("add_card", { label: "甲卡", num: "Q1", desc: "共同詞", status: "plan" });
  await call("add_card", { label: "乙卡", num: "Q2", desc: "共同詞", status: "plan" });
  await call("add_edge", { source: "Q1", target: "Q2" });
  await call("add_edge", { source: "S1", target: "Q1" });

  // list_cards：limit=1 截斷回 truncated+total
  const lc = await call("list_cards", { limit: 1 });
  assert.equal(lc.cards.length, 1);
  assert.equal(lc.truncated, true);
  assert.ok(lc.total >= 3);
  // 明確放寬（>total）＝不截斷
  const lcAll = await call("list_cards", { limit: 100 });
  assert.equal(lcAll.truncated, undefined);

  // search_cards：預設回全部命中（<100）＝不截斷；limit=1 截斷
  const sc = await call("search_cards", { query: "共同詞" });
  assert.equal(sc.count, 2);
  assert.equal(sc.truncated, undefined);
  const sc1 = await call("search_cards", { query: "共同詞", limit: 1 });
  assert.equal(sc1.count, 1);
  assert.equal(sc1.truncated, true);
  assert.equal(sc1.total, 2);

  // list_edges：limit=1 截斷回 truncated+total
  const le = await call("list_edges", { limit: 1 });
  assert.equal(le.edges.length, 1);
  assert.equal(le.truncated, true);
  assert.equal(le.total, 2);
  const leAll = await call("list_edges", {});
  assert.equal(leAll.truncated, undefined);
});

/* ---------- 4) get_ready_cards notice ---------- */
test("get_ready_cards notice：meta.onboarded 板觸發", async () => {
  await writeStore({ meta: { onboarded: { t: 1, by: "test" } }, nodes: [
    { id: "M1", type: "note", position: { x: 0, y: 0 }, data: { num: "A", label: "容器", status: "plan" } },
  ], edges: [] }, "seed", { allowEmpty: true });
  const r = await call("get_ready_cards", {});
  assert.ok(r.notice && r.notice.includes("dependency-readiness only"), "onboarded 板附 notice");
});

test("get_ready_cards notice：ready 全為 0 開放任務觸發；有開放任務不觸發", async () => {
  // 全 0：兩張無任務的就緒卡（無上游＝就緒）
  await writeStore({ nodes: [
    { id: "Z1", type: "note", position: { x: 0, y: 0 }, data: { num: "Z1", label: "無任務就緒卡", status: "plan" } },
  ], edges: [] }, "seed", { allowEmpty: true });
  const r0 = await call("get_ready_cards", {});
  assert.ok(r0.count > 0);
  assert.ok(r0.notice, "ready 全 0 開放任務＝附 notice");

  // 有開放任務：就緒卡帶任務＝不觸發
  await writeStore({ nodes: [
    { id: "W1", type: "note", position: { x: 0, y: 0 },
      data: { num: "W1", label: "帶任務就緒卡", status: "plan", tasks: ["做這個"] } },
  ], edges: [] }, "seed", { allowEmpty: true });
  const r1 = await call("get_ready_cards", {});
  assert.ok(r1.ready.some((c) => c.open_tasks > 0));
  assert.equal(r1.notice, undefined, "有開放任務＝不附 notice");
});

/* ---------- 5) analyzeCodebase 卡號跳過 G/D ---------- */
test("analyzeCodebase：頂層 cat 跳過 G 與 D（保留字段）", async () => {
  const dir = await mkdtemp(join(tmpdir(), `hare-m2c-analyze-${process.pid}-`));
  // 建多個頂層子目錄（各含一檔）逼出多個 cat，驗證配號跳過 D/G
  for (let i = 0; i < 8; i++) {
    const sub = join(dir, `dir${i}`);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, `f${i}.mjs`), `export const v${i} = ${i};\n`);
  }
  const { nodes } = analyzeCodebase(dir, { gitignore: false });
  const cats = nodes.map((n) => n.data?.num).filter(Boolean)
    .map((num) => (/^([A-Z]+)/.exec(num) || [])[1]).filter(Boolean);
  assert.ok(cats.length >= 8, "應有多個頂層 cat");
  assert.equal(cats.some((c) => c === "D" || c === "G"), false, "頂層 cat 不得為 D 或 G");
  // 子孫編號前綴也不以 D/G 起頭（cat 繼承）
  assert.equal(nodes.some((n) => /^[DG]\d/.test(n.data?.num || "")), false, "無 D/G 開頭卡號");
  await rm(dir, { recursive: true, force: true });
});
