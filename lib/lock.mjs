// 跨 process 專案級寫入鎖——零依賴，純 node: 內建。
//
// 背景：B4 已用「同 process per-專案佇列」序列化單一行程內的 read-modify-write，並用
// 原子 tmp+rename 保證檔案本身不會殘尾損毀。但兩個 *不同 process*（例如正在跑的
// server.mjs 與另一支 stdio MCP）同時寫 *同一專案* 時，各自「先讀 rev→再寫 rev+1」之間
// 仍有 TOCTOU 窗口：A 讀 rev=5、B 讀 rev=5，兩者都寫 rev=6，晚寫者覆蓋早寫者（lost update）。
//
// 本鎖以「檔案系統做仲介」提供跨 process 的 advisory lock：以資料檔路徑為鍵，在
// `<target>.lock` 用 O_EXCL（fs.open 'wx'）獨佔建立鎖檔——同一時刻只有一個 process 能建成。
// 建成者進臨界區（讀 rev→改→寫），完事在 finally 釋放（unlink）。搶不到者退避重試至逾時。
//
// 崩潰不死鎖：鎖檔內記 pid + host + 時間戳 + 一次性 token。搶不到時檢查既有鎖是否「陳舊」：
//   1) 年齡超過 STALE_MS（持有者可能已崩潰且未釋放）；或
//   2) 同一台主機且持有者 pid 已不存在（process.kill(pid,0) 判定）。
// 判定陳舊即破鎖（unlink）後重搶。釋放時只刪「token 仍是自己」的鎖，避免破了別人剛搶到的鎖。
import { open, unlink, readFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

// 陳舊門檻：鎖檔存在超過此毫秒數即視為死鎖殘留，逕行破鎖。單次寫入僅數毫秒，30 秒綽綽有餘。
const STALE_MS = 30_000;
// 搶鎖逾時：等不到就丟 LockTimeoutError（呼叫端據以回報衝突，而非無限卡死）。
const DEFAULT_TIMEOUT_MS = 15_000;
// 退避基準（毫秒），實際等待帶抖動避免多 process 同步撞擊。
const BACKOFF_MS = 20;

const HOST = hostname();

export class LockTimeoutError extends Error {
  constructor(target, timeoutMs) {
    super(`取得寫入鎖逾時（${timeoutMs}ms）：${target}`);
    this.code = "LOCK_TIMEOUT";
    this.target = target;
  }
}

const lockPathFor = (target) => `${target}.lock`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pid 是否仍存活（僅同主機有意義）。process.kill(pid,0) 不送訊號只探測：
//   成功＝存在；ESRCH＝不存在；EPERM＝存在但無權（仍算存活）。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// 嘗試獨佔建立鎖檔；成功回傳寫入的 token，被搶（EEXIST）回傳 null，其餘錯誤上拋。
async function tryAcquire(lockPath) {
  let fh;
  try {
    fh = await open(lockPath, "wx"); // O_CREAT|O_EXCL：檔已存在即 EEXIST
  } catch (e) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
  const token = `${process.pid}-${randomUUID()}`;
  try {
    await fh.writeFile(
      JSON.stringify({ pid: process.pid, host: HOST, t: Date.now(), token }),
      "utf8"
    );
  } finally {
    await fh.close();
  }
  return token;
}

// 檢查既有鎖是否陳舊；是則破鎖（unlink）回 true，呼叫端可立即重搶。非陳舊回 false。
async function breakIfStale(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return true; // 已被釋放/破除，直接重搶
    throw e;
  }
  let info = null;
  try {
    info = JSON.parse(raw);
  } catch {
    /* 內容損毀（可能剛建立尚未寫入或崩潰）→ 退回檔案 mtime 判齡 */
  }
  let ts = info && typeof info.t === "number" ? info.t : null;
  if (ts === null) {
    try {
      ts = (await stat(lockPath)).mtimeMs;
    } catch (e) {
      if (e.code === "ENOENT") return true;
      throw e;
    }
  }
  const age = Date.now() - ts;
  let stale = age > STALE_MS;
  // 同主機且持有 pid 已死 → 立即視為陳舊（不必等滿 STALE_MS）
  if (!stale && info && info.host === HOST && typeof info.pid === "number" && !pidAlive(info.pid)) {
    stale = true;
  }
  if (!stale) return false;
  await unlink(lockPath).catch(() => {}); // 破鎖；競態下別人先刪也無妨
  return true;
}

// 以 target（解析後的資料檔路徑）為鍵取得跨 process 寫入鎖，執行 fn，finally 釋放。
// opts.timeoutMs：搶鎖逾時（預設 15s）。不同 target → 不同鎖檔 → 互不阻塞。
export async function withLock(target, fn, opts = {}) {
  const lockPath = lockPathFor(target);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true }); // 鎖檔目錄可能尚未建立

  let token = null;
  for (;;) {
    token = await tryAcquire(lockPath);
    if (token) break;
    // 搶不到：若既有鎖陳舊就破鎖後立即重搶，否則退避
    if (await breakIfStale(lockPath)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(target, timeoutMs);
    await sleep(BACKOFF_MS + Math.floor(Math.random() * BACKOFF_MS));
  }

  try {
    return await fn();
  } finally {
    // 只釋放「仍是自己的」鎖：若持有期間被誤判陳舊而遭他人破鎖並重搶，不可刪到別人的。
    try {
      const cur = JSON.parse(await readFile(lockPath, "utf8"));
      if (cur && cur.token === token) await unlink(lockPath);
    } catch {
      /* 鎖檔已不存在或不可解析：無需（也不應）刪除 */
    }
  }
}

export const _internals = { lockPathFor, pidAlive, STALE_MS };
