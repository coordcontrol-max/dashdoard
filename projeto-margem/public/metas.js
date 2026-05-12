// Página /metas — admin
let me = null;
let DADOS = null;       // resposta do GET /api/admin/metas
let MES = null;         // mês atualmente selecionado (YYYY-MM)
let PCT_BUFFER = null;  // { nome: { "01": {venda, margem}, ... } } pendente pra salvar

const CAMPOS_C = ['meta_venda', 'meta_margem', 'meta_dde', 'meta_ruptura', 'meta_quebra', 'meta_troca', 'meta_foto'];

const $ = (s) => document.querySelector(s);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  if (r.status === 403) throw new Error('acesso restrito a admins');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

const fmtNum = (v) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('pt-BR');
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const valOuVazio = (v) => (v == null || isNaN(v)) ? '' : String(v);

const MESES_PT = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
function rotuloMes(ymd) {
  if (!/^\d{4}-\d{2}$/.test(ymd)) return ymd;
  const [a, m] = ymd.split('-');
  return `${MESES_PT[parseInt(m, 10) - 1]} / ${a}`;
}

// ===== Seletor de meses =====
function listaMeses() {
  // 6 meses pra trás + atual + 12 pra frente, e mais qualquer um já salvo
  const set = new Set();
  const hoje = new Date();
  for (let off = -6; off <= 12; off++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + off, 1);
    set.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  for (const m of (DADOS?.meses_salvos || [])) set.add(m);
  return Array.from(set).sort();
}

function popularSelectMes() {
  const sel = $('#selMes');
  const meses = listaMeses();
  const salvos = new Set(DADOS?.meses_salvos || []);
  sel.innerHTML = meses.map(m => {
    const marca = salvos.has(m) ? ' ●' : '';
    return `<option value="${m}"${m === MES ? ' selected' : ''}>${rotuloMes(m)}${marca}</option>`;
  }).join('');

  // Select "copiar de" — só meses salvos
  const selCp = $('#selCopiarDe');
  selCp.innerHTML = `<option value="">— escolher —</option>` +
    Array.from(salvos).sort().map(m => `<option value="${m}">${rotuloMes(m)}</option>`).join('');

  // Badge
  const badge = $('#badgeMes');
  if (DADOS.metas) {
    badge.textContent = '✓ salvas';
    badge.classList.add('salvo');
  } else {
    badge.textContent = '○ sem metas salvas';
    badge.classList.remove('salvo');
  }
}

// ===== Form: pré-preenchimento =====
// Chave: pra cada campo, usa metas salvas → senão deixa vazio (usuário decide importar planilha)
// Mapeamento entre id do input e o caminho no objeto metas
const INPUTS_GLOBAIS = [
  ['#andreVenda',  'gerentes', 'Andre', 'meta_venda'],
  ['#andreMargem', 'gerentes', 'Andre', 'meta_margem'],
  ['#andreDde',    'gerentes', 'Andre', 'meta_dde'],
  ['#andreRup',    'gerentes', 'Andre', 'meta_ruptura'],
  ['#walasVenda',  'gerentes', 'Walas', 'meta_venda'],
  ['#walasMargem', 'gerentes', 'Walas', 'meta_margem'],
  ['#walasDde',    'gerentes', 'Walas', 'meta_dde'],
  ['#walasRup',    'gerentes', 'Walas', 'meta_ruptura'],
  ['#totalVenda',  'total',    null,    'meta_venda'],
  ['#totalMargem', 'total',    null,    'meta_margem'],
  ['#totalDde',    'total',    null,    'meta_dde'],
  ['#totalRup',    'total',    null,    'meta_ruptura'],
];

function getEmObjeto(obj, secao, k, campo) {
  if (!obj) return undefined;
  if (secao === 'total') return obj.total?.[campo];
  return obj.gerentes?.[k]?.[campo];
}

function preencherForm() {
  const m = DADOS.metas || {};
  for (const [sel, secao, k, campo] of INPUTS_GLOBAIS) {
    $(sel).value = valOuVazio(getEmObjeto(m, secao, k, campo));
  }
  // PCT_BUFFER reflete o estado salvo do mês (até o usuário subir um CSV novo)
  PCT_BUFFER = m.percentuais ? JSON.parse(JSON.stringify(m.percentuais)) : null;
  atualizarStatusPct();
  renderTabela();
}

