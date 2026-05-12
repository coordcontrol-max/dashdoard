#!/usr/bin/env python3
"""Gera data/operacao.json — Indicadores de Operação por loja.

Pipeline:
  1. Q1: Venda + Margem + Verba + Doctos por loja×dia (Oracle)
  2. Meta diária por loja (lê aba 'Meta' da planilha local data/operacao_supervisor.xlsx)
  3. Mapeia loja → supervisor (estático, conforme planilha)
  4. Saída: data/operacao.json com agregação por loja (mês corrente)

Output:
{
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "gerado_em": "ISO timestamp",
  "lojas": [
    {
      "loja": 101,
      "loja_nome": "...",
      "supervisor": "Ronaldo",
      "meta_venda": 1234567.89,
      "venda": 1234567.89,
      "lucratividade": 234567.89,
      "verba": 12345.67,
      "doctos": 12345,
      "diff": ...,
      "ating_venda": ...,
      "mg_total": ...,
      "mg_pdv": ...
    }
  ],
  "supervisores": { "Ronaldo": {agregado}, "Paulo B.": {agregado}, ... },
  "total": {agregado}
}
"""
import json
import os
import re
import sys
import zipfile
from datetime import datetime, date, timedelta
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
PLANILHA = Path('./data/operacao_supervisor.xlsx')
OUT_PATH = Path('./data/operacao.json')


# ===== Mapeamento Loja → Supervisor (extraído da aba Supervisor) =====
SUPERVISORES = {
    'Ronaldo':  [101, 102, 103, 104, 5, 106, 108, 26, 27, 131],
    'Paulo B.': [7, 10, 11, 112, 13, 14, 16, 18, 20],
    'Jurandir': [29, 215, 109, 219, 21, 222, 23, 125, 28, 117],
}
LOJA_SUPERVISOR = {}
for sup, lojas in SUPERVISORES.items():
    for l in lojas:
        LOJA_SUPERVISOR[int(l)] = sup


def periodo_mes_atual():
    hoje = date.today()
    primeiro = date(hoje.year, hoje.month, 1)
    ontem = date.fromordinal(hoje.toordinal() - 1)
    if ontem < primeiro:
        ontem = primeiro
    return primeiro, ontem


def excel_serial_to_date(n):
    return date(1899, 12, 30) + timedelta(days=int(float(n)))


# ===== Lê a aba Meta da planilha local =====
# ===== Lê aba Supervisor da planilha (clientes / ticket / ranks) =====
def ler_supervisor_planilha():
    """Lê dados por loja da aba Supervisor.
    Devolve {loja: {clientes_ant, clientes_atual, clientes_diff, rank_clientes,
                     ticket_medio, rank_ticket}}
    """
    if not PLANILHA.exists():
        return {}

    with zipfile.ZipFile(PLANILHA) as z:
        sst_raw = z.read('xl/sharedStrings.xml').decode()
        sst = []
        for b in re.findall(r'<si[^>]*>(.*?)</si>', sst_raw, re.S):
            sst.append(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', b)))

        wb = z.read('xl/workbook.xml').decode()
        rels = z.read('xl/_rels/workbook.xml.rels').decode()
        sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb)
        targets = {rid: tgt for rid, tgt in re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels)}
        sup_target = next((targets[rid] for n, rid in sheets if n.lower() == 'supervisor'), None)
        if not sup_target:
            return {}
        sheet = z.read('xl/' + sup_target).decode()
        rows = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet, re.S)

    def parse_row(content):
        cells = re.findall(r'<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)', content, re.S)
        out = {}
        for col, ctype, inner in cells:
            if not inner: continue
            vm = re.search(r'<v>([^<]*)</v>', inner)
            if not vm:
                tm = re.search(r'<t[^>]*>([^<]*)</t>', inner)
                v = tm.group(1) if tm else None
            else:
                v = vm.group(1)
                if ctype == 's' and v is not None:
                    try: v = sst[int(v)]
                    except: pass
            out[col] = v
        return out

    def numf(v):
        try: return float(v) if v not in (None, '', '#N/A', '#REF!') else None
        except (ValueError, TypeError): return None
    def numi(v):
        try: return int(float(v)) if v not in (None, '', '#N/A', '#REF!') else None
        except (ValueError, TypeError): return None

    # Linhas com dados começam na 5; col B = nro empresa
    out = {}
    for rn, content in rows:
        if int(rn) < 5: continue
        r = parse_row(content)
        try:
            loja = numi(r.get('B'))
            if loja is None: continue
            out[loja] = {
                'clientes_ant':    numi(r.get('V')),
                'clientes_atual':  numi(r.get('W')),
                'clientes_diff':   numi(r.get('X')),
                'rank_clientes':   numi(r.get('Y')),
                'ticket_medio':    numf(r.get('Z')),
                'rank_ticket':     numi(r.get('AA')),
            }
        except Exception:
            continue
    return out


def ler_sem_vendas_planilha():
    """Lê aba SEM VENDAS da planilha (já preenchida pela query Oracle do Excel).
    Cols: A=NROEMPRESA, B=SEQPRODUTO, C=PRODUTO, D=EMPRESA, E=COMPRADOR,
          F=QTDTOTAL (qty unidades), G=VLRCTOBRUTO (R$),
          H=DIASESTOQUE, I=DIASULTENTRADA, J=DIASSEMVENDA.
    Devolve {loja: [{produto, comprador, qtd, valor, dde, ult_entrada, sem_venda}, ...]}
    """
    if not PLANILHA.exists():
        return {}
    with zipfile.ZipFile(PLANILHA) as z:
        sst_raw = z.read('xl/sharedStrings.xml').decode()
        sst = []
        for b in re.findall(r'<si[^>]*>(.*?)</si>', sst_raw, re.S):
            sst.append(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', b)))
        wb = z.read('xl/workbook.xml').decode()
        rels = z.read('xl/_rels/workbook.xml.rels').decode()
        sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb)
        targets = {rid: tgt for rid, tgt in re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels)}
        sv_target = next((targets[rid] for n, rid in sheets if n.strip().lower() == 'sem vendas'), None)
        if not sv_target: return {}
        sheet = z.read('xl/' + sv_target).decode()
        rows = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet, re.S)

    def parse_row(content):
        out = {}
        for col, ctype, inner in re.findall(r'<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)', content, re.S):
            if not inner: continue
            vm = re.search(r'<v>([^<]*)</v>', inner)
            if not vm: continue
            v = vm.group(1)
            if ctype == 's' and v.isdigit() and int(v) < len(sst): v = sst[int(v)]
            out[col] = v
        return out
    def numf(v):
        try: return float(v) if v not in (None, '', '#N/A', '#REF!') else 0.0
        except: return 0.0
    def numi(v):
        try: return int(float(v)) if v not in (None, '', '#N/A', '#REF!') else None
        except: return None

    out = {}
    for rn, content in rows:
        if int(rn) < 2: continue
        r = parse_row(content)
        loja = numi(r.get('A'))
        if loja is None: continue
        if loja not in out: out[loja] = []
        out[loja].append({
            'seqproduto':    numi(r.get('B')),
            'produto':       str(r.get('C') or '').strip(),
            'comprador':     str(r.get('E') or '').strip(),
            'qtd':           numf(r.get('F')),
            'valor':         numf(r.get('G')),
            'dde':           numf(r.get('H')),
            'ult_entrada':   numf(r.get('I')),
            'dias_sem_venda': numf(r.get('J')),
        })
    # Ordena por valor desc e limita top 200
    for loja in out:
        out[loja].sort(key=lambda x: x['valor'], reverse=True)
        out[loja] = out[loja][:200]
    return out


def ler_meta_planilha(dt_ini, dt_fim):
    """Devolve (metas_acumuladas_por_loja, metas_diarias_por_loja).
    metas_diarias = {loja: {YYYY-MM-DD: meta}}"""
    if not PLANILHA.exists():
        print(f'AVISO: planilha {PLANILHA} não encontrada — sem metas', file=sys.stderr)
        return {}, {}

    with zipfile.ZipFile(PLANILHA) as z:
        sst_raw = z.read('xl/sharedStrings.xml').decode()
        sst = []
        for b in re.findall(r'<si[^>]*>(.*?)</si>', sst_raw, re.S):
            sst.append(''.join(re.findall(r'<t[^>]*>([^<]*)</t>', b)))

        wb = z.read('xl/workbook.xml').decode()
        rels = z.read('xl/_rels/workbook.xml.rels').decode()
        sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb)
        targets = {rid: tgt for rid, tgt in re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels)}
        meta_target = next((targets[rid] for n, rid in sheets if n.lower() == 'meta'), None)
        if not meta_target:
            print('AVISO: aba Meta não encontrada na planilha', file=sys.stderr)
            return {}
        sheet = z.read('xl/' + meta_target).decode()
        rows = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet, re.S)

    metas_por_loja = {}
    metas_diarias = {}  # {loja: {YYYY-MM-DD: meta}}
    for rn, content in rows:
        if int(rn) < 2:  # pula header
            continue
        cells = re.findall(r'<c r="([A-Z]+)\d+"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)', content, re.S)
        row = {}
        for col, ctype, inner in cells:
            if not inner: continue
            vm = re.search(r'<v>([^<]*)</v>', inner)
            if not vm:
                tm = re.search(r'<t[^>]*>([^<]*)</t>', inner)
                v = tm.group(1) if tm else None
            else:
                v = vm.group(1)
                if ctype == 's' and v is not None:
                    try: v = sst[int(v)]
                    except: pass
            row[col] = v

        try:
            data_serial = float(row.get('A') or 0)
            if data_serial < 40000:
                continue
            d = excel_serial_to_date(data_serial)
            if not (dt_ini <= d <= dt_fim):
                continue
            loja = int(float(row.get('B') or 0))
            meta = float(row.get('C') or 0)
            metas_por_loja[loja] = metas_por_loja.get(loja, 0) + meta
            iso = d.isoformat()
            if loja not in metas_diarias: metas_diarias[loja] = {}
            metas_diarias[loja][iso] = metas_diarias[loja].get(iso, 0) + meta
        except (ValueError, TypeError):
            continue

    return metas_por_loja, metas_diarias


