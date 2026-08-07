// B4 刪除守衛回歸測試：伺服器端刪除墓碑持久化＋板世代（rev）檢核。
// 情境：analyze 重生成板後，stale 瀏覽器分頁的合併推送會把「別人已刪的舊卡」
// 當新增卡 upsert 回來；墓碑＋client 自報 rev 檢核擋掉它。
// 零依賴：mergeBoard/recordTombs 純函數直測＋delete_card 落墓碑整合測。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

const TMP = join(tmpdir(), `hare-merge-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { mergeBoard, recordTombs, pruneTombs, hasTombs } = await import("../lib/merge.mjs");
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

const CTX = { writer: "test" };
const call = (name, args = {}) => TOOLS[name].run(args, CTX);

const N = (id, x = 0) => ({ id, type: "note", position: { x, y: 0 }, data: { num: id, label: id } });

/* ---------- mergeBoard 純函數 ---------- */

test("刪除入墓碑：removedNodeIds 移除卡片並記 tombs（rev＝落地後 rev）", () => {
  const cur = { nodes: [N("A"), N("B")], edges: [], rev: 10 };
  const m = mergeBoard(cur, { nodes: [N("A")], edges: [], removedNodeIds: ["B"], rev: 10 });
  assert.deepEqual(m.nodes.map((n) => n.id), ["A"]);
  assert.equal(m.tombs.nodes.B.rev, 11, "墓碑 rev＝本次寫入落地後的 rev");
});

test("刪除守衛：stale 快照（rev < 墓碑 rev）重推已刪卡被擋下", () => {
  const cur = { nodes: [N("A")], edges: [], rev: 12,
    tombs: { nodes: { OLD: { rev: 11, t: new Date().toISOString() } }, edges: {} } };
  // stale 分頁基於 rev 8 的快照：還帶著已刪卡 OLD
  const m = mergeBoard(cur, { nodes: [N("A"), N("OLD")], edges: [], rev: 8 });
  assert.deepEqual(m.nodes.map((n) => n.id), ["A"], "OLD 不得復活");
  assert.ok(m.tombs.nodes.OLD, "墓碑保留（防下一個 stale 分頁）");
});

test("刪除守衛：不帶 rev 的舊客戶端一律視為陳舊（安全方向）", () => {
  const cur = { nodes: [], edges: [], rev: 5,
    tombs: { nodes: { OLD: { rev: 3, t: new Date().toISOString() } }, edges: {} } };
  const m = mergeBoard(cur, { nodes: [N("OLD")], edges: [] });
  assert.equal(m.nodes.length, 0);
});

test("undo 放行：client rev ≥ 墓碑 rev＝見過刪除仍要加回（復原），並清墓碑", () => {
  const cur = { nodes: [], edges: [], rev: 12,
    tombs: { nodes: { X: { rev: 11, t: new Date().toISOString() } }, edges: {} } };
  const m = mergeBoard(cur, { nodes: [N("X")], edges: [], rev: 12 });
  assert.deepEqual(m.nodes.map((n) => n.id), ["X"], "undo 復原的卡放行");
  assert.equal(m.tombs.nodes.X, undefined, "活卡清墓碑");
});

test("線段墓碑：stale 分頁重推已刪線被擋；removedEdgeIds 入墓碑", () => {
  const cur = { nodes: [N("A"), N("B")], edges: [{ id: "e1", source: "A", target: "B" }], rev: 20 };
  const m1 = mergeBoard(cur, { nodes: [N("A"), N("B")], edges: [], removedEdgeIds: ["e1"], rev: 20 });
  assert.equal(m1.edges.length, 0);
  assert.equal(m1.tombs.edges.e1.rev, 21);
  const cur2 = { ...cur, edges: [], rev: 21, tombs: m1.tombs };
  const m2 = mergeBoard(cur2, { nodes: [N("A"), N("B")],
    edges: [{ id: "e1", source: "A", target: "B" }], rev: 19 });
  assert.equal(m2.edges.length, 0, "stale 分頁不得復活已刪線");
});

test("pruneTombs：逾 TTL（30 天）修剪；hasTombs 空物件為 false", () => {
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const out = pruneTombs({ nodes: { a: { rev: 1, t: old }, b: { rev: 2, t: fresh } }, edges: {} });
  assert.equal(out.nodes.a, undefined, "過期墓碑修剪");
  assert.ok(out.nodes.b, "新墓碑保留");
  assert.equal(hasTombs({ nodes: {}, edges: {} }), false);
  assert.equal(hasTombs(out), true);
});

/* ---------- delete_card／delete_edge 整合：MCP 刪除落墓碑並持久化 ---------- */

async function seed() {
  await writeStore({
    nodes: [N("P1"), N("P2", 300), N("P3", 600)],
    edges: [{ id: "e1", source: "P1", target: "P2" }],
  }, "test-seed", { allowEmpty: true });
}
beforeEach(seed);
after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
});

test("delete_card：墓碑（卡＋相連線）持久化到資料檔；stale 合併推送不得復活", async () => {
  const r = await call("delete_card", { card: "P2" });
  assert.equal(r.ok, true);
  const file = JSON.parse(readFileSync(TMP, "utf8"));
  assert.ok(file.tombs?.nodes?.P2, "刪卡墓碑入檔");
  assert.ok(file.tombs?.edges?.e1, "相連線墓碑入檔");
  assert.equal(file.tombs.nodes.P2.rev, file.rev, "墓碑 rev＝刪除落地 rev");
  // stale 分頁（基於刪除前 rev 的快照）重推 P2 → 擋下
  const m = mergeBoard({ ...file, tombs: file.tombs },
    { nodes: [...file.nodes, N("P2", 300)], edges: file.edges, rev: file.rev - 1 });
  assert.ok(!m.nodes.some((n) => n.id === "P2"), "stale 重推已刪卡被墓碑擋下");
});

test("delete_edge：線段墓碑持久化", async () => {
  const r = await call("delete_edge", { edge: "e1" });
  assert.equal(r.ok, true);
  const file = JSON.parse(readFileSync(TMP, "utf8"));
  assert.ok(file.tombs?.edges?.e1, "刪線墓碑入檔");
});
