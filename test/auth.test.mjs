// B12 認證授權分級＋writer 防偽 單元／整合測試（零依賴，node --test）。
// 隔離：HARE_DATA_DIR→暫存 data/、HARE_DATA_PATH→暫存預設專案檔；env 在 import 前設好，
// 全程不碰 repo 內真實資料。ROADMAP_TOKEN 一律先清（測試自己在需要時設／還原）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hare-b12-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "default-legacy.json");
delete process.env.ROADMAP_TOKEN;

const { changelogPathFor, readStore } = await import("../lib/store.mjs");
const { createProject, setProjectAuth } = await import("../lib/projects.mjs");
const { authorize, roleMeets, bearerToken } = await import("../lib/auth.mjs");
const { createMcpHttpHandler } = await import("../lib/mcp-http.mjs");

// 假 req：只需 headers。
const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

// 呼叫 mcp-http handler（整合 authorize→writer→changelog 全鏈）。回傳 { status, json }。
function invokeMcp(handler, { token, rpc, url = "/mcp" }) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = url;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = {
      statusCode: 200,
      setHeader() {},
      end(payload) {
        let json = null;
        try { json = JSON.parse(payload); } catch { /* noop */ }
        resolve({ status: this.statusCode, json });
      },
    };
    handler(req, res);
    const body = JSON.stringify(rpc);
    req.emit("data", body);
    req.emit("end");
  });
}
const mcp = createMcpHttpHandler({}); // broadcaster 省略（onWrite 用 ?. 安全）
const callTool = (token, name, args = {}) =>
  invokeMcp(mcp, { token, rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });

// 讀 changelog 最後一筆（parse JSONL）。
function lastChangelogEntry(project) {
  const p = changelogPathFor(project);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

/* ---------- 角色階工具 ---------- */
test("roleMeets：admin>write>read 階序", () => {
  assert.ok(roleMeets("admin", "read") && roleMeets("admin", "write") && roleMeets("admin", "admin"));
  assert.ok(roleMeets("write", "read") && roleMeets("write", "write") && !roleMeets("write", "admin"));
  assert.ok(roleMeets("read", "read") && !roleMeets("read", "write"));
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerToken({ headers: {} }), null);
});

/* ---------- 開發模式（無任何 token）：全放行、writer 不被強加 ---------- */
test("no-token 開發模式：讀寫皆放行、role=admin、writer=null（沿用呼叫端預設）", async () => {
  const r = await authorize(reqWith(null), { project: "default", need: "write" });
  assert.equal(r.ok, true);
  assert.equal(r.role, "admin");
  assert.equal(r.writer, null); // 無 identity ⇒ 呼叫端沿用 browser/mcp-http 預設
  // mcp-http 寫入工具在開發模式亦放行
  const added = await callTool(null, "add_card", { label: "開發模式卡", project: "default" });
  assert.equal(added.status, 200);
  assert.ok(!added.json.result.isError, "add_card 應成功");
});

