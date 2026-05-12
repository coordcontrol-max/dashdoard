// Página /estrategia — Comparativo MTD por Comprador / por Loja com drill-down em seções
let DADOS = null;
let me = null;
let pollTimer = null;
let lastUpdatedAt = null;
let view = 'comprador';   // 'comprador' | 'loja'
let busca = '';
let expandidos = new Set();  // ids das linhas expandidas

const $ = (s) => document.querySelector(s);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtRs = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v/1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v/1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};
const fmtRsSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  return (v < 0 ? '-' : '+') + 'R$ ' + Math.abs(Math.round(v)).toLocaleString('pt-BR');
};
const fmtPct = (v, d = 2) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%';
const fmtPctSig = (v, d = 2) => {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(d).replace('.', ',') + '%';
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
};
const fmtDataCurta = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
};

const classDelta = (v) => v == null || v === 0 ? '' : (v > 0 ? 'pct-pos' : 'pct-neg');

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

// ========== Status ==========
function pintaStatus(s) {
  const sec = $('#trStatus');
  const msg = $('#trStatusMsg');
  const btn = $('#btnAtualizar');
  sec.classList.remove('idle','pendente','processando','erro');
  const sol = s.ultima_solicitacao;
  const ult = s.ultima_atualizacao ? fmtData(s.ultima_atualizacao) : 'nunca';
  if (sol && sol.status === 'pendente') {
    sec.classList.add('pendente');
    msg.innerHTML = `⏳ Pendente · aguardando processar… <span style="color:var(--text-muted);">(última: ${ult})</span>`;
    btn.disabled = true; btn.textContent = '⏳ Pendente';
  } else if (sol && sol.status === 'processando') {
    sec.classList.add('processando');
    msg.innerHTML = `↻ Processando agora… <span style="color:var(--text-muted);">(última: ${ult})</span>`;
    btn.disabled = true; btn.textContent = '↻ Processando…';
  } else if (sol && sol.status === 'erro') {
    sec.classList.add('erro');
    msg.innerHTML = `✗ Erro: <b>${escapeHtml(sol.mensagem || '')}</b> · última OK: ${ult}`;
    btn.disabled = false; btn.textContent = '🔄 Tentar de novo';
  } else {
    sec.classList.add('idle');
    msg.innerHTML = `Última atualização: <b>${ult}</b> <span style="color:var(--text-muted);">· Auto diário 06:30</span>`;
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

async function pollOnce() {
  const s = await api('GET', '/api/estrategia/status');
  pintaStatus(s);
  if (s.ultima_atualizacao && s.ultima_atualizacao !== lastUpdatedAt) {
    lastUpdatedAt = s.ultima_atualizacao;
    await carregarDados();
  }
  const sol = s.ultima_solicitacao;
  if (!sol || (sol.status !== 'pendente' && sol.status !== 'processando')) {
    pararPolling();
  }
}
function iniciarPolling() { pararPolling(); pollTimer = setInterval(pollOnce, 5000); }
function pararPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function clicarAtualizar() {
  const btn = $('#btnAtualizar');
  btn.disabled = true; btn.textContent = '⏳ Solicitando…';
  try { await api('POST', '/api/estrategia/atualizar'); iniciarPolling(); }
  catch (e) { alert('Falha: ' + e.message); btn.disabled = false; btn.textContent = '🔄 Atualizar'; }
}

async function carregarDados() {
  try {
    const d = await api('GET', '/api/estrategia');
    if (d && !d.vazio) {
      DADOS = d;
      renderTudo();
    }
  } catch (e) { console.error(e); }
}

// ========== Render: cabeçalho com totais ==========
function renderTotais() {
  const t = DADOS?.total;
  if (!t) return;
  $('#totVenda').textContent = fmtRsK(t.venda);
  $('#totMeta').textContent = fmtRsK(t.meta_venda);
  $('#totAting').textContent = fmtPct(t.ating, 1);

  const elMes = $('#totVsMes');
  elMes.textContent = fmtPctSig(t.desvio_pct_mes, 2);
  elMes.className = 'tot-big ' + classDelta(t.desvio_pct_mes);
  $('#totMesAnt').textContent = fmtRsK(t.venda_mes_ant);

  const elAno = $('#totVsAno');
  elAno.textContent = fmtPctSig(t.desvio_pct_ano, 2);
  elAno.className = 'tot-big ' + classDelta(t.desvio_pct_ano);
  $('#totAnoAnt').textContent = fmtRsK(t.venda_ano_ant);

  $('#totLucr').textContent = fmtRsK(t.lucratividade);
  const mg = (t.venda > 0) ? (t.lucratividade / t.venda) : null;
  $('#totMg').textContent = fmtPct(mg, 2);
}

// ========== Render: linhas da tabela ==========
// Constrói uma "linha" genérica a partir de um item (comprador ou loja)
function montaLinha(item, totalVenda, eh = 'comp') {
  const nome = eh === 'comp'
    ? (item.comprador || '—')
    : `${item.loja} — ${item.loja_nome || ''}`;
  const venda = item.venda || 0;
  const part = totalVenda > 0 ? venda / totalVenda : 0;
  const mes_ant = item.venda_mes_ant || 0;
  const ano_ant = item.venda_ano_ant || 0;
  const dif_mes = venda - mes_ant;
  const margem = (venda > 0) ? (item.lucratividade / venda) : null;
  return {
    id: eh === 'comp' ? `c-${item.seqcomprador}` : `l-${item.loja}`,
    chave: eh === 'comp' ? item.seqcomprador : item.loja,
    nome, venda, part, mes_ant, ano_ant, dif_mes,
    dif_pct_mes: item.desvio_pct_mes,
    dif_pct_ano: item.desvio_pct_ano,
    lucr: item.lucratividade || 0,
    margem,
  };
}

function rowHTML(r, expanded) {
  const arrow = expanded ? '▾' : '▸';
  return `
    <tr class="row-pai" data-id="${r.id}">
      <td class="col-nome"><span class="caret">${arrow}</span>${escapeHtml(r.nome)}</td>
      <td class="num"><b>${fmtRsK(r.venda)}</b></td>
      <td class="num">${fmtPct(r.part, 2)}</td>
      <td class="num">${fmtRsK(r.mes_ant)}</td>
      <td class="num ${classDelta(r.dif_mes)}">${fmtRsSig(r.dif_mes)}</td>
      <td class="num ${classDelta(r.dif_pct_mes)}">${fmtPctSig(r.dif_pct_mes)}</td>
      <td class="num">${fmtRsK(r.ano_ant)}</td>
      <td class="num ${classDelta(r.dif_pct_ano)}">${fmtPctSig(r.dif_pct_ano)}</td>
      <td class="num">${fmtRsK(r.lucr)}</td>
      <td class="num">${fmtPct(r.margem, 2)}</td>
    </tr>`;
}

function detalheHTML(r) {
  // Pega as seções daquele comprador ou loja
  const lista = view === 'comprador'
    ? (DADOS?.por_comprador_secao?.[r.chave]) || []
    : (DADOS?.por_loja_secao?.[r.chave]) || [];

  // Ordena por venda desc
  const ord = lista.slice().sort((a, b) => (b.venda || 0) - (a.venda || 0));
  const totalVenda = r.venda || 0;

  if (!ord.length) {
    return `<tr class="row-filha"><td colspan="10" style="padding:14px;color:var(--text-muted);">Sem detalhes</td></tr>`;
  }

  const linhasHTML = ord.map(s => {
    const v = s.venda || 0;
    const part = totalVenda > 0 ? v / totalVenda : 0;
    const dif_mes = v - (s.venda_mes_ant || 0);
    const mg = (v > 0) ? (s.lucratividade / v) : null;
    return `
      <tr class="row-secao">
        <td class="col-nome sub">└ ${escapeHtml(s.secao || '—')}</td>
        <td class="num">${fmtRsK(v)}</td>
        <td class="num">${fmtPct(part, 2)}</td>
        <td class="num">${fmtRsK(s.venda_mes_ant)}</td>
        <td class="num ${classDelta(dif_mes)}">${fmtRsSig(dif_mes)}</td>
        <td class="num ${classDelta(s.desvio_pct_mes)}">${fmtPctSig(s.desvio_pct_mes)}</td>
        <td class="num">${fmtRsK(s.venda_ano_ant)}</td>
        <td class="num ${classDelta(s.desvio_pct_ano)}">${fmtPctSig(s.desvio_pct_ano)}</td>
        <td class="num">${fmtRsK(s.lucratividade)}</td>
        <td class="num">${fmtPct(mg, 2)}</td>
      </tr>`;
  }).join('');
  return linhasHTML;
}

function renderTabela() {
  if (!DADOS) return;

  // Origem dos dados
  let itens, totalVenda;
  if (view === 'comprador') {
    itens = (DADOS.compradores || []).slice();
    totalVenda = DADOS.total?.venda || 0;
  } else {
    itens = (DADOS.lojas || []).slice();
    totalVenda = DADOS.total?.venda || 0;
  }

  // Filtro de busca
  const q = busca.trim().toLowerCase();
  if (q) {
    itens = itens.filter(it => {
      const nome = view === 'comprador' ? (it.comprador || '') : (it.loja_nome || '');
      return String(nome).toLowerCase().includes(q) || String(it.loja || '').includes(q);
    });
  }

  // Monta linhas
  const linhas = itens.map(it => montaLinha(it, totalVenda, view === 'comprador' ? 'comp' : 'loja'));
  // Ordena por venda desc
  linhas.sort((a, b) => (b.venda || 0) - (a.venda || 0));

  const tbody = $('#tbodyComp');
  if (!linhas.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="padding:14px;color:var(--text-muted);">Sem dados</td></tr>';
    return;
  }

  const html = linhas.map(r => {
    const expanded = expandidos.has(r.id);
    const base = rowHTML(r, expanded);
    if (!expanded) return base;
    return base + detalheHTML(r);
  }).join('');
  tbody.innerHTML = html;

  // Click handlers
  tbody.querySelectorAll('.row-pai').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      if (expandidos.has(id)) expandidos.delete(id);
      else expandidos.add(id);
      renderTabela();
    });
  });
}

function renderTudo() {
  if (!DADOS) return;
  if (DADOS.periodos?.atual) {
    const ini = DADOS.periodos.atual.inicio, fim = DADOS.periodos.atual.fim;
    $('#periodoTxt').textContent = `${fmtDataCurta(ini)} a ${fmtDataCurta(fim)}`;
  }
  renderTotais();
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

  // Toggle Comprador / Loja
  document.querySelectorAll('.es-toggle-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.es-toggle-btn').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      view = b.dataset.view;
      expandidos.clear();
      renderTabela();
    });
  });

  // Busca
  $('#filtroBusca').addEventListener('input', e => {
    busca = e.target.value;
    renderTabela();
  });

  const s = await api('GET', '/api/estrategia/status');
  lastUpdatedAt = s.ultima_atualizacao;
  if (s.tem_dados) await carregarDados();
  pintaStatus(s);
  if (s.ultima_solicitacao && (s.ultima_solicitacao.status === 'pendente' || s.ultima_solicitacao.status === 'processando')) {
    iniciarPolling();
  }
}

init().catch(e => {
  if (e.message !== 'não autenticado') { console.error(e); alert('Falha: ' + e.message); }
});
