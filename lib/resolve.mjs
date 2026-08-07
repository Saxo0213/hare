// MA3 agent 帶意圖自動解衝突（Layer 2）——orchestration。
// HARE 的差異化：把「兩邊意圖」（卡片需求/驗收/refs）餵給 resolver，非只給 <<<< ==== >>>> 文字。
// resolver/verifier 注入（真＝spawn agent；測＝mock），與 chat 執行器解耦、可單元測。
// 全程在傳入的「整合 worktree」上操作（不碰 main）。過不了＝一律 merge --abort 退回，升 P2 人審。
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGate } from "./gate.mjs";

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

// 目前衝突檔＋內容（含衝突標記），組給 resolver 的 task 材料。
async function conflictState(wtPath) {
  const uf = (await git(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U"], wtPath))
    .stdout.split("\n").filter(Boolean);
  const files = [];
  for (const f of uf) files.push({ path: f, content: await readFile(join(wtPath, f), "utf8").catch(() => "") });
  return files;
}

// 套完 resolver 的解法後，檔案是否仍殘留衝突標記（沒解乾淨）。
async function hasConflictMarkers(wtPath, paths) {
  for (const p of paths) {
    const c = await readFile(join(wtPath, p), "utf8").catch(() => "");
    if (/^<{7}|^={7}|^>{7}/m.test(c)) return true;
  }
  return false;
}

// 在整合 worktree 合 cardBranch：乾淨＝直接 land；衝突＝進「resolver 解→驗收閘門→對抗複核」迴圈。
// opts: { cardIntent, otherIntent, resolver, verifier, gateCommand?, maxRetries=2, verifyVotes=1 }
//   resolver({files,cardIntent,otherIntent,attempt}) → [{path,content}]｜null（放棄）
//   verifier({cardIntent,otherIntent,resolution,i}) → { preserved:boolean }
// 回 { resolved, landed, reason?, attempts?, gate? }。
export async function resolveConflict(wtPath, cardBranch, {
  cardIntent, otherIntent, resolver, verifier, gateCommand = null, maxRetries = 2, verifyVotes = 1,
} = {}) {
  const pre = (await git(["rev-parse", "HEAD"], wtPath)).stdout.trim();
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const m = await git(["merge", "--no-ff", "--no-edit", cardBranch], wtPath);
    if (m.code === 0) return { resolved: true, landed: true, note: "clean", attempts: attempt }; // 無衝突＝已 auto-commit

    const files = await conflictState(wtPath);
    const resolution = typeof resolver === "function"
      ? await resolver({ files, cardIntent, otherIntent, attempt, wtPath }) : null; // wtPath 給真 agent 知道在哪解
    if (!resolution || !resolution.length) { await git(["merge", "--abort"], wtPath); return { resolved: false, landed: false, reason: "resolver-gave-up→human" }; }

    for (const r of resolution) await writeFile(join(wtPath, r.path), r.content);
    if (await hasConflictMarkers(wtPath, files.map((f) => f.path))) { await git(["merge", "--abort"], wtPath); continue; } // 沒解乾淨→重試

    await git(["add", "-A"], wtPath);
    const gate = await runGate(wtPath, gateCommand); // 雙方驗收閘門（呼叫端給合併後該跑的測試）
    if (!gate.pass) { await git(["merge", "--abort"], wtPath); continue; } // 閘門紅→重試

    // 對抗式複核：只審「有無保住兩邊意圖」，過半肯定才收
    const votes = await Promise.all(Array.from({ length: verifyVotes }, (_, i) =>
      (typeof verifier === "function" ? verifier({ cardIntent, otherIntent, resolution, i }) : Promise.resolve({ preserved: true }))));
    const kept = votes.filter((v) => v && v.preserved).length;
    if (kept <= votes.length / 2) { await git(["merge", "--abort"], wtPath); return { resolved: false, landed: false, reason: "verify-rejected→human", gate }; }

    await git(["commit", "--no-edit"], wtPath); // 收下解法（完成合併）
    return { resolved: true, landed: true, attempts: attempt, gate };
  }
  await git(["merge", "--abort"], wtPath).catch(() => {}); // 保險
  await git(["reset", "--hard", pre], wtPath);
  return { resolved: false, landed: false, reason: "retries-exhausted→human" };
}
