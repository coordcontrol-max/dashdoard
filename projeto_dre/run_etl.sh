#!/usr/bin/env bash
# Rotina diária de atualização do dashboard.
# Disparada pelo Task Scheduler do Windows (ver instruções em PIPELINE.md).
#
# Fluxo:
#   1. Garante que /mnt/controller está montado (re-monta se preciso)
#   2. Roda etl.py        — lê os 3 Excel da rede e gera dados.json
#   3. Roda upload_to_firestore.py — sobe meses/ pro Firestore
#   4. Loga tudo em logs/etl-YYYYMMDD.log
#
# Falha rápido (set -e) — se algum passo morrer, o script para e o log
# mostra exatamente onde parou.

set -euo pipefail

cd /root/projeto_dre
mkdir -p logs
LOG="logs/etl-$(date +%Y%m%d).log"

# Limpa logs com mais de 30 dias (mantém o histórico recente)
find logs -name "etl-*.log" -mtime +30 -delete 2>/dev/null || true

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ETL iniciado ====="

  # Garante mount da rede (idempotente — mount -a só monta o que ainda não está)
  if ! mountpoint -q /mnt/controller; then
    echo "[mount] /mnt/controller não está montado — montando via /etc/fstab"
    mount -a
  fi

  echo "----- [1/2] etl.py -----"
  python3 etl.py

  echo "----- [2/2] upload_to_firestore.py -----"
  python3 upload_to_firestore.py

  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ETL concluído com sucesso ====="
} 2>&1 | tee -a "$LOG"
