// ========== Estado ==========
let DADOS = null;
let me = null;
let tabAtiva = 'faturamento';

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtMoney = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtMoneyShort = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + 'M';
  if (Math.abs(v) >= 1e3) return 'R$ ' + Math.round(v / 1e3) + 'k';
  return 'R$ ' + Math.round(v);
};
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtSignedPct = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtSignedMoney = (v) => v == null || isNaN(v) ? '—' : (v >= 0 ? '+' : '') + 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const classDelta = (v) => v == null || isNaN(v) || v === 0 ? 'cell-zero' : (v > 0 ? 'cell-pos' : 'cell-neg');
const classDeltaForCard = (v) => v == null || isNaN(v) ? 'zero' : (v > 0 ? 'pos' : (v < 0 ? 'neg' : 'zero'));

const DIAS_ABREV = { 'Segunda-Feira': 'Seg', 'Terça-Feira': 'Ter', 'Quarta-Feira': 'Qua', 'Quinta-Feira': 'Qui', 'Sexta-Feira': 'Sex', 'Sábado': 'Sáb', 'Domingo': 'Dom' };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

function formatData(iso) {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function formatMesRef(s) {
  if (!s) return '—';
  const [ano, mes] = s.split('-');
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return meses[parseInt(mes, 10) - 1] + '/' + ano;
}

// ========== KPI cards ==========
function preencherKpiCard(cardId, kpi, opts = {}) {
  const root = document.getElementById(cardId);
  if (!root || !kpi) return;
  const fmt = opts.pct ? fmtPct : fmtMoney;
  const fmtSigned = opts.pct ? fmtSignedPct : fmtSignedMoney;
  // Atingimento acumulado = realizado / meta_ate_hoje
  const ating_acum = (kpi.meta_ate_hoje && kpi.realizado != null)
    ? kpi.realizado / kpi.meta_ate_hoje : null;
  const map = {
    meta_mes:      [fmt, kpi.meta_mes, 'zero'],
    meta_ate_hoje: [fmt, kpi.meta_ate_hoje, 'zero'],
    realizado:     [fmt, kpi.realizado, 'zero'],
    diff:          [fmtSigned, kpi.diff, classDeltaForCard(kpi.diff)],
    ating:         [fmtPct, kpi.ating, classDeltaForCard((kpi.ating || 0) - 1)],
    ating_acum:    [fmtPct, ating_acum, classDeltaForCard((ating_acum || 0) - 1)],
  };
  // Para Quebra/Compra: ating < 1 = bom (gastou menos), ating > 1 = ruim (gastou mais)
  if (cardId === 'cardQuebra') {
    map.ating[2]      = (kpi.ating || 0) <= 1 ? 'pos' : 'neg';
    map.ating_acum[2] = (ating_acum || 0) <= 1 ? 'pos' : 'neg';
    map.diff[2]       = (kpi.diff || 0) <= 0 ? 'pos' : 'neg';
  }
  root.querySelectorAll('[data-k]').forEach(el => {
    const key = el.dataset.k;
    const v = map[key];
    if (!v) return;
    el.textContent = v[0](v[1]);
    el.className = 'val' +
      (key === 'realizado' ? ' big' : '') +
      ((key === 'ating' || key === 'ating_acum') ? ' ating' : '') +
      ' ' + v[2];
  });
}

function renderKPIs() {
  $('#mesRef').textContent = formatMesRef(DADOS.mes_referencia);
  preencherKpiCard('cardVenda', DADOS.kpis.venda);
  preencherKpiCard('cardMargemGeral', DADOS.kpis.margem_geral);
  preencherKpiCard('cardMargemPDV', DADOS.kpis.margem_pdv);
  preencherKpiCard('cardQuebra', DADOS.kpis.quebra);
  preencherKpiCard('cardCompra', DADOS.kpis.compra);

  // Percentuais derivados (margem ÷ venda · venda−compra ÷ venda)
  const venda = DADOS.kpis?.venda?.realizado || 0;
  const margG = DADOS.kpis?.margem_geral?.realizado || 0;
  const margP = DADOS.kpis?.margem_pdv?.realizado || 0;
  const compra = DADOS.kpis?.compra?.realizado || 0;
  const elG = $('#pctMargemGeral'); if (elG) elG.textContent = fmtPct(venda ? margG / venda : null);
  const elP = $('#pctMargemPDV');   if (elP) elP.textContent = fmtPct(venda ? margP / venda : null);
  const elC = $('#pctCompraVenda'); if (elC) elC.textContent = fmtPct(venda ? (venda - compra) / venda : null);

  // Card Promoção — soma os dias fechados
  let vCom = 0, vSem = 0, mCom = 0, mSem = 0, vTot = 0;
  for (const d of (DADOS.dias || [])) {
    if (!d.fechado) continue;
    vCom += Number(d.venda_promo)      || 0;
    vSem += Number(d.venda_sem_promo)  || 0;
    mCom += Number(d.margem_com_promo) || 0;
    mSem += Number(d.margem_sem_promo) || 0;
    vTot += Number(d.realizado)        || 0;
  }
  const setTxt = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
  setTxt('vendaComPromo',   fmtMoney(vCom));
  setTxt('vendaSemPromo',   fmtMoney(vSem));
  setTxt('partComPromo',    fmtPct(vTot ? vCom / vTot : null));
  setTxt('partSemPromo',    fmtPct(vTot ? vSem / vTot : null));
  setTxt('margemComPromo',  fmtMoney(mCom));
  setTxt('margemSemPromo',  fmtMoney(mSem));
  setTxt('margemComPromoPct', fmtPct(vCom ? mCom / vCom : null));
  setTxt('margemSemPromoPct', fmtPct(vSem ? mSem / vSem : null));
}

// ========== Setores ==========
function renderSetores() {
  const root = document.querySelector('.vd-setores');
  root.innerHTML = '';
  const ordem = ['bovino', 'aves', 'linguicas', 'natalinos', 'peixes', 'suino', 'acougue_geral', 'flv', 'liquida'];
  for (const key of ordem) {
    const s = DADOS.setores[key];
    if (!s) continue;
    const t = s.totais;
    const div = document.createElement('div');
    div.className = 'setor-card' + (key === 'acougue_geral' ? ' acougue-geral' : '');
    let extra = '';
    if (t.quebra != null) {
      extra = `<div class="setor-info"><span>Quebra: <b>${fmtMoneyShort(t.quebra)}</b></span><span>${fmtPct(t.quebra_pct)}</span></div>`;
    }
    div.innerHTML = `
      <div class="setor-nome">${s.nome}</div>
      <div class="setor-venda">${fmtMoneyShort(t.venda)}</div>
      <div class="setor-info"><span>Part: <b>${fmtPct(t.part_pct)}</b></span></div>
      <div class="setor-info"><span>Margem: <b>${fmtMoneyShort(t.margem)}</b></span><span>${fmtPct(t.margem_pct)}</span></div>
      ${extra}
    `;
    root.appendChild(div);
  }
}

// ========== Gráfico ==========
function renderGrafico() {
  const svg = $('#grafico');
  const W = 1200, H = 280;
  const PAD_L = 60, PAD_R = 20, PAD_T = 20, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const dias = DADOS.dias;
  let accMeta = 0, accReal = 0;
  const pontosMeta = [], pontosReal = [];
  let maxY = 0;
  for (let i = 0; i < dias.length; i++) {
    accMeta += dias[i].meta_venda || 0;
    pontosMeta.push(accMeta);
    if (dias[i].fechado) {
      accReal += dias[i].realizado || 0;
      pontosReal.push(accReal);
    } else pontosReal.push(null);
    if (accMeta > maxY) maxY = accMeta;
    if (accReal > maxY) maxY = accReal;
  }
  if (maxY === 0) maxY = 1;

  const xAt = (i) => PAD_L + (i / Math.max(dias.length - 1, 1)) * innerW;
  const yAt = (v) => PAD_T + innerH - (v / maxY) * innerH;

  const grids = [];
  for (let i = 0; i <= 4; i++) {
    const y = PAD_T + (i / 4) * innerH;
    const valor = maxY * (1 - i / 4);
    grids.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="#1c2230"/>`);
    grids.push(`<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" fill="#6b7488" font-size="10">${fmtMoneyShort(valor)}</text>`);
  }

  const ticks = new Set([0, 4, 9, 14, 19, 24, dias.length - 1]);
  const tickLines = [];
  for (const i of ticks) {
    if (!dias[i]) continue;
    const x = xAt(i);
    tickLines.push(`<line x1="${x}" x2="${x}" y1="${PAD_T + innerH}" y2="${PAD_T + innerH + 4}" stroke="#3a4258"/>`);
    tickLines.push(`<text x="${x}" y="${PAD_T + innerH + 18}" text-anchor="middle" fill="#6b7488" font-size="10">${formatData(dias[i].data)}</text>`);
  }

  const pathMeta = pontosMeta.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');

  let pathReal = '', started = false;
  for (let i = 0; i < pontosReal.length; i++) {
    if (pontosReal[i] != null) {
      pathReal += (started ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(pontosReal[i]).toFixed(1) + ' ';
      started = true;
    } else if (started) break;
  }

  let marker = '';
  const lastReal = pontosReal.findIndex(v => v == null);
  const lastIdx = lastReal === -1 ? pontosReal.length - 1 : lastReal - 1;
  if (lastIdx >= 0 && pontosReal[lastIdx] != null) {
    marker = `<circle cx="${xAt(lastIdx).toFixed(1)}" cy="${yAt(pontosReal[lastIdx]).toFixed(1)}" r="4" fill="#4ade80"/>`;
  }

  svg.innerHTML = `
    ${grids.join('')}
    ${tickLines.join('')}
    <path d="${pathMeta}" fill="none" stroke="#3b6dab" stroke-width="2" stroke-dasharray="4 3"/>
    <path d="${pathReal}" fill="none" stroke="#4ade80" stroke-width="2.5"/>
    ${marker}
    <g transform="translate(${PAD_L + 8},${PAD_T + 8})">
      <rect width="170" height="42" rx="4" fill="#0f1218" stroke="#232938"/>
      <line x1="10" x2="30" y1="14" y2="14" stroke="#3b6dab" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="36" y="18" fill="#c5cad4" font-size="11">Meta acumulada</text>
      <line x1="10" x2="30" y1="30" y2="30" stroke="#4ade80" stroke-width="2.5"/>
      <text x="36" y="34" fill="#c5cad4" font-size="11">Realizado acumulado</text>
    </g>
  `;
}

// ========== Resumo ==========
function renderResumo() {
  const dias = DADOS.dias;
  const metaMes = DADOS.kpis.venda.meta_mes || 0;
  let realizadoMTD = 0, metaMTD = 0, fechados = 0, acima = 0, abaixo = 0;
  let melhor = null, pior = null;
  for (const d of dias) {
    if (!d.fechado) continue;
    realizadoMTD += d.realizado || 0;
    metaMTD += d.meta_venda || 0;
    fechados++;
    const dif = (d.realizado || 0) - (d.meta_venda || 0);
    if (dif >= 0) acima++; else abaixo++;
    if (!melhor || dif > ((melhor.realizado || 0) - (melhor.meta_venda || 0))) melhor = d;
    if (!pior || dif < ((pior.realizado || 0) - (pior.meta_venda || 0))) pior = d;
  }
  let streak = 0, dir = 0;
  for (let i = dias.length - 1; i >= 0; i--) {
    const d = dias[i]; if (!d.fechado) continue;
    const cd = ((d.realizado || 0) >= (d.meta_venda || 0)) ? 1 : -1;
    if (dir === 0) { dir = cd; streak = 1; }
    else if (cd === dir) streak++; else break;
  }
  const projecao = fechados > 0 ? (realizadoMTD / fechados) * dias.length : 0;
  const restante = metaMes - realizadoMTD;
  const diasRest = dias.length - fechados;

  const root = $('#vdResumo');
  const pills = [];
  pills.push(`<div class="pill ${acima >= abaixo ? 'up' : 'down'}">Acima: <b>${acima}</b> · Abaixo: <b>${abaixo}</b> dias</div>`);
  if (streak > 0) {
    const cls = dir > 0 ? 'up' : 'down';
    const arrow = dir > 0 ? '↑' : '↓';
    pills.push(`<div class="pill ${cls}">Sequência: <b>${streak} dia${streak>1?'s':''} ${arrow}</b></div>`);
  }
  if (melhor) {
    const dif = (melhor.realizado || 0) - (melhor.meta_venda || 0);
    pills.push(`<div class="pill up">Melhor dia: <b>${formatData(melhor.data)} ${DIAS_ABREV[melhor.dia_semana]||''}</b> · ${fmtSignedMoney(dif)}</div>`);
  }
  if (pior && pior !== melhor) {
    const dif = (pior.realizado || 0) - (pior.meta_venda || 0);
    pills.push(`<div class="pill down">Pior dia: <b>${formatData(pior.data)} ${DIAS_ABREV[pior.dia_semana]||''}</b> · ${fmtSignedMoney(dif)}</div>`);
  }
  pills.push(`<div class="pill">Projeção fim de mês: <b>${fmtMoneyShort(projecao)}</b></div>`);
  if (diasRest > 0 && restante > 0) {
    pills.push(`<div class="pill">Pra fechar a meta: <b>${fmtMoneyShort(restante / diasRest)}/dia</b> em ${diasRest} dias</div>`);
  } else if (restante <= 0) {
    pills.push(`<div class="pill up">Meta do mês atingida · sobra <b>${fmtMoneyShort(-restante)}</b></div>`);
  }
  root.innerHTML = pills.join('');
}

// ========== Tabelas (com abas) ==========
const TABS = {
  faturamento: {
    cols: [
      { lbl: 'Data', kind: 'data' },
      { lbl: 'Dia', kind: 'dia' },
      { lbl: 'Meta',          k: 'meta_venda', kind: 'money' },
      { lbl: 'Realizado',     k: 'realizado', kind: 'money', pendente: true },
      { lbl: 'Δ R$',          kind: 'calc-diff', meta: 'meta_venda', real: 'realizado' },
      { lbl: 'Δ %',           k: 'diff_pct', kind: 'pct-signed', pendente: true },
      { lbl: 'c/ Promo',      k: 'venda_promo', kind: 'money', pendente: true },
      { lbl: '% c/Pr',        k: 'pct_promo', kind: 'pct', pendente: true },
      { lbl: 's/ Promo',      k: 'venda_sem_promo', kind: 'money', pendente: true },
      { lbl: '% s/Pr',        k: 'pct_sem_promo', kind: 'pct', pendente: true },
    ],
  },
  margem: {
    cols: [
      { lbl: 'Data', kind: 'data' },
      { lbl: 'Dia', kind: 'dia' },
      { lbl: 'Meta Geral',    k: 'meta_margem_geral', kind: 'money' },
      { lbl: 'Realizado',     k: 'margem_realizada', kind: 'money', pendente: true },
      { lbl: 'Δ R$',          kind: 'calc-diff', meta: 'meta_margem_geral', real: 'margem_realizada' },
      { lbl: 'Δ %',           k: 'margem_diff_pct', kind: 'pct', pendente: true },
      { lbl: 'Verba',         k: 'verba', kind: 'money', pendente: true },
      { lbl: '% Verba',       k: 'verba_pct', kind: 'pct', pendente: true },
      { lbl: 'Meta PDV',      k: 'meta_margem_pdv', kind: 'money' },
      { lbl: 'Margem PDV',    k: 'margem_pdv', kind: 'money', pendente: true },
      { lbl: 'Δ PDV R$',      kind: 'calc-diff', meta: 'meta_margem_pdv', real: 'margem_pdv' },
      { lbl: '% PDV',         k: 'margem_pdv_diff_pct', kind: 'pct', pendente: true },
      { lbl: 'Acordo',        k: 'acordo_recebido', kind: 'money', pendente: true },
      { lbl: '% Acordo',      k: 'acordo_pct', kind: 'pct', pendente: true },
      { lbl: 'M s/Pr',        k: 'margem_sem_promo', kind: 'money', pendente: true },
      { lbl: '% s/Pr',        k: 'margem_sem_promo_pct', kind: 'pct', pendente: true },
      { lbl: 'M c/Pr',        k: 'margem_com_promo', kind: 'money', pendente: true },
      { lbl: '% c/Pr',        k: 'margem_com_promo_pct', kind: 'pct', pendente: true },
    ],
  },
  quebras: {
    cols: [
      { lbl: 'Data', kind: 'data' },
      { lbl: 'Dia', kind: 'dia' },
      { lbl: 'Quebras',       k: 'quebras', kind: 'money', pendente: true },
      { lbl: '% Quebras',     k: 'quebras_pct', kind: 'pct', pendente: true },
      { lbl: 'Inventário',    k: 'inventario', kind: 'money', pendente: true },
      { lbl: '% Invent',      k: 'inventario_pct', kind: 'pct', pendente: true },
      { lbl: 'Compra',        k: 'compra', kind: 'money', pendente: true },
      { lbl: '851',           k: 'compra_851', kind: 'money', pendente: true },
      { lbl: 'Realizado',     k: 'compra_realizado', kind: 'money', pendente: true },
    ],
  },
  acougue: {
    cols: [
      { lbl: 'Data', kind: 'data' },
      { lbl: 'Dia', kind: 'dia' },
      { lbl: 'Bovino',        kind: 'setor', setor: 'bovino', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'bovino', sk: 'margem_pct' },
      { lbl: 'Aves',          kind: 'setor', setor: 'aves', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'aves', sk: 'margem_pct' },
      { lbl: 'Linguiças',     kind: 'setor', setor: 'linguicas', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'linguicas', sk: 'margem_pct' },
      { lbl: 'Natalinos',     kind: 'setor', setor: 'natalinos', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'natalinos', sk: 'margem_pct' },
      { lbl: 'Peixes',        kind: 'setor', setor: 'peixes', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'peixes', sk: 'margem_pct' },
      { lbl: 'Suíno',         kind: 'setor', setor: 'suino', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'suino', sk: 'margem_pct' },
      { lbl: 'Açougue Total', kind: 'setor', setor: 'acougue_geral', sk: 'venda' },
      { lbl: 'M%',            kind: 'setor', setor: 'acougue_geral', sk: 'margem_pct' },
    ],
  },
  'flv-liquida': {
    cols: [
      { lbl: 'Data', kind: 'data' },
      { lbl: 'Dia', kind: 'dia' },
      { lbl: 'FLV Venda',     kind: 'setor', setor: 'flv', sk: 'venda' },
      { lbl: 'FLV Part%',     kind: 'setor', setor: 'flv', sk: 'part_pct' },
      { lbl: 'FLV Margem',    kind: 'setor', setor: 'flv', sk: 'margem' },
      { lbl: 'FLV M%',        kind: 'setor', setor: 'flv', sk: 'margem_pct' },
      { lbl: 'FLV Quebra',    kind: 'setor', setor: 'flv', sk: 'quebra' },
      { lbl: 'FLV Q%',        kind: 'setor', setor: 'flv', sk: 'quebra_pct' },
      { lbl: 'Liquida Venda', kind: 'setor', setor: 'liquida', sk: 'venda' },
      { lbl: 'Liquida Part%', kind: 'setor', setor: 'liquida', sk: 'part_pct' },
      { lbl: 'Liquida Marg.', kind: 'setor', setor: 'liquida', sk: 'margem' },
      { lbl: 'Liquida M%',    kind: 'setor', setor: 'liquida', sk: 'margem_pct' },
    ],
  },
};

function renderTabela() {
  const tab = TABS[tabAtiva];
  if (!tab) return;
  const thead = $('#theadVendas');
  const tbody = $('#tbodyVendas');
  thead.innerHTML = '<tr>' + tab.cols.map(c => {
    const isNum = !['data', 'dia'].includes(c.kind);
    return `<th class="${isNum ? 'num' : ''}">${c.lbl}</th>`;
  }).join('') + '</tr>';

  const dataHoje = new Date().toISOString().slice(0, 10);
  const dias = DADOS.dias;
  const setoresPorData = {};
  for (const [skey, sdata] of Object.entries(DADOS.setores)) {
    setoresPorData[skey] = {};
    for (const d of sdata.dias) setoresPorData[skey][d.data] = d;
  }

  const linhas = [];
  for (let i = 0; i < dias.length; i++) {
    const d = dias[i];
    const isFimSem = d.dia_semana === 'Sábado' || d.dia_semana === 'Domingo';
    const isHoje = d.data === dataHoje;
    const classes = [];
    if (!d.fechado) classes.push('pendente');
    if (isFimSem) classes.push('fim-semana');
    if (isHoje) classes.push('hoje');
    if (d.fechado) {
      const dif = (d.realizado || 0) - (d.meta_venda || 0);
      classes.push(dif >= 0 ? 'acima' : 'abaixo');
    }

    const tds = tab.cols.map(c => {
      if (c.kind === 'data') return `<td>${formatData(d.data)}</td>`;
      if (c.kind === 'dia')  return `<td><span class="dia-label">${DIAS_ABREV[d.dia_semana] || d.dia_semana}</span></td>`;
      let val, html;
      if (c.kind === 'setor') {
        const sd = (setoresPorData[c.setor] || {})[d.data];
        val = sd ? sd[c.sk] : null;
        if (c.sk === 'part_pct' || c.sk === 'margem_pct' || c.sk === 'quebra_pct') html = fmtPct(val);
        else html = (sd && sd.fechado) ? fmtMoney(val) : '—';
      } else if (c.kind === 'calc-diff') {
        if (!d.fechado) html = '—';
        else { val = (d[c.real] || 0) - (d[c.meta] || 0); html = `<span class="${classDelta(val)}">${fmtSignedMoney(val)}</span>`; }
      } else if (c.kind === 'money') {
        val = d[c.k];
        html = (c.pendente && !d.fechado) ? '—' : fmtMoney(val);
      } else if (c.kind === 'pct') {
        val = d[c.k];
        html = (c.pendente && !d.fechado) ? '—' : fmtPct(val);
      } else if (c.kind === 'pct-signed') {
        val = d[c.k];
        if (c.pendente && !d.fechado) html = '—';
        else html = `<span class="${classDelta(val)}">${fmtSignedPct(val)}</span>`;
      }
      return `<td class="num">${html}</td>`;
    }).join('');

    linhas.push(`<tr class="${classes.join(' ')}">${tds}</tr>`);
  }

  // Linha total
  const totalTds = tab.cols.map((c, i) => {
    if (i === 0) return `<td>TOTAL</td>`;
    if (i === 1) return `<td></td>`;
    if (c.kind === 'setor') {
      const t = DADOS.setores[c.setor]?.totais || {};
      const v = t[c.sk];
      if (c.sk === 'part_pct' || c.sk === 'margem_pct' || c.sk === 'quebra_pct') return `<td class="num">${fmtPct(v)}</td>`;
      return `<td class="num">${fmtMoney(v)}</td>`;
    }
    if (c.kind === 'calc-diff') {
      const t = DADOS.totais_principal || {};
      const v = (t[c.real] || 0) - (t[c.meta] || 0);
      return `<td class="num"><span class="${classDelta(v)}">${fmtSignedMoney(v)}</span></td>`;
    }
    if (c.kind === 'money') {
      const v = DADOS.totais_principal?.[c.k];
      return `<td class="num">${fmtMoney(v)}</td>`;
    }
    if (c.kind === 'pct' || c.kind === 'pct-signed') {
      const v = DADOS.totais_principal?.[c.k];
      return `<td class="num">${c.kind === 'pct-signed' ? fmtSignedPct(v) : fmtPct(v)}</td>`;
    }
    return `<td></td>`;
  }).join('');
  linhas.push(`<tr class="total">${totalTds}</tr>`);

  tbody.innerHTML = linhas.join('');
}

// ========== Export ==========
function exportarCSV() {
  const tab = TABS[tabAtiva];
  const fmtN = (v) => v == null || isNaN(v) ? '' : v.toFixed(2).replace('.', ',');
  const linhas = [tab.cols.map(c => `"${c.lbl}"`).join(';')];
  const setoresPorData = {};
  for (const [skey, sdata] of Object.entries(DADOS.setores)) {
    setoresPorData[skey] = {};
    for (const d of sdata.dias) setoresPorData[skey][d.data] = d;
  }
  for (const d of DADOS.dias) {
    const cells = tab.cols.map(c => {
      if (c.kind === 'data') return d.data || '';
      if (c.kind === 'dia') return d.dia_semana || '';
      if (c.kind === 'setor') {
        const sd = (setoresPorData[c.setor] || {})[d.data];
        return fmtN(sd ? sd[c.sk] : null);
      }
      if (c.kind === 'calc-diff') {
        if (!d.fechado) return '';
        return fmtN((d[c.real] || 0) - (d[c.meta] || 0));
      }
      return fmtN(d[c.k]);
    });
    linhas.push(cells.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';'));
  }
  const blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `vendas_${tabAtiva}_${DADOS.mes_referencia || 'mes'}.csv`;
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

  $('#btnExport').addEventListener('click', exportarCSV);

  $$('.vd-tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.vd-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tabAtiva = btn.dataset.tab;
    renderTabela();
  }));

  try {
    DADOS = await api('GET', '/api/vendas');
  } catch (err) {
    document.querySelector('.main-content').innerHTML = `
      <div style="padding:32px;color:#ffb3bf;">
        <h2>Não consegui carregar os dados de venda diária</h2>
        <p>${err.message}</p>
        <p style="color:#8b95a7">Rode <code>./atualizar_dados.sh</code> no servidor pra gerar os dados.</p>
      </div>`;
    return;
  }

  renderKPIs();
  renderSetores();
  renderGrafico();
  renderResumo();
  renderTabela();

  setInterval(async () => {
    try {
      DADOS = await api('GET', '/api/vendas');
      renderKPIs(); renderSetores(); renderGrafico(); renderResumo(); renderTabela();
    } catch {}
  }, 60000);
}

init().catch(e => {
  if (e.message !== 'não autenticado') {
    console.error(e);
    alert('Falha: ' + e.message);
  }
});
