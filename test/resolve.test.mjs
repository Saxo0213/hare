// MA3 agent 帶意圖自動解衝突（Layer 2）orchestration：resolver/verifier 注入（mock）。
// 六情境：乾淨無衝突／解成 land／殘留標記重試耗盡／閘門紅／複核否決／resolver 放棄。
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConflict } from "../lib/resolve.mjs";

let repo, wt;
const g = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
const put = (name, content, cwd = repo) => writeFile(join(cwd, name), content);
const RESOLVED = "l1\nl2-merged\nl3\n";
const okVerifier = () => ({ preserved: true });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-rz-"));
  wt = await mkdtemp(join(tmpdir(), "hare-rz-wt-"));
  await rm(wt, { recursive: true, force: true }); // git worktree add 要求路徑不存在
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  await put("f.txt", "l1\nl2\nl3\n"); await put("other.txt", "x\n");
  await put("gate.js", "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)\n");
  g(["add", "-A"]); g(["commit", "-qm", "base"]);
  const branch = async (name, mut) => { g(["checkout", "-q", "main"]); g(["checkout", "-q", "-b", name]); await mut(); g(["add", "-A"]); g(["commit", "-qam", name]); };
  await branch("feat-a", () => put("f.txt", "l1\nl2A\nl3\n"));
  await branch("feat-b", () => put("f.txt", "l1\nl2B\nl3\n"));  // 與 feat-a 同行衝突
  await branch("feat-c", () => put("other.txt", "y\n"));         // 與 feat-a 不衝突
  g(["checkout", "-q", "main"]);
  g(["worktree", "add", "-q", "-b", "intb", wt, "feat-a"]);      // 整合 worktree 起於 feat-a
});
beforeEach(() => { try { g(["merge", "--abort"], wt); } catch { /* none */ } g(["reset", "-q", "--hard", "feat-a"], wt); g(["clean", "-qfd"], wt); });
after(async () => {
  try { g(["worktree", "remove", "--force", wt]); } catch { /* ignore */ }
  await rm(repo, { recursive: true, force: true }); await rm(wt, { recursive: true, force: true });
});

test("乾淨無衝突（feat-c）：直接 land", async () => {
  const r = await resolveConflict(wt, "feat-c", { resolver: () => [], verifier: okVerifier });
  assert.equal(r.resolved, true); assert.equal(r.landed, true); assert.equal(r.note, "clean");
});

test("解成＋閘門綠＋複核過：land，檔案為解法內容", async () => {
  const r = await resolveConflict(wt, "feat-b", {
    resolver: () => [{ path: "f.txt", content: RESOLVED }], verifier: okVerifier, gateCommand: ["node", "gate.js"],
  });
  assert.equal(r.landed, true); assert.equal(r.resolved, true);
  assert.equal(await readFile(join(wt, "f.txt"), "utf8"), RESOLVED, "解法內容已落地");
});

test("殘留衝突標記：重試耗盡→人審", async () => {
  const r = await resolveConflict(wt, "feat-b", {
    resolver: ({ files }) => [{ path: "f.txt", content: files[0].content }], // 原封不動（仍含標記）
    verifier: okVerifier, maxRetries: 2,
  });
  assert.equal(r.landed, false); assert.equal(r.reason, "retries-exhausted→human");
});

test("閘門紅（解法帶 bad.txt）：重試耗盡→人審", async () => {
  const r = await resolveConflict(wt, "feat-b", {
    resolver: () => [{ path: "f.txt", content: RESOLVED }, { path: "bad.txt", content: "boom\n" }],
    verifier: okVerifier, gateCommand: ["node", "gate.js"], maxRetries: 2,
  });
  assert.equal(r.landed, false); assert.equal(r.reason, "retries-exhausted→human");
});

test("複核否決：verify-rejected→人審（不 land）", async () => {
  const r = await resolveConflict(wt, "feat-b", {
    resolver: () => [{ path: "f.txt", content: RESOLVED }], verifier: () => ({ preserved: false }),
  });
  assert.equal(r.landed, false); assert.equal(r.reason, "verify-rejected→human");
});

test("resolver 放棄（回 null）：resolver-gave-up→人審", async () => {
  const r = await resolveConflict(wt, "feat-b", { resolver: () => null, verifier: okVerifier });
  assert.equal(r.landed, false); assert.equal(r.reason, "resolver-gave-up→human");
});
