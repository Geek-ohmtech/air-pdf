/** 메인 스레드 페이지 엔진 창구. 모든 호출은 비동기(워커와 메시지로) */
export class EngineClient {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void; progress?: (p: any) => void }>();
  ready: Promise<void>;

  constructor() {
    this.w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (ev) => {
      if (ev.data.event) { for (const fn of this.listeners) fn(ev.data); return; }
      const { id, result, error, progress } = ev.data;
      const p = this.pending.get(id); if (!p) return;
      if (progress) { p.progress?.(progress); return; }
      this.pending.delete(id);
      error ? p.rej(new Error(error)) : p.res(result);
    };
    this.ready = this.call<void>('boot', [new URL('./', document.baseURI).href]).then(() => { this.isReady = true; });
  }
  private isReady = false;
  private listeners: ((e: any) => void)[] = [];
  /** 엔진이 먼저 알려 오는 일 (예: 메모리를 아끼려고 페이지를 닫음) */
  onEvent(fn: (e: { event: string; docId: number; key: number }) => void) { this.listeners.push(fn); }
  call<T = any>(method: string, args: any[] = [], opts: { transfer?: Transferable[]; progress?: (p: any) => void } = {}): Promise<T> {
    // 엔진이 준비되기 전에 온 일은 준비된 뒤에 보낸다 (화면을 엔진보다 먼저 띄우기 위해)
    if (method !== 'boot' && !this.isReady) return this.ready.then(() => this.call<T>(method, args, opts));
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res, rej, progress: opts.progress });
      this.w.postMessage({ id, method, args }, opts.transfer || []);
    });
  }
}
