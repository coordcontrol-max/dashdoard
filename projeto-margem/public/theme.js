// Aplica o tema ANTES do CSS pintar a tela (evita piscar do dark→light).
// Inclua este script no <head> de cada página, ANTES do <link rel="stylesheet">.
(function () {
  const KEY = 'margem_theme';
  const stored = (function () {
    try { return localStorage.getItem(KEY); } catch { return null; }
  })();
  const theme = stored || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();

// Toggle exposto globalmente — chamado pelo botão.
window.toggleTema = function () {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('margem_theme', next); } catch {}
  // atualiza ícone do botão se existir
  document.querySelectorAll('.btn-theme').forEach(b => {
    b.innerHTML = next === 'dark' ? '☀️' : '🌙';
    b.title = next === 'dark' ? 'Modo claro' : 'Modo escuro';
  });
};

// Inicializa ícone do botão depois do DOM
document.addEventListener('DOMContentLoaded', function () {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('.btn-theme').forEach(b => {
    b.innerHTML = cur === 'dark' ? '☀️' : '🌙';
    b.title = cur === 'dark' ? 'Modo claro' : 'Modo escuro';
    b.addEventListener('click', window.toggleTema);
  });
});
