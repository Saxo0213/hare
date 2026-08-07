// import_mermaid（S7-5，2026-07-18）：Mermaid flowchart 子集 → 新分頁卡片＋連線。
// 隔離沿 listtasks.test 慣例：HARE_DATA_PATH 指暫存檔、先設 env 再 dynamic import。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-mermaid-test-${process.pid}.json`);
process.env.HARE_DATA_PATH = TMP;

const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, readStore } = await import("../lib/store.mjs");

const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });

beforeEach(() => writeStore({
  nodes: [{ id: "T1", type: "note", position: { x: 0, y: 0 },
    data: { num: "T1", label: "既有卡", status: "note" } }],
  edges: [],
}, "test-seed", { allowEmpty: true }));
after(async () => {
  await rm(TMP, { force: true });
  await rm(TMP.replace(/\.json$/i, "-changelog.jsonl"), { force: true });
});

const SRC = `graph TD
  %% 這行是註解，應跳過
  A[使用者] -->|操作| B(白板)
  B --> C
  C[Agent]
  subgraph 不支援的區塊
  D --> E
  end
`;

test("import_mermaid：節點/連線/標籤/註解解析＋建新頁＋不支援語法回報", async () => {
  const r = await call("import_mermaid", { text: SRC, name: "MM測試" });
  assert.equal(r.ok, true);
  assert.equal(r.page, "MM測試");
  assert.equal(r.cards, 5); // A B C D E
  assert.equal(r.edges, 3); // A->B B->C D->E
  // subgraph/end 兩行不支援 → 誠實回報（D --> E 是合法連線，不在 skipped）
  assert.deepEqual(r.skipped, ["subgraph 不支援的區塊", "end"]);
  assert.ok(r.note && r.note.includes("TD"), "非 LR 方向要註記");

  const data = await readStore();
  const pg = data.pages.find((p) => p.name === "MM測試");
  assert.ok(pg, "新分頁存在");
  const labels = pg.nodes.map((n) => n.data.label);
  assert.ok(labels.includes("使用者") && labels.includes("白板") && labels.includes("Agent"));
  assert.ok(labels.includes("D") && labels.includes("E"), "無標籤節點以 key 為題");
  // 邊標籤保留；位置經 layoutLayered（不全部疊在同一點）
  const lbl = pg.edges.find((e) => e.label === "操作");
  assert.ok(lbl, "連線標籤保留");
  const xs = new Set(pg.nodes.map((n) => n.position.x));
  assert.ok(xs.size > 1, "分層排版：至少兩欄");
  // 既有頁不受影響
  const first = data.pages[0];
  assert.ok(first.nodes.some((n) => n.data?.num === "T1"), "原頁卡片保留");
});

test("import_mermaid：撞名分頁拒絕、解析不到節點拒絕", async () => {
  await call("import_mermaid", { text: "graph LR\nA-->B", name: "撞名頁" });
  await assert.rejects(() => call("import_mermaid", { text: "graph LR\nA-->B", name: "撞名頁" }),
    /分頁已存在/);
  await assert.rejects(() => call("import_mermaid", { text: "%% 只有註解" }), /解析不到任何節點/);
});
