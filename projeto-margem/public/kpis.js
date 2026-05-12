// ========== Estado ==========
let DADOS = null;
let me = null;
let pollTimer = null;
let rankModoB1 = 'ating';  // 'ating' | 'diff' — modo do rank no Bloco 1 (KPI's Comercial)

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const fmtRs = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsP = (v) => v == null || isNaN(v) ? '—' : (v < 0 ? '-' : '') + 'R$ ' + Math.round(Math.abs(v)).toLocaleString('pt-BR');
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const fmtDec = (v, d=2) => v == null || isNaN(v) ? '—' : Number(v).toFixed(d).replace('.', ',');
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
};
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

function classAting(ating) {
  if (ating == null) return '';
  if (ating >= 1) return 'ating-ok';
  if (ating >= 0.85) return 'ating-warn';
  return 'ating-bad';
}

// Rank: 1, 2, 3 = piores (vermelho)
function classRank(rank) {
  if (rank == null) return '';
  if (rank <= 3) return 'rank-bad';
  return '';
}

function classAtingInverso(ating) {
  // Pra DDE, RUPTURA, QUEBRA, TROCA — meta superior é melhor
  if (ating == null) return '';
  if (ating >= 1) return 'ating-ok';
  if (ating >= 0.85) return 'ating-warn';
  return 'ating-bad';
}

// ========== Status / atualização ==========
function pintaStatus(s) {
  const sec = $('#trStatus');
  const msg = $('#trStatusMsg');
  const btn = $('#btnAtualizar');

  // Mostra periodo (vem de DADOS, não da solicitação)
  const box = $('#trPeriodoBox');
  if (DADOS && DADOS.periodo && box) {
    const ini = new Date(DADOS.periodo.inicio + 'T00:00:00');
    const fim = new Date(DADOS.periodo.fim + 'T00:00:00');
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    $('#trPeriodoTxt').textContent = `${fmt(ini)} a ${fmt(fim)}`;
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
    msg.innerHTML = `Última atualização: <b>${ult}</b>`;
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

let lastUpdatedAt = null;
async function pollOnce() {
  const s = await api('GET', '/api/kpis/status');
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
    await api('POST', '/api/kpis/atualizar');
    iniciarPolling();
  } catch (e) {
    alert('Falha: ' + e.message);
    btn.disabled = false; btn.textContent = '🔄 Atualizar';
  }
}

async function carregarDados() {
  try {
    const d = await api('GET', '/api/kpis');
    if (d && !d.vazio) {
      DADOS = d;
      renderTudo();
    }
  } catch (e) { console.error(e); }
}

// ========== Render ==========
function abrirModalDiario(nome) {
  const vendas = DADOS?.vendas_diarias?.[nome] || {};
  const metas  = DADOS?.metas_diarias?.[nome] || {};
  const fimISO = (DADOS?.periodo?.fim) || new Date().toISOString().slice(0,10);

  // Gera lista de datas: do dia 1 do mês até dia "fim" (inclusive)
  const fim = new Date(fimISO + 'T00:00:00');
  const ano = fim.getFullYear(), mes = fim.getMonth();
  const dias = [];
  for (let d = 1; d <= fim.getDate(); d++) {
    const dt = new Date(ano, mes, d);
    dias.push(dt.toISOString().slice(0,10));
  }

  let totV = 0, totM = 0, totMV = 0, totMM = 0;
  const linhas = dias.map(iso => {
    const v = vendas[iso] || {};
    const m = metas[iso] || {};
    const venda = v.venda || 0;
    const margem = v.margem || 0;
    const mv = m.meta_venda || 0;
    const mm = m.meta_margem || 0;
    totV += venda; totM += margem; totMV += mv; totMM += mm;
    const diffV = venda - mv;
    const diffM = margem - mm;
    const atV = mv ? venda / mv : null;
    const atM = mm ? margem / mm : null;
    const dataBR = iso.split('-').reverse().join('/');
    return `
      <tr>
        <td>${dataBR}</td>
        <td class="num">${fmtRs(mv)}</td>
        <td class="num">${fmtRs(venda)}</td>
        <td class="num ${diffV >= 0 ? 'ating-ok' : 'ating-bad'}">${fmtRs(diffV)}</td>
        <td class="num ${classAting(atV)}">${fmtPct(atV)}</td>
        <td class="num">${fmtRs(mm)}</td>
        <td class="num">${fmtRs(margem)}</td>
        <td class="num ${diffM >= 0 ? 'ating-ok' : 'ating-bad'}">${fmtRs(diffM)}</td>
        <td class="num ${classAting(atM)}">${fmtPct(atM)}</td>
      </tr>
    `;
  });
  // Linha total
  const atVT = totMV ? totV / totMV : null;
  const atMT = totMM ? totM / totMM : null;
  linhas.push(`
    <tr class="total" style="background:rgba(245,211,12,.12);font-weight:700;">
      <td>TOTAL</td>
      <td class="num">${fmtRs(totMV)}</td>
      <td class="num">${fmtRs(totV)}</td>
      <td class="num ${(totV-totMV) >= 0 ? 'ating-ok' : 'ating-bad'}">${fmtRs(totV-totMV)}</td>
      <td class="num ${classAting(atVT)}">${fmtPct(atVT)}</td>
      <td class="num">${fmtRs(totMM)}</td>
      <td class="num">${fmtRs(totM)}</td>
      <td class="num ${(totM-totMM) >= 0 ? 'ating-ok' : 'ating-bad'}">${fmtRs(totM-totMM)}</td>
      <td class="num ${classAting(atMT)}">${fmtPct(atMT)}</td>
    </tr>
  `);

  $('#modalDiarioTitulo').textContent = nome;
  $('#modalDiarioInfo').innerHTML = `
    <b>${dias.length}</b> dias · Venda: <b>${fmtRs(totV)}</b> / ${fmtRs(totMV)} (${fmtPct(atVT)})
    · Margem: <b>${fmtRs(totM)}</b> / ${fmtRs(totMM)} (${fmtPct(atMT)})
  `;
  $('#tbodyDiario').innerHTML = linhas.join('');
  $('#modalDiario').classList.add('open');
}

// ========== Funções do Painel (tab "Painel") ==========
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v/1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v/1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};