# ===== SQL Q2 — ESTOQUE por loja×comprador (qtd, medvdia, dde, valor bruto) =====
# Versão fornecida pelo usuário — agrupa por LOJA + COMPRADOR; agregamos por loja em Python.
SQL_ESTOQUE_NROEMPRESAS = "5,7,10,101,102,103,104,106,108,109,11,112,117,125,13,131,14,16,18,20,21,215,219,222,23,26,27,28,29"
SQL_ESTOQUE_LOJA = f"""
SELECT
    E.NROEMPRESA                                                 AS NROEMPRESA,
    E.NOMEREDUZIDO                                               AS LOJA,
    O.APELIDO                                                    AS COMPRADOR,
    ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ) AS QTDTOTAL,
    SUM( C.MEDVDIAGERAL / K.QTDEMBALAGEM ) AS MEDVDIA,
    NVL( FC5_DIVIDE(
        ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ),
        ROUND( SUM( C.MEDVDIAGERAL / K.QTDEMBALAGEM ), 3 )
    ), 0 ) AS DIASESTOQUE,
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
                 AND NVL( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) IS NOT NULL THEN
                COALESCE( PR.PERCACRESCCUSTORELACVIG,
                          F_RETACRESCCUSTORELAC( C.SEQPRODUTO, C.DTAENTRADASAIDA, I2.UTILACRESCCUSTPRODRELAC, PR.PERCACRESCCUSTORELACVIG ) )
            ELSE 1
            END )
        * ( ESTQLOJA + ESTQDEPOSITO )
    ) AS VLRCTOBRUTO
FROM
    MAP_PRODUTO A,
    MAP_FAMILIA B,
    ( SELECT
          Y.SEQPRODUTO, Y.NROEMPRESA, Y.SEQCLUSTER,
          DECODE( ( ESTQLOJA + ESTQDEPOSITO ), 0, NULL, Y.SEQPRODUTO ) SEQPRODUTOCOMESTQ,
          DECODE( X.PRECO, 0, X.MENORPRECO, X.PRECO ) PRECO,
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
          NVL(Y.CMULTIMPOSTOPRESUM, 0) CMULTIMPOSTOPRESUM,
          SYSDATE DTAENTRADASAIDA,
          ( NVL(Y.CMULTVLRDESCPISTRANSF,       0)
          + NVL(Y.CMULTVLRDESCCOFINSTRANSF,    0)
          + NVL(Y.CMULTVLRDESCICMSTRANSF,      0)
          + NVL(Y.CMULTVLRDESCIPITRANSF,       0)
          + NVL(Y.CMULTVLRDESCLUCROTRANSF,     0)
          + NVL(Y.CMULTVLRDESCVERBATRANSF,     0)
          + NVL(Y.CMULTVLRDESCDIFERENCATRANSF, 0) ) VLRDESCTRANSFCB
      FROM
          ( SELECT
                SEQPRODUTO, NROEMPRESA,
                MAX( CASE WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                       ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM END ) PRECO,
                MIN( CASE WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                       ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM END ) MENORPRECO,
                MAX( CASE WHEN STATUSVENDA = 'I'
                          OR DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) = 0 THEN NULL
                       ELSE DECODE( PRECOVALIDPROMOC, 0, PRECOVALIDNORMAL, PRECOVALIDPROMOC ) / QTDEMBALAGEM END ) MAIORPRECO,
                DECODE( MIN( STATUSVENDA ),'A',MIN( STATUSVENDA ),'I') STATUSVENDA
            FROM   MRL_PRODEMPSEG
            WHERE  NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
              AND  NROSEGMENTO IN ( 2,4,1,3 )
            GROUP BY SEQPRODUTO, NROEMPRESA
          ) X,
          MRL_PRODUTOEMPRESA Y, MAX_EMPRESA E
      WHERE E.NROEMPRESA = Y.NROEMPRESA
        AND Y.NROEMPRESA = X.NROEMPRESA
        AND Y.SEQPRODUTO = X.SEQPRODUTO
        AND X.SEQPRODUTO IN (
              SELECT JP2.SEQPRODUTO FROM MAP_FAMDIVCATEG JX2, MAP_PRODUTO JP2
              WHERE JP2.SEQFAMILIA = JX2.SEQFAMILIA
                AND JX2.STATUS = 'A' AND JX2.NRODIVISAO = 4
                AND JX2.SEQCATEGORIA IN (3082,1946,1948,1947)
        )
        AND Y.SEQPRODUTO IN (
              SELECT FF.SEQPRODUTO FROM MAP_PRODUTO FF
              WHERE FF.SEQFAMILIA NOT IN (
                    SELECT SEQFAMILIA FROM MAP_FAMDIVISAO
                    WHERE NRODIVISAO = '4'
                      AND SEQCOMPRADOR IN (14,13,20,11,15,21,19,2,17,12)
              )
        )
        AND Y.SEQPRODUTO IN (
              SELECT FF.SEQPRODUTO FROM MAP_PRODUTO FF
              WHERE FF.SEQFAMILIA IN (
                    SELECT MAP_FAMDIVCATEG.SEQFAMILIA FROM MAP_CATEGORIA, MAP_FAMDIVCATEG
                    WHERE MAP_CATEGORIA.NRODIVISAO = E.NRODIVISAO
                      AND MAP_FAMDIVCATEG.SEQCATEGORIA = MAP_CATEGORIA.SEQCATEGORIA
                      AND MAP_FAMDIVCATEG.NRODIVISAO = MAP_CATEGORIA.NRODIVISAO
                      AND MAP_FAMDIVCATEG.STATUS = 'A'
                      AND MAP_CATEGORIA.TIPCATEGORIA = 'M'
                      AND MAP_CATEGORIA.STATUSCATEGOR IN ('A','F')
                      AND MAP_FAMDIVCATEG.SEQCATEGORIA IN (3082,1946,1948,1947)
              )
        )
    ) C,
    MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K, MAX_EMPRESA E, MAX_DIVISAO I2,
    MAD_FAMSEGMENTO H, MAD_SEGMENTO SE,
    MAX_COMPRADOR O, MAP_FAMDIVCATEG W,
    MAP_FAMDIVCATEG FDC, MAP_CATEGORIA CAT,
    MAP_PRODACRESCCUSTORELAC PR
WHERE A.SEQPRODUTO = C.SEQPRODUTO
  AND B.SEQFAMILIA = A.SEQFAMILIA
  AND C.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND D.SEQFAMILIA = A.SEQFAMILIA
  AND D.NRODIVISAO = E.NRODIVISAO
  AND K.SEQFAMILIA = D.SEQFAMILIA
  AND K.QTDEMBALAGEM = 1
  AND E.NROEMPRESA = C.NROEMPRESA
  AND I2.NRODIVISAO = E.NRODIVISAO
  AND I2.NRODIVISAO = D.NRODIVISAO
  AND A.SEQFAMILIA = FDC.SEQFAMILIA
  AND CAT.NRODIVISAO = E.NRODIVISAO
  AND FDC.SEQCATEGORIA = CAT.SEQCATEGORIA
  AND FDC.NRODIVISAO = CAT.NRODIVISAO
  AND CAT.NIVELHIERARQUIA = 1
  AND CAT.STATUSCATEGOR IN ('A','F')
  AND FDC.STATUS = 'A'
  AND CAT.TIPCATEGORIA = 'M'
  AND C.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND C.DTAENTRADASAIDA = PR.DTAMOVIMENTACAO(+)
  AND O.SEQCOMPRADOR = D.SEQCOMPRADOR
  AND W.SEQFAMILIA = D.SEQFAMILIA
  AND W.NRODIVISAO = D.NRODIVISAO
  AND W.STATUS = 'A'
  AND W.SEQCATEGORIA IN (3082,1946,1948,1947)
  AND H.SEQFAMILIA = A.SEQFAMILIA
  AND H.NROSEGMENTO = E.NROSEGMENTOPRINC
  AND H.NROSEGMENTO = SE.NROSEGMENTO
  AND D.SEQCOMPRADOR NOT IN (14,13,20,11,15,21,19,2,17,12)
  AND (ESTQLOJA + ESTQDEPOSITO) != 0
  AND A.SEQPRODUTOBASE IS NULL
GROUP BY E.NROEMPRESA, E.NOMEREDUZIDO, O.SEQCOMPRADOR, O.APELIDO
HAVING ROUND( SUM( ( ESTQLOJA + ESTQDEPOSITO ) / K.QTDEMBALAGEM ), 6 ) != 0
ORDER BY E.NROEMPRESA, O.APELIDO
"""


