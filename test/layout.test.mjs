// B4 add_card 自動排版回歸測試：省略 x/y 時依 skill 落格（頂層卡落依賴欄下一空列、
// 子卡於兄弟下方堆疊），且明確給 x/y 仍原樣尊重。零依賴；HARE_DATA_PATH 隔離到暫存檔。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-layout-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, readStore } = await import("../lib/store.mjs");
const {
  X0, Y0, COL_PITCH, CARD_W, ROW_PITCH, ROW_PITCH_TALL,
  CHILD_X, CHILD_Y0, CHILD_PITCH, placeTopLevel, placeChild, placeAfter, isTall, gridOf,
  computeLayers, layoutAnchor, preserveLockedPositions,
} = await import("../lib/layout.mjs");

const CTX = { writer: "test" };
const call = (name, args = {}) => TOOLS[name].run(args, CTX);

// 種子：一條泳道 + 欄 0 既有一張 B1(60,100) + 一個容器 CT 含一張子卡 CH(16,60)。
function seedBoard() {
  return {
    nodes: [
      { id: "L1", type: "lane", position: { x: -40, y: -50 }, data: { title: "測試泳道" } },
      { id: "B1", type: "note", position: { x: X0, y: 100 },
        data: { num: "B1", label: "根卡", status: "real", desc: "第 0 層" } },
      { id: "CT", type: "note", position: { x: 1500, y: 400 },
        data: { num: "CT", label: "容器" } },
      { id: "CH", type: "note", position: { x: CHILD_X, y: CHILD_Y0 }, parentId: "CT", extent: "parent",
        data: { num: "CH", label: "既有子卡" } },
    ],
    edges: [],
  };
}
async function seed() { await writeStore(seedBoard(), "test-seed", { allowEmpty: true }); }
beforeEach(seed);
after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
});

// 兩張卡是否重疊（軸對齊矩形，標準卡寬高估）：水平間距 < CARD_W 且垂直間距 < 估計高度。
function overlaps(a, b, h = 300) {
  return Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < h;
}

/* ---------- 頂層卡：省略 x/y 落最左欄下一空列，不與既有卡重疊 ---------- */

test("頂層卡省略 x/y：落欄 0（x=X0），y 在既有同欄卡下方一個列距，不重疊", async () => {
  // 既有欄 0 只有 B1(60,100)，非內容多卡 → 新卡應在 60,100+ROW_PITCH
  const r = await call("add_card", { label: "新頂層卡", type: "note" });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.equal(pos.x, X0, "x 落在第 0 欄格線");
  assert.equal(pos.y, 100 + ROW_PITCH, "y = 既有最低卡 y + ROW_PITCH");
  // 與既有 B1 不重疊
  const b1 = (await call("get_card", { card: "B1", fields: ["position"] })).position;
  assert.ok(!overlaps(pos, b1), "與 B1 不重疊");
  // x 落在 460 格線交點上（layer * COL_PITCH + X0）
  assert.equal((pos.x - X0) % COL_PITCH, 0, "x 在 460 格線上");
});

test("頂層卡連續兩張省略 x/y：垂直堆疊、彼此不重疊", async () => {
  const a = await call("add_card", { label: "A", type: "note" });
  const b = await call("add_card", { label: "B", type: "note" });
  const pa = (await call("get_card", { card: a.card.id, fields: ["position"] })).position;
  const pb = (await call("get_card", { card: b.card.id, fields: ["position"] })).position;
  assert.equal(pa.x, X0);
  assert.equal(pb.x, X0);
  assert.ok(pb.y > pa.y, "第二張在第一張下方");
  assert.ok(!overlaps(pa, pb), "兩張不重疊");
});

test("空欄（僅泳道）：頂層卡落 X0/Y0", () => {
  const pos = placeTopLevel([{ id: "L", type: "lane", position: { x: 0, y: 0 } }], []);
  assert.deepEqual(pos, { x: X0, y: Y0 });
});

/* ---------- 子卡：省略 x/y 於兄弟卡下方堆疊，x=16 留白 ---------- */

test("子卡省略 x/y：x=16、y 在最低兄弟下方一個 CHILD_PITCH", async () => {
  // CT 已有 CH(16,60) → 新子卡應為 (16, 60+CHILD_PITCH)
  const r = await call("add_card", { label: "新子卡", type: "note", parentId: "CT" });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.equal(pos.x, CHILD_X, "x 固定 16 留左緣padding");
  assert.equal(pos.y, CHILD_Y0 + CHILD_PITCH, "y 在既有子卡下方一個 CHILD_PITCH");
  // 與既有兄弟 CH 不重疊（子卡較矮，估計高度 80）
  const ch = (await call("get_card", { card: "CH", fields: ["position"] })).position;
  assert.ok(Math.abs(pos.y - ch.y) >= CHILD_PITCH, "與兄弟至少隔一個 CHILD_PITCH");
});

