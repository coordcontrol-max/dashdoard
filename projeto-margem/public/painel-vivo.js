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
let LOJA_SELECIONADA = null;       // ex: 5 ou null
let COMPRADOR_SELECIONADO = null;  // ex: "11-WALLACE(PAS)" ou null
let DADOS_VENDAS = null;       // cache /api/vendas
let DADOS_ESTR = null;         // cache /api/estrategia (pra var ano/mês ant e per-loja/comprador)
const INDISPONIVEL = '—';

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
// Helpers que retornam null quando filtro torna o campo indisponível.
function getLojaInfo() {
  if (!LOJA_SELECIONADA || !DADOS_ESTR) return null;
  return (DADOS_ESTR.lojas || []).find(l => l.loja === LOJA_SELECIONADA) || null;
}
function getCompradorInfo() {
  if (!COMPRADOR_SELECIONADO || !DADOS_ESTR) return null;
  return (DADOS_ESTR.compradores || []).find(c => c.comprador === COMPRADOR_SELECIONADO) || null;
}

function renderTudo() {
  if (!DADOS_VENDAS) return;
  const dias = DADOS_VENDAS.dias || [];
  const total = DADOS_VENDAS.totais_principal || {};
  const diaAtivo = resolverDiaAtivo(dias);
  const lojaInfo = getLojaInfo();
  const compInfo = getCompradorInfo();
  const filtrandoEscopo = !!(lojaInfo || compInfo);

  // Acumulado da rede até diaAtivo (inclusive)
  const cutoff = diaAtivo ? diaAtivo.data : null;
  let vendaAcumRede = 0, metaAcumRede = 0, margemAcumRede = 0;
  let diasContados = 0;
  for (const d of dias) {
    if (cutoff && d.data > cutoff) break;
    vendaAcumRede  += d.realizado || 0;
    metaAcumRede   += d.meta_venda || 0;
    margemAcumRede += d.margem_realizada || 0;
    diasContados++;
  }
  const totalDias = dias.length || 1;

  // ===== Resolução dos cards (escopo: rede / loja / comprador) =====
  // Daily fields (venda/meta dia, margem dia) só existem em nível REDE.
  // Quando há filtro de loja/comprador, esses cards mostram "—".
  const vDia = filtrandoEscopo ? null : (diaAtivo ? (diaAtivo.realizado || 0) : 0);
  const mDia = filtrandoEscopo ? null : (diaAtivo ? (diaAtivo.meta_venda || 0) : 0);
  const pctDia = (vDia != null && mDia != null && mDia > 0) ? vDia / mDia : null;

  // Acumulado e Meta:
  // - Rede:      vendaAcumRede / metaAcumRede
  // - Loja:      lojaInfo.venda / lojaInfo.meta_venda * (diasContados/dias_total_mes)  ← Meta parcial proporcional
  //              Mas: estrategia.lojas tem só meta_venda total do mês, não meta diária.
  //              Pra meta parcial real precisaria de outra estrutura → mostra "—" no Meta Parcial.
  // - Comprador: análogo
  let vendaMes, metaParcial, metaMensal, varAno, varMes, projecao;
  if (lojaInfo) {
    vendaMes    = lojaInfo.venda;
    metaParcial = null;  // sem meta diária por loja
    metaMensal  = lojaInfo.meta_venda;
    varAno      = lojaInfo.desvio_pct_ano;
    varMes      = lojaInfo.desvio_pct_mes;
  } else if (compInfo) {
    vendaMes    = compInfo.venda;
    metaParcial = null;  // sem meta diária por comprador
    metaMensal  = null;  // estrategia.compradores não traz meta
    varAno      = compInfo.desvio_pct_ano;
    varMes      = compInfo.desvio_pct_mes;
  } else {
    vendaMes    = vendaAcumRede;
    metaParcial = metaAcumRede;
    metaMensal  = total.meta_venda || 0;
    const e = DADOS_ESTR?.total || {};
    varAno      = e.desvio_pct_ano;
    varMes      = e.desvio_pct_mes;
  }
  projecao = (diasContados > 0 && vendaMes != null) ? (vendaMes / diasContados) * totalDias : null;

  // Margem:
  // - Rede:      acumulado das margens diárias
  // - Loja/Comp: estrategia tem lucratividade (acumulado) mas não margem diária
  let margemMes;
  if (lojaInfo)      margemMes = lojaInfo.lucratividade;
  else if (compInfo) margemMes = compInfo.lucratividade;
  else               margemMes = margemAcumRede;
  const margemMesPct = (margemMes != null && vendaMes && vendaMes !== 0) ? margemMes / vendaMes : null;

  const margemDia = filtrandoEscopo ? null : (diaAtivo ? (diaAtivo.margem_realizada || 0) : 0);
  const margemDiaPct = (margemDia != null && vDia && vDia !== 0) ? margemDia / vDia : null;

  // ===== Aplica nos cards =====
  // 1 — Venda do Dia
  $('#vendaDiaVal').textContent = vDia == null ? INDISPONIVEL : fmtRs2(vDia);
  const tag = $('#vendaDiaTag');
  if (filtrandoEscopo) {
    tag.textContent = '';
  } else if (diaAtivo && !diaAtivo.fechado && !DATA_SELECIONADA) {
    tag.textContent = 'em curso';
  } else {
    tag.textContent = diaAtivo ? fmtData(diaAtivo.data).slice(0,5) : '';
  }
  const tileDia = $('#tile-vendaDia');
  tileDia.classList.remove('ok-100','ok-warn','ok-bad');
  const c1 = classTile(pctDia); if (c1) tileDia.classList.add(c1);

  // 2 — Meta do Dia
  $('#metaDiaVal').textContent = mDia == null ? INDISPONIVEL : fmtRs2(mDia);

  // 3 — Venda do Mês
  $('#vendaMesVal').textContent = vendaMes == null ? INDISPONIVEL : fmtRs2(vendaMes);

  // 4 — Meta Parcial
  $('#metaParcialVal').textContent = metaParcial == null ? INDISPONIVEL : fmtRs2(metaParcial);
  const pctParcial = (metaParcial && vendaMes != null) ? vendaMes / metaParcial : null;
  const tileVMes = $('#tile-vendaMes');
  tileVMes.classList.remove('ok-100','ok-warn','ok-bad');
  const c3 = classTile(pctParcial); if (c3) tileVMes.classList.add(c3);

  // 5 — Projeção
  $('#projecaoVal').textContent = projecao == null ? INDISPONIVEL : fmtRs2(projecao);
  const pctProj = (metaMensal && projecao != null) ? projecao / metaMensal : null;
  const tileProj = $('#tile-projecao');
  tileProj.classList.remove('ok-100','ok-warn','ok-bad');
  const c5 = classTile(pctProj); if (c5) tileProj.classList.add(c5);

  // 6 — Meta Mensal
  $('#metaMensalVal').textContent = metaMensal == null ? INDISPONIVEL : fmtRs2(metaMensal);

  // 7 e 8 — Variações
  const elVarAno = $('#varAnoVal');
  elVarAno.textContent = fmtPctSig(varAno);
  elVarAno.classList.remove('pos','neg');
  if (varAno != null) elVarAno.classList.add(varAno >= 0 ? 'pos' : 'neg');
  const elVarMes = $('#varMesVal');
  elVarMes.textContent = fmtPctSig(varMes);
  elVarMes.classList.remove('pos','neg');
  if (varMes != null) elVarMes.classList.add(varMes >= 0 ? 'pos' : 'neg');

  // 9 — Margem Dia
  $('#margemDiaVal').textContent = margemDia == null ? INDISPONIVEL : fmtRs2(margemDia);
  $('#margemDiaSub').textContent = margemDiaPct == null ? INDISPONIVEL : fmtPct1(margemDiaPct);

  // 10 — Margem Mês
  $('#margemMesVal').textContent = margemMes == null ? INDISPONIVEL : fmtRs2(margemMes);
  $('#margemMesSub').textContent = margemMesPct == null ? INDISPONIVEL : fmtPct1(margemMesPct);

  // Gauge — só faz sentido sem filtro de loja/comprador (precisa de meta diária)
  const gPctEff = pctDia;
  const gPct = gPctEff != null ? Math.min(Math.max(gPctEff, 0), 1) : 0;
  const arcLen = 251.3;
  $('#gaugeFill').setAttribute('stroke-dashoffset', arcLen * (1 - gPct));
  const elPct = $('#gaugePct');
  elPct.textContent = gPctEff == null ? INDISPONIVEL : fmtPct1(gPctEff);
  elPct.className = 'pv-gauge-pct ' + classPct(gPctEff);

  // Resumo dos filtros ativos (mostra na sub do header)
  const resumo = [];
  if (DATA_SELECIONADA && diaAtivo) resumo.push(fmtData(diaAtivo.data).slice(0,5));
  if (lojaInfo)   resumo.push(`Loja ${lojaInfo.loja_nome || lojaInfo.loja}`);
  if (compInfo)   resumo.push(`Comp. ${compInfo.comprador}`);
  $('#filtroResumo').textContent = resumo.length ? '· ' + resumo.join(' · ') : '';

  // Badge no botão filtro
  const ativos = (DATA_SELECIONADA ? 1 : 0) + (lojaInfo ? 1 : 0) + (compInfo ? 1 : 0);
  const badge = $('#btnFiltroBadge');
  const btnF = $('#btnFiltro');
  if (ativos > 0) {
    badge.textContent = ativos;
    badge.style.display = '';
    btnF.classList.add('active');
  } else {
    badge.style.display = 'none';
    btnF.classList.remove('active');
  }
}

