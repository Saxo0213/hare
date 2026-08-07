// B5 快照／回滾測試（node --test，零依賴）。
// 隔離：HARE_DATA_DIR 指向暫存資料夾＋HARE_DATA_PATH 指向暫存預設專案檔——
// 全程不碰 repo 內真實 roadmap-data.json 或 data/。env 於動態 import 前設好。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = mkdtempSync(join(tmpdir(), "hare-b5-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default.json");

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, readStore } = await import("../lib/store.mjs");
const { snapshotPathFor } = await import("../lib/snapshots.mjs");

const call = (name, args = {}, ctx = { writer: "test-agent" }) => TOOLS[name].run(args, ctx);

const card = (id) => ({ id, type: "note", position: { x: 0, y: 0 }, data: { num: id, label: id, status: "plan" } });

after(async () => { await rm(TMP, { recursive: true, force: true }); });

test("快照→改板→回滾：board 還原、rev 前進（非回退）、歷史不抹除", async () => {
  const P = "snaptest";
  // 種初板：3 卡＋1 邊＋meta
  await writeStore({
    nodes: [card("s1"), card("s2"), card("s3")],
    edges: [{ id: "e1", source: "s1", target: "s2" }],
    meta: { title: "原始板" },
  }, "test-seed", { project: P, allowEmpty: true });
  const before = await readStore(P);
  assert.equal(before.rev, 1);

  // 建快照
  const snapRes = await call("create_snapshot", { project: P, label: "改前備份" });
  assert.equal(snapRes.ok, true);
  const snapId = snapRes.snapshot.id;
  assert.ok(snapId, "回傳快照 id");
  assert.equal(snapRes.snapshot.rev, 1, "快照記錄的是拍照當下 rev");
  assert.equal(snapRes.snapshot.label, "改前備份");
  assert.equal(snapRes.snapshot.cardCount, 3);

  // 大幅改板：刪一卡、加一卡、改 meta、加一邊
  await call("delete_card", { project: P, card: "s3" });
  await call("add_card", { project: P, label: "新卡", num: "s9", type: "note" });
  await call("update_card", { project: P, card: "s1", label: "改過的 s1" });
  const mutated = await readStore(P);
  assert.ok(mutated.rev > 1, "改板後 rev 已前進");
  const mutatedRev = mutated.rev;
  const mutatedIds = mutated.nodes.map((n) => n.id).sort();
  assert.deepEqual(mutatedIds, ["s1", "s2"].concat(mutated.nodes.filter((n) => n.data?.num === "s9").map((n) => n.id)).sort());
  assert.ok(!mutatedIds.includes("s3"), "s3 已刪");

  // 回滾
  const rb = await call("rollback_snapshot", { project: P, snapshot: snapId });
  assert.equal(rb.ok, true);
  assert.equal(rb.restoredFrom.id, snapId);
  assert.equal(rb.restoredFrom.rev, 1);

  const after = await readStore(P);
  // board 內容還原成快照當下（3 卡、s3 回來、s1 label 復原、s9 不在、meta 復原、邊復原）
  const ids = after.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["s1", "s2", "s3"], "節點還原成快照");
  assert.equal(after.nodes.find((n) => n.id === "s1").data.label, "s1", "s1 label 還原");
  assert.equal(after.meta.title, "原始板", "meta 還原");
  assert.equal(after.edges.length, 1, "邊還原");
  assert.equal(after.edges[0].id, "e1");
  // rev 前進（新 rev = mutatedRev + 1），不是回退到快照的 rev 1
  assert.equal(after.rev, mutatedRev + 1, "回滾以新 rev 寫回（非回退）");
  assert.equal(rb.rev, after.rev);
  assert.ok(after.rev > 1, "rev 絕不回退到快照當下值");

  // 歷史不抹除：快照仍在，且可再次回滾（回滾本身可回滾）
  const listed = await call("list_snapshots", { project: P });
  assert.equal(listed.count, 1, "快照歷史仍在");
  assert.equal(listed.snapshots[0].id, snapId);
  const rb2 = await call("rollback_snapshot", { project: P, snapshot: snapId });
  assert.equal(rb2.rev, after.rev + 1, "可重複回滾，rev 持續前進");
});

