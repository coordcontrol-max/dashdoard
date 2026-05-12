#!/usr/bin/env python3
"""Gera data/kpis.json — KPIs Comerciais.

Pipeline:
  1. Rodar 4 queries no Oracle (extraídas da aba TEMPLETE (2) da planilha):
     - Q1: VENDA E MARGEM por comprador (Conn 7)
     - Q2: ESTOQUE (qtd, dias, custo) por comprador (Conn 4)
     - Q3: PERDA/QUEBRA por comprador (Conn 1)
     - Q4: TROCA por comprador (Conn 2 — versão simplificada já feita)
  2. Lê METAS da planilha data/KPIs.xlsx (aba TEMPLETE (2))
     - Bloco 1: META por gerente (Perecível/Mercearia) — col D
     - Bloco 2: META por comprador (DDE, Ruptura, Quebra, Troca, Foto) — cols D,H,L,P,T
  3. Reusa dados de RUPTURA do app_data (já carregado no servidor)
  4. Calcula atingimentos, ranks e status
  5. Salva data/kpis.json
"""
import json
import os
import re
import sys
import time
import zipfile
from collections import defaultdict
from datetime import datetime, date
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
PLANILHA = Path('./data/KPIs.xlsx')
OUT_PATH = Path('./data/kpis.json')

# Filtros comuns
NROEMPRESA_PEREC = "5,7,10,101,102,103,104,106,108,109,11,112,117,125,13,131,14,16,17,18,20,21,215,219,222,23,25,26,27,28,29"

# Gerente → lista de chaves (parte do APELIDO depois do dash)
GRUPOS = [
  ('André', ['ISRAEL', 'PAULO', 'SAMUEL', 'WALLACE']),
  ('Walas', ['MAURIC', 'WAL', 'LUZIA(PERF)', 'IGOR', 'LUCAS', 'LUZIA(BAZAR)', 'WALAS']),
]

def chave_apelido(apelido):
    """01-MAURIC(SEC) → MAURIC(SEC); 03-ISRAEL(FLV) → ISRAEL(FLV)"""
    m = re.match(r'^[\d\s]*-\s*(.+)$', str(apelido or '').strip())
    return (m.group(1) if m else str(apelido or '')).strip().upper().replace(' ', '')

def gerente_de(apelido):
    k = chave_apelido(apelido)
    for nome, chaves in GRUPOS:
        for ch in chaves:
            chU = ch.upper()
            if k == chU or k.startswith(chU + '('):
                return nome
    return None

# ===== Datas: do dia 1 do mês até ontem =====
def periodo_mes_atual():
    hoje = date.today()
    primeiro = date(hoje.year, hoje.month, 1)
    # ontem (sysdate -1)
    ontem = date.today().fromordinal(date.today().toordinal() - 1)
    return primeiro, ontem

# ============================================================
# Q1 — VENDA E MARGEM (Conn 7)
# Retorna: APELIDO, VENDA, LUCRATIVIDADE, QTD, DOCTOS, VENDAPROMOC, MARGEM_PDV, ?, VERBA
# ============================================================
def sql_venda_margem(dt_ini, dt_fim):
    return f"""
SELECT O.APELIDO,
       V.DTAVDA AS DATA_VENDA,
       SUM((ROUND(V.VLRITEM, 2)) - (ROUND(V.VLRDEVOLITEM, 2) - (0))) AS VLRVENDA,
       ROUND(SUM(FC5_ABCDISTRIBLUCRATIVIDADE('L','L','N',V.VLRITEM,'N',
              V.VLRICMSST,V.VLRFCPST,V.VLRICMSSTEMPORIG,E.UF,V.UFPESSOA,
              'N',0,'N',V.VLRIPIITEM,V.VLRIPIDEVOLITEM,'N',V.VLRDESCFORANF,
              Y.CMDIAVLRNF - 0, Y.CMDIAIPI, NVL(Y.CMDIACREDPIS, 0), NVL(Y.CMDIACREDCOFINS, 0),
              Y.CMDIAICMSST, Y.CMDIADESPNF, Y.CMDIADESPFORANF, Y.CMDIADCTOFORANF,
              'S', A.PROPQTDPRODUTOBASE, V.QTDITEM, V.VLREMBDESCRESSARCST, V.ACMCOMPRAVENDA,
              V.PISITEM, V.COFINSITEM,
              DECODE(V.TIPCGO,'S',Y.QTDVDA,NVL(Y.QTDDEVOL,Y.QTDVDA)),
              (DECODE(V.TIPCGO,'S',Y.VLRIMPOSTOVDA - NVL(Y.VLRIPIVDA,0),
                NVL(Y.VLRIMPOSTODEVOL - NVL(V.VLRIPIDEVOLITEM,0),Y.VLRIMPOSTOVDA - NVL(Y.VLRIPIVDA,0)))),
              'N', V.VLRDESPOPERACIONALITEM, Y.VLRDESPESAVDA, 'N', NVL(Y.VLRVERBAVDAACR, 0),
              Y.QTDVERBAVDA, Y.VLRVERBAVDA - NVL(Y.VLRVERBAVDAINDEVIDA,0),
              'N', NVL(V.VLRTOTCOMISSAOITEM,0), V.VLRDEVOLITEM, V.VLRDEVOLICMSST, V.DVLRFCPST,
              V.QTDDEVOLITEM, V.PISDEVOLITEM, V.COFINSDEVOLITEM,
              V.VLRDESPOPERACIONALITEMDEVOL, V.VLRTOTCOMISSAOITEMDEVOL,
              E.PERIRLUCRAT, E.PERCSLLLUCRAT, Y.CMDIACREDICMS,
              DECODE(V.ICMSEFETIVOITEM,0,V.ICMSITEM,V.ICMSEFETIVOITEM),
              V.VLRFCPICMS, V.PERCPMF, V.PEROUTROIMPOSTO,
              DECODE(V.ICMSEFETIVODEVOLITEM,0,V.ICMSDEVOLITEM,V.ICMSEFETIVODEVOLITEM),
              V.DVLRFCPICMS,
              CASE WHEN ('S')='N' THEN
                (NVL(Y.CMDIAVLRDESCPISTRANSF,0)+NVL(Y.CMDIAVLRDESCCOFINSTRANSF,0)+NVL(Y.CMDIAVLRDESCICMSTRANSF,0)+
                 NVL(Y.CMDIAVLRDESCIPITRANSF,0)+NVL(Y.CMDIAVLRDESCLUCROTRANSF,0)+NVL(Y.CMDIAVLRDESCVERBATRANSF,0))
              ELSE 0 END,
              CASE WHEN DV.UTILACRESCCUSTPRODRELAC='S' AND NVL(A.SEQPRODUTOBASE,A.SEQPRODUTOBASEANTIGO) IS NOT NULL
                THEN COALESCE(PR.PERCACRESCCUSTORELACVIG, NVL(F_RETACRESCCUSTORELACABC(V.SEQPRODUTO,V.DTAVDA),1))
                ELSE 1 END,
              'N',0,0,'S',V.VLRDESCMEDALHA,'S',V.VLRDESCFORNEC,V.VLRDESCFORNECDEVOL,
              'N',V.VLRFRETEITEMRATEIO,V.VLRFRETEITEMRATEIODEV,'S',V.VLRICMSSTEMBUTPROD,V.VLRICMSSTEMBUTPRODDEV,
              V.VLREMBDESCRESSARCSTDEVOL,
              CASE WHEN 'N'='S' THEN NVL(V.VLRDESCACORDOVERBAPDV,0) ELSE 0 END,
              NVL(Y.CMDIACREDIPI,0),NVL(V.VLRITEMRATEIOCTE,0),'N','C',V.VLRIPIPRECOVDA,V.VLRIPIPRECODEVOL,V.VLRDESCMEDALHADEVOL)),2) AS LUCRATIVIDADE
  FROM MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V,
       MAP_PRODUTO A, MAP_PRODUTO PB,
       MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K,
       MAX_EMPRESA E, MAX_DIVISAO DV,
       MAP_PRODACRESCCUSTORELAC PR, MAX_COMPRADOR O
 WHERE D.SEQFAMILIA = A.SEQFAMILIA
   AND D.NRODIVISAO = V.NRODIVISAO
   AND V.SEQPRODUTO = A.SEQPRODUTO
   AND V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
   AND V.NROEMPRESA IN (SELECT P.SEQPESSOAEMP FROM MAX_EMPRESA P)
   AND V.NROEMPRESA NOT IN (0,1,2,3,4,6,8,9,12,15,17,19,22,115,119,122,130,901,997,998,999)
   AND V.NROSEGMENTO IN (SELECT S.NROSEGMENTO FROM MAD_SEGMENTO S)
   AND V.NRODIVISAO = D.NRODIVISAO
   AND E.NROEMPRESA = V.NROEMPRESA
   AND E.NRODIVISAO = DV.NRODIVISAO
   AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
   AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
   AND V.DTAVDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
   AND Y.NROEMPRESA = NVL(E.NROEMPCUSTOABC, E.NROEMPRESA)
   AND Y.DTAENTRADASAIDA = V.DTAVDA
   AND K.SEQFAMILIA = A.SEQFAMILIA AND K.QTDEMBALAGEM = 1
   AND Y.SEQPRODUTO = PB.SEQPRODUTO
   AND D.SEQCOMPRADOR = O.SEQCOMPRADOR
   AND DECODE(V.TIPTABELA,'S',V.CGOACMCOMPRAVENDA,V.ACMCOMPRAVENDA) IN ('S','I')
   AND D.SEQCOMPRADOR != 14
 GROUP BY O.APELIDO, V.DTAVDA
 ORDER BY 1, 2
"""

