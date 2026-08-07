// 內建置中對話框（統一於視窗中心顯示，不要用瀏覽器原生彈窗；
// 三模式——confirm（確定/取消）、alert（僅確定）、prompt（帶輸入框），
// 原生 window.confirm/prompt/alert 全數退場）。
// 任何元件呼叫 confirmDialog/alertDialog/promptDialog 取得 Promise；App 以 registerConfirm
// 註冊實際的置中卡片渲染器（.confirm-mask）。未註冊（極早期）＝confirm/alert 視為通過、
// prompt 回 null，不阻斷。
// HARE c0nf1rmd CONFIRM
let handler = null;
export function registerConfirm(fn) { handler = fn; }
const ask = (opts) => new Promise((resolve) => {
  if (typeof handler === "function") handler(opts, resolve);
  else resolve(opts.mode === "prompt" ? null : true);
});
export const confirmDialog = (text) => ask({ mode: "confirm", text });
export const alertDialog = (text) => ask({ mode: "alert", text });
export const promptDialog = (text, def = "") => ask({ mode: "prompt", text, def });
