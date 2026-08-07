// list_tasks（2026-07-18 使用者需求）：任務視圖——只回帶開放任務的卡。
// 隔離沿 claim.test 慣例：BANLU_DATA_PATH 指暫存檔、先設 env 再 dynamic import。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-listtasks-test-${process.pid}.json`);
process.env.HARE_DATA_PATH = TMP;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });

beforeEach(() => writeStore({
  nodes: [
    { id: "T1", type: "note", position: { x: 0, y: 0 },
      data: { num: "T1", label: "有任務", status: "plan", tasks: ["做 A", "做 B"] } },
    { id: "T2", type: "note", position: { x: 300, y: 0 },
      data: { num: "T2", label: "無任務", status: "real", tasks: [] } },
    { id: "T3", type: "note", position: { x: 600, y: 0 },
      data: { num: "T3", label: "空白任務不算", status: "note", tasks: ["  "] } },
    { id: "L1", type: "lane", position: { x: 0, y: 0 },
      data: { title: "帶任務的泳道不列", tasks: ["假"] } },
  ],
  edges: [],
}, "test-seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP.replace(/\.json$/i, "-changelog.jsonl"), { force: true });
});

test("list_tasks：只回帶開放任務的卡（空白/泳道/無任務皆排除）", async () => {
  const r = await call("list_tasks");
  assert.equal(r.cards, 1);
  assert.equal(r.open_tasks, 2);
  assert.equal(r.list[0].num, "T1");
  assert.deepEqual(r.list[0].tasks, ["做 A", "做 B"]);
});

test("list_tasks：status 過濾", async () => {
  const r = await call("list_tasks", { status: "real" });
  assert.equal(r.cards, 0); // T1 是 plan，被濾掉
});
