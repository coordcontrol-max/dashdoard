#!/usr/bin/env python3
"""Gera data/vendas.json direto do Oracle Consinco (sem Excel).

Pipeline:
  1. Roda 7 queries no Oracle:
     - SQL_BASE: aba B_VDA25 / VENDA25 (todas as vendas, por dia × comprador)
       Agrega por SEQCOMPRADOR pra obter Açougue Geral (6), Liquida (7), FLV (9).
     - SQL_PROMO: aba Promo (só sem promoção)
     - SQL_COMPRAS: aba B_Ent (entradas de compra)
     - SQL_ACORDO: aba ACRPRE (acordos recebidos)
     - SQL_PERDA: aba PERDA25 (quebras / perdas)
     - SQL_INVENT: aba INVENT25 (inventário) — TODO valor diverge da planilha; investigar
     - SQL_SETOR_ACOUGUE: 6 sub-açougues (Bovino, Aves, Linguiças, Natalinos, Peixaria, Suíno)
  2. Lê data/vendas_aux.json (apenas metas — preenchidas manualmente)
  3. Replica as fórmulas da aba FATURAMENTO da planilha
  4. Gera data/vendas.json no formato que o site já consome

Acumulados (META VENDA AC, META MARGEM AC, etc.) são calculados dinamicamente:
  somam só dias FECHADOS (anteriores a hoje), igual `SUMIFS(...,"<"&TODAY())` do Excel.
"""
import csv
import json
import os
import sys
import time
from datetime import datetime, date, timedelta
from pathlib import Path

# Re-exec com LD_LIBRARY_PATH se ainda não estiver setado
ORACLE_LIB_DEFAULT = '/home/joaoreis/oracle/instantclient_23_7'
_lib = os.environ.get('ORACLE_LIB', ORACLE_LIB_DEFAULT)
_curr = os.environ.get('LD_LIBRARY_PATH', '')
if _lib not in _curr.split(':'):
    os.environ['LD_LIBRARY_PATH'] = f'{_lib}:{_curr}' if _curr else _lib
    os.execv(sys.executable, [sys.executable] + sys.argv)

import oracledb

# ===== Config =====
ORACLE_USER = os.environ.get('ORACLE_USER', 'consinco')
ORACLE_PASSWORD = os.environ.get('ORACLE_PASSWORD', '')
ORACLE_DSN = os.environ.get('ORACLE_DSN', '10.61.1.1:1521/orcl')

AUX_PATH = Path('./data/vendas_aux.json')
OUT_PATH = Path('./data/vendas.json')

DIAS_SEMANA = {
    0: 'Segunda-Feira', 1: 'Terça-Feira', 2: 'Quarta-Feira',
    3: 'Quinta-Feira', 4: 'Sexta-Feira', 5: 'Sábado', 6: 'Domingo',
}

# ===== Query base (B_VDA25) — agregada por (dia, comprador) — usada também p/ Liquida (SEQCOMPRADOR=7) =====
SQL_BASE = """
select v.dtavda, d.seqcomprador,
  sum( ( round( V.VLRITEM, 2 ) ) - ( round( V.VLRDEVOLITEM, 2 ) - ( 0 ) ) ) as vlr_venda,
  round(sum(
    fC5_AbcDistribLucratividade(
      'L', 'L', 'N', V.VLRITEM , 'N',
      V.VLRICMSST, V.VLRFCPST, V.VLRICMSSTEMPORIG, E.UF, V.UFPESSOA,
      'N', 0, 'N', V.VLRIPIITEM, V.VLRIPIDEVOLITEM,
      'N', V.VLRDESCFORANF, Y.CMDIAVLRNF - 0 , Y.CMDIAIPI,
      nvl( Y.CMDIACREDPIS, 0 ), nvl( Y.CMDIACREDCOFINS, 0 ),
      Y.CMDIAICMSST, Y.CMDIADESPNF, Y.CMDIADESPFORANF, Y.CMDIADCTOFORANF,
      'S', a.propqtdprodutobase, V.QTDITEM,
      V.VLREMBDESCRESSARCST, V.ACMCOMPRAVENDA, V.PISITEM, V.COFINSITEM,
      decode( V.TIPCGO, 'S', Y.QTDVDA, nvl( Y.QTDDEVOL, Y.QTDVDA ) ),
      ( decode( V.TIPCGO, 'S', Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ),
        nvl( Y.VLRIMPOSTODEVOL - nvl( V.VLRIPIDEVOLITEM, 0 ),
        Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ) ) ) ) ,
      'N', V.VLRDESPOPERACIONALITEM, Y.VLRDESPESAVDA, 'N',
      nvl( Y.VLRVERBAVDAACR, 0 ),
      Y.QTDVERBAVDA, Y.VLRVERBAVDA - nvl( Y.VLRVERBAVDAINDEVIDA, 0 ),
      'N', NVL(V.VLRTOTCOMISSAOITEM, 0),
      V.VLRDEVOLITEM, VLRDEVOLICMSST, V.DVLRFCPST, V.QTDDEVOLITEM,
      V.PISDEVOLITEM, V.COFINSDEVOLITEM,
      V.VLRDESPOPERACIONALITEMDEVOL, V.VLRTOTCOMISSAOITEMDEVOL,
      E.PERIRLUCRAT, E.PERCSLLLUCRAT, Y.CMDIACREDICMS,
      decode( V.ICMSEFETIVOITEM, 0, V.ICMSITEM, V.ICMSEFETIVOITEM ),
      V.VLRFCPICMS, V.PERCPMF, V.PEROUTROIMPOSTO,
      decode( V.ICMSEFETIVODEVOLITEM, 0, V.ICMSDEVOLITEM, V.ICMSEFETIVODEVOLITEM ),
      V.DVLRFCPICMS,
      case when ( 'S' ) = 'N' then
        (nvl(y.cmdiavlrdescpistransf,0) + nvl(y.cmdiavlrdesccofinstransf,0) + nvl(y.cmdiavlrdescicmstransf,0) +
         nvl(y.cmdiavlrdescipitransf,0) + nvl(y.cmdiavlrdesclucrotransf,0) + nvl(y.cmdiavlrdescverbatransf,0) )
        else 0
      end,
      case when DV.UTILACRESCCUSTPRODRELAC = 'S' and nvl( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) is not null then
        coalesce( PR.PERCACRESCCUSTORELACVIG, nvl( F_RETACRESCCUSTORELACABC( V.SEQPRODUTO, V.DTAVDA ), 1 ) )
        else 1
      end,
      'N', 0, 0, 'S', V.VLRDESCMEDALHA, 'S',
      V.VLRDESCFORNEC, V.VLRDESCFORNECDEVOL,
      'N', V.VLRFRETEITEMRATEIO, V.VLRFRETEITEMRATEIODEV,
      'S', V.VLRICMSSTEMBUTPROD, V.VLRICMSSTEMBUTPRODDEV, V.VLREMBDESCRESSARCSTDEVOL,
      case when 'N' = 'S' then nvl( V.VLRDESCACORDOVERBAPDV, 0 ) else 0 end,
      nvl( Y.CMDIACREDIPI, 0 ), NVL(V.VLRITEMRATEIOCTE,0),
      'N', 'C', V.VLRIPIPRECOVDA, V.VLRIPIPRECODEVOL, V.VLRDESCMEDALHADEVOL
    )), 2
  ) as lucro,
  sum(
    ( decode( Y.QTDVERBAVDA, 0, 0,
      ( Y.VLRVERBAVDA - nvl( Y.VLRverbaVDAindevida, 0 ) )
      * nvl( a.propqtdprodutobase, 1 )
      / Y.QTDVDA )
    ) * ( V.QTDITEM - 0 )
  ) as verba,
  count( distinct V.ROWIDDOCTO ) as doctos
from MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V, MAP_PRODUTO A, MAP_PRODUTO PB, MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K, MAX_EMPRESA E, MAX_DIVISAO DV, MAP_PRODACRESCCUSTORELAC PR
where D.SEQFAMILIA = A.SEQFAMILIA
  and D.NRODIVISAO = V.NRODIVISAO
  and V.SEQPRODUTO = A.SEQPRODUTO
  and V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
  and V.NRODIVISAO = D.NRODIVISAO
  and E.NROEMPRESA = V.NROEMPRESA
  and E.NRODIVISAO = DV.NRODIVISAO
  AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
  and V.DTAVDA between :dt_ini and :dt_fim
  and Y.NROEMPRESA = nvl( E.NROEMPCUSTOABC, E.NROEMPRESA )
  and Y.DTAENTRADASAIDA = V.DTAVDA
  and v.nroempresa not in (1,2,3,4,6,8,9,12,15,17,19,22,25)
  and K.SEQFAMILIA = A.SEQFAMILIA
  and K.QTDEMBALAGEM = 1
  and Y.SEQPRODUTO = PB.SEQPRODUTO
  and DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) in ( 'S', 'I' )
  and D.SEQCOMPRADOR != 14
group by v.dtavda, d.seqcomprador
order by v.dtavda, d.seqcomprador
"""

