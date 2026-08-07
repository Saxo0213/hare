// 整合佇列＋合併後閘門——真的 git merge／跑指令，但**一律在專屬「整合 worktree」上**，
// 絕不碰 main 工作樹。三層策略的機械部分：乾淨＋低風險＋閘門綠→land；衝突/高風險/紅→needsReview。
// 零依賴。與 read-only 的 integrate.mjs 分工：這裡會 mutate（在隔離 worktree 內）。
import { spawn } from "node:child_process";
import { access, symlink, rm, rmdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { previewIntegration } from "./integrate.mjs";
import { isGitRepo, worktreePath, branchName, branchExists, chatBranchPrefix, defaultBase } from "./worktree.mjs";

// 目標專案的 npm scripts＝資料列（通用化：閘門/建置指令讀專案自己的宣告，不寫死任何棧）。
// 無 package.json／壞 JSON＝空物件（呼叫端自行決定跳過）。
export async function projectScripts(repoRoot) {
  try { return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).scripts || {}; }
  catch { return {}; }
}
import { runGate } from "./gate.mjs";
import { resolveConflict } from "./resolve.mjs"; // Layer 2（衝突時 agent 自動解，注入 resolver）
export { runGate }; // re-export：既有呼叫端/測試相容

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

// 整合 worktree 路徑（per-project：.hare-worktrees/<project>/__integration__）。
export function integrationPath(repoRoot, project) { return worktreePath(repoRoot, project, "__integration__"); }

// 準備一個全新的整合 worktree：branch 自 base 重置、checkout 到專屬路徑（每次佇列從乾淨 base 起）。
// 整合分支 per-project（hare/integration/<project>），避免多板共用一 repo 時互撞。
export async function startIntegration(repoRoot, { project = "default", base = "main", integrationBranch } = {}) {
  if (!repoRoot || !(await isGitRepo(repoRoot))) return { ok: false, error: "not a git repo" };
  const ib = integrationBranch || `hare/integration/${project}`;
  const path = integrationPath(repoRoot, project);
  // 舊樹先清。node_modules 連結（下方 junction）會讓 git worktree remove 卻步——
  // 先拆連結：rmdir 對 junction＝只刪連結點不動主樹目標；真目錄非空＝ENOTEMPTY 退 rm 遞迴。
  const nm = join(path, "node_modules");
  try { await rmdir(nm); } catch (e) {
    if (e && e.code === "ENOTEMPTY") await rm(nm, { recursive: true, force: true }).catch(() => {});
  }
  await git(["worktree", "remove", "--force", path], repoRoot); // 不在也無妨
  await git(["worktree", "prune"], repoRoot);
  let r = await git(["worktree", "add", "-B", ib, path, base], repoRoot);
  if (r.code !== 0 && /already exists/i.test(r.stderr || "")) {
    // 殘留目錄（git 清不掉的狀況）：fs 強刪（連結已拆，遞迴刪不會波及主樹）＋prune 後重試一次
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(["worktree", "prune"], repoRoot);
    r = await git(["worktree", "add", "-B", ib, path, base], repoRoot);
  }
  if (r.code !== 0) return { ok: false, error: (r.stderr || "").trim() };
  // 全新 checkout 無 node_modules，閘門（npm test 等）跑不動——從主樹「連結」一份
  // （junction/symlink，非複製；node_modules 在 .gitignore，不影響 merge）。
  // lib/layout.mjs import @dagrejs/dagre＝runtime 依賴，缺了它 25 個測試檔全紅。
  // 連結失敗不擋流程——閘門會如實紅，人審看得到原因。
  try {
    const src = join(repoRoot, "node_modules");
    await access(src);
    await access(join(path, "node_modules")).catch(() => symlink(src, join(path, "node_modules"), "junction"));
  } catch { /* 主樹也沒 node_modules＝維持現狀 */ }
  return { ok: true, path, integrationBranch: ib };
}