function classAtPainel(at) {
  if (at == null) return '';
  if (at >= 1) return 'ok';
  if (at >= 0.85) return 'warn';
  return 'bad';
}

function pintaKpiPainel(id, real, meta, fmt, inverso = false) {
  const el = $(`#${id}`);
  if (!el) return;
  const ating = (meta && real != null) ? (inverso ? meta / Math.max(real, 0.0001) : real / meta) : null;
  el.querySelector('.pn-kpi-val').textContent = fmt(real);
  el.querySelector('.pn-kpi-sub').textContent = `meta: ${fmt(meta)} · ${fmtPct(ating)}`;
  const fill = el.querySelector('.pn-bar-fill');
  fill.style.width = Math.min((ating || 0) * 100, 100) + '%';
  fill.classList.remove('warn', 'bad');
  if (ating != null) {
    if (ating < 0.85) fill.classList.add('bad');
    else if (ating < 1) fill.classList.add('warn');
  }
}

function renderKPIsMini() {
  const t = DADOS.total || {};

  // Helper: pinta um KPI mini com valor + sub + diff/ating
  function pintaMini(id, opts) {
    const el = $(id);
    if (!el) return;
    const valEl = el.querySelector('.val');
    if (valEl) valEl.innerHTML = opts.valHtml;

    let subEl = el.querySelector('.kpi-mini-sub');
    if (!subEl) {
      subEl = document.createElement('div');
      subEl.className = 'kpi-mini-sub';
      subEl.style.cssText = 'font-size:10px;color:#aab2bd;margin-top:4px;line-height:1.4;';
      el.appendChild(subEl);
    }
    subEl.innerHTML = opts.subHtml || '';
  }

  function corDiff(at) {
    if (at == null) return '#aab2bd';
    if (at >= 1) return '#22c55e';
    if (at >= 0.85) return '#f5a522';
    return '#ef4444';
  }

  // Faturamento: valor + (diff vs meta · ating)
  const atV = (t.meta_venda && t.venda) ? t.venda / t.meta_venda : null;
  const indV = atV >= 1 ? 'up' : (atV >= 0.85 ? 'warn' : 'down');
  const diffV = (t.venda && t.meta_venda) ? t.venda - t.meta_venda : null;
  const sinalV = diffV >= 0 ? '+' : '';
  pintaMini('#miniFat', {
    valHtml: `${fmtRsK(t.venda)} <span class="indicador ${indV}"></span>`,
    subHtml: diffV != null
      ? `<span style="color:${corDiff(atV)}">${sinalV}${fmtRsK(diffV)}</span> · <b style="color:${corDiff(atV)}">${fmtPct(atV)}</b>`
      : '',
  });

  // Margem
  const atM = (t.meta_margem && t.margem) ? t.margem / t.meta_margem : null;
  const indM = atM >= 1 ? 'up' : (atM >= 0.85 ? 'warn' : 'down');
  const pctMargem = (t.venda && t.margem) ? t.margem / t.venda : null;
  const pctMetaMargem = (t.meta_venda && t.meta_margem) ? t.meta_margem / t.meta_venda : null;
  const pctMargemTxt = pctMargem != null ? ` <small style="font-size:11px;color:#aab2bd;">(${fmtPct(pctMargem)})</small>` : '';
  const diffM = (t.margem && t.meta_margem) ? t.margem - t.meta_margem : null;
  const sinalM = diffM >= 0 ? '+' : '';
  pintaMini('#miniMar', {
    valHtml: `${fmtRsK(t.margem)}${pctMargemTxt} <span class="indicador ${indM}"></span>`,
    subHtml: (diffM != null && pctMetaMargem != null)
      ? `<span style="color:${corDiff(atM)}">${sinalM}${fmtRsK(diffM)}</span> · <b style="color:${corDiff(atM)}">${fmtPct(atM)}</b><br>meta: ${fmtPct(pctMetaMargem)}`
      : (diffM != null ? `<span style="color:${corDiff(atM)}">${sinalM}${fmtRsK(diffM)}</span> · <b style="color:${corDiff(atM)}">${fmtPct(atM)}</b>` : ''),
  });

  // Ruptura (inverso)
  const atR = (t.meta_ruptura && t.ruptura) ? t.meta_ruptura / Math.max(t.ruptura, 0.0001) : null;
  const indR = atR >= 1 ? 'up' : (atR >= 0.85 ? 'warn' : 'down');
  pintaMini('#miniRup', {
    valHtml: `${fmtPct(t.ruptura)} <span class="indicador ${indR}"></span>`,
    subHtml: t.meta_ruptura
      ? `meta: ${fmtPct(t.meta_ruptura)} · <b style="color:${corDiff(atR)}">${fmtPct(atR)}</b>`
      : '',
  });

  // DDE (inverso)
  const atD = (t.meta_dde && t.dde) ? t.meta_dde / Math.max(t.dde, 0.01) : null;
  const indD = atD >= 1 ? 'up' : (atD >= 0.85 ? 'warn' : 'down');
  const valEstq = t.valor_estoque ? `<small style="font-size:11px;color:#aab2bd;">(${fmtRsK(t.valor_estoque)})</small>` : '';
  pintaMini('#miniDDE', {
    valHtml: `${fmtDec(t.dde, 1)}d ${valEstq} <span class="indicador ${indD}"></span>`,
    subHtml: t.meta_dde
      ? `meta: ${fmtDec(t.meta_dde, 0)}d · <b style="color:${corDiff(atD)}">${fmtPct(atD)}</b>`
      : '',
  });

  // Quebra (inverso)
  const atQ = (t.meta_quebra && t.perda) ? t.meta_quebra / Math.max(t.perda, 0.01) : null;
  const indQ = atQ >= 1 ? 'up' : (atQ >= 0.85 ? 'warn' : 'down');
  pintaMini('#miniQue', {
    valHtml: `${fmtRsK(t.perda)} <span class="indicador ${indQ}"></span>`,
    subHtml: t.meta_quebra
      ? `meta: ${fmtRsK(t.meta_quebra)} · <b style="color:${corDiff(atQ)}">${fmtPct(atQ)}</b>`
      : '',
  });

  // Troca (inverso)
  const atT = (t.meta_troca && t.troca) ? t.meta_troca / Math.max(t.troca, 0.01) : null;
  const indT = atT >= 1 ? 'up' : (atT >= 0.85 ? 'warn' : 'down');
  pintaMini('#miniTro', {
    valHtml: `${fmtRsK(t.troca)} <span class="indicador ${indT}"></span>`,
    subHtml: t.meta_troca
      ? `meta: ${fmtRsK(t.meta_troca)} · <b style="color:${corDiff(atT)}">${fmtPct(atT)}</b>`
      : '',
  });

  // Pill de período (mês)
  const p = DADOS.periodo;
  if (p) {
    const ini = new Date(p.inicio + 'T00:00:00').toLocaleDateString('pt-BR');
    const fim = new Date(p.fim + 'T00:00:00').toLocaleDateString('pt-BR');
    $('#periodoTxt').textContent = `${ini} → ${fim}`;
    const pill = $('#pillMes');
    if (pill) {
      const meses = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
      const dt = new Date(p.fim + 'T00:00:00');
      pill.textContent = `${meses[dt.getMonth()]} / ${dt.getFullYear()}`;
    }
  }
}

