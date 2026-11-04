// 브라우저 시험: node tests/e2e.mjs  (먼저 npm run build && vite preview --port 4173)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOT = process.env.SHOT || '/tmp';
const base = 'http://localhost:4173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', e => errs.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });

console.log('보기 모드');
await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 15000 });
await page.waitForTimeout(600);
const m = await page.evaluate(() => ({ boot: window.__bootMs, open: window.__openMs, render: window.__lastRenderMs, pages: window.__app.doc.info.pageCount }));
ok(m.pages === 12, `12쪽 문서 열림 (시작 ${m.boot?.toFixed(0)}ms, 열기 ${m.open?.toFixed(0)}ms, 쪽 렌더 ${m.render?.toFixed(0)}ms)`);
await page.screenshot({ path: SHOT + '/e1-view.png' });

// 글자 끌어 선택 + 복사
const pg = await page.locator('.page').first().boundingBox();
const z = await page.evaluate(() => window.__app.view.zoom);
await page.mouse.move(pg.x + 66 * z, pg.y + 128 * z);
await page.waitForTimeout(300);
await page.mouse.down(); await page.mouse.move(pg.x + 300 * z, pg.y + 130 * z, { steps: 6 }); await page.mouse.up();
const sel = await page.evaluate(() => window.__app.view.selectedText());
ok(sel.startsWith('제1조'), '글자 선택: ' + sel.slice(0, 20));

// 찾기
await page.fill('.search-input', '계약 금액');
await page.press('.search-input', 'Enter');
await page.waitForFunction(() => document.querySelector('.search-head b'), null, { timeout: 8000 });
const found = await page.textContent('.search-head');
ok(/22건/.test(found), '찾기: ' + found.trim());
await page.screenshot({ path: SHOT + '/e2-search.png' });
await page.keyboard.press('Escape');

