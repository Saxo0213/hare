// 整合分析——read-only：判斷 branch 合併進 base 會不會衝突、改了什麼。
// 全程不動工作樹：衝突用 `git merge-tree --write-tree`（in-memory，git≥2.38），摘要用 `git diff`。
// 供 Layer 1（乾淨＝自動候選）、Layer 3（衝突/改動呈現給人審）、#1 衝突率量測。零依賴。
import { spawn } from "node:child_process";

// 跑 git（無 shell、收 stdout/stderr）；git 不在或崩＝code -1，不 throw。
function git(args, cwd) {
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

// base 與 branch 合併會不會衝突（in-memory，不動任何檔）。
// 回 { ok, clean, conflictFiles[] }。git 太舊/失敗＝ok:false（呼叫端退回 worktree dry-merge 或直接人審）。
export async function analyzeMergeConflicts(repoRoot, base, branch) {
  // 先驗兩端 ref 都解析得到（壞 ref＝無法分析，不與「衝突」exit 1 混淆）
  for (const ref of [base, branch]) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot)).code !== 0) {
      return { ok: false, clean: false, conflictFiles: [], error: `bad ref: ${ref}` };
    }
  }
  // exit 0＝乾淨、1＝衝突（可靠）。輸出：第 1 行＝tree oid；衝突時接「衝突檔資訊段」
  // 每行 `<mode> <oid> <stage>\t<path>`（stage 1/2/3），空行結束段、之後是訊息。
  // quotePath=false＝含特殊字元路徑不被引號化。conflictFiles＝best-effort（內容衝突取得準）。
  const r = await git(["-c", "core.quotePath=false", "merge-tree", "--write-tree", base, branch], repoRoot);
  if (r.code !== 0 && r.code !== 1) return { ok: false, clean: false, conflictFiles: [], error: (r.stderr || "").trim() };
  const clean = r.code === 0;
  const conflictFiles = [];
  if (!clean) {
    const lines = r.stdout.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "") break; // 衝突檔資訊段結束
      const tab = lines[i].indexOf("\t");
      if (tab >= 0) { const p = lines[i].slice(tab + 1); if (!conflictFiles.includes(p)) conflictFiles.push(p); }
    }
  }
  return { ok: true, clean, conflictFiles };
}

// branch 相對 base（三點＝自 merge-base 起 branch 的改動）的摘要：files/insertions/deletions。
export async function diffSummary(repoRoot, base, branch) {
  const r = await git(["diff", "--shortstat", `${base}...${branch}`], repoRoot);
  if (r.code !== 0) return { ok: false, files: 0, insertions: 0, deletions: 0 };
  const s = r.stdout;
  const n = (re) => Number((s.match(re) || [])[1] || 0);
  return { ok: true, files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
}

// branch 相對 base 改動的檔案清單（人審呈現用）。
export async function changedFiles(repoRoot, base, branch) {
  const r = await git(["diff", "--name-only", "-z", `${base}...${branch}`], repoRoot);
  if (r.code !== 0) return [];
  return r.stdout.split("\0").filter(Boolean);
}

// 整合預判：一次回「乾淨嗎＋衝突檔＋改動摘要＋改動檔」——Layer 1/3 的判定與呈現資料。
export async function previewIntegration(repoRoot, base, branch) {
  const [conf, sum, files] = await Promise.all([
    analyzeMergeConflicts(repoRoot, base, branch),
    diffSummary(repoRoot, base, branch),
    changedFiles(repoRoot, base, branch),
  ]);
  return { base, branch, clean: conf.ok ? conf.clean : null, analyzable: conf.ok,
    conflictFiles: conf.conflictFiles, ...sum, changedFiles: files };
}
