// 任務結構 dict 化——HARE 7a5kd1c7 tasks-dict
// 儲存格式：{ '<ISO 時間戳>': '任務文字' }——時間戳＝隱性排序鍵（建立時間），UI 不顯示。
// 對外（MCP 線上格式）與前端顯示＝依時間戳排序後的「文字陣列」。
// 舊資料（陣列）讀取時自動遷移：**確定性時間戳**（1970 基準＋索引 ms）——每次讀取產生
// 相同鍵（避免內容指紋抖動引發多分頁推送迴圈），且永遠排在新任務之前；一經寫回即落盤。
// 純函式、前後端共用（前端自 ../lib/tasks.mjs import，同 collision 慣例）。

export const LEGACY_BASE = 0; // 1970-01-01T00:00:00Z：舊陣列遷移的確定性基準

export function isTaskDict(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

// 陣列→dict（保序：基準＋索引 ms）；dict 原樣；其他＝空
export function normalizeTasks(v, stampBase = Date.now()) {
  if (isTaskDict(v)) return v;
  if (!Array.isArray(v)) return {};
  const out = {};
  v.forEach((t, i) => {
    const s = String(t ?? "");
    if (s.trim()) out[new Date(stampBase + i).toISOString()] = s;
  });
  return out;
}

// 讀取遷移（就地）：node.data.tasks 是陣列＝舊資料 → 確定性 dict
export function migrateTasksInPlace(node) {
  const d = node?.data;
  if (d && Array.isArray(d.tasks)) d.tasks = normalizeTasks(d.tasks, LEGACY_BASE);
  return node;
}

// 排序後條目 [{k, text}]（時間戳升冪＝建立順序）
export function taskEntries(v) {
  const dict = isTaskDict(v) ? v : normalizeTasks(v, LEGACY_BASE);
  return Object.entries(dict)
    .map(([k, text]) => ({ k, text: String(text) }))
    .filter((e) => e.text.trim())
    .sort((a, b) => a.k.localeCompare(b.k));
}

// 顯示／線上格式：排序後純文字陣列
export function taskTexts(v) { return taskEntries(v).map((e) => e.text); }

export function taskCount(v) { return taskEntries(v).length; }

// 新增：自帶時間戳；同毫秒撞鍵＝+1ms 遞推（保插入序）
export function addTask(v, text, stamp) {
  const dict = { ...(isTaskDict(v) ? v : normalizeTasks(v, LEGACY_BASE)) };
  let k = stamp || new Date().toISOString();
  while (dict[k] !== undefined) k = new Date(Date.parse(k) + 1).toISOString();
  dict[k] = String(text);
  return dict;
}

// 依「排序後索引」編輯（保留原時間戳）；text 空/null＝刪除該鍵
export function setTaskAt(v, index, text) {
  const dict = { ...(isTaskDict(v) ? v : normalizeTasks(v, LEGACY_BASE)) };
  const e = taskEntries(dict)[index];
  if (!e) return dict;
  if (text == null || !String(text).trim()) delete dict[e.k];
  else dict[e.k] = String(text);
  return dict;
}

// update_card 收到 tasks「陣列」時的文字對齊合併——
// 不整包重打戳（那會毀掉「建立時間」）：與既有任務文字完全相同者保留原鍵；全新文字
// 依陣列順序打新戳（同毫秒 +1ms 遞推，沿 addTask 慣例）；既有但新陣列沒有的＝刪除。
// 重複文字按出現次數配對——既有兩條同文字、新陣列只留一條時，保留「鍵較小」（建立較早）者。
// existing 可為現行 dict，或舊陣列（先以 LEGACY 基準對齊既有語意）。純函式。
// HARE a4f7c2e1 tasks_merge
export function mergeTaskTexts(existing, texts, now = Date.now()) {
  const dict = isTaskDict(existing) ? existing : normalizeTasks(existing, LEGACY_BASE);
  // 既有：文字 → 該文字的鍵佇列（升冪＝建立序；配對時從頭取＝優先保留較早鍵）
  const byText = new Map();
  for (const { k, text } of taskEntries(dict)) {
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(k);
  }
  const out = {};
  let last = null; // 新戳游標：同毫秒 +1ms 遞推，跨整個陣列連續（保新任務插入序）
  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = String(raw ?? "");
    if (!text.trim()) continue; // 空白剔除（同 normalizeTasks 語意）
    const keys = byText.get(text);
    if (keys && keys.length) { out[keys.shift()] = text; continue; } // 保留原鍵（配對用掉一個）
    // 全新文字：打新戳；撞既有鍵或已配鍵＝ +1ms
    let k = last == null ? new Date(now).toISOString() : new Date(Date.parse(last) + 1).toISOString();
    while (out[k] !== undefined || dict[k] !== undefined) k = new Date(Date.parse(k) + 1).toISOString();
    out[k] = text;
    last = k;
  }
  return out;
}

// 依文字移除第一筆吻合（complete_task 用）；回 {dict, removed}
export function removeTaskByText(v, matcher) {
  const dict = { ...(isTaskDict(v) ? v : normalizeTasks(v, LEGACY_BASE)) };
  const hit = taskEntries(dict).find((e) => matcher(e.text));
  if (!hit) return { dict, removed: null };
  delete dict[hit.k];
  return { dict, removed: hit.text };
}
