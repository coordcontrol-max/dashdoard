#!/usr/bin/env bash
# Recopia a planilha do servidor de rede e regenera site/data.json
set -e
cd "$(dirname "$0")"

REMOTE='\\10.61.1.13\controller\02 - SUPERMERCADOS\02 - COMERCIAL - JOÃO\2026\Margem Cadastro\Atualizacao de Margem.xlsx'

echo "→ copiando planilha do servidor de rede…"
powershell.exe -Command "Copy-Item \"$REMOTE\" \"\$env:USERPROFILE\\temp_margem.xlsx\" -Force"

cp "/mnt/c/Users/$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')/temp_margem.xlsx" \
   ./data/Atualizacao_de_Margem.xlsx

echo "→ extraindo dados…"
python3 extract.py

echo "✓ pronto. Recarregue o site no navegador."
