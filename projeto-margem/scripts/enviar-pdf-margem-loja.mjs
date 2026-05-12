// Gera o PDF de Margem por Loja (Análise Comparativa) e envia por email.
// Roda local (WSL2). Usa o Chrome do Windows pra converter HTML→PDF.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { renderPaginaMargemLojaPDF } from '../render-pdf-margem-loja.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Carrega .env
const envPath = path.join(ROOT, '.env');
const envText = await readFile(envPath, 'utf-8');
for (const linha of envText.split('\n')) {
  const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const PDF_TO = process.env.PDF_TO;
const CHROME_PATH = process.env.CHROME_PATH || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

if (!SMTP_USER || !SMTP_PASS || !PDF_TO) {
  console.error('ERRO: SMTP_USER, SMTP_PASS e PDF_TO precisam estar no .env');
  process.exit(1);
}
if (!existsSync(CHROME_PATH)) {
  console.error(`ERRO: Chrome não encontrado em ${CHROME_PATH}`);
  process.exit(1);
}

const WIN_TEMP = '/mnt/c/Users/joao.reis/AppData/Local/Temp/supervendas';
const HTML_PATH = path.join(WIN_TEMP, 'margem-loja.html');
const PDF_PATH  = path.join(WIN_TEMP, 'margem-loja.pdf');
const HTML_PATH_WIN = 'C:\\Users\\joao.reis\\AppData\\Local\\Temp\\supervendas\\margem-loja.html';
const PDF_PATH_WIN  = 'C:\\Users\\joao.reis\\AppData\\Local\\Temp\\supervendas\\margem-loja.pdf';

console.log('→ lendo dados de margem por loja…');
const dados = JSON.parse(await readFile(path.join(ROOT, 'data', 'margem_loja.json'), 'utf-8'));

console.log('→ gerando HTML…');
const html = renderPaginaMargemLojaPDF(dados);
await writeFile(HTML_PATH, html, 'utf-8');

console.log('→ convertendo pra PDF via Chrome headless…');
await new Promise((resolve, reject) => {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=10000',
    '--default-background-color=00000000',
    `--print-to-pdf=${PDF_PATH_WIN}`,
    `file:///${HTML_PATH_WIN.replace(/\\/g, '/')}`,
  ];
  const proc = spawn(CHROME_PATH, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', reject);
  proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`chrome exit ${code}`)));
});

if (!existsSync(PDF_PATH)) {
  console.error('ERRO: PDF não foi gerado em', PDF_PATH);
  process.exit(1);
}
const pdfBuf = await readFile(PDF_PATH);
console.log(`✓ PDF gerado: ${(pdfBuf.length / 1024).toFixed(0)} KB`);

// Resumo no corpo do email — agrega tudo do JSON
const linhas = dados.linhas || [];
let venda = 0, lucr = 0, verba = 0;
for (const l of linhas) {
  venda += Number(l.venda) || 0;
  lucr  += Number(l.lucratividade) || 0;
  verba += Number(l.verba) || 0;
}
const mgTotal = venda > 0 ? lucr / venda : null;
const mgPdv   = venda > 0 ? (lucr - verba) / venda : null;
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
const fmtRsK = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' Mi';
  if (Math.abs(v) >= 1e3) return 'R$ ' + (v / 1e3).toFixed(0) + ' mil';
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
};

const hoje = new Date();
const dia = String(hoje.getDate()).padStart(2, '0');
const mes = String(hoje.getMonth() + 1).padStart(2, '0');
const ano = hoje.getFullYear();
const dataBR = `${dia}/${mes}/${ano}`;
const periodo = dados.periodo || {};
const fmtDataIso = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
};

console.log(`→ enviando email pra ${PDF_TO}…`);
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

await transporter.sendMail({
  from: `"Supervendas" <${SMTP_USER}>`,
  to: PDF_TO,
  subject: `Margem por Loja — ${dataBR}`,
  text: `Segue em anexo a Análise Comparativa de Margem por Loja atualizada em ${dataBR}.

Período: ${fmtDataIso(periodo.inicio)} a ${fmtDataIso(periodo.fim)}

Resumo do período:
  • Venda total:     ${fmtRsK(venda)}
  • Margem Total %:  ${fmtPct(mgTotal)}
  • Margem PDV %:    ${fmtPct(mgPdv)}
  • Verba total:     ${fmtRsK(verba)}

— Supervendas`,
  attachments: [{
    filename: `margem-loja-${ano}-${mes}-${dia}.pdf`,
    content: pdfBuf,
    contentType: 'application/pdf',
  }],
});

console.log('✓ email enviado');

try { await unlink(HTML_PATH); } catch {}
try { await unlink(PDF_PATH); } catch {}
