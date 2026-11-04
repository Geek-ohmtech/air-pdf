/**
 * 편집 모드 (보기 모드에서는 이 파일을 아예 불러오지 않는다)
 * 모든 결과는 PDF 안의 진짜 객체로 들어간다: 글자는 글자, 선은 선, 주석은 PDF 주석.
 */
import type { App } from '../app.ts';
import type { AnnotInfo, PageObjInfo, Rect, TextRun } from '../engine/types.ts';
import type { PageEl } from '../viewer/docview.ts';
import { busy, confirmBox, dialog, h, icon, menu, promptBox, toast, type IconName } from '../ui/dom.ts';
import { colorButton } from '../ui/color.ts';
import { builtinItems, ensureFont, fontCss, fontItem, loadSystemFonts, systemFontsLoaded } from './fontlist.ts';

type Tab = 'edit' | 'annot' | 'page' | 'tools';
type Tool = 'select' | 'editText' | 'addText' | 'textbox' | 'image' | 'sign' | 'table' | 'rect' | 'ellipse' | 'line' | 'free' | 'redact'
  | 'aselect' | 'highlight' | 'underline' | 'strike' | 'note' | 'pen' | 'arect' | 'aellipse';
interface ObjChange { key: number; gen: number; removed: { h: number; idx: number }[]; added: { h: number; idx: number }[]; substituted: boolean; also?: number[] }
interface Entry { label: string; keys: number[]; undo: () => Promise<boolean | void>; redo: () => Promise<boolean | void>; structural?: boolean }
type Sel = { kind: 'run'; page: number; key: number; run: TextRun } | { kind: 'obj'; page: number; key: number; obj: PageObjInfo } | { kind: 'annot'; page: number; key: number; annot: AnnotInfo };

const ANNOT = { TEXT: 1, SQUARE: 5, CIRCLE: 6, HIGHLIGHT: 9, UNDERLINE: 10, STRIKEOUT: 12, INK: 15 };
const TOOLS: Record<Tool, { tab: Tab; label: string; icon: IconName; key?: string; hint: string }> = {
  select: { tab: 'edit', label: '선택', icon: 'select', key: 'v', hint: '글자 줄·그림·도형을 눌러 고르고 끌어서 옮깁니다. 두 번 누르면 글자를 고칩니다. Delete로 지웁니다.' },
  editText: { tab: 'edit', label: '글자 고치기', icon: 'editText', key: 'e', hint: '원본 글자 줄을 누르면 바로 고칠 수 있습니다. Enter로 확정, Shift+Enter 줄바꿈, Esc 취소.' },
  addText: { tab: 'edit', label: '글자 추가', icon: 'addText', key: 't', hint: '글자를 넣을 곳을 누르세요. 넣은 뒤에도 고른 상태라 색·크기·글꼴을 바로 바꿀 수 있습니다.' },
  textbox: { tab: 'edit', label: '글상자', icon: 'textbox', hint: '끌어서 글상자 영역을 정하세요. 폭에 맞춰 줄이 바뀌고, 나중에 두 번 눌러 고칩니다.' },
  image: { tab: 'edit', label: '이미지', icon: 'image', key: 'i', hint: '이미지를 고르면 현재 쪽에 넣습니다. 붙여넣기(Ctrl+V)와 끌어다 놓기도 됩니다.' },
  sign: { tab: 'edit', label: '서명', icon: 'pen', hint: '서명을 그려 이미지로 넣습니다.' },
  table: { tab: 'edit', label: '표', icon: 'table', key: 'b', hint: '표를 넣을 영역을 끌어서 정하세요.' },
  rect: { tab: 'edit', label: '사각형', icon: 'rect', key: 'r', hint: '끌어서 사각형을 그립니다 (PDF 도형).' },
  ellipse: { tab: 'edit', label: '원', icon: 'ellipse', hint: '끌어서 원을 그립니다 (PDF 도형).' },
  line: { tab: 'edit', label: '선', icon: 'line', key: 'l', hint: '끌어서 선을 긋습니다 (PDF 도형).' },
  free: { tab: 'edit', label: '자유선', icon: 'free', hint: '끌어서 자유롭게 그립니다 (PDF 선). 나중에 골라서 색·굵기를 바꿀 수 있습니다.' },
  redact: { tab: 'edit', label: '영역 삭제', icon: 'redact', key: 'x', hint: '끌어서 고른 영역의 글자·그림·선을 실제로 지웁니다. 되돌릴 수 없습니다.' },
  aselect: { tab: 'annot', label: '주석 선택', icon: 'select', hint: '주석을 눌러 고릅니다. 메모는 두 번 눌러 내용을 고칩니다. Delete로 지웁니다.' },
  highlight: { tab: 'annot', label: '형광펜', icon: 'highlight', key: 'h', hint: '강조할 글자를 끌어서 고르세요.' },
  underline: { tab: 'annot', label: '밑줄', icon: 'underline', key: 'u', hint: '밑줄 칠 글자를 끌어서 고르세요.' },
  strike: { tab: 'annot', label: '취소선', icon: 'strike', key: 's', hint: '취소선을 그을 글자를 끌어서 고르세요.' },
  note: { tab: 'annot', label: '메모', icon: 'note', key: 'n', hint: '메모를 붙일 곳을 누르세요.' },
  pen: { tab: 'annot', label: '펜', icon: 'pen', key: 'd', hint: '끌어서 자유롭게 그립니다 (PDF 잉크 주석).' },
  arect: { tab: 'annot', label: '사각 표시', icon: 'rect', hint: '끌어서 사각형 표시를 붙입니다 (주석).' },
  aellipse: { tab: 'annot', label: '원 표시', icon: 'ellipse', hint: '끌어서 원 표시를 붙입니다 (주석).' },
};
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, any>) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const inRect = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
const SERIF = /myeongjo|myungjo|batang|times|serif|mincho|song|gungsuh|명조|바탕|궁서|garamond|georgia|cambria/i;

const SHAPE_TOOLS = new Set(['textbox', 'rect', 'ellipse', 'line', 'free']);
/** 하나 넣으면 선택 도구로 돌아가는 도구 */
const CREATE_TOOLS = new Set(['addText', 'textbox', 'table', 'rect', 'ellipse', 'line', 'free']);
export class Editor {
  app: App;
  tab: Tab = 'edit'; tool: Tool = 'select';
  props = { textColor: '#1a1a1a', fontSize: 12, bold: false, stroke: '#d0342c', width: 1.5, fill: '', hl: '#ffd400', opacity: 0.45, annotColor: '#d0342c', redactFill: 'white' as 'white' | 'black', redactWhat: 'all' as 'all' | 'text',
    font: 'noto-sans', align: 'left' as 'left' | 'center' | 'right', border: '#2b59c3', tbFill: '', keepRatio: true };
  private undoS: Entry[] = []; private redoS: Entry[] = [];
  private runs = new Map<number, TextRun[] | Promise<TextRun[]>>();
  private objs = new Map<number, PageObjInfo[] | Promise<PageObjInfo[]>>();
  private annots = new Map<number, AnnotInfo[] | Promise<AnnotInfo[]>>();
  private _sel: Sel | null = null;
  /** 고른 것. 새로 정하면 함께 고른 것(more)은 비운다 (여러 개는 sel을 정한 뒤 more를 채운다) */
  private get sel(): Sel | null { return this._sel; }
  private set sel(v: Sel | null) { this._sel = v; this.more = []; }
  /** Shift+클릭·끌어 고르기로 함께 고른 것 (같은 쪽, sel 제외) */
  private more: Sel[] = [];
  /** 도구 단추를 두 번 누르면 그 도구를 계속 쓴다 (아니면 하나 넣고 선택 도구로 돌아감) */
  private toolLock = false;
  private hover: { page: number; rect: Rect } | null = null;
  private drag: any = null;
  private editing: { ta: HTMLTextAreaElement; commit: (cancel?: boolean) => Promise<void>; kind?: 'run' | 'new' | 'box'; restyle?: () => void; at?: { page: number; x: number; y: number } } | null = null;
  private tableEd: HTMLElement | null = null;
  private toolBar!: HTMLElement; private propBar!: HTMLElement; private undoBtn!: HTMLButtonElement; private redoBtn!: HTMLButtonElement; private countEl!: HTMLElement;
  private annotPanel: HTMLElement | null = null;
  private warnedSub = false;
  private nudge: { key: string; t: number; dx: number; dy: number } | null = null;

  constructor(app: App) {
    this.app = app;
    this.buildRibbon();
  }
  get E() { return this.app.engine; }
  get V() { return this.app.view; }
  get doc() { return this.app.doc!; }

  /* ───────────── 켜기 / 끄기 ───────────── */
  async activate() {
    this.V.interaction = {
      pointerdown: (e, p, x, y) => this.down(e, p, x, y),
      pointermove: (e, p, x, y) => this.move(e, p, x, y),
      pointerup: (e, p, x, y) => this.up(e, p, x, y),
      dblclick: (e, p, x, y) => this.dbl(e, p, x, y),
      hover: (e, p, x, y) => this.hoverAt(p, x, y),
    };
    this.V.decorate = pe => this.paint(pe);
    for (const pe of this.V.live.values()) { pe.links.innerHTML = ''; this.paint(pe); }
    const prevZoom = this.prevZoom = this.V.onZoom;
    this.V.onZoom = z => { prevZoom(z); if (this.editing) this.editing.commit(); this.layoutTableEditor(); };
    this.app.sidebar.onMovePage = (key, to) => this.movePage(key, to);
    this.app.sidebar.onThumbMenu = (e, i) => this.thumbMenu(e, i);
    if (!this.annotPanel) this.annotPanel = this.app.sidebar.addPanel('annots', '주석', 'comments', h('div', { class: 'annot-list' }));
    this.E.call('setAuthor', [this.app.prefs.author || '사용자']);
    this.setTab(this.tab);
    this.refreshAnnotList();
  }
  private prevZoom: ((z: number) => void) | null = null;
  deactivate() {
    this.commitPending();
    if (this.prevZoom) { this.V.onZoom = this.prevZoom; this.prevZoom = null; }
    this.closeTableEditor();
    this.sel = null; this.hover = null;
    for (const pe of this.V.live.values()) pe.edit.innerHTML = '';
    if (this.annotPanel) { this.app.sidebar.removePanel('annots'); this.annotPanel = null; }
  }
  async onDoc() {
    this.undoS = []; this.redoS = []; this.runs.clear(); this.objs.clear(); this.annots.clear(); this.sel = null;
    this.updateUndo(); this.refreshAnnotList();
    for (const pe of this.V.live.values()) this.paint(pe);
  }
  /** 입력 중인 글자를 확정한다 (끝날 때까지 기다릴 수 있다) */
  commitPending(): Promise<void> { return this.editing ? this.editing.commit() : Promise.resolve(); }
  /** 엔진이 그 쪽을 닫았다: 기억해 둔 객체 번호를 버린다 */
  dropPage(key: number) {
    this.runs.delete(key); this.objs.delete(key); this.annots.delete(key);
    if (this.sel?.key === key) { const p = this.sel.page; this.sel = null; this.paintPage(p); this.renderProps(); }
    if (this.hover && this.V.pages[this.hover.page]?.key === key) this.hover = null;
  }
  /** 쪽 구조가 바뀌었다 (삭제·되살리기·옮기기·회전): 쪽마다 기억한 것을 모두 버린다 */
  dropCaches() {
    this.runs.clear(); this.objs.clear(); this.annots.clear();
    this.sel = null; this.hover = null;
  }
  /** 탭마다 따로 가지는 편집 상태 */
  saveState() { return { undoS: this.undoS, redoS: this.redoS, runs: this.runs, objs: this.objs, annots: this.annots }; }
  loadState(st?: any) {
    this.closeTableEditor();
    this.undoS = st?.undoS || []; this.redoS = st?.redoS || [];
    this.runs = st?.runs || new Map(); this.objs = st?.objs || new Map(); this.annots = st?.annots || new Map();
    this.sel = null; this.hover = null;
    this.updateUndo(); this.renderProps();
    if (this.app.mode === 'edit') { this.repaintAll(); this.refreshAnnotList(); }
  }
  /** 입력란 채우기를 허용하는 도구인가 */
  allowsForms() { return this.tool === 'select' || this.tool === 'aselect'; }
  hint() { return this.more.length ? `${this.more.length + 1}개 고름 · 끌어서 함께 옮기기 · Shift+클릭으로 더하거나 빼기 · Delete로 지우기 · Esc 해제` : this.sel ? '선택됨 · 끌어서 옮기기 · Shift+클릭으로 여러 개 고르기 · 화살표로 1pt씩 · Delete로 지우기 · Esc 선택 해제' : TOOLS[this.tool]?.hint || ''; }

