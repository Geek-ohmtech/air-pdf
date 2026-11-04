/** 문서 도구: 이미지 → PDF, PDF → 이미지, 용량 줄이기 (보기·편집 모드 모두에서 메뉴로 쓴다) */
import type { App } from './app.ts';
import type { OpenedFile } from './platform/types.ts';
import { busy, dialog, h, icon, promptBox, toast } from './ui/dom.ts';
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

type ImgPdfOpts = { mode: 'a4' | 'image'; correct: boolean; ocr: boolean };
/**
 * 이미지 → PDF 설정. 사진으로 찍은 문서라면 보정·글자 인식(OCR)을 함께 하자고 제안한다.
 * "다시 묻지 않기"를 고르면 그 선택을 기억하고, 설정에서 다시 켤 수 있다.
 */
async function askImagePdf(app: App, count: number, o: { ocr?: boolean; title?: string; ok?: string } = {}): Promise<ImgPdfOpts | null> {
  const P = app.prefs, def = P.scanDefault || { correct: true, ocr: true }, ask = P.scanSuggest !== false;
  const sel = h('select', { class: 'field' }, h('option', { value: 'a4' }, 'A4에 맞추기 (가로·세로 자동, 여백 있음)'), h('option', { value: 'image' }, '이미지 크기 그대로'));
  const cb = (on: boolean) => h('input', { type: 'checkbox', checked: on ? '' : undefined }) as HTMLInputElement;
  const corr = cb(def.correct), ocr = cb(o.ocr !== false && def.ocr), never = cb(false);
  const box = ask ? h('div', { class: 'suggest' },
    h('div', { class: 'suggest-h' }, '휴대폰으로 찍은 문서인가요?'),
    h('label', { class: 'chk' }, corr, h('span', {}, '문서 보정', h('small', {}, '종이 모서리에 맞춰 반듯하게 펴고, 기울기·그늘·대비를 바로잡습니다'))),
    o.ocr !== false ? h('label', { class: 'chk' }, ocr, h('span', {}, '글자 인식 (OCR)', h('small', {}, '찾기·복사·선택이 되도록 보이지 않는 글자를 얹습니다 (이 컴퓨터 안에서 처리)'))) : null,
    h('label', { class: 'chk never' }, never, h('span', {}, '다시 묻지 않기', h('small', {}, '지금 선택을 기억합니다. 설정에서 다시 켤 수 있습니다'))))
    : h('p', { class: 'hint' }, `문서 보정 ${def.correct ? '켬' : '끔'}${o.ocr !== false ? ` · 글자 인식 ${def.ocr ? '켬' : '끔'}` : ''} — 메뉴 ⋯ → 설정에서 바꿀 수 있습니다.`);
  const r = await dialog({ title: o.title || `이미지 ${count}장으로 PDF 만들기`, body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '페이지 크기'), sel, box, h('p', { class: 'hint' }, '이미지마다 한 페이지가 됩니다. 보정하지 않은 사진(JPEG)은 다시 압축하지 않아 화질이 그대로입니다.')),
    buttons: [{ label: '취소', value: false }, { label: o.ok || '만들기', value: true, primary: true }],
    collect: () => ({ mode: sel.value, correct: ask ? corr.checked : def.correct, ocr: o.ocr === false ? false : ask ? ocr.checked : def.ocr }) });
  if (!r?.value) return null;
  const v = r.data as ImgPdfOpts;
  if (ask && never.checked) { P.scanSuggest = false; P.scanDefault = { correct: v.correct, ocr: o.ocr === false ? def.ocr : v.ocr }; app.savePrefs(); }
  return v;
}
/** 보정을 고르면 보정 화면을 거쳐 파일을 바꾼다 (취소하면 null) */
async function maybeCorrect(files: File[], correct: boolean): Promise<File[] | null> {
  if (!correct) return files;
  const { scanDialog, fileToCanvas } = await import('./scan/ui.ts');
  const b = busy('사진을 불러오는 중…');
  const srcs: { name: string; canvas: HTMLCanvasElement }[] = [];
  try { for (const f of files) { try { srcs.push({ name: f.name, canvas: await fileToCanvas(f) }); } catch { toast(`“${f.name}”은 읽을 수 없는 이미지라 건너뜁니다.`); } } }
  finally { b.done(); }
  if (!srcs.length) return null;
  const out = await scanDialog(srcs);
  if (!out) return null;
  const { toBlob } = await import('./scan/scan.ts');
  const b2 = busy('보정한 그림을 저장하는 중…');
  try {
    return await Promise.all(out.map(async (c, i) => { const bl = await toBlob(c, 'color'); return new File([bl], srcs[i].name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }); }));
  } finally { b2.done(); }
}

