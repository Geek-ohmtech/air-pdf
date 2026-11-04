/// <reference lib="webworker" />
/** PDFium 워커: 화면(메인 스레드)을 막지 않도록 모든 PDF 작업은 여기서 한다 */
import { init } from '@embedpdf/pdfium';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { PdfEngine } from './core.ts';
import { FontKit } from './fonts.ts';

let engine: PdfEngine | null = null;
let base = '';
const vendor = (p: string) => new URL('vendor/' + p, base).href;
const FONT = 'fonts/NotoSansKR-Regular.ttf';

// 워커가 뜨자마자 엔진(WebAssembly)을 받으면서 바로 컴파일해 둔다 (받기와 컴파일이 겹쳐서 빨라진다)
const WASM = new URL(wasmUrl, self.location.href).href;
const compiled: Promise<WebAssembly.Module> = (async () => {
  try { return await WebAssembly.compileStreaming(fetch(WASM)); }
  catch { return WebAssembly.compile(await (await fetch(WASM)).arrayBuffer()); } // 서버가 wasm 형식을 안 알려 줄 때
})();

async function boot(b: string) {
  base = b;
  const mod = await compiled;
  const P = await init({
    instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(mod, imports).then(inst => done(inst, mod));
      return {};
    },
  } as any);
  let fontBytes: Uint8Array | null = null;
  const kit = new FontKit({
    font: async () => fontBytes || (fontBytes = new Uint8Array(await (await fetch(vendor(FONT))).arrayBuffer())),
    fontSync: () => {
      if (fontBytes) return fontBytes;
      try {
        const x = new XMLHttpRequest(); x.open('GET', vendor(FONT), false); x.responseType = 'arraybuffer'; x.send();
        if (x.status === 200 || x.status === 0) fontBytes = new Uint8Array(x.response);
      } catch { /* 대체 글꼴 없이 계속 */ }
      return fontBytes;
    },
    hbWasm: async () => (await fetch(vendor('harfbuzz-subset.wasm'))).arrayBuffer(),
    fetchFont: async (file: string) => { const r = await fetch(vendor('fonts/' + file)); if (!r.ok) throw new Error('글꼴 파일을 찾지 못했습니다: ' + file); return new Uint8Array(await r.arrayBuffer()); },
  });
  engine = new PdfEngine(P, kit);
  engine.onEvict = (docId, key) => (self as any).postMessage({ event: 'evict', docId, key });
  // 글꼴을 넣지 않은 한글 PDF가 많아서, 대체 글꼴은 엔진이 준비된 뒤 미리 읽어 둔다 (첫 쪽 그리기가 멈추지 않게)
  setTimeout(() => { if (!fontBytes) fetch(vendor(FONT)).then(r => r.ok ? r.arrayBuffer() : null).then(b => { if (b && !fontBytes) fontBytes = new Uint8Array(b); }).catch(() => {}); }, 150);
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, method, args } = ev.data;
  try {
    if (method === 'boot') { await boot(args[0]); return post(id, true); }
    if (method === 'setAuthor') { engine!.author = args[0] || '사용자'; return post(id, true); }
    const E: any = engine;
    if (!E) throw new Error('엔진이 아직 준비되지 않았습니다');
    if (method === 'render') {
      const r = E.render(...args);
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(new ImageData(r.data, r.width, r.height));
        return post(id, { ...r, data: null, bitmap: bmp }, [bmp]);
      }
      return post(id, r, [r.data.buffer]);
    }
    if (method === 'search') {
      const res = await E.search(args[0], args[1], args[2], (hits: any, page: number, total: number) =>
        (self as any).postMessage({ id, progress: { hits, page, total } }));
      return post(id, res);
    }
    if (method === 'compressCopy') {
      const encode = async (rgba: Uint8ClampedArray, w: number, h: number, ow: number, oh: number, q: number) => {
        const src = await createImageBitmap(new ImageData(rgba as any, w, h), { resizeWidth: ow, resizeHeight: oh, resizeQuality: 'high' });
        const c = new OffscreenCanvas(ow, oh); c.getContext('2d')!.drawImage(src, 0, 0); src.close();
        return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: q })).arrayBuffer());
      };
      const res = await E.compressCopy(args[0], args[1], encode, (done: number, total: number) => (self as any).postMessage({ id, progress: { done, total } }));
      return post(id, res, [res.bytes.buffer]);
    }
    if (typeof E[method] !== 'function') throw new Error('알 수 없는 작업: ' + method);
    const out = await E[method](...args);
    const tr: Transferable[] = [];
    if (out instanceof Uint8Array) tr.push(out.buffer);
    else if (out && out.boxes instanceof Float32Array) tr.push(out.boxes.buffer);
    post(id, out, tr);
  } catch (e: any) {
    (self as any).postMessage({ id, error: e?.message || String(e) });
  }
};
function post(id: number, result: any, transfer: Transferable[] = []) { (self as any).postMessage({ id, result }, transfer); }
