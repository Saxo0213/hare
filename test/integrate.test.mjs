// 整合分析（MA2）：merge-tree 衝突偵測＋diff 摘要——read-only，不動工作樹。
// 造三分支：feat-a／feat-b 改同一行（衝突）、feat-c 改別檔（乾淨）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeMergeConflicts, diffSummary, changedFiles, previewIntegration } from "../lib/integrate.mjs";

let repo;
const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
const put = (name, content) => writeFile(join(repo, name), content);

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-integ-"));
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  await put("f.txt", "l1\nl2\nl3\n"); await put("other.txt", "x\n");
  g(["add", "-A"]); g(["commit", "-qm", "base"]);
  // feat-a：改 f.txt 第 2 行
  g(["checkout", "-q", "-b", "feat-a"]); await put("f.txt", "l1\nl2A\nl3\n"); g(["commit", "-qam", "a"]);
  // feat-b：改 f.txt 同一行（與 a 衝突）
  g(["checkout", "-q", "main"]); g(["checkout", "-q", "-b", "feat-b"]); await put("f.txt", "l1\nl2B\nl3\n"); g(["commit", "-qam", "b"]);
  // feat-c：只改 other.txt（與 a 不衝突）
  g(["checkout", "-q", "main"]); g(["checkout", "-q", "-b", "feat-c"]); await put("other.txt", "y\n"); g(["commit", "-qam", "c"]);
  g(["checkout", "-q", "main"]);
});
after(async () => { await rm(repo, { recursive: true, force: true }); });

test("analyzeMergeConflicts：同行改動＝衝突、列出衝突檔", async () => {
  const r = await analyzeMergeConflicts(repo, "feat-a", "feat-b");
  assert.equal(r.ok, true);
  assert.equal(r.clean, false);
  assert.deepEqual(r.conflictFiles, ["f.txt"]);
});

test("analyzeMergeConflicts：改不同檔＝乾淨", async () => {
  const r = await analyzeMergeConflicts(repo, "feat-a", "feat-c");
  assert.equal(r.ok, true);
  assert.equal(r.clean, true);
  assert.deepEqual(r.conflictFiles, []);
});

test("diffSummary / changedFiles：branch 相對 base 的改動", async () => {
  const s = await diffSummary(repo, "main", "feat-a");
  assert.equal(s.ok, true);
  assert.equal(s.files, 1);
  assert.ok(s.insertions >= 1 && s.deletions >= 1);
  assert.deepEqual(await changedFiles(repo, "main", "feat-a"), ["f.txt"]);
});

test("previewIntegration：一次回乾淨旗標＋衝突檔＋摘要＋改動檔", async () => {
  const clean = await previewIntegration(repo, "feat-a", "feat-c");
  assert.equal(clean.analyzable, true);
  assert.equal(clean.clean, true);
  const conflict = await previewIntegration(repo, "feat-a", "feat-b");
  assert.equal(conflict.clean, false);
  assert.deepEqual(conflict.conflictFiles, ["f.txt"]);
});

test("非 git／壞 ref：analyzable 為 false，不炸", async () => {
  const bad = await analyzeMergeConflicts(repo, "no-such-branch", "feat-a");
  assert.equal(bad.ok, false);
});
