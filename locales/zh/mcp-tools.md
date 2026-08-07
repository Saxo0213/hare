# MCP 工具說明（中文對照）

對應 `lib/tools.mjs` 的 `TOOLS`（HARE 55cda112）50 個工具的 description 與參數說明。
英文版為上線主線；本檔照譯、與英文版同精簡度。深規則見 [mcp-guide.md](mcp-guide.md)。

共用參數（注入所有單板工具）：
- `project`：專案代號（省略＝default）。
- `page`：分頁 id 或名稱（省略＝全專案視角）。
- `fields`（list_cards/get_card）：只回指定欄位（任意卡片資料鍵，如 color/bg/position）；省略＝預設摘要。

## 導引與總覽（唯讀）

| 工具 | 說明 |
|---|---|
| get_overview | 專案總覽：G0 導引摘要、分頁、泳道、卡片/線段數、狀態/型別統計、未完任務數。專案脈絡未載入時先呼叫這個。 |
| get_guide | 按需載入一個 HARE 詳細指南主題。省略 topic＝主題索引（每題一行）；給 topic＝該題全文。topics：mapping/projects/work/code/images/safety。 |

## DAG 分析（唯讀）

| 工具 | 說明 |
|---|---|
| get_ready_cards | 列出就緒可接的卡（上游全 real、自身未 real）。每筆帶 kind（work/guide/container）、open_tasks 與認領狀態；`claimed:false`＝只看可接手的。`types`＝納入分析的型別（省略＝工作卡：note 型且 status≠note，以下同）。 |
| get_blockers | 一張卡的阻塞鏈：上游還沒 real 的前置卡（遞迴）。空＝就緒。`card`＝卡片 id/編號/名稱（以下同）。 |
| get_downstream | 一張卡的下游影響（遞迴）。可選 `relations`（預設 [prerequisite]）/`max_depth`/`max_cards`；`detail:true`＝加權影響範圍（每卡分數、途徑、原因，依分數排序）。 |
| detect_cycles | 依賴環偵測（卡片編號序列）。hasCycle:false＝乾淨 DAG。 |
| critical_path | 關鍵路徑：最長依賴鏈（以卡片數計）。有環時回報無法計算。 |
| get_graph | 一發看懂整板（token 精簡）：`view` pack＝結構圖（預設）、steps＝拓撲建造順序、insights＝唯讀結構健康檢查（hub/橋/孤卡/依賴倒置/低信心/懸空 pin）。比整包 list_cards 便宜。 |
| get_changes | 自某 rev 以來的增量變更：回訪 agent 只讀差異、不必重新入職。逐卡 added/updated/removed＋線段數＋writers。`since_rev`（必填）＝回 rev 大於此值的變更；`limit` 限卡數（預設 100，超出回 truncated:true）。 |

## 認領協定

| 工具 | 說明 |
|---|---|
| claim_card | 認領卡片（「我在做這張」）：設 data.claim={agent,t}。他人新鮮認領（15 分內）→拒絕；同 agent 重複認領＝刷新心跳；stale 可接手。`agent`＝認領者身分，誠實記錄進卡片與變更日誌。 |
| release_card | 釋放認領（刪 data.claim）——做完或放手時呼叫，讓別人能接。 |
| list_active | 列出被認領的卡：編號/名稱/狀態/認領者/時戳/stale 旗標（心跳逾 15 分＝可接手）。一眼看誰在做什麼。 |

## 卡片