# ============================================================
# Q2 — ESTOQUE (qtd, media venda) — Conn 4 com filtros completos
# Filtros: categoria 3082/1946/1948/1947, segmento 1/2/3/4,
# exclui compradores 14,13,20,11,15,21,19,2,17,12,
# usa NRODIVISAO=4 nas subqueries.
# ============================================================
SQL_ESTOQUE_NROEMPRESAS = "5,7,10,101,102,103,104,106,108,109,11,112,117,125,13,131,14,16,18,20,21,215,219,222,23,26,27,28,29"
SQL_ESTOQUE = f"""
SELECT
    O.APELIDO                                                    AS COMPRADOR,
    ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ) AS QTDTOTAL,
    SUM( C.MEDVDIAGERAL / K.QTDEMBALAGEM )                       AS MEDVDIA,
    NVL( FC5_DIVIDE(
        ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ),
        ROUND( SUM( C.MEDVDIAGERAL / K.QTDEMBALAGEM ), 3 )
    ), 0 )                                                       AS DIASESTOQUE,
    SUM(
        (
            C.CMULTVLRNF + C.CMULTIPI +
            C.CMULTDESPNF + C.CMULTICMSST + C.CMULTDESPFORANF +
            FC_RETORNAIMPREFORMATOTAL(
                pnVlrimpostoibsmun     => NVL(C.CMULTIBSMUN,     0),
                pnVlrimpostoibsuf      => NVL(C.CMULTIBSUF,      0),
                pnVlrimpostocbs        => NVL(C.CMULTCBS,        0),
                pnVlrimpostois         => NVL(C.CMULTIS,         0),
                pnVlrimpostoibsmunCred => NVL(C.CMULTCREDIBSMUN, 0),
                pnVlrimpostoibsufCred  => NVL(C.CMULTCREDIBSUF,  0),
                pnVlrimpostocbsCred    => NVL(C.CMULTCREDCBS,    0),
                pnVlrimpostoisCred     => NVL(C.CMULTCREDIS,     0),
                psTipoCalculo => 'C',
                psTipoCusto   => 'B'
            )
            - ( NVL( F_CMDIADTOFNF(C.SEQPRODUTO, C.NROEMPRESA, SYSDATE), C.CMULTDCTOFORANF ) - C.CMULTIMPOSTOPRESUM )
            + C.VLRDESCTRANSFCB
        )
        * ( CASE
                WHEN I2.UTILACRESCCUSTPRODRELAC = 'S'
                 AND NVL( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) IS NOT NULL
                THEN COALESCE(
                        PR.PERCACRESCCUSTORELACVIG,
                        F_RETACRESCCUSTORELAC( C.SEQPRODUTO, C.DTAENTRADASAIDA, I2.UTILACRESCCUSTPRODRELAC, PR.PERCACRESCCUSTORELACVIG )
                     )
                ELSE 1
            END )
        * ( ESTQLOJA + ESTQDEPOSITO )
    )                                                            AS VLRCTOBRUTO
FROM
    MAP_PRODUTO A,
    MAP_FAMILIA B,
    ( SELECT
          Y.SEQPRODUTO, Y.NROEMPRESA, Y.SEQCLUSTER,
          DECODE( ( ESTQLOJA + ESTQDEPOSITO ), 0, NULL, Y.SEQPRODUTO ) SEQPRODUTOCOMESTQ,
          DECODE( X.PRECO, 0, X.MENORPRECO, X.PRECO )                  PRECO,
          X.MENORPRECO, X.MAIORPRECO,
          Y.ESTQLOJA, Y.ESTQDEPOSITO,
          Y.QTDPENDPEDCOMPRA, Y.QTDPENDPEDEXPED,
          Y.QTDRESERVADAVDA, Y.QTDRESERVADARECEB,
          Y.MEDVDIAGERAL,
          Y.CMULTVLRNF, Y.CMULTIPI,
          NVL(Y.CMULTCREDIBSMUN, 0) CMULTCREDIBSMUN,
          NVL(Y.CMULTCREDIBSUF,  0) CMULTCREDIBSUF,
          NVL(Y.CMULTCREDCBS,    0) CMULTCREDCBS,
          NVL(Y.CMULTCREDIS,     0) CMULTCREDIS,
          NVL(Y.CMULTIS,         0) CMULTIS,
          NVL(Y.CMULTCBS,        0) CMULTCBS,
          NVL(Y.CMULTIBSMUN,     0) CMULTIBSMUN,
          NVL(Y.CMULTIBSUF,      0) CMULTIBSUF,
          Y.CMULTCREDICMS, Y.CMULTICMSST, Y.CMULTDESPNF,
          Y.CMULTDESPFORANF, Y.CMULTDCTOFORANF,
          NVL(Y.CMULTIMPOSTOPRESUM,   0) CMULTIMPOSTOPRESUM,
          NVL(Y.CMULTCREDPIS,         0) CMULTCREDPIS,
          NVL(Y.CMULTCREDCOFINS,      0) CMULTCREDCOFINS,
          NVL(Y.CMULTCREDIPI,         0) CMULTCREDIPI,
          NVL(Y.CMULTVLRDESPFIXA,     0) CMULTVLRDESPFIXA,
          NVL(Y.CMULTVLRDESCFIXO,     0) CMULTVLRDESCFIXO,
          NVL(Y.ESTQEMPRESA,          0) ESTQEMPRESA,
          SYSDATE                         DTAENTRADASAIDA,
          Y.INDPOSICAOCATEG,
          Y.DTAULTVENDA,
          ( NVL(Y.CMULTVLRDESCPISTRANSF,       0)
          + NVL(Y.CMULTVLRDESCCOFINSTRANSF,    0)
          + NVL(Y.CMULTVLRDESCICMSTRANSF,      0)
          + NVL(Y.CMULTVLRDESCIPITRANSF,       0)
          + NVL(Y.CMULTVLRDESCLUCROTRANSF,     0)
          + NVL(Y.CMULTVLRDESCVERBATRANSF,     0)
          + NVL(Y.CMULTVLRDESCDIFERENCATRANSF, 0) ) VLRDESCTRANSFCB,
          NVL(Y.CMULTDCTOFORANFEMP, 0) CMULTDCTOFORANFEMP,
          CASE WHEN NVL(Y.CMULTCUSLIQUIDOEMP,0) - NVL(Y.CMULTDCTOFORANFEMP,0) < 0
               THEN 0
               ELSE NVL(Y.CMULTCUSLIQUIDOEMP,0) - NVL(Y.CMULTDCTOFORANFEMP,0)
          END CUSTOFISCALUNIT
      FROM
          ( SELECT
                SEQPRODUTO, NROEMPRESA,
                MAX( CASE
                        WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                        ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM
                     END ) PRECO,
                MIN( CASE
                        WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                        ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM
                     END ) MENORPRECO,
                MAX( CASE
                        WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                        ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM
                     END ) MAIORPRECO,
                DECODE( MIN( STATUSVENDA ), 'A', MIN( STATUSVENDA ), 'I' ) STATUSVENDA
            FROM  MRL_PRODEMPSEG
            WHERE NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
              AND NROSEGMENTO IN ( 2,4,1,3 )
            GROUP BY SEQPRODUTO, NROEMPRESA
          ) X,
          MRL_PRODUTOEMPRESA Y,
          MAX_EMPRESA        E
      WHERE E.NROEMPRESA  = Y.NROEMPRESA
        AND Y.NROEMPRESA  = X.NROEMPRESA
        AND Y.SEQPRODUTO  = X.SEQPRODUTO
        AND X.SEQPRODUTO IN (
              SELECT JP2.SEQPRODUTO
              FROM   MAP_FAMDIVCATEG JX2, MAP_PRODUTO JP2
              WHERE  JP2.SEQFAMILIA    = JX2.SEQFAMILIA
                AND  JX2.STATUS        = 'A'
                AND  JX2.NRODIVISAO    = 4
                AND  JX2.SEQCATEGORIA IN ( 3082, 1946, 1948, 1947 )
        )
        AND Y.SEQPRODUTO IN (
              SELECT FF.SEQPRODUTO
              FROM   MAP_PRODUTO FF
              WHERE  FF.SEQFAMILIA NOT IN (
                         SELECT SEQFAMILIA FROM MAP_FAMDIVISAO
                         WHERE  NRODIVISAO   = '4'
                           AND  SEQCOMPRADOR IN ( 14,13,20,11,15,21,19,2,17,12 )
                     )
        )
        AND Y.SEQPRODUTO IN (
              SELECT FF.SEQPRODUTO
              FROM   MAP_PRODUTO FF
              WHERE  FF.SEQFAMILIA IN (
                         SELECT MAP_FAMDIVCATEG.SEQFAMILIA
                         FROM   MAP_CATEGORIA, MAP_FAMDIVCATEG
                         WHERE  MAP_CATEGORIA.NRODIVISAO        = E.NRODIVISAO
                           AND  MAP_FAMDIVCATEG.SEQCATEGORIA    = MAP_CATEGORIA.SEQCATEGORIA
                           AND  MAP_FAMDIVCATEG.NRODIVISAO      = MAP_CATEGORIA.NRODIVISAO
                           AND  MAP_FAMDIVCATEG.STATUS          = 'A'
                           AND  MAP_CATEGORIA.TIPCATEGORIA      = 'M'
                           AND  MAP_CATEGORIA.STATUSCATEGOR    IN ( 'A', 'F' )
                           AND  MAP_FAMDIVCATEG.SEQCATEGORIA   IN ( 3082, 1946, 1948, 1947 )
                     )
        )
    ) C,
    MAP_FAMDIVISAO             D,
    MAP_FAMEMBALAGEM           K,
    MAX_EMPRESA                E,
    MAD_PARAMETRO              J3,
    MAX_DIVISAO                I2,
    MAP_CLASSIFABC             Z2,
    MAD_FAMSEGMENTO            H,
    MAP_REGIMETRIBUTACAO       RT,
    MAP_TRIBUTACAOUF           T3,
    MAPV_PISCOFINSTRIBUT       SS,
    MAX_COMPRADOR              O,
    MAP_FAMDIVCATEG            W,
    MAD_SEGMENTO               SE,
    MAP_PRODACRESCCUSTORELAC   PR,
    MAP_FAMDIVCATEG            FDC,
    MAP_CATEGORIA              CAT
WHERE A.SEQPRODUTO         = C.SEQPRODUTO
  AND B.SEQFAMILIA         = A.SEQFAMILIA
  AND C.NROEMPRESA        IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND D.SEQFAMILIA         = A.SEQFAMILIA
  AND D.NRODIVISAO         = E.NRODIVISAO
  AND K.SEQFAMILIA         = D.SEQFAMILIA
  AND K.QTDEMBALAGEM       = 1
  AND E.NROEMPRESA         = C.NROEMPRESA
  AND J3.NROEMPRESA        = E.NROEMPRESA
  AND I2.NRODIVISAO        = E.NRODIVISAO
  AND I2.NRODIVISAO        = D.NRODIVISAO
  AND Z2.NROSEGMENTO       = H.NROSEGMENTO
  AND Z2.CLASSIFCOMERCABC  = H.CLASSIFCOMERCABC
  AND Z2.NROSEGMENTO       = SE.NROSEGMENTO
  AND T3.NROTRIBUTACAO     = D.NROTRIBUTACAO
  AND T3.UFEMPRESA         = NVL( E.UFFORMACAOPRECO, E.UF )
  AND T3.UFCLIENTEFORNEC   = E.UF
  AND T3.TIPTRIBUTACAO     = DECODE( I2.TIPDIVISAO, 'V', 'SN', 'SC' )
  AND T3.NROREGTRIBUTACAO  = NVL( E.NROREGTRIBUTACAO, 0 )
  AND A.SEQFAMILIA         = FDC.SEQFAMILIA
  AND CAT.NRODIVISAO       = E.NRODIVISAO
  AND FDC.SEQCATEGORIA     = CAT.SEQCATEGORIA
  AND FDC.NRODIVISAO       = CAT.NRODIVISAO
  AND B.SEQFAMILIA         = A.SEQFAMILIA
  AND CAT.NIVELHIERARQUIA  = 1
  AND CAT.STATUSCATEGOR   IN ( 'A', 'F' )
  AND FDC.STATUS           = 'A'
  AND CAT.TIPCATEGORIA     = 'M'
  AND C.SEQPRODUTO         = PR.SEQPRODUTO(+)
  AND C.DTAENTRADASAIDA    = PR.DTAMOVIMENTACAO(+)
  AND SS.NROEMPRESA        = E.NROEMPRESA
  AND SS.NROTRIBUTACAO     = T3.NROTRIBUTACAO
  AND SS.UFEMPRESA         = T3.UFEMPRESA
  AND SS.UFCLIENTEFORNEC   = T3.UFCLIENTEFORNEC
  AND SS.TIPTRIBUTACAO     = T3.TIPTRIBUTACAO
  AND SS.NROREGTRIBUTACAO  = T3.NROREGTRIBUTACAO
  AND SS.SEQFAMILIA        = B.SEQFAMILIA
  AND O.SEQCOMPRADOR       = D.SEQCOMPRADOR
  AND W.SEQFAMILIA         = D.SEQFAMILIA
  AND W.NRODIVISAO         = D.NRODIVISAO
  AND W.STATUS             = 'A'
  AND W.SEQCATEGORIA      IN ( 3082, 1946, 1948, 1947 )
  AND H.SEQFAMILIA         = A.SEQFAMILIA
  AND H.NROSEGMENTO        = E.NROSEGMENTOPRINC
  AND T3.NROREGTRIBUTACAO  = RT.NROREGTRIBUTACAO
  AND D.SEQCOMPRADOR      NOT IN ( 14, 13, 20, 11, 15, 21, 19, 2, 17, 12 )
  AND ( ESTQLOJA + ESTQDEPOSITO ) != 0
  AND A.SEQPRODUTOBASE    IS NULL
GROUP BY
    O.SEQCOMPRADOR,
    O.APELIDO
HAVING
    ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ) != 0
ORDER BY
    O.APELIDO
"""

