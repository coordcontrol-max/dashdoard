// ========== Estado ==========
let DADOS = null;
let me = null;
let escopo = 'geral';   // 'geral' ou '20x80'
let pagina = 1;
const POR_PAGINA = 100;
let busca = '';
let filtroComprador = '';
let filtroLoja = '';
let filtroFornecedor = '';
let compradorFocado = null;  // nome do comprador em foco no gráfico (null = todos)

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const fmtMed = (v) => v == null || isNaN(v) ? '—' : v.toFixed(2).replace('.', ',');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

function classPct(v) {
  if (v == null || isNaN(v)) return '';
  if (v >= 0.20) return '';        // vermelho default
  if (v >= 0.12) return 'warn';
  return 'ok';
}

// ========== KPIs ==========
function renderKPIs() {
  const k = DADOS.kpis;
  const tot = escopo === '20x80' ? k.total_20x80 : k.total_geral;

  if (tot) {
    const pctEl = $('#kpiPctRuptura');
    pctEl.querySelector('.val').textContent = fmtPct(tot.pct);
    pctEl.querySelector('.sub').textContent = `vs meta ${fmtPct(k.meta_geral)}`;
    pctEl.classList.toggle('alerta', tot.pct > k.meta_geral);
    pctEl.classList.toggle('ok', tot.pct <= k.meta_geral);

    $('#kpiSkus').querySelector('.val').textContent = fmtNum(tot.skus);
    $('#kpiZerados').querySelector('.val').textContent = fmtNum(tot.zerados);
  }

  // Variação último dia (do ranking de compradores via Evolução Diária)
  const ev = DADOS.evolucao_diaria;
  const evList = escopo === '20x80' ? ev['20x80'] : ev.geral;
  const totalGeral = evList.find(c => c.nome === 'Total Geral');
  let variacao = '—';
  let subVar = '';
  if (totalGeral && ev.datas.length >= 2) {
    const ultDia = totalGeral.por_dia[ev.datas[ev.datas.length - 1]];
    const penDia = totalGeral.por_dia[ev.datas[ev.datas.length - 2]];
    if (ultDia != null && penDia != null) {
      const dif = ultDia - penDia;
      variacao = (dif >= 0 ? '+' : '') + (dif * 100).toFixed(2).replace('.', ',') + 'pp';
      subVar = `${ev.datas[ev.datas.length - 2]} → ${ev.datas[ev.datas.length - 1]}`;
    }
  }
  const varEl = $('#kpiVariacao');
  varEl.querySelector('.val').textContent = variacao;
  varEl.querySelector('.sub').textContent = subVar || 'vs dia anterior';

  $('#kpiFornEm100').querySelector('.val').textContent = fmtNum(k.fornecedores_em_ruptura || 0);
}

