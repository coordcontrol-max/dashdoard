// Botão de tela cheia — incluir em todas as páginas autenticadas.
(function () {
  const ICON_ENTER = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/></svg>`;
  const ICON_EXIT  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 01-2 2H3"/><path d="M21 8h-3a2 2 0 01-2-2V3"/><path d="M3 16h3a2 2 0 012 2v3"/><path d="M16 21v-3a2 2 0 012-2h3"/></svg>`;

  function atualizarBotoes() {
    const ativo = !!document.fullscreenElement;
    document.querySelectorAll('.btn-fullscreen').forEach(b => {
      b.innerHTML = ativo ? ICON_EXIT : ICON_ENTER;
      b.title = ativo ? 'Sair da tela cheia' : 'Tela cheia';
    });
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (req) req.call(el).catch(() => {});
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.btn-fullscreen').forEach(b => {
      b.addEventListener('click', toggleFullscreen);
    });
    atualizarBotoes();
  });
  document.addEventListener('fullscreenchange', atualizarBotoes);
})();