test("容器無子卡：第一張子卡落 (16, CHILD_Y0)", () => {
  const pos = placeChild([{ id: "P", type: "note", position: { x: 0, y: 0 } }], "P");
  assert.deepEqual(pos, { x: CHILD_X, y: CHILD_Y0 });
});

test("子卡依實際底緣排列：高兄弟卡不會被固定 CHILD_PITCH 疊住", () => {
  const sibling = {
    id: "CH", type: "note", parentId: "P", position: { x: CHILD_X, y: CHILD_Y0 },
    measured: { width: 240, height: 240 }, data: {},
  };
  const pos = placeChild([sibling], "P");
  assert.equal(pos.y, CHILD_Y0 + 240 + 16, "下一張落在實際底緣後 16px");
  assert.ok(pos.y >= sibling.position.y + sibling.measured.height, "不與高兄弟卡重疊");
});

/* ---------- 向後相容：明確 x/y 仍原樣尊重 ---------- */

test("明確給 x/y：原樣尊重，不自動落格", async () => {
  const r = await call("add_card", { label: "手動座標", type: "note", x: 777, y: 888 });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.deepEqual(pos, { x: 777, y: 888 });
});

test("只給 x（省略 y）：尊重 x，y 回退舊預設 120（不觸發自動落格）", async () => {
  const r = await call("add_card", { label: "只給x", type: "note", x: 555 });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.deepEqual(pos, { x: 555, y: 120 });
});

/* ---------- 內容多卡：下一張用較大列距（ROW_PITCH_TALL） ---------- */

test("isTall：陣列／時間戳 dict 任務皆按 taskCount 判斷內容量", () => {
  assert.equal(isTall({ type: "note", data: { tasks: ["a", "b", "c", "d"] } }), true);
  assert.equal(isTall({ type: "note", data: { tasks: {
    "2026-01-01T00:00:00.000Z": "a", "2026-01-01T00:00:00.001Z": "b",
    "2026-01-01T00:00:00.002Z": "c", "2026-01-01T00:00:00.003Z": "d",
  } } }), true);
  assert.equal(isTall({ type: "note", data: { desc: "x".repeat(121) } }), true);
  assert.equal(isTall({ type: "note", data: { desc: "有", tasks: ["一"] } }), true);
  assert.equal(isTall({ type: "note", data: { desc: "短", tasks: [] } }), false);
});

test("既有最低卡為內容多卡時，新卡改用 ROW_PITCH_TALL 間距", () => {
  const nodes = [
    { id: "L", type: "lane", position: { x: 0, y: 0 } },
    { id: "T", type: "note", position: { x: X0, y: 200 },
      data: { tasks: ["a", "b", "c", "d", "e"] } }, // 內容多
  ];
  const pos = placeTopLevel(nodes, []);
  assert.deepEqual(pos, { x: X0, y: 200 + ROW_PITCH_TALL });
});

/* ---------- 每專案格線設定（B4：meta.layout 覆寫） ---------- */

test("gridOf：meta.layout 逐鍵覆寫，未設鍵與型別不對的鍵落回預設", () => {
  const g = gridOf({ layout: { x0: 100, rowPitch: 200, colPitch: "壞值", childPitch: NaN } });
  assert.equal(g.x0, 100, "覆寫生效");
  assert.equal(g.rowPitch, 200, "覆寫生效");
  assert.equal(g.colPitch, COL_PITCH, "型別不對落回預設");
  assert.equal(g.childPitch, CHILD_PITCH, "NaN 落回預設");
  assert.equal(g.y0, Y0, "未設鍵用預設");
  assert.deepEqual(gridOf(null), gridOf({}), "無 meta＝預設格線");
});

test("add_card 依 meta.layout 落格：空板首卡落在覆寫後的 x0/y0", async () => {
  await writeStore({
    nodes: [{ id: "L1", type: "lane", position: { x: 0, y: 0 }, data: { title: "泳道" } }],
    edges: [], meta: { layout: { x0: 500, y0: 30 } },
  }, "test-seed", { allowEmpty: true });
  const r = await call("add_card", { label: "格線覆寫卡", type: "note" });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.deepEqual(pos, { x: 500, y: 30 }, "落在專案自訂格線原點");
});

/* ---------- after=<卡>：增量落點（建卡→建線→碰撞讓位，既有卡不動） ---------- */

