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
const errCreate = $('#errCreate');
const okCreate = $('#okCreate');
const errPwd = $('#errPwd');
const okPwd = $('#okPwd');

let me = null;

async function carregarUsuarios() {
  const users = await api('GET', '/api/users');
  const tbody = $('#usersTbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${u.is_admin ? '<span class="badge">admin</span>' : 'usuário'}</td>
      <td>${(u.created_at || '').slice(0,10)}</td>
      <td class="actions-cell">
        <button data-action="reset" data-id="${u.id}">Trocar senha</button>
        <button data-action="toggleAdmin" data-id="${u.id}" data-current="${u.is_admin ? 1 : 0}">
          ${u.is_admin ? 'Tirar admin' : 'Tornar admin'}
        </button>
        <button class="danger" data-action="delete" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.getElementById('usersTbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id, 10);
  try {
    if (action === 'reset') {
      const senha = prompt('Nova senha (mín. 6 caracteres):');
      if (!senha) return;
      await api('PUT', `/api/users/${id}/password`, { password: senha });
      alert('Senha alterada.');
    } else if (action === 'toggleAdmin') {
      const novoAdmin = btn.dataset.current === '1' ? false : true;
      await api('PUT', `/api/users/${id}`, { is_admin: novoAdmin });
      await carregarUsuarios();
    } else if (action === 'delete') {
      if (!confirm(`Excluir usuário "${btn.dataset.name}"?`)) return;
      await api('DELETE', `/api/users/${id}`);
      await carregarUsuarios();
    }
  } catch (err) { alert(err.message); }
});

document.getElementById('formCreate').addEventListener('submit', async (e) => {
  e.preventDefault();
  errCreate.textContent = ''; okCreate.textContent = '';
  try {
    const username = $('#newUsername').value.trim();
    const password = $('#newPassword').value;
    const is_admin = $('#newAdmin').checked;
    await api('POST', '/api/users', { username, password, is_admin });
    okCreate.textContent = `✓ usuário "${username}" criado`;
    $('#newUsername').value = ''; $('#newPassword').value = ''; $('#newAdmin').checked = false;
    await carregarUsuarios();
  } catch (err) { errCreate.textContent = err.message; }
});

document.getElementById('formMyPwd').addEventListener('submit', async (e) => {
  e.preventDefault();
  errPwd.textContent = ''; okPwd.textContent = '';
  try {
    await api('POST', '/api/me/password', {
      current_password: $('#curPwd').value,
      new_password: $('#newPwd').value,
    });
    okPwd.textContent = '✓ senha alterada';
    $('#curPwd').value = ''; $('#newPwd').value = '';
  } catch (err) { errPwd.textContent = err.message; }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.href = '/login.html';
});

(async () => {
  try {
    me = await api('GET', '/api/me');
    if (!me.is_admin) { location.href = '/'; return; }
    await carregarUsuarios();
  } catch (err) { console.error(err); }
})();
