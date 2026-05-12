#!/usr/bin/env python3
"""Gera data/estrategia.json — Comparativo de Vendas (Nível Estratégia).

Pipeline:
  1. Roda SQL de venda+lucratividade 3x (mês atual, mês anterior, ano anterior)
  2. Agrega por loja, por comprador (seção) e total
  3. Lê meta acumulada da planilha (aba Meta)
  4. Calcula desvios e atingimentos
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
OUT_PATH = Path('./data/estrategia.json')

NROEMPRESAS = "5,7,10,101,102,103,104,106,108,109,11,112,117,125,13,131,14,16,17,18,20,21,215,219,222,23,25,26,27,28,29"


def periodos():
    """Retorna 3 períodos: atual, mês_ant (mesmo intervalo), ano_ant (mesmo intervalo)."""
    hoje = date.today()
    primeiro = date(hoje.year, hoje.month, 1)
    ontem = date.fromordinal(hoje.toordinal() - 1)
    if ontem < primeiro: ontem = primeiro

    # Mês anterior: 1º do mês passado até o mesmo "dia ontem"
    if primeiro.month == 1:
        mes_ant_ini = date(primeiro.year - 1, 12, 1)
    else:
        mes_ant_ini = date(primeiro.year, primeiro.month - 1, 1)
    # Mesmo dia (clamp pro último dia do mês passado se for menor)
    try:
        mes_ant_fim = date(mes_ant_ini.year, mes_ant_ini.month, ontem.day)
    except ValueError:
        # ex.: dia 31 num mês com 30 dias → último dia
        next_month = date(mes_ant_ini.year + (1 if mes_ant_ini.month == 12 else 0),
                         (mes_ant_ini.month % 12) + 1, 1)
        mes_ant_fim = next_month - timedelta(days=1)

    # Ano anterior: mesmo período no ano passado
    try:
        ano_ant_ini = date(primeiro.year - 1, primeiro.month, primeiro.day)
        ano_ant_fim = date(ontem.year - 1, ontem.month, ontem.day)
    except ValueError:
        ano_ant_ini = primeiro.replace(year=primeiro.year - 1)
        ano_ant_fim = ontem.replace(year=ontem.year - 1)

    return {
        'atual':   (primeiro, ontem),
        'mes_ant': (mes_ant_ini, mes_ant_fim),
        'ano_ant': (ano_ant_ini, ano_ant_fim),
    }


def excel_serial_to_date(n):
    return date(1899, 12, 30) + timedelta(days=int(float(n)))


def ler_meta_planilha(dt_ini, dt_fim):
    """Devolve {loja: meta_acumulada} no período pedido."""
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
        meta_target = next((targets[rid] for n, rid in sheets if n.lower() == 'meta'), None)
        if not meta_target: return {}
        sheet = z.read('xl/' + meta_target).decode()
        rows = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet, re.S)

    metas = {}
    for rn, content in rows:
        if int(rn) < 2: continue
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
            row[col] = v
        try:
            ds = float(row.get('A') or 0)
            if ds < 40000: continue
            d = excel_serial_to_date(ds)
            if not (dt_ini <= d <= dt_fim): continue
            loja = int(float(row.get('B') or 0))
            meta = float(row.get('C') or 0)
            metas[loja] = metas.get(loja, 0) + meta
        except (ValueError, TypeError):
            continue
    return metas


def sql_estrategia(dt_ini, dt_fim):
    return f"""
