#!/usr/bin/env bash
# Atualiza apenas a planilha de Ruptura.
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

REMOTE='\\10.61.1.13\controller\02 - SUPERMERCADOS\02 - COMERCIAL - JOÃO\2026\Projeto BI - João\Ruptura\analise de ruptura - Maio.xlsx'
WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')

echo "→ copiando análise de Ruptura do servidor de rede…"
powershell.exe -NoProfile -Command "Copy-Item \"$REMOTE\" \"\$env:USERPROFILE\\ruptura.tmp.xlsx\" -Force"
cp "/mnt/c/Users/${WIN_USER}/ruptura.tmp.xlsx" "./data/Ruptura.xlsx"

echo "→ extraindo dados…"
python3 extract_ruptura.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo "→ enviando ruptura pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh ruptura
else
  echo "ℹ upload pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
