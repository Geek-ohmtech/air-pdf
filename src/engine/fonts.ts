/**
 * 글꼴 도우미
 * 1) 부분 글꼴(subset): 새로 쓰는 글자만 담은 작은 TrueType을 만들어 PDF에 넣는다(HarfBuzz hb-subset).
 *    그래서 글자를 넣어도 파일이 수 KB만 커지고, 저장본에서 글자가 검색·복사된다.
 * 2) 대체 글꼴: 글꼴이 내장되지 않은 한글 PDF(바탕/굴림/HY… 등)를 열 때 PDFium이 쓸 글꼴을 공급한다.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { TTF } from './ttf.ts';

export interface FontSource {
  /** 기본 글꼴(Noto Sans KR) 바이트, 비동기 */
  font(): Promise<Uint8Array>;
  /** 같은 글꼴, 동기(PDFium 콜백 안에서 필요). 워커에서는 동기 XHR로 받는다 */
  fontSync(): Uint8Array | null;
  hbWasm(): Promise<ArrayBuffer>;
  /** 내장 글꼴 파일 받기 (vendor/fonts/…) */
  fetchFont?(file: string): Promise<Uint8Array>;
}

/** 앱에 함께 들어 있는 글꼴 (모두 SIL Open Font License) */
export const BUILTIN_FONTS: { id: string; name: string; file: string; css: string }[] = [
  { id: 'noto-sans', name: '본고딕 (Noto Sans KR)', file: 'NotoSansKR-Regular.ttf', css: 'AirNotoSans' },
  { id: 'nanum-gothic', name: '나눔고딕', file: 'NanumGothic-Regular.ttf', css: 'AirNanumGothic' },
  { id: 'nanum-myeongjo', name: '나눔명조', file: 'NanumMyeongjo-Regular.ttf', css: 'AirNanumMyeongjo' },
  { id: 'nanum-pen', name: '나눔손글씨 펜', file: 'NanumPenScript-Regular.ttf', css: 'AirNanumPen' },
];

const CJK_CHARSETS = new Set([128, 129, 130, 134, 136]);
const KOREAN_FACE = /batang|gulim|dotum|gungsuh|malgun|myeongjo|gothic|hy|hanyang|hancom|hcr|함초롬|한컴|바탕|굴림|돋움|궁서|맑은|nanum|나눔|명조|고딕|ms-?mincho|ms-?gothic|simsun|simhei|mingliu|kozmin|kozgo|ryumin|stsong|msung|hysmyeongjo|hygothic|adobe ?myungjo|adobe ?gothic/i;

interface FontEntry { bytes: Uint8Array | null; index: number; file?: string; ttf?: TTF }

export class FontKit {
  private src: FontSource;
  private full: Uint8Array | null = null;
  private hb: any = null;
  private fallbackOn = false;
  private fonts = new Map<string, FontEntry>();

  constructor(src: FontSource) {
    this.src = src;
    for (const f of BUILTIN_FONTS) this.fonts.set(f.id, { bytes: null, index: 0, file: f.file });
  }
  /** 컴퓨터에 설치된 글꼴 등록 (TTC면 index로 얼굴 고르기) */
  register(id: string, bytes: Uint8Array, index = 0) { this.fonts.set(id, { bytes, index }); }
  has(id: string) { const f = this.fonts.get(id); return !!f && (!!f.bytes || !!f.file); }

  private async bytesOf(id: string): Promise<FontEntry> {
    const f = this.fonts.get(id) || this.fonts.get('noto-sans')!;
    if (!f.bytes) {
      if (f.file === 'NotoSansKR-Regular.ttf' || !this.src.fetchFont) f.bytes = this.full || (this.full = await this.src.font());
      else f.bytes = await this.src.fetchFont(f.file!);
    }
    return f;
  }
  private async ensureHb() {
    if (!this.hb) { const { instance } = await WebAssembly.instantiate(await this.src.hbWasm()); this.hb = instance.exports; }
  }

