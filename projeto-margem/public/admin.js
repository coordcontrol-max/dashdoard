async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('não autenticado'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'erro');
  return data;
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let me = null;
let USERS = [];

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fmtTelefone(d) {
  if (!d) return '—';
  const x = String(d);
  if (x.length === 11) return `(${x.slice(0,2)}) ${x.slice(2,7)}-${x.slice(7)}`;
  if (x.length === 10) return `(${x.slice(0,2)}) ${x.slice(2,6)}-${x.slice(6)}`;
  return x;
}
function fmtCpf(d) {
  if (!d) return '—';
  const x = String(d);
  if (x.length === 11) return `${x.slice(0,3)}.${x.slice(3,6)}.${x.slice(6,9)}-${x.slice(9)}`;
  return x;
}

async function carregarUsuarios() {
  USERS = await api('GET', '/api/users');
  const ativos = USERS.filter(u => u.ativo).length;
  $('#adminSub').textContent = `${USERS.length} usuário${USERS.length !== 1 ? 's' : ''} cadastrado${USERS.length !== 1 ? 's' : ''} · ${ativos} ativo${ativos !== 1 ? 's' : ''}`;

  const tbody = $('#usersTbody');
  tbody.innerHTML = USERS.map(u => {
    const status = !u.ativo ? `<span class="badge inativo">Inativo</span>`
      : !u.senha_definida ? `<span class="badge pendente">Pendente 1º acesso</span>`
      : `<span class="badge ativo">Ativo</span>`;
    const adminBadge = u.is_admin ? `<span class="badge admin">admin</span>` : '';
    const nome = u.nome || u.username;
    const email = u.email || u.username;

    return `
      <tr data-id="${u.id}">
        <td>
          <div class="user-name">${escapeHtml(nome)}${adminBadge}</div>
          <div class="user-email">${escapeHtml(email)}</div>
        </td>
        <td>${status}</td>
        <td>${escapeHtml(u.cargo || '—')}</td>
        <td>${escapeHtml(fmtTelefone(u.telefone))}</td>
        <td>${escapeHtml(fmtCpf(u.cpf))}</td>
        <td>
          <div class="actions-cell" style="justify-content:center;">
            ${!u.senha_definida ? `<button class="icon-btn green" title="Copiar link de primeiro acesso" data-action="link" data-id="${u.id}">🔗</button>` : ''}
            <button class="icon-btn red" title="Resetar senha (gera novo link)" data-action="reset" data-id="${u.id}">🔑</button>
            <button class="icon-btn blue" title="Editar usuário" data-action="edit" data-id="${u.id}">✏️</button>
            <button class="icon-btn gray" title="${u.ativo ? 'Desativar' : 'Reativar'}" data-action="toggle" data-id="${u.id}">${u.ativo ? '⏸' : '▶'}</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// ===== Modal de criar/editar =====
function abrirModal(user) {
  $('#userId').value = user?.id || '';
  $('#fNome').value = user?.nome || '';
  $('#fEmail').value = user?.email || '';
  $('#fTelefone').value = user?.telefone ? fmtTelefone(user.telefone) : '';
  $('#fCpf').value = user?.cpf ? fmtCpf(user.cpf) : '';
  $('#fCargo').value = user?.cargo || '';
  $('#fAdmin').checked = !!user?.is_admin;
  $('#modalTitle').textContent = user ? `Editar usuário` : 'Novo usuário';
  $('#formErr').textContent = '';
  $('#fEmail').disabled = !!user; // não permite mudar email após criar
  $('#modalUser').classList.add('open');
}
function fecharModal() { $('#modalUser').classList.remove('open'); }

$$('[data-close]').forEach(b => b.addEventListener('click', fecharModal));
$('#modalUser').addEventListener('click', e => { if (e.target.id === 'modalUser') fecharModal(); });

$('#btnNovo').addEventListener('click', () => abrirModal(null));

$('#formUser').addEventListener('submit', async e => {
  e.preventDefault();
  $('#formErr').textContent = '';
  const id = $('#userId').value;
  const payload = {
    nome: $('#fNome').value.trim(),
    email: $('#fEmail').value.trim().toLowerCase(),
    telefone: $('#fTelefone').value,
    cpf: $('#fCpf').value,
    cargo: $('#fCargo').value.trim(),
    is_admin: $('#fAdmin').checked,
  };
  try {
    if (id) {
      delete payload.email; // não muda no edit
      await api('PUT', `/api/users/${id}`, payload);
      fecharModal();
      await carregarUsuarios();
    } else {
      const r = await api('POST', '/api/users', payload);
      fecharModal();
      await carregarUsuarios();
      mostrarLink(r.link_primeiro_acesso, r.expira_em);
    }
  } catch (err) {
    $('#formErr').textContent = err.message;
  }
});

// ===== Ações por linha =====
$('#usersTbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const action = btn.dataset.action;
  const u = USERS.find(x => x.id === id);
  if (!u) return;

  try {
    if (action === 'edit') {
      abrirModal(u);
    } else if (action === 'link') {
      // Reutiliza o token existente, sem regenerar
      const link = `${location.origin}/primeiro-acesso?token=${u.token_primeiro_acesso}`;
      mostrarLink(link, u.token_expira_em);
    } else if (action === 'reset') {
      if (!confirm(`Resetar senha de "${u.nome || u.username}"?\nIsso vai invalidar a senha atual e gerar um novo link de primeiro acesso.`)) return;
      const r = await api('POST', `/api/users/${id}/regen-token`);
      await carregarUsuarios();
      mostrarLink(r.link_primeiro_acesso, r.expira_em);
    } else if (action === 'toggle') {
      await api('PUT', `/api/users/${id}`, { ativo: !u.ativo });
      await carregarUsuarios();
    }
  } catch (err) {
    alert(err.message);
  }
});

// ===== Modal de link =====
function mostrarLink(linkRel, expiraEm) {
  const fullUrl = linkRel.startsWith('http') ? linkRel : `${location.origin}${linkRel}`;
  $('#linkBox').textContent = fullUrl;
  if (expiraEm) {
    const exp = new Date(expiraEm);
    $('#linkExpira').textContent = exp.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } else {
    $('#linkExpira').textContent = '7 dias';
  }
  $('#modalLink').classList.add('open');
}
$$('[data-close-link]').forEach(b => b.addEventListener('click', () => $('#modalLink').classList.remove('open')));
$('#modalLink').addEventListener('click', e => { if (e.target.id === 'modalLink') $('#modalLink').classList.remove('open'); });
$('#btnCopiarLink').addEventListener('click', async () => {
  const txt = $('#linkBox').textContent;
  try {
    await navigator.clipboard.writeText(txt);
    $('#btnCopiarLink').textContent = '✓ Copiado';
    setTimeout(() => { $('#btnCopiarLink').textContent = 'Copiar link'; }, 1500);
  } catch {
    alert('Não consegui copiar — selecione e copie manualmente');
  }
});

// ===== Logout =====
$('#btnLogout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/login.html';
});

// ===== Níveis de acesso (permissões por nível × relatório) =====
const NIVEIS = [
  { id: 'administrador', label: 'Administrador', cls: 'administrador', tudo: true },
  { id: 'ger-comercial', label: 'Ger Comercial', cls: 'ger-comercial' },
  { id: 'gerente',       label: 'Gerente',       cls: 'gerente' },
  { id: 'supervisor',    label: 'Supervisor',    cls: 'supervisor' },
  { id: 'comprador',     label: 'Comprador',     cls: 'comprador' },
];
// Relatórios na mesma ordem da sidebar; cada um com setor (grupo).
const RELATORIOS = [
  { setor: 'Comercial',     id: 'venda-diaria', label: 'Venda Diária' },
  { setor: 'Comercial',     id: 'ruptura',      label: 'Ruptura' },
  { setor: 'Comercial',     id: 'troca',        label: 'Troca' },
  { setor: 'Comercial',     id: 'kpis',         label: 'KPIs Comerciais' },
  { setor: 'Comercial',     id: 'estrategia',   label: 'Nível Estratégia' },
  { setor: 'Comercial',     id: 'margem',       label: 'Margem' },
  { setor: 'Financeiro',    id: 'dre',          label: 'DRE PowerBI' },
  { setor: 'RH / DP',       id: 'vagas',        label: 'Vagas em Aberto' },
  { setor: 'Operação',      id: 'operacao',     label: 'Operação' },
  { setor: 'Operação',      id: 'margem-loja',  label: 'Margem por Loja' },
  { setor: 'Administração', id: 'metas',        label: 'Metas Manuais' },
];

const PERM_KEY = 'admin_permissoes_niveis';
// Estrutura: { [nivelId]: { [relatorioId]: true|false } }
let PERMS = null;
let PERMS_PRISTINE = null; // snapshot pra detectar dirty

function carregarPermissoes() {
  try {
    const raw = localStorage.getItem(PERM_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // Default: nada marcado pros não-admin
  const base = {};
  for (const n of NIVEIS) base[n.id] = {};
  return base;
}

function permEstaDirty() {
  return JSON.stringify(PERMS) !== JSON.stringify(PERMS_PRISTINE);
}

function atualizarBotaoSalvar() {
  const btn = $('#btnSalvarPermissoes');
  const stat = $('#permStatus');
  if (!btn) return;
  const dirty = permEstaDirty();
  btn.disabled = !dirty;
  if (stat) {
    if (dirty) {
      stat.textContent = 'Alterações não salvas';
      stat.className = 'perm-status dirty';
    } else {
      stat.textContent = '';
      stat.className = 'perm-status';
    }
  }
}

function renderPermissoes() {
  const tbody = $('#permissionsTbody');
  if (!tbody) return;
  if (!PERMS) {
    PERMS = carregarPermissoes();
    PERMS_PRISTINE = JSON.parse(JSON.stringify(PERMS));
  }
  const linhas = [];
  for (const n of NIVEIS) {
    RELATORIOS.forEach((r, idx) => {
      const isFirst = idx === 0;
      const checked = n.tudo
        ? true
        : !!(PERMS[n.id] && PERMS[n.id][r.id]);
      const disabled = !!n.tudo;
      linhas.push(`
        <tr class="perm-row${isFirst ? ' perm-row-first' : ''}">
          <td class="nivel-cell">${isFirst ? `<span class="nivel-badge ${n.cls}">${n.label}</span>` : ''}</td>
          <td>${r.setor}</td>
          <td>${r.label}</td>
          <td class="center-cell">
            <input type="checkbox" class="perm-check"
              data-nivel="${n.id}" data-rel="${r.id}"
              ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          </td>
        </tr>
      `);
    });
  }
  tbody.innerHTML = linhas.join('');
  atualizarBotaoSalvar();
}

// Handler de mudança nos checkboxes
document.addEventListener('change', (e) => {
  const cb = e.target.closest('.perm-check');
  if (!cb || cb.disabled) return;
  const nivel = cb.dataset.nivel;
  const rel = cb.dataset.rel;
  if (!PERMS[nivel]) PERMS[nivel] = {};
  if (cb.checked) PERMS[nivel][rel] = true;
  else delete PERMS[nivel][rel];
  atualizarBotaoSalvar();
});

// Salvar
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#btnSalvarPermissoes');
  if (!btn || btn.disabled) return;
  try {
    localStorage.setItem(PERM_KEY, JSON.stringify(PERMS));
    PERMS_PRISTINE = JSON.parse(JSON.stringify(PERMS));
    const stat = $('#permStatus');
    if (stat) {
      stat.textContent = '✓ Salvo';
      stat.className = 'perm-status saved';
      setTimeout(() => { stat.textContent = ''; stat.className = 'perm-status'; }, 2200);
    }
    atualizarBotaoSalvar();
  } catch (err) {
    alert('Erro salvando permissões: ' + err.message);
  }
});

// ===== Abas de Configurações (Usuários / Níveis de acesso / Dimensões) =====
const TABS_KEY = 'admin_aba_ativa';
function ativarAba(nome) {
  $$('.config-tab').forEach(b => b.classList.toggle('active', b.dataset.configTab === nome));
  $$('.config-pane').forEach(p => p.classList.toggle('active', p.id === 'pane' + nome.charAt(0).toUpperCase() + nome.slice(1)));
  try { localStorage.setItem(TABS_KEY, nome); } catch {}
  // Lazy render da matriz de permissões na primeira ativação
  if (nome === 'acessos') renderPermissoes();
}
$$('.config-tab').forEach(btn => {
  btn.addEventListener('click', () => ativarAba(btn.dataset.configTab));
});

// Sub-abas dentro de Dimensões
function ativarDimSubtab(nome) {
  $$('.dim-subtab').forEach(b => {
    const on = b.dataset.dimTab === nome;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('#dimContent [data-dim-pane]').forEach(p => {
    p.style.display = (p.dataset.dimPane === nome) ? '' : 'none';
  });
}
$$('.dim-subtab').forEach(btn => {
  btn.addEventListener('click', () => ativarDimSubtab(btn.dataset.dimTab));
});

// ===== Bootstrap =====
(async () => {
  try {
    me = await api('GET', '/api/me');
    if (!me.is_admin) { location.href = '/'; return; }
    await carregarUsuarios();
    // Restaura aba salva (se válida)
    try {
      const salva = localStorage.getItem(TABS_KEY);
      if (salva && ['usuarios', 'acessos', 'dimensoes'].includes(salva)) {
        ativarAba(salva);
      }
    } catch {}
  } catch (err) { console.error(err); }
})();
