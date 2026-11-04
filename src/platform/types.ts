export interface OpenedFile { name: string; bytes: Uint8Array; path?: string; handle?: any }
export interface SavedTarget { name: string; path?: string; handle?: any }
export interface Platform {
  kind: 'web' | 'desktop';
  pickPdfs(multiple?: boolean): Promise<OpenedFile[]>;
  /** 원래 자리에 덮어쓰기. 할 수 없으면 false (→ 다른 이름으로 저장) */
  saveInPlace(file: SavedTarget, bytes: Uint8Array): Promise<boolean>;
  saveAs(suggestedName: string, bytes: Uint8Array, kind?: FileKind): Promise<SavedTarget | null>;
  pickImages(): Promise<File[]>;
  initialFiles(): Promise<OpenedFile[]>;
  onExternalOpen(cb: (files: OpenedFile[]) => void): void;
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