  /** 윤곽선·글자 폭 해석기 */
  async outlines(id = 'noto-sans'): Promise<TTF> {
    const f = await this.bytesOf(id);
    if (!f.ttf) f.ttf = new TTF(f.bytes!, f.index);
    return f.ttf;
  }

  async subset(text: string, id = 'noto-sans'): Promise<Uint8Array> {
    await this.ensureHb();
    const fe = await this.bytesOf(id);
    const hb = this.hb, font = fe.bytes!;
    const heap = () => new Uint8Array(hb.memory.buffer);
    const fp = hb.malloc(font.length); heap().set(font, fp);
    const blob = hb.hb_blob_create(fp, font.length, 2, 0, 0);
    const face = hb.hb_face_create(blob, fe.index); hb.hb_blob_destroy(blob);
    const input = hb.hb_subset_input_create_or_fail();
    const uset = hb.hb_subset_input_unicode_set(input);
    for (const ch of text) hb.hb_set_add(uset, ch.codePointAt(0)!);
    hb.hb_set_add(uset, 0x20);
    const sub = hb.hb_subset_or_fail(face, input);
    hb.hb_subset_input_destroy(input);
    if (!sub) { hb.hb_face_destroy(face); hb.free(fp); throw new Error('부분 글꼴을 만들지 못했습니다'); }
    const rb = hb.hb_face_reference_blob(sub);
    const len = hb.hb_blob_get_length(rb), dp = hb.hb_blob_get_data(rb, 0);
    const out = heap().slice(dp, dp + len);
    hb.hb_blob_destroy(rb); hb.hb_face_destroy(sub); hb.hb_face_destroy(face); hb.free(fp);
    return out;
  }

  /** PDFium 시스템 글꼴 정보(FPDF_SYSFONTINFO)를 JS 콜백으로 채운다 */
  installFallback(P: WrappedPdfiumModule) {
    const M: any = P.pdfium;
    if (this.fallbackOn || typeof M.addFunction !== 'function') return;
    const size = 36, st = M.wasmExports.malloc(size);
    for (let i = 0; i < size; i += 4) M.setValue(st + i, 0, 'i32');
    const HANDLE = 7;
    let data: Uint8Array | null = null;
    const fns = [
      M.addFunction(() => {}, 'vi'),                                    // Release
      M.addFunction(() => {}, 'vii'),                                   // EnumFonts
      M.addFunction((_t: number, _w: number, _it: number, charset: number, _pf: number, faceP: number, exactP: number) => { // MapFont
        const face = faceP ? M.UTF8ToString(faceP) : '';
        if (!CJK_CHARSETS.has(charset) && !KOREAN_FACE.test(face)) return 0;
        if (exactP) M.setValue(exactP, 0, 'i32');
        return HANDLE;
      }, 'iiiiiiii'),
      M.addFunction((_t: number, faceP: number) => (faceP && KOREAN_FACE.test(M.UTF8ToString(faceP)) ? HANDLE : 0), 'iii'), // GetFont
      M.addFunction((_t: number, h: number, table: number, buf: number, bufSize: number) => {  // GetFontData
        if (h !== HANDLE || table !== 0) return 0;
        if (!data) data = this.full || this.src.fontSync();
        if (!data) return 0;
        if (buf && bufSize >= data.length) M.HEAPU8.set(data, buf);
        return data.length;
      }, 'iiiiii'),
      M.addFunction(() => 0, 'iiiii'),                                  // GetFaceName
      M.addFunction(() => 129, 'iii'),                                  // GetFontCharset
      M.addFunction(() => {}, 'vii'),                                   // DeleteFont
    ];
    M.setValue(st, 1, 'i32');
    fns.forEach((f, i) => M.setValue(st + 4 + i * 4, f, 'i32'));
    P.FPDF_SetSystemFontInfo(st);
    this.fallbackOn = true;
  }
}
