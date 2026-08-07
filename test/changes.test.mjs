// 入職系統 M2a（B8）：changelog 逐卡事件化（store.mjs diff）＋ get_changes 增量聚合
// ＋ behind_revs 端到端 ＋ INSTRUCTIONS 能力觸發。
// 隔離沿既有慣例：HARE_DATA_PATH 指暫存檔、先設 env 再 dynamic import；絕不動正式白板。
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-changes-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { writeStore, readStore } = await import("../lib/store.mjs");
const { TOOLS, INSTRUCTIONS, entryInfo } = await import("../lib/tools.mjs");

// 節點建構器：id＝num；position 與 data 可覆寫（測揮發欄位用）。
const nd = (id, data = {}, position = { x: 0, y: 0 }) =>
  ({ id, type: "note", position, data: { num: id, label: id, ...data } });

async function reset() {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  for (let r = 0; r < 200; r += 1) await rm(`${TMP}.bak-${r}`, { force: true });
}
async function lastChanged() {
  const lines = (await readFile(CHANGELOG, "utf8")).trim().split(/\n/);
  return JSON.parse(lines[lines.length - 1]).changed;
}

beforeEach(reset);
after(reset);

/* ---------- store.mjs：逐卡 diff ---------- */
test("diff：增/刪/改，揮發欄位（position）與 claim/量測衍生值不觸發 updated", async () => {
  // rev1：A,B,C 全新增
  await writeStore({ nodes: [nd("A"), nd("B"), nd("C")], edges: [] }, "w", { allowEmpty: true });
  let ch = await lastChanged();
  assert.deepEqual([...ch.a].sort(), ["A", "B", "C"]);
  assert.deepEqual(ch.u, []); assert.deepEqual(ch.r, []);

  // rev2：新增 D；A 只搬位置（不算 updated）；B 改 label（算 updated）；C 不動
  await writeStore({ nodes: [
    nd("A", {}, { x: 999, y: 888 }), nd("B", { label: "new" }), nd("C"), nd("D"),
  ], edges: [] }, "w");
  ch = await lastChanged();
  assert.deepEqual(ch.a, ["D"], "只有 D 新增");
  assert.deepEqual(ch.u, ["B"], "只有 B 內容更新（A 搬位不算）");
  assert.deepEqual(ch.r, []);

  // rev3：A 加 claim（心跳雜訊，不算）；B 加 childZoneH（量測衍生值，不算）；移除 C
  await writeStore({ nodes: [
    nd("A", { claim: { agent: "x", t: "2026-01-01T00:00:00Z" } }),
    nd("B", { label: "new", childZoneH: 123 }), nd("D"),
  ], edges: [] }, "w");
  ch = await lastChanged();
  assert.deepEqual(ch.a, []);
  assert.deepEqual(ch.u, [], "claim 與 childZoneH 皆不觸發 updated");
  assert.deepEqual(ch.r, ["C"], "C 被移除");
});

test("diff：邊 added/removed 各自入 ea/er（B9 端點語意 {i,s,t,r}）", async () => {
  await writeStore({ nodes: [nd("A"), nd("B")], edges: [{ id: "e1", source: "A", target: "B" }] }, "w", { allowEmpty: true });
  let ch = await lastChanged();
  // B9：ea/er 由純 id 改記端點語意——{i:id, s:source num, t:target num, r:有效 relation（任務板投影＝prerequisite）}
  assert.deepEqual(ch.ea, [{ i: "e1", s: "A", t: "B", r: "prerequisite" }]);
  assert.deepEqual(ch.er, []);
  await writeStore({ nodes: [nd("A"), nd("B")], edges: [] }, "w");
  ch = await lastChanged();
  assert.deepEqual(ch.ea, []);
  assert.deepEqual(ch.er, [{ i: "e1", s: "A", t: "B", r: "prerequisite" }]);
});

test("diff：五陣列合計 >50 個 id → bulk:true 只記數量", async () => {
  await writeStore({ nodes: [nd("seed")], edges: [] }, "w", { allowEmpty: true });
  const many = Array.from({ length: 60 }, (_, i) => nd(`m${i}`));
  await writeStore({ nodes: [nd("seed"), ...many], edges: [] }, "w");
  const ch = await lastChanged();
  assert.equal(ch.bulk, true);
  assert.equal(typeof ch.a, "number");
  assert.equal(ch.a, 60, "60 張新增以數量記");
});

