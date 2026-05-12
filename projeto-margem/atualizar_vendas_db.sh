#!/usr/bin/env bash
# Atualiza vendas direto do Oracle Consinco (sem Excel, sem PL/SQL Developer).
# Rotina diária: roda em ~1m40s (97s da query Oracle + ~3s de upload).
set -e
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

echo "→ rodando query no Oracle Consinco e gerando vendas.json…"
~/.venv-oracle/bin/python3 extract_vendas_db.py

if [ -n "$SITE_URL" ] && [ -n "$ADMIN_USERNAME" ] && [ -n "$ADMIN_PASSWORD" ]; then
  echo
  echo "→ enviando vendas pro site ($SITE_URL)…"
  bash ./scripts/upload-dados.sh vendas
else
  echo "ℹ upload pulado (defina SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env)"
fi

echo
echo "✓ pronto."
