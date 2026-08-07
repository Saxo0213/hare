// add_cards（批次建卡＋拉線，B10，2026-07-22）回歸測試：單元＋JSON-RPC 實跑。
// 單一 rev、批內 key wiring、先引用後定義報錯、混用 key 與既有卡號、cat 自動連號、
// 整批失敗不落半套、上限防呆、refs hint 彙整。零依賴；HARE_DATA_PATH 隔離到暫存檔。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const TMP = join(tmpdir(), `hare-addcards-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
const DATA_DIR = join(tmpdir(), `hare-addcards-test-dir-${process.pid}`);
process.env.HARE_DATA_PATH = TMP;
process.env.HARE_DATA_DIR = DATA_DIR;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");

const CTX = { writer: "test" };
const call = (name, args = {}) => TOOLS[name].run(args, CTX);

// 種子：P1(real)→P2 依賴鏈 + 容器 CT。用於「混用 key 與既有卡號」測試。
function seedBoard() {
  return {
    nodes: [
      { id: "P1", type: "note", position: { x: 1, y: 2 },
        data: { num: "P1", label: "Card One", status: "real" } },
      { id: "P2", type: "note", position: { x: 300, y: 2 },
        data: { num: "P2", label: "Card Two", status: "plan" } },
      { id: "CT", type: "note", position: { x: 0, y: 400 },
        data: { num: "CT", label: "Container", status: "plan" } },
    ],
    edges: [{ id: "e1", source: "P1", target: "P2" }],
  };
}
async function seed() { await writeStore(seedBoard(), "test-seed", { allowEmpty: true }); }
beforeEach(seed);
after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  await rm(DATA_DIR, { recursive: true, force: true });
});

/* ---------- 單元 ---------- */

