/** 문서 도구: 이미지 → PDF, PDF → 이미지, 용량 줄이기 (보기·편집 모드 모두에서 메뉴로 쓴다) */
import type { App } from './app.ts';
import { busy, dialog, h, toast } from './ui/dom.ts';
import { makeZip } from './ui/zip.ts';

export interface ImageSpec { bytes: Uint8Array; kind: 'jpg' | 'png'; w: number; h: number; name: string }

/** JPEG의 EXIF 방향값 (1 = 그대로) */
function exifOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return 0;
    const mk = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
    if (mk === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10, le = b[t] === 0x49;
      const u16 = (o: number) => le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
      const u32 = (o: number) => le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8); }
      return 1;
    }
    if (mk === 0xda) return 1;
    p += 2 + len;
  }
  return 1;
}
/** 이미지 파일 → PDF에 넣을 자료. 원본 JPEG/PNG는 다시 압축하지 않고 그대로 넣는다 */
export async function loadImage(file: Blob, name = '이미지'): Promise<ImageSpec> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8, png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const w = bmp.width, hgt = bmp.height;
  if ((jpg && exifOrientation(bytes) <= 1) || png) { bmp.close(); return { bytes, kind: jpg ? 'jpg' : 'png', w, h: hgt, name }; }
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  c.getContext('2d')!.drawImage(bmp, 0, 0); bmp.close();
  const type = jpg ? 'image/jpeg' : 'image/png';
  const out: Blob = await new Promise(r => c.toBlob(b => r(b!), type, 0.92));
  return { bytes: new Uint8Array(await out.arrayBuffer()), kind: jpg ? 'jpg' : 'png', w, h: hgt, name };
}

async function askPageMode(count: number) {
  const sel = h('select', { class: 'field' }, h('option', { value: 'a4' }, 'A4에 맞추기 (가로·세로 자동, 여백 있음)'), h('option', { value: 'image' }, '이미지 크기 그대로'));
  const r = await dialog({ title: `이미지 ${count}장으로 PDF 만들기`, body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '쪽 크기'), sel, h('p', { class: 'hint' }, '이미지마다 한 쪽이 됩니다. 사진(JPEG)은 다시 압축하지 않아 화질이 그대로입니다.')), buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }], collect: () => sel.value });
  return r?.value ? (r.data as 'a4' | 'image') : null;
}

/** 이미지 여러 장 → 새 PDF(새 탭) */
export async function imagesToPdf(app: App, files?: File[]) {
  if (!files) files = await app.platform.pickImages();
  if (!files.length) return;
  const mode = await askPageMode(files.length); if (!mode) return;
  const b = busy('PDF를 만드는 중…');
  try {
    const docId = await app.engine.call<number>('createDoc');
    let n = 0;
    for (const f of files) {
      b.set(`이미지 넣는 중… ${++n}/${files.length}`);
      try { const s = await loadImage(f, f.name); await app.engine.call('addImagePage', [docId, n - 1, s, mode]); }
      catch { toast(`“${f.name}”은 읽을 수 없는 이미지라 건너뛰었습니다.`); n--; }
    }
    b.done();
    if (!n) { app.engine.call('close', [docId]); return; }
    const base = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : `이미지 ${n}장`;
    await app.addTab(docId, base + '.pdf', true);
    toast(`${n}쪽짜리 PDF를 만들었습니다. Ctrl+S로 저장하세요.`);
  } catch (e: any) { b.done(); toast('PDF를 만들지 못했습니다: ' + e.message); }
}

/** 편집 모드: 이미지를 쪽으로 끼워 넣기 (되돌리기 지원은 편집기에서) */
export async function insertImagePages(app: App, at: number, files: File[]) {
  const mode = await askPageMode(files.length); if (!mode) return [];
  const keys: number[] = [];
  const b = busy('쪽을 넣는 중…');
  try {
    for (const f of files) { const s = await loadImage(f, f.name); keys.push(await app.engine.call<number>('addImagePage', [app.doc!.id, at + keys.length, s, mode])); }
  } catch (e: any) { toast('이미지를 넣지 못했습니다: ' + e.message); }
  finally { b.done(); }
  return keys;
}

