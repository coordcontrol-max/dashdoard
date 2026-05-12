// Render server-side da Análise Comparativa de Margem por Loja.
// Página A4 paisagem com:
//  - Cabeçalho: período + data de geração
//  - Tabela: Loja × dia (Mg Total %, Mg PDV %) + médias + variação + tendência

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtPp  = (v) => v == null || isNaN(v) ? '—' : ((v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + ' pp');
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v / 1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function classMg(v) {
  if (v == null) return '';
  if (v >= 0.20) return 'ok';
  if (v >= 0.17) return 'warn';
  return 'bad';
}

// Agrega lista de linhas em {venda, lucr, verba, mg_total, mg_pdv}
function agregar(linhas) {
  let venda = 0, lucr = 0, verba = 0;
  for (const l of linhas) {
    venda += Number(l.venda) || 0;
    lucr  += Number(l.lucratividade) || 0;
    verba += Number(l.verba) || 0;
  }
  // Cenário A: lucratividade já INCLUI verba
  const mg_total = venda > 0 ? lucr / venda : null;
  const mg_pdv   = venda > 0 ? (lucr - verba) / venda : null;
  return { venda, lucratividade: lucr, verba, mg_total, mg_pdv };
}

export function renderPaginaMargemLojaPDF(data) {
  if (!data || !data.linhas || !data.linhas.length) {
    return `<!doctype html><html><body><h1>Sem dados de Margem por Loja</h1></body></html>`;
  }
  const linhas = data.linhas;
  const periodo = data.periodo || {};

  // Lista de datas únicas
  const datas = Array.from(new Set(linhas.map(l => l.data))).sort();
  // Lista de lojas únicas (ordenadas pelo número da loja)
  const lojas = Array.from(new Set(linhas.map(l => l.loja))).filter(x => x != null).sort((a, b) => a - b);

  // Lookup nome da loja
  const lojaNome = {};
  for (const l of linhas) {
    if (l.loja != null && !lojaNome[l.loja] && l.loja_nome) lojaNome[l.loja] = l.loja_nome;
  }

  // Pra cada loja, agrega por dia
  const dadosPorLoja = lojas.map(loja => {
    const out = { loja, nome: lojaNome[loja] || '', porDia: {} };
    for (const dt of datas) {
      const dia = linhas.filter(l => l.loja === loja && l.data === dt);
      out.porDia[dt] = agregar(dia);
    }
    return out;
  });

  // Linha TOTAL por dia
  const totalPorDia = {};
  for (const dt of datas) {
    const dia = linhas.filter(l => l.data === dt);
    totalPorDia[dt] = agregar(dia);
  }
  const totalGeral = agregar(linhas);

  function linhaLoja(r) {
    const valoresT = datas.map(dt => r.porDia[dt]?.mg_total).filter(x => x != null);
    const valoresP = datas.map(dt => r.porDia[dt]?.mg_pdv).filter(x => x != null);
    const ultT = valoresT.at(-1);
    const ultP = valoresP.at(-1);
    const antT = valoresT.at(-2);
    const antP = valoresP.at(-2);
    const varT = (ultT != null && antT != null) ? (ultT - antT) : null;
    const varP = (ultP != null && antP != null) ? (ultP - antP) : null;
    const mediaT = valoresT.length ? valoresT.reduce((s, x) => s + x, 0) / valoresT.length : null;
    const mediaP = valoresP.length ? valoresP.reduce((s, x) => s + x, 0) / valoresP.length : null;
    const tendT = (ultT != null && valoresT.length > 1)
      ? (ultT > (valoresT.slice(0, -1).reduce((s, x) => s + x, 0) / Math.max(1, valoresT.length - 1)) ? 'up' : 'down') : 'flat';
    const tendP = (ultP != null && valoresP.length > 1)
      ? (ultP > (valoresP.slice(0, -1).reduce((s, x) => s + x, 0) / Math.max(1, valoresP.length - 1)) ? 'up' : 'down') : 'flat';

    let cells = '';
    cells += `<td class="loja">${r.loja} — ${escapeHtml(r.nome)}</td>`;
    cells += `<td class="${classMg(mediaT)}"><b>${fmtPct(mediaT)}</b></td>`;
    for (const dt of datas) {
      const v = r.porDia[dt]?.mg_total;
      cells += `<td class="${classMg(v)}">${fmtPct(v)}</td>`;
    }
    cells += `<td class="${varT == null ? '' : (varT >= 0 ? 'var-up' : 'var-down')}">${fmtPp(varT)}</td>`;
    cells += `<td class="tend-${tendT}">${tendT === 'up' ? '▲' : tendT === 'down' ? '▼' : '–'}</td>`;
    cells += `<td class="${classMg(mediaP)} sep"><b>${fmtPct(mediaP)}</b></td>`;
    for (const dt of datas) {
      const v = r.porDia[dt]?.mg_pdv;
      cells += `<td class="${classMg(v)}">${fmtPct(v)}</td>`;
    }
    cells += `<td class="${varP == null ? '' : (varP >= 0 ? 'var-up' : 'var-down')}">${fmtPp(varP)}</td>`;
    cells += `<td class="tend-${tendP}">${tendP === 'up' ? '▲' : tendP === 'down' ? '▼' : '–'}</td>`;
    return `<tr>${cells}</tr>`;
  }

  function linhaTotal() {
    let cells = `<td class="loja">TOTAL</td>`;
    cells += `<td><b>${fmtPct(totalGeral.mg_total)}</b></td>`;
    for (const dt of datas) cells += `<td>${fmtPct(totalPorDia[dt]?.mg_total)}</td>`;
    cells += `<td>—</td><td>—</td>`;
    cells += `<td class="sep"><b>${fmtPct(totalGeral.mg_pdv)}</b></td>`;
    for (const dt of datas) cells += `<td>${fmtPct(totalPorDia[dt]?.mg_pdv)}</td>`;
    cells += `<td>—</td><td>—</td>`;
    return `<tr class="total">${cells}</tr>`;
  }

  // Header com 2 linhas (grupos Mg Total / Mg PDV)
  const N = datas.length;
  const colsTot = 1 + 1 + N + 2;  // Loja + média + dias + var + tend
  const colsPdv = 1 + N + 2;       // média + dias + var + tend
  let header = `<thead>
    <tr class="grp">
      <th rowspan="2">Loja</th>
      <th colspan="${1 + N + 2}" class="grp-tot">Margem Total</th>
      <th colspan="${1 + N + 2}" class="grp-pdv">Margem PDV</th>
    </tr>
    <tr>
      <th>Médio</th>`;
  for (const dt of datas) header += `<th>${fmtData(dt)}</th>`;
  header += `<th>Var</th><th>Tend.</th>`;
  header += `<th class="sep">Médio</th>`;
  for (const dt of datas) header += `<th>${fmtData(dt)}</th>`;
  header += `<th>Var</th><th>Tend.</th>`;
  header += `</tr></thead>`;

  const dataGeracao = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const ini = fmtData(periodo.inicio);
  const fim = fmtData(periodo.fim);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Margem por Loja — Análise Comparativa</title>
<style>
  @page { size: A4 landscape; margin: 5mm; }
  * { box-sizing: border-box; }
  html, body {
    font-family: Aptos, "Aptos Display", "Segoe UI", system-ui, sans-serif;
    margin: 0; padding: 0;
    color: #1a1a1a;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .header {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 3px;
    border-bottom: 1.5px solid #1f6b35;
    padding-bottom: 2px;
  }
  .header h1 {
    font-size: 10pt;
    margin: 0;
    color: #1f6b35;
  }
  .header .meta {
    font-size: 7pt;
    color: #666;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 6.2pt;
    table-layout: auto;
    page-break-inside: avoid;
  }
  thead { display: table-header-group; }
  thead th {
    background: #1f6b35;
    color: white;
    padding: 2px 2px;
    font-weight: 700;
    text-align: center;
    border: 0.5px solid #144826;
    font-size: 5.8pt;
    line-height: 1.1;
  }
  thead th.grp-tot { background: #2F5496; }
  thead th.grp-pdv { background: #6B4F2F; }
  tbody td {
    padding: 1.5px 3px;
    border-bottom: 0.5px solid #ddd;
    text-align: right;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
    white-space: nowrap;
  }
  tbody td.loja {
    text-align: left;
    font-weight: 600;
    color: #222;
    border-right: 0.5px solid #ccc;
    white-space: nowrap;
    font-size: 6pt;
  }
  tbody tr { page-break-inside: avoid; }
  tbody tr:nth-child(even) td { background: #F5F7FA; }
  tbody tr.total td {
    background: #FCE4A6 !important;
    font-weight: 700;
    border-top: 1.5px solid #d4a017;
    border-bottom: 1.5px solid #d4a017;
  }

  /* Cores de margem */
  td.ok    { color: #1a8f4f; font-weight: 700; }
  td.warn  { color: #d4a017; font-weight: 700; }
  td.bad   { color: #c0392b; font-weight: 700; }

  /* Variação positiva/negativa */
  td.var-up   { color: #1a8f4f; font-weight: 700; }
  td.var-down { color: #c0392b; font-weight: 700; }

  /* Tendência */
  td.tend-up   { color: #1a8f4f; font-weight: 700; text-align: center; }
  td.tend-down { color: #c0392b; font-weight: 700; text-align: center; }
  td.tend-flat { color: #888; text-align: center; }

  /* Separador entre Mg Total e Mg PDV */
  .sep, td.sep {
    border-left: 1.5px solid #6B4F2F !important;
  }

  .footer { display: none; }
</style>
</head>
<body>
  <div class="header">
    <h1>Margem por Loja — Análise Comparativa</h1>
    <div class="meta">Período: <b>${ini}</b> a <b>${fim}</b> · Gerado em ${dataGeracao}</div>
  </div>

  <table>
    ${header}
    <tbody>
      ${dadosPorLoja.map(linhaLoja).join('\n')}
      ${linhaTotal()}
    </tbody>
  </table>

  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 200));</script>
</body>
</html>`;
}

