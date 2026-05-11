const form = document.getElementById('loginForm');
const errEl = document.getElementById('err');
const btn = document.getElementById('btnSubmit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'falha no login');
    }
    location.href = '/';
  } catch (err) {
    errEl.textContent = err.message || 'erro';
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});