test("after 頂層卡＋下游欄無卡：落右一欄同列，並自動建線 r→l", async () => {
  const r = await call("add_card", { label: "下游卡", type: "note", after: "B1" });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.deepEqual(pos, { x: X0 + COL_PITCH, y: 100 }, "B1(60,100) 右一欄、同列對齊");
  assert.ok(r.edge, "回應帶自動建立的線");
  assert.equal(r.edge.target, r.card.id, "線終點＝新卡");
  const raw = await readStore();
  const e = raw.edges.find((x) => x.id === r.edge.id);
  assert.equal(e.source, "B1", "線起點＝after 卡");
  assert.equal(e.sourceHandle, "r", "頂層走右出");
  assert.equal(e.targetHandle, "l", "頂層走左進");
});

test("after 同一張卡連兩次：第二張被碰撞讓位，不與第一張重疊、既有卡全不動", async () => {
  const a = await call("add_card", { label: "下游A", type: "note", after: "B1" });
  const b = await call("add_card", { label: "下游B", type: "note", after: "B1" });
  const pa = (await call("get_card", { card: a.card.id, fields: ["position"] })).position;
  const pb = (await call("get_card", { card: b.card.id, fields: ["position"] })).position;
  assert.ok(!overlaps(pa, pb, 240), "兩張下游卡不重疊");
  const b1 = (await call("get_card", { card: "B1", fields: ["position"] })).position;
  assert.deepEqual(b1, { x: X0, y: 100 }, "after 卡（既有卡）不被推動");
  assert.deepEqual(pa, { x: X0 + COL_PITCH, y: 100 }, "第一張佔走初始位不被第二張推動");
});

test("after＋明確 x/y：座標原樣尊重，只建線", async () => {
  const r = await call("add_card", { label: "手動下游", type: "note", after: "B1", x: 999, y: 111 });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.deepEqual(pos, { x: 999, y: 111 });
  assert.ok(r.edge && r.edge.target === r.card.id, "線照建");
});

test("after 容器內子卡：新卡繼承父容器成兄弟、落正下方、編號承父號", async () => {
  const r = await call("add_card", { label: "子卡下游", type: "note", after: "CH" });
  const pos = (await call("get_card", { card: r.card.id, fields: ["position"] })).position;
  assert.equal(pos.x, CHILD_X, "容器內垂直堆疊：x 沿 after 卡");
  assert.ok(pos.y > CHILD_Y0, "落 after 卡下方");
  assert.match(r.card.num, /^CT-\d+$/, "編號＝父號-序號（證明繼承 CT 為父）");
  const raw = await readStore();
  const e = raw.edges.find((x) => x.target === r.card.id);
  assert.equal(e.source, "CH", "線起點＝after 子卡");
  assert.equal(e.sourceHandle, undefined, "容器內不指定端點側");
});

test("after 與 parentId 不同層：拒絕", async () => {
  await assert.rejects(
    call("add_card", { label: "矛盾卡", type: "note", after: "B1", parentId: "CT" }),
    /不同層/);
});

test("after 找不到目標卡：拒絕", async () => {
  await assert.rejects(
    call("add_card", { label: "斷鏈卡", type: "note", after: "不存在" }),
    /找不到 after/);
});

test("placeAfter 純函數：初始位被固定卡佔住＝沿最短分離軸讓位，回傳不重疊座標", () => {
  const afterNode = { id: "U", type: "note", position: { x: X0, y: 100 } };
  const occupied = { id: "O", type: "note", position: { x: X0 + COL_PITCH, y: 100 },
    measured: { width: 360, height: 240 } };
  const pos = placeAfter([afterNode, occupied], afterNode);
  assert.ok(!overlaps(pos, occupied.position, 240), "與佔位卡不重疊");
});

test("layoutAnchor：錨居中，下游往右分層、上游往左分層、同層對錨垂直置中", () => {
  const items = [
    { id: "A", w: 200, h: 100 }, { id: "B", w: 200, h: 100 }, { id: "C", w: 200, h: 100 },
    { id: "D", w: 200, h: 100 }, { id: "E", w: 200, h: 100 },
  ];
  // A=錨；A→B, A→C（下游）；D→A, E→A（上游）
  const edges = [{ source: "A", target: "B" }, { source: "A", target: "C" },
    { source: "D", target: "A" }, { source: "E", target: "A" }];
  const { pos, anchorAt } = layoutAnchor(items, edges, "A", { colGap: 100, rowGap: 40 });
  const x = (id) => pos.get(id).x;
  assert.ok(x("D") < x("A") && x("E") < x("A"), "上游在錨左側");
  assert.ok(x("B") > x("A") && x("C") > x("A"), "下游在錨右側");
  assert.equal(x("B"), x("C"), "同層同 x");
  assert.equal(x("D"), x("E"), "同層同 x");
  assert.deepEqual(anchorAt, pos.get("A"), "anchorAt＝錨位");
  // 同層兩卡對「錨中心」上下對稱堆疊
  const cy = (id) => pos.get(id).y + 50;      // 卡高 100 → 中心 = y+50
  assert.ok(Math.abs((cy("B") + cy("C")) / 2 - cy("A")) < 2, "下游層對錨中心置中");
});

