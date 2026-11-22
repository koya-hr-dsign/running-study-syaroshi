/* 描画前にテーマを当てて、切り替え時のちらつきを防ぐ */
(function () {
  var t = 'light';
  try { t = (JSON.parse(localStorage.getItem('sq.settings') || '{}').theme) || 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t);
})();