// ========== Gráfico ==========
function renderGrafico() {
  const svg = $('#graficoRuptura');
  const W = 1200, H = 300;
  const PAD_L = 60, PAD_R = 200, PAD_T = 20, PAD_B = 36;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const ev = DADOS.evolucao_diaria;
  const datas = ev.datas;
  if (!datas.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="currentColor">Sem dados</text>'; return; }

  const todosCompradores = (escopo === '20x80' ? ev['20x80'] : ev.geral).filter(c => c.nome !== 'META 12%' && c.nome !== 'Total Geral');
  const total = (escopo === '20x80' ? ev['20x80'] : ev.geral).find(c => c.nome === 'Total Geral');
  const meta = 0.12;

  // Modo padrão: só Total Geral + meta. Quando clica num comprador na legenda,
  // entra em modo "focado" e mostra a curva dele em destaque.
  const focado = compradorFocado ? todosCompradores.find(c => c.nome === compradorFocado) : null;
  const lista = focado ? [focado] : [];  // sem foco = não desenha linhas individuais

  // Atualiza head com nome focado + botão de voltar
  const headInfo = $('#graficoHeadInfo');
  if (headInfo) {
    if (focado) {
      headInfo.innerHTML = `<span style="color:var(--text-muted);">Mostrando:</span>
        <strong style="margin:0 8px;color:var(--accent);">${escapeHtml(focado.nome)}</strong>
        <button id="btnLimparFoco" class="btn-mini">← Voltar pro total</button>`;
      const btn = $('#btnLimparFoco');
      if (btn) btn.addEventListener('click', () => { compradorFocado = null; renderGrafico(); });
    } else {
      headInfo.innerHTML = '<span class="hint">linha tracejada vermelha = meta 12% · clique num comprador na legenda pra focar nele</span>';
    }
  }

  // Determina min/max em y
  let max = meta;
  for (const c of [...lista, total].filter(Boolean)) {
    for (const data of datas) {
      const v = c.por_dia?.[data];
      if (typeof v === 'number' && v > max) max = v;
    }
  }
  max = Math.ceil(max * 100) / 100 + 0.02;
  const min = 0;

  const xAt = (i) => PAD_L + (datas.length === 1 ? innerW / 2 : (i / (datas.length - 1)) * innerW);
  const yAt = (v) => PAD_T + innerH - ((v - min) / (max - min)) * innerH;

  // Grid horizontal
  const grids = [];
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * (i / 4);
    const y = yAt(v);
    grids.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity=".1"/>`);
    grids.push(`<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" fill="currentColor" fill-opacity=".55" font-size="10">${(v * 100).toFixed(1)}%</text>`);
  }

  // Eixo X
  const tickLines = [];
  for (let i = 0; i < datas.length; i++) {
    const x = xAt(i);
    tickLines.push(`<line x1="${x}" x2="${x}" y1="${PAD_T + innerH}" y2="${PAD_T + innerH + 4}" stroke="currentColor" stroke-opacity=".3"/>`);
    tickLines.push(`<text x="${x}" y="${PAD_T + innerH + 18}" text-anchor="middle" fill="currentColor" fill-opacity=".55" font-size="10">${escapeHtml(datas[i])}</text>`);
  }

  // Linha de meta
  const yMeta = yAt(meta);
  const linhaMeta = `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yMeta}" y2="${yMeta}" stroke="#dc3545" stroke-width="1.5" stroke-dasharray="6 4"/>
                     <text x="${W - PAD_R + 4}" y="${yMeta + 4}" fill="#dc3545" font-size="11" font-weight="600">META 12%</text>`;

  // Cores rotativas pros compradores
  const palette = ['#1f8a45', '#2c75c5', '#f5a522', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#0ea5e9', '#f97316', '#8b5cf6', '#10b981', '#f43f5e', '#6366f1', '#eab308'];
  const linhasComp = [];
  const pontos = [];     // bolinhas nos pontos (só quando focado)
  const legenda = [];
  lista.forEach((c, idx) => {
    // Quando focado, usa cor da palette baseada no índice ORIGINAL pra manter consistência visual
    const idxOriginal = todosCompradores.indexOf(c);
    const cor = palette[idxOriginal % palette.length];
    let path = '';
    let started = false;
    datas.forEach((d, i) => {
      const v = c.por_dia?.[d];
      if (typeof v === 'number') {
        path += (started ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1) + ' ';
        started = true;
        if (focado) {
          pontos.push(`<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="4" fill="${cor}"/>
                       <text x="${xAt(i).toFixed(1)}" y="${(yAt(v) - 8).toFixed(1)}" text-anchor="middle" fill="${cor}" font-size="11" font-weight="700">${(v * 100).toFixed(1)}%</text>`);
        }
      }
    });
    if (path) {
      const sw = focado ? 3 : 1.6;
      const op = focado ? 1 : 0.65;
      linhasComp.push(`<path d="${path}" fill="none" stroke="${cor}" stroke-width="${sw}" opacity="${op}"/>`);
    }
    legenda.push({ nome: c.nome, cor });
  });

  // Linha grossa do total geral (sempre visível como referência)
  let pathTotal = '';
  const pontosTotal = [];
  if (total) {
    let started = false;
    datas.forEach((d, i) => {
      const v = total.por_dia?.[d];
      if (typeof v === 'number') {
        pathTotal += (started ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1) + ' ';
        started = true;
        // Quando NÃO está focado, mostra bolinhas e % na linha do total
        if (!focado) {
          pontosTotal.push(`<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="4" fill="var(--accent)"/>
                       <text x="${xAt(i).toFixed(1)}" y="${(yAt(v) - 8).toFixed(1)}" text-anchor="middle" fill="var(--accent)" font-size="11" font-weight="700">${(v * 100).toFixed(2).replace('.', ',')}%</text>`);
        }
      }
    });
  }
  const totalSw = focado ? 2 : 3.5;
  const totalOp = focado ? 0.5 : 1;
  const linhaTotal = pathTotal ? `<path d="${pathTotal}" fill="none" stroke="var(--accent)" stroke-width="${totalSw}" opacity="${totalOp}"/>` : '';

  // Legenda à direita — interativa (clique pra focar)
  const legHtml = ['<g transform="translate(' + (W - PAD_R + 4) + ',' + (PAD_T + 30) + ')">'];
  if (total) legHtml.push(`<g transform="translate(0,0)"><line x1="0" x2="18" y1="6" y2="6" stroke="var(--accent)" stroke-width="3"/><text x="22" y="10" fill="currentColor" font-size="11" font-weight="700">Total Geral</text></g>`);
  // Legenda completa (todos os compradores) — itens clicáveis
  todosCompradores.slice(0, 12).forEach((c, i) => {
    const cor = palette[i % palette.length];
    const y = 22 + i * 14;
    const isFoc = focado && focado.nome === c.nome;
    const opac = focado && !isFoc ? '.3' : '.85';
    const fw = isFoc ? '700' : '400';
    legHtml.push(`
      <g class="lg-comp" data-nome="${escapeHtml(c.nome)}" transform="translate(0,${y})" style="cursor:pointer;">
        <rect x="-2" y="-3" width="180" height="14" fill="transparent"/>
        <line x1="0" x2="18" y1="6" y2="6" stroke="${cor}" stroke-width="${isFoc ? 3 : 2}" opacity="${opac}"/>
        <text x="22" y="10" fill="currentColor" fill-opacity="${opac}" font-size="10" font-weight="${fw}">${escapeHtml(c.nome.slice(0, 18))}</text>
      </g>`);
  });
  legHtml.push('</g>');

  svg.innerHTML = grids.join('') + tickLines.join('') + linhaMeta + linhasComp.join('') + linhaTotal + pontosTotal.join('') + pontos.join('') + legHtml.join('');

  // Click handlers nos itens da legenda — alterna foco
  svg.querySelectorAll('.lg-comp').forEach(g => {
    g.addEventListener('click', () => {
      const nome = g.dataset.nome;
      compradorFocado = (compradorFocado === nome) ? null : nome;
      renderGrafico();
    });
  });
}

// ========== Rankings ==========
function renderRanking(elemId, lista, comClick) {
  const el = $(elemId);
  if (!lista || !lista.length) { el.innerHTML = '<div class="ru-rank-row disabled" style="padding:14px;color:var(--text-muted);">Sem dados</div>'; return; }
  // Filtra "Total Geral" e "META"
  const filtrado = lista.filter(r => {
    const n = r.nome || '';
    return !n.includes('Total Geral') && !n.includes('META') && (r.pct || 0) > 0;
  });
  filtrado.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  const top = filtrado.slice(0, 15);
  el.innerHTML = top.map((r, i) => {
    const posCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    const pctCls = classPct(r.pct);
    return `
      <div class="ru-rank-row ${comClick ? '' : 'disabled'}" data-nome="${escapeHtml(r.nome)}">
        <span class="pos ${posCls}">#${i + 1}</span>
        <span class="nome" title="${escapeHtml(r.nome)}">${escapeHtml(r.nome)}</span>
        <span class="skus">${fmtNum(r.zerados)}/${fmtNum(r.skus)}</span>
        <span class="pct ${pctCls}">${fmtPct(r.pct)}</span>
      </div>
    `;
  }).join('');
}

// ========== Resumo executivo ==========
function renderResumoExecutivo() {
  const TOP = 5;

  // Filtra itens pelo escopo atual
  let itens = DADOS.itens || [];
  if (escopo === '20x80') itens = itens.filter(i => i.is_20x80);

  // ----- Compradores e Lojas: usa rankings já calculados (com % real) -----
  const rkComp = (escopo === '20x80' ? DADOS.ranking_compradores['20x80'] : DADOS.ranking_compradores.geral) || [];
  const rkLoja = (escopo === '20x80' ? DADOS.ranking_lojas['20x80'] : DADOS.ranking_lojas.geral) || [];

  function pintaRow(seletor, lista, fmtVal, onClick) {
    const el = $(seletor);
    if (!lista.length) { el.innerHTML = '<div class="ru-resumo-row disabled" style="color:var(--text-muted);">Sem dados</div>'; return; }
    el.innerHTML = lista.map((r, i) => `
      <div class="ru-resumo-row${onClick ? '' : ' disabled'}" data-nome="${escapeHtml(r.nome)}" data-codigo="${r.codigo || ''}">
        <span class="pos">#${i + 1}</span>
        <span class="nome" title="${escapeHtml(r.nome)}">${escapeHtml(r.nome)}</span>
        <span class="val ${r.pctClass || ''}">${fmtVal(r)}</span>
      </div>
    `).join('');
    if (onClick) {
      el.querySelectorAll('.ru-resumo-row').forEach(row => {
        row.addEventListener('click', () => onClick(row.dataset));
      });
    }
  }

  // Compradores: top 5 por % (descontando "Total Geral"/"META")
  const compradores = rkComp
    .filter(r => !/(total geral|meta)/i.test(r.nome) && (r.pct || 0) > 0)
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))
    .slice(0, TOP)
    .map(r => ({ ...r, pctClass: classPct(r.pct) }));
  pintaRow('#resumoCompradores', compradores, r => fmtPct(r.pct), d => abrirDrill('comprador', d.nome));

  // Lojas: top 5 por %
  const lojas = rkLoja
    .filter(r => !/(total geral|meta)/i.test(r.nome) && (r.pct || 0) > 0)
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))
    .slice(0, TOP)
    .map(r => ({ ...r, pctClass: classPct(r.pct) }));
  pintaRow('#resumoLojas', lojas, r => fmtPct(r.pct), d => abrirDrill('loja', d.nome));

  // ----- Fornecedores: agrupa itens do escopo atual -----
  const forn = new Map();
  for (const it of itens) {
    const k = it.fornecedor || '—';
    if (!forn.has(k)) forn.set(k, { nome: k, qtd: 0, media: 0 });
    const g = forn.get(k);
    g.qtd += 1;
    g.media += (it.media_venda || 0);
  }
  const fornTop = Array.from(forn.values()).sort((a, b) => b.qtd - a.qtd).slice(0, TOP);
  pintaRow('#resumoFornecedores', fornTop, r => `${fmtNum(r.qtd)} SKUs`, null);

  // ----- Produtos que mais doem: top 5 por média de venda perdida -----
  // Agrupa por código (mesmo produto em várias lojas vira 1 só, somando média)
  const prods = new Map();
  for (const it of itens) {
    const k = it.codigo || it.produto;
    if (!prods.has(k)) {
      prods.set(k, { nome: it.produto, codigo: it.codigo, qtd: 0, media: 0 });
    }
    const g = prods.get(k);
    g.qtd += 1;
    g.media += (it.media_venda || 0);
  }
  const prodTop = Array.from(prods.values()).sort((a, b) => b.media - a.media).slice(0, TOP);
  pintaRow('#resumoProdutos', prodTop, r => fmtMed(r.media),
           d => abrirDrill('produto', d.nome, d.codigo));
}

