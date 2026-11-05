// 브라우저 시험 8: 왼쪽 레일(탐색 패널), 전체 화면에서 패널, 최근 문서, 인쇄한 문서 글자 인식, 종이가 꽉 찬 사진 보정
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
const railTabs = () => page.$$eval('.side-tab', bs => Object.fromEntries(bs.map(b => [b.dataset.tab, { shown: !b.hidden, on: b.getAttribute('aria-selected') === 'true' }])));

await page.goto(base + '?file=fixtures/sample.pdf');
await page.waitForFunction(() => window.__app?.doc && document.querySelector('.page canvas.pg-base')?.width > 10, null, { timeout: 20000 });
await page.waitForTimeout(500);

console.log('왼쪽 레일');
let t = await railTabs();
ok(t.thumbs?.shown && t.thumbs.on, '페이지 단추가 보이고 켜져 있음');
ok(t.search && !t.search.shown, '찾기 결과 단추는 찾기 전에는 숨김');
const hasOutline = (await ev(() => window.__app.doc.outline?.length || 0)) > 0;
ok(t.outline && t.outline.shown === hasOutline, `목차 단추는 목차가 있을 때만 (${hasOutline ? '있음' : '없음'})`);
await page.click('.side-tab[data-tab="thumbs"]'); await page.waitForTimeout(150);
ok(await ev(() => document.querySelector('.sidebar').hidden), '켜진 단추를 다시 누르면 패널이 닫힘');
await page.click('.side-tab[data-tab="thumbs"]'); await page.waitForTimeout(150);
ok(!(await ev(() => document.querySelector('.sidebar').hidden)), '다시 누르면 열림');
await page.click('.side-close'); await page.waitForTimeout(150);
ok(await ev(() => document.querySelector('.sidebar').hidden), '× 단추로 닫힘');
await page.fill('.search-input', '계약'); await page.press('.search-input', 'Enter');
await page.waitForFunction(() => window.__app.hits.length > 0, null, { timeout: 10000 });
t = await railTabs();
ok(t.search.shown && t.search.on && !(await ev(() => document.querySelector('.sidebar').hidden)), '찾으면 찾기 결과 단추가 나타나고 패널이 열림');
await page.screenshot({ path: SHOT + '/m1-rail.png' });
await page.press('.search-input', 'Escape'); await page.waitForTimeout(200);
t = await railTabs();
ok(!t.search.shown && t.thumbs.on, '찾기를 지우면 찾기 결과 단추가 사라지고 페이지로');

console.log('전체 화면');
await page.mouse.click(700, 400);
await page.keyboard.press('F11'); await page.waitForTimeout(600);
if (await ev(() => document.getElementById('app').classList.contains('fs'))) {
  ok(await page.locator('.side-rail').isVisible(), '도구줄이 숨어도 레일은 보여서 패널을 켜고 끌 수 있음');
  if (await ev(() => document.querySelector('.sidebar').hidden)) await page.click('.side-tab[data-tab="thumbs"]');
  await page.waitForTimeout(200);
  const shown = !(await ev(() => document.querySelector('.sidebar').hidden));
  ok(shown, '전체 화면에서 레일로 패널 열기');
  await page.mouse.move(640, 1); await page.waitForTimeout(500);
  const g = await ev(() => { const c = document.querySelector('.chrome').getBoundingClientRect(), r = document.querySelector('.side-tab:not([hidden])').getBoundingClientRect(), hd = document.querySelector('.side-head').getBoundingClientRect(); return { chrome: c.bottom, tab: r.top, head: hd.top }; });
  ok(g.tab >= g.chrome - 1 && (!shown || g.head >= g.chrome - 1), `도구줄이 내려와도 레일·패널 머리가 가려지지 않음 (도구줄 아래 ${Math.round(g.chrome)}px, 레일 ${Math.round(g.tab)}px, 패널 ${Math.round(g.head)}px)`);
  await page.screenshot({ path: SHOT + '/m2-fs.png' });
  await page.mouse.move(640, 500); await page.waitForTimeout(900);
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
} else ok(false, '전체 화면이 되지 않음');

