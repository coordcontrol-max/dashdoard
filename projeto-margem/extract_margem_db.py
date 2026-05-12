#!/usr/bin/env python3
"""Gera data/margem_loja.json — Margem detalhada (loja × comprador × dia).

Período: 1º do mês corrente → ontem (sysdate-1).

Output schema:
{
  "periodo": {"inicio": "YYYY-MM-DD", "fim": "YYYY-MM-DD"},
  "gerado_em": "ISO timestamp",
  "linhas": [
    {
      "loja": 5,
      "loja_nome": "MATRIZ",
      "seqcomprador": 1,
      "comprador": "01-MAURIC(SEC)",
      "gerente": "Walas",
      "data": "2026-05-01",
      "venda": 12345.67,
      "lucratividade": 2345.67,
      "verba": 100.00,
      "doctos": 50
    },
    ...
  ]
}
"""
import json
import os
import re
import sys
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
OUT_PATH = Path('./data/margem_loja.json')

# Mesma classificação de gerentes do extract_kpis_db.py
GRUPOS = [
  ('André', ['ISRAEL', 'PAULO', 'SAMUEL', 'WALLACE']),
  ('Walas', ['MAURIC', 'WAL', 'LUZIA(PERF)', 'IGOR', 'LUCAS', 'LUZIA(BAZAR)', 'WALAS']),
]


def chave_apelido(apelido):
    m = re.match(r'^[\d\s]*-\s*(.+)$', str(apelido or '').strip())
    return (m.group(1) if m else str(apelido or '')).strip().upper().replace(' ', '')


def gerente_de(apelido):
    k = chave_apelido(apelido)
    for nome, chaves in GRUPOS:
        for ch in chaves:
            chU = ch.upper().replace(' ', '')
            if chU in k:
                return nome
    return None


def periodo_mes_atual():
    hoje = date.today()
    primeiro = date(hoje.year, hoje.month, 1)
    ontem = date.fromordinal(hoje.toordinal() - 1)
    if ontem < primeiro:
        ontem = primeiro
    return primeiro, ontem


def sql_margem_loja(dt_ini, dt_fim):
    return f"""
SELECT
    V.NROEMPRESA,
    D.SEQCOMPRADOR,
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
GROUP BY V.NROEMPRESA, D.SEQCOMPRADOR, V.DTAVDA
"""


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    dt_ini, dt_fim = periodo_mes_atual()
    print(f'Período: {dt_ini.strftime("%d/%m/%Y")} → {dt_fim.strftime("%d/%m/%Y")}')

    print(f'Conectando em {ORACLE_DSN} como {ORACLE_USER}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    # Lookups: nome da loja e do comprador
    cur.execute("SELECT NROEMPRESA, NVL(FANTASIA, NOMEREDUZIDO) FROM MAX_EMPRESA WHERE NROEMPRESA NOT IN (1,2,3,4,6,8,9,12,15,17,19,22,25)")
    loja_nome = {r[0]: str(r[1] or '').strip() for r in cur.fetchall()}

    cur.execute("SELECT SEQCOMPRADOR, APELIDO FROM MAX_COMPRADOR")
    comp_nome = {r[0]: str(r[1] or '').strip() for r in cur.fetchall()}

    print('Rodando Q margem por loja×comprador×dia…')
    sql = sql_margem_loja(dt_ini, dt_fim)
    cur.execute(sql)
    rows = cur.fetchall()
    cur.close(); conn.close()
    print(f'  → {len(rows)} linhas')

    linhas = []
    for r in rows:
        loja, seqc, dt, venda, lucr, verba, doctos = r
        try:
            dt_str = dt.strftime('%Y-%m-%d') if hasattr(dt, 'strftime') else str(dt)[:10]
        except Exception:
            dt_str = str(dt)
        nome = comp_nome.get(seqc) or f'#{seqc}'
        linhas.append({
            'loja': int(loja) if loja is not None else None,
            'loja_nome': loja_nome.get(int(loja)) if loja is not None else None,
            'seqcomprador': int(seqc) if seqc is not None else None,
            'comprador': nome,
            'gerente': gerente_de(nome),
            'data': dt_str,
            'venda':         float(venda or 0),
            'lucratividade': float(lucr or 0),
            'verba':         float(verba or 0),
            'doctos':        int(doctos or 0),
        })

    out = {
        'periodo': {'inicio': dt_ini.isoformat(), 'fim': dt_fim.isoformat()},
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'linhas': linhas,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    # Resumo no log
    tot_v = sum(l['venda'] for l in linhas)
    tot_l = sum(l['lucratividade'] for l in linhas)
    tot_b = sum(l['verba'] for l in linhas)
    pct = (tot_l / tot_v * 100) if tot_v else 0
    print(f'  → venda: R$ {tot_v:,.2f} · margem: R$ {tot_l:,.2f} ({pct:.2f}%) · verba: R$ {tot_b:,.2f}')
    print(f'  → arquivo salvo em {OUT_PATH}')


if __name__ == '__main__':
    main()
