import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, queryOne, run, migrate } from './db.js';
import { renderPaginaPDF } from './render-pdf.js';
import { renderPaginaRupturaPDF } from './render-pdf-ruptura.js';
import { renderPaginaMargemLojaPDF } from './render-pdf-margem-loja.js';
import { renderPaginaVDResumoPDF } from './render-pdf-vd-resumo.js';
import { parseVagasCompleto } from './vagas-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Config =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('⚠ JWT_SECRET não definido. Usando segredo aleatório (logout em todos a cada restart).');
  return 'tmp-' + Math.random().toString(36).slice(2);
})();
const COOKIE_NAME = 'margem_token';
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  maxAge: 1000 * 60 * 60 * 24 * 7,
};
const TOKEN_TTL = '7d';

// ===== Bootstrap DB =====
await migrate();
{
  const ADMIN = process.env.ADMIN_USERNAME || 'joao paiva';
  const ADMIN_PWD = process.env.ADMIN_PASSWORD || '858646';
  const exists = await queryOne('SELECT id FROM users WHERE username = $1', [ADMIN]);
  if (!exists) {
    await run(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, TRUE)',
      [ADMIN, bcrypt.hashSync(ADMIN_PWD, 10)]
    );
    console.log(`✓ admin "${ADMIN}" criado.`);
  }
  const padrao = await queryOne('SELECT id FROM scenarios WHERE name = $1', ['Padrão']);
  if (!padrao) {
    await run('INSERT INTO scenarios (name, overrides_json) VALUES ($1, $2::jsonb)', ['Padrão', '{}']);
  }
}

// ===== Dados em memória (margem + vendas + ruptura + troca + vagas + kpis) =====
let DATA_MARGEM = [];
let DATA_VENDAS = null;
let DATA_RUPTURA = null;
let DATA_TROCA = null;
let DATA_VAGAS = null;
let DATA_KPIS = null;
let DATA_KPIS_RAW = null;   // Snapshot original do worker (sem manuais aplicadas) — base pra apagar/reaplicar
let DATA_MARGEM_LOJA = null;
let DATA_OPERACAO = null;
let DATA_ESTRATEGIA = null;

async function carregarDadosDoBanco() {
  const rows = await query('SELECT key, data FROM app_data');
  for (const r of rows) {
    if (r.key === 'margem') DATA_MARGEM = r.data;
    else if (r.key === 'vendas') DATA_VENDAS = r.data;
    else if (r.key === 'ruptura') DATA_RUPTURA = r.data;
    else if (r.key === 'troca') DATA_TROCA = r.data;
    else if (r.key === 'vagas') DATA_VAGAS = r.data;
    else if (r.key === 'kpis') DATA_KPIS = r.data;
    else if (r.key === 'kpis_raw') DATA_KPIS_RAW = r.data;
    else if (r.key === 'margem_loja') DATA_MARGEM_LOJA = r.data;
    else if (r.key === 'operacao') DATA_OPERACAO = r.data;
    else if (r.key === 'estrategia') DATA_ESTRATEGIA = r.data;
  }
  console.log(`✓ DB · margem: ${DATA_MARGEM?.length || 0} cat · vendas: ${DATA_VENDAS?.dias?.length || 0} dias · ruptura: ${DATA_RUPTURA?.itens?.length || 0} itens · troca: ${DATA_TROCA?.itens?.length || 0} itens · vagas: ${DATA_VAGAS?.assistentes?.length || 0} assistentes · kpis: ${DATA_KPIS?.compradores?.length || 0} compradores · margem_loja: ${DATA_MARGEM_LOJA?.linhas?.length || 0} linhas`);
}

async function seedDadosDeArquivosLocais() {
  const seeds = [
    { key: 'margem', file: path.join(__dirname, 'data', 'data.json') },
    { key: 'vendas', file: path.join(__dirname, 'data', 'vendas.json') },
    { key: 'ruptura', file: path.join(__dirname, 'data', 'ruptura.json') },
    { key: 'troca', file: path.join(__dirname, 'data', 'troca.json') },
  ];
  for (const { key, file } of seeds) {
    const existe = await queryOne('SELECT key FROM app_data WHERE key = $1', [key]);
    if (!existe && existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf-8'));
      await run(
        'INSERT INTO app_data (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()',
        [key, JSON.stringify(j)]
      );
      console.log(`✓ seed: ${key}`);
    }
  }
}

await seedDadosDeArquivosLocais();
await carregarDadosDoBanco();

// ===== Ruptura: snapshot diário + evolução =====
async function salvarSnapshotRuptura(ruptura) {
  const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  for (const escopo of ['geral', '20x80']) {
    const lista = ruptura?.ranking_compradores?.[escopo] || [];
    for (const r of lista) {
      if (!r.nome) continue;
      await run(
        `INSERT INTO ruptura_historico (data, escopo, comprador, skus, zerados, pct)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (data, escopo, comprador)
         DO UPDATE SET skus = EXCLUDED.skus, zerados = EXCLUDED.zerados, pct = EXCLUDED.pct`,
        [hoje, escopo, r.nome, r.skus || 0, r.zerados || 0, r.pct || 0]
      );
    }
  }
}

