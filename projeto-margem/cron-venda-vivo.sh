#!/usr/bin/env bash
# Worker da fila de "Atualizar Venda do Dia" (Painel ao Vivo).
#
# Agendado via Task Scheduler do Windows, recorrência alta (ex.: a cada 1 min
# das 07h às 23h, ou daily 24h se quiser):
#   Trigger: Daily, repeat task every 1 minute for 16h starting 07:00
#   Action:  wsl bash /caminho/para/projeto-margem/cron-venda-vivo.sh
#
# Comportamento por execução:
#   - Bate no site em /api/admin/vendas/proxima-pendente
#   - Se NÃO há solicitação pendente → exit silencioso (custo: ~200ms)
#   - Se há → roda extract_vendas_db.py + upload e finaliza a solicitação
#   - Se Oracle não responder em 30s → finaliza com status=erro
#
# Lockfile previne dupla execução se um ciclo ainda está rodando.

set -e
cd "$(dirname "$0")"

mkdir -p logs
LOG="logs/venda-vivo-$(date +%Y-%m-%d).log"
LOCK="/tmp/projeto-margem-venda-vivo.lock"

if [ -e "$LOCK" ]; then
  PID=$(cat "$LOCK" 2>/dev/null || echo 0)
  if kill -0 "$PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] anterior rodando (pid=$PID) — skip" >> "$LOG"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

if [ ! -f .env ]; then
  echo "[$(date '+%H:%M:%S')] ERRO: .env não encontrado" >> "$LOG"
  exit 1
fi
set -a; . ./.env; set +a

if [ -z "$SITE_URL" ] || [ -z "$ADMIN_USERNAME" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "[$(date '+%H:%M:%S')] ERRO: SITE_URL/ADMIN_USERNAME/ADMIN_PASSWORD faltando" >> "$LOG"
  exit 1
fi

COOKIE_JAR=$(mktemp)
trap 'rm -f "$LOCK" "$COOKIE_JAR" /tmp/v_*.json' EXIT

# Login no site
LOGIN_BODY=$(python3 -c "import json,os; print(json.dumps({'username':os.environ['ADMIN_USERNAME'],'password':os.environ['ADMIN_PASSWORD']}))")
HTTP=$(curl -s -o /tmp/v_login.json -w "%{http_code}" -c "$COOKIE_JAR" \
  -X POST "$SITE_URL/api/login" -H "Content-Type: application/json" -d "$LOGIN_BODY")
if [ "$HTTP" != "200" ]; then
  echo "[$(date '+%H:%M:%S')] login falhou (HTTP $HTTP)" >> "$LOG"
  exit 1
fi

# Pega próxima pendente (idempotente — marca como 'processando')
PENDENTE=$(curl -s -b "$COOKIE_JAR" -X POST "$SITE_URL/api/admin/vendas/proxima-pendente" -H "Content-Type: application/json" -d '{}')
ID=$(echo "$PENDENTE" | python3 -c "import json,sys; d=json.load(sys.stdin); p=d.get('pendente'); print(p['id'] if p else '')")

if [ -z "$ID" ]; then
  # Nada na fila — exit silencioso, não polui o log
  exit 0
fi

echo "" >> "$LOG"
echo "── $(date '+%Y-%m-%d %H:%M:%S') · solicitação #$ID ──" >> "$LOG"

# Finaliza a solicitação no servidor
finalizar() {
  local status="$1"
  local msg="$2"
  curl -s -o /dev/null -b "$COOKIE_JAR" -X POST "$SITE_URL/api/admin/vendas/finalizar" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json,sys; print(json.dumps({'id': $ID, 'status': '$status', 'mensagem': sys.argv[1]}))" "$msg")" \
    || true
}

# Probe Oracle (30s)
if ! nc -zw30 10.61.1.1 1521 2>/dev/null; then
  MSG="Oracle não respondeu em 30s (VPN caiu?)"
  echo "  ⚠ $MSG" >> "$LOG"
  finalizar erro "$MSG"
  exit 0
fi

T0=$(date +%s)
if ~/.venv-oracle/bin/python3 extract_vendas_db.py >> "$LOG" 2>&1; then
  T1=$(date +%s)
  echo "  ✓ extract em $((T1 - T0))s" >> "$LOG"
  if bash ./scripts/upload-dados.sh vendas >> "$LOG" 2>&1; then
    T2=$(date +%s)
    MSG="extract $((T1-T0))s + upload $((T2-T1))s = $((T2-T0))s"
    echo "  ✓ $MSG" >> "$LOG"
    finalizar ok "$MSG"
  else
    MSG="extract OK mas upload falhou"
    echo "  ✗ $MSG" >> "$LOG"
    finalizar erro "$MSG"
  fi
else
  MSG="extract_vendas_db.py falhou — ver log"
  echo "  ✗ $MSG" >> "$LOG"
  finalizar erro "$MSG"
fi
