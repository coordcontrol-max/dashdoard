// ========== Estado ==========
let DADOS = null;
let me = null;

// ========== Utils ==========
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmtNum = (v) => v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('pt-BR');
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtData = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

function classPct(v, meta) {
  // meta = limite inferior do "ruim" (ex: 0.10 = acima de 10% é alerta)
  if (v == null) return '';
  if (v <= meta * 0.5) return 'pct-ok';
  if (v <= meta) return 'pct-ok';
  if (v <= meta * 1.5) return 'pct-warn';
  return 'pct-bad';
}

// ========== Render ==========
function renderKPIs() {
  if (!DADOS) return;
  const total = DADOS.total_abertas;
  const status = DADOS.status_vagas || {};
  const findStatus = (txt) => {
    const k = Object.keys(status).find(k => k.toLowerCase().includes(txt.toLowerCase()));
    return k ? status[k] : null;
  };
  const atendendo = findStatus('atendendo');
  const foraPrazo = findStatus('FORA DO PRAZO');
  const emSelecao = findStatus('EM SELEÇÃO');
  const proAdm   = findStatus('PROCESSO DE ADMISSÃO');

  $('#kpiTotal .val').textContent = fmtNum(total);

  const valAtend = atendendo?.valor;
  $('#kpiAtendendo .val').textContent = atendendo ? (atendendo.valor_raw || fmtPct(valAtend)) : '—';
  // Atendendo: quanto MAIOR melhor (meta seria 80%)
  $('#kpiAtendendo').classList.remove('alerta', 'ok');
  if (valAtend != null) {
    if (valAtend >= 0.80) $('#kpiAtendendo').classList.add('ok');
    else if (valAtend < 0.50) $('#kpiAtendendo').classList.add('alerta');
  }

  const valFora = foraPrazo?.valor;
  $('#kpiForaPrazo .val').textContent = foraPrazo ? (foraPrazo.valor_raw || fmtPct(valFora)) : '—';
  $('#kpiForaPrazo').classList.remove('alerta', 'ok');
  if (valFora != null) {
    if (valFora <= 0.10) $('#kpiForaPrazo').classList.add('ok');
    else if (valFora > 0.20) $('#kpiForaPrazo').classList.add('alerta');
  }

  $('#kpiSelecao .val').textContent = emSelecao ? (emSelecao.valor || emSelecao.valor_raw || '—') : '—';
  $('#kpiPronto .val').textContent  = proAdm ? (proAdm.valor || proAdm.valor_raw || '—') : '—';
}

function renderStatusGrid() {
  const status = DADOS?.status_vagas || {};
  const interesse = ['EM SELEÇÃO', 'DOCUMENTAÇÃO', 'EXAME E CONTA', 'JURIDICO', 'FORMAÇ AÇOUGUE', 'AGUARDANDO CONTRATO DP'];
  const cards = interesse
    .map(label => {
      const s = Object.values(status).find(x => x.label.toLowerCase().includes(label.toLowerCase()));
      return s ? `
        <div class="vg-status-card">
          <span class="lbl">${escapeHtml(s.label)}</span>
          <span class="val">${s.valor != null ? fmtNum(s.valor) : (s.valor_raw || '—')}</span>
        </div>` : '';
    })
    .join('');
  $('#statusGrid').innerHTML = cards || '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>';
}

function renderAssistentes() {
  const tbody = $('#tbodyAssist');
  const lista = DADOS?.assistentes || [];
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="padding:20px;text-align:center;color:var(--text-muted);">Sem dados</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(a => {
    const clsForaPrazo = classPct(a.fora_prazo_pct, 0.10);
    const clsMeta = a.meta_80_pct == null ? '' : (a.meta_80_pct >= 0.80 ? 'pct-ok' : a.meta_80_pct >= 0.50 ? 'pct-warn' : 'pct-bad');
    const clsQlp = classPct(a.qlp_pct, 0.20);
    const rkCls = a.rank == null ? '' :
                  a.rank <= 1 ? 'rk-verde' :
                  a.rank <= 2 ? 'rk-amarelo' :
                  a.rank <= 3 ? 'rk-laranja' : 'rk-vermelho';
    return `
      <tr>
        <td><b>${escapeHtml(a.nome)}</b></td>
        <td>${escapeHtml(a.regiao)}</td>
        <td style="font-size:11px;color:var(--text-muted);">${escapeHtml(a.lojas)}</td>
        <td class="num">${fmtNum(a.vagas_abertas)}</td>
        <td class="num">${fmtNum(a.fora_prazo)}</td>
        <td class="num ${clsForaPrazo}">${fmtPct(a.fora_prazo_pct)}</td>
        <td class="num">${fmtNum(a.pront_adm)}</td>
        <td class="num ${clsMeta}">${fmtPct(a.meta_80_pct)}</td>
        <td class="num">${fmtNum(a.qlp_lojas)}</td>
        <td class="num ${clsQlp}">${fmtPct(a.qlp_pct)}</td>
        <td class="num ${rkCls}">${a.rank ?? '—'}</td>
      </tr>
    `;
  }).join('');
}