function atualizarStatusPct() {
  const el = $('#pctStatus');
  if (!el) return;
  const pct = PCT_BUFFER || DADOS.metas?.percentuais || {};
  const compradoresComPct = Object.keys(pct);
  if (!compradoresComPct.length) {
    el.className = 'mt-pct-status warn';
    el.textContent = `○ Nenhum percentual customizado. Será usada a curva da planilha (escalada).`;
    return;
  }
  // Calcula soma média por comprador pra ver se está próxima de 100%
  let foraDoPadrao = 0;
  for (const dias of Object.values(pct)) {
    let sV = 0;
    for (const d of Object.values(dias)) sV += Number(d.venda) || 0;
    if (sV > 0 && (sV < 95 || sV > 105)) foraDoPadrao++;
  }
  if (foraDoPadrao > 0) {
    el.className = 'mt-pct-status warn';
    el.textContent = `⚠ ${compradoresComPct.length} compradores com %, mas ${foraDoPadrao} têm soma fora de 95-105%. Verifique.`;
  } else {
    el.className = 'mt-pct-status ok';
    el.textContent = `✓ ${compradoresComPct.length} compradores com percentuais customizados.`;
  }
}

function renderTabela() {
  const tbody = $('#tbodyMetas');
  const compradores = DADOS.compradores || [];
  const overrides = DADOS.metas?.compradores || {};

  const grupos = [
    { gerente: 'André',  label: '🥩 Perecível — André',  items: compradores.filter(c => c.gerente === 'André') },
    { gerente: 'Walas',  label: '🛒 Mercearia — Walas',  items: compradores.filter(c => c.gerente === 'Walas') },
    { gerente: null,     label: 'Outros',                items: compradores.filter(c => !c.gerente) },
  ];

  let html = '';
  for (const g of grupos) {
    if (!g.items.length) continue;
    html += `<tr class="gerente"><td colspan="9">${escapeHtml(g.label)} · ${g.items.length} compradores</td></tr>`;
    for (const c of g.items) {
      const ov = overrides[c.nome] || {};
      const inp = (campo, step = 'any') => {
        const v = ov[campo];
        const cls = v != null ? 'modificado' : '';
        return `<input type="number" step="${step}" class="${cls}"
                 data-nome="${escapeHtml(c.nome)}" data-campo="${campo}"
                 value="${valOuVazio(v)}">`;
      };
      const atual =
        `Vda: ${c.meta_venda  != null ? fmtNum(c.meta_venda)  : '—'} · ` +
        `Mar: ${c.meta_margem != null ? fmtNum(c.meta_margem) : '—'} · ` +
        `DDE: ${c.meta_dde ?? '—'} · ` +
        `Rup: ${c.meta_ruptura != null ? fmtPct(c.meta_ruptura) : '—'} · ` +
        `Que: ${c.meta_quebra != null ? fmtNum(c.meta_quebra) : '—'} · ` +
        `Tro: ${c.meta_troca != null ? fmtNum(c.meta_troca) : '—'} · ` +
        `Foto: ${c.meta_foto != null ? fmtNum(c.meta_foto) : '—'}`;
      html += `
        <tr>
          <td>${escapeHtml(c.nome)}</td>
          <td>${inp('meta_venda', '1')}</td>
          <td>${inp('meta_margem', '1')}</td>
          <td>${inp('meta_dde', '0.1')}</td>
          <td>${inp('meta_ruptura', '0.0001')}</td>
          <td>${inp('meta_quebra', '1')}</td>
          <td>${inp('meta_troca', '1')}</td>
          <td>${inp('meta_foto', '1')}</td>
          <td class="mt-atual">${atual}</td>
        </tr>
      `;
    }
  }
  tbody.innerHTML = html;
}

// ===== Importar planilha (pré-preenche campos vazios) =====
function importarPlanilha() {
  const p = DADOS.planilha || {};
  let preench = 0;
  for (const [sel, secao, k, campo] of INPUTS_GLOBAIS) {
    const v = getEmObjeto(p, secao, k, campo);
    const el = $(sel);
    if (!el || v == null || isNaN(v)) continue;
    if (el.value === '') { el.value = v; el.classList.add('modificado'); preench++; }
  }

  const compradores = DADOS.compradores || [];
  const inputs = $('#tbodyMetas').querySelectorAll('input[type="number"]');
  const porChave = {};
  inputs.forEach(i => { porChave[`${i.dataset.nome}|${i.dataset.campo}`] = i; });

  for (const c of compradores) {
    for (const campo of CAMPOS_C) {
      const inp = porChave[`${c.nome}|${campo}`];
      const v = c[campo];
      if (!inp || v == null || isNaN(v)) continue;
      if (inp.value === '') {
        inp.value = v;
        inp.classList.add('modificado');
        preench++;
      }
    }
  }
  const msg = $('#msgSalvar');
  msg.className = 'mt-msg ok';
  msg.textContent = `✓ ${preench} campos pré-preenchidos com a planilha. Revise e clique em "Salvar e aplicar".`;
}

