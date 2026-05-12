// Service worker mínimo — habilita instalação como PWA.
// Sem cache offline complexo: tudo passa direto pelo network.
// Se quiser offline depois, dá pra adicionar cache de páginas estáticas aqui.

const VERSION = 'sv-1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Deixa o navegador resolver normalmente. Service worker só precisa existir
  // (com fetch handler) pro Chrome considerar o PWA instalável.
});
