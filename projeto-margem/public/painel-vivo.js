// Painel ao Vivo · venda × meta do dia e acumulado
// Auto-refresh a cada 5 minutos. Lê /api/vendas (já tem dia a dia + totais).

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Helpers de formatação (mesmo padrão das outras páginas)
const fmtRs   = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsK  = (v) => {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' mi';
  if (abs >= 1e3) return 'R$ ' + (v / 1e3).toFixed(0) + 'k';
  return fmtRs(v);
};
const fmtRsSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  const s = fmtRs(Math.abs(v));
  return (v >= 0 ? '+' : '−') + s.slice(2); // tira "R$ "
};
const fmtPct  = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%';
const fmtPctSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(1).replace('.', ',') + '%';
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
};

let REFRESH_TIMER = null;
const REFRESH_MS = 5 * 60 * 1000;  // 5 min

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) {
    if (r.status === 401) { location.href = '/login.html'; throw new Error('401'); }
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// Classifica % atingimento → estilo visual
function classPct(p) {
  if (p == null || isNaN(p)) return '';
  if (p >= 1.0)   return 'pos';
  if (p >= 0.92)  return 'warn';
  return 'neg';
}
function classBar(p) {
  if (p == null) return '';
  if (p >= 1.0)  return '';
  if (p >= 0.92) return 'warn';
  return 'bad';
}
function classCardStatus(p) {
  if (p == null) return '';
  if (p >= 1.0)   return 'ok-100';
  if (p >= 0.92)  return 'ok-warn';
  return 'ok-bad';
}

function aplicarKPI(prefix, venda, meta, opts = {}) {
  const elValor = $('#' + prefix + 'Venda');
  const elMeta  = $('#' + prefix + 'Meta');
  const elDiff  = $('#' + prefix + 'Diff');
  const elBar   = $('#' + prefix + 'Bar');
  const elPct   = $('#' + prefix + 'Pct');
  const cardEl  = elValor?.closest('.pv-card');

  const pct  = (meta && meta !== 0) ? venda / meta : null;
  const diff = (venda != null && meta != null) ? venda - meta : null;

  if (elValor) elValor.textContent = opts.compact ? fmtRsK(venda) : fmtRs(venda);
  if (elMeta)  elMeta.textContent  = opts.compact ? fmtRsK(meta)  : fmtRs(meta);

  if (elDiff) {
    elDiff.textContent = fmtRsSig(diff);
    elDiff.classList.remove('pos', 'neg');
    if (diff != null) elDiff.classList.add(diff >= 0 ? 'pos' : 'neg');
  }

  if (elBar) {
    const w = pct != null ? Math.min(Math.max(pct * 100, 0), 130) : 0;
    elBar.style.width = w + '%';
    elBar.className = 'pv-bar-fill ' + classBar(pct);
  }

  if (elPct) {
    elPct.textContent = fmtPct(pct);
    elPct.className = 'pv-card-pct ' + classPct(pct);
  }

  if (cardEl) {
    cardEl.classList.remove('ok-100', 'ok-warn', 'ok-bad');
    const cls = classCardStatus(pct);
    if (cls) cardEl.classList.add(cls);
  }
}

function renderHero(dados) {
  const dias = dados.dias || [];
  const total = dados.totais_principal || {};

  // "Dia ao vivo" = primeiro dia não-fechado se houver, senão o último fechado.
  // (Fechado = noite consolidada; não-fechado = dia em curso.)
  const idxParcial = dias.findIndex(d => !d.fechado);
  let diaAtivo = null;
  if (idxParcial >= 0) diaAtivo = dias[idxParcial];
  else if (dias.length) diaAtivo = dias[dias.length - 1];

  // Card 1 — dia
  if (diaAtivo) {
    $('#kpiDiaData').textContent = `${fmtData(diaAtivo.data)} · ${diaAtivo.dia_semana || ''}${diaAtivo.fechado ? '' : ' · em curso'}`;
    aplicarKPI('kpiDia', diaAtivo.realizado || 0, diaAtivo.meta_venda || 0);
  }

  // Acumulado até hoje (inclusive parcial)
  let vendaAcum = 0, metaAcum = 0;
  const cutoff = diaAtivo ? diaAtivo.data : null;
  for (const d of dias) {
    if (cutoff && d.data > cutoff) break;
    vendaAcum += d.realizado || 0;
    metaAcum  += d.meta_venda || 0;
  }
  aplicarKPI('kpiMes', vendaAcum, metaAcum);

  // Projeção: ritmo até hoje × dias do mês / dias decorridos
  // diasDecorridos = nº de dias contados no acum (inclusive parcial).
  let diasDecorridos = 0;
  for (const d of dias) {
    if (cutoff && d.data > cutoff) break;
    diasDecorridos++;
  }
  const totalDias = dias.length || 1;
  const ritmo = diasDecorridos > 0 ? (vendaAcum / diasDecorridos) : 0;
  const projecao = ritmo * totalDias;
  const metaMensal = total.meta_venda || 0;
  aplicarKPI('kpiProj', projecao, metaMensal, { compact: true });
}

function renderMini(dados) {
  const dias = dados.dias || [];
  const total = dados.totais_principal || {};

  const idxParcial = dias.findIndex(d => !d.fechado);
  const diaAtivo = idxParcial >= 0 ? dias[idxParcial] : (dias.length ? dias[dias.length - 1] : null);

  // Margem do dia
  if (diaAtivo) {
    const mDia = diaAtivo.margem_realizada;
    const metaMDia = diaAtivo.meta_margem_geral;
    const mDiaPct = (diaAtivo.realizado && diaAtivo.realizado !== 0) ? mDia / diaAtivo.realizado : null;
    $('#miniMargemDia').textContent = fmtRsK(mDia);
    const sub = $('#miniMargemDiaPct');
    sub.textContent = `${fmtPct(mDiaPct)} · meta ${fmtRsK(metaMDia)}`;
    sub.className = 'pv-mini-sub ' + ((mDia >= (metaMDia || 0)) ? 'pos' : 'neg');
  }

  // Margem acumulada do mês
  $('#miniMargemMes').textContent = fmtRsK(total.margem_realizada);
  const mPct = total.realizado ? total.margem_realizada / total.realizado : null;
  $('#miniMargemMesPct').textContent = `${fmtPct(mPct)} · meta ${fmtRsK(total.meta_margem_geral)}`;

  // Margem PDV
  $('#miniMargemPdv').textContent = fmtRsK(total.margem_pdv);
  const mpdvPct = total.realizado ? total.margem_pdv / total.realizado : null;
  $('#miniMargemPdvPct').textContent = `${fmtPct(mpdvPct)} · meta ${fmtRsK(total.meta_margem_pdv)}`;

  // Ritmo / "precisa por dia"
  let vendaAcum = 0;
  let metaAcum = 0;
  let diasDecorridos = 0;
  const cutoff = diaAtivo ? diaAtivo.data : null;
  for (const d of dias) {
    if (cutoff && d.data > cutoff) break;
    vendaAcum += d.realizado || 0;
    metaAcum  += d.meta_venda || 0;
    diasDecorridos++;
  }
  const ritmo = diasDecorridos > 0 ? vendaAcum / diasDecorridos : 0;
  const totalDias = dias.length || 1;
  const diasRestantes = Math.max(totalDias - diasDecorridos, 0);
  const faltando = Math.max((total.meta_venda || 0) - vendaAcum, 0);
  const precisaPorDia = diasRestantes > 0 ? faltando / diasRestantes : 0;
  $('#miniRitmo').textContent = fmtRsK(ritmo);
  $('#miniRitmoNeed').textContent = diasRestantes > 0
    ? `Precisa: ${fmtRsK(precisaPorDia)}/dia (${diasRestantes} d)`
    : 'Mês encerrado';
}

function renderChart(dados) {
  const dias = dados.dias || [];
  const chart = $('#pvChart');
  if (!dias.length) { chart.innerHTML = ''; return; }

  // Escala: maior entre venda e meta no mês
  let maxV = 0;
  for (const d of dias) {
    maxV = Math.max(maxV, d.realizado || 0, d.meta_venda || 0);
  }
  if (maxV === 0) maxV = 1;

  let html = '';
  for (const d of dias) {
    const v = d.realizado || 0;
    const m = d.meta_venda || 0;
    const pct = m > 0 ? v / m : null;
    const barH = (v / maxV) * 100;
    const metaTop = 100 - (m / maxV) * 100;

    let cls = '';
    if (!d.fechado && v === 0) cls = 'future';
    else if (!d.fechado) cls = 'partial';
    else if (pct == null) cls = '';
    else if (pct >= 1.0) cls = '';
    else if (pct >= 0.92) cls = 'warn';
    else cls = 'bad';

    const dia = d.data.slice(8, 10);
    html += `
      <div class="pv-day" title="${dia}/${d.data.slice(5,7)} ${d.dia_semana || ''}">
        <div class="pv-day-meta" style="top: ${metaTop}%;"></div>
        <div class="pv-day-bar ${cls}" style="height: ${barH}%;"></div>
        <div class="pv-day-num">${dia}</div>
        <div class="pv-day-tooltip">
          <b>${dia}/${d.data.slice(5,7)}</b> · ${d.dia_semana || ''}<br>
          Venda: <b>${fmtRsK(v)}</b><br>
          Meta:  ${fmtRsK(m)}<br>
          ${pct != null ? '% Ating: ' + fmtPct(pct) : ''}
        </div>
      </div>
    `;
  }
  chart.innerHTML = html;
}

function renderTabela(dados) {
  const dias = (dados.dias || []).slice();
  // Últimos 10 dias (ordem mais recente primeiro)
  const ultimos = dias.slice(-10).reverse();
  const idxParcial = dados.dias.findIndex(d => !d.fechado);
  const hojeIso = idxParcial >= 0 ? dados.dias[idxParcial].data : (dados.dias.length ? dados.dias[dados.dias.length - 1].data : null);

  const html = ultimos.map(d => {
    const v = d.realizado || 0;
    const m = d.meta_venda || 0;
    const diff = v - m;
    const pct = m > 0 ? v / m : null;
    const mg = d.margem_realizada;
    const mgPct = (v && v !== 0) ? mg / v : null;
    const isHoje = d.data === hojeIso;
    return `
      <tr class="${isHoje ? 'hoje' : ''}">
        <td>${fmtData(d.data)}${d.fechado ? '' : ' <small style="color:var(--text-muted);">(parcial)</small>'}</td>
        <td>${escapeHtml(d.dia_semana || '')}</td>
        <td class="num">${fmtRs(v)}</td>
        <td class="num">${fmtRs(m)}</td>
        <td class="num ${diff >= 0 ? 'pos' : 'neg'}">${fmtRsSig(diff)}</td>
        <td class="num">${fmtPct(pct)}</td>
        <td class="num">${fmtRs(mg)}</td>
        <td class="num">${fmtPct(mgPct)}</td>
      </tr>
    `;
  }).join('');
  $('#pvTbody').innerHTML = html;
}

async function carregar() {
  try {
    const d = await api('GET', '/api/vendas');
    $('#mesRef').textContent = d.mes_referencia ? `${d.mes_referencia.slice(5,7)}/${d.mes_referencia.slice(0,4)}` : '—';

    renderHero(d);
    renderMini(d);
    renderChart(d);
    renderTabela(d);

    $('#atualizadoEm').textContent = 'atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    console.error('Erro carregando painel:', err);
    $('#atualizadoEm').textContent = '⚠ falha ao atualizar';
  }
}

function agendarRefresh() {
  if (REFRESH_TIMER) clearInterval(REFRESH_TIMER);
  REFRESH_TIMER = setInterval(carregar, REFRESH_MS);
}

(async function bootstrap() {
  try {
    const me = await api('GET', '/api/me');
    $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
    if (me.is_admin) $('#linkAdmin').style.display = '';
  } catch { location.href = '/login.html'; return; }

  $('#btnLogout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = '/login.html'; });
  $('#btnRefresh').addEventListener('click', carregar);

  await carregar();
  agendarRefresh();
})();
