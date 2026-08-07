---
name: hare-card-conventions
description: HARE 卡片建立準則——把對談內容（需求、決策、任務）寫成白板卡片時，新卡必須「長在圖上」：先搜板、落對位、拉線成索引、帶 refs。「幫我記到白板」「開卡」「把討論整理成卡片」時適用。
---

# HARE 卡片建立準則

白板是依賴圖，不是便利貼牆。每張新卡必答三題：**跟哪些卡有關（先搜）、屬於誰（落點）、關係怎麼畫（拉線）**。答不出＝不建，或併入既有卡。

## 流程

1. **先搜再建**：`search_cards` 換 2-3 組關鍵詞（模組／功能／檔名）。高度相關卡已存在 → `update_card` 或 `add_comment`，不開重複卡；相關但不同 → 記下編號當連線錨點。
2. **落點**：屬某容器 → `parentId`（編號自動繼承「父號-序號」）；屬某分頁 → `page`；跨模組主題 → 頂層＋必拉線。座標省略＝自動落格（skill hare-card-layout）。
3. **拉線＝索引本體**：每張新卡至少一條 edge 連相關卡，談到 N 個模組＝N 條線。`arrow`：flow 動線／inject 依賴／both 雙向；label 一句話寫明關係。線不可跨分頁——跨頁關聯用 pin 卡（`refCard`）。
4. **內容**：plan/exec/chip 建卡當下帶 `refs:[{path,label,uuid?}]`（path 相對 refBase）；desc 寫多行 Markdown；待辦進 `tasks`（get_ready_cards 才撿得到）；決策脈絡進 `add_comment`；status 只用 note/plan——real 限實跑驗證過。
5. **自檢**：有父容器、有線、或被 pin 引用——至少其一，否則＝孤卡＝沒建完。

## 樣板（參考板上 W2）

主題＝容器卡（歷程記 desc）；各功能面＝子卡（各帶 desc＋refs）；跨主題關聯＝容器間的線。

## 反模式

卡片海（N 張零連結）；「之後再連線」；重複開卡（先搜）；裸路徑卡（描述程式無 refs）。