# ===== Query Promo — só vendas SEM promoção (V.SEQPROMOCAO is null) =====
SQL_PROMO = """
select v.dtavda,
  sum( ( round( V.VLRITEM, 2 ) ) - ( round( V.VLRDEVOLITEM, 2 ) - ( 0 ) ) ) as venda_sem_promo,
  round(sum(
    fC5_AbcDistribLucratividade(
      'L', 'L', 'N', V.VLRITEM , 'N',
      V.VLRICMSST, V.VLRFCPST, V.VLRICMSSTEMPORIG, E.UF, V.UFPESSOA,
      'N', 0, 'N', V.VLRIPIITEM, V.VLRIPIDEVOLITEM,
      'N', V.VLRDESCFORANF, Y.CMDIAVLRNF - 0 , Y.CMDIAIPI,
      nvl( Y.CMDIACREDPIS, 0 ), nvl( Y.CMDIACREDCOFINS, 0 ),
      Y.CMDIAICMSST, Y.CMDIADESPNF, Y.CMDIADESPFORANF, Y.CMDIADCTOFORANF,
      'S', a.propqtdprodutobase, V.QTDITEM,
      V.VLREMBDESCRESSARCST, V.ACMCOMPRAVENDA, V.PISITEM, V.COFINSITEM,
      decode( V.TIPCGO, 'S', Y.QTDVDA, nvl( Y.QTDDEVOL, Y.QTDVDA ) ),
      ( decode( V.TIPCGO, 'S', Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ),
        nvl( Y.VLRIMPOSTODEVOL - nvl( V.VLRIPIDEVOLITEM, 0 ),
        Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ) ) ) ) ,
      'N', V.VLRDESPOPERACIONALITEM, Y.VLRDESPESAVDA, 'N',
      nvl( Y.VLRVERBAVDAACR, 0 ),
      Y.QTDVERBAVDA, Y.VLRVERBAVDA - nvl( Y.VLRVERBAVDAINDEVIDA, 0 ),
      'N', NVL(V.VLRTOTCOMISSAOITEM, 0),
      V.VLRDEVOLITEM, VLRDEVOLICMSST, V.DVLRFCPST, V.QTDDEVOLITEM,
      V.PISDEVOLITEM, V.COFINSDEVOLITEM,
      V.VLRDESPOPERACIONALITEMDEVOL, V.VLRTOTCOMISSAOITEMDEVOL,
      E.PERIRLUCRAT, E.PERCSLLLUCRAT, Y.CMDIACREDICMS,
      decode( V.ICMSEFETIVOITEM, 0, V.ICMSITEM, V.ICMSEFETIVOITEM ),
      V.VLRFCPICMS, V.PERCPMF, V.PEROUTROIMPOSTO,
      decode( V.ICMSEFETIVODEVOLITEM, 0, V.ICMSDEVOLITEM, V.ICMSEFETIVODEVOLITEM ),
      V.DVLRFCPICMS,
      case when ( 'S' ) = 'N' then
        (nvl(y.cmdiavlrdescpistransf,0) + nvl(y.cmdiavlrdesccofinstransf,0) + nvl(y.cmdiavlrdescicmstransf,0) +
         nvl(y.cmdiavlrdescipitransf,0) + nvl(y.cmdiavlrdesclucrotransf,0) + nvl(y.cmdiavlrdescverbatransf,0) )
        else 0
      end,
      case when DV.UTILACRESCCUSTPRODRELAC = 'S' and nvl( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) is not null then
        coalesce( PR.PERCACRESCCUSTORELACVIG, nvl( F_RETACRESCCUSTORELACABC( V.SEQPRODUTO, V.DTAVDA ), 1 ) )
        else 1
      end,
      'N', 0, 0, 'S', V.VLRDESCMEDALHA, 'S',
      V.VLRDESCFORNEC, V.VLRDESCFORNECDEVOL,
      'N', V.VLRFRETEITEMRATEIO, V.VLRFRETEITEMRATEIODEV,
      'S', V.VLRICMSSTEMBUTPROD, V.VLRICMSSTEMBUTPRODDEV, V.VLREMBDESCRESSARCSTDEVOL,
      case when 'N' = 'S' then nvl( V.VLRDESCACORDOVERBAPDV, 0 ) else 0 end,
      nvl( Y.CMDIACREDIPI, 0 ), NVL(V.VLRITEMRATEIOCTE,0),
      'N', 'C', V.VLRIPIPRECOVDA, V.VLRIPIPRECODEVOL, V.VLRDESCMEDALHADEVOL
    )), 2
  ) as margem_sem_promo
from MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V, MAP_PRODUTO A, MAP_PRODUTO PB, MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K, MAX_EMPRESA E, MAX_DIVISAO DV, MAP_PRODACRESCCUSTORELAC PR
where D.SEQFAMILIA = A.SEQFAMILIA
  and D.NRODIVISAO = V.NRODIVISAO
  and V.SEQPRODUTO = A.SEQPRODUTO
  and V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
  and V.NRODIVISAO = D.NRODIVISAO
  and E.NROEMPRESA = V.NROEMPRESA
  and E.NRODIVISAO = DV.NRODIVISAO
  AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
  and V.DTAVDA between :dt_ini and :dt_fim
  and Y.NROEMPRESA = nvl( E.NROEMPCUSTOABC, E.NROEMPRESA )
  and Y.DTAENTRADASAIDA = V.DTAVDA
  and K.SEQFAMILIA = A.SEQFAMILIA and K.QTDEMBALAGEM = 1
  and Y.SEQPRODUTO = PB.SEQPRODUTO
  and DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) in ( 'S', 'I' )
  and D.SEQCOMPRADOR != 14
  and V.SEQPROMOCAO is null
  and V.NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)
group by v.dtavda
order by v.dtavda
"""

