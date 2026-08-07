// B17 板型規則引擎測試：板型偵測（泳道 sub 標記）＋validate 連線語意提示＋add_edge 即時 hint。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-boardtype-test-${process.pid}.json`);
process.env.HARE_DATA_PATH = TMP;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");
const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });

const card = (id, x) => ({ id, type: "note", position: { x, y: 0 }, data: { num: id, label: id, status: "note", desc: "d" } });
beforeEach(() => writeStore({ pages: [
  { id: "p1", name: "介面", nodes: [
    { id: "ln1", type: "lane", position: { x: 0, y: 0 }, data: { title: "帶", sub: "模組介面圖·agent 自建" } },
    card("A1", 0), card("A2", 300),
  ], edges: [
    // flow 線（無 marker 欄）＝違反 iface 慣例 → validate 應提示
    { id: "e1", source: "A1", target: "A2" },
  ] },
  { id: "p2", name: "自由", nodes: [card("B1", 0), card("B2", 300)], edges: [
    { id: "e2", source: "B1", target: "B2" }, // task 板不限制＝不提示
  ] },
] }, "seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP.replace(/\.json$/i, "-changelog.jsonl"), { force: true });
});

test("validate：模組介面板的 flow 線收到板型提示；自由板不提示", async () => {
  const r = await call("validate_cards");
  const hints = (r.problems || []).filter((p) => p.issue === "板型連線語意提示");
  assert.equal(hints.length, 1);
  assert.ok(hints[0].detail.includes("A1→A2") && hints[0].detail.includes("inject"));
  assert.equal(hints[0].page, "介面");
});

test("add_edge 即時 hint：介面板加 flow 線回 hint、加 inject 線不回", async () => {
  const r1 = await call("add_edge", { source: "A1", target: "A2", page: "介面" });
  assert.ok(r1.hint && r1.hint.includes("inject"), `應含板型提示：${JSON.stringify(r1)}`);
  const r2 = await call("add_edge", { source: "A2", target: "A1", arrow: "inject", page: "介面" });
  assert.equal(r2.hint, undefined);
  // B2→B1（反向，非既有 B1→B2 的重複）：自由板不回板型提示、也非自環/重複
  const r3 = await call("add_edge", { source: "B2", target: "B1", page: "自由" });
  assert.equal(r3.hint, undefined); // task 板不限制
});
