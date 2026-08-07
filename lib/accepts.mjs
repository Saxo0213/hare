// 驗收項（accepts）——HARE 3ac5e77b accepts
// 一張卡的「做完是什麼樣」清單。每項＝{ state, desc, anchor }：
//   state  短標籤（A／B／登入成功…），同一張卡內唯一
//   desc   這個狀態下可以親眼確認的事
//   anchor 現實中的位置，四種語法（沿用板上既有慣例，不另發明）：
//            R3                  圖片卡的範圍框
//            src/auth.mjs        檔案
//            src/auth.mjs#login  函數（同 refs 的 path#label）
//            W7                  另一張卡的編號
// 與任務的分別：任務是「要做什麼」，驗收是「做完長什麼樣」——前者會被做完刪掉，
// 後者跟著卡片一輩子，是卡片對現實的映射。
// 純函式、前後端共用（前端自 ../lib/accepts.mjs import，同 tasks.mjs 慣例）。

// anchor 型別判定：純資料判斷，不碰檔案系統
export function anchorKind(a) {
  const s = String(a || "").trim();
  if (!s) return null;
  if (/^R\d+$/.test(s)) return "region";                    // 圖片範圍框
  if (/[/\\.]/.test(s)) return s.includes("#") ? "symbol" : "file";
  return "card";                                            // 其餘視為卡號
}

// 正規化：陣列進、陣列出。丟掉沒有 state 或 desc 的項；state 去重（後蓋前）。
// 相容寬鬆輸入：字串項 "A｜說明｜錨點" 或 "A|說明|錨點" 也吃（路一的字串約定直接升級）。
export function normalizeAccepts(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Map();
  for (const raw of v) {
    let state = "", desc = "", anchor = "";
    if (typeof raw === "string") {
      const parts = raw.split(/[｜|]/).map((x) => x.trim());
      [state = "", desc = "", anchor = ""] = parts;
    } else if (raw && typeof raw === "object") {
      state = String(raw.state ?? "").trim();
      desc = String(raw.desc ?? "").trim();
      anchor = String(raw.anchor ?? "").trim();
    }
    if (!state || !desc) continue;
    seen.set(state, { state, desc, ...(anchor ? { anchor } : {}) });
  }
  return [...seen.values()];
}

export function acceptsOf(data) { return normalizeAccepts(data?.accepts); }

// 注入／摘要用的單行式：「A｜說明｜錨點」
export function acceptLine(a) {
  return [a.state, a.desc, a.anchor].filter(Boolean).join("｜");
}