# ===== Query Compras (B_Ent) — entradas no estoque =====
SQL_COMPRAS = """
SELECT
  TRUNC(E2.DTAENTRADA) AS DTA,
  SUM(E2.VLRITEM + E2.VLRIPI + E2.VLRICMSDI
      + E2.VLRDESPTRIBUTITEM + E2.VLRDESPNTRIBUTITEM + E2.VLRDESPFORANF
      + E2.VLRICMSST + E2.VLRFCPST - E2.VLRDESCITEM)
  -
  SUM(E2.DVLRITEM + E2.DVLRIPI + E2.DVLRICMSDI
      + E2.DVLRDESPTRIBUTITEM + E2.DVLRDESPNTRIBUTITEM + E2.DVLRDESPFORANF
      + E2.DVLRICMSST + E2.DVLRFCPST - E2.DVLRDESCITEM)
  AS VLRENTRADA
FROM MAXV_ABCENTRADABASE  E2
JOIN MAP_PRODUTO           A  ON A.SEQPRODUTO   = E2.SEQPRODUTO
JOIN MAP_FAMDIVISAO        D  ON D.SEQFAMILIA   = A.SEQFAMILIA
                              AND D.NRODIVISAO   = E2.NRODIVISAO
JOIN MAD_FAMSEGMENTO       H  ON H.SEQFAMILIA   = D.SEQFAMILIA
                              AND H.NROSEGMENTO  = E2.NROSEGMENTOPRINC
JOIN MAP_FAMEMBALAGEM      K  ON K.SEQFAMILIA   = A.SEQFAMILIA
                              AND K.QTDEMBALAGEM = D.PADRAOEMBCOMPRA
JOIN MAX_COMPRADOR         O  ON O.SEQCOMPRADOR = D.SEQCOMPRADOR
JOIN MAX_DIVISAO           DV ON DV.NRODIVISAO  = E2.NRODIVISAO
JOIN MRL_PRODUTOEMPRESA    C  ON C.SEQPRODUTO   = E2.SEQPRODUTO
                              AND C.NROEMPRESA   = E2.NROEMPRESA
WHERE D.NRODIVISAO IN (1, 2, 3, 4)
  AND O.SEQCOMPRADOR NOT IN (14, 15)
  AND E2.NROEMPRESA IN (
      1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,26,27,28,29,
      101,102,103,104,106,108,109,117,112,115,119,122,125,130,131,
      215,219,222,
      900,901,997,998,999
  )
  AND E2.DTAENTRADA BETWEEN :dt_ini AND :dt_fim
  AND E2.CODGERALOPER IN (1, 100, 101, 802)
GROUP BY TRUNC(E2.DTAENTRADA)
ORDER BY TRUNC(E2.DTAENTRADA)
"""

# ===== Query PERDA25 — quebras (Perda Geral 2025) =====
SQL_PERDA = """
SELECT TRUNC(VW.DTAENTRADASAIDA) AS DTA, SUM(VW.VALORLANCTOBRT) AS VLR
FROM MAP_FAMDIVISAO D, MAX_EMPRESA E, MAX_DIVISAO I2, MAP_CLASSIFABC Z2,
     MAXV_ABCPERDABASE VW, MAP_TRIBUTACAOUF T3, MAP_FAMILIA B,
     MAD_FAMSEGMENTO H, MAP_FAMEMBALAGEM K, MRL_PRODUTOEMPRESA C,
     MRL_PRODEMPSEG C3, MAD_SEGMENTO SE, MAP_PRODUTO PR, MAX_COMPRADOR O
WHERE E.NROEMPRESA = VW.NROEMPRESA
  AND E.NRODIVISAO = D.NRODIVISAO
  AND O.SEQCOMPRADOR = D.SEQCOMPRADOR
  AND H.SEQFAMILIA = VW.SEQFAMILIA
  AND H.NROSEGMENTO = E.NROSEGMENTOPRINC
  AND H.NROSEGMENTO = SE.NROSEGMENTO
  AND D.SEQFAMILIA = VW.SEQFAMILIA
  AND B.SEQFAMILIA = VW.SEQFAMILIA
  AND I2.NRODIVISAO = D.NRODIVISAO
  AND Z2.NROSEGMENTO = H.NROSEGMENTO
  AND Z2.CLASSIFCOMERCABC = H.CLASSIFCOMERCABC
  AND K.SEQFAMILIA = H.SEQFAMILIA
  AND K.QTDEMBALAGEM = (CASE WHEN instr('1', ',') > 0 THEN fPadraoEmbVenda2(D.SEQFAMILIA, '1') ELSE H.PADRAOEMBVENDA END)
  AND C.SEQPRODUTO = VW.SEQPRODUTO
  AND C.NROEMPRESA = nvl(E.NROEMPCUSTOABC, E.NROEMPRESA)
  AND C3.NROEMPRESA = VW.NROEMPRESA
  AND C3.SEQPRODUTO = VW.SEQPRODUTO
  AND C3.NROSEGMENTO = E.NROSEGMENTOPRINC
  AND C3.QTDEMBALAGEM = H.PADRAOEMBVENDA
  AND T3.NROTRIBUTACAO = D.NROTRIBUTACAO
  AND T3.UFEMPRESA = E.UF
  AND T3.UFCLIENTEFORNEC = E.UF
  AND T3.TIPTRIBUTACAO = decode(I2.TIPDIVISAO, 'V', 'SN', 'SC')
  AND T3.NROREGTRIBUTACAO = nvl(E.NROREGTRIBUTACAO, 0)
  AND PR.SEQPRODUTO = VW.SEQPRODUTO
  AND VW.DTAENTRADASAIDA BETWEEN :dt_ini AND :dt_fim
  AND VW.TIPCLASSINTERNO IN ('P', 'R', 'C', 'A')
  AND VW.CODGERALOPER = 549
  AND VW.TIPLANCTO IN ('S')
  AND E.NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)
  AND D.SEQFAMILIA NOT IN (SELECT SEQFAMILIA FROM MAP_FAMDIVISAO WHERE SEQCOMPRADOR = 14)
GROUP BY TRUNC(VW.DTAENTRADASAIDA)
ORDER BY TRUNC(VW.DTAENTRADASAIDA)
"""

# ===== Query INVENT25 — inventário (Inv 2025) =====
SQL_INVENT = """
SELECT TRUNC(L3.DTAENTRADASAIDA) AS DTA,
       SUM(L3.VLRENTRADACOMPRA) + SUM(L3.VLRENTRADAOUTRAS)
       - SUM(L3.VLRSAIDAVENDA) - SUM(L3.VLRSAIDAOUTRAS) AS VLR
FROM MAXV_ABCMOVTOBASE_PROD L3, MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K,
     MAX_EMPRESA E, MRL_PRODUTOEMPRESA C, MAX_COMPRADOR O
WHERE D.SEQFAMILIA = L3.SEQFAMILIA
  AND K.SEQFAMILIA = D.SEQFAMILIA
  AND K.QTDEMBALAGEM = 1
  AND L3.DTAENTRADASAIDA BETWEEN :dt_ini AND :dt_fim
  AND L3.NRODIVISAO = D.NRODIVISAO
  AND D.SEQCOMPRADOR = O.SEQCOMPRADOR
  AND E.NROEMPRESA = L3.NROEMPRESA
  AND C.SEQPRODUTO = L3.SEQPRODUTO
  AND C.NROEMPRESA = E.NROEMPRESA
  AND L3.CODGERALOPER IN (401, 501)
GROUP BY TRUNC(L3.DTAENTRADASAIDA)
ORDER BY TRUNC(L3.DTAENTRADASAIDA)
"""

