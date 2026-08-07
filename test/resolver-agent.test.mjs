// MA3 真 resolver agent：buildResolvePrompt（純）＋makeResolverAgent 全流程（假 executor 代 claude）。
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResolvePrompt, makeResolverAgent } from "../lib/resolver-agent.mjs";
import { resolveConflict } from "../lib/resolve.mjs";

test("buildResolvePrompt：含雙方意圖、衝突檔內容、除標記指示", () => {
  const p = buildResolvePrompt({
    files: [{ path: "f.txt", content: "<<<<<<< HEAD\nA\n=======\nB\n>>>>>>>" }],
    cardIntent: "本卡要做 X", otherIntent: "對方要做 Y", attempt: 2,
  });
  assert.match(p, /本卡要做 X/);
  assert.match(p, /對方要做 Y/);
  assert.match(p, /f\.txt/);
  assert.match(p, /衝突標記/);
  assert.match(p, /第 2 次/);
});

let repo, wt, GOOD, NOOP;
const g = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
const put = (name, content, cwd = repo) => writeFile(join(cwd, name), content);

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "hare-ra-"));
  wt = await mkdtemp(join(tmpdir(), "hare-ra-wt-")); await rm(wt, { recursive: true, force: true });
  const scripts = await mkdtemp(join(tmpdir(), "hare-ra-fake-"));
  GOOD = join(scripts, "good.js"); NOOP = join(scripts, "noop.js");
  // 假 agent：就地把 f.txt 解成無標記版本（模擬真 agent 解衝突）
  await writeFile(GOOD, "require('fs').writeFileSync('f.txt','l1\\nl2-agent-resolved\\nl3\\n')\n");
  await writeFile(NOOP, "process.exit(0)\n"); // 啥也不做＝標記殘留

  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
  await put("f.txt", "l1\nl2\nl3\n"); g(["add", "-A"]); g(["commit", "-qm", "base"]);
  g(["checkout", "-q", "-b", "feat-a"]); await put("f.txt", "l1\nl2A\nl3\n"); g(["commit", "-qam", "a"]);
  g(["checkout", "-q", "main"]); g(["checkout", "-q", "-b", "feat-b"]); await put("f.txt", "l1\nl2B\nl3\n"); g(["commit", "-qam", "b"]);
  g(["checkout", "-q", "main"]);
  g(["worktree", "add", "-q", "-b", "intb", wt, "feat-a"]);
});
beforeEach(() => { try { g(["merge", "--abort"], wt); } catch { /* none */ } g(["reset", "-q", "--hard", "feat-a"], wt); g(["clean", "-qfd"], wt); });
after(async () => {
  try { g(["worktree", "remove", "--force", wt]); } catch { /* ignore */ }
  await rm(repo, { recursive: true, force: true }); await rm(wt, { recursive: true, force: true });
});

test("makeResolverAgent＋resolveConflict：假 agent 就地解→讀回→land", async () => {
  const resolver = makeResolverAgent({ execCommand: [process.execPath, GOOD] });
  const r = await resolveConflict(wt, "feat-b", { resolver, verifier: () => ({ preserved: true }), cardIntent: "改 f 第2行" });
  assert.equal(r.landed, true, "假 agent 解完後 land");
  assert.equal(await readFile(join(wt, "f.txt"), "utf8"), "l1\nl2-agent-resolved\nl3\n");
});

test("makeResolverAgent：agent 沒解乾淨（標記殘留）→重試耗盡→人審", async () => {
  const resolver = makeResolverAgent({ execCommand: [process.execPath, NOOP] });
  const r = await resolveConflict(wt, "feat-b", { resolver, verifier: () => ({ preserved: true }), maxRetries: 2 });
  assert.equal(r.landed, false);
  assert.equal(r.reason, "retries-exhausted→human");
});

test("makeResolverAgent：execCommand 缺 → resolver 回 null（gave-up）", async () => {
  const resolver = makeResolverAgent({});
  const r = await resolveConflict(wt, "feat-b", { resolver });
  assert.equal(r.reason, "resolver-gave-up→human");
});
