// Server-side render do relatório PDF de Ruptura.
// Replica os blocos da planilha do dono:
//   Página 1: Evolução Diária (geral + 20x80) com gráficos
//   Página 2: Rankings — Comprador (geral/20x80) e Loja (geral/20x80)

// ===== Hierarquia de gerentes =====
// O nome do comprador vem como "07-WALAS(COMMD)". A chave de mapeamento é o
// trecho APÓS o "-" (ex: "WALAS(COMMD)"), comparado em uppercase sem espaços.
const GRUPOS = [
  {
    nome: 'Walas',
    chaves: ['WALAS', 'LUCAS', 'MAURIC', 'WAL', 'IGOR', 'LUZIA(BAZAR)', 'LUZIA(PERF)'],
  },
  {
    nome: 'André',
    chaves: ['PAULO', 'SAMUEL', 'ISRAEL', 'WALLACE'],
  },
];

function chaveDoComprador(nome) {
  // "07-WALAS(COMMD)" → "WALAS(COMMD)"
  const m = String(nome || '').match(/^[\d\s]*-\s*(.+)$/);
  return (m ? m[1] : String(nome || '')).trim().toUpperCase().replace(/\s+/g, '');
}

function gerenteDoComprador(nome) {
  const k = chaveDoComprador(nome);
  for (const g of GRUPOS) {
    for (const ch of g.chaves) {
      const chU = ch.toUpperCase();
      // Match exato (ex: "LUZIA(BAZAR)" vs "LUZIA(BAZAR)")
      if (k === chU) return g.nome;
      // Match com sufixo entre parênteses (ex: "WALAS" vs "WALAS(COMMD)")
      if (k.startsWith(chU + '(')) return g.nome;
    }
  }
  return null;
}

// ===== Helpers de formatação =====
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function classPctTxt(v, meta = 0.12) {
  if (v == null) return '';
  if (v <= meta * 0.5) return 'verde-forte';        // muito abaixo da meta
  if (v <= meta) return 'verde';                     // dentro da meta
  if (v <= meta * 1.3) return 'amarelo';
  if (v <= meta * 1.7) return 'laranja';
  return 'vermelho';
}

function corRank(rank, total) {
  // Top 25% pior = vermelho, top 50% = laranja, top 75% = amarelo, resto = verde
  if (!rank || !total) return '';
  const q = rank / total;
  if (q <= 0.25) return 'vermelho';
  if (q <= 0.50) return 'laranja';
  if (q <= 0.75) return 'amarelo';
  return 'verde';
}

