// B25-1 訊號對帳層：auditClaims（純函式）＋ auditRealRefs（假 git 注入，不碰真 repo）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditClaims, auditRealRefs, auditWorktrees } from "../lib/audit.mjs";

const nd = (id, data = {}) => ({ id, type: "note", data: { num: id, label: `卡${id}`, ...data } });
const line = (o) => JSON.stringify(o);

test("auditClaims：逾時無產出才報；新鮮 claim／claim 後有寫入不報", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const pages = [{ name: "任務", nodes: [
    nd("A", { claim: { agent: "bot1", t: "2026-08-02T11:00:00Z" } }), // 逾時 60 分＋claim 後零寫入 → 報
    nd("B", { claim: { agent: "bot2", t: "2026-08-02T11:55:00Z" } }), // 5 分＝心跳新鮮 → 不報
    nd("C", { claim: { agent: "bot3", t: "2026-08-02T10:00:00Z" } }), // 逾時但 claim 後有寫入 → 不報
    nd("D", {}), // 無 claim
  ] }];
  const logs = [
    line({ t: "2026-08-02T11:30:00Z", rev: 2, changed: { a: [], u: ["C"], r: [], ea: [], er: [] } }),
    line({ t: "2026-08-02T09:00:00Z", rev: 1, changed: { a: [], u: ["A"], r: [], ea: [], er: [] } }), // claim 前寫入不算產出
  ];
  const out = auditClaims(pages, logs, { now, staleMs: 15 * 60 * 1000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "claim_stale_no_output");
  assert.equal(out[0].card, "A");
  assert.equal(out[0].agent, "bot1");
  assert.equal(out[0].stale_minutes, 60);
  assert.equal(out[0].page, "任務");
});

test("auditClaims：bulk 行無逐卡明細，不得當該卡的產出證據", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const pages = [{ name: "p", nodes: [nd("A", { claim: { agent: "x", t: "2026-08-02T11:00:00Z" } })] }];
  const logs = [line({ t: "2026-08-02T11:30:00Z", rev: 9, changed: { bulk: true, a: 70, u: 0, r: 0 } })];
  assert.equal(auditClaims(pages, logs, { now }).length, 1);
});

