export interface OpenedFile { name: string; bytes: Uint8Array; path?: string; handle?: any }
export interface SavedTarget { name: string; path?: string; handle?: any }
export type BatchMode = 'merge' | 'split' | 'to-images' | 'to-pdf';
export interface Batch { mode: BatchMode | null; files: OpenedFile[] }
export interface UpdateInfo { version: string; notes: string; install(progress: (done: number, total: number) => void): Promise<void> }
export interface Platform {
  kind: 'web' | 'desktop';
  pickPdfs(multiple?: boolean): Promise<OpenedFile[]>;
  /** 원래 자리에 덮어쓰기. 할 수 없으면 false (→ 다른 이름으로 저장) */
  saveInPlace(file: SavedTarget, bytes: Uint8Array): Promise<boolean>;
  saveAs(suggestedName: string, bytes: Uint8Array, kind?: FileKind): Promise<SavedTarget | null>;
  pickImages(): Promise<File[]>;
  /** 설치된 글꼴 (TrueType만) */
  listFonts(): Promise<{ family: string; path: string; index: number; korean: boolean }[]>;
  fontBytes(path: string): Promise<Uint8Array>;
  /** 실행할 때 받은 파일 (탐색기 메뉴로 실행했으면 mode가 있다) */
  initialFiles(): Promise<Batch>;
  onExternalOpen(cb: (b: Batch) => void): void;
  /** 여러 파일을 폴더에 저장 (데스크톱) */
  pickFolder?(): Promise<string | null>;
  writeInFolder?(dir: string, name: string, bytes: Uint8Array): Promise<string>;
  reveal?(path: string): void;
  /** 기본 PDF 프로그램: 지금 상태(알 수 없으면 null)와 지정하기 */
  defaultApp?: { status(): Promise<boolean | null>; make(): Promise<void> };
  version?(): Promise<string>;
  checkUpdate?(): Promise<UpdateInfo | null>;
  readPath(path: string): Promise<OpenedFile>;
  recent(): string[];
  addRecent(path: string): void;
  setTitle(title: string): void;
  openUrl(url: string): void;
  onCloseRequest(cb: () => Promise<boolean>): void;
  toggleFullscreen(): Promise<void>;
}
export type FileKind = 'pdf' | 'png' | 'jpg' | 'zip';
export const KINDS: Record<FileKind, { mime: string; ext: string[]; label: string }> = {
  pdf: { mime: 'application/pdf', ext: ['pdf'], label: 'PDF 문서' }, png: { mime: 'image/png', ext: ['png'], label: 'PNG 그림' },
  jpg: { mime: 'image/jpeg', ext: ['jpg', 'jpeg'], label: 'JPEG 그림' }, zip: { mime: 'application/zip', ext: ['zip'], label: 'ZIP 압축 파일' },
};
export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
