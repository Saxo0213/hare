// 合併後閘門執行器（抽出以避免 mergequeue↔resolve 循環相依）。
// 在整合 worktree 跑指令（如 ["npm","test"]）；無指令＝視為通過（不擋）。回 { pass, code, output(尾段4KB), skipped? }。
import { spawn } from "node:child_process";

export function runGate(cwd, command) {
  if (!command || !command.length) return Promise.resolve({ pass: true, code: 0, output: "", skipped: true });
  return new Promise((res) => {
    // win32：npm/.cmd 需 shell → 傳「單一字串」給 shell（避開 DEP0190：shell 不可配 args 陣列）；
    // 非 win32：陣列＋免 shell（不經 shell 解析，安全）。gate 指令來自設定＝可信。
    const win = process.platform === "win32";
    let c;
    try {
      c = win ? spawn(command.join(" "), { cwd, windowsHide: true, shell: true })
        : spawn(command[0], command.slice(1), { cwd, windowsHide: true });
    } catch (e) { return res({ pass: false, code: -1, output: String(e && e.message || e) }); }
    let out = "";
    const cap = (d) => { out = (out + d.toString()).slice(-4000); };
    c.stdout.on("data", cap); c.stderr.on("data", cap);
    c.on("close", (code) => res({ pass: code === 0, code, output: out }));
    c.on("error", (e) => res({ pass: false, code: -1, output: String(e && e.message || e) }));
  });
}