/* ---------- get_changes：增量聚合（假 changelog ＋ 暫存資料檔）---------- */
test("get_changes：聚合最新事件、removed→id 尾碼、bulk_revs、writers 去重", async () => {
  // 暫存資料檔：板上有 X(N1)、Y(N2)；Z 不在板上（已刪）。
  await writeStore({ nodes: [nd("X", { num: "N1", label: "卡X" }), nd("Y", { num: "N2", label: "卡Y" })], edges: [] },
    "w", { allowEmpty: true });
  // 手工 changelog（完全掌控聚合語意）：覆蓋 writeStore 寫的那行。
  const t = "2026-07-18T00:00:00Z";
  await writeFile(CHANGELOG, [
    JSON.stringify({ t, writer: "mcp", rev: 1, changed: { a: ["X", "Y"], u: [], r: [], ea: ["e1"], er: [] } }),
    JSON.stringify({ t, writer: "browser", rev: 2, changed: { a: [], u: ["X"], r: [], ea: [], er: [] } }),
    JSON.stringify({ t, writer: "browser", rev: 3, changed: { a: ["Z"], u: [], r: ["Z"], ea: [], er: ["e1"] } }),
    JSON.stringify({ t, writer: "mcp", rev: 4, changed: { bulk: true, a: 70, u: 0, r: 0, ea: 0, er: 0 } }),
    JSON.stringify({ t, writer: "old", rev: 5, nodes: 2 }), // 舊格式無 changed：計入 entries/writers
  ].join("\n") + "\n", "utf8");

  const r = await TOOLS.get_changes.run({ since_rev: 0 });
  assert.equal(r.from_rev, 1); assert.equal(r.to_rev, 5); assert.equal(r.entries, 5);
  assert.deepEqual([...r.writers].sort(), ["browser", "mcp", "old"]);
  // B9：此 changelog 用舊格式（純字串 id ea/er）→ 讀取端容忍＝退回計數並標 legacy。
  assert.deepEqual(r.edges.added, []); assert.deepEqual(r.edges.removed, []);
  assert.equal(r.edges.legacy, true);
  assert.equal(r.edges.added_count, 1); assert.equal(r.edges.removed_count, 1);
  assert.deepEqual(r.bulk_revs, [4]);
  // cards 依 last_rev 降冪：Z(3,removed) → X(2,updated) → Y(1,added)
  assert.equal(r.cards.length, 3);
  assert.equal(r.cards[0].change, "removed");
  assert.ok(r.cards[0].id && r.cards[0].id.startsWith("#"), "removed 卡以 id 尾碼標示");
  assert.equal(r.cards[1].num, "N1"); assert.equal(r.cards[1].change, "updated"); assert.equal(r.cards[1].last_rev, 2);
  assert.equal(r.cards[2].num, "N2"); assert.equal(r.cards[2].change, "added");
});

test("get_changes：since_rev 過濾 + limit 截斷 truncated", async () => {
  await writeStore({ nodes: [nd("X", { num: "N1" }), nd("Y", { num: "N2" })], edges: [] }, "w", { allowEmpty: true });
  const t = "2026-07-18T00:00:00Z";
  await writeFile(CHANGELOG, [
    JSON.stringify({ t, writer: "mcp", rev: 1, changed: { a: ["X"], u: [], r: [], ea: [], er: [] } }),
    JSON.stringify({ t, writer: "mcp", rev: 2, changed: { a: ["Y"], u: [], r: [], ea: [], er: [] } }),
    JSON.stringify({ t, writer: "mcp", rev: 3, changed: { a: [], u: ["X"], r: [], ea: [], er: [] } }),
  ].join("\n") + "\n", "utf8");
  const r = await TOOLS.get_changes.run({ since_rev: 2 });
  assert.equal(r.entries, 1, "只含 rev>2 的一筆");
  assert.deepEqual(r.cards.map((c) => c.num), ["N1"]); // rev3 更新 X
  const r2 = await TOOLS.get_changes.run({ since_rev: 0, limit: 1 });
  assert.equal(r2.cards.length, 1);
  assert.equal(r2.truncated, true);
});

