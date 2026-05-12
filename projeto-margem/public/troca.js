// ========== Estado ==========
let DADOS = null;
let me = null;
let pagina = 1;
const POR_PAGINA = 100;
let busca = '';
let filtroLoja = '';
let filtroComprador = '';
let filtroFornecedor = '';
let pollTimer = null;

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtRs   = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRsK  = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const fmtNum  = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const fmtQtd  = (v) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normComp = (c) => String(c || '').replace(/^\d+\s*-\s*/, '');

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

// ========== Status / atualização ==========
function pintaStatus(s) {
  const sec  = $('#trStatus');
  const icon = $('#trStatusIcon');
  const msg  = $('#trStatusMsg');
  const btn  = $('#btnAtualizar');

  sec.classList.remove('idle', 'pendente', 'processando', 'erro');

  const sol = s.ultima_solicitacao;
  const ult = s.ultima_atualizacao ? fmtData(s.ultima_atualizacao) : 'nunca';

  if (sol && sol.status === 'pendente') {
    sec.classList.add('pendente');
    icon.textContent = '⏳';
    msg.innerHTML = `Solicitação pendente · aguardando agente local processar… <span style="color:var(--text-muted);">(última: ${ult})</span>`;
    btn.disabled = true;
    btn.textContent = '⏳ Pendente';
  } else if (sol && sol.status === 'processando') {
    sec.classList.add('processando');
    icon.textContent = '↻';
    msg.innerHTML = `Atualizando agora… <span style="color:var(--text-muted);">(última: ${ult})</span>`;
    btn.disabled = true;
    btn.textContent = '↻ Atualizando…';
  } else if (sol && sol.status === 'erro') {
    sec.classList.add('erro');
    icon.textContent = '✗';
    msg.innerHTML = `Erro na última atualização: <b>${escapeHtml(sol.mensagem || 'desconhecido')}</b> · <span style="color:var(--text-muted);">última OK: ${ult}</span>`;
    btn.disabled = false;
    btn.textContent = '🔄 Tentar novamente';
  } else {
    sec.classList.add('idle');
    icon.textContent = '●';
    msg.innerHTML = `Última atualização: <b>${ult}</b>`;
    btn.disabled = false;
    btn.textContent = '🔄 Atualizar agora';
  }
  $('#ultimaAtual').textContent = ult;
}

async function carregarStatus() {
  try {
    const s = await api('GET', '/api/troca/status');
    pintaStatus(s);
    return s;
  } catch (e) { console.error(e); return null; }
}

async function carregarDados() {
  try {
    const d = await api('GET', '/api/troca');
    if (d && !d.vazio) {
      DADOS = d;
      popularFiltros();
      renderTudo();
    } else {
      $('#kpiValor .val').textContent  = '—';
      $('#kpiQtd .val').textContent    = '—';
      $('#kpiSkus .val').textContent   = '—';
      $('#kpiLojas .val').textContent  = '—';
      $('#kpiForn .val').textContent   = '—';
      $('#tbodyItens').innerHTML = '<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--text-muted);">Sem dados ainda. Clique em <b>🔄 Atualizar agora</b> pra rodar a query.</td></tr>';
      $('#infoBar').textContent = '';
    }
  } catch (e) {
    console.error(e);
  }
}

async function clicarAtualizar() {
  const btn = $('#btnAtualizar');
  btn.disabled = true;
  btn.textContent = '⏳ Solicitando…';
  try {
    await api('POST', '/api/troca/atualizar');
    iniciarPolling();
  } catch (e) {
    alert('Falha ao solicitar: ' + e.message);
    btn.disabled = false;
    btn.textContent = '🔄 Atualizar agora';
  }
}

let lastUpdatedAt = null;
async function pollOnce() {
  const s = await carregarStatus();
  if (!s) return;
  // Quando finalizar (status mudou pra 'ok'), recarrega os dados
  if (s.ultima_atualizacao && s.ultima_atualizacao !== lastUpdatedAt) {
    lastUpdatedAt = s.ultima_atualizacao;
    await carregarDados();
  }
  // Para o polling se nada está em andamento e já passou pelo menos 1 ciclo
  const sol = s.ultima_solicitacao;
  if (!sol || (sol.status !== 'pendente' && sol.status !== 'processando')) {
    pararPolling();
  }
}
function iniciarPolling() {
  pararPolling();
  pollTimer = setInterval(pollOnce, 5000);
}
function pararPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ========== KPIs ==========
function renderKPIs() {
  const t = DADOS.totais || {};
  $('#kpiValor .val').textContent  = fmtRsK(t.valor);
  $('#kpiQtd .val').textContent    = fmtNum(t.qtd);
  $('#kpiSkus .val').textContent   = fmtNum(t.qtd_skus);
  $('#kpiLojas .val').textContent  = fmtNum(t.qtd_lojas);
  $('#kpiForn .val').textContent   = fmtNum(t.qtd_forn);
}

