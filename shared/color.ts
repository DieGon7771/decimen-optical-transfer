// Experimental color matrix mode — 2 bits per module on a fixed 4-color
// palette (white/black/red/blue).
//
// In this mode a frame is NOT a standard QR code. The payload (self-describing
// frame header + fountain block, see protocol.ts) is laid out row-major across
// an N×N module grid at 2 bits/module. Three black/white finder patterns keep
// the camera locked on and give a white-balance/contrast reference. Reliability
// comes from the header + fountain layer, so no QR ECC/masking is needed.
//
// N = ceil(sqrt(frameBytes*4 + 192)) with 192 = 3 finder footprints (8×8).

import { HEADER_LEN, parseFrame, tryFrameHeader } from "./protocol";

export const COLOR_PALETTE: readonly [number, number, number][] = [
  [255, 255, 255], // 00
  [0, 0, 0], // 01
  [255, 0, 0], // 10
  [0, 0, 255], // 11
];

const FINDER = 8; // finder footprint (7×7 pattern + 1 white separator ring)
const FINDER_MODULES = 3 * FINDER * FINDER;
const CONF_THRESH = 100; // max normalized-RGB distance for a "confident" module

// 7×7 finder pattern (1 = black module)
const FINDER7: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];

export function matrixSizeFor(frameBytes: number): number {
  return Math.ceil(Math.sqrt(frameBytes * 4 + FINDER_MODULES));
}

export function isFinderCell(x: number, y: number, n: number): boolean {
  return (
    (x < FINDER && y < FINDER) ||
    (x >= n - FINDER && y < FINDER) ||
    (x < FINDER && y >= n - FINDER)
  );
}

function finderPixel(x: number, y: number, n: number): [number, number, number] {
  const dx = x < FINDER ? x : x - (n - FINDER);
  const dy = y < FINDER ? y : y - (n - FINDER);
  if (dx === 0 || dy === 0) return [255, 255, 255]; // separator ring
  return FINDER7[dy - 1]![dx - 1] ? [0, 0, 0] : [255, 255, 255];
}

// Sender: build the colored matrix for a packed frame (header + block).
export function renderColorFrame(frame: Uint8Array, margin: number): ImageData {
  const n = matrixSizeFor(frame.length);
  const total = n + 2 * margin;
  const img = new ImageData(total, total);
  const px = new Uint32Array(img.data.buffer);
  px.fill(0xffffffff); // white quiet zone + padding
  let bit = 0;
  const needBits = frame.length * 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let color: [number, number, number];
      if (isFinderCell(x, y, n)) {
        color = finderPixel(x, y, n);
      } else if (bit < needBits) {
        const byte = frame[bit >> 3]!;
        const bits = (byte >> (6 - (bit & 7))) & 0b11; // MSB-first, 2 bits/module
        bit += 2;
        color = COLOR_PALETTE[bits]!;
      } else {
        color = [255, 255, 255];
      }
      const idx = (y + margin) * total + (x + margin);
      px[idx] = (0xff << 24) | (color[2]! << 16) | (color[1]! << 8) | color[0]!;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Receiver: finder detection, calibration, grid sampling.
// ---------------------------------------------------------------------------

export interface ColorDecodeResult {
  bytes: Uint8Array;
  confidence: number; // fraction of data modules matched confidently (0..1)
}

interface Finder {
  cx: number;
  cy: number;
  mod: number; // module size in px
}

interface Run {
  start: number;
  len: number;
  dark: boolean;
}

function luminance(img: ImageData): Float32Array {
  const d = img.data;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    out[j] = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
  }
  return out;
}

