/**
 * 글자 인식(OCR): Tesseract(한국어+영어)를 앱 안에 넣어 오프라인으로 돌린다.
 * 인식한 낱말은 PDF에 "보이지 않는 진짜 글자"로 얹어서, 모양은 그대로 두고 검색·복사·선택이 되게 한다.
 */
let workerP: Promise<any> | null = null;
const vendor = (p: string) => new URL('vendor/ocr/' + p, document.baseURI).href;

export async function getOcr(onProgress?: (msg: string) => void) {
  if (!workerP) {
    workerP = (async () => {
      const T: any = await import('tesseract.js');
      const createWorker = T.createWorker || T.default?.createWorker;
      return createWorker(['kor', 'eng'], 1, {
        workerPath: vendor('worker.min.js'),
        corePath: vendor('core'),
        langPath: vendor('lang'),
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: (m: any) => { if (m.status && onProgress) onProgress(m.status === 'recognizing text' ? `인식 중 ${Math.round(m.progress * 100)}%` : '준비 중…'); },
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

export interface OcrWord { text: string; x: number; y: number; w: number; h: number; conf: number }

/** 그림(쪽 렌더링) → 낱말 목록(그림 px 좌표) */
export async function recognize(img: ImageBitmap | HTMLCanvasElement, onProgress?: (m: string) => void): Promise<OcrWord[]> {
  const w = await getOcr(onProgress);
  let src: HTMLCanvasElement;
  if (img instanceof HTMLCanvasElement) src = img;
  else { src = document.createElement('canvas'); src.width = img.width; src.height = img.height; src.getContext('2d')!.drawImage(img, 0, 0); }
  const { data } = await w.recognize(src, {}, { blocks: true, text: false });
  const out: OcrWord[] = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    for (const wd of l.words || []) {
      const t = (wd.text || '').trim();
      // 낮은 신뢰도, 또는 한 글자짜리 라틴 잡음(o, O, | 등)은 버린다
      if (!t || wd.confidence < 45 || (t.length === 1 && !/[\p{Script=Hangul}\p{N}]/u.test(t) && wd.confidence < 80)) continue;
      out.push({ text: t, x: wd.bbox.x0, y: wd.bbox.y0, w: wd.bbox.x1 - wd.bbox.x0, h: wd.bbox.y1 - wd.bbox.y0, conf: wd.confidence });
    }
  }
  return out;
}
export async function stopOcr() { if (workerP) { const w = await workerP.catch(() => null); workerP = null; await w?.terminate?.(); } }
