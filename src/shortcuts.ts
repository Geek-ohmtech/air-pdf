/**
 * 단축키: 모든 기능을 "동작" 목록으로 두고 키를 붙인다. 사용자가 F1 창에서 바꿀 수 있고, 바꾼 값은 저장된다.
 */
import { dialog, h, toast } from './ui/dom.ts';

export interface Action {
  id: string; label: string; group: string;
  keys: string[];              // 기본 키 (예: 'Ctrl+S', 'Shift+F3', 'V')
  run: () => void;
  when?: () => boolean;        // 이때만 동작 (예: 편집 모드)
  allowTyping?: boolean;       // 입력 칸에 있을 때도 동작
}
export const GROUPS = ['파일', '탭', '보기', '이동', '찾기', '편집', '편집 도구', '주석 도구', '페이지'];

/** 키 이벤트 → "Ctrl+Shift+S" 같은 이름 */
export function comboOf(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead', 'Unidentified'].includes(k) || e.isComposing) return null;
  let key = k;
  if (e.code?.startsWith('Key')) key = e.code.slice(3);               // 한글 입력 중에도 자판 위치로
  else if (e.code === 'BracketLeft') key = '[';                        // Shift를 눌러도 { } 가 아니라 [ ] 로
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code?.startsWith('Digit')) key = e.code.slice(5);
  else if (k === ' ') key = 'Space';
  else if (k === '+') key = '=';
  else if (k.length === 1) key = k.toUpperCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !(k === '?' )) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}
const pretty = (c: string) => c.replace('ArrowRight', '→').replace('ArrowLeft', '←').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('Equal', '=').replace(/^=$/, '=').replace('Ctrl+=', 'Ctrl+=');

export class Shortcuts {
  actions: Action[] = [];
  custom: Record<string, string[]>;
  private save: (c: Record<string, string[]>) => void;
  constructor(custom: Record<string, string[]>, save: (c: Record<string, string[]>) => void) { this.custom = { ...custom }; this.save = save; }
  add(...a: Action[]) { this.actions.push(...a); }
  keysOf(a: Action) { return this.custom[a.id] ?? a.keys; }
  label(id: string) { const a = this.actions.find(x => x.id === id); return a ? this.keysOf(a)[0] || '' : ''; }
  /** 처리했으면 true */
  handle(e: KeyboardEvent, typing: boolean): boolean {
    const c = comboOf(e); if (!c) return false;
    for (const a of this.actions) {
      if (!this.keysOf(a).includes(c)) continue;
      if (typing && !a.allowTyping) continue;
      if (a.when && !a.when()) continue;
      e.preventDefault(); e.stopPropagation();
      a.run();
      return true;
    }
    return false;
  }
  /** F1: 단축키 보기·바꾸기. 바꾼 키는 "저장"을 눌러야 반영된다 */
  async openDialog() {
    let draft: Record<string, string[]> = { ...this.custom };
    const keysOf = (a: Action) => draft[a.id] ?? a.keys;
    let recording: Action | null = null;
    let q = '';
    const body = h('div', { class: 'keys-wrap' });
    const status = h('span', { class: 'keys-status' });
    const dirty = () => JSON.stringify(draft) !== JSON.stringify(this.custom);
    const render = () => {
      body.innerHTML = '';
      const ql = q.trim().toLowerCase();
      for (const g of GROUPS) {
        const list = this.actions.filter(a => a.group === g && (!ql || a.label.toLowerCase().includes(ql) || keysOf(a).some(k => k.toLowerCase().includes(ql))));
        if (!list.length) continue;
        const rows = list.map(a => {
          const keys = keysOf(a), rec = recording === a;
          const changed = JSON.stringify(keys) !== JSON.stringify(a.keys);
          const chip = h('button', { class: 'key-chip' + (changed ? ' changed' : '') + (rec ? ' rec' : ''), type: 'button', title: '눌러서 바꾸기' },
            ...(rec ? [h('span', {}, '키를 누르세요…')] : keys.length ? keys.map(k => h('kbd', {}, pretty(k))) : [h('span', { class: 'muted' }, '없음')]));
          chip.addEventListener('click', () => { recording = a; render(); });
          return h('div', { class: 'key-row' }, h('span', { class: 'key-label' }, a.label), chip);
        });
        body.append(h('section', { class: 'keys-group' }, h('h3', {}, g), ...rows));
      }
      if (!body.children.length) body.append(h('p', { class: 'muted' }, '찾는 기능이 없습니다.'));
      status.textContent = dirty() ? '바꾼 내용이 있습니다 — 저장을 눌러야 반영됩니다' : '';
    };
    const search = h('input', { class: 'field keys-search', type: 'search', placeholder: '기능이나 키로 찾기 (예: 회전, Ctrl+S)', 'aria-label': '단축키 찾기' }) as HTMLInputElement;
    search.addEventListener('input', () => { q = search.value; render(); });
    const head = h('div', { class: 'keys-head' }, search, h('p', { class: 'hint' }, '키를 누른 뒤 새 키를 누르면 바뀝니다. Esc는 취소, Backspace는 키 삭제. 바꾼 뒤 “저장”을 누르세요.'));
    render();
    const onKey = (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault(); e.stopPropagation();
      const a = recording;
      if (e.key === 'Escape') { recording = null; render(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { draft[a.id] = []; recording = null; render(); return; }
      const c = comboOf(e); if (!c) return;
      const clash = this.actions.find(x => x !== a && keysOf(x).includes(c) && sameScope(x, a));
      if (clash) { draft[clash.id] = keysOf(clash).filter(k => k !== c); toast(`“${clash.label}”에 있던 ${pretty(c)}를 옮겨 왔습니다.`); }
      draft[a.id] = [c];
      recording = null; render();
    };
    document.addEventListener('keydown', onKey, true);
    const r = await dialog({ title: '단축키', cls: 'keys', head, body,
      buttons: [
        { label: '모두 기본값으로', value: 'reset', left: true, act: () => { draft = {}; recording = null; render(); } },
        { label: '취소', value: 'cancel' }, { label: '저장', value: 'save', primary: true }],
      onOpen: root => { root.querySelector('.modal-actions')!.prepend(status); setTimeout(() => search.focus()); } });
    document.removeEventListener('keydown', onKey, true);
    if (r?.value === 'save' && dirty()) {
      // 기본값과 같은 것은 따로 저장하지 않는다
      for (const a of this.actions) if (draft[a.id] && JSON.stringify(draft[a.id]) === JSON.stringify(a.keys)) delete draft[a.id];
      this.custom = draft; this.save(this.custom); toast('단축키를 저장했습니다.');
    }
  }
}
/** 같은 상황에서 동시에 쓰일 수 있는 동작끼리만 충돌로 본다 (보기 모드 N과 편집 모드 N은 따로) */
function sameScope(a: Action, b: Action) {
  const edit = (x: Action) => x.group === '편집 도구' || x.group === '주석 도구';
  const viewOnly = (x: Action) => x.id === 'nextPageN' || x.id === 'prevPageP' || x.id === 'down' || x.id === 'up';
  if ((edit(a) && viewOnly(b)) || (edit(b) && viewOnly(a))) return false;
  return true;
}
