// 通道 MVP（N33〜N40）單元測試：turn 完整鏈／--resume 續話／busy 排隊／interrupt／
// 權限回問（核准・逾時拒絕）／殘留 running 啟動校正。
// 以 HARE_DATA_DIR 隔離到暫存夾（chat 狀態檔都在 dataDir()/chat/ 下）；
// executor 注入 test/fake-agent.mjs（模仿 claude -p stream-json 輸出形狀）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TMP = join(tmpdir(), `hare-chat-test-${process.pid}`);
process.env.HARE_DATA_DIR = TMP;

const here = resolve(fileURLToPath(import.meta.url), "..");
const FAKE = join(here, "fake-agent.mjs");

const chat = await import("../lib/chat.mjs");

before(async () => { await mkdir(TMP, { recursive: true }); });
after(async () => { await rm(TMP, { recursive: true, force: true }); });

// 輪詢等待：turn 在背景跑，等到條件成立或逾時
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("until timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const idle = (proj, card) => until(async () => {
  const c = await chat.getChat(proj, card);
  return (c.status === "idle" || c.status === "error") ? c : null;
});

test("turn 完整鏈：user→assistant echo→tool 譯文→idle，session_id 落檔", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE], broadcaster: null, permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR;
  const r = await chat.sendMessage("chatp1", "card_a", "哈囉");
  assert.equal(r.started, true);
  const c = await idle("chatp1", "card_a");
  assert.equal(c.status, "idle");
  assert.equal(c.sessionId, "fake-sess-1");
  const roles = c.messages.map((m) => m.role);
  assert.ok(roles.includes("user") && roles.includes("assistant") && roles.includes("tool"));
  assert.ok(c.messages.find((m) => m.role === "assistant").text.includes("echo:哈囉"));
  assert.ok(c.messages.find((m) => m.role === "tool").text.includes("讀檔")); // 工具事件譯人話
});

test("follow_up：第二個 turn 帶 --resume <session_id>", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  process.env.FAKE_BEHAVIOR = "args";
  await chat.sendMessage("chatp1", "card_a", "再來");
  const c = await idle("chatp1", "card_a");
  const argv = c.messages.filter((m) => m.role === "assistant").at(-1).text;
  assert.ok(argv.includes("--resume fake-sess-1"), `應帶 --resume，實得：${argv}`);
  delete process.env.FAKE_BEHAVIOR;
});

test("busy 排隊：turn 進行中送訊息＝queued，Stop 後自動送出", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  process.env.FAKE_BEHAVIOR = "slow";
  await chat.sendMessage("chatp2", "card_b", "第一則");
  const r2 = await until(async () => {
    const c = await chat.getChat("chatp2", "card_b");
    if (c.status !== "running") return null; // 等 turn 真的跑起來再排隊
    return chat.sendMessage("chatp2", "card_b", "第二則");
  });
  assert.equal(r2.queued, 1);
  delete process.env.FAKE_BEHAVIOR; // 排隊那則用快速模式跑
  const c = await until(async () => {
    const x = await chat.getChat("chatp2", "card_b");
    const echos = x.messages.filter((m) => m.role === "assistant").length;
    return (x.status === "idle" && echos >= 2 && x.queue === 0) ? x : null;
  });
  assert.ok(c.messages.some((m) => m.role === "assistant" && m.text.includes("第二則")));
});

test("interrupt：中斷進行中 turn → idle＋中斷紀錄", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  process.env.FAKE_BEHAVIOR = "slow";
  await chat.sendMessage("chatp3", "card_c", "會被中斷");
  await until(async () => (await chat.getChat("chatp3", "card_c")).status === "running");
  const r = await chat.interrupt("chatp3", "card_c");
  assert.equal(r.ok, true);
  const c = await idle("chatp3", "card_c");
  assert.equal(c.status, "idle");
  assert.ok(c.messages.some((m) => m.role === "system" && m.text.includes("中斷")));
  delete process.env.FAKE_BEHAVIOR;
});

