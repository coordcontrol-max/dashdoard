// Server-side render do relatório PDF de venda diária.
// Devolve HTML completo (com CSS inline) sem dependência de fetch/JS no cliente.

const fmtMoney = (v) => v == null || isNaN(v) || v === 0 ? '-' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtMoneySigned = (v) => {
  if (v == null || isNaN(v) || v === 0) return '-';
  return (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Math.round(v)).toLocaleString('pt-BR');
};
const fmtPct = (v) => v == null || isNaN(v) ? '-' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtPctSigned = (v) => {
  if (v == null || isNaN(v)) return '-';
  return (v >= 0 ? '' : '-') + Math.abs(v * 100).toFixed(2).replace('.', ',') + '%';
};
const cellMoney = (v) => {
  if (v == null || isNaN(v) || v === 0) return '<td class="zero">-</td>';
  return `<td>${fmtMoney(v)}</td>`;
};
const cellMoneySigned = (v) => {
  if (v == null || isNaN(v) || v === 0) return '<td class="zero">-</td>';
  return `<td class="${v < 0 ? 'neg' : 'pos'}">${fmtMoneySigned(v)}</td>`;
};
const cellPct = (v) => {
  if (v == null || isNaN(v)) return '<td class="zero">-</td>';
  return `<td>${fmtPct(v)}</td>`;
};
const cellPctSigned = (v) => {
  if (v == null || isNaN(v)) return '<td class="zero">-</td>';
  return `<td class="${v < 0 ? 'neg' : 'pos'}">${fmtPctSigned(v)}</td>`;
};

