/** 엔진 ↔ 화면이 주고받는 자료. 좌표는 전부 화면 pt(좌상단 원점, 쪽 회전 반영) */
export interface Rect { x: number; y: number; w: number; h: number }
export interface PageSize { key: number; w: number; h: number }
export interface DocInfo {
  pageCount: number; pages: PageSize[];
  title: string; author: string; subject: string; creator: string; producer: string; created: string; modified: string;
  version: string; encrypted: boolean; permissions: number;
}
export interface RenderResult { width: number; height: number; x: number; y: number; data: Uint8ClampedArray }
export interface TextData { text: string; boxes: Float32Array }
export interface SearchHit { page: number; index: number; length: number; rects: Rect[]; before: string; match: string; after: string }
export interface LinkInfo { rect: Rect; page?: number; top?: number; uri?: string }
export interface OutlineItem { title: string; page: number; top?: number; children: OutlineItem[] }
export interface AnnotInfo { id: number; subtype: number; kind: string; page: number; rect: Rect; contents: string; author: string; modified: string; color: string }
export interface TextRun {
  objs: number[]; text: string; rect: Rect; size: number; color: string; font: string;
  bold: boolean; italic: boolean; embedded: boolean; invisible: boolean; origin: { x: number; y: number }; angle: number;
  inForm?: boolean;
}
export interface PageObjInfo { h: number; type: 'image' | 'path' | 'form' | 'shape' | 'free' | 'textbox'; rect: Rect; inForm?: boolean; meta?: any; objs?: number[] }
