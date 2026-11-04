/** 왼쪽 패널: 쪽 그림, 목차, 검색 결과, (편집 모드) 주석 목록 */
import type { OutlineItem, SearchHit } from '../engine/types.ts';
import type { DocView } from './docview.ts';
import { h, icon, esc, type IconName } from '../ui/dom.ts';

export type Tab = 'thumbs' | 'outline' | 'search' | 'annots';

export class Sidebar {
  el: HTMLElement;
  private tabs: HTMLElement; private body: HTMLElement;
  panels = new Map<Tab, HTMLElement>();
  tab: Tab = 'thumbs';
  view: DocView;
  private thumbList: HTMLElement;
  private thumbObs: IntersectionObserver;
  private thumbDone = new Map<number, number>(); // key → version
  selected = new Set<number>(); // 고른 쪽(키)
  editable = true;
  onMovePage: (key: number, to: number) => void = () => {};
  onThumbMenu: (e: MouseEvent, index: number) => void = () => {};
  onSearchPick: (hit: SearchHit) => void = () => {};
  onDeleteKey: () => void = () => {};
  onDropFiles: (files: File[], at: number) => void = () => {};
  private searchList: HTMLElement; private searchHead: HTMLElement;

  constructor(parent: HTMLElement, view: DocView) {
    this.view = view;
    this.tabs = h('div', { class: 'side-tabs', role: 'tablist' });
    this.body = h('div', { class: 'side-body' });
    this.el = h('aside', { class: 'sidebar', 'aria-label': '탐색 패널' }, this.tabs, this.body);
    parent.prepend(this.el);
    this.thumbList = h('div', { class: 'thumbs', tabindex: '0', 'aria-label': '쪽 목록. 끌어서 순서 바꾸기, Delete로 지우기, 다른 PDF를 끌어 놓아 넣기' });
    this.addPanel('thumbs', '쪽', 'thumbs', this.thumbList);
    this.addPanel('outline', '목차', 'outline', h('div', { class: 'outline' }, h('p', { class: 'empty' }, '목차가 없는 문서입니다.')));
    this.searchHead = h('div', { class: 'search-head' });
    this.searchList = h('div', { class: 'search-list' });
    this.addPanel('search', '검색', 'search', h('div', {}, this.searchHead, this.searchList));
    this.thumbObs = new IntersectionObserver(es => {
      for (const en of es) if (en.isIntersecting) this.renderThumb(en.target as HTMLElement);
    }, { root: this.body, rootMargin: '300px 0px' });
    this.show('thumbs');
    this.bindThumbs();
  }
  addPanel(tab: Tab, label: string, ic: IconName, content: HTMLElement) {
    const b = h('button', { class: 'side-tab', role: 'tab', type: 'button', title: label, dataset: { tab }, onclick: () => this.show(tab) }, icon(ic), h('span', {}, label));
    this.tabs.append(b);
    const panel = h('div', { class: 'side-panel', role: 'tabpanel', hidden: true }, content);
    this.body.append(panel); this.panels.set(tab, panel);
    return panel;
  }
  removePanel(tab: Tab) { this.panels.get(tab)?.remove(); this.panels.delete(tab); this.tabs.querySelector(`[data-tab="${tab}"]`)?.remove(); if (this.tab === tab) this.show('thumbs'); }
  show(tab: Tab) {
    this.tab = tab;
    for (const [t, p] of this.panels) p.hidden = t !== tab;
    this.tabs.querySelectorAll('.side-tab').forEach(b => b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === tab)));
  }

  /* ───────────── 쪽 그림 ───────────── */
  buildThumbs() {
    this.thumbObs.disconnect(); this.thumbList.innerHTML = ''; this.thumbDone.clear();
    const W = 118;
    this.view.pages.forEach((p, i) => {
      const hgt = Math.round(W * p.h / p.w);
      const item = h('div', { class: 'thumb' + (this.selected.has(p.key) ? ' picked' : ''), dataset: { i: String(i), key: String(p.key) }, draggable: this.editable ? 'true' : undefined, title: `${i + 1}쪽` },
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
  private bindThumbs() {
    let anchor = -1, dragKey = -1;
    this.thumbList.addEventListener('click', e => {
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null; if (!it) return;
      const i = +it.dataset.i!, key = +it.dataset.key!;
      if (this.editable && (e.ctrlKey || e.metaKey)) { this.selected.has(key) ? this.selected.delete(key) : this.selected.add(key); anchor = i; }
      else if (this.editable && e.shiftKey && anchor >= 0) { this.selected.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) this.selected.add(this.view.pages[k].key); }
      else { this.selected.clear(); this.selected.add(key); anchor = i; this.view.scrollToPage(i); if (innerWidth < 860) this.el.hidden = true; }
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
        this.selected.add(this.view.pages[i].key); anchor = i;
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
    this.thumbList.addEventListener('dragstart', e => {
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null; if (!it || !this.editable) return;
      dragKey = +it.dataset.key!; it.classList.add('dragging'); e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', String(dragKey));
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
      if (dragKey < 0) return; e.preventDefault(); e.stopPropagation();
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null;
      this.thumbList.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
      if (!it) return;
      const r = it.getBoundingClientRect(); it.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
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
      if (dragKey < 0) return; e.preventDefault(); e.stopPropagation();
      const it = (e.target as HTMLElement).closest('.thumb') as HTMLElement | null;
      if (it && +it.dataset.key! !== dragKey) {
        const from = this.view.pages.findIndex(p => p.key === dragKey);
        let to = +it.dataset.i! + (it.classList.contains('drop-after') ? 1 : 0);
        if (from < to) to--;
        this.onMovePage(dragKey, to);
      }
      clearMarks(); dragKey = -1;
    });
    this.thumbList.addEventListener('dragend', () => { clearMarks(); dragKey = -1; });
  }
  paintPicked() { this.thumbList.querySelectorAll('.thumb').forEach(t => t.classList.toggle('picked', this.selected.has(+(t as HTMLElement).dataset.key!))); }
  /** 편집 대상 쪽: 고른 쪽이 있으면 그것, 없으면 현재 쪽 */
  targetPages(): number[] {
    const keys = this.view.pages.map(p => p.key);
    const picked = keys.filter(k => this.selected.has(k));
    return picked.length ? picked : [keys[this.view.current]];
  }

  /* ───────────── 목차 ───────────── */
  setOutline(items: OutlineItem[]) {
    const box = this.panels.get('outline')!.firstElementChild as HTMLElement;
    box.innerHTML = '';
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
  }
  searchAdd(hits: SearchHit[], startIndex: number) {
    if (!hits.length) return;
    const page = hits[0].page;
    const g = h('div', { class: 'sr-group' }, h('div', { class: 'sr-page' }, `${page + 1}쪽`));
    hits.forEach((hit, k) => g.append(h('button', { class: 'sr-item', type: 'button', dataset: { n: String(startIndex + k) }, onclick: () => this.onSearchPick(hit), html: `${esc(hit.before)}<mark>${esc(hit.match)}</mark>${esc(hit.after)}` })));
    this.searchList.append(g);
  }
  searchProgress(q: string, found: number, page: number, total: number, done: boolean) {
    this.searchHead.innerHTML = done
      ? (found ? `“${esc(q)}” <b>${found}</b>건` : `“${esc(q)}”와 맞는 글자가 없습니다. 스캔 문서라면 편집 → 도구 → 글자 인식(OCR)을 먼저 하세요.`)
      : `<span class="spin sm"></span> ${page + 1}/${total}쪽 · ${found}건`;
  }
  markHit(n: number) {
    this.searchList.querySelector('.sr-item.cur')?.classList.remove('cur');
    const b = this.searchList.querySelector(`.sr-item[data-n="${n}"]`) as HTMLElement | null;
    if (b) { b.classList.add('cur'); b.scrollIntoView({ block: 'nearest' }); }
  }
}
