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
/** 작은 그림(낮은 해상도 스캔)은 보정 전에 키운다: 글자를 또렷하게 다듬을 여유가 생긴다 */
export function upscale(c: HTMLCanvasElement, minLong = 2200) {
  const m = Math.max(c.width, c.height); if (m >= minLong) return c;
  const k = Math.min(4, minLong / m), r = document.createElement('canvas');
  r.width = Math.round(c.width * k); r.height = Math.round(c.height * k);
  const g = r.getContext('2d')!; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, r.width, r.height);
  return r;
}
/** 거의 흑백인 문서인가 (색이 거의 없으면 회색조 보정이 더 깨끗하다) */
export function mostlyGray(c: HTMLCanvasElement) {
  const k = 200 / Math.max(c.width, c.height), w = Math.max(4, Math.round(c.width * k)), h = Math.max(4, Math.round(c.height * k));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; let colored = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx < 235) { n++; if (mx - mn > 45) colored++; } // 바탕(밝은 곳)은 빼고, 글자·그림 쪽에서 색이 뚜렷한 점
  }
  return n === 0 || colored / n < 0.06;
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
  // 종이 밖 = 그림 가장자리에서 이어진 어두운 곳. 나머지(글자·표 테두리 포함)는 모두 종이로 본다
  // (밝은 덩어리만 찾으면 굵은 표 테두리 안쪽만 종이로 잘못 잡는다)
  const g0 = grayOf(sg.getImageData(0, 0, sw, sh).data, sw * sh);
  const bgm = new Uint8Array(sw * sh); const stack: number[] = [];
  // 가장자리에서 이어진 어두운 덩어리마다: 종이와 맞닿은 경계가 흐릿하게 번지면(그늘) 종이로 되돌린다.
  // 진짜 종이 테두리는 몇 픽셀 안에서 밝기가 확 바뀌고, 그늘은 넓게 서서히 바뀐다
  const comp: number[] = [];
  const grow = (seed: number) => {
    if (mask[seed] || bgm[seed]) return;
    comp.length = 0; bgm[seed] = 1; stack.push(seed);
    while (stack.length) {
      const p = stack.pop()!; comp.push(p);
      const x = p % sw, y = (p / sw) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
      for (const q of nb) if (q >= 0 && !mask[q] && !bgm[q]) { bgm[q] = 1; stack.push(q); }
    }
    let soft = 0, sharp = 0;
    const at = (x: number, y: number) => g0[Math.max(0, Math.min(sh - 1, y)) * sw + Math.max(0, Math.min(sw - 1, x))];
    for (const p of comp) {
      const x = p % sw, y = (p / sw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh || !mask[yy * sw + xx]) continue;
        const wide = at(x + dx * 7, y + dy * 7) - at(x - dx * 6, y - dy * 6); if (wide < 18) continue;
        const local = at(x + dx * 2, y + dy * 2) - at(x - dx, y - dy);
        if (local / wide < 0.5) soft++; else sharp++;
      }
    }
    if (!(soft + sharp > 10 && soft > sharp * 1.5)) return;
    // 그늘이다: 그 안에서 다시 나눠 본다 (그늘진 책상과 그늘진 종이). 차이가 작으면 모두 종이
    const part = Float32Array.from(comp, p => g[p]), t2 = otsu(part);
    let a = 0, an = 0, b = 0, bn = 0; for (const v of part) if (v > t2) { a += v; an++; } else { b += v; bn++; }
    const split = an > comp.length * 0.1 && bn > comp.length * 0.1 && a / an > (b / bn) * 1.12;
    for (const p of comp) { bgm[p] = 0; mask[p] = split && g[p] <= t2 ? 0 : 1; }
    if (split) again.push(...comp);
  };
  const again: number[] = [];
  for (let x = 0; x < sw; x++) { grow(x); grow((sh - 1) * sw + x); }
  for (let y = 0; y < sh; y++) { grow(y * sw); grow(y * sw + sw - 1); }
  // 다시 나눈 곳: 가장자리에서 이어진 어두운 부분만 바깥으로 (한 번만, 그늘 검사 없이)
  if (again.length) {
    const inA = new Uint8Array(sw * sh); for (const p of again) inA[p] = 1;
    const seed = (p: number) => { if (inA[p] && !mask[p] && !bgm[p]) { bgm[p] = 1; stack.push(p); } };
    for (let x = 0; x < sw; x++) { seed(x); seed((sh - 1) * sw + x); }
    for (let y = 0; y < sh; y++) { seed(y * sw); seed(y * sw + sw - 1); }
    while (stack.length) {
      const p = stack.pop()!, x = p % sw, y = (p / sw) | 0;
      if (x > 0) seed(p - 1); if (x < sw - 1) seed(p + 1); if (y > 0) seed(p - sw); if (y < sh - 1) seed(p + sw);
    }
  }
  let bgN = 0; for (let i = 0; i < bgm.length; i++) bgN += bgm[i];
  if (bgN < sw * sh * 0.03) return full; // 종이가 그림을 거의 다 채움 (이미 잘린 스캔)
  // 종이 영역에서 가장 큰 덩어리 (잡티 빼기)
  const lab = new Int32Array(sw * sh); let best = 0, bestN = 0, id = 0;
  for (let i = 0; i < bgm.length; i++) {
    if (bgm[i] || lab[i]) continue;
    id++; let n = 0; stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop()!; n++;
      const x = p % sw, y = (p / sw) | 0;
      if (x > 0 && !bgm[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < sw - 1 && !bgm[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && !bgm[p - sw] && !lab[p - sw]) { lab[p - sw] = id; stack.push(p - sw); }
      if (y < sh - 1 && !bgm[p + sw] && !lab[p + sw]) { lab[p + sw] = id; stack.push(p + sw); }
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

/** 종이 바탕의 밝기가 고르지 않은가 (그늘진 사진). 이미 깨끗하게 스캔한 페이지는 false */
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
export function enhance(c: HTMLCanvasElement, mode: Mode, clean = true) {
  if (mode === 'none') return c;
  const W = c.width, H = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
  // 바탕 밝기: 작게 줄여서 크게 흐린 뒤 다시 키워 쓴다 (글자는 사라지고 조명만 남음)
  const f = Math.max(1, Math.round(Math.max(W, H) / 320));
  const sw = Math.ceil(W / f), sh = Math.ceil(H / f);
  const small = new Float32Array(sw * sh), sR = new Float32Array(sw * sh), sG = new Float32Array(sw * sh), sB = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    // 칸 안에서 가장 밝은 점(종이)을 쓴다. 그 점의 색은 그 자리 종이 색
    let m = 0, mj = 0;
    for (let yy = y * f; yy < Math.min(H, y * f + f); yy += Math.max(1, f >> 1)) for (let xx = x * f; xx < Math.min(W, x * f + f); xx += Math.max(1, f >> 1)) { const j = (yy * W + xx) * 4; const v = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114; if (v > m) { m = v; mj = j; } }
    const c = y * sw + x; small[c] = m; sR[c] = d[mj]; sG[c] = d[mj + 1]; sB[c] = d[mj + 2];
  }
  const blur2 = (a: Float32Array) => boxBlur(boxBlur(a, sw, sh, 6), sw, sh, 6);
  const bg = blur2(small), bR = blur2(sR), bG = blur2(sG), bB = blur2(sB);
  const lerp = (a: Float32Array, x: number, y: number) => {
    const fx = Math.min(sw - 1.001, Math.max(0, x / f - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, y / f - 0.5));
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    return (a[y0 * sw + x0] * (1 - ax) + a[y0 * sw + x0 + 1] * ax) * (1 - ay) + (a[(y0 + 1) * sw + x0] * (1 - ax) + a[(y0 + 1) * sw + x0 + 1] * ax) * ay;
  };
  const bgAt = (x: number, y: number) => Math.max(30, lerp(bg, x, y));
  const out = new Float32Array(n);
  // 워터마크: 바탕보다 조금 어둡고 색이 살짝 도는(분홍·회분홍) 밝은 점은 바탕으로 본다.
  // 색은 그 자리 종이 색과 견준다 (사진은 곳마다 종이가 푸르거나 누렇다). 글자(검정)는 색이 없고,
  // 파란 펜은 파란 쪽이라서, 도장·서명은 더 어둡거나 색이 진해서 남는다
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = i * 4, b = bgAt(x, y);
    let v = Math.min(255, (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) / b * 255);
    if (clean && v > 170 && v < 238) {
      const r = d[j] / Math.max(30, lerp(bR, x, y)), g = d[j + 1] / Math.max(30, lerp(bG, x, y)), bl = d[j + 2] / Math.max(30, lerp(bB, x, y));
      const chroma = (Math.max(r, g, bl) - Math.min(r, g, bl)) * 255;
      if (chroma > 9 && chroma < 55 && r >= bl) v = 255;
    }
    out[i] = v;
    if (mode === 'color') { const k = 255 / b; d[j] = Math.min(255, d[j] * k); d[j + 1] = Math.min(255, d[j + 1] * k); d[j + 2] = Math.min(255, d[j + 2] * k); if (v === 255) { d[j] = d[j + 1] = d[j + 2] = 255; } }
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
  // 대비: 어두운 페이지 1%를 검정으로, 바탕을 흰색으로
  const hist = new Uint32Array(256); for (const v of out) hist[v | 0]++;
  let lo = 0, acc = 0; while (lo < 150 && (acc += hist[lo]) < n * 0.01) lo++;
  // 흐린 무늬 지우기(clean): 바탕 쪽 문턱을 낮춰 옅은 회색·분홍 워터마크가 흰 바탕이 되게, 글자는 더 진하게
  // 바탕으로 칠할 문턱: 글자가 얼마나 진한지(lo)에 맞춘다. 진한 글자 문서는 옅은 무늬를 더 많이 지운다
  // 글자가 옅은 사진(lo가 높음)은 옅은 글자까지 지워지지 않게 문턱을 종이 밝기 가까이로 올린다
  let med = 0; acc = 0; while (med < 255 && (acc += hist[med]) < n * 0.5) med++;
  const base = Math.max(172, Math.min(212, lo + (255 - lo) * 0.62)), weak = Math.max(0, Math.min(1, (lo - 80) / 50));
  const hi = clean ? base * (1 - weak) + Math.max(base, med - 18) * weak : 236, span = Math.max(30, hi - lo), gam = clean ? 1.3 : 1.15;
  const curve = (v: number) => { const t = Math.max(0, Math.min(1, (v - lo) / span)); return 255 * Math.pow(t, gam); };
  // 글자 또렷하게 (언샤프 마스크)
  if (mode !== 'bw') { const bl = boxBlur(out, W, H, 1); for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, out[i] + (out[i] - bl[i]) * 0.7)); }
  if (mode === 'bw') {
    // 문턱값을 조금 낮춰 옅은 바탕무늬(워터마크)는 흰색으로, 남은 점은 지운다
    // 대비를 먼저 늘린 뒤에 나눈다 (옅은 글자 사진도 글자가 남게)
    for (let i = 0; i < n; i++) out[i] = curve(out[i]);
    const th = Math.min(200, Math.max(105, otsu(out) - 6));
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

export interface ScanOpts { quad?: Quad | null; mode: Mode; deskew?: boolean; turn?: number; clean?: boolean; mark?: boolean }
/** 한 장 보정: 원근 → 90° 회전 → 기울기 → 조명·대비 → 스캔 앱 표시 지우기 */
export function process(src: HTMLCanvasElement, o: ScanOpts) {
  let c = o.quad && !isFull(o.quad, src.width, src.height) ? warp(src, o.quad) : src;
  if (o.turn) c = rotate(c, o.turn);
  if (o.deskew) { const a = detectSkew(c); if (Math.abs(a) >= 0.5) c = rotate(c, -a); }
  c = enhance(c === src ? copy(src) : c, o.mode, o.clean !== false);
  if (o.mark !== false) removeScanMark(c);
  return c;
}

/**
 * 스캔 앱이 아래쪽 구석에 찍는 표시("CamScanner로 스캔하기" 등) 지우기.
 * 아래 7% 띠의 오른쪽(또는 왼쪽) 구석에, 다른 내용과 떨어진 작은 글자 덩어리가 있으면 바탕색으로 덮는다.
 */
export function removeScanMark(c: HTMLCanvasElement) {
  const W = c.width, H = c.height, g = c.getContext('2d', { willReadFrequently: true })!;
  const y0 = Math.floor(H * 0.93), bh = H - y0;
  const d = g.getImageData(0, y0, W, bh).data;
  const dark = (x: number, y: number) => { const j = (y * W + x) * 4; return d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114 < 150; };
  // 열마다 어두운 점이 있는지 → 왼쪽부터 덩어리(글자 묶음) 나누기
  const col = new Uint8Array(W);
  for (let x = 0; x < W; x++) for (let y = 0; y < bh; y += 1) if (dark(x, y)) { col[x] = 1; break; }
  const gapMin = Math.round(W * 0.03);
  const blobs: [number, number][] = []; let st = -1, last = -1;
  for (let x = 0; x < W; x++) { if (col[x]) { if (st < 0) st = x; else if (x - last > gapMin) { blobs.push([st, last]); st = x; } last = x; } }
  if (st >= 0) blobs.push([st, last]);
  let changed = false;
  for (const [a, b] of blobs) {
    // 오른쪽 아래 구석만 (왼쪽 아래는 진짜 꼬리말일 때가 많아 건드리지 않는다)
    if (!(b > W * 0.88 && a > W * 0.55)) continue;
    // 덩어리의 위아래
    let top = bh, bot = -1;
    for (let y = 0; y < bh; y++) for (let x = a; x <= b; x++) if (dark(x, y)) { if (y < top) top = y; if (y > bot) bot = y; break; }
    if (bot < 0 || bot - top > H * 0.03) continue; // 한 줄 높이의 작은 글자만
    // 바탕색: 덩어리 둘레의 밝은 점 평균
    let r = 0, gg = 0, bb = 0, cnt = 0;
    for (let y = Math.max(0, top - 6); y <= Math.min(bh - 1, bot + 6); y += 2) for (const x of [Math.max(0, a - 8), Math.min(W - 1, b + 8)]) { const j = (y * W + x) * 4; r += d[j]; gg += d[j + 1]; bb += d[j + 2]; cnt++; }
    g.fillStyle = cnt ? `rgb(${r / cnt | 0},${gg / cnt | 0},${bb / cnt | 0})` : '#fff';
    g.fillRect(a - 6, y0 + top - 6, b - a + 12, bot - top + 12);
    changed = true;
  }
  return changed;
}

/** 글줄이 세로로 서 있는가 (90°·270° 돌아간 페이지): true/false, 애매하면 null. 표 선 같은 긴 줄은 빼고 글자만 본다 */
export function looksSideways(c: HTMLCanvasElement): boolean | null {
  const k = 700 / Math.max(c.width, c.height), w = Math.max(8, Math.round(c.width * k)), h = Math.max(8, Math.round(c.height * k));
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0, w, h);
  const gray = grayOf(g.getImageData(0, 0, w, h).data, w * h), bg = boxBlur(gray, w, h, 12);
  const m = new Uint8Array(w * h); for (let i = 0; i < m.length; i++) m[i] = gray[i] < bg[i] * 0.8 ? 1 : 0;
  // 긴 가로줄·세로줄(표 선) 지우기
  const lim = Math.round(Math.min(w, h) * 0.06);
  for (let y = 0; y < h; y++) { let st = -1; for (let x = 0; x <= w; x++) { const on = x < w && m[y * w + x]; if (on && st < 0) st = x; if (!on && st >= 0) { if (x - st > lim) for (let i = st; i < x; i++) m[y * w + i] = 2; st = -1; } } }
  for (let x = 0; x < w; x++) { let st = -1; for (let y = 0; y <= h; y++) { const on = y < h && m[y * w + x] === 1; if (on && st < 0) st = y; if (!on && st >= 0) { if (y - st > lim) for (let i = st; i < y; i++) m[i * w + x] = 2; st = -1; } } }
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x] === 1) { rows[y]++; cols[x]++; }
  const sharp = (a: Float64Array) => { let v = 0; for (let i = 1; i < a.length; i++) v += (a[i] - a[i - 1]) ** 2; return v / a.length; };
  const r = sharp(cols) / Math.max(1e-6, sharp(rows));
  return r > 1.8 ? true : r < 0.6 ? false : null;
}
const copy = (c: HTMLCanvasElement) => { const r = document.createElement('canvas'); r.width = c.width; r.height = c.height; r.getContext('2d')!.drawImage(c, 0, 0); return r; };
export async function toBlob(c: HTMLCanvasElement, mode: Mode): Promise<Blob> {
  return new Promise(res => c.toBlob(b => res(b!), mode === 'bw' ? 'image/png' : 'image/jpeg', 0.88));
}
