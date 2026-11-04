import './styles.css';
import { App } from './app.ts';
import { EngineClient } from './engine/client.ts';
import { loadPlatform } from './platform/index.ts';

const t0 = performance.now();
const engine = new EngineClient();
const [platform] = await Promise.all([loadPlatform(), engine.ready]);
const app = new App(engine, platform);
(window as any).__app = app;
(window as any).__bootMs = performance.now() - t0;
const batch = await platform.initialFiles();
if (batch.files.length) await app.handleBatch(batch);
const params = new URL(location.href).searchParams;
if (params.get('mode') === 'edit' && app.doc) app.setMode('edit');
