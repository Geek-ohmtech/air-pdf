// 첫 화면이 그려지기 전에 테마를 적용한다 (번쩍임 없이). 설정은 앱이 저장한 airpdf.prefs에서 읽는다.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('airpdf.prefs') || '{}'), el = document.documentElement;
    if (p.theme === 'light' || p.theme === 'dark') el.setAttribute('data-theme', p.theme);
    var a = p.accent || 'air'; if (a !== 'blue') el.setAttribute('data-accent', a);
  } catch (e) { /* 기본값 */ }
})();
