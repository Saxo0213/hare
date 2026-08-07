// B13 回歸測試：store.mjs（寫入序列化佇列／原子寫入／樂觀鎖／空板守衛／縮水備份）。
// 零依賴：node:test + node:assert。以 HARE_DATA_PATH 覆寫指向 OS 暫存檔隔離，
// 絕不動到正式白板 roadmap-data.json。DATA_PATH 於 import 期擷取 env，故先設 env
// 再用 dynamic import 載入 store（本檔案由 node --test 以獨立行程執行，env 不外溢）。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm, access } from "node:fs/promises";

const TMP = join(tmpdir(), `hare-store-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;

const store = await import("../lib/store.mjs");
const { readStore, writeStore, updateStore, RevConflictError, EmptyWriteError } = store;

// 每測前重置為已知 6 卡種子（>5 張，能觸發空板／縮水守衛）。
const seedNodes = () =>
  Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, type: "note", data: { num: `S${i}` } }));
async function seed() {
  return writeStore({ nodes: seedNodes(), edges: [] }, "test-seed", { allowEmpty: true });
}

const fileExists = (p) => access(p).then(() => true, () => false);

beforeEach(seed);

after(async () => {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  // 清縮水備份（本測試 basename 非 roadmap-data.json，store 內建修剪不會碰到→自行清）。
  for (let r = 0; r < 200; r += 1) await rm(`${TMP}.bak-${r}`, { force: true });
});

test("updateStore 序列化：N 個併發 read-modify-write 無遺失、rev 遞增 N、JSON 完好", async () => {
  const start = (await readStore()).rev;
  const N = 25;
  // 同時開火 N 個 updateStore，各自讀-改-寫推入一張卡。序列化佇列須保證無互吃更新。
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      updateStore((data) => {
        data.nodes.push({ id: `c${i}`, type: "note", data: { num: `C${i}` } });
      }, "test-concurrent")
    )
  );
  const parsed = JSON.parse(await readFile(TMP, "utf8")); // 原子寫入：任何時點檔案都是完整 JSON
  assert.equal(parsed.nodes.length, 6 + N, "6 種子 + N 併發新增全部存活");
  assert.equal(parsed.rev, start + N, "rev 恰好遞增 N（每次寫入 +1，無遺失）");
  const nums = new Set(parsed.nodes.map((n) => n.data.num));
  for (let i = 0; i < N; i += 1) assert.ok(nums.has(`C${i}`), `C${i} 存活（無互吃）`);
});

test("原子寫入：回傳結構含 nodes/edges/rev 且落地檔可解析", async () => {
  const out = await writeStore(
    { nodes: seedNodes(), edges: [{ id: "e", source: "s0", target: "s1" }] },
    "test"
  );
  assert.ok(Array.isArray(out.nodes) && Array.isArray(out.edges));
  assert.equal(typeof out.rev, "number");
  const parsed = JSON.parse(await readFile(TMP, "utf8"));
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.rev, out.rev);
});

test("RevConflictError：expectedRev 過期即拒寫；帶正確 rev 則通過", async () => {
  const cur = await readStore();
  await assert.rejects(
    () => writeStore(cur, "test", { expectedRev: cur.rev - 1 }),
    (e) => e instanceof RevConflictError && e.code === "REV_CONFLICT" && e.currentRev === cur.rev
  );
  const out = await writeStore(cur, "test", { expectedRev: cur.rev });
  assert.equal(out.rev, cur.rev + 1, "帶正確 expectedRev 應成功且 rev+1");
});

test("EmptyWriteError：既有 >=5 卡而寫入 0 卡被拒；allowEmpty 可繞過", async () => {
  await assert.rejects(
    () => writeStore({ nodes: [], edges: [] }, "test"),
    (e) => e instanceof EmptyWriteError && e.code === "EMPTY_WRITE"
  );
  assert.equal((await readStore()).nodes.length, 6, "守衛在寫入前擋下，檔案未被清空");
  const out = await writeStore({ nodes: [], edges: [] }, "test", { allowEmpty: true });
  assert.equal(out.nodes.length, 0, "明確 allowEmpty 允許清空");
});

test("縮水備份：既有 >=5 卡而新寫入 <50% 時自動備份舊檔", async () => {
  const cur = await readStore(); // 6 卡，rev=R
  // 寫入 2 卡（2 < 6*0.5=3）→ 觸發 .bak-R 備份
  await writeStore({ nodes: seedNodes().slice(0, 2), edges: [] }, "test");
  assert.equal(await fileExists(`${TMP}.bak-${cur.rev}`), true, "縮水時應留下舊檔備份");
  const bak = JSON.parse(await readFile(`${TMP}.bak-${cur.rev}`, "utf8"));
  assert.equal(bak.nodes.length, 6, "備份內容為縮水前的 6 卡");
});
