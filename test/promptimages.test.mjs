// 圖片入 prompt（HARE 1ma9e2p7）：訊息文字的 /api/assets/ 連結→base64 image 內容塊。
// 隔離：HARE_DATA_DIR 指暫存（dataDir() 的掛鉤點）、先設 env 再 dynamic import；
// 資產放 <dataDir>/assets/<專案>/。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

const ROOT = join(tmpdir(), `hare-pimg-${process.pid}`);
process.env.HARE_DATA_DIR = ROOT;
const { loadPromptImages } = await import("../lib/chat.mjs");
after(() => rm(ROOT, { recursive: true, force: true }));

test("loadPromptImages：連結→base64 塊、去重、缺檔跳過、非圖不抓", async () => {
  const dir = join(ROOT, "assets", "default");
  await mkdir(dir, { recursive: true });
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // 假 PNG 頭（內容不驗，讀檔即可）
  await writeFile(join(dir, "a.png"), PNG);
  const text = [
    "看這張 [圖片] /api/assets/default/a.png",
    "重複再貼 /api/assets/default/a.png",
    "缺檔 /api/assets/default/ghost.png",
    "非圖 /api/assets/default/note.txt",
  ].join("\n");
  const out = await loadPromptImages(text);
  assert.equal(out.length, 1, "去重＋缺檔跳過＋非圖不抓");
  assert.equal(out[0].type, "image");
  assert.equal(out[0].source.media_type, "image/png");
  assert.equal(out[0].source.data, PNG.toString("base64"));
  assert.deepEqual(await loadPromptImages("沒有圖片的訊息"), []);
});
