/** 문서 보정 화면: 모서리 맞추기 · 회전 · 보정 방식 선택 · 미리보기 */
import { dialog, h, icon } from '../ui/dom.ts';
import { detectQuad, process, toCanvas, type Mode, type Quad } from './scan.ts';

export interface ScanSource { name: string; canvas: HTMLCanvasElement }
interface Item extends ScanSource { quad: Quad; mode: Mode; turn: number; deskew: boolean; clean: boolean; mark: boolean; oriented?: boolean; small?: HTMLCanvasElement }

const MODES: [Mode, string, string][] = [
  ['color', '선명한 컬러', '종이를 하얗게, 그늘을 지우고 색은 살립니다'],
  ['gray', '회색조', '흑백 인쇄물·서류에 알맞습니다'],
  ['bw', '흑백 문서', '글자만 또렷하게 (용량이 가장 작음)'],
  ['none', '원본 색', '색은 그대로 두고 모양만 바로잡습니다'],
];

/** 보정 화면을 띄우고, 적용하면 보정한 그림들을 돌려준다 (취소하면 null) */
export async function scanDialog(srcs: ScanSource[], o: { title?: string; ok?: string } = {}): Promise<HTMLCanvasElement[] | null> {
  const items: Item[] = srcs.map(s => ({ ...s, quad: detectQuad(s.canvas), mode: 'color', turn: 0, deskew: true, clean: true, mark: true }));
  let cur = 0, sameForAll = true;
  const stage = h('div', { class: 'scan-stage' });
  const before = h('div', { class: 'scan-pane' }), after = h('div', { class: 'scan-pane' });
  const prevImg = h('canvas', { class: 'scan-out' }) as HTMLCanvasElement;
  const counter = h('span', { class: 'scan-count' });
  const strip = h('div', { class: 'scan-strip' });
  const modeRow = h('div', { class: 'seg scan-modes', role: 'radiogroup', 'aria-label': '보정 방식' });
  const deskew = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
  const orient = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
  const clean = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
  const mark = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
  const orientNote = h('span', { class: 'scan-note' });
  const all = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
  let pt: { i: number } | null = null, timer = 0;

  const it = () => items[cur];
  const smallOf = (x: Item) => x.small || (x.small = toCanvas(x.canvas, 900));
  const drawBefore = () => {
    const x = it(), sm = smallOf(x), k = sm.width / x.canvas.width;
    before.innerHTML = '';
    const wrap = h('div', { class: 'scan-img' });
    const img = h('canvas', {}) as HTMLCanvasElement; img.width = sm.width; img.height = sm.height; img.getContext('2d')!.drawImage(sm, 0, 0);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${sm.width} ${sm.height}`); svg.setAttribute('class', 'scan-quad');
    const poly = document.createElementNS(svg.namespaceURI, 'polygon');
    const pts = () => x.quad.map(p => `${p.x * k},${p.y * k}`).join(' ');
    poly.setAttribute('points', pts()); svg.append(poly);
    x.quad.forEach((p, i) => {
      const c = document.createElementNS(svg.namespaceURI, 'circle');
      c.setAttribute('cx', String(p.x * k)); c.setAttribute('cy', String(p.y * k)); c.setAttribute('r', String(Math.max(9, sm.width / 55)));
      c.setAttribute('class', 'scan-h'); c.setAttribute('data-i', String(i));
      c.setAttribute('aria-label', ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'][i] + ' 모서리');
      svg.append(c);
    });
    svg.addEventListener('pointerdown', e => { const t = e.target as SVGElement; if (t.dataset.i === undefined) return; pt = { i: +t.dataset.i }; svg.setPointerCapture(e.pointerId); e.preventDefault(); });
    svg.addEventListener('pointermove', e => {
      if (!pt) return;
      const r = svg.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * x.canvas.width, py = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * x.canvas.height;
      x.quad[pt.i] = { x: px, y: py };
      poly.setAttribute('points', pts());
      const c = svg.querySelector(`[data-i="${pt.i}"]`)!; c.setAttribute('cx', String(px * k)); c.setAttribute('cy', String(py * k));
      schedule();
    });
    svg.addEventListener('pointerup', () => { pt = null; });
    wrap.append(img, svg);
    before.append(h('div', { class: 'scan-cap' }, '원본 · 모서리 점을 끌어 종이 테두리에 맞추세요'), wrap,
      h('div', { class: 'scan-tools' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { x.quad = detectQuad(x.canvas); drawBefore(); schedule(); } }, icon('scan'), '자동으로 찾기'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { const W = x.canvas.width, H = x.canvas.height; x.quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]; drawBefore(); schedule(); } }, '그림 전체'),
        h('button', { class: 'btn sm', type: 'button', title: '왼쪽으로 90° 회전', onclick: () => { x.turn = (x.turn + 270) % 360; schedule(); } }, icon('rotL')),
        h('button', { class: 'btn sm', type: 'button', title: '오른쪽으로 90° 회전', onclick: () => { x.turn = (x.turn + 90) % 360; schedule(); } }, icon('rotR'))));
  };
  const drawAfter = () => {
    const x = it(), sm = smallOf(x), k = sm.width / x.canvas.width;
    const q = x.quad.map(p => ({ x: p.x * k, y: p.y * k })) as Quad;
    const out = process(sm, { quad: q, mode: x.mode, deskew: x.deskew, turn: x.turn, clean: x.clean, mark: x.mark });
    prevImg.width = out.width; prevImg.height = out.height; prevImg.getContext('2d')!.drawImage(out, 0, 0);
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(drawAfter, 120); };
  const drawModes = () => {
    modeRow.innerHTML = '';
    for (const [m, label, tip] of MODES) modeRow.append(h('button', { class: 'tg wide' + (it().mode === m ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(it().mode === m), title: tip, onclick: () => { for (const y of sameForAll ? items : [it()]) y.mode = m; drawModes(); schedule(); } }, label));
  };
  const drawStrip = () => {
    strip.innerHTML = '';
    if (items.length < 2) { strip.hidden = true; return; }
    items.forEach((x, i) => {
      const sm = smallOf(x), c = h('canvas', {}) as HTMLCanvasElement; c.width = 90; c.height = Math.round(90 * sm.height / sm.width); c.getContext('2d')!.drawImage(sm, 0, 0, c.width, c.height);
      strip.append(h('button', { class: 'scan-thumb' + (i === cur ? ' on' : ''), type: 'button', title: x.name, onclick: () => go(i) }, c, h('span', {}, String(i + 1))));
    });
  };
  const go = (i: number) => {
    cur = Math.max(0, Math.min(items.length - 1, i));
    counter.textContent = items.length > 1 ? `${cur + 1} / ${items.length} · ${it().name}` : it().name;
    deskew.checked = it().deskew; clean.checked = it().clean; mark.checked = it().mark;
    if (orient.checked && !it().oriented) autoOrient(it());
    drawBefore(); drawModes(); drawStrip(); drawAfter();
  };
  const autoOrient = async (x: Item) => {
    x.oriented = true; orientNote.textContent = '방향 확인 중…';
    try {
      const { detectOrientation } = await import('../editor/ocr.ts');
      const sm = smallOf(x), k = sm.width / x.canvas.width;
      const flat = process(sm, { quad: x.quad.map(p => ({ x: p.x * k, y: p.y * k })) as Quad, mode: 'none', mark: false });
      const deg = await detectOrientation(flat);
      if (deg) { x.turn = deg; if (x === it()) schedule(); }
      if (x === it()) orientNote.textContent = deg ? `${deg}° 돌려 세웠습니다` : '';
    } catch { if (x === it()) orientNote.textContent = ''; }
  };
  orient.addEventListener('change', () => { if (orient.checked) for (const y of sameForAll ? items : [it()]) { y.oriented = false; } if (orient.checked) autoOrient(it()); else orientNote.textContent = ''; });
  clean.addEventListener('change', () => { for (const y of sameForAll ? items : [it()]) y.clean = clean.checked; schedule(); });
  mark.addEventListener('change', () => { for (const y of sameForAll ? items : [it()]) y.mark = mark.checked; schedule(); });
  deskew.addEventListener('change', () => { for (const y of sameForAll ? items : [it()]) y.deskew = deskew.checked; schedule(); });
  all.addEventListener('change', () => { sameForAll = all.checked; });
  after.append(h('div', { class: 'scan-cap' }, '결과 미리보기'), h('div', { class: 'scan-img out' }, prevImg));
  stage.append(before, after);
  const nav = items.length > 1 ? h('div', { class: 'scan-nav' },
    h('button', { class: 'btn sm', type: 'button', onclick: () => go(cur - 1) }, '‹ 이전'), counter, h('button', { class: 'btn sm', type: 'button', onclick: () => go(cur + 1) }, '다음 ›')) : counter;
  const body = h('div', { class: 'scan-body' }, stage,
    h('div', { class: 'scan-opts' }, h('span', { class: 'prop-lbl' }, '보정 방식'), modeRow,
      h('label', { class: 'chk' }, deskew, ' 기울기 바로잡기'),
      h('label', { class: 'chk', title: '옆으로 눕거나 거꾸로 된 페이지를 글자를 읽어 보고 바로 세웁니다' }, orient, ' 방향 자동 바로잡기'), orientNote,
      h('label', { class: 'chk', title: '옅은 회색·분홍 바탕무늬(워터마크)를 흰 바탕으로 지우고 글자를 진하게' }, clean, ' 흐린 무늬 지우기'),
      h('label', { class: 'chk', title: '아래쪽 구석의 "CamScanner로 스캔하기" 같은 스캔 앱 표시를 지웁니다' }, mark, ' 스캔 앱 표시 지우기'),
      items.length > 1 ? h('label', { class: 'chk' }, all, ' 모든 이미지에 같은 보정') : null),
    strip);
  go(0);
  const r = await dialog({ title: o.title || '문서 보정', cls: 'scan', head: nav, body, buttons: [{ label: '취소', value: false }, { label: o.ok || '보정 적용', value: true, primary: true }] });
  if (!r?.value) return null;
  if (orient.checked) for (const x of items) if (!x.oriented) await autoOrient(x);
  // 실제 크기로 처리
  return items.map(x => process(x.canvas, { quad: x.quad, mode: x.mode, deskew: x.deskew, turn: x.turn, clean: x.clean, mark: x.mark }));
}

/** 파일 → 보정용 캔버스 (사진 방향(EXIF)은 브라우저가 맞춰 준다) */
export async function fileToCanvas(f: Blob) {
  const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' } as any);
  const c = toCanvas(bmp, 3000); bmp.close();
  return c;
}