function fmtData(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function nomeMes(mes_ref) {
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [ano, mes] = (mes_ref || '').split('-');
  return `${meses[parseInt(mes,10) - 1]}/${ano.slice(2)}`;
}

const DIAS_ABREV = {'Segunda-Feira':'Seg','Terça-Feira':'Ter','Quarta-Feira':'Qua','Quinta-Feira':'Qui','Sexta-Feira':'Sex','Sábado':'Sáb','Domingo':'Dom'};

function renderBlocoFaturamento(data) {
  const dias = data.dias;
  const tot = data.totais_principal;

  let html = `
    <div class="bloco-header">
      <span class="mes">${nomeMes(data.mes_referencia)}</span>
      <span class="tipo">METAS X REALIZADO</span>
    </div>
    <table>
      <thead>
        <tr>
          <th rowspan="2" class="section-head">DATA</th>
          <th rowspan="2" class="section-head">DIA</th>
          <th colspan="8" class="section-head">FATURAMENTO</th>
          <th colspan="16" class="section-head">MARGEM</th>
          <th colspan="4" class="section-head">QUEBRAS E INVENTÁRIOS</th>
          <th colspan="2" class="section-head">COMPRA</th>
        </tr>
        <tr>
          <th>META VENDA</th><th>REALIZADO</th><th>DIFF (R$)</th><th>(%)</th>
          <th>VENDA C/PROMOÇÃO</th><th>(%)</th><th>VENDA S/PROMOÇÃO</th><th>(%)</th>

          <th>META MARGEM GERAL</th><th>REALIZADO + ACORDO 20</th><th>DIFF (R$)</th><th>(%)</th>
          <th>VERBA</th><th>(%)</th>
          <th>META MARGEM PDV</th><th>MARGEM PDV</th><th>DIFF (R$)</th><th>(%)</th>
          <th>ACORDO RECEBIDO</th><th>(%)</th>
          <th>MARGEM S/PROMOÇÃO</th><th>(%)</th>
          <th>MARGEM C/PROMOÇÃO</th><th>(%)</th>

          <th>QUEBRAS</th><th>(%)</th>
          <th>INVENTÁRIO</th><th>(%)</th>

          <th>COMPRA</th><th>REALIZADO</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const d of dias) {
    const diaCurto = DIAS_ABREV[d.dia_semana] || d.dia_semana || '';
    const cls = d.fechado ? '' : 'pendente';
    html += `<tr class="${cls}">`;
    html += `<td class="col-data">${fmtData(d.data)}</td>`;
    html += `<td class="col-dia">${diaCurto}</td>`;
    html += cellMoney(d.meta_venda);
    html += cellMoney(d.realizado);
    html += cellMoneySigned(d.diff_rs);
    html += cellPctSigned(d.diff_pct);
    html += cellMoney(d.venda_promo);
    html += cellPct(d.pct_promo);
    html += cellMoney(d.venda_sem_promo);
    html += cellPct(d.pct_sem_promo);
    html += cellMoney(d.meta_margem_geral);
    html += cellMoney(d.margem_realizada);
    html += cellMoneySigned(d.margem_diff_rs);
    html += cellPct(d.margem_diff_pct);
    html += cellMoney(d.verba);
    html += cellPct(d.verba_pct);
    html += cellMoney(d.meta_margem_pdv);
    html += cellMoney(d.margem_pdv);
    html += cellMoneySigned(d.margem_pdv_diff_rs);
    html += cellPct(d.margem_pdv_diff_pct);
    html += cellMoney(d.acordo_recebido);
    html += cellPct(d.acordo_pct);
    html += cellMoney(d.margem_sem_promo);
    html += cellPct(d.margem_sem_promo_pct);
    html += cellMoney(d.margem_com_promo);
    html += cellPct(d.margem_com_promo_pct);
    html += cellMoney(d.quebras);
    html += cellPct(d.quebras_pct);
    html += cellMoneySigned(d.inventario);
    html += cellPctSigned(d.inventario_pct);
    html += cellMoney(d.compra);
    html += cellMoney(d.compra_realizado);
    html += '</tr>';
  }

  html += `<tr class="total"><td class="col-data">TOTAL</td><td></td>`;
  html += cellMoney(tot.meta_venda);
  html += cellMoney(tot.realizado);
  html += cellMoneySigned(tot.diff_rs);
  html += cellPctSigned(tot.realizado && tot.meta_venda ? (tot.realizado - tot.meta_venda) / tot.meta_venda : null);
  html += cellMoney(tot.venda_promo);
  html += cellPct(tot.realizado ? tot.venda_promo / tot.realizado : null);
  html += cellMoney(tot.venda_sem_promo);
  html += cellPct(tot.realizado ? tot.venda_sem_promo / tot.realizado : null);
  html += cellMoney(tot.meta_margem_geral);
  html += cellMoney(tot.margem_realizada);
  html += cellMoneySigned(tot.margem_diff_rs);
  html += cellPct(tot.realizado ? tot.margem_realizada / tot.realizado : null);
  html += cellMoney(tot.verba);
  html += cellPct(tot.realizado ? tot.verba / tot.realizado : null);
  html += cellMoney(tot.meta_margem_pdv);
  html += cellMoney(tot.margem_pdv);
  html += cellMoneySigned(tot.margem_pdv ? tot.margem_pdv - tot.meta_margem_pdv : null);
  html += cellPct(tot.realizado ? tot.margem_pdv / tot.realizado : null);
  html += cellMoney(tot.acordo_recebido);
  html += cellPct(tot.realizado ? ((tot.margem_pdv || 0) + (tot.acordo_recebido || 0)) / tot.realizado : null);
  html += cellMoney(tot.margem_sem_promo);
  html += cellPct(tot.venda_sem_promo ? tot.margem_sem_promo / tot.venda_sem_promo : null);
  html += cellMoney(tot.margem_com_promo);
  html += cellPct(tot.venda_promo ? tot.margem_com_promo / tot.venda_promo : null);
  html += cellMoney(tot.quebras);
  html += cellPct(tot.realizado ? tot.quebras / tot.realizado : null);
  html += cellMoneySigned(tot.inventario);
  html += cellPctSigned(tot.realizado && tot.inventario ? tot.inventario / tot.realizado : null);
  html += cellMoney(tot.compra);
  html += cellMoney(tot.compra);
  html += '</tr>';

  html += '</tbody></table>';
  return html;
}

function renderKPIs(data) {
  const k = data.kpis || {};
  const card = (titulo, kpi) => {
    kpi = kpi || {};
    return `
    <div class="kpi-card">
      <div class="kpi-titulo">${titulo}</div>
      <div class="kpi-linhas">
        <div><span class="lbl">META</span><span class="val">${fmtMoney(kpi.meta_mes)}</span></div>
        <div><span class="lbl">AC</span><span class="val">${fmtMoney(kpi.meta_ate_hoje)}</span></div>
        <div><span class="lbl">REALIZADO</span><span class="val">${fmtMoney(kpi.realizado)}</span></div>
        <div><span class="lbl">DIFF</span><span class="val ${(kpi.diff||0) < 0 ? 'neg' : 'pos'}">${fmtMoneySigned(kpi.diff)}</span></div>
        <div class="ating"><span class="lbl">ATING (%)</span><span class="val">${fmtPct(kpi.ating)}</span></div>
      </div>
    </div>
  `;
  };
  return `
    <div class="kpis-rodape">
      ${card('META VENDA', k.venda)}
      ${card('META MARGEM', k.margem_geral)}
      ${card('META MARGEM PDV', k.margem_pdv)}
      <div class="kpi-card">
        <div class="kpi-titulo">ACOMP ATACADO</div>
        <div class="kpi-linhas">
          <div><span class="lbl">MARGEM</span><span class="val">${fmtMoney(k.acomp_atacado?.margem)}</span></div>
          <div><span class="lbl">VERBA</span><span class="val">${fmtMoney(k.acomp_atacado?.verba)}</span></div>
          <div class="ating"><span class="lbl">(%)</span><span class="val">${fmtPct(k.acomp_atacado?.verba_pct)}</span></div>
        </div>
      </div>
      ${card('META QUEBRA', k.quebra)}
      ${card('META COMPRA AC', k.compra)}
      <div class="kpi-card">
        <div class="kpi-titulo">META COMPOSIÇÃO</div>
        <div class="kpi-linhas">
          <div><span class="lbl">VALOR</span><span class="val">${fmtMoney(k.metas_unitarias?.['META COMPOSIÇÃO'] ?? null)}</span></div>
          <div class="ating"><span class="lbl">(%)</span><span class="val">${fmtPct(k.composicao_pct)}</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderBlocoSetores(data) {
  const dias = data.dias;
  const setores = data.setores || {};

  const seq = [
    { key: 'bovino',        nome: 'BOVINO',         caminho: 'PERECIVEIS \\ AÇOUGUE \\ BOVINO',     cls: 'setor-acougue' },
    { key: 'aves',          nome: 'AVES',           caminho: 'PERECIVEIS \\ AÇOUGUE \\ AVES',       cls: 'setor-aves' },
    { key: 'linguicas',     nome: 'LINGUIÇAS',      caminho: 'PERECIVEIS \\ AÇOUGUE \\ LINGUIÇAS',  cls: 'setor-linguicas' },
    { key: 'natalinos',     nome: 'NATALINOS',      caminho: 'PERECIVEIS \\ AÇOUGUE \\ NATALINOS', cls: 'setor-natalinos' },
    { key: 'peixes',        nome: 'PEIXES',         caminho: 'PERECIVEIS \\ AÇOUGUE \\ PEIXARIA', cls: 'setor-peixes' },
    { key: 'suino',         nome: 'SUÍNO',          caminho: 'PERECIVEIS \\ AÇOUGUE \\ SUÍNO',     cls: 'setor-suino' },
    { key: 'acougue_geral', nome: 'AÇOUGUE GERAL',  caminho: 'AÇOUGUE',                            cls: 'setor-acougue-total' },
    { key: 'flv',           nome: 'FLV',            caminho: 'PERECIVEIS \\ FLV',                  cls: 'setor-flv', temQuebra: true },
    { key: 'liquida',       nome: 'LIQUIDA',        caminho: 'LIQUIDA',                            cls: 'setor-liquida' },
  ];

  const idx = {};
  for (const s of seq) {
    idx[s.key] = {};
    for (const d of (setores[s.key]?.dias || [])) {
      idx[s.key][d.data] = d;
    }
  }

  let html = `
    <div class="bloco-header">
      <span class="mes">${nomeMes(data.mes_referencia)}</span>
      <span class="tipo">VENDA POR SETOR</span>
    </div>
    <table>
      <thead>
        <tr>
          <th rowspan="3" class="section-head">DATA</th>
          <th rowspan="3" class="section-head">DIA</th>
  `;
  for (const s of seq) {
    const colspan = s.temQuebra ? 6 : 4;
    html += `<th colspan="${colspan}" class="${s.cls}">${s.nome}</th>`;
  }
  html += '</tr><tr>';
  for (const s of seq) {
    const colspan = s.temQuebra ? 6 : 4;
    html += `<th colspan="${colspan}" class="${s.cls}">${s.caminho}</th>`;
  }
  html += '</tr><tr>';
  for (const s of seq) {
    html += `<th>VENDA</th><th>PART %</th><th>MARGEM</th><th>(%)</th>`;
    if (s.temQuebra) html += `<th>QUEBRA</th><th>(%)</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const d of dias) {
    const diaCurto = DIAS_ABREV[d.dia_semana] || '';
    const realizadoDia = d.realizado || 0;
    const cls = d.fechado ? '' : 'pendente';
    html += `<tr class="${cls}"><td class="col-data">${fmtData(d.data)}</td><td class="col-dia">${diaCurto}</td>`;
    for (const s of seq) {
      const sd = idx[s.key][d.data];
      const venda = sd?.venda;
      const margem = sd?.margem;
      const part = realizadoDia && venda ? venda / realizadoDia : null;
      const margemPct = venda && margem ? margem / venda : null;
      html += cellMoney(venda);
      html += cellPct(part);
      html += cellMoney(margem);
      html += cellPct(margemPct);
      if (s.temQuebra) {
        html += cellMoney(null);
        html += cellPct(null);
      }
    }
    html += '</tr>';
  }

  html += `<tr class="total"><td class="col-data">TOTAL</td><td></td>`;
  const totalRealizado = (data.totais_principal?.realizado) || 0;
  for (const s of seq) {
    const t = setores[s.key]?.totais || {};
    html += cellMoney(t.venda);
    html += cellPct(totalRealizado && t.venda ? t.venda / totalRealizado : null);
    html += cellMoney(t.margem);
    html += cellPct(t.venda && t.margem ? t.margem / t.venda : null);
    if (s.temQuebra) {
      html += cellMoney(null);
      html += cellPct(null);
    }
  }
  html += '</tr>';
  html += '</tbody></table>';
  return html;
}

const CSS_INLINE = `
@page { size: 480mm 297mm; margin: 5mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 9px; background: #f0f0f0; color: #000; }
.toolbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: #1f6b35; color: #fff; position: sticky; top: 0; z-index: 10; }
.toolbar .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.toolbar .sv { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: #f5d30c; color: #1f6b35; border-radius: 5px; font-weight: 800; font-style: italic; font-size: 12px; }
.toolbar-actions { display: flex; gap: 12px; align-items: center; }
.toolbar-actions a { color: #fff; text-decoration: none; font-size: 12px; }
.toolbar-actions a:hover { text-decoration: underline; }
.toolbar-actions .btn-primary { background: #f5d30c; color: #1f6b35; border: none; padding: 8px 16px; border-radius: 5px; font-weight: 700; cursor: pointer; font-size: 13px; }
.toolbar-actions .btn-primary:hover { filter: brightness(1.1); }
@media print { .no-print { display: none !important; } body { background: #fff; } }
main { padding: 16px; max-width: 1600px; margin: 0 auto; background: #fff; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 8px; table-layout: auto; }
table th, table td { border: 1px solid #aaa; padding: 1px 2px; text-align: right; white-space: nowrap; vertical-align: middle; height: 16px; }
table th { background: #1f6b35; color: #fff; font-weight: 700; text-align: center; font-size: 8px; padding: 3px 2px; line-height: 1.1; }
table th.section-head { background: #154a25; font-size: 9px; letter-spacing: 0.3px; }
table th.setor-acougue { background: #8b4513; }
table th.setor-aves { background: #c08040; }
table th.setor-linguicas { background: #b04040; }
table th.setor-natalinos { background: #80a040; }
table th.setor-peixes { background: #4080a0; }
table th.setor-suino { background: #d49090; }
table th.setor-acougue-total { background: #6f3b0c; }
table th.setor-flv { background: #1f6b35; }
table th.setor-liquida { background: #6c3483; }
table td.col-data { text-align: center; font-weight: 600; background: #f0f0f0; }
table td.col-dia { text-align: center; background: #f0f0f0; color: #555; font-size: 8px; }
table td.zero { color: #999; }
table td.neg { color: #c0392b; }
table td.pos { color: #1a8f4f; }
table tr.total td { background: #ffe9a8; font-weight: 700; border-top: 2px solid #1f6b35; border-bottom: 2px solid #1f6b35; }
table tbody tr.pendente td:not(.col-data):not(.col-dia) { color: #aaa; }
.kpis-rodape { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 8px; }
.kpi-card { border: 1px solid #1f6b35; border-radius: 3px; background: #fff; font-size: 8.5px; overflow: hidden; }
.kpi-card .kpi-titulo { background: #1f6b35; color: #fff; text-align: center; padding: 3px 4px; font-weight: 700; text-transform: uppercase; font-size: 7.5px; letter-spacing: 0.3px; }
.kpi-card .kpi-linhas { padding: 3px 6px; }
.kpi-card .kpi-linhas div { display: flex; justify-content: space-between; padding: 1px 0; }
.kpi-card .kpi-linhas div .lbl { color: #666; }
.kpi-card .kpi-linhas div .val { font-weight: 600; }
.kpi-card .kpi-linhas div.ating { border-top: 1px solid #ccc; padding-top: 2px; margin-top: 2px; }
.kpi-card .kpi-linhas div.ating .val { color: #1a8f4f; font-weight: 700; }
.page-break { page-break-after: always; height: 0; }
.bloco-header { display: flex; justify-content: space-between; align-items: center; background: #1f6b35; color: #fff; padding: 6px 12px; margin-top: 0; }
.bloco-header .mes { font-size: 11px; font-weight: 700; }
.bloco-header .tipo { font-size: 13px; font-weight: 700; letter-spacing: 1px; }
`;

export function renderPaginaPDF(data) {
  if (!data || !data.dias) {
    return `<!doctype html><html><body style="padding:40px;font-family:Arial;">
      <h2>Sem dados</h2>
      <p>Os dados de venda diária ainda não foram carregados. Rode o extrator e tente de novo.</p>
      <p><a href="/venda-diaria">← Voltar</a></p>
    </body></html>`;
  }

  let body = '';
  try { body += renderBlocoFaturamento(data); }
  catch (e) { body += `<div style="color:red;padding:20px;">Erro no bloco Faturamento: ${e.message}</div>`; }
  try { body += renderKPIs(data); }
  catch (e) { body += `<div style="color:red;padding:20px;">Erro nos KPIs: ${e.message}</div>`; }
  body += '<div class="page-break"></div>';
  try { body += renderBlocoSetores(data); }
  catch (e) { body += `<div style="color:red;padding:20px;">Erro no bloco Setores: ${e.message}</div>`; }

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faturamento Diário — PDF</title>
<style>${CSS_INLINE}</style>
</head>
<body>
<div class="toolbar no-print">
  <div class="brand">
    <span class="sv">SV</span>
    <strong>Supervendas</strong> · Faturamento Diário
  </div>
  <div class="toolbar-actions">
    <button class="btn-primary" onclick="window.print()">🖨 Imprimir / Salvar PDF</button>
    <a href="/venda-diaria">← Voltar ao site</a>
  </div>
</div>
<main>${body}</main>
</body>
</html>`;
}
