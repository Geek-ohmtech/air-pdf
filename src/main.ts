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
const batchP = platform.initialFiles().catch(() => ({ mode: null, files: [] }));
await engine.ready;
(window as any).__bootMs = performance.now() - t0;
const batch = await batchP;
if (batch.files.length) {
  say(batch.files.length > 1 ? `문서 ${batch.files.length}개를 여는 중…` : `“${batch.files[0].name}” 여는 중…`);
  await app.handleBatch(batch);
}
hideSplash();
const params = new URL(location.href).searchParams;
if (params.get('mode') === 'edit' && app.doc) app.setMode('edit');
