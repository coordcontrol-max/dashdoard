// Render PDF da Venda Diária — visão completa em 1 página A4 paisagem.
// Inclui: cabeçalho, 6 KPI cards, setores e tabela de dias (Faturamento).

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtRs = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v / 1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};
// Mesma função, mas sem o prefixo R$ — pra economizar espaço na tabela
const fmtK = (v) => {
  if (v == null || isNaN(v) || v === 0) return '—';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2).replace('.', ',') + 'M';
  if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + 'k';
  return Math.round(v).toLocaleString('pt-BR');
};
const fmtRsSig = (v) => {
  if (v == null || isNaN(v) || v === 0) return '—';
  return (v < 0 ? '-' : '+') + 'R$ ' + Math.abs(Math.round(v)).toLocaleString('pt-BR');
};
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtPctSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + '%';
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const DIAS_ABR = { 'Segunda-Feira': 'Seg', 'Terça-Feira': 'Ter', 'Quarta-Feira': 'Qua', 'Quinta-Feira': 'Qui', 'Sexta-Feira': 'Sex', 'Sábado': 'Sáb', 'Domingo': 'Dom' };

function nomeMes(mesRef) {
  if (!mesRef) return '';
  const [a, m] = mesRef.split('-');
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return `${meses[parseInt(m, 10) - 1]}/${a}`;
}