// ===== Donut grande de atingimento total =====
function renderDonutAtingimento() {
  const svg = $('#donutAtingimento');
  if (!svg) return;
  const t = DADOS.total || {};
  const at = t.ating_total || 0;
  const pctEl = $('#donutPct');
  pctEl.textContent = fmtPct(at);
  pctEl.classList.remove('warn', 'bad');
  if (at < 0.85) pctEl.classList.add('bad');
  else if (at < 1) pctEl.classList.add('warn');

  $('#realVal').textContent = fmtRsK(t.venda);
  $('#metaVal').textContent = fmtRsK(t.meta_venda);

  const R = 50, r = 38;
  const pct = Math.min(at, 1);
  const start = -Math.PI / 2;
  const end = start + pct * Math.PI * 2;
  const cor = at >= 1 ? '#22c55e' : (at >= 0.85 ? '#f5a522' : '#ef4444');
  // Ring de fundo (cinza)
  const bgPath = `<circle cx="0" cy="0" r="${(R+r)/2}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="${R-r}"/>`;
  // Arco preenchido
  let fill = '';
  if (pct > 0) {
    const large = (end - start) > Math.PI ? 1 : 0;
    const x1 = Math.cos(start) * R, y1 = Math.sin(start) * R;
    const x2 = Math.cos(end)   * R, y2 = Math.sin(end)   * R;
    const x3 = Math.cos(end)   * r, y3 = Math.sin(end)   * r;
    const x4 = Math.cos(start) * r, y4 = Math.sin(start) * r;
    fill = `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z" fill="${cor}"/>`;
  }
  svg.innerHTML = bgPath + fill;
}

