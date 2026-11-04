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
export const GROUPS = ['파일', '탭', '보기', '이동', '찾기', '편집', '편집 도구', '주석 도구', '쪽'];

/** 키 이벤트 → "Ctrl+Shift+S" 같은 이름 */
export function comboOf(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead', 'Unidentified'].includes(k) || e.isComposing) return null;
  let key = k;
  if (e.code?.startsWith('Key')) key = e.code.slice(3);               // 한글 입력 중에도 자판 위치로
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
  /** F1: 단축키 보기·바꾸기 */
  async openDialog() {
    let recording: { a: Action; chip: HTMLElement } | null = null;
    const body = h('div', { class: 'keys-wrap' });
    const render = () => {
      body.innerHTML = '';
      body.append(h('p', { class: 'hint' }, '키를 누르면 새 단축키를 정할 수 있습니다. Esc는 취소, Backspace는 지우기입니다.'));
      for (const g of GROUPS) {
        const list = this.actions.filter(a => a.group === g); if (!list.length) continue;
        const tb = h('table', { class: 'keys-table' });
        for (const a of list) {
          const keys = this.keysOf(a);
          const chip = h('button', { class: 'key-chip' + (this.custom[a.id] ? ' changed' : ''), type: 'button', title: '눌러서 바꾸기' }, ...(keys.length ? keys.map(k => h('kbd', {}, pretty(k))) : [h('span', { class: 'muted' }, '없음')]));
          chip.addEventListener('click', () => { recording?.chip.classList.remove('rec'); recording = { a, chip }; chip.classList.add('rec'); chip.textContent = '키를 누르세요…'; });
          tb.append(h('tr', {}, h('td', {}, a.label), h('td', { class: 'kc' }, chip)));
        }
        body.append(h('h3', { class: 'keys-group' }, g), tb);
      }
    };
    render();
    const onKey = (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault(); e.stopPropagation();
      const { a } = recording;
      if (e.key === 'Escape') { recording = null; render(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { this.custom[a.id] = []; recording = null; this.save(this.custom); render(); return; }
      const c = comboOf(e); if (!c) return;
      const clash = this.actions.find(x => x !== a && x.group !== '' && this.keysOf(x).includes(c) && sameScope(x, a));
      if (clash) { this.custom[clash.id] = this.keysOf(clash).filter(k => k !== c); toast(`“${clash.label}”에 있던 ${pretty(c)}를 옮겨 왔습니다.`); }
      this.custom[a.id] = [c];
      recording = null; this.save(this.custom); render();
    };
    document.addEventListener('keydown', onKey, true);
    const r = await dialog({ title: '단축키', wide: true, body, buttons: [{ label: '기본값으로', value: 'reset' }, { label: '닫기', value: 'close', primary: true }] });
    document.removeEventListener('keydown', onKey, true);
    if (r?.value === 'reset') { this.custom = {}; this.save(this.custom); toast('단축키를 기본값으로 되돌렸습니다.'); }
  }
}
/** 같은 상황에서 동시에 쓰일 수 있는 동작끼리만 충돌로 본다 (보기 모드 N과 편집 모드 N은 따로) */
function sameScope(a: Action, b: Action) {
  const edit = (x: Action) => x.group === '편집 도구' || x.group === '주석 도구';
  const viewOnly = (x: Action) => x.id === 'nextPage' || x.id === 'prevPage';
  if ((edit(a) && viewOnly(b)) || (edit(b) && viewOnly(a))) return false;
  return true;
}
