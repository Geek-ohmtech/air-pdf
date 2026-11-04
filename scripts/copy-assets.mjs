// node_modules에서 앱이 실행 중에 읽는 파일(글꼴, wasm, OCR 자료)을 public/vendor로 복사한다
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nm = p => path.join(root, 'node_modules', p);
const out = p => path.join(root, 'public', 'vendor', p);
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to); };
copy(nm('@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf'), out('fonts/NotoSansKR-Regular.ttf'));
copy(nm('harfbuzzjs/dist/harfbuzz-subset.wasm'), out('harfbuzz-subset.wasm'));
copy(nm('@expo-google-fonts/nanum-gothic/400Regular/NanumGothic_400Regular.ttf'), out('fonts/NanumGothic-Regular.ttf'));
copy(nm('@expo-google-fonts/nanum-myeongjo/400Regular/NanumMyeongjo_400Regular.ttf'), out('fonts/NanumMyeongjo-Regular.ttf'));
copy(nm('@expo-google-fonts/nanum-pen-script/400Regular/NanumPenScript_400Regular.ttf'), out('fonts/NanumPenScript-Regular.ttf'));
copy(nm('tesseract.js/dist/worker.min.js'), out('ocr/worker.min.js'));
for (const f of fs.readdirSync(nm('tesseract.js-core'))) {
  if (/^tesseract-core-(relaxedsimd|simd)-lstm\.wasm\.js$/.test(f)) copy(nm('tesseract.js-core/' + f), out('ocr/core/' + f));
}
copy(nm('@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz'), out('ocr/lang/kor.traineddata.gz'));
copy(nm('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), out('ocr/lang/eng.traineddata.gz'));
const size = d => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`vendor 자료 준비 완료 (${(size(path.join(root, 'public', 'vendor')) / 1048576).toFixed(1)}MB)`);
