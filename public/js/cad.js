// DXF drawing preview: the file is read with dxf-parser and becomes an SVG image (white background, like paper),
// which the viewer shows like any other image: zoom, notes on points, pins.
// Drawn: lines, polylines (with bulge arcs), circles, arcs, ellipses, splines, texts, blocks (INSERT, grids too),
// dimensions (their block), solids and points; layers that are off or frozen are not. Paper space is skipped: model
// space is shown. Loaded only when a DXF is opened.

let parser = null;
async function loadParser() {
  if (!parser) {
    await import('../vendor/dxf-parser/dxf-parser.js'); // UMD: registers itself as self.DxfParser
    const P = self.DxfParser?.default || self.DxfParser;
    parser = new P();
  }
  return parser;
}

// 2D matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const I = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, p) => [m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]];
const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const angleOf = m => Math.atan2(m[1], m[0]);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// On white paper light colours (pure yellow, green and cyan) cannot be read: they are darkened.
const hex = c => {
  let r = (c >> 16) & 255;
  let g = (c >> 8) & 255;
  let b = c & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.42) [r, g, b] = [r, g, b].map(x => Math.round(x * (0.42 / lum)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};
const n = x => (Math.round(x * 1000) / 1000).toString();

// MTEXT text without formatting codes ({\fArial|b0;…}, \P new line, \~ space…) and %%c, %%d, %%p.
function plainText(s) {
  return String(s || '')
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ')
    .replace(/\\[ACcFfHhQTWp][^;\\{}]*;/g, '').replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;]*)[#^/]([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '').replace(/\\\\/g, '\\')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%');
}