test("layoutAnchor：孤立卡（無邊）接在最右層外、不與主結構重疊", () => {
  const items = [{ id: "A", w: 100, h: 80 }, { id: "B", w: 100, h: 80 }, { id: "X", w: 100, h: 80 }];
  const { pos } = layoutAnchor(items, [{ source: "A", target: "B" }], "A", {});
  assert.ok(pos.get("X").x > pos.get("B").x, "孤立卡在下游之外");
});

test("computeLayers：最長路徑分層且環壓成同一 SCC", () => {
  const nodes = ["A", "B", "C", "D"].map((id) => ({ id, type: "note", data: { status: "plan" } }));
  const dag = computeLayers(nodes, [
    { source: "A", target: "D" }, { source: "A", target: "B" },
    { source: "B", target: "C" }, { source: "C", target: "D" },
  ]);
  assert.deepEqual(Object.fromEntries(dag), { A: 0, B: 1, C: 2, D: 3 }, "捷徑不會把 D 拉回短路徑層");
  const cyc = computeLayers(nodes.slice(0, 2), [
    { source: "A", target: "B" }, { source: "B", target: "A" },
  ]);
  assert.equal(cyc.get("A"), cyc.get("B"), "同一有向環壓成同層");
});

test("layoutAnchor：捷徑＋長路徑仍保持每條跨層邊由左向右", () => {
  const items = ["A", "B", "C", "D"].map((id) => ({ id, w: 160, h: 80 }));
  const edges = [
    { source: "A", target: "D" }, { source: "A", target: "B" },
    { source: "B", target: "C" }, { source: "C", target: "D" },
  ];
  const { pos } = layoutAnchor(items, edges, "A", { colGap: 100, rowGap: 40 });
  const cx = (id) => pos.get(id).x + 80;
  for (const e of edges) assert.ok(cx(e.source) < cx(e.target), `${e.source}→${e.target} 應由左向右`);
});

test("preserveLockedPositions：鎖定卡恢復原座標，未鎖定卡保留排版結果", () => {
  const pos = new Map([
    ["L", { x: 500, y: 500 }],
    ["M", { x: 600, y: 600 }],
  ]);
  const out = preserveLockedPositions(pos, [
    { id: "L", position: { x: 10, y: 20 }, data: { locked: true } },
    { id: "M", position: { x: 30, y: 40 }, data: { locked: false } },
  ]);
  assert.deepEqual(out.get("L"), { x: 10, y: 20 }, "鎖定卡不移動");
  assert.deepEqual(out.get("M"), { x: 600, y: 600 }, "未鎖定卡使用新位置");
  assert.deepEqual(pos.get("L"), { x: 500, y: 500 }, "不修改原 Map");
});

test("layoutAnchor 通道檢討：稠密圖排完卡片互不重疊、回傳定案 sides", () => {
  // A=錨；扇出 B,C,D（下游層1）＋跨層 A→E、C→E、D→E（層2），另 F,G 也接 A
  const items = ["A", "B", "C", "D", "E", "F", "G"].map((id) => ({ id, w: 200, h: 120 }));
  const edges = [
    { source: "A", target: "B" }, { source: "A", target: "C" }, { source: "A", target: "D" },
    { source: "A", target: "F" }, { source: "A", target: "G" },
    { source: "B", target: "E" }, { source: "C", target: "E" }, { source: "D", target: "E" },
    { source: "A", target: "E" },
  ];
  const { pos, sides } = layoutAnchor(items, edges, "A", { colGap: 120, rowGap: 40 });
  assert.ok(sides instanceof Map && sides.size === edges.length, "每條邊都有定案端點側");
  // 任兩卡 AABB 不重疊（含 8px 容差）——通道檢討後「不疊在一起」
  const ids = items.map((it) => it.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = pos.get(ids[i]), b = pos.get(ids[j]), da = items[i], db = items[j];
      const ox = Math.min(a.x + da.w, b.x + db.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + da.h, b.y + db.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 8 || oy <= 8, `${ids[i]} 與 ${ids[j]} 不應重疊（ox=${ox} oy=${oy}）`);
    }
  }
});