# ===== Query SETOR AÇOUGUE — sub-categorias do açougue (nível 3, SEQCATEGORIA=2121) =====
SQL_SETOR_ACOUGUE = """
select G.CAMINHOCOMPLETO as CAMINHO, V.DTAVDA as DTA,
       sum( ( round( V.VLRITEM, 2 ) ) - ( round( V.VLRDEVOLITEM, 2 ) - ( 0 ) ) ) as VLRVENDA,
       round(sum(
         fC5_AbcDistribLucratividade(
           'L', 'L', 'N', V.VLRITEM, 'N',
           V.VLRICMSST, V.VLRFCPST, V.VLRICMSSTEMPORIG, E.UF, V.UFPESSOA,
           'N', 0, 'N', V.VLRIPIITEM, V.VLRIPIDEVOLITEM,
           'N', V.VLRDESCFORANF, Y.CMDIAVLRNF - 0 , Y.CMDIAIPI,
           nvl( Y.CMDIACREDPIS, 0 ), nvl( Y.CMDIACREDCOFINS, 0 ),
           Y.CMDIAICMSST, Y.CMDIADESPNF, Y.CMDIADESPFORANF, Y.CMDIADCTOFORANF,
           'S', a.propqtdprodutobase, V.QTDITEM,
           V.VLREMBDESCRESSARCST, V.ACMCOMPRAVENDA, V.PISITEM, V.COFINSITEM,
           decode( V.TIPCGO, 'S', Y.QTDVDA, nvl( Y.QTDDEVOL, Y.QTDVDA ) ),
           ( decode( V.TIPCGO, 'S', Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ),
             nvl( Y.VLRIMPOSTODEVOL - nvl( V.VLRIPIDEVOLITEM, 0 ),
             Y.VLRIMPOSTOVDA - nvl( Y.VLRIPIVDA, 0 ) ) ) ) ,
           'N', V.VLRDESPOPERACIONALITEM, Y.VLRDESPESAVDA, 'N',
           nvl( Y.VLRVERBAVDAACR, 0 ),
           DECODE( V.TIPDOCFISCALCGO, 'T', 0, Y.QTDVERBAVDA ),
           Y.VLRVERBAVDA - nvl( Y.VLRVERBAVDAINDEVIDA, 0 ),
           'N', NVL(V.VLRTOTCOMISSAOITEM, 0),
           V.VLRDEVOLITEM, VLRDEVOLICMSST, V.DVLRFCPST, V.QTDDEVOLITEM,
           V.PISDEVOLITEM, V.COFINSDEVOLITEM,
           V.VLRDESPOPERACIONALITEMDEVOL, V.VLRTOTCOMISSAOITEMDEVOL,
           E.PERIRLUCRAT, E.PERCSLLLUCRAT, Y.CMDIACREDICMS,
           decode( V.ICMSEFETIVOITEM, 0, V.ICMSITEM, V.ICMSEFETIVOITEM ) + 0 ,
           V.VLRFCPICMS, V.PERCPMF, V.PEROUTROIMPOSTO,
           decode( V.ICMSEFETIVODEVOLITEM, 0, V.ICMSDEVOLITEM, V.ICMSEFETIVODEVOLITEM ) + 0 ,
           V.DVLRFCPICMS,
           case when ( 'S' ) = 'N' then
             (nvl(y.cmdiavlrdescpistransf,0) + nvl(y.cmdiavlrdesccofinstransf,0) + nvl(y.cmdiavlrdescicmstransf,0) +
              nvl(y.cmdiavlrdescipitransf,0) + nvl(y.cmdiavlrdesclucrotransf,0) + nvl(y.cmdiavlrdescverbatransf,0) )
             else 0 end,
           case when DV.UTILACRESCCUSTPRODRELAC = 'S' and nvl( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) is not null then
             coalesce( PR.PERCACRESCCUSTORELACVIG, nvl( F_RETACRESCCUSTORELACABC( V.SEQPRODUTO, V.DTAVDA ), 1 ) )
             else 1 end,
           'N', 0, 0, 'S', V.VLRDESCMEDALHA, 'S',
           V.VLRDESCFORNEC, V.VLRDESCFORNECDEVOL,
           'N', V.VLRFRETEITEMRATEIO, V.VLRFRETEITEMRATEIODEV,
           'S', V.VLRICMSSTEMBUTPROD, V.VLRICMSSTEMBUTPRODDEV, V.VLREMBDESCRESSARCSTDEVOL,
           case when 'N' = 'S' then nvl( V.VLRDESCACORDOVERBAPDV, 0 ) else 0 end,
           nvl( Y.CMDIACREDIPI, 0 ), NVL(V.VLRITEMRATEIOCTE,0),
           'N', 'C', V.VLRIPIPRECOVDA, V.VLRIPIPRECODEVOL,
           V.VLRDESCMEDALHADEVOL, 'N'
         )), 2
       ) as VLRLUCRO
from MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V, MAP_PRODUTO A, MAP_PRODUTO PB,
     MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K, MAX_EMPRESA E, MAX_DIVISAO DV,
     MAP_PRODACRESCCUSTORELAC PR, MAXV_CATEGORIA G, MAP_FAMDIVCATEG U, MAP_FAMDIVCATEG W
where D.SEQFAMILIA = A.SEQFAMILIA
  and D.NRODIVISAO = V.NRODIVISAO
  and V.SEQPRODUTO = A.SEQPRODUTO
  and V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
  and V.NRODIVISAO = D.NRODIVISAO
  and E.NROEMPRESA = V.NROEMPRESA
  and E.NRODIVISAO = DV.NRODIVISAO
  AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
  and V.DTAVDA between :dt_ini and :dt_fim
  and Y.NROEMPRESA = nvl( E.NROEMPCUSTOABC, E.NROEMPRESA )
  and Y.DTAENTRADASAIDA = V.DTAVDA
  and K.SEQFAMILIA = A.SEQFAMILIA and K.QTDEMBALAGEM = 1
  and Y.SEQPRODUTO = PB.SEQPRODUTO
  and G.NRODIVISAO = U.NRODIVISAO
  and G.NIVELHIERARQUIA = 3
  and G.TIPCATEGORIA = 'M'
  and G.STATUSCATEGOR != 'I'
  and U.SEQFAMILIA = D.SEQFAMILIA
  and U.NRODIVISAO = D.NRODIVISAO
  and U.SEQCATEGORIA = G.SEQCATEGORIA
  and U.STATUS = 'A'
  and W.SEQFAMILIA = D.SEQFAMILIA
  and W.NRODIVISAO = D.NRODIVISAO
  and W.STATUS = 'A'
  and W.SEQCATEGORIA = 2121
  and DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) in ( 'S', 'I' )
  AND V.NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)
group by G.CAMINHOCOMPLETO, V.DTAVDA
order by V.DTAVDA, G.CAMINHOCOMPLETO
"""

