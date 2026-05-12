#!/usr/bin/env python3
"""Extrai a aba FATURAMENTO completa: tabela principal + KPIs + setores."""
import json
import re
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

XLSX_PATH = Path('./data/Faturamento_Diario.xlsx')
OUT_PATH = Path('./data/vendas.json')
SHEET_FILE = 'xl/worksheets/sheet1.xml'

EXCEL_EPOCH = datetime(1899, 12, 30)

# ---------- Bloco principal (linhas 7-37, total 38) ----------
COLUNAS_PRINCIPAL = {
    'B':  'data_serial',
    'C':  'dia_semana',
    # FATURAMENTO
    'D':  'meta_venda',
    'E':  'realizado',
    'F':  'diff_rs',
    'G':  'diff_pct',
    'H':  'venda_promo',
    'I':  'pct_promo',
    'J':  'venda_sem_promo',
    'K':  'pct_sem_promo',
    # MARGEM
    'L':  'meta_margem_geral',
    'M':  'margem_realizada',
    'N':  'margem_diff_rs',
    'O':  'margem_diff_pct',
    'P':  'verba',
    'Q':  'verba_pct',
    'R':  'meta_margem_pdv',
    'S':  'margem_pdv',
    'T':  'margem_pdv_diff_rs',
    'U':  'margem_pdv_diff_pct',
    'V':  'acordo_recebido',
    'W':  'acordo_pct',
    'X':  'margem_sem_promo',
    'Y':  'margem_sem_promo_pct',
    'Z':  'margem_com_promo',
    'AA': 'margem_com_promo_pct',
    # QUEBRAS E INVENTÁRIOS
    'AB': 'quebras',
    'AC': 'quebras_pct',
    'AD': 'inventario',
    'AE': 'inventario_pct',
    # COMPRA
    'AG': 'compra',
    'AH': 'compra_851',
    'AI': 'compra_realizado',
}

# ---------- Setores (linhas 48-78, total 79) ----------
SETORES = [
    {'key': 'bovino',         'nome': 'Bovino',         'cols': {'venda': 'D', 'part': 'E', 'margem': 'F', 'mpct': 'G'}},
    {'key': 'aves',           'nome': 'Aves',           'cols': {'venda': 'H', 'part': 'I', 'margem': 'J', 'mpct': 'K'}},
    {'key': 'linguicas',      'nome': 'Linguiças',      'cols': {'venda': 'L', 'part': 'M', 'margem': 'N', 'mpct': 'O'}},
    {'key': 'natalinos',      'nome': 'Natalinos',      'cols': {'venda': 'P', 'part': 'Q', 'margem': 'R', 'mpct': 'S'}},
    {'key': 'peixes',         'nome': 'Peixes',         'cols': {'venda': 'T', 'part': 'U', 'margem': 'V', 'mpct': 'W'}},
    {'key': 'suino',          'nome': 'Suíno',          'cols': {'venda': 'X', 'part': 'Y', 'margem': 'Z', 'mpct': 'AA'}},
    {'key': 'acougue_geral',  'nome': 'Açougue Geral',  'cols': {'venda': 'AB', 'part': 'AC', 'margem': 'AD', 'mpct': 'AE'}},
    {'key': 'flv',            'nome': 'FLV',            'cols': {'venda': 'AF', 'part': 'AG', 'margem': 'AH', 'mpct': 'AI', 'quebra': 'AJ', 'quebra_pct': 'AK'}},
    {'key': 'liquida',        'nome': 'Liquida',        'cols': {'venda': 'AL', 'part': 'AM', 'margem': 'AN', 'mpct': 'AO'}},
]

CELL_RE = re.compile(
    r'<c r="([A-Z]+)(\d+)"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)',
    re.S
)
VAL_RE = re.compile(r'<v>([^<]*)</v>', re.S)