# ===== SQL Q3 — QUEBRA por loja×comprador×produto =====
QUEBRA_NROEMPRESAS = "5,7,10,101,102,103,104,106,108,109,11,112,117,125,13,131,14,16,17,18,20,21,215,219,222,23,25,26,27,28,29"
def sql_quebra(dt_ini, dt_fim):
    return f"""
SELECT
    E.NROEMPRESA           AS NROEMPRESA,
    E.NOMEREDUZIDO         AS LOJA,
    O.APELIDO              AS COMPRADOR,
    A.SEQPRODUTO           AS SEQPRODUTO,
    A.DESCCOMPLETA         AS PRODUTO,
    SUM(VW.QTDLANCTO)      AS QTDPERDA,
    SUM(VW.VALORLANCTOBRT) AS VLRTOTALLANCTOBRT
FROM
    MAX_COMPRADOR O,
    MAP_FAMDIVISAO D,
    MAX_EMPRESA E,
    MAX_DIVISAO I2,
    MAP_CLASSIFABC Z2,
    MAXV_ABCPERDABASE VW,
    MAP_TRIBUTACAOUF T3,
    MAP_FAMILIA B,
    MAD_FAMSEGMENTO H,
    MAP_FAMEMBALAGEM K,
    MRL_PRODUTOEMPRESA C,
    MRL_PRODEMPSEG C3,
    MAP_PRODUTO A,
    (SELECT
        A.SEQPRODUTO,
        A.NROEMPRESA,
        SUM(A.ESTQLOJA) ESTQLOJA,
        SUM(A.ESTQDEPOSITO) ESTQDEPOSITO,
        SUM(A.ESTQTROCA) AS ESTQTROCA,
        SUM(A.ESTQALMOXARIFADO) AS ESTQALMOXARIFADO,
        SUM(A.ESTQOUTRO) AS ESTQOUTRO,
        0 VLRDESCTRANSFCB
     FROM MRL_PRODUTOEMPRESA A
     WHERE A.NROEMPRESA IN ({QUEBRA_NROEMPRESAS})
     GROUP BY A.SEQPRODUTO, A.NROEMPRESA) SX,
    MAD_SEGMENTO SE,
    MAP_PRODUTO PR,
    (SELECT MAX(DX.UTILACRESCCUSTPRODRELAC) UTILACRESCCUSTPRODRELAC
     FROM MAX_DIVISAO DX, MAX_EMPRESA EX
     WHERE EX.NROEMPRESA IN ({QUEBRA_NROEMPRESAS})
     AND DX.NRODIVISAO = EX.NRODIVISAO) I3
WHERE
    E.NROEMPRESA = VW.NROEMPRESA
    AND E.NRODIVISAO = D.NRODIVISAO
    AND H.SEQFAMILIA = VW.SEQFAMILIA
    AND H.NROSEGMENTO = E.NROSEGMENTOPRINC
    AND H.NROSEGMENTO = SE.NROSEGMENTO
    AND D.SEQFAMILIA = VW.SEQFAMILIA
    AND D.NRODIVISAO IN (1,2,3,4)
    AND B.SEQFAMILIA = VW.SEQFAMILIA
    AND I2.NRODIVISAO = D.NRODIVISAO
    AND Z2.NROSEGMENTO = H.NROSEGMENTO
    AND Z2.CLASSIFCOMERCABC = H.CLASSIFCOMERCABC
    AND K.SEQFAMILIA = H.SEQFAMILIA
    AND K.QTDEMBALAGEM = (CASE WHEN INSTR('1', ',') > 0 THEN
                            fPadraoEmbVenda2(D.SEQFAMILIA,'1')
                         ELSE
                            H.PADRAOEMBVENDA
                         END)
    AND C.SEQPRODUTO = VW.SEQPRODUTO
    AND C.NROEMPRESA = NVL(E.NROEMPCUSTOABC, E.NROEMPRESA)
    AND C3.NROEMPRESA = VW.NROEMPRESA
    AND C3.SEQPRODUTO = VW.SEQPRODUTO
    AND C3.NROSEGMENTO = E.NROSEGMENTOPRINC
    AND C3.QTDEMBALAGEM = H.PADRAOEMBVENDA
    AND T3.NROTRIBUTACAO = D.NROTRIBUTACAO
    AND T3.UFEMPRESA = E.UF
    AND T3.UFCLIENTEFORNEC = E.UF
    AND T3.TIPTRIBUTACAO = DECODE(I2.TIPDIVISAO, 'V', 'SN', 'SC')
    AND T3.NROREGTRIBUTACAO = NVL(E.NROREGTRIBUTACAO, 0)
    AND PR.SEQPRODUTO = VW.SEQPRODUTO
    AND SX.SEQPRODUTO = VW.SEQPRODUTO
    AND SX.NROEMPRESA = VW.NROEMPRESA
    AND A.SEQPRODUTO = VW.SEQPRODUTO
    AND VW.DTAENTRADASAIDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}', 'DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}', 'DD/MM/YYYY')
    AND VW.NROEMPRESA IN ({QUEBRA_NROEMPRESAS})
    AND VW.TIPCLASSINTERNO IN ('P', 'R', 'C', 'A')
    AND VW.CODGERALOPER = 549
    AND VW.TIPLANCTO IN ('S')
    AND O.SEQCOMPRADOR = D.SEQCOMPRADOR
    AND O.SEQCOMPRADOR != 14
GROUP BY
    E.NROEMPRESA,
    E.NOMEREDUZIDO,
    O.SEQCOMPRADOR,
    O.APELIDO,
    A.SEQPRODUTO,
    A.DESCCOMPLETA
ORDER BY
    E.NROEMPRESA,
    O.APELIDO,
    A.DESCCOMPLETA
"""


# ===== SQL Produtos com estoque e SEM VENDAS há >= N dias =====
# Usa MRL_PRODUTOEMPRESA.DTAULTVENDA pra calcular dias sem venda.
# VLRCTOBRUTO = qtd × (CMULTVLRNF + IPI + ICMSST + DESPNF + DESPFORANF - DCTOFORANF)
# Filtra estoque > 0 e DIASSEMVENDA >= dias_min. Exclui comprador 14.
def sql_sem_vendas(dt_ref, dias_min=10):
    return f"""
SELECT C.NROEMPRESA,
       C.SEQPRODUTO,
       A.DESCCOMPLETA AS PRODUTO,
       O.APELIDO AS COMPRADOR,
       (C.ESTQLOJA + NVL(C.ESTQDEPOSITO,0)) AS QTDTOTAL,
       (C.ESTQLOJA + NVL(C.ESTQDEPOSITO,0)) *
         ( NVL(C.CMULTVLRNF,0) + NVL(C.CMULTIPI,0) + NVL(C.CMULTICMSST,0)
         + NVL(C.CMULTDESPNF,0) + NVL(C.CMULTDESPFORANF,0)
         - NVL(C.CMULTDCTOFORANF,0) ) AS VLRCTOBRUTO,
       (TRUNC(TO_DATE('{dt_ref.strftime('%d/%m/%Y')}','DD/MM/YYYY')) - TRUNC(C.DTAULTVENDA)) AS DIASSEMVENDA,
       NVL(C.MEDVDIAGERAL, 0) AS MEDVDIA,
       TO_CHAR(C.DTAULTVENDA, 'YYYY-MM-DD') AS DTAULTVENDA
FROM MRL_PRODUTOEMPRESA C, MAP_PRODUTO A, MAP_FAMDIVISAO D, MAX_COMPRADOR O, MAX_EMPRESA E
WHERE C.SEQPRODUTO = A.SEQPRODUTO
  AND A.SEQFAMILIA = D.SEQFAMILIA
  AND E.NROEMPRESA = C.NROEMPRESA
  AND D.NRODIVISAO = E.NRODIVISAO
  AND D.SEQCOMPRADOR = O.SEQCOMPRADOR
  AND D.SEQCOMPRADOR NOT IN (14, 13, 20, 11, 15, 21, 19, 2, 17, 12)
  AND C.STATUSCOMPRA IN ('A','I')
  AND A.SEQPRODUTOBASE IS NULL
  AND C.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND (C.ESTQLOJA + NVL(C.ESTQDEPOSITO,0)) > 0
  AND C.DTAULTVENDA IS NOT NULL
  AND TRUNC(TO_DATE('{dt_ref.strftime('%d/%m/%Y')}','DD/MM/YYYY')) - TRUNC(C.DTAULTVENDA) >= {dias_min}
  -- Produto não pode ter sido incluído recentemente (>= N dias)
  AND TRUNC(TO_DATE('{dt_ref.strftime('%d/%m/%Y')}','DD/MM/YYYY')) - TRUNC(A.DTAHORINCLUSAO) >= {dias_min}
  -- Produto tem que estar no segmento da loja (ativo ou inativo, não removido)
  AND EXISTS (
    SELECT 1 FROM MRL_PRODEMPSEG SEG
    WHERE SEG.NROEMPRESA = C.NROEMPRESA
      AND SEG.SEQPRODUTO = C.SEQPRODUTO
      AND SEG.STATUSVENDA IN ('A','I')
  )
  -- Categoria top-level (MERCEARIA, PERECIVEIS, NAO ALIMENTOS, A CLASSIFICAR)
  AND EXISTS (
    SELECT 1 FROM MAP_FAMDIVCATEG X
    WHERE X.SEQFAMILIA = A.SEQFAMILIA
      AND X.NRODIVISAO = D.NRODIVISAO
      AND X.STATUS = 'A'
      AND X.SEQCATEGORIA IN (1, 1946, 1948, 1947)
  )
  -- Exclui produtos com média de venda nos últimos N dias (MRL_CUSTODIA)
  AND NOT EXISTS (
    SELECT 1 FROM MRL_CUSTODIA M
    WHERE M.NROEMPRESA = C.NROEMPRESA
      AND M.SEQPRODUTO = C.SEQPRODUTO
      AND TRUNC(TO_DATE('{dt_ref.strftime('%d/%m/%Y')}','DD/MM/YYYY')) - M.DTAENTRADASAIDA <= {dias_min}
      AND M.QTDSAIDAMEDVENDA > 0
  )
"""


