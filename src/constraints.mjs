// 持續性約束群組（零依賴純函數）：對齊約束成員形成群組，
// 任一成員移動時其餘成員沿約束軸跟隨；支援多重群組（A-B 一組、A-C 另一組）
// 以 BFS 跨群組傳播（visited 防環）。座標一律為同一父層的相對座標。
//
// constraint: { id, type: left|right|top|bottom|hcenter|vcenter|gapv|gaph, members: [nodeId],
//   off?: {id: number} }——gapv/gaph（間格約束，W1-2-6）：建立當下記錄各成員的 y/x 偏移，
//   之後任一成員移動，其餘成員維持建立時的間距跟隨（軸外方向不動）。
// nodes: [{ id, x, y, w, h }]；movedId＝拖動源。回傳 Map(id → {x, y})（不含 movedId）。
// HARE 8d40f7c1 propagate
// 各約束型別作用的軸：多約束並存時按「軸」各自定案（
// 早期以整個節點做 visited，同卡的第二條約束被跳過 → 多約束沒有完全套用。
// 例：B 與 A 有 left（x 軸）＋ gapv（y 軸）兩條約束，拖 A 時 B 兩軸都要跟）。
const AXIS = { left: "x", right: "x", hcenter: "x", gaph: "x",
  top: "y", bottom: "y", vcenter: "y", gapv: "y" };

export function propagate(nodes, constraints, movedId) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n }]));
  const out = new Map();
  // done：各節點已定案的軸（同軸只接受第一條約束的結果，防振盪/迴圈；不同軸互不干擾）
  const done = new Map([[movedId, { x: true, y: true }]]);
  const queue = [movedId];
  while (queue.length) {
    const cur = queue.shift();
    const c0 = byId.get(cur);
    if (!c0) continue;
    for (const c of constraints || []) {
      if (!Array.isArray(c.members) || !c.members.includes(cur)) continue;
      const ax = AXIS[c.type];
      if (!ax) continue;
      for (const mid of c.members) {
        if (mid === cur) continue;
        const m = byId.get(mid);
        if (!m) continue;
        const d = done.get(mid) || {};
        if (d[ax]) continue; // 該軸已由其他約束定案
        let nx = m.x, ny = m.y;
        switch (c.type) {
          case "left": nx = c0.x; break;
          case "right": nx = c0.x + c0.w - m.w; break;
          case "top": ny = c0.y; break;
          case "bottom": ny = c0.y + c0.h - m.h; break;
          case "hcenter": nx = c0.x + c0.w / 2 - m.w / 2; break;
          case "vcenter": ny = c0.y + c0.h / 2 - m.h / 2; break;
          case "gapv": ny = c0.y + ((c.off?.[mid] ?? 0) - (c.off?.[cur] ?? 0)); break; // 上下間格
          case "gaph": nx = c0.x + ((c.off?.[mid] ?? 0) - (c.off?.[cur] ?? 0)); break; // 左右間格
          default: break;
        }
        d[ax] = true; done.set(mid, d);
        if (Math.abs(nx - m.x) > 0.5 || Math.abs(ny - m.y) > 0.5) {
          m.x = nx; m.y = ny;
          out.set(mid, { x: nx, y: ny });
          queue.push(mid); // 跨群組連鎖（A-B 動了 B，B-C 群組再帶動 C）
        }
      }
    }
  }
  return out;
}

// 移除節點後清理約束：成員剔除、少於 2 人的約束整條移除
export function pruneConstraints(constraints, existingIds) {
  return (constraints || [])
    .map((c) => ({ ...c, members: (c.members || []).filter((m) => existingIds.has(m)) }))
    .filter((c) => c.members.length >= 2);
}
