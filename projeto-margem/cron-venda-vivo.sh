#!/usr/bin/env bash
# Wrapper "leve" pra rodar só a Venda do Dia a cada 15 min entre 07h-23h.
# Agendado via Task Scheduler do Windows na cadência:
#   - Trigger: All day, every 15 min, 07:00–23:00, daily
#   - Action: wsl bash /caminho/para/projeto-margem/cron-venda-vivo.sh
#
# Comportamento:
#   - Desiste rápido se Oracle não responder em 30s (sem esperar VPN ao contrário
#     do cron-update.sh que aguarda até 4h pelo deploy matinal)
#   - Loga em logs/venda-vivo-YYYY-MM-DD.log (separado do log diário principal)
#   - Executa apenas extract_vendas_db.py + upload (sem mexer em outros relatórios)
#   - Skip silencioso se job idêntico ainda rodando (lockfile)

set -e
cd "$(dirname "$0")"

mkdir -p logs
LOG="logs/venda-vivo-$(date +%Y-%m-%d).log"
LOCK="/tmp/projeto-margem-venda-vivo.lock"

# Lockfile pra evitar 2 execuções simultâneas (Task Scheduler pode disparar
# enquanto o anterior ainda não terminou se a query Oracle estiver lenta).
if [ -e "$LOCK" ]; then
  PID=$(cat "$LOCK" 2>/dev/null || echo 0)
  if kill -0 "$PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] anterior ainda rodando (pid=$PID) — pulando" >> "$LOG"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

{
  echo
  echo "── $(date '+%Y-%m-%d %H:%M:%S') ──"

  if [ ! -f .env ]; then
    echo "ERRO: .env não encontrado em $(pwd)"
    exit 1
  fi
  set -a; . ./.env; set +a

  # Probe rápido — se Oracle não responder em 30s, desiste sem ruído.
  if ! nc -zw30 10.61.1.1 1521 2>/dev/null; then
    echo "  ⚠ Oracle não respondeu em 30s — pulando este ciclo (VPN caiu?)"
    exit 0
  fi

  echo "  → extract_vendas_db.py…"
  T0=$(date +%s)
  ~/.venv-oracle/bin/python3 extract_vendas_db.py
  T1=$(date +%s)
  echo "  ✓ extract em $((T1 - T0))s"

  echo "  → upload pro site…"
  bash ./scripts/upload-dados.sh vendas
  T2=$(date +%s)
  echo "  ✓ upload em $((T2 - T1))s · ciclo total $((T2 - T0))s"

} >> "$LOG" 2>&1
