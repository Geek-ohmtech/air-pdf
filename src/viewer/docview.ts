/**
 * 문서 화면: 보이는 쪽만 DOM으로 만들고(가상 목록), 보이는 쪽부터 렌더링한다.
 * 확대가 크면 쪽 전체는 낮은 해상도로, 화면에 보이는 부분만 높은 해상도로 따로 그린다.
 */
import type { EngineClient } from '../engine/client.ts';
import type { LinkInfo, PageSize, Rect, SearchHit, TextData } from '../engine/types.ts';
import { h } from '../ui/dom.ts';

export interface PageEl {
  index: number; key: number;
  root: HTMLDivElement; base: HTMLCanvasElement; detail: HTMLCanvasElement;
  sel: HTMLDivElement; hits: HTMLDivElement; links: HTMLDivElement; edit: HTMLDivElement; forms: HTMLDivElement;
  baseKey: string; detailKey: string; version: number;
}
interface Slot { left: number; top: number; w: number; h: number }
interface Job { index: number; key: number; kind: 'base' | 'detail' | 'thumb'; scale: number; region?: Rect; version: number; cb?: (b: ImageBitmap | null) => void; tag: string }
export interface SelPoint { page: number; idx: number }
export interface Interaction {
  pointerdown?(e: PointerEvent, page: number, x: number, y: number): boolean;
  pointermove?(e: PointerEvent, page: number, x: number, y: number): void;
  pointerup?(e: PointerEvent, page: number, x: number, y: number): void;
  dblclick?(e: MouseEvent, page: number, x: number, y: number): boolean;
  hover?(e: PointerEvent, page: number, x: number, y: number): void;
  cursor?: string;
}

const GAP = 14, PAD = 20, MAX_PX = 4096 * 4096, MAX_SIDE = 8192;
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

export class DocView {
  el: HTMLDivElement; inner: HTMLDivElement;
  engine: EngineClient; docId = 0;
  pages: PageSize[] = [];
  slots: Slot[] = [];
  zoom = 1; fit: 'width' | 'page' | null = 'width';
  spread = false; night = false;
  live = new Map<number, PageEl>();
  current = 0;
  version = new Map<number, number>();
  private text = new Map<number, TextData | Promise<TextData>>();
  private linkC = new Map<number, LinkInfo[]>();
  private bmpCache = new Map<string, ImageBitmap>();
  private queue: Job[] = [];
  private busy = false;
  private hits = new Map<number, SearchHit[]>(); private curHit: SearchHit | null = null;
  sel: { a: SelPoint; b: SelPoint } | null = null;
  interaction: Interaction | null = null;
  decorate: ((pe: PageEl) => void) | null = null;
  onPageEl: ((pe: PageEl) => void)[] = [];
  onPage: (i: number) => void = () => {};
  onZoom: (z: number) => void = () => {};
  onLink: (l: LinkInfo) => void = () => {};
  onSelect: () => void = () => {};
  onContext: (e: MouseEvent, page: number, x: number, y: number) => void = () => {};
  private zoomT = 0; private raf = 0;

