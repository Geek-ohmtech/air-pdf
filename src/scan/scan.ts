/**
 * 카메라로 찍은 문서 보정 (모두 이 컴퓨터 안에서, 캔버스 픽셀로 처리)
 * - 종이 모서리 네 곳 찾기 → 원근 바로잡기(사다리꼴 → 직사각형)
 * - 기울기 바로잡기 (이미 평평한 스캔이 조금 기운 경우)
 * - 조명 고르게 + 대비: 컬러 / 회색조 / 흑백 문서
 */
export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt]; // 왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래
export type Mode = 'none' | 'color' | 'gray' | 'bw';

export function toCanvas(src: CanvasImageSource & { width: number; height: number }, maxSide = 2600) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const g = c.getContext('2d', { willReadFrequently: true })!; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const grayOf = (d: Uint8ClampedArray, n: number) => { const g = new Float32Array(n); for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114; return g; };

/** 오츠 문턱값 */
function otsu(g: Float32Array | Uint8Array) {
  const hist = new Float64Array(256); for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  const n = g.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sb = 0, wb = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) { wb += hist[t]; if (!wb) continue; const wf = n - wb; if (!wf) break; sb += t * hist[t]; const mb = sb / wb, mf = (sum - sb) / wf; const v = wb * wf * (mb - mf) ** 2; if (v > best) { best = v; th = t; } }
  return th;
}
/** 상자 흐림 (적분 영상, 반지름 r) */
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** 종이의 네 모서리 찾기: 밝은 종이 영역 가운데 가장 큰 덩어리의 대각선 끝점. 못 찾으면 그림 전체 */
export function detectQuad(c: HTMLCanvasElement): Quad {
  const W = c.width, H = c.height;
  const full: Quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const k = 360 / Math.max(W, H);
  const sw = Math.max(8, Math.round(W * k)), sh = Math.max(8, Math.round(H * k));
  const s = document.createElement('canvas'); s.width = sw; s.height = sh;
  const sg = s.getContext('2d', { willReadFrequently: true })!; sg.drawImage(c, 0, 0, sw, sh);
  const g = boxBlur(grayOf(sg.getImageData(0, 0, sw, sh).data, sw * sh), sw, sh, 1);
  const th = otsu(g);
  const mask = new Uint8Array(sw * sh); for (let i = 0; i < g.length; i++) mask[i] = g[i] > th ? 1 : 0;
  // 가장 큰 밝은 덩어리
  const lab = new Int32Array(sw * sh); let best = 0, bestN = 0, id = 0;
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || lab[i]) continue;
    id++; let n = 0; stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop()!; n++;
      const x = p % sw, y = (p / sw) | 0;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < sw - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && mask[p - sw] && !lab[p - sw]) { lab[p - sw] = id; stack.push(p - sw); }
      if (y < sh - 1 && mask[p + sw] && !lab[p + sw]) { lab[p + sw] = id; stack.push(p + sw); }
    }
    if (n > bestN) { bestN = n; best = id; }
  }
  if (bestN < sw * sh * 0.15) return full;
  let tl = Infinity, br = -Infinity, tr = -Infinity, bl = Infinity;
  const q: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  for (let i = 0; i < lab.length; i++) {
    if (lab[i] !== best) continue;
    const x = i % sw, y = (i / sw) | 0;
    if (x + y < tl) { tl = x + y; q[0] = { x, y }; }
    if (x - y > tr) { tr = x - y; q[1] = { x: x + 1, y }; }
    if (x + y > br) { br = x + y; q[2] = { x: x + 1, y: y + 1 }; }
    if (x - y < bl) { bl = x - y; q[3] = { x, y: y + 1 }; }
  }
  const quad = q.map(p => ({ x: Math.max(0, Math.min(W, p.x / k)), y: Math.max(0, Math.min(H, p.y / k)) })) as Quad;
  // 거의 그림 전체이면 (이미 잘린 스캔) 그대로
  const area = polyArea(quad);
  if (area < W * H * 0.15) return full;
  if (area > W * H * 0.97) return full;
  return quad;
}
export function polyArea(q: Pt[]) { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; } return Math.abs(a) / 2; }
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const isFull = (q: Quad, W: number, H: number) => q.every((p, i) => dist(p, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }][i]) < Math.max(W, H) * 0.004);