# ===== Query SETORES NIVEL 2 — Açougue Geral, FLV, Padaria, Rotisseria =====
SQL_SETORES_N2 = """
select gs.CAMINHOCOMPLETO as CAMINHO, v.dtavda as DTA,
       sum( ( round( V.VLRITEM, 2 ) ) - ( round( V.VLRDEVOLITEM, 2 ) - ( 0 ) ) ) as VLRVENDA,
       round(sum(
         FC5_ABCDISTRIBLUCRATIVIDADE('L','L','N',V.VLRITEM,'N',
           V.VLRICMSST,V.VLRFCPST,V.VLRICMSSTEMPORIG,E.UF,V.UFPESSOA,
           'N',0,'N',V.VLRIPIITEM,V.VLRIPIDEVOLITEM,
           'N',V.VLRDESCFORANF,Y.CMDIAVLRNF-0,Y.CMDIAIPI,
           NVL(Y.CMDIACREDPIS,0),NVL(Y.CMDIACREDCOFINS,0),
           Y.CMDIAICMSST,Y.CMDIADESPNF,Y.CMDIADESPFORANF,Y.CMDIADCTOFORANF,
           'S',A.PROPQTDPRODUTOBASE,V.QTDITEM,
           V.VLREMBDESCRESSARCST,V.ACMCOMPRAVENDA,V.PISITEM,V.COFINSITEM,
           DECODE(V.TIPCGO,'S',Y.QTDVDA,NVL(Y.QTDDEVOL,Y.QTDVDA)),
           DECODE(V.TIPCGO,'S',Y.VLRIMPOSTOVDA-NVL(Y.VLRIPIVDA,0),
             NVL(Y.VLRIMPOSTODEVOL-NVL(V.VLRIPIDEVOLITEM,0),
                 Y.VLRIMPOSTOVDA-NVL(Y.VLRIPIVDA,0))),
           'N',V.VLRDESPOPERACIONALITEM,Y.VLRDESPESAVDA,'N',
           NVL(Y.VLRVERBAVDAACR,0),
           Y.QTDVERBAVDA,Y.VLRVERBAVDA-NVL(Y.VLRVERBAVDAINDEVIDA,0),
           'N',NVL(V.VLRTOTCOMISSAOITEM,0),
           V.VLRDEVOLITEM,VLRDEVOLICMSST,V.DVLRFCPST,V.QTDDEVOLITEM,
           V.PISDEVOLITEM,V.COFINSDEVOLITEM,
           V.VLRDESPOPERACIONALITEMDEVOL,V.VLRTOTCOMISSAOITEMDEVOL,
           E.PERIRLUCRAT,E.PERCSLLLUCRAT,Y.CMDIACREDICMS,
           DECODE(V.ICMSEFETIVOITEM,0,V.ICMSITEM,V.ICMSEFETIVOITEM),
           V.VLRFCPICMS,V.PERCPMF,V.PEROUTROIMPOSTO,
           DECODE(V.ICMSEFETIVODEVOLITEM,0,V.ICMSDEVOLITEM,V.ICMSEFETIVODEVOLITEM),
           V.DVLRFCPICMS,
           CASE WHEN ('S')='N' THEN
             (NVL(Y.CMDIAVLRDESCPISTRANSF,0)+NVL(Y.CMDIAVLRDESCCOFINSTRANSF,0)+NVL(Y.CMDIAVLRDESCICMSTRANSF,0)+
              NVL(Y.CMDIAVLRDESCIPITRANSF,0)+NVL(Y.CMDIAVLRDESCLUCROTRANSF,0)+NVL(Y.CMDIAVLRDESCVERBATRANSF,0))
             ELSE 0 END,
           CASE WHEN DV.UTILACRESCCUSTPRODRELAC='S' AND NVL(A.SEQPRODUTOBASE,A.SEQPRODUTOBASEANTIGO) IS NOT NULL THEN
             COALESCE(PR.PERCACRESCCUSTORELACVIG,NVL(F_RETACRESCCUSTORELACABC(V.SEQPRODUTO,V.DTAVDA),1))
             ELSE 1 END,
           'N',0,0,'S',V.VLRDESCMEDALHA,'S',
           V.VLRDESCFORNEC,V.VLRDESCFORNECDEVOL,
           'N',V.VLRFRETEITEMRATEIO,V.VLRFRETEITEMRATEIODEV,
           'S',V.VLRICMSSTEMBUTPROD,V.VLRICMSSTEMBUTPRODDEV,V.VLREMBDESCRESSARCSTDEVOL,
           CASE WHEN 'N'='S' THEN NVL(V.VLRDESCACORDOVERBAPDV,0) ELSE 0 END,
           NVL(Y.CMDIACREDIPI,0),NVL(V.VLRITEMRATEIOCTE,0),
           'N','C',V.VLRIPIPRECOVDA,V.VLRIPIPRECODEVOL,V.VLRDESCMEDALHADEVOL)
       ),2) as VLRLUCRO
from MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V, MAP_PRODUTO A, MAP_PRODUTO PB,
     MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K, MAX_EMPRESA E, MAX_DIVISAO DV,
     MAP_PRODACRESCCUSTORELAC PR, MAXV_CATEGORIA GS, MAP_FAMDIVCATEG US, MAP_FAMDIVCATEG W
where D.SEQFAMILIA = A.SEQFAMILIA
  and D.NRODIVISAO = V.NRODIVISAO
  and V.SEQPRODUTO = A.SEQPRODUTO
  and V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
  and V.NROEMPRESA in ( select a.seqpessoaemp from max_empresa a )
  and V.NRODIVISAO = D.NRODIVISAO
  and E.NROEMPRESA = V.NROEMPRESA
  and E.NRODIVISAO = DV.NRODIVISAO
  AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
  and V.DTAVDA between :dt_ini and :dt_fim
  and Y.NROEMPRESA = nvl(E.NROEMPCUSTOABC, E.NROEMPRESA)
  and Y.DTAENTRADASAIDA = V.DTAVDA
  and K.SEQFAMILIA = A.SEQFAMILIA and K.QTDEMBALAGEM = 1
  and Y.SEQPRODUTO = PB.SEQPRODUTO
  and GS.NRODIVISAO = US.NRODIVISAO
  and GS.NIVELHIERARQUIA = 2
  and GS.STATUSCATEGOR != 'I'
  and US.SEQFAMILIA = D.SEQFAMILIA
  and US.NRODIVISAO = D.NRODIVISAO
  and US.SEQCATEGORIA = GS.SEQCATEGORIA
  and US.STATUS = 'A'
  and W.SEQFAMILIA = D.SEQFAMILIA
  and W.NRODIVISAO = D.NRODIVISAO
  and W.STATUS = 'A'
  and W.SEQCATEGORIA in (2199, 2200, 2122, 2589, 2552, 2241, 2242, 2243, 2240, 2238, 2607, 2606)
  and DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) in ('S','I')
  and D.SEQCOMPRADOR != 14
  and E.NROEMPRESA not in (1,2,3,4,6,8,9,12,15,17,19,22,25)
  and V.SEQPRODUTO not in (29600,29559,29558,29589,29590,22693,22692,22694,22695,22696,22697,14645,14644,14647,14646,14643,29545,29528,29529,29584,17213,17211,17212,29576,29574,29572,29579,29578,29571,29573,29570,29575,29577)
  and gs.TIPCATEGORIA = 'M'
group by gs.CAMINHOCOMPLETO, v.dtavda
order by v.dtavda, gs.CAMINHOCOMPLETO
"""