// ===== Tabela de compradores com data bars =====
function renderTabelaPainelComp() {
  const tbody = $('#tbodyPainelComp');
  if (!tbody) return;
  const cs = DADOS.compradores || [];
  const maxVenda = Math.max(...cs.map(c => c.venda || 0), 1);
  const maxMargem = Math.max(...cs.map(c => c.margem || 0), 1);

  function databar(valor, max, fmt, classe) {
    const pct = Math.min((valor || 0) / max * 100, 100);
    return `<div class="pn-databar"><div class="pn-databar-bg ${classe || ''}" style="width:${pct}%"></div><span class="pn-databar-text">${fmt(valor)}</span></div>`;
  }
  function corAt(at) {
    if (at == null) return '';
    if (at >= 1) return '';
    if (at >= 0.85) return 'warn';
    return 'bad';
  }

  // Ordena por venda desc
  const sorted = [...cs].sort((a, b) => (b.venda || 0) - (a.venda || 0));
  tbody.innerHTML = sorted.map(c => {
    const atV = c.meta_venda ? c.venda / c.meta_venda : null;
    const margPct = c.venda ? (c.margem / c.venda) : null;
    return `
      <tr>
        <td>${escapeHtml(c.nome)}</td>
        <td>${databar(c.venda, maxVenda, fmtRsK)}</td>
        <td>${fmtRsK(c.meta_venda)}</td>
        <td><span class="pn-databar-text" style="color:${atV >= 1 ? '#22c55e' : (atV >= 0.85 ? '#f5a522' : '#ef4444')}">${fmtPct(atV)}</span></td>
        <td>${databar(c.margem, maxMargem, fmtRsK)}</td>
        <td>${fmtPct(margPct)}</td>
        <td>${fmtDec(c.dde, 1)}</td>
        <td><span style="color:${c.rank_venda <= 3 ? '#ef4444' : '#aab2bd'};font-weight:700;">#${c.rank_venda || '—'}</span></td>
      </tr>
    `;
  }).join('');
}

function renderGerentesPainel() {
  const ger = DADOS.gerentes || {};
  function card(nome, emoji, g) {
    if (!g) return '';
    const at = g.ating_total;
    const cls = classAtPainel(at);
    return `
      <div class="pn-ger">
        <div class="pn-ger-titulo">${emoji} ${nome}</div>
        <div class="pn-ger-met"><span class="lbl">Faturamento</span> <span class="val">${fmtRsK(g.venda)} / ${fmtRsK(g.meta_venda)}</span></div>
        <div class="pn-ger-met"><span class="lbl">Margem</span> <span class="val">${fmtRsK(g.margem)} / ${fmtRsK(g.meta_margem)}</span></div>
        <div class="pn-ger-met"><span class="lbl">DDE</span> <span class="val">${fmtDec(g.dde, 1)} / ${fmtDec(g.meta_dde, 0)}</span></div>
        <div class="pn-ger-met"><span class="lbl">Ruptura</span> <span class="val">${fmtPct(g.ruptura)} / ${fmtPct(g.meta_ruptura)}</span></div>
        <div class="pn-ger-met"><span class="lbl">Quebra</span> <span class="val">${fmtRsK(g.perda)}</span></div>
        <div class="pn-ger-met"><span class="lbl">Troca</span> <span class="val">${fmtRsK(g.troca)}</span></div>
        <div class="pn-ger-ating">
          <span class="lbl">ATINGIMENTO</span>
          <span class="val ${cls === 'ok' ? 'ating-ok' : cls === 'warn' ? 'ating-warn' : 'ating-bad'}">${fmtPct(at)}</span>
        </div>
      </div>
    `;
  }
  $('#gerentesGrid').innerHTML = card('Perecível — André', '🥩', ger.Andre) + card('Mercearia — Walas', '🛒', ger.Walas);
}

function renderTopsPainel() {
  const cs = (DADOS.compradores || []).filter(c => c.ating_total != null);
  const melhores = [...cs].sort((a, b) => (b.ating_total || 0) - (a.ating_total || 0)).slice(0, 5);
  $('#listMelhores').innerHTML = melhores.map((c, i) => {
    const cls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    return `<div class="pn-item ${cls}"><span class="pos">#${i+1}</span><span class="nome">${escapeHtml(c.nome)}</span><span class="val ok">${fmtPct(c.ating_total)}</span></div>`;
  }).join('') || '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';

  const piores = [...cs].sort((a, b) => (a.ating_total || 0) - (b.ating_total || 0)).slice(0, 3);
  $('#listPiores').innerHTML = piores.map((c, i) =>
    `<div class="pn-item bad"><span class="pos">#${i+1}</span><span class="nome">${escapeHtml(c.nome)}</span><span class="val bad">${fmtPct(c.ating_total)}</span></div>`
  ).join('') || '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';
}

function renderPremiacaoPainel() {
  const premiados = (DADOS.compradores || []).filter(c => (c.premiacao || 0) > 0)
    .sort((a, b) => (b.premiacao || 0) - (a.premiacao || 0));
  const totPrem = premiados.reduce((s, c) => s + (c.premiacao || 0), 0);
  if (!premiados.length) { $('#secPremiacao').style.display = 'none'; return; }
  $('#secPremiacao').style.display = '';
  $('#listPremiacao').innerHTML = premiados.map(c =>
    `<div class="pn-item pn-prem-item"><span class="pos">💰</span><span class="nome">${escapeHtml(c.nome)}</span><span class="val">${fmtRs(c.premiacao)}</span></div>`
  ).join('') + `
    <div class="pn-item" style="background:rgba(245,211,12,.08);font-weight:700;">
      <span class="pos">Σ</span><span class="nome">Total premiações</span>
      <span class="val" style="color:#f5d30c">${fmtRs(totPrem)}</span>
    </div>`;
}

