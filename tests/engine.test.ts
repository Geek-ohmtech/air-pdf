// 엔진 단위 시험 (node --experimental-strip-types)
import fs from 'node:fs';
import { init } from '@embedpdf/pdfium';
import { PdfEngine, ANNOT } from '../src/engine/core.ts';
import { FontKit } from '../src/engine/fonts.ts';

const NM = new URL('../node_modules/', import.meta.url).pathname;
const fontPath = NM + '@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf';
const P = await init({ wasmBinary: fs.readFileSync(NM + '@embedpdf/pdfium/dist/pdfium.wasm') });
const FONTFILES: Record<string, string> = { 'NanumGothic-Regular.ttf': 'nanum-gothic/400Regular/NanumGothic_400Regular.ttf', 'NanumMyeongjo-Regular.ttf': 'nanum-myeongjo/400Regular/NanumMyeongjo_400Regular.ttf', 'NanumPenScript-Regular.ttf': 'nanum-pen-script/400Regular/NanumPenScript_400Regular.ttf' };
const kit = new FontKit({
  font: async () => fs.readFileSync(fontPath), fontSync: () => fs.readFileSync(fontPath),
  hbWasm: async () => fs.readFileSync(NM + 'harfbuzzjs/dist/harfbuzz-subset.wasm').buffer,
  fetchFont: async (f: string) => new Uint8Array(fs.readFileSync(NM + '@expo-google-fonts/' + FONTFILES[f])),
});
const E = new PdfEngine(P, kit);
const M: any = P.pdfium;
let fails = 0;
const ok = (c: any, msg: string) => { console.log((c ? '  ✓ ' : '  ✗ ') + msg); if (!c) fails++; };
const t = async (name: string, fn: () => any) => { console.log(name); try { await fn(); } catch (e) { fails++; console.log('  ✗ 예외', e); } };

// 시험 문서: 1쪽 Helvetica 영어 + 2쪽(90도 회전) 한글
function makeDoc(): Uint8Array {
  const doc = P.FPDF_CreateNewDocument();
  const p1 = P.FPDFPage_New(doc, 0, 595, 842);
  const helv = P.FPDFText_LoadStandardFont(doc, 'Helvetica');
  const put = (page: number, font: number, s: string, x: number, y: number, size = 12) => {
    const o = P.FPDFPageObj_CreateTextObj(doc, font, size);
    const n = (s.length + 1) * 2, w = M.wasmExports.malloc(n); M.stringToUTF16(s, w, n); P.FPDFText_SetText(o, w); M.wasmExports.free(w);
    P.FPDFPageObj_Transform(o, 1, 0, 0, 1, x, y); P.FPDFPage_InsertObject(page, o);
  };
  put(p1, helv, 'Total fee: KRW 2,400,000', 72, 700);
  put(p1, helv, 'Second line here', 72, 680);
  P.FPDFPage_GenerateContent(p1); P.FPDF_ClosePage(p1);
  const p2 = P.FPDFPage_New(doc, 1, 595, 842);
  P.FPDFPage_SetRotation(p2, 1);
  put(p2, helv, 'Rotated page', 100, 500);
  P.FPDFPage_GenerateContent(p2); P.FPDF_ClosePage(p2);
  const w = P.PDFiumExt_OpenFileWriter(); P.PDFiumExt_SaveAsCopy(doc, w);
  const sz = P.PDFiumExt_GetFileWriterSize(w), b = M.wasmExports.malloc(sz); P.PDFiumExt_GetFileWriterData(w, b, sz);
  const out = M.HEAPU8.slice(b, b + sz); M.wasmExports.free(b); P.PDFiumExt_CloseFileWriter(w); P.FPDF_CloseDocument(doc);
  return out;
}

function rawPdf(objs: string[]) {
  let pdf = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
const darkBox = (img: { data: Uint8ClampedArray; width: number; height: number }) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4] < 128) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, n };
};
const pixDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 60) n++; return n; };
const src = makeDoc();
const { docId } = E.open(src);
const id = docId!;