def parse_shared_strings(z):
    raw = z.read('xl/sharedStrings.xml').decode('utf-8')
    blocks = re.findall(r'<si[^>]*>(.*?)</si>', raw, re.S)
    out = []
    for b in blocks:
        parts = re.findall(r'<t[^>]*>([^<]*)</t>', b)
        out.append(''.join(parts))
    return out


def parse_row(content, sst):
    cells = {}
    for m in CELL_RE.finditer(content):
        col, _, ctype, inner = m.groups()
        val = None
        if inner:
            vm = VAL_RE.search(inner)
            if vm:
                v = vm.group(1)
                if ctype == 's':
                    try: val = sst[int(v)]
                    except (ValueError, IndexError): val = None
                elif ctype == 'str':
                    val = v
                elif ctype == 'b':
                    val = v == '1'
                else:
                    try: val = float(v)
                    except ValueError: val = v
        cells[col] = val
    return cells


def excel_serial_to_date(n):
    if n is None: return None
    try:
        return (EXCEL_EPOCH + timedelta(days=int(n))).strftime('%Y-%m-%d')
    except (TypeError, ValueError):
        return None


def main():
    if not XLSX_PATH.exists():
        print(f'ERRO: planilha não encontrada em {XLSX_PATH}', file=sys.stderr)
        sys.exit(1)

    with zipfile.ZipFile(XLSX_PATH) as z:
        sheet_xml = z.read(SHEET_FILE).decode('utf-8')
        sst = parse_shared_strings(z)

    rows_xml = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet_xml, re.S)
    by_num = {int(rn): parse_row(c, sst) for rn, c in rows_xml}

    # ----- Tabela principal (dias 7-37) -----
    dias = []
    for rownum in range(7, 38):
        cells = by_num.get(rownum, {})
        if not cells: continue
        registro = {'row': rownum}
        for col, key in COLUNAS_PRINCIPAL.items():
            registro[key] = cells.get(col)
        registro['data'] = excel_serial_to_date(registro.pop('data_serial'))
        registro['fechado'] = isinstance(registro.get('realizado'), (int, float)) and registro['realizado'] > 0
        dias.append(registro)

    # ----- Totais principal (linha 38) -----
    totais = {}
    cells_total = by_num.get(38, {})
    for col, key in COLUNAS_PRINCIPAL.items():
        if col in ('B', 'C'): continue
        totais[key] = cells_total.get(col)

    # ----- KPIs (linhas 40-43) -----
    # L40-43 organizados em colunas:
    #   D-F: META VENDA / MARGEM / MARGEM PDV / COMPOSIÇÃO (valor + %)
    #   H-J: META VENDA AC + REALIZADO + DIFF + ATING
    #   L-N: META MARGEM GERAL AC ...
    #   P-R: META MARGEM PDV AC ...
    #   T-V: ACOMP ATACADO + MARGEM + VERBA
    #   AB-AD: META QUEBRA ...
    #   AG-AI: META COMPRA AC ...
    L40 = by_num.get(40, {}); L41 = by_num.get(41, {}); L42 = by_num.get(42, {}); L43 = by_num.get(43, {})

    # metas do mês inteiro (linhas 40-43, coluna E)
    metas_mes = {}
    for rn in (40, 41, 42, 43):
        r = by_num.get(rn, {})
        nome = r.get('D')
        valor = r.get('E')
        if isinstance(nome, str) and nome.strip() and isinstance(valor, (int, float)):
            metas_mes[nome.strip()] = valor

    def kpi(col, meta_mes_key=None):
        # Cada KPI ocupa 1 coluna nas linhas 40-43:
        #   L40 col = meta acumulada até o último dia fechado
        #   L41 col = realizado acumulado
        #   L42 col = diff (realizado - meta_acumulada)
        #   L43 col = ating (realizado / meta_mes)
        return {
            'meta_mes':       metas_mes.get(meta_mes_key) if meta_mes_key else None,
            'meta_ate_hoje':  L40.get(col),
            'realizado':      L41.get(col),
            'diff':           L42.get(col),
            'ating':          L43.get(col),
        }

    kpis = {
        'venda':        kpi('J',  'META VENDA'),
        'margem_geral': kpi('N',  'META MARGEM'),
        'margem_pdv':   kpi('R',  'META MARGEM PDV'),
        'quebra':       kpi('AD', None),  # meta quebra está em AD40 (linha 40)
        'compra':       kpi('AI', None),  # meta compra está em AI40
    }
    # acomp atacado: bloco T-V só com Margem/Verba
    kpis['acomp_atacado'] = {
        'margem':       L41.get('V'),
        'verba':        L42.get('V'),
        'verba_pct':    L43.get('V'),
    }
    # Para QUEBRA e COMPRA, "meta_mes" = "meta acumulada" (a planilha só fornece um valor único)
    kpis['quebra']['meta_mes'] = L40.get('AD')
    kpis['compra']['meta_mes'] = L40.get('AI')
    kpis['composicao_pct'] = metas_mes.get('META COMPOSIÇÃO')

    # ----- Setores (linhas 48-78) + total na 79 -----
    setores_out = {}
    for setor in SETORES:
        s_dias = []
        for rownum in range(48, 79):
            cells = by_num.get(rownum, {})
            if not cells: continue
            sd = {'row': rownum}
            sd['data'] = excel_serial_to_date(cells.get('B'))
            sd['dia_semana'] = cells.get('C')
            sd['venda'] = cells.get(setor['cols']['venda'])
            sd['part_pct'] = cells.get(setor['cols']['part'])
            sd['margem'] = cells.get(setor['cols']['margem'])
            sd['margem_pct'] = cells.get(setor['cols']['mpct'])
            if 'quebra' in setor['cols']:
                sd['quebra'] = cells.get(setor['cols']['quebra'])
                sd['quebra_pct'] = cells.get(setor['cols']['quebra_pct'])
            sd['fechado'] = isinstance(sd['venda'], (int, float)) and sd['venda'] > 0
            s_dias.append(sd)

        # totais (linha 79)
        c79 = by_num.get(79, {})
        tot = {
            'venda':       c79.get(setor['cols']['venda']),
            'part_pct':    c79.get(setor['cols']['part']),
            'margem':      c79.get(setor['cols']['margem']),
            'margem_pct':  c79.get(setor['cols']['mpct']),
        }
        if 'quebra' in setor['cols']:
            tot['quebra'] = c79.get(setor['cols']['quebra'])
            tot['quebra_pct'] = c79.get(setor['cols']['quebra_pct'])

        setores_out[setor['key']] = {
            'nome': setor['nome'],
            'totais': tot,
            'dias': s_dias,
        }

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'mes_referencia': dias[0]['data'][:7] if dias and dias[0].get('data') else None,
        'kpis': kpis,
        'totais_principal': totais,
        'dias': dias,
        'setores': setores_out,
    }

    fechados = sum(1 for d in dias if d['fechado'])
    print(f'Total dias: {len(dias)} · fechados: {fechados} · pendentes: {len(dias)-fechados}')
    print(f'Mês referência: {out["mes_referencia"]}')
    print(f'KPI Venda: meta_mês=R$ {kpis["venda"]["meta_mes"] or 0:,.0f} · até hoje=R$ {kpis["venda"]["meta_ate_hoje"] or 0:,.0f} · real=R$ {kpis["venda"]["realizado"] or 0:,.0f} · ating={kpis["venda"]["ating"] or 0:.2%}')
    print(f'KPI Margem Geral: ating={kpis["margem_geral"]["ating"] or 0:.2%}')
    print(f'KPI Quebra: ating={kpis["quebra"]["ating"] or 0:.2%}')
    print(f'Setores carregados: {len(setores_out)}')

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')
    print(f'✓ salvo em {OUT_PATH}')


if __name__ == '__main__':
    main()