console.log('최근 문서 (설치판 흉내)');
await ev(() => {
  const P = window.__app.platform, day = 86400000, now = Date.now();
  let store = [['C:\\문서\\계약서.pdf', 0], ['C:\\문서\\급여명세서.pdf', 2], ['C:\\문서\\오래된.pdf', 50]].map(([p, d]) => ({ path: p, at: now - d * day }));
  P.kind = 'desktop'; P.recent = () => store.slice(); P.setRecent = l => { store = l.slice(); }; P.addRecent = p => { store = [{ path: p, at: Date.now() }, ...store.filter(x => x.path !== p)]; };
});
await page.click('.more-btn'); await page.click('.menu-item:has-text("최근 문서")');
await page.waitForSelector('.recent-modal');
ok(await page.locator('.recent-modal .recent-line').count() === 3, '… 메뉴 → 최근 문서 목록');
await page.locator('.recent-modal .recent-line').nth(2).locator('.tb').click();
ok(await page.locator('.recent-modal .recent-line').count() === 2, '목록에서 빼기');
await page.keyboard.press('Escape');
await ev(() => { window.__app.prefs.recent = { on: true, days: 1, max: 0 }; });
ok(await ev(() => window.__app.recentList().length) === 1, '기간 설정(1일)을 따름');
await ev(() => { window.__app.prefs.recent = { on: false, days: 0, max: 0 }; });
ok(await ev(() => window.__app.recentList().length) === 0, '기록을 끄면 목록이 비어 보임');

console.log('인쇄한 문서 (그림으로만 된 페이지는 글자 인식)');
const before = await ev(() => window.__app.tabs.length);
await ev(async () => { const bytes = new Uint8Array(await (await fetch('fixtures/sample.pdf')).arrayBuffer()); await window.__app.handleBatch({ mode: 'printed', files: [{ name: 'job.pdf', bytes, path: 'C:\\x\\인쇄_1.pdf' }] }); });
await page.waitForFunction(n => window.__app.tabs.length > n && !document.querySelector('.busy'), before, { timeout: 240000, polling: 500 });
const pr = await ev(async () => { const a = window.__app; const t = a.doc; return { name: t.name, dirty: t.dirty, text3: await a.engine.call('hasText', [t.id, 2]) }; });
ok(/^인쇄한 문서/.test(pr.name) && pr.dirty, '새 문서로 열림 (저장 안 됨): ' + pr.name);
ok(pr.text3, '그림뿐인 3페이지에 글자층이 생김');

console.log('종이가 꽉 찬 사진 (그늘·푸른빛)');
const sc = await ev(async () => {
  const s = await window.__mods.scan();
  const W = 1500, H = 2000, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#222'; g.font = 'bold 60px sans-serif'; g.fillText('제목 TITLE', 500, 200);
  g.font = '34px sans-serif';
  for (let i = 0; i < 30; i++) { g.fillStyle = i % 3 ? '#333' : '#777'; g.fillText('본문 글자 줄 Lorem ipsum ' + i, 150, 320 + i * 52); }
  // 조명: 푸른빛 + 아래 왼쪽 그늘 (부드럽게)
  const d = g.getImageData(0, 0, W, H), p = d.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = Math.max(0, Math.min(1, ((y / H - 0.72) - (x / W) * 0.3) / 0.12)), sh = 1 - 0.45 * t * t * (3 - 2 * t), v = 0.8 * sh, j = (y * W + x) * 4;
    p[j] *= v * 0.92; p[j + 1] *= v * 0.97; p[j + 2] *= v * 1.08;
  }
  g.putImageData(d, 0, 0);
  const q = s.detectQuad(c);
  const out = s.process(c, { quad: q, mode: 'gray', deskew: true, clean: true, mark: false });
  // 회색 글자 줄(i%3==0)이 남았는지: 그 줄 자리의 가장 어두운 값
  const k = out.width / W, og = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
  const darkest = (y0, y1) => { let m = 255; for (let y = Math.round(y0 * k); y < Math.round(y1 * k); y++) for (let x = Math.round(150 * k); x < Math.round(900 * k); x++) m = Math.min(m, og[(y * out.width + x) * 4]); return m; };
  return { full: s.isFull(q, W, H), gray: darkest(320 - 30, 320 + 5), shadowRow: darkest(320 + 29 * 52 - 30, 320 + 29 * 52 + 5) };
});
ok(sc.full, '그늘을 종이 밖으로 보지 않음 (그림 전체를 종이로)');
ok(sc.gray < 140, `회색 글자도 남음 (가장 어두운 값 ${sc.gray})`);
ok(sc.shadowRow < 140, `그늘진 아래쪽 글자도 남음 (${sc.shadowRow})`);

ok(!errs.length, '콘솔 오류 없음' + (errs.length ? ': ' + errs.join(' | ') : ''));
await b.close();
console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