test("add_cards：批內 key wiring（parent/after/edges 引用 key）＋單一 rev（前後差 1）", async () => {
  const before = (await call("get_overview")).rev;
  const r = await call("add_cards", {
    cards: [
      { key: "root", label: "根卡", cat: "K", status: "plan" },
      { key: "child", label: "子卡", parent: "root" },       // parent 引用批內 key
      { key: "next", label: "下游卡", after: "root" },        // after 引用批內 key（成線）
    ],
    edges: [
      { source: "child", target: "next", relation: "prerequisite", note: "wiring" }, // edges 引用批內 key
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.rev, before + 1, "整批單一 rev");
  // edges：after 成線 1 條 ＋ 顯式 edges 1 條 ＝ 2
  assert.equal(r.edges, 2);
  // 回傳列帶 key/num/id/label
  const byKey = Object.fromEntries(r.cards.map((c) => [c.key, c]));
  assert.equal(byKey.root.num, "K1");
  assert.equal(byKey.child.num, "K1-1", "子卡編號繼承父號-序");
  // parent 生效
  const child = await call("get_card", { card: byKey.child.num, fields: ["parentId"] });
  assert.equal(child.parentId, byKey.root.id);
  // after 成線 root→next ＋ 顯式 edge child→next：next 上游同時含 root(K1) 與 child(K1-1)
  const nextCard = await call("get_card", { card: byKey.next.num });
  assert.deepEqual(nextCard.rel.up.sort(), ["K1", "K1-1"], "next 上游含 root 與 child");
});

test("add_cards：edges relation/inferred 語意同 add_edge（tier 落章）", async () => {
  const r = await call("add_cards", {
    cards: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    edges: [{ source: "a", target: "b", relation: "imports", inferred: true, note: "guess" }],
  });
  assert.equal(r.ok, true);
  const list = await call("list_edges", {});
  const e = list.edges.find((x) => x.relation === "imports");
  assert.ok(e, "imports 邊存在");
  assert.equal(e.confidenceTier, "inferred", "inferred:true→tier inferred");
  assert.equal(e.evidenceSource, "mcp", "MCP transport→evidenceSource=mcp");
  assert.equal(e.note, "guess", "note 落入 evidence");
});

test("add_cards：完整 edges 建好後自動分層，agent 不必提供 x/y", async () => {
  const r = await call("add_cards", {
    cards: [
      { key: "a", label: "自排 A", cat: "L" },
      { key: "b", label: "自排 B", cat: "L" },
      { key: "c", label: "自排 C", cat: "L" },
    ],
    edges: [
      { source: "a", target: "c" },
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  });
  const byKey = Object.fromEntries(r.cards.map((c) => [c.key, c]));
  const [a, b, c] = await Promise.all(["a", "b", "c"].map((key) =>
    call("get_card", { card: byKey[key].id, fields: ["position"] })));
  assert.ok(a.position.x < b.position.x && b.position.x < c.position.x,
    "完整批次關係決定最長路徑分層 A→B→C");
  assert.ok(a.position.y >= 0 && b.position.y >= 0 && c.position.y >= 0, "自動產生有效座標");
});

test("add_cards：既有卡與明示座標固定，關聯新卡自動落在下游", async () => {
  const r = await call("add_cards", {
    cards: [
      { key: "auto", label: "P2 下游自排" },
      { key: "manual", label: "人工定位", x: 1234, y: 567 },
    ],
    edges: [{ source: "P2", target: "auto" }],
  });
  const byKey = Object.fromEntries(r.cards.map((c) => [c.key, c]));
  const [p2, auto, manual] = await Promise.all([
    call("get_card", { card: "P2", fields: ["position"] }),
    call("get_card", { card: byKey.auto.id, fields: ["position"] }),
    call("get_card", { card: byKey.manual.id, fields: ["position"] }),
  ]);
  assert.deepEqual(p2.position, { x: 300, y: 2 }, "既有卡不被批次排版移動");
  assert.ok(auto.position.x > p2.position.x, "固定上游 P2 左於新卡");
  assert.deepEqual(manual.position, { x: 1234, y: 567 }, "明示座標原樣保留");
});

test("add_cards：先引用後定義＝報錯（forward key）", async () => {
  await assert.rejects(() => call("add_cards", {
    cards: [
      { key: "child", label: "子", parent: "root" }, // root 尚未定義
      { key: "root", label: "根" },
    ],
  }), /parent「root」找不到|先於引用/);
});

test("add_cards：混用批內 key 與既有卡號（parent 用既有 CT、after 用既有 P1、edge 跨批+既有）", async () => {
  const r = await call("add_cards", {
    cards: [
      { key: "inCT", label: "容器內卡", parent: "CT" },  // 既有卡號 CT
      { key: "afterP1", label: "P1 下游", after: "P1" },  // 既有卡號 P1
    ],
    edges: [
      { source: "P2", target: "afterP1" }, // 既有 P2 → 批內 key
    ],
  });
  assert.equal(r.ok, true);
  const byKey = Object.fromEntries(r.cards.map((c) => [c.key, c]));
  assert.equal(byKey.inCT.num, "CT-1", "落在既有容器 CT 內＝繼承 CT-序");
  const afterCard = await call("get_card", { card: byKey.afterP1.num });
  assert.deepEqual(afterCard.rel.up.sort(), ["P1", "P2"], "上游含既有 P1（after 成線）與 P2（顯式 edge）");
});

test("add_cards：cat 自動連號——同批多張同 cat 不撞（連續遞補）", async () => {
  const r = await call("add_cards", {
    cards: [
      { label: "甲", cat: "W" }, { label: "乙", cat: "W" }, { label: "丙", cat: "W" },
    ],
  });
  assert.deepEqual(r.cards.map((c) => c.num), ["W1", "W2", "W3"], "同批同 cat 連號");
});

test("add_cards：整批失敗不落半套（錯誤後板 rev 與卡數不變）", async () => {
  const before = await call("get_overview");
  await assert.rejects(() => call("add_cards", {
    cards: [
      { key: "ok1", label: "先建這張" },
      { label: "撞號卡", num: "P1" }, // 既有 P1 撞號→整批失敗
      { label: "不該建到" },
    ],
  }), /已存在/);
  const afterOv = await call("get_overview");
  assert.equal(afterOv.rev, before.rev, "rev 不變（未寫入）");
  assert.equal(afterOv.card_count, before.card_count, "卡數不變（半套未落地）");
  // ok1 不該存在
  const s = await call("search_cards", { query: "先建這張" });
  assert.equal(s.count, 0, "第一張也未落地");
});

test("add_cards：上限防呆——cards>50、edges>100 明確報錯；cards 空拒絕", async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ label: `c${i}` }));
  await assert.rejects(() => call("add_cards", { cards: many }), /上限 50/);
  const e101 = Array.from({ length: 101 }, () => ({ source: "P1", target: "P2" }));
  await assert.rejects(() => call("add_cards", { cards: [{ label: "x" }], edges: e101 }), /上限 100/);
  await assert.rejects(() => call("add_cards", { cards: [] }), /1–50|必須提供/);
});

