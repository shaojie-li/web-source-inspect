// 浮层定位的边界几何验证。逻辑与 content.js 的 computePlacement 保持一致（改一边要同步另一边）。
const M = 8;

function computePlacement({ w, h, rect, vw, vh, prefer = 'above', margin = M }) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const overlaps = (l, t) => l < rect.right && l + w > rect.left && t < rect.bottom && t + h > rect.top;
  const inViewport = (l, t) => l >= margin && t >= margin && l + w <= vw - margin && t + h <= vh - margin;
  const overlapArea = (l, t) => {
    const ox = Math.max(0, Math.min(l + w, rect.right) - Math.max(l, rect.left));
    const oy = Math.max(0, Math.min(t + h, rect.bottom) - Math.max(t, rect.top));
    return ox * oy;
  };
  const candidates = [];
  const vertical = (top) => candidates.push({ left: clamp(rect.left, margin, Math.max(margin, vw - w - margin)), top });
  const horizontal = (left) => candidates.push({ left, top: clamp(rect.top, margin, Math.max(margin, vh - h - margin)) });
  if (prefer === 'below') {
    vertical(rect.bottom + margin);
    vertical(rect.top - h - margin);
  } else {
    vertical(rect.top - h - margin);
    vertical(rect.bottom + margin);
  }
  horizontal(rect.right + margin);
  horizontal(rect.left - w - margin);
  const pick = candidates.find((c) => inViewport(c.left, c.top) && !overlaps(c.left, c.top));
  if (pick) return pick;
  const tl = { left: margin, top: margin };
  const br = { left: Math.max(margin, vw - w - margin), top: Math.max(margin, vh - h - margin) };
  return overlapArea(tl.left, tl.top) <= overlapArea(br.left, br.top) ? tl : br;
}

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

const VW = 1280;
const VH = 800;
const W = 320; // 浮层宽
const H = 90; // 浮层高

function noOverlap({ left, top }, rect) {
  return !(left < rect.right && left + W > rect.left && top < rect.bottom && top + H > rect.top);
}
function fitsViewport({ left, top }) {
  return left >= M && top >= M && left + W <= VW - M && top + H <= VH - M;
}

const cases = [
  {
    name: '右上角的图标（就是截图里那个齿轮）：不能把 left 顶到视口外，否则浮层被压成竖排窄条',
    rect: box(1240, 20, 32, 32),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(1240, 20, 32, 32)) && p.left + W <= VW - M,
  },
  {
    name: '左上角元素：上方放不下就翻到下方，不能盖住元素',
    rect: box(16, 10, 120, 30),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(16, 10, 120, 30)) && p.top >= 40,
  },
  {
    name: '底部元素：下方放不下就翻到上方',
    rect: box(400, 770, 200, 25),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(400, 770, 200, 25)) && p.top + H <= 770,
  },
  {
    name: '左下角元素：上下都紧张时仍要既不遮挡又不出界',
    rect: box(4, 760, 60, 36),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(4, 760, 60, 36)),
  },
  {
    name: '竖向长条（侧边栏）：上下都放不下，应该走左右两侧',
    rect: box(0, 0, 200, 800),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(0, 0, 200, 800)) && p.left >= 200,
  },
  {
    name: '横向长条（顶栏）：左右放不下，应该走下方',
    rect: box(0, 0, 1280, 60),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(0, 0, 1280, 60)) && p.top >= 60,
  },
  {
    name: '元素占满整个视口：无处可躲，退让为"至少浮层完整可见"',
    rect: box(0, 0, 1280, 800),
    assert: (p) => fitsViewport(p),
  },
  {
    name: 'prefer=below（卡片）在空间充足时确实走下方，不挡住元素',
    rect: box(300, 300, 100, 40),
    prefer: 'below',
    assert: (p) => fitsViewport(p) && noOverlap(p, box(300, 300, 100, 40)) && p.top >= 340,
  },
];

let pass = 0;
for (const c of cases) {
  const p = computePlacement({ w: W, h: H, rect: c.rect, vw: VW, vh: VH, prefer: c.prefer });
  const ok = c.assert(p);
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  if (!ok) console.log(`    得到 left=${p.left} top=${p.top}（浮层 ${W}x${H}，视口 ${VW}x${VH}）`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
