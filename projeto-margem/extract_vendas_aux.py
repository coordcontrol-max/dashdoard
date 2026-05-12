#!/usr/bin/env python3
"""Extrai dados auxiliares da planilha de Faturamento Diário (metas + abas que
ainda não tem query SQL) e congela em data/vendas_aux.json.

Status das fontes:
- Metas mensais + Meta Venda diária .. ainda da planilha (preenchidas manuais 1x/mês)
- Promo (venda/margem sem promoção) .. ✓ migrado pra Oracle (SQL_PROMO em extract_vendas_db.py)
- ACRPRE (acordo) .................... ainda da planilha — TODO: query SQL
- PERDA25 (quebras) .................. ainda da planilha — TODO: query SQL
- INVENT25 (inventário) .............. ainda da planilha — TODO: query SQL
- B_Ent (compras) .................... ainda da planilha — TODO: query SQL

Roda 1× quando trocar a planilha de mês (ou alguém atualizar manualmente uma das abas).
"""
import json
import re
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

XLSX = Path('./data/Faturamento_Diario.xlsx')
OUT = Path('./data/vendas_aux.json')
EXCEL_EPOCH = datetime(1899, 12, 30)


def ser2date(n):
    if n is None: return None
    try: return (EXCEL_EPOCH + timedelta(days=int(n))).strftime('%Y-%m-%d')
    except: return None


