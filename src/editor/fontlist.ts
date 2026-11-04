/** 글꼴 목록: 앱에 든 글꼴 + 이 컴퓨터에 설치된 글꼴 */
import type { App } from '../app.ts';
import { BUILTIN_FONTS } from '../engine/fonts.ts';

export interface FontItem { id: string; name: string; css: string; group: string; path?: string; index?: number; korean?: boolean }
let sys: FontItem[] | null = null, loading: Promise<FontItem[]> | null = null;

export const builtinItems = (): FontItem[] => BUILTIN_FONTS.map(f => ({ id: f.id, name: f.name, css: `"${f.css}", "Malgun Gothic", sans-serif`, group: '앱에 든 글꼴' }));
export function systemFontsLoaded() { return sys; }
/** 컴퓨터 글꼴 목록 불러오기 (웹은 브라우저가 허락을 물을 수 있다) */
export function loadSystemFonts(app: App): Promise<FontItem[]> {
  if (sys) return Promise.resolve(sys);
  if (!loading) loading = (async () => {
    const list = await app.platform.listFonts().catch(() => []);
    sys = list.map(f => ({ id: `sys:${f.path}#${f.index}`, name: f.family, css: `"${f.family}"`, group: f.korean ? '컴퓨터 글꼴 (한글)' : '컴퓨터 글꼴', path: f.path, index: f.index, korean: f.korean }));
    sys.sort((a, b) => (a.korean === b.korean ? a.name.localeCompare(b.name, 'ko') : a.korean ? -1 : 1));
    return sys;
  })().finally(() => { loading = null; });
  return loading;
}
export function fontItem(id: string): FontItem | undefined { return builtinItems().find(f => f.id === id) || sys?.find(f => f.id === id); }
export function fontCss(id: string) { return fontItem(id)?.css || '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif'; }
/** 엔진이 그 글꼴을 쓸 수 있게 (컴퓨터 글꼴이면 파일을 읽어 넘긴다) */
export async function ensureFont(app: App, id: string) {
  if (!id.startsWith('sys:')) return;
  if (await app.engine.call<boolean>('hasFont', [id])) return;
  const it = fontItem(id); if (!it?.path) throw new Error('글꼴을 찾지 못했습니다');
  const bytes = await app.platform.fontBytes(it.path);
  await app.engine.call('registerFont', [id, bytes, it.index || 0]);
}
