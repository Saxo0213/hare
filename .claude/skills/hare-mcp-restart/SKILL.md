---
name: hare-mcp-restart
description: HARE MCP／伺服器重啟流程——改了 lib/（tools.mjs、layout.mjs…）等後端程式後讓新工具、新參數生效。「重啟 MCP」「重啟伺服器」「新參數沒生效」時使用。
---

# HARE MCP 重啟流程

後端程式改完，跑著的行程仍是舊碼。HARE 有**兩個宿主**，各自重啟：

| 宿主 | 行程 | 服務對象 | 誰能重啟 |
|---|---|---|---|
| HARE 伺服器（port 5233） | `app.exe`（Tauri 殼）內部代跑 `node server.mjs` | 瀏覽器/桌面視窗 UI＋SSE＋HTTP MCP | agent 可 |
| stdio MCP | 每個 Claude session 派生一支 `node mcp-server.mjs` | 該 session 的 hare 工具 | 只有使用者（`/mcp` 重連或重開 session） |

兩者共用同一份 lib/，重啟哪個、哪個就吃到新碼。**別殺別人 session 的 mcp-server 行程**（tasklist 會看到多支，都是各 session 的）。

**起動原則（2026-07-28 使用者裁定）**：伺服器一律**從 Tauri release 殼啟動**＝
`D:\BanLu\src-tauri\target\release\app.exe`。殼不含前端碼，開視窗指向 `localhost:5233`；
**伺服器未起時它才代跑 repo 的 `node server.mjs`**（`current_dir` 從 exe 往上找到 D:\BanLu 的
server.mjs → 吃得到 lib/ 新碼，見 src-tauri/src/lib.rs `spawn_server`）。所以「重啟載新碼」＝
先殺 5233、再起 app.exe。**不要**再直接 `node server.mjs`（那是殼內部的事，不是起動入口）。

## 重啟 HARE 伺服器（agent 照做）

1. **找 PID**：`netstat -ano | grep ":5233" | grep LISTENING`
2. **殺**：`taskkill //PID <pid> //F`（git-bash 下旗標用雙斜線），再確認埠已釋放。
   ——注意 5233 的監聽者是殼代跑的 `node server.mjs`；殺它不會關掉 app.exe 視窗（視窗會顯示
   「無回應」，重起伺服器後重整即回）。若要連殼一起收，另殺 app.exe。
3. **啟（從 release 殼、獨立行程）**——git-bash 下 `cmd //c start` 的巢狀引號會壞（實測），
   改用 powershell `Start-Process`（會 detach；powershell 不在 PATH 用完整路徑）：
   `/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Start-Process 'D:\BanLu\src-tauri\target\release\app.exe'"`
   ——app.exe 偵測 5233 未起 → 代跑 repo 的 `node server.mjs`（新碼）＋開桌面視窗。
   **不可用 run_in_background**（背景工作掛在 agent session 上，session 結束伺服器陪葬，
   2026-07-17 實證）。app.exe 已在跑（視窗還開著）＝用匣選單「重啟伺服器」，或先殺 app.exe 再起。
   使用者要自己開＝雙擊 `app.exe`（或 repo 根 `start-hare.bat`）。
4. **驗證存活＋新碼**：tools/list 裡看得到新參數＝新碼已載入——
   `curl -s -X POST localhost:5233/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
5. **實跑驗證**（鐵律：宣稱完成前實跑）：走 HTTP MCP 建 `TEST` 前綴測試卡驗新行為，驗完**按 id 刪**。

## 踩過的坑（照防即可）

- **重啟後首次寫入可能 EPERM**（rename tmp→data 被舊行程殘留控制代碼擋）：暫時性，重試一次再判斷是不是真故障。
- **寫入失敗≠卡建了一半**：EPERM 發生在整檔 rename，資料不會半套；清理時仍以「回應裡的 id」為準，不憑猜測刪卡。
- **curl -d 帶中文會被終端編碼弄花**：測試卡 label 用 ASCII。
- **wmic／powershell 不在 git-bash PATH**：查行程指令列用完整路徑
  `/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select ProcessId,CommandLine"`。
- **殺之前查父行程**：父已不存在（孤兒行程）＝殺了重啟不搶任何人所有權；父是使用者終端＝先問。

## stdio 端（使用者做）

server.mjs 重啟不影響各 session 的 stdio 連線；要讓**本 session** 的 hare 工具吃到新碼，使用者執行 `/mcp` 重連 hare（或重開 session）。agent 驗證走 HTTP MCP 即可，不必等 stdio 重連。