# ===== Query ACRPRE — acordos recebidos (com diferentes códigos de operação) =====
SQL_ACORDO = """
SELECT TRUNC(t.DTACONTABILIZA) AS DTA,
       SUM(t.VLROPERACAO) AS VLR
FROM CONSINCO.FI_TITOPERACAO t
JOIN CONSINCO.FI_TITULO ti ON ti.SEQTITULO = t.SEQTITULO
JOIN CONSINCO.GE_PESSOA p ON p.SEQPESSOA = ti.SEQPESSOA
WHERE ti.SITUACAO <> 'C'
  AND t.OPCANCELADA IS NULL
  AND ti.OBRIGDIREITO = 'D'
  AND t.DTACONTABILIZA BETWEEN :dt_ini AND :dt_fim
  AND ti.CODESPECIE IN ('ACRPRE')
  AND t.CODOPERACAO NOT IN (16, 17)
GROUP BY TRUNC(t.DTACONTABILIZA)
ORDER BY TRUNC(t.DTACONTABILIZA)
"""


def safe_div(a, b):
    if a is None or b is None or b == 0: return None
    return a / b


def montar_dia(data_iso, aux, oracle, oracle_promo, oracle_compras, oracle_acordo, oracle_perda, oracle_invent):
    """Replica as fórmulas da aba FATURAMENTO pra UMA linha (dia)."""
    metas = aux['metas_mensais']
    meta_venda_total = metas['meta_venda_total'] or 0
    meta_margem_pct = metas['meta_margem_pct'] or 0
    meta_margem_pdv_pct = metas['meta_margem_pdv_pct'] or 0

    meta_venda_dia = aux['meta_venda_diaria'].get(data_iso, 0)
    realizado = oracle.get(data_iso, {}).get('vlr_venda')
    margem_realizada = oracle.get(data_iso, {}).get('lucro')
    verba = oracle.get(data_iso, {}).get('verba')
    doctos = oracle.get(data_iso, {}).get('doctos')

    fechado = realizado is not None and realizado > 0

    # Distribuição proporcional: meta diária / meta mensal × meta total
    meta_margem_dia = (meta_venda_dia / meta_venda_total * meta_margem_pct * meta_venda_total) if meta_venda_total else None
    meta_margem_pdv_dia = (meta_venda_dia / meta_venda_total * meta_margem_pdv_pct * meta_venda_total) if meta_venda_total else None

    # Promo agora vem do Oracle (query SQL_PROMO)
    promo_dia = oracle_promo.get(data_iso, {})
    venda_sem_promo = promo_dia.get('venda_sem_promo')
    margem_sem_promo = promo_dia.get('margem_sem_promo')

    # Compras, acordo, quebras e inventário vêm todos do Oracle
    compra = oracle_compras.get(data_iso)
    acordo = oracle_acordo.get(data_iso)
    quebras = oracle_perda.get(data_iso)
    inventario = oracle_invent.get(data_iso)

    # AS COLUNAS DO FATURAMENTO (replicando fórmulas exatas):
    # H = E - J  (venda c/promo = realizado - venda s/promo)
    venda_promo = (realizado - venda_sem_promo) if (realizado is not None and venda_sem_promo is not None) else None
    # S = M - P  (margem PDV = lucro - verba)
    margem_pdv = (margem_realizada - verba) if (margem_realizada is not None and verba is not None) else None
    # Z = M - X  (margem c/promo = margem total - margem s/promo)
    margem_com_promo = (margem_realizada - margem_sem_promo) if (margem_realizada is not None and margem_sem_promo is not None) else None

    dt = datetime.strptime(data_iso, '%Y-%m-%d').date()
    return {
        'data': data_iso,
        'dia_semana': DIAS_SEMANA[dt.weekday()],
        'meta_venda':            meta_venda_dia or None,
        'realizado':             realizado,
        'diff_rs':               (realizado - meta_venda_dia) if (realizado is not None and meta_venda_dia) else None,
        'diff_pct':              safe_div(realizado - meta_venda_dia, meta_venda_dia) if (realizado is not None and meta_venda_dia) else None,
        'venda_promo':           venda_promo,
        'pct_promo':             safe_div(venda_promo, realizado),
        'venda_sem_promo':       venda_sem_promo,
        'pct_sem_promo':         safe_div(venda_sem_promo, realizado),
        'meta_margem_geral':     meta_margem_dia,
        'margem_realizada':      margem_realizada,
        'margem_diff_rs':        (margem_realizada - meta_margem_dia) if (margem_realizada is not None and meta_margem_dia) else None,
        'margem_diff_pct':       safe_div(margem_realizada, realizado),
        'verba':                 verba,
        'verba_pct':             safe_div(verba, realizado),
        'meta_margem_pdv':       meta_margem_pdv_dia,
        'margem_pdv':            margem_pdv,
        'margem_pdv_diff_rs':    (margem_pdv - meta_margem_pdv_dia) if (margem_pdv is not None and meta_margem_pdv_dia) else None,
        'margem_pdv_diff_pct':   safe_div(margem_pdv, realizado),
        'acordo_recebido':       acordo,
        'acordo_pct':            safe_div((margem_pdv or 0) + (acordo or 0), realizado),
        'margem_sem_promo':      margem_sem_promo,
        'margem_sem_promo_pct':  safe_div(margem_sem_promo, venda_sem_promo),
        'margem_com_promo':      margem_com_promo,
        'margem_com_promo_pct':  safe_div(margem_com_promo, venda_promo),
        'quebras':               quebras,
        'quebras_pct':           safe_div(quebras, realizado),
        'inventario':            inventario,
        'inventario_pct':        safe_div(inventario, realizado),
        'compra':                compra,
        'compra_851':            None,  # TODO: query separada
        'compra_realizado':      None,  # TODO: query separada
        'fechado':               fechado,
        'doctos':                doctos,
    }


