// Cria as tabelas e garante que o admin inicial existe.
// Idempotente: pode rodar várias vezes sem problema.
import bcrypt from 'bcryptjs';
import { db, migrate } from '../db.js';

const ADMIN_USER = process.env.ADMIN_USERNAME || 'joao paiva';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '858646';

migrate();

const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USER);
if (exists) {
  console.log(`✓ admin "${ADMIN_USER}" já existe (id=${exists.id})`);
} else {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  const r = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)').run(ADMIN_USER, hash);
  console.log(`✓ admin "${ADMIN_USER}" criado (id=${r.lastInsertRowid})`);
}

// cenário Padrão sempre existe (vazio)
const padrao = db.prepare('SELECT id FROM scenarios WHERE name = ?').get('Padrão');
if (!padrao) {
  db.prepare('INSERT INTO scenarios (name, overrides_json) VALUES (?, ?)').run('Padrão', '{}');
  console.log('✓ cenário "Padrão" criado');
}

console.log('Init OK.');
