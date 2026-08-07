// 寫入端消毒層（借鑑 tldraw AgentHelpers：normalize coords／ensure valid edges）。
// HARE 選「拒絕」而非「自動修正」：自環＋非有限座標＝丟錯；重複邊＝回 hint 不阻擋。
// 隔離沿既有慣例：HARE_DATA_PATH 指暫存檔、先設 env 再 dynamic import；絕不動正式白板。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-sanitize-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, readStore } = await import("../lib/store.mjs");
const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });
const card = (id) => ({ id, type: "note", position: { x: 0, y: 0 }, data: { num: id, label: id, status: "plan", desc: "d" } });

async function reset() {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  for (let r = 0; r < 200; r += 1) await rm(`${TMP}.bak-${r}`, { force: true });
  await writeStore({ nodes: [card("A"), card("B"), card("C")], edges: [] }, "seed", { allowEmpty: true });
}
beforeEach(reset);
after(() => reset());

/* ---------- 自環（DAG 非法）＝丟錯 ---------- */
test("add_edge 自環（source===target）→ 拒絕", async () => {
  await assert.rejects(call("add_edge", { source: "A", target: "A" }), /自環/);
});

test("update_edge 改端點後成自環 → 拒絕", async () => {
  const add = await call("add_edge", { source: "A", target: "B" });
  await assert.rejects(call("update_edge", { edge: add.edge.id, target: "A" }), /自環/);
});

test("add_cards 顯式 edges 自環 → 整批不落地", async () => {
  await assert.rejects(call("add_cards", {
    cards: [{ key: "x", label: "X" }],
    edges: [{ source: "x", target: "x" }],
  }), /自環/);
});

/* ---------- 座標非有限值（NaN/Infinity）＝丟錯 ---------- */
test("add_card x=NaN → 拒絕", async () => {
  await assert.rejects(call("add_card", { label: "N", x: NaN, y: 0 }), /有限數值/);
});

test("add_card y=Infinity → 拒絕", async () => {
  await assert.rejects(call("add_card", { label: "N", x: 0, y: Infinity }), /有限數值/);
});

test("move_card x=NaN → 拒絕", async () => {
  await assert.rejects(call("move_card", { card: "A", x: NaN }), /有限數值/);
});

test("add_cards 某卡座標非有限 → 整批不落地", async () => {
  await assert.rejects(call("add_cards", { cards: [{ label: "X", x: Infinity }] }), /有限數值/);
});

test("有限座標仍照常落地（消毒不誤傷正常值）", async () => {
  const r = await call("add_card", { label: "OK", x: 123, y: -45 });
  assert.equal(r.ok, true);
  const store = await readStore();
  const created = (store.nodes || []).find((n) => n.data?.label === "OK");
  assert.deepEqual(created.position, { x: 123, y: -45 }, "呼叫端給的有限座標原樣落地");
});

/* ---------- 重複邊＝回 hint、不阻擋 ---------- */
test("add_edge 重複（同 source→target）→ 建立成功且回 hint", async () => {
  await call("add_edge", { source: "A", target: "B" });
  const dup = await call("add_edge", { source: "A", target: "B" });
  assert.equal(dup.ok, true, "重複邊仍建立（不阻擋）");
  assert.match(dup.hint || "", /重複/);
});

test("add_cards 顯式 edges 重複 → 建立成功且回 hint", async () => {
  const r = await call("add_cards", {
    cards: [{ label: "Z" }],
    edges: [{ source: "A", target: "B" }, { source: "A", target: "B" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.edges, 2, "兩條都建立");
  assert.match(r.hint || "", /重複/);
});