// ===== Gráfico de barras: vendas por dia =====
function renderGraficoVendasDia() {
  const svg = $('#graficoVendasDia');
  if (!svg) return;
  const W = 800, H = 260, PAD_L = 50, PAD_R = 16, PAD_T = 28, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  // Agrega vendas+meta por dia (somando todos compradores)
  const vendasDiarias = DADOS.vendas_diarias || {};
  const metasDiarias  = DADOS.metas_diarias  || {};
  const porDia = new Map();
  for (const dias of Object.values(vendasDiarias)) {
    for (const [dt, v] of Object.entries(dias)) {
      if (!porDia.has(dt)) porDia.set(dt, { venda: 0, meta: 0 });
      porDia.get(dt).venda += v.venda || 0;
    }
  }
  for (const dias of Object.values(metasDiarias)) {
    for (const [dt, m] of Object.entries(dias)) {
      if (!porDia.has(dt)) porDia.set(dt, { venda: 0, meta: 0 });
      porDia.get(dt).meta += m.meta_venda || 0;
    }
  }
  // Filtra apenas dias com venda
  const datas = Array.from(porDia.keys()).filter(d => porDia.get(d).venda > 0).sort();
  if (!datas.length) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="currentColor" opacity=".5">Sem dados</text>';
    return;
  }
  const valores = datas.map(d => porDia.get(d));
  const max = Math.max(...valores.map(v => Math.max(v.venda, v.meta || 0))) || 1;
  const xStep = innerW / datas.length;
  const barW = Math.max(8, xStep * 0.6);
  const yAt = (v) => PAD_T + innerH - (v / max) * innerH;

  const grids = [];
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = yAt(v);
    grids.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="currentColor" stroke-opacity=".08"/>`);
    const lbl = v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'k' : v.toFixed(0);
    grids.push(`<text x="${PAD_L - 6}" y="${y + 3}" text-anchor="end" fill="currentColor" fill-opacity=".5" font-size="9">${lbl}</text>`);
  }

  const bars = [], labels = [], linhaPath = [];
  datas.forEach((dt, i) => {
    const v = valores[i];
    const x = PAD_L + xStep * i + (xStep - barW) / 2;
    const y = yAt(v.venda);
    const h = innerH - (y - PAD_T);
    const cor = (v.meta && v.venda >= v.meta) ? '#1a8f4f' : (v.meta && v.venda >= v.meta * 0.85) ? '#d4a017' : '#c0392b';
    const lblTitle = `${dt}: R$ ${Math.round(v.venda).toLocaleString('pt-BR')} (meta R$ ${Math.round(v.meta).toLocaleString('pt-BR')})`;
    bars.push(`<rect class="bar-rect" x="${x}" y="${y}" width="${barW}" height="${h}" fill="${cor}" rx="2"><title>${lblTitle}</title></rect>`);
    if ((i % 2 === 0) || datas.length <= 16) {
      const dia = dt.split('-')[2];
      labels.push(`<text x="${x + barW/2}" y="${PAD_T + innerH + 14}" text-anchor="middle" fill="currentColor" fill-opacity=".55" font-size="9">${dia}</text>`);
    }
    if (v.meta) {
      const yMeta = yAt(v.meta);
      linhaPath.push(`${i === 0 ? 'M' : 'L'} ${x + barW/2} ${yMeta}`);
    }
  });
  const linhaMeta = linhaPath.length ? `<path d="${linhaPath.join(' ')}" fill="none" stroke="#dc3545" stroke-width="1.5" stroke-dasharray="4 3"/>` : '';

  const leg = `<g transform="translate(${PAD_L},14)">
    <rect x="0" y="-7" width="10" height="10" fill="#1a8f4f" rx="2"/><text x="14" y="2" fill="currentColor" font-size="10">≥ Meta</text>
    <rect x="80" y="-7" width="10" height="10" fill="#d4a017" rx="2"/><text x="94" y="2" fill="currentColor" font-size="10">85-100%</text>
    <rect x="170" y="-7" width="10" height="10" fill="#c0392b" rx="2"/><text x="184" y="2" fill="currentColor" font-size="10">Crítico</text>
    <line x1="240" y1="-2" x2="258" y2="-2" stroke="#dc3545" stroke-width="1.5" stroke-dasharray="4 3"/><text x="264" y="2" fill="currentColor" font-size="10">Meta</text>
  </g>`;

  svg.innerHTML = grids.join('') + bars.join('') + linhaMeta + labels.join('') + leg;
}

// ===== Piores em Venda e Margem =====
function renderPiores() {
  const cs = (DADOS.compradores || []).filter(c => c.gerente);

  function lista(elId, key_real, key_meta) {
    const itens = cs
      .filter(c => c[key_real] != null && c[key_meta])
      .map(c => ({ c, ating: c[key_real] / c[key_meta] }))
      .sort((a, b) => a.ating - b.ating)
      .slice(0, 3);
    const el = $(elId);
    if (!el) return;
    if (!itens.length) { el.innerHTML = '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>'; return; }
    el.innerHTML = itens.map(({ c, ating }, i) => `
      <div class="pn-pior-row">
        <span class="pos">#${i + 1}</span>
        <span class="nome">${escapeHtml(c.nome)}</span>
        <span class="valor">${fmtRsK(c[key_real])} / ${fmtRsK(c[key_meta])}</span>
        <span class="ating">${fmtPct(ating)}</span>
      </div>
    `).join('');
  }

  lista('#pioresVenda',  'venda',  'meta_venda');
  lista('#pioresMargem', 'margem', 'meta_margem');
}

// ===== Donut: proporção de vendas por gerente =====
function renderDonut() {
  const svg = $('#donutVenda');
  if (!svg) return;
  const ger = DADOS.gerentes || {};
  const items = [
    { nome: 'André',  valor: ger.Andre?.venda || 0, cor: '#c2185b' },
    { nome: 'Walas',  valor: ger.Walas?.venda || 0, cor: '#1da1f2' },
  ];
  const total = items.reduce((s, x) => s + x.valor, 0);
  if (!total) { svg.innerHTML = ''; $('#donutTotal').textContent = '—'; return; }
  $('#donutTotal').textContent = fmtRsK(total);

  const R = 50, r = 32;
  let acc = 0;
  const paths = items.map(it => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += it.valor;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = (end - start) > Math.PI ? 1 : 0;
    const x1 = Math.cos(start) * R, y1 = Math.sin(start) * R;
    const x2 = Math.cos(end)   * R, y2 = Math.sin(end)   * R;
    const x3 = Math.cos(end)   * r, y3 = Math.sin(end)   * r;
    const x4 = Math.cos(start) * r, y4 = Math.sin(start) * r;
    return `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z" fill="${it.cor}"/>`;
  });
  svg.innerHTML = paths.join('');

  $('#donutLeg').innerHTML = items.map(it => `
    <div class="pn-donut-leg-row">
      <span class="swatch" style="background:${it.cor}"></span>
      <span class="nome">${it.nome}</span>
      <span class="val">${fmtRsK(it.valor)} · ${fmtPct(it.valor / total)}</span>
    </div>
  `).join('');
}