test("auditRealRefs：commit 之後 refs 檔被改＝報；無標記＝skipped；壞 hash＝bad_hash；非 real 不看", async () => {
  const pages = [{ name: "任務", nodes: [
    nd("R1", { status: "real", refs: [{ path: "src/a.mjs" }, { path: "lib/b.mjs" }],
      doneTasks: [{ text: "x", t: "t1", commit: "aaa1111" }] }),
    nd("R2", { status: "real", refs: [{ path: "src/c.mjs" }],
      doneTasks: [{ text: "x", t: "t1", commit: "bbb2222" }] }), // 其後沒人改 c.mjs → 不報
    nd("R3", { status: "real", refs: [{ path: "src/d.mjs" }], doneTasks: ["純文字無 commit"] }), // 無證據 → skipped
    nd("R4", { status: "real", refs: [{ path: "src/e.mjs" }],
      doneTasks: [{ text: "x", t: "t1", commit: "deadbee" }] }), // 壞 hash
    nd("P1", { status: "plan", refs: [{ path: "src/a.mjs" }] }), // 非 real 不入對帳
  ] }];
  const fakeGit = async (args) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
    if (cmd === "rev-parse --show-prefix") return { code: 0, stdout: "\n", stderr: "" };
    if (args[0] === "show") {
      if (args[3] === "deadbee") return { code: 128, stdout: "", stderr: "bad object" };
      return { code: 0, stdout: args[3] === "aaa1111" ? "100\n" : "200\n", stderr: "" };
    }
    if (args[0] === "log") {
      return { code: 0, stdout: cmd.includes("aaa1111") ? "src/a.mjs\nREADME.md\n" : "README.md\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const out = await auditRealRefs(pages, "D:/fake", { runGit: fakeGit });
  assert.equal(out.available, true);
  assert.equal(out.mismatches.length, 1);
  assert.equal(out.mismatches[0].kind, "refs_changed_after_real");
  assert.equal(out.mismatches[0].card, "R1");
  assert.deepEqual(out.mismatches[0].files, ["src/a.mjs"]);
  assert.equal(out.mismatches[0].commit, "aaa1111");
  assert.equal(out.skipped.no_commit_tag, 1);
  assert.deepEqual(out.skipped.bad_hash, ["deadbee"]);
});

test("auditRealRefs：refBase 非 git repo＝available:false 空結果（不猜）", async () => {
  const fakeGit = async () => ({ code: 128, stdout: "", stderr: "not a repo" });
  const out = await auditRealRefs([{ nodes: [nd("R", { status: "real", refs: [{ path: "a" }] })] }], "D:/fake",
    { runGit: fakeGit });
  assert.equal(out.available, false);
  assert.deepEqual(out.mismatches, []);
});

test("auditWorktrees（MA4/MA5）：分支領先＝完工未整合＋檔案登記；齊平不報；同檔並行浮出", async () => {
  const pages = [{ name: "任務", nodes: [nd("mcp_1_1", { num: "W9", label: "某功能" })] }];
  const fakeGit = async (args) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "for-each-ref") {
      return { code: 0, stdout: "hare/chat/default/mcp_1_1\nhare/chat/default/gone_card\nhare/chat/default/flat_1\nhare/chat/default/__integration__\n", stderr: "" };
    }
    if (args[0] === "rev-list") {
      if (args[2].includes("mcp_1_1")) return { code: 0, stdout: "2\n", stderr: "" };
      if (args[2].includes("gone_card") || args[2].includes("__integration__")) return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 0, stdout: "0\n", stderr: "" }; // flat_1 與 main 齊平
    }
    if (args[0] === "diff") {
      if (args[2].includes("mcp_1_1")) return { code: 0, stdout: "lib/x.mjs\n", stderr: "" };
      if (args[2].includes("gone_card")) return { code: 0, stdout: "lib/x.mjs\nsrc/y.jsx\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const out = await auditWorktrees(pages, "D:/fake", "default", { runGit: fakeGit, prefix: "hare/chat/default/" });
  assert.equal(out.available, true);
  assert.equal(out.unintegrated.length, 2, "齊平分支與 __integration__ 不報");
  const w9 = out.unintegrated.find((u) => u.card === "W9");
  assert.ok(w9, "板上有卡＝解析出 num");
  assert.equal(w9.ahead, 2); assert.equal(w9.label, "某功能"); assert.equal(w9.id, "mcp_1_1");
  assert.deepEqual(w9.files, ["lib/x.mjs"], "檔案登記（誰正在做哪些檔）");
  const gone = out.unintegrated.find((u) => u.card === "gone_card");
  assert.ok(gone, "卡被刪＝以分支尾段代稱");
  assert.equal(gone.id, null, "無卡可跳（前端列停用點擊）");
  // MA5 同檔並行：兩卡都改 lib/x.mjs → 一檔一列
  assert.equal(out.concurrent.length, 1);
  assert.equal(out.concurrent[0].file, "lib/x.mjs");
  assert.deepEqual([...out.concurrent[0].cards].sort(), ["W9", "gone_card"].sort());
});

test("auditRealRefs：show-prefix 非空（refBase 在 repo 子目錄）——路徑加前綴比對", async () => {
  const pages = [{ name: "p", nodes: [
    nd("R1", { status: "real", refs: [{ path: "a.mjs" }], doneTasks: [{ text: "x", t: "t", commit: "aaa1111" }] }),
  ] }];
  const fakeGit = async (args) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
    if (cmd === "rev-parse --show-prefix") return { code: 0, stdout: "sub/dir/\n", stderr: "" };
    if (args[0] === "show") return { code: 0, stdout: "100\n", stderr: "" };
    if (args[0] === "log") return { code: 0, stdout: "sub/dir/a.mjs\nother.txt\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const out = await auditRealRefs(pages, "D:/fake/sub/dir", { runGit: fakeGit });
  assert.equal(out.mismatches.length, 1);
  assert.deepEqual(out.mismatches[0].files, ["a.mjs"]);
});