# ===== SQL Cancelamento de Cupom por loja =====
# Espelha a query da aba 'Cancel.' do Excel (FI_TSMOVTOOPERADOR + DETALHE).
def sql_cancelamento(dt_ini, dt_fim):
    return f"""
SELECT FI_TSMOVTOOPERADOR.NROEMPRESA,
       TO_CHAR(FI_TSMOVTOOPEDETALHE.DTAMOVIMENTO, 'YYYY-MM-DD') AS DTA,
       FI_TSMOVTOOPEDETALHE.VALOR,
       FIV_TSNOPERADORCAIXA.NOME,
       FIV_TSNOPERADORCAIXA.CODOPERADOR,
       FI_TSMOVTOOPEDETALHE.NROPDV
FROM FI_TSMOVTOOPERADOR,
     FI_TSMOVTOOPEDETALHE,
     FI_TSCODMOVIMENTO,
     FIV_TSNOPERADORCAIXA,
     GE_EMPRESA
WHERE FI_TSMOVTOOPERADOR.NROPDV = FI_TSMOVTOOPEDETALHE.NROPDV
  AND FI_TSMOVTOOPERADOR.NROEMPRESA = GE_EMPRESA.NROEMPRESA
  AND GE_EMPRESA.STATUS = 'A'
  AND FI_TSMOVTOOPERADOR.NROEMPRESA = FI_TSMOVTOOPEDETALHE.NROEMPRESA
  AND FI_TSMOVTOOPERADOR.DTAMOVIMENTO = FI_TSMOVTOOPEDETALHE.DTAMOVIMENTO
  AND FI_TSMOVTOOPERADOR.CODOPERADOR = FI_TSMOVTOOPEDETALHE.CODOPERADOR
  AND FI_TSMOVTOOPERADOR.NROTURNO = FI_TSMOVTOOPEDETALHE.NROTURNO
  AND FI_TSCODMOVIMENTO.TIPO = FI_TSMOVTOOPEDETALHE.TIPO
  AND FI_TSCODMOVIMENTO.NROEMPRESAMAE = FI_TSMOVTOOPEDETALHE.NROEMPRESAMAE
  AND FI_TSCODMOVIMENTO.CODMOVIMENTO = FI_TSMOVTOOPEDETALHE.CODMOVIMENTO
  AND FIV_TSNOPERADORCAIXA.CODOPERADOR = FI_TSMOVTOOPERADOR.CODOPERADOR
  AND FIV_TSNOPERADORCAIXA.NROEMPRESA = FI_TSMOVTOOPERADOR.NROEMPRESA
  AND NVL(FI_TSMOVTOOPERADOR.VERSAO, 'A') = 'N'
  AND NVL(FI_TSMOVTOOPEDETALHE.VERSAO, 'A') = 'N'
  AND FI_TSMOVTOOPEDETALHE.VALOR > 0.00
  AND FI_TSMOVTOOPERADOR.DTAMOVIMENTO BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
  AND FI_TSMOVTOOPEDETALHE.TIPO IN ('CAN')
  AND FI_TSMOVTOOPERADOR.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
GROUP BY FI_TSMOVTOOPERADOR.NROEMPRESA,
         FI_TSMOVTOOPEDETALHE.DTAMOVIMENTO,
         FI_TSMOVTOOPEDETALHE.VALOR,
         FI_TSMOVTOOPEDETALHE.CODMOVIMENTO,
         FI_TSMOVTOOPEDETALHE.TIPO,
         FIV_TSNOPERADORCAIXA.NOME,
         FIV_TSNOPERADORCAIXA.CODOPERADOR,
         FI_TSMOVTOOPEDETALHE.NROPDV
"""


# ===== SQL Inventário Rotativo por loja × seção (FLV/BOVINO) =====
# Espelha a query da aba 'inv flv.AÇO' do Excel (CGOs 401/501 = inventário rotativo).
# Valor NEGATIVO = perda (sumiu no inventário); positivo = sobra.
def sql_inv_rotativo(dt_ini, dt_fim):
    return f"""
SELECT L3.NROEMPRESA,
       {SECAO_CASE} AS SECAO,
       SUM( NVL(L3.VLRENTRADACOMPRA,0) + NVL(L3.VLRENTRADAOUTRAS,0)
          - NVL(L3.VLRSAIDAVENDA,0)   - NVL(L3.VLRSAIDAOUTRAS,0) ) AS VLRINV
FROM MAXV_ABCMOVTOBASE_PROD L3, CONSINCODW.DWV_CATEGORIA UN
WHERE L3.DTAENTRADASAIDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
  AND L3.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND L3.CODGERALOPER IN (401, 501)
  AND UN.SEQFAMILIA = L3.SEQFAMILIA
  AND UN.NRODIVISAO = L3.NRODIVISAO
  {SECAO_WHERE}
GROUP BY L3.NROEMPRESA, {SECAO_CASE}
"""


# Inventário Rotativo detalhado por produto (drill-down loja → produtos)
def sql_inv_rotativo_produto(dt_ini, dt_fim):
    return f"""
SELECT L3.NROEMPRESA,
       {SECAO_CASE} AS SECAO,
       L3.SEQPRODUTO,
       MAX(A.DESCCOMPLETA) AS PRODUTO,
       SUM( NVL(L3.QTDENTRADACOMPRA,0) + NVL(L3.QTDENTRADAOUTRAS,0)
          - NVL(L3.QTDSAIDAVENDA,0)   - NVL(L3.QTDSAIDAOUTRAS,0) ) AS QTD,
       SUM( NVL(L3.VLRENTRADACOMPRA,0) + NVL(L3.VLRENTRADAOUTRAS,0)
          - NVL(L3.VLRSAIDAVENDA,0)   - NVL(L3.VLRSAIDAOUTRAS,0) ) AS VLR
FROM MAXV_ABCMOVTOBASE_PROD L3, CONSINCODW.DWV_CATEGORIA UN, MAP_PRODUTO A
WHERE L3.DTAENTRADASAIDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
  AND L3.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND L3.CODGERALOPER IN (401, 501)
  AND UN.SEQFAMILIA = L3.SEQFAMILIA
  AND UN.NRODIVISAO = L3.NRODIVISAO
  AND A.SEQPRODUTO = L3.SEQPRODUTO
  {SECAO_WHERE}
GROUP BY L3.NROEMPRESA, {SECAO_CASE}, L3.SEQPRODUTO
"""


# ===== SQL Compra/Venda por loja × seção (DWV + filtros específicos) =====
# Espelha o filtro W do Excel do João (SEQCATEGORIA em níveis diferentes):
#   Bovino  = N3=2193 (BOVINO — subgrupo do AÇOUGUE, exclui aves/suíno/etc)
#   FLV     = N2=2122 (FLV inteiro — inclui FLV + OVOS)
#   Padaria = N3 IN (2238 ROSTERIA, 2240 TIMIZA, 2241 PANEBRAS, 2242 SABOR E ARTE,
#                    2243 SEVERINO, 2552 CTAP, 2589 ARTE TRIGO)
SECAO_CASE = """
       CASE
         WHEN UN.SEQCATEGORIANIVEL4 IN (2199,2200) THEN 'BOVINO'
         WHEN UN.SEQCATEGORIANIVEL2 = 2122 THEN 'FLV'
         WHEN UN.SEQCATEGORIANIVEL3 IN (2238,2240,2241,2242,2243,2552,2589) THEN 'PADARIA'
       END
"""
SECAO_WHERE = """
  AND ( UN.SEQCATEGORIANIVEL4 IN (2199,2200)
        OR UN.SEQCATEGORIANIVEL2 = 2122
        OR UN.SEQCATEGORIANIVEL3 IN (2238,2240,2241,2242,2243,2552,2589) )
"""