/** 이미지 여러 장 → 새 PDF(새 탭). 사진이면 보정·OCR까지 */
export async function imagesToPdf(app: App, files?: File[]) {
  if (!files) files = await app.platform.pickImages();
  if (!files.length) return;
  const opt = await askImagePdf(app, files.length); if (!opt) return;
  const fixed = await maybeCorrect(files, opt.correct); if (!fixed) return;
  const b = busy('PDF를 만드는 중…');
  try {
    const docId = await app.engine.call<number>('createDoc');
    let n = 0;
    for (const f of fixed) {
      b.set(`이미지 넣는 중… ${++n}/${fixed.length}`);
      try { const s = await loadImage(f, f.name); await app.engine.call('addImagePage', [docId, n - 1, s, opt.mode]); }
      catch { toast(`“${f.name}”은 읽을 수 없는 이미지라 건너뛰었습니다.`); n--; }
    }
    if (!n) { b.done(); app.engine.call('close', [docId]); return; }
    let ocrMsg = '';
    if (opt.ocr) {
      const { ocrPages } = await import('./editor/ocr.ts');
      const keys = await app.engine.call<number[]>('keys', [docId]);
      const r = await ocrPages(app.engine, docId, keys.map((key, index) => ({ index, key })), { progress: m => b.set(m) });
      ocrMsg = r.words ? ` 글자 ${r.words}낱말을 인식해 찾기(Ctrl+F)가 됩니다.` : ' 인식한 글자가 없습니다.';
    }
    b.done();
    const base = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : `이미지 ${n}장`;
    await app.addTab(docId, base + '.pdf', true);
    toast(`${n}페이지 PDF를 만들었습니다.${ocrMsg} Ctrl+S로 저장하세요.`, 5000);
  } catch (e: any) { b.done(); toast('PDF를 만들지 못했습니다: ' + e.message); }
}

/** 편집 모드: 이미지를 페이지로 끼워 넣기 (되돌리기 지원은 편집기에서) */
export async function insertImagePages(app: App, at: number, files: File[]) {
  const opt = await askImagePdf(app, files.length, { ocr: false, title: `이미지 ${files.length}장을 페이지로 삽입`, ok: '삽입' }); if (!opt) return [];
  const fixed = await maybeCorrect(files, opt.correct); if (!fixed) return [];
  const keys: number[] = [];
  const b = busy('페이지를 넣는 중…');
  try {
    for (const f of fixed) { const s = await loadImage(f, f.name); keys.push(await app.engine.call<number>('addImagePage', [app.doc!.id, at + keys.length, s, opt.mode])); }
  } catch (e: any) { toast('이미지를 넣지 못했습니다: ' + e.message); }
  finally { b.done(); }
  return keys;
}

/** "1-3, 5, 8-" → 묶음 목록 (0부터). 끝을 비우면 마지막 쪽까지 */
export function parseRanges(text: string, n: number): number[][] | null {
  const out: number[][] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)(?:(-|~)(\d*))?$/.exec(part); if (!m || (!m[1] && !m[3])) return null;
    const a = m[1] ? +m[1] : 1, z = m[2] ? (m[3] ? +m[3] : n) : a;
    const g: number[] = [];
    for (let i = Math.min(a, z); i <= Math.max(a, z); i++) if (i >= 1 && i <= n) g.push(i - 1);
    if (g.length) out.push(g);
  }
  return out.length ? out : null;
}
const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const pad = (i: number, n: number) => String(i).padStart(String(n).length, '0');

/** 파일 여러 개 저장: 데스크톱은 폴더를 골라 그 안에, 웹은 ZIP 하나로 */
export async function saveMany(app: App, files: { name: string; data: Uint8Array }[], zipName: string, kind: 'pdf' | 'png' | 'jpg') {
  if (!files.length) return;
  if (files.length === 1) { const t = await app.platform.saveAs(files[0].name, files[0].data, kind); if (t) toast(`“${t.name}”로 저장했습니다.`); return; }
  const P = app.platform;
  if (P.pickFolder && P.writeInFolder) {
    const dir = await P.pickFolder(); if (!dir) return;
    const b = busy('저장하는 중…'); let last = '';
    try { for (const [i, f] of files.entries()) { b.set(`저장하는 중… ${i + 1}/${files.length}`); last = await P.writeInFolder(dir, f.name, f.data); } }
    catch (e: any) { toast('저장하지 못했습니다: ' + e.message); return; }
    finally { b.done(); }
    toast(`${files.length}개 파일을 폴더에 저장했습니다.`, 4000, P.reveal ? { label: '폴더 열기', run: () => P.reveal!(last) } : undefined);
    return;
  }
  const t = await P.saveAs(zipName, makeZip(files), 'zip');
  if (t) toast(`${files.length}개 파일을 “${t.name}”로 묶어 저장했습니다.`);
}

