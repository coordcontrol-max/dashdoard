// ========== Estado ==========
let DADOS_ORIG = [];
let DADOS = [];
let DESC_MAP = {};
let CENARIOS = [];
let cenarioAtualId = null;
let cenarioAtualNome = 'Padrão';
let me = null;

const COLS_EDIT_ITEM = [
  'margem_vivendas', 'margem_scanntech', 'margem_concorrente',
  'margem_praticada_total', 'margem_praticada_sem_promo',
  'proposta_nova_margem', 'media_venda'
];

let salvarTimer = null;
function agendarSalvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(salvarCenarioAtual, 800);
}

// ========== Utilidades ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtMoney = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtSignedMoney = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtSignedPct = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + '%';

function parseInputNumeric(str, comoPercentual) {
  if (str == null) return null;
  let s = String(str).trim();
  if (s === '') return null;
  s = s.replace('%', '').replace(/R\$/i, '').replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return comoPercentual ? n / 100 : n;
}

function classDelta(v) {
  if (v == null || isNaN(v) || v === 0) return 'zero';
  return v > 0 ? 'pos' : 'neg';
}

// ========== API ==========
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

// ========== Cenários ==========
function aplicarOverrides(overrides) {
  DADOS = JSON.parse(JSON.stringify(DADOS_ORIG));
  if (!overrides) return;
  const byId = {};
  for (const r of DADOS) byId[r.id] = r;
  for (const id of Object.keys(overrides)) {
    const r = byId[parseInt(id, 10)];
    if (!r) continue;
    const ov = overrides[id];
    for (const k of Object.keys(ov)) r[k] = ov[k];
  }
}

function calcularOverrides() {
  const overrides = {};
  const byId = {};
  for (const r of DADOS_ORIG) byId[r.id] = r;
  for (const a of DADOS) {
    const b = byId[a.id]; if (!b) continue;
    const diff = {}; let changed = false;
    for (const k of COLS_EDIT_ITEM) {
      if (a[k] !== b[k]) { diff[k] = a[k]; changed = true; }
    }
    if (changed) overrides[a.id] = diff;
  }
  return overrides;
}

async function salvarCenarioAtual() {
  if (!cenarioAtualId) return;
  try {
    await api('PUT', `/api/scenarios/${cenarioAtualId}`, { overrides: calcularOverrides() });
    flash('Cenário salvo');
    await carregarCenarios();
  } catch (err) {
    flash('Falha ao salvar: ' + err.message, true);
  }
}

async function carregarCenarios() {
  CENARIOS = await api('GET', '/api/scenarios');
  popularCenarios();
}

async function trocarCenario(id) {
  const cen = CENARIOS.find(c => c.id === id);
  if (!cen) return;
  cenarioAtualId = id;
  cenarioAtualNome = cen.name;
  const full = await api('GET', `/api/scenarios/${id}`);
  aplicarOverrides(full.overrides);
  buildDescendants();
  renderTabela();
  popularCenarios();
}

async function novoCenario() {
  const nome = prompt('Nome do novo cenário:', 'Cenário ' + (CENARIOS.length + 1));
  if (!nome) return;
  try {
    const novo = await api('POST', '/api/scenarios', { name: nome, overrides: calcularOverrides() });
    await carregarCenarios();
    cenarioAtualId = novo.id; cenarioAtualNome = novo.name;
    popularCenarios();
    flash('Cenário criado');
  } catch (err) { alert(err.message); }
}

async function excluirCenario() {
  if (cenarioAtualNome === 'Padrão') { alert('O cenário Padrão não pode ser excluído.'); return; }
  if (!confirm(`Excluir o cenário "${cenarioAtualNome}"? Isso afeta todos os usuários.`)) return;
  try {
    await api('DELETE', `/api/scenarios/${cenarioAtualId}`);
    await carregarCenarios();
    const padrao = CENARIOS.find(c => c.name === 'Padrão');
    await trocarCenario(padrao.id);
  } catch (err) { alert(err.message); }
}

async function resetarCenario() {
  if (!confirm('Recarregar valores originais? Isso zera as edições deste cenário (visível pra todos).')) return;
  DADOS = JSON.parse(JSON.stringify(DADOS_ORIG));
  await api('PUT', `/api/scenarios/${cenarioAtualId}`, { overrides: {} });
  buildDescendants();
  renderTabela();
}

