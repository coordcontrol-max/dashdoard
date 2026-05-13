#!/usr/bin/env python3
"""Gera data/inv_rotativo.json direto do Oracle Consinco (sem Excel).

Roda 2 queries (extraídas do Power Query do 'Inventário Rotativo.xlsx'):
  Q1 = Inventário: MAXV_ABCMOVTOBASE_PROD por (ano,mês,empresa,comprador,
       categoria,produto), retornando QTD_DIFERENCA e VLR_DIFERENCA
  Q2 = Vendas: MAXV_ABCDISTRIBBASE por (ano,mês,empresa,comprador,
       categoria,produto), retornando VENDA, MARGEM, VERBA

Agrega em Python:
  - lojas: soma por NROEMPRESA (do período mais recente em Inventário) +
    venda total da loja no mesmo período, % = valor / venda
  - itens: lista detalhada do Inventário no período mais recente
  - total: soma global

Saída no mesmo formato que o servidor espera em /api/inv-rotativo:
  { gerado_em, periodo: {ano, mes}, lojas: [...], total: {...}, itens: [...] }

Período: por default usa do 1º dia do mês corrente até ontem (`TRUNC(SYSDATE,'MM')`
até `TRUNC(SYSDATE)-1`). Pra rodar outro mês, defina INV_DATA_INI e INV_DATA_FIM
no formato Oracle ('01-APR-2026').
"""
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Re-exec com LD_LIBRARY_PATH se ainda não estiver setado
ORACLE_LIB_DEFAULT = '/home/joaoreis/oracle/instantclient_23_7'
_lib = os.environ.get('ORACLE_LIB', ORACLE_LIB_DEFAULT)
_curr = os.environ.get('LD_LIBRARY_PATH', '')
if _lib not in _curr.split(':'):
    os.environ['LD_LIBRARY_PATH'] = f'{_lib}:{_curr}' if _curr else _lib
    os.execv(sys.executable, [sys.executable] + sys.argv)

import oracledb

ORACLE_USER = os.environ.get('ORACLE_USER', 'consinco')
ORACLE_PASSWORD = os.environ.get('ORACLE_PASSWORD', '')
ORACLE_DSN = os.environ.get('ORACLE_DSN', '10.61.1.1:1521/orcl')
OUT_PATH = Path('./data/inv_rotativo.json')

# Período (default: mês corrente até ontem)
INV_DATA_INI = os.environ.get('INV_DATA_INI', "TRUNC(SYSDATE,'MM')")
INV_DATA_FIM = os.environ.get('INV_DATA_FIM', "TRUNC(SYSDATE) - 1")

# ============================================================
# Q1 — Inventário
# Idêntica à query 'Inventário' do Power Query (item24.xml → Section1.m),
# só parametrizando o range de datas.
# ============================================================
SQL_INVENTARIO = f"""
SELECT
    TO_CHAR(L3.DTAENTRADASAIDA, 'YYYY')           AS ANO,
    TO_CHAR(L3.DTAENTRADASAIDA, 'MM')             AS MES,
    E.NROEMPRESA,
    O.APELIDO                                     AS COMPRADOR,
    G.CAMINHOCOMPLETO,
    L3.SEQPRODUTO,
    A.DESCCOMPLETA                                AS PRODUTO,
    SUM(L3.QTDENTRADACOMPRA / K.QTDEMBALAGEM)
    + SUM(L3.QTDENTRADAOUTRAS / K.QTDEMBALAGEM)
    - SUM(L3.QTDSAIDAVENDA / K.QTDEMBALAGEM)
    - SUM(L3.QTDSAIDAOUTRAS / K.QTDEMBALAGEM)     AS QTD_DIFERENCA,
    SUM(L3.VLRENTRADACOMPRA)
    + SUM(L3.VLRENTRADAOUTRAS)
    - SUM(L3.VLRSAIDAVENDA)
    - SUM(L3.VLRSAIDAOUTRAS)                      AS VLR_DIFERENCA
FROM  MAXV_ABCMOVTOBASE_PROD  L3
JOIN  MAP_PRODUTO              A   ON  A.SEQPRODUTO      = L3.SEQPRODUTO
JOIN  MAX_EMPRESA              E   ON  E.NROEMPRESA      = L3.NROEMPRESA
JOIN  MAP_FAMDIVISAO           D   ON  D.SEQFAMILIA      = L3.SEQFAMILIA
                                   AND D.NRODIVISAO      = L3.NRODIVISAO
JOIN  MAX_COMPRADOR            O   ON  O.SEQCOMPRADOR    = D.SEQCOMPRADOR
JOIN  MAP_FAMEMBALAGEM         K   ON  K.SEQFAMILIA      = D.SEQFAMILIA
                                   AND K.QTDEMBALAGEM    = 1
JOIN  MRL_PRODUTOEMPRESA       C   ON  C.SEQPRODUTO      = L3.SEQPRODUTO
                                   AND C.NROEMPRESA      = E.NROEMPRESA
JOIN  MAP_FAMDIVCATEG          W   ON  W.SEQFAMILIA      = D.SEQFAMILIA
                                   AND W.NRODIVISAO      = D.NRODIVISAO
                                   AND W.STATUS          = 'A'
JOIN  MAXV_CATEGORIA           G   ON  G.SEQCATEGORIA    = W.SEQCATEGORIA
                                   AND G.NRODIVISAO      = W.NRODIVISAO
                                   AND G.NIVELHIERARQUIA = 3
                                   AND G.TIPCATEGORIA    = 'M'
                                   AND G.STATUSCATEGOR  != 'I'
WHERE L3.DTAENTRADASAIDA BETWEEN {INV_DATA_INI} AND {INV_DATA_FIM}
  AND L3.CODGERALOPER    IN (401, 501)
  AND D.SEQCOMPRADOR     != 14
  AND L3.SEQPRODUTO NOT IN (18559, 18560)
GROUP BY
    TO_CHAR(L3.DTAENTRADASAIDA, 'YYYY'),
    TO_CHAR(L3.DTAENTRADASAIDA, 'MM'),
    E.NROEMPRESA,
    O.APELIDO,
    G.CAMINHOCOMPLETO,
    L3.SEQPRODUTO,
    A.DESCCOMPLETA
"""