/* ---------- behind_revs 端到端（真實 writeStore 逐卡事件）---------- */
test("behind_revs：建 G0→改它→再寫別卡兩次 → entry.behind_revs===2", async () => {
  const g0a = nd("g0", { num: "G0", label: "導覽", desc: "專案簡報\n\n細節" });
  const g0b = nd("g0", { num: "G0", label: "導覽改", desc: "改後\n\n細節" }); // rev2 後固定不變
  await writeStore({ nodes: [g0a], edges: [] }, "w", { allowEmpty: true }); // rev1 a:[g0]
  await writeStore({ nodes: [g0b], edges: [] }, "w"); // rev2 u:[g0]
  await writeStore({ nodes: [g0b, nd("o1")], edges: [] }, "w"); // rev3 a:[o1]（g0 不變）
  await writeStore({ nodes: [g0b, nd("o1"), nd("o2")], edges: [] }, "w"); // rev4 a:[o2]（g0 不變）
  const data = await readStore();
  const info = entryInfo(data); // 預設專案 → changelogPathFor 走 HARE_DATA_PATH
  assert.equal(info.num, "G0");
  assert.equal(info.behind_revs, 2, "最後異動 G0 在 rev2，現值 rev4 → 落後 2");
  assert.equal(info.stale, false, "2 < 30 未過期");
});

/* ---------- card_history：單卡時間線（B22 第三波）---------- */
test("card_history：只收觸卡行、newest-first、邊事件計數、bulk 誠實跳過", async () => {
  await writeStore({ nodes: [nd("X", { num: "N1", label: "卡X" }), nd("Y", { num: "N2", label: "卡Y" })], edges: [] },
    "w", { allowEmpty: true });
  const t = "2026-07-18T00:00:00Z";
  await writeFile(CHANGELOG, [
    JSON.stringify({ t, writer: "mcp", rev: 1, changed: { a: ["X"], u: [], r: [], ea: [{ i: "e1", s: "N1", t: "N2", r: "prerequisite" }], er: [] } }),
    JSON.stringify({ t, writer: "browser", rev: 2, changed: { a: [], u: ["Y"], r: [], ea: [], er: [] } }), // 別卡：不入
    JSON.stringify({ t, writer: "browser", rev: 3, changed: { a: [], u: ["X"], r: [], ea: [], er: [] } }),
    JSON.stringify({ t, writer: "mcp", rev: 4, changed: { bulk: true, a: 70, u: 0, r: 0, ea: 0, er: 0 } }), // bulk：跳過
    JSON.stringify({ t, writer: "mcp", rev: 5, changed: { a: [], u: [], r: [], ea: [], er: [{ i: "e1", s: "N1", t: "N2", r: "prerequisite" }] } }), // 只邊觸卡
  ].join("\n") + "\n", "utf8");
  const r = await TOOLS.card_history.run({ card: "N1" });
  assert.equal(r.card, "N1"); assert.equal(r.label, "卡X");
  assert.equal(r.entries, 3, "別卡行與 bulk 行不入");
  assert.equal(r.bulk_skipped, 1);
  assert.deepEqual(r.history.map((h) => h.rev), [5, 3, 1], "newest-first");
  assert.equal(r.history[0].change, null, "純邊事件行 change 為 null");
  assert.deepEqual(r.history[0].edges, { added: 0, removed: 1, updated: 0 });
  assert.equal(r.history[1].change, "updated"); assert.equal(r.history[1].writer, "browser");
  assert.equal(r.history[2].change, "added");
  assert.deepEqual(r.history[2].edges, { added: 1, removed: 0, updated: 0 });
});

test("card_history：limit 截斷 truncated＋查無卡丟錯", async () => {
  await writeStore({ nodes: [nd("X", { num: "N1" })], edges: [] }, "w", { allowEmpty: true });
  const t = "2026-07-18T00:00:00Z";
  await writeFile(CHANGELOG, [1, 2, 3].map((rev) =>
    JSON.stringify({ t, writer: "mcp", rev, changed: { a: [], u: ["X"], r: [], ea: [], er: [] } })).join("\n") + "\n", "utf8");
  const r = await TOOLS.card_history.run({ card: "X", limit: 2 });
  assert.equal(r.entries, 3);
  assert.equal(r.history.length, 2);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.history.map((h) => h.rev), [3, 2]);
  await assert.rejects(() => TOOLS.card_history.run({ card: "nope" }), /找不到卡片/);
});

/* ---------- INSTRUCTIONS 能力觸發 ---------- */
test("INSTRUCTIONS：依序列／依賴／阻塞／影響觸發 HARE 關係圖", () => {
  for (const concept of ["sequenced", "depend on", "block", "affect"]) {
    assert.ok(INSTRUCTIONS.includes(concept), `含觸發關係「${concept}」`);
  }
  assert.ok(INSTRUCTIONS.includes("must use HARE"), "明確要求使用 HARE");
  assert.ok(INSTRUCTIONS.includes("directed relationship map"), "明確指定有方向的關係圖");
});
