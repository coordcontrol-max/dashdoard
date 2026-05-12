#!/usr/bin/env python3
"""Extrai B_VDA25 direto do Oracle Consinco — substitui o pipeline Excel/Microsoft Query.

Roda a query original do PL/SQL Developer, aplica o mapeamento de categoria
(SEQCOMPRADOR → DEPART, definido na aba CLASS da planilha), e salva:
  - data/b_vda25.csv  (mesmo formato da aba B_VDA25 da planilha — pra conferir)
  - data/b_vda25.json (mesma estrutura, pra consumo programático)

Uso:
  ./extract_b_vda25.py            # mês corrente até ontem
  ./extract_b_vda25.py 01/04/2026 # de 01/04 até ontem
  ./extract_b_vda25.py 01/04/2026 30/04/2026
"""
import csv
import json
import os
import sys
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
ORACLE_LIB = os.environ.get('ORACLE_LIB', '/home/joaoreis/oracle/instantclient_23_7')

# Mapeamento da aba CLASS da planilha (cols E→F): SEQCOMPRADOR → DEPART
CATEGORIA_POR_COMPRADOR = {
    1: 'PAS', 2: 'OUTROS', 3: 'SECA DOCE', 4: 'SECA SALG', 5: 'PADARIA',
    6: 'AÇOUGUE', 7: 'LIQUIDA', 8: 'COMMODITIES', 9: 'FLV', 10: 'BAZAR',
    11: 'OUTROS', 12: 'OUTROS', 13: 'INSTITUCIONAL', 14: 'OUTROS',
    15: 'OUTROS', 16: 'LIMPEZA', 17: 'OUTROS', 18: 'PERFUMARIA',
}

OUT_CSV = Path('./data/b_vda25.csv')
OUT_JSON = Path('./data/b_vda25.json')


def parse_dt(s):
    return datetime.strptime(s, '%d/%m/%Y').date()


# ===== Query original do user — só parametrizada nas datas =====
SQL = """
select
  v.nroempresa, d.seqcomprador, v.dtavda,
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
group by v.nroempresa, d.seqcomprador, v.dtavda
order by v.nroempresa, v.dtavda, d.seqcomprador
"""


def main():
    args = sys.argv[1:]
    hoje = date.today()
    if len(args) == 0:
        dt_ini = date(hoje.year, hoje.month, 1)
        dt_fim = hoje - timedelta(days=1)
    elif len(args) == 1:
        dt_ini = parse_dt(args[0])
        dt_fim = hoje - timedelta(days=1)
    elif len(args) == 2:
        dt_ini = parse_dt(args[0])
        dt_fim = parse_dt(args[1])
    else:
        print('uso: extract_b_vda25.py [dt_ini] [dt_fim]', file=sys.stderr); sys.exit(1)

    if not ORACLE_PASSWORD:
        print('ERRO: defina ORACLE_PASSWORD no ambiente (.env).', file=sys.stderr); sys.exit(2)

    print(f'Período: {dt_ini.strftime("%d/%m/%Y")} a {dt_fim.strftime("%d/%m/%Y")}')

    oracledb.init_oracle_client(lib_dir=ORACLE_LIB)
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()
    print('rodando query…')
    import time
    t0 = time.time()
    cur.execute(SQL, dt_ini=dt_ini, dt_fim=dt_fim)
    rows = cur.fetchall()
    dt = time.time() - t0
    conn.close()
    print(f'✓ {len(rows)} linhas em {dt:.1f}s')

    # Adapta no formato da B_VDA25:
    # cols (na planilha): NROEMPRESA, SEQCOMPRADOR, DTAVDA, DOCTOS(D), VLR_VENDA(E), LUCRO(F), VERBA(G), CATEGORIA(H)
    out_rows = []
    for r in rows:
        nroemp, seqcomp, dtavda, vlr_venda, lucro, verba, doctos = r
        categoria = CATEGORIA_POR_COMPRADOR.get(int(seqcomp), 'OUTROS')
        out_rows.append({
            'nroempresa': int(nroemp),
            'seqcomprador': int(seqcomp),
            'dtavda': dtavda.strftime('%Y-%m-%d') if hasattr(dtavda, 'strftime') else str(dtavda),
            'doctos': int(doctos) if doctos is not None else 0,
            'vlr_venda': float(vlr_venda) if vlr_venda is not None else 0.0,
            'lucro': float(lucro) if lucro is not None else 0.0,
            'verba': float(verba) if verba is not None else 0.0,
            'categoria': categoria,
        })

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open('w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(['NROEMPRESA', 'SEQCOMPRADOR', 'DTAVDA', 'DOCTOS', 'VLR_VENDA', 'LUCRO', 'VERBA', 'CATEGORIA'])
        for r in out_rows:
            w.writerow([
                r['nroempresa'], r['seqcomprador'], r['dtavda'],
                r['doctos'],
                f'{r["vlr_venda"]:.2f}'.replace('.', ','),
                f'{r["lucro"]:.2f}'.replace('.', ','),
                f'{r["verba"]:.2f}'.replace('.', ','),
                r['categoria'],
            ])

    OUT_JSON.write_text(json.dumps({
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'periodo': {'inicio': dt_ini.strftime('%Y-%m-%d'), 'fim': dt_fim.strftime('%Y-%m-%d')},
        'linhas': out_rows,
    }, ensure_ascii=False), encoding='utf-8')

    # Estatísticas
    total_venda = sum(r['vlr_venda'] for r in out_rows)
    total_lucro = sum(r['lucro'] for r in out_rows)
    total_verba = sum(r['verba'] for r in out_rows)
    total_doctos = sum(r['doctos'] for r in out_rows)
    print()
    print(f'CSV salvo em: {OUT_CSV}')
    print(f'JSON salvo em: {OUT_JSON}')
    print(f'Totais consolidados:')
    print(f'  Venda:  R$ {total_venda:>15,.2f}')
    print(f'  Lucro:  R$ {total_lucro:>15,.2f}  ({100*total_lucro/total_venda:.2f}% sobre venda)')
    print(f'  Verba:  R$ {total_verba:>15,.2f}')
    print(f'  Cupons: {total_doctos:>16,}'.replace(',', '.'))
    print()
    print('Por dia:')
    by_day = {}
    for r in out_rows:
        d = r['dtavda']
        if d not in by_day:
            by_day[d] = {'venda': 0, 'lucro': 0, 'verba': 0, 'doctos': 0}
        by_day[d]['venda'] += r['vlr_venda']
        by_day[d]['lucro'] += r['lucro']
        by_day[d]['verba'] += r['verba']
        by_day[d]['doctos'] += r['doctos']
    for d in sorted(by_day):
        v = by_day[d]
        print(f'  {d}: venda R$ {v["venda"]:>13,.2f}  | lucro R$ {v["lucro"]:>11,.2f}  | verba R$ {v["verba"]:>9,.2f}  | cupons {v["doctos"]:>5}')


if __name__ == '__main__':
    main()