/** 사다리꼴 → 직사각형 (원근 바로잡기) */
export function warp(c: HTMLCanvasElement, q: Quad, maxSide = 2480) {
  let ow = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, oh = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1.6, maxSide / Math.max(ow, oh)); ow = Math.max(2, Math.round(ow * k)); oh = Math.max(2, Math.round(oh * k));
  const Hm = homography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], q);
  const src = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height), sd = src.data, SW = c.width, SH = c.height;
  const out = new ImageData(ow, oh), od = out.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const X = x + 0.5, Y = y + 0.5;
      const w = Hm[6] * X + Hm[7] * Y + 1;
      let sx = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w - 0.5, sy = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w - 0.5;
      sx = Math.max(0, Math.min(SW - 1.001, sx)); sy = Math.max(0, Math.min(SH - 1.001, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4, o = (y * ow + x) * 4;
      for (let ch = 0; ch < 3; ch++) od[o + ch] = (sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx) * (1 - fy) + (sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx) * fy;
      od[o + 3] = 255;
    }
  }
  const r = document.createElement('canvas'); r.width = ow; r.height = oh; r.getContext('2d')!.putImageData(out, 0, 0);
  return r;
}
/** 네 점 대응으로 투영 변환 (dst → src) */
function homography(from: Pt[], to: Pt[]) {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // 가우스 소거
  for (let i = 0; i < 8; i++) {
    let p = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < 8; r++) { if (r === i) continue; const f = A[r][i] / A[i][i]; for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** 기울기 찾기 (도): 글줄이 가로로 가장 또렷하게 모이는 각도 */
export function detectSkew(c: HTMLCanvasElement) {
  const k = 900 / Math.max(c.width, c.height);
  const w = Math.max(8, Math.round(c.width * k)), h = Math.max(8, Math.round(c.height * k));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0, w, h);
  const gray = grayOf(g.getImageData(0, 0, w, h).data, w * h);
  const bg = boxBlur(gray, w, h, 15);
  const pts: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (gray[i] < bg[i] * 0.78) pts.push(x, y); }
  if (pts.length < 200) return 0;
  const score = (deg: number) => {
    const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    const rows = new Float64Array(h * 2 + w);
    for (let i = 0; i < pts.length; i += 2) { const yy = Math.round(-pts[i] * sn + pts[i + 1] * cs) + w; if (yy >= 0 && yy < rows.length) rows[yy]++; }
    let v = 0; for (let i = 1; i < rows.length; i++) { const d = rows[i] - rows[i - 1]; v += d * d; }
    return v;
  };
  let best = 0, bs = -1;
  for (let d = -8; d <= 8; d += 0.5) { const sc = score(d); if (sc > bs) { bs = sc; best = d; } }
  for (let d = best - 0.5; d <= best + 0.5; d += 0.1) { const sc = score(d); if (sc > bs) { bs = sc; best = d; } }
  return Math.round(best * 10) / 10;
}
/** 돌리기 (도, 빈 곳은 흰색). 90° 단위 회전도 여기서 */
export function rotate(c: HTMLCanvasElement, deg: number) {
  if (!deg) return c;
  const t = deg * Math.PI / 180, cs = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
  const right = Math.abs(deg) % 90 === 0;
  const W = right ? Math.round(c.width * cs + c.height * sn) : c.width, H = right ? Math.round(c.width * sn + c.height * cs) : c.height;
  const r = document.createElement('canvas'); r.width = W; r.height = H;
  const g = r.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2); g.rotate(t); g.imageSmoothingQuality = 'high'; g.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}

