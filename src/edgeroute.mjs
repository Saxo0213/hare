/* 折線避障（零依賴純函數）：三段折線（H-V-H 或 V-H-V）的包圍盒
   vs 卡片 AABB 相交測試。從中點向兩側掃描候選中線，取第一條不穿卡的通道；
   全被擋則回中點。exclude＝線段起終點卡自身；泳道/範圍框背景與子卡不擋線。 */
// HARE 710e7b05 findClearCenter
export function findClearCenter(nodes, exclude, sx, sy, tx, ty, horizontal) {
  const blocked = (segs) => nodes.some((n) => {
    if (n.type === "lane" || n.parentId || exclude.has(n.id)) return false;
    const w = n.measured?.width || 0, h = n.measured?.height || 0;
    if (!w) return false;
    const R = { x: n.position.x - 6, y: n.position.y - 6, w: w + 12, h: h + 12 };
    return segs.some((s) => s.x < R.x + R.w && s.x + s.w > R.x && s.y < R.y + R.h && s.y + s.h > R.y);
  });
  const segsFor = (c) => horizontal
    ? [{ x: Math.min(sx, c), y: sy - 1, w: Math.abs(c - sx), h: 2 },
       { x: c - 1, y: Math.min(sy, ty), w: 2, h: Math.abs(ty - sy) },
       { x: Math.min(c, tx), y: ty - 1, w: Math.abs(tx - c), h: 2 }]
    : [{ x: sx - 1, y: Math.min(sy, c), w: 2, h: Math.abs(c - sy) },
       { x: Math.min(sx, tx), y: c - 1, w: Math.abs(tx - sx), h: 2 },
       { x: tx - 1, y: Math.min(c, ty), w: 2, h: Math.abs(ty - c) }];
  const mid = horizontal ? (sx + tx) / 2 : (sy + ty) / 2;
  for (let k = 0; k <= 30; k++) {
    for (const c of (k === 0 ? [mid] : [mid + k * 24, mid - k * 24])) {
      if (!blocked(segsFor(c))) return c;
    }
  }
  return mid;
}
