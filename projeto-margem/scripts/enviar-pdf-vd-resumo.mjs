// Gera o PDF do Resumo da Venda Diária (1 página A4 paisagem) e envia por email.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { renderPaginaVDResumoPDF } from '../render-pdf-vd-resumo.js';

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
const HTML_PATH = path.join(WIN_TEMP, 'vd-resumo.html');
const PDF_PATH  = path.join(WIN_TEMP, 'vd-resumo.pdf');
const HTML_PATH_WIN = 'C:\\Users\\joao.reis\\AppData\\Local\\Temp\\supervendas\\vd-resumo.html';
const PDF_PATH_WIN  = 'C:\\Users\\joao.reis\\AppData\\Local\\Temp\\supervendas\\vd-resumo.pdf';

console.log('→ lendo dados de venda diária…');
const dados = JSON.parse(await readFile(path.join(ROOT, 'data', 'vendas.json'), 'utf-8'));

console.log('→ gerando HTML (resumo 1 página)…');
let html = renderPaginaVDResumoPDF(dados);
// Remove o auto-print pra não atrapalhar o headless
html = html.replace(/window\.addEventListener\([^<]*?<\/script>/g, '</script>');
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

// ===== Resumo no corpo do email =====
const k = dados.kpis || {};
const venda = k.venda?.realizado || 0;
const margem = k.margem_geral?.realizado || 0;
const margemPdv = k.margem_pdv?.realizado || 0;
const compra = k.compra?.realizado || 0;
const quebra = k.quebra?.realizado || 0;

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
const mesRef = dados.mes_referencia || '';
const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const [a, m] = (mesRef || '').split('-');
const mesNome = m ? `${meses[parseInt(m, 10) - 1]}/${a}` : '';

const margemPct = venda ? margem / venda : null;
const margemPdvPct = venda ? margemPdv / venda : null;
const cxv = venda ? (venda - compra) / venda : null;

console.log(`→ enviando email pra ${PDF_TO}…`);
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

await transporter.sendMail({
  from: `"Supervendas" <${SMTP_USER}>`,
  to: PDF_TO,
  subject: `Venda Diária Resumo — ${dataBR}`,
  text: `Segue em anexo o resumo da Venda Diária ${mesNome} (1 página A4 paisagem) atualizado em ${dataBR}.

Visão geral acumulada do mês:
  • Faturamento:     ${fmtRsK(venda)}     (Ating Total: ${fmtPct(k.venda?.ating)} · Acum: ${fmtPct(k.venda?.meta_ate_hoje ? venda / k.venda.meta_ate_hoje : null)})
  • Margem Total %:  ${fmtRsK(margem)} → ${fmtPct(margemPct)} sobre venda
  • Margem PDV %:    ${fmtRsK(margemPdv)} → ${fmtPct(margemPdvPct)} sobre venda
  • Quebra:          ${fmtRsK(quebra)}     (Ating: ${fmtPct(k.quebra?.ating)})
  • Compra:          ${fmtRsK(compra)}     (CxV: ${fmtPct(cxv)})

— Supervendas`,
  attachments: [{
    filename: `venda-diaria-resumo-${ano}-${mes}-${dia}.pdf`,
    content: pdfBuf,
    contentType: 'application/pdf',
  }],
});

console.log('✓ email enviado');

try { await unlink(HTML_PATH); } catch {}
try { await unlink(PDF_PATH); } catch {}
