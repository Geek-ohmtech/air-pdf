// 브라우저 시험 6: 다시 OCR, 스캔 글자 고치기, 방향 바로 세우기, 스캔 페이지 바탕 그림, 한꺼번에 처리, 저장하고 닫기
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOT = process.env.SHOT || '/tmp';
const base = 'http://localhost:4173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', e => errs.push('pageerror ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' / ')));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const ev = (fn, arg) => page.evaluate(fn, arg);
await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
const runsOf = i => ev(async i => window.__app.engine.call('textRuns', [window.__app.doc.id, window.__app.view.pages[i].key]), i);
const waitIdle = (t = 240000) => page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: t, polling: 400 });

await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });
await page.click('.mode-b[data-m="edit"]'); await page.waitForSelector('.ribbon .rt');
await ev(() => { window.__app.setFit('page'); window.__app.view.scrollToPage(2); }); await page.waitForTimeout(700); // 3페이지: 그림만 있는 스캔 페이지

console.log('스캔 페이지 바탕 그림');
const pg = await page.locator('.page').nth(2).boundingBox(); const z = await ev(() => window.__app.view.zoom);
await page.click('.rt[data-tool="select"]');
await page.mouse.click(pg.x + 300 * z, pg.y + 400 * z); await page.waitForTimeout(300);
ok(!(await ev(() => window.__app.editor.sel)), '페이지 전체 그림은 눌러도 덩어리로 안 잡힘');
await page.keyboard.down('Alt'); await page.mouse.click(pg.x + 300 * z, pg.y + 400 * z); await page.keyboard.up('Alt'); await page.waitForTimeout(300);
ok(await ev(() => window.__app.editor.sel?.obj?.type) === 'image', 'Alt+클릭으로는 그림을 고를 수 있음');
await page.keyboard.press('Escape');

console.log('거꾸로 된 페이지 + OCR (바로 세우기)');
await ev(async () => { const a = window.__app; await a.engine.call('rotatePage', [a.doc.id, a.view.pages[2].key, 2]); await a.reloadPages(2); });
await page.waitForTimeout(500);
await page.click('.rb-tab[data-t="tools"]'); await page.click('.rt:has-text("글자 인식")');
await page.waitForSelector('.modal select');
await page.click('.modal .btn.primary');
await waitIdle();
ok(/1페이지는 바로 세웠습니다/.test(await page.textContent('#toast')), '거꾸로 된 페이지를 바로 세운 뒤 인식: ' + await page.textContent('#toast'));
const firstText = await ev(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 2])).text);
const n1 = (await runsOf(2)).filter(r => r.invisible).length;
ok(n1 > 5, `글자층 ${n1}줄`);

console.log('다시 OCR');
await page.click('.rt:has-text("글자 인식")'); await page.waitForSelector('.modal select');
await page.click('.modal .btn.primary');
const done2 = await waitIdle(120000).then(() => true).catch(() => false);
ok(done2, '두 번째 인식도 끝남 (100%에서 멈추지 않음)');
const n2 = (await runsOf(2)).filter(r => r.invisible).length;
const secondText = await ev(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 2])).text);
ok(Math.abs(n2 - n1) <= 2, `예전 글자층을 바꿈 (겹치지 않음): ${n1} → ${n2}줄`);
if (Math.abs(n2 - n1) > 2) console.log('    1차:', firstText.slice(0, 300).replace(/\n/g, ' ⏎ '), '\n    2차:', secondText.slice(0, 300).replace(/\n/g, ' ⏎ '));
const t2 = await ev(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 2])).text);
ok(!/(\S{2,})\1/.test(t2.replace(/\s+/g, '').slice(0, 30)) , '같은 글자가 겹쳐 들어가지 않음');

console.log('스캔 글자 고치기');
await page.click('.rb-tab[data-t="edit"]'); await page.click('.rt[data-tool="editText"]'); await page.waitForTimeout(600);
const runs = await runsOf(2);
const target = runs.find(r => r.invisible && /계약/.test(r.text)) || runs.find(r => r.invisible && r.text.length > 4);
await ev(r => window.__app.view.scrollToRect(2, r.rect), target); await page.waitForTimeout(500);
const pg3 = await page.locator('.page').nth(2).boundingBox();
await page.mouse.click(pg3.x + (target.rect.x + 3) * z, pg3.y + (target.rect.y + target.rect.h / 2) * z);
await page.waitForSelector('textarea.ed-text.ocr');
await page.fill('textarea.ed-text', '고친 스캔 글자'); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
const vis = (await runsOf(2)).find(r => !r.invisible && r.text === '고친 스캔 글자');
ok(!!vis, '스캔 글자를 보이는 글자로 고침 (그림 글자는 종이색으로 덮음)');
await page.screenshot({ path: SHOT + '/j1-ocr-edit.png', clip: { x: pg3.x + (target.rect.x - 30) * z, y: pg3.y + (target.rect.y - 20) * z, width: (target.rect.w + 160) * z, height: (target.rect.h + 40) * z } });
await page.keyboard.press('Control+z'); await page.waitForTimeout(800);
ok(!(await runsOf(2)).some(r => r.text === '고친 스캔 글자'), '되돌리기');

console.log('저장하지 않고 닫기 / 저장하고 닫기');
await page.keyboard.press('Control+w'); await page.waitForSelector('.modal');
const btns = await page.locator('.modal .modal-actions .btn').allTextContents();
ok(btns.join() === '취소,저장하지 않고 닫기,저장하고 닫기', '닫기 단추 셋: ' + btns.join(' | '));
const dl = page.waitForEvent('download');
await page.click('.modal .btn.primary');
const d = await dl;
ok((await d.path()) && fs.statSync(await d.path()).size > 1000, '저장하고 닫기 → 저장됨');
await page.waitForTimeout(800);
ok(await ev(() => window.__app.tabs.length) === 0, '닫힘');

console.log('여러 파일 한꺼번에 처리');
await page.goto(base);
await page.waitForFunction(() => window.__app && !document.getElementById('splash'));
ev(async () => {
  const get = async u => ({ name: u.split('/').pop(), bytes: new Uint8Array(await (await fetch(u)).arrayBuffer()) });
  const t = await window.__mods.tools();
  t.batchProcess(window.__app, [await get('fixtures/sample.pdf'), await get('fixtures/payslip.pdf')]);
});
await page.waitForSelector('.modal .batch-list li');
ok(await page.locator('.modal .batch-list li').count() === 2, '파일 2개');
await page.locator('.modal .suggest .chk').nth(1).locator('input').uncheck(); // 방향 확인은 빼서 빠르게
const dl2 = page.waitForEvent('download', { timeout: 300000 });
await page.click('.modal .btn.primary');
const z2 = await dl2; const zp = SHOT + '/batch.zip'; await z2.saveAs(zp);
const zb = fs.readFileSync(zp);
const names = [...zb.toString('utf8').matchAll(/([^\x00/]+_처리\.pdf)/g)].map(m => m[1]);
ok(new Set(names).size === 2, 'ZIP 안에 처리한 PDF 2개: ' + [...new Set(names)].join(', '));
await waitIdle();
const toastT = await page.textContent('#toast');
ok(/2개 파일을 처리/.test(toastT), toastT);

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
