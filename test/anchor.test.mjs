// B21 Phase 2：findAnchor（uuid → 檔案＋行號）——宣告行／HARE-END 區塊終點／
// 標籤剝註解收尾符／.gitignore 跳過／重複錨點全部回報。temp 目錄隔離，不碰真 repo。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAnchor } from "../lib/analyze.mjs";

const root = await mkdtemp(join(tmpdir(), "hare-anchor-"));
after(() => rm(root, { recursive: true, force: true }));

test("findAnchor：宣告行＋end_line＋標籤；gitignore 跳過；重複全報；查無＝0", async () => {
  await mkdir(join(root, "lib"), { recursive: true });
  await mkdir(join(root, "skipme"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "skipme/\n", "utf8");
  await writeFile(join(root, "lib", "x.mjs"),
    "// 前言\n// HARE abc123 我的函數\nfunction f() {}\n// HARE-END abc123\n", "utf8");
  await writeFile(join(root, "style.css"), "/* HARE abc123 樣式段 */\n.a{}\n", "utf8");
  await writeFile(join(root, "skipme", "y.mjs"), "// HARE abc123 被忽略\n", "utf8");
  const r = findAnchor(root, "abc123");
  assert.equal(r.count, 2, "gitignore 目錄內的命中不算");
  assert.deepEqual(r.matches.map((m) => m.path).sort(), ["lib/x.mjs", "style.css"]);
  const mjs = r.matches.find((m) => m.path === "lib/x.mjs");
  assert.equal(mjs.line, 2);
  assert.equal(mjs.end_line, 4, "HARE-END 成對＝回區塊終點");
  assert.equal(mjs.label, "我的函數");
  const css = r.matches.find((m) => m.path === "style.css");
  assert.equal(css.label, "樣式段", "CSS 註解 */ 收尾符要剝掉");
  assert.equal(css.end_line, undefined, "無 HARE-END＝不給終點");
  assert.equal(findAnchor(root, "zzz999").count, 0);
});
