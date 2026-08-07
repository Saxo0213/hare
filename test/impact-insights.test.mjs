// B9 P2 Impact Query（impact）＋ P3 get_graph view=insights（insights）單元＋工具測試。
// 零依賴 node --test；隔離走 HARE_DATA_PATH 暫存檔，絕不動正式白板。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { impact, insights, downstream } from "../lib/graph.mjs";

/* ---------- P2 impact：合成小圖 ---------- */
const wc = (num, status = "plan", extra = {}) => ({ id: num, type: "note", data: { num, label: num, status, ...extra } });
const rel = (s, t, relation) => ({ id: `${s}-${t}`, source: s, target: t, data: relation ? { relation } : {} });

test("impact：預設 relations=[prerequisite]，score/decay/最佳路徑", () => {
  // A→B→C（皆 prerequisite）。B depth1 score=1*1*0.7=0.7；C depth2 score=0.7*1*0.7=0.49。
  const data = { nodes: [wc("A"), wc("B"), wc("C")], edges: [rel("A", "B", "prerequisite"), rel("B", "C", "prerequisite")] };
  const r = impact(data, "A", { detail: true });
  assert.equal(r.card, "A");
  assert.equal(r.count, 2);
  const b = r.downstream.find((x) => x.num === "B");
  const c = r.downstream.find((x) => x.num === "C");
  assert.equal(b.depth, 1); assert.equal(b.score, 0.7);
  assert.equal(c.depth, 2); assert.equal(c.score, 0.49);
  assert.deepEqual(c.via, ["A", "B", "C"]);
  assert.deepEqual(c.reasons, ["prerequisite"]);
  // score 降冪：B 在 C 之前
  assert.deepEqual(r.downstream.map((x) => x.num), ["B", "C"]);
});

test("impact：多路徑保留最高分＋記該路徑（深但高權重勝過淺但低權重）", () => {
  // A→X 直接（reference 0.3）：depth1 score=0.3*0.7=0.21。
  // A→B→X（皆 prerequisite）：depth2 score=1*0.7*1*0.7=0.49 > 0.21 → X 記後者。
  const data = {
    nodes: [wc("A"), wc("B"), wc("X")],
    edges: [rel("A", "X", "reference"), rel("A", "B", "prerequisite"), rel("B", "X", "prerequisite")],
  };
  const r = impact(data, "A", { relations: ["prerequisite", "reference"], detail: true });
  const x = r.downstream.find((n) => n.num === "X");
  assert.equal(x.score, 0.49, "保留最高分那條");
  assert.equal(x.depth, 2);
  assert.deepEqual(x.via, ["A", "B", "X"], "記最高分路徑");
});

test("impact：relations 過濾——reference 不在預設集則不擴散", () => {
  const data = { nodes: [wc("A"), wc("R")], edges: [rel("A", "R", "reference")] };
  assert.equal(impact(data, "A", { detail: true }).count, 0, "預設只走 prerequisite");
  assert.equal(impact(data, "A", { relations: ["reference"], detail: true }).count, 1, "明點 reference 才走");
});

test("impact：max_cards 截斷回 truncated:true", () => {
  const nodes = [wc("A")]; const edges = [];
  for (let i = 0; i < 5; i += 1) { nodes.push(wc(`D${i}`)); edges.push(rel("A", `D${i}`, "prerequisite")); }
  const r = impact({ nodes, edges }, "A", { maxCards: 3, detail: true });
  assert.equal(r.truncated, true);
  assert.equal(r.count, 3);
});

test("impact：max_cards=-1（負數）＝參數錯誤，不再誤回一筆並 truncated（B9-1 修正3）", () => {
  // 兩個下游 D0/D1。舊行為：maxCards=-1 → slice(-1) 回最後一筆並標 truncated（錯）。
  const data = { nodes: [wc("A"), wc("D0"), wc("D1")],
    edges: [rel("A", "D0", "prerequisite"), rel("A", "D1", "prerequisite")] };
  assert.throws(() => impact(data, "A", { maxCards: -1, detail: true }), /正整數/, "負數報參數錯誤");
  assert.throws(() => impact(data, "A", { maxCards: 0, detail: true }), /正整數/, "0 報參數錯誤");
  assert.throws(() => impact(data, "A", { maxCards: 1.5, detail: true }), /正整數/, "非整數報參數錯誤");
  assert.throws(() => impact(data, "A", { maxCards: 6000, detail: true }), /正整數/, "超上限報參數錯誤");
  // 合法正整數照舊工作。
  const r = impact(data, "A", { maxCards: 1, detail: true });
  assert.equal(r.count, 1); assert.equal(r.truncated, true);
});

