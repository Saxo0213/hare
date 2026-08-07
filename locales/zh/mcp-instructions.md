# MCP server instructions（中文對照）

對應 `lib/tools.mjs` 的 `INSTRUCTIONS`（HARE 7c2f90b4）。英文版為上線主線，本檔為中文對照。
每條連線固定注入，只描述「何時必須使用 HARE」；不放專案背景、接卡流程或個別工具說明。

> 當需要呈現多個事項如何排序、相互依賴、阻塞或影響時，必須使用 HARE 建立有方向的關係圖。

說明分層：

1. `INSTRUCTIONS`：HARE 的能力觸發。
2. `get_guide {topic}`：建圖慣例、讀取方式與工作流程；中文對照見 [mcp-guide.md](mcp-guide.md)。
3. tool description／schema：單一工具的操作契約。
4. server validation：資料不變量的真正強制點。