function renderRankings() {
  const lista = escopo === '20x80' ? DADOS.ranking_compradores['20x80'] : DADOS.ranking_compradores.geral;
  renderRanking('#rankCompradores', lista, true);
  const lojas = escopo === '20x80' ? DADOS.ranking_lojas['20x80'] : DADOS.ranking_lojas.geral;
  renderRanking('#rankLojas', lojas, true);

  // Click handlers
  $$('#rankCompradores .ru-rank-row').forEach(r => {
    r.addEventListener('click', () => abrirDrill('comprador', r.dataset.nome));
  });
  $$('#rankLojas .ru-rank-row').forEach(r => {
    r.addEventListener('click', () => abrirDrill('loja', r.dataset.nome));
  });
}

// ========== Tabela analítica ==========
function itensFiltrados() {
  let arr = DADOS.itens || [];
  if (escopo === '20x80') arr = arr.filter(i => i.is_20x80);
  if (filtroComprador) arr = arr.filter(i => normComp(i.comprador) === normComp(filtroComprador));
  if (filtroLoja) arr = arr.filter(i => i.loja === filtroLoja);
  if (filtroFornecedor) arr = arr.filter(i => (i.fornecedor || '') === filtroFornecedor);
  if (busca) {
    const q = busca.toLowerCase();
    arr = arr.filter(i =>
      (i.produto || '').toLowerCase().includes(q) ||
      (i.comprador || '').toLowerCase().includes(q) ||
      (i.loja || '').toLowerCase().includes(q) ||
      String(i.codigo || '').includes(q)
    );
  }
  // Ordena por média de venda (maior pro menor) — itens que mais perdem venda no topo.
  return [...arr].sort((a, b) => (b.media_venda ?? 0) - (a.media_venda ?? 0));
}