SELECT
    V1.NROEMPRESA          AS NROEMPRESA,
    MAX(V1.EMPRESA)        AS LOJA,
    UN.SEQCOMPRADOR        AS SEQCOMPRADOR,
    MAX(UN.APELIDO)        AS COMPRADOR,
    V1.NRODIVISAO          AS NRODIVISAO,
    V1.SEQFAMILIA          AS SEQFAMILIA,
    V1.SEQPRODUTO          AS SEQPRODUTO,
    MAX(V1.PRODUTO)        AS PRODUTO,
    SUM(V1.QTDOPERACAOUNID) AS QUANTIDADE,
    SUM( V1.VLROPERACAO + NVL(V1.VLRDESCONTO,0) - NVL(V1.VLRACRESCIMO,0) - NVL(V1.VLRACRESCIMOAUX,0) ) AS VLROPERACAOBRUTO,
    SUM( ( DECODE( V1.METODOPRECIFICACAO,
                  'B', ( V1.VLROPERACAO
                         - ( V1.VLRCTOPRODUTO + V1.VLRCTOIPI + V1.VLRCTOICMSST + V1.VLRCTODESPNF
                             + V1.VLRCTODESPFORANF - (V1.VLRCTODCTOFORANF - NVL(V1.VLRCTOIMPOSTOPRESUM,0))
                             - V1.VLRCTODESCFIXO - V1.VLRCTOVERBA + NVL(V1.VLRCTOVERBAVDAACR,0) )
                         - V1.VLRCALCIMPOSTOVDA ),
                  'I', ( V1.VLROPERACAO
                         - ( V1.VLRCTOPRODUTO + V1.VLRCTOIPI - V1.VLRCTOCREDPIS - V1.VLRCTOCREDCOFINS
                             + V1.VLRCTOICMSST + V1.VLRCTODESPNF + V1.VLRCTODESPFORANF - V1.VLRCTODCTOFORANF
                             + V1.VLRCTOCOMPROR + V1.VLRCTOFECP
                             - V1.VLRCTODESCPISTRANSF - V1.VLRCTODESCCOFINSTRANSF - V1.VLRCTODESCICMSTRANSF
                             - V1.VLRCTOCREDICMSPRESUM - V1.VLRCTOCREDICMSESTORNO
                             - V1.VLRCTODESCFIXO + V1.VLRCTOVERBAVDAACR - V1.VLRCTOVERBA )
                         - V1.VLRICMSST - V1.VLRIPI - V1.VLRPIS - V1.VLRCOFINS
                         - (V1.VLRCALCIMPOSTOVDA - V1.VLRIPI) ),
                  ( V1.VLROPERACAO
                    - ( V1.VLRCTOPRODUTO + V1.VLRCTOIPI - V1.VLRCTOCREDPIS - V1.VLRCTOCREDICMS - V1.VLRCTOCREDCOFINS
                        + V1.VLRCTOICMSST + V1.VLRCTODESPNF + V1.VLRCTODESPFORANF - V1.VLRCTODCTOFORANF
                        - V1.VLRCTOCREDICMSESTORNO - V1.VLRCTODESCFIXO + V1.VLRCTOVERBAVDAACR - V1.VLRCTOVERBA )
                    - DECODE( V1.METODOPRECIFICACAO,
                              'L', NVL(V1.VLRFCPICMS,0) + V1.VLRPIS + V1.VLRCOFINS
                                   + (V1.VLRCALCIMPOSTOVDA - V1.VLRIPI) + V1.VLRICMSEFETIVO,
                              V1.VLRCALCIMPOSTOVDA - V1.VLRIPI )
                    - V1.VLRVERBACOMPRA )
              )
              - NVL(V1.VLRIPIPRECO,0) - NVL(V1.VLRCOMISSAO,0) + NVL(V1.VLRVERBADEVOL,0)
            ) * ((100 - V1.PERIRLUCRAT - V1.PERCSLLLUCRAT) / 100)
       ) AS VLRLUCRATIVIDADE
FROM
    CONSINCODW.DWV_BASEABCVENDA  V1,
    CONSINCODW.DWV_CATEGORIA     UN
WHERE
    V1.AGRUPAMENTO = 2
    AND V1.DTAOPERACAO BETWEEN TO_DATE('{dt_ini.strftime('%d/%m/%Y')}','DD/MM/YYYY') AND TO_DATE('{dt_fim.strftime('%d/%m/%Y')}','DD/MM/YYYY')
    AND V1.NROEMPRESA IN ({NROEMPRESAS})
    AND V1.NROSEGMENTO IN (1,2,3,4)
    AND NVL(V1.ACMCOMPRAVENDAREF, V1.ACMCOMPRAVENDA) = 'S'
    AND UN.SEQFAMILIA = V1.SEQFAMILIA
    AND UN.NRODIVISAO = V1.NRODIVISAO
    AND UN.SEQCOMPRADOR != 14
GROUP BY
    V1.NROEMPRESA,
    UN.SEQCOMPRADOR,
    V1.NRODIVISAO,
    V1.SEQFAMILIA,
    V1.SEQPRODUTO
"""


# Query auxiliar: hierarquia de categoria por (familia, divisao)
SQL_HIERARQUIA_CAT = """
SELECT
    FDC.SEQFAMILIA,
    FDC.NRODIVISAO,
    CAT.NIVELHIERARQUIA,
    CAT.CATEGORIA
