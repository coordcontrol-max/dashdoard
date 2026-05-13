// Página /operacao
let DADOS = null;
let me = null;
let pollTimer = null;
let filtroSupervisor = '';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
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
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const fmtNumSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('pt-BR');
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

function classAt(at) {
  if (at == null) return '';
  if (at >= 1) return 'ating-ok';
  if (at >= 0.95) return 'ating-warn';
  return 'ating-bad';
}
function classMg(v) {
  if (v == null) return '';
  if (v >= 0.20) return 'ating-ok';
  if (v >= 0.17) return 'ating-warn';
  return 'ating-bad';
}

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
  const sec = $('#trStatus');
  const msg = $('#trStatusMsg');
  const btn = $('#btnAtualizar');

  const box = $('#trPeriodoBox');
  if (DADOS && DADOS.periodo && box) {
    $('#trPeriodoTxt').textContent = `${fmtDataCurta(DADOS.periodo.inicio)} a ${fmtDataCurta(DADOS.periodo.fim)}`;
    box.style.display = '';
  } else if (box) {
    box.style.display = 'none';
  }
  sec.classList.remove('idle','pendente','processando','erro');
  const sol = s.ultima_solicitacao;
  const ult = s.ultima_atualizacao ? fmtData(s.ultima_atualizacao) : 'nunca';
  if (sol && sol.status === 'pendente') {
    sec.classList.add('pendente');
    msg.innerHTML = `⏳ Pendente · aguardando agente local processar… <span style="color:var(--text-muted);">(última: ${ult})</span>`;
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

let lastUpdatedAt = null;
async function pollOnce() {
  const s = await api('GET', '/api/operacao/status');
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
  try {
    await api('POST', '/api/operacao/atualizar');
    iniciarPolling();
  } catch (e) {
    alert('Falha: ' + e.message);
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

async function carregarDados() {
  try {
    const d = await api('GET', '/api/operacao');
    if (d && !d.vazio) {
      DADOS = d;
      popularFiltros();
      renderTudo();
    }
  } catch (e) { console.error(e); }
}

// ========== Render ==========
function popularFiltros() {
  const sel = $('#filtroSupervisor');
  const sups = Object.keys(DADOS?.supervisores || {}).sort();
  sel.innerHTML = '<option value="">Todos os supervisores</option>' +
    sups.map(s => `<option>${escapeHtml(s)}</option>`).join('');
}

function renderKPIs() {
  const t = DADOS.total || {};
  $('#kpiMeta').textContent  = fmtRsK(t.meta_venda);
  $('#kpiVenda').textContent = fmtRsK(t.venda);
  const elDiff = $('#kpiDiff');
  elDiff.textContent = fmtRsSig(t.diff);
  elDiff.className = 'val ' + ((t.diff || 0) >= 0 ? 'diff-pos' : 'diff-neg');
  const elAt = $('#kpiAting');
  elAt.textContent = fmtPct(t.ating_venda);
  elAt.className = 'val ' + classAt(t.ating_venda);
  const elMgT = $('#kpiMgTotal');
  elMgT.textContent = fmtPct(t.mg_total);
  elMgT.className = 'val ' + classMg(t.mg_total);
  const elMgP = $('#kpiMgPdv');
  elMgP.textContent = fmtPct(t.mg_pdv);
  elMgP.className = 'val ' + classMg(t.mg_pdv);
}

function renderTabelaVM() {
  const lojas = (DADOS?.lojas || []).filter(l => !filtroSupervisor || l.supervisor === filtroSupervisor);

  // Agrupa por supervisor
  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }

  // Calcula ranks (1=pior atingimento) entre TODAS lojas
  const todasComAt = lojas.filter(l => l.ating_venda != null).slice().sort((a, b) => (a.ating_venda || 0) - (b.ating_venda || 0));
  const totalLojas = todasComAt.length;
  todasComAt.forEach((l, i) => l._rank = i + 1);

  const classRank = (rank) => {
    if (rank == null) return '';
    if (rank <= 5) return 'rank-bad';
    return '';
  };

  let html = '';
  // Ordem fixa de supervisores
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    // Linha do supervisor com TOTAIS
    const sub = DADOS.supervisores?.[sup];
    if (sub) {
      html += `
        <tr class="supervisor">
          <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
          <td class="num">${fmtRs(sub.meta_venda)}</td>
          <td class="num">${fmtRs(sub.venda)}</td>
          <td class="num ${(sub.diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtRsSig(sub.diff)}</td>
          <td class="num ${classAt(sub.ating_venda)}">${fmtPct(sub.ating_venda)}</td>
          <td class="num">—</td>
          <td class="num">${fmtRs(sub.lucratividade)}</td>
          <td class="num ${classMg(sub.mg_total)}">${fmtPct(sub.mg_total)}</td>
          <td class="num">${fmtNum(sub.clientes_atual)}</td>
          <td class="num ${(sub.clientes_diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtNumSig(sub.clientes_diff)}</td>
          <td class="num">—</td>
          <td class="num">${fmtRs(sub.ticket_medio)}</td>
        </tr>
      `;
    } else {
      html += `<tr class="supervisor"><td colspan="12">👤 ${escapeHtml(sup)} · ${items.length} lojas</td></tr>`;
    }
    for (const l of items) {
      html += `
        <tr>
          <td><span class="loja-link" data-loja="${l.loja}">${l.loja} — ${escapeHtml(l.loja_nome || '')}</span></td>
          <td class="num">${fmtRs(l.meta_venda)}</td>
          <td class="num"><b>${fmtRs(l.venda)}</b></td>
          <td class="num ${(l.diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtRsSig(l.diff)}</td>
          <td class="num ${classAt(l.ating_venda)}">${fmtPct(l.ating_venda)}</td>
          <td class="num"><span class="${classRank(l._rank)}">${l._rank ?? '—'}</span></td>
          <td class="num">${fmtRs(l.lucratividade)}</td>
          <td class="num ${classMg(l.mg_total)}">${fmtPct(l.mg_total)}</td>
          <td class="num">${fmtNum(l.clientes_atual)}</td>
          <td class="num ${(l.clientes_diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtNumSig(l.clientes_diff)}</td>
          <td class="num"><span class="${classRank(l.rank_clientes)}">${l.rank_clientes ?? '—'}</span></td>
          <td class="num">${fmtRs(l.ticket_medio)}</td>
        </tr>
      `;
    }
  }

  // Total geral (só se sem filtro)
  if (!filtroSupervisor) {
    const t = DADOS.total || {};
    html += `
      <tr class="total">
        <td>TOTAL</td>
        <td class="num">${fmtRs(t.meta_venda)}</td>
        <td class="num"><b>${fmtRs(t.venda)}</b></td>
        <td class="num ${(t.diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtRsSig(t.diff)}</td>
        <td class="num ${classAt(t.ating_venda)}"><b>${fmtPct(t.ating_venda)}</b></td>
        <td class="num">—</td>
        <td class="num">${fmtRs(t.lucratividade)}</td>
        <td class="num ${classMg(t.mg_total)}"><b>${fmtPct(t.mg_total)}</b></td>
        <td class="num">${fmtNum(t.clientes_atual)}</td>
        <td class="num ${(t.clientes_diff || 0) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtNumSig(t.clientes_diff)}</td>
        <td class="num">—</td>
        <td class="num">${fmtRs(t.ticket_medio)}</td>
      </tr>
    `;
  }

  $('#tbodyVM').innerHTML = html;
}

function renderTabelaEstoque() {
  const tbody = $('#tbodyEstoque');
  if (!tbody) return;
  const lojas = (DADOS?.lojas || []).filter(l => !filtroSupervisor || l.supervisor === filtroSupervisor);

  // Agrupa por supervisor pra render espelhar o bloco Venda&Margem
  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  // Cores: DDE alto é ruim (estoque parado). Verde até 25d, amarelo 25-40d, vermelho >40d
  const classDde = (v) => {
    if (v == null) return '';
    if (v <= 25) return 'ating-ok';
    if (v <= 40) return 'ating-warn';
    return 'ating-bad';
  };

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const sub = DADOS.supervisores?.[sup];
    if (sub) {
      html += `
        <tr class="supervisor">
          <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
          <td class="num">${fmtRs(sub.valor_estoque)}</td>
          <td class="num ${classDde(sub.dde)}">${sub.dde != null ? sub.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</td>
        </tr>
      `;
    } else {
      html += `<tr class="supervisor"><td colspan="3">👤 ${escapeHtml(sup)} · ${items.length} lojas</td></tr>`;
    }
    for (const l of items) {
      html += `
        <tr>
          <td><span class="loja-link-estq" data-loja="${l.loja}">${l.loja} — ${escapeHtml(l.loja_nome || '')}</span></td>
          <td class="num">${fmtRs(l.valor_estoque)}</td>
          <td class="num ${classDde(l.dde)}">${l.dde != null ? l.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</td>
        </tr>
      `;
    }
  }

  if (!filtroSupervisor) {
    const t = DADOS.total || {};
    html += `
      <tr class="total">
        <td>TOTAL</td>
        <td class="num"><b>${fmtRs(t.valor_estoque)}</b></td>
        <td class="num ${classDde(t.dde)}"><b>${t.dde != null ? t.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</b></td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

// Cores % de quebra/venda baseadas na meta 0,60%
function classQuebraPct(v) {
  if (v == null) return '';
  if (v <= 0.005) return 'ating-ok';      // <= 0,50% verde
  if (v <= 0.006) return 'ating-warn';    // 0,50% - 0,60% amarelo (próximo da meta)
  return 'ating-bad';                      // > 0,60% vermelho (acima da meta)
}

function renderTabelaQuebra() {
  const tbody = $('#tbodyQuebra');
  if (!tbody) return;
  const lojas = (DADOS?.lojas || []).filter(l => !filtroSupervisor || l.supervisor === filtroSupervisor);

  // Calcula rank por % venda (1 = pior = maior %)
  const lojasComPct = lojas
    .map(l => ({ l, pct: l.venda > 0 ? l.valor_quebra / l.venda : null }))
    .filter(x => x.pct != null)
    .sort((a, b) => b.pct - a.pct); // do pior pro melhor
  lojasComPct.forEach((x, i) => x.l._rank_quebra = i + 1);

  const classRank = (rank) => {
    if (rank == null) return '';
    if (rank <= 3) return 'rank-bad';
    return '';
  };

  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const sub = DADOS.supervisores?.[sup];
    if (sub) {
      const pctSubV = (sub.venda > 0) ? sub.valor_quebra / sub.venda : null;
      html += `
        <tr class="supervisor">
          <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
          <td class="num">${fmtRs(sub.valor_quebra)}</td>
          <td class="num">${fmtNum(sub.qtd_quebra)}</td>
          <td class="num">—</td>
          <td class="num ${classQuebraPct(pctSubV)}">${fmtPct(pctSubV)}</td>
        </tr>
      `;
    } else {
      html += `<tr class="supervisor"><td colspan="5">👤 ${escapeHtml(sup)} · ${items.length} lojas</td></tr>`;
    }
    for (const l of items) {
      const pct = (l.venda > 0) ? l.valor_quebra / l.venda : null;
      html += `
        <tr>
          <td>${l.loja} — ${escapeHtml(l.loja_nome || '')}</td>
          <td class="num"><span class="valor-link" data-loja-quebra="${l.loja}">${fmtRs(l.valor_quebra)}</span></td>
          <td class="num">${fmtNum(l.qtd_quebra)}</td>
          <td class="num"><span class="${classRank(l._rank_quebra)}">${l._rank_quebra ?? '—'}</span></td>
          <td class="num ${classQuebraPct(pct)}">${fmtPct(pct)}</td>
        </tr>
      `;
    }
  }

  if (!filtroSupervisor) {
    const t = DADOS.total || {};
    const pct = t.venda > 0 ? t.valor_quebra / t.venda : null;
    html += `
      <tr class="total">
        <td>TOTAL</td>
        <td class="num"><b>${fmtRs(t.valor_quebra)}</b></td>
        <td class="num"><b>${fmtNum(t.qtd_quebra)}</b></td>
        <td class="num">—</td>
        <td class="num ${classQuebraPct(pct)}"><b>${fmtPct(pct)}</b></td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

function renderTudo() {
  if (!DADOS) return;
  if (DADOS.periodo) {
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const d = new Date(DADOS.periodo.fim + 'T00:00:00');
    $('#periodoTxt').textContent = `${meses[d.getMonth()]}/${d.getFullYear()}`;
  }
  renderKPIs();
  renderTabelaVM();
  renderTabelaEstoque();
  renderTabelaQuebra();
  renderTabelaLucro();
  renderTabelaCxV('PERECIVEIS \\ BOVINO',  '#tbodyBovino');
  renderTabelaCxV('PERECIVEIS \\ FLV',     '#tbodyFLV');
  renderTabelaCxV('PERECIVEIS \\ PADARIA', '#tbodyPadaria');
  renderTabelaQuebraSecao('PERECIVEIS \\ FLV', '#tbodyQuebraFLV');
  renderTabelaCancel();
  renderTabelaSemVendas();
  renderTabelaInvRot();
}

// ========== Aba 8 · Inventário Rotativo ==========
let INV_ROT = null;
let invRotLojaAtiva = null;
let invRotFiltroComprador = null;
// Ordenação da tabela do modal: campo + direção. Default = 'valor' desc
// (maior |inventário| primeiro, mesmo comportamento de antes da feature).
let invRotSortField = 'valor';
let invRotSortDir = 'desc';
const INV_ROT_SORT_TEXT = new Set(['comprador', 'produto']);

async function carregarInvRotativo() {
  try {
    INV_ROT = await api('GET', '/api/inv-rotativo');
    renderTabelaInvRot();
  } catch (err) {
    INV_ROT = null;
    const tb = $('#tbodyInvRot');
    if (tb) tb.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">${escapeHtml(err.message || 'sem dados')}</td></tr>`;
  }
}

// Classe pelo % (negativo = perda; meta tipo -0,60%)
function classInvRotPct(v) {
  if (v == null) return '';
  const abs = Math.abs(v);
  if (abs <= 0.005) return 'ating-ok';
  if (abs <= 0.012) return 'ating-warn';
  return 'ating-bad';
}

function renderTabelaInvRot() {
  const tbody = $('#tbodyInvRot');
  if (!tbody || !INV_ROT) return;

  // Mapa supervisor por nroempresa (vindo de DADOS.lojas)
  const supByNro = new Map();
  for (const l of (DADOS?.lojas || [])) {
    if (l.loja != null) supByNro.set(parseInt(l.loja, 10), l.supervisor);
  }

  let lojas = (INV_ROT.lojas || []).map(l => ({
    ...l,
    supervisor: supByNro.get(l.nroempresa) || null,
  }));
  if (filtroSupervisor) lojas = lojas.filter(l => l.supervisor === filtroSupervisor);

  // Rank por |pct| (pior = maior perda relativa = rank 1)
  const lojasComPct = lojas
    .map(l => ({ l, abs: l.pct != null ? Math.abs(l.pct) : -1 }))
    .filter(x => x.abs >= 0)
    .sort((a, b) => b.abs - a.abs);
  lojasComPct.forEach((x, i) => x.l._rank = i + 1);
  const classRank = (rank) => (rank != null && rank <= 3) ? 'rank-bad' : '';

  // Agrupa por supervisor
  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const totSup = items.reduce((acc, l) => {
      acc.valor += l.valor || 0; acc.qtd += l.qtd || 0; acc.venda += l.venda || 0; return acc;
    }, { valor: 0, qtd: 0, venda: 0 });
    const pctSupV = totSup.venda > 0 ? totSup.valor / totSup.venda : null;
    html += `
      <tr class="supervisor">
        <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
        <td class="num">${fmtRs(totSup.valor)}</td>
        <td class="num">${fmtNum(totSup.qtd)}</td>
        <td class="num">—</td>
        <td class="num ${classInvRotPct(pctSupV)}">${fmtPct(pctSupV)}</td>
      </tr>
    `;
    for (const l of items) {
      html += `
        <tr>
          <td>${escapeHtml(l.loja_nome || ('Loja ' + l.nroempresa))} <small style="color:var(--text-muted);">(${l.nroempresa})</small></td>
          <td class="num"><span class="valor-link" data-loja-invrot="${l.nroempresa}">${fmtRs(l.valor)}</span></td>
          <td class="num">${fmtNum(l.qtd)}</td>
          <td class="num"><span class="${classRank(l._rank)}">${l._rank ?? '—'}</span></td>
          <td class="num ${classInvRotPct(l.pct)}">${fmtPct(l.pct)}</td>
        </tr>
      `;
    }
  }

  if (!filtroSupervisor && INV_ROT.total) {
    const t = INV_ROT.total;
    html += `
      <tr class="total">
        <td>TOTAL</td>
        <td class="num"><span class="valor-link" data-invrot-total="1"><b>${fmtRs(t.valor)}</b></span></td>
        <td class="num"><b>${fmtNum(t.qtd)}</b></td>
        <td class="num">—</td>
        <td class="num ${classInvRotPct(t.pct)}"><b>${fmtPct(t.pct)}</b></td>
      </tr>
    `;
  }

  tbody.innerHTML = html || `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">sem dados</td></tr>`;
}

// Cache dos itens fetched por loja (memoiza no clique seguinte da mesma loja)
const INV_ROT_ITENS_CACHE = new Map();

async function abrirModalInvRot(nroempresaStr) {
  if (!INV_ROT) return;
  const nro = parseInt(nroempresaStr, 10);
  const lojaInfo = (INV_ROT.lojas || []).find(l => l.nroempresa === nro);
  if (!lojaInfo) return;
  invRotLojaAtiva = nro;
  invRotFiltroComprador = null;

  $('#modalInvRotTitulo').textContent = `Inv. Rotativo — ${lojaInfo.loja_nome || ('Loja ' + nro)} (${nro})`;
  $('#modalInvRotInfo').innerHTML = `Carregando itens…`;
  $('#modalInvRotTabs').innerHTML = '';
  $('#tbodyInvRotComp').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">Carregando…</td></tr>`;
  $('#modalInvRot').classList.add('open');

  let itens = INV_ROT_ITENS_CACHE.get(nro);
  if (!itens) {
    try {
      const r = await api('GET', `/api/inv-rotativo/loja/${nro}`);
      itens = (r.itens || []).map(it => ({ ...it, nroempresa: nro }));
      INV_ROT_ITENS_CACHE.set(nro, itens);
    } catch (err) {
      $('#modalInvRotInfo').innerHTML = `<span style="color:var(--neg);">Erro: ${escapeHtml(err.message)}</span>`;
      return;
    }
  }

  // Só essa loja, depois o filtro vem do invRotFiltroComprador
  if (invRotLojaAtiva !== nro) return; // user já clicou em outra coisa

  // Tabs de comprador agregam pelo VALOR de inventário (sem nulls)
  const comps = {};
  for (const it of itens) {
    const c = it.comprador || '—';
    if (!comps[c]) comps[c] = { valor: 0, qtd: 0, count: 0 };
    comps[c].valor += it.valor || 0;
    comps[c].qtd   += it.qtd || 0;
    comps[c].count++;
  }
  const compsOrdenados = Object.entries(comps).sort((a, b) => Math.abs(b[1].valor) - Math.abs(a[1].valor));

  let tabs = `<button class="qb-tab active" data-comp-invrot="">Todos (${itens.length})</button>`;
  for (const [c, info] of compsOrdenados) {
    tabs += `<button class="qb-tab" data-comp-invrot="${escapeHtml(c)}">${escapeHtml(c)} · ${fmtRs(info.valor)} (${info.count})</button>`;
  }
  $('#modalInvRotTabs').innerHTML = tabs;

  $('#modalInvRotInfo').innerHTML = `
    <b>${itens.length}</b> itens · Total: <b>${fmtRs(lojaInfo.valor)}</b> · Venda: <b>${fmtRs(lojaInfo.venda)}</b> · ${Object.keys(comps).length} compradores
  `;

  renderModalInvRotLista();
}

// ====== Modal TOTAL · todos itens agregados across lojas ======
let INV_ROT_TOTAL = null;
let invRotTotalSortField = 'valor';
let invRotTotalSortDir = 'desc';
let invRotTotalFiltroComprador = null;
const INV_ROT_TOTAL_SORT_TEXT = new Set(['produto', 'comprador']);
const INV_ROT_TOTAL_EXPANDED = new Set();   // keys de produtos com loja-drill aberto

async function abrirModalInvRotTotal() {
  $('#modalInvRotTotalInfo').innerHTML = 'Carregando itens agregados…';
  $('#modalInvRotTotalTabs').innerHTML = '';
  $('#tbodyInvRotTotal').innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">Carregando…</td></tr>`;
  $('#modalInvRotTotal').classList.add('open');
  INV_ROT_TOTAL_EXPANDED.clear();
  invRotTotalFiltroComprador = null;

  if (!INV_ROT_TOTAL) {
    try {
      const r = await api('GET', '/api/inv-rotativo/itens-total');
      INV_ROT_TOTAL = r.itens || [];
    } catch (err) {
      $('#modalInvRotTotalInfo').innerHTML = `<span style="color:var(--neg);">Erro: ${escapeHtml(err.message)}</span>`;
      return;
    }
  }

  // Constrói tabs por comprador (agrega valor de inventário pra cada)
  const comps = {};
  for (const it of INV_ROT_TOTAL) {
    const c = it.comprador || '—';
    if (!comps[c]) comps[c] = { valor: 0, count: 0 };
    comps[c].valor += it.valor || 0;
    comps[c].count++;
  }
  const compsOrdenados = Object.entries(comps).sort((a, b) => Math.abs(b[1].valor) - Math.abs(a[1].valor));
  let tabs = `<button class="qb-tab active" data-comp-invrot-total="">Todos (${INV_ROT_TOTAL.length})</button>`;
  for (const [c, info] of compsOrdenados) {
    tabs += `<button class="qb-tab" data-comp-invrot-total="${escapeHtml(c)}">${escapeHtml(c)} · ${fmtRs(info.valor)} (${info.count})</button>`;
  }
  $('#modalInvRotTotalTabs').innerHTML = tabs;

  const totalItens = INV_ROT_TOTAL.length;
  const inv = INV_ROT_TOTAL.reduce((s, x) => s + (x.valor || 0), 0);
  const ven = INV_ROT_TOTAL.reduce((s, x) => s + (x.venda || 0), 0);
  $('#modalInvRotTotalInfo').innerHTML = `
    <b>${fmtNum(totalItens)}</b> produtos distintos · Inventário: <b>${fmtRs(inv)}</b> · Venda: <b>${fmtRs(ven)}</b> · ${fmtPct(ven ? inv / ven : null)} · ${Object.keys(comps).length} compradores
  `;
  renderModalInvRotTotalLista();
}

function renderModalInvRotTotalLista() {
  if (!INV_ROT_TOTAL) return;
  // Filtro por comprador
  const baseLista = invRotTotalFiltroComprador
    ? INV_ROT_TOTAL.filter(it => it.comprador === invRotTotalFiltroComprador)
    : INV_ROT_TOTAL;
  // Decora
  const decorados = baseLista.map(it => ({
    ...it,
    pct_venda: (it.valor != null && it.venda != null && it.venda !== 0) ? it.valor / it.venda : null,
  }));

  // Ordena
  const f = invRotTotalSortField, dir = invRotTotalSortDir;
  const sign = dir === 'asc' ? 1 : -1;
  decorados.sort((a, b) => {
    const av = a[f], bv = b[f];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (INV_ROT_TOTAL_SORT_TEXT.has(f)) return sign * String(av).localeCompare(String(bv), 'pt-BR');
    return sign * (av - bv);
  });

  // Sort indicator
  $$('#tblInvRotTotal th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sortTotal === f) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  const cell = (v, fmt) => v == null ? '<span style="color:var(--text-muted);">—</span>' : fmt(v);
  let html = '';
  for (const it of decorados) {
    const isOpen = INV_ROT_TOTAL_EXPANDED.has(it.produto);
    const chev = isOpen ? '▾' : '▸';
    html += `
      <tr class="invrot-total-row${isOpen ? ' open' : ''}" data-produto="${escapeHtml(it.produto)}" style="cursor:pointer;">
        <td><span style="color:var(--text-muted);margin-right:4px;">${chev}</span>${escapeHtml(it.produto)}</td>
        <td class="num">${cell(it.qtd, fmtNum)}</td>
        <td class="num">${cell(it.valor, fmtRs)}</td>
        <td class="num">${cell(it.venda, fmtRs)}</td>
        <td class="num">${cell(it.pct_venda, fmtPct)}</td>
      </tr>
    `;
    if (isOpen) {
      const lojas = (it.lojas || []).slice().sort((a, b) => Math.abs(b.valor || 0) - Math.abs(a.valor || 0));
      for (const l of lojas) {
        const pctL = (l.valor != null && l.venda != null && l.venda !== 0) ? l.valor / l.venda : null;
        html += `
          <tr class="invrot-total-loja" style="background: var(--bg-row-hover);">
            <td style="padding-left:36px;color:var(--text-muted);">↳ ${escapeHtml(l.loja_nome)} <small>(${l.nroempresa})</small></td>
            <td class="num">${cell(l.qtd, fmtNum)}</td>
            <td class="num">${cell(l.valor, fmtRs)}</td>
            <td class="num">${cell(l.venda, fmtRs)}</td>
            <td class="num">${cell(pctL, fmtPct)}</td>
          </tr>
        `;
      }
    }
  }
  $('#tbodyInvRotTotal').innerHTML = html || `<tr><td colspan="5" style="text-align:center;padding:18px;color:var(--text-muted);">sem itens</td></tr>`;
}

function renderModalInvRotLista() {
  if (!INV_ROT || invRotLojaAtiva == null) return;
  const itensLoja = INV_ROT_ITENS_CACHE.get(invRotLojaAtiva) || [];
  const itens = itensLoja
    .filter(it => !invRotFiltroComprador || it.comprador === invRotFiltroComprador);

  // Total filtrado = soma do INVENTÁRIO (não da venda). Itens só-venda têm valor null e não contam aqui.
  const totalFiltrado = itens.reduce((s, x) => s + (x.valor || 0), 0);

  // Decora cada item com pct_venda (item.valor/item.venda) e pct_total (item.valor/totalFiltrado)
  // pra ordenação trabalhar uniformemente.
  const decorados = itens.map(it => {
    const pct_venda = (it.valor != null && it.venda != null && it.venda !== 0) ? it.valor / it.venda : null;
    const pct_total = (it.valor != null && totalFiltrado !== 0) ? it.valor / totalFiltrado : null;
    return { ...it, pct_venda, pct_total };
  });

  // Ordenação: nulls vão pro fim. Texto = localeCompare pt-BR; número = numérico.
  const f = invRotSortField, dir = invRotSortDir;
  const sign = dir === 'asc' ? 1 : -1;
  decorados.sort((a, b) => {
    const av = a[f], bv = b[f];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;       // nulls always last
    if (bv == null) return -1;
    if (INV_ROT_SORT_TEXT.has(f)) {
      return sign * String(av).localeCompare(String(bv), 'pt-BR');
    }
    return sign * (av - bv);
  });

  // Sort indicator nas <th>
  $$('#tblInvRotComp th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === f) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  // Render
  const cell = (v, fmt) => v == null ? '<span style="color:var(--text-muted);">—</span>' : fmt(v);
  let html = '';
  for (const it of decorados) {
    html += `
      <tr>
        <td>${escapeHtml(it.comprador || '—')}</td>
        <td>${escapeHtml(it.produto || '—')}</td>
        <td class="num">${cell(it.qtd,   fmtNum)}</td>
        <td class="num">${cell(it.valor, fmtRs)}</td>
        <td class="num">${cell(it.venda, fmtRs)}</td>
        <td class="num">${cell(it.pct_venda, fmtPct)}</td>
        <td class="num">${cell(it.pct_total, fmtPct)}</td>
      </tr>
    `;
  }
  const totQtd   = decorados.reduce((s, x) => s + (x.qtd   || 0), 0);
  const totVenda = decorados.reduce((s, x) => s + (x.venda || 0), 0);
  html += `
    <tr class="total">
      <td colspan="2">TOTAL ${invRotFiltroComprador ? '(' + escapeHtml(invRotFiltroComprador) + ')' : ''}</td>
      <td class="num"><b>${fmtNum(totQtd)}</b></td>
      <td class="num"><b>${fmtRs(totalFiltrado)}</b></td>
      <td class="num"><b>${fmtRs(totVenda)}</b></td>
      <td class="num"><b>${fmtPct(totVenda ? totalFiltrado / totVenda : null)}</b></td>
      <td class="num"><b>100,00%</b></td>
    </tr>
  `;
  $('#tbodyInvRotComp').innerHTML = html;
}

// ========== Aba 9 · Estoque s/ Vendas 10d ==========
function renderTabelaSemVendas() {
  const tb = $('#tbodySemVendas');
  if (!tb) return;
  let lojas = (DADOS?.lojas || []).filter(l => !filtroSupervisor || l.supervisor === filtroSupervisor);

  // Rank: 1 = pior (% valor parado mais alta)
  const comSV = lojas.filter(l => l.sem_vendas_pct != null).slice().sort((a, b) => (b.sem_vendas_pct || 0) - (a.sem_vendas_pct || 0));
  const rank = new Map();
  comSV.forEach((l, i) => rank.set(l.loja, i + 1));
  const piores = new Set(comSV.slice(0, 3).map(l => l.loja));

  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  const classSVPct = (v) => v == null ? '' : (v <= 0.05 ? 'ating-ok' : v <= 0.15 ? 'ating-warn' : 'ating-bad');

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const subV = items.reduce((a, x) => a + (x.venda || 0), 0);
    const subSV = items.reduce((a, x) => a + (x.sem_vendas_valor || 0), 0);
    const subSkus = items.reduce((a, x) => a + (x.sem_vendas_qtd_skus || 0), 0);
    const subPct = subV > 0 ? subSV / subV : null;
    const subUnid = items.reduce((a, x) => a + (x.sem_vendas_qtd_unid || 0), 0);
    html += `
      <tr class="supervisor">
        <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
        <td class="num">${fmtRs(subV)}</td>
        <td class="num">${fmtNum(subSkus)}</td>
        <td class="num">${fmtNum(subUnid)}</td>
        <td class="num">${fmtRs(subSV)}</td>
        <td class="num ${classSVPct(subPct)}"><b>${fmtPct(subPct)}</b></td>
        <td class="num">—</td>
      </tr>`;
    const ord = items.slice().sort((a, b) => (b.sem_vendas_pct ?? -Infinity) - (a.sem_vendas_pct ?? -Infinity));
    for (const l of ord) {
      const r = rank.get(l.loja);
      const rkCls = piores.has(l.loja) ? 'rank-bad' : '';
      html += `
        <tr style="cursor:pointer;" data-loja-semvendas="${l.loja}">
          <td><span class="loja-link" data-loja-semvendas="${l.loja}">${l.loja} — ${escapeHtml(l.loja_nome || '')}</span></td>
          <td class="num">${fmtRs(l.venda)}</td>
          <td class="num">${fmtNum(l.sem_vendas_qtd_skus)}</td>
          <td class="num">${fmtNum(l.sem_vendas_qtd_unid)}</td>
          <td class="num">${fmtRs(l.sem_vendas_valor)}</td>
          <td class="num ${classSVPct(l.sem_vendas_pct)}"><b>${fmtPct(l.sem_vendas_pct)}</b></td>
          <td class="num ${rkCls}">${r ?? '—'}</td>
        </tr>`;
    }
  }
  const totV = lojas.reduce((a, x) => a + (x.venda || 0), 0);
  const totSV = lojas.reduce((a, x) => a + (x.sem_vendas_valor || 0), 0);
  const totUnid = lojas.reduce((a, x) => a + (x.sem_vendas_qtd_unid || 0), 0);
  const totSkus = lojas.reduce((a, x) => a + (x.sem_vendas_qtd_skus || 0), 0);
  const totPct = totV > 0 ? totUnid / totV : null;
  html += `
    <tr class="total">
      <td><b>TOTAL</b></td>
      <td class="num"><b>${fmtRs(totV)}</b></td>
      <td class="num"><b>${fmtNum(totSkus)}</b></td>
      <td class="num"><b>${fmtNum(totUnid)}</b></td>
      <td class="num"><b>${fmtRs(totSV)}</b></td>
      <td class="num ${classSVPct(totPct)}"><b>${fmtPct(totPct)}</b></td>
      <td class="num">—</td>
    </tr>`;
  tb.innerHTML = html;
}

function abrirModalSemVendas(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;

  const detalhe = (DADOS?.sem_vendas_detalhe?.[lojaInt] || []);
  $('#modalSemVendasTitulo').textContent = `Estoque s/ Vendas — Loja ${lojaInt} ${lojaInfo.loja_nome || ''}`;
  $('#modalSemVendasInfo').innerHTML = `
    Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> ·
    Venda: <b>${fmtRs(lojaInfo.venda)}</b> ·
    Valor Parado: <b>${fmtRs(lojaInfo.sem_vendas_valor)}</b> ·
    SKUs: <b>${fmtNum(lojaInfo.sem_vendas_qtd_skus)}</b> ·
    % Venda: <b>${fmtPct(lojaInfo.sem_vendas_pct)}</b>
  `;
  $('#tbodySemVendasDet').innerHTML = detalhe.map(it => {
    const dt = it.dta_ult_venda ? it.dta_ult_venda.split('-').reverse().join('/') : '—';
    return `
      <tr>
        <td>${escapeHtml(it.produto || '—')}</td>
        <td>${escapeHtml(it.comprador || '—')}</td>
        <td class="num">${Number(it.qtd || 0).toLocaleString('pt-BR', {maximumFractionDigits: 2})}</td>
        <td class="num">${fmtRs(it.valor)}</td>
        <td class="num">${it.dias_sem_venda}</td>
        <td class="num">${dt}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="6" style="padding:14px;color:var(--text-muted);">Sem produtos</td></tr>`;

  $('#modalSemVendas').classList.add('open');
}

// ========== Aba 10 · Cancelamento de Cupom ==========
function renderTabelaCancel() {
  const tb = $('#tbodyCancel');
  if (!tb) return;
  let lojas = (DADOS?.lojas || []).filter(l => !filtroSupervisor || l.supervisor === filtroSupervisor);

  // Rank: 1 = pior (% cancel mais alta)
  const comCancel = lojas.filter(l => l.cancelamento_pct != null).slice().sort((a, b) => (b.cancelamento_pct || 0) - (a.cancelamento_pct || 0));
  const rank = new Map();
  comCancel.forEach((l, i) => rank.set(l.loja, i + 1));
  const piores = new Set(comCancel.slice(0, 3).map(l => l.loja));

  // Agrupa por supervisor
  const grupos = {};
  for (const l of lojas) {
    const s = l.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(l);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  const classCancelPct = (v) => v == null ? '' : (v <= 0.005 ? 'ating-ok' : v <= 0.015 ? 'ating-warn' : 'ating-bad');

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const subV = items.reduce((a, x) => a + (x.venda || 0), 0);
    const subC = items.reduce((a, x) => a + (x.cancelamento || 0), 0);
    const subQ = items.reduce((a, x) => a + (x.cancelamento_qtd || 0), 0);
    const subPct = subV > 0 ? subC / subV : null;
    html += `
      <tr class="supervisor">
        <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
        <td class="num">${fmtRs(subV)}</td>
        <td class="num">${fmtRs(subC)}</td>
        <td class="num">${fmtNum(subQ)}</td>
        <td class="num ${classCancelPct(subPct)}"><b>${fmtPct(subPct)}</b></td>
        <td class="num">—</td>
      </tr>`;
    const ord = items.slice().sort((a, b) => (b.cancelamento_pct ?? -Infinity) - (a.cancelamento_pct ?? -Infinity));
    for (const l of ord) {
      const r = rank.get(l.loja);
      const rkCls = piores.has(l.loja) ? 'rank-bad' : '';
      html += `
        <tr style="cursor:pointer;" data-loja-cancel="${l.loja}">
          <td><span class="loja-link" data-loja-cancel="${l.loja}">${l.loja} — ${escapeHtml(l.loja_nome || '')}</span></td>
          <td class="num">${fmtRs(l.venda)}</td>
          <td class="num">${fmtRs(l.cancelamento)}</td>
          <td class="num">${fmtNum(l.cancelamento_qtd)}</td>
          <td class="num ${classCancelPct(l.cancelamento_pct)}"><b>${fmtPct(l.cancelamento_pct)}</b></td>
          <td class="num ${rkCls}">${r ?? '—'}</td>
        </tr>`;
    }
  }
  const totV = lojas.reduce((a, x) => a + (x.venda || 0), 0);
  const totC = lojas.reduce((a, x) => a + (x.cancelamento || 0), 0);
  const totQ = lojas.reduce((a, x) => a + (x.cancelamento_qtd || 0), 0);
  const totPct = totV > 0 ? totC / totV : null;
  html += `
    <tr class="total">
      <td><b>TOTAL</b></td>
      <td class="num"><b>${fmtRs(totV)}</b></td>
      <td class="num"><b>${fmtRs(totC)}</b></td>
      <td class="num"><b>${fmtNum(totQ)}</b></td>
      <td class="num ${classCancelPct(totPct)}"><b>${fmtPct(totPct)}</b></td>
      <td class="num">—</td>
    </tr>`;
  tb.innerHTML = html;
}

// Modal Cancelamento — lista por operador/data/PDV
function abrirModalCancel(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;

  const detalhe = (DADOS?.cancelamento_detalhe?.[lojaInt] || []);
  const tot = detalhe.reduce((a, x) => a + (x.valor || 0), 0);

  $('#modalCancelTitulo').textContent = `Cancelamento — Loja ${lojaInt} ${lojaInfo.loja_nome || ''}`;
  $('#modalCancelInfo').innerHTML = `
    Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> ·
    Venda: <b>${fmtRs(lojaInfo.venda)}</b> ·
    Total Cancel: <b>${fmtRs(tot)}</b> em ${detalhe.length} operações ·
    Cancel %: <b>${fmtPct(lojaInfo.cancelamento_pct)}</b>
  `;
  $('#tbodyCancelDet').innerHTML = detalhe.map(it => {
    const dt = it.data ? it.data.split('-').reverse().slice(0,2).join('/') : '—';
    return `
      <tr>
        <td>${dt}</td>
        <td>${escapeHtml(it.operador || '—')}</td>
        <td class="num">${it.codoperador ?? '—'}</td>
        <td class="num">${it.nropdv ?? '—'}</td>
        <td class="num">${fmtRs(it.valor)}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="5" style="padding:14px;color:var(--text-muted);">Sem cancelamentos</td></tr>`;

  $('#modalCancel').classList.add('open');
}

// ========== Aba 6 · Quebra FLV (Identificada + Rotativo) ==========
function renderTabelaQuebraSecao(caminho, tbodySel) {
  const tb = $(tbodySel);
  if (!tb) return;
  let itens = (DADOS?.compra_venda_secao?.[caminho]) || [];
  if (!itens.length) {
    tb.innerHTML = '<tr><td colspan="7" style="padding:14px;color:var(--text-muted);">Sem dados</td></tr>';
    return;
  }
  if (filtroSupervisor) itens = itens.filter(it => it.supervisor === filtroSupervisor);

  // Rank: 1 = pior (% quebra TOTAL mais alta)
  const comQuebra = itens.filter(it => it.quebra_total_pct != null).slice().sort((a, b) => (b.quebra_total_pct || 0) - (a.quebra_total_pct || 0));
  const rank = new Map();
  comQuebra.forEach((it, i) => rank.set(it.loja, i + 1));
  const piores = new Set(comQuebra.slice(0, 3).map(it => it.loja));

  // Agrupa por supervisor
  const grupos = {};
  for (const it of itens) {
    const s = it.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(it);
  }
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  const classQbPct = (v) => v == null ? '' : (v <= 0.02 ? 'ating-ok' : v <= 0.05 ? 'ating-warn' : 'ating-bad');

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    const subV = items.reduce((a, x) => a + (x.venda || 0), 0);
    const subQ = items.reduce((a, x) => a + (x.quebra || 0), 0);
    const subI = items.reduce((a, x) => a + (x.inv_rotativo || 0), 0);
    const subT = items.reduce((a, x) => a + (x.quebra_total || 0), 0);
    const subPct = subV > 0 ? subT / subV : null;
    html += `
      <tr class="supervisor">
        <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
        <td class="num">${fmtRs(subV)}</td>
        <td class="num">${fmtRs(subQ)}</td>
        <td class="num">${fmtRsSig(subI)}</td>
        <td class="num">${fmtRs(subT)}</td>
        <td class="num ${classQbPct(subPct)}"><b>${fmtPct(subPct)}</b></td>
        <td class="num">—</td>
      </tr>`;
    const ord = items.slice().sort((a, b) => (b.quebra_total_pct ?? -Infinity) - (a.quebra_total_pct ?? -Infinity));
    for (const it of ord) {
      const r = rank.get(it.loja);
      const rkCls = piores.has(it.loja) ? 'rank-bad' : '';
      html += `
        <tr style="cursor:pointer;" data-loja-quebraflv="${it.loja}">
          <td><span class="loja-link" data-loja-quebraflv="${it.loja}">${it.loja} — ${escapeHtml(it.loja_nome || '')}</span></td>
          <td class="num">${fmtRs(it.venda)}</td>
          <td class="num">${fmtRs(it.quebra)}</td>
          <td class="num">${fmtRsSig(it.inv_rotativo)}</td>
          <td class="num">${fmtRs(it.quebra_total)}</td>
          <td class="num ${classQbPct(it.quebra_total_pct)}"><b>${fmtPct(it.quebra_total_pct)}</b></td>
          <td class="num ${rkCls}">${r ?? '—'}</td>
        </tr>`;
    }
  }
  const totV = itens.reduce((a, x) => a + (x.venda || 0), 0);
  const totQ = itens.reduce((a, x) => a + (x.quebra || 0), 0);
  const totI = itens.reduce((a, x) => a + (x.inv_rotativo || 0), 0);
  const totT = itens.reduce((a, x) => a + (x.quebra_total || 0), 0);
  const totPct = totV > 0 ? totT / totV : null;
  html += `
    <tr class="total">
      <td><b>TOTAL</b></td>
      <td class="num"><b>${fmtRs(totV)}</b></td>
      <td class="num"><b>${fmtRs(totQ)}</b></td>
      <td class="num"><b>${fmtRsSig(totI)}</b></td>
      <td class="num"><b>${fmtRs(totT)}</b></td>
      <td class="num ${classQbPct(totPct)}"><b>${fmtPct(totPct)}</b></td>
      <td class="num">—</td>
    </tr>`;
  tb.innerHTML = html;
}

// ========== Abas 3-5 · Compra × Venda por seção (agrupado por supervisor) ==========
function renderTabelaCxV(caminho, tbodySel) {
  const tb = $(tbodySel);
  if (!tb) return;
  let itens = (DADOS?.compra_venda_secao?.[caminho]) || [];
  if (!itens.length) {
    tb.innerHTML = '<tr><td colspan="6" style="padding:14px;color:var(--text-muted);">Sem dados — verifique se a extração rodou</td></tr>';
    return;
  }
  // Aplica filtro global de supervisor (mesmo da aba 1)
  if (filtroSupervisor) itens = itens.filter(it => it.supervisor === filtroSupervisor);

  // Rank GLOBAL (entre TODAS as lojas com dado) — 1 = pior CxV
  const todosComCxV = itens.filter(it => it.cxv_pct != null).slice().sort((a, b) => (a.cxv_pct || 0) - (b.cxv_pct || 0));
  const rank = new Map();
  todosComCxV.forEach((it, i) => rank.set(it.loja, i + 1));
  const piores = new Set(todosComCxV.slice(0, 3).map(it => it.loja));

  // Agrupa por supervisor
  const grupos = {};
  for (const it of itens) {
    const s = it.supervisor || 'Sem supervisor';
    if (!grupos[s]) grupos[s] = [];
    grupos[s].push(it);
  }
  // Ordem dos supervisores: mesma da aba Venda&Margem
  const ordemSup = Object.keys(DADOS?.supervisores || {}).filter(s => grupos[s]);
  for (const k of Object.keys(grupos)) if (!ordemSup.includes(k)) ordemSup.push(k);

  let html = '';
  for (const sup of ordemSup) {
    const items = grupos[sup];
    if (!items?.length) continue;
    // Totais do supervisor
    const subV = items.reduce((a, x) => a + (x.venda || 0), 0);
    const subC = items.reduce((a, x) => a + (x.compra || 0), 0);
    const subCxV = subV - subC;
    const subPct = subV > 0 ? subCxV / subV : null;
    const subCls = (subPct == null) ? '' : (subPct >= 0 ? 'ating-ok' : 'ating-bad');
    html += `
      <tr class="supervisor">
        <td>👤 ${escapeHtml(sup)} · ${items.length} lojas</td>
        <td class="num">${fmtRs(subV)}</td>
        <td class="num">${fmtRs(subC)}</td>
        <td class="num ${subCls}">${fmtRsSig(subCxV)}</td>
        <td class="num ${subCls}"><b>${fmtPct(subPct)}</b></td>
        <td class="num">—</td>
      </tr>`;
    // Lojas do supervisor (ordenadas por CxV% desc — melhor primeiro)
    const ord = items.slice().sort((a, b) => (b.cxv_pct ?? -Infinity) - (a.cxv_pct ?? -Infinity));
    for (const it of ord) {
      const r = rank.get(it.loja);
      const rkCls = piores.has(it.loja) ? 'rank-bad' : '';
      const cxvCls = (it.cxv_pct == null) ? '' : (it.cxv_pct >= 0 ? 'ating-ok' : 'ating-bad');
      html += `
        <tr>
          <td>${it.loja} — ${escapeHtml(it.loja_nome || '')}</td>
          <td class="num">${fmtRs(it.venda)}</td>
          <td class="num">${fmtRs(it.compra)}</td>
          <td class="num ${cxvCls}">${fmtRsSig(it.cxv_rs)}</td>
          <td class="num ${cxvCls}"><b>${fmtPct(it.cxv_pct)}</b></td>
          <td class="num ${rkCls}">${r ?? '—'}</td>
        </tr>`;
    }
  }

  // Total geral
  const totV = itens.reduce((a, x) => a + (x.venda || 0), 0);
  const totC = itens.reduce((a, x) => a + (x.compra || 0), 0);
  const totCxV = totV - totC;
  const totPct = totV > 0 ? totCxV / totV : null;
  const totCls = (totPct == null) ? '' : (totPct >= 0 ? 'ating-ok' : 'ating-bad');
  html += `
    <tr class="total">
      <td><b>TOTAL</b></td>
      <td class="num"><b>${fmtRs(totV)}</b></td>
      <td class="num"><b>${fmtRs(totC)}</b></td>
      <td class="num ${totCls}"><b>${fmtRsSig(totCxV)}</b></td>
      <td class="num ${totCls}"><b>${fmtPct(totPct)}</b></td>
      <td class="num">—</td>
    </tr>`;
  tb.innerHTML = html;
}

// ========== Aba 2 · Lucro líquido por loja ==========
function renderTabelaLucro() {
  const tb = $('#tbodyLucro');
  if (!tb) return;
  const lojas = (DADOS?.lojas || []).slice();
  // Ordena por margem total desc; rank vem dessa ordenação
  const enriched = lojas.map(l => {
    const venda = l.venda || 0;
    const lucr = l.lucratividade || 0;
    const mgT = (venda > 0) ? (lucr / venda) : null;
    const mgP = l.margem_pdv != null ? l.margem_pdv : null;
    return { ...l, _mgT: mgT, _mgP: mgP };
  });
  enriched.sort((a, b) => (b._mgT || -1) - (a._mgT || -1));
  // Rank: 1 = melhor margem total
  enriched.forEach((l, i) => l._rankMg = i + 1);
  // Pra colorir: 3 piores margens em vermelho
  const piores = new Set(enriched.slice(-3).map(l => l.loja));

  const rows = enriched.map(l => {
    const cls = piores.has(l.loja) ? 'rank-bad' : '';
    return `
      <tr>
        <td>${l.loja} — ${escapeHtml(l.loja_nome || '')}</td>
        <td class="num">${fmtRs(l.venda)}</td>
        <td class="num">${fmtRs(l.lucratividade)}</td>
        <td class="num"><b>${fmtPct(l._mgT)}</b></td>
        <td class="num">${fmtPct(l._mgP)}</td>
        <td class="num ${cls}">${l._rankMg}</td>
      </tr>`;
  }).join('');
  tb.innerHTML = rows || '<tr><td colspan="6" style="padding:14px;color:var(--text-muted);">Sem dados</td></tr>';
}

// ========== Modal · Drill-down Quebra FLV (Identificada + Rotativo) ==========
function abrirModalQuebraFLV(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;

  // Item da seção FLV
  const flv = (DADOS?.compra_venda_secao?.['PERECIVEIS \\ FLV'] || []).find(i => i.loja == lojaInt);
  const venda = flv?.venda || 0;
  const quebraIdent = flv?.quebra || 0;
  const invRotativo = flv?.inv_rotativo || 0;
  const quebraTotal = flv?.quebra_total || 0;
  const quebraPct = flv?.quebra_total_pct;

  $('#modalQuebraFLVTitulo').textContent = `Quebra FLV — Loja ${lojaInt} ${lojaInfo.loja_nome || ''}`;
  $('#modalQuebraFLVInfo').innerHTML = `
    Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> ·
    Venda FLV: <b>${fmtRs(venda)}</b> ·
    Quebra Ident.: <b>${fmtRs(quebraIdent)}</b> ·
    Inv. Rotativo: <b>${fmtRsSig(invRotativo)}</b> ·
    Quebra Total: <b>${fmtRs(quebraTotal)}</b> (${fmtPct(quebraPct)})
  `;

  // Quebra Identificada — filtra quebra_detalhe pelo comprador FLV
  const detalhe = (DADOS?.quebra_detalhe?.[lojaInt] || []).filter(it => /FLV/i.test(it.comprador || ''));
  const totIdent = detalhe.reduce((a, x) => a + (x.valor || 0), 0);
  const ordIdent = detalhe.slice().sort((a, b) => (b.valor || 0) - (a.valor || 0));
  $('#tbodyQuebraFLVIdent').innerHTML = ordIdent.map(it => {
    const pct = totIdent > 0 ? (it.valor / totIdent) : 0;
    return `
      <tr>
        <td>${escapeHtml(it.produto || '—')}</td>
        <td class="num">${(it.qtd == null ? '—' : Number(it.qtd).toLocaleString('pt-BR', {maximumFractionDigits: 2}))}</td>
        <td class="num">${fmtRs(it.valor)}</td>
        <td class="num">${fmtPct(pct)}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="4" style="padding:14px;color:var(--text-muted);">Sem quebra identificada</td></tr>`;

  // Inventário Rotativo
  const inv = (DADOS?.inv_rotativo_detalhe?.['FLV']?.[lojaInt] || []);
  const totInv = inv.reduce((a, x) => a + (x.valor || 0), 0);
  const ordInv = inv.slice().sort((a, b) => (a.valor || 0) - (b.valor || 0));  // mais negativo primeiro
  $('#tbodyQuebraFLVInv').innerHTML = ordInv.map(it => {
    const pct = totInv !== 0 ? (it.valor / totInv) : 0;
    const cls = (it.valor < 0) ? 'ating-bad' : (it.valor > 0 ? 'ating-ok' : '');
    return `
      <tr>
        <td>${escapeHtml(it.produto || '—')}</td>
        <td class="num">${(it.qtd == null ? '—' : Number(it.qtd).toLocaleString('pt-BR', {maximumFractionDigits: 2}))}</td>
        <td class="num ${cls}">${fmtRsSig(it.valor)}</td>
        <td class="num">${fmtPct(pct)}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="4" style="padding:14px;color:var(--text-muted);">Sem inventário rotativo</td></tr>`;

  $('#modalQuebraFLV').classList.add('open');
}

// ========== Tabs (Pontos da Meta) ==========
function mostrarAba(num) {
  document.querySelectorAll('.op-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === String(num)));
  document.querySelectorAll('.op-tab-content').forEach(c => {
    c.hidden = c.dataset.tabContent !== String(num);
  });
  // Persiste
  try { localStorage.setItem('op_aba', String(num)); } catch (e) {}
}

// ========== Drill-down estoque por comprador (de uma loja) ==========
function abrirModalEstoque(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;

  const compradores = DADOS?.estoque_por_comprador?.[lojaInt] || [];
  const totalLoja = lojaInfo.valor_estoque || 0;

  const classDde = (v) => {
    if (v == null) return '';
    if (v <= 25) return 'ating-ok';
    if (v <= 40) return 'ating-warn';
    return 'ating-bad';
  };

  let html = '';
  for (const c of compradores) {
    const pct = totalLoja > 0 ? c.valor_estoque / totalLoja : null;
    html += `
      <tr>
        <td>${escapeHtml(c.comprador || '—')}</td>
        <td class="num">${fmtRs(c.valor_estoque)}</td>
        <td class="num">${fmtPct(pct)}</td>
        <td class="num ${classDde(c.dde)}">${c.dde != null ? c.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</td>
      </tr>
    `;
  }
  html += `
    <tr class="total" style="background:rgba(245,211,12,.12);font-weight:700;">
      <td>TOTAL</td>
      <td class="num"><b>${fmtRs(totalLoja)}</b></td>
      <td class="num"><b>100,00%</b></td>
      <td class="num ${classDde(lojaInfo.dde)}"><b>${lojaInfo.dde != null ? lojaInfo.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</b></td>
    </tr>
  `;

  $('#modalEstoqueTitulo').textContent = `Estoque — Loja ${lojaInfo.loja} — ${lojaInfo.loja_nome || ''}`;
  $('#modalEstoqueInfo').innerHTML = `
    <b>${compradores.length}</b> compradores · Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> · Valor total: <b>${fmtRs(totalLoja)}</b> · DDE: <b>${lojaInfo.dde != null ? lojaInfo.dde.toFixed(1).replace('.', ',') + 'd' : '—'}</b>
  `;
  $('#tbodyEstoqueComp').innerHTML = html;
  $('#modalEstoque').classList.add('open');
}

// ========== Drill-down quebra (loja → compradores → produtos) ==========
let quebraFiltroComprador = null;
let quebraLojaAtiva = null;

function abrirModalQuebra(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;
  quebraLojaAtiva = lojaInt;
  quebraFiltroComprador = null;

  const itens = DADOS?.quebra_detalhe?.[lojaInt] || [];
  const totalLoja = lojaInfo.valor_quebra || 0;

  // Compradores únicos com seus totais
  const comps = {};
  for (const it of itens) {
    const c = it.comprador || '—';
    if (!comps[c]) comps[c] = { valor: 0, qtd: 0, count: 0 };
    comps[c].valor += it.valor || 0;
    comps[c].qtd += it.qtd || 0;
    comps[c].count++;
  }
  const compsOrdenados = Object.entries(comps).sort((a, b) => b[1].valor - a[1].valor);

  // Tabs (TODOS + 1 por comprador)
  let tabs = `<button class="qb-tab active" data-comp="">Todos (${itens.length})</button>`;
  for (const [c, info] of compsOrdenados) {
    tabs += `<button class="qb-tab" data-comp="${escapeHtml(c)}">${escapeHtml(c)} · ${fmtRs(info.valor)} (${info.count})</button>`;
  }
  $('#modalQuebraTabs').innerHTML = tabs;

  $('#modalQuebraTitulo').textContent = `Quebra — Loja ${lojaInfo.loja} — ${lojaInfo.loja_nome || ''}`;
  $('#modalQuebraInfo').innerHTML = `
    <b>${itens.length}</b> itens · Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> · Total: <b>${fmtRs(totalLoja)}</b> · ${Object.keys(comps).length} compradores
  `;

  renderModalQuebraLista();
  $('#modalQuebra').classList.add('open');
}

function renderModalQuebraLista() {
  const itens = (DADOS?.quebra_detalhe?.[quebraLojaAtiva] || [])
    .filter(it => !quebraFiltroComprador || it.comprador === quebraFiltroComprador);
  const totalFiltrado = itens.reduce((s, x) => s + (x.valor || 0), 0);

  let html = '';
  for (const it of itens) {
    const pct = totalFiltrado > 0 ? it.valor / totalFiltrado : null;
    html += `
      <tr>
        <td>${escapeHtml(it.comprador || '—')}</td>
        <td>${escapeHtml(it.produto || '—')}</td>
        <td class="num">${fmtNum(it.qtd)}</td>
        <td class="num">${fmtRs(it.valor)}</td>
        <td class="num">${fmtPct(pct)}</td>
      </tr>
    `;
  }
  html += `
    <tr class="total">
      <td colspan="2">TOTAL ${quebraFiltroComprador ? '(' + escapeHtml(quebraFiltroComprador) + ')' : ''}</td>
      <td class="num"><b>${fmtNum(itens.reduce((s, x) => s + (x.qtd || 0), 0))}</b></td>
      <td class="num"><b>${fmtRs(totalFiltrado)}</b></td>
      <td class="num"><b>100,00%</b></td>
    </tr>
  `;
  $('#tbodyQuebraComp').innerHTML = html;
}

// ========== Drill-down dia a dia por loja ==========
function abrirModalDiario(loja) {
  const lojaInt = parseInt(loja, 10);
  const lojaInfo = (DADOS?.lojas || []).find(l => l.loja == lojaInt);
  if (!lojaInfo) return;

  const vendasD = DADOS?.vendas_diarias?.[lojaInt] || {};
  const metasD  = DADOS?.metas_diarias?.[lojaInt]  || {};
  const fimISO  = (DADOS?.periodo?.fim) || new Date().toISOString().slice(0,10);

  // Lista de datas: do dia 1 do mês até o "fim" do período
  const fim = new Date(fimISO + 'T00:00:00');
  const ano = fim.getFullYear(), mes = fim.getMonth();
  const dias = [];
  for (let d = 1; d <= fim.getDate(); d++) {
    dias.push(new Date(ano, mes, d).toISOString().slice(0,10));
  }

  let totMV = 0, totV = 0, totL = 0, totVerba = 0, totDoc = 0;
  const linhas = dias.map(iso => {
    const v = vendasD[iso] || {};
    const meta = metasD[iso] || 0;
    const venda = Number(v.venda) || 0;
    const lucr  = Number(v.lucratividade) || 0;
    const verba = Number(v.verba) || 0;
    const doctos = Number(v.doctos) || 0;
    totMV += meta; totV += venda; totL += lucr; totVerba += verba; totDoc += doctos;
    const diff = venda - meta;
    const ating = meta > 0 ? venda / meta : null;
    const mgT = venda > 0 ? lucr / venda : null;
    const mgP = venda > 0 ? (lucr - verba) / venda : null;
    const dataBR = iso.split('-').reverse().join('/');
    return `
      <tr>
        <td>${dataBR}</td>
        <td class="num">${fmtRs(meta)}</td>
        <td class="num"><b>${fmtRs(venda)}</b></td>
        <td class="num ${diff >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtRsSig(diff)}</td>
        <td class="num ${classAt(ating)}">${fmtPct(ating)}</td>
        <td class="num">${fmtRs(lucr)}</td>
        <td class="num ${classMg(mgT)}">${fmtPct(mgT)}</td>
        <td class="num ${classMg(mgP)}">${fmtPct(mgP)}</td>
        <td class="num">${fmtRs(verba)}</td>
        <td class="num">${fmtNum(doctos)}</td>
      </tr>
    `;
  });

  // Linha total
  const atTot = totMV ? totV / totMV : null;
  const mgTotPct = totV ? totL / totV : null;
  const mgPdvPct = totV ? (totL - totVerba) / totV : null;
  linhas.push(`
    <tr class="total" style="background:rgba(245,211,12,.12);font-weight:700;">
      <td>TOTAL</td>
      <td class="num">${fmtRs(totMV)}</td>
      <td class="num"><b>${fmtRs(totV)}</b></td>
      <td class="num ${(totV-totMV) >= 0 ? 'diff-pos' : 'diff-neg'}">${fmtRsSig(totV - totMV)}</td>
      <td class="num ${classAt(atTot)}"><b>${fmtPct(atTot)}</b></td>
      <td class="num">${fmtRs(totL)}</td>
      <td class="num ${classMg(mgTotPct)}"><b>${fmtPct(mgTotPct)}</b></td>
      <td class="num ${classMg(mgPdvPct)}"><b>${fmtPct(mgPdvPct)}</b></td>
      <td class="num">${fmtRs(totVerba)}</td>
      <td class="num">${fmtNum(totDoc)}</td>
    </tr>
  `);

  $('#modalDiarioTitulo').textContent = `Loja ${lojaInfo.loja} — ${lojaInfo.loja_nome || ''}`;
  $('#modalDiarioInfo').innerHTML = `
    <b>${dias.length}</b> dias · Supervisor: <b>${escapeHtml(lojaInfo.supervisor || '—')}</b> · Venda: <b>${fmtRs(totV)}</b> / ${fmtRs(totMV)} (${fmtPct(atTot)})
  `;
  $('#tbodyDiario').innerHTML = linhas.join('');
  $('#modalDiario').classList.add('open');
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
  $('#filtroSupervisor').addEventListener('change', e => { filtroSupervisor = e.target.value; renderTudo(); });

  // Tabs (Pontos da Meta)
  document.querySelectorAll('.op-tab').forEach(b => {
    b.addEventListener('click', () => mostrarAba(b.dataset.tab));
  });
  // Restaura última aba aberta
  try {
    const saved = localStorage.getItem('op_aba');
    if (saved) mostrarAba(saved);
  } catch (e) {}

  // Click na loja → abre modal correspondente
  document.addEventListener('click', e => {
    const linkVM = e.target.closest('.loja-link');
    if (linkVM) { abrirModalDiario(linkVM.dataset.loja); return; }
    const linkEstq = e.target.closest('.loja-link-estq');
    if (linkEstq) { abrirModalEstoque(linkEstq.dataset.loja); return; }
    const linkQb = e.target.closest('[data-loja-quebra]');
    if (linkQb) { abrirModalQuebra(linkQb.dataset.lojaQuebra); return; }
    const linkQbFLV = e.target.closest('[data-loja-quebraflv]');
    if (linkQbFLV) { abrirModalQuebraFLV(linkQbFLV.dataset.lojaQuebraflv); return; }
    const linkCancel = e.target.closest('[data-loja-cancel]');
    if (linkCancel) { abrirModalCancel(linkCancel.dataset.lojaCancel); return; }
    const linkSV = e.target.closest('[data-loja-semvendas]');
    if (linkSV) { abrirModalSemVendas(linkSV.dataset.lojaSemvendas); return; }
    const linkIR = e.target.closest('[data-loja-invrot]');
    if (linkIR) { abrirModalInvRot(linkIR.dataset.lojaInvrot); return; }
    const linkIRT = e.target.closest('[data-invrot-total]');
    if (linkIRT) { abrirModalInvRotTotal(); return; }
    const tabQb = e.target.closest('.qb-tab:not([data-comp-invrot])');
    if (tabQb && tabQb.hasAttribute('data-comp')) {
      $('#modalQuebraTabs').querySelectorAll('.qb-tab').forEach(t => t.classList.remove('active'));
      tabQb.classList.add('active');
      quebraFiltroComprador = tabQb.dataset.comp || null;
      renderModalQuebraLista();
      return;
    }
    const tabIR = e.target.closest('[data-comp-invrot]');
    if (tabIR) {
      $('#modalInvRotTabs').querySelectorAll('.qb-tab').forEach(t => t.classList.remove('active'));
      tabIR.classList.add('active');
      invRotFiltroComprador = tabIR.dataset.compInvrot || null;
      renderModalInvRotLista();
      return;
    }
  });
  $('#modalDiarioClose').addEventListener('click', () => $('#modalDiario').classList.remove('open'));
  $('#modalDiarioFechar').addEventListener('click', () => $('#modalDiario').classList.remove('open'));
  $('#modalDiario').addEventListener('click', e => { if (e.target.id === 'modalDiario') $('#modalDiario').classList.remove('open'); });
  $('#modalEstoqueClose').addEventListener('click', () => $('#modalEstoque').classList.remove('open'));
  $('#modalEstoqueFechar').addEventListener('click', () => $('#modalEstoque').classList.remove('open'));
  $('#modalEstoque').addEventListener('click', e => { if (e.target.id === 'modalEstoque') $('#modalEstoque').classList.remove('open'); });
  $('#modalQuebraClose').addEventListener('click', () => $('#modalQuebra').classList.remove('open'));
  $('#modalQuebraFechar').addEventListener('click', () => $('#modalQuebra').classList.remove('open'));
  $('#modalQuebra').addEventListener('click', e => { if (e.target.id === 'modalQuebra') $('#modalQuebra').classList.remove('open'); });
  $('#modalQuebraFLVClose').addEventListener('click', () => $('#modalQuebraFLV').classList.remove('open'));
  $('#modalQuebraFLVFechar').addEventListener('click', () => $('#modalQuebraFLV').classList.remove('open'));
  $('#modalQuebraFLV').addEventListener('click', e => { if (e.target.id === 'modalQuebraFLV') $('#modalQuebraFLV').classList.remove('open'); });
  $('#modalCancelClose').addEventListener('click', () => $('#modalCancel').classList.remove('open'));
  $('#modalCancelFechar').addEventListener('click', () => $('#modalCancel').classList.remove('open'));
  $('#modalCancel').addEventListener('click', e => { if (e.target.id === 'modalCancel') $('#modalCancel').classList.remove('open'); });
  $('#modalSemVendasClose').addEventListener('click', () => $('#modalSemVendas').classList.remove('open'));
  $('#modalSemVendasFechar').addEventListener('click', () => $('#modalSemVendas').classList.remove('open'));
  $('#modalSemVendas').addEventListener('click', e => { if (e.target.id === 'modalSemVendas') $('#modalSemVendas').classList.remove('open'); });
  $('#modalInvRotClose').addEventListener('click', () => $('#modalInvRot').classList.remove('open'));
  $('#modalInvRotFechar').addEventListener('click', () => $('#modalInvRot').classList.remove('open'));
  $('#modalInvRot').addEventListener('click', e => { if (e.target.id === 'modalInvRot') $('#modalInvRot').classList.remove('open'); });
  // Modal TOTAL (todos itens)
  $('#modalInvRotTotalClose').addEventListener('click', () => $('#modalInvRotTotal').classList.remove('open'));
  $('#modalInvRotTotalFechar').addEventListener('click', () => $('#modalInvRotTotal').classList.remove('open'));
  $('#modalInvRotTotal').addEventListener('click', e => { if (e.target.id === 'modalInvRotTotal') $('#modalInvRotTotal').classList.remove('open'); });
  // Sort por clique nas colunas do modal TOTAL
  $('#tblInvRotTotal thead').addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const field = th.dataset.sortTotal;
    if (invRotTotalSortField === field) {
      invRotTotalSortDir = invRotTotalSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      invRotTotalSortField = field;
      invRotTotalSortDir = INV_ROT_TOTAL_SORT_TEXT.has(field) ? 'asc' : 'desc';
    }
    renderModalInvRotTotalLista();
  });
  // Expand row no modal TOTAL → mostra breakdown por loja
  $('#tbodyInvRotTotal').addEventListener('click', e => {
    const row = e.target.closest('tr.invrot-total-row');
    if (!row) return;
    const produto = row.dataset.produto;
    if (INV_ROT_TOTAL_EXPANDED.has(produto)) INV_ROT_TOTAL_EXPANDED.delete(produto);
    else INV_ROT_TOTAL_EXPANDED.add(produto);
    renderModalInvRotTotalLista();
  });
  // Filtro por comprador (tabs) no modal TOTAL
  $('#modalInvRotTotalTabs').addEventListener('click', e => {
    const tab = e.target.closest('.qb-tab');
    if (!tab) return;
    $$('#modalInvRotTotalTabs .qb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    invRotTotalFiltroComprador = tab.dataset.compInvrotTotal || null;
    INV_ROT_TOTAL_EXPANDED.clear();
    renderModalInvRotTotalLista();
  });
  // Sort por clique nas colunas do modal Inv. Rotativo
  $('#tblInvRotComp thead').addEventListener('click', e => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const field = th.dataset.sort;
    if (invRotSortField === field) {
      invRotSortDir = invRotSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      invRotSortField = field;
      // Texto começa asc (A-Z), número começa desc (maior primeiro)
      invRotSortDir = INV_ROT_SORT_TEXT.has(field) ? 'asc' : 'desc';
    }
    renderModalInvRotLista();
  });

  // Carrega Inv. Rotativo (independente do Operação principal)
  carregarInvRotativo();

  const s = await api('GET', '/api/operacao/status');
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