function renderTabela() {
  const arr = itensFiltrados();
  const inicio = (pagina - 1) * POR_PAGINA;
  const slice = arr.slice(inicio, inicio + POR_PAGINA);
  const tbody = $('#tbodyItens');
  tbody.innerHTML = slice.map(i => `
    <tr>
      <td><span class="produto-link" data-codigo="${i.codigo}" data-produto="${escapeHtml(i.produto)}">${escapeHtml(i.produto)}</span></td>
      <td>${i.codigo || '—'}</td>
      <td>${escapeHtml(i.loja)}</td>
      <td>${escapeHtml(i.comprador)}</td>
      <td class="num">${fmtMed(i.media_venda)}</td>
      <td class="center">${i.is_20x80 ? '<span class="badge-2080">20×80</span>' : ''}</td>
    </tr>
  `).join('');

  $('#infoBar').innerHTML = `
    <b>${fmtNum(arr.length)}</b> SKUs zerados encontrados ·
    mostrando ${slice.length === 0 ? 0 : inicio + 1}–${inicio + slice.length}
    ${escopo === '20x80' ? '<b style="margin-left:8px;color:var(--warn-strong);">filtro 20×80 ativo</b>' : ''}
  `;
  const totalPag = Math.max(1, Math.ceil(arr.length / POR_PAGINA));
  $('#pgInfo').textContent = `Página ${pagina} de ${totalPag}`;
  $('#btnPrev').disabled = pagina <= 1;
  $('#btnNext').disabled = pagina >= totalPag;

  // click no produto abre drill por produto
  $$('#tbodyItens .produto-link').forEach(el => {
    el.addEventListener('click', () => abrirDrill('produto', el.dataset.produto, el.dataset.codigo));
  });
}