test("異常結束：exit 1 → status=error＋錯誤紀錄含 stderr", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  process.env.FAKE_BEHAVIOR = "fail";
  await chat.sendMessage("chatp4", "card_d", "會爆");
  const c = await idle("chatp4", "card_d");
  assert.equal(c.status, "error");
  // flaky 防治（2026-08-02 整合閘門誤紅事故）：曾間歇性讀不到剛落檔的錯誤訊息——
  // 單發斷言改輪詢等待，語意不變（boom 必須出現，等不到照樣 timeout 紅）
  await until(async () => {
    const cc = await chat.getChat("chatp4", "card_d");
    return cc.messages.some((m) => m.role === "error" && m.text.includes("boom")) ? cc : null;
  });
  delete process.env.FAKE_BEHAVIOR;
});

test("權限回問：pending 落檔＋核准回 allow；resolvePermission 清單消失", async () => {
  chat.configureChat({ permissionTimeoutMs: 10000 });
  const p = chat.requestPermission("chatp5", "card_e", "Bash", { command: "npm test" });
  const pend = await until(async () => {
    const l = await chat.listPending("chatp5");
    return l.length ? l : null;
  });
  assert.equal(pend[0].tool, "Bash");
  assert.equal(pend[0].card, "card_e");
  const ok = await chat.resolvePermission("chatp5", pend[0].id, true);
  assert.equal(ok, true);
  const result = await p;
  assert.equal(result.behavior, "allow");
  assert.equal((await chat.listPending("chatp5")).length, 0);
  const c = await chat.getChat("chatp5", "card_e");
  assert.ok(c.messages.some((m) => m.role === "perm" && m.text.includes("等待核准")));
  assert.ok(c.messages.some((m) => m.role === "perm" && m.text.includes("已核准")));
});