# ============================================================
# Q3 — PERDA/QUEBRA por comprador (versão definitiva — passada pelo João)
# Filtros: NRODIVISAO 1,2,3,4 + MAP_FAMILIA + MAP_FAMEMBALAGEM (QTDEMBALAGEM=1)
# ============================================================
NROEMPRESA_PERDA = "5,7,10,11,13,14,16,18,20,21,23,26,27,28,29,101,102,103,104,106,108,109,112,117,125,131,215,219,222"
def sql_perda(dt_ini, dt_fim):
    return f"""
SELECT
  CAST(O.SEQCOMPRADOR AS NUMBER)               AS SEQ_COMPRADOR,
  CAST(O.APELIDO      AS VARCHAR2(60))         AS NOME_COMPRADOR,
  CAST(SUM(VW.VALORLANCTOBRT) AS NUMBER(18,2)) AS VLR_PERDA_BRUTA
FROM MAXV_ABCPERDABASE VW,
     MAP_FAMDIVISAO    D,
     MAX_EMPRESA       E,
     MAX_COMPRADOR     O,
     MAP_FAMILIA       B,
     MAP_FAMEMBALAGEM  K
WHERE VW.DTAENTRADASAIDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','dd/mm/yyyy')
                             AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','dd/mm/yyyy')
  AND VW.NROEMPRESA IN ({NROEMPRESA_PERDA})
  AND VW.TIPCLASSINTERNO IN ('P','R','C','A')
  AND VW.CODGERALOPER = 549
  AND VW.TIPLANCTO    = 'S'
  AND E.NROEMPRESA = VW.NROEMPRESA
  AND D.SEQFAMILIA = VW.SEQFAMILIA
  AND D.NRODIVISAO = E.NRODIVISAO
  AND D.NRODIVISAO IN (1,2,3,4)
  AND O.SEQCOMPRADOR = D.SEQCOMPRADOR
  AND B.SEQFAMILIA = VW.SEQFAMILIA
  AND K.SEQFAMILIA = VW.SEQFAMILIA
  AND K.QTDEMBALAGEM = 1
GROUP BY O.SEQCOMPRADOR, O.APELIDO
ORDER BY VLR_PERDA_BRUTA DESC
"""

