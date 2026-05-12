#!/usr/bin/env bash
# Atualiza apenas a planilha de Faturamento Diário (rotina diária).
# Usa variáveis do .env (SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD) pra fazer upload pro site.
set -e
cd "$(dirname "$0")"

# Carrega .env se existir
[ -f .env ] && set -a && . ./.env && set +a

REMOTE='\\10.61.1.13\controller\02 - SUPERMERCADOS\01 - FATURAMENTO\2026\banco de dados\MAIO\FATURAMENTO DIÁRIO - MAI 26.xlsx'
WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')

echo "→ copiando Faturamento Diário do servidor de rede…"
powershell.exe -NoProfile -Command "Copy-Item \"$REMOTE\" \"\$env:USERPROFILE\\vendas.tmp.xlsx\" -Force"
cp "/mnt/c/Users/${WIN_USER}/vendas.tmp.xlsx" "./data/Faturamento_Diario.xlsx"

echo "→ extraindo dados…"
python3 extract_vendas.py

# Upload pro site (se SITE_URL configurada no .env)
if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo "→ enviando vendas pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh vendas
else
  echo "ℹ upload pro site pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
