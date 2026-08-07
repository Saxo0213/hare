// 卡片款式（W1-3-8 P4）：純函式 registry（驗證/消毒/解析/退回）＋MCP 工具 round-trip
// ＋惡意輸入拒絕＋未知 id 安全退回。隔離沿慣例：HARE_DATA_PATH 指暫存檔、先設 env 再 import。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import {
  BUILTIN_STYLES, BUILTIN_IDS, DEFAULT_APPEARANCE, validateCardStyle, sanitizeCardStyles,
  isValidStyleId, isBuiltin, resolveStyle, styleToAttrs, effectiveAppearance,
} from "../lib/cardstyles.mjs";

/* ============ 純函式 ============ */
test("validateCardStyle：合法款式 round-trip；未知 token key 丟棄、enum 正規化", () => {
  const s = validateCardStyle({ name: "Team", base: "outlined", density: "compact", shape: "pill",
    header: "band", tokens: { accent: "#0A6FB0", surface: "semantic-panel", border: "solid", shadow: "low", junk: "x" } });
  assert.equal(s.name, "Team");
  assert.equal(s.base, "outlined");
  assert.equal(s.density, "compact");
  assert.equal(s.tokens.accent, "#0a6fb0"); // 正規化小寫
  assert.equal(s.tokens.surface, "semantic-panel");
  assert.equal("junk" in s.tokens, false, "未知 token key 丟棄");
});

test("validateCardStyle：非法 enum → 退回預設；非物件/缺 name → throw", () => {
  const s = validateCardStyle({ name: "X", base: "nonsense", density: "huge", shape: "blob", header: "weird" });
  assert.equal(s.base, "classic");
  assert.equal(s.density, "comfortable");
  assert.equal(s.shape, "rounded");
  assert.equal(s.header, "plain");
  assert.throws(() => validateCardStyle({}), /缺 name/);
  assert.throws(() => validateCardStyle({ name: "  " }), /缺 name/);
  assert.throws(() => validateCardStyle("nope"), /物件/);
});

test("validateCardStyle：惡意 accent（非 hex）＝丟棄，不進 CSS", () => {
  const s = validateCardStyle({ name: "M", tokens: { accent: "javascript:alert(1)" } });
  assert.equal("accent" in s.tokens, false);
  const s2 = validateCardStyle({ name: "M", tokens: { accent: "red; background:url(x)" } });
  assert.equal("accent" in s2.tokens, false);
});

test("isValidStyleId / isBuiltin", () => {
  assert.equal(isValidStyleId("team-review"), true);
  assert.equal(isValidStyleId("Team"), false); // 大寫
  assert.equal(isValidStyleId("-x"), false); // 連字號開頭
  assert.equal(isValidStyleId("a".repeat(41)), false); // 過長
  assert.equal(isBuiltin("classic"), true);
  assert.equal(isBuiltin("team-review"), false);
});

test("sanitizeCardStyles：略過壞 id／撞內建／壞結構，保留合法並回報", () => {
  const { styles, dropped } = sanitizeCardStyles({
    good: { name: "G", base: "sticky" },
    "Bad Id": { name: "B" },
    classic: { name: "C" },
    noname: {},
  });
  assert.deepEqual(Object.keys(styles), ["good"]);
  const reasons = Object.fromEntries(dropped.map((d) => [d.id, d.reason]));
  assert.match(reasons["Bad Id"], /id 格式/);
  assert.match(reasons.classic, /內建/);
  assert.ok(reasons.noname);
});

test("resolveStyle / effectiveAppearance：內建優先、未知安全退回鏈", () => {
  assert.equal(resolveStyle("outlined", null), BUILTIN_STYLES.outlined);
  const custom = { mycustom: validateCardStyle({ name: "MC", base: "compact" }) };
  assert.equal(resolveStyle("mycustom", custom).base, "compact");
  assert.equal(resolveStyle("ghost", custom), null);
  assert.equal(effectiveAppearance("ghost", "outlined", custom), "outlined"); // 卡壞→板預設
  assert.equal(effectiveAppearance("ghost", "alsoghost", custom), DEFAULT_APPEARANCE); // 全壞→classic
  assert.equal(effectiveAppearance("mycustom", "outlined", custom), "mycustom"); // 卡有效＝優先
});