def sql_compra_secao(dt_ini, dt_fim):
    return f"""
SELECT V1.NROEMPRESA, {SECAO_CASE} AS SECAO,
       SUM(V1.VLRITEM - NVL(V1.VLRDESCITEM,0)) AS VLRCOMPRA
FROM CONSINCODW.DWV_COMPRA V1, CONSINCODW.DWV_CATEGORIA UN
WHERE V1.DTAENTRADA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
  AND V1.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND V1.CODGERALOPER IN (1, 50, 51, 52, 101, 202, 802)
  AND UN.SEQFAMILIA = V1.SEQFAMILIA
  AND UN.NRODIVISAO = V1.NRODIVISAO
  {SECAO_WHERE}
GROUP BY V1.NROEMPRESA, {SECAO_CASE}
"""


def sql_venda_secao(dt_ini, dt_fim):
    return f"""
SELECT V1.NROEMPRESA, {SECAO_CASE} AS SECAO,
       SUM(V1.VLROPERACAO) AS VLRVENDA
FROM CONSINCODW.DWV_BASEABCVENDA V1, CONSINCODW.DWV_CATEGORIA UN
WHERE V1.AGRUPAMENTO = 2
  AND V1.DTAOPERACAO BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
  AND V1.NROEMPRESA IN ({SQL_ESTOQUE_NROEMPRESAS})
  AND V1.NROSEGMENTO IN (1,2,3,4)
  AND NVL(V1.ACMCOMPRAVENDAREF, V1.ACMCOMPRAVENDA) = 'S'
  AND UN.SEQFAMILIA = V1.SEQFAMILIA
  AND UN.NRODIVISAO = V1.NRODIVISAO
  {SECAO_WHERE}
GROUP BY V1.NROEMPRESA, {SECAO_CASE}
"""


