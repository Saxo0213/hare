# 參與 HARE 開發

歡迎。這份文件講「怎麼改 HARE」；「怎麼用 HARE」在 [README](README.md)。

先看第三節「不可協商的四條」——那幾條不直觀，卻是最常被退件的原因。

---

## 1. 環境與跑起來

```bash
git clone https://github.com/Saxo0213/hare.git
cd hare
npm install
npm run build     # 產出 dist/
npm run serve     # http://localhost:5233
```

改前端時用 `npm run dev`（Vite 熱更新），跟 `npm run serve` 擇一，不要同時跑（同一個埠）。

需要 **Node.js 20.6 以上**。

---

## 2. 程式放在哪

| 路徑 | 內容 |
|---|---|
| `src/` | 前端。`App.jsx` 是主體，`nodes.jsx` 卡片元件，`edges.jsx` 線段，`index.css` 全部樣式 |
| `lib/` | 後端與 MCP。`tools.mjs` 是 MCP 工具實作、`store.mjs` 資料存取、`chat.mjs` agent 通道 |
| `server.mjs` | HTTP 伺服器（靜態檔＋API＋SSE＋MCP HTTP transport）|
| `mcp-server.mjs` | MCP stdio transport。與 HTTP 版共用 `lib/tools.mjs`，行為一致 |
| `test/` | 單元測試。跑 `npm test` |
| `src-tauri/` | 桌面殼（Rust）|

前後端共用的純函式放 `lib/`，前端直接 `import` 過去（例如 `lib/tasks.mjs`、`lib/collision.mjs`）——同一份邏輯不寫兩遍。

---

## 3. 不可協商的四條

### ① 零依賴

**runtime 只有這四個套件**：`@xyflow/react`、`react`、`react-dom`、`@dagrejs/dagre`。
伺服器與 MCP **純 Node.js 內建模組**，JSON-RPC 2.0 手寫。

Vite 與 Tauri 只是建置期工具，不算 runtime。

**新增任何 runtime 依賴預設不接受。** 真的必要就先開 issue 討論，不要直接寫進 PR——
被退的不是那行 `npm install`，是整個 PR。

### ② 不造假、不跳步

宣稱做完之前要**實際跑過**。失敗就照實寫，附上輸出。

**驗證分工**：
- 程式正確性（測試、build、API/MCP 實跑）→ **你負責**，PR 裡附證據
- UI 視覺與互動 → **維護者驗收**，你不必自己截圖佐證「看起來正常」

### ③ 註解只寫「現在是什麼」

**留**：功能說明、`// HARE <uuid> <anchor>` 標籤、連帶關係補充（改這裡會影響哪裡）
**不留**：日期、誰要求的、原本長怎樣、「已移除 X」

```js
// ✅ 量測衍生值不入內容指紋，防跨分頁回寫循環
// ✅ parentLookup＝O(1)；用 s.nodes.some 每個節點各掛一個＝O(N²)
// ❌ 折疊鈕已移除（2026-07-18 使用者指示）：點標題列即切換折疊
// ❌ 卡片互斥（W1-3）：2026-07-12 兩度造成整片下漂
```

判準：**兩年後有人第一次讀這段程式，這句話還幫得上忙嗎？** 幫不上就是沿革，該進 commit 訊息。

同理適用白板卡片的說明欄——**說明是標題的細節**，不是這張卡的編年史。

### ④ 一個 PR 一件事

混在一起的 PR 很難審，也很難在出問題時單獨回退。

---

## 4. 送 PR 之前

```bash
npm run gate     # 測試 ＋ build，兩個都要綠
```

CI 會在你的 PR 上跑同一套。**紅燈的 PR 不會被看**——先修好。

**commit 訊息用中文，格式 `主題（範圍）：要點`**：

```
卡片互斥改只掛 onNodeDragStop（前端）：拖曳中不做子卡區維護，避免打斷拖曳工作階段
```

沿革、誰提的、原本怎樣——**寫在這裡**，不要寫進註解。

---

## 5. 幾個踩過的坑

- **`App.jsx`**：新的 state 或函式要**宣告在第一次引用之前**（依賴陣列在渲染期取值，先引用＝TDZ 崩潰）
- **JSX 註解**：`return` 內用 `{/* */}`，但別放在頂層
- **測試卡**：在白板上跑測試時，卡片一律帶專屬前綴（或用獨立測試專案），清理時只按 id 刪
- **鎖定狀態**的唯一真相是 `data.locked`；`draggable` / `deletable` 每次渲染派生，不要持久化

---

## 6. 有疑問

開 issue 問，不必先寫程式。設計方向的討論比修好一版再重寫便宜得多。
