/**
 * 아주 작은 TrueType 해석기: 글자 → 윤곽선(벡터 경로)과 폭.
 * 입력란 모양(appearance)을 글꼴 없이 경로로 그릴 때 쓴다 → 어떤 PDF 프로그램에서도 한글이 보인다.
 */
export interface Glyph { adv: number; path: string } // path: 글꼴 단위, y는 위가 +, "x y m"/"x y l"/"x1 y1 x2 y2 x y c"/"h"
export class TTF {
  private v: DataView; private tables = new Map<string, number>();
  unitsPerEm = 1000; ascent = 800; descent = -200;
  private locaLong = false; private nGlyphs = 0; private nHM = 0;
  private cmap12 = 0; private cmap4 = 0;
  private cache = new Map<number, Glyph>();
  constructor(bytes: Uint8Array) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = this.v.getUint16(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(...[0, 1, 2, 3].map(k => this.v.getUint8(o + k)));
      this.tables.set(tag, this.v.getUint32(o + 8));
    }
    const head = this.t('head'); this.unitsPerEm = this.v.getUint16(head + 18); this.locaLong = this.v.getInt16(head + 50) === 1;
    this.nGlyphs = this.v.getUint16(this.t('maxp') + 4);
    const hhea = this.t('hhea'); this.ascent = this.v.getInt16(hhea + 4); this.descent = this.v.getInt16(hhea + 6); this.nHM = this.v.getUint16(hhea + 34);
    const cm = this.t('cmap'), nt = this.v.getUint16(cm + 2);
    for (let i = 0; i < nt; i++) {
      const pid = this.v.getUint16(cm + 4 + i * 8), eid = this.v.getUint16(cm + 6 + i * 8), off = cm + this.v.getUint32(cm + 8 + i * 8);
      const fmt = this.v.getUint16(off);
      if (fmt === 12 && (pid === 3 || pid === 0)) this.cmap12 = off;
      if (fmt === 4 && (pid === 3 && eid === 1 || pid === 0)) this.cmap4 = off;
    }
  }
  private t(tag: string) { const o = this.tables.get(tag); if (o === undefined) throw new Error('글꼴에 ' + tag + ' 표가 없습니다'); return o; }
  gid(cp: number): number {
    const v = this.v;
    if (this.cmap12) {
      const n = v.getUint32(this.cmap12 + 12);
      let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, o = this.cmap12 + 16 + m * 12;
        const s = v.getUint32(o), e = v.getUint32(o + 4);
        if (cp < s) hi = m - 1; else if (cp > e) lo = m + 1; else return v.getUint32(o + 8) + cp - s;
      }
      return 0;
    }
    if (!this.cmap4 || cp > 0xffff) return 0;
    const o = this.cmap4, seg = v.getUint16(o + 6) / 2;
    const ends = o + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
    for (let i = 0; i < seg; i++) {
      if (cp > v.getUint16(ends + i * 2)) continue;
      const s = v.getUint16(starts + i * 2); if (cp < s) return 0;
      const d = v.getInt16(deltas + i * 2), r = v.getUint16(ranges + i * 2);
      if (!r) return (cp + d) & 0xffff;
      const g = v.getUint16(ranges + i * 2 + r + (cp - s) * 2);
      return g ? (g + d) & 0xffff : 0;
    }
    return 0;
  }
  private adv(g: number) { const h = this.t('hmtx'); return this.v.getUint16(h + Math.min(g, this.nHM - 1) * 4); }
  private glyfOff(g: number): [number, number] {
    const loca = this.t('loca'), glyf = this.t('glyf');
    const a = this.locaLong ? this.v.getUint32(loca + g * 4) : this.v.getUint16(loca + g * 2) * 2;
    const b = this.locaLong ? this.v.getUint32(loca + g * 4 + 4) : this.v.getUint16(loca + g * 2 + 2) * 2;
    return [glyf + a, b - a];
  }
  /** 윤곽선 점들(복합 글리프 포함) */
  private contours(g: number, m = [1, 0, 0, 1, 0, 0], depth = 0): { x: number; y: number; on: boolean }[][] {
    if (g >= this.nGlyphs || depth > 6) return [];
    const [o, len] = this.glyfOff(g); if (!len) return [];
    const v = this.v, nc = v.getInt16(o);
    const tf = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    if (nc < 0) { // 복합
      const out: { x: number; y: number; on: boolean }[][] = [];
      let p = o + 10, more = true;
      while (more) {
        const flags = v.getUint16(p), gi = v.getUint16(p + 2); p += 4;
        let dx = 0, dy = 0;
        if (flags & 1) { dx = v.getInt16(p); dy = v.getInt16(p + 2); p += 4; } else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
        let a = 1, b = 0, c = 0, d = 1;
        const f2 = (q: number) => v.getInt16(q) / 16384;
        if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
        const sub = [a, b, c, d, dx, dy];
        const comb = [sub[0] * m[0] + sub[1] * m[2], sub[0] * m[1] + sub[1] * m[3], sub[2] * m[0] + sub[3] * m[2], sub[2] * m[1] + sub[3] * m[3], sub[4] * m[0] + sub[5] * m[2] + m[4], sub[4] * m[1] + sub[5] * m[3] + m[5]];
        out.push(...this.contours(gi, comb, depth + 1));
        more = !!(flags & 0x20);
      }
      return out;
    }
    const endPts: number[] = []; for (let i = 0; i < nc; i++) endPts.push(v.getUint16(o + 10 + i * 2));
    const n = nc ? endPts[nc - 1] + 1 : 0;
    let p = o + 10 + nc * 2; p += 2 + v.getUint16(p);
    const flags: number[] = [];
    while (flags.length < n) { const f = v.getUint8(p++); flags.push(f); if (f & 8) { let r = v.getUint8(p++); while (r--) flags.push(f); } }
    const xs: number[] = [], ys: number[] = [];
    let x = 0; for (const f of flags) { if (f & 2) { const d = v.getUint8(p++); x += f & 16 ? d : -d; } else if (!(f & 16)) { x += v.getInt16(p); p += 2; } xs.push(x); }
    let y = 0; for (const f of flags) { if (f & 4) { const d = v.getUint8(p++); y += f & 32 ? d : -d; } else if (!(f & 32)) { y += v.getInt16(p); p += 2; } ys.push(y); }
    const out: { x: number; y: number; on: boolean }[][] = [];
    let s = 0;
    for (const e of endPts) { const c: { x: number; y: number; on: boolean }[] = []; for (let i = s; i <= e; i++) c.push({ ...tf(xs[i], ys[i]), on: !!(flags[i] & 1) }); out.push(c); s = e + 1; }
    return out;
  }
  glyph(cp: number): Glyph {
    const hit = this.cache.get(cp); if (hit) return hit;
    const g = this.gid(cp);
    let path = '';
    const r = (n: number) => Math.round(n * 10) / 10;
    for (const c of this.contours(g)) {
      if (c.length < 2) continue;
      // 시작점: 첫 on 점, 없으면 첫 두 off 점의 중점
      let start = c.findIndex(q => q.on);
      const pts = start >= 0 ? [...c.slice(start), ...c.slice(0, start)] : c;
      let first = start >= 0 ? pts[0] : { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, on: true };
      path += `${r(first.x)} ${r(first.y)} m `;
      let prev = first, ctrl: { x: number; y: number } | null = null;
      const seq = start >= 0 ? [...pts.slice(1), pts[0]] : [...pts, first];
      for (const q of seq) {
        if (q.on) {
          if (ctrl) { path += quad(prev, ctrl, q); ctrl = null; } else path += `${r(q.x)} ${r(q.y)} l `;
          prev = q;
        } else {
          if (ctrl) { const mid = { x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2, on: true }; path += quad(prev, ctrl, mid); prev = mid; }
          ctrl = q;
        }
      }
      if (ctrl) path += quad(prev, ctrl, first);
      path += 'h ';
    }
    function quad(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }) {
      const c1 = { x: p0.x + (p1.x - p0.x) * 2 / 3, y: p0.y + (p1.y - p0.y) * 2 / 3 }, c2 = { x: p2.x + (p1.x - p2.x) * 2 / 3, y: p2.y + (p1.y - p2.y) * 2 / 3 };
      return `${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(p2.x)} ${r(p2.y)} c `;
    }
    const out = { adv: this.adv(g), path };
    this.cache.set(cp, out);
    return out;
  }
  /** 글자들을 PDF 경로 연산자로 (x,y: 기준선 시작점, 쪽 좌표) */
  pdfPath(text: string, size: number, x: number, y: number) {
    const k = size / this.unitsPerEm, r = (n: number) => (Math.round(n * 100) / 100).toString();
    let out = '', cx = x;
    for (const ch of text) {
      const g = this.glyph(ch.codePointAt(0)!);
      const nums: number[] = [];
      for (const tok of g.path.split(' ')) {
        if (!tok) continue;
        if (tok === 'm' || tok === 'l' || tok === 'c') {
          for (let i = 0; i < nums.length; i += 2) out += r(cx + nums[i] * k) + ' ' + r(y + nums[i + 1] * k) + ' ';
          out += tok + '\n'; nums.length = 0;
        } else if (tok === 'h') out += 'h\n';
        else nums.push(parseFloat(tok));
      }
      cx += g.adv * k;
    }
    return out;
  }
  width(text: string, size: number) { let w = 0; for (const ch of text) w += this.glyph(ch.codePointAt(0)!).adv; return w * size / this.unitsPerEm; }
}