function popularFiltros() {
  const compradores = new Set(), lojas = new Set(), fornecedores = new Set();
  for (const i of DADOS.itens) {
    if (i.comprador) compradores.add(i.comprador);
    if (i.loja) lojas.add(i.loja);
    if (i.fornecedor) fornecedores.add(i.fornecedor);
  }
  const fc = $('#filtroComprador');
  fc.innerHTML = '<option value="">Todos os compradores</option>' +
    Array.from(compradores).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
  const fl = $('#filtroLoja');
  fl.innerHTML = '<option value="">Todas as lojas</option>' +
    Array.from(lojas).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
  const ff = $('#filtroFornecedor');
  ff.innerHTML = '<option value="">Todos os fornecedores</option>' +
    Array.from(fornecedores).sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map(c => `<option>${escapeHtml(c)}</option>`).join('');
}

// O ranking de compradores usa o APELIDO puro ("02-WAL(SAL,FAR)"),
// já o item.comprador vem com prefixo numérico ("4 - 02-WAL(SAL,FAR)").
// Normaliza tirando "<num> - " do início pra bater os dois.
const normComp = (c) => String(c || '').replace(/^\d+\s*-\s*/, '');

// ========== Drill-down (modal) ==========
function abrirDrill(tipo, nome, codigo) {
  const modal = $('#modalDrill');
  let arr = DADOS.itens || [];
  if (escopo === '20x80') arr = arr.filter(i => i.is_20x80);

  let titulo, info, col1, col2;
  let mostrarResumos = false;

  if (tipo === 'comprador') {
    arr = arr.filter(i => normComp(i.comprador) === nome);
    titulo = `Comprador: ${nome}`;
    col1 = 'Loja';
    col2 = 'Comprador';
    const lojas = new Set(arr.map(i => i.loja));
    const fornecedores = new Set(arr.map(i => i.fornecedor).filter(Boolean));
    info = `<b>${fmtNum(arr.length)}</b> SKUs zerados em <b>${lojas.size}</b> loja(s) · <b>${fornecedores.size}</b> fornecedor(es)`;
    mostrarResumos = true;
  } else if (tipo === 'loja') {
    arr = arr.filter(i => i.loja === nome);
    titulo = `Loja: ${nome}`;
    col1 = 'Loja';
    col2 = 'Comprador';
    const comps = new Set(arr.map(i => i.comprador));
    const fornecedores = new Set(arr.map(i => i.fornecedor).filter(Boolean));
    info = `<b>${fmtNum(arr.length)}</b> SKUs zerados · <b>${comps.size}</b> comprador(es) · <b>${fornecedores.size}</b> fornecedor(es)`;
    mostrarResumos = true;
  } else if (tipo === 'produto') {
    if (codigo) arr = arr.filter(i => String(i.codigo) === String(codigo));
    else arr = arr.filter(i => i.produto === nome);
    titulo = `Produto: ${nome}`;
    col1 = 'Loja';
    col2 = 'Comprador';
    info = `Zerado em <b>${fmtNum(arr.length)}</b> loja(s)`;
    mostrarResumos = false;
  }

  $('#drillTitle').textContent = titulo;
  $('#drillInfo').innerHTML = info;
  $('#drillCol1').textContent = col1;
  $('#drillCol2').textContent = col2;

  // Resumos por loja e fornecedor (só pra drill por comprador/loja)
  const resumosEl = $('#drillResumos');
  if (mostrarResumos) {
    resumosEl.classList.remove('hidden');
    // Pra drill por comprador → mostra TOP lojas; pra drill por loja → mostra TOP compradores
    if (tipo === 'comprador') {
      renderResumo('#drillResumoLojas', arr, 'loja');
      $('#drillResumos .drill-resumo-card:first-child .drill-resumo-head strong').textContent = '🏪 Lojas com mais ruptura';
    } else {
      renderResumo('#drillResumoLojas', arr, 'comprador');
      $('#drillResumos .drill-resumo-card:first-child .drill-resumo-head strong').textContent = '🛒 Compradores com mais ruptura';
    }
    renderResumo('#drillResumoFornecedores', arr, 'fornecedor');
  } else {
    resumosEl.classList.add('hidden');
  }

  // ordena por media_venda desc (perdendo mais venda primeiro)
  arr.sort((a, b) => (b.media_venda || 0) - (a.media_venda || 0));

  const tbody = $('#tbodyDrill');
  tbody.innerHTML = arr.slice(0, 500).map(i => `
    <tr>
      <td>${escapeHtml(i.produto)}</td>
      <td>${i.codigo || '—'}</td>
      <td>${escapeHtml(i.loja)}</td>
      <td>${escapeHtml(i.comprador)}</td>
      <td class="num">${fmtMed(i.media_venda)}</td>
      <td class="center">${i.is_20x80 ? '<span class="badge-2080">20×80</span>' : ''}</td>
    </tr>
  `).join('');
  if (arr.length > 500) {
    tbody.innerHTML += `<tr><td colspan="6" style="text-align:center;padding:10px;color:var(--text-muted);">… mais ${arr.length - 500} linhas (use exportar CSV pra ver tudo)</td></tr>`;
  }

  modal._dados = arr;
  modal._titulo = titulo;
  modal.classList.add('open');
}