  constructor(parent: HTMLElement, engine: EngineClient) {
    this.engine = engine;
    this.inner = h('div', { class: 'doc-inner' });
    this.el = h('div', { class: 'doc-view', tabindex: '0' }, this.inner);
    parent.append(this.el);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => { if (this.fit) this.applyFit(true); else this.layout(); }).observe(this.el);
    this.el.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.bindPointer();
  }

  /* ───────────── 문서와 배치 ───────────── */
  setDoc(docId: number, pages: PageSize[]) {
    this.docId = docId; this.pages = pages; this.clear(); this.sel = null; this.hits.clear(); this.curHit = null;
    this.text.clear(); this.linkC.clear(); this.bmpCache.forEach(b => b.close()); this.bmpCache.clear();
    this.applyFit(false);
    this.el.scrollTop = 0;
  }
  setPages(pages: PageSize[]) { this.pages = pages; this.clear(); this.layout(); }
  private clear() { for (const pe of this.live.values()) pe.root.remove(); this.live.clear(); this.queue = []; }
  layout() {
    const z = this.zoom, vw = this.el.clientWidth;
    const slots: Slot[] = [];
    let y = PAD, maxW = 0;
    if (!this.spread) {
      for (const p of this.pages) { slots.push({ left: 0, top: y, w: p.w * z, h: p.h * z }); y += p.h * z + GAP; maxW = Math.max(maxW, p.w * z); }
      const cw = Math.max(vw, maxW + PAD * 2);
      for (const s of slots) s.left = (cw - s.w) / 2;
      this.inner.style.width = cw + 'px';
    } else {
      for (let i = 0; i < this.pages.length; i += 2) {
        const a = this.pages[i], b = this.pages[i + 1];
        const rowH = Math.max(a.h, b ? b.h : 0) * z, rowW = (a.w + (b ? b.w : a.w)) * z + GAP;
        maxW = Math.max(maxW, rowW);
        slots.push({ left: 0, top: y + (rowH - a.h * z) / 2, w: a.w * z, h: a.h * z });
        if (b) slots.push({ left: 0, top: y + (rowH - b.h * z) / 2, w: b.w * z, h: b.h * z });
        y += rowH + GAP;
      }
      const cw = Math.max(vw, maxW + PAD * 2);
      for (let i = 0; i < slots.length; i += 2) {
        const a = slots[i], b = slots[i + 1];
        const row = a.w + GAP + (b ? b.w : a.w), x0 = (cw - row) / 2;
        a.left = x0; if (b) b.left = x0 + a.w + GAP;
      }
      this.inner.style.width = cw + 'px';
    }
    this.slots = slots;
    this.inner.style.height = y + PAD + 'px';
    for (const [i, pe] of this.live) this.place(pe, i);
    this.schedule();
  }
  private place(pe: PageEl, i: number) {
    const s = this.slots[i]; if (!s) return;
    Object.assign(pe.root.style, { left: s.left + 'px', top: s.top + 'px', width: s.w + 'px', height: s.h + 'px' });
  }
  applyFit(keep: boolean) {
    if (!this.pages.length) return;
    const cur = this.pages[this.current] || this.pages[0];
    const vw = this.el.clientWidth - PAD * 2, vh = this.el.clientHeight - PAD * 2;
    const pw = this.spread ? cur.w * 2 + GAP : cur.w;
    let z = this.zoom;
    if (this.fit === 'width') z = vw / Math.max(...this.pages.map(p => p.w * (this.spread ? 2 : 1))) * (this.spread ? 1 : 1);
    if (this.fit === 'page') z = Math.min(vw / pw, vh / cur.h);
    if (this.fit === 'width' && this.spread) z = (vw - GAP) / (Math.max(...this.pages.map(p => p.w)) * 2);
    this.setZoom(Math.max(0.1, Math.min(z, 8)), keep ? undefined : null, true);
  }
  /** 확대. anchor: 화면 안의 고정점(클라이언트 좌표). null이면 위로 */
  setZoom(z: number, anchor?: { x: number; y: number } | null, fromFit = false) {
    if (!fromFit) this.fit = null;
    z = Math.max(0.1, Math.min(z, 8));
    const r = this.el.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : this.el.clientWidth / 2, ay = anchor ? anchor.y - r.top : 0;
    const at = this.pointAt(this.el.scrollLeft + ax, this.el.scrollTop + ay);
    this.zoom = z;
    this.layout();
    if (at && anchor !== null) {
      const s = this.slots[at.page];
      this.el.scrollLeft = s.left + at.x * z - ax;
      this.el.scrollTop = s.top + at.y * z - ay;
    }
    for (const pe of this.live.values()) pe.detail.hidden = true;
    clearTimeout(this.zoomT);
    this.zoomT = window.setTimeout(() => this.schedule(), 90);
    this.onZoom(z);
  }
  /** 문서 좌표(스크롤 내부 px) → 쪽과 그 안의 pt 좌표 */
  pointAt(cx: number, cy: number): { page: number; x: number; y: number } | null {
    if (!this.slots.length) return null;
    let best = 0, bd = Infinity;
    const i0 = this.firstSlotAt(cy - 2000);
    for (let i = i0; i < this.slots.length; i++) {
      const s = this.slots[i]; if (s.top > cy + 2000) break;
      const dx = cx < s.left ? s.left - cx : cx > s.left + s.w ? cx - s.left - s.w : 0;
      const dy = cy < s.top ? s.top - cy : cy > s.top + s.h ? cy - s.top - s.h : 0;
      const d = dx + dy; if (d < bd) { bd = d; best = i; }
    }
    const s = this.slots[best];
    return { page: best, x: (cx - s.left) / this.zoom, y: (cy - s.top) / this.zoom };
  }
  private firstSlotAt(y: number) {
    let lo = 0, hi = this.slots.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.slots[m].top + this.slots[m].h < y) lo = m + 1; else hi = m; }
    return Math.max(0, lo - 1);
  }
  scrollToPage(i: number, top?: number, smooth = false) {
    const s = this.slots[i]; if (!s) return;
    const y = s.top + (top !== undefined ? top * this.zoom - 40 : -PAD / 2);
    this.el.scrollTo({ top: Math.max(0, y), left: this.el.scrollLeft, behavior: smooth ? 'smooth' : 'auto' });
    this.current = i; this.onPage(i);
  }
  scrollToRect(i: number, r: Rect) {
    const s = this.slots[i]; if (!s) return;
    const y = s.top + r.y * this.zoom, x = s.left + r.x * this.zoom;
    if (y < this.el.scrollTop + 40 || y + r.h * this.zoom > this.el.scrollTop + this.el.clientHeight - 40) this.el.scrollTop = y - this.el.clientHeight / 3;
    if (x < this.el.scrollLeft || x + r.w * this.zoom > this.el.scrollLeft + this.el.clientWidth) this.el.scrollLeft = x - 40;
  }

  /* ───────────── 보이는 쪽 관리와 렌더링 ───────────── */
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); }); }
  private update() {
    if (!this.slots.length) return;
    const top = this.el.scrollTop, bottom = top + this.el.clientHeight, buf = this.el.clientHeight;
    const want = new Set<number>();
    for (let i = this.firstSlotAt(top - buf); i < this.slots.length; i++) {
      const s = this.slots[i]; if (s.top > bottom + buf) break;
      if (s.top + s.h >= top - buf) want.add(i);
    }
    for (const [i, pe] of this.live) if (!want.has(i)) { pe.root.remove(); this.live.delete(i); }
    for (const i of want) if (!this.live.has(i)) this.createPage(i);
    // 현재 쪽 = 화면 중앙을 지나는 쪽
    const mid = top + this.el.clientHeight * 0.4;
    let cur = this.current;
    for (const i of want) { const s = this.slots[i]; if (s.top <= mid && s.top + s.h + GAP >= mid) { cur = i; break; } }
    if (top < 4) cur = 0;
    if (bottom >= this.el.scrollHeight - 4 && !this.spread) cur = this.pages.length - 1;
    if (cur !== this.current) { this.current = cur; this.onPage(cur); }
    this.enqueueVisible();
  }
  private createPage(i: number) {
    const key = this.pages[i].key;
    const pe: PageEl = {
      index: i, key,
      root: h('div', { class: 'page' + (this.night ? ' night' : ''), dataset: { i: String(i) } }),
      base: h('canvas', { class: 'pg-base' }), detail: h('canvas', { class: 'pg-detail', hidden: true }),
      sel: h('div', { class: 'pg-sel' }), hits: h('div', { class: 'pg-hits' }), links: h('div', { class: 'pg-links' }), edit: h('div', { class: 'pg-edit' }), forms: h('div', { class: 'pg-forms' }),
      baseKey: '', detailKey: '', version: this.ver(key),
    };
    pe.root.append(pe.base, pe.detail, pe.hits, pe.sel, pe.links, pe.forms, pe.edit);
    this.place(pe, i);
    // 가지고 있는 그림으로 먼저 채움(흐려도 빈칸보다 낫다)
    const cached = [...this.bmpCache.entries()].reverse().find(([k]) => k.startsWith(`${key}:${pe.version}:`));
    if (cached) this.draw(pe.base, cached[1]);
    this.inner.append(pe.root);
    this.live.set(i, pe);
    this.drawHits(pe); this.drawSel(pe);
    if (!this.interaction) this.loadLinks(pe);
    for (const f of this.onPageEl) f(pe);
    this.decorate?.(pe);
  }
  private ver(key: number) { return this.version.get(key) || 0; }
  private baseScale(i: number) {
    const p = this.pages[i]; let s = this.zoom * dpr();
    const area = p.w * p.h * s * s;
    if (area > MAX_PX) s = Math.sqrt(MAX_PX / (p.w * p.h));
    s = Math.min(s, MAX_SIDE / Math.max(p.w, p.h));
    return s;
  }
  private enqueueVisible() {
    const top = this.el.scrollTop, vh = this.el.clientHeight;
    const center = top + vh / 2;
    const jobs: Job[] = [];
    for (const [i, pe] of this.live) {
      const s = this.slots[i];
      const visible = s.top < top + vh && s.top + s.h > top;
      const scale = this.baseScale(i);
      const bk = `${pe.key}:${pe.version}:${scale.toFixed(3)}`;
      if (pe.baseKey !== bk) jobs.push({ index: i, key: pe.key, kind: 'base', scale, version: pe.version, tag: bk });
      // 세밀 타일: 쪽 전체를 충분한 해상도로 못 그릴 때
      const need = this.zoom * dpr();
      if (visible && need > scale * 1.05) {
        const vx0 = Math.max(0, this.el.scrollLeft - s.left), vy0 = Math.max(0, top - s.top);
        const vx1 = Math.min(s.w, this.el.scrollLeft + this.el.clientWidth - s.left), vy1 = Math.min(s.h, top + vh - s.top);
        const m = 160;
        const region = { x: Math.max(0, vx0 - m) * dpr(), y: Math.max(0, vy0 - m) * dpr(), w: (Math.min(s.w, vx1 + m) - Math.max(0, vx0 - m)) * dpr(), h: (Math.min(s.h, vy1 + m) - Math.max(0, vy0 - m)) * dpr() };
        const dk = `${pe.key}:${pe.version}:${need.toFixed(3)}:${Math.round(region.x)}:${Math.round(region.y)}:${Math.round(region.w)}:${Math.round(region.h)}`;
        if (pe.detailKey !== dk) jobs.push({ index: i, key: pe.key, kind: 'detail', scale: need, region, version: pe.version, tag: dk });
      } else if (pe.detailKey) { pe.detail.hidden = true; pe.detailKey = ''; }
    }
    const pri = (j: Job) => { const s = this.slots[j.index]; const vis = s.top < top + vh && s.top + s.h > top; return (vis ? 0 : 1e6) + Math.abs(s.top + s.h / 2 - center) + (j.kind === 'detail' ? 500 : 0); };
    jobs.sort((a, b) => pri(a) - pri(b));
    const thumbs = this.queue.filter(j => j.kind === 'thumb');
    this.queue = [...jobs, ...thumbs];
    this.pump();
  }
  requestThumb(index: number, width: number, cb: (b: ImageBitmap | null) => void) {
    const p = this.pages[index]; if (!p) return;
    const scale = (width * dpr()) / p.w;
    this.queue.push({ index, key: p.key, kind: 'thumb', scale, version: this.ver(p.key), cb, tag: 'thumb' });
    this.pump();
  }
  cancelThumbs() { this.queue = this.queue.filter(j => j.kind !== 'thumb'); }
  private async pump() {
    if (this.busy) return;
    const job = this.queue.shift(); if (!job) return;
    this.busy = true;
    try {
      const idx = this.pages.findIndex(p => p.key === job.key);
      if (idx < 0 || this.ver(job.key) !== job.version) { job.cb?.(null); return; }
      const t0 = performance.now();
      const r: any = await this.engine.call('render', [this.docId, idx, job.scale, job.region]);
      (window as any).__lastRenderMs = performance.now() - t0;
      const bmp: ImageBitmap = r.bitmap || await createImageBitmap(new ImageData(r.data, r.width, r.height));
      if (job.kind === 'thumb') { job.cb?.(bmp); return; }
      const pe = [...this.live.values()].find(p => p.key === job.key);
      if (job.kind === 'base') {
        const ck = job.tag;
        this.bmpCache.set(ck, bmp);
        while (this.bmpCache.size > 14) { const [k, b] = this.bmpCache.entries().next().value!; b.close(); this.bmpCache.delete(k); }
        if (pe && pe.version === job.version) { this.draw(pe.base, bmp); pe.baseKey = job.tag; }
      } else if (pe && pe.version === job.version) {
        const d = dpr();
        pe.detail.width = bmp.width; pe.detail.height = bmp.height;
        pe.detail.getContext('2d')!.drawImage(bmp, 0, 0);
        Object.assign(pe.detail.style, { left: r.x / d + 'px', top: r.y / d + 'px', width: bmp.width / d + 'px', height: bmp.height / d + 'px' });
        pe.detail.hidden = false; pe.detailKey = job.tag;
        bmp.close();
      } else bmp.close();
    } catch (e) {
      console.warn('render', e); job.cb?.(null);
    } finally {
      this.busy = false;
      if (this.queue.length) setTimeout(() => this.pump(), 0);
    }
  }
  private draw(c: HTMLCanvasElement, b: ImageBitmap) {
    if (c.width !== b.width || c.height !== b.height) { c.width = b.width; c.height = b.height; }
    c.getContext('2d')!.drawImage(b, 0, 0);
  }
  /** 편집 뒤 다시 그리기 */
  invalidate(key: number) {
    this.version.set(key, this.ver(key) + 1);
    this.text.delete(key); this.linkC.delete(key);
    for (const pe of this.live.values()) if (pe.key === key) { pe.version = this.ver(key); pe.baseKey = ''; pe.detailKey = ''; pe.sel.innerHTML = ''; for (const f of this.onPageEl) f(pe); }
    this.schedule();
  }
  setNight(on: boolean) { this.night = on; for (const pe of this.live.values()) pe.root.classList.toggle('night', on); }
  setSpread(on: boolean) { this.spread = on; this.clear(); if (this.fit) this.applyFit(true); else this.layout(); }
  pageEl(i: number) { return this.live.get(i) || null; }

  /* ───────────── 확대(휠) ───────────── */
  private wheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022));
    this.setZoom(this.zoom * f, { x: e.clientX, y: e.clientY });
  }

  /* ───────────── 글자 선택 / 끌어서 넘기기 ───────────── */
  async getText(i: number): Promise<TextData> {
    const key = this.pages[i].key;
    let t = this.text.get(key);
    if (!t) { t = this.engine.call<TextData>('textData', [this.docId, i]); this.text.set(key, t); t.then(v => this.text.set(key, v)); }
    return t;
  }
  private textNow(i: number): TextData | null { const t = this.text.get(this.pages[i]?.key); return t && !(t instanceof Promise) ? t : null; }
  private charAt(td: TextData, x: number, y: number, strict: boolean): number {
    const b = td.boxes, n = td.text.length;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const x0 = b[i * 4], y0 = b[i * 4 + 1], x1 = b[i * 4 + 2], y1 = b[i * 4 + 3];
      if (x1 <= x0) continue;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return x > (x0 + x1) / 2 ? i + 1 : i;
      if (strict) continue;
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0, dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const d = dx + dy * 3;
      if (d < bd) { bd = d; best = x > (x0 + x1) / 2 ? i + 1 : i; }
    }
    if (strict) return -1;
    return best;
  }
  overText(i: number, x: number, y: number) {
    const td = this.textNow(i); if (!td) { this.getText(i); return false; }
    return this.charAt(td, x, y, true) >= 0;
  }
  /** 선택된 범위를 쪽마다 [시작, 끝) 으로 */
  private ranges(): { page: number; s: number; e: number }[] {
    if (!this.sel) return [];
    let { a, b } = this.sel;
    if (b.page < a.page || (b.page === a.page && b.idx < a.idx)) [a, b] = [b, a];
    const out: { page: number; s: number; e: number }[] = [];
    for (let p = a.page; p <= b.page; p++) {
      const td = this.textNow(p); if (!td) continue;
      const s = p === a.page ? a.idx : 0, e = p === b.page ? b.idx : td.text.length;
      if (e > s) out.push({ page: p, s, e });
    }
    return out;
  }
  rectsFor(td: TextData, s: number, e: number): Rect[] {
    const out: Rect[] = []; const b = td.boxes;
    let cur: Rect | null = null;
    for (let i = s; i < e; i++) {
      const x0 = b[i * 4], y0 = b[i * 4 + 1], x1 = b[i * 4 + 2], y1 = b[i * 4 + 3];
      if (x1 <= x0 || td.text[i] === '\n' || td.text[i] === '\r') continue;
      if (cur && Math.abs(y0 - cur.y) < (y1 - y0) * 0.5 && x0 <= cur.x + cur.w + (y1 - y0) * 1.2 && x0 >= cur.x - 1) {
        const r2 = Math.max(cur.x + cur.w, x1), b2 = Math.max(cur.y + cur.h, y1);
        cur.y = Math.min(cur.y, y0); cur.w = r2 - cur.x; cur.h = b2 - cur.y;
      } else { if (cur) out.push(cur); cur = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
    }
    if (cur) out.push(cur);
    return out;
  }
  selection(): { page: number; text: string; rects: Rect[] }[] {
    return this.ranges().map(r => { const td = this.textNow(r.page)!; return { page: r.page, text: td.text.slice(r.s, r.e), rects: this.rectsFor(td, r.s, r.e) }; });
  }
  selectedText() { return this.selection().map(s => s.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).join('\n').trim(); }
  clearSelection() { this.sel = null; for (const pe of this.live.values()) pe.sel.innerHTML = ''; this.onSelect(); }
  async selectAllOnPage(i: number) { const td = await this.getText(i); this.sel = { a: { page: i, idx: 0 }, b: { page: i, idx: td.text.length } }; this.redrawSel(); this.onSelect(); }
  private drawSel(pe: PageEl) {
    pe.sel.innerHTML = '';
    const r = this.ranges().find(x => x.page === pe.index); if (!r) return;
    const td = this.textNow(pe.index)!;
    for (const rc of this.rectsFor(td, r.s, r.e)) pe.sel.append(h('div', { class: 'sel-r', style: this.pct(pe.index, rc) }));
  }
  redrawSel() { for (const pe of this.live.values()) this.drawSel(pe); }

  private bindPointer() {
    let mode: 'select' | 'pan' | 'custom' | null = null;
    let panStart = { x: 0, y: 0, sl: 0, st: 0 };
    let clicks = 0, lastClick = 0;
    const locate = (e: { clientX: number; clientY: number }) => {
      const r = this.el.getBoundingClientRect();
      return this.pointAt(e.clientX - r.left + this.el.scrollLeft, e.clientY - r.top + this.el.scrollTop);
    };
    this.el.addEventListener('pointerdown', async e => {
      if (e.button !== 0 || !this.slots.length) return;
      const t = e.target as HTMLElement;
      if (t.closest('.pg-link, .no-view-pointer, .fld, textarea, input, button, select, [contenteditable]')) return;
      const at = locate(e); if (!at) return;
      const onPage = !!t.closest('.page');
      if (this.interaction?.pointerdown && onPage) {
        if (this.interaction.pointerdown(e, at.page, at.x, at.y)) { mode = 'custom'; this.el.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      }
      const now = performance.now();
      clicks = now - lastClick < 350 ? clicks + 1 : 1; lastClick = now;
      // 터치는 손가락으로 넘기는 것이 먼저다 (글자 선택은 마우스·펜)
      const td = onPage && e.pointerType !== 'touch' ? this.textNow(at.page) : null;
      if (!td && onPage) this.getText(at.page);
      const idx = td ? this.charAt(td, at.x, at.y, true) : -1;
      if (td && (idx >= 0 || e.shiftKey && this.sel)) {
        e.preventDefault();
        if (clicks >= 2 && idx >= 0) { this.selectUnit(at.page, td, idx, clicks >= 3 ? 'line' : 'word'); mode = null; return; }
        if (e.shiftKey && this.sel) this.sel.b = { page: at.page, idx: this.charAt(td, at.x, at.y, false) };
        else this.sel = { a: { page: at.page, idx }, b: { page: at.page, idx } };
        this.redrawSel();
        mode = 'select';
        this.el.setPointerCapture(e.pointerId);
      } else {
        if (this.sel) this.clearSelection();
        if (e.pointerType === 'mouse') {
          mode = 'pan'; panStart = { x: e.clientX, y: e.clientY, sl: this.el.scrollLeft, st: this.el.scrollTop };
          this.el.setPointerCapture(e.pointerId); this.el.classList.add('panning');
        }
      }
    });
    this.el.addEventListener('pointermove', e => {
      const at = locate(e);
      if (mode === 'custom' && at) { this.interaction?.pointermove?.(e, at.page, at.x, at.y); return; }
      if (mode === 'pan') { this.el.scrollLeft = panStart.sl - (e.clientX - panStart.x); this.el.scrollTop = panStart.st - (e.clientY - panStart.y); return; }
      if (mode === 'select' && at && this.sel) {
        const td = this.textNow(at.page);
        if (!td) { this.getText(at.page).then(() => this.redrawSel()); return; }
        this.sel.b = { page: at.page, idx: this.charAt(td, at.x, at.y, false) };
        this.redrawSel();
        const r = this.el.getBoundingClientRect();
        if (e.clientY > r.bottom - 30) this.el.scrollTop += 18; else if (e.clientY < r.top + 30) this.el.scrollTop -= 18;
        return;
      }
      if (!mode && at && e.buttons === 0) {
        const onPage = (e.target as HTMLElement).closest('.page');
        if (this.interaction) { this.interaction.hover?.(e, at.page, at.x, at.y); this.el.style.cursor = this.interaction.cursor || ''; }
        else this.el.style.cursor = onPage && this.overText(at.page, at.x, at.y) ? 'text' : '';
      }
    });
    const end = (e: PointerEvent) => {
      const at = locate(e);
      if (mode === 'custom' && at) this.interaction?.pointerup?.(e, at.page, at.x, at.y);
      if (mode === 'select') { if (this.sel && this.sel.a.page === this.sel.b.page && this.sel.a.idx === this.sel.b.idx) this.clearSelection(); else this.onSelect(); }
      this.el.classList.remove('panning');
      mode = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('dblclick', e => {
      const at = locate(e); if (!at || !this.interaction?.dblclick) return;
      if (this.interaction.dblclick(e, at.page, at.x, at.y)) e.preventDefault();
    });
    this.el.addEventListener('contextmenu', e => {
      const at = locate(e); if (!at || !(e.target as HTMLElement).closest('.page')) return;
      e.preventDefault(); this.onContext(e, at.page, at.x, at.y);
    });
  }
  private selectUnit(page: number, td: TextData, idx: number, unit: 'word' | 'line') {
    const t = td.text;
    let s = Math.min(idx, t.length - 1), e = s;
    if (unit === 'word') {
      const isW = (c: string) => /[\p{L}\p{N}_]/u.test(c);
      if (!isW(t[s]) && s > 0 && isW(t[s - 1])) s--;
      e = s; while (s > 0 && isW(t[s - 1])) s--; while (e < t.length && isW(t[e])) e++;
      if (e === s) e = s + 1;
    } else {
      while (s > 0 && t[s - 1] !== '\n') s--; while (e < t.length && t[e] !== '\r' && t[e] !== '\n') e++;
    }
    this.sel = { a: { page, idx: s }, b: { page, idx: e } };
    this.redrawSel(); this.onSelect();
  }

  /* ───────────── 링크 / 검색 표시 ───────────── */
  private async loadLinks(pe: PageEl) {
    let links = this.linkC.get(pe.key);
    if (!links) { try { links = await this.engine.call<LinkInfo[]>('links', [this.docId, pe.index]); } catch { links = []; } this.linkC.set(pe.key, links); }
    if (this.interaction || !this.live.has(pe.index)) return;
    pe.links.innerHTML = '';
    for (const l of links) {
      const a = h('a', { class: 'pg-link', href: l.uri || '#', title: l.uri || `${(l.page ?? 0) + 1}쪽으로 이동`, style: this.pct(pe.index, l.rect) });
      a.addEventListener('click', ev => { ev.preventDefault(); this.onLink(l); });
      pe.links.append(a);
    }
  }
  refreshLinks() { for (const pe of this.live.values()) { pe.links.innerHTML = ''; if (!this.interaction) this.loadLinks(pe); } }
  setHits(byPage: Map<number, SearchHit[]>, current: SearchHit | null) {
    this.hits = byPage; this.curHit = current;
    for (const pe of this.live.values()) this.drawHits(pe);
  }
  private drawHits(pe: PageEl) {
    pe.hits.innerHTML = '';
    const list = this.hits.get(pe.index); if (!list) return;
    for (const hit of list) for (const r of hit.rects)
      pe.hits.append(h('div', { class: 'hit-r' + (hit === this.curHit ? ' cur' : ''), style: this.pct(pe.index, { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }) }));
  }
  /** 쪽 크기에 대한 백분율 위치 → 확대해도 다시 그릴 필요가 없다 */
  pct(i: number, r: Rect) {
    const p = this.pages[i];
    return { left: r.x / p.w * 100 + '%', top: r.y / p.h * 100 + '%', width: r.w / p.w * 100 + '%', height: r.h / p.h * 100 + '%' };
  }
  /** 확대 후 위치 기반 층을 다시 그린다 */
  redrawLayers() { for (const pe of this.live.values()) { this.drawHits(pe); this.drawSel(pe); } this.refreshLinks(); }
}