test("styleToAttrs：classic＝零覆寫；自訂＝class＋accent 變數", () => {
  assert.deepEqual(styleToAttrs(BUILTIN_STYLES.classic), { cls: "", vars: {} });
  const s = validateCardStyle({ name: "X", base: "outlined", tokens: { accent: "#123456", shadow: "medium" } });
  const { cls, vars } = styleToAttrs(s);
  assert.match(cls, /sty-base-outlined/);
  assert.match(cls, /sty-shadow-medium/);
  assert.match(cls, /sty-accent/);
  assert.equal(vars["--sty-accent"], "#123456");
});

/* ============ MCP 工具（暫存檔）============ */
const TMP = join(tmpdir(), `hare-cardstyles-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore, readStore } = await import("../lib/store.mjs");
const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });
const card = (id) => ({ id, type: "note", position: { x: 0, y: 0 }, data: { num: id, label: id, status: "plan" } });

async function reset() {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  for (let r = 0; r < 200; r += 1) await rm(`${TMP}.bak-${r}`, { force: true });
  await writeStore({ nodes: [card("A"), card("B"), card("C")], edges: [] }, "seed", { allowEmpty: true });
}
beforeEach(reset);
after(() => reset());

test("set_card_style + list_card_styles：建立自訂款式、內建＋自訂並列", async () => {
  const r = await call("set_card_style", { id: "team", name: "Team", base: "outlined", tokens: { accent: "#0a6fb0", junk: "x" } });
  assert.equal(r.ok, true);
  assert.equal("junk" in r.style.tokens, false, "消毒掉未知 token");
  const st = await readStore();
  assert.ok(st.meta.cardStyles.team, "寫入 meta.cardStyles");
  const ls = await call("list_card_styles");
  assert.equal(ls.builtinIds.length, BUILTIN_IDS.length);
  assert.deepEqual(ls.customIds, ["team"]);
  assert.ok(ls.styles.classic && ls.styles.team);
});

test("set_card_style：拒內建 id 與非法 id 格式", async () => {
  await assert.rejects(call("set_card_style", { id: "classic", name: "X" }), /內建/);
  await assert.rejects(call("set_card_style", { id: "Bad Id", name: "X" }), /格式/);
});

test("set_card_style：惡意 accent 被丟棄（不落 meta）", async () => {
  const r = await call("set_card_style", { id: "m", name: "M", tokens: { accent: "javascript:alert(1)" } });
  assert.equal("accent" in r.style.tokens, false);
});

test("update_card appearance：設定 → round-trip；null 清除", async () => {
  await call("set_card_style", { id: "team", name: "Team" });
  await call("update_card", { card: "A", appearance: "team" });
  let st = await readStore();
  assert.equal(st.nodes.find((n) => n.id === "A").data.appearance, "team");
  await call("update_card", { card: "A", appearance: null });
  st = await readStore();
  assert.equal("appearance" in st.nodes.find((n) => n.id === "A").data, false, "null 清除欄位");
});

test("delete_card_style：移除款式並遷移引用卡回板預設", async () => {
  await call("set_card_style", { id: "team", name: "Team" });
  await call("update_card", { card: "A", appearance: "team" });
  await call("update_card", { card: "B", appearance: "team" });
  const r = await call("delete_card_style", { id: "team" });
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 2, "兩張引用卡被遷移");
  const st = await readStore();
  assert.equal("team" in (st.meta.cardStyles || {}), false);
  assert.equal("appearance" in st.nodes.find((n) => n.id === "A").data, false);
  await assert.rejects(call("delete_card_style", { id: "ghost" }), /找不到/);
});

test("未知 appearance id：可寫入、渲染端安全退回（不破壞卡片）", async () => {
  await call("update_card", { card: "A", appearance: "ghost" }); // 未知 id，允許寫入
  const st = await readStore();
  assert.equal(st.nodes.find((n) => n.id === "A").data.appearance, "ghost");
  // 退回鏈：卡的 ghost 無效 → 板預設（此處未設＝undefined）→ classic
  assert.equal(effectiveAppearance("ghost", undefined, st.meta && st.meta.cardStyles), "classic");
});