function configurarFiltro() {
  // Data input limits
  const inp = $('#filtroData');
  if (inp && DADOS_VENDAS) {
    const dias = DADOS_VENDAS.dias || [];
    if (dias.length) {
      inp.min = dias[0].data;
      inp.max = dias[dias.length - 1].data;
      if (!inp.value) {
        const da = resolverDiaAtivo(dias);
        if (da) inp.value = da.data;
      }
    }
  }

  // Populate Loja select
  const selL = $('#filtroLoja');
  if (selL && DADOS_ESTR?.lojas && selL.options.length <= 1) {
    const opts = (DADOS_ESTR.lojas || []).slice().sort((a,b) => (a.loja || 0) - (b.loja || 0));
    for (const l of opts) {
      const o = document.createElement('option');
      o.value = String(l.loja);
      o.textContent = `${l.loja_nome || ('Loja ' + l.loja)}`;
      selL.appendChild(o);
    }
  }

  // Populate Comprador select
  const selC = $('#filtroComprador');
  if (selC && DADOS_ESTR?.compradores && selC.options.length <= 1) {
    const opts = (DADOS_ESTR.compradores || []).slice().sort((a,b) => String(a.comprador || '').localeCompare(String(b.comprador || ''), 'pt-BR'));
    for (const c of opts) {
      const o = document.createElement('option');
      o.value = c.comprador;
      o.textContent = c.comprador;
      selC.appendChild(o);
    }
  }
}