/* ---------- per 專案 token：正確／錯誤 ---------- */
test("per 專案 token：正確 token 依角色放行；錯誤 token→401", async () => {
  await createProject("proja", { title: "Project A" });
  await setProjectAuth("proja", {
    tokens: {
      "tok-a-write": { role: "write", identity: "alice" },
      "tok-a-admin": { role: "admin", identity: "admin-a" },
    },
  });
  // 正確 write token
  const ok = await authorize(reqWith("tok-a-write"), { project: "proja", need: "write" });
  assert.equal(ok.ok, true);
  assert.equal(ok.role, "write");
  assert.equal(ok.identity, "alice");
  assert.equal(ok.writer, "alice"); // writer 由 token 反查
  // 錯誤（未知）token → 401
  const bad = await authorize(reqWith("totally-bogus"), { project: "proja", need: "write" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  // 未帶 token 而需寫入 → 401
  const none = await authorize(reqWith(null), { project: "proja", need: "write" });
  assert.equal(none.status, 401);
});

test("角色不足：write token 執行 admin（需求）→403", async () => {
  const r = await authorize(reqWith("tok-a-write"), { project: "proja", need: "admin" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.role, "write");
});

/* ---------- 跨專案越權：A 的 token 不能寫 B（403） ---------- */
test("跨專案越權：proja 的 token 寫 projb→403（憑證有效但不屬本專案）", async () => {
  await createProject("projb", { title: "Project B" });
  await setProjectAuth("projb", { tokens: { "tok-b-write": { role: "write", identity: "bob" } } });
  // proja 的 token 拿去寫 projb → 403（非 401：可辨識為跨專案越權）
  const r = await authorize(reqWith("tok-a-write"), { project: "projb", need: "write" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  // projb 自己的 token 正常
  const ok = await authorize(reqWith("tok-b-write"), { project: "projb", need: "write" });
  assert.equal(ok.ok, true);
  assert.equal(ok.identity, "bob");
});

/* ---------- 私有專案讀取保護 ---------- */
test("私有專案：讀取需 token（無→401，讀 token→放行）；非私有讀取仍公開", async () => {
  await createProject("priv", { title: "Private" });
  await setProjectAuth("priv", { private: true, tokens: { "tok-r": { role: "read", identity: "reader" } } });
  // 私有：無 token 讀 → 401
  const noRead = await authorize(reqWith(null), { project: "priv", need: "read" });
  assert.equal(noRead.ok, false);
  assert.equal(noRead.status, 401);
  // 私有：read token 讀 → 放行
  const okRead = await authorize(reqWith("tok-r"), { project: "priv", need: "read" });
  assert.equal(okRead.ok, true);
  assert.equal(okRead.role, "read");
  // 非私有（proja）讀取仍公開（無 token 也可讀）
  const pub = await authorize(reqWith(null), { project: "proja", need: "read" });
  assert.equal(pub.ok, true);
  assert.equal(pub.role, "public");
  // 預設專案（無 auth 設定）讀取公開
  const def = await authorize(reqWith(null), { project: "default", need: "read" });
  assert.equal(def.ok, true);
});

/* ---------- writer 防偽：變更日誌 writer 由 token 反查，非呼叫端自報 ---------- */
test("writer 防偽：mcp-http 帶 token 寫入→changelog writer=token 對應 identity", async () => {
  const before = await readStore("proja");
  const r = await callTool("tok-a-write", "add_card", { label: "來自 alice 的卡", project: "proja" });
  assert.equal(r.status, 200);
  assert.ok(!r.json.result.isError, "帶正確 token 應寫入成功");
  const entry = lastChangelogEntry("proja");
  assert.equal(entry.writer, "alice", "changelog writer 應為 token 對應 identity，不可偽造");
  assert.equal(entry.project, "proja");
  // 卡片確實寫入（rev 遞增）
  const after = await readStore("proja");
  assert.equal(after.rev, (before?.rev || 0) + 1);
});

test("writer 防偽：mcp-http 錯誤 token 寫入→401 且不落盤", async () => {
  const before = await readStore("proja");
  const r = await callTool("bad-token", "add_card", { label: "不該存在", project: "proja" });
  assert.equal(r.status, 401);
  assert.ok(r.json.error, "應回 JSON-RPC error");
  const after = await readStore("proja");
  assert.equal(after.rev, before.rev, "未授權寫入不得改變 rev");
});

/* ---------- 全域 ROADMAP_TOKEN（legacy）向後相容 ---------- */
test("全域 ROADMAP_TOKEN：未設 per 專案 token 的專案沿用 legacy（讀公開、寫需全域 token）", async () => {
  await createProject("plain", { title: "Plain" }); // 無 per 專案 token 設定
  process.env.ROADMAP_TOKEN = "global-secret";
  try {
    // 讀取仍公開
    const rd = await authorize(reqWith(null), { project: "plain", need: "read" });
    assert.equal(rd.ok, true);
    // 寫入需對的全域 token
    const noTok = await authorize(reqWith(null), { project: "plain", need: "write" });
    assert.equal(noTok.status, 401);
    const wrong = await authorize(reqWith("nope"), { project: "plain", need: "write" });
    assert.equal(wrong.status, 401);
    const ok = await authorize(reqWith("global-secret"), { project: "plain", need: "write" });
    assert.equal(ok.ok, true);
    assert.equal(ok.role, "admin"); // 全域 token＝admin override（操作者總控）
    assert.equal(ok.writer, null); // 不強加 identity ⇒ 沿用預設 writer
  } finally {
    delete process.env.ROADMAP_TOKEN;
  }
});

/* ---------- admin 工具（建立專案）經 mcp-http 授權 ---------- */
test("admin 工具經 mcp-http：預設專案設 admin token 後，create_project 需該 token", async () => {
  // 以預設專案的 auth 當「伺服器管理」閘門（create/rename/delete 不吃 project 參數→落 default）
  await setProjectAuth("default", { tokens: { "srv-admin": { role: "admin", identity: "root" } } });
  try {
    // 無 token → 401
    const denied = await callTool(null, "create_project", { id: "byadmin" });
    assert.equal(denied.status, 401);
    // 有 admin token → 成功
    const ok = await callTool("srv-admin", "create_project", { id: "byadmin", title: "由 admin 建" });
    assert.equal(ok.status, 200);
    assert.ok(!ok.json.result.isError, "admin token 應可建立專案");
  } finally {
    await setProjectAuth("default", null); // 還原：不影響其他測試檔／後續
  }
});

/* ---------- 通道專案綁定（2026-07-26 使用者回報：對話 agent 把卡建去別的專案） ---------- */
test("chatProject 綁定：省略 project＝落綁定專案；明確指定者優先", async () => {
  await createProject("bindproj", { title: "綁定測試" });
  const nodesOf = (d) => (Array.isArray(d?.pages) ? d.pages : [{ nodes: d?.nodes || [] }])
    .flatMap((p) => p.nodes || []);
  // 帶 chatProject 的連線：add_card 未指定 project → 卡落 bindproj
  const r1 = await invokeMcp(mcp, { token: null, url: "/mcp?chat=c1&chatProject=bindproj",
    rpc: { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "add_card", arguments: { label: "綁定落點卡" } } } });
  assert.equal(r1.status, 200);
  assert.ok(!r1.json.result.isError, `add_card 應成功：${r1.json.result?.content?.[0]?.text}`);
  const bound = nodesOf(await readStore("bindproj"));
  assert.ok(bound.some((n) => n.data?.label === "綁定落點卡"), "卡應落在綁定專案 bindproj");
  // 明確指定 project=default → 尊重指定，不被綁定蓋掉
  const r2 = await invokeMcp(mcp, { token: null, url: "/mcp?chat=c1&chatProject=bindproj",
    rpc: { jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "add_card", arguments: { label: "明確指定卡", project: "default" } } } });
  assert.equal(r2.status, 200);
  const dflt = nodesOf(await readStore("default"));
  assert.ok(dflt.some((n) => n.data?.label === "明確指定卡"), "明確指定 default 應落 default");
  const boundAgain = nodesOf(await readStore("bindproj"));
  assert.ok(!boundAgain.some((n) => n.data?.label === "明確指定卡"), "明確指定不應落綁定專案");
});
