---
name: hare-ui-feedback
description: HARE 視覺回饋迴圈——agent 做完綁在圖片卡範圍框（region）上的 UI 任務後，用 playwright 操作跑起來的畫面、截取對應範圍，再經 MCP 把改後畫面貼回同一個範圍框，與意圖圖（shot）前／後並列，讓不懂程式的人肉眼對照結果。接到圖片卡 region 任務、或使用者說「改完貼回來看」「跑起來截圖對照」時使用。
---

# HARE 視覺回饋迴圈

把「agent 在做什麼」變成不懂程式的人看得懂的東西：使用者在一張畫面截圖上圈範圍框
（region R1、R2…）、寫白話任務；agent 改完程式後，**操作跑起來的畫面、截圖、貼回同一個
框**，使用者用肉眼對照「意圖（前）vs 改後（後）」即可驗收——全程不必讀程式碼。

這條迴圈補上一個缺口：MCP 一直**能讀圖卻不能寫圖**（`get_card` 回 image/regions/shot，
但沒有寫圖工具）。`attach_image`／`set_region_result`（v0.6.0）把改後畫面寫回白板。

## 什麼時候用

- 接到綁在圖片卡範圍框的任務（`get_card` 回 `regions[].tasks`）。
- 使用者說「改完貼回來看」「跑起來截圖對照」「把畫面貼到板上」。
- 任何「動了 UI、要讓人肉眼確認結果」的場合。

## 迴圈（照做）

1. **讀框**：`get_card <卡號>` 拿該卡的 `regions`——每框有 `n`（R 編號）、`at`（座標比例
   x/y/w/h）、`shot`（意圖／前的範圍截圖）、`tasks`（白話任務）。用檔案讀取工具開 `shot`
   看清楚要改成什麼。
2. **改程式**：照任務動工（定位程式靠卡片 `refs` 的 path＋uuid → 搜 `HARE <uuid>`）。
3. **開畫面**：用 playwright 把跑起來的 app 導到對應畫面
   （`browser_navigate` → 必要時 `browser_click` 走到該狀態）。
4. **截圖**：`browser_take_screenshot` 存成本機檔。**只截 region 對應的畫面範圍**
   （用 `at` 座標比例對位），不要整頁糊成一團——框是局部，結果圖也該是局部。
5. **貼回**：`set_region_result { card, region:"R1", image:<截圖路徑> }`
   把改後畫面設為該框的結果圖（後），與 `shot`（前）並列。
   - 若是「整張新畫面」而非某個框 → 用 `attach_image { path, card }` 追加到卡片 gallery
     （省略 card＝新建一張圖片卡）。
6. **回報**：說清楚貼了哪張、對應哪個 R 編號、對照的是哪條任務。**不自稱「畫面對了」**。

## 界線（鐵律，寫進每次回報）

- **agent 的職責＝取回視覺證據並貼到人眼前；判斷 UI 是否正確＝使用者的事。**
  程式碼正確性（build／單元測試／API 實跑）由你驗證並附證據；UI 視覺與互動由使用者驗證。
- `status=real` **不因截圖成功就標**——貼圖成功只證明「畫面拍回來了」，不證明「畫面對了」。
  要標 real，附的是程式面的驗證依據（build 過、測試過），不是截圖。
- 寫入一律帶 writer（MCP 寫入即 `mcp`），不偽造身分。

## 工具速查

| 目的 | 工具 | 關鍵參數 |
|---|---|---|
| 讀範圍框（前圖／座標／任務） | `get_card` | 回 `regions[]`：n / at / shot / result / tasks |
| 把改後畫面貼回某個框 | `set_region_result` | `card`、`region`（如 "R1"）、`image`（本機截圖路徑） |
| 追加整張新畫面到卡片 | `attach_image` | `path`；`card`＝追加到既有圖片卡，省略＝新建圖片卡 |

- 只收點陣圖（png/jpg/gif/webp）；svg／非圖檔拒收。
- 存檔落 `data/assets/<project>/`，板 JSON 只存 URL（不撐爆板檔）。
- 貼回後 `get_card` 的該框會多回 `result`（改後畫面磁碟路徑），與 `shot`（前）並列。

## 常見狀況

- **框跨多張 gallery 圖**：R 編號跨全卡的圖片清單連續編號；`set_region_result` 靠 R 編號
  定位，不必指定是哪張圖。
- **找不到 R 編號**：先 `get_card` 看現有 `regions[].n`；沒有框就是使用者還沒圈——
  可用 `attach_image` 先把畫面貼上去，請使用者圈框標任務。
- **app 沒跑起來**：先照專案的啟動方式把 app 跑起來（見 skill `run` 或專案啟動慣例），
  再導頁截圖。