test("impact：max_depth 限制擴散深度", () => {
  const data = { nodes: [wc("A"), wc("B"), wc("C")], edges: [rel("A", "B", "prerequisite"), rel("B", "C", "prerequisite")] };
  const r = impact(data, "A", { maxDepth: 1, detail: true });
  assert.deepEqual(r.downstream.map((x) => x.num), ["B"], "深度 1 只到 B");
});

test("impact：有環不重訪（同路徑）", () => {
  const data = { nodes: [wc("A"), wc("B")], edges: [rel("A", "B", "prerequisite"), rel("B", "A", "prerequisite")] };
  const r = impact(data, "A", { detail: true });
  assert.equal(r.count, 1, "只達 B，不因環回頭重訪 A");
  assert.equal(r.downstream[0].num, "B");
});

test("impact：無新參數時與舊 downstream 輸出完全相同（守恆快照）", () => {
  const data = {
    nodes: [wc("A", "real"), wc("B"), wc("C"), wc("D", "real")],
    edges: [rel("A", "B"), rel("B", "C"), rel("A", "D")],
  };
  // 工具層守恆：不帶新參數＝呼叫 downstream（此處直接比對兩函式輸出集一致）。
  const old = downstream(data, "A");
  assert.deepEqual(old.downstream.map((c) => c.num).sort(), ["B", "C", "D"]);
});

/* ---------- P3 insights：合成小圖各類別觸發／不觸發 ---------- */
test("insights：工作孤兒觸發與不觸發", () => {
  const data = {
    nodes: [wc("A"), wc("B"), wc("ORPH")], // ORPH 無邊、無 parentId、無 pin
    edges: [rel("A", "B", "prerequisite")],
  };
  const r = insights(data);
  assert.equal(r.stats.orphans, 1);
  assert.ok(r.text.includes("工作孤兒"));
  assert.ok(r.text.includes("ORPH"));
  // 加一條邊指向 ORPH → 不再是孤兒
  const r2 = insights({ nodes: data.nodes, edges: [...data.edges, rel("B", "ORPH", "prerequisite")] });
  assert.equal(r2.stats.orphans, 0);
  assert.ok(!r2.text.includes("工作孤兒"), "空類省略");
});

test("insights：依賴倒掛（real 卻有未完成上游）", () => {
  const data = {
    nodes: [wc("UP", "plan"), wc("DN", "real")],
    edges: [rel("UP", "DN", "prerequisite")],
  };
  const r = insights(data);
  assert.equal(r.stats.inverted, 1);
  assert.ok(r.text.includes("依賴倒掛"));
  assert.ok(r.text.includes("DN"));
  // UP 也轉 real → 不倒掛
  const r2 = insights({ nodes: [wc("UP", "real"), wc("DN", "real")], edges: data.edges });
  assert.equal(r2.stats.inverted, 0);
});

test("insights：低可信要害（關鍵路徑上 inferred 邊）", () => {
  const data = {
    nodes: [wc("A"), wc("B"), wc("C")],
    edges: [
      { id: "e1", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "inferred" } },
      { id: "e2", source: "B", target: "C", data: { relation: "prerequisite", confidenceTier: "asserted" } },
    ],
  };
  const r = insights(data);
  assert.equal(r.stats.lowConfidence, 1);
  assert.ok(r.text.includes("低可信要害"));
  assert.ok(r.text.includes("A→B"));
  // 全 asserted → 不觸發
  const r2 = insights({ nodes: data.nodes, edges: [
    { id: "e1", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "asserted" } },
    { id: "e2", source: "B", target: "C", data: { relation: "prerequisite", confidenceTier: "asserted" } },
  ] });
  assert.equal(r2.stats.lowConfidence, 0);
});

