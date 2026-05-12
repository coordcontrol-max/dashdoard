#!/usr/bin/env python3
"""Extrai a planilha de Ruptura → data/ruptura.json.

Abas usadas:
- Evolução Diária (sheet1): pivot Comprador × Dia, geral e 20×80
- Template v1 (sheet2): ranking de compradores e lojas, geral e 20×80
- FORNECEDOR (sheet3): ranking dos fornecedores
- Itens geral (sheet7): TODOS os SKUs zerados (loja, comprador, produto, código, média venda)
- Itens 20x80 (sheet8): subset dos 20×80 (pra marcar flag is_20x80)
"""
import json
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

XLSX_PATH = Path('./data/Ruptura.xlsx')
OUT_PATH = Path('./data/ruptura.json')

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
                else:
                    try: val = float(v)
                    except ValueError: val = v
        cells[col] = val
    return cells


def load_sheet(z, sheetfile, sst):
    sh = z.read(f'xl/worksheets/{sheetfile}').decode('utf-8')
    rows_xml = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sh, re.S)
    return {int(rn): parse_row(c, sst) for rn, c in rows_xml}


def is_num(v): return isinstance(v, (int, float)) and not (isinstance(v, float) and (v != v))


def s(v): return str(v).strip() if v is not None else None


# ===== Extratores =====

def extrair_evolucao(rows):
    """Lê linhas 4-19 (geral) e 26-41 (20x80) da Evolução Diária."""
    header_geral = rows.get(4, {})
    header_20 = rows.get(26, {})

    # Datas: cols C, D, E, F... do header (B é "🔴 ATUAL", já capturado separado)
    def datas_de(header):
        out = []
        for col in 'CDEFGHIJKLMNOPQRSTUVWX':
            v = header.get(col)
            if v: out.append({'col': col, 'data': str(v).strip()})
        return out

    datas = datas_de(header_geral)

    def lista(rows_idx, datas_lst):
        out = []
        for rn in rows_idx:
            r = rows.get(rn, {})
            nome = s(r.get('A'))
            atual = r.get('B')
            if not nome: continue
            por_dia = {d['data']: r.get(d['col']) for d in datas_lst if is_num(r.get(d['col']))}
            out.append({
                'nome': nome,
                'atual': atual if is_num(atual) else None,
                'por_dia': por_dia,
            })
        return out

    geral = lista(range(5, 20), datas)
    vinte = lista(range(27, 42), datas)
    return {'datas': [d['data'] for d in datas], 'geral': geral, '20x80': vinte}


def extrair_template_compradores(rows):
    """Linhas 7-21 do Template v1: B-F (geral) e H-L (20x80)."""
    geral, vinte = [], []
    for rn in range(7, 25):
        r = rows.get(rn, {})
        b = s(r.get('B'))
        if b and not b.startswith('Compradores') and 'RUPTURA' not in b:
            if is_num(r.get('C')) and is_num(r.get('E')):
                geral.append({
                    'nome': b,
                    'skus': r.get('C'),
                    'zerados': r.get('D'),
                    'pct': r.get('E'),
                    'rank': int(r.get('F')) if is_num(r.get('F')) else None,
                })
        h = s(r.get('H'))
        if h and not h.startswith('Compradores') and 'RUPTURA' not in h:
            if is_num(r.get('I')) and is_num(r.get('K')):
                vinte.append({
                    'nome': h,
                    'skus': r.get('I'),
                    'zerados': r.get('J'),
                    'pct': r.get('K'),
                    'rank': int(r.get('L')) if is_num(r.get('L')) else None,
                })
    return {'geral': geral, '20x80': vinte}


def extrair_template_lojas(rows):
    """A partir da linha 27 — até onde tiver dados."""
    geral, vinte = [], []
    for rn in range(27, 200):
        r = rows.get(rn, {})
        b = s(r.get('B'))
        h = s(r.get('H'))
        if not b and not h: continue
        if b and 'RUPTURA' not in b and not b.startswith('Compradores'):
            if is_num(r.get('C')):
                geral.append({
                    'nome': b,
                    'skus': r.get('C'),
                    'zerados': r.get('D'),
                    'pct': r.get('E'),
                    'rank': int(r.get('F')) if is_num(r.get('F')) else None,
                })
        if h and 'RUPTURA' not in h and not h.startswith('Compradores'):
            if is_num(r.get('I')):
                vinte.append({
                    'nome': h,
                    'skus': r.get('I'),
                    'zerados': r.get('J'),
                    'pct': r.get('K'),
                    'rank': int(r.get('L')) if is_num(r.get('L')) else None,
                })
    return {'geral': geral, '20x80': vinte}


