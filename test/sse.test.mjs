// N39 SSE 事件序號＋斷線補放測試：假 res 物件收集寫入，驗證 id 欄、環形緩衝與 after 補放。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBroadcaster } from "../lib/sse.mjs";

const fakeRes = () => { const w = []; return { writes: w, write: (s) => w.push(s) }; };
const seqsOf = (res) => res.writes.map((s) => /^id: (\d+)/.exec(s)?.[1]).filter(Boolean).map(Number);

test("事件帶單調序號；同專案訂閱者收到、他專案不收", () => {
  const b = createBroadcaster();
  const a = fakeRes(), other = fakeRes();
  b.addClient(a, "default");
  b.addClient(other, "beta");
  b.broadcast(100);
  b.broadcastEvent({ type: "chat", card: "x", event: "msg" });
  assert.deepEqual(seqsOf(a), [1, 2]);
  assert.equal(other.writes.length, 0);
});

test("斷線補放：after 游標之後的事件先補齊再接 live", () => {
  const b = createBroadcaster();
  b.broadcastEvent({ type: "chat", event: "m1" });
  b.broadcastEvent({ type: "chat", event: "m2" });
  b.broadcastEvent({ type: "chat", event: "m3" });
  const late = fakeRes();
  b.addClient(late, "default", "1"); // 收過 seq1＝補放 2、3
  assert.deepEqual(seqsOf(late), [2, 3]);
  b.broadcastEvent({ type: "chat", event: "m4" }); // live 接續
  assert.deepEqual(seqsOf(late), [2, 3, 4]);
});

test("環形緩衝：超出上限丟最舊（early 斷線走整包重載兜底）", () => {
  const b = createBroadcaster();
  for (let i = 0; i < 505; i++) b.broadcastEvent({ i });
  const late = fakeRes();
  b.addClient(late, "default", "0");
  const seqs = seqsOf(late);
  assert.equal(seqs.length, 500);
  assert.equal(seqs[0], 6); // 1..5 已被擠出
  assert.equal(seqs.at(-1), 505);
});