# ============================================================
# Q4 — TROCA por comprador — usa MESMA query do extract_troca_db.py
# (NROEMPRESA_LIST = lojas usadas no relatório de Troca)
# Retorna por (loja, produto, fornec, comprador), agregação no Python.
# ============================================================
NROEMPRESA_TROCA = "5,10,11,12,13,14,16,18,20,21,23,26,27,28,29,101,102,103,104,106,108,109,112,117,125,131,215,219,222"
SQL_TROCA = f"""
SELECT
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
        FROM MRL_PRODUTOEMPRESA Y
        WHERE Y.NROEMPRESA IN ({NROEMPRESA_TROCA})
    ) C,
    MAP_FAMDIVISAO              D,
    MAP_FAMEMBALAGEM            K,
    MAX_EMPRESA                 E,
    MAX_DIVISAO                 I2,
    MAP_PRODACRESCCUSTORELAC    PR,
    GE_PESSOA                   P,
    MAP_FAMFORNEC               F,
    MAX_COMPRADOR               O
WHERE A.SEQPRODUTO = C.SEQPRODUTO
  AND B.SEQFAMILIA = A.SEQFAMILIA
  AND D.SEQFAMILIA = A.SEQFAMILIA
  AND D.NRODIVISAO = E.NRODIVISAO
  AND K.SEQFAMILIA = D.SEQFAMILIA
  AND K.QTDEMBALAGEM = 1
  AND E.NROEMPRESA = C.NROEMPRESA
  AND E.NROEMPRESA IN ({NROEMPRESA_TROCA})
  AND I2.NRODIVISAO = E.NRODIVISAO
  AND I2.NRODIVISAO = D.NRODIVISAO
  AND C.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND C.DTAENTRADASAIDA = PR.DTAMOVIMENTACAO(+)
  AND F.SEQFORNECEDOR = P.SEQPESSOA
  AND F.SEQFAMILIA = A.SEQFAMILIA
  AND F.PRINCIPAL = 'S'
  AND O.SEQCOMPRADOR = D.SEQCOMPRADOR
  AND C.ESTQTROCA != 0
  AND A.SEQPRODUTOBASE IS NULL
GROUP BY O.APELIDO
HAVING ROUND(SUM(C.ESTQTROCA / K.QTDEMBALAGEM), 6) != 0
ORDER BY O.APELIDO
"""