function renderTudo() {
  if (!DADOS) return;
  // Período
  const p = DADOS.periodo;
  if (p) {
    const ini = new Date(p.inicio + 'T00:00:00').toLocaleDateString('pt-BR');
    const fim = new Date(p.fim + 'T00:00:00').toLocaleDateString('pt-BR');
    $('#periodoTxt').textContent = `${ini} → ${fim}`;
  }

  // Painel
  renderKPIsMini();
  renderDonutAtingimento();
  renderTabelaPainelComp();
  renderGraficoVendasDia();
  renderDonut();
  renderPiores();

  // Detalhado
  renderB1();
  renderB2();
  renderResumo();
}

function renderB1() {
  const tbody = $('#tbodyB1');
  const cs = DADOS.compradores || [];
  const tot = DADOS.total || {};

  // Agrupa por gerente
  const grupos = [
    { gerente: 'André', label: '🥩 Perecível — André', agg: DADOS.gerentes?.Andre, items: cs.filter(c => c.gerente === 'André') },
    { gerente: 'Walas', label: '🛒 Mercearia — Walas', agg: DADOS.gerentes?.Walas, items: cs.filter(c => c.gerente === 'Walas') },
  ];

  // Outros (sem gerente)
  const outros = cs.filter(c => !c.gerente);

  // Calcula ranks dinâmicos (atingimento OU diff) só entre compradores com dados
  const ranksV = ranksB1Por(cs, 'venda', 'meta_venda', rankModoB1);
  const ranksM = ranksB1Por(cs, 'margem', 'meta_margem', rankModoB1);

  let html = '';
  for (const g of grupos) {
    for (const c of g.items) {
      const part = (tot.venda && c.venda) ? c.venda / tot.venda : null;
      html += linhaB1(c.nome, c.venda, c.meta_venda, c.margem, c.meta_margem, part, false, false, ranksV.get(c.nome), ranksM.get(c.nome));
    }
    if (g.agg) {
      const part = (tot.venda && g.agg.venda) ? g.agg.venda / tot.venda : null;
      html += linhaB1(g.label, g.agg.venda, g.agg.meta_venda, g.agg.margem, g.agg.meta_margem, part, true);
    }
  }
  for (const c of outros) {
    const part = (tot.venda && c.venda) ? c.venda / tot.venda : null;
    html += linhaB1(c.nome, c.venda, c.meta_venda, c.margem, c.meta_margem, part, false, false, ranksV.get(c.nome), ranksM.get(c.nome));
  }
  html += linhaB1('TOTAL', tot.venda, tot.meta_venda, tot.margem, tot.meta_margem, 1, false, true);
  tbody.innerHTML = html;
}

// Devolve Map<nome_comprador, rank>. modo='ating' (real/meta) ou 'diff' (real-meta).
// Em ambos: 1 = pior (menor atingimento OU mais negativo em $).
function ranksB1Por(cs, keyReal, keyMeta, modo) {
  const enriched = [];
  for (const c of cs) {
    const real = c[keyReal], meta = c[keyMeta];
    if (real == null || !meta) continue;
    const v = modo === 'diff' ? (real - meta) : (real / meta);
    enriched.push({ nome: c.nome, v });
  }
  enriched.sort((a, b) => a.v - b.v);
  const map = new Map();
  enriched.forEach((x, i) => map.set(x.nome, i + 1));
  return map;
}