function renderResumo(seletor, arr, campo) {
  // Conta SKUs zerados agrupados por `campo` (loja, comprador, fornecedor)
  // e soma média de venda perdida. Mostra top 10.
  const grupos = new Map();
  for (const it of arr) {
    let k = it[campo] || '—';
    if (campo === 'comprador') k = normComp(k);
    if (!grupos.has(k)) grupos.set(k, { nome: k, qtd: 0, media: 0 });
    const g = grupos.get(k);
    g.qtd += 1;
    g.media += (it.media_venda || 0);
  }
  const lista = Array.from(grupos.values()).sort((a, b) => b.qtd - a.qtd).slice(0, 10);
  const el = $(seletor);
  if (!lista.length) {
    el.innerHTML = '<div class="drill-resumo-row" style="color:var(--text-muted);">Sem dados</div>';
    return;
  }
  el.innerHTML = lista.map((g, i) => `
    <div class="drill-resumo-row">
      <span class="pos">#${i + 1}</span>
      <span class="nome" title="${escapeHtml(g.nome)}">${escapeHtml(g.nome)}</span>
      <span class="skus">${fmtNum(g.qtd)} SKUs</span>
      <span class="pct">${fmtMed(g.media)}</span>
    </div>
  `).join('');
}

function fecharDrill() { $('#modalDrill').classList.remove('open'); }

