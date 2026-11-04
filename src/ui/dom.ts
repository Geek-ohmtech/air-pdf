/** 작은 DOM 도우미, 아이콘, 알림, 대화상자 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const P = (d: string, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const icons = {
  open: P('<path d="M2.5 6V15.5h15V7.5H9.5L8 6z"/>'),
  save: P('<path d="M10 3v9M6.5 8.5L10 12l3.5-3.5"/><path d="M3.5 13v3.5h13V13"/>'),
  sidebar: P('<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M7.5 3.5v13"/>'),
  prev: P('<path d="M12 4.5L6.5 10l5.5 5.5"/>'),
  next: P('<path d="M8 4.5l5.5 5.5L8 15.5"/>'),
  minus: P('<path d="M5 10h10"/>'),
  plus: P('<path d="M5 10h10M10 5v10"/>'),
  search: P('<circle cx="8.5" cy="8.5" r="5"/><path d="M12.3 12.3L16.5 16.5"/>'),
  more: P('<circle cx="5" cy="10" r=".6" fill="currentColor"/><circle cx="10" cy="10" r=".6" fill="currentColor"/><circle cx="15" cy="10" r=".6" fill="currentColor"/>'),
  close: P('<path d="M5 5l10 10M15 5L5 15"/>'),
  undo: P('<path d="M6.5 4L3 7.5 6.5 11"/><path d="M3 7.5h8.5a4.5 4.5 0 010 9H8"/>'),
  redo: P('<path d="M13.5 4L17 7.5 13.5 11"/><path d="M17 7.5H8.5a4.5 4.5 0 000 9H12"/>'),
  select: P('<path d="M5 3l10.5 7-4.8 1.1L8.3 16z"/>'),
  editText: P('<path d="M3 5.5V4h9v1.5M7.5 4v11M5.5 15h4"/><path d="M14.5 9.5l2 2-4.5 4.5-2.3.3.3-2.3z"/>'),
  addText: P('<path d="M4 5.5V4h12v1.5M10 4v12M7.5 16h5"/>'),
  image: P('<rect x="2.5" y="4" width="15" height="12" rx="1.5"/><circle cx="7" cy="8" r="1.4"/><path d="M3 15l4.5-4.5 3 3 2-2L17 16"/>'),
  table: P('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><path d="M2.5 8h15M2.5 12.3h15M8 3.5v13M13 3.5v13"/>'),
  rect: P('<rect x="3.5" y="5" width="13" height="10" rx="1"/>'),
  ellipse: P('<ellipse cx="10" cy="10" rx="7" ry="5.5"/>'),
  line: P('<path d="M4 16L16 4"/>'),
  redact: P('<rect x="3" y="7" width="14" height="6" rx="1" fill="currentColor" opacity=".85"/><path d="M3 4h14M3 16h9" opacity=".5"/>'),
  highlight: P('<path d="M6.5 12.5l6.5-8.5 3 2.5-6.5 8.5z"/><path d="M6.5 12.5L5 15.5h3l1.5-.5"/><path d="M2.5 18h15" stroke-width="2.6" opacity=".45"/>'),
  underline: P('<path d="M6 3.5v6a4 4 0 008 0v-6M4.5 17h11"/>'),
  strike: P('<path d="M3.5 10h13M13.5 6.2C13 4.6 11.7 3.8 10 3.8c-2 0-3.5 1-3.5 2.6M6.5 13.6c.4 1.7 1.8 2.6 3.7 2.6 2.1 0 3.6-1 3.6-2.8"/>'),
  note: P('<path d="M4 3.5h12v9.5l-3.5 3.5H4z"/><path d="M12.5 16.5V13H16M7 7.5h6M7 10.5h4"/>'),
  pen: P('<path d="M13.5 3.5l3 3-9 9-4 1 1-4z"/><path d="M12 5l3 3"/>'),
  rotL: P('<path d="M4 8a6.5 6.5 0 116 9"/><path d="M2.5 4.5L4 8l3.5-1.3"/>'),
  rotR: P('<path d="M16 8a6.5 6.5 0 10-6 9"/><path d="M17.5 4.5L16 8l-3.5-1.3"/>'),
  trash: P('<path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11"/>'),
  pageAdd: P('<path d="M4.5 2.5h7l4 4v11h-11z"/><path d="M10 8.5v6M7 11.5h6"/>'),
  merge: P('<rect x="2.5" y="2.5" width="8" height="10" rx="1"/><path d="M8.5 17.5h8.5v-11"/><path d="M14 2v5M11.5 4.5h5"/>'),
  extract: P('<path d="M4.5 2.5h7l4 4v11h-11z"/><path d="M10 14.5v-6M7.5 11L10 8.5l2.5 2.5"/>'),
  up: P('<path d="M5 12.5L10 7.5l5 5"/>'),
  down: P('<path d="M5 7.5L10 12.5l5-5"/>'),
  ocr: P('<path d="M3 7V4h3M14 4h3v3M17 13v3h-3M6 16H3v-3"/><path d="M7 8h6M7 10.5h6M7 13h4"/>'),
  lock: P('<rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 017 0V9"/>'),
  info: P('<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.3v.2"/>'),
  print: P('<path d="M5.5 7.5V3h9v4.5"/><rect x="2.5" y="7.5" width="15" height="7" rx="1.2"/><path d="M5.5 12h9v5h-9z"/>'),
  moon: P('<path d="M15.5 12.5A6.5 6.5 0 017.5 4.5a6.5 6.5 0 108 8z"/>'),
  spread: P('<rect x="2" y="4" width="7.5" height="12" rx="1"/><rect x="10.5" y="4" width="7.5" height="12" rx="1"/>'),
  full: P('<path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5"/>'),
  keyboard: P('<rect x="2" y="5" width="16" height="10" rx="1.5"/><path d="M5 8.5h.5M8 8.5h.5M11 8.5h.5M14 8.5h.5M6 12h8"/>'),
  copy: P('<rect x="6.5" y="6.5" width="10" height="10" rx="1.2"/><path d="M13.5 6.5V3.5h-10v10h3"/>'),
  thumbs: P('<rect x="3" y="3" width="5.5" height="6.5" rx=".8"/><rect x="11.5" y="3" width="5.5" height="6.5" rx=".8"/><rect x="3" y="12" width="5.5" height="5" rx=".8"/><rect x="11.5" y="12" width="5.5" height="5" rx=".8"/>'),
  outline: P('<path d="M3 5h2M3 10h2M3 15h2M8 5h9M10 10h7M10 15h7"/>'),
  comments: P('<path d="M3 4h14v9.5H9l-4 3v-3H3z"/>'),
  theme: P('<circle cx="10" cy="10" r="7"/><path d="M10 3v14a7 7 0 000-14z" fill="currentColor"/>'),
  check: P('<path d="M4 10.5l4 4 8-9"/>'),
  view: P('<path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.5"/>'),
  edit: P('<path d="M13.5 3.5l3 3-9 9-4 1 1-4z"/>'),
  compress: P('<path d="M10 2.5v5M7.5 5L10 7.5 12.5 5M10 17.5v-5M7.5 15l2.5-2.5 2.5 2.5"/><path d="M3 10h14"/>'),
  fit: P('<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><rect x="7" y="7" width="6" height="6" rx=".5"/>'),
};
export type IconName = keyof typeof icons;
export function icon(name: IconName) { const s = document.createElement('span'); s.className = 'ico'; s.innerHTML = icons[name]; return s; }

let toastT = 0;
export function toast(msg: string, ms = 2800) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = window.setTimeout(() => t!.classList.remove('show'), ms);
}

export function busy(msg: string) {
  const el = h('div', { class: 'busy' }, h('div', { class: 'busy-card' }, h('span', { class: 'spin' }), h('span', { class: 'busy-msg' }, msg)));
  document.body.append(el);
  return { set: (m: string) => { (el.querySelector('.busy-msg') as HTMLElement).textContent = m; }, done: () => el.remove() };
}

/** 모달 대화상자. 버튼을 누르면 값과 함께 닫힌다 */
export function dialog<T = any>(opts: { title: string; body?: Node | string; buttons: { label: string; value: T; primary?: boolean; danger?: boolean }[]; onOpen?: (root: HTMLElement) => void; collect?: (root: HTMLElement) => any; wide?: boolean }): Promise<{ value: T; data?: any } | null> {
  return new Promise(res => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const card = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('h2', {}, opts.title),
      typeof opts.body === 'string' ? h('p', {}, opts.body) : opts.body || null,
      h('div', { class: 'modal-actions' }, ...opts.buttons.map(b => h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button', dataset: { i: String(opts.buttons.indexOf(b)) } }, b.label))));
    const back = h('div', { class: 'modal-back' }, card);
    const close = (v: { value: T; data?: any } | null) => { back.remove(); document.removeEventListener('keydown', key, true); prevFocus?.focus?.(); res(v); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !(e.target as HTMLElement).matches('textarea')) {
        const p = opts.buttons.findIndex(b => b.primary); if (p >= 0) { e.preventDefault(); e.stopPropagation(); close({ value: opts.buttons[p].value, data: opts.collect?.(card) }); }
      }
    };
    card.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null; if (!b) return;
      const btn = opts.buttons[+b.dataset.i!];
      close({ value: btn.value, data: opts.collect?.(card) });
    });
    back.addEventListener('pointerdown', e => { if (e.target === back) close(null); });
    document.addEventListener('keydown', key, true);
    document.body.append(back);
    opts.onOpen?.(card);
    const f = card.querySelector('input, textarea, select') as HTMLElement | null;
    (f || card.querySelector('.btn.primary') as HTMLElement | null)?.focus();
  });
}
export async function confirmBox(title: string, body: string, ok = '확인', danger = false) {
  const r = await dialog({ title, body, buttons: [{ label: '취소', value: false }, { label: ok, value: true, primary: true, danger }] });
  return !!r?.value;
}
export async function promptBox(title: string, label: string, value = '', opts: { type?: string; ok?: string; hint?: string; error?: string } = {}) {
  const input = h('input', { class: 'field', type: opts.type || 'text', value, 'aria-label': label, autocomplete: 'off' });
  const body = h('div', { class: 'form' }, h('label', { class: 'lbl' }, label), input, opts.error ? h('p', { class: 'err' }, opts.error) : null, opts.hint ? h('p', { class: 'hint' }, opts.hint) : null);
  const r = await dialog({ title, body, buttons: [{ label: '취소', value: false }, { label: opts.ok || '확인', value: true, primary: true }], collect: () => input.value });
  return r?.value ? (r.data as string) : null;
}

/** 단축 메뉴 */
export function menu(anchor: { x: number; y: number }, items: ({ label: string; icon?: IconName; hint?: string; action: () => void; disabled?: boolean; checked?: boolean } | '-')[]) {
  document.querySelector('.menu')?.remove();
  const m = h('div', { class: 'menu', role: 'menu' }, ...items.map(it => it === '-' ? h('div', { class: 'menu-sep' }) :
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', disabled: it.disabled, onclick: () => { m.remove(); it.action(); } },
      it.icon ? icon(it.icon) : h('span', { class: 'ico' }), h('span', { class: 'menu-label' }, it.label),
      it.checked ? icon('check') : it.hint ? h('kbd', {}, it.hint) : null)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(anchor.x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(anchor.y, innerHeight - r.height - 8)) + 'px';
  const off = (e: Event) => { if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { m.remove(); document.removeEventListener('keydown', k); } });
  (m.querySelector('.menu-item:not([disabled])') as HTMLElement)?.focus();
  return m;
}