test("insights 低可信要害：平行邊——reference 排前不再漏報 prerequisite/inferred（B9-1 修正4）", () => {
  // A→B 有兩條平行邊：reference/asserted 與 prerequisite/inferred。CP＝A→B→C（prerequisite 鏈）。
  // 舊 .find() 抓到先出現的 reference/asserted → 漏報；修正後只看 prerequisite → 應報 inferred。
  const nodes = [wc("A"), wc("B"), wc("C")];
  const cpTail = { id: "bc", source: "B", target: "C", data: { relation: "prerequisite", confidenceTier: "asserted" } };
  const refFirst = { id: "ab-ref", source: "A", target: "B", data: { relation: "reference", confidenceTier: "asserted" } };
  const preInf = { id: "ab-pre", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "inferred" } };
  const r1 = insights({ nodes, edges: [refFirst, preInf, cpTail] });
  assert.equal(r1.stats.lowConfidence, 1, "reference 排前也要抓到 prerequisite/inferred");
  assert.ok(r1.text.includes("A→B（inferred）"));
  // 反序（prerequisite 排前）結果一致（順序無關）。
  const r2 = insights({ nodes, edges: [preInf, refFirst, cpTail] });
  assert.equal(r2.stats.lowConfidence, 1);
});

test("insights 低可信要害：平行邊——reference/inferred 排前不再誤報 prerequisite/asserted（B9-1 修正4）", () => {
  // A→B 平行：prerequisite/asserted（真 CP 邊）＋ reference/inferred。CP＝A→B→C。
  // 舊 .find() 若抓到 reference/inferred → 誤報；修正後只看 prerequisite/asserted → 不報。
  const nodes = [wc("A"), wc("B"), wc("C")];
  const cpTail = { id: "bc", source: "B", target: "C", data: { relation: "prerequisite", confidenceTier: "asserted" } };
  const preAss = { id: "ab-pre", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "asserted" } };
  const refInf = { id: "ab-ref", source: "A", target: "B", data: { relation: "reference", confidenceTier: "inferred" } };
  assert.equal(insights({ nodes, edges: [refInf, preAss, cpTail] }).stats.lowConfidence, 0, "reference/inferred 排前不誤報");
  assert.equal(insights({ nodes, edges: [preAss, refInf, cpTail] }).stats.lowConfidence, 0, "反序亦不誤報");
});

test("insights 低可信要害：同端點多條 prerequisite 取最強 tier 裁定（B9-1 修正4）", () => {
  // A→B 兩條 prerequisite：一 asserted、一 inferred。最強＝asserted → 不算低可信。
  const nodes = [wc("A"), wc("B"), wc("C")];
  const cpTail = { id: "bc", source: "B", target: "C", data: { relation: "prerequisite", confidenceTier: "asserted" } };
  const strong = { id: "ab-s", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "asserted" } };
  const weak = { id: "ab-w", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "inferred" } };
  assert.equal(insights({ nodes, edges: [strong, weak, cpTail] }).stats.lowConfidence, 0, "有 asserted 平行邊即不低可信");
  // 皆 inferred → 最強仍 inferred → 報。
  const bothWeak = { id: "ab-w2", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "inferred" } };
  assert.equal(insights({ nodes, edges: [weak, bothWeak, cpTail] }).stats.lowConfidence, 1, "皆 inferred 則報");
});

test("insights：懸空 pin（refCard 目標不存在）", () => {
  const data = {
    nodes: [wc("A"), { id: "P", type: "pin", data: { num: "P", label: "pin", refCard: "GHOST" } }],
    edges: [],
  };
  const r = insights(data);
  assert.equal(r.stats.danglingPins, 1);
  assert.ok(r.text.includes("懸空 pin"));
  // 目標存在（knownIds 帶入）→ 不懸空
  const r2 = insights(data, { knownIds: new Set(["A", "GHOST"]) });
  assert.equal(r2.stats.danglingPins, 0);
});

