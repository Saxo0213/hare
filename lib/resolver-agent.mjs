// MA3 真 resolver agent——把 orchestration 的注入點接上「真的 coding agent」。
// 差異化：prompt 帶雙方卡片意圖（需求/驗收/refs），非只給文字衝突標記。
// 流程：組 prompt → 一次性 spawn agent（cwd=整合 worktree）就地編輯解衝突 → 讀回衝突檔內容。
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// PURE：組解衝突 prompt（可單元測）。files=[{path,content(含標記)}]。
export function buildResolvePrompt({ files, cardIntent, otherIntent, attempt = 1 } = {}) {
  const p = [];
  p.push("你正在解一個 git 合併衝突。請就地編輯下列衝突檔、移除所有衝突標記（<<<<<<< / ======= / >>>>>>>），");
  p.push("產出同時保住「雙方意圖」的正確版本。只改必要的行，別擴張範圍，別動無關檔案。");
  if (cardIntent) p.push(`\n【本卡意圖】\n${cardIntent}`);
  if (otherIntent) p.push(`\n【對方（已整合那側）意圖】\n${otherIntent}`);
  p.push("\n【衝突檔（含標記，位於你的工作目錄）】");
  for (const f of (files || [])) p.push(`\n--- ${f.path} ---\n${f.content}`);
  p.push("\n完成後檔案不得留任何衝突標記。");
  if (attempt > 1) p.push(`\n（第 ${attempt} 次嘗試：前次未通過驗收/複核，請更謹慎。）`);
  return p.join("\n");
}

// 一次性 spawn agent：execCommand（如 ["claude","-p","--output-format=stream-json","--allowedTools","Edit Write Read"]），
// cwd=worktree，prompt 走 stdin，等結束。逾時殺掉。回 { ok }。
export function spawnResolver({ execCommand, cwd, prompt, timeoutMs = 300000 } = {}) {
  return new Promise((res) => {
    if (!execCommand || !execCommand.length) return res({ ok: false, error: "no execCommand" });
    const [cmd, ...args] = execCommand;
    let c;
    try {
      c = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) });
    } catch (e) { return res({ ok: false, error: String(e && e.message || e) }); }
    const timer = setTimeout(() => { try { c.kill(); } catch { /* */ } res({ ok: false, error: "timeout" }); }, timeoutMs);
    c.stdout.on("data", () => {}); c.stderr.on("data", () => {}); // 排空，避免背壓卡住
    c.on("close", (code) => { clearTimeout(timer); res({ ok: code === 0 }); });
    c.on("error", (e) => { clearTimeout(timer); res({ ok: false, error: String(e && e.message || e) }); });
    try { c.stdin.write(prompt); c.stdin.end(); } catch { /* 子行程可能已退出 */ }
  });
}

// 造 resolver：符合 resolveConflict 的 resolver 契約。agent 就地改完，再讀回衝突檔內容回傳。
export function makeResolverAgent({ execCommand, timeoutMs } = {}) {
  return async ({ files, cardIntent, otherIntent, attempt, wtPath }) => {
    if (!execCommand || !execCommand.length || !wtPath) return null;
    const prompt = buildResolvePrompt({ files, cardIntent, otherIntent, attempt });
    const r = await spawnResolver({ execCommand, cwd: wtPath, prompt, timeoutMs });
    if (!r.ok) return null;
    // 讀回 agent 就地編輯後的內容（resolveConflict 會再寫回＝idempotent；hasConflictMarkers 把關沒解乾淨）
    return Promise.all((files || []).map(async (f) => ({
      path: f.path, content: await readFile(join(wtPath, f.path), "utf8").catch(() => f.content),
    })));
  };
}
