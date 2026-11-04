import type { Platform } from './types.ts';
export async function loadPlatform(): Promise<Platform> {
  if ((window as any).__TAURI_INTERNALS__) return (await import('./desktop.ts')).createDesktop();
  return (await import('./web.ts')).createWeb();
}
