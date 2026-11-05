/** 왼쪽 패널: 페이지 그림, 목차, 검색 결과, (편집 모드) 주석 목록 */
import type { OutlineItem, SearchHit } from '../engine/types.ts';
import type { DocView } from './docview.ts';
import { h, icon, esc, type IconName } from '../ui/dom.ts';

export type Tab = 'thumbs' | 'outline' | 'search' | 'annots';

export class Sidebar {
  el: HTMLElement;
  /** 왼쪽 가장자리의 얇은 줄: 누르면 그 패널이 열리고, 열린 것을 다시 누르면 닫힌다 */
  rail: HTMLElement;
  private tabs: HTMLElement; private body: HTMLElement; private headTitle: HTMLElement;
  onToggle: (shown: boolean) => void = () => {};
  panels = new Map<Tab, HTMLElement>();
  tab: Tab = 'thumbs';
  view: DocView;
  private thumbList: HTMLElement;
  private thumbObs: IntersectionObserver;
  private thumbDone = new Map<number, number>(); // key → version
  selected = new Set<number>(); // 선택한 페이지(키)
  editable = true;
  onMovePage: (key: number, to: number) => void = () => {};
  onThumbMenu: (e: MouseEvent, index: number) => void = () => {};
  onSearchPick: (hit: SearchHit) => void = () => {};
  onDeleteKey: () => void = () => {};
  onDropFiles: (files: File[], at: number) => void = () => {};
  onOrganize: () => void = () => {};
  cols: 1 | 2 = 1;
  setCols(n: 1 | 2) {
    this.cols = n; try { localStorage.setItem('airpdf.thumbCols', String(n)); } catch { /* */ }
    this.thumbList.classList.toggle('two', n === 2);
    this.panels.get('thumbs')?.querySelectorAll('.th-col').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.n === String(n))));
    this.buildThumbs();
  }
  private searchList: HTMLElement; private searchHead: HTMLElement;

  constructor(parent: HTMLElement, view: DocView) {
    this.view = view;
    this.tabs = h('div', { class: 'rail-tabs', role: 'tablist', 'aria-orientation': 'vertical' });
    this.rail = h('nav', { class: 'side-rail needs-doc', 'aria-label': '탐색 패널' }, this.tabs);
    this.body = h('div', { class: 'side-body' });
    this.headTitle = h('span', { class: 'side-title' });
    this.el = h('aside', { class: 'sidebar', 'aria-label': '탐색 패널' },
      h('div', { class: 'side-head' }, this.headTitle, h('button', { class: 'side-close', type: 'button', title: '패널 닫기 (F12)', 'aria-label': '패널 닫기', onclick: () => this.close() }, icon('close'))),
      this.body);
    parent.prepend(this.el);
    parent.prepend(this.rail);
    this.thumbList = h('div', { class: 'thumbs', tabindex: '0', 'aria-label': '페이지 목록. 끌어서 순서 바꾸기, Delete로 삭제, 다른 PDF를 끌어 놓아 삽입' });
    // 페이지 목록 위: 1열/2열, 페이지 구성 보기
    try { this.cols = localStorage.getItem('airpdf.thumbCols') === '2' ? 2 : 1; } catch { /* */ }
    const colBtn = (n: 1 | 2, title: string) => h('button', { class: 'th-col', type: 'button', title, 'aria-pressed': String(this.cols === n), dataset: { n: String(n) }, onclick: () => this.setCols(n) }, icon(n === 1 ? 'col1' : 'col2'));
    const head = h('div', { class: 'thumbs-head' }, colBtn(1, '한 줄로 보기'), colBtn(2, '두 줄로 보기'), h('span', { class: 'grow' }),
      h('button', { class: 'th-org', type: 'button', title: '페이지 구성 보기 (Ctrl+Shift+G): 페이지만 크게 늘어놓고 순서·삭제·삽입', onclick: () => this.onOrganize() }, icon('grid'), h('span', {}, '페이지 구성')));
    this.thumbList.classList.toggle('two', this.cols === 2);
    this.addPanel('thumbs', '페이지', 'thumbs', h('div', { class: 'thumbs-wrap' }, head, this.thumbList));
    this.addPanel('outline', '목차', 'outline', h('div', { class: 'outline' }, h('p', { class: 'empty' }, '목차가 없는 문서입니다.')));
    this.searchHead = h('div', { class: 'search-head' });
    this.searchList = h('div', { class: 'search-list' });
    this.addPanel('search', '찾기 결과', 'search', h('div', {}, this.searchHead, this.searchList), '찾기');
    // 목차·찾기 결과는 쓸 것이 있을 때만 보인다
    this.setTabVisible('outline', false); this.setTabVisible('search', false);
    this.thumbObs = new IntersectionObserver(es => {
      for (const en of es) if (en.isIntersecting) this.renderThumb(en.target as HTMLElement);
    }, { root: this.body, rootMargin: '300px 0px' });
    this.show('thumbs');
    this.bindThumbs();
  }
  addPanel(tab: Tab, label: string, ic: IconName, content: HTMLElement, short = label) {
    const b = h('button', { class: 'side-tab', role: 'tab', type: 'button', title: label, 'aria-label': label, dataset: { tab, label }, onclick: () => this.clickTab(tab) }, icon(ic), h('span', { class: 'rail-lbl' }, short));
    this.tabs.append(b);
    const panel = h('div', { class: 'side-panel', role: 'tabpanel', hidden: true }, content);
    this.body.append(panel); this.panels.set(tab, panel);
    return panel;
  }
  removePanel(tab: Tab) { this.panels.get(tab)?.remove(); this.panels.delete(tab); this.tabs.querySelector(`[data-tab="${tab}"]`)?.remove(); if (this.tab === tab) this.show('thumbs'); }
  show(tab: Tab) {
    if (!this.panels.has(tab)) tab = 'thumbs';
    this.tab = tab;
    this.setTabVisible(tab, true);
    for (const [t, p] of this.panels) p.hidden = t !== tab;
    const b = this.tabs.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null;
    this.headTitle.textContent = b?.dataset.label || '';
    this.paintTabs();
  }
  private paintTabs() { this.tabs.querySelectorAll('.side-tab').forEach(b => b.setAttribute('aria-selected', String(!this.el.hidden && (b as HTMLElement).dataset.tab === this.tab))); }
  /** 레일 단추: 닫혀 있으면 열고, 이미 보고 있는 것이면 닫는다 */
  clickTab(tab: Tab) { if (!this.el.hidden && this.tab === tab) this.close(); else { this.show(tab); this.open(); } }
  open() { if (!this.el.hidden) return; this.el.hidden = false; this.paintTabs(); this.markCurrent(this.view.current); this.onToggle(true); }
  close() { if (this.el.hidden) return; this.el.hidden = true; this.paintTabs(); this.onToggle(false); }
  toggle() { this.el.hidden ? this.open() : this.close(); }
  get shown() { return !this.el.hidden; }
  setTabVisible(tab: Tab, on: boolean) {
    const b = this.tabs.querySelector(`[data-tab="${tab}"]`) as HTMLElement | null; if (b) b.hidden = !on;
    if (!on && this.tab === tab) this.show('thumbs');
  }

  /* ───────────── 페이지 그림 ───────────── */
  private anchor = -1;
  buildThumbs() {
    this.thumbObs.disconnect(); this.thumbList.innerHTML = ''; this.thumbDone.clear();
    this.anchor = -1;
    const W = this.cols === 2 ? 80 : 118;
    this.view.pages.forEach((p, i) => {
      const hgt = Math.round(W * p.h / p.w);
      const item = h('div', { class: 'thumb' + (this.selected.has(p.key) ? ' picked' : ''), dataset: { i: String(i), key: String(p.key) }, title: `${i + 1}페이지` },
        h('div', { class: 'thumb-paper', style: { width: W + 'px', height: Math.min(hgt, 170) + 'px' } }, h('canvas', {})),
        h('span', { class: 'thumb-num' }, String(i + 1)));
      this.thumbList.append(item);
      this.thumbObs.observe(item);
    });
    this.markCurrent(this.view.current);
  }
  private renderThumb(item: HTMLElement) {
    const i = +item.dataset.i!, key = +item.dataset.key!;
    const v = this.view.version.get(key) || 0;
    if (this.thumbDone.get(key) === v) return;
    this.thumbDone.set(key, v);
    const paper = item.querySelector('.thumb-paper') as HTMLElement;
    this.view.requestThumb(i, paper.clientWidth || 118, b => {
      if (!b) { this.thumbDone.delete(key); return; }
      const c = item.querySelector('canvas')!; c.width = b.width; c.height = b.height; c.getContext('2d')!.drawImage(b, 0, 0); b.close();
    });
  }
  refreshThumb(key: number) {
    this.thumbDone.delete(key);
    const it = this.thumbList.querySelector(`.thumb[data-key="${key}"]`) as HTMLElement | null;
    if (it) this.renderThumb(it);
  }
  markCurrent(i: number) {
    this.thumbList.querySelector('.thumb.current')?.classList.remove('current');
    const it = this.thumbList.children[i] as HTMLElement | undefined;
    if (it) { it.classList.add('current'); if (this.tab === 'thumbs' && !this.el.hidden) it.scrollIntoView({ block: 'nearest' }); }
  }
  /* ───────────── 끌어 놓을 자리 (설치판에서 파일을 끌어 올 때도 씀) ───────────── */
  /** 화면 좌표가 페이지 목록 위면 넣을 자리(0~페이지 수), 아니면 null */
  dropIndexAt(x: number, y: number): number | null {
    if (this.el.hidden || this.tab !== 'thumbs' || !this.view.pages.length) return null;
    const lr = this.body.getBoundingClientRect();
    if (x < lr.left || x > lr.right || y < lr.top || y > lr.bottom) return null;
    const items = [...this.thumbList.querySelectorAll('.thumb')] as HTMLElement[];
    if (this.cols === 2) {
      let best = -1, bd = Infinity;
      items.forEach((it, i) => { const r = it.getBoundingClientRect(); const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; const dd = dx * dx + dy * dy * 4; if (dd < bd) { bd = dd; best = i; } });
      if (best < 0) return this.view.pages.length;
      const r = items[best].getBoundingClientRect();
      return best + (x > r.left + r.width / 2 ? 1 : 0);
    }
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (y < r.top + r.height / 2) return +it.dataset.i!;
      if (y <= r.bottom) return +it.dataset.i! + 1;
    }
    return this.view.pages.length;
  }
  markDropAt(x: number, y: number) {
    this.clearDropMarks();
    const at = this.dropIndexAt(x, y); if (at === null) return null;
    const items = this.thumbList.querySelectorAll('.thumb');
    if (at < items.length) items[at].classList.add('drop-before'); else items[items.length - 1]?.classList.add('drop-after');
    return at;
  }
  clearDropMarks() { this.thumbList.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); }

  private bindThumbs() {
    // 순서 바꾸기는 마우스로 직접 처리한다 (설치판 Windows에서는 HTML 끌어 놓기가 막혀 있어서)
    let pd: { key: number; x: number; y: number; el: HTMLElement; started: boolean; ghost?: HTMLElement; scroll?: number } | null = null;
    let skipClick = false;
    const endDrag = () => {
      if (!pd) return;
      pd.el.classList.remove('dragging'); pd.ghost?.remove(); if (pd.scroll) cancelAnimationFrame(pd.scroll);
      this.clearDropMarks(); document.body.classList.remove('thumb-dragging'); pd = null;
    };
    this.thumbList.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this.editable) return;
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null; if (!it) return;
      pd = { key: +it.dataset.key!, x: e.clientX, y: e.clientY, el: it, started: false };
    });
    window.addEventListener('pointermove', e => {
      if (!pd) return;
      if (!pd.started) {
        if (Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 6) return;
        pd.started = true; pd.el.classList.add('dragging'); document.body.classList.add('thumb-dragging');
        const cv = pd.el.querySelector('canvas') as HTMLCanvasElement | null;
        pd.ghost = h('div', { class: 'thumb-ghost' }, cv && cv.width ? (() => { const c = h('canvas', {}) as HTMLCanvasElement; c.width = cv.width; c.height = cv.height; c.getContext('2d')!.drawImage(cv, 0, 0); return c; })() : null, h('span', {}, `${+pd.el.dataset.i! + 1}페이지`));
        document.body.append(pd.ghost);
        // 목록 가장자리에 가면 저절로 넘긴다
        const tick = () => {
          if (!pd) return;
          const r = this.body.getBoundingClientRect(), y = (pd as any).cy ?? 0;
          if (y < r.top + 40) this.body.scrollTop -= 12; else if (y > r.bottom - 40) this.body.scrollTop += 12;
          pd.scroll = requestAnimationFrame(tick);
        };
        pd.scroll = requestAnimationFrame(tick);
      }
      (pd as any).cy = e.clientY;
      pd.ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
      this.markDropAt(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', e => {
      if (!pd) return;
      if (pd.started) {
        const at = this.dropIndexAt(e.clientX, e.clientY), key = pd.key;
        skipClick = true; setTimeout(() => skipClick = false, 0);
        endDrag();
        if (at !== null) {
          const from = this.view.pages.findIndex(p => p.key === key);
          const to = from < at ? at - 1 : at;
          if (to !== from) this.onMovePage(key, to);
        }
      } else pd = null;
    });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && pd?.started) endDrag(); });
    window.addEventListener('blur', endDrag);
    this.thumbList.addEventListener('click', e => {
      if (skipClick) return;
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null; if (!it) return;
      const i = +it.dataset.i!, key = +it.dataset.key!;
      if (this.editable && (e.ctrlKey || e.metaKey)) { this.selected.has(key) ? this.selected.delete(key) : this.selected.add(key); this.anchor = i; }
      else if (this.editable && e.shiftKey && this.anchor >= 0) { const a = Math.min(this.anchor, this.view.pages.length - 1); this.selected.clear(); for (let k = Math.min(a, i); k <= Math.max(a, i); k++) this.selected.add(this.view.pages[k].key); }
      else { this.selected.clear(); this.selected.add(key); this.anchor = i; this.view.scrollToPage(i); if (innerWidth < 860) this.close(); }
      this.paintPicked();
      this.thumbList.focus({ preventScroll: true });
    });
    this.thumbList.addEventListener('keydown', e => {
      if (!this.editable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.onDeleteKey(); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); this.view.pages.forEach(p => this.selected.add(p.key)); this.paintPicked(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const i = Math.max(0, Math.min(this.view.pages.length - 1, this.view.current + (e.key === 'ArrowDown' ? 1 : -1)));
        if (!e.shiftKey) this.selected.clear();
        this.selected.add(this.view.pages[i].key); this.anchor = i;
        this.view.scrollToPage(i); this.paintPicked();
      }
    });
    this.thumbList.addEventListener('contextmenu', e => {
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null; if (!it) return;
      e.preventDefault();
      const key = +it.dataset.key!;
      if (!this.selected.has(key)) { this.selected.clear(); this.selected.add(key); this.paintPicked(); }
      this.onThumbMenu(e, +it.dataset.i!);
    });
    const clearMarks = () => this.thumbList.querySelectorAll('.drop-before, .drop-after, .dragging').forEach(x => x.classList.remove('drop-before', 'drop-after', 'dragging'));
    const isFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
    const dropIndex = (e: DragEvent) => {
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null;
      if (!it) return this.view.pages.length;
      const r = it.getBoundingClientRect();
      return +it.dataset.i! + (e.clientY < r.top + r.height / 2 ? 0 : 1);
    };
    this.thumbList.addEventListener('dragover', e => {
      if (isFiles(e) && this.editable && this.view.pages.length) {
        e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = 'copy';
        document.body.classList.add('drop-in-thumbs');
        const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null;
        this.thumbList.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
        const last = this.thumbList.lastElementChild as HTMLElement | null;
        if (it) { const r = it.getBoundingClientRect(); it.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after'); }
        else last?.classList.add('drop-after');
        return;
      }
    });
    this.thumbList.addEventListener('dragleave', e => { if (!this.thumbList.contains(e.relatedTarget as Node)) { document.body.classList.remove('drop-in-thumbs'); clearMarks(); } });
    this.thumbList.addEventListener('drop', e => {
      if (isFiles(e) && this.editable && this.view.pages.length) {
        e.preventDefault(); e.stopPropagation();
        document.body.classList.remove('drop-in-thumbs');
        const at = dropIndex(e); clearMarks();
        window.dispatchEvent(new Event('airpdf-drop-done'));
        this.onDropFiles([...e.dataTransfer!.files], at);
        return;
      }
    });
  }
  paintPicked() { this.thumbList.querySelectorAll('.thumb').forEach(t => t.classList.toggle('picked', this.selected.has(+(t as HTMLElement).dataset.key!))); }
  /** 편집 대상 페이지: 선택한 페이지가 있으면 그것, 없으면 현재 페이지 */
  targetPages(): number[] {
    const keys = this.view.pages.map(p => p.key);
    const picked = keys.filter(k => this.selected.has(k));
    return picked.length ? picked : [keys[this.view.current]];
  }

  /* ───────────── 목차 ───────────── */
  setOutline(items: OutlineItem[]) {
    const box = this.panels.get('outline')!.firstElementChild as HTMLElement;
    box.innerHTML = '';
    this.setTabVisible('outline', items.length > 0);
    if (!items.length) { box.append(h('p', { class: 'empty' }, '목차가 없는 문서입니다.')); return; }
    const build = (list: OutlineItem[], depth: number): HTMLElement => h('ul', { class: 'ol-list', role: depth ? 'group' : 'tree' }, ...list.map(it => {
      const kids = it.children.length ? build(it.children, depth + 1) : null;
      const open = depth < 1;
      const li = h('li', { class: 'ol-item' + (open ? ' open' : '') },
        h('div', { class: 'ol-row' },
          kids ? h('button', { class: 'ol-tog', type: 'button', 'aria-label': '펼치기', onclick: (e: Event) => { e.stopPropagation(); li.classList.toggle('open'); } }, '▸') : h('span', { class: 'ol-tog sp' }),
          h('button', { class: 'ol-link', type: 'button', onclick: () => it.page >= 0 && this.view.scrollToPage(it.page, it.top) }, it.title || '(제목 없음)'),
          it.page >= 0 ? h('span', { class: 'ol-pg' }, String(it.page + 1)) : null),
        kids);
      return li;
    }));
    box.append(build(items, 0));
  }

  /* ───────────── 검색 결과 ───────────── */
  searchStart(q: string) {
    this.searchHead.innerHTML = `<span class="spin sm"></span> “${esc(q)}” 찾는 중…`;
    this.searchList.innerHTML = '';
    this.show('search');
    this.open();
  }
  searchAdd(hits: SearchHit[], startIndex: number) {
    if (!hits.length) return;
    const page = hits[0].page;
    const g = h('div', { class: 'sr-group' }, h('div', { class: 'sr-page' }, `${page + 1}페이지`));
    hits.forEach((hit, k) => g.append(h('button', { class: 'sr-item', type: 'button', dataset: { n: String(startIndex + k) }, onclick: () => this.onSearchPick(hit), html: `${esc(hit.before)}<mark>${esc(hit.match)}</mark>${esc(hit.after)}` })));
    this.searchList.append(g);
  }
  searchProgress(q: string, found: number, page: number, total: number, done: boolean) {
    this.searchHead.innerHTML = done
      ? (found ? `“${esc(q)}” <b>${found}</b>건` : `“${esc(q)}”와 맞는 글자가 없습니다. 스캔 문서라면 편집 → 도구 → 글자 인식(OCR)을 먼저 하세요.`)
      : `<span class="spin sm"></span> ${page + 1}/${total}페이지 · ${found}건`;
  }
  markHit(n: number) {
    this.searchList.querySelector('.sr-item.cur')?.classList.remove('cur');
    const b = this.searchList.querySelector(`.sr-item[data-n="${n}"]`) as HTMLElement | null;
    if (b) { b.classList.add('cur'); b.scrollIntoView({ block: 'nearest' }); }
  }
}
