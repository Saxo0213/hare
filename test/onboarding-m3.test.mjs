// 入職系統 M3（B8）：專案啟動狀態機——單元＋JSON-RPC 實跑。
// 隔離沿 multiproject 慣例：HARE_DATA_DIR/HARE_DATA_PATH 指暫存區，全程不碰 repo 真板。
// 設計哲學驗證：程式管流程與狀態轉移（種子／顯示／歸零清 meta），agent 管語意。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const TMP = mkdtempSync(join(tmpdir(), "hare-m3-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default-legacy.json");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const { TOOLS } = await import("../lib/tools.mjs");
const { createProject, onboardingSeed, ONBOARDING_STEPS } = await import("../lib/projects.mjs");
const { readStore, updateStore, ensurePages } = await import("../lib/store.mjs");
const { taskTexts } = await import("../lib/tasks.mjs");

after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 略 */ } });

// 模擬使用者在瀏覽器親自勾選最後一項：前端直接同步板資料，不經 MCP complete_task。
async function browserApprove(project) {
  await updateStore((data) => {
    const ob = data.meta?.onboarding;
    const card = ensurePages(data).flatMap((p) => p.nodes || []).find((n) => n.id === ob?.card);
    const final = taskTexts(card?.data?.tasks).find((t) => t.includes("使用者核可"));
    card.data.tasks = {};
    card.data.doneTasks = [...(card.data.doneTasks || []), { text: final, t: new Date().toISOString() }];
  }, "browser", { project });
}

