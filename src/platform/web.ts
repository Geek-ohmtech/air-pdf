import { KINDS, type FileKind, type OpenedFile, type Platform, type SavedTarget } from './types.ts';

const W: any = window;
const webFonts = new Map<string, any>();
const pdfTypes = [{ description: 'PDF 문서', accept: { 'application/pdf': ['.pdf'] } }];

function inputPick(multiple: boolean, accept = 'application/pdf,.pdf'): Promise<File[]> {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res([...(i.files || [])]);
    i.addEventListener('cancel', () => res([]));
    i.click();
  });
}
export function createWeb(): Platform {
  return {
    kind: 'web',
    // 시험용: 설치판 제목 표시줄 모양을 웹에서 보려고 (window.__fakeWin)
    win: (window as any).__fakeWin ? { minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onResized() {} } : undefined,
    async pickPdfs(multiple = false) {
      if (W.showOpenFilePicker) {
        try {
          const hs = await W.showOpenFilePicker({ types: pdfTypes, multiple });
          return Promise.all(hs.map(async (h: any) => { const f = await h.getFile(); return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), handle: h }; }));
        } catch (e: any) { if (e?.name === 'AbortError') return []; }
      }
      const files = await inputPick(multiple);
      return Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    },
    async saveInPlace(file, bytes) {
      if (!file.handle?.createWritable) return false;
      try {
        if ((await file.handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await file.handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') return false;
        const w = await file.handle.createWritable(); await w.write(bytes); await w.close(); return true;
      } catch { return false; }
    },
    pickImages: () => inputPick(true, 'image/png,image/jpeg,image/webp,image/gif,image/bmp'),
    async listFonts() {
      // 크롬·엣지: 브라우저가 허락을 물어본다
      if (!W.queryLocalFonts) return [];
      const fonts: any[] = await W.queryLocalFonts();
      const out: { family: string; path: string; index: number; korean: boolean }[] = [];
      const seen = new Set<string>();
      for (const f of fonts) {
        if (!/regular|normal|medium|^$/i.test(f.style) || seen.has(f.family)) continue;
        seen.add(f.family); webFonts.set(f.postscriptName, f);
        out.push({ family: f.family, path: f.postscriptName, index: 0, korean: /[가-힣]/.test(f.family) || /gothic|myeongjo|batang|gulim|dotum|malgun|nanum|noto sans (kr|cjk)/i.test(f.family) });
      }
      return out;
    },
    async fontBytes(path: string) { const f = webFonts.get(path); if (!f) throw new Error('글꼴을 읽을 수 없습니다'); return new Uint8Array(await (await f.blob()).arrayBuffer()); },
    async saveAs(name, bytes, kind: FileKind = 'pdf'): Promise<SavedTarget | null> {
      const K = KINDS[kind];
      // claude.ai 아티팩트 안에서는 그쪽 저장 창을 쓴다
      const dl = W.claude?.use ? await W.claude.use('downloads').catch(() => null) : null;
      if (dl) {
        try { await dl.save({ filename: name, data: new Blob([bytes as BlobPart], { type: K.mime }) }); return { name }; }
        catch (e: any) { if (e?.code === 'declined') return null; throw new Error(e?.message || '저장할 수 없습니다'); }
      }
      if (W.showSaveFilePicker) {
        try {
          const h = await W.showSaveFilePicker({ suggestedName: name, types: [{ description: K.label, accept: { [K.mime]: K.ext.map(e => '.' + e) } }] });
          const w = await h.createWritable(); await w.write(bytes); await w.close();
          return { name: h.name, handle: h };
        } catch (e: any) { if (e?.name === 'AbortError') return null; }
      }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: K.mime }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return kind === 'pdf' ? { name } : { name };
    },
    async initialFiles() {
      // 웹에서 ?file=주소 로 열기 (같은 출처)
      const us = new URL(location.href).searchParams.getAll('file');
      const out: OpenedFile[] = [];
      for (const u of us) { try { const r = await fetch(u); if (r.ok) out.push({ name: decodeURIComponent(u.split('/').pop() || '문서.pdf'), bytes: new Uint8Array(await r.arrayBuffer()) }); } catch { /* 건너뜀 */ } }
      return { mode: null, files: out };
    },
    onExternalOpen() { /* 웹: 끌어다 놓기는 화면에서 처리 */ },
    async readPath(): Promise<OpenedFile> { throw new Error('웹에서는 경로로 열 수 없습니다'); },
    recent: () => [], addRecent() {}, setRecent() {},
    setTitle(t) { document.title = t; },
    openUrl(url) { window.open(url, '_blank', 'noopener'); },
    onCloseRequest() {
      // 웹: 브라우저가 띄우는 "페이지를 나가시겠습니까?" 확인만 쓸 수 있다
      window.addEventListener('beforeunload', e => { if ((window as any).__dirty) { e.preventDefault(); e.returnValue = ''; } });
    },
    async toggleFullscreen() { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); },
    onFullscreen(cb) { document.addEventListener('fullscreenchange', () => cb(!!document.fullscreenElement)); },
  };
}
