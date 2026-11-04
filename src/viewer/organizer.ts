/**
 * 페이지 구성 보기: 문서의 페이지만 크게 늘어놓고 순서 바꾸기·삭제·삽입·회전·추출을 한다.
 * 고른 페이지는 쪽 목록(sidebar.selected)과 같은 것을 써서, 편집기의 페이지 작업이 그대로 동작한다.
 */
import type { App } from '../app.ts';
import { h, icon, menu, toast } from '../ui/dom.ts';

const SIZE_KEY = 'airpdf.orgSize';

export class Organizer {
  app: App;
  el: HTMLElement;
  private grid: HTMLElement;
  private info: HTMLElement;
  private size = 170;
  private anchor = -1;
  private done = new Map<number, number>();
  private obs: IntersectionObserver;
  isOpen = false;

  constructor(app: App, parent: HTMLElement) {
    this.app = app;
    try { this.size = Math.max(110, Math.min(320, +(localStorage.getItem(SIZE_KEY) || 170))); } catch { /* */ }
    this.grid = h('div', { class: 'org-grid', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': '페이지 목록' });
    this.info = h('span', { class: 'org-info' });
    const zoom = h('input', { type: 'range', min: '110', max: '320', step: '10', value: String(this.size), class: 'org-zoom', 'aria-label': '미리보기 크기', title: '미리보기 크기' }) as HTMLInputElement;
    zoom.addEventListener('input', () => { this.size = +zoom.value; try { localStorage.setItem(SIZE_KEY, zoom.value); } catch { /* */ } this.layout(); });
    const btn = (ic: Parameters<typeof icon>[0], label: string, fn: (e: MouseEvent) => void, title = label) => h('button', { class: 'btn sm', type: 'button', title, onclick: fn }, icon(ic), h('span', {}, label));
    const ed = (fn: (e: any) => void) => () => this.app.pageEditor().then(fn);
    const bar = h('div', { class: 'org-bar' },
      h('strong', { class: 'org-title' }, '페이지 구성'), this.info,
      h('span', { class: 'org-sep' }),
      btn('rotL', '왼쪽 회전', ed(e => e.rotate(-1, 'auto')), '선택한 페이지를 왼쪽으로 90° 회전'),
      btn('rotR', '오른쪽 회전', ed(e => e.rotate(1, 'auto')), '선택한 페이지를 오른쪽으로 90° 회전'),
      btn('pageAdd', '빈 페이지', ed(e => e.insertBlank(this.insertAt())), '선택한 페이지 뒤에 빈 페이지 삽입'),
      btn('merge', 'PDF 삽입', ed(e => e.mergePdf(undefined, this.insertAt())), '다른 PDF의 페이지를 선택한 페이지 뒤에 삽입'),
      btn('image', '이미지 삽입', ed(e => e.imagePages(undefined, this.insertAt())), '이미지를 새 페이지로 삽입'),
      btn('scan', '문서 보정', ed(e => e.correctPages()), '사진·스캔 페이지를 반듯하게 펴고 그늘·대비를 바로잡기'),
      btn('extract', '추출', ed(e => e.extract()), '선택한 페이지만 새 PDF로'),
      btn('trash', '삭제', ed(e => e.deletePages()), '선택한 페이지 삭제 (Delete)'),
      h('span', { class: 'org-grow' }),
      h('label', { class: 'org-zoom-wrap' }, icon('thumbs'), zoom),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => this.hide() }, '문서 보기로'));
    this.el = h('section', { class: 'organizer', hidden: true, 'aria-label': '페이지 구성' }, bar, h('div', { class: 'org-scroll' }, this.grid));
    parent.append(this.el);
    this.obs = new IntersectionObserver(es => { for (const en of es) if (en.isIntersecting) this.paint(en.target as HTMLElement); }, { root: this.el.querySelector('.org-scroll'), rootMargin: '400px 0px' });
    this.bind();
  }
  get sel() { return this.app.sidebar.selected; }
  /** 넣을 자리: 선택한 페이지 가운데 마지막 뒤 (없으면 현재 페이지 뒤) */
  private insertAt() {
    const pages = this.app.view.pages;
    const idx = pages.map((p, i) => this.sel.has(p.key) ? i : -1).filter(i => i >= 0);
    return (idx.length ? Math.max(...idx) : this.app.view.current) + 1;
  }
  show() {
    if (!this.app.doc) return;
    this.isOpen = true; this.el.hidden = false;
    this.app.root.classList.add('org-open');
    this.refresh();
    const cur = this.grid.children[this.app.view.current] as HTMLElement | undefined;
    cur?.scrollIntoView({ block: 'center' });
    this.grid.focus({ preventScroll: true });
  }
  hide() {
    this.isOpen = false; this.el.hidden = true;
    this.app.root.classList.remove('org-open');
    this.app.sidebar.paintPicked();
  }
  toggle() { this.isOpen ? this.hide() : this.show(); }
  /** 페이지가 바뀐 뒤 다시 그린다 */
  refresh() {
    if (!this.isOpen) return;
    this.obs.disconnect(); this.grid.innerHTML = ''; this.done.clear(); this.anchor = -1;
    const pages = this.app.view.pages;
    pages.forEach((p, i) => {
      const card = h('div', { class: 'org-card' + (this.sel.has(p.key) ? ' picked' : '') + (i === this.app.view.current ? ' current' : ''), role: 'option', 'aria-selected': String(this.sel.has(p.key)), dataset: { i: String(i), key: String(p.key) }, title: `${i + 1}페이지 · 두 번 누르면 이 페이지 보기` },
        h('div', { class: 'org-paper' }, h('canvas', {})),
        h('span', { class: 'org-num' }, String(i + 1)));
      this.grid.append(card); this.obs.observe(card);
    });
    this.layout(); this.status();
  }
  private layout() {
    this.grid.style.setProperty('--org', this.size + 'px');
    const pages = this.app.view.pages;
    this.grid.querySelectorAll('.org-card').forEach((c, i) => {
      const p = pages[i]; const paper = c.querySelector('.org-paper') as HTMLElement;
      const w = p.w >= p.h ? this.size : this.size * p.w / p.h, hgt = p.w >= p.h ? this.size * p.h / p.w : this.size;
      paper.style.width = w + 'px'; paper.style.height = hgt + 'px';
      if ((this.done.get(p.key) || 0) < w * devicePixelRatio - 4) this.done.delete(p.key);
    });
    for (const c of this.grid.querySelectorAll('.org-card')) { this.obs.unobserve(c); this.obs.observe(c); }
  }
  private paint(card: HTMLElement) {
    const i = +card.dataset.i!, key = +card.dataset.key!;
    const paper = card.querySelector('.org-paper') as HTMLElement, w = paper.clientWidth;
    if ((this.done.get(key) || 0) >= w * devicePixelRatio - 4) return;
    this.done.set(key, w * devicePixelRatio);
    this.app.view.requestThumb(i, w, b => {
      if (!b) { this.done.delete(key); return; }
      const c = card.querySelector('canvas')!; c.width = b.width; c.height = b.height; c.getContext('2d')!.drawImage(b, 0, 0); b.close();
    });
  }
  private status() {
    const n = this.app.view.pages.length, k = this.app.view.pages.filter(p => this.sel.has(p.key)).length;
    this.info.textContent = k ? `${n}페이지 중 ${k}페이지 선택` : `${n}페이지 · 끌어서 순서 변경, Ctrl·Shift+클릭으로 여러 페이지 선택`;
  }
  private paintSel() {
    this.grid.querySelectorAll('.org-card').forEach(c => { const on = this.sel.has(+(c as HTMLElement).dataset.key!); c.classList.toggle('picked', on); c.setAttribute('aria-selected', String(on)); });
    this.status();
  }
  /** 화면 좌표 → 넣을 자리 (여러 열이라 가로 위치로 앞뒤를 정한다) */
  dropIndexAt(x: number, y: number): number | null {
    if (!this.isOpen) return null;
    const cards = [...this.grid.querySelectorAll('.org-card')] as HTMLElement[];
    const gr = this.el.querySelector('.org-scroll')!.getBoundingClientRect();
    if (x < gr.left || x > gr.right || y < gr.top || y > gr.bottom) return null;
    let best = -1, bd = Infinity;
    cards.forEach((c, i) => { const r = c.getBoundingClientRect(); const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; const d = dx * dx + dy * dy * 4; if (d < bd) { bd = d; best = i; } });
    if (best < 0) return cards.length;
    const r = cards[best].getBoundingClientRect();
    return best + (x > r.left + r.width / 2 ? 1 : 0);
  }
  markDropAt(x: number, y: number) {
    this.clearMarks();
    const at = this.dropIndexAt(x, y); if (at === null) return null;
    const cards = this.grid.querySelectorAll('.org-card');
    if (at < cards.length) cards[at].classList.add('drop-before'); else cards[cards.length - 1]?.classList.add('drop-after');
    return at;
  }
  clearMarks() { this.grid.querySelectorAll('.drop-before, .drop-after').forEach(c => c.classList.remove('drop-before', 'drop-after')); }

