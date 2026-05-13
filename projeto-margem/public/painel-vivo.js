// Painel ao Vivo · venda × meta com 10 cards + gauge.
// On-demand refresh via fila + worker no PC. Filtro de data muda cutoff acumulado.

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const fmtRs  = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRs2 = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' mi';
  return fmtRs(v);
};
const fmtPct  = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtPct1 = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%';
const fmtPctSig = (v) => {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(2).replace('.', ',') + '%';
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

// ===== Estado =====
let POLL_TIMER = null;
const POLL_MS = 3000;
let DATA_SELECIONADA = null;   // ISO YYYY-MM-DD ou null (auto = ao vivo)
let DADOS_VENDAS = null;       // cache /api/vendas
let DADOS_ESTR = null;         // cache /api/estrategia (pra var ano/mês ant)

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

// ===== Helpers =====
function resolverDiaAtivo(dias) {
  if (DATA_SELECIONADA) {
    const d = dias.find(x => x.data === DATA_SELECIONADA);
    if (d) return d;
  }
  const idxParcial = dias.findIndex(x => !x.fechado);
  if (idxParcial >= 0) return dias[idxParcial];
  return dias.length ? dias[dias.length - 1] : null;
}

// Classes de cor pelo % atingimento (0-1, 1=100%)
function classPct(p) {
  if (p == null || isNaN(p)) return '';
  if (p >= 1.0)  return 'pos';
  if (p >= 0.92) return 'warn';
  return 'neg';
}
function classTile(p) {
  if (p == null || isNaN(p)) return '';
  if (p >= 1.0)  return 'ok-100';
  if (p >= 0.92) return 'ok-warn';
  return 'ok-bad';
}

// ===== Render =====
function renderTudo() {
  if (!DADOS_VENDAS) return;
  const dias = DADOS_VENDAS.dias || [];
  const total = DADOS_VENDAS.totais_principal || {};
  const diaAtivo = resolverDiaAtivo(dias);

  // Acumulado até diaAtivo (inclusive)
  const cutoff = diaAtivo ? diaAtivo.data : null;
  let vendaAcum = 0, metaAcum = 0, margemAcum = 0;
  let diasContados = 0;
  for (const d of dias) {
    if (cutoff && d.data > cutoff) break;
    vendaAcum  += d.realizado || 0;
    metaAcum   += d.meta_venda || 0;
    margemAcum += d.margem_realizada || 0;
    diasContados++;
  }
  const totalDias = dias.length || 1;
  const projecao = diasContados > 0 ? (vendaAcum / diasContados) * totalDias : 0;
  const metaMensal = total.meta_venda || 0;

  // 1 — Venda do Dia
  const vDia = diaAtivo ? (diaAtivo.realizado || 0) : 0;
  const mDia = diaAtivo ? (diaAtivo.meta_venda || 0) : 0;
  const pctDia = mDia > 0 ? vDia / mDia : null;
  $('#vendaDiaVal').textContent = fmtRs2(vDia);
  const tag = $('#vendaDiaTag');
  if (diaAtivo && !diaAtivo.fechado && !DATA_SELECIONADA) {
    tag.textContent = 'em curso';
  } else {
    tag.textContent = diaAtivo ? fmtData(diaAtivo.data).slice(0,5) : '';
  }
  // Status do tile da Venda do Dia
  const tileDia = $('#tile-vendaDia');
  tileDia.classList.remove('ok-100','ok-warn','ok-bad');
  const c1 = classTile(pctDia); if (c1) tileDia.classList.add(c1);

  // 2 — Meta do Dia
  $('#metaDiaVal').textContent = fmtRs2(mDia);

  // 3 — Venda do Mês (acumulado)
  $('#vendaMesVal').textContent = fmtRs2(vendaAcum);

  // 4 — Meta Parcial (acumulada até hoje)
  $('#metaParcialVal').textContent = fmtRs2(metaAcum);
  const pctParcial = metaAcum > 0 ? vendaAcum / metaAcum : null;
  const tileVMes = $('#tile-vendaMes');
  tileVMes.classList.remove('ok-100','ok-warn','ok-bad');
  const c3 = classTile(pctParcial); if (c3) tileVMes.classList.add(c3);

  // 5 — Projeção
  $('#projecaoVal').textContent = fmtRs2(projecao);
  const pctProj = metaMensal > 0 ? projecao / metaMensal : null;
  const tileProj = $('#tile-projecao');
  tileProj.classList.remove('ok-100','ok-warn','ok-bad');
  const c5 = classTile(pctProj); if (c5) tileProj.classList.add(c5);

  // 6 — Meta Mensal
  $('#metaMensalVal').textContent = fmtRs2(metaMensal);

  // 7 e 8 — Variações (vêm de /api/estrategia)
  const tot_est = DADOS_ESTR?.total || {};
  const varAno = tot_est.desvio_pct_ano;
  const varMes = tot_est.desvio_pct_mes;
  const elVarAno = $('#varAnoVal');
  elVarAno.textContent = fmtPctSig(varAno);
  elVarAno.classList.remove('pos','neg');
  if (varAno != null) elVarAno.classList.add(varAno >= 0 ? 'pos' : 'neg');
  const elVarMes = $('#varMesVal');
  elVarMes.textContent = fmtPctSig(varMes);
  elVarMes.classList.remove('pos','neg');
  if (varMes != null) elVarMes.classList.add(varMes >= 0 ? 'pos' : 'neg');

  // 9 — Margem Dia
  const margemDia = diaAtivo ? (diaAtivo.margem_realizada || 0) : 0;
  const margemDiaPct = vDia > 0 ? margemDia / vDia : null;
  $('#margemDiaVal').textContent = fmtRs2(margemDia);
  $('#margemDiaSub').textContent = fmtPct1(margemDiaPct);

  // 10 — Margem Mês (acumulado)
  const margemMesPct = vendaAcum > 0 ? margemAcum / vendaAcum : null;
  $('#margemMesVal').textContent = fmtRs2(margemAcum);
  $('#margemMesSub').textContent = fmtPct1(margemMesPct);

  // Gauge — % atingimento da meta do dia
  const gPct = pctDia != null ? Math.min(Math.max(pctDia, 0), 1) : 0;
  const arcLen = 251.3;
  const offset = arcLen * (1 - gPct);
  $('#gaugeFill').setAttribute('stroke-dashoffset', offset);
  const elPct = $('#gaugePct');
  elPct.textContent = fmtPct1(pctDia);
  elPct.className = 'pv-gauge-pct ' + classPct(pctDia);
}

function configurarFiltro() {
  const inp = $('#filtroData');
  if (!inp || !DADOS_VENDAS) return;
  const dias = DADOS_VENDAS.dias || [];
  if (!dias.length) return;
  inp.min = dias[0].data;
  inp.max = dias[dias.length - 1].data;
  if (!inp.value) {
    const da = resolverDiaAtivo(dias);
    if (da) inp.value = da.data;
  }
}

async function carregar() {
  try {
    const [v, e] = await Promise.all([
      api('GET', '/api/vendas'),
      api('GET', '/api/estrategia').catch(() => null), // estrategia opcional
    ]);
    DADOS_VENDAS = v;
    DADOS_ESTR = e;
    $('#mesRef').textContent = v.mes_referencia ? `${v.mes_referencia.slice(5,7)}/${v.mes_referencia.slice(0,4)}` : '—';
    configurarFiltro();
    renderTudo();
    $('#atualizadoEm').textContent = 'atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    console.error('Erro carregando painel:', err);
    $('#atualizadoEm').textContent = '⚠ falha ao atualizar';
  }
}

// ===== Refresh on-demand via fila/worker =====
async function solicitarAtualizacao() {
  const btn = $('#btnRefresh');
  const status = $('#atualizadoEm');
  btn.disabled = true;
  btn.textContent = '⏳ Atualizando…';
  status.textContent = 'pedindo atualização…';
  try {
    const r = await api('POST', '/api/vendas/atualizar');
    const id = r.solicitacao?.id;
    if (!id) throw new Error('sem id da solicitação');
    if (POLL_TIMER) clearInterval(POLL_TIMER);
    POLL_TIMER = setInterval(async () => {
      try {
        const s = await api('GET', '/api/vendas/status');
        const sol = s.ultima_solicitacao;
        if (!sol || sol.id < id) return;
        if (sol.status === 'pendente')    { status.textContent = 'aguardando worker (fila)…'; return; }
        if (sol.status === 'processando') { status.textContent = 'rodando query Oracle…';     return; }
        clearInterval(POLL_TIMER); POLL_TIMER = null;
        if (sol.status === 'ok') {
          await carregar();
          status.textContent = '✓ ' + (sol.mensagem || 'atualizado') + ' às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        } else {
          status.textContent = '⚠ ' + (sol.mensagem || 'erro');
        }
        btn.disabled = false;
        btn.textContent = '🔄 Atualizar';
      } catch (err) {
        clearInterval(POLL_TIMER); POLL_TIMER = null;
        status.textContent = '⚠ erro no poll: ' + err.message;
        btn.disabled = false;
        btn.textContent = '🔄 Atualizar';
      }
    }, POLL_MS);
  } catch (err) {
    status.textContent = '⚠ ' + err.message;
    btn.disabled = false;
    btn.textContent = '🔄 Atualizar';
  }
}

(async function bootstrap() {
  try {
    const me = await api('GET', '/api/me');
    $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
    if (me.is_admin) $('#linkAdmin').style.display = '';
  } catch { location.href = '/login.html'; return; }

  $('#btnLogout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = '/login.html'; });
  $('#btnRefresh').addEventListener('click', solicitarAtualizacao);
  $('#filtroData').addEventListener('change', (e) => {
    DATA_SELECIONADA = e.target.value || null;
    renderTudo();
  });
  $('#btnHoje').addEventListener('click', () => {
    DATA_SELECIONADA = null;
    if (DADOS_VENDAS) {
      const da = resolverDiaAtivo(DADOS_VENDAS.dias || []);
      const inp = $('#filtroData');
      if (da && inp) inp.value = da.data;
    }
    renderTudo();
  });

  await carregar();

  // Se já tem solicitação em andamento, acompanha
  try {
    const s = await api('GET', '/api/vendas/status');
    const sol = s.ultima_solicitacao;
    if (sol && (sol.status === 'pendente' || sol.status === 'processando')) {
      const btn = $('#btnRefresh');
      btn.disabled = true; btn.textContent = '⏳ Atualizando…';
      $('#atualizadoEm').textContent = sol.status === 'pendente' ? 'aguardando worker (fila)…' : 'rodando query Oracle…';
      POLL_TIMER = setInterval(async () => {
        try {
          const ss = await api('GET', '/api/vendas/status');
          const cur = ss.ultima_solicitacao;
          if (!cur || cur.id < sol.id) return;
          if (cur.status === 'pendente' || cur.status === 'processando') return;
          clearInterval(POLL_TIMER); POLL_TIMER = null;
          if (cur.status === 'ok') {
            await carregar();
            $('#atualizadoEm').textContent = '✓ ' + (cur.mensagem || 'atualizado');
          } else {
            $('#atualizadoEm').textContent = '⚠ ' + (cur.mensagem || 'erro');
          }
          btn.disabled = false; btn.textContent = '🔄 Atualizar';
        } catch {}
      }, POLL_MS);
    }
  } catch {}
})();