# ===== SQL Q1 — Venda + Margem + Verba + Doctos por loja×dia =====
def sql_venda_margem_loja(dt_ini, dt_fim):
    return f"""
SELECT
    V.NROEMPRESA,
    V.DTAVDA,
    SUM( ( ROUND( V.VLRITEM, 2 ) ) - ( ROUND( V.VLRDEVOLITEM, 2 ) - ( 0 ) ) ) AS VENDA,
    ROUND( SUM(
        fC5_AbcDistribLucratividade(
            'L', 'L', 'N',
            V.VLRITEM,
            'N',
            V.VLRICMSST, V.VLRFCPST, V.VLRICMSSTEMPORIG,
            E.UF, V.UFPESSOA,
            'N', 0, 'N',
            V.VLRIPIITEM, V.VLRIPIDEVOLITEM,
            'N',
            V.VLRDESCFORANF,
            Y.CMDIAVLRNF - 0,
            Y.CMDIAIPI,
            NVL( Y.CMDIACREDPIS, 0 ),
            NVL( Y.CMDIACREDCOFINS, 0 ),
            Y.CMDIAICMSST,
            Y.CMDIADESPNF,
            Y.CMDIADESPFORANF,
            Y.CMDIADCTOFORANF,
            'S',
            A.PROPQTDPRODUTOBASE,
            V.QTDITEM,
            V.VLREMBDESCRESSARCST,
            V.ACMCOMPRAVENDA,
            V.PISITEM,
            V.COFINSITEM,
            DECODE( V.TIPCGO, 'S', Y.QTDVDA, NVL( Y.QTDDEVOL, Y.QTDVDA ) ),
            ( DECODE( V.TIPCGO, 'S', Y.VLRIMPOSTOVDA - NVL( Y.VLRIPIVDA, 0 ),
                NVL( Y.VLRIMPOSTODEVOL - NVL( V.VLRIPIDEVOLITEM, 0 ),
                Y.VLRIMPOSTOVDA - NVL( Y.VLRIPIVDA, 0 ) ) ) ),
            'N',
            V.VLRDESPOPERACIONALITEM,
            Y.VLRDESPESAVDA,
            'N',
            NVL( Y.VLRVERBAVDAACR, 0 ),
            Y.QTDVERBAVDA,
            Y.VLRVERBAVDA - NVL( Y.VLRVERBAVDAINDEVIDA, 0 ),
            'N',
            NVL( V.VLRTOTCOMISSAOITEM, 0 ),
            V.VLRDEVOLITEM,
            VLRDEVOLICMSST,
            V.DVLRFCPST,
            V.QTDDEVOLITEM,
            V.PISDEVOLITEM,
            V.COFINSDEVOLITEM,
            V.VLRDESPOPERACIONALITEMDEVOL,
            V.VLRTOTCOMISSAOITEMDEVOL,
            E.PERIRLUCRAT,
            E.PERCSLLLUCRAT,
            Y.CMDIACREDICMS,
            DECODE( V.ICMSEFETIVOITEM, 0, V.ICMSITEM, V.ICMSEFETIVOITEM ),
            V.VLRFCPICMS,
            V.PERCPMF,
            V.PEROUTROIMPOSTO,
            DECODE( V.ICMSEFETIVODEVOLITEM, 0, V.ICMSDEVOLITEM, V.ICMSEFETIVODEVOLITEM ),
            V.DVLRFCPICMS,
            CASE WHEN ( 'S' ) = 'N' THEN
                ( NVL(Y.CMDIAVLRDESCPISTRANSF, 0) + NVL(Y.CMDIAVLRDESCCOFINSTRANSF, 0)
                + NVL(Y.CMDIAVLRDESCICMSTRANSF, 0) + NVL(Y.CMDIAVLRDESCIPITRANSF, 0)
                + NVL(Y.CMDIAVLRDESCLUCROTRANSF, 0) + NVL(Y.CMDIAVLRDESCVERBATRANSF, 0) )
            ELSE 0
            END,
            CASE WHEN DV.UTILACRESCCUSTPRODRELAC = 'S'
                  AND NVL( A.SEQPRODUTOBASE, A.SEQPRODUTOBASEANTIGO ) IS NOT NULL THEN
                COALESCE( PR.PERCACRESCCUSTORELACVIG,
                          NVL( F_RETACRESCCUSTORELACABC( V.SEQPRODUTO, V.DTAVDA ), 1 ) )
            ELSE 1
            END,
            'N', 0, 0, 'S',
            V.VLRDESCMEDALHA,
            'S',
            V.VLRDESCFORNEC,
            V.VLRDESCFORNECDEVOL,
            'N',
            V.VLRFRETEITEMRATEIO,
            V.VLRFRETEITEMRATEIODEV,
            'S',
            V.VLRICMSSTEMBUTPROD,
            V.VLRICMSSTEMBUTPRODDEV,
            V.VLREMBDESCRESSARCSTDEVOL,
            CASE WHEN 'N' = 'S' THEN NVL( V.VLRDESCACORDOVERBAPDV, 0 ) ELSE 0 END,
            NVL( Y.CMDIACREDIPI, 0 ),
            NVL( V.VLRITEMRATEIOCTE, 0 ),
            'N', 'C',
            V.VLRIPIPRECOVDA,
            V.VLRIPIPRECODEVOL,
            V.VLRDESCMEDALHADEVOL
        )
    ), 2 ) AS LUCRATIVIDADE,
    SUM(
        ( DECODE( Y.QTDVERBAVDA, 0, 0,
            ( Y.VLRVERBAVDA - NVL( Y.VLRVERBAVDAINDEVIDA, 0 ) )
            * NVL( A.PROPQTDPRODUTOBASE, 1 )
            / Y.QTDVDA )
        ) * ( V.QTDITEM - 0 )
    ) AS VERBA,
    COUNT( DISTINCT V.ROWIDDOCTO ) AS DOCTOS
FROM
    MRL_CUSTODIA Y, MAXV_ABCDISTRIBBASE V,
    MAP_PRODUTO A, MAP_PRODUTO PB,
    MAP_FAMDIVISAO D, MAP_FAMEMBALAGEM K,
    MAX_EMPRESA E, MAX_DIVISAO DV,
    MAP_PRODACRESCCUSTORELAC PR
WHERE D.SEQFAMILIA = A.SEQFAMILIA
  AND D.NRODIVISAO = V.NRODIVISAO
  AND V.SEQPRODUTO = A.SEQPRODUTO
  AND V.SEQPRODUTOCUSTO = PB.SEQPRODUTO
  AND V.NRODIVISAO = D.NRODIVISAO
  AND E.NROEMPRESA = V.NROEMPRESA
  AND E.NRODIVISAO = DV.NRODIVISAO
  AND V.SEQPRODUTO = PR.SEQPRODUTO(+)
  AND V.DTAVDA = PR.DTAMOVIMENTACAO(+)
  AND V.DTAVDA BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','dd/mm/yyyy')
                   AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','dd/mm/yyyy')
  AND Y.NROEMPRESA = NVL( E.NROEMPCUSTOABC, E.NROEMPRESA )
  AND Y.DTAENTRADASAIDA = V.DTAVDA
  AND V.NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)
  AND K.SEQFAMILIA = A.SEQFAMILIA
  AND K.QTDEMBALAGEM = 1
  AND Y.SEQPRODUTO = PB.SEQPRODUTO
  AND DECODE(V.TIPTABELA, 'S', V.CGOACMCOMPRAVENDA, V.ACMCOMPRAVENDA) IN ( 'S', 'I' )
  AND D.SEQCOMPRADOR != 14
GROUP BY V.NROEMPRESA, V.DTAVDA
"""


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    dt_ini, dt_fim = periodo_mes_atual()
    print(f'Período: {dt_ini.strftime("%d/%m/%Y")} → {dt_fim.strftime("%d/%m/%Y")}')

    print('Lendo Meta da planilha…')
    meta_por_loja, metas_diarias = ler_meta_planilha(dt_ini, dt_fim)
    print(f'  → {len(meta_por_loja)} lojas com meta acumulada no período')

    print('Lendo aba Supervisor (clientes/ticket)…')
    supervisor_data = ler_supervisor_planilha()
    print(f'  → {len(supervisor_data)} lojas com dados de operação')

    print(f'Conectando em {ORACLE_DSN} como {ORACLE_USER}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    # Lookup nome da loja
    cur.execute("SELECT NROEMPRESA, NVL(FANTASIA, NOMEREDUZIDO) FROM MAX_EMPRESA")
    loja_nome = {int(r[0]): str(r[1] or '').strip() for r in cur.fetchall() if r[0] is not None}

    print('Rodando Q1 venda+margem por loja×dia…')
    cur.execute(sql_venda_margem_loja(dt_ini, dt_fim))
    rows = cur.fetchall()
    print(f'  → {len(rows)} linhas (loja×dia)')

    print('Rodando Q2 estoque por loja…')
    cur.execute(SQL_ESTOQUE_LOJA)
    rows_estq = cur.fetchall()
    print(f'  → {len(rows_estq)} linhas (loja×comprador) com estoque')

    print('Rodando Q3 quebra (loja×comprador×produto)…')
    cur.execute(sql_quebra(dt_ini, dt_fim))
    rows_quebra = cur.fetchall()
    print(f'  → {len(rows_quebra)} linhas de quebra')

    # Compra usa +1 dia (até hoje), igual o Excel faz — venda continua até ontem
    dt_fim_compra = date.today()
    print(f'Rodando Q4 compra por loja×seção (Compra_STAFF) até {dt_fim_compra.strftime("%d/%m/%Y")}…')
    cur.execute(sql_compra_secao(dt_ini, dt_fim_compra))
    rows_compra_sec = cur.fetchall()
    print(f'  → {len(rows_compra_sec)} linhas (loja×seção) compra')

    print('Rodando Q5 venda por loja×seção (Venda_STAFF)…')
    cur.execute(sql_venda_secao(dt_ini, dt_fim))
    rows_venda_sec = cur.fetchall()
    print(f'  → {len(rows_venda_sec)} linhas (loja×seção) venda')

    print('Rodando Q6 inventário rotativo (CGO 401/501)…')
    cur.execute(sql_inv_rotativo(dt_ini, dt_fim))
    rows_inv_rot = cur.fetchall()
    print(f'  → {len(rows_inv_rot)} linhas (loja×seção) inv rotativo')

    print('Rodando Q7 inventário rotativo por produto…')
    cur.execute(sql_inv_rotativo_produto(dt_ini, dt_fim))
    rows_inv_rot_prod = cur.fetchall()
    print(f'  → {len(rows_inv_rot_prod)} linhas (loja×seção×produto) inv rotativo')

    print('Rodando Q8 cancelamento de cupom…')
    cur.execute(sql_cancelamento(dt_ini, dt_fim))
    rows_cancel = cur.fetchall()
    print(f'  → {len(rows_cancel)} linhas (loja×data×operador×pdv) cancelamento')

    cur.close(); conn.close()

    print('Lendo aba SEM VENDAS da planilha…')
    sem_vendas_planilha = ler_sem_vendas_planilha()
    print(f'  → {sum(len(v) for v in sem_vendas_planilha.values())} produtos em {len(sem_vendas_planilha)} lojas')

    # ===== Agrega Compra×Venda por seção =====
    # rows_compra_sec / rows_venda_sec: NROEMPRESA, CATEGORIANIVEL2, VLR
    compra_map = {}  # {(loja, secao): valor}
    venda_map = {}
    for r in rows_compra_sec:
        loja = int(r[0]) if r[0] is not None else None
        secao = str(r[1] or '').strip()
        valor = float(r[2] or 0)
        if loja is None or not secao: continue
        compra_map[(loja, secao)] = compra_map.get((loja, secao), 0) + valor
    for r in rows_venda_sec:
        loja = int(r[0]) if r[0] is not None else None
        secao = str(r[1] or '').strip()
        valor = float(r[2] or 0)
        if loja is None or not secao: continue
        venda_map[(loja, secao)] = venda_map.get((loja, secao), 0) + valor

    # Pré-agrega quebra por seção (comprador → seção) — usado em compra_venda_secao abaixo
    COMP_SECAO_PRE = {
        '03-ISRAEL(FLV)':  'FLV',
        '04-PAULO(PAD)':   'PADARIA',
        '06-SAMUEL(ACOU)': 'BOVINO',
    }
    quebra_por_loja_secao = {}  # {secao: {loja: valor}}
    for r in rows_quebra:
        loja_int = int(r[0]) if r[0] is not None else None
        comprador = str(r[2] or '').strip()
        sec = COMP_SECAO_PRE.get(comprador)
        if loja_int is None or not sec: continue
        valor = float(r[6] or 0)
        if sec not in quebra_por_loja_secao:
            quebra_por_loja_secao[sec] = {}
        quebra_por_loja_secao[sec][loja_int] = quebra_por_loja_secao[sec].get(loja_int, 0) + valor

    # Inventário rotativo por seção (FLV / BOVINO — Padaria não tem inv rotativo)
    # rows_inv_rot: NROEMPRESA, SECAO, VLRINV (pode ser negativo = perda)
    inv_rotativo_por_loja_secao = {}  # {secao: {loja: valor}}
    for r in rows_inv_rot:
        loja_int = int(r[0]) if r[0] is not None else None
        secao = str(r[1] or '').strip()
        if loja_int is None or not secao: continue
        valor = float(r[2] or 0)
        if secao not in inv_rotativo_por_loja_secao:
            inv_rotativo_por_loja_secao[secao] = {}
        inv_rotativo_por_loja_secao[secao][loja_int] = inv_rotativo_por_loja_secao[secao].get(loja_int, 0) + valor

    # Produtos com estoque sem vendas — lido da planilha SEM VENDAS (col F=qty, G=valor)
    sem_vendas_por_loja = {}  # {loja: {valor, qtd_skus, qtd_unid}}
    sem_vendas_detalhe = sem_vendas_planilha  # já vem ordenado e capado em 200
    # Pra os totais, somar TODOS (não só top 200), preciso ler de novo agregado.
    # Otimização: lê novamente sem cap pra totalizar.
    sem_vendas_tot_planilha = {}
    try:
        with zipfile.ZipFile(PLANILHA) as z:
            wb = z.read('xl/workbook.xml').decode()
            rels = z.read('xl/_rels/workbook.xml.rels').decode()
            sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb)
            targets = {rid: tgt for rid, tgt in re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels)}
            sv_t = next((targets[rid] for n, rid in sheets if n.strip().lower() == 'sem vendas'), None)
            if sv_t:
                s = z.read('xl/' + sv_t).decode()
                for rn, content in re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', s, re.S):
                    if int(rn) < 2: continue
                    a = re.search(r'<c r="A\d+"[^>]*><v>([^<]*)</v>', content)
                    f = re.search(r'<c r="F\d+"[^>]*><v>([^<]*)</v>', content)
                    g = re.search(r'<c r="G\d+"[^>]*><v>([^<]*)</v>', content)
                    if not a: continue
                    try:
                        loja = int(float(a.group(1)))
                        qtd  = float(f.group(1)) if f else 0
                        vlr  = float(g.group(1)) if g else 0
                        if loja not in sem_vendas_tot_planilha:
                            sem_vendas_tot_planilha[loja] = {'qtd': 0, 'vlr': 0, 'skus': 0}
                        sem_vendas_tot_planilha[loja]['qtd'] += qtd
                        sem_vendas_tot_planilha[loja]['vlr'] += vlr
                        sem_vendas_tot_planilha[loja]['skus'] += 1
                    except: pass
    except Exception as e:
        print(f'  ⚠ erro ler totais SEM VENDAS: {e}')
    for loja_int, tot in sem_vendas_tot_planilha.items():
        sem_vendas_por_loja[loja_int] = {
            'valor':    tot['vlr'],
            'qtd_unid': tot['qtd'],
            'qtd_skus': tot['skus'],
        }

    # Cancelamento de cupom — total por loja + detalhe (operador, data, pdv, valor)
    # Cols: 0=NROEMPRESA, 1=DTA(YYYY-MM-DD), 2=VALOR, 3=NOME, 4=CODOPERADOR, 5=NROPDV
    cancelamento_por_loja = {}  # {loja: {total, qtd}}
    cancelamento_detalhe = {}   # {loja: [{data, operador, codoperador, nropdv, valor}]}
    for r in rows_cancel:
        loja_int = int(r[0]) if r[0] is not None else None
        if loja_int is None: continue
        dta = str(r[1] or '')
        valor = float(r[2] or 0)
        nome = str(r[3] or '').strip()
        codop = int(r[4]) if r[4] is not None else None
        nropdv = int(r[5]) if r[5] is not None else None
        if loja_int not in cancelamento_por_loja:
            cancelamento_por_loja[loja_int] = {'total': 0, 'qtd': 0}
        cancelamento_por_loja[loja_int]['total'] += valor
        cancelamento_por_loja[loja_int]['qtd']   += 1
        if loja_int not in cancelamento_detalhe:
            cancelamento_detalhe[loja_int] = []
        cancelamento_detalhe[loja_int].append({
            'data':         dta,
            'operador':     nome,
            'codoperador':  codop,
            'nropdv':       nropdv,
            'valor':        valor,
        })
    # Ordena por valor desc (maiores cancelamentos primeiro)
    for loja_int in cancelamento_detalhe:
        cancelamento_detalhe[loja_int].sort(key=lambda x: x['valor'], reverse=True)

    # Inventário rotativo detalhado por produto — {secao: {loja: [{produto, qtd, valor}]}}
    inv_rotativo_detalhe = {}
    for r in rows_inv_rot_prod:
        loja_int = int(r[0]) if r[0] is not None else None
        secao = str(r[1] or '').strip()
        seqp = int(r[2]) if r[2] is not None else None
        produto = str(r[3] or '').strip()
        qtd = float(r[4] or 0)
        valor = float(r[5] or 0)
        if loja_int is None or not secao: continue
        if secao not in inv_rotativo_detalhe: inv_rotativo_detalhe[secao] = {}
        if loja_int not in inv_rotativo_detalhe[secao]: inv_rotativo_detalhe[secao][loja_int] = []
        inv_rotativo_detalhe[secao][loja_int].append({
            'seqproduto': seqp, 'produto': produto, 'qtd': qtd, 'valor': valor,
        })
    # Ordena por valor absoluto desc (piores primeiro — mais negativo no topo se for perda)
    for secao in inv_rotativo_detalhe:
        for loja in inv_rotativo_detalhe[secao]:
            inv_rotativo_detalhe[secao][loja].sort(key=lambda x: x['valor'])  # mais negativo primeiro

    # Seções de interesse pras abas Bovino / FLV / Padaria
    SECOES_ALVO = ['BOVINO', 'FLV', 'PADARIA']
    compra_venda_secao = {}
    for secao in SECOES_ALVO:
        itens = []
        lojas_no_caminho = sorted({l for (l, s) in compra_map.keys() if s == secao} |
                                  {l for (l, s) in venda_map.keys()  if s == secao})
        # Pra seção mapeia em comprador, pegamos a quebra (FLV→ISRAEL, PADARIA→PAULO, BOVINO→SAMUEL)
        quebra_sec_loja = quebra_por_loja_secao.get(secao, {})
        inv_rot_sec_loja = inv_rotativo_por_loja_secao.get(secao, {})
        for l in lojas_no_caminho:
            compra = compra_map.get((l, secao), 0)
            venda  = venda_map.get((l, secao), 0)
            cxv_rs = venda - compra
            cxv_pct = (cxv_rs / venda) if venda > 0 else None
            quebra = quebra_sec_loja.get(l, 0)
            inv_rot = inv_rot_sec_loja.get(l, 0)
            # Quebra "com folhagens" = Identificada + Rotativo
            # Inv rotativo é NEGATIVO quando há perda → subtrair adiciona (quebra efetiva maior)
            quebra_total = quebra - inv_rot
            quebra_pct_id = (quebra / venda) if venda > 0 else None
            quebra_pct_total = (quebra_total / venda) if venda > 0 else None
            itens.append({
                'loja': l,
                'loja_nome': loja_nome.get(l, ''),
                'supervisor': LOJA_SUPERVISOR.get(l),
                'venda':       venda,
                'compra':      compra,
                'cxv_rs':      cxv_rs,
                'cxv_pct':     cxv_pct,
                'quebra':            quebra,
                'quebra_pct':        quebra_pct_id,
                'inv_rotativo':      inv_rot,
                'quebra_total':      quebra_total,
                'quebra_total_pct':  quebra_pct_total,
            })
        # Chave PERECIVEIS \ X igual o frontend espera
        caminho = f'PERECIVEIS \\ {secao}'
        compra_venda_secao[caminho] = itens

    # Cols: 0=NROEMPRESA, 1=LOJA, 2=COMPRADOR, 3=QTDTOTAL, 4=MEDVDIA, 5=DIASESTOQUE, 6=VLRCTOBRUTO
    # Agrega por loja (soma todos os compradores) + guarda detalhe por comprador
    estoque_por_loja = {}
    estoque_por_loja_comprador = {}  # {loja: [{comprador, valor_estoque, qtd, medvdia, dde}]}
    for r in rows_estq:
        loja_int = int(r[0]) if r[0] is not None else None
        if loja_int is None: continue
        comprador = str(r[2] or '').strip()
        qtd     = float(r[3] or 0)
        medvdia = float(r[4] or 0)
        valor   = float(r[6] or 0)
        dde     = (qtd / medvdia) if medvdia > 0 else None

        if loja_int not in estoque_por_loja:
            estoque_por_loja[loja_int] = {'qtd_estoque': 0, 'medvdia': 0, 'valor_estoque': 0}
        estoque_por_loja[loja_int]['qtd_estoque']   += qtd
        estoque_por_loja[loja_int]['medvdia']       += medvdia
        estoque_por_loja[loja_int]['valor_estoque'] += valor

        if loja_int not in estoque_por_loja_comprador:
            estoque_por_loja_comprador[loja_int] = []
        estoque_por_loja_comprador[loja_int].append({
            'comprador':     comprador,
            'qtd_estoque':   qtd,
            'medvdia':       medvdia,
            'valor_estoque': valor,
            'dde':           dde,
        })
    # DDE = qtd_total / medvdia_total
    for loja_int, e in estoque_por_loja.items():
        e['dde'] = (e['qtd_estoque'] / e['medvdia']) if e['medvdia'] > 0 else None
    # Ordena compradores por valor de estoque (maior pro menor)
    for loja_int in estoque_por_loja_comprador:
        estoque_por_loja_comprador[loja_int].sort(key=lambda x: x['valor_estoque'], reverse=True)

    # Quebra: agrega por loja + guarda detalhe (comprador × produto)
    # Cols: 0=NROEMPRESA, 1=LOJA, 2=COMPRADOR, 3=SEQPRODUTO, 4=PRODUTO, 5=QTDPERDA, 6=VLRTOTALLANCTOBRT
    quebra_por_loja = {}        # {loja: {valor_quebra, qtd_quebra}}
    quebra_detalhe = {}         # {loja: [{comprador, seqproduto, produto, qtd, valor}]}
    for r in rows_quebra:
        loja_int = int(r[0]) if r[0] is not None else None
        if loja_int is None: continue
        comprador = str(r[2] or '').strip()
        seqp = int(r[3]) if r[3] is not None else None
        produto = str(r[4] or '').strip()
        qtd = float(r[5] or 0)
        valor = float(r[6] or 0)
        if loja_int not in quebra_por_loja:
            quebra_por_loja[loja_int] = {'valor_quebra': 0, 'qtd_quebra': 0}
        quebra_por_loja[loja_int]['valor_quebra'] += valor
        quebra_por_loja[loja_int]['qtd_quebra']   += qtd
        if loja_int not in quebra_detalhe:
            quebra_detalhe[loja_int] = []
        quebra_detalhe[loja_int].append({
            'comprador':   comprador,
            'seqproduto':  seqp,
            'produto':     produto,
            'qtd':         qtd,
            'valor':       valor,
        })
    # Ordena por valor (maior pro menor) dentro de cada loja
    for loja_int in quebra_detalhe:
        quebra_detalhe[loja_int].sort(key=lambda x: x['valor'], reverse=True)

    # Agrega por loja (soma dos dias) + guarda detalhe diário
    por_loja = {}
    vendas_diarias = {}  # {loja: {YYYY-MM-DD: {venda, lucr, verba, doctos}}}
    for r in rows:
        loja, dt, venda, lucr, verba, doctos = r
        loja_int = int(loja) if loja is not None else None
        if loja_int is None:
            continue
        try:
            dt_str = dt.strftime('%Y-%m-%d') if hasattr(dt, 'strftime') else str(dt)[:10]
        except Exception:
            dt_str = str(dt)
        v = float(venda or 0); l_v = float(lucr or 0); vb = float(verba or 0); dc = int(doctos or 0)
        if loja_int not in por_loja:
            por_loja[loja_int] = {'venda': 0, 'lucr': 0, 'verba': 0, 'doctos': 0}
        por_loja[loja_int]['venda']  += v
        por_loja[loja_int]['lucr']   += l_v
        por_loja[loja_int]['verba']  += vb
        por_loja[loja_int]['doctos'] += dc
        if loja_int not in vendas_diarias: vendas_diarias[loja_int] = {}
        vendas_diarias[loja_int][dt_str] = {
            'venda': v, 'lucratividade': l_v, 'verba': vb, 'doctos': dc,
        }

    # Monta lista de lojas
    lojas = []
    for loja, agg in sorted(por_loja.items()):
        venda = agg['venda']
        lucr  = agg['lucr']
        verba = agg['verba']
        meta  = meta_por_loja.get(loja, 0)
        # Cenário A: lucratividade JÁ INCLUI verba
        mg_total = (lucr / venda) if venda > 0 else None
        mg_pdv   = ((lucr - verba) / venda) if venda > 0 else None
        diff     = venda - meta
        ating    = (venda / meta) if meta > 0 else None
        sup_extra = supervisor_data.get(loja, {})
        estq = estoque_por_loja.get(loja, {})
        lojas.append({
            'loja': loja,
            'loja_nome': loja_nome.get(loja, ''),
            'supervisor': LOJA_SUPERVISOR.get(loja),
            'meta_venda':    meta,
            'venda':         venda,
            'lucratividade': lucr,
            'verba':         verba,
            'doctos':        agg['doctos'],
            'diff':          diff,
            'ating_venda':   ating,
            'mg_total':      mg_total,
            'mg_pdv':        mg_pdv,
            # Operação (planilha aba Supervisor)
            'clientes_ant':    sup_extra.get('clientes_ant'),
            'clientes_atual':  sup_extra.get('clientes_atual'),
            'clientes_diff':   sup_extra.get('clientes_diff'),
            'rank_clientes':   sup_extra.get('rank_clientes'),
            'ticket_medio':    sup_extra.get('ticket_medio'),
            'rank_ticket':     sup_extra.get('rank_ticket'),
            # Estoque (Oracle)
            'valor_estoque':   estq.get('valor_estoque'),
            'qtd_estoque':     estq.get('qtd_estoque'),
            'medvdia':         estq.get('medvdia'),
            'dde':             estq.get('dde'),
            # Quebra (Oracle Q3)
            'valor_quebra':    (quebra_por_loja.get(loja, {}) or {}).get('valor_quebra', 0),
            'qtd_quebra':      (quebra_por_loja.get(loja, {}) or {}).get('qtd_quebra', 0),
            # Cancelamento de cupom (Oracle Q8)
            'cancelamento':         (cancelamento_por_loja.get(loja, {}) or {}).get('total', 0),
            'cancelamento_qtd':     (cancelamento_por_loja.get(loja, {}) or {}).get('qtd', 0),
            'cancelamento_pct':     (((cancelamento_por_loja.get(loja, {}) or {}).get('total', 0) / venda) if venda > 0 else None),
            # Estoque sem venda — da aba SEM VENDAS da planilha (qtd_unid bate com CG da Supervisor)
            'sem_vendas_valor':     (sem_vendas_por_loja.get(loja, {}) or {}).get('valor', 0),
            'sem_vendas_qtd_skus':  (sem_vendas_por_loja.get(loja, {}) or {}).get('qtd_skus', 0),
            'sem_vendas_qtd_unid':  (sem_vendas_por_loja.get(loja, {}) or {}).get('qtd_unid', 0),
            # % da planilha = qty_unid / venda (mesma fórmula CH = CG/F do Supervisor)
            'sem_vendas_pct':       (((sem_vendas_por_loja.get(loja, {}) or {}).get('qtd_unid', 0) / venda) if venda > 0 else None),
        })

    # Agrega por supervisor
    supervisores = {}
    for sup in SUPERVISORES.keys():
        items = [l for l in lojas if l['supervisor'] == sup]
        venda = sum(l['venda'] for l in items)
        lucr  = sum(l['lucratividade'] for l in items)
        verba = sum(l['verba'] for l in items)
        meta  = sum(l['meta_venda'] for l in items)
        doctos = sum(l['doctos'] for l in items)
        cli_ant = sum((l['clientes_ant'] or 0) for l in items)
        cli_atu = sum((l['clientes_atual'] or 0) for l in items)
        cli_diff = cli_atu - cli_ant
        ticket = (venda / cli_atu) if cli_atu > 0 else None
        valor_estq = sum((l['valor_estoque'] or 0) for l in items)
        qtd_estq = sum((l['qtd_estoque'] or 0) for l in items)
        medvdia_sum = sum((l['medvdia'] or 0) for l in items)
        dde_sup = (qtd_estq / medvdia_sum) if medvdia_sum > 0 else None
        supervisores[sup] = {
            'meta_venda':    meta,
            'venda':         venda,
            'lucratividade': lucr,
            'verba':         verba,
            'doctos':        doctos,
            'diff':          venda - meta,
            'ating_venda':   (venda / meta) if meta > 0 else None,
            'mg_total':      (lucr / venda) if venda > 0 else None,
            'mg_pdv':        ((lucr - verba) / venda) if venda > 0 else None,
            'lojas':         len(items),
            'clientes_ant':   cli_ant,
            'clientes_atual': cli_atu,
            'clientes_diff':  cli_diff,
            'ticket_medio':   ticket,
            'valor_estoque':  valor_estq,
            'dde':            dde_sup,
            'valor_quebra':   sum((l['valor_quebra'] or 0) for l in items),
            'qtd_quebra':     sum((l['qtd_quebra'] or 0) for l in items),
        }

    # Total geral
    venda_t = sum(l['venda'] for l in lojas)
    lucr_t  = sum(l['lucratividade'] for l in lojas)
    verba_t = sum(l['verba'] for l in lojas)
    meta_t  = sum(l['meta_venda'] for l in lojas)
    doctos_t = sum(l['doctos'] for l in lojas)
    cli_ant_t = sum((l['clientes_ant'] or 0) for l in lojas)
    cli_atu_t = sum((l['clientes_atual'] or 0) for l in lojas)
    valor_estq_t = sum((l['valor_estoque'] or 0) for l in lojas)
    qtd_estq_t = sum((l['qtd_estoque'] or 0) for l in lojas)
    medvdia_t = sum((l['medvdia'] or 0) for l in lojas)
    total = {
        'meta_venda':    meta_t,
        'venda':         venda_t,
        'lucratividade': lucr_t,
        'verba':         verba_t,
        'doctos':        doctos_t,
        'diff':          venda_t - meta_t,
        'ating_venda':   (venda_t / meta_t) if meta_t > 0 else None,
        'mg_total':      (lucr_t / venda_t) if venda_t > 0 else None,
        'mg_pdv':        ((lucr_t - verba_t) / venda_t) if venda_t > 0 else None,
        'clientes_ant':   cli_ant_t,
        'clientes_atual': cli_atu_t,
        'clientes_diff':  cli_atu_t - cli_ant_t,
        'ticket_medio':   (venda_t / cli_atu_t) if cli_atu_t > 0 else None,
        'valor_estoque':  valor_estq_t,
        'dde':            (qtd_estq_t / medvdia_t) if medvdia_t > 0 else None,
        'valor_quebra':   sum((l['valor_quebra'] or 0) for l in lojas),
        'qtd_quebra':     sum((l['qtd_quebra'] or 0) for l in lojas),
    }

    out = {
        'periodo':       {'inicio': dt_ini.isoformat(), 'fim': dt_fim.isoformat()},
        'gerado_em':     datetime.now().isoformat(timespec='seconds'),
        'lojas':         lojas,
        'supervisores':  supervisores,
        'total':         total,
        'vendas_diarias': vendas_diarias,
        'metas_diarias':  metas_diarias,
        'estoque_por_comprador': estoque_por_loja_comprador,
        'quebra_detalhe':        quebra_detalhe,
        'compra_venda_secao':    compra_venda_secao,
        'inv_rotativo_detalhe':  inv_rotativo_detalhe,
        'cancelamento_detalhe':  cancelamento_detalhe,
        'sem_vendas_detalhe':    sem_vendas_detalhe,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    print(f'\n✓ {OUT_PATH} salvo')
    print(f'  Total venda: R$ {venda_t:,.2f} · meta: R$ {meta_t:,.2f} · ating: {(venda_t/meta_t*100 if meta_t else 0):.2f}%')
    print(f'  Margem Total: {(lucr_t/venda_t*100 if venda_t else 0):.2f}% · Margem PDV: {((lucr_t-verba_t)/venda_t*100 if venda_t else 0):.2f}%')


if __name__ == '__main__':
    main()
