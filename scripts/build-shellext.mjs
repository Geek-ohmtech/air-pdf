// 탐색기 미리보기 확장(DLL)을 만들어 설치 파일에 넣을 자리에 둔다. Windows용 빌드에서만 한다.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || (process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : '');
if (!triple.includes('windows')) { console.log('셸 확장: Windows용 빌드가 아니라 건너뜀'); process.exit(0); }
const dir = path.resolve('src-tauri/shellext');
execSync(`cargo build --release --target ${triple}`, { cwd: dir, stdio: 'inherit' });
fs.mkdirSync('src-tauri/shell-bin', { recursive: true });
// .bin 이름으로 넣는다: 설치 프로그램이 판마다 새 이름의 .dll로 복사해 등록한다 (쓰는 중인 DLL은 덮어쓸 수 없어서)
fs.copyFileSync(path.join(dir, 'target', triple, 'release', 'airpdf_shell.dll'), 'src-tauri/shell-bin/airpdf_shell.dll.bin');
console.log('셸 확장 준비됨:', triple);
