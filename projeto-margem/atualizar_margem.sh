#!/usr/bin/env bash
# Atualiza apenas a planilha de Margem.
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

REMOTE='\\10.61.1.13\controller\02 - SUPERMERCADOS\02 - COMERCIAL - JOÃO\2026\Margem Cadastro\Atualizacao de Margem.xlsx'
WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')

echo "→ copiando Atualização de Margem do servidor de rede…"
powershell.exe -NoProfile -Command "Copy-Item \"$REMOTE\" \"\$env:USERPROFILE\\margem.tmp.xlsx\" -Force"
cp "/mnt/c/Users/${WIN_USER}/margem.tmp.xlsx" "./data/Atualizacao_de_Margem.xlsx"

echo "→ extraindo dados…"
python3 extract.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo "→ enviando margem pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh margem
else
  echo "ℹ upload pro site pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
