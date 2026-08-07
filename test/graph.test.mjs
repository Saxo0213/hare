// B10 依賴圖分析單元測試（零依賴，node --test）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readyCards, blockers, downstream, detectCycles, criticalPath } from "../lib/graph.mjs";

// 固定測資：A(real)→B→C；A→D(real)；孤立 E。皆 plan（A/D 標 real）。
const card = (num, status) => ({ id: num, type: "note", data: { num, label: num, status } });
const edge = (s, t) => ({ source: s, target: t });
const fixture = {
  nodes: [card("A", "real"), card("B", "plan"), card("C", "plan"), card("D", "real"), card("E", "plan"),
    { id: "L", type: "lane", data: {} }, { id: "N", type: "note", data: { num: "N", status: "note" } }],
  edges: [edge("A", "B"), edge("B", "C"), edge("A", "D"), edge("N", "E") /* note 邊應被忽略 */],
};

test("readyCards：上游全 real 且自身未 real", () => {
  const r = readyCards(fixture);
  const nums = r.ready.map((c) => c.num).sort();
  // B：上游 A real → 就緒。E：note 邊被忽略→無前置→就緒。C：上游 B 未 real→不就緒。D：real→排除。
  assert.deepEqual(nums, ["B", "E"]);
});

test("blockers：遞迴上游未 real 者", () => {
  assert.deepEqual(blockers(fixture, "C").blockers.map((c) => c.num), ["B"]); // A real 不算
  assert.equal(blockers(fixture, "B").ready, true); // 上游只有 A(real)
});

test("downstream：遞迴下游", () => {
  assert.deepEqual(downstream(fixture, "A").downstream.map((c) => c.num).sort(), ["B", "C", "D"]);
});

test("detectCycles：無環", () => {
  assert.equal(detectCycles(fixture).hasCycle, false);
});

test("detectCycles：有環", () => {
  const cyc = { nodes: [card("X", "plan"), card("Y", "plan"), card("Z", "plan")],
    edges: [edge("X", "Y"), edge("Y", "Z"), edge("Z", "X")] };
  const r = detectCycles(cyc);
  assert.equal(r.hasCycle, true);
  assert.equal(r.cycles[0].length, 3);
});

test("criticalPath：最長鏈 A→B→C", () => {
  const cp = criticalPath(fixture);
  assert.equal(cp.length, 3);
  assert.deepEqual(cp.path.map((c) => c.num), ["A", "B", "C"]);
});

test("criticalPath：有環回報錯誤", () => {
  const cyc = { nodes: [card("X", "plan"), card("Y", "plan")], edges: [edge("X", "Y"), edge("Y", "X")] };
  assert.ok(criticalPath(cyc).error);
});