/** 엔진에 잠깐 여는 PDF (암호가 있으면 묻는다). 다 쓰면 close */
async function openTemp(app: App, f: OpenedFile): Promise<number | null> {
  let pw = '', tried = false;
  for (;;) {
    const r = await app.engine.call<{ docId?: number; error?: string }>('open', [f.bytes, pw]);
    if (r.docId) return r.docId;
    if (r.error !== 'password') { toast(`“${f.name}”은 PDF가 아니거나 손상된 파일이라 건너뜁니다.`); return null; }
    const v = await promptBox('암호가 걸린 문서', `“${f.name}”의 암호를 입력하세요.`, '', { type: 'password', ok: '확인', error: tried ? '암호가 맞지 않습니다.' : undefined });
    if (v === null) return null;
    pw = v; tried = true;
  }
}

async function renderImage(app: App, docId: number, i: number, dpi: number, fmt: string) {
  const res: any = await app.engine.call('render', [docId, i, dpi / 72, undefined, true, false]);
  const c = document.createElement('canvas'); c.width = res.width; c.height = res.height;
  const g = c.getContext('2d')!;
  if (fmt === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  if (res.bitmap) { g.drawImage(res.bitmap, 0, 0); res.bitmap.close(); } else g.putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
  const blob: Blob = await new Promise(rr => c.toBlob(bb => rr(bb!), fmt === 'png' ? 'image/png' : 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}
const fmtDpi = () => {
  const fmt = h('select', { class: 'field' }, h('option', { value: 'png' }, 'PNG (글자가 선명)'), h('option', { value: 'jpg' }, 'JPG (용량이 작음)'));
  const dpi = h('select', { class: 'field' }, h('option', { value: '96' }, '96 dpi (화면용)'), h('option', { value: '150', selected: '' }, '150 dpi (보통)'), h('option', { value: '300' }, '300 dpi (인쇄용)'));
  return { fmt, dpi, nodes: [h('label', { class: 'lbl' }, '형식'), fmt, h('label', { class: 'lbl' }, '해상도'), dpi] };
};
const manyHint = (app: App) => app.platform.pickFolder ? '여러 파일은 고른 폴더에 저장합니다.' : '여러 파일은 ZIP 파일 하나로 묶습니다.';

/** PDF 쪽 → PNG/JPG */
export async function exportImages(app: App) {
  const d = app.doc; if (!d) return;
  const n = d.info.pageCount, cur = app.view.current;
  const picked = app.sidebar.selected.size > 1 ? app.sidebar.selected.size : 0;
  const range = h('select', { class: 'field' }, h('option', { value: 'cur' }, `현재 쪽 (${cur + 1}쪽)`), h('option', { value: 'all' }, `모든 쪽 (${n}쪽)`), picked ? h('option', { value: 'picked' }, `고른 쪽 (${picked}쪽)`) : null, h('option', { value: 'custom' }, '쪽 번호 지정'));
  const custom = h('input', { class: 'field', placeholder: '예: 1-3, 5, 8', hidden: true });
  range.addEventListener('change', () => { custom.hidden = range.value !== 'custom'; if (!custom.hidden) custom.focus(); });
  const fd = fmtDpi();
  const r = await dialog({ title: '이미지로 내보내기', body: h('div', { class: 'form' }, h('label', { class: 'lbl' }, '범위'), range, custom, ...fd.nodes, h('p', { class: 'hint' }, manyHint(app))), buttons: [{ label: '취소', value: false }, { label: '내보내기', value: true, primary: true }], collect: () => ({ range: range.value, custom: custom.value, fmt: fd.fmt.value, dpi: +fd.dpi.value }) });
  if (!r?.value) return;
  const o = r.data;
  let pages: number[] = [];
  if (o.range === 'cur') pages = [cur];
  else if (o.range === 'all') pages = [...Array(n).keys()];
  else if (o.range === 'picked') pages = app.view.pages.map((p, i) => app.sidebar.selected.has(p.key) ? i : -1).filter(i => i >= 0);
  else {
    const g = parseRanges(String(o.custom), n);
    if (!g) { toast('쪽 번호를 알아볼 수 없습니다. 예: 1-3, 5'); return; }
    pages = [...new Set(g.flat())];
  }
  const b = busy('그림으로 바꾸는 중…');
  const files: { name: string; data: Uint8Array }[] = [];
  const base = stem(d.name);
  try {
    for (const i of pages) {
      b.set(`그림으로 바꾸는 중… ${files.length + 1}/${pages.length}`);
      files.push({ name: `${base}_${pad(i + 1, n)}쪽.${o.fmt}`, data: await renderImage(app, d.id, i, o.dpi, o.fmt) });
    }
  } catch (e: any) { toast('내보내지 못했습니다: ' + e.message); return; }
  finally { b.done(); }
  await saveMany(app, files, `${base}_그림${files.length}장.zip`, o.fmt);
}

/** 탐색기 메뉴: PDF 여러 개의 모든 쪽을 그림으로 */
export async function pdfsToImages(app: App, src: OpenedFile[]) {
  const fd = fmtDpi();
  const r = await dialog({ title: `PDF ${src.length}개 → 이미지`, body: h('div', { class: 'form' }, h('p', {}, src.map(f => f.name).join(', ')), ...fd.nodes, h('p', { class: 'hint' }, '모든 쪽을 한 쪽에 한 장씩 그림으로 만듭니다. ' + manyHint(app))), buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }], collect: () => ({ fmt: fd.fmt.value, dpi: +fd.dpi.value }) });
  if (!r?.value) return;
  const files: { name: string; data: Uint8Array }[] = [];
  for (const f of src) {
    const id = await openTemp(app, f); if (!id) continue;
    const b = busy('그림으로 바꾸는 중…');
    try {
      const n = (await app.engine.call<any>('info', [id])).pageCount;
      for (let i = 0; i < n; i++) { b.set(`“${f.name}” ${i + 1}/${n}쪽`); files.push({ name: `${stem(f.name)}_${pad(i + 1, n)}쪽.${r.data.fmt}`, data: await renderImage(app, id, i, r.data.dpi, r.data.fmt) }); }
    } catch (e: any) { toast(`“${f.name}”을 바꾸지 못했습니다: ` + e.message); }
    finally { b.done(); app.engine.call('close', [id]); }
  }
  await saveMany(app, files, `그림${files.length}장.zip`, r.data.fmt);
}

/** PDF 나누기: 지금 문서(src 없음) 또는 탐색기에서 고른 파일들 */
export async function splitPdf(app: App, src?: OpenedFile[]) {
  const d = app.doc;
  if (!src && !d) return;
  const picked = !src && app.sidebar.selected.size > 0 ? app.sidebar.selected.size : 0;
  const how = h('select', { class: 'field' },
    h('option', { value: 'each' }, '한 쪽씩 — 쪽마다 파일 하나'),
    h('option', { value: 'every' }, '정한 쪽 수마다'),
    h('option', { value: 'ranges' }, '쪽 번호로 나누기'),
    picked ? h('option', { value: 'picked' }, `고른 쪽만 빼내기 (${picked}쪽)`) : null);
  const every = h('input', { class: 'field', type: 'number', min: '1', value: '2', hidden: true });
  const ranges = h('input', { class: 'field', placeholder: '예: 1-3, 4-10, 11-  (쉼표마다 파일 하나)', hidden: true });
  const sync = () => { every.hidden = how.value !== 'every'; ranges.hidden = how.value !== 'ranges'; };
  how.addEventListener('change', () => { sync(); (every.hidden ? ranges : every).focus(); });
  const what = src ? `${src.length === 1 ? '“' + src[0].name + '”' : `PDF ${src.length}개`}` : `“${d!.name}” (${d!.info.pageCount}쪽)`;
  const r = await dialog({ title: 'PDF 나누기', body: h('div', { class: 'form' }, h('p', {}, what), h('label', { class: 'lbl' }, '나누는 방법'), how, every, ranges, h('p', { class: 'hint' }, '원본은 그대로 두고 나눈 파일을 새로 만듭니다. ' + manyHint(app))), buttons: [{ label: '취소', value: false }, { label: '나누기', value: true, primary: true }], collect: () => ({ how: how.value, every: Math.max(1, parseInt(every.value) || 1), ranges: ranges.value }) });
  if (!r?.value) return;
  const o = r.data;
  const groupsFor = (n: number, keys?: number[]): number[][] | null => {
    if (o.how === 'each') return [...Array(n).keys()].map(i => [i]);
    if (o.how === 'every') { const g: number[][] = []; for (let i = 0; i < n; i += o.every) g.push([...Array(Math.min(o.every, n - i)).keys()].map(k => i + k)); return g; }
    if (o.how === 'picked') return [app.view.pages.map((p, i) => keys!.includes(p.key) ? i : -1).filter(i => i >= 0)];
    return parseRanges(o.ranges, n);
  };
  const out: { name: string; data: Uint8Array }[] = [];
  const cut = async (id: number, name: string, n: number, keys?: number[]) => {
    const groups = groupsFor(n, keys);
    if (!groups) { toast('쪽 번호를 알아볼 수 없습니다. 예: 1-3, 4-10, 11-'); return false; }
    const b = busy('나누는 중…');
    try {
      for (const [gi, g] of groups.entries()) {
        b.set(`나누는 중… ${gi + 1}/${groups.length}`);
        const label = g.length === 1 ? `${pad(g[0] + 1, n)}쪽` : o.how === 'picked' ? '고른 쪽' : `${pad(g[0] + 1, n)}-${pad(g[g.length - 1] + 1, n)}쪽`;
        out.push({ name: `${stem(name)}_${label}.pdf`, data: await app.engine.call<Uint8Array>('extract', [id, g]) });
      }
    } finally { b.done(); }
    return true;
  };
  if (!src) { if (!await cut(d!.id, d!.name, d!.info.pageCount, [...app.sidebar.selected])) return; }
  else for (const f of src) {
    const id = await openTemp(app, f); if (!id) continue;
    try { if (!await cut(id, f.name, (await app.engine.call<any>('info', [id])).pageCount)) return; }
    finally { app.engine.call('close', [id]); }
  }
  if (out.length === 1 && !src) { // 한 파일이면 바로 새 탭으로 보여 준다
    await app.openFiles([{ name: out[0].name, bytes: out[0].data }], true);
    toast('빼낸 쪽을 새 탭으로 열었습니다. Ctrl+S로 저장하세요.'); return;
  }
  await saveMany(app, out, `${src?.length === 1 ? stem(src[0].name) : d && !src ? stem(d.name) : 'PDF'}_나눔${out.length}개.zip`, 'pdf');
}

/** PDF 여러 개 합치기 → 새 탭. 순서를 바꿀 수 있다 */
export async function mergeFiles(app: App, src?: OpenedFile[]) {
  if (!src) src = await app.platform.pickPdfs(true);
  if (!src.length) return;
  if (src.length < 2) { toast('합치려면 PDF를 두 개 이상 고르세요.'); return; }
  const list = [...src];
  const ul = h('ol', { class: 'merge-list' });
  const draw = () => {
    ul.innerHTML = '';
    list.forEach((f, i) => ul.append(h('li', {}, h('span', { class: 'merge-name', title: f.path || f.name }, f.name),
      h('button', { class: 'tb sm', type: 'button', title: '위로', disabled: i === 0 ? '' : undefined, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, '↑'),
      h('button', { class: 'tb sm', type: 'button', title: '아래로', disabled: i === list.length - 1 ? '' : undefined, onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); } }, '↓'),
      h('button', { class: 'tb sm', type: 'button', title: '빼기', onclick: () => { list.splice(i, 1); draw(); } }, icon('close')))));
  };
  draw();
  const sortBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => { list.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })); draw(); } }, '이름순 정렬');
  const r = await dialog({ title: 'PDF 합치기', body: h('div', { class: 'form' }, h('p', { class: 'hint' }, '이 순서대로 이어 붙입니다.'), ul, sortBtn), buttons: [{ label: '취소', value: false }, { label: '합치기', value: true, primary: true }] });
  if (!r?.value || list.length < 1) return;
  const docId = await app.engine.call<number>('createDoc');
  const b = busy('합치는 중…');
  let at = 0, used = 0;
  try {
    for (const [i, f] of list.entries()) {
      b.set(`합치는 중… ${i + 1}/${list.length}`);
      let pw = '', res: { keys?: number[]; error?: string };
      for (;;) {
        res = await app.engine.call('importPdf', [docId, f.bytes, pw, at]);
        if (res.error !== 'password') break;
        b.done();
        const v = await promptBox('암호가 걸린 문서', `“${f.name}”의 암호를 입력하세요.`, '', { type: 'password', ok: '확인', error: pw ? '암호가 맞지 않습니다.' : undefined });
        b.set('합치는 중…');
        if (v === null) break; pw = v;
      }
      if (res.keys) { at += res.keys.length; used++; } else if (res.error !== 'password') toast(`“${f.name}”은 읽을 수 없어 건너뛰었습니다.`);
    }
  } finally { b.done(); }
  if (!at) { app.engine.call('close', [docId]); return; }
  await app.addTab(docId, `${stem(list[0].name)} 외 ${used - 1}개 합침.pdf`, true);
  toast(`${used}개 문서, ${at}쪽을 합쳤습니다. Ctrl+S로 저장하세요.`);
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
