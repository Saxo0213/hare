# 第三方授權聲明（Third-Party Licenses）

HARE 本身採 **Apache License 2.0**（見 `LICENSE`）。下列第三方套件皆為 **MIT License**，
可自由使用、修改、散布。條文逐字抄錄自各套件 `node_modules/<pkg>/LICENSE` 檔案。

執行期：`@xyflow/react`、`react`、`react-dom`、`@dagrejs/dagre`
建置期：`vite`、Tauri 桌面殼工具鏈
後端與 MCP 伺服器為零依賴（僅用 Node.js 內建模組）。

---

## React Flow（@xyflow/react）

版本：12.11.2（`package.json` 鎖定 `^12.3.5`）
Repository: https://github.com/xyflow/xyflow

```
MIT License

Copyright (c) 2019-2025 webkid GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**React Flow attribution 依使用者裁定隱藏**（B7，2026-07-18）：`src/App.jsx` 的 `<ReactFlow>`
元件設定 `proOptions={{ hideAttribution: true }}`，隱藏畫布右下角的內建 attribution 浮水印。
React Flow（@xyflow/react）以 **MIT License** 釋出，MIT 授權不強制在 UI 保留 attribution 浮水印；
只要保留本檔的授權文與著作權聲明即屬合規。attribution 浮水印屬 React Flow 商業方案的請求而非
授權條件，隱藏不影響 MIT 合規。此處保留完整 MIT 授權文即為授權紀錄。

---

## React（react + react-dom）

版本：18.3.1（`package.json` 鎖定 `^18.3.1`）
Repository: https://github.com/facebook/react

```
MIT License

Copyright (c) Facebook, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

（`react-dom` 與 `react` 同一 repository、同一版權聲明與授權條文。）

---

## Vite（vite + @vitejs/plugin-react）

版本：vite 5.4.21（鎖定 `^5.4.10`）／@vitejs/plugin-react 4.7.0（鎖定 `^4.3.3`）
Repository: https://github.com/vitejs/vite

```
MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

（`@vitejs/plugin-react` 為 Vite 官方專案的一部分，`node_modules/@vitejs/plugin-react/LICENSE`
與上述條文逐字相同，版權人同為 VoidZero Inc. and Vite contributors。二者皆為建置期
`devDependencies`，不隨 `dist/` 產物散布，僅列於此供完整揭露。）

Vite 自身發佈的產物另外打包了多個第三方套件（Apache-2.0／BSD-2-Clause／ISC／MIT 等，
詳見 `node_modules/vite/LICENSE.md`），這些是 Vite 建置工具鏈內部依賴，並非本專案
`dist/` 產物的一部分，故不逐一抄錄於此。

---

## Dagre（@dagrejs/dagre + @dagrejs/graphlib）

- 版本：@dagrejs/dagre 3.0.0（相依 @dagrejs/graphlib 4.0.1）
- 授權：MIT License
- 專案：https://github.com/dagrejs/dagre
- 用途：白板卡片分層自動排版（lib/layout.mjs layoutLayered；使用者 2026-07-13 同意引入）

```
Copyright (c) 2012-2014 Chris Pettitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 授權範圍說明

- 上述四個套件（含各自子套件 react-dom／@vitejs/plugin-react）皆為 **MIT License**，
  對使用、修改、散布（含商業用途）無限制，僅要求保留版權聲明與授權條文——本檔即為此目的而寫。
  不與 `CLAUDE.md` 的「零新依賴」鐵律衝突（該鐵律規範的是 Python 管線／辨識核心，`roadmap-viz/`
  自始即為獨立於管線之外的視覺化工具，其依賴清單見 `package.json`，此處只是依規定揭露授權）。
- 本檔案由人工比對 `package.json`／`node_modules/*/package.json` 版本號與各自 `LICENSE`
  檔案內容產出（2026-07-11），非自動產生；日後升級套件版本時建議重新核對條文與版本號是否仍一致。

---

## Tauri 桌面殼（W3-4 打包發布，2026-07-18 補記）

- 版本：@tauri-apps/cli 2.11.4（devDependency）；Rust crates `tauri` 2.11.3、`tauri-build`
  2.6.3、`tauri-plugin-log` 2、`tauri-plugin-window-state` 2、`tauri-plugin-single-instance` 2
- 授權：**MIT OR Apache-2.0 雙授權**（Tauri 官方全系採此雙授權，使用者可擇一適用；
  條文見 https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT 與 LICENSE_APACHE-2.0）
- 定位：**建置期依賴**（同 vite 慣例，鐵律 1 例外條款）——產出 `src-tauri/target/release/`
  安裝包；runtime 端 HARE 自身程式碼不連結 Tauri 之外的新依賴
- 桌面殼渲染引擎＝ **Microsoft Edge WebView2 Runtime**（隨 Windows 散布或由安裝包引導安裝，
  適用 Microsoft 授權條款 https://developer.microsoft.com/microsoft-edge/webview2/ ，
  不隨 HARE 打包散布）
- Rust crate 依賴樹的完整授權清冊可用 `cargo license`（或 `cargo about`）於 `src-tauri/`
  產出；正式對外發布安裝包前建議跑一次並附發布頁
