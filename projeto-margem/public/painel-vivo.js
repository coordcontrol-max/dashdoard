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

// Atualização on-demand: botão "Atualizar" cria solicitação na fila → worker
// no PC do João processa em ~1-2 min → frontend polla até status final.
let POLL_TIMER = null;
const POLL_MS = 3000;

// Filtro de data: ISO YYYY-MM-DD ou null (= "ao vivo" = primeiro dia não-fechado).
let DATA_SELECIONADA = null;
let DADOS_CACHE = null;

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

// Resolve o "dia ativo" — se DATA_SELECIONADA está setada, usa ela;
// senão default: primeiro dia não-fechado (ao vivo) ou último dia.
function resolverDiaAtivo(dias) {
  if (DATA_SELECIONADA) {
    const d = dias.find(x => x.data === DATA_SELECIONADA);
    if (d) return d;
  }
  const idxParcial = dias.findIndex(x => !x.fechado);
  if (idxParcial >= 0) return dias[idxParcial];
  return dias.length ? dias[dias.length - 1] : null;
}

function renderHero(dados) {
  const dias = dados.dias || [];
  const total = dados.totais_principal || {};

  // Dia ativo conforme filtro (ou auto-ao-vivo se sem filtro)
  const diaAtivo = resolverDiaAtivo(dias);

  // Card 1 — dia
  if (diaAtivo) {
    const sufixo = DATA_SELECIONADA ? '' : (diaAtivo.fechado ? '' : ' · em curso');
    $('#kpiDiaData').textContent = `${fmtData(diaAtivo.data)} · ${diaAtivo.dia_semana || ''}${sufixo}`;
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

  const diaAtivo = resolverDiaAtivo(dias);

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

function renderTudo() {
  if (!DADOS_CACHE) return;
  renderHero(DADOS_CACHE);
  renderMini(DADOS_CACHE);
}

// Aplica limites do input[type=date] (min/max) e o valor inicial.
function configurarFiltro() {
  const inp = $('#filtroData');
  if (!inp || !DADOS_CACHE) return;
  const dias = DADOS_CACHE.dias || [];
  if (!dias.length) return;
  inp.min = dias[0].data;
  inp.max = dias[dias.length - 1].data;
  // Default = dia ativo (ao vivo) na primeira carga
  if (!inp.value) {
    const da = resolverDiaAtivo(dias);
    if (da) inp.value = da.data;
  }
}

async function carregar() {
  try {
    const d = await api('GET', '/api/vendas');
    DADOS_CACHE = d;
    $('#mesRef').textContent = d.mes_referencia ? `${d.mes_referencia.slice(5,7)}/${d.mes_referencia.slice(0,4)}` : '—';
    configurarFiltro();
    renderTudo();

    $('#atualizadoEm').textContent = 'atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    console.error('Erro carregando painel:', err);
    $('#atualizadoEm').textContent = '⚠ falha ao atualizar';
  }
}

// Solicita refresh on-demand (cria pendente na fila) e fica pollando até finalizar.
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
        if (sol.status === 'pendente')   { status.textContent = 'aguardando worker (fila)…'; return; }
        if (sol.status === 'processando'){ status.textContent = 'rodando query Oracle…';       return; }
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

  // Filtro de data
  $('#filtroData').addEventListener('change', (e) => {
    DATA_SELECIONADA = e.target.value || null;
    renderTudo();
  });
  $('#btnHoje').addEventListener('click', () => {
    DATA_SELECIONADA = null;
    const inp = $('#filtroData');
    if (DADOS_CACHE) {
      const da = resolverDiaAtivo(DADOS_CACHE.dias || []);
      if (da && inp) inp.value = da.data;
    }
    renderTudo();
  });

  await carregar();

  // Se já tem uma solicitação em andamento de outro usuário, mostra status
  try {
    const s = await api('GET', '/api/vendas/status');
    const sol = s.ultima_solicitacao;
    if (sol && (sol.status === 'pendente' || sol.status === 'processando')) {
      // simula click pra acompanhar
      const btn = $('#btnRefresh');
      btn.disabled = true;
      btn.textContent = '⏳ Atualizando…';
      $('#atualizadoEm').textContent = sol.status === 'pendente' ? 'aguardando worker (fila)…' : 'rodando query Oracle…';
      // Poll usando o ID existente
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
          btn.disabled = false;
          btn.textContent = '🔄 Atualizar';
        } catch {}
      }, POLL_MS);
    }
  } catch {}
})();
