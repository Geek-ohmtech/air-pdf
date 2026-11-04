/** 색 선택 단추: 지금 색을 보여 주고, 누르면 엑셀처럼 색표가 펼쳐진다 */
import { h } from './dom.ts';

const THEME = ['#ffffff', '#1a1a1a', '#7f7f7f', '#2b59c3', '#d0342c', '#e07b00', '#ffd400', '#1f8a4c', '#7b3fbf', '#79c7ff'];
const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
const RECENT_KEY = 'airpdf.recentColors';

const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const rgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
/** t > 0: 흰색 페이지로, t < 0: 검은색 페이지로 */
const mix = (c: string, t: number) => '#' + rgb(c).map(v => hex(t > 0 ? v + (255 - v) * t : v * (1 + t))).join('');
const variants = (c: string) => {
  const lum = rgb(c).reduce((a, v) => a + v, 0) / 765;
  if (lum > 0.95) return [-0.05, -0.15, -0.25, -0.35, -0.5];   // 흰색: 점점 어둡게
  if (lum < 0.12) return [0.5, 0.35, 0.25, 0.15, 0.05];        // 검은색: 점점 밝게
  return [0.8, 0.6, 0.4, -0.25, -0.5];
};
function recent(): string[] { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function remember(c: string) {
  if (!c) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...recent().filter(x => x !== c)].slice(0, 10))); } catch { /* */ }
}

let open: { pop: HTMLElement; close: () => void } | null = null;

export interface ColorOpts { value: string; onPick: (c: string) => void; title: string; none?: string; mark?: 'text' | 'line' | 'fill'; label?: string }
const SVG = (d: string) => `<svg viewBox="0 0 20 20" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
/** 테두리(선): 굵은 테두리 네모 / 채우기: 페인트 통 */
const ICON_LINE = SVG('<rect x="3.5" y="3.5" width="13" height="11" rx="1.5" stroke-width="2.4"/>');
const ICON_FILL = SVG('<path d="M8.2 2.8l6.4 6.4-5.6 5.6a1.6 1.6 0 0 1-2.3 0L3 11.1a1.6 1.6 0 0 1 0-2.3z"/><path d="M5.4 5.6L3.2 3.4"/><path d="M3.4 9.5h10.2" stroke-width="1.2"/><path d="M16.6 11.6s1.6 1.9 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3 1.6-3z" fill="currentColor" stroke="none"/>');
export function colorButton(o: ColorOpts) {
  const bar = h('span', { class: 'cb-bar' + (o.value ? '' : ' none'), style: { background: o.value || 'transparent' } });
  const face = o.mark === 'text' ? h('span', { class: 'cb-a' }, '가') : h('span', { class: 'cb-ico', html: o.mark === 'fill' ? ICON_FILL : ICON_LINE });
  const btn = h('button', { class: 'color-btn', type: 'button', title: o.title, 'aria-label': `${o.title}: ${o.value || '없음'}`, 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    h('span', { class: 'cb-face' }, face, bar), o.label ? h('span', { class: 'cb-label' }, o.label) : null, h('span', { class: 'cb-caret' }, '▾')) as HTMLButtonElement;
  btn.addEventListener('click', e => { e.stopPropagation(); open?.close(); showPalette(btn, o); });
  return btn;
}

function showPalette(btn: HTMLButtonElement, o: ColorOpts) {
  const pick = (c: string) => { remember(c); close(); o.onPick(c); };
  const sw = (c: string) => h('button', { class: 'sw' + (c.toLowerCase() === (o.value || '').toLowerCase() ? ' cur' : ''), type: 'button', style: { background: c }, title: c, 'aria-label': '색 ' + c, onclick: () => pick(c) });
  const grid = (cols: string[][]) => h('div', { class: 'cp-grid' }, ...cols.flat().map(sw));
  const themeRows: string[][] = [THEME, ...[0, 1, 2, 3, 4].map(i => THEME.map(c => mix(c, variants(c)[i])))];
  const custom = h('input', { type: 'color', class: 'cp-custom', value: o.value || '#000000', 'aria-label': '다른 색 선택' }) as HTMLInputElement;
  custom.addEventListener('change', () => pick(custom.value));
  const rec = recent();
  const pop = h('div', { class: 'color-pop', role: 'dialog', 'aria-label': o.title },
    o.none !== undefined ? h('button', { class: 'cp-none' + (!o.value ? ' cur' : ''), type: 'button', onclick: () => pick('') }, h('span', { class: 'sw none' }), o.none || '없음') : null,
    h('div', { class: 'cp-h' }, '테마 색'), grid(themeRows),
    h('div', { class: 'cp-h' }, '표준 색'), grid([STANDARD]),
    rec.length ? h('div', { class: 'cp-h' }, '최근 쓴 색') : null, rec.length ? grid([rec]) : null,
    h('label', { class: 'cp-more' }, custom, '다른 색…'));
  document.body.append(pop);
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, r.left)) + 'px';
  pop.style.top = (r.bottom + ph + 8 > innerHeight ? Math.max(8, r.top - ph - 4) : r.bottom + 4) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  const outside = (e: Event) => { if (!pop.contains(e.target as Node) && e.target !== btn) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
  function close() {
    pop.remove(); btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', close); if (open?.pop === pop) open = null;
  }
  document.addEventListener('keydown', esc, true);
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', close); });
  open = { pop, close };
  (pop.querySelector('.sw.cur, .cp-none.cur, .sw') as HTMLElement | null)?.focus();
}