# ============================================================
# Q5 — FOTO TABLOIDE (acordos promocionais codtipoacordo=2)
# Soma vlracordo no período e agrega por comprador.
# ============================================================
def sql_foto(dt_ini, dt_fim):
    return f"""
SELECT
  B.APELIDO    AS APELIDO,
  A.DTAEMISSAO AS DTAEMISSAO,
  A.VLRACORDO  AS VLRACORDO
FROM MSU_ACORDOPROMOC A,
     MAX_COMPRADOR    B
WHERE A.DTAEMISSAO BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','dd/mm/yyyy')
                       AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','dd/mm/yyyy')
  AND A.CODTIPOACORDO = '2'
  AND A.SEQCOMPRADOR = B.SEQCOMPRADOR
"""


# ===== Lê metas da planilha =====
def _parse_sheet_rows(z, sheet_path, sst):
    sheet_xml = z.read(sheet_path).decode()
    rows_xml = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet_xml, re.S)
    rows = {}
    for rn, content in rows_xml:
        cells = re.findall(r'<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)', content, re.S)
        r = {}
        for col, ctype, inner in cells:
            if not inner: continue
            vm = re.search(r'<v>([^<]*)</v>', inner)
            if not vm: continue
            v = vm.group(1)
            if ctype == 's':
                try: v = sst[int(v)]
                except: pass
            else:
                try: v = float(v)
                except: pass
            r[col] = v
        rows[int(rn)] = r
    return rows

# Excel epoch (1900-01-01 = serial 1, mas com bug 1900 não-bissexto, então:
# 1900-01-01 = serial 1, 1900-02-28 = serial 59, 1900-03-01 = serial 61)
def excel_serial_to_date(serial):
    from datetime import date, timedelta
    # Subtrai 2 (1 pra epoch + 1 pro bug do 1900)
    return date(1899, 12, 30) + timedelta(days=int(serial))

