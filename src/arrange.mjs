// 排列/對齊/分布演算法：對一組 AABB 卡片計算目標位置（零依賴、純函數）。
// items: [{ id, x, y, w, h }]（不就地修改）；回傳 Map(id → {x, y})。
// 以選取集左上角（或中心）為錨，保持依「先上後左」排序的相對順序。

// 對齊（一律以「基準卡」為準，不取集合平均/極值）：
// anchorId＝第一張選取的卡（呼叫端由選取順序決定；省略＝items[0]）。
// left/right/top/bottom＝貼齊基準卡對應邊緣；hcenter/vcenter＝對齊基準卡中心線。
// 基準卡自身不動，其餘卡片對到它。
export function align(items, mode, anchorId) {
  if (!items || items.length < 2) return new Map();
  const a = items.find((i) => i.id === anchorId) || items[0];
  const pos = new Map();
  if (mode === "left") {
    items.forEach((i) => pos.set(i.id, { x: a.x, y: i.y }));
  } else if (mode === "right") {
    items.forEach((i) => pos.set(i.id, { x: a.x + a.w - i.w, y: i.y }));
  } else if (mode === "top") {
    items.forEach((i) => pos.set(i.id, { x: i.x, y: a.y }));
  } else if (mode === "bottom") {
    items.forEach((i) => pos.set(i.id, { x: i.x, y: a.y + a.h - i.h }));
  } else if (mode === "hcenter") { // 垂直中線對齊（x 對到基準卡中心）
    const c = a.x + a.w / 2;
    items.forEach((i) => pos.set(i.id, { x: Math.round(c - i.w / 2), y: i.y }));
  } else if (mode === "vcenter") { // 水平中線對齊（y 對到基準卡中心）
    const c = a.y + a.h / 2;
    items.forEach((i) => pos.set(i.id, { x: i.x, y: Math.round(c - i.h / 2) }));
  }
  return pos;
}

// 分布：沿軸首尾固定、中間卡片等間隙分布（間隙可為負＝總寬不足時均勻重疊）
export function distribute(items, axis) {
  if (!items || items.length < 3) return new Map();
  const pos = new Map();
  const [start, size] = axis === "h" ? ["x", "w"] : ["y", "h"];
  const list = items.slice().sort((a, b) => a[start] - b[start]);
  const first = list[0], last = list[list.length - 1];
  const span = (last[start] + last[size]) - first[start];
  const total = list.reduce((s, i) => s + i[size], 0);
  const gap = (span - total) / (list.length - 1);
  let cur = first[start];
  list.forEach((i) => {
    pos.set(i.id, axis === "h" ? { x: Math.round(cur), y: i.y } : { x: i.x, y: Math.round(cur) });
    cur += i[size] + gap;
  });
  return pos;
}
// HARE f6616051 arrange
export function arrange(items, mode, gap = 16) {
  if (!items || items.length < 2) return new Map();
  const list = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const x0 = Math.min(...list.map((i) => i.x));
  const y0 = Math.min(...list.map((i) => i.y));
  const pos = new Map();
  if (mode === "v") { // 垂直排列：x 對齊最左，依序往下
    let y = y0;
    list.forEach((i) => { pos.set(i.id, { x: x0, y }); y += i.h + gap; });
  } else if (mode === "h") { // 橫向排列：y 對齊最上，依序往右
    let x = x0;
    list.forEach((i) => { pos.set(i.id, { x, y: y0 }); x += i.w + gap; });
  } else if (mode === "grid") { // 方陣排列：近正方形網格，格寬高＝最大卡＋間距
    const cols = Math.ceil(Math.sqrt(list.length));
    const cw = Math.max(...list.map((i) => i.w)) + gap;
    const ch = Math.max(...list.map((i) => i.h)) + gap;
    list.forEach((i, k) => pos.set(i.id, { x: x0 + (k % cols) * cw, y: y0 + Math.floor(k / cols) * ch }));
  } else if (mode === "circle") { // 圓形排列：質心為圓心，半徑保證相鄰卡不重疊
    const cx = list.reduce((s, i) => s + i.x + i.w / 2, 0) / list.length;
    const cy = list.reduce((s, i) => s + i.y + i.h / 2, 0) / list.length;
    const maxD = Math.max(...list.map((i) => Math.hypot(i.w, i.h)));
    const r = Math.max(maxD, (list.length * (maxD + gap)) / (2 * Math.PI));
    list.forEach((i, k) => {
      const a = (k / list.length) * 2 * Math.PI - Math.PI / 2; // 首張在正上方
      pos.set(i.id, { x: cx + r * Math.cos(a) - i.w / 2, y: cy + r * Math.sin(a) - i.h / 2 });
    });
  }
  return pos;
}