// Points of an arc (angles in radians, counter-clockwise), one every ~5 degrees.
function arcPoints(cx, cy, r, a0, a1) {
  while (a1 <= a0) a1 += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((a1 - a0) / (Math.PI / 36)));
  return Array.from({ length: steps + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / steps; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
}

// Polyline segment with bulge (tan(angle/4)): the arc between two vertices.
function bulgePoints(p, q, bulge) {
  const theta = 4 * Math.atan(bulge);
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  if (!d) return [];
  const r = d / (2 * Math.sin(theta / 2));
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const h0 = r * Math.cos(theta / 2);
  const cx = mx - (h0 * (q.y - p.y)) / d;
  const cy = my + (h0 * (q.x - p.x)) / d;
  const a0 = Math.atan2(p.y - cy, p.x - cx);
  const a1 = Math.atan2(q.y - cy, q.x - cx);
  const pts = theta > 0 ? arcPoints(cx, cy, Math.abs(r), a0, a1) : arcPoints(cx, cy, Math.abs(r), a1, a0).reverse();
  return pts.slice(1);
}

// Sampled B-spline (de Boor); without valid knots the points are joined.
function splinePoints(e) {
  const ctrl = e.controlPoints || [];
  const k = e.degreeOfSplineCurve || 3;
  const knots = e.knotValues || [];
  if (ctrl.length <= k || knots.length !== ctrl.length + k + 1) return (e.fitPoints?.length ? e.fitPoints : ctrl);
  const t0 = knots[k];
  const t1 = knots[ctrl.length];
  const out = [];
  const steps = Math.min(400, ctrl.length * 12);
  for (let s = 0; s <= steps; s++) {
    const t = t0 + ((t1 - t0) * s) / steps;
    let span = k;
    while (span < ctrl.length - 1 && t >= knots[span + 1]) span++;
    const d = Array.from({ length: k + 1 }, (_, j) => ({ ...ctrl[span - k + j] }));
    for (let r = 1; r <= k; r++) {
      for (let j = k; j >= r; j--) {
        const i = span - k + j;
        const den = knots[i + k - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    out.push(d[k]);
  }
  return out;
}

const HALIGN = ['start', 'middle', 'end', 'start', 'middle', 'start'];
const MTEXT_ANCHOR = ['start', 'middle', 'end'];

// dxf (already read) → { svg, width, height }: width and height are the image's "natural" size (long side 1600),
// the drawing is in the viewBox.
export function dxfToSvg(dxf) {
  const layers = dxf.tables?.layer?.layers || {};
  const blocks = dxf.blocks || {};
  const out = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = ([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  // Colour: the entity's, or the layer's (also for "by block", simplifying); white/black (7) is black on paper.
  const colorOf = (e, inherited) => {
    const idx = e.colorIndex;
    if (idx === 7) return '#000000';
    if (e.color != null && idx !== 0 && idx !== 256) return hex(e.color);
    if (idx === 0 && inherited) return inherited;
    const l = layers[e.layer];
    if (!l || l.colorIndex === 7 || l.color == null) return inherited || '#000000';
    return hex(l.color);
  };
  const hiddenLayer = e => { const l = layers[e.layer]; return l && (l.visible === false || l.frozen); };
  const poly = (pts, m, color, closed = false, fill = false) => {
    const w = pts.map(p => apply(m, p));
    if (w.length < 2) return;
    w.forEach(grow);
    const d = `M${w.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}${closed ? 'Z' : ''}`;
    out.push(`<path d="${d}" stroke="${color}"${fill ? ` fill="${color}"` : ''}/>`);
  };
  const text = (str, pos, height, rotDeg, anchor, color, m, baseline = 0) => {
    const s = plainText(str);
    if (!s.trim() || !height) return;
    const [x, y] = apply(m, pos);
    const hgt = height * scaleOf(m);
    const rot = rotDeg + (angleOf(m) * 180) / Math.PI;
    const lines = s.split('\n');
    const longest = Math.max(...lines.map(l => l.length));
    grow([x, y]);
    grow([x + Math.cos((rot * Math.PI) / 180) * longest * hgt * 0.6, y + Math.sin((rot * Math.PI) / 180) * longest * hgt * 0.6]);
    grow([x, y - lines.length * hgt * 1.4]);
    const spans = lines.map((l, i) => `<tspan x="0" dy="${i ? '1.35em' : n(baseline * hgt)}">${esc(l)}</tspan>`).join('');
    out.push(`<text transform="translate(${n(x)} ${n(y)}) rotate(${n(rot)}) scale(1 -1)" font-size="${n(hgt)}" fill="${color}" stroke="none" text-anchor="${anchor}">${spans}</text>`);
  };

  const draw = (list, m, depth, inherited) => {
    if (depth > 12) return; // endlessly nested blocks
    for (const e of list || []) {
      if (e.inPaperSpace || hiddenLayer(e)) continue;
      const color = colorOf(e, inherited);
      switch (e.type) {
        case 'LINE': poly(e.vertices, m, color); break;
        case 'LWPOLYLINE':
        case 'POLYLINE': {
          if (e.isPolyfaceMesh || e.is3dPolygonMesh) break;
          const v = e.vertices || [];
          const pts = v.length ? [v[0]] : [];
          const count = e.shape || e.closed ? v.length : v.length - 1;
          for (let i = 0; i < count; i++) {
            const p = v[i];
            const q = v[(i + 1) % v.length];
            if (p.bulge) pts.push(...bulgePoints(p, q, p.bulge));
            else pts.push(q);
          }
          poly(pts, m, color, !!(e.shape || e.closed));
          break;
        }
        case 'CIRCLE': poly(arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI), m, color, true); break;
        case 'ARC': poly(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), m, color); break;
        case 'ELLIPSE': {
          const a = e.majorAxisEndPoint;
          const rot = Math.atan2(a.y, a.x);
          const ra = Math.hypot(a.x, a.y);
          const rb = ra * (e.axisRatio || 1);
          let t0 = e.startAngle ?? 0;
          let t1 = e.endAngle ?? 2 * Math.PI;
          while (t1 <= t0) t1 += 2 * Math.PI;
          const steps = Math.max(8, Math.ceil((t1 - t0) / (Math.PI / 36)));
          const pts = Array.from({ length: steps + 1 }, (_, i) => {
            const t = t0 + ((t1 - t0) * i) / steps;
            const x = ra * Math.cos(t);
            const y = rb * Math.sin(t);
            return { x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) };
          });
          poly(pts, m, color);
          break;
        }
        case 'SPLINE': poly(splinePoints(e), m, color, !!e.closed); break;
        case 'SOLID':
        case '3DFACE': {
          const p = (e.points || e.vertices || []).filter(Boolean);
          // SOLID: the third and fourth points are swapped compared to the outline order.
          const ring = e.type === 'SOLID' && p.length === 4 ? [p[0], p[1], p[3], p[2]] : p;
          poly(ring, m, color, true, e.type === 'SOLID');
          break;
        }
        case 'POINT': {
          const [x, y] = apply(m, e.position);
          grow([x, y]);
          out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="0.5" fill="${color}" stroke="none" vector-effect="non-scaling-stroke"/>`);
          break;
        }
        case 'TEXT': {
          const anchor = HALIGN[e.halign || 0] || 'start';
          const at = e.halign && e.endPoint ? e.endPoint : e.startPoint;
          const base = e.valign === 2 ? 0.5 : e.valign === 3 ? 1 : 0;
          if (at) text(e.text, at, e.textHeight, e.rotation || 0, anchor, color, m, base);
          break;
        }
        case 'MTEXT': {
          const ap = (e.attachmentPoint || 1) - 1;
          const rot = e.rotation ?? (e.directionVector ? (Math.atan2(e.directionVector.y, e.directionVector.x) * 180) / Math.PI : 0);
          const base = Math.floor(ap / 3) === 0 ? 1 : Math.floor(ap / 3) === 1 ? 0.5 : 0;
          if (e.position) text(e.text, e.position, e.height, rot, MTEXT_ANCHOR[ap % 3], color, m, base);
          break;
        }
        case 'INSERT': {
          const b = blocks[e.name];
          if (!b) break;
          const rot = ((e.rotation || 0) * Math.PI) / 180;
          const sx = e.xScale ?? 1;
          const sy = e.yScale ?? 1;
          const base = b.position || { x: 0, y: 0 };
          const cols = Math.max(1, e.columnCount || 1);
          const rows = Math.max(1, e.rowCount || 1);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const ox = c * (e.columnSpacing || 0);
              const oy = r * (e.rowSpacing || 0);
              const local = mul(
                [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), e.position.x, e.position.y],
                mul([1, 0, 0, 1, ox, oy], [sx, 0, 0, sy, -base.x * sx, -base.y * sy]),
              );
              draw(b.entities, mul(m, local), depth + 1, color);
            }
          }
          break;
        }
        case 'DIMENSION': {
          const b = blocks[e.block];
          if (b) draw(b.entities, m, depth + 1, color);
          break;
        }
        default: break;
      }
    }
  };
  draw(dxf.entities, I, 0, null);
  if (!Number.isFinite(minX)) throw new Error('nothing to draw in model space');
  // A 2% margin; a drawing made of a single horizontal line still gets some height.
  let w = maxX - minX;
  let hgt = maxY - minY;
  const pad = Math.max(w, hgt) * 0.02 || 1;
  w = Math.max(w, hgt / 50) + 2 * pad;
  hgt = Math.max(hgt, w / 50) + 2 * pad;
  const x0 = (minX + maxX) / 2 - w / 2;
  const y0 = (minY + maxY) / 2 - hgt / 2;
  const width = w >= hgt ? 1600 : Math.round((1600 * w) / hgt);
  const height = w >= hgt ? Math.round((1600 * hgt) / w) : 1600;
  // DXF y goes up, SVG y goes down: the drawing is flipped (texts straighten themselves).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${n(x0)} ${n(-(y0 + hgt))} ${n(w)} ${n(hgt)}">`
    + `<rect x="${n(x0)}" y="${n(-(y0 + hgt))}" width="${n(w)}" height="${n(hgt)}" fill="#fff"/>`
    + `<g transform="scale(1 -1)" fill="none" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" font-family="Helvetica, Arial, sans-serif">`
    + `<style>path{vector-effect:non-scaling-stroke}</style>${out.join('')}</g></svg>`;
  return { svg, width, height };
}

// File text → URL of an SVG image (to release with URL.revokeObjectURL when no longer needed).
export async function dxfImage(text) {
  const p = await loadParser();
  const dxf = p.parseSync(text);
  const { svg, width, height } = dxfToSvg(dxf);
  return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), width, height };
}