# ============================================================
# Q2 — Vendas (mesmo período/escopo)
# Idêntica à 'Vendas' do Power Query, parametrizando data.
# ============================================================
SQL_VENDAS = f"""
SELECT
    TO_CHAR(V.DTAVDA, 'YYYY') AS ANO,
    TO_CHAR(V.DTAVDA, 'MM')   AS MES,
    E.NROEMPRESA,
    O.APELIDO                 AS COMPRADOR,
    G.CAMINHOCOMPLETO,
    A.SEQPRODUTO,
    A.DESCCOMPLETA            AS PRODUTO,
    SUM(ROUND(V.VLRITEM, 2) - ROUND(V.VLRDEVOLITEM, 2)) AS VENDA
FROM  MAXV_ABCDISTRIBBASE      V
JOIN  MAX_EMPRESA               E   ON  E.NROEMPRESA       = V.NROEMPRESA
JOIN  MAX_DIVISAO               DV  ON  DV.NRODIVISAO      = E.NRODIVISAO
JOIN  MAP_PRODUTO               A   ON  A.SEQPRODUTO       = V.SEQPRODUTO
JOIN  MAP_FAMDIVISAO            D   ON  D.SEQFAMILIA       = A.SEQFAMILIA
                                    AND D.NRODIVISAO       = V.NRODIVISAO
JOIN  MAX_COMPRADOR             O   ON  O.SEQCOMPRADOR     = D.SEQCOMPRADOR
JOIN  MAP_FAMDIVCATEG           U   ON  U.SEQFAMILIA       = D.SEQFAMILIA
                                    AND U.NRODIVISAO       = D.NRODIVISAO
                                    AND U.STATUS           = 'A'
JOIN  MAXV_CATEGORIA            G   ON  G.SEQCATEGORIA     = U.SEQCATEGORIA
                                    AND G.NRODIVISAO       = U.NRODIVISAO
                                    AND G.NIVELHIERARQUIA  = 3
                                    AND G.TIPCATEGORIA     = 'M'
                                    AND G.STATUSCATEGOR   != 'I'
WHERE V.DTAVDA BETWEEN {INV_DATA_INI} AND {INV_DATA_FIM}
  AND DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) IN ('S','I')
  AND D.SEQCOMPRADOR != 14
  AND E.NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)
GROUP BY
    TO_CHAR(V.DTAVDA, 'YYYY'),
    TO_CHAR(V.DTAVDA, 'MM'),
    E.NROEMPRESA,
    O.APELIDO,
    G.CAMINHOCOMPLETO,
    A.SEQPRODUTO,
    A.DESCCOMPLETA
"""