function globalThreshold(lum: Float32Array): number {
  let min = 255;
  let max = 0;
  for (let i = 0; i < lum.length; i++) {
    const v = lum[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return 0.5 * (min + max);
}

function checkFinderPattern(runs: Run[], i: number): { cx: number; mod: number } | null {
  const r0 = runs[i]!,
    r1 = runs[i + 1]!,
    r2 = runs[i + 2]!,
    r3 = runs[i + 3]!,
    r4 = runs[i + 4]!;
  if (!(r0.dark && !r1.dark && r2.dark && !r3.dark && r4.dark)) return null;
  const total = r0.len + r1.len + r2.len + r3.len + r4.len;
  const mod = total / 7;
  if (mod < 2) return null;
  const ok = (len: number, ratio: number) =>
    len > mod * ratio * 0.75 && len < mod * ratio * 1.45;
  if (!ok(r0.len, 1) || !ok(r1.len, 1) || !ok(r2.len, 3) || !ok(r3.len, 1) || !ok(r4.len, 1)) {
    return null;
  }
  return { cx: r2.start + r2.len / 2, mod };
}

function rowRuns(lum: Float32Array, w: number, y: number, thr: number): Run[] {
  const runs: Run[] = [];
  const row = y * w;
  let start = 0;
  let dark = lum[row]! < thr;
  for (let x = 1; x <= w; x++) {
    const cur = x < w ? lum[row + x]! < thr : !dark;
    if (cur !== dark) {
      runs.push({ start, len: x - start, dark });
      start = x;
      dark = cur;
    }
  }
  return runs;
}

interface Cand {
  x: number;
  y: number;
  mod: number;
  votes: number;
}

function findFinders(lum: Float32Array, w: number, h: number, thr: number): Finder[] | null {
  const cands: Cand[] = [];
  for (let y = 2; y < h - 2; y += 2) {
    const runs = rowRuns(lum, w, y, thr);
    for (let i = 0; i + 4 < runs.length; i++) {
      const hit = checkFinderPattern(runs, i);
      if (hit) cands.push({ x: hit.cx, y, mod: hit.mod, votes: 1 });
    }
  }
  if (cands.length < 3) return null;
  const clusters: Cand[] = [];
  for (const c of cands) {
    let hit: Cand | null = null;
    for (const cl of clusters) {
      if (Math.abs(cl.x - c.x) < 3 * c.mod && Math.abs(cl.y - c.y) < 3 * c.mod) {
        hit = cl;
        break;
      }
    }
    if (hit) {
      hit.x = (hit.x * hit.votes + c.x) / (hit.votes + 1);
      hit.y = (hit.y * hit.votes + c.y) / (hit.votes + 1);
      hit.mod = (hit.mod * hit.votes + c.mod) / (hit.votes + 1);
      hit.votes++;
    } else {
      clusters.push({ ...c });
    }
  }
  const top = clusters
    .filter((cl) => cl.votes >= 2)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 3);
  if (top.length < 3) return null;
  for (const t of top) {
    const cy = columnCenter(lum, w, h, thr, t.x, t.y, t.mod);
    if (cy !== null) t.y = cy;
  }
  return top.map((t) => ({ cx: t.x, cy: t.y, mod: t.mod }));
}

function columnCenter(
  lum: Float32Array,
  w: number,
  h: number,
  thr: number,
  x: number,
  y: number,
  mod: number,
): number | null {
  const y0 = Math.max(0, Math.round(y - 4 * mod));
  const y1 = Math.min(h, Math.round(y + 4 * mod));
  if (y1 <= y0) return null;
  const runs: Run[] = [];
  let start = y0;
  let dark = lum[start * w + x]! < thr;
  for (let yy = y0 + 1; yy <= y1; yy++) {
    const cur = yy < y1 ? lum[yy * w + x]! < thr : !dark;
    if (cur !== dark) {
      runs.push({ start, len: yy - start, dark });
      start = yy;
      dark = cur;
    }
  }
  for (let i = 0; i + 4 < runs.length; i++) {
    const hit = checkFinderPattern(runs, i);
    if (hit) return hit.cx;
  }
  return null;
}

function orderFinders(fs: Finder[]): [Finder, Finder, Finder] {
  // the corner is the finder whose two arms are most perpendicular
  let corner = fs[0]!;
  let best = Infinity;
  for (const p of fs) {
    const others = fs.filter((q) => q !== p);
    const v1x = others[0]!.cx - p.cx;
    const v1y = others[0]!.cy - p.cy;
    const v2x = others[1]!.cx - p.cx;
    const v2y = others[1]!.cy - p.cy;
    const dot = Math.abs(v1x * v2x + v1y * v2y);
    if (dot < best) {
      best = dot;
      corner = p;
    }
  }
  const rest = fs.filter((q) => q !== corner);
  const a = rest[0]!;
  const b = rest[1]!;
  const aHoriz = Math.abs(a.cy - corner.cy) < Math.abs(a.cx - corner.cx);
  return aHoriz ? [corner, a, b] : [corner, b, a]; // [TL, TR, BL]
}

const dist2 = (a: Finder, b: Finder) => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;

function sampleModule(
  d: Uint8ClampedArray,
  W: number,
  H: number,
  px: number,
  py: number,
  mod: number,
): [number, number, number] {
  const s = Math.max(1, Math.round(mod * 0.5));
  const x0 = Math.max(0, Math.min(W - 1, Math.round(px - s / 2)));
  const y0 = Math.max(0, Math.min(H - 1, Math.round(py - s / 2)));
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let yy = y0; yy < Math.min(H, y0 + s); yy++) {
    for (let xx = x0; xx < Math.min(W, x0 + s); xx++) {
      const i = (yy * W + xx) * 4;
      r += d[i]!;
      g += d[i + 1]!;
      b += d[i + 2]!;
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function calibrate(
  img: ImageData,
  n: number,
  mod: number,
  tl: Finder,
): { white: [number, number, number]; black: [number, number, number] } {
  const d = img.data;
  const W = img.width;
  const H = img.height;
  let wr = 0,
    wg = 0,
    wb = 0,
    wc = 0,
    br = 0,
    bg = 0,
    bb = 0,
    bc = 0;
  const boxes = [
    [0, 0],
    [n - FINDER, 0],
    [0, n - FINDER],
  ] as const;
  for (const [bx, by] of boxes) {
    for (let dy = 0; dy < FINDER; dy++) {
      for (let dx = 0; dx < FINDER; dx++) {
        const c = sampleModule(
          d,
          W,
          H,
          tl.cx + (bx + dx - 3.5) * mod,
          tl.cy + (by + dy - 3.5) * mod,
          mod,
        );
        const black = dx !== 0 && dy !== 0 && FINDER7[dy - 1]![dx - 1] === 1;
        if (black) {
          br += c[0]!;
          bg += c[1]!;
          bb += c[2]!;
          bc++;
        } else {
          wr += c[0]!;
          wg += c[1]!;
          wb += c[2]!;
          wc++;
        }
      }
    }
  }
  if (!wc || !bc) return { white: [255, 255, 255], black: [0, 0, 0] };
  return {
    white: [wr / wc, wg / wc, wb / wc],
    black: [br / bc, bg / bc, bb / bc],
  };
}

function sample(
  img: ImageData,
  n: number,
  mod: number,
  tl: Finder,
  byteCount: number,
): { bytes: Uint8Array; confidence: number } {
  const d = img.data;
  const W = img.width;
  const H = img.height;
  const cal = calibrate(img, n, mod, tl);
  const bytes = new Uint8Array(byteCount);
  let bit = 0;
  const needBits = byteCount * 8;
  let confSum = 0;
  let confCount = 0;
  outer: for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (isFinderCell(mx, my, n)) continue;
      const c = sampleModule(
        d,
        W,
        H,
        tl.cx + (mx - 3.5) * mod,
        tl.cy + (my - 3.5) * mod,
        mod,
      );
      // normalize per channel using the finder white/black reference, then
      // classify by euclidean distance in normalized RGB
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < COLOR_PALETTE.length; k++) {
        const p = COLOR_PALETTE[k]!;
        let dist = 0;
        for (let ch = 0; ch < 3; ch++) {
          const denom = cal.white[ch]! - cal.black[ch]!;
          let v = c[ch]!;
          if (denom > 8) v = ((v - cal.black[ch]!) * 255) / denom;
          const dd = v - p[ch]!;
          dist += dd * dd;
        }
        if (dist < bestD) {
          bestD = dist;
          best = k;
        }
      }
      confCount++;
      if (bestD < CONF_THRESH * CONF_THRESH) confSum++;
      if (bit < needBits) {
        bytes[bit >> 3] = (bytes[bit >> 3]! << 2) | best;
        bit += 2;
        if (bit >= needBits) break outer;
      }
    }
  }
  return { bytes, confidence: confCount ? confSum / confCount : 0 };
}