// ========== Hierarquia ==========
function buildDescendants() {
  DESC_MAP = {};
  const stack = {};
  for (const r of DADOS) {
    if (r.nivel === 4) {
      for (const lvl of [1, 2, 3]) {
        const ancId = stack[lvl];
        if (ancId !== undefined) {
          if (!DESC_MAP[ancId]) DESC_MAP[ancId] = [];
          DESC_MAP[ancId].push(r.id);
        }
      }
    } else {
      stack[r.nivel] = r.id;
      for (let l = r.nivel + 1; l <= 3; l++) delete stack[l];
    }
  }
}

// ========== Cálculos ==========
function lucratividadeItem(row, margemKey) {
  const m = row[margemKey], v = row.media_venda;
  if (typeof m !== 'number' || typeof v !== 'number') return null;
  return m * v;
}

function calcSubtotal(idAgrupador, dataById) {
  const ids = DESC_MAP[idAgrupador] || [];
  let totalMed = 0;
  let lViv = 0, lScann = 0, lConc = 0, lPrat = 0, lSPromo = 0, lProp = 0;
  let temViv = false, temScann = false, temConc = false, temPrat = false, temSPromo = false, temProp = false;
  for (const id of ids) {
    const r = dataById[id]; if (!r) continue;
    const v = (typeof r.media_venda === 'number') ? r.media_venda : 0;
    totalMed += v;
    if (typeof r.margem_vivendas === 'number')           { lViv    += r.margem_vivendas * v; temViv = true; }
    if (typeof r.margem_scanntech === 'number')          { lScann  += r.margem_scanntech * v; temScann = true; }
    if (typeof r.margem_concorrente === 'number')        { lConc   += r.margem_concorrente * v; temConc = true; }
    if (typeof r.margem_praticada_total === 'number')    { lPrat   += r.margem_praticada_total * v; temPrat = true; }
    if (typeof r.margem_praticada_sem_promo === 'number'){ lSPromo += r.margem_praticada_sem_promo * v; temSPromo = true; }
    if (typeof r.proposta_nova_margem === 'number')      { lProp   += r.proposta_nova_margem * v; temProp = true; }
  }
  return {
    media_venda: totalMed,
    margem_vivendas:           (temViv && totalMed)    ? lViv / totalMed    : null,
    margem_scanntech:          (temScann && totalMed)  ? lScann / totalMed  : null,
    margem_concorrente:        (temConc && totalMed)   ? lConc / totalMed   : null,
    margem_praticada_total:    (temPrat && totalMed)   ? lPrat / totalMed   : null,
    margem_praticada_sem_promo:(temSPromo && totalMed) ? lSPromo / totalMed : null,
    proposta_nova_margem:      (temProp && totalMed)   ? lProp / totalMed   : null,
    lucr_vivendas:    temViv    ? lViv    : null,
    lucr_scanntech:   temScann  ? lScann  : null,
    lucr_concorrente: temConc   ? lConc   : null,
    lucr_proposta:    temProp   ? lProp   : null,
  };
}

function valoresLinha(row, dataById) {
  if (row.nivel === 4) {
    return {
      media_venda: row.media_venda,
      margem_vivendas: row.margem_vivendas,
      margem_scanntech: row.margem_scanntech,
      margem_concorrente: row.margem_concorrente,
      margem_praticada_total: row.margem_praticada_total,
      margem_praticada_sem_promo: row.margem_praticada_sem_promo,
      proposta_nova_margem: row.proposta_nova_margem,
      lucr_vivendas:    lucratividadeItem(row, 'margem_vivendas'),
      lucr_scanntech:   lucratividadeItem(row, 'margem_scanntech'),
      lucr_concorrente: lucratividadeItem(row, 'margem_concorrente'),
      lucr_proposta:    lucratividadeItem(row, 'proposta_nova_margem'),
    };
  } else {
    return calcSubtotal(row.id, dataById);
  }
}

// ========== Render ==========
function popularSecoes() {
  const set = new Set();
  for (const r of DADOS) if (r.secao) set.add(r.secao);
  const sel = $('#filtroSecao');
  sel.innerHTML = '<option value="">Todas as seções</option>';
  Array.from(set).sort().forEach(s => {
    const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o);
  });
}

