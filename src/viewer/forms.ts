/**
 * 입력란(AcroForm) 채우기: 보기 모드에서도 칸을 눌러 바로 입력한다.
 * 칸을 누르면 그 자리에 입력 상자를 띄우고, 확정하면 엔진이 값과 모양(한글 포함)을 PDF에 써 넣는다.
 */
import type { App } from '../app.ts';
import type { FieldInfo } from '../engine/core.ts';
import type { PageEl } from './docview.ts';
import { h, toast } from '../ui/dom.ts';

export class FormLayer {
  app: App;
  private cache = new Map<number, FieldInfo[] | Promise<FieldInfo[]>>();
  private open: { el: HTMLElement; commit: (cancel?: boolean) => Promise<void> } | null = null;
  private toldReadOnly = false;

  constructor(app: App) {
    this.app = app;
    app.view.onPageEl.push(pe => this.paint(pe));
  }
  reset() { this.closeEditor(true); this.cache.clear(); }
  get active() { const d = this.app.doc; return !!d && d.formType === 1; }
  private async get(pageIndex: number) {
    const key = this.app.view.pages[pageIndex].key;
    let v = this.cache.get(key);
    if (!v) { v = this.app.engine.call<FieldInfo[]>('fields', [this.app.doc!.id, pageIndex]); this.cache.set(key, v); v.then(x => { if (this.cache.get(key) === v) this.cache.set(key, x); }).catch(() => this.cache.delete(key)); }
    return v;
  }
  async paint(pe: PageEl) {
    pe.forms.innerHTML = '';
    if (!this.active) return;
    const docId = this.app.doc!.id, version = pe.version;
    let fields: FieldInfo[];
    try { fields = await this.get(pe.index); } catch { return; }
    if (this.app.doc?.id !== docId || pe.version !== version || !pe.root.isConnected) return;
    pe.forms.innerHTML = '';
    for (const f of fields) {
      const el = h('div', {
        class: `fld fld-${f.type}${f.readOnly ? ' ro' : ''}${f.required ? ' req' : ''}`, role: 'button', tabindex: '-1',
        title: (f.name || '입력란') + (f.required ? ' (꼭 채워야 함)' : '') + (f.readOnly ? ' (읽기 전용)' : ''),
        style: this.app.view.pct(pe.index, f.rect), dataset: { id: String(f.id) },
      });
      el.addEventListener('pointerdown', e => { e.stopPropagation(); });
      el.addEventListener('click', e => { e.stopPropagation(); this.edit(pe, f); });
      pe.forms.append(el);
    }
  }
  /** 다른 칸으로 옮겨 가기(Tab) */
  private async next(pe: PageEl, f: FieldInfo, dir: number) {
    const list = (await this.get(pe.index)).filter(x => !x.readOnly);
    const i = list.findIndex(x => x.id === f.id);
    const nx = list[i + dir];
    if (nx) this.edit(pe, nx);
  }
  private async commit(pe: PageEl, f: FieldInfo, value: string | boolean | number | number[]) {
    const d = this.app.doc!, key = this.app.view.pages[pe.index].key;
    try {
      await this.app.engine.call('setField', [d.id, key, f.id, value]);
      this.cache.delete(key);
      this.app.markDirty();
      this.app.refreshPage(key);
    } catch (e: any) { toast('입력란에 쓰지 못했습니다: ' + e.message); }
  }
  closeEditor(cancel = false) { if (this.open) this.open.commit(cancel); }

  async edit(pe: PageEl, f: FieldInfo) {
    if (this.app.mode === 'edit' && !this.app.editor?.allowsForms()) return;
    this.closeEditor();
    if (f.readOnly) { if (!this.toldReadOnly) { toast('읽기 전용 입력란입니다.'); this.toldReadOnly = true; } return; }
    if (f.type === 'checkbox' || f.type === 'radio') { await this.commit(pe, f, f.type === 'radio' ? true : !f.checked); return; }
    const z = this.app.view.zoom;
    const fs = (f.fontSize || (f.multiline ? 10 : Math.max(6, Math.min(12, (f.rect.h - 4) * 0.72)))) * z;
    const pos = { ...this.app.view.pct(pe.index, f.rect) };
    let ctl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.type === 'combo' || f.type === 'list') {
      const s = h('select', { class: 'fld-input', multiple: f.type === 'list' && f.multiSelect ? '' : undefined, 'aria-label': f.name }) as HTMLSelectElement;
      if (f.type === 'combo' && !f.options.some(o => o.selected)) s.append(h('option', { value: '-1', selected: '' }, '— 선택하세요 —'));
      f.options.forEach((o, i) => s.append(h('option', { value: String(i), selected: o.selected ? '' : undefined }, o.label)));
      ctl = s;
    } else if (f.multiline) {
      ctl = h('textarea', { class: 'fld-input', 'aria-label': f.name, spellcheck: 'false' }, f.value) as HTMLTextAreaElement;
    } else {
      ctl = h('input', { class: 'fld-input', type: f.password ? 'password' : 'text', value: f.value, 'aria-label': f.name, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    }
    Object.assign(ctl.style, pos, { fontSize: fs + 'px' });
    pe.forms.append(ctl);
    let done = false;
    const commit = async (cancel = false) => {
      if (done) return; done = true; this.open = null;
      const el = ctl;
      if (!cancel) {
        if (el instanceof HTMLSelectElement) {
          if (f.type === 'list') { const sel = [...el.selectedOptions].map(o => +o.value); await this.commit(pe, f, sel); }
          else if (+el.value >= 0 && !f.options[+el.value]?.selected) await this.commit(pe, f, +el.value);
        } else if (el.value !== f.value) await this.commit(pe, f, el.value);
      }
      el.remove();
    };
    this.open = { el: ctl, commit };
    ctl.addEventListener('keydown', e => {
      e.stopPropagation();
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') { e.preventDefault(); commit(true); }
      else if (ke.key === 'Enter' && !(ctl instanceof HTMLTextAreaElement && !ke.ctrlKey) && !ke.isComposing) { e.preventDefault(); commit(); }
      else if (ke.key === 'Tab') { e.preventDefault(); commit().then(() => this.next(pe, f, ke.shiftKey ? -1 : 1)); }
    });
    if (ctl instanceof HTMLSelectElement && f.type === 'combo') ctl.addEventListener('change', () => commit());
    ctl.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ctl) commit(); }, 0));
    ctl.addEventListener('pointerdown', e => e.stopPropagation());
    requestAnimationFrame(() => { ctl.focus(); if (ctl instanceof HTMLInputElement) ctl.select(); });
  }
}
