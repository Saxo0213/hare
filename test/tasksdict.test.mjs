// B19 任務 dict 化測試：純函式（正規化/遷移確定性/編輯保戳）＋工具層線上相容
//（儲存 dict、線上排序陣列、complete/restore 走 dict）。隔離：HARE_DATA_PATH。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-tasksdict-test-${process.pid}.json`);
process.env.HARE_DATA_PATH = TMP;

const { normalizeTasks, migrateTasksInPlace, taskEntries, taskTexts, addTask, setTaskAt } =
  await import("../lib/tasks.mjs");
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });

test("normalizeTasks：陣列→dict 保序、空白剔除；dict 原樣", () => {
  const d = normalizeTasks(["甲", " ", "乙"], 1000);
  assert.deepEqual(Object.values(d), ["甲", "乙"]);
  assert.deepEqual(Object.keys(d), [new Date(1000).toISOString(), new Date(1002).toISOString()]);
  const same = { "2026-01-01T00:00:00.000Z": "x" };
  assert.equal(normalizeTasks(same), same);
});

test("讀取遷移確定性：同一陣列兩次遷移產生相同鍵（防指紋抖動）", () => {
  const a = migrateTasksInPlace({ data: { tasks: ["一", "二"] } }).data.tasks;
  const b = migrateTasksInPlace({ data: { tasks: ["一", "二"] } }).data.tasks;
  assert.deepEqual(a, b);
  assert.ok(Object.keys(a)[0].startsWith("1970-")); // 1970 基準＝永遠排在新任務前
});

test("addTask 自帶時間戳＋同毫秒避撞；setTaskAt 編輯保戳、空值刪鍵", () => {
  const stamp = "2026-07-18T00:00:00.000Z";
  let d = addTask({}, "第一", stamp);
  d = addTask(d, "第二", stamp); // 同戳 → +1ms
  assert.deepEqual(taskTexts(d), ["第一", "第二"]);
  const k0 = taskEntries(d)[0].k;
  d = setTaskAt(d, 0, "改一");
  assert.equal(taskEntries(d)[0].k, k0); // 編輯保留原時間戳
  assert.equal(taskEntries(d)[0].text, "改一");
  d = setTaskAt(d, 0, null);
  assert.deepEqual(taskTexts(d), ["第二"]);
});

// ---- 工具層端對端 ----
beforeEach(() => writeStore({ nodes: [
  { id: "L1", type: "note", position: { x: 0, y: 0 },
    data: { num: "L1", label: "舊資料卡", status: "plan", tasks: ["舊一", "舊二"] } }, // 陣列＝舊格式
], edges: [] }, "seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP.replace(/\.json$/i, "-changelog.jsonl"), { force: true });
});

test("線上相容：get_card/list_tasks 回排序文字陣列；舊陣列讀取即遷移", async () => {
  const c = await call("get_card", { card: "L1" });
  assert.deepEqual(c.tasks, ["舊一", "舊二"]); // 線上格式仍是陣列
  const lt = await call("list_tasks");
  assert.deepEqual(lt.list[0].tasks, ["舊一", "舊二"]);
});

test("complete_task 擴充：時間戳鍵點名封存＋all 全部封存/全部還原", async () => {
  await call("add_card", { label: "批次卡", num: "L3", tasks: ["批甲", "批乙", "批丙"] });
  // 時間戳鍵點名：取排序第 2 條的鍵封存
  const raw = JSON.parse(await readFile(TMP, "utf8"));
  const l3 = (raw.pages || [{ nodes: raw.nodes }]).flatMap((p) => p.nodes).find((n) => n.data?.num === "L3");
  const key2 = Object.keys(l3.data.tasks).sort()[1];
  const r1 = await call("complete_task", { card: "L3", task: key2 });
  assert.deepEqual(r1.tasks, ["批甲", "批丙"]);
  assert.equal(r1.completed, "批乙");
  // all 全部封存
  const r2 = await call("complete_task", { card: "L3", all: true });
  assert.deepEqual(r2.tasks, []);
  assert.equal(r2.doneTasks.length, 3);
  // all 全部還原（保封存戳時序）
  const r3 = await call("complete_task", { card: "L3", all: true, restore: true });
  assert.equal(r3.doneTasks.length, 0);
  assert.equal(r3.tasks.length, 3);
});

test("add_card 陣列任務→磁碟存 dict；complete/restore 走 dict 保時序", async () => {
  await call("add_card", { label: "新卡", num: "L2", tasks: ["做甲", "做乙"] });
  const raw = JSON.parse(await readFile(TMP, "utf8"));
  const pages = raw.pages || [{ nodes: raw.nodes }];
  const l2 = pages.flatMap((p) => p.nodes).find((n) => n.data?.num === "L2");
  assert.ok(!Array.isArray(l2.data.tasks) && typeof l2.data.tasks === "object", "磁碟儲存應為 dict");
  assert.deepEqual(Object.values(l2.data.tasks), ["做甲", "做乙"]);
  // complete：dict 移除＋doneTasks 入檔
  const done = await call("complete_task", { card: "L2", task: "做甲" });
  assert.deepEqual(done.tasks, ["做乙"]);
  // restore：以封存戳回鍵，排序回到「做甲」在前（封存戳晚於建立戳→應排「做乙」後）
  const back = await call("complete_task", { card: "L2", task: "做甲", restore: true });
  assert.deepEqual(back.tasks, ["做乙", "做甲"]); // 還原戳＝封存時間，晚於做乙的建立戳
});
