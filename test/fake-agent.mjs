// 通道 MVP 測試用假 executor：模仿 `claude -p --output-format=stream-json` 的輸出形狀。
// 行為由環境變數 FAKE_BEHAVIOR 控制：
//   echo（預設）：init → assistant（echo:<prompt>＋一個 tool_use）→ result
//   args        ：assistant 文字＝收到的 argv（測 --resume 旗標有無傳入）
//   slow        ：result 前等 400ms（測 busy 排隊與 interrupt）
//   fail        ：stderr 吐錯後 exit 1（測異常結束→error 狀態）
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", async () => {
  const mode = process.env.FAKE_BEHAVIOR || "echo";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (mode === "fail") { process.stderr.write("fake agent boom"); process.exit(1); }
  // resume-fail：帶 --resume 就裝作 session 檔遺失（測對話轉生）；無 --resume 走 echo
  if (mode === "resume-fail" && process.argv.slice(2).join(" ").includes("--resume")) {
    process.stderr.write("Error: No conversation found with session ID: gone");
    process.exit(1);
  }
  out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION || "fake-sess-1" });
  if (mode === "slow") await new Promise((r) => setTimeout(r, 400));
  const text = mode === "args" ? `argv:${process.argv.slice(2).join(" ")}` : `echo:${prompt.trim()}`;
  out({ type: "assistant", message: { content: [
    { type: "text", text },
    { type: "tool_use", name: "Read", input: { file_path: "lib/chat.mjs" } },
  ] } });
  out({ type: "result", subtype: "success", is_error: false, result: text });
  process.exit(0);
});
