// 孤兒 agent 行程回收（HARE 0a9fa9e5，2026-08-02 SlimeHunter 雙寫事故）：
// 登記檔＝data/chat/agent-pids.json；死 pid/身分不吻合＝放過；活的 node 行程＝整樹終止。
// 隔離：HARE_DATA_DIR 溫暫存，先設 env 再 import。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

const ROOT = join(tmpdir(), `hare-reap-${process.pid}`);
process.env.HARE_DATA_DIR = ROOT;
const { reapOrphanAgents } = await import("../lib/chat.mjs");

const PIDS = join(ROOT, "chat", "agent-pids.json");
after(() => rm(ROOT, { recursive: true, force: true }));

const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

test("死 pid／檔不存在＝安全通過並清檔", async () => {
  assert.deepEqual((await reapOrphanAgents()).reaped, [], "無登記檔＝空跑");
  await mkdir(join(ROOT, "chat"), { recursive: true });
  await writeFile(PIDS, JSON.stringify([{ pid: 999999, project: "default", card: "cX", t: "t" }]));
  const r = await reapOrphanAgents();
  assert.deepEqual(r.reaped, [], "死 pid（查無映像）不殺不報");
  assert.deepEqual(JSON.parse(await readFile(PIDS, "utf8")), [], "掃完清檔");
});

test("活的 node 登記行程＝整樹終止", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid && alive(child.pid), "測試行程起得來");
  await writeFile(PIDS, JSON.stringify([{ pid: child.pid, project: "default", card: "cY", t: "t" }]));
  const r = await reapOrphanAgents();
  assert.equal(r.reaped.length, 1, "身分吻合（node）＝回收");
  assert.equal(r.reaped[0].pid, child.pid);
  // taskkill 非同步落地：輪詢至死，上限 5 秒
  let dead = false;
  for (let i = 0; i < 50 && !dead; i += 1) {
    await new Promise((res) => setTimeout(res, 100));
    dead = !alive(child.pid);
  }
  assert.equal(dead, true, "行程已被終止");
});
