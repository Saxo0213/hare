// 入職系統 M1（B8）：專案入口卡（G0）萃取與過期偵測 ＋ stdio 首次注入端到端。
// 隔離沿既有慣例（claim/listtasks.test）：HARE_DATA_PATH 指暫存檔、先設 env 再 dynamic import。
// 純函式（findEntryCard/entryDigestOf）直接以記憶體資料測；entryInfo 的 behind_revs 用暫存假
// changelog；buildInstructions 走暫存 store。JSON-RPC 實跑自備暫存板（含 G0 入口卡）——
// 測試必須在任何 clone 上都成立，不能依賴 repo 根剛好有哪一份白板。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TMP = join(tmpdir(), `hare-onboarding-test-${process.pid}.json`);
const TMP_LOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
// stdio 子行程專用板：與 TMP 分開，避免同檔互相干擾
const TMP_RPC = join(tmpdir(), `hare-onboarding-rpc-${process.pid}.json`);
const TMP_RPC_LOG = TMP_RPC.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { findEntryCard, entryDigestOf, entryInfo, buildInstructions, INSTRUCTIONS } =
  await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP_LOG, { force: true });
  await rm(TMP_RPC, { force: true });
  await rm(TMP_RPC_LOG, { force: true });
});

/* ---------- findEntryCard ---------- */
test("findEntryCard：跨頁找到 G0 非泳道卡（大小寫不敏感、泳道排除）", () => {
  const data = { pages: [
    { id: "p1", name: "主板", nodes: [{ id: "x", type: "note", data: { num: "B1" } }] },
    { id: "p2", name: "導覽", nodes: [
      { id: "lane1", type: "lane", data: { num: "G0" } }, // 泳道叫 G0 也不算
      { id: "g", type: "note", data: { num: "g0", desc: "摘要\n\n細節" } }] },
  ] };
  const f = findEntryCard(data);
  assert.ok(f);
  assert.equal(f.node.id, "g");
  assert.equal(f.page.name, "導覽");
});
test("findEntryCard：無 G0 回 null", () => {
  assert.equal(findEntryCard({ pages: [{ nodes: [{ id: "a", type: "note", data: { num: "B1" } }] }] }), null);
});

/* ---------- entryDigestOf ---------- */
test("entryDigestOf：取首段（到第一個空行為止，保留段內單換行）", () => {
  assert.equal(entryDigestOf("第一段\n第一段續\n\n第二段"), "第一段\n第一段續");
});
test("entryDigestOf：超過 300 字截斷加省略號", () => {
  const d = entryDigestOf("字".repeat(400));
  assert.equal([...d].length, 301); // 300 + 「…」
  assert.ok(d.endsWith("…"));
});
test("entryDigestOf：CJK/emoji 以 code point 計數不切壞", () => {
  const d = entryDigestOf("😀".repeat(350));
  assert.equal([...d].length, 301);
  assert.ok(d.endsWith("…"));
});
test("entryDigestOf：空/undefined 安全回空字串", () => {
  assert.equal(entryDigestOf(undefined), "");
  assert.equal(entryDigestOf(""), "");
});

/* ---------- entryInfo（behind_revs 用暫存假 changelog）---------- */
test("entryInfo：behind_revs 由 changelog 算過期、stale=behind>30", async () => {
  const cardId = "mcp_entry_1";
  await writeFile(TMP_LOG, [
    JSON.stringify({ t: "x", rev: 90, note: "unrelated" }),
    JSON.stringify({ t: "x", rev: 100, ids: [cardId] }),   // 最新一筆含卡 id
    JSON.stringify({ t: "x", rev: 130, note: "later, no card id" }),
  ].join("\n") + "\n", "utf8");
  const data = { rev: 140, pages: [{ name: "導覽", nodes: [
    { id: cardId, type: "note", data: { num: "G0", label: "導覽", desc: "摘要\n\n更多" } }] }] };
  const info = entryInfo(data); // 預設專案 → changelogPathFor 用 HARE_DATA_PATH → TMP_LOG
  assert.equal(info.num, "G0");
  assert.equal(info.page, "導覽");
  assert.equal(info.digest, "摘要");
  assert.equal(info.behind_revs, 40);
  assert.equal(info.stale, true);
});
test("entryInfo：changelog 掃不到卡 id → behind_revs/stale 皆 null", async () => {
  await writeFile(TMP_LOG, JSON.stringify({ t: "x", rev: 5, nodes: 10 }) + "\n", "utf8");
  const data = { rev: 9, pages: [{ name: "導覽", nodes: [
    { id: "mcp_absent", type: "note", data: { num: "G0", desc: "只有摘要" } }] }] };
  const info = entryInfo(data);
  assert.equal(info.behind_revs, null);
  assert.equal(info.stale, null);
  assert.equal(info.digest, "只有摘要");
});
test("entryInfo：無 G0 → null", () => {
  assert.equal(entryInfo({ rev: 1, pages: [{ nodes: [] }] }), null);
});