def parse_planilha_metas(dt_ate):
    """Lê metas:
    - Aba BASE META: META VENDA (linhas 3-13) e META MARGEM (linhas 18-28) por comprador,
      acumulado até dt_ate (somando colunas dia a dia até ontem).
    - Aba TEMPLETE (2): META do bloco 2 (DDE, ruptura, quebra, troca, foto) por comprador.
    """
    if not PLANILHA.exists():
        print(f'AVISO: planilha {PLANILHA} não encontrada — sem metas', file=sys.stderr)
        return {}
    with zipfile.ZipFile(PLANILHA) as z:
        sst_raw = z.read('xl/sharedStrings.xml').decode()
        sst = []
        for b in re.findall(r'<si[^>]*>(.*?)</si>', sst_raw, re.S):
            sst.append(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', b)))

        # TEMPLETE (2) = sheet3 (rId3) — pega metas do bloco 2
        rows_t2 = _parse_sheet_rows(z, 'xl/worksheets/sheet3.xml', sst)
        # BASE META = sheet11 (rId11)
        rows_bm = _parse_sheet_rows(z, 'xl/worksheets/sheet11.xml', sst)

    # ---- BASE META: identifica colunas de cada dia ----
    # Linha 2 (TOTAL VENDA header): col B='GERAL', cols C+ tem serials de data
    header_venda = rows_bm.get(2, {})
    header_marg  = rows_bm.get(17, {})

    serial_alvo = (dt_ate - excel_serial_to_date(0)).days
    # Acha quais colunas (letras) somar — todas onde valor da linha header é serial entre 1ª data do mês e dt_ate
    # (inclusive)
    def cols_ate(header):
        out = []
        for col, val in header.items():
            if not isinstance(val, (int, float)): continue
            if 40000 < val <= serial_alvo:  # 40000 = filtro pra evitar valores não-data
                out.append(col)
        return out

    cols_v = cols_ate(header_venda)
    cols_m = cols_ate(header_marg)

    def meta_acumulada(rows, linha, cols):
        r = rows.get(linha, {})
        return sum(float(r.get(c, 0) or 0) for c in cols)

    # Compradores: BASE META linhas 3-13 (venda), 18-28 (margem)
    meta_v_por_nome = {}
    meta_m_por_nome = {}
    metas_diarias = {}  # {apelido: {YYYY-MM-DD: {meta_venda, meta_margem}}}

    def meta_diaria(rows, linha, header):
        """Devolve {YYYY-MM-DD: valor} pra cada coluna que tem serial de data no header."""
        r = rows.get(linha, {})
        out = {}
        for col, val in header.items():
            if not isinstance(val, (int, float)) or val < 40000:
                continue
            try:
                dt_str = excel_serial_to_date(val).isoformat()
            except Exception:
                continue
            v = r.get(col)
            if v is not None:
                out[dt_str] = float(v) if isinstance(v, (int, float)) else 0
        return out

    for rn in range(3, 14):
        r = rows_bm.get(rn, {})
        nome = str(r.get('A', '')).strip()
        if not nome or nome == 'TOTAL': continue
        meta_v_por_nome[nome] = meta_acumulada(rows_bm, rn, cols_v)
        if nome not in metas_diarias: metas_diarias[nome] = {}
        for dt_str, v in meta_diaria(rows_bm, rn, header_venda).items():
            if dt_str not in metas_diarias[nome]: metas_diarias[nome][dt_str] = {}
            metas_diarias[nome][dt_str]['meta_venda'] = v
    for rn in range(18, 29):
        r = rows_bm.get(rn, {})
        nome = str(r.get('A', '')).strip()
        if not nome or nome == 'TOTAL': continue
        meta_m_por_nome[nome] = meta_acumulada(rows_bm, rn, cols_m)
        if nome not in metas_diarias: metas_diarias[nome] = {}
        for dt_str, v in meta_diaria(rows_bm, rn, header_marg).items():
            if dt_str not in metas_diarias[nome]: metas_diarias[nome][dt_str] = {}
            metas_diarias[nome][dt_str]['meta_margem'] = v

    # Totais
    meta_v_total = meta_acumulada(rows_bm, 14, cols_v)
    meta_m_total = meta_acumulada(rows_bm, 29, cols_m)

    # ---- TEMPLETE (2): metas do bloco 2 (DDE, RUPTURA, QUEBRA, TROCA, FOTO) ----
    metas_b2 = {}
    for rn in list(range(28, 32)) + list(range(33, 40)):
        r = rows_t2.get(rn, {})
        nome = str(r.get('B', '')).strip()
        if not nome or nome.startswith('PER') or nome.startswith('MER') or nome == 'TOTAL': continue
        metas_b2[nome] = {
            'meta_dde':     r.get('D'),
            'meta_ruptura': r.get('H'),
            'meta_quebra':  r.get('L'),
            'meta_troca':   r.get('P'),
            'meta_foto':    r.get('T'),
        }

    return {
        'meta_venda_por':  meta_v_por_nome,
        'meta_margem_por': meta_m_por_nome,
        'meta_venda_total': meta_v_total,
        'meta_margem_total': meta_m_total,
        'metas_diarias':   metas_diarias,
        'b2': metas_b2,
    }


def run_query(cur, label, sql):
    t = time.time()
    print(f'  → {label}…', end='', flush=True)
    cur.execute(sql)
    rows = cur.fetchall()
    print(f' {len(rows)} linhas em {time.time()-t:.1f}s')
    return rows


def ler_ruptura_local():
    """Lê data/ruptura.json e devolve:
    - dict APELIDO → {pct, skus, zerados} (pra média ponderada)
    - total_geral_pct (do kpis.total_geral) — mesmo valor que aparece na página /ruptura
    """
    p = Path('./data/ruptura.json')
    if not p.exists():
        return {}, None
    try:
        d = json.loads(p.read_text(encoding='utf-8'))
        out = {}
        for r in (d.get('ranking_compradores', {}).get('geral', []) or []):
            nome = r.get('nome', '')
            if nome:
                out[nome] = {
                    'pct': r.get('pct'),
                    'skus': r.get('skus') or 0,
                    'zerados': r.get('zerados') or 0,
                }
        total_pct = d.get('kpis', {}).get('total_geral', {}).get('pct')
        return out, total_pct
    except Exception as e:
        print(f'AVISO: falha ao ler ruptura.json: {e}', file=sys.stderr)
        return {}, None


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    dt_ini, dt_fim = periodo_mes_atual()
    print(f'Período: {dt_ini.strftime("%d/%m/%Y")} → {dt_fim.strftime("%d/%m/%Y")}')

    print('Lendo ruptura local (data/ruptura.json)…')
    ruptura_info, ruptura_total_geral = ler_ruptura_local()
    ruptura_por = {nome: r['pct'] for nome, r in ruptura_info.items()}
    print(f'  → {len(ruptura_por)} compradores com ruptura · total geral: {ruptura_total_geral}')

    print('Lendo metas da planilha…')
    metas = parse_planilha_metas(dt_fim)
    if not metas:
        metas = {'meta_venda_por': {}, 'meta_margem_por': {}, 'meta_venda_total': 0, 'meta_margem_total': 0, 'b2': {}}
    print(f'  → {len(metas["b2"])} compradores com metas (b2) · meta venda total: R$ {metas["meta_venda_total"]:,.0f}')

    print(f'Conectando em {ORACLE_DSN} como {ORACLE_USER}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    rows_vm     = run_query(cur, 'Q1 venda+margem', sql_venda_margem(dt_ini, dt_fim))
    rows_estq   = run_query(cur, 'Q2 estoque',      SQL_ESTOQUE)
    rows_perda  = run_query(cur, 'Q3 perda/quebra', sql_perda(dt_ini, dt_fim))
    rows_troca  = run_query(cur, 'Q4 troca',        SQL_TROCA)
    rows_foto   = run_query(cur, 'Q5 foto tabloide',sql_foto(dt_ini, dt_fim))
    cur.close(); conn.close()

    # ---- Indexa por APELIDO (somando todos os dias) e por (APELIDO, DATA) ----
    # rows_vm cols: 0=APELIDO, 1=DATA_VENDA, 2=VLRVENDA, 3=LUCRATIVIDADE
    venda_por = {}
    margem_por = {}
    vendas_diarias = {}  # {apelido: {YYYY-MM-DD: {venda, margem}}}
    for r in rows_vm:
        ap, dt = r[0], r[1]
        v, m = float(r[2] or 0), float(r[3] or 0)
        venda_por[ap]  = venda_por.get(ap, 0) + v
        margem_por[ap] = margem_por.get(ap, 0) + m
        # data Oracle vem como datetime
        try:
            dt_str = dt.strftime('%Y-%m-%d') if hasattr(dt, 'strftime') else str(dt)[:10]
        except Exception:
            dt_str = str(dt)
        if ap not in vendas_diarias: vendas_diarias[ap] = {}
        if dt_str not in vendas_diarias[ap]:
            vendas_diarias[ap][dt_str] = {'venda': 0, 'margem': 0}
        vendas_diarias[ap][dt_str]['venda']  += v
        vendas_diarias[ap][dt_str]['margem'] += m
    # rows_estq cols: 0=APELIDO, 1=QTDTOTAL, 2=MEDVDIA, 3=DIASESTOQUE, 4=VLRCTOBRUTO
    qtd_por = {r[0]: float(r[1] or 0) for r in rows_estq}
    medvdia_por = {r[0]: float(r[2] or 0) for r in rows_estq}
    valor_estq_por = {r[0]: float(r[4] or 0) for r in rows_estq if len(r) > 4}
    perda_por = {r[1]: float(r[2] or 0) for r in rows_perda}  # r[1]=APELIDO, r[2]=VLR_PERDA_BRUTA
    troca_por = {r[0]: float(r[2] or 0) for r in rows_troca}
    # Foto tabloide: soma de vlracordo por apelido + breakdown diário (r=APELIDO, DTAEMISSAO, VLRACORDO)
    foto_por = {}
    foto_diaria = {}  # {apelido: {YYYY-MM-DD: valor}}
    for r in rows_foto:
        ap, dt, vlr = r[0], r[1], float(r[2] or 0)
        if not ap or not vlr:
            continue
        foto_por[ap] = foto_por.get(ap, 0) + vlr
        try:
            dt_str = dt.strftime('%Y-%m-%d') if hasattr(dt, 'strftime') else str(dt)[:10]
        except Exception:
            dt_str = str(dt)
        if ap not in foto_diaria: foto_diaria[ap] = {}
        foto_diaria[ap][dt_str] = foto_diaria[ap].get(dt_str, 0) + vlr

    # ---- Lista de compradores (todos que apareceram em qualquer query) ----
    todos = set(venda_por) | set(qtd_por) | set(perda_por) | set(troca_por) | set(foto_por)
    todos.discard(None)

    # ---- Calcula linhas individuais ----
    def calc_dde(qtd, medvdia):
        return (qtd / medvdia) if medvdia and medvdia > 0 else None

    def calc_pct(real, meta):
        if not real or not meta or meta == 0: return None
        # Pra ESTOQUE: meta/real (queremos meta MAIOR que real)
        return real / meta if real else None

    compradores = []
    for ap in sorted(todos):
        venda = venda_por.get(ap, 0)
        margem = margem_por.get(ap, 0)
        qtd = qtd_por.get(ap)
        medvdia = medvdia_por.get(ap)
        dde = calc_dde(qtd, medvdia)
        perda = perda_por.get(ap, 0)
        troca = troca_por.get(ap, 0)
        gerente = gerente_de(ap)
        meta_b2 = metas['b2'].get(ap, {})
        # Ruptura: lookup pelo nome no JSON local
        ruptura = ruptura_por.get(ap)
        compradores.append({
            'nome': ap,
            'gerente': gerente,
            'venda':       venda,
            'margem':      margem,    # Lucratividade (margem geral)
            'meta_venda':  metas['meta_venda_por'].get(ap),
            'meta_margem': metas['meta_margem_por'].get(ap),
            'qtd_estoque': qtd,
            'valor_estoque': valor_estq_por.get(ap, 0),
            'medvdia':     medvdia,
            'dde':         dde,
            'ruptura':     ruptura,    # % da aba RUPTURA (geral)
            'perda':       perda,
            'troca':       troca,
            'foto':        foto_por.get(ap, 0),   # FOTO TABLOIDE — soma vlracordo de msu_acordopromoc (codtipoacordo=2)
            'meta_dde':     meta_b2.get('meta_dde'),
            'meta_ruptura': meta_b2.get('meta_ruptura'),
            'meta_quebra':  meta_b2.get('meta_quebra'),
            'meta_troca':   meta_b2.get('meta_troca'),
            'meta_foto':    meta_b2.get('meta_foto'),
        })

    # ---- Agrega por gerente (soma) ----
    def agrega(filtro):
        items = [c for c in compradores if filtro(c)]
        venda = sum(c['venda'] or 0 for c in items)
        margem = sum(c['margem'] or 0 for c in items)
        meta_venda  = sum(c['meta_venda'] or 0 for c in items)
        meta_margem = sum(c['meta_margem'] or 0 for c in items)
        meta_quebra = sum(c['meta_quebra'] or 0 for c in items)
        meta_troca  = sum(c['meta_troca'] or 0 for c in items)
        meta_foto   = sum(c['meta_foto'] or 0 for c in items)
        qtd = sum(c['qtd_estoque'] or 0 for c in items)
        valor_estoque = sum(c.get('valor_estoque') or 0 for c in items)
        medvdia = sum(c['medvdia'] or 0 for c in items)
        dde = (qtd / medvdia) if medvdia and medvdia > 0 else None
        perda = sum(c['perda'] or 0 for c in items)
        troca = sum(c['troca'] or 0 for c in items)
        foto  = sum(c['foto'] or 0 for c in items)
        # Ruptura: média ponderada por SKUs (zerados / total skus) — mesma fórmula da página /ruptura
        soma_z = sum((ruptura_info.get(c['nome'], {}) or {}).get('zerados') or 0 for c in items)
        soma_s = sum((ruptura_info.get(c['nome'], {}) or {}).get('skus')    or 0 for c in items)
        ruptura_pond = (soma_z / soma_s) if soma_s > 0 else None
        return {
            'venda': venda, 'margem': margem,
            'meta_venda': meta_venda, 'meta_margem': meta_margem,
            'meta_quebra': meta_quebra, 'meta_troca': meta_troca, 'meta_foto': meta_foto,
            'qtd_estoque': qtd, 'valor_estoque': valor_estoque, 'medvdia': medvdia, 'dde': dde,
            'ruptura': ruptura_pond,
            'perda': perda, 'troca': troca, 'foto': foto,
        }

    agg_andre = agrega(lambda c: c['gerente'] == 'André')
    agg_walas = agrega(lambda c: c['gerente'] == 'Walas')
    agg_total = agrega(lambda c: True)
    # Total: usa o META TOTAL diretamente (mais preciso que soma)
    agg_total['meta_venda']  = metas['meta_venda_total']  or agg_total['meta_venda']
    agg_total['meta_margem'] = metas['meta_margem_total'] or agg_total['meta_margem']

    # Metas fixas por gerente (definidas pelo João)
    agg_andre['meta_dde']     = 10
    agg_walas['meta_dde']     = 35
    agg_total['meta_dde']     = 32
    agg_andre['meta_ruptura'] = 0.135
    agg_walas['meta_ruptura'] = 0.1443
    agg_total['meta_ruptura'] = 0.12

    # Ruptura total = mesmo valor da página /ruptura (kpis.total_geral.pct)
    # — assim os totais batem perfeitamente entre as duas páginas.
    if ruptura_total_geral is not None:
        agg_total['ruptura'] = ruptura_total_geral

    # ===== Ranks (entre os compradores não-zerados) =====
    # 1 = melhor (atingimento mais alto)
    def atingimento(c, key_real, key_meta, inverso=False):
        real = c.get(key_real)
        meta = c.get(key_meta)
        if real is None or not meta:
            return None
        if inverso:
            return meta / max(real, 0.0001)
        return real / meta

    def aplicar_rank(campo_rank, key_real, key_meta, inverso=False):
        with_at = []
        for c in compradores:
            at = atingimento(c, key_real, key_meta, inverso)
            if at is not None:
                with_at.append((c, at))
        # 1 = pior atingimento (do menor pro maior)
        with_at.sort(key=lambda x: x[1])
        for i, (c, _) in enumerate(with_at, start=1):
            c[campo_rank] = i

    # Bloco 1: rank venda e margem (real/meta — quanto MAIOR melhor)
    aplicar_rank('rank_venda',   'venda',   'meta_venda',   inverso=False)
    aplicar_rank('rank_margem',  'margem',  'meta_margem',  inverso=False)
    # Bloco 2: rank DDE, ruptura, quebra, troca (meta/real — quanto MAIOR melhor)
    aplicar_rank('rank_dde',     'dde',     'meta_dde',     inverso=True)
    aplicar_rank('rank_ruptura', 'ruptura', 'meta_ruptura', inverso=True)
    aplicar_rank('rank_quebra',  'perda',   'meta_quebra',  inverso=True)
    aplicar_rank('rank_troca',   'troca',   'meta_troca',   inverso=True)

    # ===== Ating Total (formula da planilha — soma ponderada com cap) =====
    # Pesos: venda=50%, DDE=10%, ruptura=15%, quebra=5%, troca=10%, foto=10% (total=100%)
    # Margem NÃO entra no ating total (só na premiação)
    PESOS = [
        ('venda',   'meta_venda',   False, 0.50),
        ('dde',     'meta_dde',     True,  0.10),
        ('ruptura', 'meta_ruptura', True,  0.15),
        ('perda',   'meta_quebra',  True,  0.05),
        ('troca',   'meta_troca',   True,  0.10),
        ('foto',    'meta_foto',    False, 0.10),
    ]

    def calcula_ating_total(obj):
        total = 0
        for key_real, key_meta, inv, peso in PESOS:
            at = atingimento(obj, key_real, key_meta, inv)
            if at is None: at = 0
            total += min(at * peso, peso)
        return total

    for c in compradores:
        c['ating_total'] = calcula_ating_total(c)
        # Premiação: só pra compradores individuais
        ating_marg = atingimento(c, 'margem', 'meta_margem', False)
        if ating_marg is not None and ating_marg >= 1:
            extra = 2000 if c['ating_total'] >= 1 else (1000 if c['ating_total'] >= 0.95 else 0)
            c['premiacao'] = 2000 + extra
        else:
            c['premiacao'] = 0

    # Aplica também aos gerentes e ao total (com metas globais setadas acima)
    for obj in [agg_andre, agg_walas, agg_total]:
        obj['ating_total'] = calcula_ating_total(obj)

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'periodo': {'inicio': dt_ini.isoformat(), 'fim': dt_fim.isoformat()},
        'compradores': compradores,
        'gerentes': {
            'Andre': agg_andre,
            'Walas': agg_walas,
        },
        'total': agg_total,
        'vendas_diarias': vendas_diarias,
        'metas_diarias':  metas.get('metas_diarias', {}),
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    print()
    print(f'✓ salvo em {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)')
    print(f'Compradores: {len(compradores)}')
    print(f'Total venda:  R$ {agg_total["venda"]:>14,.2f}  (meta: R$ {(agg_total["meta_venda"] or 0):>13,.2f})')
    print(f'Total margem: R$ {agg_total["margem"]:>14,.2f}  (meta: R$ {(agg_total["meta_margem"] or 0):>13,.2f})')


if __name__ == '__main__':
    main()
