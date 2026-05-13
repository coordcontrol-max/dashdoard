#!/usr/bin/env bash
# Faz upload do data/data.json e/ou data/vendas.json pro site.
# Uso: ./scripts/upload-dados.sh [margem|vendas|ambos]   (default: ambos)
# Requer no .env: SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD
set -e
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && . ./.env && set +a

if [ -z "$SITE_URL" ] || [ -z "$ADMIN_USERNAME" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERRO: precisa configurar SITE_URL, ADMIN_USERNAME, ADMIN_PASSWORD no .env" >&2
  exit 1
fi

ALVO="${1:-ambos}"
COOKIE_JAR=$(mktemp)
PAYLOAD=$(mktemp --suffix=.json)
trap "rm -f $COOKIE_JAR $PAYLOAD /tmp/login.json /tmp/upload.json" EXIT

echo "  • login…"
LOGIN_BODY=$(python3 -c "import json,os; print(json.dumps({'username':os.environ['ADMIN_USERNAME'],'password':os.environ['ADMIN_PASSWORD']}))")
HTTP=$(curl -s -o /tmp/login.json -w "%{http_code}" -c "$COOKIE_JAR" \
  -X POST "$SITE_URL/api/login" \
  -H "Content-Type: application/json" \
  -d "$LOGIN_BODY")
if [ "$HTTP" != "200" ]; then
  echo "ERRO no login (HTTP $HTTP):"; cat /tmp/login.json; exit 1
fi

# Monta o payload via Python (sem jq)
python3 - "$ALVO" "$PAYLOAD" <<'PY'
import json, sys, os
alvo, out = sys.argv[1], sys.argv[2]
payload = {}
def carrega(path, key):
    if os.path.exists(path):
        with open(path) as f: payload[key] = json.load(f)
if alvo in ('margem', 'ambos'):       carrega('data/data.json',         'margem')
if alvo in ('vendas', 'ambos'):       carrega('data/vendas.json',       'vendas')
if alvo in ('kpis',   'ambos'):       carrega('data/kpis.json',         'kpis')
if alvo in ('ruptura', 'ambos'):      carrega('data/ruptura.json',      'ruptura')
if alvo in ('margem_loja', 'ambos'):  carrega('data/margem_loja.json',  'margem_loja')
if alvo in ('operacao', 'ambos'):     carrega('data/operacao.json',     'operacao')
if alvo in ('estrategia', 'ambos'):   carrega('data/estrategia.json',   'estrategia')
if alvo in ('inv_rotativo', 'ambos'): carrega('data/inv_rotativo.json', 'inv_rotativo')
if not payload:
    sys.stderr.write(f"alvo inválido: {alvo}\n"); sys.exit(2)
with open(out, 'w') as f: json.dump(payload, f)
PY

echo "  • enviando dados ($(wc -c < "$PAYLOAD" | tr -d ' ') bytes)…"
HTTP=$(curl -s -o /tmp/upload.json -w "%{http_code}" -b "$COOKIE_JAR" \
  -X POST "$SITE_URL/api/admin/upload-dados" \
  -H "Content-Type: application/json" \
  --data-binary "@$PAYLOAD")
if [ "$HTTP" != "200" ]; then
  echo "ERRO no upload (HTTP $HTTP):"; cat /tmp/upload.json; exit 1
fi

echo -n "  ✓ "
cat /tmp/upload.json
echo