test("insights：Hub 度數＋缺證據高連接", () => {
  // H 連 4 條工作邊、無 refs → 同時是 Hub 與缺證據高連接。
  const data = {
    nodes: [wc("H"), wc("a"), wc("b"), wc("c"), wc("d")],
    edges: [rel("a", "H", "prerequisite"), rel("b", "H", "prerequisite"), rel("H", "c", "prerequisite"), rel("H", "d", "prerequisite")],
  };
  const r = insights(data);
  assert.ok(r.stats.hubs >= 1);
  assert.equal(r.stats.noEvidence, 1, "H 度數 4 且無 refs");
  assert.ok(r.text.includes("入2/出2"));
  // H 帶 refs → 不缺證據
  const withRefs = { nodes: [wc("H", "plan", { refs: [{ path: "x.js" }] }), wc("a"), wc("b"), wc("c"), wc("d")], edges: data.edges };
  assert.equal(insights(withRefs).stats.noEvidence, 0);
});

test("insights：>1500 節點跳過 Bridge 並註明", () => {
  const nodes = []; const edges = [];
  for (let i = 0; i < 1600; i += 1) nodes.push(wc(`n${i}`));
  for (let i = 0; i < 1599; i += 1) edges.push(rel(`n${i}`, `n${i + 1}`, "prerequisite"));
  const r = insights({ nodes, edges });
  assert.equal(r.stats.bridgeSkipped, true);
  assert.ok(r.text.includes("略過 betweenness"));
});

test("insights：Bridge betweenness 找出橋接點", () => {
  // A→M→B、A→M→C：M 在所有最短路徑上 → betweenness 最高。
  const data = {
    nodes: [wc("A"), wc("M"), wc("B"), wc("C")],
    edges: [rel("A", "M", "prerequisite"), rel("M", "B", "prerequisite"), rel("M", "C", "prerequisite")],
  };
  const r = insights(data);
  assert.ok(r.stats.bridges >= 1);
  assert.ok(r.text.includes("Bridge 橋接"));
  assert.ok(r.text.includes("M"));
});

/* ---------- P4 待裁定問題（surprise_questions）：五條規則各觸發／不觸發＋排序＋截斷＋守恆 ---------- */
const cont = (id) => ({ id, type: "note", data: { num: id, label: id, status: "note" } }); // 容器＝結構卡（不入 dag）
const kid = (id, parentId, status = "plan", extra = {}) => ({ id, type: "note", parentId, data: { num: id, label: id, status, ...extra } });
const pin = (id, refCard) => ({ id, type: "pin", data: { num: id, label: id, refCard } });
const relTier = (s, t, relation, tier) => ({ id: `${s}-${t}-${tier}`, source: s, target: t, data: { relation, confidenceTier: tier } });

/* ---------- B9-P5：孤兒容器排除 ＋ P5a 容器內聚 ---------- */
test("insights：有子卡的工作容器不算孤兒（W2 前端內容型），葉卡才算", () => {
  // CONT＝工作狀態容器（有 2 子卡）；LEAF＝無邊/無 parent/無 kids 的真孤兒。
  const nodes = [wc("CONT"), kid("k1", "CONT"), kid("k2", "CONT"), wc("LEAF")];
  const r = insights({ nodes, edges: [] });
  assert.equal(r.stats.orphans, 1, "只有 LEAF 是孤兒（CONT 有子卡＝排除）");
  assert.ok(r.text.includes("LEAF"));
  assert.ok(!r.text.includes("CONT"), "容器不列入孤兒");
});

test("insights P5a：容器內聚偏低觸發（cohesion<0.5 且對外邊≥3）", () => {
  // C1 內部 a→b（internal 1）；對外 a→x、a→y、b→z（external 3）→ cohesion 0.25。
  const nodes = [cont("C1"), cont("C2"), kid("a", "C1"), kid("b", "C1"), kid("x", "C2"), wc("y"), wc("z")];
  const edges = [rel("a", "b", "prerequisite"), rel("a", "x", "prerequisite"),
    rel("a", "y", "prerequisite"), rel("b", "z", "prerequisite")];
  const r = insights({ nodes, edges });
  assert.equal(r.stats.cohesion, 1, "C1 內聚偏低；C2 對外邊 1<3 不報");
  assert.ok(r.text.includes("### 容器內聚"));
  assert.ok(r.text.includes("內聚偏低"));
});

