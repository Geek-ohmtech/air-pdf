/**
 * 글자 인식(OCR): Tesseract(한국어+영어)를 앱 안에 넣어 오프라인으로 돌린다.
 * 인식한 낱말은 PDF에 "보이지 않는 진짜 글자"로 얹어서, 모양은 그대로 두고 검색·복사·선택이 되게 한다.
 */
let workerP: Promise<any> | null = null;
/** 엔진은 한 번 만들어 계속 쓰므로, 진행 상황은 그때그때 지금 작업의 표시로 보낸다 */
let progressTo: ((msg: string) => void) | null = null;
const vendor = (p: string) => new URL('vendor/ocr/' + p, document.baseURI).href;

export async function getOcr(onProgress?: (msg: string) => void) {
  progressTo = onProgress || null;
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
        logger: (m: any) => { if (m.status && progressTo) progressTo(m.status === 'recognizing text' ? `인식 중 ${Math.round(m.progress * 100)}%` : '준비 중…'); },
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

export interface OcrWord { text: string; x: number; y: number; w: number; h: number; conf: number }

/** 그림(페이지 렌더링) → 낱말 목록(그림 px 좌표) */
export async function recognize(img: ImageBitmap | HTMLCanvasElement, onProgress?: (m: string) => void, opts: { clean?: boolean | 'gray' | 'bw'; merge?: boolean } = {}): Promise<OcrWord[]> {
  const w = await getOcr(onProgress);
  let src: HTMLCanvasElement;
  if (img instanceof HTMLCanvasElement) src = img;
  else { src = document.createElement('canvas'); src.width = img.width; src.height = img.height; src.getContext('2d')!.drawImage(img, 0, 0); }
  // 사진·스캔은 조명을 고르게 하고 대비를 높여서 넘긴다 (모양·위치는 그대로라 글자층 자리가 맞는다)
  // 조명이 고르지 않은 사진만 다듬는다 (이미 깨끗한 스캔은 그대로가 더 잘 읽힌다)
  const sc = await import('../scan/scan.ts');
  if (opts.clean === 'gray' || opts.clean === 'bw' || (opts.clean === undefined && sc.unevenLight(src))) { onProgress?.('그림 다듬는 중…'); src = sc.enhance(src, opts.clean === 'bw' ? 'bw' : 'gray'); }
  const { data } = await w.recognize(src, {}, { blocks: true, text: false });
  const out: OcrWord[] = [];
  const hangul = /[\p{Script=Hangul}]/u, junk = /^[|\\/_~=\-–—.,:;'"`^°*•·()[\]{}<>!?]+$/;
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).map((wd: any) => ({ text: (wd.text || '').trim(), x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, conf: wd.confidence }))
      .filter((wd: any) => wd.text && !(junk.test(wd.text) && wd.conf < 90))
      .sort((a: any, b: any) => a.x0 - b.x0);
    if (!words.length) continue;
    const hs = words.map((wd: any) => wd.y1 - wd.y0).sort((a: number, b: number) => a - b), lh = hs[hs.length >> 1] || 1;
    // 한글은 음절마다 낱말로 나뉘어 나오는 일이 많아서, 사이가 좁으면 한 낱말로 붙인다 (찾기·복사가 되게).
    // 자간이 넓은 줄(머리말·꼬리말)도 있어서, 그 줄의 간격 분포에서 "음절 사이"와 "낱말 사이"를 가른다
    const korGap = (a: any, b: any) => hangul.test(a.text.slice(-1)) || hangul.test(b.text[0]);
    const gaps = words.slice(1).map((wd: any, i: number) => korGap(words[i], wd) ? wd.x0 - words[i].x1 : -1).filter((g: number) => g >= 0).sort((a: number, b: number) => a - b);
    let split = lh * 0.42;
    if (gaps.length >= 3) {
      let bi = -1, br = 1.7;
      for (let i = 0; i < gaps.length - 1; i++) { const r = gaps[i + 1] / Math.max(gaps[i], lh * 0.05); if (r > br && gaps[i] < lh * 0.9) { br = r; bi = i; } }
      if (bi >= 0) split = Math.min(lh * 0.9, (gaps[bi] + gaps[bi + 1]) / 2);
    }
    const single = (t: string) => t.length === 1 && hangul.test(t);
    const merged: typeof words = [];
    for (const wd of words) {
      const last = merged[merged.length - 1];
      const gap = last ? wd.x0 - last.x1 : Infinity;
      const kor = last && korGap(last, wd);
      if (last && wd.x0 < last.x1 - (wd.x1 - wd.x0) * 0.5 && last.text.endsWith(wd.text)) continue; // 겹쳐서 두 번 읽은 낱말
      const lim = !kor ? lh * 0.12 : single(wd.text) && single(last.text.slice(-1)) && last.text.length === 1 ? Math.max(split, lh * 0.55) : split;
      if (last && opts.merge !== false && gap < lim) {
        last.text += wd.text; last.x1 = Math.max(last.x1, wd.x1); last.y0 = Math.min(last.y0, wd.y0); last.y1 = Math.max(last.y1, wd.y1);
        last.conf = Math.min(last.conf, wd.conf) * 0.3 + (last.conf + wd.conf) / 2 * 0.7;
      } else merged.push({ ...wd });
    }
    for (const wd of merged) {
      // 같은 자리에 같은 글자를 두 번 읽은 것은 하나만 (겹친 줄)
      if (out.some(q => q.text === wd.text && Math.min(q.x + q.w, wd.x1) - Math.max(q.x, wd.x0) > (wd.x1 - wd.x0) * 0.6 && Math.min(q.y + q.h, wd.y1) - Math.max(q.y, wd.y0) > (wd.y1 - wd.y0) * 0.5)) continue;
      // 낮은 신뢰도, 또는 한 글자짜리 라틴 잡음(o, O, | 등)은 버린다
      if (wd.conf < 50 || (wd.text.length === 1 && !/[\p{Script=Hangul}\p{N}]/u.test(wd.text) && wd.conf < 85)) continue;
      out.push({ text: wd.text, x: wd.x0, y: wd.y0, w: wd.x1 - wd.x0, h: wd.y1 - wd.y0, conf: wd.conf });
    }
  }
  return out;
}
/**
 * 페이지가 몇 도 돌아가 있는지 (0·90·180·270): 글줄 방향으로 후보를 둘로 줄인 뒤,
 * 두 방향으로 조금씩 읽어 보고 더 잘 읽히는 쪽을 고른다
 */
