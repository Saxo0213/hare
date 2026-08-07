---
name: hare-card-conventions
description: HARE 卡片建立準則——把對談內容（需求、決策、任務）寫成白板卡片時，新卡必須「長在圖上」：先搜板、落對位、拉線成索引、帶 refs。「幫我記到白板」「開卡」「把討論整理成卡片」時適用。
---

# HARE 卡片建立準則

白板是依賴圖，不是便利貼牆。每張新卡必答三題：**跟哪些卡有關（先搜）、屬於誰（落點）、關係怎麼畫（拉線）**。答不出＝不建，或併入既有卡。

## 流程

1. **先搜再建**：`search_cards` 換 2-3 組關鍵詞（模組／功能／檔名）。高度相關卡已存在 → `update_card` 或 `add_comment`，不開重複卡；相關但不同 → 記下編號當連線錨點。
2. **卡與線同一步（2026-07-22 裁決 D20）**：關係在建卡呼叫裡就成立，不拆成「先建卡、再拉線」兩段——屬容器 → `parentId`（編號自動繼承）；有上游 → `after=<卡號>`（同一次寫入自動成線）；跨頁關聯 → pin 卡（`refCard`）。多條關聯＝建卡後**同一輪緊接** `add_edge {relation, note}` 補齊；談到 N 個模組＝N 條線。`relation` 四型：prerequisite 前置／reference 參照／imports 引用／validates 驗收；不確定就帶 `inferred:true`。線不可跨分頁。
3. **內容**：plan/exec/chip 建卡當下帶 `refs:[{path,label,uuid?}]`（path 相對 refBase）；desc 首行＝耐久句、多行 Markdown；待辦進 `tasks`（get_ready_cards 才撿得到）；決策脈絡進 `add_comment`；status 只用 note/plan——real 限實跑驗證過。座標省略＝自動落格（skill hare-card-layout）。
4. **自檢**：有父容器、有線、或被 pin 引用——至少其一，否則＝孤卡＝沒建完；關係若留到「之後再補」＝流程做錯，不是待辦。

## 樣板（參考板上 W2）

主題＝容器卡（歷程記 desc）；各功能面＝子卡（各帶 desc＋refs）；跨主題關聯＝容器間的線。

## 反模式

卡片海（N 張零連結）；**建卡與拉線拆成兩段工作**（「之後再連線」＝裁決 D20 明禁）；重複開卡（先搜）；裸路徑卡（描述程式無 refs）。
