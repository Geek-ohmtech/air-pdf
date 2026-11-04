// 자동 업데이트 안내 파일(release/latest.json) 만들기
// 쓰는 법: node scripts/make-latest.mjs "바뀐 점 한 줄"
// 앞서 서명 키(TAURI_SIGNING_PRIVATE_KEY)를 넣고 Windows 설치 파일을 빌드해 .sig가 있어야 한다.
import fs from 'node:fs';
const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const v = conf.version, exe = `AirPDF_${v}_x64-setup.exe`;
const sigPath = [`src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/${exe}.sig`, `src-tauri/target/release/bundle/nsis/${exe}.sig`].find(p => fs.existsSync(p));
if (!sigPath) { console.error('서명 파일(.sig)이 없습니다. 서명 키를 넣고 먼저 빌드하세요.'); process.exit(1); }
const signature = fs.readFileSync(sigPath, 'utf8').trim();
const url = `https://raw.githubusercontent.com/Geek-ohmtech/air-pdf/main/release/${exe}`;
const out = {
  version: v,
  notes: process.argv[2] || `Air PDF ${v}`,
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  platforms: { 'windows-x86_64': { signature, url }, 'windows-x86_64-nsis': { signature, url } },
};
fs.writeFileSync('release/latest.json', JSON.stringify(out, null, 2) + '\n');
console.log('release/latest.json →', v);