function exportar(arr, nome) {
  const cabec = ['Produto', 'Código', 'Loja', 'Comprador', 'Méd Venda', '20x80'];
  const linhas = [cabec.join(';')];
  for (const i of arr) {
    linhas.push([
      i.produto || '', i.codigo || '', i.loja || '', i.comprador || '',
      (i.media_venda != null ? i.media_venda.toFixed(2).replace('.', ',') : ''),
      i.is_20x80 ? 'sim' : '',
    ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';'));
  }
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ruptura_${nome.replace(/\W+/g, '_')}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ========== Bootstrap ==========
async function init() {
  me = await api('GET', '/api/me');
  $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
  if (me.is_admin) $('#linkAdmin').style.display = '';
  $('#btnLogout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.href = '/login.html';
  });

  try {
    DADOS = await api('GET', '/api/ruptura');
  } catch (err) {
    document.querySelector('.main-content').innerHTML = `
      <div style="padding:32px;color:var(--neg);">
        <h2>Não consegui carregar os dados de ruptura</h2>
        <p>${err.message}</p>
        <p style="color:var(--text-muted)">Rode <code>./atualizar_ruptura.sh</code> ou <code>./atualizar_dados.sh</code> pra gerar.</p>
      </div>`;
    return;
  }

  $('#geradoEm').textContent = DADOS.gerado_em ? new Date(DADOS.gerado_em).toLocaleString('pt-BR') : '—';

  popularFiltros();
  renderTudo();

  // Tabs de escopo
  $$('.ru-tab').forEach(t => t.addEventListener('click', () => {
    $$('.ru-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    escopo = t.dataset.escopo;
    pagina = 1;
    renderTudo();
  }));

  $('#busca').addEventListener('input', e => { busca = e.target.value; pagina = 1; renderTabela(); });
  $('#filtroComprador').addEventListener('change', e => { filtroComprador = e.target.value; pagina = 1; renderTabela(); });
  $('#filtroLoja').addEventListener('change', e => { filtroLoja = e.target.value; pagina = 1; renderTabela(); });
  $('#filtroFornecedor').addEventListener('change', e => { filtroFornecedor = e.target.value; pagina = 1; renderTabela(); });
  $('#limparFiltros').addEventListener('click', () => {
    busca = ''; filtroComprador = ''; filtroLoja = ''; filtroFornecedor = ''; pagina = 1;
    $('#busca').value = ''; $('#filtroComprador').value = ''; $('#filtroLoja').value = ''; $('#filtroFornecedor').value = '';
    renderTabela();
  });
  $('#btnPrev').addEventListener('click', () => { if (pagina > 1) { pagina--; renderTabela(); } });
  $('#btnNext').addEventListener('click', () => { pagina++; renderTabela(); });
  $('#exportarCsv').addEventListener('click', () => exportar(itensFiltrados(), `produtos_${escopo}`));

  $('#drillClose').addEventListener('click', fecharDrill);
  $('#drillFechar').addEventListener('click', fecharDrill);
  $('#modalDrill').addEventListener('click', e => { if (e.target.id === 'modalDrill') fecharDrill(); });
  $('#drillExport').addEventListener('click', () => {
    const m = $('#modalDrill');
    if (m._dados) exportar(m._dados, m._titulo);
  });
}

function renderTudo() {
  renderKPIs();
  renderResumoExecutivo();
  renderGrafico();
  renderRankings();
  renderTabela();
}

init().catch(e => {
  if (e.message !== 'não autenticado') {
    console.error(e);
    alert('Falha: ' + e.message);
  }
});
