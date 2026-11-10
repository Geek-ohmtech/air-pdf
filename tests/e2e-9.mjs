// 브라우저 시험 9: 인쇄 (용지에 맞추기 기본, 페이지 범위, 팩스·흑백 프린터용)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOT = process.env.SHOT || '/tmp';
const base = 'http://localhost:4173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const ev = (fn, arg) => page.evaluate(fn, arg);
await page.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });
const n = await ev(() => window.__app.doc.info.pageCount);

console.log('인쇄 창');
await page.mouse.click(700, 400);
await page.keyboard.press('Control+p'); await page.waitForSelector('.modal .print-opts');
ok(await page.isChecked('input[name="pr-fit"][value="fit"]'), '“용지에 맞추기”가 기본');
ok(await page.isChecked('input[name="pr-color"][value="color"]') && await page.isChecked('input[name="pr-q"][value="std"]'), '색상 기본은 컬러, 품질은 표준');
await page.click('.modal .btn.primary');
await page.waitForFunction(() => window.__printed === 1, null, { timeout: 60000 });
const pp = await ev(() => ({ n: document.querySelectorAll('#print-root .pp').length, fit: document.getElementById('print-root').classList.contains('fit'), css: document.getElementById('print-page-style')?.textContent }));
ok(pp.n === n && pp.fit, `전체 ${n}페이지를 맞추기로 준비`);
const pdf = await page.pdf({ preferCSSPageSize: true });
const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
ok(pdfPages === n, `인쇄 결과도 ${n}장 (넘쳐서 빈 장이 생기지 않음): ${pdfPages}장`);
await page.emulateMedia({ media: 'print' });
const fits = await ev(() => [...document.querySelectorAll('#print-root .pp')].every(p => { const r = p.getBoundingClientRect(), i = p.querySelector('img').getBoundingClientRect(); return i.width <= r.width + 1 && i.height <= r.height + 1; }));
ok(fits, '모든 페이지 그림이 한 장 안에 들어감');
await page.emulateMedia({ media: 'screen' });
await ev(() => window.dispatchEvent(new Event('afterprint')));
ok(!(await ev(() => document.getElementById('print-root'))), '인쇄가 끝나면 준비한 것을 지움');

console.log('범위 + 흑백 고품질');
await page.keyboard.press('Control+p'); await page.waitForSelector('.modal .print-opts');
await page.fill('.print-opts input[aria-label="인쇄할 페이지"]', '1-2, 4');
await page.check('input[name="pr-color"][value="bw"]'); await page.check('input[name="pr-q"][value="high"]');
await page.click('.modal .btn.primary');
await page.waitForFunction(() => window.__printed === 2, null, { timeout: 60000 });
const fx = await ev(async () => {
  const imgs = [...document.querySelectorAll('#print-root img')];
  const im = imgs[0]; await im.decode();
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let mid = 0, black = 0;
  for (let j = 0; j < d.length; j += 4) { if (d[j] > 10 && d[j] < 245) mid++; if (d[j] < 10) black++; }
  return { count: imgs.length, mid, black, w: im.naturalWidth };
});
ok(fx.count === 3, '“1-2, 4” → 3페이지');
ok(fx.mid === 0 && fx.black > 1000, `흑백(회색 없음), 검은 점 ${fx.black}개`);
ok(fx.w >= 2400, `고품질은 300dpi (폭 ${fx.w}px)`);
ok(await ev(() => window.__app.prefs.print?.color === 'bw' && window.__app.prefs.print?.quality === 'high'), '고른 색상·품질을 기억');
await ev(() => window.dispatchEvent(new Event('afterprint')));


console.log('흑백: 사진은 망점, 글자는 또렷');
const ph = await ev(async () => {
  const a = window.__app;
  const bytes = new Uint8Array(await (await fetch('fixtures/photo.jpg')).arrayBuffer());
  await a.engine.call('addImage', [a.doc.id, a.view.pages[0].key, { kind: 'jpg', bytes, x: 60, y: 420, w: 320, h: 240 }]);
  const root = await a.preparePrint([0], { fit: 'fit', color: 'bw', quality: 'std' });
  const im = root.querySelector('img'); await im.decode();
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const k = c.width / a.doc.info.pages[0].w;
  // 사진 자리 (위에서부터): x 60~380, y 420~660
  const box = g.getImageData(Math.round(80 * k), Math.round(440 * k), Math.round(280 * k), Math.round(200 * k)).data;
  let blk = 0; for (let j = 0; j < box.length; j += 4) if (box[j] < 128) blk++;
  root.remove(); document.getElementById('print-page-style')?.remove();
  return blk / (box.length / 4);
});
ok(ph > 0.15 && ph < 0.85, `사진 자리가 하얗게 날아가거나 새까맣지 않고 망점으로 (검정 ${(ph * 100).toFixed(0)}%)`);

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
