import type { EngineClient } from './engine/client.ts';
import type { DocInfo, LinkInfo, OutlineItem, SearchHit } from './engine/types.ts';
import { FormLayer } from './viewer/forms.ts';
import { Shortcuts } from './shortcuts.ts';
import type { Batch, BatchMode, OpenedFile, Platform, SavedTarget, UpdateInfo } from './platform/types.ts';
import { baseName } from './platform/types.ts';
import { DocView } from './viewer/docview.ts';
import { Sidebar } from './viewer/sidebar.ts';
import { Organizer } from './viewer/organizer.ts';
import { $, busy, confirmBox, dialog, esc, h, hscroll, icon, menu, promptBox, toast } from './ui/dom.ts';
import type { Editor } from './editor/editor.ts';
import THEMES from './theme-list.json';

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
  organizer!: Organizer;
  shortcuts: Shortcuts;
  private tabbar!: HTMLElement; private tabbarWrap!: HTMLElement; ribbonWrap!: HTMLElement;
  mode: Mode = 'view';
  editor: Editor | null = null;
  private start: HTMLElement;
  private winTitle!: HTMLElement;
  private pageInput!: HTMLInputElement; private pageCount!: HTMLElement; private zoomBtn!: HTMLButtonElement;
  private searchInput!: HTMLInputElement; private saveBtn!: HTMLButtonElement; private modeBtns!: HTMLElement;
  private hits: SearchHit[] = []; private hitByPage = new Map<number, SearchHit[]>(); private hitIdx = -1; private lastQuery = '';
  private searchOpts = { matchCase: false, wholeWord: false };
  prefs: { theme: string; spread: boolean; night: boolean; sidebar: boolean; author: string; shortcuts?: Record<string, string[]>; autoUpdate?: boolean; accent?: string; scanSuggest?: boolean; scanDefault?: { correct: boolean; ocr: boolean } } = { theme: 'system', spread: false, night: false, sidebar: true, author: '' };

  constructor(engine: EngineClient, platform: Platform) {
    this.engine = engine; this.platform = platform;
    try { Object.assign(this.prefs, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch { /* 기본값 */ }
    this.applyTheme();
    this.shortcuts = new Shortcuts(this.prefs.shortcuts || {}, c => { this.prefs.shortcuts = c; this.savePrefs(); });
    this.root = h('div', { id: 'app', class: 'mode-view no-doc' });
    const top = this.buildTopbar();
    this.ribbon = h('div', { class: 'ribbon' });
    this.stage = h('div', { class: 'stage' });
    const main = h('div', { class: 'main' }, this.stage);
    this.status = h('footer', { class: 'statusbar' });
    this.tabbar = h('div', { class: 'tabbar', role: 'tablist' });
    this.tabbarWrap = h('div', { class: 'tabbar-wrap', hidden: true }, this.tabbar);
    hscroll(this.tabbarWrap, this.tabbar);
    this.ribbonWrap = h('div', { class: 'ribbon-wrap', hidden: true }, this.ribbon);
    hscroll(this.ribbonWrap, this.ribbon);
    this.root.append(top, this.tabbarWrap, this.ribbonWrap, main, this.status);
    document.body.append(this.root);
    this.view = new DocView(this.stage, engine);
    this.sidebar = new Sidebar(main, this.view);
    this.organizer = new Organizer(this, main);
    this.sidebar.onOrganize = () => this.organizer.toggle();
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
    // 페이지 목록 편집은 보기 모드에서도 된다 (되돌리기 기록은 편집기와 함께 쓴다)
    this.sidebar.onMovePage = (key, to) => this.pageEditor().then(ed => ed.movePage(key, to));
    this.sidebar.onThumbMenu = (e, i) => this.pageEditor().then(ed => ed.thumbMenu(e, i));
    this.sidebar.onDeleteKey = () => this.pageEditor().then(ed => ed.deletePages());
    this.sidebar.onDropFiles = async (files, at) => {
      const ed = await this.pageEditor();
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
      const imgs = files.filter(f => f.type.startsWith('image/'));
      if (pdfs.length) await ed.mergePdf(await Promise.all(pdfs.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), at);
      if (imgs.length) await ed.imagePages(imgs, at);
      if (!pdfs.length && !imgs.length) toast('PDF나 이미지 파일만 넣을 수 있습니다.');
    };
    this.bindKeys();
    this.bindDrop();
    // 엔진이 메모리를 아끼려고 페이지를 닫으면, 그 페이지에 대해 기억해 둔 객체 번호를 버린다
    engine.onEvent(e => {
      if (e.event !== 'evict') return;
      if (this.doc?.id === e.docId) this.editor?.dropPage(e.key);
      else { const t = this.tabs.find(x => x.id === e.docId); const st: any = t?.editorState; if (st) { st.runs?.delete(e.key); st.objs?.delete(e.key); st.annots?.delete(e.key); } }
    });
    platform.onExternalOpen(b => this.handleBatch(b));
    platform.onCloseRequest(async () => {
      const dirty = this.tabs.filter(t => t.dirty);
      return !dirty.length || await confirmBox('저장하지 않은 변경 사항', `${dirty.map(t => '“' + t.name + '”').join(', ')}에 저장하지 않은 편집 내용이 있습니다. 저장하지 않고 닫을까요?`, '저장하지 않고 닫기', true);
    });
    this.updateStatus();
    if (platform.checkUpdate && this.prefs.autoUpdate !== false) setTimeout(() => this.checkUpdate(false), 4000);
  }
  /* ───────────── 탐색기에서 넘어온 일 ───────────── */
  private batchBuf: { mode: BatchMode; files: OpenedFile[] } | null = null; private batchT = 0; private batchDone: (() => void) | null = null;
  /** 여러 파일을 선택해 탐색기 메뉴를 누르면 파일마다 따로 들어오므로, 잠깐 모았다가 한 번에 처리한다 */
  async handleBatch(b: Batch) {
    if (!b.mode) { if (b.files.length) await this.openFiles(b.files); return; }
    if (this.batchBuf && this.batchBuf.mode !== b.mode) this.flushBatch();
    if (!this.batchBuf) { this.batchBuf = { mode: b.mode, files: [] }; this.batchDone = this.loading('탐색기에서 선택한 파일을 모으는 중…'); }
    for (const f of b.files) if (!this.batchBuf.files.some(x => x.path && x.path === f.path)) this.batchBuf.files.push(f);
    clearTimeout(this.batchT); this.batchT = window.setTimeout(() => this.flushBatch(), 1200);
  }
  private flushBatch() {
    const b = this.batchBuf; this.batchBuf = null; clearTimeout(this.batchT); this.batchDone?.(); this.batchDone = null;
    if (!b?.files.length) return;
    const by = (a: OpenedFile, c: OpenedFile) => a.name.localeCompare(c.name, 'ko', { numeric: true });
    const files = [...b.files].sort(by);
    import('./tools.ts').then(m => {
      if (b.mode === 'merge') return files.length > 1 ? m.mergeFiles(this, files) : this.openFiles(files);
      if (b.mode === 'split') return m.splitPdf(this, files);
      if (b.mode === 'to-images') return m.pdfsToImages(this, files);
      if (b.mode === 'to-pdf') {
        const imgs = files.filter(f => !/\.pdf$/i.test(f.name)).map(f => new File([f.bytes as BlobPart], f.name));
        return imgs.length ? m.imagesToPdf(this, imgs) : this.openFiles(files);
      }
    });
  }
  /* ───────────── 업데이트 / 기본 프로그램 ───────────── */
  async checkUpdate(manual: boolean) {
    const P = this.platform; if (!P.checkUpdate) return;
    let u: UpdateInfo | null = null;
    try { u = await P.checkUpdate(); }
    catch (e: any) { if (manual) toast('업데이트를 확인하지 못했습니다: ' + (e?.message || e)); return; }
    if (!u) { if (manual) toast(`최신 버전입니다 (${await P.version?.() || ''}).`); return; }
    const info = u;
    document.querySelector('.update-bar')?.remove();
    const bar = h('div', { class: 'update-bar', role: 'status' },
      h('span', {}, '새 버전 ', h('b', {}, info.version), '이 나왔습니다.'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => bar.remove() }, '나중에'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => this.installUpdate(info, bar) }, '지금 업데이트'));
    if (info.notes) bar.title = info.notes;
    document.body.append(bar);
  }
  private async installUpdate(u: UpdateInfo, bar: HTMLElement) {
    if (this.tabs.some(t => t.dirty) && !await confirmBox('업데이트', '저장하지 않은 문서가 있습니다. 업데이트하면 프로그램이 다시 시작되어 편집 내용이 사라집니다. 계속할까요?', '업데이트', true)) return;
    bar.remove();
    const b = busy('업데이트를 받는 중…');
    try { await u.install((done, total) => b.set(total ? `업데이트를 받는 중… ${Math.round(done / total * 100)}%` : `업데이트를 받는 중… ${Math.round(done / 1048576)}MB`)); }
    catch (e: any) { b.done(); toast('업데이트하지 못했습니다: ' + (e?.message || e)); }
  }
  async makeDefault() {
    const D = this.platform.defaultApp; if (!D) return;
    try {
      await D.make();
      await dialog({ title: '기본 PDF 프로그램', body: h('div', { class: 'form' },
        h('p', {}, 'Windows 설정의 “기본 앱” 화면을 열었습니다.'),
        h('p', {}, '“.pdf” 항목을 눌러 ', h('b', {}, 'Air PDF'), '를 선택하면 끝납니다. (Windows는 보안상 프로그램이 직접 바꾸지 못하게 되어 있습니다.)'),
        h('p', { class: 'hint' }, '설정 화면이 열리지 않으면: PDF 파일을 오른쪽 단추로 누르고 → 연결 프로그램 → 다른 앱 선택 → Air PDF → “항상”을 누르세요.')),
        buttons: [{ label: '확인', value: true, primary: true }] });
    } catch (e: any) { toast(String(e?.message || e)); }
  }
  savePrefs() { try { localStorage.setItem(PREF, JSON.stringify(this.prefs)); } catch { /* */ } }
  applyTheme() {
    const t = this.prefs.theme, el = document.documentElement;
    if (t === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', t);
    const a = this.prefs.accent || 'air';
    if (a === 'blue') el.removeAttribute('data-accent'); else el.setAttribute('data-accent', a);
  }
  /** 테마: 밝기 + 강조색. 선택하는 즉시 바뀌고, 취소하면 되돌린다 */
  async themeDialog() {
    const before = { theme: this.prefs.theme, accent: this.prefs.accent };
    const body = h('div', { class: 'form' });
    const draw = () => {
      body.innerHTML = '';
      const modes: [string, string, string][] = [['system', '시스템 설정 따르기', 'linear-gradient(90deg,#f4f5f8 50%,#1d2027 50%)'], ['light', '밝게', '#f4f5f8'], ['dark', '어둡게', '#1d2027']];
      body.append(h('label', { class: 'lbl' }, '화면 밝기'), h('div', { class: 'theme-row' }, ...modes.map(([v, l, bg]) =>
        h('button', { class: 'theme-opt', type: 'button', 'aria-pressed': String(this.prefs.theme === v), onclick: () => { this.prefs.theme = v; this.applyTheme(); draw(); } }, h('span', { class: 'theme-mode', style: { background: bg } }), l))));
      const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (this.prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      body.append(h('label', { class: 'lbl' }, '강조색'), h('div', { class: 'theme-row' }, ...Object.entries(THEMES).map(([k, v]: [string, any]) =>
        h('button', { class: 'theme-opt', type: 'button', 'aria-pressed': String((this.prefs.accent || 'air') === k), onclick: () => { this.prefs.accent = k; this.applyTheme(); draw(); } }, h('span', { class: 'theme-dot', style: { background: dark ? v.dark : v.light } }), v.name))));
      body.append(h('p', { class: 'hint' }, '편집 모드의 주황색 띠는 “고치는 중”을 알리는 표시라 그대로 둡니다.'));
    };
    draw();
    const r = await dialog({ title: '테마', body, wide: true, buttons: [{ label: '취소', value: false }, { label: '적용', value: true, primary: true }] });
    if (r?.value) this.savePrefs(); else { this.prefs.theme = before.theme; this.prefs.accent = before.accent; this.applyTheme(); }
  }
  /** 설정: 자주 바꾸는 것들을 한곳에 */
  async settings() {
    const P = this.prefs;
    const cb = (on: boolean) => h('input', { type: 'checkbox', checked: on ? '' : undefined }) as HTMLInputElement;
    const sug = cb(P.scanSuggest !== false), defC = cb(P.scanDefault?.correct ?? true), defO = cb(P.scanDefault?.ocr ?? true);
    const upd = cb(P.autoUpdate !== false);
    const author = h('input', { class: 'field', value: P.author || '', placeholder: '사용자', 'aria-label': '주석 작성자 이름' }) as HTMLInputElement;
    const row = (label: string, sub: string, ctl: Node) => h('label', { class: 'set-row' }, h('span', {}, label, sub ? h('small', {}, sub) : null), ctl);
    const btnRow = (label: string, sub: string, text: string, fn: () => void) => h('div', { class: 'set-row' }, h('span', {}, label, sub ? h('small', {}, sub) : null), h('button', { class: 'btn sm', type: 'button', onclick: fn }, text));
    const body = h('div', { class: 'settings' },
      h('section', { class: 'set-sec' }, h('h3', {}, '화면'),
        btnRow('테마', '밝기와 강조색', '테마 바꾸기…', () => this.themeDialog()),
        btnRow('단축키', '보기·바꾸기 (F1)', '단축키…', () => this.showShortcuts())),
      h('section', { class: 'set-sec' }, h('h3', {}, '이미지 → PDF'),
        row('만들 때 문서 보정·글자 인식 제안 보기', '“다시 묻지 않기”로 숨긴 제안을 다시 켭니다', sug),
        row('문서 보정 (제안을 숨겼을 때 기본값)', '반듯하게 펴기, 기울기·그늘·대비 바로잡기', defC),
        row('글자 인식 OCR (제안을 숨겼을 때 기본값)', '찾기·복사가 되도록 글자층을 얹기', defO)),
      h('section', { class: 'set-sec' }, h('h3', {}, '편집'),
        row('주석 작성자 이름', '메모·형광펜 등에 적힙니다', author)),
      this.platform.checkUpdate || this.platform.defaultApp ? h('section', { class: 'set-sec' }, h('h3', {}, '프로그램'),
        this.platform.checkUpdate ? row('자동으로 업데이트 확인', '켤 때 새 버전이 있는지 확인합니다', upd) : null,
        this.platform.defaultApp ? btnRow('기본 PDF 프로그램', 'PDF 파일을 Air PDF로 열기', '지정하기…', () => this.makeDefault()) : null) : null);
    const r = await dialog({ title: '설정', body, wide: true, buttons: [{ label: '취소', value: false }, { label: '저장', value: true, primary: true }] });
    if (!r?.value) return;
    P.scanSuggest = sug.checked; P.scanDefault = { correct: defC.checked, ocr: defO.checked };
    P.autoUpdate = upd.checked; P.author = author.value.trim();
    this.engine.call('setAuthor', [P.author || '사용자']).catch(() => {});
    this.savePrefs(); toast('설정을 저장했습니다.');
  }
  /** Air PDF 정보: 버전, 업데이트 확인 */
  async about() {
    const ver = this.platform.version ? await this.platform.version().catch(() => '') : '';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (this.prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const body = h('div', { class: 'about' }, h('img', { src: dark ? 'logo-dark.png' : 'logo.png', alt: 'Air PDF' }),
      h('p', { class: 'start-slogan' }, '문서는 가볍게, 작업은 자유롭게'),
      h('p', { class: 'ver' }, ver ? `버전 ${ver}` : '웹판'),
      h('p', { class: 'hint' }, 'PDFium 엔진 · MIT 라이선스'));
    const r = await dialog({ title: 'Air PDF 정보', body, buttons: [
      { label: 'GitHub 페이지', value: 'gh', left: true },
      ...(this.platform.checkUpdate ? [{ label: '업데이트 확인', value: 'up' }] : []),
      { label: '닫기', value: 'close', primary: true }] });
    if (r?.value === 'gh') this.platform.openUrl('https://github.com/Geek-ohmtech/air-pdf');
    else if (r?.value === 'up') this.checkUpdate(true);
  }

  /* ───────────── 화면 구성 ───────────── */
  private tb(ic: Parameters<typeof icon>[0], title: string, onclick: () => void, extra: Record<string, any> = {}) {
    return h('button', { class: 'tb', type: 'button', title, 'aria-label': title, onclick, ...extra }, icon(ic));
  }
  private buildTopbar() {
    this.pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', value: '–', 'aria-label': '페이지 번호', title: '페이지 번호 (Ctrl+G)' });
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
    const inner = h('div', { class: 'tb-inner' },
      h('div', { class: 'tb-group' },
        this.tb('sidebar', '탐색 패널 (F12)', () => this.toggleSidebar()),
        h('span', { class: 'brand' }, h('img', { class: 'brand-mark', src: 'icon-64.png', alt: '' }), h('span', { class: 'brand-name' }, 'Air PDF')),
        this.tb('open', '열기 (Ctrl+O)', () => this.pickAndOpen()),
        this.saveBtn),
      h('div', { class: 'tb-group nav-group needs-doc' },
        this.tb('prev', '이전 페이지 (P)', () => this.goto(this.view.current - 1)),
        h('label', { class: 'page-box' }, this.pageInput, this.pageCount),
        this.tb('next', '다음 페이지 (N)', () => this.goto(this.view.current + 1))),
      h('div', { class: 'tb-group needs-doc zoom-group' },
        this.tb('minus', '축소 (Ctrl+-)', () => this.zoomStep(-1)),
        this.zoomBtn,
        this.tb('plus', '확대 (Ctrl+=)', () => this.zoomStep(1)),
        this.tb('fit', '페이지 너비 맞춤 (Ctrl+2)', () => this.setFit('width'))),
      h('div', { class: 'tb-spacer', 'data-tauri-drag-region': '' }, this.winTitle = h('span', { class: 'win-title', 'data-tauri-drag-region': '' })),
      h('div', { class: 'search-box needs-doc' }, icon('search'), this.searchInput, optBtn('Aa', 'matchCase', '대소문자 구분'), optBtn('낱말', 'wholeWord', '낱말 단위')),
      h('div', { class: 'tb-group' }, this.modeBtns, h('button', { class: 'tb more-btn', type: 'button', title: '메뉴', 'aria-label': '메뉴', onclick: () => this.mainMenu() }, icon('more'))));
    // 설치판: 운영체제 제목 표시줄 대신 이 줄이 제목 표시줄이다 (빈 곳을 끌어 창 옮기기, 두 번 눌러 최대화)
    const W = this.platform.win;
    const scroll = h('div', { class: 'tb-scroll' }, inner);
    const head = h('header', { class: 'topbar' + (W ? ' titlebar' : '') }, scroll);
    hscroll(scroll, inner);
    if (W) {
      for (const el of [head, scroll, inner]) el.setAttribute('data-tauri-drag-region', '');
      const svg = (d: string) => h('span', { class: 'wc-ico', html: `<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1">${d}</svg>` });
      const maxIco = '<rect x="0.5" y="0.5" width="9" height="9"/>', restoreIco = '<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7h-2"/>';
      const maxBtn = h('button', { class: 'wc', type: 'button', title: '최대화', 'aria-label': '최대화', onclick: () => W.toggleMaximize() }, svg(maxIco));
      const sync = () => W.isMaximized().then(m => { maxBtn.innerHTML = ''; maxBtn.append(svg(m ? restoreIco : maxIco)); maxBtn.title = m ? '이전 크기로' : '최대화'; head.classList.toggle('maxed', m); }).catch(() => {});
      W.onResized(sync); sync();
      head.append(h('div', { class: 'win-ctl' },
        h('button', { class: 'wc', type: 'button', title: '최소화', 'aria-label': '최소화', onclick: () => W.minimize() }, svg('<path d="M0 5.5h10"/>')),
        maxBtn,
        h('button', { class: 'wc close', type: 'button', title: '닫기', 'aria-label': '닫기', onclick: () => W.close() }, svg('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'))));
      document.documentElement.classList.add('custom-titlebar');
    }
    return head;
  }
  private buildStart() {
    const recent = this.platform.recent();
    return h('div', { class: 'start' },
      h('div', { class: 'start-card' },
        h('h1', { class: 'start-logo' }, h('img', { class: 'logo-light', src: 'logo.png', alt: 'Air PDF' }), h('img', { class: 'logo-dark', src: 'logo-dark.png', alt: 'Air PDF' })),
        h('p', { class: 'start-slogan' }, '문서는 가볍게, 작업은 자유롭게'),
        h('p', { class: 'start-sub' }, '빠르게 보고, 필요할 때만 편집 모드로 수정합니다.'),
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
    const done = this.loading(files.length > 1 ? `문서 ${files.length}개를 여는 중…` : `“${files[0]?.name}” 여는 중…`);
    try { for (const f of files) await this.openOne(f, unsaved); }
    finally { requestAnimationFrame(done); }
  }
  /** 위쪽 로딩 바 (짧게 끝나면 보이지 않는다). 끝나면 돌려받은 함수를 부른다 */
  loading(label: string) {
    let bar = document.getElementById('load-bar');
    if (!bar) { bar = h('div', { id: 'load-bar', class: 'load-bar', role: 'progressbar', 'aria-label': '불러오는 중' }, h('i', {})); document.body.append(bar); }
    const n = +(bar.dataset.n || 0) + 1; bar.dataset.n = String(n); bar.title = label; bar.classList.add('on');
    const st = this.status.querySelector('.st-hint') as HTMLElement | null, prev = st?.textContent;
    if (st) st.textContent = label;
    let ended = false;
    return () => {
      if (ended) return; ended = true;
      const m = +(bar!.dataset.n || 1) - 1; bar!.dataset.n = String(m);
      if (m <= 0) bar!.classList.remove('on');
      if (st && st.textContent === label) { st.textContent = prev || ''; this.updateStatus(); }
    };
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
    if (this.doc) await this.stash(this.doc); // 입력 중이던 글자를 먼저 그 문서에 넣고 바꾼다
    if (this.doc === tab) return;
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
    this.organizer.refresh();
    this.sidebar.setOutline(tab.outline || []);
    if (!tab.outline) this.engine.call<OutlineItem[]>('outline', [tab.id]).then(o => { tab.outline = o; if (this.doc === tab) this.sidebar.setOutline(o); }).catch(() => {});
    this.clearSearch();
    this.editor?.loadState(tab.editorState);
    this.renderTabs();
    this.updateTitle(); this.updateStatus(); this.onPage(this.view.current);
    this.view.el.focus();
  }
  private async stash(tab: DocState) {
    await this.editor?.commitPending();
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
      await this.editor?.commitPending();
      this.doc = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) await this.activate(next);
      else {
        if (this.mode === 'edit') await this.setMode('view');
        this.forms.reset();
        this.view.setDoc(0, []);
        this.sidebar.buildThumbs(); this.sidebar.setOutline([]);
        this.root.classList.add('no-doc'); this.start.hidden = false; this.organizer.hide();
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
    this.tabbarWrap.hidden = this.tabs.length < 2;
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
    if (this.winTitle) { this.winTitle.textContent = d ? d.name : ''; this.winTitle.classList.toggle('dirty', !!d?.dirty); this.winTitle.title = d ? (d.target?.path || d.name) + (d.dirty ? ' (저장하지 않음)' : '') : ''; }
    this.saveBtn.hidden = !d?.dirty;
    (window as any).__dirty = this.tabs.some(t => t.dirty);
  }
  /** 페이지 구성이 바뀐 뒤(삭제·이동·합치기) 다시 읽기 */
  async reloadPages(keepIndex?: number) {
    if (!this.doc) return;
    this.editor?.dropCaches(); // 페이지 구조가 바뀌면 페이지마다 기억한 객체 번호는 쓸 수 없다
    const info = await this.engine.call<DocInfo>('info', [this.doc.id]);
    this.doc.info = info;
    const cur = keepIndex ?? this.view.current;
    this.view.setPages(info.pages);
    this.sidebar.selected.forEach(k => { if (!info.pages.some(p => p.key === k)) this.sidebar.selected.delete(k); });
    this.sidebar.buildThumbs();
    this.organizer.refresh();
    this.view.scrollToPage(Math.min(cur, info.pages.length - 1));
    this.clearSearch();
    this.updateStatus();
  }
  refreshPage(key: number) { this.view.invalidate(key); this.sidebar.refreshThumb(key); }

  /** 편집 기능(페이지 다루기·되돌리기)을 보기 모드에서도 쓰기 위해 편집기를 불러 둔다 */
  async pageEditor(): Promise<Editor> {
    if (!this.editor) { const { Editor } = await import('./editor/editor.ts'); this.editor = new Editor(this); this.editor.loadState(this.doc?.editorState); }
    return this.editor;
  }

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
        try { await this.pageEditor(); } finally { b.done(); }
      }
      this.view.clearSelection();
      this.ribbonWrap.hidden = false;
      await this.editor!.activate();
    } else {
      this.editor?.deactivate();
      this.ribbonWrap.hidden = true;
      this.view.interaction = null; this.view.decorate = null;
      this.view.el.style.cursor = '';
      this.view.refreshLinks();
    }
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
      { label: '페이지 너비 맞춤', hint: 'Ctrl+2', action: () => this.setFit('width'), checked: this.view.fit === 'width' },
      { label: '페이지 전체 맞춤', hint: 'Ctrl+0', action: () => this.setFit('page'), checked: this.view.fit === 'page' },
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
    const btn = this.root.querySelector('.topbar .more-btn') as HTMLElement;
    const r = btn.getBoundingClientRect();
    menu({ x: r.right - 240, y: r.bottom + 4 }, [
      { label: '열기…', icon: 'open', hint: 'Ctrl+O', action: () => this.pickAndOpen() },
      { label: '저장', icon: 'save', hint: 'Ctrl+S', action: () => this.save(false), disabled: !this.doc },
      { label: '다른 이름으로 저장…', icon: 'save', hint: 'Ctrl+Shift+S', action: () => this.save(true), disabled: !this.doc },
      { label: '인쇄…', icon: 'print', hint: 'Ctrl+P', action: () => this.print(), disabled: !this.doc }, '-',
      { label: '이미지로 PDF 만들기…', icon: 'image', action: () => import('./tools.ts').then(m => m.imagesToPdf(this)) },
      { label: '페이지를 이미지로 내보내기…', icon: 'extract', action: () => import('./tools.ts').then(m => m.exportImages(this)), disabled: !this.doc },
      { label: 'PDF 용량 줄이기…', icon: 'compress', action: () => import('./tools.ts').then(m => m.compressPdf(this)), disabled: !this.doc },
      { label: 'PDF 나누기…', icon: 'split', hint: this.shortcuts.label('split'), action: () => import('./tools.ts').then(m => m.splitPdf(this)), disabled: !this.doc },
      { label: 'PDF 여러 개 합치기…', icon: 'merge', action: () => import('./tools.ts').then(m => m.mergeFiles(this)) }, '-',
      { label: '문서 닫기', icon: 'close', hint: 'Ctrl+W', action: () => this.closeDoc(), disabled: !this.doc }, '-',
      { label: '두 페이지씩 보기', icon: 'spread', action: () => { this.prefs.spread = !this.prefs.spread; this.savePrefs(); this.view.setSpread(this.prefs.spread); }, checked: this.prefs.spread },
      { label: '야간 보기 (색 반전)', icon: 'moon', action: () => { this.prefs.night = !this.prefs.night; this.savePrefs(); this.view.setNight(this.prefs.night); }, checked: this.prefs.night },
      { label: '전체 화면', icon: 'full', hint: 'F11', action: () => this.platform.toggleFullscreen() },
      { label: '테마…', icon: 'theme', hint: ({ system: '시스템', light: '밝게', dark: '어둡게' } as any)[this.prefs.theme], action: () => this.themeDialog() }, '-',
      { label: '문서 정보', icon: 'info', action: () => this.docInfo(), disabled: !this.doc },
      { label: '설정…', icon: 'settings', hint: this.shortcuts.label('settings'), action: () => this.settings() },
      { label: '단축키', icon: 'keyboard', hint: 'F1', action: () => this.showShortcuts() },
      { label: 'Air PDF 정보', icon: 'info', action: () => this.about() },
      ...(this.platform.defaultApp ? ['-' as const, { label: '기본 PDF 프로그램으로 지정…', icon: 'pin' as const, action: () => this.makeDefault() }] : []),
      ...(this.platform.checkUpdate ? [{ label: '업데이트 확인', icon: 'update' as const, action: () => this.checkUpdate(true) },] : []),
    ]);
  }
  updateStatus() {
    const d = this.doc;
    const selText = this.view.sel ? this.view.selectedText() : '';
    this.status.innerHTML = '';
    const parts: (Node | null)[] = [
      h('span', { class: 'st-mode ' + this.mode }, this.mode === 'edit' ? '편집 모드' : '보기 모드'),
      h('span', { class: 'st-pg' }, d ? `${this.view.current + 1} / ${d.info.pageCount}페이지` : '문서 없음'),
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
      row('만든 날', date(i.created)), row('수정한 날', date(i.modified)), row('PDF 버전', i.version), row('페이지 수', String(i.pageCount)),
      row('첫 페이지 크기', p0 ? `${(p0.w / 72 * 25.4).toFixed(0)} × ${(p0.h / 72 * 25.4).toFixed(0)} mm` : ''), row('파일 크기', `${(d.size / 1048576).toFixed(2)} MB`),
      row('보안', i.encrypted ? '암호로 보호됨' : '없음')),
      buttons: [{ label: '닫기', value: true, primary: true }] });
  }
  showShortcuts() { this.shortcuts.openDialog(); }
  private contextMenu(e: MouseEvent, page: number, x: number, y: number) {
    if (this.mode === 'edit' && this.editor?.contextMenu(e, page, x, y)) return;
    const sel = this.view.selectedText();
    menu({ x: e.clientX, y: e.clientY }, [
      { label: '복사', icon: 'copy', hint: 'Ctrl+C', action: () => this.copy(), disabled: !sel },
      { label: '이 페이지 글자 모두 선택', hint: 'Ctrl+A', action: () => this.view.selectAllOnPage(page) },
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
    if (n > 60 && !(await confirmBox('인쇄', `${n}페이지를 인쇄용으로 준비합니다. 시간이 조금 걸릴 수 있습니다.`, '계속'))) return;
    const b = busy('인쇄 준비 중…');
    const root = h('div', { id: 'print-root' });
    try {
      for (let i = 0; i < n; i++) {
        b.set(`인쇄 준비 중… ${i + 1}/${n}페이지`);
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
    const S = this.shortcuts;
    const doc = () => !!this.doc, edit = () => this.mode === 'edit' && !!this.doc;
    const ed = (fn: (e: Editor) => void) => () => { if (this.doc) this.pageEditor().then(fn); };
    const tools = (m: any) => import('./tools.ts').then(m);
    const noHScroll = () => doc() && this.view.el.scrollWidth <= this.view.el.clientWidth;
    S.add(
      { id: 'open', group: '파일', label: '열기', keys: ['Ctrl+O'], run: () => this.pickAndOpen(), allowTyping: true },
      { id: 'save', group: '파일', label: '저장', keys: ['Ctrl+S'], run: () => this.save(false), allowTyping: true },
      { id: 'saveAs', group: '파일', label: '다른 이름으로 저장', keys: ['Ctrl+Shift+S'], run: () => this.save(true), allowTyping: true },
      { id: 'print', group: '파일', label: '인쇄', keys: ['Ctrl+P'], run: () => this.print(), when: doc, allowTyping: true },
      { id: 'compress', group: '파일', label: 'PDF 용량 줄이기', keys: ['Ctrl+Shift+M'], run: () => tools((m: any) => m.compressPdf(this)), when: doc },
      { id: 'split', group: '파일', label: 'PDF 나누기', keys: ['Ctrl+Shift+D'], run: () => tools((m: any) => m.splitPdf(this)), when: doc },
      { id: 'img2pdf', group: '파일', label: '이미지로 PDF 만들기', keys: ['Ctrl+Shift+I'], run: () => tools((m: any) => m.imagesToPdf(this)) },
      { id: 'pdf2img', group: '파일', label: '페이지를 이미지로 내보내기', keys: ['Ctrl+Shift+E'], run: () => tools((m: any) => m.exportImages(this)), when: doc },
      { id: 'info', group: '파일', label: '문서 정보', keys: ['Ctrl+D'], run: () => this.docInfo(), when: doc },
      { id: 'closeTab', group: '탭', label: '탭 닫기', keys: ['Ctrl+W', 'Ctrl+F4'], run: () => this.closeDoc(), allowTyping: true },
      { id: 'nextTab', group: '탭', label: '다음 탭', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], run: () => this.cycleTab(1), allowTyping: true },
      { id: 'prevTab', group: '탭', label: '이전 탭', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], run: () => this.cycleTab(-1), allowTyping: true },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ id: 'tab' + n, group: '탭', label: n === 9 ? '마지막 탭' : `${n}번째 탭`, keys: ['Alt+' + n], run: () => { const t = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1]; if (t) this.activate(t); } })),
      { id: 'mode', group: '보기', label: '보기 ↔ 편집 모드', keys: ['Ctrl+E'], run: () => this.setMode(this.mode === 'edit' ? 'view' : 'edit'), allowTyping: true },
      { id: 'settings', group: '보기', label: '설정', keys: ['Ctrl+,'], run: () => this.settings() },
      { id: 'organizer', group: '보기', label: '페이지 구성 보기', keys: ['Ctrl+Shift+G'], run: () => this.organizer.toggle(), when: doc, allowTyping: true },
      { id: 'sidebar', group: '보기', label: '탐색 패널 보이기/숨기기', keys: ['F12', 'Ctrl+Shift+B'], run: () => this.toggleSidebar(), allowTyping: true },
      { id: 'fullscreen', group: '보기', label: '전체 화면', keys: ['F11'], run: () => this.platform.toggleFullscreen(), allowTyping: true },
      { id: 'zoomIn', group: '보기', label: '확대', keys: ['Ctrl+=', 'Ctrl+Shift+='], run: () => this.zoomStep(1), when: doc },
      { id: 'zoomOut', group: '보기', label: '축소', keys: ['Ctrl+-'], run: () => this.zoomStep(-1), when: doc },
      { id: 'fitPage', group: '보기', label: '페이지 전체 맞춤', keys: ['Ctrl+0'], run: () => this.setFit('page'), when: doc },
      { id: 'actual', group: '보기', label: '실제 크기', keys: ['Ctrl+1'], run: () => this.view.setZoom(96 / 72), when: doc },
      { id: 'fitWidth', group: '보기', label: '페이지 너비 맞춤', keys: ['Ctrl+2'], run: () => this.setFit('width'), when: doc },
      { id: 'spread', group: '보기', label: '두 페이지씩 보기', keys: ['Ctrl+3'], run: () => { this.prefs.spread = !this.prefs.spread; this.savePrefs(); this.view.setSpread(this.prefs.spread); }, when: doc },
      { id: 'night', group: '보기', label: '야간 보기', keys: ['Ctrl+Shift+Y'], run: () => { this.prefs.night = !this.prefs.night; this.savePrefs(); this.view.setNight(this.prefs.night); } },
      { id: 'keys', group: '보기', label: '단축키 보기·바꾸기', keys: ['F1', '?'], run: () => this.showShortcuts() },
      { id: 'nextPage', group: '이동', label: '다음 페이지', keys: ['PageDown'], run: () => this.goto(this.view.current + 1), when: doc },
      { id: 'prevPage', group: '이동', label: '이전 페이지', keys: ['PageUp'], run: () => this.goto(this.view.current - 1), when: doc },
      { id: 'nextPageArrow', group: '이동', label: '다음 페이지 (→, 선택한 것이 없을 때)', keys: ['ArrowRight'], run: () => this.goto(this.view.current + 1), when: noHScroll },
      { id: 'prevPageArrow', group: '이동', label: '이전 페이지 (←, 선택한 것이 없을 때)', keys: ['ArrowLeft'], run: () => this.goto(this.view.current - 1), when: noHScroll },
      { id: 'nextPageN', group: '이동', label: '다음 페이지 (보기 모드)', keys: ['N'], run: () => this.goto(this.view.current + 1), when: () => doc() && this.mode === 'view' },
      { id: 'prevPageP', group: '이동', label: '이전 페이지 (보기 모드)', keys: ['P'], run: () => this.goto(this.view.current - 1), when: () => doc() && this.mode === 'view' },
      { id: 'nextPage2', group: '이동', label: '다음 페이지 (편집 모드에서도)', keys: ['Alt+ArrowDown'], run: () => this.goto(this.view.current + 1), when: doc },
      { id: 'prevPage2', group: '이동', label: '이전 페이지 (편집 모드에서도)', keys: ['Alt+ArrowUp'], run: () => this.goto(this.view.current - 1), when: doc },
      { id: 'first', group: '이동', label: '첫 페이지', keys: ['Home', 'Ctrl+Home'], run: () => this.goto(0), when: doc },
      { id: 'last', group: '이동', label: '마지막 페이지', keys: ['End', 'Ctrl+End'], run: () => this.goto(this.doc!.info.pageCount - 1), when: doc },
      { id: 'goto', group: '이동', label: '페이지 번호로 이동', keys: ['Ctrl+G'], run: () => this.pageInput.focus(), when: doc, allowTyping: true },
      { id: 'down', group: '이동', label: '조금 아래로', keys: ['J'], run: () => { this.view.el.scrollTop += 60; }, when: () => doc() && this.mode === 'view' },
      { id: 'up', group: '이동', label: '조금 위로', keys: ['K'], run: () => { this.view.el.scrollTop -= 60; }, when: () => doc() && this.mode === 'view' },
      { id: 'find', group: '찾기', label: '찾기', keys: ['Ctrl+F'], run: () => { this.searchInput.focus(); this.searchInput.select(); const s = this.view.selectedText(); if (s && s.length < 80) this.searchInput.value = s; }, when: doc, allowTyping: true },
      { id: 'findNext', group: '찾기', label: '다음 찾기', keys: ['F3'], run: () => { this.hits.length ? this.gotoHit(this.hitIdx + 1) : this.searchInput.focus(); }, when: doc, allowTyping: true },
      { id: 'findPrev', group: '찾기', label: '이전 찾기', keys: ['Shift+F3'], run: () => { if (this.hits.length) this.gotoHit(this.hitIdx - 1); }, when: doc, allowTyping: true },
      { id: 'undo', group: '편집', label: '되돌리기', keys: ['Ctrl+Z'], run: ed(e => e.undo()), when: () => !!this.editor && doc() },
      { id: 'redo', group: '편집', label: '다시 하기', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: ed(e => e.redo()), when: () => !!this.editor && doc() },
      { id: 'copy', group: '편집', label: '선택한 글자 복사', keys: ['Ctrl+C'], run: () => this.copy(), when: () => !!this.view.sel },
      { id: 'selectAll', group: '편집', label: '이 페이지 글자 모두 선택', keys: ['Ctrl+A'], run: () => this.view.selectAllOnPage(this.view.current), when: () => doc() && this.mode === 'view' },
      { id: 'arrangeFront', group: '편집', label: '맨 앞으로 가져오기', keys: ['Ctrl+Alt+Home'], run: ed(e => e.arrange('front')), when: edit },
      { id: 'arrangeForward', group: '편집', label: '앞으로 가져오기', keys: ['Ctrl+Alt+]'], run: ed(e => e.arrange('forward')), when: edit },
      { id: 'arrangeBackward', group: '편집', label: '뒤로 보내기', keys: ['Ctrl+Alt+['], run: ed(e => e.arrange('backward')), when: edit },
      { id: 'arrangeBack', group: '편집', label: '맨 뒤로 보내기', keys: ['Ctrl+Alt+End'], run: ed(e => e.arrange('back')), when: edit },
      { id: 'rotL', group: '페이지', label: '왼쪽으로 회전 (현재·선택한 페이지)', keys: ['Ctrl+['], run: ed(e => e.rotate(-1)), when: doc },
      { id: 'rotR', group: '페이지', label: '오른쪽으로 회전 (현재·선택한 페이지)', keys: ['Ctrl+]'], run: ed(e => e.rotate(1)), when: doc },
      { id: 'rotAll', group: '페이지', label: '모든 페이지 오른쪽으로 회전', keys: ['Ctrl+Shift+]'], run: ed(e => e.rotate(1, 'all')), when: doc },
      { id: 'blank', group: '페이지', label: '빈 페이지 삽입', keys: ['Ctrl+Shift+N'], run: ed(e => e.insertBlank()), when: doc },
      { id: 'delPage', group: '페이지', label: '페이지 삭제 (현재·선택한 페이지)', keys: ['Ctrl+Delete'], run: ed(e => e.deletePages()), when: doc },
      { id: 'merge', group: '페이지', label: '다른 PDF 삽입 (합치기)', keys: ['Ctrl+Shift+O'], run: ed(e => e.mergePdf()), when: doc },
      { id: 'extract', group: '페이지', label: '페이지 추출', keys: ['Ctrl+Shift+X'], run: ed(e => e.extract()), when: doc },
    );
    const tool = (id: string, label: string, key: string, group = '편집 도구') => ({ id: 'tool.' + id, group, label, keys: key ? [key] : [], run: () => this.editor?.setTool(id as any), when: edit });
    S.add(
      tool('select', '선택', 'V'), tool('editText', '글자 수정', 'E'), tool('addText', '글자 추가', 'T'), tool('textbox', '글상자', 'G'),
      tool('image', '이미지', 'I'), tool('table', '표', 'B'), tool('rect', '사각형', 'R'), tool('ellipse', '원', 'O'), tool('line', '선', 'L'),
      tool('free', '자유선', 'F'), tool('redact', '영역 삭제', 'X'),
      tool('aselect', '주석 선택', 'A', '주석 도구'), tool('highlight', '형광펜', 'H', '주석 도구'), tool('underline', '밑줄', 'U', '주석 도구'),
      tool('strike', '취소선', 'S', '주석 도구'), tool('note', '메모', 'N', '주석 도구'), tool('pen', '펜', 'D', '주석 도구'),
      tool('arect', '사각 표시', 'Shift+R', '주석 도구'), tool('aellipse', '원 표시', 'Shift+O', '주석 도구'),
    );
    document.addEventListener('keydown', e => {
      if (document.querySelector('.modal-back')) return;
      if (document.querySelector('.busy')) { e.preventDefault(); return; } // 오래 걸리는 작업 중에는 단축키를 막는다
      const t = e.target as HTMLElement;
      const typing = t.matches('input, textarea, select, [contenteditable]');
      if (!typing && this.mode === 'edit' && this.editor?.key(e)) return;
      if (S.handle(e, typing)) return;
      if (!typing && e.key === 'Escape') { this.view.clearSelection(); this.clearSearch(); }
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
    window.addEventListener('airpdf-drop-done', () => { depth = 0; zone.hidden = true; document.body.classList.remove('drop-in-thumbs'); });
    // 설치판: 파일 끌어 놓기는 운영체제가 직접 알려 준다 (경로와 위치)
    this.platform.onFileDrag?.(async ev => {
      const canInsert = !!this.doc && this.doc.formType < 2;
      if (ev.type === 'over') {
        const at = canInsert ? (this.organizer.isOpen ? this.organizer.markDropAt(ev.x, ev.y) : this.sidebar.markDropAt(ev.x, ev.y)) : null;
        zone.hidden = at !== null; document.body.classList.toggle('drop-in-thumbs', at !== null);
        return;
      }
      zone.hidden = true; document.body.classList.remove('drop-in-thumbs'); this.sidebar.clearDropMarks(); this.organizer.clearMarks();
      if (ev.type !== 'drop' || !ev.paths.length) return;
      const isPdf = (p: string) => /\.pdf$/i.test(p), isImg = (p: string) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p);
      const at = canInsert ? (this.organizer.isOpen ? (this.organizer.dropIndexAt(ev.x, ev.y) ?? this.view.pages.length) : this.sidebar.dropIndexAt(ev.x, ev.y)) : null;
      const read = async (ps: string[]) => (await Promise.all(ps.map(p => this.platform.readPath(p).catch(() => null)))).filter(Boolean) as OpenedFile[];
      const asFile = (f: OpenedFile) => new File([f.bytes as BlobPart], f.name, { type: isPdf(f.name) ? 'application/pdf' : 'image/' + (f.name.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')) });
      const pdfs = ev.paths.filter(isPdf), imgs = ev.paths.filter(isImg);
      if (!pdfs.length && !imgs.length) { toast('PDF나 이미지 파일만 열 수 있습니다.'); return; }
      if (at !== null) { this.sidebar.onDropFiles((await read([...pdfs, ...imgs])).map(asFile), at); return; }
      if (pdfs.length) await this.openFiles(await read(pdfs));
      else if (this.mode === 'edit' && this.doc) this.editor?.dropImages((await read(imgs)).map(asFile));
      else import('./tools.ts').then(async m => m.imagesToPdf(this, (await read(imgs)).map(asFile)));
    });
    window.addEventListener('drop', async e => {
      if (!isFiles(e)) return;
      e.preventDefault(); depth = 0; zone.hidden = true; document.body.classList.remove('drop-in-thumbs');
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