// ===== Copiar de outro mês =====
async function copiarDe() {
  const origem = $('#selCopiarDe').value;
  if (!origem) { alert('Escolha um mês de origem'); return; }
  if (origem === MES) { alert('Mês de origem é o mesmo do destino'); return; }
  // Busca metas do mês origem
  const r = await api('GET', `/api/admin/metas?mes=${encodeURIComponent(origem)}`);
  const m = r.metas;
  if (!m) { alert(`Mês ${rotuloMes(origem)} não tem metas salvas.`); return; }
  if (!confirm(`Copiar metas de ${rotuloMes(origem)} pra ${rotuloMes(MES)}? (Substitui o que está no formulário)`)) return;

  // Globais
  for (const [sel, secao, k, campo] of INPUTS_GLOBAIS) {
    const v = getEmObjeto(m, secao, k, campo);
    const el = $(sel);
    el.value = valOuVazio(v);
    el.classList.toggle('modificado', el.value !== '');
  }

  // Compradores
  const inputs = $('#tbodyMetas').querySelectorAll('input[type="number"]');
  const porChave = {};
  inputs.forEach(i => {
    porChave[`${i.dataset.nome}|${i.dataset.campo}`] = i;
    i.value = ''; i.classList.remove('modificado');
  });
  for (const [nome, vals] of Object.entries(m.compradores || {})) {
    for (const [campo, v] of Object.entries(vals)) {
      const inp = porChave[`${nome}|${campo}`];
      if (inp) { inp.value = v; inp.classList.add('modificado'); }
    }
  }
  const msg = $('#msgSalvar');
  msg.className = 'mt-msg ok';
  msg.textContent = `✓ Copiado de ${rotuloMes(origem)}. Revise e clique em "Salvar e aplicar".`;
}

// ===== Coletar payload =====
function coletarPayload() {
  const tbody = $('#tbodyMetas');
  const compradores = {};
  tbody.querySelectorAll('input[type="number"]').forEach(inp => {
    const v = inp.value.trim();
    if (v === '') return;
    const nome = inp.dataset.nome;
    const campo = inp.dataset.campo;
    if (!compradores[nome]) compradores[nome] = {};
    compradores[nome][campo] = Number(v);
  });
  const payload = {
    mes: MES,
    gerentes: { Andre: {}, Walas: {} },
    total: {},
    compradores,
    percentuais: PCT_BUFFER || {},
  };
  for (const [sel, secao, k, campo] of INPUTS_GLOBAIS) {
    const v = $(sel).value || null;
    if (secao === 'total') payload.total[campo] = v;
    else payload.gerentes[k][campo] = v;
  }
  return payload;
}

// ===== Salvar / apagar / limpar =====
async function carregar(mes) {
  const url = mes ? `/api/admin/metas?mes=${encodeURIComponent(mes)}` : '/api/admin/metas';
  DADOS = await api('GET', url);
  MES = DADOS.mes;
  popularSelectMes();
  preencherForm();
}

async function salvar() {
  const btn = $('#btnSalvar');
  const msg = $('#msgSalvar');
  msg.className = 'mt-msg'; msg.textContent = '';
  btn.disabled = true; btn.textContent = '💾 Salvando…';
  try {
    const r = await api('POST', '/api/admin/metas', coletarPayload());
    msg.className = 'mt-msg ok';
    msg.textContent = r.aplicado_em_kpis
      ? `✓ Salvo em ${rotuloMes(MES)} e aplicado nos KPIs.`
      : `✓ Salvo em ${rotuloMes(MES)}. Será aplicado quando os KPIs deste mês forem atualizados.`;
    await carregar(MES);
  } catch (e) {
    msg.className = 'mt-msg erro';
    msg.textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '💾 Salvar e aplicar';
  }
}

