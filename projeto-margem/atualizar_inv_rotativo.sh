#!/usr/bin/env bash
# Atualiza Inventário Rotativo direto do Oracle Consinco (sem Excel).
# As 2 queries (Inventário e Vendas) foram extraídas do Power Query do
# 'Inventário Rotativo.xlsx' e portadas pro extract_inv_rotativo_db.py.
#
# Período: por default, do 1º dia do mês corrente até ontem.
# Pra rodar um mês fechado, exporta as env vars antes de chamar:
#   export INV_DATA_INI="TO_DATE('01-APR-2026','DD-MON-YYYY')"
#   export INV_DATA_FIM="TO_DATE('30-APR-2026','DD-MON-YYYY')"
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

echo "→ rodando queries no Oracle Consinco e gerando inv_rotativo.json…"
~/.venv-oracle/bin/python3 extract_inv_rotativo_db.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo
  echo "→ enviando inv_rotativo pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh inv_rotativo
else
  echo "ℹ upload pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
