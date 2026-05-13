#!/usr/bin/env bash
# Wrapper pra rodar diariamente via Task Scheduler do Windows.
# Roda extract_vendas_db.py + atualiza o site.
# Loga tudo em logs/YYYY-MM-DD.log

set -e
cd "$(dirname "$0")"

mkdir -p logs
LOG="logs/$(date +%Y-%m-%d).log"

{
  echo "=========================================="
  echo "= Atualização automática $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=========================================="
  echo

  # Carrega .env
  if [ ! -f .env ]; then
    echo "ERRO: .env não encontrado em $(pwd)" >&2
    exit 1
  fi
  set -a; . ./.env; set +a

  # Espera VPN/Oracle ficar disponível (até 4h) — Task Scheduler dispara fixo 6h,
  # mas se o João só conecta VPN mais tarde, a gente segura aqui.
  echo "→ aguardando Oracle (10.61.1.1:1521) responder…"
  ORACLE_OK=0
  for i in $(seq 1 48); do  # 48 × 5min = 4h
    if nc -zw5 10.61.1.1 1521 2>/dev/null; then
      ORACLE_OK=1
      echo "  ✓ Oracle respondeu na tentativa $i ($(date '+%H:%M:%S'))"
      break
    fi
    echo "  · tentativa $i/48 — sem resposta, aguardando 5min…"
    sleep 300
  done
  if [ "$ORACLE_OK" != "1" ]; then
    echo "✗ Oracle não respondeu em 4h — desistindo. (VPN não conectada?)" >&2
    exit 1
  fi

  echo
  echo "→ rodando extract_vendas_db.py…"
  ~/.venv-oracle/bin/python3 extract_vendas_db.py

  echo
  echo "→ rodando extract_ruptura_db.py…"
  ~/.venv-oracle/bin/python3 extract_ruptura_db.py

  echo
  echo "→ rodando extract_kpis_db.py…"
  ~/.venv-oracle/bin/python3 extract_kpis_db.py

  echo
  echo "→ rodando extract_margem_db.py (margem por loja×comprador×dia)…"
  ~/.venv-oracle/bin/python3 extract_margem_db.py

  echo
  echo "→ copiando OPERAÇÃO - MAIO.xlsx do servidor de rede…"
  WIN_USER=$(powershell.exe -NoProfile -Command 'Write-Host -NoNewline $env:USERNAME' | tr -d '\r')
  if powershell.exe -NoProfile -Command 'Copy-Item -LiteralPath "\\10.61.1.13\controller\02 - SUPERMERCADOS\01 - FATURAMENTO\2026\banco de dados\MAIO\OPERAÇÃO - MAIO.xlsx" -Destination "$env:USERPROFILE\op_supervisor.tmp.xlsx" -Force' 2>&1; then
    cp "/mnt/c/Users/${WIN_USER}/op_supervisor.tmp.xlsx" "./data/operacao_supervisor.xlsx"
    echo "  ✓ planilha copiada ($(stat -c%s ./data/operacao_supervisor.xlsx) bytes)"
  else
    echo "  ⚠ falha ao copiar — usando cópia local antiga ($(stat -c%Y ./data/operacao_supervisor.xlsx | xargs -I{} date -d @{} '+%d/%m %H:%M'))"
  fi

  echo
  echo "→ rodando extract_operacao_db.py (indicadores de operação por loja)…"
  ~/.venv-oracle/bin/python3 extract_operacao_db.py

  echo
  echo "→ rodando extract_estrategia_db.py (comparativo vendas atual / mês ant / ano ant)…"
  ~/.venv-oracle/bin/python3 extract_estrategia_db.py

  echo
  echo "→ rodando extract_inv_rotativo_db.py (Inventário Rotativo · Operação aba 8)…"
  ~/.venv-oracle/bin/python3 extract_inv_rotativo_db.py

  echo
  echo "→ enviando dados pro site (Render)…"
  ./scripts/upload-dados.sh ambos

  echo
  echo "→ gerando e enviando PDF de Faturamento por email…"
  node scripts/enviar-pdf.mjs

  echo
  echo "→ gerando e enviando PDF de Ruptura por email…"
  node scripts/enviar-pdf-ruptura.mjs

  echo
  echo "→ gerando e enviando PDF de Margem por Loja por email…"
  node scripts/enviar-pdf-margem-loja.mjs

  echo
  echo "→ gerando e enviando PDF Resumo da Venda Diária por email…"
  node scripts/enviar-pdf-vd-resumo.mjs

  echo
  echo "✓ tudo OK em $(date '+%H:%M:%S')"
} 2>&1 | tee -a "$LOG"