test("list_snapshots：多筆時間序、輕量（不含 board）", async () => {
  const P = "snaplist";
  await writeStore({ nodes: [card("a1")], edges: [] }, "test", { project: P, allowEmpty: true });
  const r1 = await call("create_snapshot", { project: P, label: "第一張" });
  await call("add_card", { project: P, label: "多一卡", num: "a2", type: "note" });
  const r2 = await call("create_snapshot", { project: P });

  const listed = await call("list_snapshots", { project: P });
  assert.equal(listed.count, 2);
  // append 順序＝早→晚
  assert.equal(listed.snapshots[0].id, r1.snapshot.id);
  assert.equal(listed.snapshots[1].id, r2.snapshot.id);
  assert.equal(listed.snapshots[0].label, "第一張");
  assert.equal(listed.snapshots[1].label, null, "省略 label＝null");
  // 卡數各自反映拍照當下
  assert.equal(listed.snapshots[0].cardCount, 1);
  assert.equal(listed.snapshots[1].cardCount, 2);
  // 輕量：清單項不含 board
  assert.ok(!("board" in listed.snapshots[0]), "list 不回傳整版 board");
  assert.equal(listed.snapshots[0].writer, "test-agent", "writer 由 ctx 蓋章");
});

test("per 專案隔離：快照檔各自獨立、互不可見", async () => {
  const A = "snapiso-a", B = "snapiso-b";
  await writeStore({ nodes: [card("x1")], edges: [] }, "test", { project: A, allowEmpty: true });
  await writeStore({ nodes: [card("y1")], edges: [] }, "test", { project: B, allowEmpty: true });
  await call("create_snapshot", { project: A, label: "A 的快照" });

  // A 有一張、B 沒有
  assert.equal((await call("list_snapshots", { project: A })).count, 1);
  assert.equal((await call("list_snapshots", { project: B })).count, 0);
  // 快照檔路徑不同
  assert.notEqual(snapshotPathFor(A), snapshotPathFor(B));
  assert.ok(snapshotPathFor(A).endsWith("snapiso-a-snapshots.jsonl"));

  // 用 A 的快照 id 在 B 回滾＝找不到（隔離）
  const aId = (await call("list_snapshots", { project: A })).snapshots[0].id;
  await assert.rejects(() => call("rollback_snapshot", { project: B, snapshot: aId }), /找不到快照/);
});

test("空快照回滾：allowEmpty 生效（快照本就是空板才可還原成空）", async () => {
  const P = "snapempty";
  // 空板專案（0 卡）
  await writeStore({ nodes: [], edges: [] }, "test", { project: P, allowEmpty: true });
  const snap = await call("create_snapshot", { project: P, label: "空板" });
  assert.equal(snap.snapshot.cardCount, 0);

  // 填卡到 ≥5（觸發 store 的空板寫入防呆門檻）
  await writeStore({ nodes: [card("f1"), card("f2"), card("f3"), card("f4"), card("f5"), card("f6")], edges: [] },
    "test", { project: P });
  assert.equal((await readStore(P)).nodes.length, 6);

  // 回滾到空快照：因快照本就合法為空 → allowEmpty，成功還原成 0 卡
  const rb = await call("rollback_snapshot", { project: P, snapshot: snap.snapshot.id });
  assert.equal(rb.cardCount, 0);
  const after = await readStore(P);
  assert.equal(after.nodes.length, 0, "還原成空板");
  assert.ok(after.rev > 1, "rev 仍前進");
});

test("rollback_snapshot：找不到快照 id 報錯", async () => {
  const P = "snapmiss";
  await writeStore({ nodes: [card("m1")], edges: [] }, "test", { project: P, allowEmpty: true });
  await assert.rejects(() => call("rollback_snapshot", { project: P, snapshot: "snap_nope" }), /找不到快照/);
});

test("write 分級：create_snapshot 與 rollback_snapshot 屬 write、list_snapshots 屬 read", async () => {
  const { WRITE_TOOL_NAMES, roleFor } = await import("../lib/tools.mjs");
  assert.ok(WRITE_TOOL_NAMES.has("create_snapshot"));
  assert.ok(WRITE_TOOL_NAMES.has("rollback_snapshot"));
  assert.ok(!WRITE_TOOL_NAMES.has("list_snapshots"));
  assert.equal(roleFor("rollback_snapshot"), "write");
  assert.equal(roleFor("list_snapshots"), "read");
});
