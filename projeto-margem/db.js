// Wrapper sobre node-postgres (pg). Toda a app usa Postgres (local + prod).
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERRO: variável de ambiente DATABASE_URL não definida.');
  console.error('Defina ela com a connection string do Postgres (Render → seu banco → Internal/External Database URL).');
  process.exit(1);
}

// Render usa SSL self-signed; Postgres nativo precisa de rejectUnauthorized=false
const ssl = DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl,
  max: 5,
});

// Helpers async — sintaxe parecida com SQLite mas com await
export async function query(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

export async function queryOne(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}

export async function run(sql, params = []) {
  // Para INSERT/UPDATE/DELETE — retorna rowCount e (se RETURNING) primeira linha
  const r = await pool.query(sql, params);
  return { rowCount: r.rowCount, row: r.rows[0] || null };
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      overrides_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // Migrações idempotentes — adicionam colunas extras sem quebrar dados existentes.
  await pool.query(`
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nome TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS telefone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS cargo TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nivel TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS senha_definida BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_primeiro_acesso TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expira_em TIMESTAMPTZ;
  `);

  // Index único por email (permite NULL pra users antigos sem email).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;
  `);

  // ===== Dimensões (Configurações > Dimensões) =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dim_lojas (
      nroempresa INTEGER PRIMARY KEY,
      nome TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dim_anos (
      ano INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS dim_meses (
      numero INTEGER PRIMARY KEY,
      nome TEXT NOT NULL
    );
  `);

  // Seeds idempotentes (ON CONFLICT DO NOTHING — não sobrescreve edição futura)
  await pool.query(`
    INSERT INTO dim_lojas (nroempresa, nome) VALUES
      (5,   'WBL'),
      (10,  'ARBS'),
      (11,  'RAWL'),
      (12,  'SV'),
      (13,  'SARW'),
      (14,  'VS'),
      (16,  'LUZ'),
      (18,  'LUNA ATAC'),
      (20,  'JARDIM'),
      (21,  'AGUAS'),
      (23,  'CAMPING'),
      (26,  'NSP MATRIZ'),
      (27,  'NSP 02'),
      (28,  'NSF 02'),
      (29,  'NSF MATRIZ'),
      (101, 'NSP 04'),
      (102, 'NSM 02'),
      (103, 'NSP 05'),
      (104, 'NSM 03'),
      (106, 'NSM MATRIZ'),
      (108, 'NSP 03'),
      (109, 'NSF 04'),
      (112, 'NSM 04'),
      (117, 'NSF 03'),
      (125, 'STMJ MATRIZ'),
      (215, 'STMJ 02'),
      (219, 'STMJ 03'),
      (222, 'STMJ 04')
    ON CONFLICT (nroempresa) DO NOTHING;

    INSERT INTO dim_anos (ano) VALUES (2026) ON CONFLICT (ano) DO NOTHING;

    INSERT INTO dim_meses (numero, nome) VALUES
      (1, 'Janeiro'), (2, 'Fevereiro'), (3, 'Março'), (4, 'Abril'),
      (5, 'Maio'), (6, 'Junho'), (7, 'Julho'), (8, 'Agosto'),
      (9, 'Setembro'), (10, 'Outubro'), (11, 'Novembro'), (12, 'Dezembro')
    ON CONFLICT (numero) DO NOTHING;
  `);

  // Snapshot diário da ruptura por comprador (alimenta a "Evolução Diária").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ruptura_historico (
      data DATE NOT NULL,
      escopo TEXT NOT NULL,
      comprador TEXT NOT NULL,
      skus NUMERIC,
      zerados NUMERIC,
      pct DOUBLE PRECISION,
      PRIMARY KEY (data, escopo, comprador)
    );
    CREATE INDEX IF NOT EXISTS ruptura_historico_data_idx ON ruptura_historico (data DESC);
  `);

  // Solicitações de atualização do relatório de Troca (extract roda no PC do user).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS troca_atualizacao (
      id SERIAL PRIMARY KEY,
      solicitado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
      solicitado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      iniciado_em    TIMESTAMPTZ,
      processado_em  TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'pendente',
      mensagem       TEXT
    );
    CREATE INDEX IF NOT EXISTS troca_atualizacao_status_idx ON troca_atualizacao (status, solicitado_em);
  `);

  // Mesma estrutura pra KPIs Comerciais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpis_atualizacao (
      id SERIAL PRIMARY KEY,
      solicitado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
      solicitado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      iniciado_em    TIMESTAMPTZ,
      processado_em  TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'pendente',
      mensagem       TEXT
    );
    CREATE INDEX IF NOT EXISTS kpis_atualizacao_status_idx ON kpis_atualizacao (status, solicitado_em);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS margem_loja_atualizacao (
      id SERIAL PRIMARY KEY,
      solicitado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
      solicitado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      iniciado_em    TIMESTAMPTZ,
      processado_em  TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'pendente',
      mensagem       TEXT
    );
    CREATE INDEX IF NOT EXISTS margem_loja_atualizacao_status_idx ON margem_loja_atualizacao (status, solicitado_em);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS operacao_atualizacao (
      id SERIAL PRIMARY KEY,
      solicitado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
      solicitado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      iniciado_em    TIMESTAMPTZ,
      processado_em  TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'pendente',
      mensagem       TEXT
    );
    CREATE INDEX IF NOT EXISTS operacao_atualizacao_status_idx ON operacao_atualizacao (status, solicitado_em);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS estrategia_atualizacao (
      id SERIAL PRIMARY KEY,
      solicitado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
      solicitado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      iniciado_em    TIMESTAMPTZ,
      processado_em  TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'pendente',
      mensagem       TEXT
    );
    CREATE INDEX IF NOT EXISTS estrategia_atualizacao_status_idx ON estrategia_atualizacao (status, solicitado_em);
  `);
}