console.log('편집 모드');
await page.click('.mode-b[data-m="edit"]');
await page.waitForSelector('.ribbon .rt');
await page.evaluate(() => { window.__app.setFit('page'); window.__app.view.scrollToPage(0); });
await page.waitForTimeout(500);
// 원본 글자 고치기
await page.click('.rt[data-tool="editText"]');
await page.waitForTimeout(500);
const pg2 = await page.locator('.page').first().boundingBox();
const z2 = await page.evaluate(() => window.__app.view.zoom);
await page.mouse.click(pg2.x + 120 * z2, pg2.y + (120 + 11 * 1.25 + 8) * z2);
await page.waitForSelector('textarea.ed-text');
const before = await page.inputValue('textarea.ed-text');
await page.fill('textarea.ed-text', '제2조 (계약 금액) 총 계약 금액은 금 31,500,000원(부가세 별도)으로 한다.');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const txt = await page.evaluate(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 0])).text);
ok(before.startsWith('제2조') && txt.includes('31,500,000원'), '원본 글자 고침 (고치기 전: ' + before.slice(0, 18) + '…)');
await page.screenshot({ path: SHOT + '/e3-edited.png' });
// 글자 추가
await page.click('.rt[data-tool="addText"]');
await page.mouse.click(pg2.x + 360 * z2, pg2.y + 470 * z2);
await page.waitForSelector('textarea.ed-text.new');
await page.keyboard.type('검토 완료 – 홍길동');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const added = await page.evaluate(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 0])).text);
ok(added.includes('검토 완료 – 홍길동'), '새 글자 추가');
// 선택해서 끌어 옮기기
const runY = async () => (await page.evaluate(async () => { const k = window.__app.view.pages[0].key; return (await window.__app.engine.call('textRuns', [window.__app.doc.id, k])).find(r => r.text.includes('검토 완료'))?.rect.y; }));
const y0 = await runY();
await page.click('.rt[data-tool="select"]');
await page.waitForTimeout(400);
await page.mouse.move(pg2.x + 380 * z2, pg2.y + (y0 + 6) * z2); await page.waitForTimeout(150);
await page.mouse.down(); await page.mouse.move(pg2.x + 380 * z2, pg2.y + (y0 + 46) * z2, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(700);
const y1 = await runY();
ok(Math.abs(y1 - y0 - 40) < 2, `글자 줄 옮기기 (${y0.toFixed(1)} → ${y1.toFixed(1)})`);
// 도형
const paths0 = await page.evaluate(async () => (await window.__app.engine.call('pageObjects', [window.__app.doc.id, window.__app.view.pages[0].key])).length);
await page.click('.rt[data-tool="rect"]');
await page.mouse.move(pg2.x + 420 * z2, pg2.y + 600 * z2); await page.mouse.down(); await page.mouse.move(pg2.x + 520 * z2, pg2.y + 660 * z2, { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(600);
const paths1 = await page.evaluate(async () => (await window.__app.engine.call('pageObjects', [window.__app.doc.id, window.__app.view.pages[0].key])).length);
ok(paths1 === paths0 + 1, '사각형 도형 추가');
// 영역 삭제 (Payment 줄)
await page.click('.rt[data-tool="redact"]');
const payY = 120 + 11 * 1.25 * 5;
await page.mouse.move(pg2.x + 60 * z2, pg2.y + (payY + 1) * z2); await page.mouse.down(); await page.mouse.move(pg2.x + 540 * z2, pg2.y + (payY + 13) * z2, { steps: 4 }); await page.mouse.up();
await page.waitForSelector('.modal .btn.danger');
await page.click('.modal .btn.danger');
await page.waitForTimeout(800);
const afterRedact = await page.evaluate(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 0])).text);
ok(!afterRedact.includes('Payment') && afterRedact.includes('제5조'), '영역 삭제: 그 줄만 실제로 사라짐');
// 표
await page.click('.rt[data-tool="table"]');
await page.mouse.move(pg2.x + 64 * z2, pg2.y + 500 * z2); await page.mouse.down(); await page.mouse.move(pg2.x + 400 * z2, pg2.y + 560 * z2, { steps: 5 }); await page.mouse.up();
await page.waitForSelector('.modal');
await page.fill('.modal input[type=number] >> nth=0', '2');
await page.fill('.modal input[type=number] >> nth=1', '3');
await page.click('.modal .btn.primary');
await page.waitForSelector('.tbl-cell');
const cells = ['구분', '담당', '일정', '설계', '김철수', '1주차'];
for (let i = 0; i < cells.length; i++) await page.fill(`.tbl-cell >> nth=${i}`, cells[i]);
await page.screenshot({ path: SHOT + '/e4-table-edit.png' });
await page.click('.tbl-bar .btn.primary');
await page.waitForTimeout(900);
// 주석: 형광펜 + 메모
await page.click('.rb-tab[data-t="annot"]');
await page.click('.rt[data-tool="highlight"]');
await page.mouse.move(pg2.x + 66 * z2, pg2.y + (120 + 11 * 1.25 * 2 + 8) * z2); await page.mouse.down();
await page.mouse.move(pg2.x + 380 * z2, pg2.y + (120 + 11 * 1.25 * 2 + 8) * z2, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(700);
await page.click('.rt[data-tool="note"]');
await page.mouse.click(pg2.x + 520 * z2, pg2.y + 140 * z2);
await page.waitForSelector('.modal textarea');
await page.fill('.modal textarea', '기간 연장 조건 확인 필요');
await page.click('.modal .btn.primary');
await page.waitForTimeout(800);
const annots = await page.evaluate(async () => (await window.__app.engine.call('annots', [window.__app.doc.id, 0])).map(a => a.kind + ':' + a.contents));
ok(annots.length === 2 && annots.some(a => a.includes('기간 연장')), '주석 2개: ' + annots.join(' | '));
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/e5-annots.png' });
// 되돌리기 / 다시 하기
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
const afterUndo = (await page.evaluate(async () => (await window.__app.engine.call('annots', [window.__app.doc.id, 0])).length));
await page.keyboard.press('Control+y');
await page.waitForTimeout(500);
const afterRedo = (await page.evaluate(async () => (await window.__app.engine.call('annots', [window.__app.doc.id, 0])).length));
ok(afterUndo === 1 && afterRedo === 2, `되돌리기 ${afterUndo}개 → 다시 하기 ${afterRedo}개`);

console.log('글자 인식 (OCR)');
await page.click('.rb-tab[data-t="tools"]');
await page.evaluate(() => window.__app.view.scrollToPage(2));
await page.waitForTimeout(500);
await page.click('.rt:has-text("글자 인식")');
await page.click('.modal .btn.primary');
await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 180000 });
const ocrText = await page.evaluate(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 2])).text);
ok(ocrText.includes('계약') && ocrText.length > 80, `스캔 쪽 인식: “${ocrText.replace(/\s+/g, ' ').slice(0, 40)}…”`);

console.log('쪽 다루기 / 저장');
await page.click('.rb-tab[data-t="page"]');
await page.evaluate(() => window.__app.view.scrollToPage(5));
await page.waitForTimeout(300);
await page.click('.rt:has-text("쪽 삭제")');
await page.waitForTimeout(600);
await page.click('.rt:has-text("오른쪽 회전")');
await page.waitForTimeout(600);
const pc = await page.evaluate(() => window.__app.doc.info.pageCount);
ok(pc === 11, '쪽 삭제 → 11쪽');
await page.screenshot({ path: SHOT + '/e6-pages.png' });
const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const savedPath = SHOT + '/saved.pdf';
await dl.saveAs(savedPath);
ok(true, '저장 파일 받음: ' + dl.suggestedFilename());

console.log('암호 문서');
await page.evaluate(() => { window.__app.doc.dirty = false; });
await page.goto(base + '?file=fixtures/locked.pdf');
await page.waitForSelector('.modal input[type=password]');
await page.fill('.modal input[type=password]', '0000'); await page.keyboard.press('Enter');
await page.waitForSelector('.modal .err');
ok(true, '틀린 암호에 오류 표시');
await page.screenshot({ path: SHOT + '/e7-password.png' });
await page.fill('.modal input[type=password]', '1234'); await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__app?.doc?.info.encrypted, null, { timeout: 8000 });
ok(true, '맞는 암호로 열림');

console.log('어두운 테마 / 좁은 화면');
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(400);
await page.screenshot({ path: SHOT + '/e8-dark.png' });
await page.setViewportSize({ width: 420, height: 800 });
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT + '/e9-narrow.png' });

ok(errs.length === 0, '콘솔 오류 없음' + (errs.length ? ': ' + errs.slice(0, 4).join(' / ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
