// Renderiza a sidebar dinamicamente em todas as páginas autenticadas.
// Suporta colapsar/expandir o painel todo (botão toggle) e drilldown por grupo.
(async function () {
  const aside = document.querySelector('.sidebar');
  if (!aside) return;

  const KEY = 'sidebar_colapsada';
  const KEY_GRUPOS = 'sidebar_grupos_estado'; // { 'Comercial': 'open'|'closed', ... }
  const colapsadaInicial = (function () {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  })();
  if (colapsadaInicial) aside.classList.add('collapsed');

  function lerEstadoGrupos() {
    try { return JSON.parse(localStorage.getItem(KEY_GRUPOS) || '{}'); }
    catch { return {}; }
  }
  function salvarEstadoGrupos(obj) {
    try { localStorage.setItem(KEY_GRUPOS, JSON.stringify(obj)); } catch {}
  }

  let isAdmin = false;
  try {
    const r = await fetch('/api/me');
    if (r.ok) { const me = await r.json(); isAdmin = !!me.is_admin; }
  } catch {}

  const SIDEBAR_GROUPS = [
    {
      name: 'Comercial',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11a1 1 0 001 1h14a1 1 0 001-1V9"/><path d="M9 21v-6a2 2 0 014 0v6"/></svg>`,
      items: [
        { label: 'Painel ao Vivo', href: '/painel-vivo' },
        { label: 'Venda Diária', href: '/venda-diaria' },
        { label: 'Ruptura', href: '/ruptura' },
        { label: 'Troca', href: '/troca' },
        { label: "KPIs Comerciais", href: '/kpis' },
        { label: 'Nível Estratégia', href: '/estrategia' },
        { label: 'Margem', href: '/' },
      ],
    },
    {
      name: 'Financeiro',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
      items: [
        { label: 'DRE PowerBI', href: '/dre' },
      ],
    },
    {
      name: 'RH / DP',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
      items: [
        { label: 'Vagas em Aberto', href: '/vagas' },
      ],
    },
    {
      name: 'Operação',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
      items: [
        { label: 'Operação', href: '/operacao' },
        { label: 'Margem por Loja', href: '/margem-loja' },
      ],
    },
  ];

  if (isAdmin) {
    SIDEBAR_GROUPS.push({
      name: 'Administração',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3 3-2-2"/></svg>`,
      items: [
        { label: 'Configurações', href: '/admin' },
        { label: 'Metas Manuais', href: '/metas' },
      ],
    });
  }

  const path = location.pathname.replace(/\/$/, '') || '/';
  const estadoGrupos = lerEstadoGrupos();

  const html = [];
  html.push(`
    <div class="sidebar-brand">
      <div class="brand-mark">SV</div>
      <div class="brand-text">
        <div class="brand-name">Supervendas</div>
        <div class="brand-sub">Kpi's Comercial</div>
      </div>
      <button class="sidebar-toggle" type="button" title="Recolher menu" aria-label="Recolher menu">
        <svg class="ico-collapse" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        <svg class="ico-expand" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </button>
    </div>
  `);

  for (const g of SIDEBAR_GROUPS) {
    const primeiroHref = g.items[0]?.href || '#';
    const itemsHtml = g.items.map(it => {
      const isActive = (it.href === '/' && path === '/') || (it.href !== '/' && (path === it.href || path.startsWith(it.href + '/')));
      return `<a href="${it.href}" class="sidebar-item${isActive ? ' active' : ''}">${it.label}</a>`;
    }).join('');
    const grupoAtivo = g.items.some(it => (it.href === '/' && path === '/') || (it.href !== '/' && path === it.href));

    // Drilldown: por padrão o grupo da página atual fica aberto, os demais fechados.
    // Estado salvo em localStorage por grupo sobrescreve o padrão.
    const estadoSalvo = estadoGrupos[g.name];
    const aberto = estadoSalvo ? (estadoSalvo === 'open') : grupoAtivo;
    const groupClasses = ['sidebar-group'];
    if (grupoAtivo) groupClasses.push('has-active');
    if (!aberto) groupClasses.push('is-closed');

    html.push(`
      <div class="${groupClasses.join(' ')}" data-group="${g.name}">
        <a href="${primeiroHref}" class="sidebar-group-title" title="${g.name}">
          <span class="group-icon">${g.icon}</span>
          <span class="group-name">${g.name}</span>
          <svg class="group-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </a>
        ${itemsHtml}
      </div>
    `);
  }

  aside.innerHTML = html.join('');

  // Toggle do painel inteiro (desktop)
  const btn = aside.querySelector('.sidebar-toggle');
  btn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    aside.classList.toggle('collapsed');
    const colapsada = aside.classList.contains('collapsed');
    try { localStorage.setItem(KEY, colapsada ? '1' : '0'); } catch {}
    btn.title = colapsada ? 'Expandir menu' : 'Recolher menu';
  });

  // Drilldown: clique no título do grupo alterna abrir/fechar (sem navegar).
  // Quando a sidebar está colapsada (só ícones), o clique mantém o comportamento
  // antigo de navegar pro primeiro item.
  aside.addEventListener('click', (e) => {
    const title = e.target.closest('.sidebar-group-title');
    if (!title) return;
    if (aside.classList.contains('collapsed')) return; // ícones: deixa navegar
    e.preventDefault();
    const grupo = title.closest('.sidebar-group');
    const nome = grupo?.dataset.group;
    if (!grupo || !nome) return;
    grupo.classList.toggle('is-closed');
    const fechado = grupo.classList.contains('is-closed');
    const estado = lerEstadoGrupos();
    estado[nome] = fechado ? 'closed' : 'open';
    salvarEstadoGrupos(estado);
  });

  // ===== Mobile: botão hamburguer + backdrop =====
  document.body.classList.add('has-sidebar');
  if (!document.querySelector('.mobile-menu-btn')) {
    const hamburger = document.createElement('button');
    hamburger.className = 'mobile-menu-btn';
    hamburger.setAttribute('aria-label', 'Abrir menu');
    hamburger.innerHTML = '☰';
    document.body.appendChild(hamburger);

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    const fechar = () => {
      aside.classList.remove('mobile-open');
      backdrop.classList.remove('show');
    };
    hamburger.addEventListener('click', () => {
      const aberta = aside.classList.toggle('mobile-open');
      backdrop.classList.toggle('show', aberta);
    });
    backdrop.addEventListener('click', fechar);
    // Fecha ao clicar num item da sidebar (navegação)
    aside.addEventListener('click', (e) => {
      if (e.target.closest('.sidebar-item')) fechar();
    });
  }
})();
