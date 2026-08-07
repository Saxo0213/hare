// B9 邊語意化（Edge Schema v2）：板型投影純函式 ＋ 工作 DAG 過濾守恆 ＋
// add_edge/update_edge relation/tier round-trip ＋ get_changes 邊端點語意 ＋ guide "edges" 主題。
// 隔離沿既有慣例：HARE_DATA_PATH 指暫存檔、先設 env 再 dynamic import；絕不動正式白板。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { projectRelation, boardKindOf, edgeSemantics, readyCards, blockers } from "../lib/graph.mjs";

/* ---------- 純函式：板型偵測 ---------- */
const laneFor = (sub) => ({ id: "L", type: "lane", data: { sub } });
test("boardKindOf：泳道 sub 標記 → 板型（含 task 保底）", () => {
  assert.equal(boardKindOf({ nodes: [laneFor("模組介面圖·agent 自建")] }), "iface");
  assert.equal(boardKindOf({ nodes: [laneFor("系統架構圖")] }), "system");
  assert.equal(boardKindOf({ nodes: [laneFor("analyze 自動生成")] }), "analysis");
  assert.equal(boardKindOf({ nodes: [] }), "task");
  assert.equal(boardKindOf({ nodes: [{ id: "n", type: "note", data: {} }] }), "task");
});

/* ---------- 純函式：板型投影逐案例 ---------- */
const flowEdge = { source: "a", target: "b" }; // 無 marker＝flow
const injectEdge = { source: "a", target: "b", markerStart: { type: "arrowclosed" } };
const bothEdge = { source: "a", target: "b", markerStart: {}, markerEnd: {} };
test("projectRelation：明示 relation 一律原樣（不受板型影響）", () => {
  for (const kind of ["task", "analysis", "iface", "system"]) {
    assert.equal(projectRelation({ ...flowEdge, data: { relation: "validates" } }, kind), "validates");
  }
});
test("projectRelation：任務／自由板 → prerequisite", () => {
  assert.equal(projectRelation(flowEdge, "task"), "prerequisite");
  assert.equal(projectRelation(injectEdge, "task"), "prerequisite");
});
test("projectRelation：分析板 → imports", () => {
  assert.equal(projectRelation(flowEdge, "analysis"), "imports");
  assert.equal(projectRelation(injectEdge, "analysis"), "imports");
});
test("projectRelation：模組介面板 inject/both → imports、flow → reference", () => {
  assert.equal(projectRelation(injectEdge, "iface"), "imports");
  assert.equal(projectRelation(bothEdge, "iface"), "imports");
  assert.equal(projectRelation(flowEdge, "iface"), "reference");
});
test("projectRelation：系統架構板 → reference", () => {
  assert.equal(projectRelation(flowEdge, "system"), "reference");
  assert.equal(projectRelation(bothEdge, "system"), "reference");
});

/* ---------- 純函式：edgeSemantics（list_edges 有效語意）---------- */
test("edgeSemantics：存了 relation＝原 tier/source；未存＝投影＋extracted、無 source", () => {
  const stored = { data: { relation: "prerequisite", confidenceTier: "asserted", evidence: { source: "mcp" } } };
  assert.deepEqual(edgeSemantics(stored, "task"), { relation: "prerequisite", confidenceTier: "asserted", source: "mcp" });
  assert.deepEqual(edgeSemantics(flowEdge, "analysis"), { relation: "imports", confidenceTier: "extracted", source: null });
});

/* ---------- 工作 DAG 過濾：reference 不擋、prerequisite 擋 ---------- */
const wc = (num, status, extra = {}) => ({ id: num, type: "note", data: { num, label: num, status, ...extra } });
test("DAG 過濾：prerequisite 邊擋 ready、明示 reference 邊不擋", () => {
  // A(未 real)。B 經 prerequisite 依賴 A → 被擋；C 經 reference 依賴 A → 不擋。
  const data = {
    nodes: [wc("A", "plan"), wc("B", "plan"), wc("C", "plan")],
    edges: [
      { id: "e1", source: "A", target: "B", data: { relation: "prerequisite" } },
      { id: "e2", source: "A", target: "C", data: { relation: "reference" } },
    ],
  };
  const ready = readyCards(data).ready.map((c) => c.num).sort();
  assert.deepEqual(ready, ["A", "C"], "A 無前置就緒、C 的 reference 邊被忽略故就緒、B 被 A 擋");
  assert.deepEqual(blockers(data, "B").blockers.map((c) => c.num), ["A"]);
  assert.equal(blockers(data, "C").ready, true, "reference 邊不進工作 DAG");
});

