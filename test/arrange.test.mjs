// 排列/對齊純函數測試。align＝基準卡錨定：以第一張選取卡為準，其餘對到它；
// 不取集合平均/極值中心。
import { test } from "node:test";
import assert from "node:assert/strict";
import { align, distribute, arrange } from "../src/arrange.mjs";

// 三張卡：A(0,0 100x50)、B(300,200 200x100)、C(600,50 100x80)
const items = () => [
  { id: "A", x: 0, y: 0, w: 100, h: 50 },
  { id: "B", x: 300, y: 200, w: 200, h: 100 },
  { id: "C", x: 600, y: 50, w: 100, h: 80 },
];

test("align 錨定：vcenter 以基準卡（anchorId）中心為準，基準卡不動", () => {
  const pos = align(items(), "vcenter", "B"); // B 中心 y = 250
  assert.deepEqual(pos.get("B"), { x: 300, y: 200 }, "基準卡不動");
  assert.equal(pos.get("A").y, 250 - 25, "A 對到 B 的水平中線");
  assert.equal(pos.get("C").y, 250 - 40, "C 對到 B 的水平中線");
  assert.equal(pos.get("A").x, 0, "x 不動");
});

test("align 錨定：hcenter 以基準卡中心為準（非平均中心）", () => {
  const pos = align(items(), "hcenter", "A"); // A 中心 x = 50
  assert.deepEqual(pos.get("A"), { x: 0, y: 0 });
  assert.equal(pos.get("B").x, 50 - 100, "B 中心對到 x=50");
  assert.equal(pos.get("C").x, 50 - 50);
});

test("align 錨定：left/right/top/bottom 貼齊基準卡對應邊", () => {
  assert.equal(align(items(), "left", "B").get("A").x, 300);
  assert.equal(align(items(), "right", "B").get("C").x, 500 - 100, "貼 B 右緣 500");
  assert.equal(align(items(), "top", "C").get("B").y, 50);
  assert.equal(align(items(), "bottom", "A").get("B").y, 50 - 100, "貼 A 下緣 50");
});

test("align：anchorId 缺省＝items[0]；不足兩張回空", () => {
  const pos = align(items(), "left");
  assert.equal(pos.get("B").x, 0, "預設以第一項為基準");
  assert.equal(align([items()[0]], "left", "A").size, 0);
});

test("distribute / arrange 基本語意不受 align 改動影響", () => {
  const dh = distribute(items(), "h");
  assert.equal(dh.get("A").x, 0, "首張固定");
  const av = arrange(items(), "v");
  assert.equal(av.get("A").x, 0, "垂直排列 x 對齊最左");
  assert.ok(av.get("B").y > av.get("A").y, "依序往下");
});