await t('문서 정보 / 회전 좌표', () => {
  const info = E.info(id);
  ok(info.pageCount === 2, '쪽 수 2');
  const g = E.pageGeom(id, 1);
  ok(Math.abs(g.w - 842) < 1 && Math.abs(g.h - 595) < 1, `90도 쪽은 가로로 넓다 (${g.w}x${g.h})`);
  ok(Math.abs(info.pages[1].w - 842) < 1, 'FPDF_GetPageSizeByIndexF도 회전 반영');
  // PDFium의 PageToDevice와 내 행렬 비교
  const d = (E as any).docs.get(id); const pc = (E as any).page(d, 1);
  const ip = M.wasmExports.malloc(8);
  P.FPDF_PageToDevice(pc.page, 0, 0, 8420, 5950, 0, 100, 500, ip, ip + 4);
  const dx = M.HEAP32[ip >> 2] / 10, dy = M.HEAP32[(ip + 4) >> 2] / 10;
  const mine = [pc.m[0] * 100 + pc.m[2] * 500 + pc.m[4], pc.m[1] * 100 + pc.m[3] * 500 + pc.m[5]];
  ok(Math.abs(dx - mine[0]) < 0.2 && Math.abs(dy - mine[1]) < 0.2, `좌표 변환 일치 (pdfium ${dx},${dy} / mine ${mine.map(v => v.toFixed(1))})`);
});

await t('렌더링', () => {
  const t0 = performance.now(); const r = E.render(id, 0, 2); const ms = performance.now() - t0;
  ok(r.width === 1190 && r.height === 1684, `크기 ${r.width}x${r.height}, ${ms.toFixed(1)}ms`);
  let dark = 0; for (let i = 0; i < r.data.length; i += 4) if (r.data[i] < 128) dark++;
  ok(dark > 500, `글자 픽셀 있음 (${dark})`);
  for (const pg of [0, 1]) {
    const img = E.render(id, pg, 1); const td = E.textData(id, pg);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4] < 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    let bx = 1e9, by = 1e9; for (let i = 0; i < td.boxes.length; i += 4) if (td.boxes[i + 2] > 0) { bx = Math.min(bx, td.boxes[i]); by = Math.min(by, td.boxes[i + 1]); }
    ok(Math.abs(x0 - bx) < 4 && Math.abs(y0 - by) < 8, `${pg + 1}쪽 그림 위치 = 글자 위치 (그림 ${x0},${y0} / 글자 ${bx.toFixed(0)},${by.toFixed(0)})`);
  }
  const part = E.render(id, 0, 4, { x: 200, y: 400, w: 512, h: 256 });
  ok(part.width === 512 && part.height === 256, '부분 렌더링');
});

await t('글자 추출 / 검색', async () => {
  const td = E.textData(id, 0);
  ok(td.text.includes('Total fee'), '본문 추출');
  const hits: any[] = [];
  await E.search(id, 'line', {}, h => hits.push(...h));
  ok(hits.length === 1 && hits[0].rects.length === 1, `검색 1건 (${hits.length})`);
  ok(hits[0].rects[0].y > 140 && hits[0].rects[0].y < 170, `검색 위치 y=${hits[0].rects[0].y.toFixed(1)}`);
});

const key0 = E.keys(id)[0];
await t('원본 글자 편집: 같은 글꼴 재사용', async () => {
  const runs = E.textRuns(id, key0);
  ok(runs.length === 2, `줄 2개 (${runs.length})`);
  const r = runs.find(r => r.text.startsWith('Total'))!;
  ok(r.font === 'Helvetica', '글꼴 이름 ' + r.font);
  const ch = await E.editRun(id, key0, r.objs, 'Total fee: KRW 3,100,000');
  ok(!ch.substituted, '원래 글꼴 유지');
  ok(E.textData(id, 0).text.includes('3,100,000'), '바뀐 글자가 글자로 추출됨');
  E.detach(id, key0, ch.gen, ch.added); E.attach(id, key0, ch.gen, ch.removed);
  ok(E.textData(id, 0).text.includes('2,400,000'), '되돌리기');
});