// ===== Bloco 1: Evolução Diária por Comprador (uma tabela por escopo) =====
function renderTabelaEvolucao(data, escopo /* 'geral'|'20x80' */) {
  const ev = data.evolucao_diaria || { datas: [], geral: [], '20x80': [] };
  const datas = ev.datas || [];
  const lista = ev[escopo] || [];
  const ranking = data.ranking_compradores?.[escopo] || [];

  // Indexa pct por dia, por nome de comprador
  const idxEv = {};
  for (const c of lista) {
    if (!c || !c.nome) continue;
    idxEv[c.nome] = c.por_dia || {};
  }

  // % atual = vem do ranking_compradores (sempre o do dia atual)
  const idxAtual = {};
  for (const r of ranking) idxAtual[r.nome] = r.pct;

  // Monta linhas em ordem: para cada GRUPO, primeiro o agregado depois seus subs
  const linhas = [];

  for (const g of GRUPOS) {
    // Compradores deste grupo presentes no ranking
    const subs = ranking.filter(r => gerenteDoComprador(r.nome) === g.nome);
    if (!subs.length) continue;

    // Agregado do gerente (soma zerados / soma skus)
    const skus = subs.reduce((s, r) => s + (r.skus || 0), 0);
    const zer  = subs.reduce((s, r) => s + (r.zerados || 0), 0);
    const pctAtual = skus ? zer / skus : null;

    // Pcts por dia do gerente: pra cada data, soma a pct ponderada
    // (não temos skus/zerados por dia no histórico — só pct do total comprador.
    //  Como aproximação usamos a média ponderada do dia atual aplicada a cada dia,
    //  mas o histórico já vem como "pct do comprador", então fazemos média
    //  ponderada por SKUs do dia atual.)
    const porDiaGerente = {};
    for (const dt of datas) {
      let totSkus = 0, totZer = 0;
      for (const sub of subs) {
        const pctDia = idxEv[sub.nome]?.[dt];
        if (pctDia == null) continue;
        // Aproximação: usa skus do dia atual como peso (não temos histórico de skus)
        totSkus += sub.skus || 0;
        totZer  += (sub.skus || 0) * pctDia;
      }
      if (totSkus > 0) porDiaGerente[dt] = totZer / totSkus;
    }

    linhas.push({ tipo: 'gerente', nome: g.nome, atual: pctAtual, porDia: porDiaGerente });
    for (const sub of subs) {
      linhas.push({ tipo: 'sub', nome: sub.nome, atual: sub.pct, porDia: idxEv[sub.nome] || {} });
    }
  }

  // Total geral
  const totSkus = ranking.reduce((s, r) => s + (r.skus || 0), 0);
  const totZer  = ranking.reduce((s, r) => s + (r.zerados || 0), 0);
  const totAtual = totSkus ? totZer / totSkus : null;
  const totPorDia = {};
  for (const dt of datas) {
    let s = 0, z = 0;
    for (const r of ranking) {
      const pct = idxEv[r.nome]?.[dt];
      if (pct == null) continue;
      s += r.skus || 0;
      z += (r.skus || 0) * pct;
    }
    if (s > 0) totPorDia[dt] = z / s;
  }
  linhas.push({ tipo: 'total', nome: 'Total Geral', atual: totAtual, porDia: totPorDia });
  linhas.push({ tipo: 'meta', nome: 'META 12%', atual: 0.12, porDia: Object.fromEntries(datas.map(d => [d, 0.12])) });

  const corCab = escopo === '20x80' ? 'cab-verde' : 'cab-azul';
  const corHead = escopo === '20x80' ? 'subhead-verde' : 'subhead-azul';

  let html = `
    <table class="tbl-evolucao">
      <thead>
        <tr><th colspan="${2 + datas.length}" class="${corCab}">EVOLUÇÃO DIÁRIA - RUPTURA ${escopo === '20x80' ? '20X80' : 'GERAL'} POR COMPRADOR ${escopo === '20x80' ? '20X80' : 'GERAL'}</th></tr>
        <tr class="${corHead}">
          <th class="col-comp">Comprador</th>
          <th class="col-atual">⚪ ATUAL</th>
          ${datas.map(d => `<th>${escapeHtml(d)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;

  for (const l of linhas) {
    const cls =
      l.tipo === 'gerente' ? 'row-gerente' :
      l.tipo === 'total'   ? 'row-total' :
      l.tipo === 'meta'    ? 'row-meta' : '';
    html += `<tr class="${cls}"><td class="col-nome">${escapeHtml(l.nome)}</td>`;
    html += `<td class="col-atual ${classPctTxt(l.atual)}">${fmtPct(l.atual)}</td>`;
    for (const dt of datas) {
      const v = l.porDia?.[dt];
      html += `<td class="${classPctTxt(v)}">${fmtPct(v)}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// ===== Gráfico SVG inline da evolução do TOTAL =====
function renderGrafEvolucao(data, escopo, corLinha) {
  const ev = data.evolucao_diaria || {};
  const datas = ev.datas || [];
  const lista = ev[escopo] || [];
  const ranking = data.ranking_compradores?.[escopo] || [];
  const meta = 0.12;

  // Pct total por dia (ponderado)
  const idxEv = {};
  for (const c of lista) idxEv[c.nome] = c.por_dia || {};
  const totPorDia = {};
  for (const dt of datas) {
    let s = 0, z = 0;
    for (const r of ranking) {
      const pct = idxEv[r.nome]?.[dt];
      if (pct == null) continue;
      s += r.skus || 0;
      z += (r.skus || 0) * pct;
    }
    if (s > 0) totPorDia[dt] = z / s;
  }

  if (datas.length === 0) {
    return '<div class="graf-vazio">Sem histórico ainda — vai sendo preenchido a cada dia.</div>';
  }

  const W = 400, H = 200, PAD_L = 50, PAD_R = 16, PAD_T = 30, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  let max = meta + 0.02;
  for (const v of Object.values(totPorDia)) if (v > max) max = v;
  max = Math.ceil(max * 100) / 100 + 0.005;
  const min = Math.max(0, Math.floor(Math.min(...Object.values(totPorDia), meta) * 100) / 100 - 0.01);

  const xAt = (i) => PAD_L + (datas.length === 1 ? innerW / 2 : (i / (datas.length - 1)) * innerW);
  const yAt = (v) => PAD_T + innerH - ((v - min) / (max - min)) * innerH;

  let pathTotal = '';
  const pontos = [];
  let started = false;
  datas.forEach((d, i) => {
    const v = totPorDia[d];
    if (typeof v !== 'number') return;
    pathTotal += (started ? 'L' : 'M') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1) + ' ';
    pontos.push(`<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="3.5" fill="${corLinha}"/>
                 <text x="${xAt(i).toFixed(1)}" y="${(yAt(v) - 8).toFixed(1)}" text-anchor="middle" fill="${corLinha}" font-size="10" font-weight="700">${(v * 100).toFixed(2).replace('.', ',')}%</text>`);
    started = true;
  });

  // Grid
  const grids = [];
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * (i / 4);
    const y = yAt(v);
    grids.push(`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" stroke="#ddd"/>`);
    grids.push(`<text x="${PAD_L - 4}" y="${y + 3}" text-anchor="end" fill="#666" font-size="9">${(v * 100).toFixed(2).replace('.', ',')}%</text>`);
  }

  // Eixo X
  const xticks = datas.map((d, i) => `<text x="${xAt(i)}" y="${PAD_T + innerH + 14}" text-anchor="middle" fill="#666" font-size="10">${escapeHtml(d)}</text>`);

  // Linha de meta
  const yMeta = yAt(meta);
  const linhaMeta = `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yMeta}" y2="${yMeta}" stroke="#dc3545" stroke-width="2" stroke-dasharray="6 4"/>
                     <text x="${PAD_L + 30}" y="${yMeta - 4}" fill="#dc3545" font-size="10" font-weight="700">12,00%</text>`;

  const linhaTotal = pathTotal ? `<path d="${pathTotal}" fill="none" stroke="${corLinha}" stroke-width="2.5"/>` : '';

  const tituloCor = escopo === '20x80' ? '#1f8a45' : '#2c75c5';

  return `
    <div class="graf-card">
      <div class="graf-titulo" style="color:${tituloCor}">Evolução Diária — Ruptura ${escopo === '20x80' ? '20x80' : 'GERAL'}</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="graf-svg">
        ${grids.join('')}
        ${linhaMeta}
        ${linhaTotal}
        ${pontos.join('')}
        ${xticks.join('')}
      </svg>
      <div class="graf-leg">
        <span><span class="leg-marker" style="background:${corLinha}"></span> % Ruptura ${escopo === '20x80' ? '20x80' : 'Geral'}</span>
        <span><span class="leg-marker" style="background:#dc3545;height:2px;width:18px;"></span> Meta 12%</span>
      </div>
    </div>
  `;
}

// ===== Bloco 2: Ranking de Comprador (com agrupamento por gerente) =====
function renderRankingComprador(data, escopo) {
  const ranking = data.ranking_compradores?.[escopo] || [];
  if (!ranking.length) return '<div class="rk-vazio">Sem dados</div>';

  const totalRank = ranking.length;
  const linhas = [];

  for (const g of GRUPOS) {
    const subs = ranking.filter(r => gerenteDoComprador(r.nome) === g.nome);
    if (!subs.length) continue;

    const skus = subs.reduce((s, r) => s + (r.skus || 0), 0);
    const zer  = subs.reduce((s, r) => s + (r.zerados || 0), 0);
    const pct  = skus ? zer / skus : null;

    linhas.push({ tipo: 'gerente', nome: g.nome, skus, zerados: zer, pct, rank: null });
    for (const r of subs.sort((a, b) => (b.pct || 0) - (a.pct || 0))) {
      linhas.push({ tipo: 'sub', ...r });
    }
  }

  const totSkus = ranking.reduce((s, r) => s + (r.skus || 0), 0);
  const totZer  = ranking.reduce((s, r) => s + (r.zerados || 0), 0);
  linhas.push({ tipo: 'total', nome: 'Total Geral', skus: totSkus, zerados: totZer, pct: totSkus ? totZer / totSkus : null, rank: null });

  const titulo = `RUPTURA ${escopo === '20x80' ? '20X80' : 'GERAL'} COMPRADOR`;
  const cls = escopo === '20x80' ? 'cab-verde' : 'cab-azul';

  let html = `
    <table class="tbl-rank">
      <thead>
        <tr><th colspan="5" class="${cls}">${titulo}</th></tr>
        <tr class="rk-header">
          <th class="col-nome">Compradores</th>
          <th class="num">ITENS_SKU</th>
          <th class="num">(SKU) zerados</th>
          <th class="num">(%)</th>
          <th class="num">Rank</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const l of linhas) {
    const clsRow =
      l.tipo === 'gerente' ? 'row-gerente' :
      l.tipo === 'total'   ? 'row-total' : '';
    const corR = l.rank ? corRank(l.rank, totalRank) : '';
    html += `<tr class="${clsRow}">
      <td class="col-nome">${l.tipo === 'gerente' ? '▼ ' : (l.tipo === 'sub' ? '   ' : '')}${escapeHtml(l.nome)}</td>
      <td class="num">${fmtNum(l.skus)}</td>
      <td class="num">${fmtNum(l.zerados)}</td>
      <td class="num ${classPctTxt(l.pct)}">${fmtPct(l.pct)}</td>
      <td class="num rk-cell ${corR}">${l.rank || (l.tipo === 'total' ? '-' : '')}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// ===== Bloco 3: Ranking de Loja =====
function renderRankingLoja(data, escopo) {
  const lojas = (data.ranking_lojas?.[escopo] || []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0));
  if (!lojas.length) return '<div class="rk-vazio">Sem dados</div>';

  const titulo = `RUPTURA ${escopo === '20x80' ? '20X80' : 'GERAL'} LOJA`;
  const cls = escopo === '20x80' ? 'cab-verde' : 'cab-azul';

  let html = `
    <table class="tbl-rank">
      <thead>
        <tr><th colspan="4" class="${cls}">${titulo}</th></tr>
        <tr class="rk-header">
          <th class="col-nome">Lojas</th>
          <th class="num">ITENS_SKU</th>
          <th class="num">(SKU) zerados</th>
          <th class="num">(%)</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const l of lojas) {
    html += `<tr>
      <td class="col-nome">${escapeHtml(l.nome)}</td>
      <td class="num">${fmtNum(l.skus)}</td>
      <td class="num">${fmtNum(l.zerados)}</td>
      <td class="num ${classPctTxt(l.pct)}">${fmtPct(l.pct)}</td>
    </tr>`;
  }
  // Total
  const totSkus = lojas.reduce((s, r) => s + (r.skus || 0), 0);
  const totZer  = lojas.reduce((s, r) => s + (r.zerados || 0), 0);
  html += `<tr class="row-total">
    <td class="col-nome">Total Geral</td>
    <td class="num">${fmtNum(totSkus)}</td>
    <td class="num">${fmtNum(totZer)}</td>
    <td class="num">${fmtPct(totSkus ? totZer / totSkus : null)}</td>
  </tr>`;
  html += `</tbody></table>`;
  return html;
}

const CSS_INLINE = `
@page { size: A4 portrait; margin: 8mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 10px; background: #f0f0f0; color: #000; }

.toolbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: #1f6b35; color: #fff; position: sticky; top: 0; z-index: 10; }
.toolbar .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.toolbar .sv { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: #f5d30c; color: #1f6b35; border-radius: 5px; font-weight: 800; font-style: italic; font-size: 12px; }
.toolbar-actions { display: flex; gap: 12px; align-items: center; }
.toolbar-actions a { color: #fff; text-decoration: none; font-size: 12px; }
.toolbar-actions .btn-primary { background: #f5d30c; color: #1f6b35; border: none; padding: 8px 16px; border-radius: 5px; font-weight: 700; cursor: pointer; font-size: 13px; }

@media print { .no-print { display: none !important; } body { background: #fff; } }

main { padding: 12px; max-width: 1000px; margin: 0 auto; background: #fff; }
.bloco { margin-bottom: 12px; }
.page-break { page-break-after: always; height: 0; }

/* ===== Tabela de Evolução ===== */
.evol-pair { display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px; align-items: start; margin-bottom: 16px; }

table { border-collapse: collapse; width: 100%; font-size: 10px; font-variant-numeric: tabular-nums; }
table th, table td { border: 1px solid #aaa; padding: 3px 6px; }
table th { font-weight: 700; text-align: center; }
.tbl-evolucao th, .tbl-rank th { background: #fff; }

.cab-azul    { background: #2c75c5; color: #fff; font-size: 12px; padding: 6px 8px; letter-spacing: 0.5px; }
.cab-verde   { background: #1f8a45; color: #fff; font-size: 12px; padding: 6px 8px; letter-spacing: 0.5px; }
.subhead-azul  th { background: #d6e6f5; }
.subhead-verde th { background: #d4edda; }

.col-nome { text-align: left; padding-left: 8px; }
.col-comp { text-align: left; min-width: 120px; }
.col-atual { background: #fff7d6; font-weight: 700; }

td { text-align: center; }

.row-gerente td { background: #e8f4ff; font-weight: 700; }
.row-total   td { background: #cfe2f3; font-weight: 800; border-top: 2px solid #2c75c5; border-bottom: 2px solid #2c75c5; }
.row-meta    td { background: #fff5f5; color: #c0392b; font-weight: 700; }

/* Cores de % conforme distância da meta */
.verde-forte { background: #b6e2c7; color: #155724; font-weight: 700; }
.verde       { background: #d4edda; color: #155724; font-weight: 700; }
.amarelo     { background: #fff3cd; color: #856404; font-weight: 700; }
.laranja     { background: #ffd9b3; color: #8a4f00; font-weight: 700; }
.vermelho    { background: #f5c6cb; color: #721c24; font-weight: 700; }

/* Rank cell */
.rk-cell.verde     { background: #b6e2c7; color: #155724; font-weight: 800; }
.rk-cell.amarelo   { background: #fff3cd; color: #856404; font-weight: 800; }
.rk-cell.laranja   { background: #ffd9b3; color: #8a4f00; font-weight: 800; }
.rk-cell.vermelho  { background: #f5c6cb; color: #721c24; font-weight: 800; }

.tbl-rank .rk-header th { background: #d4edda; }

/* ===== Gráficos SVG ===== */
.graf-card { padding: 6px; }
.graf-titulo { text-align: center; font-weight: 700; font-size: 12px; margin-bottom: 4px; }
.graf-svg { width: 100%; height: auto; }
.graf-leg { display: flex; gap: 14px; justify-content: center; margin-top: 4px; font-size: 10px; }
.leg-marker { display: inline-block; width: 14px; height: 8px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
.graf-vazio { padding: 30px; text-align: center; color: #888; font-size: 11px; }

/* ===== Página 2: 4 quadrantes ===== */
.quad-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.num { text-align: right; padding-right: 8px; font-variant-numeric: tabular-nums; }
.rk-vazio { padding: 16px; color: #888; text-align: center; }
`;

export function renderPaginaRupturaPDF(data) {
  if (!data || !data.ranking_compradores) {
    return `<!doctype html><html><body style="padding:40px;font-family:Arial;">
      <h2>Sem dados de Ruptura</h2>
      <p>Os dados ainda não foram carregados. Rode o extractor e tente de novo.</p>
      <p><a href="/ruptura">← Voltar</a></p>
    </body></html>`;
  }

  const dataHoje = (() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  })();

  // Página 1
  const pagina1 = `
    <div class="evol-pair">
      ${renderTabelaEvolucao(data, 'geral')}
      ${renderGrafEvolucao(data, 'geral', '#2c75c5')}
    </div>
    <div class="evol-pair">
      ${renderTabelaEvolucao(data, '20x80')}
      ${renderGrafEvolucao(data, '20x80', '#1f8a45')}
    </div>
  `;

  // Página 2
  const pagina2 = `
    <div class="quad-grid">
      <div>${renderRankingComprador(data, 'geral')}</div>
      <div>${renderRankingComprador(data, '20x80')}</div>
      <div>${renderRankingLoja(data, 'geral')}</div>
      <div>${renderRankingLoja(data, '20x80')}</div>
    </div>
  `;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ruptura — PDF</title>
<style>${CSS_INLINE}</style>
</head>
<body>
<div class="toolbar no-print">
  <div class="brand">
    <span class="sv">SV</span>
    <strong>Supervendas</strong> · Ruptura · ${dataHoje}
  </div>
  <div class="toolbar-actions">
    <button class="btn-primary" onclick="window.print()">🖨 Imprimir / Salvar PDF</button>
    <a href="/ruptura">← Voltar ao site</a>
  </div>
</div>
<main>
  <section class="bloco">${pagina1}</section>
  <div class="page-break"></div>
  <section class="bloco">${pagina2}</section>
</main>
</body>
</html>`;
}