| 工具 | 說明 |
|---|---|
| list_cards | 列出卡片（可依 status/type 過濾）：精簡列（num/label/status/type/parent/open_tasks/desc 首行），不含任務內文。fields 自選欄位；limit/offset 分頁（預設 200、上限 5000）。 |
| list_tasks | 只回「帶開放任務的卡」：編號/名稱/狀態/分頁＋tasks（附每卡數量）。任務視圖；全量走 list_cards。 |
| get_card | 取單卡（id/編號/名稱）。預設精簡摘要＋rel 關係摘要（up/down/parent/kids/pins＝鄰居卡號）；色彩/背景/座標等用 fields。 |
| get_card_tree | 一發回某卡鄰域：卡片＋子卡樹（遞迴、`depth` 限深，預設 3）＋碰到子樹的線段（附對端編號/名稱）＋引用它的 pin 卡。 |
| search_cards | 關鍵字搜尋：編號/名稱/說明/任務/refs/commit hash（用 hash 反查該變更背後的卡）。結果不含 refs（get_card 才有）。limit 預設 100、上限 5000。 |
| add_card | 新增卡片（x/y 皆省略＝自動落格；`after`=<上游卡>＝落其下游避碰、同筆自動建 after→新卡的線、與 after 同層同父；若給了 x/y 則只建線）。`type`：note（預設）/pin（引用另一卡，需 refCard）/dep（外部依賴）/res（資料夾資源）。編號首選 `cat` 分類字母（如 "W"→系統補該類最小空號）；`num` 僅相容保留、撞號即錯；子卡自動繼承「父號-序號」。`tasks`＝字串陣列（自動補時戳）或 {ISO時戳:文字} dict。描述程式的卡必帶 `refs` 雙層制：檔案級只 {path}；函式級 {path,label,uuid}，label＝程式行 HARE 錨點名。見 get_guide mapping/code。 |
| add_cards | 批次建卡＋建線＋自動排版「一筆寫入」（單一 rev）。`cards`＝1–50 張、依陣列順序建，每張可設批次 `key` 供後續卡/線用 parent/after/source/target 引用（key 須先宣告後使用）；`edges`＝0–100 條（語意同 add_edge）。完整關係建好後，省略座標的本批卡會按分頁／父容器自動分層；既有卡及明示 x/y 的卡不動。cat 自動編號；任一錯誤整批不寫。見 get_guide mapping。 |
| update_card | 更新卡片欄位（id/編號/名稱指定）；null 刪鍵、""/[] 清空。`tasks`：陣列＝依文字對齊合併（沒改的保留原時戳、新的補戳、少的移除），dict＝原樣覆寫，null 刪除。`doneTasks` 建議走 complete_task 不直改。`type`＝改卡型（只限內容卡互轉，lane/img 拒轉；pin 需 refCard）。`listing`＝res 卡的資料夾列表。refs 雙層制同 add_card；見 get_guide code。 |
| move_card | 搬卡：改父容器（進子畫布）及/或改座標。parentId null＝脫離成頂層（座標轉絕對、不跳位）；省略＝只改座標。巢狀時 x/y 相對父卡（建議 x≥8、y≥父卡 childTop）。見 skill hare-nested-architecture。 |
| delete_card | 刪卡（連同子卡與相連線段）。`card`＝單張；`cards`＝批次清單（原子性：任一找不到＝整批不刪）。 |
| validate_cards | 卡片 lint：缺 desc/refs、refs/錨點斷鏈、編號重複、板型提示、殘留舊欄位。只回報不修改。`summary:true`＝只回各類數量；limit/offset 分頁（預設 100）。 |

## 分頁與匯入

| 工具 | 說明 |
|---|---|
| add_page | 為專案新增空分頁。撞名（分頁名已存在）拒絕。 |
| delete_page | 刪除整個分頁（連同頁上所有卡與線，回報數量）——破壞性操作；最後一頁不可刪。 |
| import_mermaid | 匯入 Mermaid flowchart 子集（graph TD/LR、A[標籤]、A-->B、A-->\|標籤\|B、%% 註解）到「新分頁」成卡片＋連線，分層排版；不支援的行逐行回報 skipped、不猜語意。 |

## 任務

| 工具 | 說明 |
|---|---|
| complete_task | 完成（封存）或還原卡片任務。task＝索引／唯一關鍵字／ISO 時戳鍵（任務儲存為 {時戳:文字}）；`all:true`＝一次封存（或配 restore 還原）全部開放任務。例外：啟動檢核必須依序完成，最後「使用者核可」不可由 agent 代銷。封存帶時戳。 |
| tag_commit | 把 git commit hash 回填到卡片封存任務（先銷卡、後 commit 的常態流程）。只補尚無 commit 的封存項；`contains` 限定內文關鍵字。 |

## 討論串

| 工具 | 說明 |
|---|---|
| add_comment | 卡片留言：追加 {writer,t,text}（決策脈絡/驗證依據/疑問，與 tasks、desc 分離）。writer 由連線身分決定，呼叫端不可指定。 |
| list_comments | 列出卡片討論串（早→晚），每則 {writer,t,text}。 |
| delete_comment | 依索引刪一則留言（0＝最早）。 |