await t('원본 글자 편집: 한글 → 부분 글꼴 대체', async () => {
  const r = E.textRuns(id, key0).find(r => r.text.startsWith('Second'))!;
  const ch = await E.editRun(id, key0, r.objs, '두 번째 줄 수정');
  ok(ch.substituted, '대체 글꼴 사용');
  const td = E.textData(id, 0);
  ok(td.text.includes('두 번째 줄 수정'), '한글이 진짜 글자로 들어감');
  const img = E.render(id, 0, 2); let dark = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) dark++;
  ok(dark > 800, '한글이 그려짐');
});

await t('글자·표·도형·OCR층 추가', async () => {
  const a = await E.addText(id, key0, { x: 72, y: 300, text: '새 글자\n둘째 줄', size: 14, color: '#c02020' });
  ok(a.added.length === 2, '줄마다 객체');
  const tb = await E.addTable(id, key0, { x: 72, y: 400, cols: [100, 100], rows: [24, 24], cells: [['항목', '금액'], ['디자인', '240만원']], fontSize: 10, color: '#111111', border: '#333333', borderWidth: 0.8, padding: 4, headerFill: '#eeeeee', headerBold: true });
  ok(tb.added.length >= 6, `표 객체 ${tb.added.length}개`);
  await E.addOcrLayer(id, key0, [{ text: '스캔본문', x: 300, y: 600, w: 80, h: 14 }]);
  const td = E.textData(id, 0);
  ok(td.text.includes('240만원') && td.text.includes('스캔본문') && td.text.includes('둘째 줄'), '모두 검색 가능한 글자');
  const sh = E.addShape(id, key0, { kind: 'rect', x: 60, y: 60, w: 100, h: 50, stroke: '#0000ff', width: 2 });
  ok(sh.added.length === 1, '사각형 경로');
  ok(E.pageObjects(id, key0).some(o => o.type === 'path'), '도형 선택 목록');
});

await t('주석', () => {
  const h = E.addAnnot(id, key0, { subtype: ANNOT.HIGHLIGHT, quads: [{ x: 72, y: 130, w: 120, h: 14 }], color: '#ffd400', opacity: 0.5, contents: '확인 필요' });
  const n = E.addAnnot(id, key0, { subtype: ANNOT.TEXT, point: { x: 400, y: 100 }, contents: '한글 메모입니다', color: '#ffcc00' });
  E.addAnnot(id, key0, { subtype: ANNOT.INK, ink: [[[100, 500], [120, 520], [140, 505]]], color: '#2244ff', width: 2 });
  let list = E.annots(id, 0);
  ok(list.length === 3, `주석 3개 (${list.length})`);
  ok(list.find(a => a.id === n)!.contents === '한글 메모입니다', '메모 내용');
  E.updateAnnot(id, key0, n, { contents: '고친 메모' });
  ok(E.annots(id, 0).find(a => a.id === n)!.contents === '고친 메모', '메모 수정');
  E.setAnnotRemoved(id, key0, h, true);
  ok(E.annots(id, 0).length === 2, '주석 지움(숨김)');
  E.setAnnotRemoved(id, key0, h, false);
  ok(E.annots(id, 0).length === 3, '지운 주석 되살림');
  E.setAnnotRemoved(id, key0, h, true);
});

await t('영역 삭제(실제 제거)', () => {
  const before = E.textData(id, 0).text;
  ok(before.includes('KRW'), '삭제 전');
  E.redact(id, key0, { x: 60, y: 125, w: 300, h: 25 }, null);
  const after = E.textData(id, 0).text;
  ok(!after.includes('KRW'), '글자가 실제로 사라짐');
});

