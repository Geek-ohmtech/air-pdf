// 브라우저 시험 3: 넣은 뒤 글자 꾸미기, 글꼴, 글상자, 자유선, 도형 후편집, 이미지 자유 크기, 쪽 목록, 단축키, 나누기·합치기
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOT = process.env.SHOT || '/tmp';
const FX = new URL('./fixtures/', import.meta.url).pathname;
const base = 'http://localhost:4173/';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', e => errs.push('pageerror ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
await page.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
const ev = (fn, arg) => page.evaluate(fn, arg);
const objs = () => ev(async () => window.__app.engine.call('pageObjects', [window.__app.doc.id, window.__app.view.pages[0].key]));
const runs = () => ev(async () => window.__app.engine.call('textRuns', [window.__app.doc.id, window.__app.view.pages[0].key]));

await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });

console.log('쪽 목록 (보기 모드)');
const order = () => ev(() => window.__app.view.pages.map(p => p.key));
const k0 = await order();
const t1 = page.locator('.thumb').nth(0), t3 = page.locator('.thumb').nth(2);
await t1.dragTo(t3, { targetPosition: { x: 40, y: 60 } });
await page.waitForTimeout(800);
const k1 = await order();
ok(k1[0] === k0[1] && k1.indexOf(k0[0]) > 0, '끌어서 쪽 순서 바꾸기: ' + k1.slice(0, 4).join(','));
await page.locator('.thumb').nth(11).click();
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
if (await page.locator('.modal .btn.danger').count()) await page.click('.modal .btn.danger');
await page.waitForTimeout(800);
ok(await ev(() => window.__app.doc.info.pageCount) === 11, 'Delete로 쪽 지우기 → 11쪽');
await page.keyboard.press('Control+z'); await page.waitForTimeout(800);
ok(await ev(() => window.__app.doc.info.pageCount) === 12, 'Ctrl+Z로 되살리기');

console.log('단축키');
await page.keyboard.press('F1');
await page.waitForSelector('.modal .keys-wrap');
ok(await page.locator('.modal .key-chip').count() > 30, '단축키 창 (' + await page.locator('.modal .key-chip').count() + '개)');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.mouse.click(700, 400);
await page.keyboard.press('Control+e');
await page.waitForSelector('.ribbon .rt');
ok(await ev(() => window.__app.mode) === 'edit', 'Ctrl+E로 편집 모드');
await ev(() => { window.__app.setFit('page'); window.__app.view.scrollToPage(0); });
await page.waitForTimeout(500);
await page.mouse.click(700, 400);
await page.keyboard.press('t');
ok(await page.locator('.rt[data-tool="addText"][aria-pressed="true"]').count() === 1, 'T로 글자 넣기 도구');

const pg = await page.locator('.page').first().boundingBox();
const z = await ev(() => window.__app.view.zoom);
const at = (x, y) => [pg.x + x * z, pg.y + y * z];

console.log('넣은 뒤 글자 꾸미기');
await page.mouse.click(...at(330, 430));
await page.waitForSelector('textarea.ed-text.new');
await page.keyboard.type('나중에 꾸밀 글자');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
ok(await ev(() => window.__app.editor.sel?.kind) === 'run', '넣은 글자가 골라져 있음');
const red = '#d0342c';
await page.locator('.rb-props .color-btn').first().click();
await page.locator('.color-pop .sw[aria-label="색 #d0342c"]').first().click();
await page.waitForTimeout(700);
let r = (await runs()).find(x => x.text.includes('나중에 꾸밀'));
ok(r && r.color.toLowerCase() === red, '넣은 뒤 색 바꾸기: ' + r?.color);
const s0 = r.size;
await page.locator('.rb-props input.num').first().fill('22');
await page.locator('.rb-props input.num').first().press('Enter');
await page.waitForTimeout(800);
r = (await runs()).find(x => x.text.includes('나중에 꾸밀'));
ok(r && Math.abs(r.size - 22) < 0.6, `넣은 뒤 크기 바꾸기 ${s0} → ${r?.size?.toFixed(1)}`);
await page.locator('.rb-props select.font-sel').first().selectOption('nanum-myeongjo');
await page.waitForTimeout(1500);
r = (await runs()).find(x => x.text.includes('나중에 꾸밀'));
ok(r && /myeongjo/i.test(r.font), '넣은 뒤 글꼴 바꾸기: ' + r?.font);
await page.keyboard.press('Control+z'); await page.waitForTimeout(800);
r = (await runs()).find(x => x.text.includes('나중에 꾸밀'));
ok(r && !/myeongjo/i.test(r.font), '글꼴 바꾸기 되돌리기');
await page.screenshot({ path: SHOT + '/g1-restyle.png' });

