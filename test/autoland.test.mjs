// MA5 無同步修改自動合併（autoLand）：乾淨＝自動合入 main（merge commit 可 revert）；
// 同檔並行＝退回；main 工作樹同檔未提交＝退回。真暫存 repo，絕不碰正式 repo。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { autoLand, integrationPath } from "../lib/mergequeue.mjs";
import { ensureWorktree, closeoutWorktree, removeWorktree, worktreePath } from "../lib/worktree.mjs";

let repo;
const P = `al${process.pid}`;
const CARDS = ["cardA", "cardB", "cardC", "cardD", "cardE", "cardF"];
const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-al-"));
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repo, "f.txt"), "base\n");
  g(["add", "-A"]); g(["commit", "-qm", "base"]);
});
after(async () => {
  for (const c of CARDS) {
    try { await removeWorktree(repo, P, c, { force: true }); } catch { /* ignore */ }
    await rm(worktreePath(repo, P, c), { recursive: true, force: true }).catch(() => {});
  }
  await rm(integrationPath(repo, P), { recursive: true, force: true }).catch(() => {});
  await rm(resolve(repo, "..", ".hare-worktrees", P), { recursive: true, force: true }).catch(() => {});
  await rm(repo, { recursive: true, force: true });
});

test("autoLand：無同步修改＝自動合入 main（merge commit、可 revert、主樹拿到檔案、分支歸位）", async () => {
  const wt = await ensureWorktree(repo, P, "cardA");
  await writeFile(join(wt, "a1.txt"), "workA\n");
  const co = await closeoutWorktree(repo, P, "cardA", "A 收尾");
  assert.equal(co.ok, true);
  const r = await autoLand(repo, { project: P, card: "cardA", gateCommand: [] });
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.deepEqual(r.files, ["a1.txt"]);
  // main HEAD＝merge commit（雙親＝可 git revert -m 1 整卡復原）
  const parents = g(["rev-list", "--parents", "-1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 3, "merge commit 有兩個 parent");
  // 主工作樹真的拿到檔案（做完＝看得到）
  assert.equal((await readFile(join(repo, "a1.txt"), "utf8")).trim(), "workA");
  // land 後分支歸位＝快轉到 main 尖（下輪從新底開工，不再累積分岔）
  assert.equal(g(["rev-parse", `hare/chat/${P}/cardA`]).trim(), g(["rev-parse", "main"]).trim());
});

test("autoLand 分岔回同步：main 前進（不同檔）＝分支自動跟上照 land；同檔演進衝突＝diverged-conflict 退回", async () => {
  // 乾淨分岔：main 動 base-only.txt，cardE 動自己的 e.txt → pre-sync 合入 main 後照 land
  await writeFile(join(repo, "base-only.txt"), "main 前進\n");
  g(["add", "-A"]); g(["commit", "-qm", "main 前進（不同檔）"]);
  const we = await ensureWorktree(repo, P, "cardE");
  await writeFile(join(we, "e.txt"), "workE\n");
  assert.equal((await closeoutWorktree(repo, P, "cardE", "E 收尾")).ok, true);
  const re = await autoLand(repo, { project: P, card: "cardE", gateCommand: [] });
  assert.equal(re.landed, true, JSON.stringify(re));
  // 同檔演進衝突：main 與 cardF 各自改 f-shared.txt 同一行 → diverged-conflict、main 不動
  await writeFile(join(repo, "f-shared.txt"), "主線版\n");
  g(["add", "-A"]); g(["commit", "-qm", "主線改 f-shared"]);
  const wf = await ensureWorktree(repo, P, "cardF"); // 從當前 main 建分支
  await writeFile(join(repo, "f-shared.txt"), "主線又改\n"); // main 再前進＝分岔
  g(["add", "-A"]); g(["commit", "-qm", "主線再改 f-shared"]);
  await writeFile(join(wf, "f-shared.txt"), "卡片版\n"); // 分支改同檔同行
  assert.equal((await closeoutWorktree(repo, P, "cardF", "F 收尾")).ok, true);
  const pre = g(["rev-parse", "HEAD"]).trim();
  const rf = await autoLand(repo, { project: P, card: "cardF", gateCommand: [] });
  assert.equal(rf.landed, false);
  assert.equal(rf.reason, "diverged-conflict");
  assert.deepEqual(rf.files, ["f-shared.txt"]);
  assert.equal(g(["rev-parse", "HEAD"]).trim(), pre, "main 一步未動");
});

test("autoLand：兩卡同檔＝concurrent-edit 退回、main 不動", async () => {
  const wb = await ensureWorktree(repo, P, "cardB");
  const wc = await ensureWorktree(repo, P, "cardC");
  await writeFile(join(wb, "shared.txt"), "B 版\n");
  await writeFile(join(wc, "shared.txt"), "C 版\n");
  assert.equal((await closeoutWorktree(repo, P, "cardB", "B 收尾")).ok, true);
  assert.equal((await closeoutWorktree(repo, P, "cardC", "C 收尾")).ok, true);
  const pre = g(["rev-parse", "HEAD"]).trim();
  const r = await autoLand(repo, { project: P, card: "cardB", gateCommand: [] });
  assert.equal(r.landed, false);
  assert.equal(r.reason, "concurrent-edit");
  assert.equal(r.overlaps[0].card, "cardC");
  assert.deepEqual(r.overlaps[0].files, ["shared.txt"]);
  assert.equal(g(["rev-parse", "HEAD"]).trim(), pre, "main 一步未動");
});

test("autoLand：main 工作樹同檔未提交＝main-dirty-overlap 退回；無分支卡＝no-branch", async () => {
  const wd = await ensureWorktree(repo, P, "cardD");
  await writeFile(join(wd, "f.txt"), "D 改\n");
  assert.equal((await closeoutWorktree(repo, P, "cardD", "D 收尾")).ok, true);
  await writeFile(join(repo, "f.txt"), "手上未提交\n"); // main 工作樹弄髒同一檔
  const r = await autoLand(repo, { project: P, card: "cardD", gateCommand: [] });
  assert.equal(r.landed, false);
  assert.equal(r.reason, "main-dirty-overlap");
  assert.deepEqual(r.files, ["f.txt"]);
  g(["checkout", "--", "f.txt"]); // 還原
  assert.equal((await autoLand(repo, { project: P, card: "ghost", gateCommand: [] })).reason, "no-branch");
});
