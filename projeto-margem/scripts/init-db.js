// Cria as tabelas e garante que o admin inicial existe.
// Idempotente: pode rodar várias vezes sem problema.
// Server.js já faz isso no startup — esse script só serve pra rodar manualmente se precisar.
import bcrypt from 'bcryptjs';
import { pool, queryOne, run, migrate } from '../db.js';

const ADMIN_USER = process.env.ADMIN_USERNAME || 'joao paiva';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '858646';

await migrate();

const exists = await queryOne('SELECT id FROM users WHERE username = $1', [ADMIN_USER]);
if (exists) {
  console.log(`✓ admin "${ADMIN_USER}" já existe (id=${exists.id})`);
} else {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  const r = await run(
    'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id',
    [ADMIN_USER, hash]
  );
  console.log(`✓ admin "${ADMIN_USER}" criado (id=${r.row.id})`);
}

const padrao = await queryOne('SELECT id FROM scenarios WHERE name = $1', ['Padrão']);
if (!padrao) {
  await run('INSERT INTO scenarios (name, overrides_json) VALUES ($1, $2::jsonb)', ['Padrão', '{}']);
  console.log('✓ cenário "Padrão" criado');
}

console.log('Init OK.');
await pool.end();