await t('페이지 다루기', async () => {
  const k2 = E.keys(id)[1];
  E.rotatePage(id, k2, 1);
  ok(E.pageGeom(id, 1).rotation === 2, '회전');
  const bk = E.insertBlank(id, 2, 595, 842);
  ok(E.info(id).pageCount === 3, '빈 쪽 추가');
  E.movePage(id, bk, 0);
  ok(E.keys(id)[0] === bk, '쪽 이동');
  const tmp = E.deletePage(id, bk);
  ok(E.info(id).pageCount === 2, '쪽 삭제');
  E.restorePage(id, bk, 0, tmp);
  ok(E.info(id).pageCount === 3 && E.keys(id)[0] === bk, '쪽 되살림');
  const im = E.importPdf(id, src, '', 3);
  ok(im.keys?.length === 2 && E.info(id).pageCount === 5, '다른 PDF 합치기');
  const ex = E.extract(id, [1]);
  const o2 = E.open(ex); ok(o2.docId && E.info(o2.docId).pageCount === 1, '쪽 뽑아내기'); E.close(o2.docId!);
});

await t('저장 / 다시 열기 / 암호', () => {
  E.setPassword(id, '1234', 'owner');
  const bytes = E.save(id);
  fs.writeFileSync('/tmp/claude-0/-home-user/20e33b69-2b80-548c-a7b1-d3df5dbebf23/scratchpad/engine-out.pdf', bytes);
  ok(E.open(bytes).error === 'password', '암호 없으면 거부');
  ok(E.open(bytes, '0000').error === 'password', '틀린 암호 거부');
  const r = E.open(bytes, '1234');
  ok(!!r.docId, '맞는 암호로 열림');
  const k = E.keys(r.docId!);
  const idx = k.findIndex((_, i) => E.textData(r.docId!, i).text.includes('두 번째 줄 수정'));
  ok(idx >= 0, '저장본에 한글 글자 유지');
  ok(E.annots(r.docId!, idx).length === 2, '저장본 주석 2개 (지운 것은 빠짐)');
  ok(bytes.length < 120000, `파일 크기 ${(bytes.length / 1024).toFixed(1)}KB (글꼴 통째로 안 넣음)`);
});


await t('글꼴 미내장 한글 PDF (대체 글꼴)', () => {
  // 바탕(Batang) 글꼴을 이름만 적고 내장하지 않은 PDF
  const content = 'BT /F1 24 Tf 72 700 Td <AC00B098B2E4> Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Batang /Encoding /UniKS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Batang /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /Batang /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  ];
  let pdf = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const r = E.open(new TextEncoder().encode(pdf));
  ok(!!r.docId, '열림');
  ok(E.textData(r.docId!, 0).text.startsWith('가나다'), '글자 추출 ' + E.textData(r.docId!, 0).text);
  const img = E.render(r.docId!, 0, 1); let dark = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) dark++;
  fs.writeFileSync("/tmp/claude-0/-home-user/20e33b69-2b80-548c-a7b1-d3df5dbebf23/scratchpad/fb.raw", img.data); ok(dark > 150, `대체 글꼴로 그려짐 (${dark}px)`);
});