console.log('글상자');
await page.click('.rt[data-tool="textbox"]');
await page.mouse.move(...at(320, 520)); await page.mouse.down(); await page.mouse.move(...at(500, 580), { steps: 5 }); await page.mouse.up();
await page.waitForSelector('textarea.ed-text.box');
await page.keyboard.type('글상자 안의 글은 폭에 맞춰 자동으로 줄이 바뀝니다. Air PDF');
await page.mouse.click(...at(80, 790));
await page.waitForTimeout(1200);
let tb = (await objs()).find(o => o.type === 'textbox');
ok(tb && tb.meta.text.startsWith('글상자') && tb.rect.w > 170 && tb.rect.h > 40, `글상자 넣기 ${tb?.rect.w.toFixed(0)}×${tb?.rect.h.toFixed(0)}`);
await page.mouse.click(...at(tb.rect.x + 10, tb.rect.y + 10));
await page.waitForTimeout(400);
ok(await ev(() => window.__app.editor.sel?.obj?.type) === 'textbox', '글상자 고르기');
await page.locator('.rb-props .color-btn').nth(1).click();
await page.locator('.color-pop .sw[aria-label="색 #2b59c3"]').first().click();
await page.waitForTimeout(900);
tb = (await objs()).find(o => o.type === 'textbox');
ok(tb?.meta.border === '#2b59c3', '글상자 테두리 색 바꾸기');
// 오른쪽 가운데 손잡이로 폭 넓히기 → 줄 수가 줄어든다
const h0 = tb.rect.h;
await page.mouse.move(...at(tb.rect.x + tb.rect.w, tb.rect.y + tb.rect.h / 2)); await page.waitForTimeout(100);
await page.mouse.down(); await page.mouse.move(...at(tb.rect.x + tb.rect.w + 160, tb.rect.y + tb.rect.h / 2), { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(1000);
tb = (await objs()).find(o => o.type === 'textbox');
ok(tb && tb.rect.w > 250 && tb.rect.x + tb.rect.w <= 600 && tb.rect.h < h0, `글상자 폭 넓히면 다시 짜기 (높이 ${h0.toFixed(0)} → ${tb?.rect.h.toFixed(0)}, 폭 ${tb?.rect.w.toFixed(0)}, 쪽 밖으로 안 나감)`);
// 두 번 눌러 내용 고치기
await page.mouse.dblclick(...at(tb.rect.x + 20, tb.rect.y + 12));
await page.waitForSelector('textarea.ed-text.box');
await page.keyboard.press('Control+a'); await page.keyboard.type('고친 글상자');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(1000);
tb = (await objs()).find(o => o.type === 'textbox');
ok(tb?.meta.text === '고친 글상자', '글상자 내용 고치기');
await page.screenshot({ path: SHOT + '/g2-textbox.png' });

console.log('자유선');
await page.click('.rt[data-tool="free"]');
const n0 = (await objs()).length;
await page.mouse.move(...at(80, 700)); await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(...at(80 + i * 8, 700 + Math.sin(i / 2) * 20));
await page.mouse.up();
await page.waitForTimeout(800);
const fr = (await objs()).find(o => o.type === 'free');
ok((await objs()).length === n0 + 1 && fr, '자유선 넣기');

console.log('도형 후편집');
await page.click('.rt[data-tool="rect"]');
await page.mouse.move(...at(380, 640)); await page.mouse.down(); await page.mouse.move(...at(480, 700), { steps: 4 }); await page.mouse.up();
await page.waitForTimeout(700);
await page.click('.rt[data-tool="select"]');
let sh = (await objs()).find(o => o.type === 'shape');
await page.mouse.click(...at(sh.rect.x + 1, sh.rect.y + sh.rect.h / 2));
await page.waitForTimeout(400);
ok(await ev(() => window.__app.editor.sel?.obj?.type) === 'shape', '도형 고르기');
await page.locator('.rb-props input.num').first().fill('4');
await page.locator('.rb-props input.num').first().press('Enter');
await page.waitForTimeout(800);
sh = (await objs()).find(o => o.type === 'shape');
ok(sh?.meta.width === 4, '도형 선 굵기 바꾸기');
await page.mouse.move(...at(sh.rect.x + sh.rect.w, sh.rect.y + sh.rect.h)); await page.waitForTimeout(100);
const cur = await ev(() => getComputedStyle(document.querySelector('.page .pg-edit') || document.body).cursor + '|' + [...document.querySelectorAll('.page')].map(p => getComputedStyle(p).cursor).join(','));
ok(/resize/.test(cur), '손잡이 위 커서: ' + cur.split('|')[0]);
const w0 = sh.rect.w, hh0 = sh.rect.h;
await page.mouse.down(); await page.mouse.move(...at(sh.rect.x + sh.rect.w + 60, sh.rect.y + sh.rect.h + 10), { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(900);
sh = (await objs()).find(o => o.type === 'shape');
ok(sh && sh.rect.w > w0 + 50 && sh.rect.h < hh0 + 20, `도형 비율 따로 크기 바꾸기 ${w0.toFixed(0)}×${hh0.toFixed(0)} → ${sh?.rect.w.toFixed(0)}×${sh?.rect.h.toFixed(0)} (굵기 ${sh?.meta.width})`);

console.log('이미지 자유 크기');
const hasImg = async () => (await objs()).find(o => o.type === 'image');
if (!await hasImg()) {
  // 이미지 넣기: 편집기의 dropImages 사용
  await ev(async () => { const r = await fetch('fixtures/small.jpg'); const f = new File([await r.blob()], 'small.jpg', { type: 'image/jpeg' }); await window.__app.editor.dropImages([f]); });
  await page.waitForTimeout(1200);
}
let im = await hasImg();
ok(!!im, '이미지 넣음');
if (im) {
  await page.click('.rt[data-tool="select"]');
  await page.mouse.click(...at(im.rect.x + im.rect.w / 2, im.rect.y + im.rect.h / 2));
  await page.waitForTimeout(300);
  const box = page.locator('.rb-props .chk input');
  ok(await box.count() === 1, '비율 유지 선택 칸');
  await box.uncheck();
  const ratio0 = im.rect.w / im.rect.h;
  await page.mouse.move(...at(im.rect.x + im.rect.w, im.rect.y + im.rect.h)); await page.waitForTimeout(100);
  await page.mouse.down(); await page.mouse.move(...at(im.rect.x + im.rect.w + 80, im.rect.y + im.rect.h + 5), { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(900);
  im = await hasImg();
  const ratio1 = im.rect.w / im.rect.h;
  ok(Math.abs(ratio1 - ratio0) > 0.2, `비율 안 지키고 늘이기 (${ratio0.toFixed(2)} → ${ratio1.toFixed(2)})`);
}
await page.screenshot({ path: SHOT + '/g3-objects.png' });

console.log('영역 삭제: 글자만');
await page.click('.rt[data-tool="redact"]');
await page.selectOption('.rb-props select[aria-label="지울 대상"]', 'text');
const before = await objs();
const shapes0 = before.filter(o => o.type !== 'image').length;
sh = before.find(o => o.type === 'shape');
await page.mouse.move(...at(40, 100)); await page.mouse.down(); await page.mouse.move(...at(560, 800), { steps: 5 }); await page.mouse.up();
await page.waitForTimeout(400);
if (await page.locator('.modal .btn.danger').count()) await page.click('.modal .btn.danger');
await page.waitForTimeout(1200);
const after = await objs();
const txt = await ev(async () => (await window.__app.engine.call('textData', [window.__app.doc.id, 0])).text);
ok(after.some(o => o.type === 'shape') && after.some(o => o.type === 'image') && !txt.includes('제2조'), '글자만 지우고 도형·그림은 남김');
await page.keyboard.press('Control+z'); await page.waitForTimeout(900);

console.log('회전: 모든 쪽');
await page.keyboard.press('Control+Shift+]'); await page.waitForTimeout(900);
const ws = await ev(() => window.__app.view.pages.map(p => p.w > p.h));
ok(ws.every(Boolean), '모든 쪽 가로로 돌아감');
await page.keyboard.press('Control+z'); await page.waitForTimeout(900);
ok((await ev(() => window.__app.view.pages.map(p => p.w > p.h))).every(x => !x), '되돌리기');

console.log('나누기 / 합치기');
await page.keyboard.press('Escape');
await page.keyboard.press('Control+Shift+d');
await page.waitForSelector('.modal select');
await page.selectOption('.modal select', 'every');
await page.fill('.modal input[type=number]', '5');
const dl = page.waitForEvent('download');
await page.click('.modal .btn.primary');
const d = await dl; const zp = SHOT + '/split.zip'; await d.saveAs(zp);
const zb = fs.readFileSync(zp);
const names = [...zb.toString('latin1').matchAll(/PK\x01\x02[\s\S]{42}/g)].length;
ok(names === 3, `5쪽마다 나누기 → ZIP 안 PDF ${names}개 (${Math.round(zb.length / 1024)}KB)`);
// 합치기: 파일 대신 열린 문서 바이트 두 개
const nTabs = await ev(() => window.__app.tabs.length);
await ev(async () => {
  const get = async u => new Uint8Array(await (await fetch(u)).arrayBuffer());
  window.__mergeArgs = [{ name: 'b.pdf', bytes: await get('fixtures/form.pdf') }, { name: 'a.pdf', bytes: await get('fixtures/sample.pdf') }];
});
await ev(() => { window.__app.handleBatch({ mode: 'merge', files: window.__mergeArgs.slice(0, 1) }); window.__app.handleBatch({ mode: 'merge', files: window.__mergeArgs.slice(1) }); });
await page.waitForSelector('.modal .merge-list li', { timeout: 5000 });
ok(await page.locator('.modal .merge-list li').count() === 2, '탐색기에서 따로 온 두 파일을 한 번에 모음');
ok((await page.locator('.modal .merge-name').first().textContent()) === 'a.pdf', '이름순 정렬');
await page.click('.modal .btn.primary');
await page.waitForFunction(n => window.__app.tabs.length === n + 1, nTabs, { timeout: 8000 });
ok(await ev(() => window.__app.doc.info.pageCount) === 13, '합친 문서 13쪽 (12 + 1) 새 탭');

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
