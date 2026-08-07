// B14 Agent 認領協定測試：claim_card / release_card / list_active ＋ get_ready_cards claimed 過濾。
// 零依賴（node:test）；以 HARE_DATA_PATH 覆寫隔離到 OS 暫存檔（先設 env 再 dynamic import）。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-claim-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, updateStore } = await import("../lib/store.mjs");

const CTX = { writer: "test" };
const call = (name, args = {}) => TOOLS[name].run(args, CTX);

// 種子：P1(real)→P2→P3 依賴鏈（P2 就緒），供認領與就緒過濾測試。
function seedBoard() {
  return {
    nodes: [
      { id: "P1", type: "note", position: { x: 1, y: 2 },
        data: { num: "P1", label: "Card One", status: "real" } },
      { id: "P2", type: "note", position: { x: 300, y: 2 },
        data: { num: "P2", label: "Card Two", status: "plan" } },
      { id: "P3", type: "note", position: { x: 600, y: 2 },
        data: { num: "P3", label: "Card Three", status: "plan" } },
    ],
    edges: [
      { id: "e1", source: "P1", target: "P2" },
      { id: "e2", source: "P2", target: "P3" },
    ],
  };
}
beforeEach(() => writeStore(seedBoard(), "test-seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
});

test("claim_card：認領後 data.claim 帶 agent 與時戳", async () => {
  const r = await call("claim_card", { card: "P2", agent: "agent-A" });
  assert.equal(r.ok, true);
  assert.equal(r.card, "P2");
  assert.equal(r.claim.agent, "agent-A");
  assert.ok(r.claim.t, "帶 ISO 時戳");
  const got = await call("get_card", { card: "P2", fields: ["claim"] });
  assert.equal(got.claim.agent, "agent-A");
});

test("claim_card：已被別的 agent 認領（新鮮）→ 拒絕並告知認領者", async () => {
  await call("claim_card", { card: "P2", agent: "agent-A" });
  await assert.rejects(
    () => call("claim_card", { card: "P2", agent: "agent-B" }),
    /已被 agent-A 認領/,
  );
});

test("claim_card：同一 agent 重複認領＝刷新心跳（idempotent，時戳前進）", async () => {
  const r1 = await call("claim_card", { card: "P2", agent: "agent-A" });
  await new Promise((res) => setTimeout(res, 5)); // 確保時戳不同
  const r2 = await call("claim_card", { card: "P2", agent: "agent-A" });
  assert.equal(r2.ok, true);
  assert.equal(r2.claim.agent, "agent-A");
  assert.ok(Date.parse(r2.claim.t) >= Date.parse(r1.claim.t), "心跳時戳刷新（不倒退）");
});

test("release_card 後可被別的 agent 重新認領", async () => {
  await call("claim_card", { card: "P2", agent: "agent-A" });
  const rel = await call("release_card", { card: "P2" });
  assert.equal(rel.released, true);
  const got = await call("get_card", { card: "P2", fields: ["claim"] });
  assert.equal(got.claim, null, "release 後 claim 欄位已刪");
  // 釋放後別的 agent 可認領
  const r = await call("claim_card", { card: "P2", agent: "agent-B" });
  assert.equal(r.claim.agent, "agent-B");
});

test("list_active：列出認領者 + 時戳 + stale 旗標", async () => {
  await call("claim_card", { card: "P2", agent: "agent-A" });
  // 手動注入一個「陳舊」認領（心跳 30 分鐘前）到 P3
  await updateStore((data) => {
    const n = data.nodes.find((m) => m.id === "P3");
    n.data.claim = { agent: "agent-stale", t: new Date(Date.now() - 30 * 60 * 1000).toISOString() };
  }, "test");

  const r = await call("list_active");
  assert.equal(r.count, 2);
  assert.equal(r.staleThresholdMin, 15);
  const fresh = r.active.find((a) => a.num === "P2");
  const stale = r.active.find((a) => a.num === "P3");
  assert.equal(fresh.agent, "agent-A");
  assert.equal(fresh.stale, false, "剛認領＝非 stale");
  assert.ok(fresh.t, "帶時戳");
  assert.equal(stale.agent, "agent-stale");
  assert.equal(stale.stale, true, "30 分前認領＝stale");
});

test("claim_card：陳舊（stale）認領可被別的 agent 接手", async () => {
  // P2 被 agent-A 於 30 分前認領（stale）
  await updateStore((data) => {
    const n = data.nodes.find((m) => m.id === "P2");
    n.data.claim = { agent: "agent-A", t: new Date(Date.now() - 30 * 60 * 1000).toISOString() };
  }, "test");
  const r = await call("claim_card", { card: "P2", agent: "agent-B" });
  assert.equal(r.claim.agent, "agent-B", "stale 認領被接手");
});

test("get_ready_cards：claimed 過濾與 available/claim 標註", async () => {
  // P2 就緒且未認領 → available
  const all0 = await call("get_ready_cards");
  const p2ready = all0.ready.find((c) => c.num === "P2");
  assert.ok(p2ready, "P2 就緒");
  assert.equal(p2ready.available, true);
  assert.equal(p2ready.claim, null);

  await call("claim_card", { card: "P2", agent: "agent-A" });
  // claimed:false → 排除已被活躍認領的 P2
  const avail = await call("get_ready_cards", { claimed: false });
  assert.ok(!avail.ready.some((c) => c.num === "P2"), "claimed:false 排除已認領");
  // claimed:true → 只留被活躍認領的 P2
  const taken = await call("get_ready_cards", { claimed: true });
  assert.deepEqual(taken.ready.map((c) => c.num), ["P2"]);
  assert.equal(taken.ready[0].claim.agent, "agent-A");
});