const OK_SCORE = 6000, MIN_SCORE = 2000;
/** 위아래로 띠를 옮겨 가며 어두운 점(글자)이 가장 많은 띠의 위쪽 좌표 */
function inkiestBand(c: HTMLCanvasElement, bandH: number) {
  const k = 200 / c.height, w = Math.max(4, Math.round(c.width * k)), h = 200;
  const s = document.createElement('canvas'); s.width = w; s.height = h;
  const g = s.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, row = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = (y * w + x) * 4; if (d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11 < 140) row[y]++; }
  const bh = Math.round(bandH * k); let best = 0, bs = -1, sum = 0;
  for (let y = 0; y < h; y++) { sum += row[y]; if (y >= bh) sum -= row[y - bh]; if (y >= bh - 1 && sum > bs) { bs = sum; best = y - bh + 1; } }
  return Math.round(best / k);
}
export async function detectOrientation(c: HTMLCanvasElement, onProgress?: (m: string) => void): Promise<0 | 90 | 180 | 270> {
  const sc = await import('../scan/scan.ts');
  const small = sc.toCanvas(c, 1500);
  const side = sc.looksSideways(small);
  const cands: (0 | 90 | 180 | 270)[] = side === true ? [90, 270] : side === false ? [0, 180] : [0, 90, 180, 270];
  const score = async (deg: number) => {
    const r = sc.rotate(small, deg);
    // 글자가 가장 많은 띠를 골라 그 부분만 읽어 시간을 줄인다
    const cw = Math.round(r.width * 0.9), ch = Math.round(r.height * 0.45);
    const top = inkiestBand(r, ch);
    const crop = document.createElement('canvas'); crop.width = cw; crop.height = ch;
    crop.getContext('2d')!.drawImage(r, (r.width - cw) / 2, top, cw, ch, 0, 0, cw, ch);
    const words = await recognize(crop, onProgress, { clean: false, merge: false });
    return words.filter(w => w.conf > 60).reduce((a, w) => a + w.conf * w.text.length, 0);
  };
  const scores: number[] = [];
  for (const d of cands) {
    scores.push(await score(d));
    // 대부분의 문서는 이미 바로 서 있다: 그대로 읽어 충분히 잘 읽히면 더 볼 것 없이 끝
    if (d === 0 && scores[0] >= OK_SCORE) { (window as any).__oriScores = scores; return 0; }
    // 다른 방향이 아주 잘 읽히면 거기서 멈춘다 (틀린 방향은 4천 점 아래, 바른 방향은 1만 점 넘게 나온다)
    if (d !== 0 && scores[scores.length - 1] >= OK_SCORE * 1.5) { (window as any).__oriScores = scores; return d; }
  }
  (window as any).__oriScores = scores;
  let bi = 0; scores.forEach((v, i) => { if (v > scores[bi]) bi = i; });
  // 어느 쪽으로도 잘 안 읽히면(글자가 거의 없거나 그림) 돌리지 않는다
  if (scores[bi] < MIN_SCORE) return 0;
  // 0°(그대로)가 후보이면, 다른 방향이 확실히 더 잘 읽힐 때만 돌린다
  const zero = cands.indexOf(0);
  if (zero >= 0 && bi !== zero && scores[bi] < scores[zero] * 1.25) return 0;
  return cands[bi];
}
export async function stopOcr() { if (workerP) { const w = await workerP.catch(() => null); workerP = null; await w?.terminate?.(); } }

