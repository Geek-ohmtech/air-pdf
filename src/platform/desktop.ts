/** Tauri(Windows / macOS / Linux) */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { baseName, KINDS, type FileKind, type OpenedFile, type Platform } from './types.ts';

const RECENT = 'airpdf.recent';
async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return { name: baseName(path), bytes: new Uint8Array(buf), path };
}
async function writePath(path: string, bytes: Uint8Array) {
  await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}
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
      const paths = await invoke<string[]>('initial_files');
      const out: OpenedFile[] = [];
      for (const pth of paths) { try { out.push(await readPath(pth)); } catch { /* 없는 파일 */ } }
      return out;
    },
    onExternalOpen(cb) {
      const handle = async (paths: string[]) => {
        const pdfs = paths.filter(x => /\.pdf$/i.test(x));
        if (pdfs.length) cb(await Promise.all(pdfs.map(readPath)));
      };
      getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === 'drop') handle(e.payload.paths); });
      listen<string[]>('open-files', e => handle(e.payload));
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
  };
  return p;
}
