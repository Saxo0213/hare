// 認證授權：分級授權＋writer 防偽。零依賴，純 node 邏輯。
//
// 三層授權模型（由「有沒有設 token」決定走哪條，向後相容為第一原則）：
//   1) per 專案 token（存 data/projects.json 的 auth 映射，見 lib/projects.mjs）：
//      每個 token 映射 { role, identity }；role=read<write<admin；private:true ⇒ 連讀都要 token。
//      writer 身分由 token 反查（identity），呼叫端不得自報 ⇒ 變更日誌無法偽造。
//   2) 全域 ROADMAP_TOKEN（legacy）：該專案未設 per 專案 token 時沿用——讀公開、
//      寫需帶對的全域 token（＝admin override，操作者總控）。
//   3) 開發模式：兩者都沒設 ⇒ 恆真（與今日行為完全一致）。
// 讀取：非私有專案一律公開（沿襲今日「讀公開」）。
import { getProjectAuth, findTokenGrant } from "./projects.mjs";
import { normalizeProjectId, DEFAULT_PROJECT } from "./store.mjs";

// 角色階：admin 涵蓋 write 涵蓋 read。
const RANK = { read: 1, write: 2, admin: 3 };
export function roleMeets(role, need) { return (RANK[role] || 0) >= (RANK[need] || 0); }

// 取 Authorization: Bearer <token> 的 token（無則 null）。
export function bearerToken(req) {
  const h = req?.headers?.authorization || req?.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1] : null;
}

// 向後相容：舊的同步布林檢查（全域 ROADMAP_TOKEN；未設＝恆真）。
// 保留給任何仍走「全域寫入 token」語意的呼叫端；本模組自己的端點改用 authorize()。
export function checkAuth(req) {
  const token = process.env.ROADMAP_TOKEN;
  if (!token) return true; // 開發模式：恆真
  return bearerToken(req) === token;
}

// 主授權入口。回傳 { ok, status, role, identity, writer, project, error }。
//   ok:true  → 放行；writer＝變更日誌應記的身分（null＝沿用呼叫端預設如 browser/mcp-http）。
//   ok:false → status 401（未提供／未知憑證）或 403（憑證有效但權限不足／跨專案越權）。
// need：本次操作所需最低角色 read|write|admin。
export async function authorize(req, { project, need = "read" } = {}) {
  let pid;
  try { pid = normalizeProjectId(project); } catch { pid = DEFAULT_PROJECT; }
  const cfg = await getProjectAuth(pid);
  const presented = bearerToken(req);
  const globalTok = process.env.ROADMAP_TOKEN || null;
  const hasProjTokens = !!(cfg && cfg.tokens && Object.keys(cfg.tokens).length);

  const grant = (role, identity) => ({
    ok: true, status: 200, role, identity: identity || null, writer: identity || null, project: pid,
  });
  const publicRead = () => ({ ok: true, status: 200, role: "public", identity: null, writer: null, project: pid });
  const deny = (status, role = null, identity = null) => ({
    ok: false, status, role, identity, writer: null, project: pid,
    error: status === 403
      ? `forbidden：憑證有效但權限不足（需 ${need}）`
      : "unauthorized：需有效的 Authorization: Bearer <token>",
  });

  // 開發模式：本專案無 per 專案 token 且無全域 token ⇒ 恆真（今日行為）。
  if (!hasProjTokens && !globalTok) return grant("admin", null);

  // 讀取：非私有專案一律公開（含 legacy 全域 token 模式與非私有 per 專案模式）。
  if (need === "read" && !(hasProjTokens && cfg.private)) return publicRead();

  // 到這裡：需要憑證（write/admin，或私有專案的 read）。
  if (!presented) return deny(401);

  // 本專案 per 專案 token。
  if (hasProjTokens && cfg.tokens[presented]) {
    const e = cfg.tokens[presented];
    const role = e.role || "write";
    if (roleMeets(role, need)) return grant(role, e.identity);
    return deny(403, role, e.identity || null); // 憑證有效但角色不足
  }

  // 全域 ROADMAP_TOKEN＝admin override（維持操作者總控權；不強加身分，沿用預設 writer）。
  if (globalTok && presented === globalTok) {
    if (roleMeets("admin", need)) return grant("admin", null);
    return deny(403, "admin", null);
  }

  // 憑證在「別的專案」有效但不屬本專案 ⇒ 403（可辨識的跨專案越權，非單純未知）。
  const elsewhere = await findTokenGrant(presented);
  if (elsewhere) return deny(403, elsewhere.role, elsewhere.identity);

  // 完全未知的 token ⇒ 401。
  return deny(401);
}