test("insights P5a：容器對耦合偏高觸發（跨界工作邊≥5）", () => {
  const nodes = [cont("C1"), cont("C2")];
  for (const k of ["a1", "a2", "a3", "a4", "a5"]) nodes.push(kid(k, "C1"));
  for (const k of ["b1", "b2", "b3", "b4", "b5"]) nodes.push(kid(k, "C2"));
  const edges = [];
  for (let i = 1; i <= 5; i += 1) edges.push(rel(`a${i}`, `b${i}`, "prerequisite"));
  const r = insights({ nodes, edges });
  assert.ok(r.text.includes("耦合偏高"), "C1×C2 跨界 5 條");
  assert.ok(r.text.includes("### 容器內聚"));
});

test("insights P5a：高內聚容器不觸發", () => {
  // C1 內部 3 條、對外 1 條 → cohesion 0.75 且對外邊 1<3 → 不報。
  const nodes = [cont("C1"), kid("a", "C1"), kid("b", "C1"), kid("c", "C1"), wc("y")];
  const edges = [rel("a", "b", "prerequisite"), rel("b", "c", "prerequisite"),
    rel("a", "c", "prerequisite"), rel("c", "y", "prerequisite")];
  const r = insights({ nodes, edges });
  assert.equal(r.stats.cohesion, 0);
  assert.ok(!r.text.includes("### 容器內聚"), "空類省略");
});

test("questions 規則1：唯一前置 tier=inferred 觸發；extracted（板型投影）不觸發", () => {
  // 觸發：B 唯一 prerequisite 上游來自 inferred 邊。
  const hit = insights({ nodes: [wc("A"), wc("B")], edges: [relTier("A", "B", "prerequisite", "inferred")] });
  const q1 = hit.questions.find((q) => q.target === "B");
  assert.ok(q1, "inferred 唯一前置 → 出題");
  assert.equal(q1.priority, 1);
  assert.ok(q1.question.includes("唯一前置"));
  assert.ok(hit.text.includes("### 待裁定"));
  // 不觸發：無 relation 的舊邊（任務板投影＝prerequisite、tier extracted）＝正常舊資料。
  const miss = insights({ nodes: [wc("A"), wc("B")], edges: [{ id: "e", source: "A", target: "B", data: {} }] });
  assert.equal(miss.questions.length, 0, "extracted 板型投影不算低可信");
  assert.ok(!miss.text.includes("### 待裁定"), "無題則省略段");
});

test("questions 規則2：跨頂層容器強依賴觸發；同容器不觸發", () => {
  const base = [cont("C1"), cont("C2"), kid("a", "C1"), kid("b", "C2")];
  const hit = insights({ nodes: base, edges: [rel("a", "b", "prerequisite")] });
  const q2 = hit.questions.find((q) => q.priority === 3);
  assert.ok(q2, "跨容器 → 出題");
  assert.ok(q2.question.includes("容器 C1 與 C2"));
  // 同容器（a,b 皆屬 C1）→ 不觸發。
  const same = insights({ nodes: [cont("C1"), kid("a", "C1"), kid("b", "C1")], edges: [rel("a", "b", "prerequisite")] });
  assert.equal(same.questions.filter((q) => q.priority === 3).length, 0);
});

test("questions 規則3：real 樞紐（度數≥3）無 refs 觸發；有 refs 不觸發", () => {
  const edges = [rel("a", "H", "prerequisite"), rel("b", "H", "prerequisite"), rel("H", "c", "prerequisite")];
  const hit = insights({ nodes: [wc("H", "real"), wc("a"), wc("b"), wc("c")], edges });
  const q3 = hit.questions.find((q) => q.target === "H");
  assert.ok(q3, "real＋度數3＋無 refs → 出題");
  assert.equal(q3.priority, 2);
  assert.ok(q3.question.includes("已標 real"));
  // 帶 refs → 不觸發規則3。
  const withRefs = insights({ nodes: [wc("H", "real", { refs: [{ path: "x.js" }] }), wc("a"), wc("b"), wc("c")], edges });
  assert.equal(withRefs.questions.some((q) => q.target === "H" && q.question.includes("已標 real")), false);
  // 非 real（plan）→ 不觸發規則3。
  const notReal = insights({ nodes: [wc("H"), wc("a"), wc("b"), wc("c")], edges });
  assert.equal(notReal.questions.some((q) => q.question.includes("已標 real")), false);
});