def main():
    args = sys.argv[1:]
    hoje = date.today()

    if not AUX_PATH.exists():
        print(f'ERRO: {AUX_PATH} não encontrada — rode antes: python3 extract_vendas_aux.py', file=sys.stderr)
        sys.exit(1)
    if not ORACLE_PASSWORD:
        print('ERRO: defina ORACLE_PASSWORD no .env', file=sys.stderr); sys.exit(2)

    aux = json.loads(AUX_PATH.read_text(encoding='utf-8'))
    # Override fixo da meta de compra (definida pelo João — sobrescreve o que veio da planilha)
    if 'metas_mensais' in aux:
        aux['metas_mensais']['meta_compra'] = 45_712_500

    if len(args) >= 1:
        dt_ini = datetime.strptime(args[0], '%d/%m/%Y').date()
    else:
        dt_ini = date(hoje.year, hoje.month, 1)
    if len(args) >= 2:
        dt_fim = datetime.strptime(args[1], '%d/%m/%Y').date()
    else:
        dt_fim = hoje - timedelta(days=1)

    print(f'Período: {dt_ini.strftime("%d/%m/%Y")} a {dt_fim.strftime("%d/%m/%Y")}')

    # Roda Oracle (2 queries: base e promo)
    oracledb.init_oracle_client(lib_dir=os.environ.get('ORACLE_LIB', ORACLE_LIB_DEFAULT))
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    print('rodando SQL_BASE (B_VDA25)…')
    t0 = time.time()
    cur.execute(SQL_BASE, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_base = cur.fetchall()
    print(f'  ✓ {len(rows_base)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_PROMO (V.SEQPROMOCAO is null)…')
    t0 = time.time()
    cur.execute(SQL_PROMO, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_promo = cur.fetchall()
    print(f'  ✓ {len(rows_promo)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_COMPRAS (B_Ent)…')
    t0 = time.time()
    cur.execute(SQL_COMPRAS, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_compras = cur.fetchall()
    print(f'  ✓ {len(rows_compras)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_ACORDO (ACRPRE)…')
    t0 = time.time()
    cur.execute(SQL_ACORDO, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_acordo = cur.fetchall()
    print(f'  ✓ {len(rows_acordo)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_PERDA (PERDA25)…')
    t0 = time.time()
    cur.execute(SQL_PERDA, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_perda = cur.fetchall()
    print(f'  ✓ {len(rows_perda)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_INVENT (INVENT25)…')
    t0 = time.time()
    cur.execute(SQL_INVENT, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_invent = cur.fetchall()
    print(f'  ✓ {len(rows_invent)} dias em {time.time()-t0:.1f}s')

    print('rodando SQL_SETOR_ACOUGUE (sub-açougues)…')
    t0 = time.time()
    cur.execute(SQL_SETOR_ACOUGUE, dt_ini=dt_ini, dt_fim=dt_fim)
    rows_setor_acougue = cur.fetchall()
    print(f'  ✓ {len(rows_setor_acougue)} linhas em {time.time()-t0:.1f}s')

    conn.close()

    # rows_base vem por (dtavda, seqcomprador). Soma por dia (oracle) e captura
    # categorias-pai (AÇOUGUE=6, LIQUIDA=7, FLV=9) separadamente — bate com aba VENDA25 da planilha.
    # Mapping da aba CLASS: SEQCOMPRADOR → CATEGORIA
    oracle = {}            # totais por dia
    oracle_acougue = {}    # SEQCOMPRADOR=6 → AÇOUGUE GERAL
    oracle_liquida = {}    # SEQCOMPRADOR=7 → LIQUIDA
    oracle_flv     = {}    # SEQCOMPRADOR=9 → FLV
    for r in rows_base:
        dt_, seqcomp, vlr_venda, lucro, verba, doctos = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        if d_iso not in oracle:
            oracle[d_iso] = {'vlr_venda': 0.0, 'lucro': 0.0, 'verba': 0.0, 'doctos': 0}
        oracle[d_iso]['vlr_venda'] += float(vlr_venda) if vlr_venda is not None else 0
        oracle[d_iso]['lucro']     += float(lucro) if lucro is not None else 0
        oracle[d_iso]['verba']     += float(verba) if verba is not None else 0
        oracle[d_iso]['doctos']    += int(doctos) if doctos is not None else 0
        sc = int(seqcomp) if seqcomp is not None else 0
        registro_setor = {
            'venda':  float(vlr_venda) if vlr_venda is not None else 0,
            'margem': float(lucro) if lucro is not None else 0,
        }
        if sc == 6:    oracle_acougue[d_iso] = registro_setor
        elif sc == 7:  oracle_liquida[d_iso] = registro_setor
        elif sc == 9:  oracle_flv[d_iso]     = registro_setor
    oracle_promo = {}
    for r in rows_promo:
        dt_, venda_sp, margem_sp = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        oracle_promo[d_iso] = {
            'venda_sem_promo': float(venda_sp) if venda_sp is not None else None,
            'margem_sem_promo': float(margem_sp) if margem_sp is not None else None,
        }
    oracle_compras = {}
    for r in rows_compras:
        dt_, vlr = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        oracle_compras[d_iso] = float(vlr) if vlr is not None else None

    oracle_acordo = {}
    for r in rows_acordo:
        dt_, vlr = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        oracle_acordo[d_iso] = float(vlr) if vlr is not None else None

    oracle_perda = {}
    for r in rows_perda:
        dt_, vlr = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        oracle_perda[d_iso] = float(vlr) if vlr is not None else None

    oracle_invent = {}
    for r in rows_invent:
        dt_, vlr = r
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        oracle_invent[d_iso] = float(vlr) if vlr is not None else None

    # Monta TODOS os dias do mês (mesmo os futuros, com realizado vazio)
    primeiro = date(dt_ini.year, dt_ini.month, 1)
    if dt_ini.month == 12:
        ultimo = date(dt_ini.year + 1, 1, 1) - timedelta(days=1)
    else:
        ultimo = date(dt_ini.year, dt_ini.month + 1, 1) - timedelta(days=1)

    dias = []
    d = primeiro
    while d <= ultimo:
        dias.append(montar_dia(d.strftime('%Y-%m-%d'), aux, oracle, oracle_promo, oracle_compras, oracle_acordo, oracle_perda, oracle_invent))
        d += timedelta(days=1)

    # ===== Totais (linha 38 do FATURAMENTO) =====
    def soma(campo, somente_fechados=False):
        return sum(
            (x[campo] or 0)
            for x in dias
            if x[campo] is not None and (not somente_fechados or x['fechado'])
        )

    totais = {
        'meta_venda':             soma('meta_venda'),
        'realizado':              soma('realizado'),
        'venda_promo':            soma('venda_promo'),
        'venda_sem_promo':        soma('venda_sem_promo'),
        'meta_margem_geral':      soma('meta_margem_geral'),
        'margem_realizada':       soma('margem_realizada'),
        'verba':                  soma('verba'),
        'meta_margem_pdv':        soma('meta_margem_pdv'),
        'margem_pdv':             soma('margem_pdv'),
        'acordo_recebido':        soma('acordo_recebido'),
        'margem_sem_promo':       soma('margem_sem_promo'),
        'margem_com_promo':       soma('margem_com_promo'),
        'quebras':                soma('quebras'),
        'inventario':             soma('inventario'),
        'compra':                 soma('compra'),
    }
    # diffs / pcts no total
    totais['diff_rs'] = totais['realizado'] - totais['meta_venda']
    totais['margem_diff_rs'] = totais['margem_realizada'] - totais['meta_margem_geral']

    # ===== KPIs (linhas 40-43) — acumulados FECHADOS (até ontem) =====
    metas = aux['metas_mensais']
    meta_venda_mes = metas['meta_venda_total'] or 0
    meta_margem_pct = metas['meta_margem_pct'] or 0
    meta_margem_pdv_pct = metas['meta_margem_pdv_pct'] or 0

    # acumulado de meta = soma das metas dos dias com data < hoje
    meta_venda_ate_hoje = sum(x['meta_venda'] or 0 for x in dias if datetime.strptime(x['data'], '%Y-%m-%d').date() < hoje)
    realizado_ac = sum(x['realizado'] or 0 for x in dias if x['fechado'])

    meta_margem_ac = sum(x['meta_margem_geral'] or 0 for x in dias if datetime.strptime(x['data'], '%Y-%m-%d').date() < hoje)
    margem_ac = sum(x['margem_realizada'] or 0 for x in dias if x['fechado'])

    meta_margem_pdv_ac = sum(x['meta_margem_pdv'] or 0 for x in dias if datetime.strptime(x['data'], '%Y-%m-%d').date() < hoje)
    margem_pdv_ac = sum(x['margem_pdv'] or 0 for x in dias if x['fechado'])

    quebras_ac = sum(x['quebras'] or 0 for x in dias if x['fechado'])
    compras_ac = sum(x['compra'] or 0 for x in dias if x['fechado'])

    kpis = {
        'venda': {
            'meta_mes': meta_venda_mes,
            'meta_ate_hoje': meta_venda_ate_hoje,
            'realizado': realizado_ac,
            'diff': realizado_ac - meta_venda_ate_hoje,
            'ating': realizado_ac / meta_venda_mes if meta_venda_mes else 0,
        },
        'margem_geral': {
            'meta_mes': meta_venda_mes * meta_margem_pct,
            'meta_ate_hoje': meta_margem_ac,
            'realizado': margem_ac,
            'diff': margem_ac - meta_margem_ac,
            'ating': margem_ac / (meta_venda_mes * meta_margem_pct) if meta_venda_mes else 0,
        },
        'margem_pdv': {
            'meta_mes': meta_venda_mes * meta_margem_pdv_pct,
            'meta_ate_hoje': meta_margem_pdv_ac,
            'realizado': margem_pdv_ac,
            'diff': margem_pdv_ac - meta_margem_pdv_ac,
            'ating': margem_pdv_ac / (meta_venda_mes * meta_margem_pdv_pct) if meta_venda_mes else 0,
        },
        'quebra': {
            'meta_mes': metas['meta_quebra'],
            'meta_ate_hoje': metas['meta_quebra'],
            'realizado': quebras_ac,
            'diff': quebras_ac - (metas['meta_quebra'] or 0),
            'ating': min(1.0, quebras_ac / metas['meta_quebra']) if metas.get('meta_quebra') else 1.0,
        },
        'compra': {
            'meta_mes': metas['meta_compra'],
            'meta_ate_hoje': metas['meta_compra'],
            'realizado': compras_ac,
            'diff': compras_ac - (metas['meta_compra'] or 0),
            'ating': compras_ac / metas['meta_compra'] if metas.get('meta_compra') else 0,
        },
        'acomp_atacado': {'margem': None, 'verba': 0, 'verba_pct': None},
        'composicao_pct': meta_margem_pct - meta_margem_pdv_pct,
    }

    # ===== Setores =====
    # 6 sub-açougues vêm de SQL_SETOR_ACOUGUE (NIVELHIERARQUIA=3, SEQCATEGORIA=2121).
    # Açougue Geral, FLV, Liquida vêm da SQL_BASE filtrada por SEQCOMPRADOR (mapping CLASS):
    #   6=AÇOUGUE, 7=LIQUIDA, 9=FLV — mesma lógica que a aba VENDA25 da planilha.
    CAMINHO_KEY = {
        'PERECIVEIS \\ AÇOUGUE \\ AVES':       'aves',
        'PERECIVEIS \\ AÇOUGUE \\ BOVINO':     'bovino',
        'PERECIVEIS \\ AÇOUGUE \\ LINGUIÇAS':  'linguicas',
        'PERECIVEIS \\ AÇOUGUE \\ NATALINOS':  'natalinos',
        'PERECIVEIS \\ AÇOUGUE \\ PEIXARIA':   'peixes',
        'PERECIVEIS \\ AÇOUGUE \\ SUÍNO':      'suino',
    }
    setores_data = {
        'bovino': {}, 'aves': {}, 'linguicas': {}, 'natalinos': {},
        'peixes': {}, 'suino': {}, 'acougue_geral': {}, 'flv': {}, 'liquida': {},
    }
    for caminho, dt_, venda, lucro in rows_setor_acougue:
        key = CAMINHO_KEY.get(caminho)
        if not key: continue
        d_iso = dt_.strftime('%Y-%m-%d') if hasattr(dt_, 'strftime') else str(dt_)
        setores_data[key][d_iso] = {
            'venda': float(venda) if venda else 0,
            'margem': float(lucro) if lucro else 0,
        }

    # Categorias-pai (filtradas por SEQCOMPRADOR direto em B_VDA25 — bate com VENDA25)
    for d_iso, v in oracle_acougue.items():
        setores_data['acougue_geral'][d_iso] = v
    for d_iso, v in oracle_flv.items():
        setores_data['flv'][d_iso] = v
    for d_iso, v in oracle_liquida.items():
        setores_data['liquida'][d_iso] = v

    # Realizado total por dia (pra calcular part%)
    realizado_por_dia = {x['data']: x['realizado'] for x in dias if x.get('realizado') is not None}

    setores_out = {}
    nomes = {'bovino':'Bovino','aves':'Aves','linguicas':'Linguiças','natalinos':'Natalinos',
             'peixes':'Peixes','suino':'Suíno','acougue_geral':'Açougue Geral','flv':'FLV','liquida':'Liquida'}
    for key, nome in nomes.items():
        d_data = setores_data.get(key, {})
        venda_tot = sum(v['venda'] for v in d_data.values())
        margem_tot = sum(v['margem'] for v in d_data.values())
        realizado_tot = sum(realizado_por_dia.get(d, 0) for d in d_data.keys())
        dias_setor = []
        for d_iso in sorted(d_data.keys()):
            v = d_data[d_iso]
            r = realizado_por_dia.get(d_iso, 0)
            dias_setor.append({
                'data': d_iso,
                'dia_semana': DIAS_SEMANA[datetime.strptime(d_iso, '%Y-%m-%d').date().weekday()],
                'venda': v['venda'],
                'part_pct': (v['venda'] / r) if r else None,
                'margem': v['margem'],
                'margem_pct': (v['margem'] / v['venda']) if v['venda'] else None,
                'fechado': True,
            })
        setores_out[key] = {
            'nome': nome,
            'totais': {
                'venda':       venda_tot if venda_tot else None,
                'part_pct':    (venda_tot / realizado_tot) if realizado_tot else None,
                'margem':      margem_tot if margem_tot else None,
                'margem_pct':  (margem_tot / venda_tot) if venda_tot else None,
            },
            'dias': dias_setor,
        }
    setores_vazios = setores_out  # nome mantido pra não quebrar o resto do código

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'mes_referencia': dt_ini.strftime('%Y-%m'),
        'fonte': 'Oracle Consinco + planilha (auxiliares)',
        'kpis': kpis,
        'totais_principal': totais,
        'dias': dias,
        'setores': setores_vazios,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    print()
    print(f'✓ salvo em {OUT_PATH}')
    print(f'KPIs:')
    print(f'  Venda  · meta R$ {meta_venda_mes:>13,.0f} · até hoje R$ {meta_venda_ate_hoje:>11,.0f} · real R$ {realizado_ac:>11,.0f} · ating {kpis["venda"]["ating"]*100:.2f}%')
    print(f'  Margem · meta R$ {meta_venda_mes*meta_margem_pct:>13,.0f} · até hoje R$ {meta_margem_ac:>11,.0f} · real R$ {margem_ac:>11,.0f} · ating {kpis["margem_geral"]["ating"]*100:.2f}%')
    print(f'  Quebra · meta R$ {metas["meta_quebra"]:>13,.0f} · real R$ {quebras_ac:>11,.0f}')
    print(f'  Compra · meta R$ {metas["meta_compra"]:>13,.0f} · real R$ {compras_ac:>11,.0f}')


if __name__ == '__main__':
    main()