function linhaB1(nome, venda, metaVenda, margem, metaMargem, part, ehGerente, ehTotal, rankV, rankM) {
  const diffV  = (venda != null && metaVenda) ? venda - metaVenda : null;
  const atingV = (venda != null && metaVenda) ? venda / metaVenda : null;
  const margPct = (venda && margem) ? margem / venda : null;
  const metaMargPct = (metaVenda && metaMargem) ? metaMargem / metaVenda : null;
  const diffM  = (margem != null && metaMargem) ? margem - metaMargem : null;
  const atingM = (margem != null && metaMargem) ? margem / metaMargem : null;
  const cls = ehTotal ? 'total' : (ehGerente ? 'gerente' : '');
  const clsDV = diffV == null ? '' : (diffV >= 0 ? 'ating-ok' : 'ating-bad');
  const clsDM = diffM == null ? '' : (diffM >= 0 ? 'ating-ok' : 'ating-bad');
  // Apenas compradores individuais clicáveis (não gerente/total)
  const isClick = !ehGerente && !ehTotal;
  const nomeHtml = isClick
    ? `<span class="comp-link" data-nome="${escapeHtml(nome)}">${escapeHtml(nome)}</span>`
    : escapeHtml(nome);
  return `
    <tr class="${cls}">
      <td>${nomeHtml}</td>
      <td class="num" data-label="Venda">${fmtRs(venda)}</td>
      <td class="num" data-label="Meta">${fmtRs(metaVenda)}</td>
      <td class="num ${clsDV}" data-label="Diff">${fmtRsP(diffV)}</td>
      <td class="num ${classAting(atingV)}" data-label="Ating">${fmtPct(atingV)}</td>
      <td class="num ${classRank(rankV)}" data-label="Rank V">${rankV ?? '—'}</td>
      <td class="num" data-label="Part %">${fmtPct(part)}</td>
      <td class="num" data-label="Margem">${fmtRs(margem)}</td>
      <td class="num" data-label="Margem %"><b>${fmtPct(margPct)}</b></td>
      <td class="num" data-label="Meta Marg.">${fmtRs(metaMargem)}</td>
      <td class="num" data-label="Meta %"><i style="color:var(--text-muted)">${fmtPct(metaMargPct)}</i></td>
      <td class="num ${clsDM}" data-label="Diff Marg.">${fmtRsP(diffM)}</td>
      <td class="num ${classAting(atingM)}" data-label="Ating Marg.">${fmtPct(atingM)}</td>
      <td class="num ${classRank(rankM)}" data-label="Rank M">${rankM ?? '—'}</td>
    </tr>
  `;
}

function renderB2() {
  const tbody = $('#tbodyB2');
  const cs = DADOS.compradores || [];
  const tot = DADOS.total || {};
  const grupos = [
    { gerente: 'André', label: '🥩 Perecível — André', agg: DADOS.gerentes?.Andre, items: cs.filter(c => c.gerente === 'André') },
    { gerente: 'Walas', label: '🛒 Mercearia — Walas', agg: DADOS.gerentes?.Walas, items: cs.filter(c => c.gerente === 'Walas') },
  ];
  const outros = cs.filter(c => !c.gerente);

  let html = '';
  for (const g of grupos) {
    for (const c of g.items) html += linhaB2(c, false);
    if (g.agg) html += linhaB2({ nome: g.label, ...g.agg }, true);
  }
  for (const c of outros) html += linhaB2(c, false);
  html += linhaB2({ nome: 'TOTAL', ...tot }, false, true);
  tbody.innerHTML = html;
}

function linhaB2(c, ehGerente, ehTotal) {
  const atingDDE = (c.dde != null && c.meta_dde) ? c.meta_dde / c.dde : null;
  const atingR   = (c.ruptura != null && c.meta_ruptura) ? c.meta_ruptura / Math.max(c.ruptura, 0.0001) : null;
  const atingQ   = (c.perda != null && c.meta_quebra) ? c.meta_quebra / Math.max(c.perda, 0.01) : null;
  const atingT   = (c.troca != null && c.meta_troca) ? c.meta_troca / Math.max(c.troca, 0.01) : null;
  const atingF   = (c.foto != null && c.meta_foto) ? c.foto / c.meta_foto : null;
  const cls = ehTotal ? 'total' : (ehGerente ? 'gerente' : '');
  const showRank = !(ehTotal || ehGerente);
  const rkText = (v) => showRank ? (v ?? '—') : '—';
  const rk = (v) => `<td class="num ${showRank ? classRank(v) : ''}">${rkText(v)}</td>`;
  const rk2 = (label, v) => `<td class="num ${showRank ? classRank(v) : ''}" data-label="${label}">${rkText(v)}</td>`;
  return `
    <tr class="${cls}">
      <td>${escapeHtml(c.nome)}</td>
      <td class="num" data-label="Valor Estq">${fmtRs(c.valor_estoque)}</td>
      <td class="num" data-label="DDE">${fmtDec(c.dde, 1)}</td>
      <td class="num" data-label="Meta DDE">${fmtDec(c.meta_dde, 0)}</td>
      <td class="num ${classAtingInverso(atingDDE)}" data-label="Ating">${fmtPct(atingDDE)}</td>
      ${rk2('Rank DDE', c.rank_dde)}
      <td class="num" data-label="Ruptura">${fmtPct(c.ruptura)}</td>
      <td class="num" data-label="Meta R.">${fmtPct(c.meta_ruptura)}</td>
      <td class="num ${classAtingInverso(atingR)}" data-label="Ating">${fmtPct(atingR)}</td>
      ${rk2('Rank R.', c.rank_ruptura)}
      <td class="num" data-label="Quebra">${fmtRs(c.perda)}</td>
      <td class="num" data-label="Meta Q.">${fmtRs(c.meta_quebra)}</td>
      <td class="num ${classAtingInverso(atingQ)}" data-label="Ating">${fmtPct(atingQ)}</td>
      ${rk2('Rank Q.', c.rank_quebra)}
      <td class="num" data-label="Troca">${fmtRs(c.troca)}</td>
      <td class="num" data-label="Meta T.">${fmtRs(c.meta_troca)}</td>
      <td class="num ${classAtingInverso(atingT)}" data-label="Ating">${fmtPct(atingT)}</td>
      ${rk2('Rank T.', c.rank_troca)}
      <td class="num" data-label="Foto">${fmtRs(c.foto)}</td>
      <td class="num" data-label="Meta Foto">${fmtRs(c.meta_foto)}</td>
      <td class="num ${classAting(atingF)}" data-label="Ating">${fmtPct(atingF)}</td>
      <td class="num ${classAting(c.ating_total)}" data-label="ATING TOTAL"><b>${fmtPct(c.ating_total)}</b></td>
      <td class="num" data-label="Premiação">${(c.premiacao && c.premiacao > 0) ? fmtRs(c.premiacao) : '—'}</td>
    </tr>
  `;
}