async function apagarMes() {
  if (!DADOS.metas) { alert(`${rotuloMes(MES)} já não tem metas salvas.`); return; }
  if (!confirm(`Apagar todas as metas salvas em ${rotuloMes(MES)}? Volta a usar o que vier da planilha (ou do mês anterior salvo).`)) return;
  try {
    await api('POST', '/api/admin/metas', { mes: MES, apagar: true });
    const msg = $('#msgSalvar');
    msg.className = 'mt-msg ok';
    msg.textContent = `✓ Metas de ${rotuloMes(MES)} apagadas.`;
    await carregar(MES);
  } catch (e) {
    alert('Falha: ' + e.message);
  }
}

function limparTodas() {
  for (const [sel] of INPUTS_GLOBAIS) {
    $(sel).value = '';
    $(sel).classList.remove('modificado');
  }
  $('#tbodyMetas').querySelectorAll('input[type="number"]').forEach(i => {
    i.value = ''; i.classList.remove('modificado');
  });
  const msg = $('#msgSalvar');
  msg.className = 'mt-msg';
  msg.textContent = 'Formulário limpo. Clique em "Salvar e aplicar" pra apagar este mês.';
}

// ===== CSV =====
// Quantas casas decimais por campo
const PREC = {
  meta_venda: 2, meta_margem: 2, meta_quebra: 2, meta_troca: 2, meta_foto: 2,
  meta_dde: 1, meta_ruptura: 4,
};
function fmtCelula(campo, v) {
  if (v == null || v === '' || isNaN(v)) return '';
  const d = PREC[campo] ?? 4;
  return Number(v).toFixed(d).replace('.', ',');
}