function classDelta(v) {
  if (v == null || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}

function classQuebra(v) {
  if (v == null || v === 0) return '';
  return v <= 0 ? 'pos' : 'neg';
}

// ===== Card KPI compacto =====
function renderCard(titulo, kpi, opts = {}) {
  if (!kpi) return '';
  const venda = opts.vendaRef || 0;
  const realizado = kpi.realizado || 0;
  const ating_acum = (kpi.meta_ate_hoje && realizado != null) ? realizado / kpi.meta_ate_hoje : null;
  const ating_total = kpi.ating;
  const inverso = opts.inverso || false;
  const clsTotal = inverso ? ((ating_total || 0) <= 1 ? 'pos' : 'neg') : classDelta((ating_total || 0) - 1);
  const clsAcum  = inverso ? ((ating_acum  || 0) <= 1 ? 'pos' : 'neg') : classDelta((ating_acum  || 0) - 1);
  const clsDiff  = inverso ? ((kpi.diff || 0) <= 0 ? 'pos' : 'neg') : classDelta(kpi.diff);

  let extra = '';
  if (opts.extraLabel) {
    extra = `<div class="card-extra"><span class="lbl">${opts.extraLabel}</span><span class="val">${opts.extraValue}</span></div>`;
  }

  return `
    <div class="card ${opts.primary ? 'primary' : ''}">
      <div class="card-title">${titulo}</div>
      <div class="card-grid">
        <div><span class="lbl">Meta mês</span><span class="val">${fmtRsK(kpi.meta_mes)}</span></div>
        <div><span class="lbl">Meta hoje</span><span class="val">${fmtRsK(kpi.meta_ate_hoje)}</span></div>
        <div><span class="lbl">Realizado</span><span class="val big">${fmtRsK(realizado)}</span></div>
        <div><span class="lbl">Diff</span><span class="val ${clsDiff}">${fmtRsSig(kpi.diff)}</span></div>
        <div><span class="lbl">At Total</span><span class="val ${clsTotal}">${fmtPct(ating_total)}</span></div>
        <div><span class="lbl">At Acum</span><span class="val ${clsAcum}">${fmtPct(ating_acum)}</span></div>
        ${extra}
      </div>
    </div>
  `;
}

function renderCardPromo(dias, vendaTotal) {
  let vCom = 0, vSem = 0, mCom = 0, mSem = 0;
  for (const d of (dias || [])) {
    if (!d.fechado) continue;
    vCom += Number(d.venda_promo)      || 0;
    vSem += Number(d.venda_sem_promo)  || 0;
    mCom += Number(d.margem_com_promo) || 0;
    mSem += Number(d.margem_sem_promo) || 0;
  }
  return `
    <div class="card">
      <div class="card-title">Promoção</div>
      <div class="card-grid">
        <div><span class="lbl">Venda c/ promo</span><span class="val">${fmtRsK(vCom)}</span></div>
        <div><span class="lbl">Part %</span><span class="val">${fmtPct(vendaTotal ? vCom / vendaTotal : null)}</span></div>
        <div><span class="lbl">Venda s/ promo</span><span class="val">${fmtRsK(vSem)}</span></div>
        <div><span class="lbl">Part %</span><span class="val">${fmtPct(vendaTotal ? vSem / vendaTotal : null)}</span></div>
        <div><span class="lbl">Mg c/ promo</span><span class="val">${fmtRsK(mCom)}</span></div>
        <div><span class="lbl">Mg %</span><span class="val">${fmtPct(vCom ? mCom / vCom : null)}</span></div>
        <div><span class="lbl">Mg s/ promo</span><span class="val">${fmtRsK(mSem)}</span></div>
        <div><span class="lbl">Mg %</span><span class="val">${fmtPct(vSem ? mSem / vSem : null)}</span></div>
      </div>
    </div>
  `;
}

// ===== Setores =====
function renderSetores(setores) {
  const ordem = ['bovino', 'aves', 'linguicas', 'natalinos', 'peixes', 'suino', 'acougue_geral', 'flv', 'liquida'];
  return ordem.map(k => {
    const s = setores?.[k];
    if (!s) return '';
    const t = s.totais || {};
    return `
      <div class="setor">
        <div class="s-nome">${escapeHtml(s.nome || k.toUpperCase())}</div>
        <div class="s-venda">${fmtRsK(t.venda)}</div>
        <div class="s-info"><span>Part:</span><b>${fmtPct(t.part_pct)}</b></div>
        <div class="s-info"><span>Mg:</span><b>${fmtPct(t.margem_pct)}</b></div>
      </div>
    `;
  }).join('');
}

// ===== Tabela dos dias (Faturamento) =====
function renderTabelaDias(dias) {
  let html = `
    <table class="dias">
      <colgroup>
        <col class="c-dt"><col class="c-dia">
        <col class="c-num"><col class="c-num"><col class="c-pct">
        <col class="c-num"><col class="c-num"><col class="c-pct">
        <col class="c-num"><col class="c-pct">
        <col class="c-num"><col class="c-num"><col class="c-num">
      </colgroup>
      <thead>
        <tr>
          <th>Data</th>
          <th>Dia</th>
          <th>Meta Venda</th>
          <th>Venda</th>
          <th>Diff %</th>
          <th>Meta Mg</th>
          <th>Margem</th>
          <th>Mg %</th>
          <th>Mg PDV</th>
          <th>Mg PDV %</th>
          <th>Verba</th>
          <th>Quebra</th>
          <th>Compra</th>
        </tr>
      </thead>
      <tbody>
  `;
  let totMV = 0, totV = 0, totMM = 0, totM = 0, totMP = 0, totVerba = 0, totQ = 0, totC = 0;
  for (const d of (dias || [])) {
    const fechado = !!d.fechado;
    if (fechado) {
      totMV += Number(d.meta_venda)        || 0;
      totV  += Number(d.realizado)         || 0;
      totMM += Number(d.meta_margem_geral) || 0;
      totM  += Number(d.margem_realizada)  || 0;
      totMP += Number(d.margem_pdv)        || 0;
      totVerba += Number(d.verba)          || 0;
      totQ  += Number(d.quebras)           || 0;
      totC  += Number(d.compra)            || 0;
    }
    const diff = (d.diff_rs != null) ? d.diff_rs : null;
    const diffPct = (d.diff_pct != null) ? d.diff_pct : null;
    const mgPct = (d.realizado && d.margem_realizada) ? d.margem_realizada / d.realizado : null;
    const mgPdvPct = (d.realizado && d.margem_pdv) ? d.margem_pdv / d.realizado : null;
    html += `
      <tr class="${fechado ? '' : 'pendente'}">
        <td>${fmtData(d.data)}</td>
        <td>${escapeHtml(DIAS_ABR[d.dia_semana] || d.dia_semana || '')}</td>
        <td>${fmtK(d.meta_venda)}</td>
        <td><b>${fmtK(d.realizado)}</b></td>
        <td class="${classDelta(diffPct)}">${fmtPctSig(diffPct)}</td>
        <td>${fmtK(d.meta_margem_geral)}</td>
        <td>${fmtK(d.margem_realizada)}</td>
        <td>${fmtPct(mgPct)}</td>
        <td>${fmtK(d.margem_pdv)}</td>
        <td>${fmtPct(mgPdvPct)}</td>
        <td>${fmtK(d.verba)}</td>
        <td>${fmtK(d.quebras)}</td>
        <td>${fmtK(d.compra)}</td>
      </tr>
    `;
  }
  const mgTotPct = totV ? totM / totV : null;
  const mgPdvTotPct = totV ? totMP / totV : null;
  const diffPctTotal = totMV ? (totV - totMV) / totMV : null;
  html += `
    <tr class="total">
      <td colspan="2">TOTAL</td>
      <td>${fmtK(totMV)}</td>
      <td>${fmtK(totV)}</td>
      <td class="${classDelta(diffPctTotal)}">${fmtPctSig(diffPctTotal)}</td>
      <td>${fmtK(totMM)}</td>
      <td>${fmtK(totM)}</td>
      <td>${fmtPct(mgTotPct)}</td>
      <td>${fmtK(totMP)}</td>
      <td>${fmtPct(mgPdvTotPct)}</td>
      <td>${fmtK(totVerba)}</td>
      <td>${fmtK(totQ)}</td>
      <td>${fmtK(totC)}</td>
    </tr>
  `;
  html += `</tbody></table>`;
  return html;
}

export function renderPaginaVDResumoPDF(data) {
  if (!data || !data.dias) {
    return `<!doctype html><html><body><h1>Sem dados</h1></body></html>`;
  }

  const k = data.kpis || {};
  const venda = k.venda?.realizado || 0;
  // CxV
  const compraReal = k.compra?.realizado || 0;
  const cxv = venda ? (venda - compraReal) / venda : null;
  // Margem % sobre venda
  const margemPct = venda ? (k.margem_geral?.realizado || 0) / venda : null;
  const margemPdvPct = venda ? (k.margem_pdv?.realizado || 0) / venda : null;

  const dataGeracao = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Venda Diária — ${nomeMes(data.mes_referencia)}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  html, body {
    font-family: Aptos, "Aptos Display", "Segoe UI", system-ui, sans-serif;
    margin: 0; padding: 0; color: #1a1a1a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    font-size: 6pt;
  }

  .header {
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1px solid #1f6b35;
    padding-bottom: 1px;
    margin-bottom: 2px;
  }
  .header h1 { font-size: 9pt; margin: 0; color: #1f6b35; }
  .header .meta { font-size: 6pt; color: #666; }

  /* Cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 3px;
    margin-bottom: 3px;
  }
  .card {
    background: #f8fafd;
    border: 1px solid #cdd5df;
    border-radius: 3px;
    padding: 3px 5px;
    min-width: 0;
    overflow: hidden;
  }
  .card.primary { background: #e8f4ff; border-color: #1976d2; }
  .card-title {
    font-size: 6.2pt; font-weight: 700;
    color: #1f6b35;
    text-transform: uppercase; letter-spacing: .2px;
    margin-bottom: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 3px;
  }
  .card-grid > div { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .card-grid .lbl {
    font-size: 5pt; color: #666;
    text-transform: uppercase; letter-spacing: .1px;
    line-height: 1.05;
  }
  .card-grid .val {
    font-size: 6.5pt; font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card-grid .val.big { font-size: 7.5pt; }
  .card-grid .val.pos { color: #1a8f4f; }
  .card-grid .val.neg { color: #c0392b; }
  .card-extra {
    grid-column: 1 / -1;
    padding-top: 1px;
    border-top: 1px solid #ddd;
    margin-top: 1px;
    display: flex; justify-content: space-between;
  }
  .card-extra .lbl { font-size: 5pt; }
  .card-extra .val { font-size: 6.5pt; }

  /* Setores */
  .setores {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 2px;
    margin-bottom: 3px;
  }
  .setor {
    background: #f8fafd;
    border: 1px solid #cdd5df;
    border-radius: 3px;
    padding: 2px 4px;
    min-width: 0;
    overflow: hidden;
  }
  .s-nome {
    font-size: 5.5pt; font-weight: 700;
    color: #1f6b35;
    text-transform: uppercase;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .s-venda {
    font-size: 7pt; font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  .s-info {
    font-size: 5.5pt;
    display: flex; justify-content: space-between;
    line-height: 1.2;
  }
  .s-info span { color: #666; }
  .s-info b { font-variant-numeric: tabular-nums; }

  /* Tabela dias — larguras fixas pra forçar ajuste na página */
  table.dias {
    width: 100%;
    border-collapse: collapse;
    font-size: 6pt;
    table-layout: fixed;
  }
  table.dias col.c-dt    { width: 4.5%; }
  table.dias col.c-dia   { width: 3.5%; }
  table.dias col.c-num   { width: 7.7%; }
  table.dias col.c-pct   { width: 5.5%; }
  table.dias thead th {
    background: #1f6b35;
    color: white;
    padding: 1.5px 1px;
    font-weight: 700;
    font-size: 5.3pt;
    border: 0.5px solid #144826;
    text-align: right;
    text-transform: uppercase;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  table.dias thead th:first-child,
  table.dias thead th:nth-child(2) { text-align: left; }
  table.dias tbody td {
    padding: 0.8px 2px;
    border-bottom: 0.5px solid #ddd;
    text-align: right;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  table.dias tbody td:first-child,
  table.dias tbody td:nth-child(2) { text-align: left; font-weight: 600; }
  table.dias tbody tr:nth-child(even) td { background: #f5f7fa; }
  table.dias tbody tr.pendente td { color: #aaa; font-style: italic; }
  table.dias tbody tr.total td {
    background: #fce4a6 !important;
    font-weight: 700;
    border-top: 1px solid #d4a017;
    border-bottom: 1px solid #d4a017;
    color: #222;
  }
  td.pos { color: #1a8f4f; font-weight: 700; }
  td.neg { color: #c0392b; font-weight: 700; }
</style>
</head>
<body>
  <div class="header">
    <h1>Venda Diária — Acompanhamento Meta vs Realizado · ${nomeMes(data.mes_referencia)}</h1>
    <div class="meta">Valores em R$ · M = milhão, k = mil · Gerado em ${dataGeracao}</div>
  </div>

  <div class="cards">
    ${renderCard('Faturamento', k.venda, { primary: true })}
    ${renderCard('Margem Total %', k.margem_geral, { extraLabel: '% sobre venda', extraValue: fmtPct(margemPct) })}
    ${renderCard('Margem PDV %', k.margem_pdv, { extraLabel: '% sobre venda', extraValue: fmtPct(margemPdvPct) })}
    ${renderCardPromo(data.dias, venda)}
    ${renderCard('Quebra', k.quebra, { inverso: true })}
    ${renderCard('Compra', k.compra, { inverso: true, extraLabel: 'CxV', extraValue: fmtPct(cxv) })}
  </div>

  <div class="setores">
    ${renderSetores(data.setores)}
  </div>

  ${renderTabelaDias(data.dias)}

  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 200));</script>
</body>
</html>`;
}