// Mostra/esconde aviso quando loja+comprador selecionados ao mesmo tempo
function checarConflitoLojaComprador() {
  const aviso = $('#filtroAviso');
  const l = $('#filtroLoja').value;
  const c = $('#filtroComprador').value;
  if (aviso) aviso.style.display = (l && c) ? '' : 'none';
}

function abrirModalFiltro() {
  // Espelha estado atual nos campos antes de abrir
  $('#filtroData').value = DATA_SELECIONADA || ($('#filtroData').max || '');
  $('#filtroLoja').value = LOJA_SELECIONADA != null ? String(LOJA_SELECIONADA) : '';
  $('#filtroComprador').value = COMPRADOR_SELECIONADO || '';
  checarConflitoLojaComprador();
  $('#modalFiltro').classList.add('open');
}
function fecharModalFiltro() { $('#modalFiltro').classList.remove('open'); }

function aplicarFiltros() {
  DATA_SELECIONADA      = $('#filtroData').value || null;
  const l = $('#filtroLoja').value;
  const c = $('#filtroComprador').value;
  // Se ambos selecionados, prevalece loja (estrategia não tem loja×comprador)
  if (l && c) {
    LOJA_SELECIONADA = parseInt(l, 10);
    COMPRADOR_SELECIONADO = null;
  } else {
    LOJA_SELECIONADA = l ? parseInt(l, 10) : null;
    COMPRADOR_SELECIONADO = c || null;
  }
  fecharModalFiltro();
  renderTudo();
}

function limparFiltros() {
  DATA_SELECIONADA = null;
  LOJA_SELECIONADA = null;
  COMPRADOR_SELECIONADO = null;
  // Reseta inputs do modal
  $('#filtroLoja').value = '';
  $('#filtroComprador').value = '';
  if (DADOS_VENDAS) {
    const da = resolverDiaAtivo(DADOS_VENDAS.dias || []);
    if (da) $('#filtroData').value = da.data;
  }
  checarConflitoLojaComprador();
  fecharModalFiltro();
  renderTudo();
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

  // Filtros (modal)
  $('#btnFiltro').addEventListener('click', abrirModalFiltro);
  $('#modalFiltroClose').addEventListener('click', fecharModalFiltro);
  $('#modalFiltro').addEventListener('click', (e) => { if (e.target.id === 'modalFiltro') fecharModalFiltro(); });
  $('#btnAplicarFiltros').addEventListener('click', aplicarFiltros);
  $('#btnLimparFiltros').addEventListener('click', limparFiltros);
  $('#filtroLoja').addEventListener('change', checarConflitoLojaComprador);
  $('#filtroComprador').addEventListener('change', checarConflitoLojaComprador);

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