/* ---------- buildInstructions（能力觸發，不載入專案背景）---------- */
test("buildInstructions：無資料檔仍回靜態能力觸發", async () => {
  await rm(TMP, { force: true }); // 確保 store 檔不存在
  assert.equal(await buildInstructions(), INSTRUCTIONS);
});
test("buildInstructions：即使有 G0 也只回能力觸發，不附 Project brief", async () => {
  await writeStore({ nodes: [
    { id: "g0n", type: "note", position: { x: 0, y: 0 },
      data: { num: "G0", label: "導覽", desc: "這是專案簡報\n\n其餘細節" } },
  ], edges: [] }, "test-seed", { allowEmpty: true });
  const s = await buildInstructions();
  assert.equal(s, INSTRUCTIONS, "instructions 就是靜態能力觸發，不動態附 brief");
  assert.ok(!s.includes("[Project brief"), "不附 G0 brief（語意由首次注入承接）");
  assert.ok(s.includes("must use HARE"), "能力觸發明確要求使用 HARE");
  assert.ok(s.includes("directed relationship map"), "能力觸發明確指定輸出型態");
});

/* ---------- JSON-RPC 實跑（真實 roadmap-data.json，唯讀）---------- */
test("JSON-RPC：initialize 能力觸發 → 首個工具注入 guide → 二次不注入 → get_overview.entry", async () => {
  // 自備一份最小白板：一張 G0 入口卡就夠 get_overview.entry 成立。
  await writeFile(TMP_RPC, JSON.stringify({ rev: 1, nodes: [
    { id: "g0", type: "note", position: { x: 0, y: 0 },
      data: { num: "G0", label: "入口", desc: "摘要段\n\n細節段" } },
  ], edges: [] }), "utf8");
  const env = { ...process.env };
  for (const k of ["HARE_DATA_DIR", "BANLU_DATA_PATH", "BANLU_DATA_DIR"]) delete env[k];
  env.HARE_DATA_PATH = TMP_RPC;
  const child = spawn(process.execPath, ["mcp-server.mjs"], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });

  const responses = new Map();
  const waiters = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null) {
        responses.set(msg.id, msg);
        const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); }
      }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = (id, ms = 8000) => new Promise((res, rej) => {
    if (responses.has(id)) return res(responses.get(id));
    const to = setTimeout(() => rej(new Error(`等待 id=${id} 逾時；stderr=${stderr}`)), ms);
    waiters.set(id, (m) => { clearTimeout(to); res(m); });
  });

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor(1);
    assert.ok(!init.result.instructions.includes("[Project brief"),
      "initialize instructions 不應再含 G0 brief（D18 憲法-only）");
    assert.equal(init.result.instructions, INSTRUCTIONS,
      "initialize instructions 應只含靜態能力觸發");

    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_cards", arguments: {} } });
    const r2 = await waitFor(2);
    assert.ok(r2.result.content[0].text.startsWith("[HARE guide"),
      "首個非 get_overview 工具回應應以 [HARE guide 開頭");

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_cards", arguments: {} } });
    const r3 = await waitFor(3);
    assert.ok(!r3.result.content[0].text.startsWith("[HARE guide"),
      "第二次呼叫不應再注入");

    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_overview", arguments: {} } });
    const r4 = await waitFor(4);
    const ov = JSON.parse(r4.result.content[0].text);
    assert.equal(ov.entry?.num, "G0", "get_overview.entry.num 應為 G0");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
