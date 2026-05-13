#!/usr/bin/env bash
# Atualiza a planilha de Inventário Rotativo, extrai pra JSON e envia ao site.
# Origem default: \\10.61.1.13\controller\13 - PROJETOS\Projetos Pivot\Rotativos\Inventário Rotativo\
# Pra usar um caminho/nome diferente, defina INV_ROTATIVO_REMOTE no .env.
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

REMOTE_DEFAULT='\\10.61.1.13\controller\13 - PROJETOS\Projetos Pivot\Rotativos\Inventário Rotativo\Inventário Rotativo.xlsx'
REMOTE="${INV_ROTATIVO_REMOTE:-$REMOTE_DEFAULT}"
WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')

echo "→ copiando Inventário Rotativo do servidor de rede…"
echo "  fonte: $REMOTE"
powershell.exe -NoProfile -Command "Copy-Item \"$REMOTE\" \"\$env:USERPROFILE\\inv_rotativo.tmp.xlsx\" -Force"
mkdir -p ./data
cp "/mnt/c/Users/${WIN_USER}/inv_rotativo.tmp.xlsx" "./data/Inventario_Rotativo.xlsx"

echo "→ extraindo dados…"
INV_ROTATIVO_XLSX=./data/Inventario_Rotativo.xlsx python3 extract_inv_rotativo.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo "→ enviando inv_rotativo pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh inv_rotativo
else
  echo "ℹ upload pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