function popularCenarios() {
  const sel = $('#cenario');
  sel.innerHTML = '';
  for (const c of CENARIOS) {
    const o = document.createElement('option');
    o.value = c.id;
    const quando = c.updated_at ? ` · ${c.updated_at.slice(5,16).replace('T',' ')}${c.updated_by ? ' · ' + c.updated_by : ''}` : '';
    o.textContent = c.name + quando;
    if (c.id === cenarioAtualId) o.selected = true;
    sel.appendChild(o);
  }
}

function renderKPIs() {
  let totalMed = 0, lViv = 0, lScann = 0, lConc = 0, lProp = 0;
  for (const r of DADOS) {
    if (r.nivel !== 4) continue;
    const v = (typeof r.media_venda === 'number') ? r.media_venda : 0;
    totalMed += v;
    if (typeof r.margem_vivendas === 'number')      lViv   += r.margem_vivendas * v;
    if (typeof r.margem_scanntech === 'number')     lScann += r.margem_scanntech * v;
    if (typeof r.margem_concorrente === 'number')   lConc  += r.margem_concorrente * v;
    if (typeof r.proposta_nova_margem === 'number') lProp  += r.proposta_nova_margem * v;
  }
  const delta = lProp - lViv;
  const dPct = lViv ? (delta / lViv) : 0;

  $('#kpiMed').textContent = fmtMoney(totalMed);
  $('#kpiLucroAtual').textContent = fmtMoney(lViv);
  $('#kpiLucroProposta').textContent = fmtMoney(lProp);
  $('#kpiLucroScann').textContent = fmtMoney(lScann);
  $('#kpiLucroConc').textContent = fmtMoney(lConc);
  const dEl = $('#kpiDelta');
  dEl.textContent = fmtSignedMoney(delta);
  dEl.className = 'kpi-value ' + classDelta(delta);
  $('#kpiDeltaPct').textContent = lViv ? fmtSignedPct(dPct) : '—';
}

function renderTabela() {
  const tbody = $('#tbody');
  const search = $('#search').value.toLowerCase().trim();
  const secaoF = $('#filtroSecao').value;
  const nivelF = $('#filtroNivel').value;
  const onlyChanged = $('#onlyChanged').checked;
  const overrides = calcularOverrides();

  const dataById = {};
  for (const r of DADOS) dataById[r.id] = r;

  const ehItemFiltrado = (r) => {
    if (r.nivel !== 4) return false;
    if (secaoF && r.secao !== secaoF) return false;
    if (search) {
      const s = ((r.secao || '') + ' ' + (r.categoria || '')).toLowerCase();
      if (!s.includes(search)) return false;
    }
    if (onlyChanged && !overrides[r.id]) return false;
    if (nivelF && nivelF === '4') return true;
    if (nivelF && nivelF !== '4') return false;
    return true;
  };

  const visivel = new Set();
  const ancestrais = {};
  {
    const stack = {};
    for (const r of DADOS) {
      if (r.nivel === 4) {
        ancestrais[r.id] = { ...stack };
      } else {
        stack[r.nivel] = r.id;
        for (let l = r.nivel + 1; l <= 3; l++) delete stack[l];
      }
    }
  }
  for (const r of DADOS) {
    if (r.nivel === 4 && ehItemFiltrado(r)) {
      visivel.add(r.id);
      const a = ancestrais[r.id] || {};
      for (const lvl of [1, 2, 3]) if (a[lvl]) visivel.add(a[lvl]);
    }
  }
  if (nivelF) {
    const maxLvl = parseInt(nivelF, 10);
    for (const r of DADOS) {
      if (r.nivel < 4 && r.nivel > maxLvl) visivel.delete(r.id);
    }
  }

  const filtrados = DADOS.filter(r => visivel.has(r.id));

  const frag = document.createDocumentFragment();
  for (const r of filtrados) {
    const v = valoresLinha(r, dataById);
    const isItem = r.nivel === 4;
    const isChanged = isItem && !!overrides[r.id];

    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    tr.classList.add('lvl-' + r.nivel);
    if (isChanged) tr.classList.add('changed');

    tr.appendChild(td('col-secao', r.secao || ''));
    tr.appendChild(td('col-cat indent-' + r.nivel, r.categoria || ''));

    if (isItem) {
      tr.appendChild(inputCell(r, 'margem_vivendas', true, overrides));
      tr.appendChild(inputCell(r, 'margem_scanntech', true, overrides));
      tr.appendChild(inputCell(r, 'margem_concorrente', true, overrides));
      tr.appendChild(inputCell(r, 'margem_praticada_total', true, overrides));
      tr.appendChild(inputCell(r, 'margem_praticada_sem_promo', true, overrides));
      tr.appendChild(inputCell(r, 'proposta_nova_margem', true, overrides, 'prop'));
    } else {
      tr.appendChild(calcTd(fmtPct(v.margem_vivendas), 'zero'));
      tr.appendChild(calcTd(fmtPct(v.margem_scanntech), 'zero'));
      tr.appendChild(calcTd(fmtPct(v.margem_concorrente), 'zero'));
      tr.appendChild(calcTd(fmtPct(v.margem_praticada_total), 'zero'));
      tr.appendChild(calcTd(fmtPct(v.margem_praticada_sem_promo), 'zero'));
      tr.appendChild(calcTd(fmtPct(v.proposta_nova_margem), 'zero'));
    }

    const dM = (typeof v.proposta_nova_margem === 'number' && typeof v.margem_vivendas === 'number' && v.proposta_nova_margem !== 0)
      ? (v.proposta_nova_margem - v.margem_vivendas) / v.proposta_nova_margem : null;
    tr.appendChild(calcTd(dM == null ? '—' : fmtSignedPct(dM), classDelta(dM)));

    if (isItem) {
      tr.appendChild(inputCell(r, 'media_venda', false, overrides, 'money'));
    } else {
      tr.appendChild(calcTd(fmtMoney(v.media_venda), 'zero'));
    }

    tr.appendChild(calcTd(fmtMoney(v.lucr_scanntech), 'lucr'));
    tr.appendChild(calcTd(fmtMoney(v.lucr_concorrente), 'lucr'));
    tr.appendChild(calcTd(fmtMoney(v.lucr_vivendas), 'lucr'));
    tr.appendChild(calcTd(fmtMoney(v.lucr_proposta), 'lucr prop'));

    frag.appendChild(tr);
  }
  tbody.innerHTML = '';
  tbody.appendChild(frag);

  $('#rowCount').textContent = filtrados.length;
  renderKPIs();
}