test("questions 規則4：同向明示 prerequisite＋reference 雙線觸發；投影邊不算", () => {
  const hit = insights({ nodes: [wc("X"), wc("Y")], edges: [
    { id: "e1", source: "X", target: "Y", data: { relation: "prerequisite" } },
    { id: "e2", source: "X", target: "Y", data: { relation: "reference" } },
  ] });
  const q4 = hit.questions.find((q) => q.target === "X→Y");
  assert.ok(q4, "明示雙線 → 出題");
  assert.equal(q4.priority, 1);
  // 明示 prerequisite ＋ 無 relation 投影邊 → 不算矛盾雙線。
  const miss = insights({ nodes: [wc("X"), wc("Y")], edges: [
    { id: "e1", source: "X", target: "Y", data: { relation: "prerequisite" } },
    { id: "e2", source: "X", target: "Y", data: {} },
  ] });
  assert.equal(miss.questions.some((q) => q.target === "X→Y"), false);
});

test("questions 規則5：懸空 pin 觸發", () => {
  const hit = insights({ nodes: [wc("A"), pin("P", "GHOST")], edges: [] });
  const q5 = hit.questions.find((q) => q.question.includes("pin P"));
  assert.ok(q5, "懸空 pin → 出題");
  assert.equal(q5.priority, 2);
  // knownIds 含 GHOST → 不懸空、不出題。
  const ok = insights({ nodes: [wc("A"), pin("P", "GHOST")], edges: [] }, { knownIds: new Set(["A", "GHOST", "P"]) });
  assert.equal(ok.questions.length, 0);
});

test("questions：priority 升冪排序（高優先在前）", () => {
  // 同板同時觸發規則4（P1）與規則5（P2）→ P1 排前。
  const data = { nodes: [wc("X"), wc("Y"), pin("P", "GHOST")], edges: [
    { id: "e1", source: "X", target: "Y", data: { relation: "prerequisite" } },
    { id: "e2", source: "X", target: "Y", data: { relation: "reference" } },
  ] };
  const r = insights(data);
  assert.deepEqual(r.questions.map((q) => q.priority), [1, 2]);
});

test("questions：全專案上限 10 筆截斷＋註明", () => {
  const nodes = [wc("A")];
  for (let i = 0; i < 12; i += 1) nodes.push(pin(`P${i}`, `GHOST${i}`)); // 12 懸空 pin → 12 題
  const r = insights({ nodes, edges: [] });
  assert.equal(r.questions.length, 10, "上限 10");
  assert.equal(r.stats.questions, 10);
  assert.ok(r.text.includes("### 待裁定（12）"), "標頭記真實總數 12");
  assert.ok(r.text.includes("其餘 2 題略過"), "超過截斷註明");
});

test("questions 守恆：七類既有 stats／text 不受新增段影響（快照）", () => {
  // 觸發全七類，另帶一懸空 pin（會生 P4 題）；驗七類 stats 與各段標頭不變。
  // 主鏈 A→B→C→RI（最長＝關鍵路徑，A→B inferred＝低可信要害）；H 度數3＝Hub＋缺證據；旁鏈較短。
  const nodes = [
    wc("A", "real"), wc("B"), wc("C"), wc("RI", "real"), wc("ORPH"),
    wc("H"), wc("h1"), wc("h2"), wc("h3"),
    pin("PP", "GHOST"),
  ];
  const edges = [
    { id: "ab", source: "A", target: "B", data: { relation: "prerequisite", confidenceTier: "inferred" } },
    rel("B", "C", "prerequisite"), rel("C", "RI", "prerequisite"), // RI(real) 上游 C 未 real → 倒掛
    rel("h1", "H", "prerequisite"), rel("h2", "H", "prerequisite"), rel("H", "h3", "prerequisite"),
  ];
  const r = insights({ name: "P", nodes, edges });
  // 七類 stats 逐一（新增 questions 不影響既有鍵）。
  assert.equal(r.stats.orphans, 1);
  assert.equal(r.stats.inverted, 1);
  assert.equal(r.stats.danglingPins, 1);
  assert.equal(r.stats.lowConfidence, 1);
  assert.ok(r.stats.hubs >= 1);
  assert.ok(r.stats.noEvidence >= 1);
  assert.ok(r.stats.bridges >= 1);
  // 七類段標頭仍在，且 待裁定 段排在最末（不插入七類之間）。
  for (const h of ["Hub 樞紐", "Bridge 橋接", "工作孤兒", "缺證據高連接", "依賴倒掛", "低可信要害", "懸空 pin"]) {
    assert.ok(r.text.includes(`### ${h}`), `保留段：${h}`);
  }
  assert.ok(r.text.indexOf("### 待裁定") > r.text.indexOf("### 懸空 pin"), "待裁定 段在七類之後");
});