export function decodeColorFrame(img: ImageData): ColorDecodeResult | null {
  const w = img.width;
  const h = img.height;
  if (w < 16 || h < 16) return null;
  const lum = luminance(img);
  const thr = globalThreshold(lum);
  const finders = findFinders(lum, w, h, thr);
  if (!finders) return null;
  const [tl, tr, bl] = orderFinders(finders);
  const dTR = Math.sqrt(dist2(tl, tr));
  const mod0 = (tl.mod + tr.mod + bl.mod) / 3;
  const nEst = Math.round(dTR / mod0 + 8);
  // Probe nearby sizes: the header can only parse at the exact N the sender
  // used, so a correct parse pins the grid size. Module size is refined with
  // the top-left→top-right finder distance for each candidate.
  for (let d = -2; d <= 2; d++) {
    const n = nEst + d;
    if (n < FINDER + 4) continue;
    const mod = dTR / (n - 8);
    const head = sample(img, n, mod, tl, HEADER_LEN);
    const parsed = tryFrameHeader(head.bytes); // lenient — the probe is exactly HEADER_LEN bytes
    if (!parsed) continue;
    const frameBytes = HEADER_LEN + parsed.blockLen;
    const nExact = matrixSizeFor(frameBytes);
    const modExact = dTR / (nExact - 8);
    const res = sample(img, nExact, modExact, tl, frameBytes);
    const re = parseFrame(res.bytes); // full frame → exact-length check passes
    if (re && re.header.sessionId === parsed.sessionId) {
      return { bytes: res.bytes, confidence: res.confidence };
    }
  }
  return null;
}

// Cheap heuristic used on the receiver in B/N mode: if a captured frame shows a
// significant share of strong red/blue pixels, the sender is probably running
// in color mode — suggest flipping the toggle.
export function hasStrongColor(img: ImageData, every = 4): boolean {
  const d = img.data;
  let red = 0;
  let blue = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * every) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    if (r > 110 && g < 90 && b < 90) red++;
    else if (b > 110 && r < 90 && g < 90) blue++;
    n++;
  }
  return n > 0 && (red + blue) / n > 0.01;
}