// ========== Resumo executivo ==========
function renderResumo() {
  const TOP = 5;
  const itens = DADOS.itens || [];

  function pintaRow(seletor, lista, fmtVal) {
    const el = $(seletor);
    if (!lista.length) { el.innerHTML = '<div class="ru-resumo-row disabled" style="color:var(--text-muted);">Sem dados</div>'; return; }
    el.innerHTML = lista.map((r, i) => `
      <div class="ru-resumo-row disabled">
        <span class="pos">#${i + 1}</span>
        <span class="nome" title="${escapeHtml(r.nome)}">${escapeHtml(r.nome)}</span>
        <span class="val">${fmtVal(r)}</span>
      </div>
    `).join('');
  }

  pintaRow('#resumoCompradores',   (DADOS.ranking_compradores  || []).slice(0, TOP), r => fmtRsK(r.valor));
  pintaRow('#resumoLojas',         (DADOS.ranking_lojas        || []).slice(0, TOP), r => fmtRsK(r.valor));
  pintaRow('#resumoFornecedores',  (DADOS.ranking_fornecedores || []).slice(0, TOP), r => fmtRsK(r.valor));

  // Produtos: agrupa itens por código e soma valor
  const prods = new Map();
  for (const it of itens) {
    const k = it.codigo || it.produto;
    if (!prods.has(k)) prods.set(k, { nome: it.produto, valor: 0 });
    prods.get(k).valor += it.valor || 0;
  }
  const prodTop = Array.from(prods.values()).sort((a, b) => b.valor - a.valor).slice(0, TOP);
  pintaRow('#resumoProdutos', prodTop, r => fmtRsK(r.valor));
}

// ========== Rankings ==========
function renderRanking(elemId, lista, tipo) {
  const el = $(elemId);
  if (!lista || !lista.length) { el.innerHTML = '<div class="ru-rank-row disabled" style="padding:14px;color:var(--text-muted);">Sem dados</div>'; return; }
  const top = lista.slice(0, 15);
  el.innerHTML = top.map((r, i) => {
    const posCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    return `
      <div class="ru-rank-row" data-nome="${escapeHtml(r.nome)}">
        <span class="pos ${posCls}">#${i + 1}</span>
        <span class="nome" title="${escapeHtml(r.nome)}">${escapeHtml(r.nome)}</span>
        <span class="skus">${fmtNum(r.skus_distintos)} SKUs</span>
        <span class="pct">${fmtRsK(r.valor)}</span>
      </div>
    `;
  }).join('');
  // Click → drill
  el.querySelectorAll('.ru-rank-row').forEach(row => {
    row.addEventListener('click', () => abrirDrill(tipo, row.dataset.nome));
  });
}
function renderRankings() {
  renderRanking('#rankCompradores',  DADOS.ranking_compradores,  'comprador');
  renderRanking('#rankLojas',        DADOS.ranking_lojas,        'loja');
  renderRanking('#rankFornecedores', DADOS.ranking_fornecedores, 'fornecedor');
}