/** 종이 바탕의 밝기가 고르지 않은가 (그늘진 사진). 이미 깨끗하게 스캔한 쪽은 false */
export function unevenLight(c: HTMLCanvasElement) {
  const k = 160 / Math.max(c.width, c.height), w = Math.max(8, Math.round(c.width * k)), h = Math.max(8, Math.round(c.height * k));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, cell = 8, vals: number[] = [];
  for (let y = 0; y + cell <= h; y += cell) for (let x = 0; x + cell <= w; x += cell) {
    let m = 0; for (let yy = y; yy < y + cell; yy++) for (let xx = x; xx < x + cell; xx++) { const j = (yy * w + xx) * 4; const v = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114; if (v > m) m = v; }
    vals.push(m);
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.1)], mid = vals[vals.length >> 1], hi = vals[Math.floor(vals.length * 0.9)];
  return (hi - lo) / Math.max(1, mid) > 0.12 || mid < 200;
}
/** 조명 고르게 + 대비. 종이 바탕을 흰색으로, 그림자를 지운다 */
export function enhance(c: HTMLCanvasElement, mode: Mode) {
  if (mode === 'none') return c;
  const W = c.width, H = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
  // 바탕 밝기: 작게 줄여서 크게 흐린 뒤 다시 키워 쓴다 (글자는 사라지고 조명만 남음)
  const f = Math.max(1, Math.round(Math.max(W, H) / 320));
  const sw = Math.ceil(W / f), sh = Math.ceil(H / f);
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    // 칸 안에서 가장 밝은 쪽(종이)을 쓴다
    let m = 0;
    for (let yy = y * f; yy < Math.min(H, y * f + f); yy += Math.max(1, f >> 1)) for (let xx = x * f; xx < Math.min(W, x * f + f); xx += Math.max(1, f >> 1)) { const j = (yy * W + xx) * 4; const v = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114; if (v > m) m = v; }
    small[y * sw + x] = m;
  }
  let bg = boxBlur(small, sw, sh, 6); bg = boxBlur(bg, sw, sh, 6);
  const bgAt = (x: number, y: number) => {
    const fx = Math.min(sw - 1.001, Math.max(0, x / f - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, y / f - 0.5));
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    return Math.max(30, (bg[y0 * sw + x0] * (1 - ax) + bg[y0 * sw + x0 + 1] * ax) * (1 - ay) + (bg[(y0 + 1) * sw + x0] * (1 - ax) + bg[(y0 + 1) * sw + x0 + 1] * ax) * ay);
  };
  const out = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = i * 4, b = bgAt(x, y);
    out[i] = Math.min(255, (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) / b * 255);
    if (mode === 'color') { const k = 255 / b; d[j] = Math.min(255, d[j] * k); d[j + 1] = Math.min(255, d[j + 1] * k); d[j + 2] = Math.min(255, d[j + 2] * k); }
  }
  // 컬러: 종이 색이 흰색이 되게 (노란 조명·파란 그늘 바로잡기)
  if (mode === 'color') {
    let r = 0, g = 0, bl = 0, cnt = 0;
    for (let i = 0, j = 0; i < n; i += 7, j += 28) if (out[i] > 215) { r += d[j]; g += d[j + 1]; bl += d[j + 2]; cnt++; }
    if (cnt > 100) {
      const m = (r + g + bl) / 3 / cnt, kr = m / (r / cnt), kg = m / (g / cnt), kb = m / (bl / cnt);
      for (let j = 0; j < d.length; j += 4) { d[j] = Math.min(255, d[j] * kr); d[j + 1] = Math.min(255, d[j + 1] * kg); d[j + 2] = Math.min(255, d[j + 2] * kb); }
    }
  }
  // 대비: 어두운 쪽 1%를 검정으로, 바탕을 흰색으로
  const hist = new Uint32Array(256); for (const v of out) hist[v | 0]++;
  let lo = 0, acc = 0; while (lo < 200 && (acc += hist[lo]) < n * 0.01) lo++;
  const hi = 236, span = Math.max(30, hi - lo);
  const curve = (v: number) => { const t = Math.max(0, Math.min(1, (v - lo) / span)); return 255 * Math.pow(t, 1.15); };
  if (mode === 'bw') {
    // 문턱값을 조금 낮춰 옅은 바탕무늬(워터마크)는 흰색으로, 남은 점은 지운다
    const th = Math.min(165, Math.max(105, otsu(out) - 6));
    const bin = new Uint8Array(n); for (let i = 0; i < n; i++) bin[i] = out[i] < th ? 1 : 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (!bin[i]) continue;
      const nb = bin[i - 1] + bin[i + 1] + bin[i - W] + bin[i + W] + bin[i - W - 1] + bin[i - W + 1] + bin[i + W - 1] + bin[i + W + 1];
      if (nb <= 1) bin[i] = 2; // 외톨이 점
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = bin[i] === 1 ? 0 : 255; d[j] = d[j + 1] = d[j + 2] = v; }
  } else if (mode === 'gray') {
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = curve(out[i]); d[j] = d[j + 1] = d[j + 2] = v; }
  } else {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const gv = out[i], k = gv > 1 ? curve(gv) / gv : 1;
      d[j] = Math.min(255, d[j] * k); d[j + 1] = Math.min(255, d[j + 1] * k); d[j + 2] = Math.min(255, d[j + 2] * k);
    }
  }
  const r = document.createElement('canvas'); r.width = W; r.height = H; r.getContext('2d')!.putImageData(img, 0, 0);
  return r;
}

export interface ScanOpts { quad?: Quad | null; mode: Mode; deskew?: boolean; turn?: number }
/** 한 장 보정: 원근 → 90° 회전 → 기울기 → 조명·대비 */
export function process(src: HTMLCanvasElement, o: ScanOpts) {
  let c = o.quad && !isFull(o.quad, src.width, src.height) ? warp(src, o.quad) : src;
  if (o.turn) c = rotate(c, o.turn);
  if (o.deskew) { const a = detectSkew(c); if (Math.abs(a) >= 0.5) c = rotate(c, -a); }
  return enhance(c === src ? copy(src) : c, o.mode);
}
const copy = (c: HTMLCanvasElement) => { const r = document.createElement('canvas'); r.width = c.width; r.height = c.height; r.getContext('2d')!.drawImage(c, 0, 0); return r; };
export async function toBlob(c: HTMLCanvasElement, mode: Mode): Promise<Blob> {
  return new Promise(res => c.toBlob(b => res(b!), mode === 'bw' ? 'image/png' : 'image/jpeg', 0.88));
}