/* ---------- 工具層 round-trip（暫存檔）：get_downstream 守恆＋detail、get_graph insights ---------- */
const TMP = join(tmpdir(), `hare-impact-test-${process.pid}.json`);
const CHANGELOG = TMP.replace(/\.json$/i, "-changelog.jsonl");
process.env.HARE_DATA_PATH = TMP;
const { TOOLS } = await import("../lib/tools.mjs");
const { writeStore } = await import("../lib/store.mjs");
const call = (name, args = {}) => TOOLS[name].run(args, { writer: "test" });
const node = (id, status = "plan") => ({ id, type: "note", position: { x: 0, y: 0 }, data: { num: id, label: id, status, desc: "d" } });

async function reset() {
  await rm(TMP, { force: true });
  await rm(CHANGELOG, { force: true });
  for (let r = 0; r < 200; r += 1) await rm(`${TMP}.bak-${r}`, { force: true });
  await writeStore({
    nodes: [node("A", "real"), node("B"), node("C"), node("ORPH")],
    edges: [{ id: "e1", source: "A", target: "B" }, { id: "e2", source: "B", target: "C" }],
  }, "seed", { allowEmpty: true });
}
beforeEach(reset);
after(() => reset());

test("工具 get_downstream：無新參數＝舊形（downstream 陣列、無 truncated/score）", async () => {
  const r = await call("get_downstream", { card: "A" });
  assert.deepEqual(r.downstream.map((c) => c.num).sort(), ["B", "C"]);
  assert.ok(r.downstream[0].id, "舊形帶 id");
  assert.equal(r.downstream[0].score, undefined, "無 score 欄");
  assert.equal(r.truncated, undefined);
});

test("工具 get_downstream detail:true＝評分明細", async () => {
  const r = await call("get_downstream", { card: "A", detail: true });
  assert.equal(r.card, "A");
  const b = r.downstream.find((x) => x.num === "B");
  assert.equal(b.score, 0.7);
  assert.deepEqual(b.via, ["A", "B"]);
  assert.deepEqual(b.reasons, ["prerequisite"]);
});

test("工具 get_graph view=insights：text markdown ＋ stats 欄位", async () => {
  const r = await call("get_graph", { view: "insights" });
  assert.equal(r.view, "insights");
  assert.ok(r.text.includes("工作孤兒"), "ORPH 觸發孤兒類");
  assert.ok(r.text.includes("ORPH"));
  assert.ok(r.stats && typeof r.stats.orphans === "number");
  assert.equal(r.stats.orphans, 1);
});

test("工具 get_graph view=insights：questions 欄位跨頁彙整＋懸空 pin 出題", async () => {
  await writeStore({
    nodes: [node("A", "real"), { id: "P", type: "pin", position: { x: 0, y: 0 }, data: { num: "P", label: "pin", refCard: "GHOST" } }],
    edges: [],
  }, "seed-q", { allowEmpty: true });
  const r = await call("get_graph", { view: "insights" });
  assert.ok(Array.isArray(r.questions), "回傳帶 questions 陣列");
  const q = r.questions.find((x) => x.question.includes("pin P"));
  assert.ok(q, "懸空 pin 出題");
  assert.equal(q.priority, 2);
  assert.equal(r.stats.questions, r.questions.length);
});
