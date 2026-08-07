// 每卡隔離工作目錄——git worktree 薄封裝，零依賴（git 本就是環境依賴）。
// 通道多 agent 原本共用 refBase 會互踩；開隔離後各卡 agent 跑自己的 worktree branch。
// 設計鐵則：非 git／任何失敗一律回 null → 呼叫端 fallback 回 refBase，隔離絕不弄壞通道。
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdir, access } from "node:fs/promises";

// 跑 git（無 shell、收 stdout/stderr）；git 不在或崩＝code -1，不 throw。
// export：lib/audit.mjs 共用。
export function git(args, cwd) {
  return new Promise((res) => {
    let c;
    try { c = spawn("git", args, { cwd, windowsHide: true }); }
    catch (e) { return res({ code: -1, stdout: "", stderr: String(e && e.message || e) }); }
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => res({ code, stdout: out, stderr: err }));
    c.on("error", (e) => res({ code: -1, stdout: "", stderr: String(e && e.message || e) }));
  });
}

export async function isGitRepo(dir) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return r.code === 0 && r.stdout.trim() === "true";
}

// 分支是否存在（卡片有沒有提交過工作分支）。
export async function branchExists(repoRoot, branch) {
  if (!repoRoot || !branch) return false;
  return (await git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], repoRoot)).code === 0;
}

// 卡號/專案名可能含特殊字元 → 安全化為分支/目錄片段
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "x";

// worktree 放在 repo「外」，per-project 子目錄：<repoRoot>/../.hare-worktrees/<project>/<card>
// （避免巢狀 checkout 汙染主工作樹；多專案徹底分開，清理只要刪 <project>/）。
const projectRoot = (repoRoot, project) => resolve(repoRoot, "..", ".hare-worktrees", safe(project));
export function worktreePath(repoRoot, project, card) { return resolve(projectRoot(repoRoot, project), safe(card)); }
export function branchName(project, card) { return `hare/chat/${safe(project)}/${safe(card)}`; }
export function chatBranchPrefix(project) { return `hare/chat/${safe(project)}/`; } // 掃待整合分支用

// 整合基準分支＝偵測不假設（非 main 預設分支的專案也要能自動合）：
// origin/HEAD（clone 專案的權威答案）→ 本地 main/master 存在者 → 當前分支 → 最後退 "main"。
// runGit 可注入（單元測試假 git）。
// HARE ma5ba5ed defaultBase
export async function defaultBase(repoRoot, runGit = git) {
  const o = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (o.code === 0) { const b = o.stdout.trim().replace(/^origin\//, ""); if (b) return b; }
  for (const b of ["main", "master"]) {
    if ((await runGit(["rev-parse", "--verify", "--quiet", b], repoRoot)).code === 0) return b;
  }
  const h = await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot);
  return h.code === 0 && h.stdout.trim() ? h.stdout.trim() : "main";
}

// turn 結束把 worktree 未 commit 的工作自動收進卡片分支。
// 隔離分支不進 main 歷史；收尾 commit 是整合佇列的交棒前提。無 worktree／非 git／無變更＝null；失敗回 {ok:false}，絕不 throw
// （收尾失敗不得弄壞通道 turn 收束）。
// HARE ma4c1o5e closeoutWorktree
export async function closeoutWorktree(repoRoot, project, card, message) {
  const path = worktreePath(repoRoot, project, card);
  try { await access(join(path, ".git")); } catch { return null; }
  if (!(await isGitRepo(path))) return null;
  const st = await git(["status", "--porcelain"], path);
  if (st.code !== 0 || !st.stdout.trim()) return null; // 乾淨＝無事可收
  const add = await git(["add", "-A"], path);
  if (add.code !== 0) return { ok: false, error: add.stderr.slice(0, 300) };
  const cm = await git(["commit", "-m", message || `通道自動收尾（${card}）`], path);
  if (cm.code !== 0) return { ok: false, error: cm.stderr.slice(0, 300) };
  const rev = await git(["rev-parse", "--short", "HEAD"], path);
  return { ok: true, commit: rev.stdout.trim(), branch: branchName(project, card) };
}

// 確保某專案某卡的 worktree 存在並回路徑；已存在＝重用（同分支續接）。非 git／失敗＝null（fallback）。
export async function ensureWorktree(repoRoot, project, card) {
  if (!repoRoot || !(await isGitRepo(repoRoot))) return null;
  const path = worktreePath(repoRoot, project, card);
  try { await access(join(path, ".git")); return path; } catch { /* 不存在，往下建 */ }
  const branch = branchName(project, card);
  try { await mkdir(projectRoot(repoRoot, project), { recursive: true }); } catch { /* 已存在 */ }
  // 分支已存在＝掛上（沿用先前進度）；否則從當前 HEAD 新建
  const exists = (await git(["rev-parse", "--verify", "--quiet", branch], repoRoot)).code === 0;
  const args = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];
  const r = await git(args, repoRoot);
  return r.code === 0 ? path : null;
}

// 移除某專案某卡的 worktree（完工/封存清理）。force＝連未提交變更一起清。回是否成功。
export async function removeWorktree(repoRoot, project, card, { force = false } = {}) {
  if (!repoRoot || !(await isGitRepo(repoRoot))) return false;
  const path = worktreePath(repoRoot, project, card);
  const r = await git(["worktree", "remove", ...(force ? ["--force"] : []), path], repoRoot);
  return r.code === 0;
}

// 列本 repo 的 worktrees（觀測用）；只回 HARE chat 建立者（分支 hare/chat/*）。
export async function listWorktrees(repoRoot) {
  if (!repoRoot || !(await isGitRepo(repoRoot))) return [];
  const r = await git(["worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9).trim(), branch: null }; out.push(cur); }
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
  }
  return out.filter((w) => (w.branch || "").startsWith("hare/chat/"));
}
