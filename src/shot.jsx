// 截圖：getDisplayMedia 擷取視窗/螢幕一幀 → 回 PNG blob，
// 由呼叫端直接加進圖片卡的圖片清單。就地標註（方框/圓圈/文字）改在卡片內圖片上做（見 ImgNode）。
// 零依賴（瀏覽器原生 getDisplayMedia + canvas）。
import { t as T } from "./i18n.mjs";
// HARE 5c07ed17 SHOT
// 擷取一幀：瀏覽器跳出「選擇分享來源」（可選 螢幕/視窗/分頁）→ 抓一幀 → 回 PNG Blob。
// 需安全上下文（https 或 localhost）；按取消 → 拋 NotAllowedError/AbortError（呼叫端靜默）。
export async function captureDisplayFrame() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error(T("sh_unsupported"));
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream; video.muted = true;
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error(T("sh_readFail")));
      video.play().catch(() => {});
      setTimeout(res, 1500); // 保底：部分環境 onloadeddata 較慢
    });
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(video, 0, 0, w, h);
    return await new Promise((res) => cv.toBlob(res, "image/png"));
  } finally {
    stream.getTracks().forEach((t) => t.stop()); // 立即停止分享（只要一幀）
  }
}
