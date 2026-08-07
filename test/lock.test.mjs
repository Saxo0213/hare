// B11 跨 process 專案級寫入鎖回歸測試（零依賴：node:test + node:assert + child_process）。
//
// 核心情境：兩支「不同 process」同時對「同一專案」各射 N 次 updateStore append。
// 若無跨 process 鎖，兩邊「讀 rev→寫 rev+1」會互吃更新（lost update）：存活數 < 2N、
// rev 有跳號/重號。有鎖則 2N 全存活、rev 連續 1..2N 無缺無重、JSON 完好。
// 另驗：兩個「不同專案」的 worker 併發不互相阻塞（各自獨立完成、資料正確）。
//
// 隔離：HARE_DATA_DIR 指向 mkdtemp 暫存夾；一律用「非 default」專案代號（走 data/<id>.json），
// 完全不碰 repo 的 roadmap-data.json / data/。worker 腳本寫進暫存夾（在 repo 外 → 不會被
// node --test 當測試檔撿去跑），並以明確 env 生出子行程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { open, writeFile, rm } from "node:fs/promises";

const TMP = mkdtempSync(join(tmpdir(), "hare-lock-"));
const DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_DIR = DATA_DIR; // 父行程讀結果時走同一份暫存資料夾

const storeUrl = new URL("../lib/store.mjs", import.meta.url).href;
const lockUrl = new URL("../lib/lock.mjs", import.meta.url).href;
const { readStore, changelogPathFor, dataPathFor } = await import(storeUrl);
const { withLock, LockTimeoutError, _internals } = await import(lockUrl);

// worker：對指定專案連射 N 次 updateStore（每次 push 一張帶唯一 id 的卡）。放暫存夾（repo 外）。
const workerPath = join(TMP, "lock-worker.mjs");
writeFileSync(
  workerPath,
  `import { updateStore } from ${JSON.stringify(storeUrl)};
const project = process.env.PJ, N = Number(process.env.N), tag = process.env.TAG;
for (let i = 0; i < N; i++) {
  await updateStore((d) => { d.nodes.push({ id: tag + '-' + i, type: 'plan', data: { num: tag + i } }); }, 'wk-' + tag, { project });
}
`
);

function runWorker({ project, N, tag }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, HARE_DATA_DIR: DATA_DIR, PJ: project, N: String(N), TAG: tag },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`worker ${tag} exit ${code}: ${err}`))
    );
  });
}

// 讀某專案 changelog 的 rev 陣列（升冪）。
async function changelogRevs(project) {
  const raw = await readFile(changelogPathFor(project), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).rev)
    .sort((a, b) => a - b);
}

test("跨 process 同專案併發：2 個子行程各 N 次 append，2N 全存活、rev 連續無缺無重", async () => {
  const N = 15;
  const project = "xproc"; // 走 data/xproc.json
  await Promise.all([
    runWorker({ project, N, tag: "A" }),
    runWorker({ project, N, tag: "B" }),
  ]);

  const cur = await readStore(project);
  assert.equal(cur.nodes.length, 2 * N, `2N=${2 * N} 張卡全部存活（無互吃）`);
  assert.equal(cur.rev, 2 * N, `最終 rev 恰為 2N=${2 * N}（每次寫入 +1，無遺失）`);

  // 每張卡 id 唯一（A-0..A-14、B-0..B-14 全在）
  const ids = new Set(cur.nodes.map((n) => n.id));
  assert.equal(ids.size, 2 * N, "卡 id 全數唯一無重複");
  for (const tag of ["A", "B"]) {
    for (let i = 0; i < N; i++) assert.ok(ids.has(`${tag}-${i}`), `${tag}-${i} 存活`);
  }

  // changelog 的 rev 必須恰為 1..2N，無跳號、無重號（跨 process 序列化的鐵證）
  const revs = await changelogRevs(project);
  assert.deepEqual(
    revs,
    Array.from({ length: 2 * N }, (_, i) => i + 1),
    "changelog rev 連續 1..2N，無缺口/重複"
  );

  // 落地檔為完整可解析 JSON（原子寫入未被交錯破壞）
  JSON.parse(await readFile(dataPathFor(project), "utf8"));
});

test("不同專案互不阻塞：兩專案 worker 併發各自完成、資料獨立正確", async () => {
  const N = 12;
  await Promise.all([
    runWorker({ project: "pjX", N, tag: "X" }),
    runWorker({ project: "pjY", N, tag: "Y" }),
  ]);
  const x = await readStore("pjX");
  const y = await readStore("pjY");
  assert.equal(x.nodes.length, N);
  assert.equal(y.nodes.length, N);
  assert.equal(x.rev, N);
  assert.equal(y.rev, N);
  // 資料隔離：X 的卡不外洩到 Y
  assert.ok(x.nodes.every((n) => n.id.startsWith("X-")));
  assert.ok(y.nodes.every((n) => n.id.startsWith("Y-")));
});

test("陳舊鎖回復：年齡超過門檻的殘留鎖會被破除，後續仍能取得鎖", async () => {
  const target = join(TMP, "stale-age.json");
  const lockPath = `${target}.lock`;
  // 手造一個「很久以前」的鎖檔（模擬持有者崩潰未釋放）
  const old = Date.now() - _internals.STALE_MS - 5_000;
  await writeFile(lockPath, JSON.stringify({ pid: 999999, host: hostname(), t: old, token: "ghost" }), "utf8");
  let ran = false;
  const r = await withLock(target, async () => { ran = true; return 42; }, { timeoutMs: 3_000 });
  assert.equal(ran, true, "破除陳舊鎖後臨界區有執行");
  assert.equal(r, 42);
  // 釋放後鎖檔應已移除
  await assert.rejects(() => open(lockPath, "r"), (e) => e.code === "ENOENT");
});

test("死 pid 鎖回復：同主機但持有者 pid 已不存在的鎖立即被破除", async () => {
  const target = join(TMP, "stale-pid.json");
  const lockPath = `${target}.lock`;
  // 造一個「剛剛才建」但 pid 保證不存在的鎖：年齡未達門檻，靠 pid 死亡判定破鎖。
  const deadPid = 2147483000; // 幾乎不可能存在
  assert.equal(_internals.pidAlive(deadPid), false, "測試前置：該 pid 確實不存活");
  await writeFile(lockPath, JSON.stringify({ pid: deadPid, host: hostname(), t: Date.now(), token: "dead" }), "utf8");
  let ran = false;
  await withLock(target, async () => { ran = true; }, { timeoutMs: 3_000 });
  assert.equal(ran, true, "同主機死 pid 鎖被立即破除，臨界區得以執行");
});

test("鎖逾時：活鎖持有中且未陳舊時，搶鎖逾時丟 LockTimeoutError", async () => {
  const target = join(TMP, "held.json");
  const lockPath = `${target}.lock`;
  // 造一個「當下、pid=自己（存活）」的鎖：既不逾齡、pid 又活著 → 不會被破 → 應逾時。
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), t: Date.now(), token: "self-held" }), "utf8");
  await assert.rejects(
    () => withLock(target, async () => "unreachable", { timeoutMs: 300 }),
    (e) => e instanceof LockTimeoutError && e.code === "LOCK_TIMEOUT"
  );
  await rm(lockPath, { force: true }); // 收尾
});
