import './styles.css';
import { App } from './app.ts';
import { EngineClient } from './engine/client.ts';
import { loadPlatform } from './platform/index.ts';

const t0 = performance.now();
const splash = document.getElementById('splash');
const say = (m: string) => { const e = splash?.querySelector('.msg'); if (e) e.textContent = m; };
const hideSplash = () => { if (!splash) return; splash.classList.add('out'); setTimeout(() => splash.remove(), 220); };
// 엔진(워커)을 가장 먼저 띄우고, 그동안 화면을 만들고 넘어온 파일을 읽는다
const engine = new EngineClient();
const platform = await loadPlatform();
const app = new App(engine, platform);
(window as any).__app = app;
// 시험용: 늦게 불러오는 모듈에 닿는 길
(window as any).__mods = { ocr: () => import('./editor/ocr.ts'), scan: () => import('./scan/scan.ts'), tools: () => import('./tools.ts') };
const batchP = platform.initialFiles().catch(() => ({ mode: null, files: [] }));
await engine.ready;
(window as any).__bootMs = performance.now() - t0;
const batch = await batchP;
if (batch.files.length) {
  say(batch.files.length > 1 ? `문서 ${batch.files.length}개를 여는 중…` : `“${batch.files[0].name}” 여는 중…`);
  await app.handleBatch(batch);
}
// 다른 창에서 떼어 낸 탭으로 연 새 창
const transfer = (window as any).__AIRPDF_TRANSFER__ ?? new URL(location.href).searchParams.get('transfer');
if (transfer && platform.tabs) { say('문서를 옮겨 오는 중…'); await app.adoptTransfer(+transfer); }
hideSplash();
const params = new URL(location.href).searchParams;
if (params.get('mode') === 'edit' && app.doc) app.setMode('edit');