/* ---------- onboardingSeed 純函式 ---------- */
test("onboardingSeed(new)：導覽頁＋G0 模板＋啟動檢核卡（四任務）＋G0→檢核邊", () => {
  const { page, checklistId, meta } = onboardingSeed("new");
  assert.equal(page.name, "導覽");
  const g0 = page.nodes.find((n) => n.data.num === "G0");
  assert.ok(g0, "應有 G0 卡");
  assert.equal(g0.data.status, "plan");
  assert.match(g0.data.desc, /一句話/);          // 首行佔位
  assert.match(g0.data.desc, /## 路線/);          // 段落骨架
  assert.match(g0.data.desc, /## 關鍵裁決/);
  const chk = page.nodes.find((n) => n.id === checklistId);
  assert.equal(taskTexts(chk.data.tasks).length, 4, "新專案四步");
  assert.equal(chk.data.doneTasks, undefined, "new 模式無代銷步");
  assert.deepEqual(taskTexts(chk.data.tasks), ONBOARDING_STEPS.new);
  const edge = page.edges[0];
  assert.equal(edge.source, g0.id);
  assert.equal(edge.target, checklistId);
  assert.deepEqual(meta, { mode: "new", card: checklistId });
});

test("onboardingSeed(existing)：五步，第一步『掃描』已由系統代銷（doneTasks）", () => {
  const { page, checklistId } = onboardingSeed("existing");
  const chk = page.nodes.find((n) => n.id === checklistId);
  assert.equal(taskTexts(chk.data.tasks).length, 4, "開放 4 條（五步 − 已代銷首步）");
  assert.equal(chk.data.doneTasks.length, 1);
  assert.match(chk.data.doneTasks[0].text, /掃描/);
});

/* ---------- create_project 種子 ---------- */
test("create_project：自動種導覽頁／G0／檢核卡（new 四步）／meta.onboarding", async () => {
  const r = await TOOLS.create_project.run({ id: "TESTm3new", title: "M3 新專案" }, { writer: "test" });
  assert.equal(r.ok, true);
  const cur = await readStore("TESTm3new");
  assert.ok(Array.isArray(cur.pages), "多頁 → v2");
  const guide = cur.pages.find((p) => p.name === "導覽");
  assert.ok(guide, "應種導覽分頁");
  assert.ok(guide.nodes.some((n) => n.data.num === "G0"));
  assert.equal(cur.meta.onboarding.mode, "new");
  const chk = guide.nodes.find((n) => n.id === cur.meta.onboarding.card);
  assert.equal(taskTexts(chk.data.tasks).length, 4);
});

/* ---------- analyze 全新專案路線 vs 有 page 路線 ---------- */
test("analyze_codebase 全新專案：種 existing 狀態機；有 page 路線不種", async () => {
  const LIB = resolve(REPO, "lib");
  // 全新專案（無 page）→ 種
  await TOOLS.analyze_codebase.run({ path: LIB, project: "TESTm3ex" }, { writer: "test" });
  const cur = await readStore("TESTm3ex");
  assert.equal(cur.meta.onboarding?.mode, "existing");
  const guide = cur.pages.find((p) => p.name === "導覽");
  const chk = guide.nodes.find((n) => n.id === cur.meta.onboarding.card);
  assert.equal(taskTexts(chk.data.tasks).length, 4);
  assert.equal(chk.data.doneTasks.length, 1);
  // 有 page 路線（往既有專案長分析頁）→ 不種（不再新增 onboarding，不覆寫既有 meta.onboarding）
  await TOOLS.analyze_codebase.run({ path: LIB, project: "TESTm3ex", page: "再分析" }, { writer: "test" });
  const cur2 = await readStore("TESTm3ex");
  assert.ok(!cur2.pages.some((p) => p.name === "導覽" && p.id !== guide.id), "不重種導覽頁");
  assert.equal(cur2.pages.filter((p) => p.name === "導覽").length, 1, "導覽頁仍只有一個");
});

/* ---------- get_overview onboarding 欄位 ---------- */
test("get_overview：open>0 顯示 onboarding；agent 不可全銷，使用者核可後歸零", async () => {
  await TOOLS.create_project.run({ id: "TESTm3ov" }, { writer: "test" });
  const ov = await TOOLS.get_overview.run({ project: "TESTm3ov" });
  assert.ok(ov.onboarding, "應附 onboarding 欄位");
  assert.equal(ov.onboarding.mode, "new");
  assert.equal(ov.onboarding.checklist, "O1");
  assert.equal(ov.onboarding.open, 4);
  await assert.rejects(
    () => TOOLS.complete_task.run({ card: "O1", all: true, project: "TESTm3ov" }, { writer: "test" }),
    /不可 all:true|使用者核可/,
  );
  for (let i = 0; i < 3; i++) {
    await TOOLS.complete_task.run({ card: "O1", task: 0, project: "TESTm3ov" }, { writer: "test" });
  }
  await browserApprove("TESTm3ov");
  const ov2 = await TOOLS.get_overview.run({ project: "TESTm3ov" });
  assert.equal(ov2.onboarding, undefined, "使用者親自核可、tasks 歸零 → 省略 onboarding");
});

test("complete_task：前三項依序可銷；最後使用者核可不可由 agent 代銷", async () => {
  await TOOLS.create_project.run({ id: "TESTm3seq" }, { writer: "test" });
  await assert.rejects(
    () => TOOLS.complete_task.run({ card: "O1", task: 1, project: "TESTm3seq" }, { writer: "test" }),
    /必須依序完成/,
  );
  await assert.rejects(
    () => TOOLS.update_card.run({ card: "O1", tasks: [], project: "TESTm3seq" }, { writer: "test" }),
    /不可用 update_card 改寫/,
  );
  for (let i = 0; i < 3; i++) {
    await TOOLS.complete_task.run({ card: "O1", task: 0, project: "TESTm3seq" }, { writer: "test" });
    const c = await readStore("TESTm3seq");
    assert.ok(c.meta.onboarding, `剩 ${4 - i - 1} 條時 meta.onboarding 仍在`);
  }
  await assert.rejects(
    () => TOOLS.complete_task.run({ card: "O1", task: 0, project: "TESTm3seq" }, { writer: "test" }),
    /不可由 agent 代銷/,
  );
  const waiting = await readStore("TESTm3seq");
  assert.ok(waiting.meta.onboarding, "等待使用者核可時 onboarding 仍在");
  const chk = ensurePages(waiting).flatMap((p) => p.nodes || []).find((n) => n.id === waiting.meta.onboarding.card);
  assert.match(taskTexts(chk.data.tasks)[0], /使用者核可/);
});

test("delete_card：啟動中不可刪檢核卡；資料懸空時 overview 仍容忍", async () => {
  await TOOLS.create_project.run({ id: "TESTm3dangle" }, { writer: "test" });
  await assert.rejects(
    () => TOOLS.delete_card.run({ card: "O1", project: "TESTm3dangle" }, { writer: "test" }),
    /不可刪除檢核卡/,
  );
  await updateStore((data) => {
    const id = data.meta.onboarding.card;
    for (const p of ensurePages(data)) p.nodes = (p.nodes || []).filter((n) => n.id !== id);
  }, "corrupt-fixture", { project: "TESTm3dangle" });
  const ov = await TOOLS.get_overview.run({ project: "TESTm3dangle" });
  assert.equal(ov.onboarding, undefined, "懸空 meta → 視同無入職");
});

/* ---------- JSON-RPC 實跑（暫存 project，子行程沿用同一 HARE_DATA_DIR） ---------- */
test("JSON-RPC：create_project→overview 見 onboarding→agent 不可 complete all", async () => {
  const child = spawn(process.execPath, ["mcp-server.mjs"], {
    cwd: REPO, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const responses = new Map();
  const waiters = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null) {
        responses.set(msg.id, msg);
        const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); }
      }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = (id, ms = 8000) => new Promise((res, rej) => {
    if (responses.has(id)) return res(responses.get(id));
    const to = setTimeout(() => rej(new Error(`等待 id=${id} 逾時；stderr=${stderr}`)), ms);
    waiters.set(id, (m) => { clearTimeout(to); res(m); });
  });
  const call = async (id, name, args) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitFor(id);
    return JSON.parse(r.result.content[0].text.replace(/^\[HARE guide[\s\S]*?\]\n/, ""));
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
    const created = await call(2, "create_project", { id: "TESTm3rpc" });
    assert.equal(created.ok, true);
    const ov = await call(3, "get_overview", { project: "TESTm3rpc" });
    assert.equal(ov.onboarding?.mode, "new");
    assert.equal(ov.onboarding?.open, 4);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "complete_task", arguments: { card: "O1", all: true, project: "TESTm3rpc" },
    } });
    const denied = await waitFor(4);
    assert.match(JSON.stringify(denied), /不可 all:true|使用者核可/, "JSON-RPC 同樣受啟動閘門限制");
    const ov2 = await call(5, "get_overview", { project: "TESTm3rpc" });
    assert.equal(ov2.onboarding?.open, 4, "拒絕後 onboarding 保持原狀");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