## 圖片

| 工具 | 說明 |
|---|---|
| attach_image | 把本機點陣圖（png/jpg/gif/webp，如 playwright 截圖）存入白板資產。給 `card`＝追加到該圖片卡 gallery 並切換顯示；省略＝新建圖片卡（`num` 預設補 N 類空號）。 |
| set_region_result | 把截圖設為某範圍框的「結果圖（後）」，與 shot（意圖/前）並列供使用者對照。貼圖成功不構成 status=real——UI 對錯由使用者判斷。`region`＝get_card 回的 R 編號（"R1" 或 1）。 |

## 線段

| 工具 | 說明 |
|---|---|
| list_edges | 列出線段（起點→終點、label、handles）。limit 預設 200（可加大、上限 5000）；截斷時回 truncated:true＋total。 |
| add_edge | 新增線段（source＝上游，排版分欄依此）。`arrow`：flow（預設）/inject（import）/both。`relation` 語意：prerequisite/reference/imports/validates（省略＝板型投影）；`inferred:true`＝推測（tier inferred），否則 asserted。`note`＝一行證據備註。`handles`＝端點面向 {source,target}：l/r/t/b。 |
| update_edge | 依 id 更新線段：label（null 清除）/source/target/arrow（flow/inject/both）/relation（設定即蓋 tier asserted，除非 inferred:true）/note。 |
| delete_edge | 依 id 刪除線段。 |

## 專案管理

| 工具 | 說明 |
|---|---|
| list_projects | 列出所有專案：id/標題/前綴/rev/卡數/資料檔。 |
| create_project | 建立專案。分頁在專案檔內——用各工具的 page 參數加，不在這層。追蹤外部 codebase 的專案請設 `refBase`（refs.path 解析基準根的絕對路徑，省略＝HARE repo 根；refs 一律寫相對路徑）。`id`＝英數/-/\_、英數起頭（當檔名）；`template`：blank（預設）/roadmap（泳道＋說明卡）；`layout`＝格線覆寫（存 meta.layout：x0/y0/colPitch/cardW/rowPitch/rowPitchTall/childX/childY0/childPitch）。 |
| rename_project | 改專案代號（搬資料檔與變更日誌）。default 不可改名。 |
| delete_project | 永久刪除專案（資料/日誌/備份）。不可復原——優先用 archive_project。default 不可刪。 |
| archive_project | 封存專案（非破壞：搬到 data/archive/、清單隱藏、代號保留）。unarchive_project 還原。default 不可封存。 |
| unarchive_project | 解封專案，恢復列於清單。 |

## 分析與快照

| 工具 | 說明 |
|---|---|
| analyze_codebase | 反向分析目錄樹成架構板（目錄＝容器卡、檔案＝子卡帶 refs、import 依賴線）；自動設專案 refBase＝分析根。帶 page＝寫進既有專案該分頁（分頁已有卡拒絕）；不帶＝需全新專案代號（不可 default）。`maxDepth` 預設 6、`perDir` 預設 25、`maxFiles` 預設 400、`gitignore` 預設 true、`imports` 預設 true。 |
| scan_file_tree | 生成視覺檔案總管分頁（資料夾＝巢狀資源卡、檔案＝listing 列、不建獨立檔案卡）——有別於 analyze_codebase（連結分析）。分頁規則同 analyze_codebase。`maxDepth` 預設 5、`maxList` 預設 60（每卡列數，餘者彙總）。見 get_guide code。 |
| scan_interfaces | 唯讀介面掃描：每檔 exports＋import 符號。給 agent 畫語意板的事實來源（分組取捨由 agent 判斷）。path 省略＝專案 refBase；`maxFiles` 預設 400。 |
| create_snapshot | 整版白板快照（append-only、非破壞）。回滾用 rollback_snapshot。 |
| list_snapshots | 列出快照（id/rev/label/時間/writer/卡數），早→晚。 |
| rollback_snapshot | 回滾到指定快照：以「新 rev」寫回（本身也可再回滾；歷史永不抹除）。回滾前建議先 create_snapshot。 |

## 系統

| 工具 | 說明 |
|---|---|
| request_permission | headless 對談輪的權限橋（--permission-prompt-tool）：持久化請求、等使用者裁決、回 {behavior:allow\|deny}。非一般 agent 使用。 |
