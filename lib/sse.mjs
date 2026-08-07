// 零依賴 SSE 廣播器：維護目前訂閱中的 http.ServerResponse 集合，供 /api/roadmap/events
// 與各寫入路徑（browser PUT、/mcp 工具呼叫、fs.watch 外部變更偵測）共用同一份廣播邏輯。
//
// 多專案：廣播與訂閱都帶 projectId（省略＝"default"）。每個專案獨立 lastRev 去重，
// 只推送給訂閱同一專案的 client——不同白板的 rev 事件互不干擾。
//
// 事件序號＋斷線補放（HARE 5eq9e1ay event-seq）：
// 每專案單調事件序號進 SSE `id:` 欄；近況環形緩衝 500 則。訂閱時帶 after 游標
// （明確 ?after= 優先於瀏覽器自動的 Last-Event-ID）＝先補放漏掉的事件再接live——
// EventSource 斷線重連自帶 Last-Event-ID，chat 訊息不再因斷線漏失。
const DEFAULT_PROJECT = "default";
const HIST_MAX = 500; // 每專案補放緩衝上限（超出＝最舊丟棄；早於緩衝的斷線走整包重載兜底）

export function createBroadcaster() {
  const clients = new Set();      // 元素為 { res, project }
  const lastRev = new Map();      // project -> 最近廣播的 rev（per 專案去重）
  const hist = new Map();         // project -> { seq, buf: [{seq, json}] }

  function histOf(p) {
    let h = hist.get(p);
    if (!h) { h = { seq: 0, buf: [] }; hist.set(p, h); }
    return h;
  }
  // 單一出口：編序→入緩衝→推給同專案訂閱者（SSE id 欄＝序號）
  function push(p, payloadObj) {
    const h = histOf(p);
    h.seq += 1;
    const json = JSON.stringify({ ...payloadObj, project: p, seq: h.seq });
    h.buf.push({ seq: h.seq, json });
    if (h.buf.length > HIST_MAX) h.buf.splice(0, h.buf.length - HIST_MAX);
    const line = `id: ${h.seq}\ndata: ${json}\n\n`;
    for (const c of clients) {
      if (c.project !== p) continue;
      try { c.res.write(line); } catch { clients.delete(c); }
    }
  }

  function broadcast(rev, project = DEFAULT_PROJECT) {
    if (typeof rev !== "number") return;
    const p = project || DEFAULT_PROJECT;
    if (lastRev.get(p) === rev) return;
    lastRev.set(p, rev);
    push(p, { rev });
  }

  // 通用事件廣播（chat 訊息／狀態／權限回問）。與 rev 事件走同一條 SSE；
  // 前端以 payload.type 區分（rev 事件無 type，舊監聽器讀不到 rev 數字自然忽略）。
  // HARE b7cae4e1 broadcastEvent
  function broadcastEvent(payload, project = DEFAULT_PROJECT) {
    push(project || DEFAULT_PROJECT, payload);
  }

  // 訂閱把手；after＝補放游標（收過的最後序號）——先補放缺漏再接 live
  function addClient(res, project = DEFAULT_PROJECT, after = null) {
    const p = project || DEFAULT_PROJECT;
    const handle = { res, project: p };
    const cursor = Number(after);
    if (Number.isFinite(cursor) && cursor >= 0) {
      const h = histOf(p);
      for (const e of h.buf) {
        if (e.seq > cursor) { try { res.write(`id: ${e.seq}\ndata: ${e.json}\n\n`); } catch { /* 斷了就算 */ } }
      }
    }
    clients.add(handle);
    return handle;
  }

  function removeClient(handleOrRes) {
    if (handleOrRes && clients.has(handleOrRes)) { clients.delete(handleOrRes); return; }
    // 向後相容：傳入的是 res 物件時，掃描比對移除
    for (const c of clients) if (c === handleOrRes || c.res === handleOrRes) { clients.delete(c); return; }
  }

  // 目前有訂閱者的專案清單（外部變更輪詢後備用：只 stat 有人看的板，無人訂閱＝零成本）
  function projects() {
    const s = new Set();
    for (const c of clients) s.add(c.project);
    return [...s];
  }

  return { broadcast, broadcastEvent, addClient, removeClient, projects, get size() { return clients.size; } };
}