async function montarEvolucaoDiaria(diasMax = 30) {
  // Pega os N dias mais recentes com dados em ruptura_historico
  const datasRows = await query(
    `SELECT DISTINCT data FROM ruptura_historico ORDER BY data DESC LIMIT $1`,
    [diasMax]
  );
  const datas = datasRows.map(r => r.data).reverse(); // do mais antigo pro mais recente
  const datasFmt = datas.map(d => {
    const dt = (d instanceof Date) ? d : new Date(d);
    return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}`;
  });

  async function listaPorEscopo(escopo) {
    if (datas.length === 0) return [];
    const rows = await query(
      `SELECT data, comprador, pct FROM ruptura_historico
       WHERE escopo = $1 AND data = ANY($2::date[])`,
      [escopo, datas]
    );
    // Indexa por comprador → {data → pct}
    const idx = {};
    for (const r of rows) {
      if (!idx[r.comprador]) idx[r.comprador] = {};
      const dtStr = (r.data instanceof Date) ? r.data.toISOString().slice(0,10) : r.data;
      idx[r.comprador][dtStr] = r.pct;
    }
    // Monta saída
    const out = [];
    for (const comprador of Object.keys(idx)) {
      const por_dia = {};
      for (let i = 0; i < datas.length; i++) {
        const dtStr = (datas[i] instanceof Date) ? datas[i].toISOString().slice(0,10) : datas[i];
        const v = idx[comprador][dtStr];
        if (v != null) por_dia[datasFmt[i]] = v;
      }
      // "atual" = pct do dia mais recente disponível
      const atualKey = datasFmt[datasFmt.length - 1];
      out.push({
        nome: comprador,
        atual: por_dia[atualKey] ?? null,
        por_dia,
      });
    }
    return out;
  }

  return {
    datas: datasFmt,
    geral: await listaPorEscopo('geral'),
    '20x80': await listaPorEscopo('20x80'),
  };
}

// ===== App =====
const app = express();
app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1); // Render usa proxy reverso, precisa pra cookies seguros
app.use(express.json({ limit: '20mb' }));
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
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.clearCookie(COOKIE_NAME); return res.status(401).json({ error: 'invalid_token' }); }
}
function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'admin_required' });
    next();
  });
}

// ===== Páginas com gate =====
function paginaProtegida(req, res, arquivo, somenteAdmin = false) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (somenteAdmin && !u.is_admin) return res.status(403).send('Acesso restrito.');
  } catch { return res.redirect('/login.html'); }
  res.sendFile(path.join(__dirname, 'public', arquivo));
}

const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/primeiro-acesso.html', '/primeiro-acesso.js']);

app.get('/', (req, res) => paginaProtegida(req, res, 'index.html'));
app.get('/admin', (req, res) => paginaProtegida(req, res, 'admin.html', true));
app.get('/venda-diaria', (req, res) => paginaProtegida(req, res, 'venda-diaria.html'));
app.get('/venda-diaria/imprimir', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); }
  catch { return res.redirect('/login.html'); }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPaginaPDF(DATA_VENDAS));
});
app.get('/venda-diaria/imprimir-resumo', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); }
  catch { return res.redirect('/login.html'); }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPaginaVDResumoPDF(DATA_VENDAS));
});
app.get('/ruptura', (req, res) => paginaProtegida(req, res, 'ruptura.html'));
app.get('/troca', (req, res) => paginaProtegida(req, res, 'troca.html'));
app.get('/vagas', (req, res) => paginaProtegida(req, res, 'vagas.html'));
app.get('/kpis', (req, res) => paginaProtegida(req, res, 'kpis.html'));
app.get('/painel', (req, res) => paginaProtegida(req, res, 'painel.html'));
app.get('/metas', (req, res) => paginaProtegida(req, res, 'metas.html', true));
app.get('/margem-loja', (req, res) => paginaProtegida(req, res, 'margem-loja.html'));
app.get('/operacao', (req, res) => paginaProtegida(req, res, 'operacao.html'));
app.get('/estrategia', (req, res) => paginaProtegida(req, res, 'estrategia.html'));
app.get('/dre', (req, res) => paginaProtegida(req, res, 'dre.html'));
app.get('/margem-loja/imprimir', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); }
  catch { return res.redirect('/login.html'); }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPaginaMargemLojaPDF(DATA_MARGEM_LOJA));
});
app.get('/ruptura/imprimir', (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/login.html');
  try { jwt.verify(token, JWT_SECRET); }
  catch { return res.redirect('/login.html'); }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderPaginaRupturaPDF(DATA_RUPTURA));
});
app.get('/primeiro-acesso', (req, res) => res.sendFile(path.join(__dirname, 'public', 'primeiro-acesso.html')));

app.use((req, res, next) => {
  const p = req.path;
  if (PUBLIC_FILES.has(p)) return next();
  // Apenas HTMLs são gateados. JS/CSS são públicos (dados sensíveis ficam na API).
  const protegidos = ['/index.html', '/admin.html', '/venda-diaria.html', '/venda-diaria-pdf.html', '/ruptura.html', '/troca.html', '/vagas.html', '/kpis.html', '/painel.html', '/metas.html', '/margem-loja.html', '/operacao.html', '/estrategia.html', '/dre.html'];
  if (protegidos.includes(p)) {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.redirect('/login.html');
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.redirect('/login.html'); }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ===== API: auth =====
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'campos obrigatórios' });
  const login = String(username).trim();
  // Aceita username OU email
  const user = await queryOne(
    'SELECT * FROM users WHERE username = $1 OR LOWER(email) = LOWER($1)',
    [login]
  );
  if (!user) return res.status(401).json({ error: 'credenciais inválidas' });
  if (!user.ativo) return res.status(403).json({ error: 'usuário inativo — fale com o admin' });
  if (!user.senha_definida || !user.password_hash) return res.status(403).json({ error: 'você precisa definir sua senha pelo link de primeiro acesso' });
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

app.post('/api/me/password', authRequired, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'campos obrigatórios' });
  if (String(new_password).length < 6) return res.status(400).json({ error: 'senha nova precisa ter ao menos 6 caracteres' });
  const u = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(current_password, u.password_hash)) return res.status(401).json({ error: 'senha atual incorreta' });
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(new_password, 10), u.id]);
  res.json({ ok: true });
});

// ===== API: dados base =====
app.get('/api/data', authRequired, (req, res) => {
  res.json(DATA_MARGEM);
});

app.get('/api/vendas', authRequired, (req, res) => {
  if (!DATA_VENDAS) return res.status(404).json({ error: 'vendas ainda não foram carregadas — rode atualizar_vendas.sh' });
  res.json(DATA_VENDAS);
});

app.get('/api/ruptura', authRequired, (req, res) => {
  if (!DATA_RUPTURA) return res.status(404).json({ error: 'ruptura ainda não foi carregada — rode atualizar_ruptura.sh' });
  res.json(DATA_RUPTURA);
});

// ===== Vagas (Google Sheets) =====
const VAGAS_SHEET_ID = process.env.VAGAS_SHEET_ID || '1PwT_uPBIHjL6T5e0jLygBoBvaZTxCuSvgpNCLJJL7wg';
const sheetCsvUrl = (gid = 0) => `https://docs.google.com/spreadsheets/d/${VAGAS_SHEET_ID}/export?format=csv&gid=${gid}`;

// Mapeamento gid → nome do assistente (descoberto inspecionando as abas)
const VAGAS_ABAS_INDIVIDUAIS = [
  { gid: 156638889,  assistente: 'LIGIA' },
  { gid: 1044487008, assistente: 'PEDRO' },
  { gid: 1666912867, assistente: 'NATANAEL' },
  { gid: 1874280236, assistente: 'NATY' },
  { gid: 1794836369, assistente: 'YASMIN (ADM)' },
  { gid: 1935959339, assistente: 'POSTOS' },
];

app.get('/api/vagas', authRequired, async (req, res) => {
  const meta = await queryOne(`SELECT updated_at FROM app_data WHERE key = 'vagas'`);
  res.json({
    dados: DATA_VAGAS,
    ultima_atualizacao: meta?.updated_at || null,
  });
});

async function fetchCsv(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Google Sheets retornou ${r.status}`);
  const text = await r.text();
  if (text.includes('<!DOCTYPE html>')) throw new Error('Planilha não pública');
  return text;
}

app.post('/api/vagas/atualizar', authRequired, async (req, res) => {
  try {
    // Puxa painel geral + todas as abas individuais em paralelo
    const [csvPainel, ...csvsAbas] = await Promise.all([
      fetchCsv(sheetCsvUrl(0)),
      ...VAGAS_ABAS_INDIVIDUAIS.map(a => fetchCsv(sheetCsvUrl(a.gid))),
    ]);
    const abasIndividuais = VAGAS_ABAS_INDIVIDUAIS.map((a, i) => ({
      assistente: a.assistente, csv: csvsAbas[i],
    }));
    const dados = parseVagasCompleto(csvPainel, abasIndividuais);
    await run(
      `INSERT INTO app_data (key, data, updated_by, updated_at)
       VALUES ('vagas', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(dados), req.user.id]
    );
    DATA_VAGAS = dados;
    res.json({ ok: true, dados });
  } catch (e) {
    console.error('vagas/atualizar:', e);
    if (/não pública|HTML/i.test(e.message)) {
      return res.status(403).json({ error: 'Planilha não está pública. Compartilhe como "Qualquer pessoa com o link".' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/troca', authRequired, (req, res) => {
  if (!DATA_TROCA) return res.json({ vazio: true, msg: 'sem dados ainda — clique em Atualizar' });
  res.json(DATA_TROCA);
});

// Solicita atualização — qualquer user logado
app.post('/api/troca/atualizar', authRequired, async (req, res) => {
  // Se já tem uma pendente ou processando, retorna ela em vez de criar outra
  const existente = await queryOne(
    `SELECT * FROM troca_atualizacao WHERE status IN ('pendente','processando') ORDER BY id DESC LIMIT 1`
  );
  if (existente) return res.json({ ok: true, jaExistia: true, solicitacao: existente });

  const { row } = await run(
    `INSERT INTO troca_atualizacao (solicitado_por) VALUES ($1) RETURNING *`,
    [req.user.id]
  );
  res.json({ ok: true, solicitacao: row });
});

// Status: última solicitação + última vez que os dados foram atualizados
app.get('/api/troca/status', authRequired, async (req, res) => {
  const ultimaSol = await queryOne(
    `SELECT s.*, u.username AS solicitado_por_nome
     FROM troca_atualizacao s LEFT JOIN users u ON u.id = s.solicitado_por
     ORDER BY s.id DESC LIMIT 1`
  );
  const ultimaAtualiz = await queryOne(
    `SELECT updated_at FROM app_data WHERE key = 'troca'`
  );
  res.json({
    ultima_solicitacao: ultimaSol,
    ultima_atualizacao: ultimaAtualiz?.updated_at || null,
    tem_dados: DATA_TROCA != null && DATA_TROCA.itens != null,
  });
});

// === Endpoints do daemon (admin only) ===
// Pega a próxima solicitação pendente — marca como "processando" atomicamente
app.post('/api/admin/troca/proxima-pendente', adminRequired, async (req, res) => {
  const { row } = await run(
    `UPDATE troca_atualizacao
       SET status = 'processando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM troca_atualizacao
       WHERE status = 'pendente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  res.json({ pendente: row || null });
});

// Daemon notifica o resultado
app.post('/api/admin/troca/finalizar', adminRequired, async (req, res) => {
  const { id, status, mensagem } = req.body || {};
  if (!id || !['ok', 'erro'].includes(status)) {
    return res.status(400).json({ error: 'id e status (ok|erro) obrigatórios' });
  }
  await run(
    `UPDATE troca_atualizacao SET status = $1, processado_em = NOW(), mensagem = $2 WHERE id = $3`,
    [status, mensagem || null, id]
  );
  res.json({ ok: true });
});

// ===== KPIs Comerciais (mesmo padrão da Troca) =====
app.get('/api/kpis', authRequired, (req, res) => {
  if (!DATA_KPIS) return res.json({ vazio: true, msg: 'sem dados ainda — clique em Atualizar' });
  res.json(DATA_KPIS);
});

// ===== Margem por Loja (mesmo padrão da Troca/KPIs) =====
app.get('/api/margem-loja', authRequired, (req, res) => {
  if (!DATA_MARGEM_LOJA) return res.json({ vazio: true, msg: 'sem dados ainda — atualização automática roda às 06:30' });
  res.json(DATA_MARGEM_LOJA);
});

app.post('/api/margem-loja/atualizar', authRequired, async (req, res) => {
  const existente = await queryOne(
    `SELECT * FROM margem_loja_atualizacao WHERE status IN ('pendente','processando') ORDER BY id DESC LIMIT 1`
  );
  if (existente) return res.json({ ok: true, jaExistia: true, solicitacao: existente });
  const { row } = await run(
    `INSERT INTO margem_loja_atualizacao (solicitado_por) VALUES ($1) RETURNING *`,
    [req.user.id]
  );
  res.json({ ok: true, solicitacao: row });
});

app.get('/api/margem-loja/status', authRequired, async (req, res) => {
  const ultimaSol = await queryOne(
    `SELECT s.*, u.username AS solicitado_por_nome
     FROM margem_loja_atualizacao s LEFT JOIN users u ON u.id = s.solicitado_por
     ORDER BY s.id DESC LIMIT 1`
  );
  const ultimaAtualiz = await queryOne(`SELECT updated_at FROM app_data WHERE key = 'margem_loja'`);
  res.json({
    ultima_solicitacao: ultimaSol,
    ultima_atualizacao: ultimaAtualiz?.updated_at || null,
    tem_dados: DATA_MARGEM_LOJA != null,
  });
});

app.post('/api/admin/margem-loja/proxima-pendente', adminRequired, async (req, res) => {
  const { row } = await run(
    `UPDATE margem_loja_atualizacao
       SET status = 'processando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM margem_loja_atualizacao
       WHERE status = 'pendente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  res.json({ pendente: row || null });
});

app.post('/api/admin/margem-loja/finalizar', adminRequired, async (req, res) => {
  const { id, status, mensagem } = req.body || {};
  if (!id || !['ok', 'erro'].includes(status)) {
    return res.status(400).json({ error: 'id e status (ok|erro) obrigatórios' });
  }
  await run(
    `UPDATE margem_loja_atualizacao SET status = $1, processado_em = NOW(), mensagem = $2 WHERE id = $3`,
    [status, mensagem || null, id]
  );
  res.json({ ok: true });
});

// ===== Operação (Indicadores da Supervisão) =====
app.get('/api/operacao', authRequired, (req, res) => {
  if (!DATA_OPERACAO) return res.json({ vazio: true, msg: 'sem dados ainda — atualização automática diária' });
  res.json(DATA_OPERACAO);
});

app.post('/api/operacao/atualizar', authRequired, async (req, res) => {
  const existente = await queryOne(
    `SELECT * FROM operacao_atualizacao WHERE status IN ('pendente','processando') ORDER BY id DESC LIMIT 1`
  );
  if (existente) return res.json({ ok: true, jaExistia: true, solicitacao: existente });
  const { row } = await run(
    `INSERT INTO operacao_atualizacao (solicitado_por) VALUES ($1) RETURNING *`,
    [req.user.id]
  );
  res.json({ ok: true, solicitacao: row });
});

app.get('/api/operacao/status', authRequired, async (req, res) => {
  const ultimaSol = await queryOne(
    `SELECT s.*, u.username AS solicitado_por_nome
     FROM operacao_atualizacao s LEFT JOIN users u ON u.id = s.solicitado_por
     ORDER BY s.id DESC LIMIT 1`
  );
  const ultimaAtualiz = await queryOne(`SELECT updated_at FROM app_data WHERE key = 'operacao'`);
  res.json({
    ultima_solicitacao: ultimaSol,
    ultima_atualizacao: ultimaAtualiz?.updated_at || null,
    tem_dados: DATA_OPERACAO != null,
  });
});

app.post('/api/admin/operacao/proxima-pendente', adminRequired, async (req, res) => {
  const { row } = await run(
    `UPDATE operacao_atualizacao
       SET status = 'processando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM operacao_atualizacao
       WHERE status = 'pendente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  res.json({ pendente: row || null });
});

app.post('/api/admin/operacao/finalizar', adminRequired, async (req, res) => {
  const { id, status, mensagem } = req.body || {};
  if (!id || !['ok', 'erro'].includes(status)) {
    return res.status(400).json({ error: 'id e status (ok|erro) obrigatórios' });
  }
  await run(
    `UPDATE operacao_atualizacao SET status = $1, processado_em = NOW(), mensagem = $2 WHERE id = $3`,
    [status, mensagem || null, id]
  );
  res.json({ ok: true });
});

// ===== Nível Estratégia (comparativo de vendas) =====
app.get('/api/estrategia', authRequired, (req, res) => {
  if (!DATA_ESTRATEGIA) return res.json({ vazio: true, msg: 'sem dados ainda' });
  res.json(DATA_ESTRATEGIA);
});

app.post('/api/estrategia/atualizar', authRequired, async (req, res) => {
  const existente = await queryOne(
    `SELECT * FROM estrategia_atualizacao WHERE status IN ('pendente','processando') ORDER BY id DESC LIMIT 1`
  );
  if (existente) return res.json({ ok: true, jaExistia: true, solicitacao: existente });
  const { row } = await run(
    `INSERT INTO estrategia_atualizacao (solicitado_por) VALUES ($1) RETURNING *`,
    [req.user.id]
  );
  res.json({ ok: true, solicitacao: row });
});

app.get('/api/estrategia/status', authRequired, async (req, res) => {
  const ultimaSol = await queryOne(
    `SELECT s.*, u.username AS solicitado_por_nome
     FROM estrategia_atualizacao s LEFT JOIN users u ON u.id = s.solicitado_por
     ORDER BY s.id DESC LIMIT 1`
  );
  const ultimaAtualiz = await queryOne(`SELECT updated_at FROM app_data WHERE key = 'estrategia'`);
  res.json({
    ultima_solicitacao: ultimaSol,
    ultima_atualizacao: ultimaAtualiz?.updated_at || null,
    tem_dados: DATA_ESTRATEGIA != null,
  });
});

app.post('/api/admin/estrategia/proxima-pendente', adminRequired, async (req, res) => {
  const { row } = await run(
    `UPDATE estrategia_atualizacao
       SET status = 'processando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM estrategia_atualizacao
       WHERE status = 'pendente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  res.json({ pendente: row || null });
});

app.post('/api/admin/estrategia/finalizar', adminRequired, async (req, res) => {
  const { id, status, mensagem } = req.body || {};
  if (!id || !['ok', 'erro'].includes(status)) {
    return res.status(400).json({ error: 'id e status (ok|erro) obrigatórios' });
  }
  await run(
    `UPDATE estrategia_atualizacao SET status = $1, processado_em = NOW(), mensagem = $2 WHERE id = $3`,
    [status, mensagem || null, id]
  );
  res.json({ ok: true });
});

app.post('/api/kpis/atualizar', authRequired, async (req, res) => {
  const existente = await queryOne(
    `SELECT * FROM kpis_atualizacao WHERE status IN ('pendente','processando') ORDER BY id DESC LIMIT 1`
  );
  if (existente) return res.json({ ok: true, jaExistia: true, solicitacao: existente });
  const { row } = await run(
    `INSERT INTO kpis_atualizacao (solicitado_por) VALUES ($1) RETURNING *`,
    [req.user.id]
  );
  res.json({ ok: true, solicitacao: row });
});

app.get('/api/kpis/status', authRequired, async (req, res) => {
  const ultimaSol = await queryOne(
    `SELECT s.*, u.username AS solicitado_por_nome
     FROM kpis_atualizacao s LEFT JOIN users u ON u.id = s.solicitado_por
     ORDER BY s.id DESC LIMIT 1`
  );
  const ultimaAtualiz = await queryOne(`SELECT updated_at FROM app_data WHERE key = 'kpis'`);
  res.json({
    ultima_solicitacao: ultimaSol,
    ultima_atualizacao: ultimaAtualiz?.updated_at || null,
    tem_dados: DATA_KPIS != null,
  });
});

app.post('/api/admin/kpis/proxima-pendente', adminRequired, async (req, res) => {
  const { row } = await run(
    `UPDATE kpis_atualizacao
       SET status = 'processando', iniciado_em = NOW()
     WHERE id = (
       SELECT id FROM kpis_atualizacao
       WHERE status = 'pendente'
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  res.json({ pendente: row || null });
});

app.post('/api/admin/kpis/finalizar', adminRequired, async (req, res) => {
  const { id, status, mensagem } = req.body || {};
  if (!id || !['ok', 'erro'].includes(status)) {
    return res.status(400).json({ error: 'id e status (ok|erro) obrigatórios' });
  }
  await run(
    `UPDATE kpis_atualizacao SET status = $1, processado_em = NOW(), mensagem = $2 WHERE id = $3`,
    [status, mensagem || null, id]
  );
  res.json({ ok: true });
});

// ===== Metas manuais (admin) =====
// Override de metas em cima do que vem da planilha. Schema versionado por mês:
// { "YYYY-MM": {
//     gerentes: { Andre: {meta_dde, meta_ruptura}, Walas: {...} },
//     total: { meta_dde, meta_ruptura },
//     compradores: { "01-MAURIC(SEC)": {meta_dde, meta_ruptura, meta_quebra, meta_troca, meta_foto} } } }
function getMesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getMesKpis(kpis) {
  const dt = kpis?.periodo?.fim || kpis?.periodo?.inicio;
  return (typeof dt === 'string' && /^\d{4}-\d{2}/.test(dt)) ? dt.slice(0, 7) : null;
}
async function lerMetasManuais() {
  const r = await queryOne(`SELECT data FROM app_data WHERE key = 'metas_manuais'`);
  let data = r?.data || {};
  // Migração transiente: schema antigo (sem mês) → atribui ao mês atual
  if (data && (data.gerentes || data.total || data.compradores)) {
    data = { [getMesAtual()]: data };
  }
  return data;
}
async function salvarMetasManuais(all, userId) {
  await run(
    `INSERT INTO app_data (key, data, updated_by, updated_at)
     VALUES ('metas_manuais', $1::jsonb, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [JSON.stringify(all), userId]
  );
}

function recalcAtingimentos(kpis) {
  const ating = (real, meta, inv) => {
    if (real == null || !meta) return null;
    return inv ? meta / Math.max(real, 0.0001) : real / meta;
  };
  const PESOS = [
    ['venda',   'meta_venda',   false, 0.50],
    ['dde',     'meta_dde',     true,  0.10],
    ['ruptura', 'meta_ruptura', true,  0.15],
    ['perda',   'meta_quebra',  true,  0.05],
    ['troca',   'meta_troca',   true,  0.10],
    ['foto',    'meta_foto',    false, 0.10],
  ];
  const calcAtTot = (o) => {
    let tot = 0;
    for (const [r, m, inv, p] of PESOS) {
      const at = ating(o[r], o[m], inv);
      tot += Math.min((at == null ? 0 : at) * p, p);
    }
    return tot;
  };

  // Recalcula ranks dentro de compradores (1 = pior)
  const compradores = kpis.compradores || [];
  const aplicarRank = (campo, kReal, kMeta, inv) => {
    const arr = compradores
      .map(c => ({ c, at: ating(c[kReal], c[kMeta], inv) }))
      .filter(x => x.at != null)
      .sort((a, b) => a.at - b.at);
    for (const c of compradores) c[campo] = null;
    arr.forEach((x, i) => { x.c[campo] = i + 1; });
  };
  aplicarRank('rank_venda',   'venda',   'meta_venda',   false);
  aplicarRank('rank_margem',  'margem',  'meta_margem',  false);
  aplicarRank('rank_dde',     'dde',     'meta_dde',     true);
  aplicarRank('rank_ruptura', 'ruptura', 'meta_ruptura', true);
  aplicarRank('rank_quebra',  'perda',   'meta_quebra',  true);
  aplicarRank('rank_troca',   'troca',   'meta_troca',   true);

  for (const c of compradores) {
    c.ating_total = calcAtTot(c);
    const atMarg = ating(c.margem, c.meta_margem, false);
    if (atMarg != null && atMarg >= 1) {
      const extra = c.ating_total >= 1 ? 2000 : (c.ating_total >= 0.95 ? 1000 : 0);
      c.premiacao = 2000 + extra;
    } else {
      c.premiacao = 0;
    }
  }
  for (const o of [kpis.gerentes?.Andre, kpis.gerentes?.Walas, kpis.total]) {
    if (o) o.ating_total = calcAtTot(o);
  }
}

// Campos manuais possíveis
const CAMPOS_C = ['meta_venda', 'meta_margem', 'meta_dde', 'meta_ruptura', 'meta_quebra', 'meta_troca', 'meta_foto'];
const CAMPOS_G = ['meta_venda', 'meta_margem', 'meta_dde', 'meta_ruptura'];
const CAMPOS_T = ['meta_venda', 'meta_margem', 'meta_dde', 'meta_ruptura'];
// Campos que são soma de compradores → re-agregar pra gerentes/total quando não overridden
const SUMAVEIS = ['meta_venda', 'meta_margem', 'meta_quebra', 'meta_troca', 'meta_foto'];

async function aplicarMetasManuais(kpis) {
  if (!kpis || typeof kpis !== 'object') return;
  const all = await lerMetasManuais();
  const mes = getMesKpis(kpis) || getMesAtual();
  // Pega metas do mês dos kpis; se não tiver, tenta o mês mais recente <= esse mês (fallback)
  let m = all[mes];
  if (!m) {
    const mesesAnt = Object.keys(all).filter(k => k <= mes).sort();
    if (mesesAnt.length) m = all[mesesAnt[mesesAnt.length - 1]];
  }
  if (!m) return;
  let mexeu = false;

  // 1) Compradores
  for (const c of kpis.compradores || []) {
    const src = m.compradores?.[c.nome];
    if (!src) continue;
    for (const campo of CAMPOS_C) {
      if (src[campo] != null) { c[campo] = src[campo]; mexeu = true; }
    }
  }

  // 2) Re-agrega gerentes (sum-áveis) a partir dos compradores
  const gerOver = { Andre: new Set(), Walas: new Set() };
  if (kpis.gerentes && kpis.compradores) {
    const filtro = { Andre: c => c.gerente === 'André', Walas: c => c.gerente === 'Walas' };
    for (const k of ['Andre', 'Walas']) {
      const dst = kpis.gerentes[k];
      if (!dst) continue;
      const items = kpis.compradores.filter(filtro[k]);
      for (const campo of SUMAVEIS) {
        const sum = items.reduce((s, c) => s + (Number(c[campo]) || 0), 0);
        if (sum > 0) { dst[campo] = sum; mexeu = true; }
      }
    }
  }

  // 3) Override explícito de gerentes (por cima do agregado)
  if (kpis.gerentes) {
    for (const k of ['Andre', 'Walas']) {
      const src = m.gerentes?.[k];
      const dst = kpis.gerentes[k];
      if (!src || !dst) continue;
      for (const campo of CAMPOS_G) {
        if (src[campo] != null) {
          dst[campo] = src[campo];
          gerOver[k].add(campo);
          mexeu = true;
        }
      }
    }
  }

  // 4) Re-agrega total (só meta_quebra/troca/foto: meta_venda e meta_margem total
  //    vêm de uma célula direta da planilha — só sobrescreve se override explícito)
  const totOver = new Set();
  if (kpis.total && kpis.compradores) {
    for (const campo of ['meta_quebra', 'meta_troca', 'meta_foto']) {
      const sum = kpis.compradores.reduce((s, c) => s + (Number(c[campo]) || 0), 0);
      if (sum > 0) { kpis.total[campo] = sum; mexeu = true; }
    }
  }

  // 5) Override explícito do total
  if (kpis.total && m.total) {
    for (const campo of CAMPOS_T) {
      if (m.total[campo] != null) {
        kpis.total[campo] = m.total[campo];
        totOver.add(campo);
        mexeu = true;
      }
    }
  }

  // 6) Recalcula metas_diarias com base nas metas mensais + percentuais (manuais ou planilha)
  recalcMetasDiarias(kpis, m, mes);

  if (mexeu) recalcAtingimentos(kpis);
}

function diasDoMes(mes) {
  const [a, mm] = mes.split('-').map(Number);
  const ult = new Date(a, mm, 0).getDate();
  const out = [];
  for (let d = 1; d <= ult; d++) {
    out.push({ dia: d, iso: `${a}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}` });
  }
  return out;
}

function recalcMetasDiarias(kpis, m, mes) {
  if (!kpis.compradores) return;
  const dias = diasDoMes(mes);
  const pctMan = m?.percentuais || {};

  // Garante o objeto
  if (!kpis.metas_diarias) kpis.metas_diarias = {};

  for (const c of kpis.compradores || []) {
    const monthlyV = Number(c.meta_venda)  || 0;
    const monthlyM = Number(c.meta_margem) || 0;
    const pct = pctMan[c.nome];

    // Se tem percentuais manuais → distribui usando eles
    if (pct && Object.keys(pct).length) {
      const novo = {};
      for (const { dia, iso } of dias) {
        const key = String(dia).padStart(2, '0');
        const p = pct[key] || pct[String(dia)];
        if (!p) continue;
        const obj = {};
        if (p.venda  != null && monthlyV) obj.meta_venda  = monthlyV * (Number(p.venda)  / 100);
        if (p.margem != null && monthlyM) obj.meta_margem = monthlyM * (Number(p.margem) / 100);
        if (Object.keys(obj).length) novo[iso] = obj;
      }
      kpis.metas_diarias[c.nome] = novo;
      continue;
    }

    // Sem percentuais manuais — escala a curva da planilha pra bater com a meta mensal
    const atual = kpis.metas_diarias[c.nome];
    if (atual && Object.keys(atual).length) {
      let sumV = 0, sumM = 0;
      for (const d of Object.values(atual)) {
        sumV += Number(d.meta_venda)  || 0;
        sumM += Number(d.meta_margem) || 0;
      }
      const fV = (sumV > 0 && monthlyV) ? monthlyV / sumV : null;
      const fM = (sumM > 0 && monthlyM) ? monthlyM / sumM : null;
      if (fV != null || fM != null) {
        for (const d of Object.values(atual)) {
          if (fV != null && d.meta_venda  != null) d.meta_venda  *= fV;
          if (fM != null && d.meta_margem != null) d.meta_margem *= fM;
        }
      }
      continue;
    }

    // Sem nada — divide igual entre todos os dias do mês
    if (monthlyV || monthlyM) {
      const novo = {};
      const vd = monthlyV ? monthlyV / dias.length : 0;
      const md = monthlyM ? monthlyM / dias.length : 0;
      for (const { iso } of dias) {
        const obj = {};
        if (vd) obj.meta_venda  = vd;
        if (md) obj.meta_margem = md;
        if (Object.keys(obj).length) novo[iso] = obj;
      }
      kpis.metas_diarias[c.nome] = novo;
    }
  }
}

app.get('/api/admin/metas', adminRequired, async (req, res) => {
  const all = await lerMetasManuais();
  const mesKpis = DATA_KPIS ? getMesKpis(DATA_KPIS) : null;
  const mes = String(req.query.mes || mesKpis || getMesAtual());

  // Compradores e metas atuais da planilha (vindos do último kpis.json) — pra pré-preencher
  const compradores = (DATA_KPIS?.compradores || []).map(c => {
    const out = { nome: c.nome, gerente: c.gerente };
    for (const campo of CAMPOS_C) out[campo] = c[campo];
    return out;
  });
  const planilha = {
    gerentes: {
      Andre: {}, Walas: {},
    },
    total: {},
  };
  for (const k of ['Andre', 'Walas']) {
    const g = DATA_KPIS?.gerentes?.[k];
    if (g) for (const campo of CAMPOS_G) planilha.gerentes[k][campo] = g[campo];
  }
  if (DATA_KPIS?.total) {
    for (const campo of CAMPOS_T) planilha.total[campo] = DATA_KPIS.total[campo];
  }

  // Percentuais derivados da planilha (curva atual de metas_diarias) — pra template
  // Saída: { nome: { "01": { venda, margem }, ... } } em PERCENTUAL (0-100)
  const pctPlanilha = {};
  const md = DATA_KPIS?.metas_diarias || {};
  for (const [nome, dias] of Object.entries(md)) {
    let totV = 0, totM = 0;
    for (const d of Object.values(dias)) {
      totV += Number(d.meta_venda)  || 0;
      totM += Number(d.meta_margem) || 0;
    }
    if (totV === 0 && totM === 0) continue;
    const out = {};
    for (const [iso, d] of Object.entries(dias)) {
      const dia = parseInt(iso.slice(8, 10), 10);
      if (!dia) continue;
      const k = String(dia).padStart(2, '0');
      const o = {};
      if (totV > 0 && d.meta_venda  != null) o.venda  = (Number(d.meta_venda)  / totV) * 100;
      if (totM > 0 && d.meta_margem != null) o.margem = (Number(d.meta_margem) / totM) * 100;
      if (Object.keys(o).length) out[k] = o;
    }
    if (Object.keys(out).length) pctPlanilha[nome] = out;
  }

  res.json({
    mes,
    mes_kpis: mesKpis,
    metas: all[mes] || null,
    meses_salvos: Object.keys(all).sort(),
    compradores,
    percentuais_planilha: pctPlanilha,
    planilha,
  });
});

app.post('/api/admin/metas', adminRequired, async (req, res) => {
  const body = req.body || {};
  const mes = String(body.mes || (DATA_KPIS ? getMesKpis(DATA_KPIS) : null) || getMesAtual());
  if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'mes inválido (use YYYY-MM)' });

  const limpo = { gerentes: {}, total: {}, compradores: {}, percentuais: {} };
  const numOrNull = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (const k of ['Andre', 'Walas']) {
    const g = body.gerentes?.[k];
    if (!g) continue;
    const out = {};
    for (const campo of CAMPOS_G) {
      const v = numOrNull(g[campo]);
      if (v != null) out[campo] = v;
    }
    if (Object.keys(out).length) limpo.gerentes[k] = out;
  }
  if (body.total) {
    for (const campo of CAMPOS_T) {
      const v = numOrNull(body.total[campo]);
      if (v != null) limpo.total[campo] = v;
    }
  }
  if (body.compradores && typeof body.compradores === 'object') {
    for (const [nome, src] of Object.entries(body.compradores)) {
      if (!src || typeof src !== 'object') continue;
      const out = {};
      for (const campo of CAMPOS_C) {
        const v = numOrNull(src[campo]);
        if (v != null) out[campo] = v;
      }
      if (Object.keys(out).length) limpo.compradores[nome] = out;
    }
  }
  // Percentuais diários: { nome: { "01": {venda, margem}, ... } }
  if (body.percentuais && typeof body.percentuais === 'object') {
    for (const [nome, dias] of Object.entries(body.percentuais)) {
      if (!dias || typeof dias !== 'object') continue;
      const outNome = {};
      for (const [diaStr, pct] of Object.entries(dias)) {
        if (!pct || typeof pct !== 'object') continue;
        const diaN = parseInt(diaStr, 10);
        if (!(diaN >= 1 && diaN <= 31)) continue;
        const v = numOrNull(pct.venda);
        const ma = numOrNull(pct.margem);
        if (v == null && ma == null) continue;
        const k = String(diaN).padStart(2, '0');
        outNome[k] = {};
        if (v  != null) outNome[k].venda  = v;
        if (ma != null) outNome[k].margem = ma;
      }
      if (Object.keys(outNome).length) limpo.percentuais[nome] = outNome;
    }
  }

  const all = await lerMetasManuais();
  // Se body.apagar for true, remove o mês
  if (body.apagar === true) {
    delete all[mes];
  } else {
    all[mes] = limpo;
  }
  await salvarMetasManuais(all, req.user.id);

  // Aplica imediatamente nos KPIs em memória só se for o mês atual dos kpis
  // Re-parte do raw (planilha pura) → aplica manuais → salva. Assim, apagar restaura;
  // alterar override muda só o que mudou.
  let aplicado = false;
  const base = DATA_KPIS_RAW || DATA_KPIS;
  if (base && (getMesKpis(base) === mes || !getMesKpis(base))) {
    const kpis = JSON.parse(JSON.stringify(base));
    await aplicarMetasManuais(kpis);
    DATA_KPIS = kpis;
    await run(
      `INSERT INTO app_data (key, data, updated_by, updated_at)
       VALUES ('kpis', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(DATA_KPIS), req.user.id]
    );
    aplicado = true;
  }

  res.json({ ok: true, mes, aplicado_em_kpis: aplicado });
});

// ===== API: upload de dados (apenas admin) =====
app.post('/api/admin/upload-dados', adminRequired, async (req, res) => {
  const { margem, vendas, ruptura, troca, kpis, margem_loja } = req.body || {};
  let atualizados = [];
  async function salvar(key, data) {
    await run(
      'INSERT INTO app_data (key, data, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()',
      [key, JSON.stringify(data), req.user.id]
    );
  }
  if (Array.isArray(margem)) {
    await salvar('margem', margem);
    DATA_MARGEM = margem;
    atualizados.push(`margem (${margem.length} categorias)`);
  }
  if (vendas && typeof vendas === 'object') {
    await salvar('vendas', vendas);
    DATA_VENDAS = vendas;
    atualizados.push(`vendas (${vendas.dias?.length || 0} dias)`);
  }
  if (ruptura && typeof ruptura === 'object') {
    // Salva snapshot do dia em ruptura_historico e monta evolucao_diaria
    // a partir do histórico (até 30 dias).
    await salvarSnapshotRuptura(ruptura);
    ruptura.evolucao_diaria = await montarEvolucaoDiaria();
    await salvar('ruptura', ruptura);
    DATA_RUPTURA = ruptura;
    atualizados.push(`ruptura (${ruptura.itens?.length || 0} itens, evolução: ${ruptura.evolucao_diaria.datas.length} dias)`);
  }
  if (troca && typeof troca === 'object') {
    await salvar('troca', troca);
    DATA_TROCA = troca;
    atualizados.push(`troca (${troca.itens?.length || 0} itens)`);
  }
  if (kpis && typeof kpis === 'object') {
    // Salva 'raw' (planilha pura, sem overrides manuais) — usado quando manuais mudam
    const kpisRaw = JSON.parse(JSON.stringify(kpis));
    await salvar('kpis_raw', kpisRaw);
    DATA_KPIS_RAW = kpisRaw;
    // Merge metas manuais por cima das vindas da planilha
    await aplicarMetasManuais(kpis);
    await salvar('kpis', kpis);
    DATA_KPIS = kpis;
    atualizados.push(`kpis (${kpis.compradores?.length || 0} compradores)`);
  }
  if (margem_loja && typeof margem_loja === 'object') {
    await salvar('margem_loja', margem_loja);
    DATA_MARGEM_LOJA = margem_loja;
    atualizados.push(`margem_loja (${margem_loja.linhas?.length || 0} linhas)`);
  }
  if (req.body.operacao && typeof req.body.operacao === 'object') {
    await salvar('operacao', req.body.operacao);
    DATA_OPERACAO = req.body.operacao;
    atualizados.push(`operacao (${req.body.operacao.lojas?.length || 0} lojas)`);
  }
  if (req.body.estrategia && typeof req.body.estrategia === 'object') {
    await salvar('estrategia', req.body.estrategia);
    DATA_ESTRATEGIA = req.body.estrategia;
    atualizados.push(`estrategia (${req.body.estrategia.lojas?.length || 0} lojas)`);
  }
  if (atualizados.length === 0) return res.status(400).json({ error: 'nenhum dado válido enviado' });
  console.log(`↻ upload-dados por ${req.user.username}: ${atualizados.join(', ')}`);
  res.json({ ok: true, atualizados });
});

app.get('/api/admin/data-status', adminRequired, async (req, res) => {
  const rows = await query('SELECT key, updated_at, (SELECT username FROM users WHERE id = updated_by) AS updated_by FROM app_data');
  res.json({
    margem: rows.find(r => r.key === 'margem') || null,
    vendas: rows.find(r => r.key === 'vendas') || null,
    margem_count: DATA_MARGEM?.length || 0,
    vendas_dias: DATA_VENDAS?.dias?.length || 0,
  });
});

// ===== API: cenários =====
app.get('/api/scenarios', authRequired, async (req, res) => {
  const rows = await query(`
    SELECT s.id, s.name, s.updated_at, u.username AS updated_by
    FROM scenarios s LEFT JOIN users u ON u.id = s.updated_by
    ORDER BY (s.name = 'Padrão') DESC, s.name ASC
  `);
  res.json(rows);
});

app.get('/api/scenarios/:id', authRequired, async (req, res) => {
  const row = await queryOne('SELECT * FROM scenarios WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  res.json({ id: row.id, name: row.name, overrides: row.overrides_json, updated_at: row.updated_at });
});

app.post('/api/scenarios', authRequired, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'nome obrigatório' });
  const dup = await queryOne('SELECT id FROM scenarios WHERE name = $1', [name]);
  if (dup) return res.status(409).json({ error: 'já existe um cenário com esse nome' });
  const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
  const r = await run(
    'INSERT INTO scenarios (name, overrides_json, created_by, updated_by) VALUES ($1, $2::jsonb, $3, $4) RETURNING id',
    [name, JSON.stringify(overrides), req.user.id, req.user.id]
  );
  res.json({ id: r.row.id, name });
});

app.put('/api/scenarios/:id', authRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await queryOne('SELECT * FROM scenarios WHERE id = $1', [id]);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null;
  const newName = req.body?.name ? String(req.body.name).trim() : null;
  if (newName && newName !== row.name) {
    const dup = await queryOne('SELECT id FROM scenarios WHERE name = $1 AND id != $2', [newName, id]);
    if (dup) return res.status(409).json({ error: 'já existe um cenário com esse nome' });
  }
  await run(`
    UPDATE scenarios
    SET overrides_json = COALESCE($1::jsonb, overrides_json),
        name = COALESCE($2, name),
        updated_by = $3,
        updated_at = NOW()
    WHERE id = $4
  `, [overrides == null ? null : JSON.stringify(overrides), newName, req.user.id, id]);
  res.json({ ok: true });
});

app.delete('/api/scenarios/:id', authRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await queryOne('SELECT * FROM scenarios WHERE id = $1', [id]);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  if (row.name === 'Padrão') return res.status(400).json({ error: 'cenário Padrão não pode ser excluído' });
  await run('DELETE FROM scenarios WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ===== Helpers =====
function gerarTokenPrimeiroAcesso() { return randomBytes(24).toString('hex'); }
function dataExpiraEm(dias) { const d = new Date(); d.setDate(d.getDate() + dias); return d.toISOString(); }
function digitosOnly(s) { return String(s || '').replace(/\D/g, ''); }
function emailValido(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
function cpfValido(s) {
  const c = digitosOnly(s);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += parseInt(c[i], 10) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(c[9], 10) && calc(10) === parseInt(c[10], 10);
}

// ===== API: usuários (admin) =====
// ===== API: dimensões (Configurações > Dimensões > Geral) =====
app.get('/api/dim/lojas', authRequired, async (req, res) => {
  const rows = await query('SELECT nroempresa, nome FROM dim_lojas ORDER BY nroempresa');
  res.json(rows);
});
app.get('/api/dim/anos', authRequired, async (req, res) => {
  const rows = await query('SELECT ano FROM dim_anos ORDER BY ano DESC');
  res.json(rows);
});
app.get('/api/dim/meses', authRequired, async (req, res) => {
  const rows = await query('SELECT numero, nome FROM dim_meses ORDER BY numero');
  res.json(rows);
});

app.get('/api/users', adminRequired, async (req, res) => {
  const rows = await query(`
    SELECT id, username, nome, email, telefone, cpf, cargo, nivel, ativo, is_admin, senha_definida, token_primeiro_acesso, token_expira_em, created_at
    FROM users ORDER BY ativo DESC, COALESCE(nome, username)
  `);
  res.json(rows);
});

app.post('/api/users', adminRequired, async (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const telefone = String(req.body?.telefone || '').trim();
  const cpf = String(req.body?.cpf || '').trim();
  const cargo = String(req.body?.cargo || '').trim();
  const nivelInput = String(req.body?.nivel || '').trim().toLowerCase();
  const NIVEIS_VALIDOS = ['administrador', 'ger-comercial', 'gerente', 'supervisor', 'comprador'];
  const nivel = NIVEIS_VALIDOS.includes(nivelInput) ? nivelInput : 'comprador';
  const is_admin = !!req.body?.is_admin;

  if (!nome) return res.status(400).json({ error: 'nome é obrigatório' });
  if (!email) return res.status(400).json({ error: 'email é obrigatório' });
  if (!emailValido(email)) return res.status(400).json({ error: 'email inválido' });
  if (cpf && !cpfValido(cpf)) return res.status(400).json({ error: 'CPF inválido' });

  const cpfDigits = digitosOnly(cpf);
  const telefoneDigits = digitosOnly(telefone);

  // username = email (login)
  const dup = await queryOne(
    'SELECT id FROM users WHERE LOWER(email) = $1 OR username = $2',
    [email, email]
  );
  if (dup) return res.status(409).json({ error: 'já existe um usuário com esse email' });

  const token = gerarTokenPrimeiroAcesso();
  const exp = dataExpiraEm(7);

  const r = await run(`
    INSERT INTO users (username, nome, email, telefone, cpf, cargo, nivel, is_admin, ativo, senha_definida, token_primeiro_acesso, token_expira_em)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE, $9, $10)
    RETURNING id
  `, [email, nome, email, telefoneDigits || null, cpfDigits || null, cargo || null, nivel, is_admin, token, exp]);

  res.json({
    id: r.row.id,
    nome, email, telefone: telefoneDigits, cpf: cpfDigits, cargo, nivel, is_admin,
    link_primeiro_acesso: `/primeiro-acesso?token=${token}`,
    expira_em: exp,
  });
});

app.put('/api/users/:id', adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'não encontrado' });

  const nome = req.body?.nome != null ? String(req.body.nome).trim() : null;
  const email = req.body?.email != null ? String(req.body.email).trim().toLowerCase() : null;
  const telefone = req.body?.telefone != null ? digitosOnly(req.body.telefone) : null;
  const cpf = req.body?.cpf != null ? digitosOnly(req.body.cpf) : null;
  const cargo = req.body?.cargo != null ? String(req.body.cargo).trim() : null;
  let nivel = null;
  if (req.body?.nivel != null) {
    const v = String(req.body.nivel).trim().toLowerCase();
    const NIVEIS_VALIDOS = ['administrador', 'ger-comercial', 'gerente', 'supervisor', 'comprador'];
    if (!NIVEIS_VALIDOS.includes(v)) return res.status(400).json({ error: 'nível inválido' });
    nivel = v;
  }
  const ativo = req.body?.ativo != null ? !!req.body.ativo : null;
  const is_admin = req.body?.is_admin != null ? !!req.body.is_admin : null;

  if (email && !emailValido(email)) return res.status(400).json({ error: 'email inválido' });
  if (cpf && cpf.length > 0 && !cpfValido(cpf)) return res.status(400).json({ error: 'CPF inválido' });
  if (id === req.user.id && is_admin === false) return res.status(400).json({ error: 'você não pode remover seu próprio admin' });
  if (id === req.user.id && ativo === false) return res.status(400).json({ error: 'você não pode desativar a si mesmo' });

  // checa duplicata de email
  if (email && email !== (u.email || '').toLowerCase()) {
    const dup = await queryOne('SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2', [email, id]);
    if (dup) return res.status(409).json({ error: 'email já em uso' });
  }

  await run(`
    UPDATE users SET
      nome = COALESCE($1, nome),
      email = COALESCE($2, email),
      telefone = COALESCE($3, telefone),
      cpf = COALESCE($4, cpf),
      cargo = COALESCE($5, cargo),
      nivel = COALESCE($6, nivel),
      ativo = COALESCE($7, ativo),
      is_admin = COALESCE($8, is_admin)
    WHERE id = $9
  `, [nome, email, telefone, cpf, cargo, nivel, ativo, is_admin, id]);

  res.json({ ok: true });
});

app.put('/api/users/:id/password', adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'senha precisa ter ao menos 6 caracteres' });
  const u = await queryOne('SELECT id FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  await run(
    'UPDATE users SET password_hash = $1, senha_definida = TRUE, token_primeiro_acesso = NULL, token_expira_em = NULL WHERE id = $2',
    [bcrypt.hashSync(password, 10), id]
  );
  res.json({ ok: true });
});

app.post('/api/users/:id/regen-token', adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await queryOne('SELECT id FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  const token = gerarTokenPrimeiroAcesso();
  const exp = dataExpiraEm(7);
  await run(
    'UPDATE users SET token_primeiro_acesso = $1, token_expira_em = $2, senha_definida = FALSE, password_hash = NULL WHERE id = $3',
    [token, exp, id]
  );
  res.json({
    link_primeiro_acesso: `/primeiro-acesso?token=${token}`,
    expira_em: exp,
  });
});

app.delete('/api/users/:id', adminRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'você não pode excluir a si mesmo' });
  const u = await queryOne('SELECT id FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ error: 'não encontrado' });
  await run('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ===== API: primeiro acesso (público — sem auth) =====
app.get('/api/primeiro-acesso/:token', async (req, res) => {
  const token = String(req.params.token);
  const u = await queryOne(`
    SELECT id, nome, email, token_expira_em
    FROM users WHERE token_primeiro_acesso = $1
  `, [token]);
  if (!u) return res.status(404).json({ error: 'link inválido' });
  if (u.token_expira_em && new Date(u.token_expira_em) < new Date()) {
    return res.status(410).json({ error: 'link expirado — peça pro admin gerar um novo' });
  }
  res.json({ nome: u.nome, email: u.email });
});

app.post('/api/primeiro-acesso/:token', async (req, res) => {
  const token = String(req.params.token);
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'senha precisa ter ao menos 6 caracteres' });
  const u = await queryOne(`
    SELECT id, token_expira_em FROM users WHERE token_primeiro_acesso = $1
  `, [token]);
  if (!u) return res.status(404).json({ error: 'link inválido' });
  if (u.token_expira_em && new Date(u.token_expira_em) < new Date()) {
    return res.status(410).json({ error: 'link expirado — peça pro admin gerar um novo' });
  }
  await run(`
    UPDATE users SET
      password_hash = $1,
      senha_definida = TRUE,
      token_primeiro_acesso = NULL,
      token_expira_em = NULL
    WHERE id = $2
  `, [bcrypt.hashSync(password, 10), u.id]);
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
