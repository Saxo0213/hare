// B5 快照／回滾：整版（full-board）非破壞式快照，per 專案。
// 零依賴，純 node:fs——建構於 store.mjs 之上（readStore 讀現況、updateStore 寫回），
// 不改動 store.mjs 本身。
//
// 儲存格式：每專案一份 data/<projectId>-snapshots.jsonl（append-only，一列一筆快照）。
//   每列＝ { id, t, rev, writer, label, board }，board＝拍照當下的整版白板
//   { nodes, edges, meta, viewport, deletedEdges, constraints, rev }。
//   append-only ⇒ 歷史永不抹除；回滾＝把某列的 board 以「新 rev」重新寫回白板
//   （見 rollbackSnapshot），因此回滾本身也是一次可再被回滾的白板寫入。
//
// 路徑解析沿用 store.changelogPathFor 的 legacy／多專案規則（default 專案在
// HARE_DATA_PATH／data/default.json／repo 根 roadmap-*.jsonl 三態下都對得上），
// 只把後綴 -changelog.jsonl 換成 -snapshots.jsonl，避免重複那段解析邏輯。
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readStore, updateStore, changelogPathFor } from "./store.mjs";

// 快照檔絕對路徑：與變更日誌同目錄、同專案命名，後綴改 -snapshots.jsonl。
export function snapshotPathFor(project) {
  return changelogPathFor(project).replace(/-changelog\.jsonl$/i, "-snapshots.jsonl");
}

// 唯一快照 id：同毫秒多次呼叫也不撞號（沿用 tools.mjs 的單調序號手法）。
let idSeq = 0;
const freshSnapId = () => `snap_${Date.now()}_${(idSeq += 1)}`;

// 由 store 現況擷取「整版白板」表示（欄位對齊 writeStoreSerialized 的 out）。
function boardOf(cur) {
  return {
    nodes: Array.isArray(cur?.nodes) ? cur.nodes : [],
    edges: Array.isArray(cur?.edges) ? cur.edges : [],
    meta: cur?.meta ?? null,
    viewport: cur?.viewport ?? null,
    deletedEdges: Array.isArray(cur?.deletedEdges) ? cur.deletedEdges : [],
    constraints: Array.isArray(cur?.constraints) ? cur.constraints : [],
    rev: typeof cur?.rev === "number" ? cur.rev : 0,
  };
}

const cardCountOf = (nodes) => (Array.isArray(nodes) ? nodes.filter((n) => n.type !== "lane").length : 0);

// 讀全部快照（含 board）；檔案不存在／壞列一律略過，不讓單一壞列擋住整份清單。
async function readAllSnapshots(project) {
  const path = snapshotPathFor(project);
  let text;
  try { text = await readFile(path, "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 略過壞列 */ }
  }
  return out;
}

// 建立快照：拍下目前整版白板，append 一列到 <project>-snapshots.jsonl。
// 非破壞——完全不動白板資料檔。writer 記錄拍照身分（誠實標記，CLAUDE.md 鐵律 4）。
export async function createSnapshot(project, { label } = {}, writer = "system") {
  const board = boardOf(await readStore(project));
  const entry = {
    id: freshSnapId(),
    t: new Date().toISOString(),
    rev: board.rev,
    writer: writer || "system",
    label: label != null && String(label).trim() ? String(label) : null,
    board,
  };
  const path = snapshotPathFor(project);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  return { id: entry.id, t: entry.t, rev: entry.rev, writer: entry.writer, label: entry.label,
    cardCount: cardCountOf(board.nodes), file: path };
}

// 列出快照（輕量）：只回 id/rev/label/時間/writer/卡數，不含整版 board（省 token）。
// 時間序（append 順序＝早→晚）。
export async function listSnapshots(project) {
  const all = await readAllSnapshots(project);
  const snapshots = all.map((e) => ({
    id: e.id, t: e.t, rev: e.rev, label: e.label ?? null, writer: e.writer ?? null,
    cardCount: cardCountOf(e.board?.nodes),
  }));
  return { count: snapshots.length, snapshots };
}

// 回滾到指定快照：把該快照的 board 以「新 rev」寫回白板（updateStore ⇒ 廣播＋序列化＋
// 變更日誌）。rev 前進（非回退）⇒ 回滾本身可再被回滾；快照歷史永不抹除（非破壞）。
// 快照本就是空板時才帶 allowEmpty 繞過 store 的空板寫入防呆。
export async function rollbackSnapshot(project, snapshotId, writer = "system") {
  const all = await readAllSnapshots(project);
  const snap = all.find((e) => e.id === snapshotId);
  if (!snap) throw new Error(`找不到快照：${snapshotId}`);
  const board = boardOf(snap.board);
  const allowEmpty = board.nodes.length === 0; // 僅當快照自身合法為空板時允許
  const { out } = await updateStore((data) => {
    data.nodes = board.nodes;
    data.edges = board.edges;
    data.meta = board.meta;
    data.viewport = board.viewport;
    data.deletedEdges = board.deletedEdges;
    data.constraints = board.constraints;
  }, writer || "system", { project, allowEmpty });
  return {
    rev: out.rev,
    restoredFrom: { id: snap.id, rev: snap.rev, t: snap.t, label: snap.label ?? null },
    cardCount: cardCountOf(out.nodes),
  };
}
