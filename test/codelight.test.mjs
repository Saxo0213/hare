// 內建閱讀器（N6）語法上色 tokenizer——零依賴、粗略、跨行區塊註解。
import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight } from "../src/codelight.mjs";

const clsOf = (rows) => rows.flat().filter((t) => t.c).map((t) => [t.t, t.c]);

test("js：關鍵字/字串/行註解/數字分類", () => {
  const rows = highlight(["const x = 42; // hi", 'let s = "hello";'], "js");
  const cls = clsOf(rows);
  assert.ok(cls.some(([t, c]) => t === "const" && c === "kw"));
  assert.ok(cls.some(([t, c]) => t === "let" && c === "kw"));
  assert.ok(cls.some(([t, c]) => t === "42" && c === "num"));
  assert.ok(cls.some(([t, c]) => c === "com" && t.includes("hi")));
  assert.ok(cls.some(([t, c]) => c === "str" && t.includes("hello")));
});

test("跨行區塊註解：/* 起、下一行續、*/ 收", () => {
  const rows = highlight(["code /* start", "still comment", "end */ after"], "js");
  assert.ok(rows[0].some((t) => t.c === "com" && t.t.includes("start")));
  assert.ok(rows[1].every((t) => t.c === "com"), "整行仍是註解");
  assert.ok(rows[2].some((t) => t.c === "com" && t.t.includes("*/")));
  assert.ok(rows[2].some((t) => !t.c && t.t.includes("after")), "收尾後回一般文字");
});

test("python：# 行註解、字串", () => {
  const rows = highlight(["def f():  # note", "    return 'x'"], "py");
  const cls = clsOf(rows);
  assert.ok(cls.some(([t, c]) => t === "def" && c === "kw"));
  assert.ok(cls.some(([t, c]) => c === "com" && t.includes("note")));
  assert.ok(cls.some(([t, c]) => c === "str" && t.includes("x")));
});

test("css：只認 /* */ 區塊註解、不誤判 //", () => {
  const rows = highlight([".a { color: red; } /* c */", "b // not-a-comment"], "css");
  assert.ok(rows[0].some((t) => t.c === "com" && t.t.includes("c")));
  assert.ok(rows[1].every((t) => t.c !== "com"), "css 沒有 // 行註解");
});

test("識別字含數字不被拆成數字 token", () => {
  const rows = highlight(["abc123 = 5"], "js");
  const cls = clsOf(rows);
  assert.ok(!cls.some(([t, c]) => c === "num" && t === "123"), "abc123 不拆");
  assert.ok(cls.some(([t, c]) => c === "num" && t === "5"));
});

test("空陣列/空行不炸", () => {
  assert.deepEqual(highlight([], "js"), []);
  assert.deepEqual(highlight([""], "js"), [[]]);
  assert.deepEqual(highlight(null, "js"), []);
});
