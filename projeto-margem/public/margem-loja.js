// ========== Estado ==========
let DADOS = null;
let me = null;
let pollTimer = null;
let filtroComprador = '';
let filtroGerente = '';
let ultimosN = 30; // todos por padrão (será limitado pelo total de dias)

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtRs = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v/1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v/1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtPp  = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + ' pp';
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
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

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

function classMg(v) {
  if (v == null) return '';
  if (v >= 0.20) return 'mg-ok';
  if (v >= 0.17) return 'mg-warn';
  return 'mg-bad';
}
function classRank(rank, total) {
  if (rank == null || total == null) return '';
  if (rank <= 5) return 'rank-bad';
  if (rank > total - 5) return 'rank-good';
  return '';
}

// ========== Status / atualização ==========
function pintaStatus(s) {
  const sec = $('#trStatus');
  const msg = $('#trStatusMsg');
  const btn = $('#btnAtualizar');

  const box = $('#trPeriodoBox');
  if (DADOS && DADOS.periodo && box) {
    const ini = DADOS.periodo.inicio, fim = DADOS.periodo.fim;
    $('#trPeriodoTxt').textContent = `${fmtDataCurta(ini)} a ${fmtDataCurta(fim)}`;
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
    msg.innerHTML = `Última atualização: <b>${ult}</b> <span style="color:var(--text-muted);">· Atualização automática diária às 06:30</span>`;
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

let lastUpdatedAt = null;
async function pollOnce() {
  const s = await api('GET', '/api/margem-loja/status');
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
    await api('POST', '/api/margem-loja/atualizar');
    iniciarPolling();
  } catch (e) {
    alert('Falha: ' + e.message);
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

async function carregarDados() {
  try {
    const d = await api('GET', '/api/margem-loja');
    if (d && !d.vazio) {
      DADOS = d;
      popularFiltros();
      renderTudo();
    }
  } catch (e) { console.error(e); }
}

// ========== Agregações ==========
function linhasFiltradas() {
  let arr = DADOS?.linhas || [];
  if (filtroComprador) arr = arr.filter(l => l.comprador === filtroComprador);
  if (filtroGerente)   arr = arr.filter(l => l.gerente === filtroGerente);
  return arr;
}

// Agrega uma lista de linhas em um único objeto
function agregar(linhas) {
  let venda = 0, lucr = 0, verba = 0, doctos = 0;
  for (const l of linhas) {
    venda += l.venda || 0;
    lucr  += l.lucratividade || 0;
    verba += l.verba || 0;
    doctos += l.doctos || 0;
  }
  // Cenário A: lucratividade já INCLUI verba
  // Mg Total = lucr / venda  ·  Mg PDV = (lucr - verba) / venda
  const mg_total = venda > 0 ? lucr / venda : null;
  const mg_pdv   = venda > 0 ? (lucr - verba) / venda : null;
  return { venda, lucratividade: lucr, verba, doctos, mg_total, mg_pdv };
}

// Agrupa linhas por chave (produzida por chaveFn) → objeto agregado
function agruparPor(linhas, chaveFn) {
  const grupos = {};
  for (const l of linhas) {
    const k = chaveFn(l);
    if (k == null) continue;
    if (!grupos[k]) grupos[k] = [];
    grupos[k].push(l);
  }
  const out = {};
  for (const [k, ls] of Object.entries(grupos)) out[k] = agregar(ls);
  return out;
}

function listaDatas() {
  const set = new Set();
  for (const l of DADOS?.linhas || []) if (l.data) set.add(l.data);
  return Array.from(set).sort();
}

// ========== Render ==========
function popularFiltros() {
  const compradores = new Set();
  for (const l of DADOS?.linhas || []) if (l.comprador) compradores.add(l.comprador);
  const sel = $('#filtroComprador');
  sel.innerHTML = '<option value="">Todos os compradores</option>' +
    Array.from(compradores).sort().map(c => `<option>${escapeHtml(c)}</option>`).join('');
}

function renderKPIs() {
  const arr = linhasFiltradas();
  const a = agregar(arr);
  $('#kpiVenda').textContent   = fmtRsK(a.venda);
  $('#kpiMgTotal').textContent = fmtPct(a.mg_total);
  $('#kpiMgPdv').textContent   = fmtPct(a.mg_pdv);
  $('#kpiVerba').textContent   = fmtRsK(a.verba);
  $('#kpiDoctos').textContent  = fmtNum(a.doctos);
}

function renderAcumulado() {
  const arr = linhasFiltradas();
  const porLoja = agruparPor(arr, l => l.loja);
  const lojas = Object.keys(porLoja)
    .map(loja => ({ loja: parseInt(loja, 10), nome: nomeLoja(loja), ...porLoja[loja] }))
    .filter(o => o.venda > 0)
    .sort((a, b) => a.loja - b.loja);

  // Calcula ranks (1 = pior)
  const arrMgT = lojas.filter(l => l.mg_total != null).slice().sort((a, b) => (a.mg_total || 0) - (b.mg_total || 0));
  arrMgT.forEach((l, i) => l._rank_mg_total = i + 1);
  const arrMgP = lojas.filter(l => l.mg_pdv != null).slice().sort((a, b) => (a.mg_pdv || 0) - (b.mg_pdv || 0));
  arrMgP.forEach((l, i) => l._rank_mg_pdv = i + 1);

  const total = lojas.length;
  const tot = agregar(arr);

  const tbody = $('#tbodyAcum');
  tbody.innerHTML = lojas.map(l => `
    <tr>
      <td><span class="loja-link" data-loja="${l.loja}">${l.loja} — ${escapeHtml(l.nome)}</span></td>
      <td class="num">${fmtRs(l.venda)}</td>
      <td class="num ${classMg(l.mg_total)}">${fmtPct(l.mg_total)}</td>
      <td class="num"><span class="${classRank(l._rank_mg_total, total)}">${l._rank_mg_total ?? '—'}</span></td>
      <td class="num ${classMg(l.mg_pdv)}">${fmtPct(l.mg_pdv)}</td>
      <td class="num"><span class="${classRank(l._rank_mg_pdv, total)}">${l._rank_mg_pdv ?? '—'}</span></td>
      <td class="num">${fmtRs(l.verba)}</td>
      <td class="num">${fmtNum(l.doctos)}</td>
    </tr>
  `).join('') + `
    <tr class="total">
      <td>TOTAL</td>
      <td class="num">${fmtRs(tot.venda)}</td>
      <td class="num"><b>${fmtPct(tot.mg_total)}</b></td>
      <td class="num">—</td>
      <td class="num"><b>${fmtPct(tot.mg_pdv)}</b></td>
      <td class="num">—</td>
      <td class="num">${fmtRs(tot.verba)}</td>
      <td class="num">${fmtNum(tot.doctos)}</td>
    </tr>
  `;
}

function nomeLoja(loja) {
  // Pega do primeiro item das linhas que tem essa loja
  const l = DADOS?.linhas?.find(x => String(x.loja) === String(loja));
  return l?.loja_nome || '';
}

function renderMatrix() {
  const arr = linhasFiltradas();
  const datas = listaDatas();
  const lojas = Array.from(new Set(arr.map(l => l.loja))).filter(x => x != null).sort((a, b) => a - b);

  // {loja: {data: agregado}}
  const matrix = {};
  for (const loja of lojas) matrix[loja] = {};
  for (const dt of datas) {
    const dia = arr.filter(l => l.data === dt);
    const porLoja = agruparPor(dia, l => l.loja);
    for (const [loja, agg] of Object.entries(porLoja)) {
      if (!matrix[loja]) matrix[loja] = {};
      matrix[loja][dt] = agg;
    }
  }

  // Header
  let thead = `<thead>
    <tr>
      <th rowspan="2" class="col-loja">Loja</th>`;
  for (const dt of datas) {
    thead += `<th colspan="3" class="col-date-header col-date-group">${fmtDataCurta(dt)}</th>`;
  }
  thead += `</tr><tr>`;
  for (const dt of datas) {
    thead += `<th class="num col-date-group">Venda</th><th class="num">Mg Tot %</th><th class="num">Mg PDV %</th>`;
  }
  thead += `</tr></thead>`;

  // Body
  let body = '<tbody>';
  for (const loja of lojas) {
    body += `<tr><td class="col-loja"><span class="loja-link" data-loja="${loja}">${loja} — ${escapeHtml(nomeLoja(loja))}</span></td>`;
    for (const dt of datas) {
      const a = matrix[loja]?.[dt];
      if (!a) {
        body += `<td class="num col-date-group">—</td><td class="num">—</td><td class="num">—</td>`;
      } else {
        body += `<td class="num col-date-group">${fmtRsK(a.venda)}</td>` +
                `<td class="num ${classMg(a.mg_total)}">${fmtPct(a.mg_total)}</td>` +
                `<td class="num ${classMg(a.mg_pdv)}">${fmtPct(a.mg_pdv)}</td>`;
      }
    }
    body += '</tr>';
  }

  // Total por dia
  body += `<tr class="total"><td class="col-loja">TOTAL</td>`;
  for (const dt of datas) {
    const dia = arr.filter(l => l.data === dt);
    const a = agregar(dia);
    body += `<td class="num col-date-group">${fmtRsK(a.venda)}</td>` +
            `<td class="num"><b>${fmtPct(a.mg_total)}</b></td>` +
            `<td class="num"><b>${fmtPct(a.mg_pdv)}</b></td>`;
  }
  body += '</tr></tbody>';

  $('#tblMatrix').innerHTML = thead + body;
}

function renderComparativo() {
  const arr = linhasFiltradas();
  const datas = listaDatas();
  const N = Math.min(parseInt(ultimosN, 10) || datas.length, datas.length);
  const ultimasDatas = datas.slice(-N);
  if (!ultimasDatas.length) {
    $('#theadComp').innerHTML = '';
    $('#tbodyComp').innerHTML = '<tr><td>Sem dados</td></tr>';
    return;
  }
  const lojas = Array.from(new Set(arr.map(l => l.loja))).filter(x => x != null).sort((a, b) => a - b);

  // Por loja: agregado de cada dia das últimas N + tendência
  const dadosPorLoja = lojas.map(loja => {
    const out = { loja, nome: nomeLoja(loja), porDia: {} };
    for (const dt of ultimasDatas) {
      const dia = arr.filter(l => l.loja === loja && l.data === dt);
      out.porDia[dt] = agregar(dia);
    }
    return out;
  });

  // Header dinâmico
  let thead = `<tr>
    <th>Loja</th>
    <th class="num">Mg Total<br>Médio</th>`;
  for (const dt of ultimasDatas) thead += `<th class="num">${fmtDataCurta(dt)}<br><small>Tot</small></th>`;
  thead += `<th class="num">Var<br>(último vs anterior)</th>`;
  thead += `<th class="num">Tendência</th>`;
  thead += `<th class="num">Mg PDV<br>Médio</th>`;
  for (const dt of ultimasDatas) thead += `<th class="num">${fmtDataCurta(dt)}<br><small>PDV</small></th>`;
  thead += `<th class="num">Var<br>(último vs anterior)</th>`;
  thead += `<th class="num">Tendência</th>`;
  thead += `</tr>`;

  // Body
  let body = '';
  for (const r of dadosPorLoja) {
    const valoresT = ultimasDatas.map(dt => r.porDia[dt]?.mg_total).filter(x => x != null);
    const valoresP = ultimasDatas.map(dt => r.porDia[dt]?.mg_pdv).filter(x => x != null);
    const mediaT = valoresT.length ? valoresT.reduce((s, x) => s + x, 0) / valoresT.length : null;
    const mediaP = valoresP.length ? valoresP.reduce((s, x) => s + x, 0) / valoresP.length : null;
    const ultT = valoresT.at(-1);
    const ultP = valoresP.at(-1);
    const antT = valoresT.at(-2);
    const antP = valoresP.at(-2);
    const varT = (ultT != null && antT != null) ? (ultT - antT) : null;
    const varP = (ultP != null && antP != null) ? (ultP - antP) : null;
    const tendT = (ultT != null && valoresT.length > 1)
      ? (ultT > (valoresT.slice(0, -1).reduce((s, x) => s + x, 0) / Math.max(1, valoresT.length - 1)) ? 'up' : 'down') : 'flat';
    const tendP = (ultP != null && valoresP.length > 1)
      ? (ultP > (valoresP.slice(0, -1).reduce((s, x) => s + x, 0) / Math.max(1, valoresP.length - 1)) ? 'up' : 'down') : 'flat';

    body += `<tr>
      <td><span class="loja-link" data-loja="${r.loja}">${r.loja} — ${escapeHtml(r.nome)}</span></td>
      <td class="num ${classMg(mediaT)}">${fmtPct(mediaT)}</td>`;
    for (const dt of ultimasDatas) {
      const v = r.porDia[dt]?.mg_total;
      body += `<td class="num ${classMg(v)}">${fmtPct(v)}</td>`;
    }
    body += `<td class="num ${varT == null ? '' : (varT >= 0 ? 'var-up' : 'var-down')}">${fmtPp(varT)}</td>`;
    body += `<td class="num tend-${tendT}">${tendT === 'up' ? '↑' : tendT === 'down' ? '↓' : '→'}</td>`;
    body += `<td class="num ${classMg(mediaP)}">${fmtPct(mediaP)}</td>`;
    for (const dt of ultimasDatas) {
      const v = r.porDia[dt]?.mg_pdv;
      body += `<td class="num ${classMg(v)}">${fmtPct(v)}</td>`;
    }
    body += `<td class="num ${varP == null ? '' : (varP >= 0 ? 'var-up' : 'var-down')}">${fmtPp(varP)}</td>`;
    body += `<td class="num tend-${tendP}">${tendP === 'up' ? '↑' : tendP === 'down' ? '↓' : '→'}</td>`;
    body += `</tr>`;
  }

  $('#theadComp').innerHTML = thead;
  $('#tbodyComp').innerHTML = body;
}

function renderTudo() {
  if (!DADOS) return;
  if (DADOS.periodo) {
    $('#periodoTxt').textContent = `${fmtDataCurta(DADOS.periodo.inicio)} a ${fmtDataCurta(DADOS.periodo.fim)}`;
  }
  renderKPIs();
  renderAcumulado();
  renderMatrix();
  renderComparativo();
}

// ========== Drill-down por loja ==========
function abrirDrillLoja(loja) {
  const arr = (DADOS?.linhas || []).filter(l => l.loja == loja);
  const porComp = agruparPor(arr, l => l.comprador);
  const linhas = Object.keys(porComp)
    .map(c => ({ comprador: c, ...porComp[c] }))
    .filter(o => o.venda > 0)
    .sort((a, b) => (b.venda || 0) - (a.venda || 0));
  const tot = agregar(arr);

  $('#drillTitle').textContent = `Loja ${loja} — ${nomeLoja(loja)}`;
  $('#drillInfo').innerHTML = `Período: <b>${fmtDataCurta(DADOS.periodo.inicio)}</b> a <b>${fmtDataCurta(DADOS.periodo.fim)}</b> · ` +
    `Venda: <b>${fmtRs(tot.venda)}</b> · Mg Total: <b>${fmtPct(tot.mg_total)}</b> · Mg PDV: <b>${fmtPct(tot.mg_pdv)}</b>`;
  $('#tbodyDrill').innerHTML = linhas.map(c => {
    const part = (tot.venda > 0) ? (c.venda / tot.venda) : null;
    return `
    <tr>
      <td>${escapeHtml(c.comprador)}</td>
      <td class="num">${fmtRs(c.venda)}</td>
      <td class="num">${fmtPct(part)}</td>
      <td class="num ${classMg(c.mg_total)}">${fmtPct(c.mg_total)}</td>
      <td class="num ${classMg(c.mg_pdv)}">${fmtPct(c.mg_pdv)}</td>
      <td class="num">${fmtRs(c.verba)}</td>
      <td class="num">${fmtNum(c.doctos)}</td>
    </tr>
  `;
  }).join('') + `
    <tr class="total">
      <td>TOTAL</td>
      <td class="num">${fmtRs(tot.venda)}</td>
      <td class="num"><b>100,00%</b></td>
      <td class="num"><b>${fmtPct(tot.mg_total)}</b></td>
      <td class="num"><b>${fmtPct(tot.mg_pdv)}</b></td>
      <td class="num">${fmtRs(tot.verba)}</td>
      <td class="num">${fmtNum(tot.doctos)}</td>
    </tr>
  `;
  $('#modalDrill').classList.add('open');
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

  $('#filtroComprador').addEventListener('change', e => { filtroComprador = e.target.value; renderTudo(); });
  $('#filtroGerente').addEventListener('change', e => { filtroGerente = e.target.value; renderTudo(); });
  $('#ultimosN').addEventListener('change', e => { ultimosN = e.target.value; renderComparativo(); });

  document.addEventListener('click', e => {
    const link = e.target.closest('.loja-link');
    if (link) abrirDrillLoja(link.dataset.loja);
  });
  $('#drillClose').addEventListener('click', () => $('#modalDrill').classList.remove('open'));
  $('#drillFechar').addEventListener('click', () => $('#modalDrill').classList.remove('open'));
  $('#modalDrill').addEventListener('click', e => { if (e.target.id === 'modalDrill') $('#modalDrill').classList.remove('open'); });

  const s = await api('GET', '/api/margem-loja/status');
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
