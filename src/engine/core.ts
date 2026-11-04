/**
 * PdfEngine: PDFium(WebAssembly) 위에 얹은 문서 엔진.
 * 웹 워커 안에서 돌며(노드 테스트에서도 동작), UI와는 "화면 좌표(pt, 좌상단 원점, 회전 적용 후)"로만 대화한다.
 * PDF 내부 좌표(좌하단 원점, /Rotate 적용 전) 변환은 전부 여기서 처리한다.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import type { FontKit } from './fonts.ts';
import type {
  AnnotInfo, DocInfo, LinkInfo, OutlineItem, PageObjInfo, Rect, RenderResult, SearchHit, TextData, TextRun,
} from './types.ts';

type M6 = [number, number, number, number, number, number];

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const OBJ_TEXT = 1, OBJ_PATH = 2, OBJ_IMAGE = 3, OBJ_FORM = 5;
const TEXTMODE_FILL = 0, TEXTMODE_FILL_STROKE = 2, TEXTMODE_INVISIBLE = 3;
const FONT_TRUETYPE = 2;
export const ANNOT = {
  TEXT: 1, LINK: 2, FREETEXT: 3, LINE: 4, SQUARE: 5, CIRCLE: 6, POLYGON: 7, POLYLINE: 8,
  HIGHLIGHT: 9, UNDERLINE: 10, SQUIGGLY: 11, STRIKEOUT: 12, STAMP: 13, CARET: 14, INK: 15,
  POPUP: 16, FILEATTACHMENT: 17, WIDGET: 20, REDACT: 28,
} as const;
const ANNOT_NAMES: Record<number, string> = {
  1: '메모', 3: '글상자', 4: '선', 5: '사각형', 6: '원', 7: '다각형', 8: '꺾은선', 9: '형광펜', 10: '밑줄',
  11: '물결 밑줄', 12: '취소선', 13: '스탬프', 14: '삽입 기호', 15: '펜', 17: '첨부 파일', 28: '삭제 표시',
};

interface PageCtx {
  key: number;
  page: number;          // FPDF_PAGE
  text: number;          // FPDF_TEXTPAGE (0 = 아직 없음)
  m: M6;                 // page → display (pt)
  inv: M6;               // display → page
  w: number; h: number;  // display size (pt)
  dirty: boolean;
  used: number;
  form?: number;         // 입력란 환경에 올렸으면 그 핸들
  nested?: Map<number, NestedInfo>; // 양식(Form XObject) 안 객체 → 위치 정보
}
interface NestedInfo { parent: number; top: number; fm: M6; path: number[] }
interface DocCtx {
  id: number;
  doc: number;
  buf: number;           // 원본 바이트가 들어있는 wasm 메모리 (문서 수명 동안 유지)
  keys: number[];        // 페이지 순서대로의 안정 키
  nextKey: number;
  pages: Map<number, PageCtx>;
  removedAnnots: Map<number, Set<number>>;
  gen: Map<number, number>; // 키별 세대 (페이지를 통째로 되살리면 증가 → 이전 객체 핸들은 무효)
  password: string;
  form: { info: number; handle: number } | null;
}

const mul = (a: M6, b: M6): M6 => [ // a 다음 b
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const invert = (m: M6): M6 => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
};
const ap = (m: M6, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number) => '#' + hex2(r) + hex2(g) + hex2(b);
const fromHex = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const yieldNow = () => new Promise(r => setTimeout(r, 0));

export class PdfEngine {
  P: WrappedPdfiumModule;
  M: any;
  fonts: FontKit;
  docs = new Map<number, DocCtx>();
  nextDoc = 1;
  author = '사용자';
  private searchToken = 0;

  constructor(P: WrappedPdfiumModule, fonts: FontKit) {
    this.P = P; this.M = P.pdfium; this.fonts = fonts;
    P.PDFiumExt_Init();
    fonts.installFallback(P);
  }

  /* ───────────── 메모리 도우미 ───────────── */
  private malloc(n: number) { return this.M.wasmExports.malloc(n); }
  private free(p: number) { if (p) this.M.wasmExports.free(p); }
  private put(bytes: Uint8Array) { const p = this.malloc(bytes.length || 1); this.M.HEAPU8.set(bytes, p); return p; }
  private wstr(s: string) { const n = (s.length + 1) * 2; const p = this.malloc(n); this.M.stringToUTF16(s, p, n); return p; }
  private f32(p: number, n: number) { return Array.from(this.M.HEAPF32.subarray(p >> 2, (p >> 2) + n)) as number[]; }
  private f64(p: number, n: number) { return Array.from(this.M.HEAPF64.subarray(p >> 3, (p >> 3) + n)) as number[]; }
  private u32(p: number, n: number) { return Array.from(this.M.HEAPU32.subarray(p >> 2, (p >> 2) + n)) as number[]; }
  private setF32(p: number, vals: number[]) { this.M.HEAPF32.set(vals, p >> 2); }
  /** 버퍼에 UTF-16 문자열을 받아오는 PDFium 함수 패턴 */
  private readW(fn: (buf: number, len: number) => number): string {
    const n = fn(0, 0); if (n <= 2) return '';
    const b = this.malloc(n); fn(b, n);
    const s = this.M.UTF16ToString(b); this.free(b); return s;
  }

  /* ───────────── 문서 ───────────── */
  open(bytes: Uint8Array, password = ''): { docId?: number; error?: 'password' | 'format' | 'unknown' } {
    const buf = this.put(bytes);
    const doc = this.P.FPDF_LoadMemDocument64(buf, bytes.length, password);
    if (!doc) {
      const err = this.P.FPDF_GetLastError();
      this.free(buf);
      return { error: err === 4 ? 'password' : err === 3 || err === 2 ? 'format' : 'unknown' };
    }
    const id = this.nextDoc++;
    const n = this.P.FPDF_GetPageCount(doc);
    this.docs.set(id, { id, doc, buf, keys: Array.from({ length: n }, (_, i) => i + 1), nextKey: n + 1, pages: new Map(), gen: new Map(), removedAnnots: new Map(), password, form: null });
    this.initForm(this.docs.get(id)!);
    return { docId: id };
  }
  close(docId: number) {
    const d = this.docs.get(docId); if (!d) return;
    for (const pc of d.pages.values()) this.closePage(pc);
    if (d.form) { this.P.PDFiumExt_ExitFormFillEnvironment(d.form.handle); this.P.PDFiumExt_CloseFormFillInfo(d.form.info); }
    this.P.FPDF_CloseDocument(d.doc); this.free(d.buf); this.docs.delete(docId);
  }
  /** 입력란(AcroForm) 환경: 입력란을 그리고 값을 바꾸는 데 필요 */
  private initForm(d: DocCtx) {
    if (d.form || this.P.FPDF_GetFormType(d.doc) <= 0) return;
    const info = this.P.PDFiumExt_OpenFormFillInfo();
    const handle = this.P.PDFiumExt_InitFormFillEnvironment(d.doc, info);
    if (!handle) { this.P.PDFiumExt_CloseFormFillInfo(info); return; }
    this.P.FPDF_SetFormFieldHighlightColor(handle, 0, 0x00FFE8D6);
    this.P.FPDF_SetFormFieldHighlightAlpha(handle, 110);
    d.form = { info, handle };
  }
  /** 빈 새 문서 (이미지로 PDF 만들기 등) */
  createDoc(): number {
    const doc = this.P.FPDF_CreateNewDocument();
    const id = this.nextDoc++;
    this.docs.set(id, { id, doc, buf: 0, keys: [], nextKey: 1, pages: new Map(), gen: new Map(), removedAnnots: new Map(), password: '', form: null });
    return id;
  }
  private D(docId: number) { const d = this.docs.get(docId); if (!d) throw new Error('문서가 열려 있지 않습니다'); return d; }

  info(docId: number): DocInfo {
    const d = this.D(docId);
    const sz = this.malloc(8);
    const pages = d.keys.map((key, i) => {
      this.P.FPDF_GetPageSizeByIndexF(d.doc, i, sz);
      const [w, h] = this.f32(sz, 2);
      return { key, w, h };
    });
    this.free(sz);
    const meta = (k: string) => this.readW((b, l) => this.P.FPDF_GetMetaText(d.doc, k, b, l));
    const verP = this.malloc(4); this.P.FPDF_GetFileVersion(d.doc, verP); const ver = this.M.HEAP32[verP >> 2]; this.free(verP);
    return {
      pageCount: pages.length, pages,
      title: meta('Title'), author: meta('Author'), subject: meta('Subject'), creator: meta('Creator'), producer: meta('Producer'),
      created: meta('CreationDate'), modified: meta('ModDate'),
      version: ver ? (ver / 10).toFixed(1) : '',
      encrypted: !!this.P.EPDF_IsEncrypted(d.doc),
      permissions: this.P.FPDF_GetDocPermissions(d.doc) >>> 0,
    };
  }

  /* ───────────── 페이지 ───────────── */
  private keyAt(d: DocCtx, index: number) { const k = d.keys[index]; if (k === undefined) throw new Error('페이지 범위를 벗어났습니다'); return k; }
  indexOfKey(docId: number, key: number) { return this.D(docId).keys.indexOf(key); }
  keys(docId: number) { return this.D(docId).keys.slice(); }

  private pageByKey(d: DocCtx, key: number): PageCtx {
    let pc = d.pages.get(key);
    if (pc) { pc.used = performance.now(); return pc; }
    const index = d.keys.indexOf(key);
    const page = this.P.FPDF_LoadPage(d.doc, index);
    if (!page) throw new Error(`${index + 1}쪽을 읽지 못했습니다`);
    pc = { key, page, text: 0, dirty: false, used: performance.now(), ...this.geometry(page) };
    if (d.form) { this.P.FORM_OnAfterLoadPage(page, d.form.handle); pc.form = d.form.handle; }
    d.pages.set(key, pc);
    this.evict(d);
    return pc;
  }
  private page(d: DocCtx, index: number) { return this.pageByKey(d, this.keyAt(d, index)); }
  private evict(d: DocCtx) {
    if (d.pages.size <= 24) return;
    const clean = [...d.pages.values()].filter(p => !p.dirty).sort((a, b) => a.used - b.used);
    for (const pc of clean.slice(0, d.pages.size - 24)) { this.closePage(pc); d.pages.delete(pc.key); }
  }
  private closePage(pc: PageCtx) {
    if (pc.text) this.P.FPDFText_ClosePage(pc.text);
    if (pc.form) this.P.FORM_OnBeforeClosePage(pc.page, pc.form);
    this.P.FPDF_ClosePage(pc.page);
  }
  private textPage(pc: PageCtx) {
    if (!pc.text) pc.text = this.P.FPDFText_LoadPage(pc.page);
    return pc.text;
  }
  private touch(pc: PageCtx) {
    pc.dirty = true;
    if (pc.text) { this.P.FPDFText_ClosePage(pc.text); pc.text = 0; }
    this.P.FPDFPage_GenerateContent(pc.page);
    const g = this.geometry(pc.page); pc.m = g.m; pc.inv = g.inv; pc.w = g.w; pc.h = g.h;
  }

  /** PDF 좌표 → 화면 좌표 행렬. PDFium이 쓰는 CropBox∩MediaBox와 /Rotate를 따른다. */
  private geometry(page: number) {
    const p = this.malloc(16);
    const box = (fn: 'FPDFPage_GetCropBox' | 'FPDFPage_GetMediaBox') =>
      (this.P[fn] as any)(page, p, p + 4, p + 8, p + 12) ? this.f32(p, 4) : null; // l b r t
    let mb = box('FPDFPage_GetMediaBox') || [0, 0, 612, 792];
    let cb = box('FPDFPage_GetCropBox') || mb;
    this.free(p);
    const norm = (b: number[]) => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
    mb = norm(mb); cb = norm(cb);
    let [x0, y0, x1, y1] = [Math.max(mb[0], cb[0]), Math.max(mb[1], cb[1]), Math.min(mb[2], cb[2]), Math.min(mb[3], cb[3])];
    if (x1 - x0 < 1 || y1 - y0 < 1) [x0, y0, x1, y1] = mb;
    const r = ((this.P.FPDFPage_GetRotation(page) % 4) + 4) % 4;
    let m: M6;
    if (r === 0) m = [1, 0, 0, -1, -x0, y1];
    else if (r === 1) m = [0, 1, 1, 0, -y0, -x0];
    else if (r === 2) m = [-1, 0, 0, 1, x1, -y0];
    else m = [0, -1, -1, 0, y1, x1];
    const W = x1 - x0, H = y1 - y0;
    return { m, inv: invert(m), w: r % 2 ? H : W, h: r % 2 ? W : H };
  }
  pageGeom(docId: number, index: number) { const pc = this.page(this.D(docId), index); return { w: pc.w, h: pc.h, rotation: this.P.FPDFPage_GetRotation(pc.page) }; }

  private toDisp(pc: PageCtx, l: number, b: number, r: number, t: number): Rect {
    const pts = [ap(pc.m, l, b), ap(pc.m, r, t), ap(pc.m, l, t), ap(pc.m, r, b)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  private toPage(pc: PageCtx, x: number, y: number) { return ap(pc.inv, x, y); }

  /* ───────────── 렌더링 ───────────── */
  /** scale: pt → px 배율. region: 그릴 영역(px). 없으면 페이지 전체 */
  render(docId: number, index: number, scale: number, region?: { x: number; y: number; w: number; h: number }, annots = true, fieldHighlight = true): RenderResult {
    const d = this.D(docId); const pc = this.page(d, index);
    const fullW = Math.max(1, Math.round(pc.w * scale)), fullH = Math.max(1, Math.round(pc.h * scale));
    const rg = region ? {
      x: Math.max(0, Math.floor(region.x)), y: Math.max(0, Math.floor(region.y)),
      w: Math.max(1, Math.min(Math.ceil(region.w), fullW - Math.floor(region.x))),
      h: Math.max(1, Math.min(Math.ceil(region.h), fullH - Math.floor(region.y))),
    } : { x: 0, y: 0, w: fullW, h: fullH };
    const bm = this.P.FPDFBitmap_Create(rg.w, rg.h, 1);
    this.P.FPDFBitmap_FillRect(bm, 0, 0, rg.w, rg.h, 0xffffffff);
    // PDFium은 쪽의 기본 화면 행렬(뒤집기·회전, 정수 크기)을 먼저 적용한 뒤 이 행렬을 곱한다
    const sx = (fullW / pc.w) * (pc.w / Math.max(1, Math.trunc(pc.w))), sy = (fullH / pc.h) * (pc.h / Math.max(1, Math.trunc(pc.h)));
    const m: M6 = [sx, 0, 0, sy, -rg.x, -rg.y];
    const mp = this.malloc(24), cp = this.malloc(16);
    this.setF32(mp, m); this.setF32(cp, [0, 0, rg.w, rg.h]);
    this.P.FPDF_RenderPageBitmapWithMatrix(bm, pc.page, mp, cp, (annots ? FPDF_ANNOT : 0) | FPDF_REVERSE_BYTE_ORDER);
    this.free(mp); this.free(cp);
    // 입력란(위젯)은 PDFium이 따로 그린다
    if (annots && pc.form && d.form) {
      this.P.FPDF_SetFormFieldHighlightAlpha(d.form.handle, fieldHighlight ? 110 : 0);
      this.P.FPDF_FFLDraw(d.form.handle, bm, pc.page, -rg.x, -rg.y, fullW, fullH, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
    }
    const ptr = this.P.FPDFBitmap_GetBuffer(bm), stride = this.P.FPDFBitmap_GetStride(bm);
    const data = new Uint8ClampedArray(rg.w * rg.h * 4);
    if (stride === rg.w * 4) data.set(this.M.HEAPU8.subarray(ptr, ptr + data.length));
    else for (let y = 0; y < rg.h; y++) data.set(this.M.HEAPU8.subarray(ptr + y * stride, ptr + y * stride + rg.w * 4), y * rg.w * 4);
    this.P.FPDFBitmap_Destroy(bm);
    return { width: rg.w, height: rg.h, x: rg.x, y: rg.y, data };
  }

  /* ───────────── 글자 정보 / 검색 / 링크 / 목차 ───────────── */
  textData(docId: number, index: number): TextData {
    const pc = this.page(this.D(docId), index);
    const tp = this.textPage(pc);
    const n = this.P.FPDFText_CountChars(tp);
    const boxes = new Float32Array(n * 4);
    const rp = this.malloc(16), op = this.malloc(16);
    let text = '';
    for (let i = 0; i < n; i++) {
      const u = this.P.FPDFText_GetUnicode(tp, i);
      text += u && u < 0x10000 ? String.fromCharCode(u) : u ? '\ufffd' : ' ';
      if (this.P.FPDFText_GetLooseCharBox(tp, i, rp)) {
        let [l, t, r, b] = this.f32(rp, 4);
        // 글꼴 상자(bbox)를 그대로 쓰는 글꼴은 위아래가 지나치게 크다 → 기준선 둘레로 줄인다
        const fs = this.P.FPDFText_GetFontSize(tp, i);
        const ang = this.P.FPDFText_GetCharAngle(tp, i);
        if (fs > 0 && t - b > fs * 1.6 && (Math.abs(ang) < 0.01 || Math.abs(ang - Math.PI * 2) < 0.01) && this.P.FPDFText_GetCharOrigin(tp, i, op, op + 8)) {
          const oy = this.f64(op + 8, 1)[0];
          t = oy + fs * 0.92; b = oy - fs * 0.24;
        }
        const rc = this.toDisp(pc, l, b, r, t);
        boxes.set([rc.x, rc.y, rc.x + rc.w, rc.y + rc.h], i * 4);
      }
    }
    this.free(rp); this.free(op);
    return { text, boxes };
  }

  async search(docId: number, query: string, opts: { matchCase?: boolean; wholeWord?: boolean }, onPage: (hits: SearchHit[], page: number, total: number) => void) {
    const token = ++this.searchToken;
    const d = this.D(docId);
    const q = this.wstr(query);
    const flags = (opts.matchCase ? 1 : 0) | (opts.wholeWord ? 2 : 0);
    const rp = this.malloc(32);
    let found = 0;
    try {
      for (let i = 0; i < d.keys.length; i++) {
        if (token !== this.searchToken) return { cancelled: true, found };
        const pc = this.page(d, i);
        const tp = this.textPage(pc);
        const h = this.P.FPDFText_FindStart(tp, q, flags, 0);
        const hits: SearchHit[] = [];
        let text: string | null = null;
        while (this.P.FPDFText_FindNext(h)) {
          const idx = this.P.FPDFText_GetSchResultIndex(h), cnt = this.P.FPDFText_GetSchCount(h);
          const rects: Rect[] = [];
          const nr = this.P.FPDFText_CountRects(tp, idx, cnt);
          for (let k = 0; k < nr; k++) {
            this.P.FPDFText_GetRect(tp, k, rp, rp + 8, rp + 16, rp + 24);
            const [l, t, r, b] = this.f64(rp, 4);
            rects.push(this.toDisp(pc, l, b, r, t));
          }
          if (text === null) {
            const n = this.P.FPDFText_CountChars(tp);
            const b = this.malloc((n + 1) * 2); this.P.FPDFText_GetText(tp, 0, n, b);
            text = this.M.UTF16ToString(b); this.free(b);
          }
          const s = Math.max(0, idx - 24), e = Math.min(text!.length, idx + cnt + 36);
          hits.push({ page: i, index: idx, length: cnt, rects, before: text!.slice(s, idx).replace(/\s+/g, ' '), match: text!.slice(idx, idx + cnt), after: text!.slice(idx + cnt, e).replace(/\s+/g, ' ') });
        }
        this.P.FPDFText_FindClose(h);
        found += hits.length;
        onPage(hits, i, d.keys.length);
        if (i % 4 === 3) await yieldNow();
      }
    } finally { this.free(q); this.free(rp); }
    return { cancelled: false, found };
  }
  cancelSearch() { this.searchToken++; }

  links(docId: number, index: number): LinkInfo[] {
    const d = this.D(docId); const pc = this.page(d, index);
    const out: LinkInfo[] = [];
    const sp = this.malloc(4), lp = this.malloc(4), rp = this.malloc(16);
    this.M.HEAP32[sp >> 2] = 0;
    while (this.P.FPDFLink_Enumerate(pc.page, sp, lp)) {
      const link = this.M.HEAP32[lp >> 2];
      if (!this.P.FPDFLink_GetAnnotRect(link, rp)) continue;
      const [l, t, r, b] = this.f32(rp, 4);
      const rect = this.toDisp(pc, l, b, r, t);
      let dest = this.P.FPDFLink_GetDest(d.doc, link);
      const action = this.P.FPDFLink_GetAction(link);
      if (!dest && action) {
        const type = this.P.FPDFAction_GetType(action);
        if (type === 1) dest = this.P.FPDFAction_GetDest(d.doc, action);
        else if (type === 3) {
          const n = this.P.FPDFAction_GetURIPath(d.doc, action, 0, 0);
          const b = this.malloc(n); this.P.FPDFAction_GetURIPath(d.doc, action, b, n);
          out.push({ rect, uri: this.M.UTF8ToString(b) }); this.free(b); continue;
        }
      }
      if (dest) { const t2 = this.destTarget(d, dest); if (t2) out.push({ rect, ...t2 }); }
    }
    this.free(sp); this.free(lp);
    // 본문에 적힌 웹 주소
    const wl = this.P.FPDFLink_LoadWebLinks(this.textPage(pc));
    if (wl) {
      const n = this.P.FPDFLink_CountWebLinks(wl);
      for (let i = 0; i < n; i++) {
        const uri = this.readW((b, l) => this.P.FPDFLink_GetURL(wl, i, b, l / 2) * 2);
        const nr = this.P.FPDFLink_CountRects(wl, i);
        for (let k = 0; k < nr; k++) {
          const dp = this.malloc(32);
          this.P.FPDFLink_GetRect(wl, i, k, dp, dp + 8, dp + 16, dp + 24);
          const [l, t, r, b] = this.f64(dp, 4); this.free(dp);
          if (uri) out.push({ rect: this.toDisp(pc, l, b, r, t), uri });
        }
      }
      this.P.FPDFLink_CloseWebLinks(wl);
    }
    this.free(rp);
    return out;
  }
  private destTarget(d: DocCtx, dest: number): { page: number; top?: number } | null {
    const page = this.P.FPDFDest_GetDestPageIndex(d.doc, dest);
    if (page < 0) return null;
    const p = this.malloc(24);
    let top: number | undefined;
    if (this.P.FPDFDest_GetLocationInPage(dest, p, p + 4, p + 8, p + 12, p + 16, p + 20)) {
      const hasX = this.M.HEAP32[p >> 2], hasY = this.M.HEAP32[(p + 4) >> 2];
      const [x, y] = this.f32(p + 12, 2);
      if (hasY) { try { const pc = this.page(d, page); top = ap(pc.m, hasX ? x : 0, y)[1]; } catch { /* ignore */ } }
    }
    this.free(p);
    return { page, top };
  }
  outline(docId: number): OutlineItem[] {
    const d = this.D(docId);
    const walk = (parent: number, depth: number): OutlineItem[] => {
      const items: OutlineItem[] = [];
      let bm = this.P.FPDFBookmark_GetFirstChild(d.doc, parent);
      let guard = 0;
      while (bm && guard++ < 5000) {
        const title = this.readW((b, l) => this.P.FPDFBookmark_GetTitle(bm, b, l));
        let dest = this.P.FPDFBookmark_GetDest(d.doc, bm);
        if (!dest) { const a = this.P.FPDFBookmark_GetAction(bm); if (a && this.P.FPDFAction_GetType(a) === 1) dest = this.P.FPDFAction_GetDest(d.doc, a); }
        const t = dest ? this.destTarget(d, dest) : null;
        items.push({ title, page: t ? t.page : -1, top: t?.top, children: depth < 12 ? walk(bm, depth + 1) : [] });
        bm = this.P.FPDFBookmark_GetNextSibling(d.doc, bm);
      }
      return items;
    };
    return walk(0, 0);
  }

  /* ───────────── 입력란(AcroForm) ───────────── */
  formType(docId: number) { return this.P.FPDF_GetFormType(this.D(docId).doc); }
  fields(docId: number, index: number): FieldInfo[] {
    const d = this.D(docId); if (!d.form) return [];
    const pc = this.page(d, index), f = d.form.handle;
    const out: FieldInfo[] = [];
    const n = this.P.FPDFPage_GetAnnotCount(pc.page);
    const rp = this.malloc(16), fp = this.malloc(4);
    for (let i = 0; i < n; i++) {
      const a = this.P.FPDFPage_GetAnnot(pc.page, i); if (!a) continue;
      try {
        if (this.P.FPDFAnnot_GetSubtype(a) !== ANNOT.WIDGET || (this.P.FPDFAnnot_GetFlags(a) & 2)) continue;
        const type = this.P.FPDFAnnot_GetFormFieldType(f, a);
        if (type <= 0 || type === 1 || type === 7) continue; // 단추, 서명란은 제외
        this.P.FPDFAnnot_GetRect(a, rp);
        const [l, t, r, b] = this.f32(rp, 4);
        const flags = this.P.FPDFAnnot_GetFormFieldFlags(f, a);
        const options: { label: string; selected: boolean }[] = [];
        const oc = this.P.FPDFAnnot_GetOptionCount(f, a);
        for (let k = 0; k < oc; k++) options.push({ label: this.readW((bb, ll) => this.P.FPDFAnnot_GetOptionLabel(f, a, k, bb, ll)), selected: !!this.P.FPDFAnnot_IsOptionSelected(f, a, k) });
        this.P.FPDFAnnot_GetFontSize(f, a, fp);
        out.push({
          id: this.P.EPDFAnnot_GetObjectNumber(a), page: index, type: (['', '', 'checkbox', 'radio', 'combo', 'list', 'text'] as const)[type] || 'text',
          name: this.readW((bb, ll) => this.P.FPDFAnnot_GetFormFieldName(f, a, bb, ll)),
          value: this.readW((bb, ll) => this.P.FPDFAnnot_GetFormFieldValue(f, a, bb, ll)),
          rect: this.toDisp(pc, Math.min(l, r), Math.min(b, t), Math.max(l, r), Math.max(b, t)),
          readOnly: !!(flags & 1), required: !!(flags & 2), multiline: type === 6 && !!(flags & (1 << 12)), password: type === 6 && !!(flags & (1 << 13)),
          multiSelect: type === 5 && !!(flags & (1 << 21)), editable: type === 4 && !!(flags & (1 << 18)),
          checked: type === 2 || type === 3 ? !!this.P.FPDFAnnot_IsChecked(f, a) : false,
          exportValue: type === 2 || type === 3 ? this.readW((bb, ll) => this.P.FPDFAnnot_GetFormFieldExportValue(f, a, bb, ll)) : '',
          options, fontSize: this.f32(fp, 1)[0] || 0,
        });
      } finally { this.P.FPDFPage_CloseAnnot(a); }
    }
    this.free(rp); this.free(fp);
    return out;
  }
  /**
   * 입력란 값 바꾸기. value: 글자(글자칸·콤보), true/false(확인란·단일 선택), 고른 번호들(목록)
   * 한글처럼 기본 글꼴(Helvetica)에 없는 글자가 있으면, 입력란 모양을 글자 윤곽선(벡터)으로 직접 그려 넣는다
   * → 이 앱, 다른 PDF 프로그램, 인쇄 어디서나 한글이 보인다. 값(/V)은 그대로 진짜 글자로 저장된다.
   */
  async setField(docId: number, key: number, id: number, value: string | boolean | number | number[]) {
    const d = this.D(docId); if (!d.form) return false;
    const pc = this.pageByKey(d, key), f = d.form.handle;
    const a = this.P.EPDFPage_GetAnnotByObjectNumber(pc.page, id); if (!a) return false;
    let ok = true;
    try {
      const type = this.P.FPDFAnnot_GetFormFieldType(f, a);
      if (!this.P.FORM_SetFocusedAnnot(f, a)) return false;
      if (type === 6 || (type === 4 && typeof value === 'string')) {
        this.P.FORM_SelectAllText(f, pc.page);
        const w = this.wstr(String(value)); this.P.FORM_ReplaceSelection(f, pc.page, w); this.free(w);
      } else if (type === 2 || type === 3) {
        if (!!this.P.FPDFAnnot_IsChecked(f, a) !== !!value) ok = this.P.FORM_OnChar(f, pc.page, 0x20, 0);
      } else if (type === 4 && typeof value === 'number') {
        ok = this.P.FORM_SetIndexSelected(f, pc.page, value, true);
      } else if (type === 5 && Array.isArray(value)) {
        const oc = this.P.FPDFAnnot_GetOptionCount(f, a);
        for (let k = 0; k < oc; k++) this.P.FORM_SetIndexSelected(f, pc.page, k, value.includes(k));
      }
      this.P.FORM_ForceToKillFocus(f);
      if (type === 4 || type === 5 || type === 6) {
        this.P.EPDFAnnot_GenerateFormFieldAP(a);
        const shown = type === 5 ? '' : this.readW((bb, ll) => this.P.FPDFAnnot_GetFormFieldValue(f, a, bb, ll));
        if ([...shown].some(c => c.charCodeAt(0) > 0xff)) await this.vectorFieldAP(d, pc, a, shown, type);
      }
    } finally { this.P.FPDFPage_CloseAnnot(a); }
    this.touch(pc);
    return ok;
  }
  /** 입력란 모양을 글꼴 없이 윤곽선으로 그린다 */
  private async vectorFieldAP(d: DocCtx, pc: PageCtx, a: number, text: string, type: number) {
    const f = d.form!.handle, ttf = await this.fonts.outlines();
    const rp = this.malloc(16); this.P.FPDFAnnot_GetRect(a, rp);
    const [l0, t0, r0, b0] = this.f32(rp, 4); this.free(rp);
    const l = Math.min(l0, r0), r = Math.max(l0, r0), b = Math.min(b0, t0), t = Math.max(b0, t0);
    const w = r - l, hh = t - b;
    const fp = this.malloc(4); this.P.FPDFAnnot_GetFontSize(f, a, fp); let fs = this.f32(fp, 1)[0]; this.free(fp);
    const flags = this.P.FPDFAnnot_GetFormFieldFlags(f, a);
    const multi = type === 6 && !!(flags & (1 << 12));
    if (!fs) fs = multi ? 10 : Math.max(4, Math.min(12, (hh - 4) * 0.72));
    const cp = this.malloc(12);
    const [cr, cg, cb] = this.P.FPDFAnnot_GetFontColor(f, a, cp, cp + 4, cp + 8) ? this.u32(cp, 3) : [0, 0, 0]; this.free(cp);
    const align = this.P.EPDFAnnot_GetTextAlignment(a);
    const pad = 2;
    // 줄 나누기 (여러 줄 칸이면 폭에 맞춰 감싸기)
    let lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (multi) {
      const wrapped: string[] = [];
      for (const ln of lines) {
        let cur = '';
        for (const ch of ln) { if (cur && ttf.width(cur + ch, fs) > w - pad * 2) { wrapped.push(cur); cur = ch; } else cur += ch; }
        wrapped.push(cur);
      }
      lines = wrapped;
    } else lines = [lines.join(' ')];
    const lh = fs * 1.18;
    let body = '';
    lines.forEach((ln, i) => {
      const tw = ttf.width(ln, fs);
      const x = align === 1 ? l + (w - tw) / 2 : align === 2 ? r - pad - tw : l + pad;
      const y = multi ? t - pad - fs * 0.88 - i * lh : b + (hh - fs) / 2 + fs * 0.2;
      body += ttf.pdfPath(ln, fs, x, y);
    });
    const c = (n: number) => (n / 255).toFixed(3);
    const ap = `/Tx BMC\nq\n${(l + 1).toFixed(2)} ${(b + 1).toFixed(2)} ${(w - 2).toFixed(2)} ${(hh - 2).toFixed(2)} re W n\n${c(cr)} ${c(cg)} ${c(cb)} rg\n${body}f\nQ\nEMC\n`;
    const p = this.wstr(ap); this.P.FPDFAnnot_SetAP(a, 0, p); this.free(p);
  }

  /* ───────────── 주석 ───────────── */
  annots(docId: number, index: number): AnnotInfo[] {
    const d = this.D(docId); const pc = this.page(d, index);
    const n = this.P.FPDFPage_GetAnnotCount(pc.page);
    const out: AnnotInfo[] = [];
    const rp = this.malloc(16), cp = this.malloc(16);
    for (let i = 0; i < n; i++) {
      const a = this.P.FPDFPage_GetAnnot(pc.page, i); if (!a) continue;
      const sub = this.P.FPDFAnnot_GetSubtype(a);
      if (ANNOT_NAMES[sub] && !(this.P.FPDFAnnot_GetFlags(a) & 2)) {
        this.P.FPDFAnnot_GetRect(a, rp);
        const [l, b, r, t] = this.f32(rp, 4);
        let color = '#ffd400';
        if (this.P.FPDFAnnot_GetColor(a, 0, cp, cp + 4, cp + 8, cp + 12)) { const [R, G, B] = this.u32(cp, 3); color = toHex(R, G, B); }
        out.push({
          id: this.P.EPDFAnnot_GetObjectNumber(a), subtype: sub, kind: ANNOT_NAMES[sub], page: index,
          rect: this.toDisp(pc, Math.min(l, r), Math.min(b, t), Math.max(l, r), Math.max(b, t)),
          contents: this.annotStr(a, 'Contents'), author: this.annotStr(a, 'T'), modified: this.annotStr(a, 'M'), color,
        });
      }
      this.P.FPDFPage_CloseAnnot(a);
    }
    this.free(rp); this.free(cp);
    return out;
  }
  private annotStr(a: number, key: string) { return this.readW((b, l) => this.P.FPDFAnnot_GetStringValue(a, key, b, l)); }
  private setAnnotStr(a: number, key: string, v: string) { const p = this.wstr(v); this.P.FPDFAnnot_SetStringValue(a, key, p); this.free(p); }
  private pdfDate() {
    const t = new Date(), z = -t.getTimezoneOffset(), p2 = (n: number) => String(Math.abs(n)).padStart(2, '0');
    return `D:${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}${z >= 0 ? '+' : '-'}${p2(Math.floor(z / 60))}'${p2(z % 60)}'`;
  }

  /** 새 주석. 좌표는 화면 pt. 돌려주는 id(객체 번호)로 나중에 고치거나 지운다. */
  addAnnot(docId: number, key: number, spec: AnnotSpec): number {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const a = this.P.EPDFPage_CreateAnnot(pc.page, spec.subtype);
    if (!a) throw new Error('주석을 만들지 못했습니다');
    const [R, G, B] = fromHex(spec.color || '#ffd400');
    const rp = this.malloc(32);
    let bounds: number[] | null = null;
    const grow = (x: number, y: number) => { bounds = bounds ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)] : [x, y, x, y]; };
    if (spec.quads) {
      for (const q of spec.quads) {
        // 화면 기준 좌상, 우상, 좌하, 우하 → PDF QuadPoints 순서
        const tl = this.toPage(pc, q.x, q.y), tr = this.toPage(pc, q.x + q.w, q.y), bl = this.toPage(pc, q.x, q.y + q.h), br = this.toPage(pc, q.x + q.w, q.y + q.h);
        this.setF32(rp, [...tl, ...tr, ...bl, ...br]);
        this.P.FPDFAnnot_AppendAttachmentPoints(a, rp);
        [tl, tr, bl, br].forEach(p => grow(p[0], p[1]));
      }
    }
    if (spec.ink) {
      for (const stroke of spec.ink) {
        const pp = this.malloc(stroke.length * 8);
        stroke.forEach(([x, y], i) => { const p = this.toPage(pc, x, y); this.setF32(pp + i * 8, p); grow(p[0], p[1]); });
        this.P.FPDFAnnot_AddInkStroke(a, pp, stroke.length);
        this.free(pp);
      }
    }
    if (spec.rect) {
      const p1 = this.toPage(pc, spec.rect.x, spec.rect.y), p2 = this.toPage(pc, spec.rect.x + spec.rect.w, spec.rect.y + spec.rect.h);
      grow(p1[0], p1[1]); grow(p2[0], p2[1]);
    }
    if (spec.point) {
      const p = this.toPage(pc, spec.point.x, spec.point.y);
      grow(p[0], p[1] - 20); grow(p[0] + 20, p[1]);
    }
    const pad = (spec.width || 1) / 2 + 1;
    const bb = bounds || [0, 0, 10, 10];
    const isMarkup = spec.subtype >= 9 && spec.subtype <= 12;
    this.setF32(rp, isMarkup || spec.subtype === ANNOT.TEXT || spec.subtype === ANNOT.REDACT
      ? [bb[0], bb[3], bb[2], bb[1]]
      : [bb[0] - pad, bb[3] + pad, bb[2] + pad, bb[1] - pad]);
    this.P.FPDFAnnot_SetRect(a, rp);
    this.free(rp);
    if (spec.subtype === ANNOT.REDACT) this.P.FPDFAnnot_SetColor(a, 1, R, G, B, 255);
    else this.P.FPDFAnnot_SetColor(a, 0, R, G, B, 255);
    if (spec.fill) { const [r2, g2, b2] = fromHex(spec.fill); this.P.FPDFAnnot_SetColor(a, 1, r2, g2, b2, 255); }
    if (spec.width) this.P.FPDFAnnot_SetBorder(a, 0, 0, spec.width);
    if (spec.opacity !== undefined && spec.opacity < 1) this.P.EPDFAnnot_SetOpacity(a, Math.round(spec.opacity * 255));
    if (spec.contents) this.setAnnotStr(a, 'Contents', spec.contents);
    this.setAnnotStr(a, 'T', spec.author || this.author);
    this.setAnnotStr(a, 'M', this.pdfDate());
    if (spec.subtype === ANNOT.TEXT) this.P.FPDFAnnot_SetFlags(a, 4 | 8 | 16); // Print, NoZoom, NoRotate
    else this.P.FPDFAnnot_SetFlags(a, 4);
    if (spec.subtype !== ANNOT.REDACT) this.P.EPDFAnnot_GenerateAppearance(a);
    const id = this.P.EPDFAnnot_GetObjectNumber(a);
    this.P.FPDFPage_CloseAnnot(a);
    this.touch(pc);
    return id;
  }
  updateAnnot(docId: number, key: number, id: number, patch: { contents?: string; color?: string }) {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const a = this.P.EPDFPage_GetAnnotByObjectNumber(pc.page, id); if (!a) return false;
    if (patch.contents !== undefined) this.setAnnotStr(a, 'Contents', patch.contents);
    if (patch.color) { const [R, G, B] = fromHex(patch.color); this.P.FPDFAnnot_SetColor(a, 0, R, G, B, 255); this.P.EPDFAnnot_GenerateAppearance(a); }
    this.setAnnotStr(a, 'M', this.pdfDate());
    this.P.FPDFPage_CloseAnnot(a);
    this.touch(pc);
    return true;
  }
  /**
   * 주석 지우기/되살리기. 바로 지우지 않고 숨겨 두었다가(되돌리기 가능) 저장할 때 실제로 뺀다.
   */
  setAnnotRemoved(docId: number, key: number, id: number, removed: boolean) {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const a = this.P.EPDFPage_GetAnnotByObjectNumber(pc.page, id); if (!a) return false;
    const f = this.P.FPDFAnnot_GetFlags(a);
    this.P.FPDFAnnot_SetFlags(a, removed ? f | 2 : f & ~2);
    this.P.FPDFPage_CloseAnnot(a);
    const set = d.removedAnnots.get(key) || new Set<number>();
    removed ? set.add(id) : set.delete(id);
    d.removedAnnots.set(key, set);
    this.touch(pc);
    return true;
  }

  /** 영역 안의 글자·그림·선을 실제로 지운다(겉만 덮는 것이 아님). 되돌릴 수 없다. */
  redact(docId: number, key: number, rect: Rect, fill: string | null) {
    const id = this.addAnnot(docId, key, { subtype: ANNOT.REDACT, quads: [rect], rect, color: fill || '#000000' });
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const a = this.P.EPDFPage_GetAnnotByObjectNumber(pc.page, id);
    if (!fill) this.P.FPDFAnnot_SetColor(a, 1, 255, 255, 255, 0);
    const ok = this.P.EPDFAnnot_ApplyRedaction(pc.page, a);
    this.P.FPDFPage_CloseAnnot(a);
    this.touch(pc);
    return ok;
  }

  /* ───────────── 원본 글자 편집 (페이지 객체) ───────────── */
  private objMatrix(o: number): M6 { const p = this.malloc(24); this.P.FPDFPageObj_GetMatrix(o, p); const m = this.f32(p, 6) as M6; this.free(p); return m; }
  private objBounds(o: number) { const p = this.malloc(16); const ok = this.P.FPDFPageObj_GetBounds(o, p, p + 4, p + 8, p + 12); const v = this.f32(p, 4); this.free(p); return ok ? v : null; } // l b r t
  private objText(o: number, tp: number) { return this.readW((b, l) => this.P.FPDFTextObj_GetText(o, tp, b, l)); }
  private objColor(o: number) { const p = this.malloc(16); this.P.FPDFPageObj_GetFillColor(o, p, p + 4, p + 8, p + 12); const v = this.u32(p, 4); this.free(p); return v; }
  private fontSize(o: number) { const p = this.malloc(4); this.P.FPDFTextObj_GetFontSize(o, p); const v = this.f32(p, 1)[0]; this.free(p); return v; }
  private fontName(f: number) {
    const n = this.P.FPDFFont_GetBaseFontName(f, 0, 0); if (n <= 1) return '';
    const b = this.malloc(n); this.P.FPDFFont_GetBaseFontName(f, b, n); const s = this.M.UTF8ToString(b); this.free(b); return s;
  }

  /** 페이지의 글자 객체를 줄 단위로 묶어 돌려준다 */
  textRuns(docId: number, key: number): TextRun[] {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const tp = this.textPage(pc);
    type Item = { o: number; text: string; m: M6; size: number; vs: number; ang: number; font: number; color: number[]; mode: number; b: number[] };
    const items: Item[] = [];
    this.walk(pc, (o, t, fm) => {
      if (t !== OBJ_TEXT) return;
      const text = this.objText(o, tp);
      if (!text || !text.trim()) return;
      let b = this.objBounds(o); if (!b) return;
      let m = this.objMatrix(o);
      if (fm) { m = mul(m, fm); b = this.mapBounds(b, fm); }
      const size = this.fontSize(o);
      items.push({ o, text, m, size, vs: size * Math.hypot(m[2], m[3]), ang: Math.atan2(m[1], m[0]), font: this.P.FPDFTextObj_GetFont(o), color: this.objColor(o), mode: this.P.FPDFTextObj_GetTextRenderMode(o), b });
    });
    const runs: TextRun[] = [];
    let cur: { items: Item[]; text: string; endX: number; base: number } | null = null;
    const frame = (it: Item, x: number, y: number) => { const c = Math.cos(-it.ang), s = Math.sin(-it.ang); return [x * c - y * s, x * s + y * c]; };
    const flush = () => { if (cur) runs.push(this.makeRun(pc, cur.items, cur.text)); cur = null; };
    for (const it of items) {
      const [ox, oy] = frame(it, it.m[4], it.m[5]);
      const corners = [[it.b[0], it.b[1]], [it.b[2], it.b[3]], [it.b[0], it.b[3]], [it.b[2], it.b[1]]].map(([x, y]) => frame(it, x, y)[0]);
      const right = Math.max(...corners);
      if (cur) {
        const f = cur.items[0];
        const same = f.font === it.font && Math.abs(f.vs - it.vs) < 0.6 && Math.abs(f.ang - it.ang) < 0.02 &&
          f.color.join() === it.color.join() && f.mode === it.mode && Math.abs(oy - cur.base) < it.vs * 0.25;
        const gap = ox - cur.endX;
        if (same && gap > -it.vs * 0.5 && gap < it.vs * 1.6) {
          const needSpace = gap > it.vs * 0.22 && !/\s$/.test(cur.text) && !/^\s/.test(it.text);
          cur.text += (needSpace ? ' ' : '') + it.text; cur.items.push(it); cur.endX = Math.max(cur.endX, right);
          continue;
        }
        flush();
      }
      cur = { items: [it], text: it.text, endX: right, base: oy };
    }
    flush();
    return runs;
  }
  private makeRun(pc: PageCtx, items: any[], text: string): TextRun {
    let l = Infinity, b = Infinity, r = -Infinity, t = -Infinity;
    for (const it of items) { l = Math.min(l, it.b[0]); b = Math.min(b, it.b[1]); r = Math.max(r, it.b[2]); t = Math.max(t, it.b[3]); }
    const f = items[0];
    const name = this.fontName(f.font);
    const weight = this.P.FPDFFont_GetWeight(f.font);
    const ip = this.malloc(4); this.P.FPDFFont_GetItalicAngle(f.font, ip); const italic = this.M.HEAP32[ip >> 2] !== 0 || /Italic|Oblique/i.test(name); this.free(ip);
    const [ox, oy] = ap(pc.m, f.m[4], f.m[5]);
    return {
      objs: items.map((i: any) => i.o), text: text.replace(/\s+$/, ''), rect: this.toDisp(pc, l, b, r, t),
      inForm: items.some((i: any) => pc.nested?.has(i.o)),
      size: Math.round(f.vs * 10) / 10, color: toHex(f.color[0], f.color[1], f.color[2]),
      font: name.replace(/^[A-Z]{6}\+/, ''), bold: weight >= 600 || /Bold|Black|Heavy|Semibold|Demi/i.test(name),
      italic, embedded: !!this.P.FPDFFont_GetIsEmbedded(f.font), invisible: f.mode === TEXTMODE_INVISIBLE,
      origin: { x: ox, y: oy }, angle: Math.round(-f.ang * 180 / Math.PI) % 360,
    };
  }

  /** 페이지에서 해당 글꼴이 이미 그린 글자 모음 (재사용 가능 여부 판단용) */
  private fontChars(pc: PageCtx, font: number) {
    const tp = this.textPage(pc);
    const set = new Set<string>();
    this.walk(pc, (o, t) => { if (t === OBJ_TEXT && this.P.FPDFTextObj_GetFont(o) === font) for (const ch of this.objText(o, tp)) set.add(ch); }, false);
    return set;
  }

  /**
   * 원본 글자 줄을 새 글자로 바꾼다.
   * - 원래 글꼴에 필요한 글자가 다 있으면 원래 글꼴을 그대로 쓴다(모양 유지).
   * - 없으면 Noto Sans KR 부분 글꼴을 문서에 넣어 진짜 글자(벡터)로 쓴다. 이미지로 바꾸지 않는다.
   * 원래 객체는 떼어 두었다가 되돌리기에 쓴다.
   */
  async editRun(docId: number, key: number, objs: number[], newText: string): Promise<ObjChange> {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const also = this.liftObjs(d, pc, objs);
    const first = objs[0];
    const m = this.objMatrix(first), size = this.fontSize(first), font = this.P.FPDFTextObj_GetFont(first);
    const color = this.objColor(first), mode = this.P.FPDFTextObj_GetTextRenderMode(first);
    const lines = newText.replace(/\r/g, '').split('\n');
    const chars = [...new Set([...lines.join('')])];
    const known = this.fontChars(pc, font);
    const embedded = !!this.P.FPDFFont_GetIsEmbedded(font);
    const reuse = chars.every(c => known.has(c) || c === ' ' || (!embedded && c.charCodeAt(0) < 256));
    const splitWords = reuse && embedded && !known.has(' ') && lines.some(l => l.includes(' '));
    let useFont = font, fake = false;
    if (!reuse) {
      const name = this.fontName(font);
      fake = this.P.FPDFFont_GetWeight(font) >= 600 || /Bold|Black|Heavy/i.test(name);
      useFont = await this.loadSubsetFont(d, lines.join(''));
    }
    const index = this.objIndex(pc, first);
    const removed = objs.map(o => ({ h: o, idx: this.objIndex(pc, o) }));
    for (const o of objs) this.P.FPDFPage_RemoveObject(pc.page, o);
    const added: { h: number; idx: number }[] = [];
    const vs = size * Math.hypot(m[2], m[3]);
    const ux = m[2] / Math.hypot(m[2], m[3]), uy = m[3] / Math.hypot(m[2], m[3]); // 글줄의 위쪽 방향
    const dirLen = Math.hypot(m[0], m[1]) || 1, dx = m[0] / dirLen, dyv = m[1] / dirLen; // 글줄 진행 방향
    lines.forEach((line, i) => {
      if (!line && lines.length > 1) return;
      const dy = i * vs * 1.25;
      let ox = m[4] - ux * dy, oy = m[5] - uy * dy;
      // 원래 글꼴에 공백 글자가 없으면 낱말마다 객체를 나눠 놓는다
      const pieces = splitWords ? line.split(/( +)/).filter(Boolean) : [line];
      for (const piece of pieces) {
        if (splitWords && /^ +$/.test(piece)) { const adv = piece.length * vs * 0.28; ox += dx * adv; oy += dyv * adv; continue; }
        const o = this.P.FPDFPageObj_CreateTextObj(d.doc, useFont, size);
        const w = this.wstr(piece); this.P.FPDFText_SetText(o, w); this.free(w);
        this.setMatrix(o, [m[0], m[1], m[2], m[3], ox, oy]);
        this.P.FPDFPageObj_SetFillColor(o, color[0], color[1], color[2], color[3]);
        if (mode === TEXTMODE_INVISIBLE) this.P.FPDFTextObj_SetTextRenderMode(o, TEXTMODE_INVISIBLE);
        else if (fake) this.fakeBold(o, color, size);
        const at = Math.min(index + added.length, this.P.FPDFPage_CountObjects(pc.page));
        this.P.FPDFPage_InsertObjectAtIndex(pc.page, o, at);
        added.push({ h: o, idx: at });
        if (splitWords) {
          const b = this.objBounds(o);
          if (b) { const proj = [[b[0], b[1]], [b[2], b[3]], [b[0], b[3]], [b[2], b[1]]].map(([x, y]) => (x - ox) * dx + (y - oy) * dyv); const adv = Math.max(...proj); ox += dx * adv; oy += dyv * adv; }
        }
      }
    });
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed, added, substituted: !reuse, also };
  }
  private fakeBold(o: number, color: number[], size: number) {
    this.P.FPDFTextObj_SetTextRenderMode(o, TEXTMODE_FILL_STROKE);
    this.P.FPDFPageObj_SetStrokeColor(o, color[0], color[1], color[2], color[3] ?? 255);
    this.P.FPDFPageObj_SetStrokeWidth(o, Math.max(0.2, size * 0.035));
  }
  private setMatrix(o: number, m: number[], image = false) { const p = this.malloc(24); this.setF32(p, m); image ? this.P.FPDFImageObj_SetMatrix(o, m[0], m[1], m[2], m[3], m[4], m[5]) : this.P.FPDFPageObj_SetMatrix(o, p); this.free(p); }
  private objIndex(pc: PageCtx, o: number) {
    const n = this.P.FPDFPage_CountObjects(pc.page);
    for (let i = 0; i < n; i++) if (this.P.FPDFPage_GetObject(pc.page, i) === o) return i;
    return n;
  }
  private gen(d: DocCtx, key: number) { return d.gen.get(key) || 0; }
  private async loadSubsetFont(d: DocCtx, text: string) {
    const sub = await this.fonts.subset(text + ' ');
    const p = this.put(sub);
    const f = this.P.FPDFText_LoadFont(d.doc, p, sub.length, FONT_TRUETYPE, true);
    this.free(p);
    if (!f) throw new Error('글꼴을 문서에 넣지 못했습니다');
    return f;
  }

  pageGen(docId: number, key: number) { return this.gen(this.D(docId), key); }

  /* ───────────── 양식(Form XObject) 안의 객체 ───────────── */
  /** 쪽의 객체를 양식 안까지 훑는다. fm: 그 객체가 든 양식 공간 → 쪽 공간 행렬 (쪽에 바로 있으면 null) */
  private walk(pc: PageCtx, fn: (o: number, type: number, fm: M6 | null) => void, record = true) {
    if (record) pc.nested = new Map();
    const n = this.P.FPDFPage_CountObjects(pc.page);
    for (let i = 0; i < n; i++) {
      const o = this.P.FPDFPage_GetObject(pc.page, i);
      const t = this.P.FPDFPageObj_GetType(o);
      fn(o, t, null);
      if (t === OBJ_FORM) this.walkForm(pc, o, o, this.objMatrix(o), [], 0, fn, record);
    }
  }
  private walkForm(pc: PageCtx, form: number, top: number, fm: M6, path: number[], depth: number, fn: (o: number, type: number, fm: M6 | null) => void, record: boolean) {
    if (depth > 5) return;
    const n = this.P.FPDFFormObj_CountObjects(form);
    for (let i = 0; i < n; i++) {
      const o = this.P.FPDFFormObj_GetObject(form, i); if (!o) continue;
      const t = this.P.FPDFPageObj_GetType(o);
      const info: NestedInfo = { parent: form, top, fm, path: [...path, i] };
      if (record) pc.nested!.set(o, info);
      fn(o, t, fm);
      if (t === OBJ_FORM) this.walkForm(pc, o, top, mul(this.objMatrix(o), fm), info.path, depth + 1, fn, record);
    }
  }
  private mapBounds(b: number[], m: M6) {
    const pts = [ap(m, b[0], b[1]), ap(m, b[2], b[3]), ap(m, b[0], b[3]), ap(m, b[2], b[1])];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  /** 양식의 생김새 지문: 같은 양식(스트림)을 여러 곳에서 쓰는지 알아보는 데 쓴다 */
  private formSig(form: number) {
    const n = this.P.FPDFFormObj_CountObjects(form);
    const parts: string[] = [String(n)];
    for (let i = 0; i < Math.min(n, 10); i++) {
      const o = this.P.FPDFFormObj_GetObject(form, i);
      const b = this.objBounds(o);
      parts.push(this.P.FPDFPageObj_GetType(o) + ':' + (b ? b.map(v => Math.round(v * 10)).join(',') : '-'));
    }
    return parts.join('|');
  }
  private atPath(top: number, path: number[]): { o: number; parent: number; fm: M6 } | null {
    let parent = top, fm = this.objMatrix(top), o = 0;
    for (let k = 0; k < path.length; k++) {
      if (this.P.FPDFPageObj_GetType(parent) !== OBJ_FORM) return null;
      o = this.P.FPDFFormObj_GetObject(parent, path[k]); if (!o) return null;
      if (k < path.length - 1) { fm = mul(this.objMatrix(o), fm); parent = o; }
    }
    return { o, parent, fm };
  }
  /** 양식 안 객체를 양식에서 꺼내 쪽에 바로 놓는다. 모양과 글꼴은 그대로. */
  private liftOne(pc: PageCtx, o: number, parent: number, fm: M6, top: number) {
    const m = this.objMatrix(o);
    if (!this.P.FPDFFormObj_RemoveObject(parent, o)) return false;
    this.setMatrix(o, mul(m, fm));
    this.P.FPDFPageObj_TransformClipPath(o, fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
    this.P.FPDFPage_InsertObjectAtIndex(pc.page, o, Math.min(this.objIndex(pc, top) + 1, this.P.FPDFPage_CountObjects(pc.page)));
    pc.nested?.delete(o);
    pc.dirty = true;
    return true;
  }
  /**
   * 고칠 객체 가운데 양식 안에 든 것을 꺼낸다.
   * 양식 스트림은 여러 쪽(또는 한 쪽의 여러 곳)이 함께 쓸 수 있어서, 같은 양식을 쓰는 다른 곳에서도
   * 같은 객체를 함께 꺼내야 그쪽 글자가 사라지지 않는다. 돌려주는 값: 함께 바뀐 다른 쪽의 키
   */
  private liftObjs(d: DocCtx, pc: PageCtx, objs: number[]): number[] {
    if (!pc.nested || !objs.some(o => pc.nested!.has(o))) return [];
    pc.dirty = true; // 훑는 동안 내려가지 않게
    const list = objs.map(o => ({ o, info: pc.nested!.get(o) })).filter(x => x.info) as { o: number; info: NestedInfo }[];
    // 같은 양식 안에서 뒤쪽 번호부터 꺼내야 앞쪽 번호가 바뀌지 않는다
    list.sort((a, b) => { const pa = a.info.path, pb = b.info.path; for (let k = 0; k < Math.max(pa.length, pb.length); k++) { const x = pa[k] ?? -1, y = pb[k] ?? -1; if (x !== y) return y - x; } return 0; });
    const tops = [...new Set(list.map(x => x.info.top))];
    const sigs = new Map(tops.map(t => [t, this.formSig(t)]));
    // 같은 지문의 양식을 쓰는 다른 곳 찾기
    const twins: { pc: PageCtx; top: number; srcTop: number }[] = [];
    for (const key of d.keys) {
      const other = this.pageByKey(d, key);
      const n = this.P.FPDFPage_CountObjects(other.page);
      for (let i = 0; i < n; i++) {
        const o = this.P.FPDFPage_GetObject(other.page, i);
        if (this.P.FPDFPageObj_GetType(o) !== OBJ_FORM) continue;
        for (const t of tops) if (o !== t && this.formSig(o) === sigs.get(t)) { twins.push({ pc: other, top: o, srcTop: t }); other.dirty = true; }
      }
    }
    const also = new Set<number>();
    for (const { o, info } of list) {
      for (const tw of twins) {
        if (tw.srcTop !== info.top) continue;
        const hit = this.atPath(tw.top, info.path);
        if (hit && this.P.FPDFPageObj_GetType(hit.o) === this.P.FPDFPageObj_GetType(o)) { this.liftOne(tw.pc, hit.o, hit.parent, hit.fm, tw.top); if (tw.pc !== pc) also.add(tw.pc.key); }
      }
      this.liftOne(pc, o, info.parent, info.fm, info.top);
    }
    for (const k of also) this.touch(this.pageByKey(d, k));
    return [...also];
  }
  /** 객체 지우기(떼어 두기) */
  removeObjs(docId: number, key: number, objs: number[]): ObjChange {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const also = this.liftObjs(d, pc, objs);
    const removed = objs.map(o => ({ h: o, idx: this.objIndex(pc, o) }));
    for (const o of objs) this.P.FPDFPage_RemoveObject(pc.page, o);
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed, added: [], substituted: false, also };
  }
  setMeta(docId: number, key: string, value: string) {
    const d = this.D(docId); const p = this.wstr(value);
    const ok = this.P.EPDF_SetMetaText(d.doc, key, p); this.free(p); return ok;
  }
  /** 되돌리기/다시하기용: 객체를 떼거나 다시 붙인다 */
  detach(docId: number, key: number, gen: number, objs: { h: number }[]) {
    const d = this.D(docId); if (this.gen(d, key) !== gen) return false;
    const pc = this.pageByKey(d, key);
    for (const o of objs) this.P.FPDFPage_RemoveObject(pc.page, o.h);
    this.touch(pc); return true;
  }
  attach(docId: number, key: number, gen: number, objs: { h: number; idx: number }[]) {
    const d = this.D(docId); if (this.gen(d, key) !== gen) return false;
    const pc = this.pageByKey(d, key);
    for (const o of [...objs].sort((a, b) => a.idx - b.idx)) this.P.FPDFPage_InsertObjectAtIndex(pc.page, o.h, Math.min(o.idx, this.P.FPDFPage_CountObjects(pc.page)));
    this.touch(pc); return true;
  }
  /** 화면 좌표 dx,dy만큼 이동 (scale이 있으면 기준점 둘레로 확대) */
  transformObjs(docId: number, key: number, gen: number, objs: number[], dx: number, dy: number, scale = 1, about?: { x: number; y: number }) {
    const d = this.D(docId); if (this.gen(d, key) !== gen) return false;
    const pc = this.pageByKey(d, key);
    const also = this.liftObjs(d, pc, objs);
    // 화면 공간 변환 T를 페이지 공간으로: inv ∘ T ∘ m  (m: page→disp)
    const ax = about?.x ?? 0, ay = about?.y ?? 0;
    const T: M6 = [scale, 0, 0, scale, ax - ax * scale + dx, ay - ay * scale + dy];
    const PT = mul(mul(pc.m, T), pc.inv);
    for (const o of objs) this.P.FPDFPageObj_Transform(o, PT[0], PT[1], PT[2], PT[3], PT[4], PT[5]);
    this.touch(pc); return also.length ? { also } : true;
  }

  /** 편집 모드에서 고를 수 있는 그림/도형 객체 */
  pageObjects(docId: number, key: number): PageObjInfo[] {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const out: PageObjInfo[] = [];
    this.walk(pc, (o, t, fm) => {
      if (t !== OBJ_IMAGE && t !== OBJ_PATH) return;
      let b = this.objBounds(o); if (!b) return;
      if (fm) b = this.mapBounds(b, fm);
      const rect = this.toDisp(pc, b[0], b[1], b[2], b[3]);
      if (t === OBJ_PATH && (rect.w > pc.w * 0.95 && rect.h > pc.h * 0.95)) return; // 페이지 배경
      out.push({ h: o, type: t === OBJ_IMAGE ? 'image' : 'path', rect, inForm: !!fm });
    });
    return out;
  }

  /** 새 글자 넣기. x,y: 첫 줄 글자 상자의 왼쪽 위(화면 pt) */
  async addText(docId: number, key: number, spec: { x: number; y: number; text: string; size: number; color: string; bold?: boolean; invisible?: boolean; widthFit?: number }): Promise<ObjChange> {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const lines = spec.text.replace(/\r/g, '').split('\n');
    const font = await this.loadSubsetFont(d, lines.join(''));
    const added: { h: number; idx: number }[] = [];
    const [R, G, B] = fromHex(spec.color);
    lines.forEach((line, i) => {
      if (!line) return;
      const o = this.P.FPDFPageObj_CreateTextObj(d.doc, font, spec.size);
      const w = this.wstr(line); this.P.FPDFText_SetText(o, w); this.free(w);
      const baseY = spec.y + spec.size * (1.1 + i * 1.25);
      let m = this.uprightMatrix(pc, spec.x, baseY, 1);
      if (spec.widthFit) {
        this.setMatrix(o, (m));
        const b = this.objBounds(o);
        if (b) { const r = this.toDisp(pc, b[0], b[1], b[2], b[3]); const nat = r.w; if (nat > 0.1) m = this.uprightMatrix(pc, spec.x, baseY, spec.widthFit / nat); }
      }
      this.setMatrix(o, (m));
      this.P.FPDFPageObj_SetFillColor(o, R, G, B, 255);
      if (spec.invisible) this.P.FPDFTextObj_SetTextRenderMode(o, TEXTMODE_INVISIBLE);
      else if (spec.bold) this.fakeBold(o, [R, G, B, 255], spec.size);
      this.P.FPDFPage_InsertObject(pc.page, o);
      added.push({ h: o, idx: this.P.FPDFPage_CountObjects(pc.page) - 1 });
    });
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed: [], added, substituted: true };
  }
  /** 화면에서 똑바로 보이도록 하는 객체 행렬 (화면 (x,y)가 원점, sx: 가로 배율) */
  private uprightMatrix(pc: PageCtx, x: number, y: number, sx: number): M6 {
    const o = this.toPage(pc, x, y), rx = this.toPage(pc, x + 1, y), up = this.toPage(pc, x, y - 1);
    return [(rx[0] - o[0]) * sx, (rx[1] - o[1]) * sx, up[0] - o[0], up[1] - o[1], o[0], o[1]];
  }

  addImage(docId: number, key: number, spec: { bytes: Uint8Array; kind: 'jpg' | 'png'; x: number; y: number; w: number; h: number }): ObjChange {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const o = this.P.FPDFPageObj_NewImageObj(d.doc);
    const p = this.put(spec.bytes);
    const ok = spec.kind === 'jpg' ? this.P.EPDFImageObj_SetJpeg(pc.page, 0, o, p, spec.bytes.length) : this.P.EPDFImageObj_SetPng(pc.page, 0, o, p, spec.bytes.length);
    this.free(p);
    if (!ok) { this.P.FPDFPageObj_Destroy(o); throw new Error('이미지를 넣지 못했습니다'); }
    const bl = this.toPage(pc, spec.x, spec.y + spec.h), br = this.toPage(pc, spec.x + spec.w, spec.y + spec.h), tl = this.toPage(pc, spec.x, spec.y);
    this.setMatrix(o, ([br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]]));
    this.P.FPDFPage_InsertObject(pc.page, o);
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed: [], added: [{ h: o, idx: this.P.FPDFPage_CountObjects(pc.page) - 1 }], substituted: false };
  }

  /** 선/사각형 등 도형(벡터 경로). segs: 화면 좌표 점 목록들 */
  private addPath(pc: PageCtx, d: DocCtx, polys: [number, number][][], o: { stroke?: string; width?: number; fill?: string; close?: boolean }) {
    const first = this.toPage(pc, polys[0][0][0], polys[0][0][1]);
    const path = this.P.FPDFPageObj_CreateNewPath(first[0], first[1]);
    polys.forEach((poly, pi) => {
      poly.forEach(([x, y], i) => {
        const p = this.toPage(pc, x, y);
        if (i === 0) { if (pi > 0) this.P.FPDFPath_MoveTo(path, p[0], p[1]); } else this.P.FPDFPath_LineTo(path, p[0], p[1]);
      });
      if (o.close) this.P.FPDFPath_Close(path);
    });
    if (o.stroke) { const [R, G, B] = fromHex(o.stroke); this.P.FPDFPageObj_SetStrokeColor(path, R, G, B, 255); this.P.FPDFPageObj_SetStrokeWidth(path, o.width || 1); }
    if (o.fill) { const [R, G, B] = fromHex(o.fill); this.P.FPDFPageObj_SetFillColor(path, R, G, B, 255); }
    this.P.FPDFPath_SetDrawMode(path, o.fill ? 1 : 0, !!o.stroke);
    this.P.FPDFPage_InsertObject(pc.page, path);
    return path;
  }
  addShape(docId: number, key: number, spec: { kind: 'rect' | 'line' | 'ellipse'; x: number; y: number; w: number; h: number; stroke?: string; width?: number; fill?: string }): ObjChange {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    let poly: [number, number][];
    if (spec.kind === 'line') poly = [[spec.x, spec.y], [spec.x + spec.w, spec.y + spec.h]];
    else if (spec.kind === 'rect') poly = [[spec.x, spec.y], [spec.x + spec.w, spec.y], [spec.x + spec.w, spec.y + spec.h], [spec.x, spec.y + spec.h]];
    else { poly = []; const cx = spec.x + spec.w / 2, cy = spec.y + spec.h / 2; for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2; poly.push([cx + Math.cos(a) * spec.w / 2, cy + Math.sin(a) * spec.h / 2]); } }
    const path = this.addPath(pc, d, [poly], { stroke: spec.stroke, width: spec.width, fill: spec.fill, close: spec.kind !== 'line' });
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed: [], added: [{ h: path, idx: this.P.FPDFPage_CountObjects(pc.page) - 1 }], substituted: false };
  }

  /** 표: 선(벡터) + 칸마다 진짜 글자 */
  async addTable(docId: number, key: number, t: TableSpec): Promise<ObjChange> {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const added: { h: number; idx: number }[] = [];
    const push = (h: number) => added.push({ h, idx: this.P.FPDFPage_CountObjects(pc.page) - 1 });
    const xs = [t.x]; t.cols.forEach(w => xs.push(xs[xs.length - 1] + w));
    const ys = [t.y]; t.rows.forEach(h => ys.push(ys[ys.length - 1] + h));
    const X1 = xs[xs.length - 1], Y1 = ys[ys.length - 1];
    if (t.headerFill) push(this.addPath(pc, d, [[[t.x, t.y], [X1, t.y], [X1, ys[1]], [t.x, ys[1]]]], { fill: t.headerFill, close: true }));
    const lines: [number, number][][] = [];
    ys.forEach(y => lines.push([[t.x, y], [X1, y]]));
    xs.forEach(x => lines.push([[x, t.y], [x, Y1]]));
    push(this.addPath(pc, d, lines, { stroke: t.border, width: t.borderWidth }));
    const allText = t.cells.flat().join('');
    if (allText.trim()) {
      const font = await this.loadSubsetFont(d, allText);
      const [R, G, B] = fromHex(t.color);
      for (let r = 0; r < t.rows.length; r++) for (let c = 0; c < t.cols.length; c++) {
        const cell = (t.cells[r]?.[c] || '').split('\n');
        const fs = t.fontSize, lh = fs * 1.25;
        const blockH = cell.length * lh;
        cell.forEach((line, li) => {
          if (!line) return;
          const o = this.P.FPDFPageObj_CreateTextObj(d.doc, font, fs);
          const w = this.wstr(line); this.P.FPDFText_SetText(o, w); this.free(w);
          const top = ys[r] + (t.rows[r] - blockH) / 2 + li * lh;
          const base = top + fs * 0.95;
          let x = xs[c] + t.padding;
          this.setMatrix(o, (this.uprightMatrix(pc, x, base, 1)));
          const align = t.align?.[c] || (r === 0 && t.headerFill ? 'center' : 'left');
          if (align !== 'left') {
            const b = this.objBounds(o);
            if (b) { const rr = this.toDisp(pc, b[0], b[1], b[2], b[3]); const tw = rr.w; const cw = t.cols[c] - t.padding * 2; x = align === 'center' ? xs[c] + (t.cols[c] - tw) / 2 : xs[c] + t.padding + cw - tw; }
            this.setMatrix(o, (this.uprightMatrix(pc, x, base, 1)));
          }
          this.P.FPDFPageObj_SetFillColor(o, R, G, B, 255);
          if (r === 0 && t.headerBold) this.fakeBold(o, [R, G, B, 255], fs);
          this.P.FPDFPage_InsertObject(pc.page, o); push(o);
        });
      }
    }
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed: [], added, substituted: true };
  }

  /** OCR 결과를 보이지 않는 글자층으로 얹어 검색·복사가 되게 한다 */
  async addOcrLayer(docId: number, key: number, words: { text: string; x: number; y: number; w: number; h: number }[]): Promise<ObjChange> {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const all = words.map(w => w.text).join('');
    if (!all.trim()) return { key, gen: this.gen(d, key), removed: [], added: [], substituted: true };
    const font = await this.loadSubsetFont(d, all);
    const added: { h: number; idx: number }[] = [];
    for (const wd of words) {
      if (!wd.text.trim()) continue;
      const size = Math.max(2, wd.h * 0.88);
      const o = this.P.FPDFPageObj_CreateTextObj(d.doc, font, size);
      const w = this.wstr(wd.text); this.P.FPDFText_SetText(o, w); this.free(w);
      const base = wd.y + wd.h * 0.86;
      this.setMatrix(o, (this.uprightMatrix(pc, wd.x, base, 1)));
      const b = this.objBounds(o);
      if (b) { const r = this.toDisp(pc, b[0], b[1], b[2], b[3]); const nat = Math.max(r.w, 0.1); this.setMatrix(o, (this.uprightMatrix(pc, wd.x, base, wd.w / nat))); }
      this.P.FPDFTextObj_SetTextRenderMode(o, TEXTMODE_INVISIBLE);
      this.P.FPDFPage_InsertObject(pc.page, o);
      added.push({ h: o, idx: this.P.FPDFPage_CountObjects(pc.page) - 1 });
    }
    this.touch(pc);
    return { key, gen: this.gen(d, key), removed: [], added, substituted: true };
  }
  hasText(docId: number, index: number) { const pc = this.page(this.D(docId), index); return this.P.FPDFText_CountChars(this.textPage(pc)) > 0; }

  /* ───────────── 페이지 다루기 ───────────── */
  rotatePage(docId: number, key: number, delta: number) {
    const d = this.D(docId); const pc = this.pageByKey(d, key);
    const r = ((this.P.FPDFPage_GetRotation(pc.page) + delta) % 4 + 4) % 4;
    this.P.FPDFPage_SetRotation(pc.page, r);
    this.touch(pc);
  }
  insertBlank(docId: number, at: number, w: number, h: number, reuseKey?: number) {
    const d = this.D(docId);
    const page = this.P.FPDFPage_New(d.doc, at, w, h);
    const key = reuseKey ?? d.nextKey++;
    if (reuseKey) d.gen.set(key, this.gen(d, key) + 1);
    d.keys.splice(at, 0, key);
    const pc: PageCtx = { key, page, text: 0, dirty: true, used: performance.now(), ...this.geometry(page) };
    d.pages.set(key, pc);
    this.P.FPDFPage_GenerateContent(page);
    return key;
  }
  /** 페이지 삭제. 되살리기용으로 임시 문서에 복사본을 남긴다 */
  deletePage(docId: number, key: number) {
    const d = this.D(docId);
    const index = d.keys.indexOf(key);
    const pc = d.pages.get(key);
    if (pc) { this.P.FPDFPage_GenerateContent(pc.page); }
    const tmp = this.P.FPDF_CreateNewDocument();
    const ip = this.malloc(4); this.M.HEAP32[ip >> 2] = index;
    this.P.FPDF_ImportPagesByIndex(tmp, d.doc, ip, 1, 0); this.free(ip);
    if (pc) { this.closePage(pc); d.pages.delete(key); }
    this.P.FPDFPage_Delete(d.doc, index);
    d.keys.splice(index, 1);
    return tmp;
  }
  restorePage(docId: number, key: number, at: number, tmp: number) {
    const d = this.D(docId);
    const ip = this.malloc(4); this.M.HEAP32[ip >> 2] = 0;
    this.P.FPDF_ImportPagesByIndex(d.doc, tmp, ip, 1, at); this.free(ip);
    d.keys.splice(at, 0, key);
    d.gen.set(key, this.gen(d, key) + 1);
    this.pageByKey(d, key).dirty = true;
  }
  movePage(docId: number, key: number, to: number) {
    const d = this.D(docId);
    const from = d.keys.indexOf(key);
    if (from === to) return;
    for (const pc of d.pages.values()) this.P.FPDFPage_GenerateContent(pc.page);
    const ip = this.malloc(4); this.M.HEAP32[ip >> 2] = from;
    this.P.FPDF_MovePages(d.doc, ip, 1, to); this.free(ip);
    d.keys.splice(from, 1); d.keys.splice(to, 0, key);
  }
  /** 다른 PDF의 쪽을 끼워 넣는다 */
  importPdf(docId: number, bytes: Uint8Array, password: string, at: number): { keys?: number[]; error?: string } {
    const d = this.D(docId);
    const buf = this.put(bytes);
    const src = this.P.FPDF_LoadMemDocument64(buf, bytes.length, password);
    if (!src) { const e = this.P.FPDF_GetLastError(); this.free(buf); return { error: e === 4 ? 'password' : 'format' }; }
    const n = this.P.FPDF_GetPageCount(src);
    this.P.FPDF_ImportPagesByIndex(d.doc, src, 0, 0, at);
    this.P.FPDF_CloseDocument(src); this.free(buf);
    const keys = Array.from({ length: n }, () => d.nextKey++);
    d.keys.splice(at, 0, ...keys);
    return { keys };
  }
  removePages(docId: number, keys: number[]) {
    const d = this.D(docId);
    for (const key of keys) {
      const i = d.keys.indexOf(key); if (i < 0) continue;
      const pc = d.pages.get(key); if (pc) { this.closePage(pc); d.pages.delete(key); }
      this.P.FPDFPage_Delete(d.doc, i); d.keys.splice(i, 1);
    }
  }
  /** 고른 쪽만 새 PDF로 */
  extract(docId: number, indices: number[]) {
    const d = this.D(docId);
    for (const pc of d.pages.values()) this.P.FPDFPage_GenerateContent(pc.page);
    const out = this.P.FPDF_CreateNewDocument();
    const ip = this.malloc(indices.length * 4); this.M.HEAP32.set(indices, ip >> 2);
    this.P.FPDF_ImportPagesByIndex(out, d.doc, ip, indices.length, 0); this.free(ip);
    const bytes = this.saveDoc(out);
    this.P.FPDF_CloseDocument(out);
    return bytes;
  }

  /* ───────────── 이미지 → 쪽 ───────────── */
  /** 이미지 한 장을 새 쪽으로. mode 'a4': A4 안에 여백 두고 맞춤 / 'image': 이미지 크기 그대로(150dpi 기준) */
  addImagePage(docId: number, at: number, spec: { bytes: Uint8Array; kind: 'jpg' | 'png'; w: number; h: number }, mode: 'a4' | 'image' = 'a4') {
    const d = this.D(docId);
    let pw: number, ph: number, iw: number, ih: number;
    if (mode === 'image') { pw = iw = Math.max(72, spec.w * 72 / 150); ph = ih = Math.max(72, spec.h * 72 / 150); }
    else {
      [pw, ph] = spec.w > spec.h ? [841.89, 595.28] : [595.28, 841.89];
      const k = Math.min((pw - 48) / spec.w, (ph - 48) / spec.h);
      iw = spec.w * k; ih = spec.h * k;
    }
    at = Math.max(0, Math.min(at, d.keys.length));
    const page = this.P.FPDFPage_New(d.doc, at, pw, ph);
    const o = this.P.FPDFPageObj_NewImageObj(d.doc);
    const p = this.put(spec.bytes);
    const ok = spec.kind === 'jpg' ? this.P.EPDFImageObj_SetJpeg(page, 0, o, p, spec.bytes.length) : this.P.EPDFImageObj_SetPng(page, 0, o, p, spec.bytes.length);
    this.free(p);
    if (!ok) { this.P.FPDFPageObj_Destroy(o); this.P.FPDF_ClosePage(page); this.P.FPDFPage_Delete(d.doc, at); throw new Error('이미지를 읽지 못했습니다'); }
    this.setMatrix(o, [iw, 0, 0, ih, (pw - iw) / 2, (ph - ih) / 2]);
    this.P.FPDFPage_InsertObject(page, o);
    this.P.FPDFPage_GenerateContent(page);
    const key = d.nextKey++;
    d.keys.splice(at, 0, key);
    const pc: PageCtx = { key, page, text: 0, dirty: true, used: performance.now(), ...this.geometry(page) };
    if (d.form) { this.P.FORM_OnAfterLoadPage(page, d.form.handle); pc.form = d.form.handle; }
    d.pages.set(key, pc);
    return key;
  }

  /* ───────────── 용량 줄이기 ───────────── */
  /**
   * 사본을 만들어 그 안의 큰 그림을 낮은 해상도 JPEG로 바꾼 뒤 그 바이트를 돌려준다. 원본 문서는 건드리지 않는다.
   * encode: RGBA → JPEG (워커의 OffscreenCanvas 등)
   */
  async compressCopy(docId: number, opts: { dpi: number; quality: number }, encode: (rgba: Uint8ClampedArray, w: number, h: number, ow: number, oh: number, q: number) => Promise<Uint8Array>, progress?: (done: number, total: number) => void) {
    const src = this.D(docId);
    const bytes = this.save(docId);
    const r = this.open(bytes, src.password); if (!r.docId) throw new Error('사본을 만들지 못했습니다');
    const id = r.docId, d = this.D(id);
    try {
      type Cand = { key: number; o: number; sig: string; raw: number; rect: number[] };
      const cands: Cand[] = []; const count = new Map<string, number>();
      const sp = this.malloc(8);
      for (const key of d.keys) {
        const pc = this.pageByKey(d, key); pc.dirty = true;
        this.walk(pc, (o, t, fm) => {
          if (t !== OBJ_IMAGE || fm) return; // 양식 안 그림은 건드리지 않는다
          const raw = this.P.FPDFImageObj_GetImageDataRaw(o, 0, 0);
          this.P.FPDFImageObj_GetImagePixelSize(o, sp, sp + 4);
          const [pw, ph] = this.u32(sp, 2);
          let b = this.objBounds(o); if (!b) return;
          if (fm) b = this.mapBounds(b, fm);
          const sig = `${raw}:${pw}x${ph}`;
          count.set(sig, (count.get(sig) || 0) + 1);
          cands.push({ key, o, sig, raw, rect: [pw, ph, b[2] - b[0], b[3] - b[1]] });
        });
      }
      this.free(sp);
      let changed = 0, done = 0;
      for (const c of cands) {
        progress?.(++done, cands.length);
        if (count.get(c.sig)! > 1 || c.raw < 24 * 1024) continue; // 여러 번 쓰인 그림(로고 등)과 작은 그림은 그대로
        const [pw, ph, wpt, hpt] = c.rect;
        if (!pw || !ph || wpt <= 0 || hpt <= 0) continue;
        const filters = Array.from({ length: this.P.FPDFImageObj_GetImageFilterCount(c.o) }, (_, i) => { const n = this.P.FPDFImageObj_GetImageFilter(c.o, i, 0, 0); const b = this.malloc(n); this.P.FPDFImageObj_GetImageFilter(c.o, i, b, n); const s = this.M.UTF8ToString(b); this.free(b); return s; });
        if (filters.some(f => /JBIG2|CCITT/.test(f))) continue; // 흑백 스캔 압축은 이미 작다
        if (this.P.FPDFPageObj_HasTransparency(c.o)) continue;
        const dpi = Math.max(pw / (wpt / 72), ph / (hpt / 72));
        const k = Math.min(1, opts.dpi / dpi);
        if (k > 0.92 && filters.includes('DCTDecode') && opts.quality >= 0.8) continue;
        const bm = this.P.FPDFImageObj_GetBitmap(c.o); if (!bm) continue;
        const fmt = this.P.FPDFBitmap_GetFormat(bm), w = this.P.FPDFBitmap_GetWidth(bm), h = this.P.FPDFBitmap_GetHeight(bm), stride = this.P.FPDFBitmap_GetStride(bm), ptr = this.P.FPDFBitmap_GetBuffer(bm);
        if (fmt === 1 && filters.length === 0 && w * h < 1) { this.P.FPDFBitmap_Destroy(bm); continue; }
        const rgba = new Uint8ClampedArray(w * h * 4), H8 = this.M.HEAPU8;
        for (let y = 0; y < h; y++) {
          const row = ptr + y * stride;
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (fmt === 1) { const g = H8[row + x]; rgba[o] = rgba[o + 1] = rgba[o + 2] = g; }
            else { const bpp = fmt === 2 ? 3 : 4, s = row + x * bpp; rgba[o] = H8[s + 2]; rgba[o + 1] = H8[s + 1]; rgba[o + 2] = H8[s]; }
            rgba[o + 3] = 255;
          }
        }
        this.P.FPDFBitmap_Destroy(bm);
        const ow = Math.max(1, Math.round(w * k)), oh = Math.max(1, Math.round(h * k));
        const jpg = await encode(rgba, w, h, ow, oh, opts.quality);
        if (jpg.length > c.raw * 0.9) continue;
        const pc = this.pageByKey(d, c.key);
        const p = this.put(jpg);
        if (this.P.EPDFImageObj_SetJpeg(pc.page, 0, c.o, p, jpg.length)) changed++;
        this.free(p);
        if (done % 3 === 0) await yieldNow();
      }
      for (const pc of d.pages.values()) this.P.FPDFPage_GenerateContent(pc.page);
      const out = this.saveDoc(d.doc);
      return { bytes: out, before: bytes.length, after: out.length, images: changed, total: cands.length };
    } finally { this.close(id); }
  }

  /* ───────────── 보안 / 저장 ───────────── */
  setPassword(docId: number, user: string, owner: string) {
    const d = this.D(docId);
    return this.P.EPDF_SetEncryption(d.doc, user, owner || user, -1);
  }
  removePassword(docId: number) { return this.P.EPDF_RemoveEncryption(this.D(docId).doc); }
  save(docId: number): Uint8Array {
    const d = this.D(docId);
    for (const [key, ids] of d.removedAnnots) {
      if (!ids.size || !d.keys.includes(key)) continue;
      const pc = this.pageByKey(d, key);
      for (const id of ids) this.P.EPDFPage_RemoveAnnotByObjectNumber(pc.page, id);
      ids.clear(); pc.dirty = true;
    }
    for (const pc of d.pages.values()) if (pc.dirty) this.P.FPDFPage_GenerateContent(pc.page);
    return this.saveDoc(d.doc);
  }
  private saveDoc(doc: number) {
    const w = this.P.PDFiumExt_OpenFileWriter();
    this.P.PDFiumExt_SaveAsCopy(doc, w);
    const n = this.P.PDFiumExt_GetFileWriterSize(w);
    const p = this.malloc(n);
    this.P.PDFiumExt_GetFileWriterData(w, p, n);
    const out = this.M.HEAPU8.slice(p, p + n);
    this.free(p); this.P.PDFiumExt_CloseFileWriter(w);
    return out as Uint8Array;
  }
}

export interface AnnotSpec {
  subtype: number;
  color?: string; fill?: string; width?: number; opacity?: number; contents?: string; author?: string;
  quads?: Rect[]; ink?: [number, number][][]; rect?: Rect; point?: { x: number; y: number };
}
export interface TableSpec {
  x: number; y: number; cols: number[]; rows: number[]; cells: string[][];
  fontSize: number; color: string; border: string; borderWidth: number; padding: number;
  headerFill?: string; headerBold?: boolean; align?: ('left' | 'center' | 'right')[];
}
export interface FieldInfo {
  id: number; page: number; type: 'text' | 'checkbox' | 'radio' | 'combo' | 'list'; name: string; value: string; rect: Rect;
  readOnly: boolean; required: boolean; multiline: boolean; password: boolean; multiSelect: boolean; editable: boolean;
  checked: boolean; exportValue: string; options: { label: string; selected: boolean }[]; fontSize: number;
}
export interface ObjChange { key: number; gen: number; removed: { h: number; idx: number }[]; added: { h: number; idx: number }[]; substituted: boolean; also?: number[] }
