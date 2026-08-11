// Boundary geometry checks for overlay placement. Keep this in sync with content.js computePlacement.
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
const W = 320; // overlay width
const H = 90; // overlay height

function noOverlap({ left, top }, rect) {
  return !(left < rect.right && left + W > rect.left && top < rect.bottom && top + H > rect.top);
}
function fitsViewport({ left, top }) {
  return left >= M && top >= M && left + W <= VW - M && top + H <= VH - M;
}

const cases = [
  {
    name: 'a top-right icon keeps the overlay within the viewport instead of collapsing into a narrow column',
    rect: box(1240, 20, 32, 32),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(1240, 20, 32, 32)) && p.left + W <= VW - M,
  },
  {
    name: 'a top-left element uses the space below when there is no room above',
    rect: box(16, 10, 120, 30),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(16, 10, 120, 30)) && p.top >= 40,
  },
  {
    name: 'a bottom element uses the space above when there is no room below',
    rect: box(400, 770, 200, 25),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(400, 770, 200, 25)) && p.top + H <= 770,
  },
  {
    name: 'a bottom-left element stays visible without overlap when vertical space is constrained',
    rect: box(4, 760, 60, 36),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(4, 760, 60, 36)),
  },
  {
    name: 'a vertical sidebar uses either horizontal side when neither vertical side fits',
    rect: box(0, 0, 200, 800),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(0, 0, 200, 800)) && p.left >= 200,
  },
  {
    name: 'a horizontal header uses the space below when neither horizontal side fits',
    rect: box(0, 0, 1280, 60),
    assert: (p) => fitsViewport(p) && noOverlap(p, box(0, 0, 1280, 60)) && p.top >= 60,
  },
  {
    name: 'a full-viewport element falls back to keeping the entire overlay visible',
    rect: box(0, 0, 1280, 800),
    assert: (p) => fitsViewport(p),
  },
  {
    name: 'prefer=below places the overlay below a card when space is available',
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
  if (!ok) console.log(`    got left=${p.left} top=${p.top} (overlay ${W}x${H}, viewport ${VW}x${VH})`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