function td(cls, text) {
  const el = document.createElement('td'); el.className = cls; el.textContent = text; return el;
}
function calcTd(text, extra) {
  const el = document.createElement('td');
  el.className = 'num calc' + (extra ? ' ' + extra : '');
  el.textContent = text;
  return el;
}
function inputCell(row, key, isPct, overrides, extraCls) {
  const el = document.createElement('td');
  el.className = 'num';
  const inp = document.createElement('input');
  inp.className = 'cell' + (extraCls ? ' ' + extraCls : '');
  inp.type = 'text';
  inp.spellcheck = false;
  inp.dataset.key = key;
  inp.dataset.id = row.id;
  inp.dataset.pct = isPct ? '1' : '0';
  inp.value = formatForEdit(row[key], isPct);
  if (overrides[row.id] && overrides[row.id][key] !== undefined) inp.classList.add('changed');
  el.appendChild(inp);
  return el;
}
function formatForEdit(v, isPct) {
  if (v == null || isNaN(v)) return '';
  if (isPct) return (v * 100).toFixed(2).replace('.', ',');
  return v.toFixed(2).replace('.', ',');
}

// ========== Eventos ==========
function onCellEdit(e) {
  const inp = e.target;
  if (!inp.classList || !inp.classList.contains('cell')) return;
  const id = parseInt(inp.dataset.id, 10);
  const key = inp.dataset.key;
  const isPct = inp.dataset.pct === '1';
  const newVal = parseInputNumeric(inp.value, isPct);
  const row = DADOS.find(r => r.id === id);
  if (!row) return;
  row[key] = newVal;
  renderTabela();
  agendarSalvar();
}