function statusEmoji(ating) {
  if (ating == null) return '—';
  if (ating >= 1) return '<span class="ating-ok">✓ OK</span>';
  if (ating >= 0.85) return '<span class="ating-warn">⚠ ATENÇÃO</span>';
  return '<span class="ating-bad">✗ CRÍTICO</span>';
}

function renderResumo() {
  const ger = DADOS.gerentes || {};
  function html(g) {
    if (!g) return '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';
    // inverso = true: meta MAIOR que real é melhor (atingimento = meta/real)
    const indicadores = [
      { lbl: 'Faturamento',    real: g.venda,         meta: g.meta_venda,   fmt: fmtRs,                       inverso: false },
      { lbl: 'Lucratividade',  real: g.margem,        meta: g.meta_margem,  fmt: fmtRs,                       inverso: false },
      { lbl: 'Valor Estoque',  real: g.valor_estoque, meta: null,           fmt: fmtRs,                       inverso: false },
      { lbl: 'DDE',            real: g.dde,           meta: g.meta_dde,     fmt: v => fmtDec(v, 1),           inverso: true  },
      { lbl: 'Ruptura',        real: g.ruptura,       meta: g.meta_ruptura, fmt: fmtPct,                      inverso: true  },
      { lbl: 'Quebra (R$)',    real: g.perda,         meta: g.meta_quebra,  fmt: fmtRs,                       inverso: true  },
      { lbl: 'Troca (R$)',     real: g.troca,         meta: g.meta_troca,   fmt: fmtRs,                       inverso: true  },
      { lbl: 'Foto Tabloide',  real: g.foto,          meta: g.meta_foto,    fmt: fmtRs,                       inverso: false },
    ];
    return indicadores.map(i => {
      let ating = null;
      if (i.real != null && i.meta) {
        ating = i.inverso ? i.meta / Math.max(i.real, 0.01) : i.real / i.meta;
      }
      return `
        <div class="kp-indic-row">
          <span class="lbl">${i.lbl}</span>
          <span class="real">${i.fmt(i.real)}</span>
          <span class="meta">meta: ${i.fmt(i.meta)}</span>
          <span class="ating ${classAting(ating)}">${fmtPct(ating)}</span>
          <span class="status">${statusEmoji(ating)}</span>
        </div>
      `;
    }).join('');
  }
  $('#resAndre').innerHTML = html(ger.Andre);
  $('#resWalas').innerHTML = html(ger.Walas);
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

  // Tabs Painel/Detalhado
  document.querySelectorAll('.ru-tab[data-view]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ru-tab[data-view]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const v = tab.dataset.view;
      $('#viewPainel').style.display   = v === 'painel'  ? '' : 'none';
      $('#viewDetalhe').style.display = v === 'detalhe' ? '' : 'none';
    });
  });

  // Toggle de rank do Bloco 1 (Atingimento % | Diff R$)
  document.querySelectorAll('.rk-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.rk-btn').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      rankModoB1 = b.dataset.rank;
      if (DADOS) renderB1();
    });
  });

  // Click no nome do comprador → abre modal diário
  document.addEventListener('click', e => {
    const link = e.target.closest('.comp-link');
    if (link) abrirModalDiario(link.dataset.nome);
  });
  // Modal diário — fechar
  $('#modalDiarioClose').addEventListener('click', () => $('#modalDiario').classList.remove('open'));
  $('#modalDiarioFechar').addEventListener('click', () => $('#modalDiario').classList.remove('open'));
  $('#modalDiario').addEventListener('click', e => { if (e.target.id === 'modalDiario') $('#modalDiario').classList.remove('open'); });

  const s = await api('GET', '/api/kpis/status');
  lastUpdatedAt = s.ultima_atualizacao;
  if (s.tem_dados) await carregarDados();
  pintaStatus(s);  // depois de carregar DADOS pra ter o periodo
  if (s.ultima_solicitacao && (s.ultima_solicitacao.status === 'pendente' || s.ultima_solicitacao.status === 'processando')) {
    iniciarPolling();
  }
}

init().catch(e => {
  if (e.message !== 'não autenticado') { console.error(e); alert('Falha: ' + e.message); }
});
