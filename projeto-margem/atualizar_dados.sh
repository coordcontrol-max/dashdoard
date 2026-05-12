#!/usr/bin/env bash
# Atualiza ambas as planilhas (margem + vendas).
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

REMOTE_BASE='\\10.61.1.13\controller\02 - SUPERMERCADOS'
WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')

copiar() {
  local nome="$1" origem="$2" destino="$3"
  echo "→ copiando $nome…"
  powershell.exe -NoProfile -Command "Copy-Item \"$origem\" \"\$env:USERPROFILE\\${nome}.tmp.xlsx\" -Force"
  cp "/mnt/c/Users/${WIN_USER}/${nome}.tmp.xlsx" "$destino"
}

copiar "margem"  "$REMOTE_BASE\\02 - COMERCIAL - JOÃO\\2026\\Margem Cadastro\\Atualizacao de Margem.xlsx"             "./data/Atualizacao_de_Margem.xlsx"
copiar "vendas"  "$REMOTE_BASE\\01 - FATURAMENTO\\2026\\banco de dados\\MAIO\\FATURAMENTO DIÁRIO - MAI 26.xlsx"      "./data/Faturamento_Diario.xlsx"
copiar "ruptura" "$REMOTE_BASE\\02 - COMERCIAL - JOÃO\\2026\\Projeto BI - João\\Ruptura\\analise de ruptura - Maio.xlsx" "./data/Ruptura.xlsx"

echo
echo "→ extraindo margem…";  python3 extract.py
echo
echo "→ extraindo vendas…";  python3 extract_vendas.py
echo
echo "→ extraindo ruptura…"; python3 extract_ruptura.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo
  echo "→ enviando dados pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh ambos
else
  echo
  echo "ℹ upload pro site pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
