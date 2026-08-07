---
name: hare-workflow
description: HARE 白板接卡工作流——收到卡片編號（B4、W1-3…）時如何讀卡、定位程式、銷卡、重掃追加任務。使用者丟卡號、說「W 系列」「檢視卡片任務」時使用。
---

# HARE 接卡工作流

> HARE MCP server 的 `initialize.instructions` 只提供能力觸發。
> 本 skill 與 `get_guide` 才是接卡工作流的操作來源。

## 發布流程（改 skills／MCP 工具時必守）

- skills 正本＝`.claude/skills/hare-*`（本 repo 原生自用）；對外發布靠
  `npm run install-agent`（claude／cursor／AGENTS.md 三種適配器＋MCP 註冊，見 F3 卡）。
- **每次修改正本或 MCP 工具：bump `package.json` version**——使用者端重跑
  install-agent 即更新（目標端 hare-agent-manifest.json 帶版本戳可比對）。

## 讀卡

- 單卡：`get_card <編號>`；掃描範圍：`list_cards` 過濾編號前綴＋`tasks` 非空。
- **fields 記得帶 `refs`**（預設摘要已含）——refs 的 `path`＋`label`＋`uuid` 是程式定位的鑰匙。

## 定位程式（不要 grep 猜關鍵字）

1. refs 有 `uuid` → `grep "HARE <uuid>"` 該檔＝**一行直達且全 repo 唯一**。
2. 反向（從程式碼找卡片）：看到 `// HARE <uuid> <標籤>` 註解 → `search_cards <uuid>`。
3. 沒 refs 的卡：做完必須填回（見銷卡慣例）。

## 實作與驗證

- 純邏輯抽 `src/*.mjs` 模組（零依賴），node 直跑單元測試。
- UI 行為才用 playwright；測試卡命名帶專屬前綴，清理只按 id 刪。
- 每次改完 `npx vite build` 確認語法。

## 銷卡

1. 每完成一條任務：`complete_task {card, task:<關鍵字或索引>}`（封存帶時間戳）。
2. 卡片缺 refs：`update_card {refs:[{path,label,uuid}]}` 填回，並在程式碼對應位置上方埋
   `// HARE <8位hex> <標籤>`（CSS 用 `/* */`；**JSX 內容區要用 `{/* */}`**，否則會渲染成文字）；
   區塊級 ref 可在最後一行之後補 `// HARE-END <同一hex>` 標記範圍終點（validate_cards 驗成對）。
3. 大功能補 desc：`【實作 <日期>】` ＋驗證依據；`status: real` 只有實跑驗證過才准標。

## 收尾

- **完成後重新掃描同範圍**是否有追加任務（使用者會邊看邊加），全清才結束。
- 同批 MCP 寫入後立即 list 可能有回寫殘影，隔幾秒再確認。
- **任務封存＝任務紀錄**（不另寫歷史檔）：使用者要求 commit 後，用
  `tag_commit {commit, cards}` 把 commit 編號回填到本輪封存任務——之後
  `search_cards <hash>` 可反查卡片、`git show <hash>` 看變更；銷卡當下已有
  commit 就直接 `complete_task` 帶 `commit`。CLAUDE.md 不堆歷史、不複述白板內容。
