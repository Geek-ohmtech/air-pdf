// 브라우저 시험 4: 선택 도구 복귀, Shift·끌어 여러 개 고르기, 편집 칸 겹침, 색 펼침, 쪽 이동 키, 단축키 저장, 테마, 정보, 로딩
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOT = process.env.SHOT || '/tmp';
const base = 'http://localhost:4173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1360, height: 860 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const ev = (fn, arg) => page.evaluate(fn, arg);
const objs = () => ev(async () => window.__app.engine.call('pageObjects', [window.__app.doc.id, window.__app.view.pages[0].key]));

console.log('시작 화면 / 로딩');
await page.goto(base);
await page.waitForFunction(() => window.__app && !document.getElementById('splash'), null, { timeout: 15000 });
ok(true, '시작 화면이 엔진 준비 뒤 사라짐 (' + Math.round(await ev(() => window.__bootMs)) + 'ms)');
await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });
ok(!(await page.locator('#load-bar.on').count()), '다 열리면 로딩 막대가 꺼짐');
ok(await ev(async () => { const d = window.__app.loading('시험'); const on = document.getElementById('load-bar').classList.contains('on'); d(); return on && !document.getElementById('load-bar').classList.contains('on'); }), '로딩 막대 켜고 끄기');

console.log('쪽 이동 키');
await page.mouse.click(700, 500);
await page.keyboard.press('PageDown'); await page.waitForTimeout(400);
ok(await ev(() => window.__app.view.current) === 1, 'PageDown → 2쪽');
await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
ok(await ev(() => window.__app.view.current) === 2, '→ → 3쪽');
await page.keyboard.press('PageUp'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(500);
ok(await ev(() => window.__app.view.current) === 0, 'PageUp, ← → 1쪽');

console.log('단축키 창: 저장해야 반영');
await page.keyboard.press('F1');
await page.waitForSelector('.modal.keys .key-chip');
const box = await page.locator('.modal.keys').boundingBox();
ok(box.height <= 700, `창 높이 ${Math.round(box.height)}px`);
await page.locator('.modal.keys .modal-body').evaluate(e => e.scrollTop = e.scrollHeight);
ok(await page.locator('.modal.keys .modal-actions .btn.primary').isVisible() && await page.locator('.modal.keys .keys-search').isVisible(), '스크롤해도 찾기 칸·단추 고정');
await page.fill('.keys-search', '전체 화면');
ok(await page.locator('.modal.keys .key-row').count() === 1, '찾기로 걸러 보기');
await page.locator('.modal.keys .key-chip').first().click();
await page.keyboard.press('Control+Shift+F');
ok(await ev(() => !window.__app.shortcuts.keysOf(window.__app.shortcuts.actions.find(a => a.id === 'fullscreen')).includes('Ctrl+Shift+F')), '저장 전에는 반영 안 됨');
await page.click('.modal.keys .btn.primary');
ok(await ev(() => window.__app.shortcuts.keysOf(window.__app.shortcuts.actions.find(a => a.id === 'fullscreen')).includes('Ctrl+Shift+F')), '저장하면 반영');
await page.keyboard.press('F1'); await page.waitForSelector('.modal.keys');
await page.click('.modal.keys .btn.left'); await page.click('.modal.keys .btn.primary');
ok(await ev(() => window.__app.shortcuts.keysOf(window.__app.shortcuts.actions.find(a => a.id === 'fullscreen'))[0] === 'F11'), '기본값으로 되돌리기');

console.log('테마 / 정보');
await page.click('.more-btn'); await page.click('.menu-item:has-text("테마")');
await page.waitForSelector('.modal .theme-opt');
await page.click('.modal .theme-opt:has-text("초록")');
const green = await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
await page.click('.modal .btn:has-text("취소")');
const back = await ev(() => document.documentElement.getAttribute('data-accent'));
ok(green === '#1d7a4c' && back === 'air', `강조색 미리 보기 ${green}, 취소하면 되돌림 (${back})`);
await page.click('.more-btn'); await page.click('.menu-item:has-text("테마")');
await page.click('.modal .theme-opt:has-text("어둡게")'); await page.click('.modal .theme-opt:has-text("보라")'); await page.click('.modal .btn.primary');
ok(await ev(() => JSON.parse(localStorage.getItem('airpdf.prefs')).accent === 'purple' && document.documentElement.dataset.theme === 'dark'), '테마 저장 (어둡게 + 보라)');
await page.screenshot({ path: SHOT + '/h1-theme.png' });
await page.click('.more-btn'); await page.click('.menu-item:has-text("테마")');
await page.click('.modal .theme-opt:has-text("시스템")'); await page.click('.modal .theme-opt:has-text("Air 남색")'); await page.click('.modal .btn.primary');
await page.click('.more-btn'); await page.click('.menu-item:has-text("Air PDF 정보")');
await page.waitForSelector('.modal .about');
ok(/웹판|버전/.test(await page.textContent('.modal .about .ver')), 'Air PDF 정보: ' + await page.textContent('.modal .about .ver'));
await page.keyboard.press('Escape');

console.log('편집: 그린 뒤 선택 도구로');
await page.click('.mode-b[data-m="edit"]'); await page.waitForSelector('.ribbon .rt');
await ev(() => { window.__app.setFit('page'); window.__app.view.scrollToPage(0); }); await page.waitForTimeout(500);
await page.waitForFunction(() => { const r = document.querySelector('.page').getBoundingClientRect(); const ok = window.__lastTop === r.top; window.__lastTop = r.top; return ok && r.top < innerHeight / 2; }, null, { polling: 200, timeout: 8000 }).catch(() => {});
const pg = await page.locator('.page[data-i="0"]').boundingBox(); const z = await ev(() => window.__app.view.zoom);
const at = (x, y) => [pg.x + x * z, pg.y + y * z];
const drawRect = async (x, y, w, h) => { await page.click('.rt[data-tool="rect"]'); await page.mouse.move(...at(x, y)); await page.mouse.down(); await page.mouse.move(...at(x + w, y + h), { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(700); };
await drawRect(80, 560, 80, 50);
ok(await ev(() => window.__app.editor.tool) === 'select' && await ev(() => window.__app.editor.sel?.obj?.type) === 'shape', '사각형 그린 뒤 선택 도구 + 방금 그린 것 골라짐');
await drawRect(220, 560, 80, 50);
// 두 번 눌러 고정
await page.dblclick('.rt[data-tool="line"]');
for (const y of [640, 660]) { await page.mouse.move(...at(80, y)); await page.mouse.down(); await page.mouse.move(...at(200, y), { steps: 3 }); await page.mouse.up(); await page.waitForTimeout(600); }
ok(await ev(() => window.__app.editor.tool) === 'line', '도구를 두 번 누르면 계속 쓰기 (선 2개)');
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

console.log('여러 개 고르기');
await page.click('.rt[data-tool="select"]');
let shapes = (await objs()).filter(o => o.type === 'shape' && o.meta.kind === 'rect');
await page.mouse.click(...at(shapes[0].rect.x + 1, shapes[0].rect.y + 20));
await page.keyboard.down('Shift'); await page.mouse.click(...at(shapes[1].rect.x + 1, shapes[1].rect.y + 20)); await page.keyboard.up('Shift');
await page.waitForTimeout(300);
ok(await ev(() => window.__app.editor.allSel().length) === 2, 'Shift+클릭으로 2개 고름');
await page.screenshot({ path: SHOT + '/h2-multi.png' });
const x0 = shapes.map(s => s.rect.x);
await page.mouse.move(...at(shapes[0].rect.x + 1, shapes[0].rect.y + 20)); await page.mouse.down();
await page.mouse.move(...at(shapes[0].rect.x + 31, shapes[0].rect.y + 20), { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(800);
shapes = (await objs()).filter(o => o.type === 'shape' && o.meta.kind === 'rect');
ok(shapes.every((s, i) => Math.abs(s.rect.x - x0[i] - 30) < 2), '둘을 함께 옮김');
await page.mouse.click(...at(560, 800)); await page.waitForTimeout(200);
// 끌어서 범위로 고르기 (선 2개)
await page.mouse.move(...at(70, 630)); await page.mouse.down(); await page.mouse.move(...at(215, 675), { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(500);
ok(await ev(() => window.__app.editor.allSel().length) === 2, '빈 곳에서 끌어 범위 안의 선 2개 고름');
const n0 = (await objs()).length;
await page.keyboard.press('Delete'); await page.waitForTimeout(800);
ok((await objs()).length === n0 - 2, '고른 2개를 한 번에 지움');
await page.keyboard.press('Control+z'); await page.waitForTimeout(800);
ok((await objs()).length === n0, '한 번에 되돌림');

console.log('편집 칸이 열리면 선택 표시 없음');
await page.click('.rt[data-tool="addText"]');
await page.mouse.click(...at(330, 700)); await page.waitForSelector('textarea.ed-text.new');
await page.keyboard.type('dddd'); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
ok(await ev(() => window.__app.editor.tool) === 'select', '글자 넣은 뒤 선택 도구');
const run = (await ev(async () => (await window.__app.engine.call('textRuns', [window.__app.doc.id, window.__app.view.pages[0].key])).find(r => r.text === 'dddd')));
await page.mouse.dblclick(...at(run.rect.x + 4, run.rect.y + run.rect.h / 2)); await page.waitForSelector('textarea.ed-text');
const ta = await page.locator('textarea.ed-text').boundingBox();
ok(await page.locator('.page .ed .sel-box, .page .ed .hover-box').count() === 0, '고치는 동안 선택·올림 상자 안 그림');
ok(ta.width < (run.rect.w + 40) * z, `입력 칸 폭이 글자에 맞음 (${Math.round(ta.width)}px, 글자 ${Math.round(run.rect.w * z)}px)`);
await page.screenshot({ path: SHOT + '/h3-edit.png', clip: { x: pg.x + 250 * z, y: pg.y + 660 * z, width: 260 * z, height: 90 * z } });
await page.keyboard.press('Escape');

console.log('색 펼침');
await page.mouse.click(...at(run.rect.x + 4, run.rect.y + run.rect.h / 2)); await page.waitForTimeout(300);
await page.locator('.rb-props .color-btn').first().click();
ok(await page.locator('.color-pop .sw').count() >= 70, '색표가 펼쳐짐 (' + await page.locator('.color-pop .sw').count() + '색)');
await page.screenshot({ path: SHOT + '/h4-colors.png' });
await page.locator('.color-pop .sw[aria-label="색 #0070c0"]').click();
await page.waitForTimeout(700);
ok(!(await page.locator('.color-pop').count()), '고르면 닫힘');
const c = (await ev(async () => (await window.__app.engine.call('textRuns', [window.__app.doc.id, window.__app.view.pages[0].key])).find(r => r.text === 'dddd')))?.color;
ok(c === '#0070c0', '고른 색 적용: ' + c);
await page.locator('.rb-props .color-btn').first().click();
ok(await page.locator('.color-pop .cp-h:has-text("최근")').count() === 1, '최근 쓴 색 줄');
await page.keyboard.press('Escape');
ok(!(await page.locator('.color-pop').count()), 'Esc로 닫힘');

console.log('편집 모드 쪽 목록 끌기');
const k0 = await ev(() => window.__app.view.pages.map(p => p.key));
await page.locator('.thumb').nth(0).dragTo(page.locator('.thumb').nth(2), { targetPosition: { x: 40, y: 70 } });
await page.waitForTimeout(900);
const k1 = await ev(() => window.__app.view.pages.map(p => p.key));
ok(k1[0] === k0[1] && k1.indexOf(k0[0]) === 1, '편집 모드에서도 끌어서 순서 바꾸기: ' + k1.slice(0, 4).join(','));

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
