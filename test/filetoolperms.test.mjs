// 檔案工具政策（HARE f11ea110，2026-08-02 使用者裁定「改個檔案不該還要核准」）：
// 唯讀工具一律放行；編輯工具界內（worktree/refBase）放行、界外回問；trust/all 全放。
// 隔離：HARE_DATA_DIR 溫暫存（settings/permissions 皆落此），先設 env 再 import。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";

const ROOT = join(tmpdir(), `hare-ftp-${process.pid}`);
process.env.HARE_DATA_DIR = ROOT;
const { isWhitelisted, configureChat, setProjSettings } = await import("../lib/chat.mjs");
const { getProjectRefBase } = await import("../lib/projects.mjs");
const { worktreePath } = await import("../lib/worktree.mjs");

after(() => rm(ROOT, { recursive: true, force: true }));

test("唯讀工具（Read/Grep/Glob…）任何政策下一律放行", async () => {
  configureChat({ worktreeIsolation: true });
  for (const t of ["Read", "Grep", "Glob", "NotebookRead", "TodoWrite"]) {
    assert.equal(await isWhitelisted("default", "cardX", t, { file_path: "C:/anywhere/x.txt" }), true, t);
  }
});

test("編輯工具：界內（相對路徑→worktree/refBase）放行；界外絕對路徑回問", async () => {
  configureChat({ worktreeIsolation: true });
  // 相對路徑＝turn cwd 內＝放行
  assert.equal(await isWhitelisted("default", "cardX", "Edit", { file_path: "src/App.jsx" }), true);
  assert.equal(await isWhitelisted("default", "cardX", "Write", { file_path: "lib/new.mjs" }), true);
  // 絕對路徑落在 worktree／refBase 內＝放行
  const rb = await getProjectRefBase("default");
  assert.equal(await isWhitelisted("default", "cardX", "Edit",
    { file_path: join(worktreePath(rb, "default", "cardX"), "a.mjs") }), true);
  assert.equal(await isWhitelisted("default", "cardX", "Edit", { file_path: join(rb, "b.mjs") }), true);
  // 界外＝不自動放（落回白名單/回問）
  assert.equal(await isWhitelisted("default", "cardX", "Edit", { file_path: "C:/Windows/evil.txt" }), false);
  assert.equal(await isWhitelisted("default", "cardX", "Write", { file_path: resolve(rb, "..", "outside.txt") }), false);
  // 無路徑欄位＝不自動放
  assert.equal(await isWhitelisted("default", "cardX", "Edit", {}), false);
});

test("編輯工具：policy trust＝界外也放；隔離關閉時相對路徑仍以 refBase 為界", async () => {
  // settings 有 per-pid 快取——走 setProjSettings（同步更新快取），trust 用獨立專案 id
  await setProjSettings("trustp", { bashPolicy: "trust" });
  configureChat({ worktreeIsolation: true });
  assert.equal(await isWhitelisted("trustp", "cardX", "Edit", { file_path: "C:/Windows/evil.txt" }), true,
    "trust＝使用者已裁定信任，界外也放");
  configureChat({ worktreeIsolation: false });
  assert.equal(await isWhitelisted("default", "cardY", "Edit", { file_path: "src/x.mjs" }), true,
    "隔離關＝cwd 是 refBase，相對路徑界內照放");
});
