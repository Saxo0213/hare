// 每卡隔離 worktree（MA1）：git worktree 封裝——create/reuse/list/remove ＋ 非 git fallback。
// per-project 子目錄：.hare-worktrees/<project>/<card>。用暫存 git repo，key 帶 pid 避免撞。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureWorktree, removeWorktree, listWorktrees, isGitRepo, worktreePath, branchName, branchExists,
  closeoutWorktree, chatBranchPrefix, defaultBase } from "../lib/worktree.mjs";

let repo, nonGit;
const P = `p${process.pid}`;   // 測試專屬 project
const C = "cardA", C2 = "cardB", C3 = "cardC";
const g = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-wt-repo-"));
  nonGit = await mkdtemp(join(tmpdir(), "hare-wt-plain-"));
  g(["init", "-q", "-b", "main"], repo);
  g(["config", "user.email", "t@t"], repo);
  g(["config", "user.name", "t"], repo);
  g(["config", "commit.gpgsign", "false"], repo);
  await writeFile(join(repo, "a.txt"), "hello\n");
  g(["add", "-A"], repo);
  g(["commit", "-qm", "init"], repo);
});
after(async () => {
  for (const c of [C, C2, C3]) {
    try { await removeWorktree(repo, P, c, { force: true }); } catch { /* ignore */ }
    try { await rm(worktreePath(repo, P, c), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { await rm(resolve(repo, "..", ".hare-worktrees", `p${process.pid}`), { recursive: true, force: true }); } catch { /* ignore */ }
  await rm(repo, { recursive: true, force: true });
  await rm(nonGit, { recursive: true, force: true });
});

test("isGitRepo：git 目錄 true、非 git false", async () => {
  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(nonGit), false);
});

test("ensureWorktree：per-project 子目錄、含 checkout、掛 hare/chat/<project>/<card> 分支", async () => {
  const path = await ensureWorktree(repo, P, C);
  assert.equal(path, worktreePath(repo, P, C));
  assert.match(path.replace(/\\/g, "/"), new RegExp(`\\.hare-worktrees/${P}/${C}$`), "路徑含 <project>/<card>");
  await access(join(path, ".git"));
  await access(join(path, "a.txt"));
  const list = await listWorktrees(repo);
  assert.ok(list.some((w) => w.branch === branchName(P, C)), "列得到本卡分支");
  assert.equal(branchName(P, C), `hare/chat/${P}/${C}`);
  assert.equal(await branchExists(repo, branchName(P, C)), true);
});

test("ensureWorktree：同 (project,card) 重用", async () => {
  const p1 = await ensureWorktree(repo, P, C);
  const p2 = await ensureWorktree(repo, P, C);
  assert.equal(p1, p2);
  assert.equal((await listWorktrees(repo)).filter((w) => w.branch === branchName(P, C)).length, 1);
});

test("removeWorktree：移除後列表不再有", async () => {
  await ensureWorktree(repo, P, C);
  assert.equal(await removeWorktree(repo, P, C, { force: true }), true);
  assert.ok(!(await listWorktrees(repo)).some((w) => w.branch === branchName(P, C)));
});

test("非 git 目錄：ensureWorktree 回 null（fallback）", async () => {
  assert.equal(await ensureWorktree(nonGit, P, C), null);
  assert.equal(await ensureWorktree("", P, C), null);
});

test("隔離分支改動不影響主工作樹", async () => {
  const path = await ensureWorktree(repo, P, C2);
  await writeFile(join(path, "a.txt"), "changed-in-worktree\n");
  const mainContent = execFileSync("git", ["show", "HEAD:a.txt"], { cwd: repo }).toString();
  assert.match(mainContent, /hello/);
  await removeWorktree(repo, P, C2, { force: true });
});

test("defaultBase（通用化）：main repo→main；master-only repo→master；非 git＝保守退 main", async () => {
  assert.equal(await defaultBase(repo), "main");
  assert.equal(await defaultBase(nonGit), "main");
  const m = await mkdtemp(join(tmpdir(), "hare-master-"));
  try {
    const gm = (args) => execFileSync("git", args, { cwd: m, stdio: "pipe" });
    gm(["init", "-q", "-b", "master"]); gm(["config", "user.email", "t@t"]);
    gm(["config", "user.name", "t"]); gm(["config", "commit.gpgsign", "false"]);
    await writeFile(join(m, "x.txt"), "x\n");
    gm(["add", "-A"]); gm(["commit", "-qm", "i"]);
    assert.equal(await defaultBase(m), "master");
  } finally { await rm(m, { recursive: true, force: true }); }
});

test("closeoutWorktree（MA4）：有變更＝自動 commit 進卡片分支；乾淨＝null；main 不動", async () => {
  const path = await ensureWorktree(repo, P, C3);
  assert.equal(await closeoutWorktree(repo, P, C3, "測試收尾"), null, "乾淨 worktree 無事可收");
  await writeFile(join(path, "b.txt"), "work\n");
  const co = await closeoutWorktree(repo, P, C3, "測試收尾");
  assert.equal(co.ok, true);
  assert.ok(co.commit, "回 short hash");
  assert.equal(co.branch, branchName(P, C3));
  // 分支領先 main 1 個 commit；main HEAD 不動
  const ahead = execFileSync("git", ["rev-list", "--count", `main..${co.branch}`], { cwd: repo }).toString().trim();
  assert.equal(ahead, "1");
  const mainFiles = execFileSync("git", ["ls-tree", "--name-only", "main"], { cwd: repo }).toString();
  assert.ok(!mainFiles.includes("b.txt"), "main 歷史不含 worktree 收尾");
  assert.equal(await closeoutWorktree(repo, P, C3, "再收"), null, "收完即乾淨＝再呼叫 null");
  assert.equal(await closeoutWorktree(repo, P, "no-such-card", "x"), null, "無 worktree＝null");
  assert.equal(chatBranchPrefix(P), `hare/chat/${P}/`);
  await removeWorktree(repo, P, C3, { force: true });
});