  private bind() {
    const g = this.grid;
    let pd: { key: number; x: number; y: number; card: HTMLElement; started: boolean; ghost?: HTMLElement; raf?: number; cy?: number } | null = null;
    let skip = false;
    const end = () => { if (!pd) return; pd.ghost?.remove(); if (pd.raf) cancelAnimationFrame(pd.raf); g.querySelectorAll('.dragging').forEach(c => c.classList.remove('dragging')); this.clearMarks(); document.body.classList.remove('thumb-dragging'); pd = null; };
    g.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const card = (e.target as HTMLElement).closest('.org-card') as HTMLElement | null; if (!card) return;
      pd = { key: +card.dataset.key!, x: e.clientX, y: e.clientY, card, started: false };
    });
    window.addEventListener('pointermove', e => {
      if (!pd || !this.isOpen) return;
      if (!pd.started) {
        if (Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 6) return;
        pd.started = true;
        if (!this.sel.has(pd.key)) { this.sel.clear(); this.sel.add(pd.key); this.paintSel(); }
        const n = this.sel.size;
        g.querySelectorAll('.org-card.picked').forEach(c => c.classList.add('dragging'));
        document.body.classList.add('thumb-dragging');
        const cv = pd.card.querySelector('canvas') as HTMLCanvasElement;
        const copy = h('canvas', {}) as HTMLCanvasElement; if (cv.width) { copy.width = cv.width; copy.height = cv.height; copy.getContext('2d')!.drawImage(cv, 0, 0); }
        pd.ghost = h('div', { class: 'thumb-ghost' }, copy, h('span', {}, n > 1 ? `${n}페이지` : `${+pd.card.dataset.i! + 1}페이지`));
        document.body.append(pd.ghost);
        const scroller = this.el.querySelector('.org-scroll') as HTMLElement;
        const tick = () => { if (!pd) return; const r = scroller.getBoundingClientRect(), y = pd.cy ?? 0; if (y < r.top + 50) scroller.scrollTop -= 14; else if (y > r.bottom - 50) scroller.scrollTop += 14; pd.raf = requestAnimationFrame(tick); };
        pd.raf = requestAnimationFrame(tick);
      }
      pd.cy = e.clientY;
      pd.ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      this.markDropAt(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', e => {
      if (!pd) return;
      if (!pd.started) { pd = null; return; }
      const at = this.dropIndexAt(e.clientX, e.clientY);
      const keys = this.app.view.pages.map(p => p.key).filter(k => this.sel.has(k));
      skip = true; setTimeout(() => skip = false, 0);
      end();
      if (at !== null && keys.length) this.app.pageEditor().then(ed => ed.movePages(keys, at));
    });
    window.addEventListener('blur', end);
    g.addEventListener('click', e => {
      if (skip) return;
      const card = (e.target as HTMLElement).closest('.org-card') as HTMLElement | null;
      if (!card) { if (!e.ctrlKey && !e.shiftKey) { this.sel.clear(); this.paintSel(); } return; }
      const i = +card.dataset.i!, key = +card.dataset.key!;
      if (e.ctrlKey || e.metaKey) { this.sel.has(key) ? this.sel.delete(key) : this.sel.add(key); this.anchor = i; }
      else if (e.shiftKey && this.anchor >= 0) { const a = Math.min(this.anchor, this.app.view.pages.length - 1); this.sel.clear(); for (let k = Math.min(a, i); k <= Math.max(a, i); k++) this.sel.add(this.app.view.pages[k].key); }
      else { this.sel.clear(); this.sel.add(key); this.anchor = i; this.app.view.scrollToPage(i); }
      this.paintSel();
    });
    g.addEventListener('dblclick', e => {
      const card = (e.target as HTMLElement).closest('.org-card') as HTMLElement | null; if (!card) return;
      this.hide(); this.app.goto(+card.dataset.i!);
    });
    g.addEventListener('contextmenu', e => {
      const card = (e.target as HTMLElement).closest('.org-card') as HTMLElement | null; if (!card) return;
      e.preventDefault();
      const key = +card.dataset.key!;
      if (!this.sel.has(key)) { this.sel.clear(); this.sel.add(key); this.paintSel(); }
      const ed = (fn: (e: any) => void) => () => this.app.pageEditor().then(fn);
      const n = this.sel.size;
      menu({ x: e.clientX, y: e.clientY }, [
        { label: '이 페이지 보기', icon: 'view', action: () => { this.hide(); this.app.goto(+card.dataset.i!); } }, '-',
        { label: '왼쪽으로 회전', icon: 'rotL', action: ed(x => x.rotate(-1, 'auto')) },
        { label: '오른쪽으로 회전', icon: 'rotR', action: ed(x => x.rotate(1, 'auto')) }, '-',
        { label: '뒤에 빈 페이지 삽입', icon: 'pageAdd', action: ed(x => x.insertBlank(this.insertAt())) },
        { label: '뒤에 PDF 삽입…', icon: 'merge', action: ed(x => x.mergePdf(undefined, this.insertAt())) },
        { label: n > 1 ? `${n}페이지 추출…` : '이 페이지 추출…', icon: 'extract', action: ed(x => x.extract()) }, '-',
        { label: n > 1 ? `${n}페이지 삭제` : '이 페이지 삭제', icon: 'trash', hint: 'Delete', action: ed(x => x.deletePages()) },
      ]);
    });
    g.addEventListener('keydown', e => {
      const pages = this.app.view.pages, n = pages.length;
      const mod = e.ctrlKey || e.metaKey;
      const cols = Math.max(1, Math.floor(g.clientWidth / (this.size + 28)));
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.app.pageEditor().then(x => x.deletePages()); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); pages.forEach(p => this.sel.add(p.key)); this.paintSel(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (this.sel.size) { this.sel.clear(); this.paintSel(); } else this.hide(); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.hide(); return; }
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols } as Record<string, number>;
      if (step[e.key]) {
        e.preventDefault(); e.stopPropagation();
        const i = Math.max(0, Math.min(n - 1, this.app.view.current + step[e.key]));
        if (!e.shiftKey) this.sel.clear();
        this.sel.add(pages[i].key); this.anchor = i;
        this.app.view.scrollToPage(i);
        this.grid.querySelectorAll('.org-card.current').forEach(c => c.classList.remove('current'));
        const c = this.grid.children[i] as HTMLElement; c?.classList.add('current'); c?.scrollIntoView({ block: 'nearest' });
        this.paintSel();
      }
    });
    // 웹: 파일 끌어 놓기 → 그 자리에 삽입
    const isFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
    this.el.addEventListener('dragover', e => { if (!isFiles(e)) return; e.preventDefault(); e.stopPropagation(); document.body.classList.add('drop-in-thumbs'); this.markDropAt(e.clientX, e.clientY); });
    this.el.addEventListener('dragleave', e => { if (!this.el.contains(e.relatedTarget as Node)) { this.clearMarks(); document.body.classList.remove('drop-in-thumbs'); } });
    this.el.addEventListener('drop', e => {
      if (!isFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      const at = this.dropIndexAt(e.clientX, e.clientY) ?? this.app.view.pages.length;
      this.clearMarks(); document.body.classList.remove('drop-in-thumbs');
      window.dispatchEvent(new Event('airpdf-drop-done'));
      const files = [...e.dataTransfer!.files];
      if (!files.length) return;
      this.app.sidebar.onDropFiles(files, at);
      toast(`${at + 1}번째 자리에 넣는 중…`, 1500);
    });
  }
}