def run_query(cur, label, sql):
    t = time.time()
    print(f'  → {label}…', end='', flush=True)
    cur.execute(sql)
    rows = cur.fetchall()
    print(f' {len(rows)} linhas em {time.time()-t:.1f}s')
    return rows


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    print(f'conectando em {ORACLE_DSN} como {ORACLE_USER}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    rows_inv    = run_query(cur, 'Q1 Inventário', SQL_INVENTARIO)
    rows_vendas = run_query(cur, 'Q2 Vendas',     SQL_VENDAS)

    cur.close(); conn.close()

    # ===== Normalização =====
    # Q1 cols: ANO, MES, NROEMPRESA, COMPRADOR, CAMINHOCOMPLETO, SEQPRODUTO, PRODUTO, QTD_DIFERENCA, VLR_DIFERENCA
    inv = []
    for r in rows_inv:
        ano = str(r[0]) if r[0] is not None else None
        mes = str(r[1]).zfill(2) if r[1] is not None else None
        nro = int(r[2]) if r[2] is not None else None
        if not (ano and mes and nro is not None): continue
        inv.append({
            'ano': int(ano), 'mes': mes, 'nroempresa': nro,
            'comprador':  r[3] or '',
            'secao':      r[4] or '',
            'seqproduto': int(r[5]) if r[5] is not None else None,
            'produto':    r[6] or '',
            'qtd':        float(r[7] or 0),
            'valor':      float(r[8] or 0),
        })
    print(f'Inventário: {len(inv)} linhas')

    # Q2 cols: ANO, MES, NROEMPRESA, COMPRADOR, CAMINHOCOMPLETO, SEQPRODUTO, PRODUTO, VENDA
    venda_loja = defaultdict(float)  # (ano,mes,nroempresa) -> sum(VENDA)
    for r in rows_vendas:
        ano = int(r[0]) if r[0] is not None else None
        mes = str(r[1]).zfill(2) if r[1] is not None else None
        nro = int(r[2]) if r[2] is not None else None
        if not (ano and mes and nro is not None): continue
        venda_loja[(ano, mes, nro)] += float(r[7] or 0)
    print(f'Vendas: {len(venda_loja)} agregados (ano,mes,empresa)')

    # ===== Período mais recente (do Inventário) =====
    periodos = sorted({(r['ano'], r['mes']) for r in inv}, reverse=True)
    if not periodos:
        print('ERRO: sem dados de Inventário no período', file=sys.stderr); sys.exit(2)
    ano_atual, mes_atual = periodos[0]
    print(f'Período mais recente: {ano_atual}/{mes_atual}')

    inv_periodo = [r for r in inv if r['ano'] == ano_atual and r['mes'] == mes_atual]

    # ===== Agrega por loja =====
    por_loja = defaultdict(lambda: {'valor': 0.0, 'qtd': 0.0})
    for r in inv_periodo:
        por_loja[r['nroempresa']]['valor'] += r['valor']
        por_loja[r['nroempresa']]['qtd']   += r['qtd']

    lojas = []
    for nro, agg in sorted(por_loja.items()):
        v = venda_loja.get((ano_atual, mes_atual, nro), 0.0)
        lojas.append({
            'nroempresa': nro,
            'valor': round(agg['valor'], 2),
            'qtd':   round(agg['qtd'], 3),
            'venda': round(v, 2),
            'pct':   (agg['valor'] / v) if v else None,
        })

    tot_v = sum(l['valor'] for l in lojas)
    tot_q = sum(l['qtd']   for l in lojas)
    tot_x = sum(l['venda'] for l in lojas)
    total = {
        'valor': round(tot_v, 2),
        'qtd':   round(tot_q, 3),
        'venda': round(tot_x, 2),
        'pct':   (tot_v / tot_x) if tot_x else None,
    }

    itens = [{
        'nroempresa': r['nroempresa'],
        'comprador':  r['comprador'],
        'secao':      r['secao'],
        'seqproduto': r['seqproduto'],
        'produto':    r['produto'],
        'qtd':        round(r['qtd'], 3),
        'valor':      round(r['valor'], 2),
    } for r in inv_periodo]

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'periodo':   {'ano': ano_atual, 'mes': mes_atual},
        'lojas':     lojas,
        'total':     total,
        'itens':     itens,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')
    print()
    print(f'✓ salvo em {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)')
    print(f'Lojas: {len(lojas)} · Itens: {len(itens)} · Total valor: {total["valor"]:.2f} · Venda: {total["venda"]:.2f}')


if __name__ == '__main__':
    main()
