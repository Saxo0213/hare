// B15 卡片討論串測試：add_comment / list_comments / delete_comment（node --test，零依賴）。
// 隔離：HARE_DATA_DIR 指向暫存資料夾＋HARE_DATA_PATH 指向暫存預設專案檔——
// 全程不碰 repo 內真實 roadmap-data.json 或 data/。env 於動態 import 前設好。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = mkdtempSync(join(tmpdir(), "hare-b15-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default.json");

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

// call 帶入 transport 身分；writer 應由 ctx 決定，非呼叫端引數。
const call = (name, args = {}, ctx = { writer: "test-agent" }) => TOOLS[name].run(args, ctx);

function seedBoard() {
  return {
    nodes: [
      { id: "L1", type: "lane", data: { title: "測試泳道" } },
      { id: "P1", type: "note", position: { x: 1, y: 2 },
        data: { num: "P1", label: "Card One", status: "plan" } },
      { id: "P2", type: "note", position: { x: 300, y: 2 },
        data: { num: "P2", label: "Card Two", status: "plan" } },
    ],
    edges: [],
  };
}
beforeEach(() => writeStore(seedBoard(), "test-seed", { allowEmpty: true }));
after(async () => { await rm(TMP, { recursive: true, force: true }); });

test("add_comment：兩則留言 writer 由 ctx 蓋章（不可偽造）、時間序、text 原文保留", async () => {
  // 呼叫端試圖夾帶 writer 偽造身分——應被忽略，改用 ctx.writer
  const r1 = await call("add_comment",
    { card: "P1", text: "第一則：決策脈絡", writer: "forged-human" },
    { writer: "human-alice" });
  assert.equal(r1.ok, true);
  assert.equal(r1.count, 1);
  assert.equal(r1.comment.writer, "human-alice", "writer 取自 ctx，非引數偽造值");
  assert.equal(r1.comment.text, "第一則：決策脈絡", "text 原文保留");
  assert.ok(typeof r1.comment.t === "string" && !Number.isNaN(Date.parse(r1.comment.t)), "t 為合法 ISO 時間");

  const r2 = await call("add_comment", { card: "P1", text: "第二則：驗證依據" }, { writer: "mcp-agent" });
  assert.equal(r2.count, 2);
  assert.equal(r2.comment.writer, "mcp-agent");

  // 時間序：先加的在前
  const listed = await call("list_comments", { card: "P1" });
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.comments.map((c) => c.text), ["第一則：決策脈絡", "第二則：驗證依據"]);
  assert.deepEqual(listed.comments.map((c) => c.writer), ["human-alice", "mcp-agent"]);
  assert.ok(Date.parse(listed.comments[0].t) <= Date.parse(listed.comments[1].t), "留言時間非遞減");
});

test("list_comments：無留言的卡回傳空陣列", async () => {
  const r = await call("list_comments", { card: "P2" });
  assert.equal(r.count, 0);
  assert.deepEqual(r.comments, []);
});

test("留言與 tasks/desc 分離：add_comment 不動 tasks", async () => {
  await call("add_card", { label: "有任務卡", type: "note", num: "P9", tasks: ["做甲"] });
  await call("add_comment", { card: "P9", text: "一句留言" });
  const card = await call("get_card", { card: "P9", fields: ["tasks", "comments"] });
  assert.deepEqual(card.tasks, ["做甲"], "tasks 不受留言影響");
  assert.equal(card.comments.length, 1, "comments 獨立頻道");
});

test("delete_comment：以索引刪除、count 遞減、其餘保留", async () => {
  await call("add_comment", { card: "P1", text: "甲" });
  await call("add_comment", { card: "P1", text: "乙" });
  await call("add_comment", { card: "P1", text: "丙" });
  const r = await call("delete_comment", { card: "P1", index: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.removed.text, "乙");
  assert.equal(r.count, 2);
  const listed = await call("list_comments", { card: "P1" });
  assert.deepEqual(listed.comments.map((c) => c.text), ["甲", "丙"]);
  // 索引越界報錯
  await assert.rejects(() => call("delete_comment", { card: "P1", index: 9 }), /索引超出範圍/);
});

test("add_comment：對不存在的卡片報錯", async () => {
  await assert.rejects(() => call("add_comment", { card: "ZZ9", text: "x" }), /找不到卡片/);
});

test("list_comments：對不存在的卡片報錯", async () => {
  await assert.rejects(() => call("list_comments", { card: "ZZ9" }), /找不到卡片/);
});

test("add_comment：空白留言拒絕", async () => {
  await assert.rejects(() => call("add_comment", { card: "P1", text: "   " }), /不可為空/);
});
