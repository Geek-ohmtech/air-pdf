// 시험용 PDF 만들기: 한글 본문, 표, 링크 없는 여러 쪽, 스캔(그림만 있는) 쪽, 암호 걸린 사본
import fs from 'node:fs';
import { init } from '@embedpdf/pdfium';
import { PdfEngine } from '../src/engine/core.ts';
import { FontKit } from '../src/engine/fonts.ts';
const NM = new URL('../node_modules/', import.meta.url).pathname;
const OUT = new URL('./fixtures/', import.meta.url).pathname;
const fontPath = NM + '@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf';
const P: any = await init({ wasmBinary: fs.readFileSync(NM + '@embedpdf/pdfium/dist/pdfium.wasm') } as any);
const E = new PdfEngine(P, new FontKit({ font: async () => fs.readFileSync(fontPath), fontSync: () => fs.readFileSync(fontPath), hbWasm: async () => fs.readFileSync(NM + 'harfbuzzjs/dist/harfbuzz-subset.wasm').buffer as ArrayBuffer }));
const M = P.pdfium;
// 빈 문서
const doc = P.FPDF_CreateNewDocument();
for (let i = 0; i < 12; i++) P.FPDF_ClosePage(P.FPDFPage_New(doc, i, 595.28, 841.89));
const w = P.PDFiumExt_OpenFileWriter(); P.PDFiumExt_SaveAsCopy(doc, w);
const n = P.PDFiumExt_GetFileWriterSize(w), b = M.wasmExports.malloc(n); P.PDFiumExt_GetFileWriterData(w, b, n);
const blank = M.HEAPU8.slice(b, b + n); P.PDFiumExt_CloseFileWriter(w); P.FPDF_CloseDocument(doc);
const id = E.open(blank).docId!;
const keys = E.keys(id);
const body = [
  '제1조 (목적) 이 계약은 갑과 을 사이의 소프트웨어 개발 용역에 관한 사항을 정한다.',
  '제2조 (계약 금액) 총 계약 금액은 금 24,000,000원(부가세 별도)으로 한다.',
  '제3조 (기간) 개발 기간은 계약일로부터 90일로 하며 합의에 따라 연장할 수 있다.',
  '제4조 (검수) 을은 결과물을 제출하고 갑은 10영업일 안에 검수 결과를 알린다.',
  '제5조 (지식재산권) 결과물의 저작권은 잔금 지급과 동시에 갑에게 넘어간다.',
  'Payment terms: 30% on signing, 40% at midpoint, 30% on final delivery.',
];
for (let i = 0; i < keys.length; i++) {
  if (i === 2) continue;
  await E.addText(id, keys[i], { x: 64, y: 60, text: i === 0 ? '소프트웨어 개발 용역 계약서' : `부록 ${i}`, size: 22, color: '#1a2030', bold: true });
  await E.addText(id, keys[i], { x: 64, y: 120, text: body.join('\n'), size: 11, color: '#222222' });
  if (i === 0) await E.addTable(id, keys[i], { x: 64, y: 330, cols: [180, 120, 160], rows: [22, 22, 22, 22], cells: [['항목', '수량', '금액'], ['설계', '1식', '6,000,000원'], ['개발', '1식', '15,000,000원'], ['교육', '2회', '3,000,000원']], fontSize: 10, color: '#111111', border: '#444444', borderWidth: 0.7, padding: 4, headerFill: '#e9edf5', headerBold: true });
  await E.addText(id, keys[i], { x: 270, y: 800, text: `- ${i + 1} -`, size: 9, color: '#777777' });
}
// 3쪽: 1쪽을 그림으로 찍어 넣어 "스캔 문서"처럼 (글자 없음)
const d = (E as any).docs.get(id);
const scale = 2;
const src = (E as any).page(d, 0), dst = (E as any).page(d, 2);
const W = Math.round(src.w * scale), H = Math.round(src.h * scale);
const bm = P.FPDFBitmap_Create(W, H, 0); P.FPDFBitmap_FillRect(bm, 0, 0, W, H, 0xffffffff);
P.FPDF_RenderPageBitmap(bm, src.page, 0, 0, W, H, 0, 0);
const img = P.FPDFPageObj_NewImageObj(d.doc);
const pp = M.wasmExports.malloc(4); M.HEAP32[pp >> 2] = dst.page;
P.FPDFImageObj_SetBitmap(pp, 1, img, bm); M.wasmExports.free(pp);
P.FPDFImageObj_SetMatrix(img, 595.28, 0, 0, 841.89, 0, 0);
P.FPDFPage_InsertObject(dst.page, img); P.FPDFPage_GenerateContent(dst.page); dst.dirty = true;
P.FPDFBitmap_Destroy(bm);
const bytes = E.save(id);
fs.writeFileSync(OUT + 'sample.pdf', bytes);
E.setPassword(id, '1234', '');
fs.writeFileSync(OUT + 'locked.pdf', E.save(id));
console.log('sample.pdf', (bytes.length / 1024).toFixed(0) + 'KB, locked.pdf 암호 1234');

// 입력란 문서, 양식(Form XObject) 문서
function rawPdf(objs: string[]) {
  let pdf = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
const lab = 'BT /F1 11 Tf 100 730 Td (Name) Tj ET BT /F1 11 Tf 124 655 Td (I agree) Tj ET BT /F1 11 Tf 100 630 Td (City) Tj ET BT /F1 11 Tf 100 565 Td (Memo) Tj ET';
fs.writeFileSync(OUT + 'form.pdf', rawPdf([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R 8 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R 5 0 R 6 0 R 8 0 R] /Resources << /Font << /F1 7 0 R >> >> /Contents 11 0 R >>',
  '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [100 700 300 724] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R >>',
  '<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [100 650 116 666] /F 4 /P 3 0 R /V /Off /AS /Off /MK << /CA (4) >> /AP << /N << /Yes 9 0 R /Off 10 0 R >> >> >>',
  '<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (city) /Rect [100 600 300 624] /Opt [(Seoul) (Busan) (Daegu)] /DA (/Helv 12 Tf 0 g) /F 4 /P 3 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 4096 /T (memo) /Rect [100 450 300 560] /DA (/Helv 10 Tf 0 g) /F 4 /P 3 0 R >>',
  '<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 20 >>\nstream\n0 g 3 3 10 10 re f\nendstream',
  '<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 0 >>\nstream\n\nendstream',
  `<< /Length ${lab.length} >>\nstream\n${lab}\nendstream`,
]));
const fm1 = 'BT /F1 14 Tf 20 30 Td (Hello Form) Tj ET BT /F1 12 Tf 20 10 Td (Second line) Tj ET';
const pc = 'q 1 0 0 1 100 600 cm /Fm1 Do Q BT /F1 12 Tf 72 400 Td (Top level) Tj ET';
const res = '/Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 7 0 R >> >>';
fs.writeFileSync(OUT + 'xobject.pdf', rawPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${res} /Contents 4 0 R >>`,
  `<< /Length ${pc.length} >>\nstream\n${pc}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${res} /Contents 4 0 R >>`,
  `<< /Type /XObject /Subtype /Form /BBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Length ${fm1.length} >>\nstream\n${fm1}\nendstream`,
]));
console.log('form.pdf, xobject.pdf');
