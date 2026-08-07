# HARE — Human-Agent Roadmap Editor

給「人＋AI agent」共用的依賴圖路線白板。人用瀏覽器拖卡片、agent 走 MCP 讀寫卡片，
雙方以卡片編號（B4、W1-3…）溝通任務與進度。

- **依賴圖白板**：卡片＝任務／模組，連線＝依賴，可分頁、可巢狀容器。
- **agent 原生**：內建 MCP 伺服器（stdio ＋ HTTP），agent 直接建卡、拉線、認領、銷任務。
- **卡片即對話**：每張卡可掛一個 headless agent session，權限回問就在卡上裁定。
- **零依賴後端**：伺服器與 MCP 全部只用 Node.js 內建模組，手寫 JSON-RPC 2.0。

---

## 環境需求

| 項目 | 需求 | 說明 |
|---|---|---|
| **Node.js** | **20.6.0 以上** | 用到 `node:test`、原生 ESM。建議 20 LTS 或 22 LTS |
| npm | 隨 Node 附帶 | 只用來裝前端建置依賴 |
| 作業系統 | Windows / macOS / Linux | 伺服器與 MCP 跨平台；`start-hare.bat` 與 Tauri 桌面殼目前只有 Windows |
| 瀏覽器 | Chromium 系或 Firefox 近期版本 | 需支援 `color-mix()`、`:is()`、EventSource |
| 磁碟 | 約 400 MB | 多數是 `node_modules`（前端建置用） |

**選配**

| 項目 | 什麼時候需要 |
|---|---|
| `git` | 要用「每卡隔離 worktree」與整合佇列時 |
| agent CLI（Claude Code 等） | 要用「卡片即對話」時 |
| [Rust toolchain](https://rustup.rs/) | 自建桌面應用時（見下方「桌面應用」） |

---

## 安裝

```bash
git clone <repo-url> hare
cd hare
npm install          # 只裝前端建置依賴（react / react-flow / dagre / vite）
npm run build        # 產出 dist/，伺服器對外服務的就是它
npm run serve        # 啟動 http://localhost:5233
```

瀏覽器開 `http://localhost:5233` 即可使用。

**首次啟動**會在 `data/` 建立執行期資料夾。板檔預設是 repo 根的 `roadmap-data.json`（`default` 專案），
其餘專案各自存成 `data/<專案代號>.json`。

---

## 桌面應用（標準使用形態）

HARE 的常態用法是**獨立視窗的桌面應用**，不是瀏覽器分頁——沒有網址列、沒有分頁列，
系統匣可以啟停伺服器。`src-tauri/` 就是這個殼。

```bash
npx tauri build      # 需要 Rust toolchain
```

產出 Windows 安裝檔（`src-tauri/target/release/bundle/`）：

- `msi/HARE_0.1.0_x64_en-US.msi`
- `nsis/HARE_0.1.0_x64-setup.exe`

**殼與伺服器的關係**：殼只是視窗，真相在 `server.mjs` 與資料檔。啟動時偵測 `localhost:5233`——
沒在跑就自己代跑 `node server.mjs`（位置取 `HARE_SERVER_DIR`，未設則從執行檔往上找 `server.mjs`）。
所以殼與 repo 要放得到彼此。

### 不裝 Rust 的替代路線

**Windows**：雙擊 `start-hare.bat`。埠 5233 沒在跑就背景啟動伺服器（輸出寫進 `data/server.log`），
再用 Edge → Chrome → 預設瀏覽器的順序開一個 `--app` 獨立視窗——外觀與桌面應用接近。

**其他平台**：`npm run serve` 後用瀏覽器開 `http://localhost:5233`。

### 開發模式

```bash
npm run dev          # Vite dev server（熱更新）；與 npm run serve 擇一，不要同時跑
npm test             # 單元測試
npm run gate         # 測試 ＋ build，提交前跑這個
```

---

## 接上 AI agent（MCP）

HARE 同時提供兩種 MCP transport，**共用同一份工具實作，行為一致**。

### stdio（給 Claude Code 等本機 CLI）

```bash
npm run mcp          # 等同 node mcp-server.mjs
```

在你的 agent 設定檔登記這支指令即可。以 Claude Code 為例：

```bash
claude mcp add hare -- node /absolute/path/to/hare/mcp-server.mjs
```

### HTTP（給遠端或容器內的 agent）

伺服器跑起來後，MCP 端點就在 `POST http://localhost:5233/mcp`（Streamable HTTP）。

```bash
curl -s -X POST localhost:5233/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 讓 agent 讀懂慣例

`.claude/skills/`（Claude Code）與 `.agents/skills/`（通用）內附 HARE 的操作技能：
建卡準則、排版規則、巢狀架構、接卡工作流。安裝到你自己的專案：

```bash
npm run install-agent -- --project /path/to/your-project
```

---

## 環境變數

| 變數 | 預設 | 作用 |
|---|---|---|
| `PORT` | `5233` | 伺服器監聽埠 |
| `ROADMAP_TOKEN` | 未設 | 設了之後，寫入端點（`PUT /api/roadmap`、`/mcp` 的寫入工具）需要 `Authorization: Bearer <token>`。**未設＝本機開發模式，寫入不驗證**；讀取一律公開 |
| `HARE_DATA_DIR` | `<repo>/data` | 多專案資料夾根 |
| `HARE_DATA_PATH` | 未設 | 覆寫**預設專案**的板檔路徑 |
| `HARE_AUTOLAND` | 開 | 設 `0` 關掉「無同步修改自動合入 main」 |

**對外服務前請設 `ROADMAP_TOKEN`**——沒設等於任何人都能寫你的白板。

---

## 資料放在哪

```
roadmap-data.json          預設專案（default）的白板
data/
 ├ projects.json           專案登錄表
 ├ <專案代號>.json          各專案的白板
 ├ <專案代號>-changelog.jsonl  變更日誌（誰改的、何時、改了什麼）
 ├ assets/<專案代號>/       卡片上的圖片
 └ chat/                   agent 對話轉錄與 session 對照
```

全部是純檔案，沒有資料庫。備份＝複製這些檔案。

---

## 參與開發

歡迎 issue 與 PR。開發環境、程式結構、不可協商的規矩（零依賴、註解紀律）與
commit 格式見 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 授權

HARE 採 **Apache License 2.0**，見 [`LICENSE`](LICENSE) 與 [`NOTICE`](NOTICE)。

第三方套件（`@xyflow/react`、`react`、`react-dom`、`@dagrejs/dagre`、Vite、Tauri）
皆為 MIT，條文逐字收錄於 [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md)。
