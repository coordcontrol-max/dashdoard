#!/usr/bin/env python3
"""Extrai dados da Planilha1 com hierarquia inferida pelos estilos da coluna B."""
import json
import re
import sys
import zipfile
from pathlib import Path

XLSX_PATH = Path('./data/Atualizacao_de_Margem.xlsx')
OUT_PATH = Path('./data/data.json')
SHEET_FILE = 'xl/worksheets/sheet6.xml'  # Planilha1 conforme rels

# Mapa de estilo da coluna B -> nivel hierárquico
NIVEL_POR_ESTILO = {
    '45': 1,  # Departamento (ex: Mercearia)
    '46': 2,  # Subdepartamento (ex: Commodities)
    '47': 3,  # Categoria (ex: Arroz)
    '48': 4,  # Item / Subcategoria (ex: Arroz 5kg)
    '49': 4,  # variante de item
}

# Cabeçalhos baseados no que está na linha 4 do Excel (cabeçalho real)
COLUNAS = {
    'A': 'secao',
    'B': 'categoria',
    'C': 'margem_vivendas',
    'D': 'margem_scanntech',
    'E': 'margem_concorrente',
    'F': 'margem_praticada_total',
    'G': 'margem_praticada_sem_promo',
    'H': 'proposta_nova_margem',
    'I': 'diferenca_margem',
    'J': 'venda_total_ult_tri',
    'K': 'media_venda',
    'L': 'lucratividade_scanntech',
    'M': 'lucratividade_concorrente',
    'N': 'lucratividade_vivendas',
    'O': 'lucratividade_proposta',
}


def parse_shared_strings(z):
    raw = z.read('xl/sharedStrings.xml').decode('utf-8')
    blocks = re.findall(r'<si>(.*?)</si>', raw, re.S)
    out = []
    for b in blocks:
        parts = re.findall(r'<t[^>]*>([^<]*)</t>', b)
        out.append(''.join(parts))
    return out


def col_letter(ref):
    # 'A12' -> 'A'; 'AB7' -> 'AB'
    m = re.match(r'^([A-Z]+)\d+$', ref)
    return m.group(1) if m else None


def main():
    if not XLSX_PATH.exists():
        print(f'ERRO: planilha não encontrada em {XLSX_PATH}', file=sys.stderr)
        sys.exit(1)

    with zipfile.ZipFile(XLSX_PATH) as z:
        sheet_xml = z.read(SHEET_FILE).decode('utf-8')
        sst = parse_shared_strings(z)

    rows_xml = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sheet_xml, re.S)
    # Match each <c .../> (self-closing) ou <c ...>...</c> como bloco isolado
    cell_re = re.compile(
        r'<c r="([A-Z]+\d+)"(?:\s+s="(\d+)")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)',
        re.S
    )
    val_re = re.compile(r'<v>([^<]*)</v>', re.S)

    data = []
    for rownum_str, content in rows_xml:
        rownum = int(rownum_str)
        # cabeçalho está na linha 4. Pular tudo antes (banner está na linha 2 e 3)
        if rownum <= 4:
            continue

        cells = {}
        b_style = None
        for m in cell_re.finditer(content):
            ref, style, ctype, inner = m.groups()
            col = col_letter(ref)
            if col not in COLUNAS:
                continue
            if col == 'B' and style:
                b_style = style
            # Procura <v> APENAS dentro do conteúdo dessa célula (inner)
            val = None
            if inner is not None:
                vm = val_re.search(inner)
                if vm:
                    val = vm.group(1)
            if val is None or val == '':
                cells[col] = None
                continue
            if ctype == 's':
                try:
                    cells[col] = sst[int(val)]
                except (ValueError, IndexError):
                    cells[col] = None
            elif ctype == 'str':
                cells[col] = val
            elif ctype == 'b':
                cells[col] = val == '1'
            else:
                try:
                    cells[col] = float(val)
                except ValueError:
                    cells[col] = val

        if not cells:
            continue
        # Pular linhas totalmente vazias
        if all(v in (None, '') for v in cells.values()):
            continue

        nivel = NIVEL_POR_ESTILO.get(b_style)
        # Se não conseguimos identificar nível mas a linha tem dados, considera nível 4 (item)
        if nivel is None and (cells.get('C') is not None or cells.get('J') is not None):
            nivel = 4

        registro = {
            'id': rownum,
            'nivel': nivel,
        }
        for col, key in COLUNAS.items():
            registro[key] = cells.get(col)
        # Normaliza strings
        for k in ('secao', 'categoria'):
            if registro[k] is not None:
                registro[k] = str(registro[k]).strip()

        data.append(registro)

    # Estatísticas
    contagem_nivel = {}
    for r in data:
        contagem_nivel[r['nivel']] = contagem_nivel.get(r['nivel'], 0) + 1
    print('Total registros:', len(data))
    print('Por nível:', dict(sorted(contagem_nivel.items(), key=lambda x: (x[0] is None, x[0]))))
    sem_nivel = [r for r in data if r['nivel'] is None]
    if sem_nivel:
        print(f'⚠ {len(sem_nivel)} linhas sem nível — vão como nível 4')
        for r in sem_nivel[:5]:
            print(' ', r['id'], r['secao'], r['categoria'])
        for r in data:
            if r['nivel'] is None:
                r['nivel'] = 4

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    print(f'✓ salvo em {OUT_PATH}')


if __name__ == '__main__':
    main()