def main():
    if not XLSX.exists():
        print(f'ERRO: {XLSX} não encontrada', file=sys.stderr); sys.exit(1)

    with zipfile.ZipFile(XLSX) as z:
        wb = z.read('xl/workbook.xml').decode('utf-8')
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
        rid2file = {m.group(1): m.group(2) for m in re.finditer(r'<Relationship\s+Id="(rId\d+)"[^>]*Target="(worksheets/[^"]+)"', rels)}
        name2file = {m.group(1): rid2file.get(m.group(2)) for m in re.finditer(r'<sheet\s+name="([^"]+)"[^/]*r:id="([^"]+)"', wb)}

        sst_xml = z.read('xl/sharedStrings.xml').decode('utf-8')
        si_blocks = re.findall(r'<si[^>]*>(.*?)</si>', sst_xml, re.S)
        sst = []
        for b in si_blocks:
            parts = re.findall(r'<t[^>]*>([^<]*)</t>', b)
            sst.append(''.join(parts))

        CELL_RE = re.compile(r'<c r="([A-Z]+)(\d+)"(?:\s+s="\d+")?(?:\s+t="(\w+)")?\s*(?:/>|>(.*?)</c>)', re.S)

        def parse_row(content):
            cells = {}
            for m in CELL_RE.finditer(content):
                col, _, ctype, inner = m.groups()
                val = None
                if inner:
                    vm = re.search(r'<v>([^<]*)</v>', inner)
                    if vm:
                        v = vm.group(1)
                        if ctype == 's':
                            try: val = sst[int(v)]
                            except: val = None
                        else:
                            try: val = float(v)
                            except: val = v
                cells[col] = val
            return cells

        def load_rows(sheet_name):
            f = name2file.get(sheet_name)
            if not f: return []
            sh = z.read(f'xl/{f}').decode('utf-8')
            rows_xml = re.findall(r'<row r="(\d+)"[^>]*>(.*?)</row>', sh, re.S)
            return [(int(rn), parse_row(c)) for rn, c in rows_xml]

        def get_cell(sheet_name, col, rn):
            for n, r in load_rows(sheet_name):
                if n == rn:
                    return r.get(col)
            return None

        # === Metas mensais (do FATURAMENTO L40-43) ===
        # Lemos os valores cached (já calculados) das células
        fat_rows = {n: r for n, r in load_rows('FATURAMENTO')}

        meta_venda_total = fat_rows.get(40, {}).get('E')      # E40
        meta_margem_pct = fat_rows.get(41, {}).get('F')       # F41 = % margem (0.205)
        meta_margem_pdv_pct = fat_rows.get(42, {}).get('F')   # F42 = % pdv (0.20)
        meta_quebra = fat_rows.get(40, {}).get('AD')          # AD40 (= 0.6% × meta venda)
        # Meta de compra fixa (sobrescreve o que vier da planilha em AI40)
        meta_compra = 45_712_500
        meta_quebra_pct = 0.006   # 0.6% (fórmula = 0.6%*D38)

        metas = {
            'meta_venda_total':    meta_venda_total,
            'meta_margem_pct':     meta_margem_pct,
            'meta_margem_pdv_pct': meta_margem_pdv_pct,
            'meta_quebra_pct':     meta_quebra_pct,
            'meta_quebra':         meta_quebra,
            'meta_compra':         meta_compra,
        }

        # === Meta Venda diária (aba 'Meta Venda', cols A=DATA, C=valor) ===
        # Soma por data (a planilha tem várias linhas por dia)
        meta_diaria = {}
        for rn, r in load_rows('Meta Venda'):
            a = r.get('A'); c = r.get('C')
            if isinstance(a, (int, float)) and isinstance(c, (int, float)):
                d = ser2date(a)
                meta_diaria[d] = meta_diaria.get(d, 0) + c

        # === Promo: agrega D (venda c/promo) e E (margem s/promo) por dia ===
        promo_diario = {}
        for rn, r in load_rows('Promo'):
            b = r.get('B'); d = r.get('D'); e = r.get('E')
            if isinstance(b, (int, float)):
                k = ser2date(b)
                p = promo_diario.setdefault(k, {'venda_promo': 0, 'margem_sem_promo': 0})
                if isinstance(d, (int, float)): p['venda_promo'] += d
                if isinstance(e, (int, float)): p['margem_sem_promo'] += e

        # === ACRPRE: agrega C (acordo) por dia ===
        acrpre_diario = {}
        for rn, r in load_rows('ACRPRE'):
            b = r.get('B'); c = r.get('C')
            if isinstance(b, (int, float)) and isinstance(c, (int, float)):
                k = ser2date(b)
                acrpre_diario[k] = acrpre_diario.get(k, 0) + c

        # === PERDA25: a fórmula filtra C="" (linhas total, sem categoria) ===
        perda_diario = {}
        for rn, r in load_rows('PERDA25'):
            b = r.get('B'); c_col = r.get('C'); d = r.get('D')
            # só linhas com B (data) preenchido E coluna C VAZIA (totais)
            if isinstance(b, (int, float)) and (c_col is None or c_col == '') and isinstance(d, (int, float)):
                k = ser2date(b)
                perda_diario[k] = perda_diario.get(k, 0) + d

        # === INVENT25: idem, C="" ===
        invent_diario = {}
        for rn, r in load_rows('INVENT25'):
            b = r.get('B'); c_col = r.get('C'); d = r.get('D')
            if isinstance(b, (int, float)) and (c_col is None or c_col == '') and isinstance(d, (int, float)):
                k = ser2date(b)
                invent_diario[k] = invent_diario.get(k, 0) + d

        # === B_Ent: agrega E (compra) por dia ===
        bent_diario = {}
        for rn, r in load_rows('B_Ent'):
            a = r.get('A'); e = r.get('E')
            if isinstance(a, (int, float)) and isinstance(e, (int, float)):
                k = ser2date(a)
                bent_diario[k] = bent_diario.get(k, 0) + e

    out = {
        'gerado_em': datetime.now().isoformat(timespec='seconds'),
        'fonte': 'planilha Faturamento_Diario.xlsx',
        'metas_mensais': metas,
        'meta_venda_diaria': meta_diaria,
        'promo': promo_diario,
        'acordo_recebido': acrpre_diario,
        'quebras': perda_diario,
        'inventario': invent_diario,
        'compras': bent_diario,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'✓ salvo em {OUT}')
    print(f'METAS MENSAIS: venda R$ {meta_venda_total or 0:,.0f} · margem {(meta_margem_pct or 0)*100:.2f}% · pdv {(meta_margem_pdv_pct or 0)*100:.2f}% · quebra R$ {meta_quebra or 0:,.0f} · compra R$ {meta_compra or 0:,.0f}')
    print(f'META VENDA DIÁRIA: {len(meta_diaria)} dias mapeados (sum R$ {sum(meta_diaria.values()):,.0f})')
    print(f'PROMO: {len(promo_diario)} dias')
    print(f'ACORDO: {len(acrpre_diario)} dias')
    print(f'QUEBRAS: {len(perda_diario)} dias (total R$ {sum(perda_diario.values()):,.2f})')
    print(f'INVENTÁRIO: {len(invent_diario)} dias (total R$ {sum(invent_diario.values()):,.2f})')
    print(f'COMPRAS: {len(bent_diario)} dias (total R$ {sum(bent_diario.values()):,.0f})')


if __name__ == '__main__':
    main()
