// 브라우저 시험 7: 위쪽 막대 정리(아래 막대로 옮긴 페이지 이동·확대), 전체 화면 자동 숨김, 탭 끌어 순서 바꾸기
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

await page.goto(base + '?file=fixtures/sample.pdf&file=fixtures/form.pdf&file=fixtures/payslip.pdf');
await page.waitForFunction(() => window.__app?.tabs?.length === 3 && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });

console.log('위쪽 / 아래 막대');
ok(await page.locator('.topbar .page-input').count() === 0 && await page.locator('.topbar .zoom-btn').count() === 0, '페이지 이동·확대는 위쪽 막대에서 빠짐');
ok(await page.locator('.statusbar .page-input').isVisible() && await page.locator('.statusbar .zoom-btn').isVisible(), '아래 막대에 페이지 번호·배율');
const sp = await page.locator('.tb-spacer').boundingBox();
ok(sp.width > 300, `위쪽 막대의 빈 곳(창 끌기 영역) ${Math.round(sp.width)}px`);
await page.locator('.tabbar .tab').filter({ hasText: 'sample.pdf' }).click(); await page.waitForTimeout(400);
const c0 = await ev(() => window.__app.view.current);
await page.click('.statusbar .sb[title^="다음 페이지"]'); await page.waitForTimeout(500);
const c1 = await ev(() => window.__app.view.current);
ok(c1 === c0 + 1, `아래 막대에서 다음 페이지 (${c0 + 1} → ${c1 + 1})`);
const z0 = await ev(() => window.__app.view.zoom);
await page.click('.statusbar .sb[title^="확대"]'); await page.waitForTimeout(300);
ok(await ev(() => window.__app.view.zoom) > z0, '아래 막대에서 확대');
await page.click('.statusbar .sb[title^="페이지 너비"]'); await page.waitForTimeout(300);
ok(await ev(() => window.__app.view.fit) === 'width', '아래 막대에서 너비 맞춤');
await page.screenshot({ path: SHOT + '/k1-light.png', clip: { x: 0, y: 0, width: 1280, height: 90 } });
await page.screenshot({ path: SHOT + '/k1-status.png', clip: { x: 0, y: 760, width: 1280, height: 40 } });
await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
const contrast = await ev(() => {
  const lum = c => { const m = c.match(/\d+/g).map(Number).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const fg = getComputedStyle(document.querySelector('.statusbar')).color, bg = getComputedStyle(document.querySelector('.statusbar')).backgroundColor;
  const a = lum(fg), b2 = lum(bg); return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
});
ok(contrast >= 7, `어두운 화면 아래 막대 글자 대비 ${contrast.toFixed(1)}:1`);
await page.screenshot({ path: SHOT + '/k1-dark.png', clip: { x: 0, y: 0, width: 1280, height: 90 } });
await page.emulateMedia({ colorScheme: 'light' });

console.log('탭 끌어 순서 바꾸기');
const names0 = await ev(() => window.__app.tabs.map(t => t.name));
const t0 = await page.locator('.tabbar .tab').nth(0).boundingBox(), t2 = await page.locator('.tabbar .tab').nth(2).boundingBox();
await page.mouse.move(t0.x + 30, t0.y + t0.height / 2); await page.mouse.down();
await page.mouse.move(t2.x + t2.width - 10, t2.y + t2.height / 2, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(300);
const names1 = await ev(() => window.__app.tabs.map(t => t.name));
ok(names1[2] === names0[0] && names1[0] === names0[1], '첫 탭을 맨 뒤로: ' + names1.join(', '));

console.log('전체 화면');
await page.mouse.click(640, 400);
await page.keyboard.press('F11'); await page.waitForTimeout(600);
const fs = await ev(() => document.getElementById('app').classList.contains('fs'));
ok(fs, '전체 화면이 되면 표시');
if (fs) {
  const hidden = await ev(() => document.querySelector('.chrome').getBoundingClientRect().bottom <= 2);
  ok(hidden, '위쪽 줄이 숨음');
  await page.mouse.move(640, 1); await page.waitForTimeout(400);
  ok(await ev(() => document.querySelector('.chrome').getBoundingClientRect().top >= -1), '마우스를 맨 위에 대면 나타남');
  await page.screenshot({ path: SHOT + '/k2-fs.png', clip: { x: 0, y: 0, width: 1280, height: 140 } });
  await page.mouse.move(640, 500); await page.waitForTimeout(900);
  ok(await ev(() => document.querySelector('.chrome').getBoundingClientRect().bottom <= 2), '벗어나면 다시 숨음');
  await page.keyboard.press('Escape'); await page.waitForTimeout(600);
  ok(!(await ev(() => document.getElementById('app').classList.contains('fs'))), 'Esc로 전체 화면 끝');
}

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
