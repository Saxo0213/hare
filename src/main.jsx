import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { t as T } from "./i18n.mjs";
import "./index.css";

// 全域錯誤邊界：前端崩潰時不再整頁白屏（看起來像資料被清空、
// 實際資料檔無恙）——顯示明確錯誤訊息＋重新整理鈕。資料真相在伺服器資料檔，
// 前端任何崩潰都不影響它。
// HARE 2e7c91a4 ErrorBoundary
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: "80px auto", fontFamily: "system-ui, sans-serif",
        background: "#fff", border: "1px solid #cdd9e8", borderRadius: 12, padding: "24px 28px",
        boxShadow: "0 3px 16px rgba(10,30,60,.14)" }}>
        <h2 style={{ margin: "0 0 8px", color: "#d23b39" }}>{T("m_errTitle")}</h2>
        <p style={{ color: "#4a5b73", lineHeight: 1.6 }}>{T("m_errBody")}</p>
        <pre style={{ background: "#f4f7fa", padding: 10, borderRadius: 8, fontSize: 12,
          overflowX: "auto", color: "#132033" }}>{String(this.state.err?.stack || this.state.err)}</pre>
        <button style={{ padding: "8px 18px", border: "1px solid #0a6fb0", borderRadius: 8,
          background: "#0a6fb0", color: "#fff", fontSize: 14, cursor: "pointer" }}
          onClick={() => location.reload()}>{T("m_errReload")}</button>
      </div>
    );
  }
}

// HARE 7c3a1f8e theme_switch —— 早套用主題（免 FOUC）：render 前先讀偏好寫 data-theme。
// 淺＝"light"、深＝"dark"、跟隨系統＝不設屬性（交還 index.css 的 @media 判定）。
// UI_LS 鍵名與 App.jsx 一致（hare-roadmap-ui-v1.theme）。
try {
  const pref = JSON.parse(localStorage.getItem("hare-roadmap-ui-v1") || "{}").theme;
  if (pref === "light" || pref === "dark") document.documentElement.dataset.theme = pref;
} catch { /* localStorage 不可用時退回 @media 跟隨系統 */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
