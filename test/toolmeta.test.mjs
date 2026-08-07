// 入職系統 M2d：工具 metadata token 精簡守衛 ＋ get_guide 行為測試。
// 目的＝防未來 description 回胖、INSTRUCTIONS 混回工作流程；並鎖定 get_guide 的索引/全文契約。
// 純 metadata 檢查，無需暫存檔或 I/O（get_guide 亦為純函式回傳）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, INSTRUCTIONS } from "../lib/tools.mjs";
import { GUIDES, TOPIC_ORDER } from "../lib/guide.mjs";

const cp = (s) => [...String(s || "")].length; // code point 計數（CJK 安全）

// 上限（M2d 驗收）：讀取工具 description ≤180 字元、寫入 ≤300、全體合計 ≤14,000、
// INSTRUCTIONS ≤240。字元＝token 的穩定代理（字元/4 英文 ≈ token；報告另附估算）。
const READ_CAP = 180;
const WRITE_CAP = 300;
const TOTAL_CAP = 14000;
const INSTRUCTIONS_CAP = 240;
// 例外白名單：{ 工具名: 理由 }。目前為空——所有工具皆在上限內（無例外）。
// 若未來某工具必須超標，在此登記理由，測試才放行（強迫「超標＝有意識決策」）。
const OVER_LIMIT_WHITELIST = {};

test("description 長度守衛：讀 ≤180／寫 ≤300（例外需白名單登記理由）", () => {
  const over = [];
  for (const [name, t] of Object.entries(TOOLS)) {
    const cap = t.write ? WRITE_CAP : READ_CAP;
    const len = cp(t.description);
    if (len > cap && !OVER_LIMIT_WHITELIST[name]) over.push(`${name}=${len}（上限 ${cap}）`);
  }
  assert.deepEqual(over, [], "以下工具 description 超標且未列白名單：\n" + over.join("\n"));
});

test("description 合計 ≤14,000 字元（防整體回胖）", () => {
  const total = Object.values(TOOLS).reduce((s, t) => s + cp(t.description), 0);
  assert.ok(total <= TOTAL_CAP, `description 合計 ${total} 字元 > ${TOTAL_CAP}`);
});

test("INSTRUCTIONS ≤240 字元（只保留能力觸發）", () => {
  assert.ok(cp(INSTRUCTIONS) <= INSTRUCTIONS_CAP,
    `INSTRUCTIONS ${cp(INSTRUCTIONS)} 字元 > ${INSTRUCTIONS_CAP}`);
});

test("INSTRUCTIONS 層級：只描述 HARE 使用時機與輸出，不含專案工作流", () => {
  assert.ok(INSTRUCTIONS.includes("must use HARE"), "含決定性的 HARE 使用觸發");
  assert.ok(INSTRUCTIONS.includes("directed relationship map"), "含預期的視覺輸出");
  for (const leaked of ["get_overview", "get_ready_cards", "status=real", "commit", "D-series", "get_guide"]) {
    assert.ok(!INSTRUCTIONS.includes(leaked), `不應混入下層規則：${leaked}`);
  }
});

test("相容性提示：get_overview description 含 'Call this first when project context has not been loaded.'", () => {
  assert.ok(TOOLS.get_overview.description.includes("Call this first when project context has not been loaded."),
    "不支援 server instructions 的 client 需靠此 fallback 找到入口");
});

/* ---------- get_guide 契約 ---------- */
test("get_guide：無 topic＝主題索引（每主題一行摘要，不含全文）", async () => {
  const idx = await TOOLS.get_guide.run({});
  assert.equal(idx.topics.length, TOPIC_ORDER.length, "索引列出全部主題");
  assert.deepEqual(idx.topics.map((x) => x.topic), TOPIC_ORDER);
  for (const row of idx.topics) {
    assert.ok(row.summary && row.summary.length > 0, `${row.topic} 有一行摘要`);
    assert.equal(row.text, undefined, "索引不夾帶全文");
  }
});

test("get_guide：每個 topic 回非空全文，且含該主題關鍵詞", async () => {
  const KEYWORD = { // 每主題一個必含關鍵詞（回歸鎖定內容遷移）
    mapping: "directed edge", projects: "get_overview", work: "complete_task",
    code: "HARE-END", images: "set_region_result", safety: "rollback_snapshot",
  };
  for (const topic of TOPIC_ORDER) {
    const r = await TOOLS.get_guide.run({ topic });
    assert.equal(r.topic, topic);
    assert.ok(r.text && r.text.length > 0, `${topic} 全文非空`);
    assert.ok(r.text.includes(KEYWORD[topic]), `${topic} 全文含關鍵詞「${KEYWORD[topic]}」`);
  }
});

test("get_guide：enum 由 TOPIC_ORDER 導出（schema 與資料同源）", () => {
  assert.deepEqual(TOOLS.get_guide.inputSchema.properties.topic.enum, TOPIC_ORDER);
});

test("get_guide：索引、順序與全文皆由單一 GUIDES registry 導出", () => {
  assert.deepEqual(TOPIC_ORDER, Object.keys(GUIDES));
  for (const topic of TOPIC_ORDER) {
    assert.ok(GUIDES[topic].summary, `${topic} 有摘要`);
    assert.ok(GUIDES[topic].text, `${topic} 有全文`);
  }
});

test("get_guide：所有主題維持精簡且可決策", () => {
  let total = 0;
  for (const [topic, guide] of Object.entries(GUIDES)) {
    assert.ok(guide.summary.length <= 80, `${topic} summary 不超過 80 字元`);
    assert.ok(guide.text.length <= 1000, `${topic} 準則不超過 1000 字元`);
    total += guide.text.length;
  }
  assert.ok(total <= 3500, `六主題總長不超過 3500 字元（目前 ${total}）`);
});

test("get_guide：關鍵原則不可因精簡而失真", () => {
  assert.ok(GUIDES.mapping.text.includes("must use HARE"), "關係觸發必須是決定性規則");
  assert.ok(GUIDES.mapping.text.includes("same write"), "卡片與關係必須同次建立");
  assert.ok(GUIDES.projects.text.includes("context is not loaded"), "只在脈絡未載入時先讀 overview");
  assert.ok(GUIDES.projects.text.includes("Only the user may complete final approval"), "最後核可屬於使用者");
  assert.ok(GUIDES.work.text.includes("not the card"), "complete_task 不得誤稱封存整卡");
  assert.ok(GUIDES.code.text.includes("card that describes code"), "refs 規則只套用於描述程式碼的卡");
  assert.ok(GUIDES.safety.text.includes("drops edges"), "跨頁搬移的斷線副作用不得省略");
});