def extrair_fornecedores(rows):
    """Aba FORNECEDOR — linhas a partir de 11 (linha 10 é cabeçalho A=Fornecedor B=ITENS_SKU C=zerados D=%)."""
    out = []
    # A coluna principal pode ser A (lista geral) e G (top 15 piores). Vou usar A.
    for rn in sorted(rows.keys()):
        if rn < 11: continue
        r = rows[rn]
        nome = s(r.get('A'))
        if not nome: continue
        if is_num(r.get('B')) and is_num(r.get('D')):
            out.append({
                'nome': nome,
                'skus': r.get('B'),
                'zerados': r.get('C'),
                'pct': r.get('D'),
            })
    # ordena por pct desc
    out.sort(key=lambda x: -(x.get('pct') or 0))
    return out


def extrair_itens(rows):
    """Aba Itens geral — todos os SKUs zerados."""
    out = []
    for rn in sorted(rows.keys()):
        if rn == 1: continue  # header
        r = rows[rn]
        loja = s(r.get('A'))
        comprador = s(r.get('B'))
        produto = s(r.get('C'))
        codigo = r.get('D')
        media = r.get('E')
        if not (loja and comprador and produto): continue
        out.append({
            'loja': loja,
            'comprador': comprador,
            'produto': produto,
            'codigo': int(codigo) if is_num(codigo) else codigo,
            'media_venda': media if is_num(media) else None,
        })
    return out


def extrair_itens_20x80_set(rows):
    """Retorna set de chaves (loja|comprador|codigo) que estão em Itens 20x80."""
    keys = set()
    for rn in sorted(rows.keys()):
        if rn == 1: continue
        r = rows[rn]
        loja = s(r.get('A'))
        comprador = s(r.get('B'))
        codigo = r.get('D')
        if loja and comprador and is_num(codigo):
            keys.add(f"{loja}|{comprador}|{int(codigo)}")
    return keys


def main():
    if not XLSX_PATH.exists():
        print(f'ERRO: planilha não encontrada em {XLSX_PATH}', file=sys.stderr)
        sys.exit(1)

    with zipfile.ZipFile(XLSX_PATH) as z:
        sst = parse_shared_strings(z)
        sh1 = load_sheet(z, 'sheet1.xml', sst)   # Evolução
        sh2 = load_sheet(z, 'sheet2.xml', sst)   # Template
        sh3 = load_sheet(z, 'sheet3.xml', sst)   # Fornecedor
        sh7 = load_sheet(z, 'sheet7.xml', sst)   # Itens geral
        sh8 = load_sheet(z, 'sheet8.xml', sst)   # Itens 20x80

    evolucao = extrair_evolucao(sh1)
    compradores = extrair_template_compradores(sh2)
    lojas = extrair_template_lojas(sh2)
    fornecedores = extrair_fornecedores(sh3)
    itens = extrair_itens(sh7)
    itens_20_keys = extrair_itens_20x80_set(sh8)

    # Marca cada item com is_20x80
    for it in itens:
        if is_num(it.get('codigo')):
            it['is_20x80'] = f"{it['loja']}|{it['comprador']}|{int(it['codigo'])}" in itens_20_keys
        else:
            it['is_20x80'] = False

    # KPIs globais (do template — pega a linha "Total Geral" se existir, senão soma)
    def total_de(lista_rank):
        if not lista_rank: return None
        skus = sum((r.get('skus') or 0) for r in lista_rank)
        zerados = sum((r.get('zerados') or 0) for r in lista_rank)
        return {'skus': skus, 'zerados': zerados, 'pct': zerados / skus if skus else 0}

    kpis = {
        'total_geral': total_de(compradores['geral']),
        'total_20x80': total_de(compradores['20x80']),
        'meta_geral': 0.12,  # META 12% conforme planilha
        'fornecedores_em_ruptura': len([f for f in fornecedores if (f.get('pct') or 0) >= 1.0]),  # 100% zerados
    }

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'kpis': kpis,
        'evolucao_diaria': evolucao,
        'ranking_compradores': compradores,
        'ranking_lojas': lojas,
        'ranking_fornecedores': fornecedores,
        'itens': itens,
    }

    print(f'Datas de evolução: {evolucao["datas"]}')
    print(f'Compradores (geral): {len(compradores["geral"])} · (20x80): {len(compradores["20x80"])}')
    print(f'Lojas (geral): {len(lojas["geral"])} · (20x80): {len(lojas["20x80"])}')
    print(f'Fornecedores: {len(fornecedores)}')
    print(f'Itens zerados (geral): {len(itens)} · 20x80: {sum(1 for x in itens if x["is_20x80"])}')
    if kpis['total_geral']:
        print(f'KPI geral: {kpis["total_geral"]["skus"]:.0f} SKUs, {kpis["total_geral"]["zerados"]:.0f} zerados, {kpis["total_geral"]["pct"]*100:.2f}%')

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, default=str), encoding='utf-8')
    print(f'✓ salvo em {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
