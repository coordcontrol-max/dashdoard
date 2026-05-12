let DADOS = null, me = null;

const $ = (s) => document.querySelector(s);
const fmtRs = (v) => v == null || isNaN(v) ? '—' : 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v/1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v/1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtDec = (v, d=1) => v == null || isNaN(v) ? '—' : Number(v).toFixed(d).replace('.', ',');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  return await r.json().catch(() => ({}));
}

function classAt(at) {
  if (at == null) return '';
  if (at >= 1) return 'ok';
  if (at >= 0.85) return 'warn';
  return 'bad';
}

function pintaKpi(id, real, meta, fmt, inverso = false) {
  const el = $(`#${id}`);
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

function renderHero() {
  const tot = DADOS.total || {};
  const at = tot.ating_total;
  const el = $('#heroAting');
  el.textContent = fmtPct(at);
  el.classList.remove('ok', 'warn', 'bad');
  el.classList.add(classAt(at));

  const sub = $('#heroSub');
  sub.innerHTML = `
    Faturamento <b>${fmtRsK(tot.venda)}</b> · Margem <b>${fmtRsK(tot.margem)}</b>
  `;

  const p = DADOS.periodo;
  if (p) {
    const ini = new Date(p.inicio + 'T00:00:00').toLocaleDateString('pt-BR');
    const fim = new Date(p.fim + 'T00:00:00').toLocaleDateString('pt-BR');
    $('#periodoTxt').textContent = `${ini} → ${fim}`;
  }
}

function renderKPIs() {
  const t = DADOS.total || {};
  pintaKpi('kpiFat', t.venda,   t.meta_venda,   fmtRsK);
  pintaKpi('kpiMar', t.margem,  t.meta_margem,  fmtRsK);
  pintaKpi('kpiRup', t.ruptura, t.meta_ruptura, fmtPct, true);
  pintaKpi('kpiDDE', t.dde,     t.meta_dde,     v => fmtDec(v, 1) + ' d', true);
  pintaKpi('kpiQue', t.perda,   t.meta_quebra,  fmtRsK, true);
  pintaKpi('kpiTro', t.troca,   t.meta_troca,   fmtRsK, true);
}

function renderGerentes() {
  const ger = DADOS.gerentes || {};
  const el = $('#gerentesGrid');
  function card(nome, emoji, g) {
    if (!g) return '';
    const at = g.ating_total;
    const cls = classAt(at);
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
  el.innerHTML = card('Perecível — André', '🥩', ger.Andre) + card('Mercearia — Walas', '🛒', ger.Walas);
}

function renderTops() {
  const cs = (DADOS.compradores || []).filter(c => c.ating_total != null);

  // Melhores: top 5 por ating_total desc
  const melhores = [...cs].sort((a, b) => (b.ating_total || 0) - (a.ating_total || 0)).slice(0, 5);
  $('#listMelhores').innerHTML = melhores.map((c, i) => {
    const cls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    return `
      <div class="pn-item ${cls}">
        <span class="pos">#${i + 1}</span>
        <span class="nome">${escapeHtml(c.nome)}</span>
        <span class="val ok">${fmtPct(c.ating_total)}</span>
      </div>
    `;
  }).join('') || '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';

  // Piores: bottom 3 por ating_total asc
  const piores = [...cs].sort((a, b) => (a.ating_total || 0) - (b.ating_total || 0)).slice(0, 3);
  $('#listPiores').innerHTML = piores.map((c, i) => `
    <div class="pn-item bad">
      <span class="pos">#${i + 1}</span>
      <span class="nome">${escapeHtml(c.nome)}</span>
      <span class="val bad">${fmtPct(c.ating_total)}</span>
    </div>
  `).join('') || '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';
}

function renderPremiacao() {
  const premiados = (DADOS.compradores || []).filter(c => (c.premiacao || 0) > 0)
    .sort((a, b) => (b.premiacao || 0) - (a.premiacao || 0));
  const totPrem = premiados.reduce((s, c) => s + (c.premiacao || 0), 0);
  if (!premiados.length) {
    $('#secPremiacao').style.display = 'none';
    return;
  }
  $('#secPremiacao').style.display = '';
  $('#listPremiacao').innerHTML = premiados.map(c => `
    <div class="pn-item pn-prem-item">
      <span class="pos">💰</span>
      <span class="nome">${escapeHtml(c.nome)}</span>
      <span class="val">${fmtRs(c.premiacao)}</span>
    </div>
  `).join('') + `
    <div class="pn-item" style="background:rgba(245,211,12,.08);font-weight:700;">
      <span class="pos">Σ</span>
      <span class="nome">Total premiações</span>
      <span class="val" style="color:#f5d30c">${fmtRs(totPrem)}</span>
    </div>
  `;
}

function renderTudo() {
  if (!DADOS) return;
  renderHero();
  renderKPIs();
  renderGerentes();
  renderTops();
  renderPremiacao();
}

async function init() {
  me = await api('GET', '/api/me');
  $('#userInfo').textContent = me.username + (me.is_admin ? ' (admin)' : '');
  $('#btnLogout').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.href = '/login.html';
  });

  const r = await api('GET', '/api/kpis');
  if (r && !r.vazio) {
    DADOS = r;
    renderTudo();
  } else {
    document.querySelector('.main-content').innerHTML = `
      <div style="padding:32px;text-align:center;color:var(--text-muted);">
        <h2>Sem dados ainda</h2>
        <p>Acesse <a href="/kpis" style="color:var(--accent)">KPIs Comerciais</a> e clique em Atualizar.</p>
      </div>
    `;
  }
}

init().catch(e => {
  if (e.message !== 'não autenticado') { console.error(e); alert('Falha: ' + e.message); }
});
