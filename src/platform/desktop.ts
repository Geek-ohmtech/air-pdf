/** Tauri(Windows / macOS / Linux) */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { baseName, KINDS, type Batch, type BatchMode, type FileKind, type OpenedFile, type Platform } from './types.ts';

const RECENT = 'airpdf.recent';
async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return { name: baseName(path), bytes: new Uint8Array(buf), path };
}
async function writePath(path: string, bytes: Uint8Array) {
  await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}
async function readBatch(b: { mode: BatchMode | null; files: string[] }): Promise<Batch> {
  const files: OpenedFile[] = [];
  for (const pth of b.files) { try { files.push(await readPath(pth)); } catch { /* 없는 파일 */ } }
  return { mode: b.mode, files };
}
let listening: Promise<unknown> = Promise.resolve();
export function createDesktop(): Platform {
  const win = getCurrentWindow();
  const p: Platform = {
    kind: 'desktop',
    async pickPdfs(multiple = false) {
      const r = await open({ multiple, filters: [{ name: 'PDF 문서', extensions: ['pdf'] }] });
      if (!r) return [];
      const paths = Array.isArray(r) ? r : [r];
      return Promise.all(paths.map(readPath));
    },
    async saveInPlace(file, bytes) {
      if (!file.path) return false;
      await writePath(file.path, bytes); return true;
    },
    listFonts: () => invoke<{ family: string; path: string; index: number; korean: boolean }[]>('list_fonts'),
    async fontBytes(path: string) { return (await readPath(path)).bytes; },
    async pickImages() {
      const r = await open({ multiple: true, filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!r) return [];
      const paths = Array.isArray(r) ? r : [r];
      return Promise.all(paths.map(async pth => { const f = await readPath(pth); return new File([f.bytes as BlobPart], f.name); }));
    },
    async saveAs(name, bytes, kind: FileKind = 'pdf') {
      const K = KINDS[kind];
      const path = await save({ defaultPath: name, filters: [{ name: K.label, extensions: K.ext }] });
      if (!path) return null;
      await writePath(path, bytes);
      return { name: baseName(path), path };
    },
    async initialFiles() {
      await listening; // 이벤트를 받을 준비가 된 뒤에 모인 파일을 받아야 중간에 온 파일을 놓치지 않는다
      return readBatch(await invoke<{ mode: BatchMode | null; files: string[] }>('initial_files'));
    },
    onExternalOpen(cb) {
      // 이 창으로 보낸 것만 받는다 (창이 여러 개일 때 한 번만 열리게)
      listening = getCurrentWebviewWindow().listen<{ mode: BatchMode | null; files: string[] }>('open-files', async e => cb(await readBatch(e.payload)));
    },
    onFileDrag(cb) {
      let paths: string[] = [];
      getCurrentWebview().onDragDropEvent(e => {
        const p: any = e.payload, r = devicePixelRatio || 1;
        const x = (p.position?.x ?? 0) / r, y = (p.position?.y ?? 0) / r;
        if (p.type === 'enter') { paths = p.paths || []; cb({ type: 'over', x, y, paths }); }
        else if (p.type === 'over') cb({ type: 'over', x, y, paths });
        else if (p.type === 'drop') { cb({ type: 'drop', x, y, paths: p.paths || paths }); paths = []; }
        else { cb({ type: 'leave', x: 0, y: 0, paths: [] }); paths = []; }
      });
    },
    async pickFolder() { const r = await open({ directory: true }); return typeof r === 'string' ? r : null; },
    async writeInFolder(dir, name, bytes) {
      const sep = dir.includes('\\') ? '\\' : '/';
      const path = dir.replace(/[\\/]+$/, '') + sep + name.replace(/[\\/:*?"<>|]/g, '_');
      await writePath(path, bytes); return path;
    },
    reveal(path) { revealItemInDir(path).catch(() => {}); },
    defaultApp: {
      status: () => invoke<boolean | null>('default_app_status'),
      make: () => invoke('make_default_app'),
    },
    version: () => getVersion(),
    tabs: {
      label: getCurrentWebviewWindow().label,
      async put(meta, bytes) { return invoke<number>('put_transfer', bytes, { headers: { 'x-meta': encodeURIComponent(JSON.stringify(meta)) } }); },
      async take(id) {
        const meta = JSON.parse((await invoke<string | null>('transfer_meta', { id })) || '{}');
        const buf = await invoke<ArrayBuffer>('take_transfer', { id });
        return { meta, bytes: new Uint8Array(buf) };
      },
      windowAt: (sx, sy) => invoke<string | null>('window_at', { x: sx * devicePixelRatio, y: sy * devicePixelRatio, exclude: getCurrentWebviewWindow().label }),
      sendTo: (label, id) => invoke('send_transfer', { label, id }),
      newWindow: (id, sx, sy, w, h) => invoke('new_window', { id, x: sx, y: sy, w, h }),
      onIncoming(cb) { getCurrentWebviewWindow().listen<number>('take-doc', e => cb(e.payload)); },
    },
    win: {
      minimize: () => { win.minimize(); },
      toggleMaximize: () => { win.toggleMaximize(); },
      close: () => { win.close(); },
      isMaximized: () => win.isMaximized(),
      onResized: cb => { win.onResized(() => cb()); },
    },
    async checkUpdate() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const u = await check();
      if (!u) return null;
      return {
        version: u.version, notes: u.body || '',
        async install(progress) {
          let total = 0, done = 0;
          await u.downloadAndInstall(ev => {
            if (ev.event === 'Started') total = ev.data.contentLength || 0;
            else if (ev.event === 'Progress') { done += ev.data.chunkLength; progress(done, total); }
          });
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        },
      };
    },
    readPath,
    recent() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } },
    addRecent(path) {
      try { const l = p.recent().filter(x => x !== path); l.unshift(path); localStorage.setItem(RECENT, JSON.stringify(l.slice(0, 12))); } catch { /* */ }
    },
    setTitle(t) { win.setTitle(t); },
    openUrl(url) { openUrl(url); },
    onCloseRequest(cb) {
      win.onCloseRequested(async e => { e.preventDefault(); if (await cb()) await win.destroy(); });
    },
    async toggleFullscreen() { await win.setFullscreen(!(await win.isFullscreen())); },
    onFullscreen(cb) { let last = false; const check = () => win.isFullscreen().then(on => { if (on !== last) { last = on; cb(on); } }).catch(() => {}); win.onResized(check); },
  };
  return p;
}
