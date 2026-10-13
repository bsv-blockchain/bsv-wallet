// Guilloche, the fine-line patterns of banknotes, drawn as SVG paths in
// millimetres for the printed backups (src/print/designs.ts). Pure maths, so
// the pages can be built and tested anywhere.

const f = (n: number) => +n.toFixed(3)
type Pt = [number, number]
export const poly = (pts: Pt[]) => 'M' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join('L')
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/** A hypotrochoid rosette, the banknote flower. */
export function rosette(cx: number, cy: number, R: number, r: number, d: number, scale: number, rot = 0, steps = 2400): string {
  const pts: Pt[] = []
  const turns = r / gcd(R, r)
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t)
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t)
    pts.push([cx + scale * (x * Math.cos(rot) - y * Math.sin(rot)), cy + scale * (x * Math.sin(rot) + y * Math.cos(rot))])
  }
  return poly(pts)
}

/** A scalloped ring between two radii: the lace round a mark. */
export function ring(cx: number, cy: number, r0: number, r1: number, petals: number, phase = 0, steps = 1800): string {
  const pts: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const rr = r0 + (r1 - r0) * (0.5 + 0.5 * Math.sin(petals * t + phase))
    pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)])
  }
  return poly(pts) + 'Z'
}

/** Fine wavy lines across a box: the security background. */
export function waves(x0: number, y0: number, w: number, h: number, gap: number, amp: number, len: number, phase = 0): string {
  let d = ''
  for (let y = y0; y <= y0 + h; y += gap) {
    const pts: Pt[] = []
    for (let x = x0; x <= x0 + w; x += 0.8) pts.push([x, y + amp * Math.sin((x / len) * Math.PI * 2 + y * 0.35 + phase)])
    d += poly(pts)
  }
  return d
}

/** A woven band: phase-shifted sine strands. */
export function band(x0: number, y: number, w: number, h: number, strands: number, wave: number): string {
  let d = ''
  for (let s = 0; s < strands; s++) {
    const pts: Pt[] = []
    for (let x = x0; x <= x0 + w; x += 0.35) pts.push([x, y + (h / 2) * Math.sin((x / wave) * Math.PI * 2 + (s * Math.PI) / strands)])
    d += poly(pts)
  }
  return d
}

/** Chained loops along a line: a voucher's beading. */
export function loops(x0: number, y: number, w: number, size: number): string {
  const pts: Pt[] = []
  for (let t = 0; t <= (w / size) * Math.PI * 2; t += 0.05) pts.push([x0 + (t / (Math.PI * 2)) * size + size * 0.55 * Math.sin(t), y + size * 0.45 * Math.cos(t)])
  return poly(pts)
}

/** A fan of curves sweeping round a corner mark (the classic paper wallet's swirl). */
export function fan(cx: number, cy: number, r: number, from: number, to: number, n: number, bulge: number): string {
  let d = ''
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / n
    const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a)
    const x2 = cx + (r + bulge) * Math.cos(a + 1.1), y2 = cy + (r + bulge) * Math.sin(a + 1.1)
    const qx = cx + (r + bulge * 1.4) * Math.cos(a + 0.35), qy = cy + (r + bulge * 1.4) * Math.sin(a + 0.35)
    d += `M${f(x1)} ${f(y1)}Q${f(qx)} ${f(qy)} ${f(x2)} ${f(y2)}`
  }
  return d
}

/** Sun rays from a centre: alternate wedges. */
export function rays(cx: number, cy: number, r0: number, r1: number, n: number): string {
  let d = ''
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, b = a + Math.PI / n
    d += `M${f(cx + r0 * Math.cos(a))} ${f(cy + r0 * Math.sin(a))}L${f(cx + r1 * Math.cos(a))} ${f(cy + r1 * Math.sin(a))}L${f(cx + r1 * Math.cos(b))} ${f(cy + r1 * Math.sin(b))}Z`
  }
  return d
}

/** Chained loops down a line: beading for a frame's sides. */
export function loopsV(x: number, y0: number, h: number, size: number): string {
  const pts: Pt[] = []
  for (let t = 0; t <= (h / size) * Math.PI * 2; t += 0.05) pts.push([x + size * 0.45 * Math.cos(t), y0 + (t / (Math.PI * 2)) * size + size * 0.55 * Math.sin(t)])
  return poly(pts)
}

/** A Greek key fret along a line: a continuous squared meander, `u` a step. */
export function fret(x0: number, y: number, w: number, u: number): string {
  let d = `M${f(x0)} ${f(y + 3 * u)}`
  for (let x = x0; x + 4 * u <= x0 + w + 0.01; x += 4 * u) {
    const p = (dx: number, dy: number) => `L${f(x + dx * u)} ${f(y + dy * u)}`
    d += p(0, 0) + p(3, 0) + p(3, 2) + p(2, 2) + p(2, 1) + p(1, 1) + p(1, 3) + p(4, 3)
  }
  return d
}

/** Cloud curls along a line: auspicious clouds, each a scroll that turns in on itself. */
export function clouds(x0: number, y: number, w: number, s: number, up = true): string {
  const sweep = up ? 1 : 0
  const k = up ? -1 : 1
  let d = ''
  for (let x = x0; x + 2 * s <= x0 + w + 0.01; x += 2 * s) {
    d += `M${f(x)} ${f(y)}A${f(s)} ${f(s)} 0 0 ${sweep} ${f(x + 2 * s)} ${f(y)}`
    d += `M${f(x + 2 * s)} ${f(y)}A${f(s * 0.55)} ${f(s * 0.55)} 0 0 ${1 - sweep} ${f(x + 0.9 * s)} ${f(y)}A${f(s * 0.3)} ${f(s * 0.3)} 0 0 ${sweep} ${f(x + 1.5 * s)} ${f(y + k * 0.01)}`
  }
  return d
}