// 把 cardBranch 合進整合 worktree、跑閘門。衝突→abort；閘門紅→reset 回合併前。
// 回 { branch, landed, clean, conflictFiles, gate }。
export async function landOne(wtPath, cardBranch, gateCommand) {
  const pre = (await git(["rev-parse", "HEAD"], wtPath)).stdout.trim();
  const m = await git(["merge", "--no-ff", "--no-edit", cardBranch], wtPath);
  if (m.code !== 0) {
    const uf = (await git(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"], wtPath))
      .stdout.split("\n").filter(Boolean);
    await git(["merge", "--abort"], wtPath);
    return { branch: cardBranch, landed: false, clean: false, conflictFiles: uf };
  }
  const gate = await runGate(wtPath, gateCommand);
  if (!gate.pass) {
    await git(["reset", "--hard", pre], wtPath); // 閘門紅→退回合併前（不 land）
    return { branch: cardBranch, landed: false, clean: true, gate };
  }
  return { branch: cardBranch, landed: true, clean: true, gate };
}

// 整合佇列：items 已由呼叫端按 DAG 排好，逐支序列處理。
// 每支：乾淨＋低風險＋閘門綠→land；衝突/高風險/紅→needsReview（附呈現資料給 Layer 3）。
// items: [{ card?, branch, riskTier? }]；autoRiskTiers＝可自動 land 的風險級（預設只有 low）。
// 回 { ok, integrationBranch, path, results[] }；每筆 result 帶 reason 與（needsReview 時）preview。
// resolver/verifier 給了＝開 Layer 2（衝突時 agent 帶意圖自動解）；否則衝突直接進 Layer 3 人審。
export async function processQueue(repoRoot, items, {
  project = "default", base = "main", integrationBranch, gateCommand = null, autoRiskTiers = ["low"],
  resolver = null, verifier = null, maxRetries = 2, verifyVotes = 1,
} = {}) {
  const start = await startIntegration(repoRoot, { project, base, integrationBranch });
  if (!start.ok) return { ok: false, error: start.error, results: [] };
  integrationBranch = start.integrationBranch;
  const results = [];
  const review = async (base2) => previewIntegration(repoRoot, integrationBranch, base2); // 人審呈現資料
  for (const it of (items || [])) {
    const branch = it.branch;
    const risk = it.riskTier || "low";
    // 高風險：即使可乾淨合，也不自動 land（儲存/授權/並行/刪除，錯的代價太高）
    if (!autoRiskTiers.includes(risk)) {
      results.push({ card: it.card, branch, landed: false, reason: "high-risk→human", riskTier: risk, preview: await review(branch) });
      continue;
    }
    const r = await landOne(start.path, branch, gateCommand); // Layer 1
    if (r.landed) { results.push({ card: it.card, ...r, reason: "landed" }); continue; }
    // Layer 2：衝突且有 resolver → agent 帶意圖自動解（landOne 已 abort，resolveConflict 會重合）
    if (r.clean === false && resolver) {
      const rc = await resolveConflict(start.path, branch, {
        cardIntent: it.intent, otherIntent: it.otherIntent, resolver, verifier, gateCommand, maxRetries, verifyVotes });
      if (rc.landed) { results.push({ card: it.card, branch, landed: true, reason: "auto-resolved", attempts: rc.attempts }); continue; }
      results.push({ card: it.card, branch, landed: false, reason: rc.reason || "conflict→human", preview: await review(branch) });
      continue;
    }
    // Layer 3：無 resolver（或閘門紅）→ 人審
    const reason = r.clean === false ? "conflict→human" : "gate-fail→human";
    results.push({ card: it.card, ...r, reason, preview: await review(branch) });
  }
  return { ok: true, integrationBranch, path: start.path, results };
}

// ---- 無同步修改自動合併：三重前檢全空＋單卡佇列 land（乾淨合併＋閘門綠）→
// main 以 --ff-only 快轉到整合分支＝main 得到一個 merge commit（`git revert -m 1` 整卡可復原）。
// 前檢（任一命中＝不動 main、回 reason 退佇列人審）：
//   ① 他卡分支（同專案、領先 base 或其 worktree 有未提交）改到同檔＝同步修改
//   ② main 工作樹未提交（含未追蹤）同檔＝會蓋到手上的工作
// 絕不 throw；main 工作樹只被 ff 更新「本卡改的檔」，其餘未提交內容原樣不動。
// HARE ma5a10nd autoLand
export async function autoLand(repoRoot, { project = "default", card, base,
  gateCommand, intent = "" } = {}) {
  if (!repoRoot || !(await isGitRepo(repoRoot))) return { landed: false, reason: "not-git" };
  const branch = branchName(project, card);
  if (!(await branchExists(repoRoot, branch))) return { landed: false, reason: "no-branch" };
  // 通用化：base 與閘門都偵測不假設——base＝專案預設分支；
  // 閘門＝專案自己宣告 scripts.test 才跑 npm test，沒宣告＝乾淨合併即 land（誠實記 skipped）。
  if (!base) base = await defaultBase(repoRoot);
  if (gateCommand === undefined) {
    gateCommand = (await projectScripts(repoRoot)).test ? ["npm", "test"] : null;
  }
  // 分支回同步 base：land 後分支若停在老底，
  // main 前進後 agent 再改同檔＝必衝突）。base 有新 commit → 先把 base 合回卡片 worktree：
  // 乾淨＝分支跟上、續走；衝突＝abort 退人審（diverged-conflict，附衝突檔）。
  const wtPath = worktreePath(repoRoot, project, card);
  const baseTip = (await git(["rev-parse", base], repoRoot)).stdout.trim();
  const mb = (await git(["merge-base", base, branch], repoRoot)).stdout.trim();
  if (baseTip && mb && mb !== baseTip) {
    const hasWt = (await git(["rev-parse", "--is-inside-work-tree"], wtPath)).code === 0;
    if (hasWt) {
      const m = await git(["merge", "--no-edit", base], wtPath);
      if (m.code !== 0) {
        const uf = (await git(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"], wtPath))
          .stdout.split("\n").filter(Boolean);
        await git(["merge", "--abort"], wtPath);
        return { landed: false, reason: "diverged-conflict", files: uf };
      }
    } // 無 worktree＝跳過（整合佇列合併時自然裁定）
  }
  // porcelain 行 → repo 相對路徑（XY␣path；rename「old -> new」取 new；引號剝除）
  const porcelainFiles = (out) => out.split(/\r?\n/)
    .map((l) => l.slice(3).trim()).filter(Boolean)
    .map((p) => (p.includes(" -> ") ? p.split(" -> ").pop() : p))
    .map((p) => p.replace(/^"|"$/g, "").replace(/\\/g, "/"));
  const filesOf = async (br) => new Set((await git(["diff", "--name-only", `${base}...${br}`], repoRoot))
    .stdout.split(/\r?\n/).map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean));
  const mine = await filesOf(branch);
  if (!mine.size) return { landed: false, reason: "no-changes" };
  // ① 同步修改：他卡分支已提交檔 ∪ 他卡 worktree 未提交檔
  const pfx = chatBranchPrefix(project);
  const ls = await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${pfx}*`], repoRoot);
  const overlaps = [];
  for (const ob of (ls.code === 0 ? ls.stdout : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (ob === branch || ob.slice(pfx.length) === "__integration__") continue;
    const ahead = Number((await git(["rev-list", "--count", `${base}..${ob}`], repoRoot)).stdout.trim()) || 0;
    const st = await git(["status", "--porcelain"], worktreePath(repoRoot, project, ob.slice(pfx.length)));
    const theirs = new Set([...(ahead ? await filesOf(ob) : []),
      ...(st.code === 0 ? porcelainFiles(st.stdout) : [])]); // worktree 不存在＝git 失敗＝空集
    const hit = [...mine].filter((f) => theirs.has(f));
    if (hit.length) overlaps.push({ card: ob.slice(pfx.length), files: hit });
  }
  if (overlaps.length) return { landed: false, reason: "concurrent-edit", overlaps };
  // ② main 工作樹未提交同檔（git merge 也會擋；先檢＝訊息說得清楚）
  const mainSt = await git(["status", "--porcelain"], repoRoot);
  const dirtyHit = [...mine].filter((f) => new Set(porcelainFiles(mainSt.stdout)).has(f));
  if (dirtyHit.length) return { landed: false, reason: "main-dirty-overlap", files: dirtyHit };
  // ③ 單卡整合佇列（全新整合 worktree：乾淨合併＋閘門）
  const q = await processQueue(repoRoot, [{ card, branch, riskTier: "low", intent }],
    { project, base, gateCommand });
  const r0 = (q.results || [])[0];
  if (!q.ok || !r0 || !r0.landed) {
    return { landed: false, reason: r0 ? r0.reason : (q.error || "queue-failed"),
      ...(r0?.gate ? { gate: r0.gate } : {}) };
  }
  // ④ main 快轉到整合分支：唯一新 commit＝本卡的 merge commit（可 revert）
  const ff = await git(["merge", "--ff-only", q.integrationBranch], repoRoot);
  if (ff.code !== 0) {
    return { landed: false, reason: "ff-blocked", error: (ff.stderr || "").trim().slice(0, 300),
      integrationBranch: q.integrationBranch }; // 已 land 在整合分支（有 commit），人工可續收
  }
  const head = (await git(["rev-parse", "--short", "HEAD"], repoRoot)).stdout.trim();
  // land 後分支歸位：工作已全數併入 main，worktree 快轉到 base 尖——下輪從新底開工
  // （分支尖是 merge commit 的祖先＝恆可 ff；失敗不擋，下輪 pre-sync 會補）
  if ((await git(["rev-parse", "--is-inside-work-tree"], wtPath)).code === 0) {
    await git(["merge", "--ff-only", base], wtPath);
  }
  return { landed: true, commit: head, branch, files: [...mine], ...(r0.gate ? { gate: r0.gate } : {}) };
}