function exportarCSV() {
  const cabec = ['Nivel', 'Seção', 'Categoria', 'Vivendas %', 'Scanntech %', 'Concorrente %', 'Praticada %', 's/Promo %', 'Proposta %', 'Δ Margem %', 'Méd Venda R$', 'Lucr Scanntech R$', 'Lucr Concor R$', 'Lucr Vivendas R$', 'Lucr Proposta R$'];
  const linhas = [cabec.join(';')];
  const fmtN = (v) => v == null || isNaN(v) ? '' : v.toFixed(2).replace('.', ',');
  const dataById = {}; for (const r of DADOS) dataById[r.id] = r;
  for (const r of DADOS) {
    const v = valoresLinha(r, dataById);
    const dM = (typeof v.proposta_nova_margem === 'number' && typeof v.margem_vivendas === 'number' && v.proposta_nova_margem !== 0)
      ? (v.proposta_nova_margem - v.margem_vivendas) / v.proposta_nova_margem : null;
    linhas.push([
      r.nivel, r.secao || '', r.categoria || '',
      fmtN(v.margem_vivendas != null ? v.margem_vivendas * 100 : null),
      fmtN(v.margem_scanntech != null ? v.margem_scanntech * 100 : null),
      fmtN(v.margem_concorrente != null ? v.margem_concorrente * 100 : null),
      fmtN(v.margem_praticada_total != null ? v.margem_praticada_total * 100 : null),
      fmtN(v.margem_praticada_sem_promo != null ? v.margem_praticada_sem_promo * 100 : null),
      fmtN(v.proposta_nova_margem != null ? v.proposta_nova_margem * 100 : null),
      fmtN(dM != null ? dM * 100 : null),
      fmtN(v.media_venda),
      fmtN(v.lucr_scanntech),
      fmtN(v.lucr_concorrente),
      fmtN(v.lucr_vivendas),
      fmtN(v.lucr_proposta),
    ].map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';'));
  }
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'margem_' + cenarioAtualNome.replace(/\W+/g, '_') + '_' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function flash(msg, isErr) {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div'); el.id = 'flash';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1f2533;border:1px solid #2c4868;padding:10px 14px;border-radius:6px;z-index:99;box-shadow:0 4px 12px rgba(0,0,0,.4);transition:opacity .4s;';
    document.body.appendChild(el);
  }
  el.style.color = isErr ? '#ffb3bf' : '#b8e6b8';
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

// ========== Bootstrap ==========
async function init() {
  me = await api('GET', '/api/me');
  $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
  if (me.is_admin) $('#linkAdmin').style.display = '';

  DADOS_ORIG = await api('GET', '/api/data');
  DADOS = JSON.parse(JSON.stringify(DADOS_ORIG));

  await carregarCenarios();
  const padrao = CENARIOS.find(c => c.name === 'Padrão') || CENARIOS[0];
  if (padrao) {
    cenarioAtualId = padrao.id;
    cenarioAtualNome = padrao.name;
    const full = await api('GET', `/api/scenarios/${padrao.id}`);
    aplicarOverrides(full.overrides);
  }

  buildDescendants();
  popularSecoes();
  popularCenarios();
  renderTabela();

  $('#search').addEventListener('input', renderTabela);
  $('#filtroSecao').addEventListener('change', renderTabela);
  $('#filtroNivel').addEventListener('change', renderTabela);
  $('#onlyChanged').addEventListener('change', renderTabela);
  $('#tbody').addEventListener('change', onCellEdit);
  $('#tbody').addEventListener('blur', onCellEdit, true);
  $('#cenario').addEventListener('change', e => trocarCenario(parseInt(e.target.value, 10)));
  $('#btnNovoCenario').addEventListener('click', novoCenario);
  $('#btnSalvarCenario').addEventListener('click', salvarCenarioAtual);
  $('#btnExcluirCenario').addEventListener('click', excluirCenario);
  $('#btnExport').addEventListener('click', exportarCSV);
  $('#btnReset').addEventListener('click', resetarCenario);
  $('#btnLogout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.href = '/login.html';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('cell')) {
      e.preventDefault();
      const inputs = $$('#tbody input.cell');
      const i = inputs.indexOf(e.target);
      if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
    }
  });

  // Polling leve a cada 30s p/ refletir edições de outros usuários (apenas em cenário diferente do atual)
  setInterval(async () => {
    try {
      const antes = CENARIOS.find(c => c.id === cenarioAtualId);
      await carregarCenarios();
      const depois = CENARIOS.find(c => c.id === cenarioAtualId);
      if (depois && antes && depois.updated_at !== antes.updated_at && depois.updated_by !== me.username) {
        // Outro usuário editou este cenário — recarrega
        const full = await api('GET', `/api/scenarios/${cenarioAtualId}`);
        aplicarOverrides(full.overrides);
        buildDescendants();
        renderTabela();
        flash(`Cenário atualizado por ${depois.updated_by}`);
      }
    } catch {}
  }, 30000);
}

init().catch(e => {
  if (e.message !== 'não autenticado') {
    console.error(e);
    alert('Falha ao carregar: ' + e.message);
  }
});