// ========== Drill-down ==========
function abrirDrill(tipo, nome) {
  let arr = (DADOS.itens || []).slice();

  let titulo, info, card1Tit, card1Campo, card2Tit, card2Campo;

  if (tipo === 'comprador') {
    arr = arr.filter(i => normComp(i.comprador) === normComp(nome));
    titulo = `Comprador: ${nome}`;
    card1Tit = '🚚 Fornecedores';
    card1Campo = 'fornecedor';
    card2Tit = '🏪 Lojas';
    card2Campo = 'loja';
  } else if (tipo === 'loja') {
    arr = arr.filter(i => i.loja === nome);
    titulo = `Loja: ${nome}`;
    card1Tit = '🚚 Fornecedores';
    card1Campo = 'fornecedor';
    card2Tit = '🛒 Compradores';
    card2Campo = 'comprador';
  } else if (tipo === 'fornecedor') {
    arr = arr.filter(i => i.fornecedor === nome);
    titulo = `Fornecedor: ${nome}`;
    card1Tit = '🛒 Compradores';
    card1Campo = 'comprador';
    card2Tit = '🏪 Lojas';
    card2Campo = 'loja';
  }

  const totalValor = arr.reduce((s, i) => s + (i.valor || 0), 0);
  const totalQtd   = arr.reduce((s, i) => s + (i.qtd || 0), 0);
  info = `<b>${fmtNum(arr.length)}</b> itens · total <b>${fmtRs(totalValor)}</b> · <b>${fmtQtd(totalQtd)}</b> unidades`;

  $('#drillTitle').textContent = titulo;
  $('#drillInfo').innerHTML = info;
  $('#drillCard1Titulo').textContent = card1Tit;
  $('#drillCard2Titulo').textContent = card2Tit;
  pintaResumoDrill('#drillCard1', arr, card1Campo);
  pintaResumoDrill('#drillCard2', arr, card2Campo);

  // Tabela analítica do drill — top 500 por valor desc
  arr.sort((a, b) => (b.valor || 0) - (a.valor || 0));
  const tbody = $('#tbodyDrill');
  tbody.innerHTML = arr.slice(0, 500).map(i => `
    <tr>
      <td>${escapeHtml(i.produto)}</td>
      <td>${i.codigo || '—'}</td>
      <td>${escapeHtml(i.loja)}</td>
      <td>${escapeHtml(i.comprador)}</td>
      <td>${escapeHtml(i.fornecedor)}</td>
      <td class="num">${fmtQtd(i.qtd)}</td>
      <td class="num">${fmtRs(i.valor)}</td>
    </tr>
  `).join('');
  if (arr.length > 500) {
    tbody.innerHTML += `<tr><td colspan="7" style="text-align:center;padding:10px;color:var(--text-muted);">… mais ${arr.length - 500} linhas (use exportar CSV pra ver tudo)</td></tr>`;
  }

  const modal = $('#modalDrill');
  modal._dados = arr;
  modal._titulo = titulo;
  modal.classList.add('open');
}

function pintaResumoDrill(seletor, arr, campo) {
  const grupos = new Map();
  for (const it of arr) {
    let k = it[campo] || '—';
    if (campo === 'comprador') k = normComp(k);
    if (!grupos.has(k)) grupos.set(k, { nome: k, valor: 0, qtd: 0 });
    const g = grupos.get(k);
    g.valor += it.valor || 0;
    g.qtd   += it.qtd || 0;
  }
  const lista = Array.from(grupos.values()).sort((a, b) => b.valor - a.valor).slice(0, 10);
  const el = $(seletor);
  if (!lista.length) {
    el.innerHTML = '<div class="drill-resumo-row" style="color:var(--text-muted);">Sem dados</div>';
    return;
  }
  el.innerHTML = lista.map((g, i) => `
    <div class="drill-resumo-row">
      <span class="pos">#${i + 1}</span>
      <span class="nome" title="${escapeHtml(g.nome)}">${escapeHtml(g.nome)}</span>
      <span class="skus">${fmtQtd(g.qtd)} un</span>
      <span class="pct">${fmtRsK(g.valor)}</span>
    </div>
  `).join('');
}

function fecharDrill() { $('#modalDrill').classList.remove('open'); }