  /* ───────────── 리본 ───────────── */
  private buildRibbon() {
    const tabs: [Tab, string][] = [['edit', '편집'], ['annot', '주석'], ['page', '페이지'], ['tools', '도구']];
    this.toolBar = h('div', { class: 'rb-tools', role: 'toolbar' });
    this.propBar = h('div', { class: 'rb-props' });
    this.undoBtn = h('button', { class: 'tb', type: 'button', title: '되돌리기 (Ctrl+Z)', 'aria-label': '되돌리기', onclick: () => this.undo() }, icon('undo'));
    this.redoBtn = h('button', { class: 'tb', type: 'button', title: '다시 하기 (Ctrl+Y)', 'aria-label': '다시 하기', onclick: () => this.redo() }, icon('redo'));
    this.countEl = h('span', { class: 'rb-count' });
    this.app.ribbon.append(
      h('div', { class: 'rb-tabs', role: 'tablist' }, ...tabs.map(([t, l]) => h('button', { class: 'rb-tab', role: 'tab', type: 'button', dataset: { t }, onclick: () => this.setTab(t) }, l))),
      this.toolBar, this.propBar, h('div', { class: 'rb-end' }, this.countEl, this.undoBtn, this.redoBtn));
    this.updateUndo();
  }
  private toolBtn(t: Tool) {
    const d = TOOLS[t];
    const keep = CREATE_TOOLS.has(t) ? ' · 두 번 누르면 계속 쓰기' : '';
    const b = h('button', { class: 'rt' + (this.tool === t && this.toolLock ? ' locked' : ''), type: 'button', dataset: { tool: t }, 'aria-pressed': String(this.tool === t), title: d.label + (this.app.shortcuts.label('tool.' + t) ? ` (${this.app.shortcuts.label('tool.' + t)})` : '') + keep, onclick: () => this.setTool(t) }, icon(d.icon), h('span', {}, d.label));
    if (keep) b.addEventListener('dblclick', () => { this.setTool(t, true); toast(`“${d.label}” 도구를 계속 씁니다. 그만 쓰려면 Esc나 다른 도구를 누르세요.`); });
    return b;
  }
  private actBtn(ic: IconName, label: string, fn: (e: MouseEvent) => void, title?: string) {
    return h('button', { class: 'rt', type: 'button', title: title || label, onclick: fn }, icon(ic), h('span', {}, label));
  }
  setTab(t: Tab) {
    this.tab = t;
    this.app.ribbon.querySelectorAll('.rb-tab').forEach(b => b.setAttribute('aria-selected', String((b as HTMLElement).dataset.t === t)));
    this.toolBar.innerHTML = '';
    const sep = () => h('span', { class: 'rb-sep' });
    if (t === 'edit') {
      this.toolBar.append(this.toolBtn('select'), this.toolBtn('editText'), this.toolBtn('addText'), this.toolBtn('textbox'), sep(), this.toolBtn('image'), this.toolBtn('sign'), this.toolBtn('table'), sep(), this.toolBtn('rect'), this.toolBtn('ellipse'), this.toolBtn('line'), this.toolBtn('free'), sep(), this.toolBtn('redact'));
      if (TOOLS[this.tool].tab !== 'edit') this.setTool('select');
    } else if (t === 'annot') {
      this.toolBar.append(this.toolBtn('aselect'), sep(), this.toolBtn('highlight'), this.toolBtn('underline'), this.toolBtn('strike'), sep(), this.toolBtn('note'), this.toolBtn('pen'), this.toolBtn('arect'), this.toolBtn('aellipse'));
      if (TOOLS[this.tool].tab !== 'annot') this.setTool('highlight');
      this.app.sidebar.show('annots');
    } else if (t === 'page') {
      this.toolBar.append(
        this.actBtn('rotL', '왼쪽 회전 ▾', (e?: any) => this.rotateMenu(e, -1), '왼쪽으로 돌리기: 현재·고른·모든 쪽'), this.actBtn('rotR', '오른쪽 회전 ▾', (e?: any) => this.rotateMenu(e, 1), '오른쪽으로 돌리기: 현재·고른·모든 쪽'), sep(),
        this.actBtn('pageAdd', '빈 쪽', () => this.insertBlank()), this.actBtn('image', '이미지 쪽', () => this.imagePages(), '이미지를 새 쪽으로 넣기'), this.actBtn('merge', 'PDF 합치기', () => this.mergePdf()), this.actBtn('extract', '쪽 뽑아내기', () => this.extract()), sep(),
        this.actBtn('up', '앞으로', () => this.shiftPages(-1)), this.actBtn('down', '뒤로', () => this.shiftPages(1)), this.actBtn('trash', '쪽 삭제', () => this.deletePages()), sep(),
        this.actBtn('grid', '페이지 구성', () => this.app.organizer.show(), '페이지만 크게 늘어놓고 순서·삭제·삽입 (Ctrl+Shift+G)'),
        h('span', { class: 'rb-note' }, '왼쪽 쪽 목록에서 Ctrl/Shift+클릭으로 여러 쪽을 고르고, 끌어서 순서를 바꿉니다.'));
      this.app.sidebar.show('thumbs');
      this.setTool('select');
    } else {
      this.toolBar.append(
        this.actBtn('scan', '문서 보정', () => this.correctPages(), '사진·스캔 페이지를 반듯하게 펴고 기울기·그늘·대비를 바로잡습니다 (선택한 페이지 또는 현재 페이지)'),
        this.actBtn('ocr', '글자 인식', () => this.ocrDialog(), '스캔한 쪽의 글자를 인식해 검색·복사되게 합니다 (OCR)'), sep(),
        this.actBtn('lock', '암호 설정', () => this.setPassword()), this.actBtn('lock', '암호 해제', () => this.removePassword()), sep(),
        this.actBtn('info', '문서 속성', () => this.editMeta()), this.actBtn('comments', '작성자 이름', () => this.setAuthor()));
      this.setTool('select');
    }
    this.renderProps();
  }
  setTool(t: Tool, lock = false) {
    if (t === 'image') { this.pickImage(); return; }
    if (t === 'sign') { this.signature(); return; }
    this.commitPending();
    this.toolLock = lock;
    if (TOOLS[t].tab !== this.tab && (this.tab === 'edit' || this.tab === 'annot')) { this.tool = t; this.setTab(TOOLS[t].tab); return; }
    this.tool = t; this.sel = null; this.more = []; this.hover = null;
    this.toolBar.querySelectorAll('.rt[data-tool]').forEach(b => { const on = (b as HTMLElement).dataset.tool === t; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('locked', on && lock); });
    const cur: Record<string, string> = { select: 'default', aselect: 'default', editText: 'text', addText: 'text', textbox: 'crosshair', note: 'copy', pen: 'crosshair', free: 'crosshair', highlight: 'text', underline: 'text', strike: 'text' };
    this.V.interaction!.cursor = cur[t] || 'crosshair';
    this.V.el.style.cursor = this.V.interaction!.cursor;
    this.app.root.classList.toggle('forms-ok', this.allowsForms());
    this.renderProps(); this.repaintAll(); this.app.updateStatus();
  }
  private renderProps() {
    const P = this.propBar; P.innerHTML = '';
    const t = this.tool, s = this.sel;
    const obj = s?.kind === 'obj' ? s.obj : null;
    const color = (title: string, cur: string, set: (c: string) => void, mark: 'text' | 'line' | 'fill' = 'line', none?: string, label?: string) => colorButton({ title, value: cur, onPick: set, mark, none, label: label ?? (mark === 'fill' ? '채우기' : mark === 'line' ? '선' : undefined) });
    const num = (label: string, v: number, min: number, max: number, step: number, set: (n: number) => void, unit = 'pt') => {
      const i = h('input', { type: 'number', class: 'num', value: String(Math.round(v * 10) / 10), min: String(min), max: String(max), step: String(step), 'aria-label': label });
      i.addEventListener('change', () => { const n = Math.max(min, Math.min(max, parseFloat(i.value) || v)); set(n); });
      return h('label', { class: 'prop' }, h('span', {}, label), i, h('small', {}, unit));
    };
    const boldBtn = (on: boolean, set: (b: boolean) => void) => h('button', { class: 'tg' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), title: '굵게', onclick: () => set(!on) }, h('b', {}, '가'));
    const lbl = (txt: string) => h('span', { class: 'prop-lbl' }, txt);
    if (s && this.more.length) { // 여러 개
      const all = this.allSel();
      P.append(lbl(`${all.length}개 고름`));
      if (all.every(x => x.kind === 'run')) P.append(color('글자 색', '', c => this.styleMany({ color: c }), 'text'), boldBtn(false, () => this.styleMany({ bold: true })));
      else if (all.every(x => x.kind === 'obj' && ['shape', 'free', 'path'].includes(x.obj.type))) P.append(color('선 색', '', c => this.setShape({ stroke: c })), num('굵기', this.props.width, 0.25, 30, 0.25, n => this.setShape({ width: n })));
      P.append(h('button', { class: 'btn sm', type: 'button', title: '겹친 순서', onclick: (e: MouseEvent) => this.arrangeMenu(e) }, icon('layers'), '순서 ▾'));
      P.append(h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => this.deleteSel() }, icon('trash'), '모두 지우기'));
      return;
    }
    // 글자 (새 글자, 고른 글자 줄, 표)
    const run = s?.kind === 'run' ? s.run : null;
    if (run || t === 'addText' || t === 'editText') {
      const cur = run ? { color: run.color, size: run.size, bold: run.bold, font: '' } : { color: this.props.textColor, size: this.props.fontSize, bold: this.props.bold, font: this.props.font };
      if (run) P.append(lbl('고른 글자'));
      P.append(this.fontSelect(cur.font || this.props.font, f => this.setText('font', f), run ? run.font : ''),
        color('글자 색', cur.color, c => this.setText('color', c), 'text'),
        num('크기', cur.size, 4, 200, 0.5, n => this.setText('size', n)),
        boldBtn(cur.bold, b => this.setText('bold', b)));
    } else if (obj?.type === 'textbox' || t === 'textbox') {
      const m = obj?.type === 'textbox' ? obj.meta : { font: this.props.font, color: this.props.textColor, size: this.props.fontSize, bold: this.props.bold, align: this.props.align, border: this.props.border, fill: this.props.tbFill, bw: this.props.width };
      if (obj) P.append(lbl('글상자'));
      const alignBtn = (a: 'left' | 'center' | 'right', ic: string) => h('button', { class: 'tg' + (m.align === a ? ' on' : ''), type: 'button', title: { left: '왼쪽 정렬', center: '가운데 정렬', right: '오른쪽 정렬' }[a], 'aria-pressed': String(m.align === a), onclick: () => this.setBox({ align: a }) }, ic);
      P.append(this.fontSelect(m.font || 'noto-sans', f => this.setBox({ font: f })), color('글자 색', m.color, c => this.setBox({ color: c }), 'text'), num('크기', m.size, 4, 120, 0.5, n => this.setBox({ size: n })), boldBtn(!!m.bold, b => this.setBox({ bold: b })),
        h('div', { class: 'seg' }, alignBtn('left', '≡'), alignBtn('center', '☰'), alignBtn('right', '≡')),
        color('테두리 색', m.border || '', c => this.setBox({ border: c }), 'line', '테두리 없음', '테두리'), color('배경색', m.fill || '', c => this.setBox({ fill: c }), 'fill', '배경 없음', '배경'));
    } else if (obj && (obj.type === 'shape' || obj.type === 'free' || obj.type === 'path')) {
      const st = obj.meta || {};
      P.append(lbl(obj.type === 'free' ? '자유선' : '도형'), color('선 색', st.stroke || '', c => this.setShape({ stroke: c }), 'line', obj.type === 'shape' && st.kind !== 'line' ? '선 없음' : undefined),
        num('굵기', st.width ?? this.props.width, 0.25, 30, 0.25, n => this.setShape({ width: n })));
      if (obj.type !== 'free' && st.kind !== 'line') P.append(color('채우기 색', st.fill || '', c => this.setShape({ fill: c }), 'fill', '채우기 없음'));
    } else if (t === 'rect' || t === 'ellipse' || t === 'line' || t === 'free' || t === 'table') {
      P.append(color('선 색', this.props.stroke, c => { this.props.stroke = c; this.renderProps(); }), num('굵기', this.props.width, 0.25, 20, 0.25, n => this.props.width = n));
      if (t === 'rect' || t === 'ellipse') P.append(color('채우기 색', this.props.fill === 'same' ? this.props.stroke : this.props.fill, c => { this.props.fill = c; this.renderProps(); }, 'fill', '채우기 없음'));
      if (t === 'table') P.append(this.fontSelect(this.props.font, f => { this.props.font = f; this.renderProps(); }), num('글자', this.props.fontSize, 5, 48, 0.5, n => this.props.fontSize = n));
    } else if (t === 'highlight' || t === 'underline' || t === 'strike') {
      const cur = t === 'highlight' ? this.props.hl : this.props.annotColor;
      P.append(color(t === 'highlight' ? '형광펜 색' : '선 색', cur, c => { if (t === 'highlight') this.props.hl = c; else this.props.annotColor = c; this.renderProps(); }, t === 'highlight' ? 'fill' : 'line'));
      if (t === 'highlight') P.append(num('불투명도', Math.round(this.props.opacity * 100), 10, 100, 5, n => this.props.opacity = n / 100, '%'));
    } else if (t === 'pen' || t === 'arect' || t === 'aellipse' || t === 'note') {
      P.append(color('색', this.props.annotColor, c => { this.props.annotColor = c; this.renderProps(); }));
      if (t !== 'note') P.append(num('굵기', this.props.width, 0.5, 20, 0.5, n => this.props.width = n));
    } else if (t === 'redact') {
      const what = h('select', { class: 'sel', 'aria-label': '지울 대상' }, h('option', { value: 'all', selected: this.props.redactWhat === 'all' ? '' : undefined }, '지울 대상: 전부 (글자·그림·선)'), h('option', { value: 'text', selected: this.props.redactWhat === 'text' ? '' : undefined }, '지울 대상: 글자만'));
      what.addEventListener('change', () => { this.props.redactWhat = what.value as any; this.renderProps(); });
      P.append(what);
      if (this.props.redactWhat !== 'text') {
        const sel = h('select', { class: 'sel', 'aria-label': '지운 자리' }, h('option', { value: 'white', selected: this.props.redactFill === 'white' ? '' : undefined }, '지운 자리: 흰색'), h('option', { value: 'black', selected: this.props.redactFill === 'black' ? '' : undefined }, '지운 자리: 검은 상자'));
        sel.addEventListener('change', () => this.props.redactFill = sel.value as any);
        P.append(sel);
      }
    }
    if (obj?.type === 'image') {
      const cb = h('input', { type: 'checkbox', checked: this.props.keepRatio ? '' : undefined });
      cb.addEventListener('change', () => { this.props.keepRatio = (cb as HTMLInputElement).checked; });
      P.append(lbl('이미지'), h('label', { class: 'chk', title: '모서리 손잡이로 크기를 바꿀 때 가로세로 비율 유지 (Shift를 누르면 반대로)' }, cb, ' 비율 유지'));
    }
    if (s && s.kind !== 'annot') P.append(h('button', { class: 'btn sm', type: 'button', title: '겹친 순서: 앞으로 가져오기·뒤로 보내기', onclick: (e: MouseEvent) => this.arrangeMenu(e) }, icon('layers'), '순서 ▾'));
    if (s) P.append(h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => this.deleteSel() }, icon('trash'), '지우기'));
  }
  /** 글꼴 고르기 (앱 글꼴 + 컴퓨터 글꼴) */
  private fontSelect(cur: string, set: (id: string) => void, origName = '') {
    const sel = h('select', { class: 'sel font-sel', 'aria-label': '글꼴', title: '글꼴' }) as HTMLSelectElement;
    if (origName) sel.append(h('option', { value: '', selected: '' }, `원래 글꼴 (${origName})`));
    const groups = new Map<string, HTMLElement>();
    const add = (it: { id: string; name: string; css: string; group: string }) => {
      let g = groups.get(it.group); if (!g) { g = h('optgroup', { label: it.group }); groups.set(it.group, g); sel.append(g); }
      g.append(h('option', { value: it.id, selected: !origName && it.id === cur ? '' : undefined, style: { fontFamily: it.css } }, it.name));
    };
    builtinItems().forEach(add);
    const sys = systemFontsLoaded();
    if (sys) sys.forEach(add);
    else sel.append(h('option', { value: '__load' }, '컴퓨터 글꼴 불러오기…'));
    sel.addEventListener('change', async () => {
      if (sel.value === '__load') {
        const b = busy('글꼴 목록을 읽는 중…');
        try { const l = await loadSystemFonts(this.app); if (!l.length) toast(this.app.platform.kind === 'web' ? '이 브라우저에서는 컴퓨터 글꼴을 읽을 수 없습니다. 크롬·엣지에서 허락하면 됩니다.' : '쓸 수 있는 글꼴을 찾지 못했습니다.'); }
        finally { b.done(); }
        this.renderProps(); return;
      }
      if (!sel.value) return;
      try { await ensureFont(this.app, sel.value); set(sel.value); }
      catch (e: any) { toast('그 글꼴을 쓸 수 없습니다: ' + e.message); }
    });
    if (this.app.platform.kind === 'desktop' && !sys) loadSystemFonts(this.app).then(() => this.renderProps()).catch(() => {});
    return sel;
  }

  /* ───────────── 고른 것에 바로 적용 ───────────── */
  /** 글자 속성: 입력 중이면 입력 칸에, 고른 글자 줄이 있으면 그 줄에 바로 */
  private async setText(field: 'font' | 'color' | 'size' | 'bold', v: any) {
    const map: any = { font: 'font', color: 'textColor', size: 'fontSize', bold: 'bold' };
    (this.props as any)[map[field]] = v;
    if (this.editing?.kind === 'new') { this.editing.restyle?.(); this.renderProps(); this.editing.ta.focus(); return; }
    let s = this.sel;
    if (this.editing?.kind === 'run' && this.editing.at) {
      const at = this.editing.at;
      await this.editing.commit();
      const runs = await this.getRuns(at.page);
      const run = runs.find(r => inRect(r.rect, at.x, at.y, 2));
      s = run ? { kind: 'run', page: at.page, key: this.V.pages[at.page].key, run } : null;
    } else if (this.editing) await this.editing.commit();
    if (s?.kind === 'run') await this.styleRun(s.page, s.key, s.run, field, v);
    this.renderProps();
  }
  private async styleRun(page: number, key: number, run: TextRun, field: string, v: any) {
    const id = this.doc.id;
    try {
      if (field === 'color' || field === 'bold') {
        const st: any = field === 'color' ? { color: v } : { bold: v };
        const res = await this.E.call<{ before: any[]; also?: number[] }>('setTextStyle', [id, key, run.objs, st]);
        this.push({ label: field === 'color' ? '글자 색' : '굵게', keys: [key, ...(res.also || [])], undo: () => this.E.call('restoreTextStyle', [id, key, res.before]), redo: () => this.E.call('setTextStyle', [id, key, run.objs, st]) });
        for (const k of res.also || []) this.changed(k);
        this.changed(key);
        await this.reselectRun(page, run.objs[0]);
      } else if (field === 'size') {
        const f = v / run.size; if (Math.abs(f - 1) < 0.001) return;
        const gen = await this.E.call<number>('pageGen', [id, key]), about = { ...run.origin };
        await this.E.call('transformObjs', [id, key, gen, run.objs, 0, 0, f, about]);
        this.push({ label: '글자 크기', keys: [key], undo: () => this.E.call('transformObjs', [id, key, gen, run.objs, 0, 0, 1 / f, about]), redo: () => this.E.call('transformObjs', [id, key, gen, run.objs, 0, 0, f, about]) });
        this.changed(key);
        await this.reselectRun(page, run.objs[0]);
      } else if (field === 'font') {
        const ch = await this.E.call<ObjChange>('editRun', [id, key, run.objs, run.text, { font: v }]);
        this.objEntry('글꼴 바꾸기', ch);
        await this.reselectRun(page, ch.added[0]?.h);
      }
    } catch (e: any) { toast('바꾸지 못했습니다: ' + e.message); }
  }
  /** 하나 넣은 뒤: 선택 도구로 돌아가 방금 넣은 것을 골라 둔다 (도구를 고정했으면 그대로) */
  private async afterCreate(page: number, h0: number | undefined, kind: 'obj' | 'run' = 'obj') {
    if (!this.toolLock && this.tool !== 'select' && TOOLS[this.tool].tab === 'edit') this.setTool('select');
    if (kind === 'run') await this.reselectRun(page, h0); else await this.reselectObj(page, h0);
  }
  private async reselectRun(page: number, h0?: number) {
    if (!h0) return;
    const runs = await this.getRuns(page);
    const r = runs.find(x => x.objs.includes(h0));
    if (r) { this.sel = { kind: 'run', page, key: this.V.pages[page].key, run: r }; this.paintPage(page); this.renderProps(); this.app.updateStatus(); }
  }
  private async reselectObj(page: number, h0?: number) {
    if (!h0) return;
    const objs = await this.getObjs(page);
    const o = objs.find(x => (x.objs || [x.h]).includes(h0));
    if (o) { this.sel = { kind: 'obj', page, key: this.V.pages[page].key, obj: o }; this.paintPage(page); this.renderProps(); this.app.updateStatus(); }
  }
  /** 여러 글자 줄의 색·굵기를 한 번에 */
  private async styleMany(st: { color?: string; bold?: boolean }) {
    const s = this.sel; if (!s) return;
    const id = this.doc.id, key = s.key, objs = this.selObjs(), keep = this.allSel();
    try {
      const res = await this.E.call<{ before: any[]; also?: number[] }>('setTextStyle', [id, key, objs, st]);
      this.push({ label: st.color ? '글자 색' : '굵게', keys: [key, ...(res.also || [])], undo: () => this.E.call('restoreTextStyle', [id, key, res.before]), redo: () => this.E.call('setTextStyle', [id, key, objs, st]) });
      for (const k of res.also || []) this.changed(k);
      this.changed(key);
      const runs = await this.getRuns(s.page);
      const all = keep.map(k => k.kind === 'run' ? runs.find(r => r.objs.includes(k.run.objs[0])) : null).filter(Boolean).map(run => ({ kind: 'run', page: s.page, key, run }) as Sel);
      this.sel = all[0] || null; this.more = all.slice(1); this.paintPage(s.page); this.renderProps();
    } catch (e: any) { toast('바꾸지 못했습니다: ' + e.message); }
  }
  /** 도형·자유선 선 색·굵기·채우기 */
  private async setShape(st: { stroke?: string; width?: number; fill?: string }) {
    const s = this.sel; if (s?.kind !== 'obj') return;
    const id = this.doc.id, key = s.key, objs = this.more.length ? this.selObjs() : s.obj.objs || [s.obj.h];
    const before = await this.E.call<any[]>('setShapeStyle', [id, key, objs, st]);
    this.push({ label: '도형 모양', keys: [key], undo: () => this.E.call('restoreShapeStyle', [id, key, before]), redo: () => this.E.call('setShapeStyle', [id, key, objs, st]) });
    if (st.stroke !== undefined) this.props.stroke = st.stroke || this.props.stroke;
    if (st.width !== undefined) this.props.width = st.width;
    this.changed(key);
    await this.reselectObj(s.page, objs[0]);
  }
  /** 글상자 속성: 고른 글상자를 새 속성으로 다시 만든다 */
  private async setBox(patch: any) {
    const s = this.sel;
    const map: any = { font: 'font', color: 'textColor', size: 'fontSize', bold: 'bold', align: 'align', border: 'border', fill: 'tbFill' };
    for (const [k, v] of Object.entries(patch)) (this.props as any)[map[k]] = v;
    if (this.editing?.kind === 'box') { this.editing.restyle?.(); this.renderProps(); this.editing.ta.focus(); return; }
    if (s?.kind !== 'obj' || s.obj.type !== 'textbox') { this.renderProps(); return; }
    try {
      if (patch.font) await ensureFont(this.app, patch.font);
      const ch = await this.E.call<ObjChange>('replaceTextBox', [this.doc.id, s.key, s.obj.objs, { ...s.obj.meta, ...patch }]);
      this.objEntry('글상자 고치기', ch);
      await this.reselectObj(s.page, ch.added[0]?.h);
    } catch (e: any) { toast('글상자를 고치지 못했습니다: ' + e.message); }
  }
  /** 손잡이로 크기 바꾸기: 그림·선은 늘이고, 도형은 다시 그리고, 글상자는 폭에 맞춰 다시 짠다 */
  private async resizeSel(r0: Rect, r1: Rect, handle: string) {
    const s = this.sel; if (s?.kind !== 'obj') return;
    const id = this.doc.id, key = s.key, o = s.obj, objs = o.objs || [o.h];
    this.hover = null;
    if (o.type === 'textbox') { // 글상자는 쪽 밖으로 나가지 않게
      const pg = this.V.pages[s.page];
      const x = Math.max(0, r1.x), R = Math.min(pg.w, r1.x + r1.w);
      r1 = { ...r1, x, w: Math.max(40, R - x) };
    }
    try {
      if (o.type === 'shape') {
        const ch = await this.E.call<ObjChange>('reshape', [id, key, objs, { x: r1.x + 1, y: r1.y + 1, w: r1.w - 2, h: r1.h - 2 }]);
        this.objEntry('도형 크기', ch); await this.reselectObj(s.page, ch.added[0]?.h);
      } else if (o.type === 'textbox') {
        const spec = { ...o.meta, x: r1.x, y: r1.y, w: r1.w, minH: handle.includes('s') ? r1.h : o.meta.minH };
        const ch = await this.E.call<ObjChange>('replaceTextBox', [id, key, objs, spec]);
        this.objEntry('글상자 크기', ch); await this.reselectObj(s.page, ch.added[0]?.h);
      } else {
        const gen = await this.E.call<number>('pageGen', [id, key]);
        const sc: [number, number] = [r1.w / r0.w, r1.h / r0.h];
        const fwd = [id, key, gen, objs, r1.x - r0.x, r1.y - r0.y, sc, { x: r0.x, y: r0.y }];
        const back = [id, key, gen, objs, r0.x - r1.x, r0.y - r1.y, [1 / sc[0], 1 / sc[1]], { x: r1.x, y: r1.y }];
        const tr: any = await this.E.call('transformObjs', fwd);
        for (const k of tr?.also || []) this.changed(k);
        this.push({ label: '크기 바꾸기', keys: [key], undo: () => this.E.call('transformObjs', back), redo: () => this.E.call('transformObjs', fwd) });
        this.changed(key); await this.reselectObj(s.page, objs[0]);
      }
    } catch (e: any) { toast('크기를 바꾸지 못했습니다: ' + e.message); }
  }

  /* ───────────── 캐시 ───────────── */
  private async getRuns(page: number): Promise<TextRun[]> {
    const key = this.V.pages[page].key;
    let r = this.runs.get(key);
    if (!r) { r = this.E.call<TextRun[]>('textRuns', [this.doc.id, key]); this.runs.set(key, r); r.then(v => { if (this.runs.get(key) === r) this.runs.set(key, v); }); }
    return r;
  }
  private async getObjs(page: number): Promise<PageObjInfo[]> {
    const key = this.V.pages[page].key;
    let r = this.objs.get(key);
    if (!r) { r = this.E.call<PageObjInfo[]>('pageObjects', [this.doc.id, key]); this.objs.set(key, r); r.then(v => { if (this.objs.get(key) === r) this.objs.set(key, v); }); }
    return r;
  }
  private async getAnnots(page: number): Promise<AnnotInfo[]> {
    const key = this.V.pages[page].key;
    let r = this.annots.get(key);
    if (!r) { r = this.E.call<AnnotInfo[]>('annots', [this.doc.id, page]); this.annots.set(key, r); r.then(v => { if (this.annots.get(key) === r) this.annots.set(key, v); }); }
    return r;
  }
  private now<T>(m: Map<number, T[] | Promise<T[]>>, page: number): T[] | null { const v = m.get(this.V.pages[page]?.key); return v && !(v instanceof Promise) ? v : null; }
  private changed(key: number) {
    this.runs.delete(key); this.objs.delete(key); this.annots.delete(key);
    this.app.refreshPage(key); this.app.markDirty(); this.app.staleSearch();
    const i = this.V.pages.findIndex(p => p.key === key);
    const pe = this.V.pageEl(i); if (pe) this.paint(pe);
  }

  /* ───────────── 겹쳐 그리기 ───────────── */
  private repaintAll() { for (const pe of this.V.live.values()) this.paint(pe); }
  private paint(pe: PageEl) {
    const p = this.V.pages[pe.index]; if (!p || this.app.mode !== 'edit') return;
    let svg = pe.edit.querySelector('svg.ed') as SVGSVGElement | null;
    if (!svg) { svg = svgEl('svg', { class: 'ed', viewBox: `0 0 ${p.w} ${p.h}`, preserveAspectRatio: 'none' }) as SVGSVGElement; pe.edit.prepend(svg); }
    svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    svg.innerHTML = '';
    const tool = this.tool;
    // 원본 글자 줄 테두리 (편집 도구일 때 은은하게 모두 표시)
    if (tool === 'editText' || tool === 'select') {
      const runs = this.now(this.runs, pe.index);
      if (!runs) this.getRuns(pe.index).then(() => this.V.pageEl(pe.index) && this.paint(this.V.pageEl(pe.index)!));
      else if (tool === 'editText') for (const r of runs) if (!r.invisible) svg.append(svgEl('rect', { class: 'run-hint', x: r.rect.x - 1, y: r.rect.y - 1, width: r.rect.w + 2, height: r.rect.h + 2 }));
      if (tool === 'select' && !this.now(this.objs, pe.index)) this.getObjs(pe.index);
    }
    if (tool === 'aselect' && !this.now(this.annots, pe.index)) this.getAnnots(pe.index).then(() => this.V.pageEl(pe.index) && this.paint(this.V.pageEl(pe.index)!));
    if (this.editing) { if (this.drag?.page === pe.index && this.drag.preview) svg.append(this.drag.preview); return; }
    if (this.hover && this.hover.page === pe.index && !this.allSel().some(x => x.page === pe.index && this.sameRect(this.rectOf(x), this.hover!.rect))) {
      const r = this.hover.rect; svg.append(svgEl('rect', { class: 'hover-box', x: r.x - 1.5, y: r.y - 1.5, width: r.w + 3, height: r.h + 3 }));
    }
    for (const x of this.allSel()) {
      if (x.page !== pe.index) continue;
      let r = this.rectOf(x);
      if (this.drag?.kind === 'move' && this.drag.moved) r = { ...r, x: r.x + this.drag.dx, y: r.y + this.drag.dy };
      if (this.drag?.kind === 'resize' && x === this.sel) r = this.drag.r;
      svg.append(svgEl('rect', { class: 'sel-box', x: r.x - 2, y: r.y - 2, width: r.w + 4, height: r.h + 4 }));
      if (x !== this.sel || this.more.length) continue;
      const hs = 7 / this.V.zoom;
      for (const [name, hx, hy] of this.handles(r)) svg.append(svgEl('rect', { class: 'handle h-' + name, x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs }));
    }
    if (this.drag?.page === pe.index && this.drag.preview) svg.append(this.drag.preview);
  }
  /** 고른 것의 크기 조절 손잡이: 이름과 위치 */
  private handles(r: Rect): [string, number, number][] {
    const s = this.sel; if (!s || s.kind !== 'obj') return [];
    const L = r.x - 2, T = r.y - 2, R = r.x + r.w + 2, B = r.y + r.h + 2, cx = (L + R) / 2, cy = (T + B) / 2;
    if (s.obj.type === 'textbox') return [['w', L, cy], ['e', R, cy], ['s', cx, B]];
    return [['nw', L, T], ['n', cx, T], ['ne', R, T], ['e', R, cy], ['se', R, B], ['s', cx, B], ['sw', L, B], ['w', L, cy]];
  }
  private handleAt(x: number, y: number): string | null {
    const r = this.selRect(); if (!r || this.more.length) return null;
    const hs = 8 / this.V.zoom;
    for (const [n, hx, hy] of this.handles(r)) if (Math.abs(x - hx) <= hs && Math.abs(y - hy) <= hs) return n;
    return null;
  }
  private sameRect(a: Rect, b: Rect) { return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5; }
  private selRect(): Rect | null {
    const s = this.sel; if (!s) return null;
    return s.kind === 'run' ? s.run.rect : s.kind === 'obj' ? s.obj.rect : s.annot.rect;
  }
  private paintPage(i: number) { const pe = this.V.pageEl(i); if (pe) this.paint(pe); }
  /** 입력 칸을 열 때: 고른 표시·마우스 올림 표시를 지워 겹쳐 보이지 않게 */
  private clearSelFor(page: number) {
    const old = this.sel?.page; this.sel = null; this.more = []; this.hover = null;
    if (old !== undefined && old !== page) this.paintPage(old);
    this.paintPage(page);
  }
  private allSel(): Sel[] { return this.sel ? [this.sel, ...this.more] : []; }
  private rectOf(x: Sel): Rect { return x.kind === 'run' ? x.run.rect : x.kind === 'obj' ? x.obj.rect : x.annot.rect; }
  private sameSel(a: Sel, b: Sel) {
    if (a.kind !== b.kind || a.page !== b.page) return false;
    if (a.kind === 'run') return (b as any).run.objs[0] === a.run.objs[0];
    if (a.kind === 'obj') return ((b as any).obj.objs || [(b as any).obj.h])[0] === (a.obj.objs || [a.obj.h])[0];
    return (b as any).annot.id === a.annot.id;
  }
  /** Shift+클릭: 넣거나 빼기 */
  private toggleSel(x: Sel) {
    const all = this.allSel().filter(s => s.kind !== 'annot' && s.page === x.page);
    const i = all.findIndex(s => this.sameSel(s, x));
    if (i >= 0) all.splice(i, 1); else all.push(x);
    this.sel = all[0] || null; this.more = all.slice(1);
  }

  /* ───────────── 마우스 ───────────── */
  private hitRun(page: number, x: number, y: number) { const runs = this.now(this.runs, page); return runs?.filter(r => !r.invisible).reverse().find(r => inRect(r.rect, x, y, 1.5)) || null; }
  /** 눌러서 고를 객체: 흰색으로만 칠한 상자(표 칸 바탕 등)는 건너뛰고, 선만 있는 원본 도형은 선 가까이를 눌러야 잡힌다 */
  private hitObj(page: number, x: number, y: number) {
    const objs = this.now(this.objs, page); if (!objs) return null;
    const tol = Math.max(2, 5 / this.V.zoom);
    return objs.slice().reverse().find(o => {
      if (!inRect(o.rect, x, y, 2)) return false;
      if (!o.vis) return true;
      if (o.vis.ghost) return false;
      if (o.vis.fill) return true;
      const r = o.rect; // 선만 있는 것: 가장자리 근처만
      return o.rect.w < tol * 2 || o.rect.h < tol * 2 || x < r.x + tol || x > r.x + r.w - tol || y < r.y + tol || y > r.y + r.h - tol;
    }) || null;
  }
  private hitAnnot(page: number, x: number, y: number) { const a = this.now(this.annots, page); return a?.slice().reverse().find(o => inRect(o.rect, x, y, 3)) || null; }

  private hoverAt(page: number, x: number, y: number) {
    if ((this.tool === 'select' || SHAPE_TOOLS.has(this.tool)) && this.sel?.page === page) {
      const hn = this.handleAt(x, y);
      if (hn && this.V.interaction) { this.V.interaction.cursor = ({ nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' } as any)[hn]; return; }
    }
    let r: Rect | null = null;
    if (this.tool === 'select' || this.tool === 'editText') {
      const run = this.hitRun(page, x, y);
      r = run ? run.rect : this.tool === 'select' ? this.hitObj(page, x, y)?.rect || null : null;
      if (!this.now(this.runs, page)) this.getRuns(page);
    } else if (this.tool === 'aselect') r = this.hitAnnot(page, x, y)?.rect || null;
    const prev = this.hover;
    this.hover = r ? { page, rect: r } : null;
    if (prev?.page !== this.hover?.page || (prev && this.hover && !this.sameRect(prev.rect, this.hover.rect)) || (!prev !== !this.hover)) {
      if (prev && prev.page !== page) this.paintPage(prev.page);
      this.paintPage(page);
    }
    if (this.V.interaction) {
      const base = ({ select: 'default', aselect: 'default', editText: 'text', addText: 'text' } as any)[this.tool];
      this.V.interaction.cursor = (this.tool === 'select' || this.tool === 'aselect') && r ? 'move' : this.tool === 'editText' && r ? 'text' : base || this.V.interaction.cursor;
      if (this.tool === 'aselect' && r) this.V.interaction.cursor = 'pointer';
    }
  }

  private down(e: PointerEvent, page: number, x: number, y: number): boolean {
    if (this.editing) { this.editing.commit(); if (this.tool === 'addText' || this.tool === 'editText') return true; }
    const key = this.V.pages[page].key;
    const t = this.tool;
    if (t === 'select') {
      const s = this.sel;
      if (s && s.page === page && s.kind === 'obj') {
        const hn = this.handleAt(x, y);
        if (hn) { const r0 = { ...s.obj.rect }; this.drag = { kind: 'resize', page, x0: x, y0: y, handle: hn, r0, r: r0 }; return true; }
      }
      const inSel = this.allSel().some(q => q.page === page && inRect(this.rectOf(q), x, y, 2));
      if (inSel && !e.shiftKey) { this.drag = { kind: 'move', page, x0: x, y0: y, dx: 0, dy: 0, moved: false }; return true; }
      const run = this.hitRun(page, x, y);
      const obj = run ? null : this.hitObj(page, x, y);
      if (!this.now(this.runs, page)) { this.getRuns(page); this.getObjs(page); }
      const old = this.sel?.page;
      const hit: Sel | null = run ? { kind: 'run', page, key, run } : obj ? { kind: 'obj', page, key, obj } : null;
      if (e.shiftKey && hit && (!this.sel || this.sel.page === page)) this.toggleSel(hit);
      else if (!e.shiftKey || !hit) { if (hit || !e.shiftKey) { this.sel = hit; this.more = []; } }
      if (old !== undefined && old !== page) this.paintPage(old);
      this.paintPage(page); this.renderProps(); this.app.updateStatus();
      if (hit && !e.shiftKey) { this.drag = { kind: 'move', page, x0: x, y0: y, dx: 0, dy: 0, moved: false }; return true; }
      if (!hit) { // 빈 곳에서 끌면 범위 안의 것을 모두 고른다
        const preview = svgEl('rect', { class: 'marquee', x, y, width: 0, height: 0 });
        this.drag = { kind: 'marquee', page, x0: x, y0: y, x, y, preview, add: e.shiftKey };
        return true;
      }
      return true;
    }
    // 도형·글상자 도구에서도 방금 넣은(고른) 것은 바로 크기 조절·옮기기
    if (SHAPE_TOOLS.has(t)) {
      const s = this.sel;
      if (s?.kind === 'obj' && s.page === page) {
        const hn = this.handleAt(x, y);
        if (hn) { const r0 = { ...s.obj.rect }; this.drag = { kind: 'resize', page, x0: x, y0: y, handle: hn, r0, r: r0 }; return true; }
        if (t === 'textbox' && inRect(s.obj.rect, x, y, 2)) { this.drag = { kind: 'move', page, x0: x, y0: y, dx: 0, dy: 0, moved: false }; return true; }
      }
      const o = t === 'textbox' ? this.hitObj(page, x, y) : null;
      if (o?.type === 'textbox') {
        const old = this.sel?.page;
        this.sel = { kind: 'obj', page, key, obj: o };
        if (old !== undefined && old !== page) this.paintPage(old);
        this.paintPage(page); this.renderProps(); this.app.updateStatus();
        this.drag = { kind: 'move', page, x0: x, y0: y, dx: 0, dy: 0, moved: false }; return true;
      }
      if (this.sel) { const old = this.sel.page; this.sel = null; this.paintPage(old); this.renderProps(); }
    }
    if (t === 'editText') {
      const run = this.hitRun(page, x, y);
      if (!this.now(this.runs, page)) { this.getRuns(page).then(() => this.paintPage(page)); this.getObjs(page); return true; }
      if (run) { this.openRunEditor(page, run); return true; }
      const tb = this.hitObj(page, x, y);
      if (tb?.type === 'textbox') { this.openTextBoxEditor(page, tb.rect, tb); return true; }
      toast('여기에는 고칠 수 있는 글자가 없습니다. 새 글자는 “글자 추가”를 쓰세요.'); return true;
    }
    if (t === 'addText') {
      if (this.sel?.kind === 'run' && this.sel.page === page && inRect(this.sel.run.rect, x, y, 2)) { this.drag = { kind: 'move', page, x0: x, y0: y, dx: 0, dy: 0, moved: false }; return true; }
      this.sel = null; this.openNewTextEditor(page, x, y - this.props.fontSize * 0.7); return true;
    }
    if (t === 'aselect') {
      const a = this.hitAnnot(page, x, y);
      const old = this.sel?.page;
      this.sel = a ? { kind: 'annot', page, key, annot: a } : null;
      if (old !== undefined && old !== page) this.paintPage(old);
      this.paintPage(page); this.renderProps(); this.app.updateStatus();
      if (a) { this.highlightAnnotInList(a.id); return true; }
      return false;
    }
    if (t === 'note') { this.placeNote(page, x, y); return true; }
    if (t === 'highlight' || t === 'underline' || t === 'strike') {
      this.V.getText(page).then(td => {
        const idx = (this.V as any).charAt(td, x, y, false);
        this.V.sel = { a: { page, idx }, b: { page, idx } };
        this.drag = { kind: 'textsel', page };
      });
      return true;
    }
    if (t === 'pen' || t === 'free') {
      const pts: [number, number][] = [[x, y]];
      const path = svgEl('polyline', { class: 'ink-prev', points: `${x},${y}`, stroke: t === 'free' ? this.props.stroke : this.props.annotColor, 'stroke-width': this.props.width });
      this.drag = { kind: 'ink', page, pts, preview: path, free: t === 'free' };
      this.paintPage(page); return true;
    }
    // 끌어서 영역 정하기: 표, 도형, 영역 삭제, 주석 도형
    const preview = t === 'line' ? svgEl('line', { class: 'shape-prev', x1: x, y1: y, x2: x, y2: y }) : t === 'ellipse' || t === 'aellipse' ? svgEl('ellipse', { class: 'shape-prev', cx: x, cy: y, rx: 0, ry: 0 }) : svgEl('rect', { class: 'shape-prev' + (t === 'redact' ? ' redact' : ''), x, y, width: 0, height: 0 });
    this.drag = { kind: 'area', page, x0: x, y0: y, x, y, preview };
    this.paintPage(page);
    return true;
  }
  private move(e: PointerEvent, page: number, x: number, y: number) {
    const d = this.drag; if (!d) return;
    if (d.kind === 'move') {
      if (page !== d.page) return;
      d.dx = x - d.x0; d.dy = y - d.y0;
      if (!d.moved && Math.hypot(d.dx, d.dy) * this.V.zoom > 3) d.moved = true;
      if (d.moved) this.paintPage(d.page);
    } else if (d.kind === 'resize') {
      const r0: Rect = d.r0, hn: string = d.handle, dx = x - d.x0, dy = y - d.y0;
      let nx = r0.x, ny = r0.y, nw = r0.w, nh = r0.h;
      if (hn.includes('e')) nw = r0.w + dx;
      if (hn.includes('w')) { nw = r0.w - dx; nx = r0.x + dx; }
      if (hn.includes('s')) nh = r0.h + dy;
      if (hn.includes('n')) { nh = r0.h - dy; ny = r0.y + dy; }
      const obj = this.sel?.kind === 'obj' ? this.sel.obj : null;
      const corner = hn.length === 2;
      const keep = corner && (obj?.type === 'image' ? this.props.keepRatio !== e.shiftKey : e.shiftKey);
      if (keep && r0.w > 0 && r0.h > 0) {
        const k = Math.max(nw / r0.w, nh / r0.h);
        nw = r0.w * k; nh = r0.h * k;
        if (hn.includes('w')) nx = r0.x + r0.w - nw;
        if (hn.includes('n')) ny = r0.y + r0.h - nh;
      }
      const min = 4;
      if (nw < min) { if (hn.includes('w')) nx -= min - nw; nw = min; }
      if (nh < min) { if (hn.includes('n')) ny -= min - nh; nh = min; }
      d.r = { x: nx, y: ny, w: nw, h: nh };
      this.paintPage(d.page);
    } else if (d.kind === 'textsel' && this.V.sel) {
      this.V.getText(page).then(td => { if (!this.V.sel) return; this.V.sel.b = { page, idx: (this.V as any).charAt(td, x, y, false) }; this.V.redrawSel(); });
    } else if (d.kind === 'ink' && page === d.page) {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) * this.V.zoom < 1.5) return;
      d.pts.push([x, y]); d.preview.setAttribute('points', d.pts.map((p: number[]) => p.join(',')).join(' '));
    } else if (d.kind === 'marquee' && page === d.page) {
      d.x = x; d.y = y;
      d.preview.setAttribute('x', Math.min(d.x0, x)); d.preview.setAttribute('y', Math.min(d.y0, y));
      d.preview.setAttribute('width', Math.abs(x - d.x0)); d.preview.setAttribute('height', Math.abs(y - d.y0));
      this.paintPage(d.page);
    } else if (d.kind === 'area' && page === d.page) {
      d.x = x; d.y = y;
      const p = d.preview, x0 = Math.min(d.x0, x), y0 = Math.min(d.y0, y), w = Math.abs(x - d.x0), hh = Math.abs(y - d.y0);
      if (p.tagName === 'line') { p.setAttribute('x2', x); p.setAttribute('y2', y); }
      else if (p.tagName === 'ellipse') { p.setAttribute('cx', x0 + w / 2); p.setAttribute('cy', y0 + hh / 2); p.setAttribute('rx', w / 2); p.setAttribute('ry', hh / 2); }
      else { p.setAttribute('x', x0); p.setAttribute('y', y0); p.setAttribute('width', w); p.setAttribute('height', hh); }
    }
  }
  private async up(_e: PointerEvent, _page: number, _x: number, _y: number) {
    const d = this.drag; this.drag = null; if (!d) return;
    const key = this.V.pages[d.page]?.key;
    try {
      if (d.kind === 'move' && d.moved && this.sel) await this.moveSel(d.dx, d.dy);
      else if (d.kind === 'resize' && this.sel?.kind === 'obj' && !this.sameRect(d.r, d.r0)) await this.resizeSel(d.r0, d.r, d.handle);
      else if (d.kind === 'textsel') await this.markupFromSelection();
      else if (d.kind === 'marquee') await this.marqueeDone(d);
      else if (d.kind === 'ink' && d.free) {
        const ch = await this.E.call<ObjChange>('addFree', [this.doc.id, key, { points: d.pts, stroke: this.props.stroke, width: this.props.width }]);
        this.objEntry('자유선', ch); await this.afterCreate(d.page, ch.added[0]?.h);
      } else if (d.kind === 'ink' && d.pts.length > 1) {
        const id = await this.E.call<number>('addAnnot', [this.doc.id, key, { subtype: ANNOT.INK, ink: [d.pts], color: this.props.annotColor, width: this.props.width }]);
        this.annotEntry('펜', key, id);
      } else if (d.kind === 'area') {
        const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
        const big = r.w > 3 || r.h > 3;
        if (this.tool === 'textbox') this.openTextBoxEditor(d.page, { x: r.x, y: r.y, w: Math.max(r.w, 120), h: Math.max(r.h, 30) });
        else if (big || this.tool === 'table') await this.areaDone(d.page, key, r, d);
      }
    } catch (err: any) { toast('하지 못했습니다: ' + err.message); }
    this.paintPage(d.page);
  }
  private async marqueeDone(d: any) {
    const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
    if (r.w * this.V.zoom < 4 && r.h * this.V.zoom < 4) return;
    const page = d.page, key = this.V.pages[page].key;
    const [runs, objs] = await Promise.all([this.getRuns(page), this.getObjs(page)]);
    const inside = (q: Rect) => q.x >= r.x && q.y >= r.y && q.x + q.w <= r.x + r.w && q.y + q.h <= r.y + r.h;
    const got: Sel[] = [
      ...runs.filter(x => !x.invisible && inside(x.rect)).map(run => ({ kind: 'run', page, key, run }) as Sel),
      ...objs.filter(o => inside(o.rect) && !o.vis?.ghost).map(obj => ({ kind: 'obj', page, key, obj }) as Sel)];
    const all = d.add && this.sel?.page === page ? [...this.allSel()] : [];
    for (const g of got) if (!all.some(a => this.sameSel(a, g))) all.push(g);
    this.sel = all[0] || null; this.more = all.slice(1);
    this.renderProps(); this.app.updateStatus();
  }
  private dbl(_e: MouseEvent, page: number, x: number, y: number) {
    if (this.tool === 'select' || this.tool === 'editText' || this.tool === 'textbox') {
      const run = this.hitRun(page, x, y);
      if (run) { this.openRunEditor(page, run); return true; }
      const obj = this.hitObj(page, x, y);
      if (obj?.type === 'textbox') { this.openTextBoxEditor(page, obj.rect, obj); return true; }
    }
    if (this.tool === 'aselect') {
      const a = this.hitAnnot(page, x, y);
      if (a) { this.editAnnotContents(a); return true; }
    }
    return false;
  }

  /* ───────────── 되돌리기 ───────────── */
  private push(e: Entry) {
    this.undoS.push(e); if (this.undoS.length > 200) this.undoS.shift();
    this.redoS = []; this.updateUndo(); this.app.markDirty();
  }
  private updateUndo() {
    this.undoBtn.disabled = !this.undoS.length; this.redoBtn.disabled = !this.redoS.length;
    this.undoBtn.title = this.undoS.length ? `되돌리기: ${this.undoS[this.undoS.length - 1].label} (Ctrl+Z)` : '되돌리기 (Ctrl+Z)';
    this.redoBtn.title = this.redoS.length ? `다시 하기: ${this.redoS[this.redoS.length - 1].label} (Ctrl+Y)` : '다시 하기 (Ctrl+Y)';
    this.countEl.textContent = this.undoS.length ? `변경 ${this.undoS.length}건` : '';
  }
  async undo() { await this.step(this.undoS, this.redoS, 'undo'); }
  async redo() { await this.step(this.redoS, this.undoS, 'redo'); }
  private async step(from: Entry[], to: Entry[], dir: 'undo' | 'redo') {
    await this.commitPending();
    const e = from.pop(); if (!e) return;
    let ok: boolean | void;
    try { ok = await e[dir](); }
    catch (err: any) { from.push(e); toast(`“${e.label}”을 ${dir === 'undo' ? '되돌리지' : '다시 하지'} 못했습니다: ${err.message}`); return; }
    if (ok === false) toast(`“${e.label}”은 ${dir === 'undo' ? '되돌릴' : '다시 할'} 수 없습니다 (그 쪽이 다시 만들어졌습니다).`);
    to.push(e);
    this.sel = null;
    if (e.structural) { this.dropCaches(); await this.app.reloadPages(); }
    for (const k of e.keys) this.changed(k);
    this.updateUndo(); this.renderProps(); this.refreshAnnotList();
    toast(`${dir === 'undo' ? '되돌림' : '다시 함'}: ${e.label}`, 1400);
  }
  private objEntry(label: string, ch: ObjChange) {
    const id = this.doc.id;
    this.push({
      label, keys: [ch.key],
      undo: async () => { const a = await this.E.call('detach', [id, ch.key, ch.gen, ch.added]); const b = await this.E.call('attach', [id, ch.key, ch.gen, ch.removed]); return a !== false && b !== false; },
      redo: async () => { const a = await this.E.call('detach', [id, ch.key, ch.gen, ch.removed]); const b = await this.E.call('attach', [id, ch.key, ch.gen, ch.added]); return a !== false && b !== false; },
    });
    this.changed(ch.key);
    for (const k of ch.also || []) this.changed(k);
    if (ch.also?.length) toast(`같은 양식을 함께 쓰는 다른 쪽 ${ch.also.length}곳도 정리했습니다 (그쪽 내용은 그대로입니다).`, 3600);
  }
  private annotEntry(label: string, key: number, aid: number) {
    const id = this.doc.id;
    this.push({ label, keys: [key], undo: () => this.E.call('setAnnotRemoved', [id, key, aid, true]), redo: () => this.E.call('setAnnotRemoved', [id, key, aid, false]) });
    this.changed(key); this.refreshAnnotList();
  }

  /* ───────────── 원본 글자 고치기 ───────────── */
  private fontFor(run: TextRun) { return SERIF.test(run.font) ? '"Noto Serif KR", "Batang", "AppleMyungjo", serif' : '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'; }
  private placeEditor(page: number, r: Rect, size: number, opts: { font: string; color: string; bold: boolean; text: string; minW?: number }) {
    const pe = this.V.pageEl(page); if (!pe) return null;
    const z = this.V.zoom, p = this.V.pages[page];
    const ta = h('textarea', { class: 'ed-text', spellcheck: 'false', 'aria-label': '글자 입력', wrap: 'off', cols: '1', rows: '1' }) as HTMLTextAreaElement;
    ta.value = opts.text;
    this.clearSelFor(page);
    Object.assign(ta.style, { left: r.x / p.w * 100 + '%', top: r.y / p.h * 100 + '%', fontSize: size * z + 'px', fontFamily: opts.font, color: opts.color, fontWeight: opts.bold ? '700' : '400', minWidth: (opts.minW || 40) * z + 'px', minHeight: size * 1.35 * z + 'px' });
    const fit = () => { ta.style.height = 'auto'; ta.style.width = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(ta.scrollWidth + size * z, (opts.minW || 0) * z) + 'px'; };
    ta.addEventListener('input', fit);
    pe.edit.append(ta); fit();
    ta.focus(); ta.select();
    requestAnimationFrame(() => { if (document.activeElement !== ta) { ta.focus(); ta.select(); } });
    return ta;
  }
  private openRunEditor(page: number, run: TextRun) {
    this.commitPending();
    const key = this.V.pages[page].key;
    if (run.angle) toast('기울어진 글자도 고칠 수 있지만 입력 칸은 똑바로 보입니다.', 2200);
    const ta = this.placeEditor(page, { x: run.rect.x - 2, y: run.rect.y - run.size * 0.12, w: run.rect.w, h: run.rect.h }, run.size, { font: this.fontFor(run), color: run.color, bold: run.bold, text: run.text, minW: run.rect.w + 4 });
    if (!ta) return;
    ta.classList.add('cover');
    let done = false;
    const commit = async (cancel = false) => {
      if (done) return; done = true; this.editing = null;
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      if (cancel || text === run.text) return;
      try {
        if (!text) { const ch = await this.E.call<ObjChange>('removeObjs', [this.doc.id, key, run.objs]); this.objEntry('글자 지우기', ch); return; }
        const ch = await this.E.call<ObjChange>('editRun', [this.doc.id, key, run.objs, text]);
        this.objEntry('글자 고치기', ch);
        if (ch.substituted && !this.warnedSub) { this.warnedSub = true; toast('원래 글꼴에 없는 글자가 있어 그 줄은 Noto Sans KR 글꼴로 넣었습니다. 글자로 저장되어 검색·복사가 됩니다.', 5200); }
      } catch (e: any) { toast('글자를 고치지 못했습니다: ' + e.message); }
    };
    this.bindEditorKeys(ta, commit);
    this.editing = { ta, commit, kind: 'run', at: { page, x: run.rect.x + Math.min(4, run.rect.w / 2), y: run.rect.y + run.rect.h / 2 } };
  }
  private openNewTextEditor(page: number, x: number, y: number) {
    this.commitPending();
    const key = this.V.pages[page].key;
    const ta = this.placeEditor(page, { x, y, w: 0, h: 0 }, this.props.fontSize, { font: fontCss(this.props.font), color: this.props.textColor, bold: this.props.bold, text: '', minW: 60 });
    if (!ta) return;
    ta.classList.add('new');
    const restyle = () => Object.assign(ta.style, { fontSize: this.props.fontSize * this.V.zoom + 'px', fontFamily: fontCss(this.props.font), color: this.props.textColor, fontWeight: this.props.bold ? '700' : '400' });
    let done = false;
    const commit = async (cancel = false) => {
      if (done) return; done = true; this.editing = null;
      const text = ta.value.replace(/\s+$/, ''); ta.remove();
      if (cancel || !text) return;
      try {
        await ensureFont(this.app, this.props.font);
        const ch = await this.E.call<ObjChange>('addText', [this.doc.id, key, { x: x + 2, y: y + 1, text, size: this.props.fontSize, color: this.props.textColor, bold: this.props.bold, font: this.props.font }]);
        this.objEntry('글자 추가', ch);
        await this.afterCreate(page, ch.added[0]?.h, 'run'); // 넣은 글자를 골라 둔다 → 바로 색·크기·글꼴을 바꿀 수 있다
        this.app.status.querySelector('.st-hint')!.textContent = '넣은 글자가 골라져 있습니다 · 위에서 색·크기·글꼴을 바로 바꿀 수 있습니다';
      } catch (e: any) { toast('글자를 넣지 못했습니다: ' + e.message); }
    };
    this.bindEditorKeys(ta, commit);
    this.editing = { ta, commit, kind: 'new', restyle };
  }
  /** 글상자 입력: 폭이 정해진 상자 안에서 줄이 바뀐다 */
  private openTextBoxEditor(page: number, r: Rect, existing?: PageObjInfo) {
    this.commitPending();
    const pe = this.V.pageEl(page); if (!pe) return;
    const key = this.V.pages[page].key, p = this.V.pages[page], z = this.V.zoom;
    const m = existing?.meta;
    if (m) Object.assign(this.props, { font: m.font || 'noto-sans', textColor: m.color, fontSize: m.size, bold: !!m.bold, align: m.align || 'left', border: m.border || '', tbFill: m.fill || '' });
    const ta = h('textarea', { class: 'ed-text box', spellcheck: 'false', 'aria-label': '글상자 내용' }) as HTMLTextAreaElement;
    this.clearSelFor(page);
    ta.value = m?.text || '';
    const restyle = () => Object.assign(ta.style, {
      left: r.x / p.w * 100 + '%', top: r.y / p.h * 100 + '%', width: r.w * z + 'px', minHeight: r.h * z + 'px',
      fontSize: this.props.fontSize * z + 'px', fontFamily: fontCss(this.props.font), color: this.props.textColor, fontWeight: this.props.bold ? '700' : '400',
      textAlign: this.props.align, padding: 6 * z + 'px', background: this.props.tbFill || 'rgba(255,255,255,.92)', borderColor: this.props.border || 'var(--edit)', lineHeight: '1.3', whiteSpace: 'pre-wrap',
    });
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, r.h * z) + 'px'; };
    restyle(); ta.addEventListener('input', fit);
    pe.edit.append(ta); fit();
    const place = () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };
    place(); requestAnimationFrame(() => { if (document.activeElement !== ta) place(); });
    this.renderProps();
    let done = false;
    const commit = async (cancel = false) => {
      if (done) return; done = true; this.editing = null;
      const text = ta.value.replace(/\s+$/, ''); ta.remove();
      if (cancel) return;
      try {
        await ensureFont(this.app, this.props.font);
        const spec = { ...(m || {}), x: r.x, y: r.y, w: r.w, minH: m?.minH ?? r.h, text, font: this.props.font, size: this.props.fontSize, color: this.props.textColor, bold: this.props.bold, align: this.props.align, border: this.props.border, bw: m?.bw ?? 1, fill: this.props.tbFill, pad: 6 };
        if (existing && !text) { const ch = await this.E.call<ObjChange>('removeObjs', [this.doc.id, key, existing.objs]); this.objEntry('글상자 지우기', ch); this.sel = null; return; }
        if (!text) return;
        const ch = await this.E.call<ObjChange>(existing ? 'replaceTextBox' : 'addTextBox', existing ? [this.doc.id, key, existing.objs, spec] : [this.doc.id, key, spec]);
        this.objEntry(existing ? '글상자 고치기' : '글상자', ch);
        if (existing) await this.reselectObj(page, ch.added[0]?.h); else await this.afterCreate(page, ch.added[0]?.h);
      } catch (e: any) { toast('글상자를 넣지 못했습니다: ' + e.message); }
    };
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); commit(true); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } });
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta && !document.activeElement?.closest('.ribbon-wrap')) commit(); }, 0));
    ta.addEventListener('pointerdown', e => e.stopPropagation());
    this.editing = { ta, commit, kind: 'box', restyle };
  }
  private bindEditorKeys(ta: HTMLTextAreaElement, commit: (c?: boolean) => Promise<void>) {
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); commit(true); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commit(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta && !document.activeElement?.closest('.ribbon-wrap')) commit(); }, 0));
    ta.addEventListener('pointerdown', e => e.stopPropagation());
  }

  /* ───────────── 고른 것 옮기기 / 크기 / 지우기 ───────────── */
  private selObjs(): number[] { return this.allSel().flatMap(s => s.kind === 'run' ? s.run.objs : s.kind === 'obj' ? (s.obj.objs || [s.obj.h]) : []); }
  private async moveSel(dx: number, dy: number, merge = false) {
    const s = this.sel; if (!s || s.kind === 'annot') return;
    const id = this.doc.id, key = s.key, objs = this.selObjs();
    const gen = await this.E.call<number>('pageGen', [id, key]);
    const tr: any = await this.E.call('transformObjs', [id, key, gen, objs, dx, dy]);
    for (const k of tr?.also || []) this.changed(k);
    const shift = (r: Rect) => { r.x += dx; r.y += dy; };
    for (const x of this.allSel()) shift(this.rectOf(x));
    if (merge && this.undoS.length && (this.undoS[this.undoS.length - 1] as any).nudgeKey === objs.join()) {
      const last: any = this.undoS[this.undoS.length - 1]; last.dx += dx; last.dy += dy;
    } else {
      const entry: any = {
        label: '옮기기', keys: [key], nudgeKey: objs.join(), dx, dy,
        undo: () => this.E.call('transformObjs', [id, key, gen, objs, -entry.dx, -entry.dy]),
        redo: () => this.E.call('transformObjs', [id, key, gen, objs, entry.dx, entry.dy]),
      };
      this.push(entry);
    }
    const keep = this.sel, keepMore = this.more;
    this.changed(key);
    this.sel = keep; this.more = keepMore; this.paintPage(s.page);
  }
  /** 겹친 순서 바꾸기 (고른 것 모두) */
  async arrange(how: 'front' | 'back' | 'forward' | 'backward') {
    const s = this.sel; if (!s || s.kind === 'annot') return;
    const id = this.doc.id, key = s.key, objs = this.selObjs(), keepSel = this.sel, keepMore = this.more;
    try {
      const r = await this.E.call<{ before: { h: number; idx: number }[]; also: number[]; changed: boolean }>('reorder', [id, key, objs, how]);
      for (const k of r.also) this.changed(k);
      if (!r.changed) { toast(how === 'forward' ? '이미 겹친 객체 중 맨 앞에 있습니다.' : how === 'backward' ? '이미 겹친 객체 중 맨 뒤에 있습니다.' : '순서가 바뀌지 않았습니다.'); return; }
      const label = { front: '맨 앞으로 가져오기', back: '맨 뒤로 보내기', forward: '앞으로 가져오기', backward: '뒤로 보내기' }[how];
      this.push({ label, keys: [key], undo: () => this.E.call('restoreOrder', [id, key, r.before]), redo: () => this.E.call('reorder', [id, key, objs, how]) });
      this.changed(key);
      this.sel = keepSel; this.more = keepMore; this.paintPage(s.page); this.renderProps();
    } catch (e: any) { toast('순서를 바꾸지 못했습니다: ' + e.message); }
  }
  private arrangeMenu(ev: MouseEvent) {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const k = (id: string) => this.app.shortcuts.label(id);
    menu({ x: r.left, y: r.bottom + 4 }, [
      { label: '맨 앞으로 가져오기', icon: 'front', hint: k('arrangeFront'), action: () => this.arrange('front') },
      { label: '앞으로 가져오기', icon: 'up', hint: k('arrangeForward'), action: () => this.arrange('forward') },
      { label: '뒤로 보내기', icon: 'down', hint: k('arrangeBackward'), action: () => this.arrange('backward') },
      { label: '맨 뒤로 보내기', icon: 'back', hint: k('arrangeBack'), action: () => this.arrange('back') },
    ]);
  }
  async deleteSel() {
    const s = this.sel; if (!s) return;
    const objs = this.selObjs(), many = this.more.length;
    this.sel = null; this.more = [];
    if (s.kind === 'annot') {
      await this.E.call('setAnnotRemoved', [this.doc.id, s.key, s.annot.id, true]);
      const id = this.doc.id;
      this.push({ label: '주석 지우기', keys: [s.key], undo: () => this.E.call('setAnnotRemoved', [id, s.key, s.annot.id, false]), redo: () => this.E.call('setAnnotRemoved', [id, s.key, s.annot.id, true]) });
      this.changed(s.key); this.refreshAnnotList();
    } else {
      const ch = await this.E.call<ObjChange>('removeObjs', [this.doc.id, s.key, objs]);
      this.objEntry(many ? `${many + 1}개 지우기` : s.kind === 'run' ? '글자 지우기' : '객체 지우기', ch);
    }
    this.renderProps(); this.app.updateStatus();
  }

  /* ───────────── 영역 도구 ───────────── */
  private async areaDone(page: number, key: number, r: Rect, d: { x0: number; y0: number; x: number; y: number }) {
    const t = this.tool, P = this.props, id = this.doc.id;
    if (t === 'rect' || t === 'ellipse' || t === 'line') {
      const spec: any = t === 'line'
        ? { kind: 'line', x: d.x0, y: d.y0, w: d.x - d.x0, h: d.y - d.y0, stroke: P.stroke, width: P.width }
        : { kind: t, ...r, stroke: P.stroke, width: P.width, fill: P.fill === 'same' ? P.stroke : P.fill || undefined };
      const ch = await this.E.call<ObjChange>('addShape', [id, key, spec]);
      this.objEntry(t === 'line' ? '선' : t === 'rect' ? '사각형' : '원', ch);
      await this.afterCreate(page, ch.added[0]?.h); // 방금 그린 도형을 골라 둔다 → 색·굵기·크기를 바로 고칠 수 있다
    } else if (t === 'redact') {
      const textOnly = P.redactWhat === 'text';
      if (!(await confirmBox(textOnly ? '영역의 글자만 지우기' : '영역 삭제', (textOnly ? '고른 영역의 글자만 PDF에서 실제로 지웁니다. 그림·선·표 테두리는 그대로 남습니다.' : '고른 영역의 글자·그림·선을 PDF에서 실제로 지웁니다. 덮어 가리는 것이 아니어서 개인정보를 지울 때 안전합니다.') + ' 이 작업은 되돌릴 수 없고, 지금까지의 되돌리기 기록도 비워집니다.', '지우기', true))) return;
      if (textOnly) await this.E.call('redactText', [id, key, r]);
      else await this.E.call('redact', [id, key, r, P.redactFill === 'black' ? '#000000' : null]);
      this.undoS = []; this.redoS = []; this.updateUndo();
      this.changed(key); this.app.markDirty();
      toast(textOnly ? '영역의 글자를 지웠습니다.' : '영역의 내용을 지웠습니다.');
    } else if (t === 'arect' || t === 'aellipse') {
      const aid = await this.E.call<number>('addAnnot', [id, key, { subtype: t === 'arect' ? ANNOT.SQUARE : ANNOT.CIRCLE, rect: r, color: P.annotColor, width: P.width }]);
      this.annotEntry(t === 'arect' ? '사각 표시' : '원 표시', key, aid);
    } else if (t === 'table') {
      await this.tableDialog(page, key, r);
    }
  }

  /* ───────────── 표 ───────────── */
  private async tableDialog(page: number, key: number, r: Rect) {
    const p = this.V.pages[page];
    if (r.w < 40 || r.h < 20) { const w = Math.min(360, p.w - r.x - 20); r = { x: r.x, y: r.y, w: Math.max(120, w), h: 66 }; }
    const rows = h('input', { class: 'field num', type: 'number', value: '3', min: '1', max: '60' });
    const cols = h('input', { class: 'field num', type: 'number', value: '3', min: '1', max: '20' });
    const head = h('input', { type: 'checkbox', checked: '' });
    const res = await dialog({
      title: '표 넣기', body: h('div', { class: 'form grid2' }, h('label', { class: 'lbl' }, '줄 수'), rows, h('label', { class: 'lbl' }, '칸 수'), cols, h('label', { class: 'chk' }, head, ' 첫 줄을 제목 줄로 (배경색·굵게)')),
      buttons: [{ label: '취소', value: false }, { label: '다음: 내용 입력', value: true, primary: true }],
      collect: () => ({ rows: +rows.value, cols: +cols.value, head: (head as HTMLInputElement).checked }),
    });
    if (!res?.value) return;
    const R = Math.max(1, Math.min(60, res.data.rows | 0)), C = Math.max(1, Math.min(20, res.data.cols | 0));
    const rowH = Math.max(this.props.fontSize * 1.9, r.h / R);
    this.openTableEditor(page, key, { x: r.x, y: r.y, w: r.w, h: rowH * R }, R, C, res.data.head);
  }
  private tableState: any = null;
  private openTableEditor(page: number, key: number, r: Rect, R: number, C: number, head: boolean) {
    this.closeTableEditor();
    const grid = h('div', { class: 'tbl-grid', style: { gridTemplateColumns: `repeat(${C}, 1fr)` } });
    for (let i = 0; i < R * C; i++) grid.append(h('textarea', { class: 'tbl-cell' + (head && i < C ? ' head' : ''), rows: '1', 'aria-label': `${Math.floor(i / C) + 1}줄 ${i % C + 1}칸`, spellcheck: 'false' }));
    const bar = h('div', { class: 'tbl-bar' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => this.closeTableEditor() }, '취소'),
      h('button', { class: 'btn sm primary', type: 'button', onclick: () => this.commitTable() }, icon('check'), '표 넣기'));
    this.tableEd = h('div', { class: 'tbl-ed no-view-pointer' }, grid, bar);
    this.tableState = { page, key, r, R, C, head };
    this.V.pageEl(page)?.edit.append(this.tableEd);
    this.layoutTableEditor();
    (grid.firstElementChild as HTMLElement).focus();
    this.tableEd.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') this.closeTableEditor(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.commitTable(); });
  }
  private layoutTableEditor() {
    const s = this.tableState; if (!s || !this.tableEd) return;
    const p = this.V.pages[s.page];
    Object.assign(this.tableEd.style, { left: s.r.x / p.w * 100 + '%', top: s.r.y / p.h * 100 + '%', width: s.r.w / p.w * 100 + '%' });
    this.tableEd.querySelectorAll('.tbl-cell').forEach(c => Object.assign((c as HTMLElement).style, { fontSize: this.props.fontSize * this.V.zoom + 'px', height: s.r.h / s.R * this.V.zoom + 'px' }));
  }
  private closeTableEditor() { this.tableEd?.remove(); this.tableEd = null; this.tableState = null; }
  private async commitTable() {
    const s = this.tableState; if (!s || !this.tableEd) return;
    const vals = [...this.tableEd.querySelectorAll('.tbl-cell')].map(c => (c as HTMLTextAreaElement).value);
    const cells: string[][] = []; for (let i = 0; i < s.R; i++) cells.push(vals.slice(i * s.C, i * s.C + s.C));
    this.closeTableEditor();
    const P = this.props;
    try {
      const ch = await this.E.call<ObjChange>('addTable', [this.doc.id, s.key, {
        x: s.r.x, y: s.r.y, cols: Array(s.C).fill(s.r.w / s.C), rows: Array(s.R).fill(s.r.h / s.R), cells,
        fontSize: P.fontSize, color: '#1a1a1a', border: P.stroke === '#d0342c' ? '#3a3f4b' : P.stroke, borderWidth: Math.min(P.width, 1.5), padding: 4, font: P.font,
        headerFill: s.head ? '#e9edf5' : undefined, headerBold: s.head,
      }]);
      this.objEntry('표 넣기', ch);
      if (!this.toolLock) this.setTool('select');
      toast('표를 넣었습니다. 칸 글자는 “글자 고치기”로 나중에 고칠 수 있습니다.');
    } catch (e: any) { toast('표를 넣지 못했습니다: ' + e.message); }
  }

  /* ───────────── 이미지 / 서명 ───────────── */
  private pickImage() {
    const i = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp' });
    i.onchange = () => { if (i.files?.[0]) this.dropImages([i.files[0]]); };
    i.click();
  }
  async dropImages(files: File[]) { for (const f of files) await this.insertImage(f); }
  private async insertImage(blob: Blob, opts: { widthPt?: number } = {}) {
    try {
      const bmp = await createImageBitmap(blob);
      const max = 3000, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
      const jpg = blob.type === 'image/jpeg';
      const out: Blob = await new Promise(res => c.toBlob(b => res(b!), jpg ? 'image/jpeg' : 'image/png', 0.92));
      const bytes = new Uint8Array(await out.arrayBuffer());
      const page = this.V.current, key = this.V.pages[page].key, p = this.V.pages[page];
      let w = opts.widthPt || Math.min(p.w * 0.45, c.width * 0.6); let hh = w * c.height / c.width;
      if (hh > p.h * 0.6) { hh = p.h * 0.6; w = hh * c.width / c.height; }
      const s = this.V.slots[page], vt = Math.max(0, (this.V.el.scrollTop - s.top) / this.V.zoom), vb = Math.min(p.h, (this.V.el.scrollTop + this.V.el.clientHeight - s.top) / this.V.zoom);
      const rect = { x: (p.w - w) / 2, y: Math.max(8, Math.min(p.h - hh - 8, (vt + vb) / 2 - hh / 2)), w, h: hh };
      const ch = await this.E.call<ObjChange>('addImage', [this.doc.id, key, { bytes, kind: jpg ? 'jpg' : 'png', ...rect }]);
      this.objEntry('이미지 넣기', ch);
      this.setTool('select');
      this.sel = { kind: 'obj', page, key, obj: { h: ch.added[0].h, type: 'image', rect } };
      this.paintPage(page); this.renderProps();
      toast('이미지를 넣었습니다. 끌어서 옮기고, 모서리·가장자리 점으로 크기를 바꿉니다 (비율 유지는 위 칸에서).');
    } catch (e: any) { toast('이미지를 넣지 못했습니다: ' + e.message); }
  }
  private async signature() {
    const c = h('canvas', { class: 'sign-pad', width: '1200', height: '420' }) as HTMLCanvasElement;
    const g = c.getContext('2d')!; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = '#1b2a6b';
    let drawing = false, any = false, last: [number, number] = [0, 0];
    const pt = (e: PointerEvent): [number, number] => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    c.addEventListener('pointerdown', e => { drawing = true; any = true; last = pt(e); c.setPointerCapture(e.pointerId); g.beginPath(); g.arc(last[0], last[1], 3.5, 0, 7); g.fillStyle = g.strokeStyle as string; g.fill(); });
    c.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); g.beginPath(); g.moveTo(...last); g.lineTo(...p); g.stroke(); last = p; });
    c.addEventListener('pointerup', () => drawing = false);
    const clear = h('button', { class: 'btn sm', type: 'button', onclick: () => { g.clearRect(0, 0, c.width, c.height); any = false; } }, '다시 그리기');
    const colors = h('div', { class: 'swatches' }, ...['#1b2a6b', '#1a1a1a', '#c0262d'].map(col => h('button', { class: 'sw', type: 'button', style: { background: col }, 'aria-label': '펜 색', onclick: () => { g.strokeStyle = col; } })));
    const r = await dialog({ title: '서명 그리기', wide: true, body: h('div', { class: 'sign-wrap' }, c, h('div', { class: 'sign-tools' }, colors, clear)), buttons: [{ label: '취소', value: false }, { label: '서명 넣기', value: true, primary: true }] });
    if (!r?.value || !any) return;
    // 여백 잘라내기
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 12, cw = x1 - x0 + pad * 2, chh = y1 - y0 + pad * 2;
    const out = h('canvas', { width: String(cw), height: String(chh) }) as HTMLCanvasElement;
    out.getContext('2d')!.drawImage(c, x0 - pad, y0 - pad, cw, chh, 0, 0, cw, chh);
    const blob: Blob = await new Promise(res => out.toBlob(b => res(b!), 'image/png'));
    await this.insertImage(blob, { widthPt: 140 });
  }

  /* ───────────── 주석 ───────────── */
  private async markupFromSelection() {
    const parts = this.V.selection();
    this.V.clearSelection();
    if (!parts.length) return;
    const t = this.tool;
    const subtype = t === 'highlight' ? ANNOT.HIGHLIGHT : t === 'underline' ? ANNOT.UNDERLINE : ANNOT.STRIKEOUT;
    const label = t === 'highlight' ? '형광펜' : t === 'underline' ? '밑줄' : '취소선';
    for (const part of parts) {
      if (!part.rects.length) continue;
      const key = this.V.pages[part.page].key;
      const aid = await this.E.call<number>('addAnnot', [this.doc.id, key, {
        subtype, quads: part.rects, color: t === 'highlight' ? this.props.hl : this.props.annotColor,
        opacity: t === 'highlight' ? this.props.opacity : undefined, contents: part.text.trim().slice(0, 500),
      }]);
      this.annotEntry(label, key, aid);
    }
  }
  private async placeNote(page: number, x: number, y: number) {
    const text = await this.noteDialog('메모 붙이기', '');
    if (text === null) return;
    const key = this.V.pages[page].key;
    const aid = await this.E.call<number>('addAnnot', [this.doc.id, key, { subtype: ANNOT.TEXT, point: { x, y }, contents: text, color: this.props.annotColor === '#d0342c' ? '#ffd400' : this.props.annotColor }]);
    this.annotEntry('메모', key, aid);
  }
  private async noteDialog(title: string, value: string) {
    const ta = h('textarea', { class: 'field note-field', rows: '5', 'aria-label': '메모 내용' }, value) as HTMLTextAreaElement;
    const r = await dialog({ title, body: h('div', { class: 'form' }, ta, h('p', { class: 'hint' }, `작성자: ${this.app.prefs.author || '사용자'} · 도구 → 작성자 이름에서 바꿉니다.`)), buttons: [{ label: '취소', value: false }, { label: '저장', value: true, primary: true }], collect: () => ta.value });
    return r?.value ? (r.data as string) : null;
  }
  private async editAnnotContents(a: AnnotInfo) {
    const v = await this.noteDialog(`${a.kind} 내용`, a.contents);
    if (v === null || v === a.contents) return;
    const key = this.sel?.kind === 'annot' && this.sel.annot.id === a.id ? this.sel.key : this.V.pages[a.page].key, id = this.doc.id, old = a.contents;
    await this.E.call('updateAnnot', [id, key, a.id, { contents: v }]);
    this.push({ label: '주석 내용 고치기', keys: [key], undo: () => this.E.call('updateAnnot', [id, key, a.id, { contents: old }]), redo: () => this.E.call('updateAnnot', [id, key, a.id, { contents: v }]) });
    this.changed(key); this.refreshAnnotList();
  }
  private listT = 0;
  refreshAnnotList() {
    clearTimeout(this.listT);
    this.listT = window.setTimeout(() => this.buildAnnotList(), 120);
  }
  private async buildAnnotList() {
    const panel = this.annotPanel?.firstElementChild as HTMLElement | undefined; if (!panel || !this.app.doc) return;
    const n = this.V.pages.length;
    const all: AnnotInfo[] = [];
    panel.innerHTML = '<p class="empty"><span class="spin sm"></span> 주석을 모으는 중…</p>';
    for (let i = 0; i < n; i++) { try { all.push(...(await this.getAnnots(i)).map(a => ({ ...a, page: i }))); } catch { /* */ } }
    panel.innerHTML = '';
    if (!all.length) { panel.append(h('p', { class: 'empty' }, '주석이 없습니다. 위의 주석 도구로 형광펜·메모·펜 표시를 남겨 보세요.')); return; }
    panel.append(h('div', { class: 'al-head' }, `주석 ${all.length}개`));
    let lastPage = -1;
    for (const a of all) {
      if (a.page !== lastPage) { panel.append(h('div', { class: 'al-page' }, `${a.page + 1}쪽`)); lastPage = a.page; }
      const d = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(a.modified);
      panel.append(h('div', { class: 'al-item', dataset: { id: String(a.id) } },
        h('button', { class: 'al-main', type: 'button', onclick: () => { this.V.scrollToRect(a.page, a.rect); this.setTab('annot'); this.setTool('aselect'); this.sel = { kind: 'annot', page: a.page, key: this.V.pages[a.page].key, annot: a }; this.paintPage(a.page); this.renderProps(); } },
          h('span', { class: 'al-dot', style: { background: a.color } }),
          h('span', { class: 'al-kind' }, a.kind),
          h('span', { class: 'al-meta' }, [a.author, d ? `${d[2]}.${d[3]} ${d[4] || ''}:${d[5] || ''}` : ''].filter(Boolean).join(' · ')),
          a.contents ? h('span', { class: 'al-text' }, a.contents) : null),
        h('div', { class: 'al-act' },
          h('button', { class: 'tb sm', type: 'button', title: '내용 고치기', 'aria-label': '내용 고치기', onclick: () => this.editAnnotContents(a) }, icon('edit')),
          h('button', { class: 'tb sm', type: 'button', title: '지우기', 'aria-label': '지우기', onclick: async () => { this.sel = { kind: 'annot', page: a.page, key: this.V.pages[a.page].key, annot: a }; await this.deleteSel(); } }, icon('trash')))));
    }
  }
  private highlightAnnotInList(id: number) {
    const p = this.annotPanel; if (!p) return;
    p.querySelector('.al-item.cur')?.classList.remove('cur');
    const it = p.querySelector(`.al-item[data-id="${id}"]`); it?.classList.add('cur'); it?.scrollIntoView({ block: 'nearest' });
  }

  /* ───────────── 쪽 다루기 ───────────── */
  private targets() { return this.app.sidebar.targetPages(); }
  /** scope: auto(고른 쪽이 있으면 그 쪽, 없으면 현재 쪽) / current / picked / all */
  async rotate(dir: number, scope: 'auto' | 'current' | 'picked' | 'all' = 'auto') {
    const all = this.V.pages.map(p => p.key);
    const keys = scope === 'all' ? all : scope === 'current' ? [all[this.V.current]] : scope === 'picked' ? all.filter(k => this.app.sidebar.selected.has(k)) : this.targets();
    if (!keys.length) { toast('고른 쪽이 없습니다. 왼쪽 쪽 목록에서 Ctrl+클릭으로 고르세요.'); return; }
    const id = this.doc.id;
    for (const k of keys) await this.E.call('rotatePage', [id, k, dir]);
    this.push({ label: '쪽 회전', keys, structural: true, undo: async () => { for (const k of keys) await this.E.call('rotatePage', [id, k, -dir]); }, redo: async () => { for (const k of keys) await this.E.call('rotatePage', [id, k, dir]); } });
    await this.app.reloadPages(); keys.forEach(k => this.changed(k));
    toast(`${keys.length === all.length ? '모든 쪽' : keys.length + '쪽'}을 ${dir > 0 ? '오른쪽' : '왼쪽'}으로 돌렸습니다.`, 1600);
  }
  /** 회전 단추: 범위 고르기 */
  private rotateMenu(ev: MouseEvent, dir: number) {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const picked = this.app.sidebar.selected.size;
    const dirName = dir > 0 ? '오른쪽' : '왼쪽';
    menu({ x: r.left, y: r.bottom + 4 }, [
      { label: `현재 쪽 (${this.V.current + 1}쪽) ${dirName}으로`, icon: dir > 0 ? 'rotR' : 'rotL', hint: dir > 0 ? 'Ctrl+]' : 'Ctrl+[', action: () => this.rotate(dir, 'current') },
      { label: `고른 쪽 ${picked ? `(${picked}쪽)` : '— 쪽 목록에서 고르세요'}`, icon: dir > 0 ? 'rotR' : 'rotL', action: () => this.rotate(dir, 'picked'), disabled: !picked },
      { label: `모든 쪽 (${this.V.pages.length}쪽) ${dirName}으로`, icon: dir > 0 ? 'rotR' : 'rotL', hint: dir > 0 ? 'Ctrl+Shift+]' : '', action: () => this.rotate(dir, 'all') },
    ]);
  }
  /** 여러 쪽을 한 자리(at: 옮기기 전 목록 기준 넣을 자리)로 옮긴다. 되돌리기는 한 번에 */
  async movePages(keys: number[], at: number) {
    const id = this.doc.id, order = this.V.pages.map(p => p.key), want = new Set(keys);
    const sel = order.filter(k => want.has(k));
    const pos = at - order.slice(0, at).filter(k => want.has(k)).length;
    // 바라는 최종 순서를 만든 뒤, 앞에서부터 다른 자리만 그 자리로 옮긴다
    const rest = order.filter(k => !want.has(k));
    const goal = [...rest.slice(0, pos), ...sel, ...rest.slice(pos)];
    const cur = [...order], moves: { key: number; from: number; to: number }[] = [];
    for (let i = 0; i < goal.length; i++) {
      if (cur[i] === goal[i]) continue;
      const from = cur.indexOf(goal[i]);
      moves.push({ key: goal[i], from, to: i }); cur.splice(from, 1); cur.splice(i, 0, goal[i]);
    }
    if (!moves.length) return;
    for (const m of moves) await this.E.call('movePage', [id, m.key, m.to]);
    this.push({ label: sel.length > 1 ? `${sel.length}쪽 옮기기` : '쪽 옮기기', keys: [], structural: true,
      undo: async () => { for (const m of [...moves].reverse()) await this.E.call('movePage', [id, m.key, m.from]); },
      redo: async () => { for (const m of moves) await this.E.call('movePage', [id, m.key, m.to]); } });
    await this.app.reloadPages(pos);
  }
  async insertBlank(atIndex?: number) {
    const id = this.doc.id, at = atIndex ?? this.V.current + 1, ref = this.V.pages[Math.min(Math.max(0, at - 1), this.V.pages.length - 1)];
    const key = await this.E.call<number>('insertBlank', [id, at, ref.w, ref.h]);
    this.push({ label: '빈 쪽 넣기', keys: [], structural: true, undo: () => this.E.call('removePages', [id, [key]]), redo: () => this.E.call('insertBlank', [id, at, ref.w, ref.h, key]) });
    await this.app.reloadPages(at);
    toast(`${at + 1}쪽에 빈 쪽을 넣었습니다.`);
  }
  async deletePages() {
    const keys = this.targets(), id = this.doc.id;
    if (keys.length >= this.V.pages.length) { toast('모든 쪽을 지울 수는 없습니다.'); return; }
    if (keys.length > 1 && !(await confirmBox('쪽 삭제', `${keys.length}쪽을 지울까요? Ctrl+Z로 되돌릴 수 있습니다.`, '지우기', true))) return;
    if (this.editing) this.commitPending();
    const saved: { key: number; at: number; tmp: number }[] = [];
    const order = keys.map(k => ({ k, at: this.V.pages.findIndex(p => p.key === k) })).sort((a, b) => b.at - a.at);
    for (const { k, at } of order) saved.push({ key: k, at, tmp: await this.E.call<number>('deletePage', [id, k]) });
    const entry: Entry = {
      label: '쪽 삭제', keys: [], structural: true,
      undo: async () => { for (const s of [...saved].reverse()) await this.E.call('restorePage', [id, s.key, s.at, s.tmp]); },
      redo: async () => { for (const s of saved) s.tmp = await this.E.call<number>('deletePage', [id, s.key]); },
    };
    this.push(entry);
    this.app.sidebar.selected.clear();
    await this.app.reloadPages();
    toast(`${keys.length}쪽을 지웠습니다.`);
  }
  async movePage(key: number, to: number) {
    const id = this.doc.id, from = this.V.pages.findIndex(p => p.key === key);
    if (from === to || from < 0) return;
    await this.E.call('movePage', [id, key, to]);
    this.push({ label: '쪽 옮기기', keys: [], structural: true, undo: () => this.E.call('movePage', [id, key, from]), redo: () => this.E.call('movePage', [id, key, to]) });
    await this.app.reloadPages(to);
  }
  async shiftPages(dir: number) {
    const keys = this.targets();
    const idx = keys.map(k => this.V.pages.findIndex(p => p.key === k)).sort((a, b) => a - b);
    if (dir < 0 && idx[0] === 0 || dir > 0 && idx[idx.length - 1] === this.V.pages.length - 1) return;
    const id = this.doc.id;
    const seq = dir < 0 ? idx : [...idx].reverse();
    for (const i of seq) await this.E.call('movePage', [id, this.V.pages[i].key, i + dir]);
    const moves = seq.map(i => ({ key: this.V.pages[i].key, from: i, to: i + dir }));
    this.push({ label: '쪽 옮기기', keys: [], structural: true, undo: async () => { for (const m of [...moves].reverse()) await this.E.call('movePage', [id, m.key, m.from]); }, redo: async () => { for (const m of moves) await this.E.call('movePage', [id, m.key, m.to]); } });
    await this.app.reloadPages(this.V.current + dir);
  }
  async imagePages(files?: File[], atIndex?: number) {
    if (!files) files = await this.app.platform.pickImages();
    if (!files.length) return;
    const { loadImage } = await import('../tools.ts');
    const sel = h('select', { class: 'field' }, h('option', { value: 'a4' }, 'A4에 맞추기'), h('option', { value: 'image' }, '이미지 크기 그대로'));
    const r = await dialog({ title: `이미지 ${files.length}장을 쪽으로 넣기`, body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '쪽 크기'), sel, h('p', { class: 'hint' }, `${(atIndex ?? this.V.current + 1) + 1}쪽 자리에 넣습니다.`)), buttons: [{ label: '취소', value: false }, { label: '넣기', value: true, primary: true }], collect: () => sel.value });
    if (!r?.value) return;
    const id = this.doc.id, at = atIndex ?? this.V.current + 1, mode = r.data;
    const specs: any[] = []; for (const f of files) { try { specs.push(await loadImage(f, f.name)); } catch { toast(`“${f.name}”은 읽을 수 없는 이미지입니다.`); } }
    if (!specs.length) return;
    const cur = { keys: [] as number[] };
    const add = async () => { cur.keys = []; for (let i = 0; i < specs.length; i++) cur.keys.push(await this.E.call<number>('addImagePage', [id, at + i, specs[i], mode])); };
    await add();
    this.push({ label: '이미지 쪽 넣기', keys: [], structural: true, undo: () => this.E.call('removePages', [id, cur.keys]), redo: add });
    await this.app.reloadPages(at);
    toast(`이미지 ${specs.length}장을 쪽으로 넣었습니다.`);
  }
  async mergePdf(given?: { name: string; bytes: Uint8Array }[], atIndex?: number) {
    const files = given || await this.app.platform.pickPdfs(true);
    if (!files.length) return;
    const id = this.doc.id;
    const start = atIndex ?? this.V.current + 1;
    let at = start, total = 0;
    for (const f of files) {
      let pw = '';
      for (;;) {
        const r = await this.E.call<{ keys?: number[]; error?: string }>('importPdf', [id, f.bytes, pw, at]);
        if (r.keys) {
          const cur = { keys: r.keys }, at0 = at, bytes = f.bytes, pw0 = pw;
          this.push({ label: 'PDF 합치기', keys: [], structural: true,
            undo: () => this.E.call('removePages', [id, cur.keys]),
            redo: async () => { cur.keys = (await this.E.call<{ keys: number[] }>('importPdf', [id, bytes, pw0, at0])).keys; } });
          at += r.keys.length; total += r.keys.length; break;
        }
        if (r.error === 'password') { const v = await promptBox('암호가 걸린 문서', `“${f.name}”의 암호를 입력하세요.`, '', { type: 'password' }); if (v === null) break; pw = v; continue; }
        toast(`“${f.name}”을 읽지 못했습니다.`); break;
      }
    }
    if (total) { await this.app.reloadPages(start); toast(`${start + 1}쪽 자리에 ${total}쪽을 넣었습니다. Ctrl+Z로 되돌릴 수 있습니다.`); }
  }
  async extract() {
    const keys = this.targets();
    const idx = keys.map(k => this.V.pages.findIndex(p => p.key === k)).sort((a, b) => a - b);
    const bytes = await this.E.call<Uint8Array>('extract', [this.doc.id, idx]);
    const name = this.doc.name.replace(/\.pdf$/i, '') + `_${idx.length === 1 ? idx[0] + 1 + '쪽' : idx.length + '쪽'}.pdf`;
    const t = await this.app.platform.saveAs(name, bytes);
    if (t) toast(`${idx.length}쪽을 “${t.name}”로 저장했습니다.`);
  }
  thumbMenu(e: MouseEvent, _i: number) {
    const n = this.targets().length;
    menu({ x: e.clientX, y: e.clientY }, [
      { label: `${n}쪽 왼쪽으로 회전`, icon: 'rotL', hint: 'Ctrl+[', action: () => this.rotate(-1) },
      { label: `${n}쪽 오른쪽으로 회전`, icon: 'rotR', hint: 'Ctrl+]', action: () => this.rotate(1) },
      { label: '모든 쪽 오른쪽으로 회전', icon: 'rotR', action: () => this.rotate(1, 'all') },
      { label: '뒤에 빈 쪽 넣기', icon: 'pageAdd', action: () => this.insertBlank() },
      { label: `${n}쪽 뽑아내기…`, icon: 'extract', action: () => this.extract() }, '-',
      { label: `${n}쪽 지우기`, icon: 'trash', action: () => this.deletePages() },
    ]);
  }

  /* ───────────── 도구 ───────────── */
  /** 문서 보정: 사진·스캔 페이지를 반듯하게 펴고 그늘·대비를 바로잡는다 (선택한 페이지 또는 현재 페이지) */
  async correctPages() {
    await this.commitPending();
    const id = this.doc.id, keys = this.targets();
    const idx = keys.map(k => this.V.pages.findIndex(p => p.key === k)).filter(i => i >= 0);
    if (!idx.length) return;
    const { scanDialog } = await import('../scan/ui.ts');
    const { toBlob } = await import('../scan/scan.ts');
    const b = busy('페이지를 불러오는 중…');
    const srcs: { name: string; canvas: HTMLCanvasElement }[] = [];
    try {
      for (const i of idx) {
        const r: any = await this.E.call('render', [id, i, 220 / 72, undefined, false, false]);
        const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
        const g = c.getContext('2d')!; if (r.bitmap) { g.drawImage(r.bitmap, 0, 0); r.bitmap.close(); } else g.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
        srcs.push({ name: `${i + 1}페이지`, canvas: c });
      }
    } finally { b.done(); }
    const out = await scanDialog(srcs, { title: idx.length > 1 ? `문서 보정 (${idx.length}페이지)` : '문서 보정', ok: '보정 적용' });
    if (!out) return;
    const b2 = busy('보정한 페이지를 넣는 중…');
    const changes: ObjChange[] = [];
    try {
      for (const [n, c] of out.entries()) {
        b2.set(`보정한 페이지를 넣는 중… ${n + 1}/${out.length}`);
        const bytes = new Uint8Array(await (await toBlob(c, 'color')).arrayBuffer());
        changes.push(await this.E.call<ObjChange>('replaceWithImage', [id, keys[n], { bytes, kind: 'jpg', iw: c.width, ih: c.height }]));
      }
    } catch (e: any) { toast('보정하지 못했습니다: ' + e.message); }
    finally { b2.done(); }
    if (!changes.length) return;
    this.push({ label: '문서 보정', keys: changes.map(c => c.key),
      undo: async () => { for (const c of changes) { await this.E.call('detach', [id, c.key, c.gen, c.added]); await this.E.call('attach', [id, c.key, c.gen, c.removed]); } },
      redo: async () => { for (const c of changes) { await this.E.call('detach', [id, c.key, c.gen, c.removed]); await this.E.call('attach', [id, c.key, c.gen, c.added]); } } });
    for (const c of changes) this.changed(c.key);
    if (await confirmBox('문서 보정', `${changes.length}페이지를 보정했습니다. 이어서 글자 인식(OCR)을 해서 찾기·복사가 되게 할까요?`, '글자 인식')) {
      const b3 = busy('글자 인식 엔진을 준비하는 중…');
      try {
        const { ocrPages } = await import('./ocr.ts');
        const r = await ocrPages(this.E, id, changes.map(c => ({ index: this.V.pages.findIndex(p => p.key === c.key), key: c.key })), { progress: m => b3.set(m) });
        if (r.changes.length) this.push({ label: '글자 인식', keys: r.changes.map(c => c.key), undo: async () => { for (const c of r.changes) await this.E.call('detach', [id, c.key, c.gen, c.added]); }, redo: async () => { for (const c of r.changes) await this.E.call('attach', [id, c.key, c.gen, c.added]); } });
        for (const c of r.changes) this.changed(c.key);
        toast(`낱말 ${r.words}개를 인식했습니다. 이제 찾기(Ctrl+F)가 됩니다.`, 4000);
      } catch (e: any) { toast('글자 인식을 하지 못했습니다: ' + e.message); }
      finally { b3.done(); }
    }
  }
  private async ocrDialog() {
    const sel = h('select', { class: 'field' }, h('option', { value: 'cur' }, `현재 쪽 (${this.V.current + 1}쪽)`), h('option', { value: 'empty' }, '글자가 없는 쪽 모두 (스캔 쪽)'), h('option', { value: 'all' }, '모든 쪽'));
    const r = await dialog({ title: '글자 인식 (OCR)', body: h('div', { class: 'form' }, h('p', {}, '스캔한 쪽의 글자를 한국어·영어로 인식해 보이지 않는 글자층으로 얹습니다. 모양은 그대로이고, 저장하면 다른 프로그램에서도 검색·복사가 됩니다. 인식은 이 컴퓨터 안에서만 합니다.'), h('label', { class: 'lbl' }, '대상'), sel), buttons: [{ label: '취소', value: false }, { label: '인식 시작', value: true, primary: true }], collect: () => sel.value });
    if (!r?.value) return;
    const which = r.data as string;
    const id = this.doc.id;
    const pages = which === 'cur' ? [this.V.current] : this.V.pages.map((_, i) => i);
    const keysAt = this.V.pages.map(p => p.key); // 도중에 다른 탭으로 가도 이 문서의 쪽에 넣는다
    const b = busy('글자 인식 엔진을 준비하는 중…');
    let cancelled = false;
    const cancelBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => { cancelled = true; } }, '그만');
    document.querySelector('.busy-card')?.append(cancelBtn);
    const changes: ObjChange[] = [];
    let done = 0, words = 0;
    try {
      const { ocrPages } = await import('./ocr.ts');
      const r = await ocrPages(this.E, id, pages.map(i => ({ index: i, key: keysAt[i] })), { skipText: which === 'empty', progress: m => b.set(m), cancelled: () => cancelled });
      changes.push(...r.changes); done = r.done; words = r.words;
      for (const c of r.changes) this.changed(c.key);
    } catch (e: any) { b.done(); toast('글자 인식을 하지 못했습니다: ' + e.message, 5000); return; }
    b.done();
    if (changes.length) {
      this.push({
        label: '글자 인식', keys: changes.map(c => c.key),
        undo: async () => { for (const c of changes) await this.E.call('detach', [id, c.key, c.gen, c.added]); },
        redo: async () => { for (const c of changes) await this.E.call('attach', [id, c.key, c.gen, c.added]); },
      });
    }
    toast(done ? `${done}쪽에서 낱말 ${words}개를 인식했습니다. 이제 찾기(Ctrl+F)로 검색됩니다.` : '인식할 쪽이 없었습니다 (이미 글자가 있는 쪽은 건너뜁니다).', 5000);
  }
  private async setPassword() {
    const a = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', 'aria-label': '새 암호' });
    const b2 = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', 'aria-label': '암호 확인' });
    const r = await dialog({ title: '문서 암호 설정', body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '열기 암호'), a, h('label', { class: 'lbl' }, '한 번 더'), b2, h('p', { class: 'hint' }, 'AES로 암호화합니다. 저장해야 적용되고, 암호를 잊으면 열 수 없습니다.')), buttons: [{ label: '취소', value: false }, { label: '설정', value: true, primary: true }], collect: () => [a.value, b2.value] });
    if (!r?.value) return;
    const [p1, p2] = r.data as string[];
    if (!p1) { toast('암호를 입력하세요.'); return; }
    if (p1 !== p2) { toast('두 암호가 다릅니다.'); return; }
    await this.E.call('setPassword', [this.doc.id, p1, '']);
    this.doc.info.encrypted = true; this.app.markDirty();
    toast('저장하면 암호가 걸립니다.');
  }
  private async removePassword() {
    if (!this.doc.info.encrypted) { toast('이 문서에는 암호가 없습니다.'); return; }
    if (!(await confirmBox('암호 해제', '저장할 때 암호를 없앱니다. 누구나 열 수 있게 됩니다.', '해제'))) return;
    await this.E.call('removePassword', [this.doc.id]);
    this.doc.info.encrypted = false; this.app.markDirty();
    toast('저장하면 암호가 풀립니다.');
  }
  private async editMeta() {
    const i = this.doc.info;
    const f = (v: string) => h('input', { class: 'field', value: v });
    const t = f(i.title), a = f(i.author), s = f(i.subject);
    const r = await dialog({ title: '문서 속성', body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '제목'), t, h('label', { class: 'lbl' }, '작성자'), a, h('label', { class: 'lbl' }, '주제'), s), buttons: [{ label: '취소', value: false }, { label: '적용', value: true, primary: true }], collect: () => [t.value, a.value, s.value] });
    if (!r?.value) return;
    const [nt, na, ns] = r.data as string[];
    const id = this.doc.id;
    await this.E.call('setMeta', [id, 'Title', nt]); await this.E.call('setMeta', [id, 'Author', na]); await this.E.call('setMeta', [id, 'Subject', ns]);
    Object.assign(i, { title: nt, author: na, subject: ns });
    this.app.markDirty(); toast('문서 속성을 바꿨습니다. 저장하면 반영됩니다.');
  }
  private async setAuthor() {
    const v = await promptBox('작성자 이름', '주석에 남길 이름', this.app.prefs.author || '', { hint: '새로 만드는 메모·형광펜에 이 이름이 들어갑니다.' });
    if (v === null) return;
    this.app.prefs.author = v.trim(); this.app.savePrefs();
    this.E.call('setAuthor', [v.trim() || '사용자']);
    toast('작성자 이름을 바꿨습니다.');
  }

  /* ───────────── 키보드 / 단축 메뉴 ───────────── */
  key(e: KeyboardEvent): boolean {
    // 상황에 따라 뜻이 바뀌는 키만 여기서 처리한다 (나머지는 단축키 목록)
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSel(); return true; }
    if (e.key === 'Escape') { if (this.sel) { const p = this.sel.page; this.sel = null; this.more = []; this.paintPage(p); this.renderProps(); } else if (this.tool !== 'select' && this.tool !== 'aselect') this.setTool(this.tab === 'annot' ? 'aselect' : 'select'); this.app.updateStatus(); return true; }
    if (e.key === 'Enter' && this.sel?.kind === 'run') { e.preventDefault(); this.openRunEditor(this.sel.page, this.sel.run); return true; }
    if (this.sel && this.sel.kind !== 'annot' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      this.moveSel(dx, dy, true); return true;
    }
    return false;
  }
  contextMenu(e: MouseEvent, page: number, x: number, y: number): boolean {
    const run = this.hitRun(page, x, y), obj = run ? null : this.hitObj(page, x, y);
    const key = this.V.pages[page].key;
    if (run || obj) this.sel = run ? { kind: 'run', page, key, run } : { kind: 'obj', page, key, obj: obj! };
    this.paintPage(page); this.renderProps();
    menu({ x: e.clientX, y: e.clientY }, [
      ...(run ? [{ label: '이 글자 고치기', icon: 'editText' as IconName, hint: 'Enter', action: () => this.openRunEditor(page, run) }] : []),
      ...(run || obj ? [
        { label: '맨 앞으로 가져오기', icon: 'front' as IconName, action: () => this.arrange('front') },
        { label: '앞으로 가져오기', icon: 'up' as IconName, action: () => this.arrange('forward') },
        { label: '뒤로 보내기', icon: 'down' as IconName, action: () => this.arrange('backward') },
        { label: '맨 뒤로 보내기', icon: 'back' as IconName, action: () => this.arrange('back') }, '-' as const,
        { label: '지우기', icon: 'trash' as IconName, hint: 'Delete', action: () => this.deleteSel() }, '-' as const] : []),
      { label: '여기에 글자 추가', icon: 'addText', action: () => this.openNewTextEditor(page, x, y - this.props.fontSize * 0.7) },
      { label: '여기에 메모 붙이기', icon: 'note', action: () => this.placeNote(page, x, y) },
      { label: '이미지 넣기…', icon: 'image', action: () => this.pickImage() },
      { label: '서명 넣기…', icon: 'pen', action: () => this.signature() }, '-',
      { label: '보기 모드로', icon: 'view', hint: 'Ctrl+E', action: () => this.app.setMode('view') },
    ]);
    return true;
  }
}

// 붙여넣기: 편집 모드에서 이미지 붙여넣기
document.addEventListener('paste', e => {
  const app = (window as any).__app as App | undefined;
  if (!app || app.mode !== 'edit' || (e.target as HTMLElement).matches('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); app.editor?.dropImages([item.getAsFile()!]); }
});