/** PDF 쪽 → PNG/JPG (여러 쪽이면 ZIP 하나로) */
export async function exportImages(app: App) {
  const d = app.doc; if (!d) return;
  const n = d.info.pageCount, cur = app.view.current;
  const picked = app.mode === 'edit' ? app.sidebar.selected.size : 0;
  const range = h('select', { class: 'field' }, h('option', { value: 'cur' }, `현재 쪽 (${cur + 1}쪽)`), h('option', { value: 'all' }, `모든 쪽 (${n}쪽)`), picked ? h('option', { value: 'picked' }, `고른 쪽 (${picked}쪽)`) : null, h('option', { value: 'custom' }, '쪽 번호 지정'));
  const custom = h('input', { class: 'field', placeholder: '예: 1-3, 5, 8', hidden: true });
  range.addEventListener('change', () => { custom.hidden = range.value !== 'custom'; if (!custom.hidden) custom.focus(); });
  const fmt = h('select', { class: 'field' }, h('option', { value: 'png' }, 'PNG (글자가 선명)'), h('option', { value: 'jpg' }, 'JPG (용량이 작음)'));
  const dpi = h('select', { class: 'field' }, h('option', { value: '96' }, '96 dpi (화면용)'), h('option', { value: '150', selected: '' }, '150 dpi (보통)'), h('option', { value: '300' }, '300 dpi (인쇄용)'));
  const r = await dialog({ title: '이미지로 내보내기', body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '범위'), range, custom, h('label', { class: 'lbl' }, '형식'), fmt, h('label', { class: 'lbl' }, '해상도'), dpi, h('p', { class: 'hint' }, '여러 쪽은 ZIP 파일 하나로 묶습니다.')), buttons: [{ label: '취소', value: false }, { label: '내보내기', value: true, primary: true }], collect: () => ({ range: range.value, custom: custom.value, fmt: fmt.value, dpi: +dpi.value }) });
  if (!r?.value) return;
  const o = r.data;
  let pages: number[] = [];
  if (o.range === 'cur') pages = [cur];
  else if (o.range === 'all') pages = [...Array(n).keys()];
  else if (o.range === 'picked') pages = app.view.pages.map((p, i) => app.sidebar.selected.has(p.key) ? i : -1).filter(i => i >= 0);
  else {
    for (const part of String(o.custom).split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part); if (!m) continue;
      const a = +m[1], z = m[2] ? +m[2] : a;
      for (let i = Math.min(a, z); i <= Math.max(a, z); i++) if (i >= 1 && i <= n) pages.push(i - 1);
    }
    pages = [...new Set(pages)];
    if (!pages.length) { toast('쪽 번호를 알아볼 수 없습니다. 예: 1-3, 5'); return; }
  }
  const b = busy('그림으로 바꾸는 중…');
  const files: { name: string; data: Uint8Array }[] = [];
  const base = d.name.replace(/\.pdf$/i, '');
  try {
    for (const i of pages) {
      b.set(`그림으로 바꾸는 중… ${files.length + 1}/${pages.length}`);
      const res: any = await app.engine.call('render', [d.id, i, o.dpi / 72, undefined, true, false]);
      const c = document.createElement('canvas'); c.width = res.width; c.height = res.height;
      const g = c.getContext('2d')!;
      if (res.bitmap) { g.drawImage(res.bitmap, 0, 0); res.bitmap.close(); } else g.putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
      const blob: Blob = await new Promise(rr => c.toBlob(bb => rr(bb!), o.fmt === 'png' ? 'image/png' : 'image/jpeg', 0.9));
      files.push({ name: `${base}_${String(i + 1).padStart(String(n).length, '0')}쪽.${o.fmt}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
  } catch (e: any) { b.done(); toast('내보내지 못했습니다: ' + e.message); return; }
  b.done();
  const one = files.length === 1;
  const t = await app.platform.saveAs(one ? files[0].name : `${base}_그림${files.length}장.zip`, one ? files[0].data : makeZip(files), one ? o.fmt : 'zip');
  if (t) toast(one ? `“${t.name}”로 저장했습니다.` : `${files.length}장을 “${t.name}”로 묶어 저장했습니다.`);
}

/** 용량 줄이기: 사본을 만들어 큰 그림만 낮은 해상도로. 원본은 그대로 둔다 */
export async function compressPdf(app: App) {
  const d = app.doc; if (!d) return;
  const lvl = h('select', { class: 'field' },
    h('option', { value: '96,0.6' }, '많이 줄이기 — 화면·메일용 (96dpi)'),
    h('option', { value: '150,0.72', selected: '' }, '보통 — 대부분 이걸로 충분 (150dpi)'),
    h('option', { value: '220,0.82' }, '조금만 — 인쇄용 (220dpi)'));
  const r = await dialog({ title: 'PDF 용량 줄이기', body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '정도'), lvl, h('p', { class: 'hint' }, '사진·스캔 그림의 해상도를 낮춰 JPEG로 다시 저장합니다. 글자·선·표는 그대로 벡터로 남아 흐려지지 않습니다. 지금 문서는 바꾸지 않고 줄인 사본을 만듭니다.')), buttons: [{ label: '취소', value: false }, { label: '줄이기', value: true, primary: true }], collect: () => lvl.value });
  if (!r?.value) return;
  const [dpi, q] = String(r.data).split(',').map(Number);
  const b = busy('그림을 줄이는 중…');
  let res: { bytes: Uint8Array; before: number; after: number; images: number; total: number };
  try {
    res = await app.engine.call('compressCopy', [d.id, { dpi, quality: q }], { progress: (p: any) => b.set(`그림을 줄이는 중… ${p.done}/${p.total}`) });
  } catch (e: any) { b.done(); toast('용량을 줄이지 못했습니다: ' + e.message); return; }
  b.done();
  const mb = (n: number) => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + 'KB' : (n / 1048576).toFixed(2) + 'MB';
  const pct = Math.round((1 - res.after / res.before) * 100);
  if (res.after >= res.before * 0.97) {
    await dialog({ title: 'PDF 용량 줄이기', body: `더 줄일 그림이 없습니다 (${mb(res.before)}). 그림이 이미 작거나 글자 위주인 문서입니다.`, buttons: [{ label: '확인', value: true, primary: true }] });
    return;
  }
  const choice = await dialog({ title: 'PDF 용량 줄이기', body: h('div', { class: 'form' }, h('p', { class: 'big-num' }, `${mb(res.before)} → ${mb(res.after)}`), h('p', {}, `${pct}% 줄었습니다. 그림 ${res.images}개를 다시 저장했습니다.`)), buttons: [{ label: '닫기', value: 'close' }, { label: '새 탭으로 열어 보기', value: 'tab' }, { label: '줄인 파일 저장…', value: 'save', primary: true }] });
  if (!choice || choice.value === 'close') return;
  const name = d.name.replace(/\.pdf$/i, '') + '_압축.pdf';
  if (choice.value === 'save') { const t = await app.platform.saveAs(name, res.bytes, 'pdf'); if (t) toast(`“${t.name}”로 저장했습니다 (${mb(res.after)}).`); }
  else await app.openFiles([{ name, bytes: res.bytes }], true);
}