function renderAnalistas() {
  const tbody = $('#tbodyAnalist');
  const lista = DADOS?.analistas || [];
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted);">Sem dados</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(a => `
    <tr>
      <td><b>${escapeHtml(a.nome)}</b></td>
      <td class="num">${fmtNum(a.qtd_abertas)}</td>
      <td class="num">${fmtNum(a.pronto_admissao)}</td>
      <td class="num ${classPct(a.fora_prazo_pct, 0.10)}">${fmtPct(a.fora_prazo_pct)}</td>
    </tr>
  `).join('');
}

function renderHeatmap() {
  const lojas = DADOS?.vagas_por_loja || [];
  const el = $('#heatmap');
  if (!lojas.length) { el.innerHTML = '<div style="padding:14px;color:var(--text-muted);">Sem dados</div>'; return; }
  el.innerHTML = lojas.map(l => {
    const q = l.qtd || 0;
    const cls = q === 0 ? 'q-zero' : q <= 2 ? 'q-low' : q <= 4 ? 'q-med' : 'q-high';
    return `
      <div class="vg-heatmap-cell ${cls}" data-loja="${escapeHtml(l.loja)}">
        <span class="loja">${escapeHtml(l.loja)}</span>
        <span class="qtd">${q}</span>
      </div>
    `;
  }).join('');
  // Click — abre modal com vagas detalhadas dessa loja
  el.querySelectorAll('.vg-heatmap-cell').forEach(cell => {
    if (cell.classList.contains('q-zero')) return;
    cell.addEventListener('click', () => abrirModalLoja(cell.dataset.loja));
  });
}

// Extrai número da loja: "LJ01 - DF" → 1, "LJ15" → 15
function numLoja(nome) {
  const m = String(nome || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function abrirModalLoja(nomeLoja) {
  const nLoja = numLoja(nomeLoja);
  const detalhe = DADOS?.vagas_detalhadas || [];
  const vagas = detalhe.filter(v => numLoja(v.loja) === nLoja);

  $('#modalLojaTitulo').textContent = `Loja ${nomeLoja}`;
  $('#modalLojaInfo').innerHTML = `<b>${vagas.length}</b> vaga(s) em aberto`;

  // Agrupa por status pra mostrar resumo no topo
  const porStatus = new Map();
  let dentroPrazo = 0, foraPrazo = 0;
  for (const v of vagas) {
    const s = v.status || 'SEM STATUS';
    porStatus.set(s, (porStatus.get(s) || 0) + 1);
    const cl = (v.classificacao || '').toLowerCase();
    if (cl.includes('fora')) foraPrazo++;
    else if (cl.includes('dentro')) dentroPrazo++;
  }
  const resumoEl = $('#modalLojaResumo');
  if (porStatus.size === 0) {
    resumoEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);">Nenhuma vaga aberta detalhada — pode ser que não esteja registrada nas abas individuais.</div>';
  } else {
    const pills = Array.from(porStatus.entries()).sort((a, b) => b[1] - a[1]).map(([status, qtd]) => `
      <div class="vg-resumo-pill">
        <span class="lbl">${escapeHtml(status)}</span>
        <span class="val">${qtd}</span>
      </div>
    `);
    // 2 pills extras: dentro/fora do prazo
    pills.push(`
      <div class="vg-resumo-pill" style="border-color:rgba(26,143,79,.5);">
        <span class="lbl">Dentro do Prazo</span>
        <span class="val pct-ok">${dentroPrazo}</span>
      </div>
    `);
    pills.push(`
      <div class="vg-resumo-pill" style="border-color:rgba(192,57,43,.55);">
        <span class="lbl">Fora do Prazo</span>
        <span class="val pct-bad">${foraPrazo}</span>
      </div>
    `);
    resumoEl.innerHTML = pills.join('');
  }

  // Tabela
  const tbody = $('#modalLojaTbody');
  if (!vagas.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--text-muted);">Sem vagas nesta loja</td></tr>';
  } else {
    tbody.innerHTML = vagas.map(v => `
      <tr>
        <td><b>${escapeHtml(v.cargo)}</b>${v.requ ? `<br><small style="color:var(--text-muted)">REQ ${escapeHtml(v.requ)}</small>` : ''}</td>
        <td>${escapeHtml(v.status)}</td>
        <td>${escapeHtml(v.substituindo)}</td>
        <td>${escapeHtml(v.motivo)}</td>
        <td>${escapeHtml(v.abertura)}</td>
        <td>${escapeHtml(v.prazo)}</td>
        <td>${escapeHtml(v.classificacao)}</td>
        <td>${escapeHtml(v.assistente)}</td>
      </tr>
    `).join('');
  }

  $('#modalLoja').classList.add('open');
}

function fecharModalLoja() { $('#modalLoja').classList.remove('open'); }

function renderSemanal() {
  const adm = DADOS?.admissao_semanal;
  const thead = $('#theadSemanal');
  const tbody = $('#tbodySemanal');
  if (!adm || !adm.semanas?.length) {
    thead.innerHTML = ''; tbody.innerHTML = '<tr><td style="padding:20px;text-align:center;color:var(--text-muted);">Sem dados</td></tr>';
    return;
  }
  const cols = [...adm.semanas, adm.total];
  thead.innerHTML = `<tr><th></th>${cols.map(c => `<th>${escapeHtml(c.periodo)}</th>`).join('')}</tr>`;
  const linha = (label, key) => `
    <tr>
      <td><b>${label}</b></td>
      ${cols.map(c => {
        const v = c[key];
        if (key === 'diff') {
          const cls = v == null ? '' : v >= 0 ? 'pct-ok' : 'pct-bad';
          const sinal = v != null && v > 0 ? '+' : '';
          return `<td class="num ${cls}">${v == null ? '—' : sinal + fmtNum(v)}</td>`;
        }
        return `<td class="num">${fmtNum(v)}</td>`;
      }).join('')}
    </tr>`;
  tbody.innerHTML = linha('Meta', 'meta') + linha('Realizado', 'real') + linha('Diferença', 'diff');
}

function renderTudo() {
  renderKPIs();
  renderStatusGrid();
  renderAssistentes();
  renderAnalistas();
  renderHeatmap();
  renderSemanal();
}

// ========== Atualização ==========
async function clicarAtualizar() {
  const btn = $('#btnAtualizar');
  btn.disabled = true;
  btn.textContent = '↻ Atualizando…';
  $('#trStatusMsg').textContent = 'Buscando dados do Google Sheets…';
  try {
    const r = await api('POST', '/api/vagas/atualizar');
    DADOS = r.dados;
    renderTudo();
    await carregarStatus();
  } catch (e) {
    alert('Falha: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Atualizar';
  }
}

async function carregarStatus() {
  const r = await api('GET', '/api/vagas');
  const ult = r.ultima_atualizacao ? fmtData(r.ultima_atualizacao) : 'nunca';
  $('#trStatusMsg').innerHTML = `Última atualização: <b>${ult}</b>`;
  $('#ultimaAtual').textContent = ult;
  return r;
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

  $('#btnAtualizar').addEventListener('click', clicarAtualizar);

  // Modal de loja
  $('#modalLojaClose').addEventListener('click', fecharModalLoja);
  $('#modalLojaFechar').addEventListener('click', fecharModalLoja);
  $('#modalLoja').addEventListener('click', e => { if (e.target.id === 'modalLoja') fecharModalLoja(); });

  const r = await carregarStatus();
  if (r.dados) {
    DADOS = r.dados;
    renderTudo();
  } else {
    $('#trStatusMsg').textContent = 'Sem dados ainda. Clique em 🔄 Atualizar pra puxar a planilha.';
  }
}

init().catch(e => {
  if (e.message !== 'não autenticado') {
    console.error(e);
    alert('Falha: ' + e.message);
  }
});
