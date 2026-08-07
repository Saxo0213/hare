// N6 閱讀器「只顯示目標區塊」推斷（blockEndFrom）——大括號平衡的邊角：參數解構、單行函數、
// 標籤定位宣告行、縮排語言。回傳 0-based 結尾行 index（含）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockEndFrom } from "../lib/roadmap-api.mjs";

test("多行函數：錨點標籤定位宣告行，收於 };", () => {
  const lines = [
    "// HARE 6564be7b patchNodeData",
    "const propSnapAt = useRef({ id: null });",       // 前置單行語句（同層）
    "const patchNodeData = (patch) => {",             // ← 標籤宣告行
    "  doThing();",
    "};",
    "const after = 1;",
  ];
  // 標籤 patchNodeData → ds=2；大括號平衡到 index 4（};）
  assert.equal(blockEndFrom(lines, 0, "js"), 4);
});

test("參數解構不提前收：function F({a,b}) { 淨 +1", () => {
  const lines = [
    "// HARE a6b21f0c code_reader",
    "function CodeReader({ reader, pos, size }) {",    // 行內 {} 抵消、body { 淨 +1
    "  return null;",
    "}",
    "const x = 2;",
  ];
  // 標籤 code_reader 找不到（函數是 CodeReader）→ 退回 ai+1，行尾判斷 → 收於 index 3（}）
  assert.equal(blockEndFrom(lines, 0, "js"), 3);
});

test("單行箭頭函數：{} 同行抵消，1 行即收", () => {
  const lines = [
    "// HARE 00000000 setNodeBg",
    "const setNodeBg = (c) => patchNodeData({ bg: c });",
    "const next = 3;",
  ];
  assert.equal(blockEndFrom(lines, 0, "js"), 1);
});

test("無區塊單行語句：以分號止", () => {
  const lines = ["// HARE 00000000 X", "const X = 42;", "more();"];
  assert.equal(blockEndFrom(lines, 0, "js"), 1);
});

test("縮排語言（py）：縮排回到 ≤ 宣告行即結束", () => {
  const lines = [
    "# HARE 00000000 handler",
    "def handler(req):",       // ds
    "    do_a()",
    "    do_b()",
    "next_top = 1",            // 縮排回 0 ≤ def 縮排 → 前一行為尾
  ];
  assert.equal(blockEndFrom(lines, 0, "py"), 3);
});
