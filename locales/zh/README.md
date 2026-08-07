# locales/zh — MCP 中文對照版

上線主線＝英文（`lib/tools.mjs` 的 description／inputSchema／INSTRUCTIONS 與
`lib/guide.mjs` 的 get_guide 主題，agent 每次連線／按需吃進 context，精簡＝省 token）。
本資料夾保存**中文對照版**，供中文使用者查閱、以及未來若要做語言切換時當來源。

- [mcp-instructions.md](mcp-instructions.md) — server instructions（initialize 注入的能力觸發）中文版
- [mcp-guide.md](mcp-guide.md) — get_guide 六個詳細主題（`lib/guide.mjs`）全文中文版
- [mcp-tools.md](mcp-tools.md) — 50 個工具的 description＋參數說明中文版

維護規則：改 `lib/tools.mjs`（INSTRUCTIONS／工具語意）或 `lib/guide.mjs`（主題內容）時，
同步更新這裡的對照條目（描述精簡度以英文版為準，中文照譯、不回膨脹）。
程式碼註解與錯誤訊息仍為中文（錯誤訊息被測試斷言鎖定，且不佔連線 token）。
