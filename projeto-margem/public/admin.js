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

// ===== Bootstrap =====
(async () => {
  try {
    me = await api('GET', '/api/me');
    if (!me.is_admin) { location.href = '/'; return; }
    await carregarUsuarios();
  } catch (err) { console.error(err); }
})();
