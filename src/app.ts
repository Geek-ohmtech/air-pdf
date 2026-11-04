import type { EngineClient } from './engine/client.ts';
import type { DocInfo, LinkInfo, OutlineItem, SearchHit } from './engine/types.ts';
import { FormLayer } from './viewer/forms.ts';
import type { OpenedFile, Platform, SavedTarget } from './platform/types.ts';
import { baseName } from './platform/types.ts';
import { DocView } from './viewer/docview.ts';
import { Sidebar } from './viewer/sidebar.ts';
import { $, busy, confirmBox, dialog, esc, h, icon, menu, promptBox, toast } from './ui/dom.ts';
import type { Editor } from './editor/editor.ts';

export interface DocState {
  id: number; info: DocInfo; name: string; target: SavedTarget | null; dirty: boolean; size: number; formType: number;
  outline?: OutlineItem[]; view?: { zoom: number; fit: 'width' | 'page' | null; top: number; left: number; current: number }; editorState?: any;
}
type Mode = 'view' | 'edit';
const PREF = 'airpdf.prefs';
export const fmtSize = (n: number) => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1048576).toFixed(2)}MB`;

export class App {
  engine: EngineClient; platform: Platform;
  root: HTMLElement; ribbon: HTMLElement; stage: HTMLElement; status: HTMLElement;
  view: DocView; sidebar: Sidebar;
  doc: DocState | null = null;
  tabs: DocState[] = [];
  forms!: FormLayer;
  private tabbar!: HTMLElement;
  mode: Mode = 'view';
  editor: Editor | null = null;
  private start: HTMLElement;
  private pageInput!: HTMLInputElement; private pageCount!: HTMLElement; private zoomBtn!: HTMLButtonElement;
  private searchInput!: HTMLInputElement; private saveBtn!: HTMLButtonElement; private modeBtns!: HTMLElement;
  private hits: SearchHit[] = []; private hitByPage = new Map<number, SearchHit[]>(); private hitIdx = -1; private lastQuery = '';
  private searchOpts = { matchCase: false, wholeWord: false };
  prefs = { theme: 'system', spread: false, night: false, sidebar: true, author: '' };

  constructor(engine: EngineClient, platform: Platform) {
    this.engine = engine; this.platform = platform;
    try { Object.assign(this.prefs, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch { /* 기본값 */ }
    this.applyTheme();
    this.root = h('div', { id: 'app', class: 'mode-view no-doc' });
    const top = this.buildTopbar();
    this.ribbon = h('div', { class: 'ribbon', hidden: true });
    this.stage = h('div', { class: 'stage' });
    const main = h('div', { class: 'main' }, this.stage);
    this.status = h('footer', { class: 'statusbar' });
    this.tabbar = h('div', { class: 'tabbar', role: 'tablist', hidden: true });
    this.root.append(top, this.tabbar, this.ribbon, main, this.status);
    document.body.append(this.root);
    this.view = new DocView(this.stage, engine);
    this.sidebar = new Sidebar(main, this.view);
    this.sidebar.el.hidden = !this.prefs.sidebar || innerWidth < 860;
    this.start = this.buildStart();
    this.stage.append(this.start);
    this.view.spread = this.prefs.spread; this.view.night = this.prefs.night;
    this.view.onPage = i => this.onPage(i);
    this.view.onZoom = () => this.updateZoom();
    this.view.onLink = l => this.followLink(l);
    this.view.onContext = (e, page, x, y) => this.contextMenu(e, page, x, y);
    this.view.onSelect = () => this.updateStatus();
    this.sidebar.onSearchPick = hit => this.gotoHit(this.hits.indexOf(hit));
    this.forms = new FormLayer(this);
    this.bindKeys();
    this.bindDrop();
    platform.onExternalOpen(files => this.openFiles(files));
    platform.onCloseRequest(async () => {
      const dirty = this.tabs.filter(t => t.dirty);
      return !dirty.length || await confirmBox('저장하지 않은 변경 사항', `${dirty.map(t => '“' + t.name + '”').join(', ')}에 저장하지 않은 편집 내용이 있습니다. 저장하지 않고 닫을까요?`, '저장하지 않고 닫기', true);
    });
    this.updateStatus();
  }
  savePrefs() { try { localStorage.setItem(PREF, JSON.stringify(this.prefs)); } catch { /* */ } }
  applyTheme() {
    const t = this.prefs.theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  }

  /* ───────────── 화면 구성 ───────────── */
  private tb(ic: Parameters<typeof icon>[0], title: string, onclick: () => void, extra: Record<string, any> = {}) {
    return h('button', { class: 'tb', type: 'button', title, 'aria-label': title, onclick, ...extra }, icon(ic));
  }
  private buildTopbar() {
    this.pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', value: '–', 'aria-label': '쪽 번호', title: '쪽 번호 (Ctrl+G)' });
    this.pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') { this.goto(parseInt(this.pageInput.value) - 1); this.view.el.focus(); } if (e.key === 'Escape') this.view.el.focus(); });
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.pageCount = h('span', { class: 'page-count' }, '/ –');
    this.zoomBtn = h('button', { class: 'tb zoom-btn', type: 'button', title: '배율', onclick: (e: MouseEvent) => this.zoomMenu(e) }, '100%');
    this.searchInput = h('input', { class: 'search-input', type: 'search', placeholder: '문서에서 찾기', 'aria-label': '문서에서 찾기', title: '찾기 (Ctrl+F) · 다음 Enter/F3 · 이전 Shift+Enter' });
    this.searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const q = this.searchInput.value.trim(); if (!q) return; if (q !== this.lastQuery) this.search(q); else this.gotoHit(this.hitIdx + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') { this.clearSearch(); this.view.el.focus(); }
    });
    const optBtn = (label: string, k: 'matchCase' | 'wholeWord', title: string) => {
      const b = h('button', { class: 'opt', type: 'button', title, 'aria-pressed': 'false', onclick: () => { this.searchOpts[k] = !this.searchOpts[k]; b.setAttribute('aria-pressed', String(this.searchOpts[k])); if (this.lastQuery) this.search(this.lastQuery); } }, label);
      return b;
    };
    this.saveBtn = h('button', { class: 'tb save-btn', type: 'button', title: '저장 (Ctrl+S)', onclick: () => this.save(false), hidden: true }, icon('save'), h('span', { class: 'tb-lbl' }, '저장'));
    this.modeBtns = h('div', { class: 'mode-switch', role: 'group', 'aria-label': '모드' },
      h('button', { type: 'button', class: 'mode-b', dataset: { m: 'view' }, 'aria-pressed': 'true', title: '보기 모드 (Ctrl+E로 전환)', onclick: () => this.setMode('view') }, icon('view'), h('span', {}, '보기')),
      h('button', { type: 'button', class: 'mode-b', dataset: { m: 'edit' }, 'aria-pressed': 'false', title: '편집 모드 (Ctrl+E로 전환)', onclick: () => this.setMode('edit') }, icon('edit'), h('span', {}, '편집')));
    return h('header', { class: 'topbar' },
      h('div', { class: 'tb-group' },
        this.tb('sidebar', '탐색 패널 (F12)', () => this.toggleSidebar()),
        h('span', { class: 'brand' }, h('span', { class: 'brand-mark', html: '<svg viewBox="0 0 24 24"><path d="M4.5 2h10.5l4.5 4.5V22H4.5z" fill="var(--accent)"/><path d="M15 2v4.5h4.5" fill="none" stroke="var(--on-accent)" stroke-width="1.2" opacity=".6"/><path d="M8.3 18.6c-.2-5 2.4-8.4 7-9.6-.1 4.6-2.8 8.2-7 9.6z" fill="var(--on-accent)"/><path d="M7.2 20.1l6.9-9.3" stroke="var(--accent)" stroke-width=".9" stroke-linecap="round"/></svg>' }), h('span', { class: 'brand-name' }, 'Air PDF')),
        this.tb('open', '열기 (Ctrl+O)', () => this.pickAndOpen()),
        this.saveBtn),
      h('div', { class: 'tb-group nav-group needs-doc' },
        this.tb('prev', '이전 쪽 (P)', () => this.goto(this.view.current - 1)),
        h('label', { class: 'page-box' }, this.pageInput, this.pageCount),
        this.tb('next', '다음 쪽 (N)', () => this.goto(this.view.current + 1))),
      h('div', { class: 'tb-group needs-doc zoom-group' },
        this.tb('minus', '축소 (Ctrl+-)', () => this.zoomStep(-1)),
        this.zoomBtn,
        this.tb('plus', '확대 (Ctrl+=)', () => this.zoomStep(1)),
        this.tb('fit', '쪽 너비 맞춤 (Ctrl+2)', () => this.setFit('width'))),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'search-box needs-doc' }, icon('search'), this.searchInput, optBtn('Aa', 'matchCase', '대소문자 구분'), optBtn('낱말', 'wholeWord', '낱말 단위')),
      h('div', { class: 'tb-group' }, this.modeBtns, this.tb('more', '메뉴', () => this.mainMenu())));
  }
  private buildStart() {
    const recent = this.platform.recent();
    return h('div', { class: 'start' },
      h('div', { class: 'start-card' },
        h('div', { class: 'start-mark', html: '<svg viewBox="0 0 24 24"><path d="M4.5 2h10.5l4.5 4.5V22H4.5z" fill="var(--accent)"/><path d="M15 2v4.5h4.5" fill="none" stroke="var(--on-accent)" stroke-width="1.2" opacity=".6"/><path d="M8.3 18.6c-.2-5 2.4-8.4 7-9.6-.1 4.6-2.8 8.2-7 9.6z" fill="var(--on-accent)"/><path d="M7.2 20.1l6.9-9.3" stroke="var(--accent)" stroke-width=".9" stroke-linecap="round"/></svg>' }),
        h('h1', {}, 'Air PDF'),
        h('p', { class: 'start-sub' }, '빠르게 보고, 필요할 때만 편집 모드로 고칩니다.'),
        h('div', { class: 'start-btns' }, h('button', { class: 'btn primary big', type: 'button', onclick: () => this.pickAndOpen() }, icon('open'), 'PDF 열기'),
          h('button', { class: 'btn big', type: 'button', onclick: () => import('./tools.ts').then(m => m.imagesToPdf(this)) }, icon('image'), '이미지로 PDF 만들기')),
        h('p', { class: 'start-hint' }, this.platform.kind === 'web' ? '또는 이 창에 PDF를 끌어다 놓으세요. 파일은 이 컴퓨터 밖으로 나가지 않습니다.' : '또는 이 창에 PDF를 끌어다 놓으세요.'),
        recent.length ? h('div', { class: 'recent' }, h('h3', {}, '최근 문서'), ...recent.map(p => h('button', { class: 'recent-item', type: 'button', title: p, onclick: async () => { try { this.openFiles([await this.platform.readPath(p)]); } catch { toast('파일을 찾을 수 없습니다: ' + p); } } }, icon('open'), h('span', { class: 'recent-name' }, baseName(p)), h('span', { class: 'recent-path' }, p)))) : null,
        h('div', { class: 'start-keys' },
          ...[['Ctrl+O', '열기'], ['Ctrl+F', '찾기'], ['Ctrl+E', '보기/편집 전환'], ['Ctrl+휠', '확대'], ['F1', '단축키']].map(([k, v]) => h('span', {}, h('kbd', {}, k), ' ', v)))));
  }

  /* ───────────── 열기 / 저장 ───────────── */
  async pickAndOpen() { const files = await this.platform.pickPdfs(true); if (files.length) this.openFiles(files); }
  /** 파일마다 새 탭으로 연다. unsaved: 아직 저장 위치가 없는 사본(압축본 등) */
  async openFiles(files: OpenedFile[], unsaved = false) {
    for (const f of files) await this.openOne(f, unsaved);
  }
  private async openOne(f: OpenedFile, unsaved: boolean) {
    if (f.path) { const ex = this.tabs.find(t => t.target?.path === f.path); if (ex) { await this.activate(ex); return; } }
    const t0 = performance.now();
    let pw = '', tried = false, docId = 0;
    for (;;) {
      const r = await this.engine.call<{ docId?: number; error?: string }>('open', [f.bytes, pw]);
      if (r.docId) { docId = r.docId; break; }
      if (r.error === 'password') {
        const v = await promptBox('암호가 걸린 문서', `“${f.name}”을 열려면 암호를 입력하세요.`, '', { type: 'password', ok: '열기', error: tried ? '암호가 맞지 않습니다. 다시 입력하세요.' : undefined });
        if (v === null) return;
        pw = v; tried = true; continue;
      }
      toast(r.error === 'format' ? `“${f.name}”은 PDF가 아니거나 손상된 파일입니다.` : `“${f.name}”을 열지 못했습니다.`);
      return;
    }
    const tab = await this.makeTab(docId, f.name, unsaved, unsaved ? null : f.path || f.handle ? { name: f.name, path: f.path, handle: f.handle } : null, f.bytes.length);
    if (f.path) this.platform.addRecent(f.path);
    requestAnimationFrame(() => (window as any).__openMs = performance.now() - t0);
    if (pw) toast('암호를 확인했습니다. 저장하면 같은 암호가 유지됩니다.');
    else if (tab.formType === 1) toast('입력란이 있는 문서입니다. 칸을 누르면 바로 입력할 수 있습니다.', 3600);
    else if (tab.formType >= 2) toast('XFA 양식은 입력을 지원하지 않습니다. 보기만 할 수 있습니다.', 3600);
  }
  /** 엔진에 이미 있는 문서를 새 탭으로 (이미지로 만든 PDF 등) */
  async addTab(docId: number, name: string, dirty: boolean) { await this.makeTab(docId, name, dirty, null, 0); }
  private async makeTab(docId: number, name: string, dirty: boolean, target: SavedTarget | null, size: number) {
    const [info, formType] = await Promise.all([this.engine.call<DocInfo>('info', [docId]), this.engine.call<number>('formType', [docId])]);
    const tab: DocState = { id: docId, info, name, target, dirty, size, formType };
    const at = this.doc ? this.tabs.indexOf(this.doc) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    await this.activate(tab);
    if (!size) this.engine.call<Uint8Array>('save', [docId]).then(b => { tab.size = b.length; this.updateStatus(); }).catch(() => {});
    return tab;
  }
  /** 탭 바꾸기: 화면 위치·배율·편집 기록은 탭마다 따로 기억한다 */
  async activate(tab: DocState) {
    if (this.doc === tab) return;
    if (this.doc) this.stash(this.doc);
    this.forms.reset();
    this.doc = tab;
    this.root.classList.remove('no-doc');
    this.start.hidden = true;
    this.view.spread = this.prefs.spread;
    this.view.fit = 'width';
    this.view.setDoc(tab.id, tab.info.pages);
    const v = tab.view;
    if (v) {
      this.view.fit = v.fit;
      if (v.fit) this.view.applyFit(false); else this.view.setZoom(v.zoom, null);
      this.view.el.scrollTop = v.top; this.view.el.scrollLeft = v.left;
      this.view.current = v.current;
    }
    this.sidebar.selected.clear();
    this.sidebar.buildThumbs();
    this.sidebar.setOutline(tab.outline || []);
    if (!tab.outline) this.engine.call<OutlineItem[]>('outline', [tab.id]).then(o => { tab.outline = o; if (this.doc === tab) this.sidebar.setOutline(o); }).catch(() => {});
    this.clearSearch();
    this.editor?.loadState(tab.editorState);
    this.renderTabs();
    this.updateTitle(); this.updateStatus(); this.onPage(this.view.current);
    this.view.el.focus();
  }
  private stash(tab: DocState) {
    this.editor?.commitPending();
    tab.view = { zoom: this.view.zoom, fit: this.view.fit, top: this.view.el.scrollTop, left: this.view.el.scrollLeft, current: this.view.current };
    if (this.editor) tab.editorState = this.editor.saveState();
  }
  async closeTab(tab: DocState | null = this.doc) {
    if (!tab) return;
    if (tab.dirty && !(await confirmBox('저장하지 않은 변경 사항', `“${tab.name}”의 편집 내용을 저장하지 않고 닫을까요?`, '닫기', true))) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    this.engine.call('close', [tab.id]);
    if (tab === this.doc) {
      this.editor?.commitPending();
      this.doc = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) await this.activate(next);
      else {
        if (this.mode === 'edit') await this.setMode('view');
        this.forms.reset();
        this.view.setDoc(0, []);
        this.sidebar.buildThumbs(); this.sidebar.setOutline([]);
        this.root.classList.add('no-doc'); this.start.hidden = false;
        this.editor?.loadState(undefined);
        this.updateTitle(); this.updateStatus();
      }
    }
    this.renderTabs();
  }
  async closeDoc() { await this.closeTab(); }
  cycleTab(dir: number) {
    if (this.tabs.length < 2 || !this.doc) return;
    const i = this.tabs.indexOf(this.doc);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }
  renderTabs() {
    const bar = this.tabbar;
    bar.hidden = this.tabs.length < 2;
    bar.innerHTML = '';
    for (const t of this.tabs) {
      const b = h('div', { class: 'tab' + (t === this.doc ? ' on' : ''), role: 'tab', 'aria-selected': String(t === this.doc), title: t.target?.path || t.name, tabindex: '0' },
        t.info.encrypted ? icon('lock') : null,
        h('span', { class: 'tab-name' }, t.name),
        t.dirty ? h('span', { class: 'tab-dirty', title: '저장하지 않음' }, '●') : null,
        h('button', { class: 'tab-x', type: 'button', title: '닫기 (Ctrl+W)', 'aria-label': t.name + ' 닫기', onclick: (e: Event) => { e.stopPropagation(); this.closeTab(t); } }, icon('close')));
      b.addEventListener('click', () => this.activate(t));
      b.addEventListener('auxclick', e => { if ((e as MouseEvent).button === 1) { e.preventDefault(); this.closeTab(t); } });
      b.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') this.activate(t); });
      bar.append(b);
    }
    bar.append(h('button', { class: 'tab-add', type: 'button', title: '다른 PDF 열기 (Ctrl+O)', 'aria-label': '열기', onclick: () => this.pickAndOpen() }, icon('plus')));
  }
  async save(as: boolean) {
    const d = this.doc; if (!d) return;
    if (!as && !d.dirty && d.target) { toast('바뀐 내용이 없습니다.'); return; }
    this.editor?.commitPending();
    const b = busy('저장하는 중…');
    try {
      const bytes = await this.engine.call<Uint8Array>('save', [d.id]);
      b.done();
      let ok = false;
      if (!as && d.target) ok = await this.platform.saveInPlace(d.target, bytes);
      if (!ok) {
        const suggest = as || !d.target ? d.name.replace(/\.pdf$/i, '') + (d.target ? '' : '_편집') + '.pdf' : d.name;
        const t = await this.platform.saveAs(suggest, bytes);
        if (!t) return;
        d.target = t; d.name = t.name;
        if (t.path) this.platform.addRecent(t.path);
      }
      d.dirty = false; d.size = bytes.length;
      this.updateTitle(); this.updateStatus(); this.renderTabs();
      toast(`저장했습니다 · ${d.name} (${fmtSize(bytes.length)})`);
    } catch (e: any) { b.done(); toast('저장하지 못했습니다: ' + e.message); }
  }
  markDirty() { if (this.doc && !this.doc.dirty) { this.doc.dirty = true; this.updateTitle(); this.renderTabs(); } this.updateStatus(); }
  updateTitle() {
    const d = this.doc;
    this.platform.setTitle(d ? `${d.dirty ? '● ' : ''}${d.name} - Air PDF` : 'Air PDF');
    this.saveBtn.hidden = !d?.dirty;
    (window as any).__dirty = this.tabs.some(t => t.dirty);
  }
  /** 쪽 구성이 바뀐 뒤(삭제·이동·합치기) 다시 읽기 */
  async reloadPages(keepIndex?: number) {
    if (!this.doc) return;
    const info = await this.engine.call<DocInfo>('info', [this.doc.id]);
    this.doc.info = info;
    const cur = keepIndex ?? this.view.current;
    this.view.setPages(info.pages);
    this.sidebar.selected.forEach(k => { if (!info.pages.some(p => p.key === k)) this.sidebar.selected.delete(k); });
    this.sidebar.buildThumbs();
    this.view.scrollToPage(Math.min(cur, info.pages.length - 1));
    this.clearSearch();
    this.updateStatus();
  }
  refreshPage(key: number) { this.view.invalidate(key); this.sidebar.refreshThumb(key); }

  /* ───────────── 모드 ───────────── */
  async setMode(m: Mode) {
    if (m === this.mode) return;
    if (m === 'edit' && !this.doc) { toast('먼저 PDF를 여세요.'); return; }
    if (m === 'edit' && this.doc && (this.doc.info.permissions & 8) === 0 && this.doc.info.encrypted) {
      toast('이 문서는 작성자가 편집을 막아 두었습니다. 그래도 편집 기능은 쓸 수 있지만 원저작자의 뜻을 확인하세요.', 4200);
    }
    this.mode = m;
    this.root.classList.toggle('mode-edit', m === 'edit'); this.root.classList.toggle('mode-view', m === 'view');
    this.modeBtns.querySelectorAll('.mode-b').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.m === m)));
    if (m === 'edit') {
      if (!this.editor) {
        const b = busy('편집 도구를 불러오는 중…');
        try { const { Editor } = await import('./editor/editor.ts'); this.editor = new Editor(this); } finally { b.done(); }
      }
      this.view.clearSelection();
      this.ribbon.hidden = false;
      await this.editor!.activate();
    } else {
      this.editor?.deactivate();
      this.ribbon.hidden = true;
      this.view.interaction = null; this.view.decorate = null;
      this.view.el.style.cursor = '';
      this.view.refreshLinks();
    }
    this.sidebar.editable = m === 'edit';
    this.sidebar.buildThumbs();
    requestAnimationFrame(() => { if (this.view.fit) this.view.applyFit(true); });
    this.updateStatus();
  }

  /* ───────────── 이동 / 확대 ───────────── */
  goto(i: number) {
    if (!this.doc) return;
    const n = this.doc.info.pageCount;
    if (isNaN(i)) { this.onPage(this.view.current); return; }
    this.view.scrollToPage(Math.max(0, Math.min(n - 1, i)));
  }
  private onPage(i: number) {
    this.pageInput.value = this.doc ? String(i + 1) : '–';
    this.pageCount.textContent = '/ ' + (this.doc?.info.pageCount ?? '–');
    this.sidebar.markCurrent(i);
    this.updateStatus();
  }
  zoomPct() { return Math.round(this.view.zoom * 72 / 96 * 100); }
  private updateZoom() { this.zoomBtn.textContent = this.zoomPct() + '%'; this.updateStatus(); }
  zoomStep(dir: number) {
    const steps = [10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600];
    const p = this.zoomPct();
    const next = dir > 0 ? steps.find(s => s > p + 1) : [...steps].reverse().find(s => s < p - 1);
    if (next) this.view.setZoom(next / 100 * 96 / 72);
  }
  setFit(f: 'width' | 'page') { this.view.fit = f; this.view.applyFit(true); }
  private zoomMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const z = (p: number) => () => this.view.setZoom(p / 100 * 96 / 72);
    menu({ x: r.left, y: r.bottom + 4 }, [
      { label: '쪽 너비 맞춤', hint: 'Ctrl+2', action: () => this.setFit('width'), checked: this.view.fit === 'width' },
      { label: '쪽 전체 맞춤', hint: 'Ctrl+0', action: () => this.setFit('page'), checked: this.view.fit === 'page' },
      { label: '실제 크기', hint: 'Ctrl+1', action: z(100) }, '-',
      ...[50, 75, 100, 125, 150, 200, 300, 400].map(p => ({ label: p + '%', action: z(p), checked: !this.view.fit && this.zoomPct() === p })),
    ]);
  }
  toggleSidebar() { const show = this.sidebar.el.hidden; this.sidebar.el.hidden = !show; if (innerWidth >= 860) { this.prefs.sidebar = show; this.savePrefs(); } }
  private followLink(l: LinkInfo) {
    if (l.uri) {
      if (/^(https?|mailto):/i.test(l.uri)) this.platform.openUrl(l.uri);
      else toast('열 수 없는 링크입니다: ' + l.uri);
    } else if (l.page !== undefined) this.view.scrollToPage(l.page, l.top);
  }

  /* ───────────── 찾기 ───────────── */
  async search(q: string) {
    if (!this.doc) return;
    this.lastQuery = q; this.hits = []; this.hitByPage = new Map(); this.hitIdx = -1;
    this.engine.call('cancelSearch');
    this.sidebar.searchStart(q);
    if (this.sidebar.el.hidden) this.toggleSidebar();
    let jumped = false;
    const docId = this.doc.id;
    const res = await this.engine.call<{ cancelled: boolean; found: number }>('search', [docId, q, this.searchOpts], {
      progress: ({ hits, page, total }: { hits: SearchHit[]; page: number; total: number }) => {
        if (this.lastQuery !== q) return;
        if (hits.length) {
          this.sidebar.searchAdd(hits, this.hits.length);
          this.hits.push(...hits); this.hitByPage.set(page, hits);
          if (!jumped) {
            jumped = true;
            const fromCur = this.hits.findIndex(x => x.page >= this.view.current);
            this.gotoHit(fromCur >= 0 ? fromCur : 0);
          } else this.view.setHits(this.hitByPage, this.hits[this.hitIdx] || null);
        }
        this.sidebar.searchProgress(q, this.hits.length, page, total, false);
      },
    });
    if (this.lastQuery === q && !res.cancelled) {
      this.sidebar.searchProgress(q, this.hits.length, 0, 0, true);
      if (!this.hits.length) toast(`“${q}”을 찾지 못했습니다.`);
    }
  }
  gotoHit(n: number) {
    if (!this.hits.length) return;
    this.hitIdx = (n + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitIdx];
    this.view.setHits(this.hitByPage, hit);
    if (hit.rects[0]) { this.view.scrollToRect(hit.page, hit.rects[0]); }
    this.sidebar.markHit(this.hitIdx);
    this.status.querySelector('.st-hint')!.textContent = `찾기 ${this.hitIdx + 1} / ${this.hits.length}`;
  }
  /** 편집으로 문서가 바뀌면 찾기 결과 위치가 틀려지므로 지운다 */
  staleSearch() {
    if (!this.lastQuery && !this.hits.length) return;
    const q = this.lastQuery;
    this.clearSearch();
    this.sidebar.searchProgress(q, 0, 0, 0, true);
    (this.sidebar.panels.get('search')!.querySelector('.search-head') as HTMLElement).textContent = `문서가 바뀌어 “${q}” 찾기 결과를 지웠습니다. 찾기 칸에서 Enter를 누르면 다시 찾습니다.`;
    (this.sidebar.panels.get('search')!.querySelector('.search-list') as HTMLElement).innerHTML = '';
  }
  clearSearch() {
    this.engine.call('cancelSearch').catch(() => {});
    this.lastQuery = ''; this.hits = []; this.hitByPage = new Map(); this.hitIdx = -1;
    this.view.setHits(this.hitByPage, null);
  }

  /* ───────────── 메뉴 / 상태 표시줄 ───────────── */
  private mainMenu() {
    const btn = this.root.querySelector('.topbar .tb-group:last-child .tb:last-child') as HTMLElement;
    const r = btn.getBoundingClientRect();
    menu({ x: r.right - 240, y: r.bottom + 4 }, [
      { label: '열기…', icon: 'open', hint: 'Ctrl+O', action: () => this.pickAndOpen() },
      { label: '저장', icon: 'save', hint: 'Ctrl+S', action: () => this.save(false), disabled: !this.doc },
      { label: '다른 이름으로 저장…', icon: 'save', hint: 'Ctrl+Shift+S', action: () => this.save(true), disabled: !this.doc },
      { label: '인쇄…', icon: 'print', hint: 'Ctrl+P', action: () => this.print(), disabled: !this.doc }, '-',
      { label: '이미지로 PDF 만들기…', icon: 'image', action: () => import('./tools.ts').then(m => m.imagesToPdf(this)) },
      { label: '쪽을 이미지로 내보내기…', icon: 'extract', action: () => import('./tools.ts').then(m => m.exportImages(this)), disabled: !this.doc },
      { label: 'PDF 용량 줄이기…', icon: 'compress', action: () => import('./tools.ts').then(m => m.compressPdf(this)), disabled: !this.doc }, '-',
      { label: '문서 닫기', icon: 'close', hint: 'Ctrl+W', action: () => this.closeDoc(), disabled: !this.doc }, '-',
      { label: '두 쪽씩 보기', icon: 'spread', action: () => { this.prefs.spread = !this.prefs.spread; this.savePrefs(); this.view.setSpread(this.prefs.spread); }, checked: this.prefs.spread },
      { label: '야간 보기 (색 반전)', icon: 'moon', action: () => { this.prefs.night = !this.prefs.night; this.savePrefs(); this.view.setNight(this.prefs.night); }, checked: this.prefs.night },
      { label: '전체 화면', icon: 'full', hint: 'F11', action: () => this.platform.toggleFullscreen() },
      { label: '화면 테마: ' + ({ system: '시스템', light: '밝게', dark: '어둡게' } as any)[this.prefs.theme], icon: 'theme', action: () => { this.prefs.theme = this.prefs.theme === 'system' ? 'light' : this.prefs.theme === 'light' ? 'dark' : 'system'; this.applyTheme(); this.savePrefs(); } }, '-',
      { label: '문서 정보', icon: 'info', action: () => this.docInfo(), disabled: !this.doc },
      { label: '단축키', icon: 'keyboard', hint: 'F1', action: () => this.shortcuts() },
    ]);
  }
  updateStatus() {
    const d = this.doc;
    const selText = this.view.sel ? this.view.selectedText() : '';
    this.status.innerHTML = '';
    const parts: (Node | null)[] = [
      h('span', { class: 'st-mode ' + this.mode }, this.mode === 'edit' ? '편집 모드' : '보기 모드'),
      h('span', { class: 'st-pg' }, d ? `${this.view.current + 1} / ${d.info.pageCount}쪽` : '문서 없음'),
      d?.info.encrypted ? h('span', { class: 'st-lock', title: '암호로 보호된 문서' }, icon('lock'), '암호') : null,
      h('span', { class: 'st-hint' }, selText ? `${selText.length}자 선택됨 · Ctrl+C 복사` : (this.mode === 'edit' ? this.editor?.hint() : '') || (d ? (d.formType === 1 ? '입력란을 눌러 바로 입력 · ' : '') + '글자를 끌어 선택 · 빈 곳을 끌어 넘기기 · Ctrl+휠 확대' : '')),
      h('span', { class: 'st-sp' }),
      d && d.size ? h('span', { class: 'st-size' }, fmtSize(d.size)) : null,
      d ? h('span', { class: 'st-zoom' }, this.zoomPct() + '%') : null,
    ];
    this.status.append(...parts.filter((x): x is Node => !!x));
  }
  private docInfo() {
    const d = this.doc!; const i = d.info;
    const date = (s: string) => { const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s); return m ? `${m[1]}-${m[2] || '01'}-${m[3] || '01'} ${m[4] || '00'}:${m[5] || '00'}` : s || '—'; };
    const row = (k: string, v: string) => h('tr', {}, h('th', {}, k), h('td', {}, v || '—'));
    const p0 = i.pages[0];
    dialog({ title: '문서 정보', wide: true, body: h('table', { class: 'info-table' },
      row('파일', d.name), row('제목', i.title), row('작성자', i.author), row('주제', i.subject), row('만든 프로그램', i.creator), row('PDF 생성기', i.producer),
      row('만든 날', date(i.created)), row('고친 날', date(i.modified)), row('PDF 버전', i.version), row('쪽 수', String(i.pageCount)),
      row('첫 쪽 크기', p0 ? `${(p0.w / 72 * 25.4).toFixed(0)} × ${(p0.h / 72 * 25.4).toFixed(0)} mm` : ''), row('파일 크기', `${(d.size / 1048576).toFixed(2)} MB`),
      row('보안', i.encrypted ? '암호로 보호됨' : '없음')),
      buttons: [{ label: '닫기', value: true, primary: true }] });
  }
  shortcuts() {
    const rows: [string, string][] = [
      ['Ctrl+O', '열기'], ['Ctrl+S / Ctrl+Shift+S', '저장 / 다른 이름으로'], ['Ctrl+P', '인쇄'], ['Ctrl+W', '문서 닫기'],
      ['Ctrl+E', '보기 ↔ 편집 모드'], ['Ctrl+F, F3, Shift+F3', '찾기, 다음, 이전'], ['Ctrl+G', '쪽으로 이동'],
      ['N / P, Home / End', '다음·이전 쪽, 처음·끝'], ['Ctrl+= / Ctrl+-, Ctrl+휠', '확대 / 축소'], ['Ctrl+0 / 1 / 2', '쪽 맞춤 / 실제 크기 / 너비 맞춤'],
      ['Ctrl+C, Ctrl+A', '선택 글자 복사, 이 쪽 모두 선택'], ['F11, F12', '전체 화면, 탐색 패널'],
      ['편집: V T E I B', '선택, 글자 추가, 글자 고치기, 이미지, 표'], ['편집: H U S N D', '형광펜, 밑줄, 취소선, 메모, 펜'],
      ['편집: Ctrl+Z / Ctrl+Y', '되돌리기 / 다시 하기'], ['편집: Delete, 화살표', '선택한 것 지우기, 옮기기'],
    ];
    dialog({ title: '단축키', wide: true, body: h('table', { class: 'keys-table' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, ...k.split(', ').flatMap((x, i) => [i ? ', ' : '', h('kbd', {}, x)])), h('td', {}, v)))), buttons: [{ label: '닫기', value: true, primary: true }] });
  }
  private contextMenu(e: MouseEvent, page: number, x: number, y: number) {
    if (this.mode === 'edit' && this.editor?.contextMenu(e, page, x, y)) return;
    const sel = this.view.selectedText();
    menu({ x: e.clientX, y: e.clientY }, [
      { label: '복사', icon: 'copy', hint: 'Ctrl+C', action: () => this.copy(), disabled: !sel },
      { label: '이 쪽 글자 모두 선택', hint: 'Ctrl+A', action: () => this.view.selectAllOnPage(page) },
      { label: `“${sel.slice(0, 16)}${sel.length > 16 ? '…' : ''}” 찾기`, icon: 'search', action: () => { this.searchInput.value = sel; this.search(sel); }, disabled: !sel || sel.length > 80 }, '-',
      { label: '편집 모드로', icon: 'edit', hint: 'Ctrl+E', action: () => this.setMode('edit') },
    ]);
  }
  async copy() {
    const t = this.view.selectedText(); if (!t) return;
    try { await navigator.clipboard.writeText(t); toast(`${t.length}자를 복사했습니다.`); }
    catch { const ta = h('textarea', {}, t); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('복사했습니다.'); }
  }

  /* ───────────── 인쇄 ───────────── */
  async print() {
    const d = this.doc; if (!d) return;
    const n = d.info.pageCount;
    if (n > 60 && !(await confirmBox('인쇄', `${n}쪽을 인쇄용으로 준비합니다. 시간이 조금 걸릴 수 있습니다.`, '계속'))) return;
    const b = busy('인쇄 준비 중…');
    const root = h('div', { id: 'print-root' });
    try {
      for (let i = 0; i < n; i++) {
        b.set(`인쇄 준비 중… ${i + 1}/${n}쪽`);
        const p = d.info.pages[i];
        const r: any = await this.engine.call('render', [d.id, i, 150 / 72]);
        const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
        const ctx = c.getContext('2d')!;
        if (r.bitmap) { ctx.drawImage(r.bitmap, 0, 0); r.bitmap.close(); } else ctx.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
        const blob: Blob = await new Promise(res => c.toBlob(bb => res(bb!), 'image/jpeg', 0.92));
        root.append(h('img', { src: URL.createObjectURL(blob), class: p.w > p.h ? 'land' : '' }));
      }
    } finally { b.done(); }
    document.body.append(root);
    const cleanup = () => { root.querySelectorAll('img').forEach(i => URL.revokeObjectURL((i as HTMLImageElement).src)); root.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    await Promise.all([...root.querySelectorAll('img')].map(i => (i as HTMLImageElement).decode().catch(() => {})));
    window.print();
    setTimeout(cleanup, 60_000);
  }

  /* ───────────── 키보드 / 끌어다 놓기 ───────────── */
  private bindKeys() {
    document.addEventListener('keydown', e => {
      const t = e.target as HTMLElement;
      const typing = t.matches('input, textarea, select, [contenteditable]');
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (document.querySelector('.modal-back')) return;
      if (mod && k === 'o') { e.preventDefault(); this.pickAndOpen(); return; }
      if (mod && k === 's') { e.preventDefault(); this.save(e.shiftKey); return; }
      if (mod && k === 'p') { e.preventDefault(); this.print(); return; }
      if (mod && k === 'w') { e.preventDefault(); this.closeDoc(); return; }
      if (mod && e.key === 'Tab') { e.preventDefault(); this.cycleTab(e.shiftKey ? -1 : 1); return; }
      if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); this.cycleTab(e.key === 'PageDown' ? 1 : -1); return; }
      if (mod && k === 'e') { e.preventDefault(); this.setMode(this.mode === 'edit' ? 'view' : 'edit'); return; }
      if (mod && k === 'f') { e.preventDefault(); this.searchInput.focus(); this.searchInput.select(); const s = this.view.selectedText(); if (s && s.length < 80) this.searchInput.value = s; return; }
      if (mod && k === 'g') { e.preventDefault(); this.pageInput.focus(); return; }
      if (e.key === 'F3') { e.preventDefault(); if (this.hits.length) this.gotoHit(this.hitIdx + (e.shiftKey ? -1 : 1)); else this.searchInput.focus(); return; }
      if (e.key === 'F11') { e.preventDefault(); this.platform.toggleFullscreen(); return; }
      if (e.key === 'F12') { e.preventDefault(); this.toggleSidebar(); return; }
      if (e.key === 'F1') { e.preventDefault(); this.shortcuts(); return; }
      if (typing) return;
      if (this.mode === 'edit' && this.editor?.key(e)) return;
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomStep(1); return; }
      if (mod && k === '-') { e.preventDefault(); this.zoomStep(-1); return; }
      if (mod && k === '0') { e.preventDefault(); this.setFit('page'); return; }
      if (mod && k === '1') { e.preventDefault(); this.view.setZoom(96 / 72); return; }
      if (mod && k === '2') { e.preventDefault(); this.setFit('width'); return; }
      if (mod && k === 'c') { if (this.view.sel) { e.preventDefault(); this.copy(); } return; }
      if (mod && k === 'a') { e.preventDefault(); this.view.selectAllOnPage(this.view.current); return; }
      if (mod) return;
      if (!this.doc) return;
      if (k === 'n' || (e.key === 'ArrowRight' && this.view.el.scrollWidth <= this.view.el.clientWidth)) { e.preventDefault(); this.goto(this.view.current + 1); }
      else if (k === 'p' || (e.key === 'ArrowLeft' && this.view.el.scrollWidth <= this.view.el.clientWidth)) { e.preventDefault(); this.goto(this.view.current - 1); }
      else if (e.key === 'Home') { e.preventDefault(); this.goto(0); }
      else if (e.key === 'End') { e.preventDefault(); this.goto(this.doc.info.pageCount - 1); }
      else if (k === 'j') this.view.el.scrollTop += 60;
      else if (k === 'k') this.view.el.scrollTop -= 60;
      else if (e.key === 'Escape') { this.view.clearSelection(); this.clearSearch(); }
      else if (e.key === '?') this.shortcuts();
    });
  }
  private bindDrop() {
    let depth = 0;
    const zone = h('div', { class: 'dropzone', hidden: true }, h('div', {}, icon('open'), h('span', {}, 'PDF는 새 탭으로 열고, 이미지는 PDF로 만듭니다')));
    document.body.append(zone);
    const isFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', e => { if (!isFiles(e)) return; depth++; zone.hidden = false; });
    window.addEventListener('dragleave', e => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; zone.hidden = true; } });
    window.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async e => {
      if (!isFiles(e)) return;
      e.preventDefault(); depth = 0; zone.hidden = true;
      const files = [...e.dataTransfer!.files];
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      const imgs = files.filter(f => f.type.startsWith('image/'));
      if (pdfs.length) this.openFiles(await Promise.all(pdfs.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      else if (imgs.length && this.mode === 'edit' && this.doc) this.editor?.dropImages(imgs);
      else if (imgs.length) import('./tools.ts').then(m => m.imagesToPdf(this, imgs));
      else if (files.length) toast('PDF나 이미지 파일만 열 수 있습니다.');
    });
  }
}
export { esc, $ };