function baixarTemplate() {
  const compradores = DADOS.compradores || [];
  const overrides = DADOS.metas?.compradores || {};
  const SEP = ';';
  const header = ['nome', ...CAMPOS_C];
  // sep=; faz o Excel reconhecer o separador automaticamente
  const linhas = [`sep=${SEP}`, header.join(SEP)];
  for (const c of compradores) {
    const ov = overrides[c.nome] || {};
    const cols = [c.nome, ...CAMPOS_C.map(k => fmtCelula(k, ov[k] ?? c[k]))];
    linhas.push(cols.map(v => {
      const s = String(v);
      // escapa só se tiver o separador, aspas ou quebra de linha
      return (s.includes(SEP) || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(SEP));
  }
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `metas_compradores_${MES}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function parseCsvLinha(linha, sep) {
  const out = []; let buf = ''; let dentro = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (dentro) {
      if (ch === '"' && linha[i+1] === '"') { buf += '"'; i++; }
      else if (ch === '"') dentro = false;
      else buf += ch;
    } else {
      if (ch === '"') dentro = true;
      else if (ch === sep) { out.push(buf); buf = ''; }
      else buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function parseNumeroBR(s) {
  s = String(s).trim();
  if (s === '') return NaN;
  // Se tem `,` e `.`: formato BR (1.234,56)
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  // Só vírgula → decimal BR
  else if (s.includes(',')) s = s.replace(',', '.');
  return Number(s);
}

function detectarSeparador(linhaHeader) {
  // Conta quantos de cada candidato aparecem fora de aspas
  const candidatos = [';', ',', '\t', '|'];
  const counts = candidatos.map(s => (linhaHeader.match(new RegExp(`\\${s}`, 'g')) || []).length);
  const idx = counts.indexOf(Math.max(...counts));
  return counts[idx] > 0 ? candidatos[idx] : ';';
}

async function uploadCsv(file) {
  const txt = await file.text();
  let linhas = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!linhas.length) { alert('CSV vazio'); return; }
  // Pula linha "sep=;" se Excel deixou
  if (/^sep=/i.test(linhas[0])) linhas = linhas.slice(1);
  if (!linhas.length) { alert('CSV vazio'); return; }
  const sep = detectarSeparador(linhas[0]);
  const header = parseCsvLinha(linhas[0], sep).map(h => h.trim().toLowerCase());
  const idxNome = header.indexOf('nome');
  if (idxNome < 0) { alert('CSV precisa ter coluna "nome"'); return; }
  const campos = CAMPOS_C;
  const idxCampo = Object.fromEntries(campos.map(c => [c, header.indexOf(c)]));

  const inputs = $('#tbodyMetas').querySelectorAll('input[type="number"]');
  const porNome = {};
  inputs.forEach(i => {
    if (!porNome[i.dataset.nome]) porNome[i.dataset.nome] = {};
    porNome[i.dataset.nome][i.dataset.campo] = i;
  });

  let aplicados = 0, naoEncontrados = [];
  for (let li = 1; li < linhas.length; li++) {
    const cols = parseCsvLinha(linhas[li], sep).map(c => c.trim());
    const nome = cols[idxNome];
    if (!nome) continue;
    if (!porNome[nome]) { naoEncontrados.push(nome); continue; }
    for (const campo of campos) {
      const idx = idxCampo[campo];
      if (idx < 0) continue;
      const v = cols[idx];
      if (v == null || v === '') continue;
      const valor = parseNumeroBR(v);
      if (Number.isNaN(valor)) continue;
      const inp = porNome[nome][campo];
      if (inp) { inp.value = valor; inp.classList.add('modificado'); }
    }
    aplicados++;
  }
  let msg = `✓ ${aplicados} compradores com metas atualizadas pra ${rotuloMes(MES)}. Clique em "Salvar e aplicar" pra confirmar.`;
  if (naoEncontrados.length) {
    msg += `\n\n⚠ ${naoEncontrados.length} nomes não encontrados:\n` + naoEncontrados.slice(0, 10).join('\n');
    if (naoEncontrados.length > 10) msg += `\n…e mais ${naoEncontrados.length - 10}.`;
  }
  alert(msg);
}

// ===== CSV de Percentuais =====
function diasNoMes(yyyymm) {
  const [a, m] = yyyymm.split('-').map(Number);
  return new Date(a, m, 0).getDate(); // último dia do mês
}

function baixarTemplatePct() {
  const compradores = DADOS.compradores || [];
  const pctSalvo = (DADOS.metas?.percentuais) || {};
  const pctPlanilha = DADOS.percentuais_planilha || {};
  const ndias = diasNoMes(MES);
  const SEP = ';';

  // Formato largo: nome;tipo;01;02;...;NN
  const header = ['nome', 'tipo'];
  for (let d = 1; d <= ndias; d++) header.push(String(d).padStart(2, '0'));
  const linhas = [`sep=${SEP}`, header.join(SEP)];

  for (const c of compradores) {
    // Prioridade: salvo manual > planilha
    const fonte = pctSalvo[c.nome] || pctPlanilha[c.nome] || {};
    for (const tipo of ['venda', 'margem']) {
      const cols = [c.nome, tipo];
      let teveAlgum = false;
      for (let d = 1; d <= ndias; d++) {
        const k = String(d).padStart(2, '0');
        const v = fonte[k]?.[tipo];
        if (v != null) teveAlgum = true;
        cols.push(v != null ? Number(v).toFixed(4).replace('.', ',') : '');
      }
      // Sem nada → exporta linha vazia mesmo (usuário preenche)
      linhas.push(cols.map(x => {
        const s = String(x);
        return (s.includes(SEP) || s.includes('"') || s.includes('\n'))
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(SEP));
    }
  }

  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `percentuais_diarios_${MES}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function uploadCsvPct(file) {
  const txt = await file.text();
  let linhas = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!linhas.length) { alert('CSV vazio'); return; }
  if (/^sep=/i.test(linhas[0])) linhas = linhas.slice(1);
  if (!linhas.length) { alert('CSV vazio'); return; }
  const sep = detectarSeparador(linhas[0]);
  const header = parseCsvLinha(linhas[0], sep).map(h => h.trim().toLowerCase());

  const idxNome = header.indexOf('nome');
  const idxTipo = header.indexOf('tipo');
  const idxDia = header.indexOf('dia');
  const idxPctV = header.indexOf('pct_venda');
  const idxPctM = header.indexOf('pct_margem');

  // Detecta formato: largo (nome+tipo+dias) ou longo (nome+dia+pct_venda+pct_margem)
  const formatoLargo = idxNome >= 0 && idxTipo >= 0;
  const formatoLongo = idxNome >= 0 && idxDia >= 0 && (idxPctV >= 0 || idxPctM >= 0);
  if (!formatoLargo && !formatoLongo) {
    alert('CSV não reconhecido. Use o template (nome;tipo;01;02;…) ou formato longo (nome;dia;pct_venda;pct_margem).');
    return;
  }

  const compradoresValidos = new Set((DADOS.compradores || []).map(c => c.nome));
  const novo = {};
  let aplic = 0, naoEncontrados = new Set();

  if (formatoLargo) {
    // Mapeia coluna → dia
    const diaPorIdx = {};
    header.forEach((h, i) => {
      const n = parseInt(h, 10);
      if (n >= 1 && n <= 31) diaPorIdx[i] = String(n).padStart(2, '0');
    });
    for (let li = 1; li < linhas.length; li++) {
      const cols = parseCsvLinha(linhas[li], sep).map(c => c.trim());
      const nome = cols[idxNome];
      const tipo = (cols[idxTipo] || '').toLowerCase();
      if (!nome || !tipo) continue;
      if (!compradoresValidos.has(nome)) { naoEncontrados.add(nome); continue; }
      if (tipo !== 'venda' && tipo !== 'margem') continue;
      if (!novo[nome]) novo[nome] = {};
      for (const [idx, dia] of Object.entries(diaPorIdx)) {
        const v = cols[idx];
        if (v == null || v === '') continue;
        const num = parseNumeroBR(v);
        if (Number.isNaN(num)) continue;
        if (!novo[nome][dia]) novo[nome][dia] = {};
        novo[nome][dia][tipo] = num;
      }
      aplic++;
    }
  } else {
    for (let li = 1; li < linhas.length; li++) {
      const cols = parseCsvLinha(linhas[li], sep).map(c => c.trim());
      const nome = cols[idxNome];
      const diaN = parseInt(cols[idxDia], 10);
      if (!nome || !(diaN >= 1 && diaN <= 31)) continue;
      if (!compradoresValidos.has(nome)) { naoEncontrados.add(nome); continue; }
      const dia = String(diaN).padStart(2, '0');
      const pV = idxPctV >= 0 ? parseNumeroBR(cols[idxPctV]) : NaN;
      const pM = idxPctM >= 0 ? parseNumeroBR(cols[idxPctM]) : NaN;
      if (Number.isNaN(pV) && Number.isNaN(pM)) continue;
      if (!novo[nome]) novo[nome] = {};
      if (!novo[nome][dia]) novo[nome][dia] = {};
      if (!Number.isNaN(pV)) novo[nome][dia].venda  = pV;
      if (!Number.isNaN(pM)) novo[nome][dia].margem = pM;
      aplic++;
    }
  }

  // Normaliza: remove dias vazios
  for (const nome of Object.keys(novo)) {
    for (const dia of Object.keys(novo[nome])) {
      if (!Object.keys(novo[nome][dia]).length) delete novo[nome][dia];
    }
    if (!Object.keys(novo[nome]).length) delete novo[nome];
  }

  PCT_BUFFER = novo;
  atualizarStatusPct();

  let msg = `✓ ${aplic} linhas processadas. ${Object.keys(novo).length} compradores com %.\n\nLembre de clicar "Salvar e aplicar" pra gravar.`;
  if (naoEncontrados.size) {
    msg += `\n\n⚠ ${naoEncontrados.size} nomes não encontrados:\n` + Array.from(naoEncontrados).slice(0, 10).join('\n');
  }
  alert(msg);
}

function limparPct() {
  if (!confirm(`Apagar os percentuais de ${rotuloMes(MES)}? Após salvar, o sistema volta a usar a curva da planilha (escalada).`)) return;
  PCT_BUFFER = {};
  atualizarStatusPct();
  const msg = $('#msgSalvar');
  msg.className = 'mt-msg ok';
  msg.textContent = `✓ Percentuais limpos no formulário. Clique em "Salvar e aplicar" pra confirmar.`;
}

// ===== Bootstrap =====
async function init() {
  me = await api('GET', '/api/me');
  $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
  if (me.is_admin) $('#linkAdmin').style.display = '';
  $('#btnLogout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.href = '/login.html';
  });

  await carregar();

  $('#selMes').addEventListener('change', e => carregar(e.target.value));
  $('#btnPlanilha').addEventListener('click', importarPlanilha);
  $('#btnCopiar').addEventListener('click', copiarDe);
  $('#btnApagarMes').addEventListener('click', apagarMes);
  $('#btnSalvar').addEventListener('click', salvar);
  $('#btnLimparTodas').addEventListener('click', limparTodas);
  $('#btnTemplate').addEventListener('click', baixarTemplate);
  $('#inputCsv').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) uploadCsv(f).finally(() => { e.target.value = ''; });
  });
  $('#btnTemplatePct').addEventListener('click', baixarTemplatePct);
  $('#inputCsvPct').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) uploadCsvPct(f).finally(() => { e.target.value = ''; });
  });
  $('#btnLimparPct').addEventListener('click', limparPct);
  // Visual: marca campo modificado ao digitar
  document.body.addEventListener('input', e => {
    if (e.target.matches('input[type="number"]')) {
      e.target.classList.toggle('modificado', e.target.value !== '');
    }
  });
}

init().catch(e => {
  if (e.message !== 'não autenticado') { console.error(e); alert('Falha: ' + e.message); }
});