test("add_cards：edge 端點找不到＝整批失敗；訊息指明第幾條", async () => {
  const before = await call("get_overview");
  await assert.rejects(() => call("add_cards", {
    cards: [{ key: "a", label: "A" }],
    edges: [{ source: "a", target: "沒這張" }],
  }), /第 1 條 edge.*target/);
  assert.equal((await call("get_overview")).rev, before.rev, "邊失敗也不落半套");
});

test("add_cards：重複批內 key 報錯", async () => {
  await assert.rejects(() => call("add_cards", {
    cards: [{ key: "dup", label: "一" }, { key: "dup", label: "二" }],
  }), /key「dup」重複/);
});

test("add_cards：refs uuid 缺錨 hint 彙整回報（不擋，整批照建）", async () => {
  const srcPath = join(tmpdir(), `addcards-mark-${process.pid}.mjs`);
  await writeFile(srcPath, "// HARE feedc0de present\nexport const x = 1;\n");
  const rel = basename(srcPath); // refBase＝資料檔所在目錄（tmpdir）
  try {
    const r = await call("add_cards", {
      cards: [
        { label: "有埋", status: "plan", refs: [{ path: rel, label: "present", uuid: "feedc0de" }] },
        { label: "缺埋甲", status: "plan", refs: [{ path: rel, label: "missA", uuid: "0badc0de" }] },
        { label: "缺埋乙", status: "plan", refs: [{ path: rel, label: "missB", uuid: "deadbea7" }] },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 3, "缺錨不擋，三張都建");
    assert.ok(r.hint, "有缺錨→回 hint");
    assert.ok(r.hint.includes("0badc0de") && r.hint.includes("deadbea7"), "兩個缺錨 uuid 都彙整");
    assert.ok(!r.hint.includes("feedc0de"), "已埋的不列入");
  } finally {
    await rm(srcPath, { force: true });
  }
});

/* ---------- JSON-RPC 實跑（暫存檔）：一發建 6 卡＋5 線含 relation ---------- */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("JSON-RPC：add_cards 一發建 6 卡＋5 線→rev+1、get_graph pack 可見結構", async () => {
  // 暫存板隔離（不碰真板）：spawn 前設環境變數，種一張無 G0 的板（避免首呼注入 guide 前綴）。
  await writeStore({ nodes: [], edges: [] }, "test-seed", { allowEmpty: true });
  const env = { ...process.env, HARE_DATA_PATH: TMP, HARE_DATA_DIR: DATA_DIR };
  for (const k of ["BANLU_DATA_PATH", "BANLU_DATA_DIR"]) delete env[k];
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
  const parseResult = (msg) => {
    const text = msg.result.content[0].text;
    return JSON.parse(text.slice(text.indexOf("{"))); // 去掉可能的 guide 前綴
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await waitFor(1);
    // 建線前先讀 rev
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_overview", arguments: {} } });
    const before = parseResult(await waitFor(2)).rev;
    // 一發 6 卡＋5 線（鏈：a→b→c→d→e→f，全 prerequisite）
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_cards", arguments: {
      cards: [
        { key: "a", label: "步驟A", cat: "S", status: "plan" },
        { key: "b", label: "步驟B", cat: "S", status: "plan" },
        { key: "c", label: "步驟C", cat: "S", status: "plan" },
        { key: "d", label: "步驟D", cat: "S", status: "plan" },
        { key: "e", label: "步驟E", cat: "S", status: "plan" },
        { key: "f", label: "步驟F", cat: "S", status: "plan" },
      ],
      edges: [
        { source: "a", target: "b", relation: "prerequisite" },
        { source: "b", target: "c", relation: "prerequisite" },
        { source: "c", target: "d", relation: "prerequisite" },
        { source: "d", target: "e", relation: "prerequisite" },
        { source: "e", target: "f", relation: "prerequisite" },
      ],
    } } });
    const r = parseResult(await waitFor(3));
    assert.equal(r.ok, true);
    assert.equal(r.count, 6, "建 6 卡");
    assert.equal(r.edges, 5, "建 5 線");
    assert.equal(r.rev, before + 1, "整批單一 rev（+1）");
    // get_graph pack 可見結構
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_graph", arguments: { view: "pack" } } });
    const g = parseResult(await waitFor(4));
    assert.ok(g.text.includes("S1") && g.text.includes("S6"), "pack 含首尾卡");
    assert.ok(g.text.includes("依賴: S1→S2"), "pack 依賴鏈可見");
    assert.ok(g.text.includes("critical: S1→S2→S3→S4→S5→S6"), "critical 全鏈");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
