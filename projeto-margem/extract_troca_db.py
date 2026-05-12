#!/usr/bin/env python3
"""Gera data/troca.json direto do Oracle Consinco.

1 query: estoque de troca (ESTQTROCA) com custo bruto por
loja x produto x fornecedor x comprador.

Cruza em Python pra gerar:
  - totais (R$ e qtd geral)
  - ranking_compradores / ranking_lojas / ranking_fornecedores (por R$)
  - itens detalhados
  - evolucao_diaria (montada no servidor a partir do histórico)
"""
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

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
OUT_PATH = Path('./data/troca.json')

NROEMPRESA_LIST = "5,10,11,12,13,14,16,18,20,21,23,26,27,28,29,101,102,103,104,106,108,109,112,117,125,131,215,219,222"

SQL_TROCA = f"""
SELECT
    E.NROEMPRESA                                AS COD_EMPRESA,
    E.NOMEREDUZIDO                              AS EMPRESA,
    A.SEQPRODUTO                                AS COD_PRODUTO,
    A.DESCCOMPLETA                              AS PRODUTO,
    P.SEQPESSOA                                 AS COD_FORNECEDOR,
    P.NOMERAZAO                                 AS FORNECEDOR,
    O.SEQCOMPRADOR                              AS COD_COMPRADOR,
    O.APELIDO                                   AS COMPRADOR,
    ROUND(SUM(C.ESTQTROCA / K.QTDEMBALAGEM), 6) AS QTD_ESTOQUE,
    ROUND(
        SUM(
            ( C.CMULTVLRNF
            + C.CMULTIPI
            + C.CMULTDESPNF
            + C.CMULTICMSST
            + C.CMULTDESPFORANF
            + FC_RETORNAIMPREFORMATOTAL(
                  pnVlrimpostoibsmun     => NVL(C.CMULTIBSMUN, 0),
                  pnVlrimpostoibsuf      => NVL(C.CMULTIBSUF, 0),
                  pnVlrimpostocbs        => NVL(C.CMULTCBS, 0),
                  pnVlrimpostois         => NVL(C.CMULTIS, 0),
                  pnVlrimpostoibsmunCred => NVL(C.CMULTCREDIBSMUN, 0),
                  pnVlrimpostoibsufCred  => NVL(C.CMULTCREDIBSUF, 0),
                  pnVlrimpostocbsCred    => NVL(C.CMULTCREDCBS, 0),
                  pnVlrimpostoisCred     => NVL(C.CMULTCREDIS, 0),
                  psTipoCalculo          => 'C',
                  psTipoCusto            => 'B')
            - ( NVL(F_CMDIADTOFNF(C.SEQPRODUTO, C.NROEMPRESA, SYSDATE), C.CMULTDCTOFORANF)
              - C.CMULTIMPOSTOPRESUM )
            + C.VLRDESCTRANSFCB
            )
            * (CASE
                  WHEN I2.UTILACRESCCUSTPRODRELAC = 'S'
                       AND NVL(A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO) IS NOT NULL
                  THEN COALESCE(PR.PERCACRESCCUSTORELACVIG,
                                F_RETACRESCCUSTORELAC(C.SEQPRODUTO,
                                                      C.DTAENTRADASAIDA,
                                                      I2.UTILACRESCCUSTPRODRELAC,
                                                      PR.PERCACRESCCUSTORELACVIG))
                  ELSE 1
               END)
            * C.ESTQTROCA
        ), 2
    )                                           AS VLR_CUSTO_BRUTO
FROM
    MAP_PRODUTO   A,
    MAP_FAMILIA   B,
    (   SELECT
            Y.SEQPRODUTO,
            Y.NROEMPRESA,
            Y.ESTQTROCA,
            Y.CMULTVLRNF,
            Y.CMULTIPI,
            NVL(Y.CMULTIBSMUN, 0)        AS CMULTIBSMUN,
            NVL(Y.CMULTIBSUF, 0)         AS CMULTIBSUF,
            NVL(Y.CMULTCBS, 0)           AS CMULTCBS,
            NVL(Y.CMULTIS, 0)            AS CMULTIS,
            NVL(Y.CMULTCREDIBSMUN, 0)    AS CMULTCREDIBSMUN,
            NVL(Y.CMULTCREDIBSUF, 0)     AS CMULTCREDIBSUF,
            NVL(Y.CMULTCREDCBS, 0)       AS CMULTCREDCBS,
            NVL(Y.CMULTCREDIS, 0)        AS CMULTCREDIS,
            Y.CMULTICMSST,
            Y.CMULTDESPNF,
            Y.CMULTDESPFORANF,
            Y.CMULTDCTOFORANF,
            NVL(Y.CMULTIMPOSTOPRESUM, 0) AS CMULTIMPOSTOPRESUM,
            SYSDATE                      AS DTAENTRADASAIDA,
            ( NVL(Y.CMULTVLRDESCPISTRANSF, 0)
            + NVL(Y.CMULTVLRDESCCOFINSTRANSF, 0)
            + NVL(Y.CMULTVLRDESCICMSTRANSF, 0)
            + NVL(Y.CMULTVLRDESCIPITRANSF, 0)
            + NVL(Y.CMULTVLRDESCLUCROTRANSF, 0)
            + NVL(Y.CMULTVLRDESCVERBATRANSF, 0)
            + NVL(Y.CMULTVLRDESCDIFERENCATRANSF, 0)
            )                            AS VLRDESCTRANSFCB
        FROM
            MRL_PRODUTOEMPRESA Y
        WHERE
            Y.NROEMPRESA IN ({NROEMPRESA_LIST})
    ) C,
    MAP_FAMDIVISAO              D,
    MAP_FAMEMBALAGEM            K,
    MAX_EMPRESA                 E,
    MAX_DIVISAO                 I2,
    MAP_PRODACRESCCUSTORELAC    PR,
    GE_PESSOA                   P,
    MAP_FAMFORNEC               F,
    MAX_COMPRADOR               O
WHERE
    A.SEQPRODUTO       = C.SEQPRODUTO
    AND B.SEQFAMILIA   = A.SEQFAMILIA
    AND D.SEQFAMILIA   = A.SEQFAMILIA
    AND D.NRODIVISAO   = E.NRODIVISAO
    AND K.SEQFAMILIA   = D.SEQFAMILIA
    AND K.QTDEMBALAGEM = 1
    AND E.NROEMPRESA   = C.NROEMPRESA
    AND E.NROEMPRESA   IN ({NROEMPRESA_LIST})
    AND I2.NRODIVISAO  = E.NRODIVISAO
    AND I2.NRODIVISAO  = D.NRODIVISAO
    AND C.SEQPRODUTO   = PR.SEQPRODUTO(+)
    AND C.DTAENTRADASAIDA = PR.DTAMOVIMENTACAO(+)
    AND F.SEQFORNECEDOR   = P.SEQPESSOA
    AND F.SEQFAMILIA      = A.SEQFAMILIA
    AND F.PRINCIPAL       = 'S'
    AND O.SEQCOMPRADOR    = D.SEQCOMPRADOR
    AND C.ESTQTROCA      != 0
    AND A.SEQPRODUTOBASE IS NULL
GROUP BY
    E.NROEMPRESA, E.NOMEREDUZIDO,
    A.SEQPRODUTO, A.DESCCOMPLETA,
    P.SEQPESSOA, P.NOMERAZAO,
    O.SEQCOMPRADOR, O.APELIDO
HAVING ROUND(SUM(C.ESTQTROCA / K.QTDEMBALAGEM), 6) != 0
ORDER BY E.NROEMPRESA, O.APELIDO, A.DESCCOMPLETA
"""


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    print(f'conectando em {ORACLE_DSN} como {ORACLE_USER}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    t = time.time()
    print('  → rodando query troca…', end='', flush=True)
    cur.execute(SQL_TROCA)
    rows = cur.fetchall()
    print(f' {len(rows)} linhas em {time.time()-t:.1f}s')
    cur.close(); conn.close()

    # rows cols: 0=COD_EMPRESA, 1=EMPRESA, 2=COD_PRODUTO, 3=PRODUTO,
    #            4=COD_FORNECEDOR, 5=FORNECEDOR, 6=COD_COMPRADOR, 7=COMPRADOR,
    #            8=QTD_ESTOQUE, 9=VLR_CUSTO_BRUTO

    # ---- Itens detalhados ----
    itens = []
    for r in rows:
        loja_n = int(r[0]) if r[0] is not None else 0
        loja = f"{loja_n:02d}-{r[1]}" if r[1] else str(loja_n)
        comprador = r[7] or ''
        itens.append({
            'loja':       loja,
            'comprador':  comprador,
            'fornecedor': r[5] or '',
            'produto':    r[3] or '',
            'codigo':     int(r[2]) if r[2] is not None else None,
            'qtd':        float(r[8] or 0),
            'valor':      float(r[9] or 0),
        })

    # ---- Rankings agregados ----
    def agrega_por(rows, idx_chave_id, idx_nome, idx_qtd, idx_val):
        skus = defaultdict(set)
        qtds = defaultdict(float)
        vals = defaultdict(float)
        nomes = {}
        for r in rows:
            chave = r[idx_chave_id]
            skus[chave].add(r[2])  # SKUs distintos
            qtds[chave] += float(r[idx_qtd] or 0)
            vals[chave] += float(r[idx_val] or 0)
            nomes[chave] = r[idx_nome]
        out = []
        for k in nomes:
            out.append({
                'nome':            nomes[k],
                'valor':           round(vals[k], 2),
                'qtd':             round(qtds[k], 2),
                'skus_distintos':  len(skus[k]),
            })
        out.sort(key=lambda x: -(x['valor'] or 0))
        return out

    # Compradores: chave=COD_COMPRADOR, nome=COMPRADOR
    ranking_compradores = agrega_por(rows, 6, 7, 8, 9)
    # Lojas: chave=COD_EMPRESA, nome=EMPRESA (com prefixo "NN-")
    ranking_lojas_raw = agrega_por(rows, 0, 1, 8, 9)
    # Empresa formatada
    ranking_lojas = []
    for r in ranking_lojas_raw:
        # Encontrar COD pelo nome (lookup nas rows)
        cod = next((row[0] for row in rows if row[1] == r['nome']), None)
        nome_fmt = f"{int(cod):02d}-{r['nome']}" if cod else r['nome']
        ranking_lojas.append({**r, 'nome': nome_fmt})
    # Fornecedores: chave=COD_FORNECEDOR, nome=FORNECEDOR
    ranking_fornecedores = agrega_por(rows, 4, 5, 8, 9)

    # ---- Totais ----
    total_valor = sum(it['valor'] for it in itens)
    total_qtd   = sum(it['qtd'] for it in itens)
    total_skus  = len({it['codigo'] for it in itens})
    total_lojas = len({it['loja'] for it in itens})
    total_forn  = len({it['fornecedor'] for it in itens})
    total_comp  = len({it['comprador'] for it in itens})

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'totais': {
            'valor':       round(total_valor, 2),
            'qtd':         round(total_qtd, 2),
            'qtd_skus':    total_skus,
            'qtd_lojas':   total_lojas,
            'qtd_forn':    total_forn,
            'qtd_comp':    total_comp,
        },
        # Evolução é montada pelo servidor via troca_historico (Postgres)
        'evolucao_diaria': {'datas': [], 'total': {'por_dia': {}}, 'geral': []},
        'ranking_compradores': ranking_compradores,
        'ranking_lojas':       ranking_lojas,
        'ranking_fornecedores': ranking_fornecedores,
        'itens': itens,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    print()
    print(f'✓ salvo em {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)')
    print(f'Total: R$ {total_valor:>14,.2f}  ·  {total_qtd:>10,.2f} unid.  ·  {total_skus} SKUs distintos')
    print(f'Lojas: {total_lojas} · Fornecedores: {total_forn} · Compradores: {total_comp}')


if __name__ == '__main__':
    main()
