// Daemon local — polling 30s. Processa as filas:
//   - kpis_atualizacao        → extract_kpis_db.py
//   - margem_loja_atualizacao → extract_margem_db.py
//   - troca_atualizacao       → extract_troca_db.py
//   - operacao_atualizacao    → extract_operacao_db.py
//
// O auto-disparo diário (~06:30) é feito pelo cron-update.sh chamado
// via Task Scheduler do Windows — não pelo worker.
//
// Pra rodar:
//   node scripts/kpis-worker.mjs

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const envText = await readFile(path.join(ROOT, '.env'), 'utf-8');
for (const linha of envText.split('\n')) {
  const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const SITE_URL = process.env.SITE_URL || 'https://projeto-comercial.onrender.com';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const POLL_INTERVAL_MS = 30 * 1000;
const PYTHON = process.env.PYTHON_KPIS || `${process.env.HOME}/.venv-oracle/bin/python3`;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('ERRO: ADMIN_USERNAME e ADMIN_PASSWORD precisam estar no .env');
  process.exit(1);
}

let cookieJar = '';

async function fetchAuth(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookieJar) headers.Cookie = cookieJar;
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, { ...opts, headers });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookieJar = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
  return r;
}

async function login() {
  const r = await fetchAuth(`${SITE_URL}/api/login`, {
    method: 'POST',
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (!r.ok) throw new Error(`login: ${r.status} ${await r.text().catch(() => '')}`);
}

async function pegarPendente(tipo) {
  // tipo = 'kpis' | 'margem-loja' | 'troca'
  const r = await fetchAuth(`${SITE_URL}/api/admin/${tipo}/proxima-pendente`, { method: 'POST' });
  if (r.status === 401 || r.status === 403) { await login(); return pegarPendente(tipo); }
  if (!r.ok) throw new Error(`proxima-pendente ${tipo}: ${r.status}`);
  const j = await r.json();
  return j.pendente;
}

async function finalizar(tipo, id, status, mensagem) {
  const r = await fetchAuth(`${SITE_URL}/api/admin/${tipo}/finalizar`, {
    method: 'POST',
    body: { id, status, mensagem },
  });
  if (!r.ok) console.error(`finalizar ${tipo} falhou:`, r.status);
}

function rodarPython(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', reject);
    proc.on('exit', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${script} exit ${code}: ${err.slice(0, 500)}`));
    });
  });
}

async function uploadKpis() {
  const file = path.join(ROOT, 'data', 'kpis.json');
  if (!existsSync(file)) throw new Error('data/kpis.json não foi gerado');
  const kpis = JSON.parse(await readFile(file, 'utf-8'));
  const r = await fetchAuth(`${SITE_URL}/api/admin/upload-dados`, {
    method: 'POST',
    body: { kpis },
  });
  if (r.status === 401 || r.status === 403) { await login(); return uploadKpis(); }
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function uploadMargemLoja() {
  const file = path.join(ROOT, 'data', 'margem_loja.json');
  if (!existsSync(file)) throw new Error('data/margem_loja.json não foi gerado');
  const margem_loja = JSON.parse(await readFile(file, 'utf-8'));
  const r = await fetchAuth(`${SITE_URL}/api/admin/upload-dados`, {
    method: 'POST',
    body: { margem_loja },
  });
  if (r.status === 401 || r.status === 403) { await login(); return uploadMargemLoja(); }
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function uploadTroca() {
  const file = path.join(ROOT, 'data', 'troca.json');
  if (!existsSync(file)) throw new Error('data/troca.json não foi gerado');
  const troca = JSON.parse(await readFile(file, 'utf-8'));
  const r = await fetchAuth(`${SITE_URL}/api/admin/upload-dados`, {
    method: 'POST',
    body: { troca },
  });
  if (r.status === 401 || r.status === 403) { await login(); return uploadTroca(); }
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function uploadOperacao() {
  const file = path.join(ROOT, 'data', 'operacao.json');
  if (!existsSync(file)) throw new Error('data/operacao.json não foi gerado');
  const operacao = JSON.parse(await readFile(file, 'utf-8'));
  const r = await fetchAuth(`${SITE_URL}/api/admin/upload-dados`, {
    method: 'POST',
    body: { operacao },
  });
  if (r.status === 401 || r.status === 403) { await login(); return uploadOperacao(); }
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function uploadEstrategia() {
  const file = path.join(ROOT, 'data', 'estrategia.json');
  if (!existsSync(file)) throw new Error('data/estrategia.json não foi gerado');
  const estrategia = JSON.parse(await readFile(file, 'utf-8'));
  const r = await fetchAuth(`${SITE_URL}/api/admin/upload-dados`, {
    method: 'POST',
    body: { estrategia },
  });
  if (r.status === 401 || r.status === 403) { await login(); return uploadEstrategia(); }
  if (!r.ok) throw new Error(`upload: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}

async function processarKpis(sol) {
  console.log(`[${new Date().toISOString()}] kpis #${sol.id}…`);
  try {
    await rodarPython('extract_kpis_db.py');
    const up = await uploadKpis();
    const msg = up?.atualizados?.[0] || 'OK';
    await finalizar('kpis', sol.id, 'ok', String(msg));
    console.log(`[${new Date().toISOString()}] ✓ kpis #${sol.id} — ${msg}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ✗ kpis #${sol.id} falhou: ${e.message}`);
    await finalizar('kpis', sol.id, 'erro', e.message.slice(0, 500));
  }
}

async function processarMargemLoja(sol) {
  console.log(`[${new Date().toISOString()}] margem-loja #${sol.id}…`);
  try {
    await rodarPython('extract_margem_db.py');
    const up = await uploadMargemLoja();
    const msg = up?.atualizados?.find(x => x.startsWith('margem_loja')) || up?.atualizados?.[0] || 'OK';
    await finalizar('margem-loja', sol.id, 'ok', String(msg));
    console.log(`[${new Date().toISOString()}] ✓ margem-loja #${sol.id} — ${msg}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ✗ margem-loja #${sol.id} falhou: ${e.message}`);
    await finalizar('margem-loja', sol.id, 'erro', e.message.slice(0, 500));
  }
}

async function processarTroca(sol) {
  console.log(`[${new Date().toISOString()}] troca #${sol.id}…`);
  try {
    await rodarPython('extract_troca_db.py');
    const up = await uploadTroca();
    const msg = up?.atualizados?.find(x => x.startsWith('troca')) || up?.atualizados?.[0] || 'OK';
    await finalizar('troca', sol.id, 'ok', String(msg));
    console.log(`[${new Date().toISOString()}] ✓ troca #${sol.id} — ${msg}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ✗ troca #${sol.id} falhou: ${e.message}`);
    await finalizar('troca', sol.id, 'erro', e.message.slice(0, 500));
  }
}

async function processarOperacao(sol) {
  console.log(`[${new Date().toISOString()}] operacao #${sol.id}…`);
  try {
    await rodarPython('extract_operacao_db.py');
    const up = await uploadOperacao();
    const msg = up?.atualizados?.find(x => x.startsWith('operacao')) || up?.atualizados?.[0] || 'OK';
    await finalizar('operacao', sol.id, 'ok', String(msg));
    console.log(`[${new Date().toISOString()}] ✓ operacao #${sol.id} — ${msg}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ✗ operacao #${sol.id} falhou: ${e.message}`);
    await finalizar('operacao', sol.id, 'erro', e.message.slice(0, 500));
  }
}

async function processarEstrategia(sol) {
  console.log(`[${new Date().toISOString()}] estrategia #${sol.id}…`);
  try {
    await rodarPython('extract_estrategia_db.py');
    const up = await uploadEstrategia();
    const msg = up?.atualizados?.find(x => x.startsWith('estrategia')) || up?.atualizados?.[0] || 'OK';
    await finalizar('estrategia', sol.id, 'ok', String(msg));
    console.log(`[${new Date().toISOString()}] ✓ estrategia #${sol.id} — ${msg}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ✗ estrategia #${sol.id} falhou: ${e.message}`);
    await finalizar('estrategia', sol.id, 'erro', e.message.slice(0, 500));
  }
}

async function loop() {
  await login();
  console.log(`[kpis-worker] iniciado · ${SITE_URL} · polling ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    try {
      // Processa filas — kpis, margem-loja, troca (na ordem)
      const solK = await pegarPendente('kpis');
      if (solK) {
        await processarKpis(solK);
        continue;  // não dorme, vê se tem próxima
      }
      const solM = await pegarPendente('margem-loja');
      if (solM) {
        await processarMargemLoja(solM);
        continue;
      }
      const solT = await pegarPendente('troca');
      if (solT) {
        await processarTroca(solT);
        continue;
      }
      const solO = await pegarPendente('operacao');
      if (solO) {
        await processarOperacao(solO);
        continue;
      }
      const solE = await pegarPendente('estrategia');
      if (solE) {
        await processarEstrategia(solE);
        continue;
      }
    } catch (e) {
      console.error('[poll] erro:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch(e => { console.error('fatal:', e); process.exit(1); });
