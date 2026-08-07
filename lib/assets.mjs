// 圖片資產儲存（共用）——HTTP `POST /api/assets`（lib/roadmap-api.mjs）與 MCP
// `attach_image`／`set_region_result`（lib/tools.mjs）共用同一份寫檔邏輯：板 JSON 只存
// URL、二進位落 data/assets/<project>/（板檔與 localStorage 快取不被 base64 撐爆）。
// 零依賴（node 內建 fs/path）。
// HARE 9b2f0c7a SAVE_ASSET
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dataDir, normalizeProjectId } from "./store.mjs";

export const ASSET_MAX_BYTES = 8 * 1024 * 1024; // 上限 8MB（與前端上傳一致）

// 資產檔名：非 [\w.\-] → _、尾 60 字；無點陣圖副檔名補 .png（svg 等被改名＝不被當原型別服務）；
// 前綴 base36 時戳確保唯一，且檔名帶時戳＝GET 端可 immutable 長快取。
export function assetFileName(name) {
  const safe = String(name || "img").replace(/[^\w.\-]+/g, "_").slice(-60) || "img";
  const ext = /\.(png|jpe?g|gif|webp)$/i.test(safe) ? "" : ".png";
  return `${Date.now().toString(36)}-${safe}${ext}`;
}

// 點陣圖 magic-bytes 嗅探：回傳 png/jpg/gif/webp 或 null（非點陣圖）。MCP 從磁碟讀
// 任意路徑時用它擋掉 svg／非圖檔（HTTP 端沿舊行為靠副檔名改名，不呼叫這裡）。
export function sniffRaster(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// 寫二進位到 data/assets/<project>/，回 { file, url }。空／超限 throw；project 自動正規化。
// 內容型別驗證（sniffRaster）由呼叫端視情境決定：HTTP 沿舊行為不驗、MCP attach_image 驗。
export async function saveAsset(project, name, buf) {
  const pid = normalizeProjectId(project);
  if (!buf || !buf.length) throw new Error("空內容");
  if (buf.length > ASSET_MAX_BYTES) throw new Error("檔案過大（上限 8MB）");
  const file = assetFileName(name);
  const dir = resolve(dataDir(), "assets", pid);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, file), buf);
  return { file, url: `/api/assets/${pid}/${encodeURIComponent(file)}` };
}
