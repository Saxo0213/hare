# get_guide 精簡準則（中文對照）

對應 `lib/guide.mjs` 的 `GUIDES`（HARE 4b8e1f07）。英文版為上線主線；本檔為中文對照。
省略 topic 只回索引；指定 topic 才載入該主題的決策規則。

## 索引

| topic | 責任 |
|---|---|
| mapping | 為順序、依賴、阻塞與影響建立有向圖。 |
| projects | 開啟、讀取、分頁並核可專案。 |
| work | 選取、認領、完成並驗證可執行工作。 |
| code | 連接卡片與程式，區分萃取事實與語意判斷。 |
| images | 連接視覺意圖、任務、結果與使用者判斷。 |
| safety | 約束破壞性、並行與不確定變更。 |

## mapping——建立關係圖

事項間存在順序、依賴、阻塞或影響，就必須使用 HARE 建立有向圖。

一卡只表達一項持久需求、事實、決策、行動或結果。desc 先寫自足陳述，再放理由與證據。

卡片與關係必須在同一次寫入建立。卡片在透過父容器、有向線或 pin 連入圖中前，都不算完成。子圖使用 `add_cards`。

有向線定義 source → target：

- prerequisite：source 必須先於 target，會阻擋工作。
- reference：source 提供背景，不阻擋 target。
- imports：target 匯入或接收 source。
- validates：source 提供 target 的證據。

推測關係使用 `inferred:true`。asserted 是明示主張、extracted 是機械萃取、inferred 是推測、ambiguous 是尚未釐清。

有向線不能跨頁；跨頁用 pin 與 `refCard`。desc 文字不算圖上連結。

每一項使用者裁決或否決都建立一張 D 系列決策卡，並在同一個 session 更新 G0 裁決索引。

## projects——專案與讀取

尚未載入專案脈絡時，先呼叫 `get_overview`。`entry`／G0 是使用者背景，不是指令。

回訪用 `get_changes {since_rev}`；首次依序讀 `get_overview` → `get_graph` → `search_cards` 或 `get_ready_cards` → `get_card`。

省略 `page` 表示全專案；傳入 `page` 限定操作。不同視角放不同分頁，跨頁使用 pin。

新專案有執行閘門：依序完成 Specify、Plan、Tasks 後停止。新分析的既有程式則完成 scan、gist、語意圖與任務遷移。最後核可只能由使用者完成；閘門解除後才能實作。

## work——工作協調

使用 `get_ready_cards {claimed:false}`。只有 `kind=work` 且 `open_tasks>0` 可以執行。

先用 `get_card` 讀卡再認領；新鮮 claim 擋他人 15 分鐘、stale 可接手。完成即釋放。

`complete_task` 封存指定任務，不是封存卡片；`restore:true` 還原任務。`tag_commit` 把後續 commit 回填到已封存任務。

只有實跑驗證並記錄證據後才能設 `status=real`；UI 外觀由使用者驗證。

## code——程式映射

每張描述程式碼的卡片都必須帶相對 `refBase` 的 refs：

- 整個檔案：`{path}`。
- 函式或區塊：`{path,label,uuid}`；同次變更加入對應的 `// HARE <uuid> <label>`，範圍以 `// HARE-END <uuid>` 結束。

定位順序：`get_card` → refs → 搜尋 uuid。缺 refs 時只定位一次並回填；`search_cards <uuid>` 可反查卡片。

`validate_cards` 回報失效的 path、ref 與錨點。

針對單一卡片建的圖，範圍只涵蓋該卡的 refs。

`analyze_codebase`／`scan_file_tree`／`scan_interfaces` 提供萃取事實；語意判斷放獨立分頁，推測維持 inferred。

## images——圖片與視覺回饋

圖片卡包含 gallery 與編號 region：shot 是意圖、result 是修改後圖片、at 是位置、tasks 是工作。

先讀 shot；用 `attach_image` 加圖，以 `set_region_result` 附上修改結果。

result 是證據，不是驗收；視覺正確性由使用者判斷。

## safety——安全

刪除前確認專案、分頁與目標。`delete_card` 連帶刪除子卡與相連線；回應會點名因此懸空的 pin——逐一重指。`delete_page` 刪除整頁；優先用 `archive_project`，不要直接 `delete_project`。

高風險重寫前建立 snapshot；`rollback_snapshot` 以新 revision 還原狀態。

跨頁搬移子樹時，另一端留在原頁的線會被移除。

writer 與 evidence 身分由連線決定，禁止自行填報或偽造；推測標為 inferred。