function exportarDrill(arr, nome) {
  const cabec = ['Produto', 'Código', 'Loja', 'Comprador', 'Fornecedor', 'Qtd', 'Valor (R$)'];
  const linhas = [cabec.join(';')];
  for (const i of arr) {
    linhas.push([
      i.produto || '', i.codigo || '', i.loja || '', i.comprador || '', i.fornecedor || '',
      Number(i.qtd || 0).toFixed(2).replace('.', ','),
      Number(i.valor || 0).toFixed(2).replace('.', ','),
    ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';'));
  }
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `troca_${nome.replace(/\W+/g, '_')}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ========== Tabela analítica ==========
function itensFiltrados() {
  let arr = DADOS.itens || [];
  if (filtroLoja)       arr = arr.filter(i => i.loja === filtroLoja);
  if (filtroComprador)  arr = arr.filter(i => normComp(i.comprador) === normComp(filtroComprador));
  if (filtroFornecedor) arr = arr.filter(i => i.fornecedor === filtroFornecedor);
  if (busca) {
    const q = busca.toLowerCase();
    arr = arr.filter(i =>
      (i.produto || '').toLowerCase().includes(q) ||
      String(i.codigo || '').includes(q)
    );
  }
  // Ordena por valor desc — onde mais dinheiro está parado primeiro
  return [...arr].sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0));
}

function renderTabela() {
  const arr = itensFiltrados();
  const inicio = (pagina - 1) * POR_PAGINA;
  const slice = arr.slice(inicio, inicio + POR_PAGINA);
  const tbody = $('#tbodyItens');
  if (!arr.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted);">Nada com esses filtros</td></tr>';
  } else {
    tbody.innerHTML = slice.map(i => `
      <tr>
        <td>${escapeHtml(i.produto)}</td>
        <td>${i.codigo || '—'}</td>
        <td>${escapeHtml(i.loja)}</td>
        <td>${escapeHtml(i.comprador)}</td>
        <td>${escapeHtml(i.fornecedor)}</td>
        <td class="num">${fmtQtd(i.qtd)}</td>
        <td class="num valor-pos">${fmtRs(i.valor)}</td>
      </tr>
    `).join('');
  }

  const totalValor = arr.reduce((s, i) => s + (i.valor || 0), 0);
  $('#infoBar').innerHTML = `
    <b>${fmtNum(arr.length)}</b> itens · total <b>${fmtRs(totalValor)}</b>
    ${arr.length === 0 ? '' : `· mostrando ${inicio + 1}–${Math.min(inicio + slice.length, arr.length)}`}
  `;

  const totalPag = Math.max(1, Math.ceil(arr.length / POR_PAGINA));
  $('#pgInfo').textContent = `Página ${pagina} de ${totalPag}`;
  $('#btnPrev').disabled = pagina <= 1;
  $('#btnNext').disabled = pagina >= totalPag;
}

function popularFiltros() {
  const lojas = new Set(), compradores = new Set(), fornecedores = new Set();
  for (const i of (DADOS.itens || [])) {
    if (i.loja)       lojas.add(i.loja);
    if (i.comprador)  compradores.add(i.comprador);
    if (i.fornecedor) fornecedores.add(i.fornecedor);
  }
  const fl = $('#filtroLoja');
  fl.innerHTML = '<option value="">Todas as lojas</option>' +
    Array.from(lojas).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
  const fc = $('#filtroComprador');
  fc.innerHTML = '<option value="">Todos os compradores</option>' +
    Array.from(compradores).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
  const ff = $('#filtroFornecedor');
  ff.innerHTML = '<option value="">Todos os fornecedores</option>' +
    Array.from(fornecedores).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
}

function exportar() {
  const arr = itensFiltrados();
  const cabec = ['Produto', 'Código', 'Loja', 'Comprador', 'Fornecedor', 'Qtd', 'Valor (R$)'];
  const linhas = [cabec.join(';')];
  for (const i of arr) {
    linhas.push([
      i.produto || '', i.codigo || '', i.loja || '', i.comprador || '', i.fornecedor || '',
      Number(i.qtd || 0).toFixed(2).replace('.', ','),
      Number(i.valor || 0).toFixed(2).replace('.', ','),
    ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';'));
  }
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `troca_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderTudo() {
  renderKPIs();
  renderResumo();
  renderRankings();
  renderTabela();
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

  $('#btnAtualizar').addEventListener('click', clicarAtualizar);
  $('#busca').addEventListener('input', e => { busca = e.target.value; pagina = 1; renderTabela(); });
  $('#filtroLoja').addEventListener('change',       e => { filtroLoja = e.target.value;       pagina = 1; renderTabela(); });
  $('#filtroComprador').addEventListener('change',  e => { filtroComprador = e.target.value;  pagina = 1; renderTabela(); });
  $('#filtroFornecedor').addEventListener('change', e => { filtroFornecedor = e.target.value; pagina = 1; renderTabela(); });
  $('#limparFiltros').addEventListener('click', () => {
    busca = ''; filtroLoja = ''; filtroComprador = ''; filtroFornecedor = ''; pagina = 1;
    $('#busca').value = '';
    $('#filtroLoja').value = ''; $('#filtroComprador').value = ''; $('#filtroFornecedor').value = '';
    renderTabela();
  });
  $('#btnPrev').addEventListener('click', () => { if (pagina > 1) { pagina--; renderTabela(); } });
  $('#btnNext').addEventListener('click', () => { pagina++; renderTabela(); });
  $('#exportarCsv').addEventListener('click', exportar);

  // Modal drill
  $('#drillClose').addEventListener('click', fecharDrill);
  $('#drillFechar').addEventListener('click', fecharDrill);
  $('#modalDrill').addEventListener('click', e => { if (e.target.id === 'modalDrill') fecharDrill(); });
  $('#drillExport').addEventListener('click', () => {
    const m = $('#modalDrill');
    if (m._dados) exportarDrill(m._dados, m._titulo || 'drill');
  });

  // Carrega status + dados em paralelo
  const [s] = await Promise.all([carregarStatus(), carregarDados()]);
  if (s) {
    lastUpdatedAt = s.ultima_atualizacao;
    const sol = s.ultima_solicitacao;
    if (sol && (sol.status === 'pendente' || sol.status === 'processando')) {
      iniciarPolling();
    }
  }
}

init().catch(e => {
  if (e.message !== 'não autenticado') {
    console.error(e);
    alert('Falha: ' + e.message);
  }
});
