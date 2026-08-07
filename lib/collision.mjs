// 卡片互斥求解器：零依賴的迭代鬆弛（sequential relaxation）——
// 物理引擎解重疊約束的標準做法。輸入一組 AABB 剛體，逐輪掃描重疊對、
// 沿最短分離軸（MTV）位移，波前以固定卡為中心向外擴散（連鎖自然發生）。
//
// 穩定性設計（防震盪）：
// - 分離量只解重疊本身＋小 slop；大間距（pad）只在「對方是固定卡」時才足額，
//   兩可動卡各半分推——避免 PAD 過衝把第三方反覆彈飛（位移單調收斂）。
// - fixed（拖曳源／鎖定卡）質量無限大：永不位移，重疊全數反推給可動方。
// - 兩張固定卡互疊不解（拖到鎖卡上是允許的）。
//
// bodies: [{ id, x, y, w, h, fx }]（就地修改 x/y）；回傳被移動的 id 清單。
// HARE 7262f50e solveOverlaps
export function solveOverlaps(bodies, { pad = 10, iter = 48 } = {}) {
  const movedIds = new Set();
  for (let it = 0; it < iter; it++) {
    let any = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        if (a.fx && b.fx) continue;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        // 最短分離軸；方向＝a 中心指向 b 中心（中心重合時往右/下讓）
        const sep = (o) => o + pad;
        let dx = 0, dy = 0;
        if (ox <= oy) dx = ((b.x + b.w / 2) >= (a.x + a.w / 2) ? 1 : -1) * sep(ox);
        else dy = ((b.y + b.h / 2) >= (a.y + a.h / 2) ? 1 : -1) * sep(oy);
        if (a.fx) { b.x += dx; b.y += dy; movedIds.add(b.id); }
        else if (b.fx) { a.x -= dx; a.y -= dy; movedIds.add(a.id); }
        else {
          a.x -= dx / 2; a.y -= dy / 2;
          b.x += dx / 2; b.y += dy / 2;
          movedIds.add(a.id); movedIds.add(b.id);
        }
        any = true;
      }
    }
    if (!any) return { movedIds, converged: true, iterations: it };
  }
  return { movedIds, converged: false, iterations: iter };
}