await t('양식(Form XObject) 안 글자 편집', async () => {
  // 1·2쪽이 같은 양식 Fm1을 함께 쓰고, 2쪽에는 확대·중첩된 양식 Fm2도 있다
  const fm1 = 'BT /F1 12 Tf 20 30 Td (Hello Form) Tj ET BT /F1 12 Tf 20 10 Td (Second line) Tj ET';
  const fm3 = 'BT /F1 10 Tf 0 0 Td (Deep inner) Tj ET';
  const fm2 = '1.5 0 0 1.5 0 0 cm BT /F1 8 Tf 10 10 Td (Scaled text) Tj ET q 1 0 0 1 10 30 cm /Fm3 Do Q';
  const p1c = 'q 1 0 0 1 100 600 cm /Fm1 Do Q BT /F1 12 Tf 72 400 Td (Top level) Tj ET';
  const p2c = 'q 1 0 0 1 100 600 cm /Fm1 Do Q q 1 0 0 1 50 100 cm /Fm2 Do Q';
  const res = '/Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 7 0 R /Fm2 8 0 R >> >>';
  const pdf = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${res} /Contents 4 0 R >>`,
    `<< /Length ${p1c.length} >>\nstream\n${p1c}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${res} /Contents 10 0 R >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Length ${fm1.length} >>\nstream\n${fm1}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 100] /Matrix [2 0 0 2 0 0] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm3 9 0 R >> >> /Length ${fm2.length} >>\nstream\n${fm2}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 5 0 R >> >> /Length ${fm3.length} >>\nstream\n${fm3}\nendstream`,
    `<< /Length ${p2c.length} >>\nstream\n${p2c}\nendstream`,
  ]);
  const id = E.open(pdf).docId!;
  const [k1, k2] = E.keys(id);
  const runs1 = E.textRuns(id, k1);
  const hello = runs1.find(r => r.text === 'Hello Form')!;
  ok(hello && hello.inForm, '양식 안 글자를 찾음 (' + runs1.map(r => r.text + (r.inForm ? '*' : '')).join(', ') + ')');
  ok(Math.abs(hello.rect.y - (842 - 630 - 9)) < 4 && Math.abs(hello.rect.x - 120) < 3, `위치 ${hello.rect.x.toFixed(1)},${hello.rect.y.toFixed(1)}`);
  // 꺼내기만 하면(이동 0) 모양이 그대로여야 한다
  const before2 = E.render(id, 1, 1);
  const runs2 = E.textRuns(id, k2);
  const scaled = runs2.find(r => r.text === 'Scaled text')!, deep = runs2.find(r => r.text === 'Deep inner')!;
  ok(scaled && deep && Math.abs(scaled.size - 24) < 0.5, `확대 양식 글자 크기 ${scaled?.size} (8pt×1.5×2=24)`);
  E.transformObjs(id, k2, E.pageGen(id, k2), [...scaled.objs, ...deep.objs], 0, 0);
  ok(pixDiff(before2.data, E.render(id, 1, 1).data) < 30, '꺼낸 뒤에도 모양이 같음 (확대·중첩 양식)');
  // 1쪽 Hello Form 고치기 (같은 Helvetica로)
  const ch = await E.editRun(id, k1, hello.objs, 'Hello World');
  ok(!ch.substituted && ch.also?.includes(k2), '원래 글꼴 유지, 같은 양식을 쓰는 2쪽도 함께 정리');
  // 2쪽의 Second line을 한글로
  const sec2 = E.textRuns(id, k2).find(r => r.text === 'Second line')!;
  const ch2 = await E.editRun(id, k2, sec2.objs, '두 번째 줄');
  ok(ch2.substituted, '한글은 부분 글꼴로');
  const out = E.save(id);
  const id2 = E.open(out).docId!;
  const t1 = E.textData(id2, 0).text.replace(/\s+/g, ' '), t2 = E.textData(id2, 1).text.replace(/\s+/g, ' ');
  ok(t1.includes('Hello World') && t1.includes('Second line') && !t1.includes('Hello Form'), '저장본 1쪽: ' + t1);
  ok(t2.includes('Hello Form') && t2.includes('두 번째 줄') && !t2.includes('Second line') && t2.includes('Scaled text') && t2.includes('Deep inner'), '저장본 2쪽: ' + t2);
  // 되돌리기
  E.detach(id, k1, ch.gen, ch.added); E.attach(id, k1, ch.gen, ch.removed);
  ok(E.textData(id, 0).text.includes('Hello Form'), '양식 글자 고치기 되돌리기');
});

await t('입력란 채우기', async () => {
  const pdf = rawPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R 8 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R 5 0 R 6 0 R 8 0 R] >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 700 300 724] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R >>',
    '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [100 650 116 666] /F 4 /P 3 0 R /V /Off /AS /Off /MK << /CA (4) >> /AP << /N << /Yes 9 0 R /Off 10 0 R >> >> >>',
    '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (city) /Rect [100 600 300 624] /Opt [(Seoul) (Busan) (Daegu)] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 4096 /T (memo) /Rect [100 450 300 560] /DA (/Helv 10 Tf 0 g) /F 4 /P 3 0 R >>',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 20 >>\nstream\n0 g 3 3 10 10 re f\nendstream',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 0 >>\nstream\n\nendstream',
  ]);
  const id = E.open(pdf).docId!; const key = E.keys(id)[0];
  ok(E.formType(id) === 1, 'AcroForm 문서');
  const fs0 = E.fields(id, 0);
  ok(fs0.map(f => f.type).join() === 'text,checkbox,combo,text' && fs0[3].multiline, '입력란 4개: ' + fs0.map(f => f.name + ':' + f.type).join(', '));
  const fieldPx = (docId: number, r: { x: number; y: number; w: number; h: number }) => darkBox(E.render(docId, 0, 2, { x: r.x * 2, y: r.y * 2, w: r.w * 2, h: r.h * 2 }, true, false)).n;
  ok(await E.setField(id, key, fs0[0].id, '홍길동 Kim'), '글자칸에 한글 입력');
  await E.setField(id, key, fs0[1].id, true);
  await E.setField(id, key, fs0[2].id, 1);
  await E.setField(id, key, fs0[3].id, '첫째 줄입니다\n둘째 줄은 길어서 칸 너비를 넘으면 자동으로 다음 줄로 넘어갑니다');
  const fs1 = E.fields(id, 0);
  ok(fs1[0].value === '홍길동 Kim' && fs1[1].checked && fs1[2].value === 'Busan', `값: ${fs1[0].value} / ${fs1[1].checked} / ${fs1[2].value}`);
  const px = fieldPx(id, fs1[0].rect);
  ok(px > 250, `한글 값이 화면에 그려짐 (${px}px)`);
  const out = E.save(id);
  const id2 = E.open(out).docId!;
  const fs2 = E.fields(id2, 0);
  ok(fs2[0].value === '홍길동 Kim' && fs2[1].checked && fs2[2].value === 'Busan' && fs2[3].value.startsWith('첫째'), '저장 후 값 유지');
  const px2 = fieldPx(id2, fs2[0].rect), px3 = fieldPx(id2, fs2[3].rect);
  ok(px2 > 250 && px3 > 600, `저장본에서도 한글 모양 (${px2}px, 여러 줄 ${px3}px)`);
  fs.writeFileSync('/tmp/claude-0/-home-user/20e33b69-2b80-548c-a7b1-d3df5dbebf23/scratchpad/form-filled.pdf', out);
});

await t('이미지 → PDF, 용량 줄이기', async () => {
  const FX = new URL('./fixtures/', import.meta.url).pathname;
  const photo = new Uint8Array(fs.readFileSync(FX + 'photo.jpg')), logo = new Uint8Array(fs.readFileSync(FX + 'logo.png'));
  const id = E.createDoc();
  E.addImagePage(id, 0, { bytes: photo, kind: 'jpg', w: 2400, h: 1800 }, 'a4');
  E.addImagePage(id, 1, { bytes: logo, kind: 'png', w: 400, h: 200 }, 'image');
  const info = E.info(id);
  ok(info.pageCount === 2 && Math.round(info.pages[0].w) === 842 && Math.round(info.pages[1].w) === 192, `쪽 크기 ${info.pages.map(p => Math.round(p.w) + 'x' + Math.round(p.h)).join(', ')}`);
  const img = E.render(id, 0, 0.5); const db = darkBox(img);
  ok(db.n > 1000, '사진이 그려짐');
  const bytes = E.save(id);
  ok(bytes.length > photo.length && bytes.length < photo.length + 60000, `JPEG를 다시 압축하지 않고 그대로 넣음 (${(bytes.length / 1024).toFixed(0)}KB)`);
  // 용량 줄이기: 시험에서는 고정된 작은 JPEG를 돌려주는 가짜 인코더
  const small = new Uint8Array(fs.readFileSync(FX + 'small.jpg'));
  let asked: number[] = [];
  const res = await E.compressCopy(id, { dpi: 100, quality: 0.6 }, async (_rgba, w, h, ow, oh) => { asked = [w, h, ow, oh]; return small; });
  ok(res.images === 1 && res.after < res.before / 5, `큰 사진만 줄임 ${(res.before / 1024).toFixed(0)}KB → ${(res.after / 1024).toFixed(0)}KB (투명 PNG는 그대로)`);
  ok(asked[0] === 2400 && asked[2] > 1000 && asked[2] < 1030, `해상도 계산 ${asked.join('x')} (A4에 맞춘 사진 237dpi → 100dpi)`);
  const id2 = E.open(res.bytes).docId!;
  ok(E.info(id2).pageCount === 2 && darkBox(E.render(id2, 0, 0.5)).n > 500, '줄인 사본이 정상');
  ok(E.save(id).length > photo.length, '원본 문서는 그대로');
});

await t('글자만 지우기 / 글자 색·굵게 바꾸기', async () => {
  const id = E.createDoc();
  E.addImagePage(id, 0, { bytes: new Uint8Array(fs.readFileSync(new URL('./fixtures/logo.png', import.meta.url).pathname)), kind: 'png', w: 400, h: 200 }, 'a4');
  const key = E.keys(id)[0];
  await E.addText(id, key, { x: 100, y: 330, text: '로고 위의 글자', size: 20, color: '#111111' });
  E.addShape(id, key, { kind: 'rect', x: 90, y: 320, w: 200, h: 40, stroke: '#ff0000', width: 2 });
  const objsBefore = E.pageObjects(id, key).length;
  ok(E.textData(id, 0).text.includes('로고 위의 글자'), '지우기 전');
  E.redactText(id, key, { x: 80, y: 310, w: 260, h: 60 });
  ok(!E.textData(id, 0).text.includes('로고'), '글자는 실제로 사라짐');
  const after = E.pageObjects(id, key);
  ok(after.length === objsBefore, `그림·도형은 그대로 (${objsBefore}개 → ${after.length}개: ${after.map(o => o.type).join(',')})`);
  // 색·굵게
  await E.addText(id, key, { x: 100, y: 600, text: '색을 바꿀 글자', size: 16, color: '#000000' });
  const run = E.textRuns(id, key).find(r => r.text.includes('색을 바꿀'))!;
  const st = E.setTextStyle(id, key, run.objs, { color: '#d0342c', bold: true });
  const run2 = E.textRuns(id, key).find(r => r.text.includes('색을 바꿀'))!;
  ok(run2.color === '#d0342c', '색 바뀜 ' + run2.color);
  E.restoreTextStyle(id, key, st.before);
  ok(E.textRuns(id, key).find(r => r.text.includes('색을 바꿀'))!.color === '#000000', '색 되돌리기');
});

await t('글꼴 선택, 글상자, 자유선, 도형 다시 고치기', async () => {
  const id = E.createDoc();
  const key = E.insertBlank(id, 0, 595, 842);
  await E.addText(id, key, { x: 60, y: 60, text: '나눔손글씨로 쓴 글', size: 20, color: '#223344', font: 'nanum-pen' });
  const run = E.textRuns(id, key).find(r => r.text.includes('나눔손글씨'))!;
  ok(/NanumPen/i.test(run.font), '고른 글꼴로 들어감: ' + run.font);
  const ch = await E.editRun(id, key, run.objs, '명조로 바꾼 글', { font: 'nanum-myeongjo' });
  ok(/Myeongjo/i.test(E.textRuns(id, key).find(r => r.text.includes('명조로'))!.font), '고친 뒤 글꼴 바꾸기');
  const tb = await E.addTextBox(id, key, { x: 60, y: 120, w: 200, text: '글상자 안의 긴 문장은 폭에 맞춰 자동으로 줄이 바뀝니다. 두 번째 문장도 있습니다.', size: 12, color: '#111111', border: '#2b59c3', bw: 1, fill: '#eef3ff', pad: 6 });
  ok(tb.rect.h > 50 && tb.added.length >= 4, `글상자 ${tb.added.length}개 객체, 높이 ${tb.rect.h.toFixed(0)}pt (여러 줄)`);
  E.addShape(id, key, { kind: 'ellipse', x: 300, y: 120, w: 120, h: 60, stroke: '#d0342c', width: 2 });
  E.addFree(id, key, { points: [[300, 300], [320, 280], [350, 310], [380, 290], [400, 320]], stroke: '#1f8a4c', width: 3 });
  const out = E.save(id);
  const id2 = E.open(out).docId!; const k2 = E.keys(id2)[0];
  const objs = E.pageObjects(id2, k2);
  const box = objs.find(o => o.type === 'textbox'), sh = objs.find(o => o.type === 'shape'), fr = objs.find(o => o.type === 'free');
  ok(box && box.meta.text.startsWith('글상자 안의') && box.objs!.length === tb.added.length, '저장 후에도 글상자로 알아봄 (한글 내용 유지)');
  ok(sh && sh.meta.kind === 'ellipse' && sh.meta.stroke === '#d0342c', '저장 후에도 도형 정보 유지');
  ok(!!fr, '자유선');
  ok(!E.textRuns(id2, k2).some(r => r.text.startsWith('글상자')), '글상자 글자는 줄 고치기 목록에서 빠짐');
  const before = E.setShapeStyle(id2, k2, sh!.objs!, { stroke: '#2b59c3', width: 4, fill: '#ffeecc' });
  const sh2 = E.pageObjects(id2, k2).find(o => o.type === 'shape')!;
  ok(sh2.meta.fill === '#ffeecc' && sh2.meta.width === 4, '도형 색·굵기·채우기 바꾸기');
  E.restoreShapeStyle(id2, k2, before);
  const rs = E.reshape(id2, k2, sh2.objs!, { x: 300, y: 120, w: 200, h: 40 });
  const sh3 = E.pageObjects(id2, k2).find(o => o.type === 'shape')!;
  ok(Math.abs(sh3.rect.w - 202) < 4 && Math.abs(sh3.rect.h - 42) < 4, `도형 크기 다시 그리기 ${sh3.rect.w.toFixed(0)}×${sh3.rect.h.toFixed(0)}`);
  const rb = await E.replaceTextBox(id2, k2, box!.objs!, { ...box!.meta, text: '바꾼 글상자', fill: '', border: '#000000' });
  ok(rb.removed.length === box!.objs!.length && E.textData(id2, 0).text.includes('바꾼 글상자'), '글상자 고치기');
  const img = E.pageObjects(id2, k2).find(o => o.type === 'free')!;
  E.transformObjs(id2, k2, E.pageGen(id2, k2), img.objs!, 0, 0, [2, 0.5], { x: img.rect.x, y: img.rect.y });
  const img2 = E.pageObjects(id2, k2).find(o => o.type === 'free')!;
  ok(Math.abs(img2.rect.w / img.rect.w - 2) < 0.15 && Math.abs(img2.rect.h / img.rect.h - 0.5) < 0.2, '가로·세로 따로 늘이기');
});

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