FROM MAP_FAMDIVCATEG FDC, MAP_CATEGORIA CAT
WHERE FDC.SEQCATEGORIA = CAT.SEQCATEGORIA
  AND FDC.NRODIVISAO   = CAT.NRODIVISAO
  AND FDC.STATUS       = 'A'
  AND CAT.STATUSCATEGOR = 'A'
  AND CAT.NIVELHIERARQUIA IN (1, 2, 3, 4)
"""


def agregar_periodo(rows, hierarquia):
    """Agrega rows brutas em por_loja, por_comprador, por_setor, por_secao, total.
    hierarquia = {(seqfamilia, nrodivisao): {1: setor, 2: secao, 3: grupo, 4: subgrupo}}
    """
    por_loja = {}       # {nroempresa: {nome, venda, lucr, qtd}}
    por_comp = {}       # {seqcomprador: {apelido, venda, lucr, qtd}}
    por_setor = {}      # {setor_nome: {venda, lucr, qtd}}
    por_secao = {}      # {secao_nome: {setor, venda, lucr, qtd}}
    por_loja_secao = {} # {nroempresa: {secao: {venda, lucr, qtd}}} — pra filtro por loja
    por_comp_secao = {} # {seqcomprador: {secao: {venda, lucr, qtd}}} — drill-down por comprador
    total_v = total_l = total_q = 0

    for r in rows:
        # Cols: 0=nemp 1=loja 2=seqc 3=comp 4=nrodiv 5=seqfam 6=seqp 7=prod 8=qtd 9=venda 10=lucr
        nemp = int(r[0]) if r[0] is not None else None
        loja_nome = str(r[1] or '').strip()
        seqc = int(r[2]) if r[2] is not None else None
        comp = str(r[3] or '').strip()
        ndiv = int(r[4]) if r[4] is not None else None
        seqfam = int(r[5]) if r[5] is not None else None
        if nemp is None: continue
        # Hierarquia (lookup por família+divisão)
        h = hierarquia.get((seqfam, ndiv), {}) if seqfam is not None else {}
        setor = (h.get(1) or '— sem setor —').strip()
        secao = (h.get(2) or '— sem seção —').strip()
        v = float(r[9] or 0); l_v = float(r[10] or 0); q = float(r[8] or 0)

        if nemp not in por_loja:
            por_loja[nemp] = {'nome': loja_nome, 'venda': 0, 'lucr': 0, 'qtd': 0}
        por_loja[nemp]['venda'] += v
        por_loja[nemp]['lucr']  += l_v
        por_loja[nemp]['qtd']   += q

        if seqc is not None:
            if seqc not in por_comp:
                por_comp[seqc] = {'apelido': comp, 'venda': 0, 'lucr': 0, 'qtd': 0}
            por_comp[seqc]['venda'] += v
            por_comp[seqc]['lucr']  += l_v
            por_comp[seqc]['qtd']   += q

        if setor not in por_setor:
            por_setor[setor] = {'venda': 0, 'lucr': 0, 'qtd': 0}
        por_setor[setor]['venda'] += v
        por_setor[setor]['lucr']  += l_v
        por_setor[setor]['qtd']   += q

        if secao not in por_secao:
            por_secao[secao] = {'setor': setor, 'venda': 0, 'lucr': 0, 'qtd': 0}
        por_secao[secao]['venda'] += v
        por_secao[secao]['lucr']  += l_v
        por_secao[secao]['qtd']   += q

        # Loja × seção (pra quando filtrar por loja)
        if nemp not in por_loja_secao: por_loja_secao[nemp] = {}
        if secao not in por_loja_secao[nemp]:
            por_loja_secao[nemp][secao] = {'setor': setor, 'venda': 0, 'lucr': 0, 'qtd': 0}
        por_loja_secao[nemp][secao]['venda'] += v
        por_loja_secao[nemp][secao]['lucr']  += l_v
        por_loja_secao[nemp][secao]['qtd']   += q

        # Comprador × seção (drill-down do comparativo por comprador)
        if seqc is not None:
            if seqc not in por_comp_secao: por_comp_secao[seqc] = {}
            if secao not in por_comp_secao[seqc]:
                por_comp_secao[seqc][secao] = {'setor': setor, 'venda': 0, 'lucr': 0, 'qtd': 0}
            por_comp_secao[seqc][secao]['venda'] += v
            por_comp_secao[seqc][secao]['lucr']  += l_v
            por_comp_secao[seqc][secao]['qtd']   += q

        total_v += v; total_l += l_v; total_q += q

    return {
        'por_loja':            por_loja,
        'por_comprador':       por_comp,
        'por_setor':           por_setor,
        'por_secao':           por_secao,
        'por_loja_secao':      por_loja_secao,
        'por_comprador_secao': por_comp_secao,
        'total': {'venda': total_v, 'lucr': total_l, 'qtd': total_q},
    }


def main():
    if not ORACLE_PASSWORD:
        print('ERRO: ORACLE_PASSWORD não definida no .env', file=sys.stderr); sys.exit(1)

    pers = periodos()
    print('Períodos:')
    for k, (i, f) in pers.items():
        print(f'  {k:8s} {i.strftime("%d/%m/%Y")} → {f.strftime("%d/%m/%Y")}')

    print(f'\nConectando em {ORACLE_DSN}…')
    oracledb.init_oracle_client(lib_dir=os.environ['LD_LIBRARY_PATH'].split(':')[0])
    conn = oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)
    cur = conn.cursor()

    # Hierarquia de categoria por (familia, divisao) — uma única vez
    print('Carregando hierarquia de categoria (família × divisão)…')
    cur.execute(SQL_HIERARQUIA_CAT)
    hierarquia = {}  # {(seqfam, ndiv): {1: setor, 2: secao, 3: grupo, 4: subgrupo}}
    for r in cur.fetchall():
        seqfam, ndiv, nivel, cat = r
        key = (int(seqfam), int(ndiv))
        if key not in hierarquia: hierarquia[key] = {}
        hierarquia[key][int(nivel)] = str(cat or '').strip()
    print(f'  → {len(hierarquia)} família-divisões com hierarquia')

    agregados = {}
    for periodo, (dt_ini, dt_fim) in pers.items():
        print(f'\nRodando período {periodo} ({dt_ini.strftime("%d/%m/%Y")}–{dt_fim.strftime("%d/%m/%Y")})…')
        cur.execute(sql_estrategia(dt_ini, dt_fim))
        rows = cur.fetchall()
        agg = agregar_periodo(rows, hierarquia)
        agregados[periodo] = agg
        print(f'  → {len(rows)} linhas · venda total R$ {agg["total"]["venda"]:,.2f}')

    cur.close(); conn.close()

    # Lê meta acumulada (período atual)
    dt_ini, dt_fim = pers['atual']
    print('\nLendo Meta da planilha…')
    meta_por_loja = ler_meta_planilha(dt_ini, dt_fim)
    print(f'  → {len(meta_por_loja)} lojas com meta')

    # Monta lista de lojas com dados dos 3 períodos + meta + cálculos
    todas_lojas = set()
    for ag in agregados.values(): todas_lojas |= set(ag['por_loja'].keys())

    lojas = []
    for nemp in sorted(todas_lojas):
        atual = agregados['atual']['por_loja'].get(nemp, {'venda': 0, 'lucr': 0, 'qtd': 0, 'nome': ''})
        mes   = agregados['mes_ant']['por_loja'].get(nemp, {'venda': 0, 'lucr': 0, 'qtd': 0})
        ano   = agregados['ano_ant']['por_loja'].get(nemp, {'venda': 0, 'lucr': 0, 'qtd': 0})
        meta  = meta_por_loja.get(nemp, 0)
        venda = atual['venda']
        desvio = venda - meta
        ating = (venda / meta) if meta > 0 else None
        # Desvio % vs ano ant e mês ant
        desv_ano = ((venda - ano['venda']) / ano['venda']) if ano['venda'] > 0 else None
        desv_mes = ((venda - mes['venda']) / mes['venda']) if mes['venda'] > 0 else None
        lojas.append({
            'loja': nemp,
            'loja_nome': atual['nome'] or mes.get('nome', '') or ano.get('nome', ''),
            'venda':           venda,
            'lucratividade':   atual['lucr'],
            'qtd':             atual['qtd'],
            'venda_mes_ant':   mes['venda'],
            'venda_ano_ant':   ano['venda'],
            'meta_venda':      meta,
            'desvio':          desvio,
            'ating':           ating,
            'desvio_pct_ano':  desv_ano,
            'desvio_pct_mes':  desv_mes,
        })

    # Compradores (mantido pra eventual filtro)
    todos_comp = set()
    for ag in agregados.values(): todos_comp |= set(ag['por_comprador'].keys())
    compradores = []
    for seqc in sorted(todos_comp):
        atual = agregados['atual']['por_comprador'].get(seqc, {'venda': 0, 'lucr': 0, 'qtd': 0, 'apelido': ''})
        mes   = agregados['mes_ant']['por_comprador'].get(seqc, {'venda': 0, 'lucr': 0, 'qtd': 0})
        ano   = agregados['ano_ant']['por_comprador'].get(seqc, {'venda': 0, 'lucr': 0, 'qtd': 0})
        venda = atual['venda']
        desv_ano = ((venda - ano['venda']) / ano['venda']) if ano['venda'] > 0 else None
        desv_mes = ((venda - mes['venda']) / mes['venda']) if mes['venda'] > 0 else None
        compradores.append({
            'seqcomprador':   seqc,
            'comprador':      atual['apelido'] or mes.get('apelido', '') or ano.get('apelido', ''),
            'venda':           venda,
            'lucratividade':   atual['lucr'],
            'qtd':             atual['qtd'],
            'venda_mes_ant':   mes['venda'],
            'venda_ano_ant':   ano['venda'],
            'desvio_pct_ano':  desv_ano,
            'desvio_pct_mes':  desv_mes,
        })

    # Setores (nível 1)
    todos_setores = set()
    for ag in agregados.values(): todos_setores |= set(ag['por_setor'].keys())
    setores = []
    for s in sorted(todos_setores):
        a = agregados['atual']['por_setor'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0})
        m = agregados['mes_ant']['por_setor'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0})
        an = agregados['ano_ant']['por_setor'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0})
        venda = a['venda']
        setores.append({
            'setor':           s,
            'venda':           venda,
            'lucratividade':   a['lucr'],
            'qtd':             a['qtd'],
            'venda_mes_ant':   m['venda'],
            'venda_ano_ant':   an['venda'],
            'desvio_pct_ano':  ((venda - an['venda']) / an['venda']) if an['venda'] > 0 else None,
            'desvio_pct_mes':  ((venda - m['venda']) / m['venda']) if m['venda'] > 0 else None,
        })

    # Seções (nível 2) — usado no Ranking Seções
    todas_secoes = set()
    for ag in agregados.values(): todas_secoes |= set(ag['por_secao'].keys())
    secoes = []
    for s in sorted(todas_secoes):
        a = agregados['atual']['por_secao'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0, 'setor': ''})
        m = agregados['mes_ant']['por_secao'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0})
        an = agregados['ano_ant']['por_secao'].get(s, {'venda': 0, 'lucr': 0, 'qtd': 0})
        venda = a['venda']
        secoes.append({
            'secao':           s,
            'setor':           a['setor'],
            'venda':           venda,
            'lucratividade':   a['lucr'],
            'qtd':             a['qtd'],
            'venda_mes_ant':   m['venda'],
            'venda_ano_ant':   an['venda'],
            'desvio_pct_ano':  ((venda - an['venda']) / an['venda']) if an['venda'] > 0 else None,
            'desvio_pct_mes':  ((venda - m['venda']) / m['venda']) if m['venda'] > 0 else None,
        })

    # Por loja × seção (apenas o atual — pra filtrar quando seleciona uma loja)
    por_loja_secao = {}
    for nemp, secoes_da_loja in agregados['atual']['por_loja_secao'].items():
        m_loja = agregados['mes_ant']['por_loja_secao'].get(nemp, {})
        an_loja = agregados['ano_ant']['por_loja_secao'].get(nemp, {})
        por_loja_secao[nemp] = []
        for s, info in secoes_da_loja.items():
            m = m_loja.get(s, {'venda': 0})
            an = an_loja.get(s, {'venda': 0})
            venda = info['venda']
            por_loja_secao[nemp].append({
                'secao':           s,
                'setor':           info['setor'],
                'venda':           venda,
                'lucratividade':   info['lucr'],
                'qtd':             info['qtd'],
                'venda_mes_ant':   m.get('venda', 0),
                'venda_ano_ant':   an.get('venda', 0),
                'desvio_pct_ano':  ((venda - an.get('venda', 0)) / an['venda']) if an.get('venda', 0) > 0 else None,
                'desvio_pct_mes':  ((venda - m.get('venda', 0)) / m['venda']) if m.get('venda', 0) > 0 else None,
            })

    # Por comprador × seção (drill-down do comparativo por comprador)
    # União de todos os pares (seqc, secao) entre os 3 períodos
    pares_cs = set()
    for ag in agregados.values():
        for seqc, secs in ag['por_comprador_secao'].items():
            for s in secs.keys():
                pares_cs.add((seqc, s))
    por_comprador_secao = {}
    for seqc, s in sorted(pares_cs):
        a = agregados['atual']['por_comprador_secao'].get(seqc, {}).get(s, {'venda': 0, 'lucr': 0, 'qtd': 0, 'setor': ''})
        m = agregados['mes_ant']['por_comprador_secao'].get(seqc, {}).get(s, {'venda': 0})
        an = agregados['ano_ant']['por_comprador_secao'].get(seqc, {}).get(s, {'venda': 0})
        venda = a['venda']
        if seqc not in por_comprador_secao:
            por_comprador_secao[seqc] = []
        por_comprador_secao[seqc].append({
            'secao':           s,
            'setor':           a.get('setor', ''),
            'venda':           venda,
            'lucratividade':   a['lucr'],
            'qtd':             a['qtd'],
            'venda_mes_ant':   m.get('venda', 0),
            'venda_ano_ant':   an.get('venda', 0),
            'desvio_pct_ano':  ((venda - an.get('venda', 0)) / an['venda']) if an.get('venda', 0) > 0 else None,
            'desvio_pct_mes':  ((venda - m.get('venda', 0)) / m['venda']) if m.get('venda', 0) > 0 else None,
        })

    # Total agregado
    t_atual = agregados['atual']['total']
    t_mes   = agregados['mes_ant']['total']
    t_ano   = agregados['ano_ant']['total']
    meta_total = sum(meta_por_loja.values())
    venda_t = t_atual['venda']
    # Crescimento previsto: projeção linear (venda_atual × dias_mes ÷ dias_corridos)
    primeiro, ontem = pers['atual']
    # último dia do mês corrente
    if primeiro.month == 12:
        next_m = date(primeiro.year + 1, 1, 1)
    else:
        next_m = date(primeiro.year, primeiro.month + 1, 1)
    ultimo_dia_mes = (next_m - timedelta(days=1)).day
    dias_corridos = (ontem - primeiro).days + 1
    proj_mes = (venda_t / dias_corridos * ultimo_dia_mes) if dias_corridos > 0 else 0
    crescimento_previsto = proj_mes - t_ano['venda']  # vs ano anterior mesmo mês

    total = {
        'venda':             venda_t,
        'lucratividade':     t_atual['lucr'],
        'qtd':               t_atual['qtd'],
        'venda_mes_ant':     t_mes['venda'],
        'venda_ano_ant':     t_ano['venda'],
        'meta_venda':        meta_total,
        'desvio':            venda_t - meta_total,
        'ating':             (venda_t / meta_total) if meta_total > 0 else None,
        'desvio_pct_ano':    ((venda_t - t_ano['venda']) / t_ano['venda']) if t_ano['venda'] > 0 else None,
        'desvio_pct_mes':    ((venda_t - t_mes['venda']) / t_mes['venda']) if t_mes['venda'] > 0 else None,
        'venda_media_periodo': venda_t / max(dias_corridos, 1),
        'venda_media_3m':    None,  # TODO
        'crescimento_previsto': crescimento_previsto,
        'projecao_fim_mes':  proj_mes,
        'dias_corridos':     dias_corridos,
        'dias_total_mes':    ultimo_dia_mes,
    }

    out = {
        'periodos': {k: {'inicio': i.isoformat(), 'fim': f.isoformat()} for k, (i, f) in pers.items()},
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'lojas':         lojas,
        'compradores':   compradores,
        'setores':       setores,
        'secoes':        secoes,
        'por_loja_secao':       por_loja_secao,
        'por_comprador_secao':  por_comprador_secao,
        'total':         total,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')

    print(f'\n✓ {OUT_PATH} salvo')
    print(f'  Atual:    R$ {venda_t:,.2f}')
    print(f'  Mês ant:  R$ {t_mes["venda"]:,.2f} (Δ {(total["desvio_pct_mes"] or 0)*100:+.2f}%)')
    print(f'  Ano ant:  R$ {t_ano["venda"]:,.2f} (Δ {(total["desvio_pct_ano"] or 0)*100:+.2f}%)')
    print(f'  Meta:     R$ {meta_total:,.2f} (Ating {(total["ating"] or 0)*100:.2f}%)')


if __name__ == '__main__':
    main()