/* ---------- 工具 round-trip（暫存檔）---------- */
const TMP = join(tmpdir(), `hare-edgesem-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");
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

test("add_edge→list_edges：relation/tier/evidence.source round-trip（transport→mcp）", async () => {
  await call("add_edge", { source: "A", target: "B", relation: "validates", note: "跑過就綠" });
  const le = await call("list_edges");
  const e = le.edges.find((x) => x.relation === "validates");
  assert.ok(e, "找得到 validates 邊");
  assert.equal(e.confidenceTier, "asserted", "明示＝asserted");
  assert.equal(e.evidenceSource, "mcp", "MCP transport → source=mcp");
});

test("add_edge inferred:true → confidenceTier=inferred", async () => {
  await call("add_edge", { source: "A", target: "C", relation: "prerequisite", inferred: true });
  const le = await call("list_edges");
  const e = le.edges.find((x) => x.source === "A" && x.target === "C");
  assert.equal(e.relation, "prerequisite");
  assert.equal(e.confidenceTier, "inferred");
});

test("add_edge 不帶 relation → list_edges 用板型投影（任務板＝prerequisite、tier extracted）", async () => {
  const r = await call("add_edge", { source: "A", target: "B" });
  assert.equal(r.edge.relation, null, "未明示＝不落 data.relation");
  const le = await call("list_edges");
  const e = le.edges.find((x) => x.source === "A" && x.target === "B");
  assert.equal(e.relation, "prerequisite");
  assert.equal(e.confidenceTier, "extracted");
  assert.equal(e.evidenceSource, null);
});

test("update_edge 改 relation → tier 升 asserted", async () => {
  const add = await call("add_edge", { source: "A", target: "B", relation: "reference", inferred: true });
  const id = add.edge.id;
  const up = await call("update_edge", { edge: id, relation: "prerequisite" });
  assert.equal(up.edge.relation, "prerequisite");
  const le = await call("list_edges");
  const e = le.edges.find((x) => x.id === id);
  assert.equal(e.relation, "prerequisite");
  assert.equal(e.confidenceTier, "asserted", "改 relation＝明示過→asserted");
});

test("update_edge 只帶 note → note 寫入 evidence，list_edges 讀得到（B9-1 修正1）", async () => {
  const add = await call("add_edge", { source: "A", target: "B", relation: "prerequisite" });
  const id = add.edge.id;
  const up = await call("update_edge", { edge: id, note: "跑過 npm test 綠燈" });
  assert.equal(up.edge.note, "跑過 npm test 綠燈", "回應帶 note");
  const le = await call("list_edges");
  const e = le.edges.find((x) => x.id === id);
  assert.equal(e.note, "跑過 npm test 綠燈", "list_edges 讀得到 note（不再被靜默忽略）");
  assert.equal(e.relation, "prerequisite", "relation 未被 note 更新影響");
});

test("update_edge 無任何可更新欄位 → no-op，不寫入不徒增 rev（B9-1 修正1）", async () => {
  const add = await call("add_edge", { source: "A", target: "B", relation: "prerequisite" });
  const before = add.rev;
  const r = await call("update_edge", { edge: add.edge.id });
  assert.equal(r.noop, true, "明確標 no-op");
  assert.ok(r.reason, "附原因");
  const after = await call("list_edges"); // 讀不改 rev；用另一寫入驗證 rev 未被 no-op 推進
  assert.ok(after, "list_edges 正常");
  // 再做一次真實寫入，rev 應為 before+1（no-op 未佔用 rev）。
  const nxt = await call("update_edge", { edge: add.edge.id, note: "x" });
  assert.equal(nxt.rev, before + 1, "no-op 未推進 rev");
});

test("get_changes：relation 更新 → edges.updated{source,target,from,to}（B9-1 修正2）", async () => {
  // rev1 seed（無邊）、rev2 add prerequisite、rev3 update→reference：since_rev:2 只見這條更新。
  const add = await call("add_edge", { source: "A", target: "B", relation: "prerequisite" });
  const afterAdd = add.rev;
  await call("update_edge", { edge: add.edge.id, relation: "reference" });
  const gc = await call("get_changes", { since_rev: afterAdd });
  assert.equal(gc.edges.updated.length, 1, "見一筆邊更新");
  assert.deepEqual(gc.edges.updated[0], { source: "A", target: "B", from: "prerequisite", to: "reference" });
  assert.ok(!gc.edges.legacy, "新形無 legacy");
});

test("get_changes：只改 note（不改 relation）也進 edges.updated（B9-1 修正2）", async () => {
  const add = await call("add_edge", { source: "A", target: "B", relation: "prerequisite" });
  const afterAdd = add.rev;
  await call("update_edge", { edge: add.edge.id, note: "補一句證據" });
  const gc = await call("get_changes", { since_rev: afterAdd });
  assert.equal(gc.edges.updated.length, 1, "evidence/note 變動也算 updated");
  assert.deepEqual(gc.edges.updated[0], { source: "A", target: "B", from: "prerequisite", to: "prerequisite" });
});

test("get_changes：邊端點語意明細 {source,target,relation}（新形）", async () => {
  // reset() 已清 changelog；seed（rev1）無邊，add_edge（rev2）落一條 → since_rev:0 只見這條。
  await call("add_edge", { source: "A", target: "B", relation: "prerequisite" });
  const gc = await call("get_changes", { since_rev: 0 });
  assert.equal(gc.edges.added.length, 1);
  assert.deepEqual(gc.edges.added[0], { source: "A", target: "B", relation: "prerequisite" });
  assert.equal(gc.edges.removed.length, 0);
  assert.ok(!gc.edges.legacy, "全新形＝無 legacy 標記");
});

test("guide mapping 主題：非空且含四種 relation 與不確定性語意", async () => {
  const r = await TOOLS.get_guide.run({ topic: "mapping" });
  assert.equal(r.topic, "mapping");
  assert.ok(r.text.length > 0);
  for (const kw of ["prerequisite", "reference", "imports", "validates", "asserted", "extracted", "inferred", "ambiguous"]) {
    assert.ok(r.text.includes(kw), `mapping 全文含「${kw}」`);
  }
});