test("HARE 自家工具自動放行：mcp__hare__* 與 hare 系 skill 不浮出、直接 allow", async () => {
  chat.configureChat({ permissionTimeoutMs: 60 }); // 若誤走掛起路徑會變 deny，斷言就會抓到
  const r1 = await chat.requestPermission("chatp8", "card_g", "mcp__hare__get_overview", {});
  assert.equal(r1.behavior, "allow");
  const r2 = await chat.requestPermission("chatp8", "card_g", "Skill", { skill: "hare-workflow" });
  assert.equal(r2.behavior, "allow");
  assert.equal((await chat.listPending("chatp8")).length, 0); // 不留 pending、不打擾使用者
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("權限回問：逾時＝拒絕（deny）", async () => {
  chat.configureChat({ permissionTimeoutMs: 60 });
  // 界外路徑才會回問（2026-08-02 檔案工具政策：界內 Edit/Write 自動放行）——逾時語意不變
  const result = await chat.requestPermission("chatp6", "card_f", "Write", { file_path: "C:/outside-evil/x.txt" });
  assert.equal(result.behavior, "deny");
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("對話卡清單：turn 進行中 running 排前；收工後仍列（歷史保留、狀態轉 idle）", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  process.env.FAKE_BEHAVIOR = "slow";
  await chat.sendMessage("chatp9", "card_h", "跑著");
  const act = await until(async () => {
    const l = await chat.listChats("chatp9");
    return l.length && l[0].status === "running" ? l : null;
  });
  assert.equal(act[0].card, "card_h");
  delete process.env.FAKE_BEHAVIOR;
  await idle("chatp9", "card_h");
  const after = await chat.listChats("chatp9");
  assert.equal(after[0].card, "card_h"); // 有聊天狀態的卡都列（快速切換用）
  assert.equal(after[0].status, "idle");
});

test("語境注入：綁定卡前綴＋協作約定卡前綴進 prompt（不進轉錄）", async () => {
  // 在隔離資料夾建一個 chatp10 專案板：含綁定卡與「協作約定」卡
  const { writeStore } = await import("../lib/store.mjs");
  await writeStore({ nodes: [
    { id: "card_ctx", type: "note", position: { x: 0, y: 0 },
      data: { num: "K1", label: "語境測試卡", status: "plan" } },
    { id: "conv1", type: "note", position: { x: 300, y: 0 },
      data: { num: "K2", label: "協作約定", status: "note", desc: "回覆一律繁體中文" } },
  ], edges: [] }, "test-seed", { allowEmpty: true, project: "chatp10" });
  chat.configureChat({ execCommand: [process.execPath, FAKE], permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR; // echo 模式：assistant 會回吐收到的 prompt
  await chat.sendMessage("chatp10", "card_ctx", "你好");
  const c = await idle("chatp10", "card_ctx");
  const echo = c.messages.find((m) => m.role === "assistant").text;
  assert.ok(echo.includes("【對話綁定】") && echo.includes("K1") && echo.includes("語境測試卡"), `綁定前綴應進 prompt：${echo.slice(0, 120)}`);
  assert.ok(echo.includes("【專案約定】") && echo.includes("繁體中文"), "約定卡 desc 應進 prompt");
  const userMsg = c.messages.find((m) => m.role === "user").text;
  assert.equal(userMsg, "你好"); // 轉錄只記使用者原話
});

test("新專案啟動閘門：prompt 明示先建完卡；永久白名單也不能提前寫程式", async () => {
  const proj = "chatp_onboarding_gate";
  const { createProject } = await import("../lib/projects.mjs");
  await createProject(proj, { onboarding: "new", refBase: TMP }, "test");
  await chat.setProjWhitelist(proj, { tools: ["Read", "Write", "Edit"], bash: ["mkdir", "git status"] });

  const allowed = await chat.allowedToolsFor(proj, chat.PROJECT_CHAT_ID);
  assert.ok(allowed.includes("Read"), "啟動期保留已核可唯讀工具");
  assert.ok(!allowed.includes("Write") && !allowed.includes("Edit"), "寫入工具不編入 allowedTools");
  assert.ok(!allowed.some((x) => x === "Bash" || x.startsWith("Bash(")), "Bash 每次回閘門檢查完整命令");

  assert.equal(chat.planningSafeTool("Bash", { command: "node --version && npm --version" }), true);
  assert.equal(chat.planningSafeTool("Bash", { command: "node --version && mkdir game" }), false);
  const denied = await chat.requestPermission(proj, chat.PROJECT_CHAT_ID, "Write", { file_path: "package.json" });
  assert.equal(denied.behavior, "deny", "即使 Write 在永久白名單，啟動未核可仍拒絕");
  assert.match(denied.message, /完整建立規劃／任務卡|使用者親自核可/);
  const read = await chat.requestPermission(proj, chat.PROJECT_CHAT_ID, "Read", { file_path: "package.json" });
  assert.equal(read.behavior, "allow", "規劃期仍可讀檔");

  chat.configureChat({ execCommand: [process.execPath, FAKE], permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR;
  await chat.sendMessage(proj, chat.PROJECT_CHAT_ID, "開始建立專案");
  const c = await idle(proj, chat.PROJECT_CHAT_ID);
  const echo = c.messages.find((m) => m.role === "assistant").text;
  assert.ok(echo.includes("【啟動閘門】"), "每個 turn 都注入啟動閘門");
  assert.ok(echo.includes("禁止建立或修改專案程式檔"), "明確要求先完成白板規劃");
  assert.ok(echo.includes("不得由 agent 呼叫 complete_task"), "使用者核可不可代銷");
});

test("對話轉生：resume 失效→清 session＋轉錄記憶重生＋系統訊息", async () => {
  chat.configureChat({ execCommand: [process.execPath, FAKE], permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR;
  await chat.sendMessage("chatp11", "card_r", "第一句記憶");
  let c = await idle("chatp11", "card_r");
  assert.equal(c.sessionId, "fake-sess-1"); // 先建立 session
  process.env.FAKE_BEHAVIOR = "resume-fail"; // 下一 turn 帶 --resume 會裝作 session 遺失
  await chat.sendMessage("chatp11", "card_r", "第二句");
  c = await until(async () => {
    const x = await chat.getChat("chatp11", "card_r");
    const reborn = x.messages.some((m) => m.role === "system" && m.text.includes("轉生"));
    return (x.status === "idle" && reborn) ? x : null;
  });
  delete process.env.FAKE_BEHAVIOR;
  // 轉生後：無 --resume 的重試走 echo 成功，且重生 prompt 帶轉錄記憶
  const echo = c.messages.filter((m) => m.role === "assistant").at(-1).text;
  assert.ok(echo.includes("轉生記憶") && echo.includes("第一句記憶"), `重生 prompt 應含轉錄節選：${echo.slice(0, 150)}`);
  assert.ok(echo.includes("第二句"), "原訊息應接在記憶之後");
  assert.equal(c.status, "idle");
});

test("Bash 結構化判定：頭綴拆解與危險樣式", () => {
  const a = chat.analyzeBashHeads("npm test && node --check lib/x.mjs | head -3");
  assert.deepEqual(a.heads, ["npm test", "node", "head"]);
  assert.equal(a.danger, false);
  assert.equal(chat.analyzeBashHeads("rm -rf /d/x").danger, true);
  assert.equal(chat.analyzeBashHeads("git push --force origin main").danger, true);
  assert.deepEqual(chat.analyzeBashHeads("DEBUG=1 npm test -x").heads, ["npm test"]); // ENV 前綴跳過
});

test("三檔核可：session 白名單自動放行、危險指令仍浮出、always 落專案檔", async () => {
  chat.configureChat({ permissionTimeoutMs: 10000 });
  // ① Bash「npm test」首問→session 核可
  const p1 = chat.requestPermission("chatp12", "card_w", "Bash", { command: "npm test -a" });
  const pend1 = await until(async () => { const l = await chat.listPending("chatp12"); return l.length ? l : null; });
  await chat.resolvePermission("chatp12", pend1[0].id, true, "session");
  assert.equal((await p1).behavior, "allow");
  // ② 同頭綴再問＝白名單直接放行（不浮出、立即回）
  const r2 = await chat.requestPermission("chatp12", "card_w", "Bash", { command: "npm test --other" });
  assert.equal(r2.behavior, "allow");
  assert.equal((await chat.listPending("chatp12")).length, 0);
  // ③ 危險指令：即使頭綴在白名單邏輯外仍浮出（rm 永不自動放行）
  const p3 = chat.requestPermission("chatp12", "card_w", "Bash", { command: "rm -rf build" });
  const pend3 = await until(async () => { const l = await chat.listPending("chatp12"); return l.length ? l : null; });
  await chat.resolvePermission("chatp12", pend3[0].id, false);
  assert.equal((await p3).behavior, "deny");
  // ④ 工具 always＝專案級白名單：跨卡也放行（界外路徑才回問——2026-08-02 檔案工具政策後
  //    界內 Write 自動放行，白名單機制改以界外樣本驗證）
  const p4 = chat.requestPermission("chatp12", "card_w", "Write", { file_path: "C:/outside-wl/x.txt" });
  const pend4 = await until(async () => { const l = await chat.listPending("chatp12"); return l.length ? l : null; });
  await chat.resolvePermission("chatp12", pend4[0].id, true, "always");
  assert.equal((await p4).behavior, "allow");
  const r5 = await chat.requestPermission("chatp12", "card_OTHER", "Write", { file_path: "C:/outside-wl/y.txt" });
  assert.equal(r5.behavior, "allow"); // 另一張卡直接放行＝專案級生效
});

test("EXECUTORS 資料列：codex 列解析實機事件格式；claude 列組旗標", () => {
  const cx = chat.EXECUTORS.codex;
  // 事件樣本＝2026-07-18 實機 `codex exec --json` 結構冒煙輸出
  assert.deepEqual(cx.parseEvent({ type: "thread.started", thread_id: "019f-abc" }), { sessionId: "019f-abc" });
  const fail = cx.parseEvent({ type: "turn.failed", error: { message: "requires a newer version" } });
  assert.ok(fail.result && fail.error.includes("newer"));
  assert.deepEqual(cx.parseEvent({ type: "item.completed", item: { type: "agent_message", text: "hi" } }).msgs,
    [{ role: "assistant", text: "hi" }]);
  assert.deepEqual(cx.buildArgs({ sessionId: "019f-abc" }), ["exec", "resume", "019f-abc", "--json", "-"]);
  const cl = chat.EXECUTORS.claude;
  assert.deepEqual(cl.buildArgs({ sessionId: "s1" }), ["-p", "--output-format", "stream-json", "--verbose", "--resume", "s1"]);
});

test("殘留校正：sessions.json 裡的 running/waiting 載入時翻回 idle", async () => {
  const dir = join(TMP, "chat", "chatp7");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sessions.json"), JSON.stringify({ cards: {
    card_x: { sessionId: "s1", status: "running", queue: [], pending: [] },
    card_y: { sessionId: "s2", status: "waiting", queue: [], pending: [] },
  } }));
  const cx = await chat.getChat("chatp7", "card_x");
  const cy = await chat.getChat("chatp7", "card_y");
  assert.equal(cx.status, "idle");
  assert.equal(cy.status, "idle");
});

test("側欄清單：getChat 讀取不種檔；listChats 只列有對話證據的卡＋板上標籤解析", async () => {
  const proj = "chatp_sidebar";
  // 看過（getChat）不等於聊過：讀十次也不該出現在清單
  await chat.getChat(proj, "card_viewed_only");
  let list = await chat.listChats(proj);
  assert.equal(list.length, 0, "純看過的卡不進清單");
  // 真的聊過才列（無板專案：驗卡不可考→放行）
  chat.configureChat({ execCommand: [process.execPath, FAKE], broadcaster: null, permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR;
  await chat.sendMessage(proj, "card_real", "hi");
  await idle(proj, "card_real");
  list = await chat.listChats(proj);
  assert.equal(list.length, 1);
  assert.equal(list[0].card, "card_real");
  assert.equal(list[0].missing, true, "無板專案＝板上查無此卡，標 missing 但仍列出");
});

test("sendMessage 驗卡：有板的專案，查無此卡拒絕；板上卡放行", async () => {
  const proj = "chatp_verify";
  const { writeStore } = await import("../lib/store.mjs");
  await writeStore({ nodes: [
    { id: "real_card", type: "note", position: { x: 0, y: 0 },
      data: { num: "R1", label: "真卡", status: "note" } },
  ], edges: [] }, "test-seed", { allowEmpty: true, project: proj });
  await assert.rejects(() => chat.sendMessage(proj, "ghost_card", "hi"), /板上找不到卡片/);
  chat.configureChat({ execCommand: [process.execPath, FAKE] });
  const r = await chat.sendMessage(proj, "real_card", "hi");
  assert.equal(r.started, true);
  await idle(proj, "real_card");
  const list = await chat.listChats(proj);
  assert.equal(list.length, 1);
  assert.equal(list[0].num, "R1", "清單帶板上編號");
  assert.equal(list[0].label, "真卡", "清單帶板上標籤");
  assert.ok(list[0].page, "清單帶分頁名");
});

test("EXECUTORS 只留 claude/codex（W1-6-2）＋登入登出指令資料列", () => {
  // 擴列（cursor/droid/amp）已依 2026-08-02 使用者指示移除
  assert.deepEqual(Object.keys(chat.EXECUTORS).sort(), ["claude", "codex"]);
  // 帳號切換指令：claude 走斜線命令進 REPL；codex 是實子命令（--help 核對）
  assert.equal(chat.agentAuthCommand("claude", "login"), "claude /login");
  assert.equal(chat.agentAuthCommand("claude", "logout"), "claude /logout");
  assert.equal(chat.agentAuthCommand("codex", "login"), "codex login");
  assert.equal(chat.agentAuthCommand("codex", "logout"), "codex logout");
  assert.equal(chat.agentAuthCommand("cursor", "login"), null, "移除列不得殘留 auth 對照");
  assert.equal(chat.agentAuthCommand("claude", "hack"), null, "未知 action 回 null");
});

test("專案級對話（__project__）：有板專案驗卡放行＋前綴改全板視角＋清單標 projectChat", async () => {
  const proj = "chatp_proj";
  const { writeStore } = await import("../lib/store.mjs");
  await writeStore({ nodes: [
    { id: "pcard", type: "note", position: { x: 0, y: 0 },
      data: { num: "P1", label: "某卡", status: "note" } },
  ], edges: [] }, "test-seed", { allowEmpty: true, project: proj });
  chat.configureChat({ execCommand: [process.execPath, FAKE], permissionBaseUrl: null });
  delete process.env.FAKE_BEHAVIOR; // echo：assistant 回吐收到的 prompt（含前綴）
  const r = await chat.sendMessage(proj, "__project__", "全板狀況如何");
  assert.equal(r.started, true);
  const c = await idle(proj, "__project__");
  const echo = c.messages.find((m) => m.role === "assistant").text;
  assert.ok(echo.includes("專案級對話"), "前綴應為專案級視角");
  assert.ok(echo.includes("get_overview"), "前綴應指向全板工具");
  const list = await chat.listChats(proj);
  const row = list.find((x) => x.card === "__project__");
  assert.ok(row && row.projectChat === true, "清單列標 projectChat");
  // 幽靈防線不受影響：亂造 id 照樣拒絕
  await assert.rejects(() => chat.sendMessage(proj, "ghost_x", "hi"), /板上找不到卡片/);
});

test("Bash 核可政策：safe-auto 自動放行安全唯讀頭；strict 回問；trust 全放；危險恆浮出", async () => {
  const proj = "chatp_policy";
  chat.configureChat({ permissionTimeoutMs: 60 }); // 誤走掛起路徑會 deny，斷言抓得到
  // 預設 safe-auto：git status / cat 自動放行
  let r = await chat.requestPermission(proj, "c1", "Bash", { command: "git status | head -5" });
  assert.equal(r.behavior, "allow");
  // 非安全頭（npm install）＝回問（逾時 deny）
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "npm install left-pad" });
  assert.equal(r.behavior, "deny");
  // strict：連安全頭也回問
  await chat.setProjSettings(proj, { bashPolicy: "strict" });
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "git status" });
  assert.equal(r.behavior, "deny");
  // trust：npm install 放行；危險樣式仍浮出
  await chat.setProjSettings(proj, { bashPolicy: "trust" });
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "npm install left-pad" });
  assert.equal(r.behavior, "allow");
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "rm -rf node_modules" });
  assert.equal(r.behavior, "deny");
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("全部放行涵蓋非指令工具（2026-07-26 修正）：all＝Read／外部工具自動核可；trust 不涵蓋", async () => {
  const proj = "chatp_policy_all";
  chat.configureChat({ permissionTimeoutMs: 60 });
  // trust＝指令政策：外部（非指令、非檔案）工具照樣回問（逾時 deny）；
  // 唯讀檔案工具 2026-08-02 檔案工具政策起任何政策一律放行
  await chat.setProjSettings(proj, { bashPolicy: "trust" });
  let r = await chat.requestPermission(proj, "c1", "mcp__playwright__browser_navigate", { url: "http://localhost" });
  assert.equal(r.behavior, "deny");
  r = await chat.requestPermission(proj, "c1", "Read", { file_path: "x.txt" });
  assert.equal(r.behavior, "allow"); // 唯讀＝無副作用，trust 下也放
  // all＝所有工具自動核可（含外部 MCP 工具）
  await chat.setProjSettings(proj, { bashPolicy: "all" });
  r = await chat.requestPermission(proj, "c1", "mcp__playwright__browser_navigate", { url: "http://localhost" });
  assert.equal(r.behavior, "allow");
  // 危險指令樣式仍系統決斷、照樣浮出
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "rm -rf build" });
  assert.equal(r.behavior, "deny");
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("連帶放行（2026-07-26）：切全部放行清空排隊；白名單核准掃掉同工具連發", async () => {
  const proj = "chatp_resweep";
  chat.configureChat({ permissionTimeoutMs: 8000 });
  // ① 政策切換連帶：strict 下兩個外部工具排隊 → 切 all → 兩個都自動核准
  //   （2026-08-02 檔案工具政策後 Read/界內 Write 不再排隊，改用外部工具樣本）
  await chat.setProjSettings(proj, { bashPolicy: "strict" });
  const p1 = chat.requestPermission(proj, "c1", "mcp__ext__alpha", {});
  const p2 = chat.requestPermission(proj, "c1", "mcp__ext__beta", {});
  await new Promise((r) => setTimeout(r, 30)); // 讓 pending 落地
  await chat.setProjSettings(proj, { bashPolicy: "all" });
  assert.deepEqual((await Promise.all([p1, p2])).map((x) => x.behavior), ["allow", "allow"]);
  // ② 白名單核准連帶：strict 下兩個界外 Write 排隊 → 核准第一個入永久白名單 → 第二個連帶放行
  await chat.setProjSettings(proj, { bashPolicy: "strict" });
  const w1 = chat.requestPermission(proj, "c1", "Write", { file_path: "C:/outside-rs/x.md" });
  const w2 = chat.requestPermission(proj, "c1", "Write", { file_path: "C:/outside-rs/y.md" });
  await new Promise((r) => setTimeout(r, 30));
  const pend = await chat.listPending(proj);
  assert.equal(pend.length, 2, "應有兩筆排隊");
  await chat.resolvePermission(proj, pend[0].id, true, "always");
  assert.deepEqual((await Promise.all([w1, w2])).map((x) => x.behavior), ["allow", "allow"]);
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("危險指令系統決斷：任何政策不自動放行；15 分鐘窗內免問、窗外恢復回問", async () => {
  const proj = "chatp_danger";
  chat.configureChat({ permissionTimeoutMs: 60 });
  await chat.setProjSettings(proj, { bashPolicy: "all" }); // 連最寬政策也擋
  let r = await chat.requestPermission(proj, "c1", "Bash", { command: "rm -rf build" });
  assert.equal(r.behavior, "deny"); // 浮出→逾時拒絕
  // 開 15 分鐘窗（模擬使用者按「15 分鐘內放行」）
  await chat.setProjSettings(proj, { dangerAllowUntil: Date.now() + 15 * 60 * 1000 });
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "rm -rf build" });
  assert.equal(r.behavior, "allow"); // 窗內自動放行
  // 窗過期＝恢復回問
  await chat.setProjSettings(proj, { dangerAllowUntil: Date.now() - 1000 });
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "git push --force" });
  assert.equal(r.behavior, "deny");
  // 擴充危險網：DROP DATABASE 也入網
  r = await chat.requestPermission(proj, "c1", "Bash", { command: "mysql -e 'DROP DATABASE prod'" });
  assert.equal(r.behavior, "deny");
  chat.configureChat({ permissionTimeoutMs: 180000 });
});

test("白名單整份覆寫（安全性頁儲存制）：修剪去重、非法值過濾、清空", async () => {
  const proj = "chatp_wlset";
  let r = await chat.setProjWhitelist(proj, { tools: [" Read ", "Read", "", "Edit"], bash: ["npm test", "npm test", 42] });
  assert.deepEqual(r.whitelist, { tools: ["Read", "Edit"], bash: ["npm test", "42"] });
  const s = await chat.getAgentSettings(proj);
  assert.deepEqual(s.whitelist, { tools: ["Read", "Edit"], bash: ["npm test", "42"] });
  r = await chat.setProjWhitelist(proj, { tools: [], bash: [] });
  assert.deepEqual(r.whitelist, { tools: [], bash: [] });
});
