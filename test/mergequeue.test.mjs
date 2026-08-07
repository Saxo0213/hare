// 整合佇列＋合併後閘門（MA2 執行層）：乾淨 land／衝突退回／閘門紅回退／高風險不自動／續 land。
// 全在專屬整合 worktree 上操作，不碰 main。gate＝node gate.js（bad.txt 存在即 exit 1）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processQueue, runGate, integrationPath, startIntegration } from "../lib/mergequeue.mjs";

let repo;
const P = `mq${process.pid}`; // 測試專屬 project
const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
const put = (name, content) => writeFile(join(repo, name), content);
const GATE = ["node", "gate.js"]; // integration worktree 內有 bad.txt 就 exit 1

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-mq-"));
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  await put("f.txt", "l1\nl2\nl3\n"); await put("other.txt", "x\n");
  await put("gate.js", "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)\n");
  g(["add", "-A"]); g(["commit", "-qm", "base"]);
  const branch = async (name, mut) => { g(["checkout", "-q", "main"]); g(["checkout", "-q", "-b", name]); await mut(); g(["add", "-A"]); g(["commit", "-qam", name]); };
  await branch("feat-a", () => put("f.txt", "l1\nl2A\nl3\n"));          // 乾淨
  await branch("feat-b", () => put("f.txt", "l1\nl2B\nl3\n"));          // 與 feat-a 衝突（同行）
  await branch("feat-bad", () => put("bad.txt", "boom\n"));             // 乾淨合但 gate 紅
  await branch("feat-clean2", () => put("cleanfile.txt", "c\n"));      // 乾淨
  await branch("feat-risk", () => put("riskfile.txt", "r\n"));         // 高風險→不自動
  g(["checkout", "-q", "main"]);
});
after(async () => {
  try { g(["worktree", "remove", "--force", integrationPath(repo, P)]); } catch { /* ignore */ }
  await rm(integrationPath(repo, P), { recursive: true, force: true }).catch(() => {});
  await rm(repo, { recursive: true, force: true });
});

test("runGate：無指令＝跳過視為通過；退出碼決定 pass", async () => {
  assert.equal((await runGate(repo, null)).skipped, true);
  assert.equal((await runGate(repo, ["node", "-e", "process.exit(0)"])).pass, true);
  assert.equal((await runGate(repo, ["node", "-e", "process.exit(3)"])).pass, false);
});

test("startIntegration：建整合 worktree 自 base", async () => {
  const s = await startIntegration(repo, { project: P, base: "main" });
  assert.equal(s.ok, true);
  assert.equal(s.integrationBranch, `hare/integration/${P}`);
});

test("processQueue：五情境各走對路", async () => {
  const r = await processQueue(repo, [
    { card: "a", branch: "feat-a" },
    { card: "b", branch: "feat-b" },
    { card: "bad", branch: "feat-bad" },
    { card: "c2", branch: "feat-clean2" },
    { card: "risk", branch: "feat-risk", riskTier: "high" },
  ], { project: P, base: "main", gateCommand: GATE });
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.results.map((x) => [x.card, x]));

  assert.equal(by.a.landed, true, "乾淨＋閘門綠→land");
  assert.equal(by.a.reason, "landed");

  assert.equal(by.b.landed, false, "與已 land 的 feat-a 同行衝突");
  assert.equal(by.b.reason, "conflict→human");
  assert.ok(by.b.conflictFiles.includes("f.txt"));

  assert.equal(by.bad.landed, false, "乾淨合但 gate 紅→回退");
  assert.equal(by.bad.reason, "gate-fail→human");
  assert.equal(by.bad.gate.pass, false);

  assert.equal(by.c2.landed, true, "gate-fail 已回退，續 land 乾淨支");
  assert.equal(by.risk.landed, false, "高風險不自動 land");
  assert.equal(by.risk.reason, "high-risk→human");
  assert.ok(by.risk.preview, "高風險附呈現資料給人審");
});

test("Layer 2：給 resolver＋verifier → 衝突支自動解並 land（auto-resolved）", async () => {
  const r = await processQueue(repo, [
    { card: "a", branch: "feat-a" },
    { card: "b", branch: "feat-b", intent: "改 f.txt 第 2 行" },
  ], {
    project: P, base: "main", gateCommand: GATE,
    resolver: () => [{ path: "f.txt", content: "l1\nl2AB\nl3\n" }], // mock：合兩邊
    verifier: () => ({ preserved: true }),
  });
  const by = Object.fromEntries(r.results.map((x) => [x.card, x]));
  assert.equal(by.a.landed, true);
  assert.equal(by.b.landed, true, "衝突支被 agent 自動解並 land");
  assert.equal(by.b.reason, "auto-resolved");
});

test("整合分支結果：只含 landed 的（feat-a＋feat-clean2），不含衝突/紅/高風險", async () => {
  await processQueue(repo, [
    { card: "a", branch: "feat-a" }, { card: "bad", branch: "feat-bad" },
    { card: "c2", branch: "feat-clean2" }, { card: "risk", branch: "feat-risk", riskTier: "high" },
  ], { project: P, base: "main", gateCommand: GATE });
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", `hare/integration/${P}`], { cwd: repo }).toString();
  assert.match(files, /cleanfile\.txt/, "feat-clean2 已進");
  assert.doesNotMatch(files, /bad\.txt/, "gate 紅的 feat-bad 未進");
  assert.doesNotMatch(files, /riskfile\.txt/, "高風險 feat-risk 未進");
});
