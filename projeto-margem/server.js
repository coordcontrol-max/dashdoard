import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Config =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao-' + Math.random().toString(36).slice(2);
const COOKIE_NAME = 'margem_token';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 24 * 7, // 7 dias
};
const TOKEN_TTL = '7d';

// ===== Bootstrap DB =====
migrate();
{
  // garante admin (idempotente)
  const ADMIN = process.env.ADMIN_USERNAME || 'joao paiva';
  const ADMIN_PWD = process.env.ADMIN_PASSWORD || '858646';
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN);
  if (!exists) {
    db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)')
      .run(ADMIN, bcrypt.hashSync(ADMIN_PWD, 10));
    console.log(`✓ admin "${ADMIN}" criado.`);
  }
  // cenário Padrão
  if (!db.prepare('SELECT id FROM scenarios WHERE name = ?').get('Padrão')) {
    db.prepare('INSERT INTO scenarios (name, overrides_json) VALUES (?, ?)').run('Padrão', '{}');
  }
}

// Carrega data.json em memória e fica de olho em mudanças (atualizar_dados.sh)
const DATA_PATH = path.join(__dirname, 'data', 'data.json');
let DATA = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
console.log(`✓ ${DATA.length} categorias carregadas em memória.`);

let recarregarTimer = null;
function recarregarDados() {
  try {
    DATA = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
    console.log(`↻ data.json recarregado · ${DATA.length} categorias`);
  } catch (e) {
    console.error('falha ao recarregar data.json:', e.message);
  }
}
watch(DATA_PATH, () => {
  // debounce: vários eventos de fs.watch em sequência (write + close)
  clearTimeout(recarregarTimer);
  recarregarTimer = setTimeout(recarregarDados, 200);
});

// ===== App =====
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ===== Auth helpers =====
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function authRequired(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'auth_required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'admin_required' });
    next();
  });
}

// ===== Rotas estáticas com gate =====
// Páginas que exigem login: /, /index.html, /admin.html, /style.css, /app.js, /admin.js
// Página pública: /login.html, /login.js, /favicon.ico
const PUBLIC_FILES = new Set(['/login.html', '/login.js']);

app.get('/', (req, res) => {
  // Verifica cookie sem 401: se não logado, redireciona pra login.
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); } catch { return res.redirect('/login.html'); }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (!u.is_admin) return res.status(403).send('Acesso restrito.');
  } catch { return res.redirect('/login.html'); }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/dre', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); } catch { return res.redirect('/login.html'); }
  res.sendFile(path.join(__dirname, 'public', 'dre.html'));
});

// Estáticos: deixa /login.html, /login.js, /style.css passarem livre.
// Bloqueia /index.html, /app.js, /admin.html, /admin.js sem auth.
app.use((req, res, next) => {
  const p = req.path;
  if (PUBLIC_FILES.has(p)) return next();
  // permite favicon e style.css sem auth (sem segredo dentro)
  if (p === '/favicon.ico' || p === '/style.css') return next();
  // arquivos protegidos
  const protectedFiles = ['/index.html', '/app.js', '/admin.html', '/admin.js', '/dre.html'];
  if (protectedFiles.includes(p)) {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.redirect('/login.html');
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.redirect('/login.html'); }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ===== API: auth =====
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'campos obrigatórios' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user) return res.status(401).json({ error: 'credenciais inválidas' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'credenciais inválidas' });
  res.cookie(COOKIE_NAME, signToken(user), COOKIE_OPTS);
  res.json({ id: user.id, username: user.username, is_admin: !!user.is_admin });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, is_admin: !!req.user.is_admin });
});

app.post('/api/me/password', authRequired, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'campos obrigatórios' });
  if (String(new_password).length < 6) return res.status(400).json({ error: 'senha nova precisa ter ao menos 6 caracteres' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, u.password_hash)) return res.status(401).json({ error: 'senha atual incorreta' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), u.id);
  res.json({ ok: true });
});

// ===== API: dados base =====
app.get('/api/data', authRequired, (req, res) => {
  res.json(DATA);
});

// ===== API: cenários (compartilhados) =====
app.get('/api/scenarios', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.updated_at, u.username AS updated_by
    FROM scenarios s LEFT JOIN users u ON u.id = s.updated_by
    ORDER BY s.name = 'Padrão' DESC, s.name ASC
  `).all();
  res.json(rows);
});

app.get('/api/scenarios/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  res.json({ id: row.id, name: row.name, overrides: JSON.parse(row.overrides_json), updated_at: row.updated_at });
});

app.post('/api/scenarios', authRequired, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nome obrigatório' });
  if (db.prepare('SELECT id FROM scenarios WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'já existe um cenário com esse nome' });
  }
  const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
  const r = db.prepare(`
    INSERT INTO scenarios (name, overrides_json, created_by, updated_by)
    VALUES (?, ?, ?, ?)
  `).run(name, JSON.stringify(overrides), req.user.id, req.user.id);
  res.json({ id: r.lastInsertRowid, name });
});

app.put('/api/scenarios/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null;
  const newName = req.body?.name ? String(req.body.name).trim() : null;
  if (newName && newName !== row.name) {
    if (db.prepare('SELECT id FROM scenarios WHERE name = ? AND id != ?').get(newName, id)) {
      return res.status(409).json({ error: 'já existe um cenário com esse nome' });
    }
  }
  db.prepare(`
    UPDATE scenarios
    SET overrides_json = COALESCE(?, overrides_json),
        name = COALESCE(?, name),
        updated_by = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(overrides == null ? null : JSON.stringify(overrides), newName, req.user.id, id);
  res.json({ ok: true });
});

app.delete('/api/scenarios/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  if (row.name === 'Padrão') return res.status(400).json({ error: 'cenário Padrão não pode ser excluído' });
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ===== API: usuários (admin) =====
app.get('/api/users', adminRequired, (req, res) => {
  const rows = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all();
  res.json(rows.map(u => ({ ...u, is_admin: !!u.is_admin })));
});

app.post('/api/users', adminRequired, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const is_admin = req.body?.is_admin ? 1 : 0;
  if (!username || !password) return res.status(400).json({ error: 'usuário e senha são obrigatórios' });
  if (password.length < 6) return res.status(400).json({ error: 'senha precisa ter ao menos 6 caracteres' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'já existe um usuário com esse nome' });
  }
  const r = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 10), is_admin);
  res.json({ id: r.lastInsertRowid, username, is_admin: !!is_admin });
});

app.put('/api/users/:id/password', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'senha precisa ter ao menos 6 caracteres' });
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
  res.json({ ok: true });
});

app.put('/api/users/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  const is_admin = req.body?.is_admin ? 1 : 0;
  // Não permitir tirar admin de si mesmo (evita lockout)
  if (id === req.user.id && !is_admin) return res.status(400).json({ error: 'você não pode remover seu próprio admin' });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin, id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', adminRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'você não pode excluir a si mesmo' });
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ===== Erro genérico =====
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'erro interno' });
});

app.listen(PORT, () => {
  console.log(`✓ servidor em http://localhost:${PORT}`);
});
