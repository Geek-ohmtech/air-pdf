/** 엔진 ↔ 화면이 주고받는 자료. 좌표는 전부 화면 pt(좌상단 원점, 페이지 회전 반영) */
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
export interface PageObjInfo { h: number; type: 'image' | 'path' | 'form' | 'shape' | 'free' | 'textbox'; rect: Rect; inForm?: boolean; meta?: any; objs?: number[]; /** 원본 선·도형: 칠·선이 보이는지, 흰색으로만 칠했는지(눌러서 고르지 않음) */ vis?: { fill: boolean; stroke: boolean; ghost: boolean }; /** 페이지를 거의 다 덮는 그림 (스캔 페이지 바탕) */ bg?: boolean }