/** 여러 페이지에 글자층 얹기 (편집기와 "이미지 → PDF"가 함께 쓴다). 돌려주는 값으로 되돌리기를 만든다 */
export async function ocrPages(engine: { call: <T = any>(m: string, a?: any[]) => Promise<T> }, docId: number, pages: { index: number; key: number }[],
  o: { skipText?: boolean; progress: (m: string) => void; cancelled?: () => boolean; upright?: boolean }) {
  const changes: any[] = [], rotated: { key: number; turns: number }[] = [];
  let done = 0, words = 0;
  for (const [n, p] of pages.entries()) {
    if (o.cancelled?.()) break;
    if (o.skipText && await engine.call<boolean>('hasText', [docId, p.index])) continue;
    const label = pages.length > 1 ? `${p.index + 1}페이지 (${n + 1}/${pages.length})` : `${p.index + 1}페이지`;
    o.progress(`${label} 글자 인식 중…`);
    const scale = 300 / 72;
    if (o.upright) {
      // 옆으로 눕거나 거꾸로 된 페이지는 먼저 바로 세운다
      const sm: any = await engine.call('render', [docId, p.index, 150 / 72, undefined, false, false]);
      const c = document.createElement('canvas'); c.width = sm.width; c.height = sm.height; c.getContext('2d')!.drawImage(sm.bitmap, 0, 0); sm.bitmap.close?.();
      o.progress(`${label} 방향 확인 중…`);
      const deg = await detectOrientation(c);
      if (deg) { await engine.call('rotatePage', [docId, p.key, deg / 90]); rotated.push({ key: p.key, turns: deg / 90 }); }
    }
    const res: any = await engine.call('render', [docId, p.index, scale, undefined, false]);
    const bmp: ImageBitmap = res.bitmap || await createImageBitmap(new ImageData(res.data, res.width, res.height));
    const found = await recognize(bmp, m => o.progress(`${label} ${m}`));
    bmp.close?.();
    const ch = await engine.call<any>('addOcrLayer', [docId, p.key, found.map(w => ({ text: w.text, x: w.x / scale, y: w.y / scale, w: w.w / scale, h: w.h / scale }))]);
    if (ch.added.length) changes.push(ch);
    words += found.length; done++;
  }
  return { changes, done, words, rotated };
}
