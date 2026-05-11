"""Classificador do Fluxo de Caixa — transforma rawOracle/{ano-mes}__fluxo_*
em fatos do fluxo no formato:
    (DATA, NROEMPRESA, BANCO, LINHA, VALOR)

V1: classifica por CODESPECIE pra fluxo_pago + por descrição do FI_OPERACAO
pra fluxo_opfin. fluxo_juros tem LINHA fixa "Juros e Multas".

LINHAs usadas devem existir em meta/linhasFluxo (cadastrado pelo user).
Quando não existir, marca como "Não classificado" e gera warning.
"""
from __future__ import annotations
import datetime as dt


def _to_date(v):
    if v is None: return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.date() if isinstance(v, dt.datetime) else v
    if isinstance(v, str):
        try:
            return dt.datetime.fromisoformat(v.replace("Z", "+00:00")).date()
        except Exception:
            for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%dT%H:%M:%S"):
                try: return dt.datetime.strptime(v[:19], fmt).date()
                except Exception: pass
    return None


def _val(row: dict, *names):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
        if n.upper() in row and row[n.upper()] is not None:
            return row[n.upper()]
        if n.lower() in row and row[n.lower()] is not None:
            return row[n.lower()]
    return None


# ─── BASE_PAGO (fluxo_pago) — codoperacao 5 + 6 ───────────────────────────
# CODESPECIE → LINHA do fluxo. Mapa baseado nas espécies que aparecem em
# títulos a receber/pagar. Quando codespecie é desconhecido, vai pra
# "Não classificado" e gera warning pra o user cadastrar.
CODESPECIE_TO_LINHA_FLUXO = {
    # --- ENTRADAS (vendas/recbtos) ---
    "CARTAO":  "Recbto de Venda em Crédito",
    "CARDEB":  "Recbto de Venda em Débito",
    "TICKET":  "Recbto de Venda em Ticket",
    "CARDIG":  "Recbto de Venda em PIX",        # carteira digital
    "DRCOL":   "Recbto de Venda entre Unidades",
    "RECIC":   "Reciclagem E Osso",
    "CONVEN":  "Recbto de Convênios (Terceiros)",
    # Acordos / contratos comerciais (mesmos do BASE3 do DRE)
    "ACRA22": "Recbto de Contratos", "ACRA23": "Recbto de Contratos",
    "ACRA24": "Recbto de Contratos", "ACRA25": "Recbto de Contratos",
    "ACRCOM": "Recbto de Contratos", "ACREX2": "Recbto de Contratos",
    "ACREXT": "Recbto de Contratos", "ACRFOR": "Recbto de Contratos",
    "ACRINA": "Recbto de Contratos", "ACRINT": "Recbto de Contratos",
    "ACRLOG": "Recbto de Contratos", "ACRMGM": "Recbto de Contratos",
    "ACRMKT": "Recbto de Contratos", "ACRPEN": "Recbto de Contratos",
    "ACRPON": "Recbto de Contratos", "ACRPRE": "Recbto de Contratos",
    "ACRQUE": "Recbto de Contratos", "ACRTRO": "Recbto de Contratos",
    "ACRXTR": "Recbto de Contratos", "CONTRT": "Recbto de Contratos",
    "DEVREC": "Recbto de Contratos",            # Devolução fornecedor (recebimento)
    # --- FORNECEDORES (saídas) ---
    "DUPP":   "(-) Fornecedores De Mercadorias",
    "DUPRPD": "(-) Fornecedores De Mercadorias",
    "DPCOL":  "(-) Pagto de Compra Entre Unidades",
    "ADIAFO": "Adiantamento A Fornecedores",
    # --- DESPESAS COM PESSOAL ---
    "ORDSAL": "Salarios E Ordenados Operaçao",
    "SALARO": "Salarios E Ordenados Operaçao",
    "SALADM": "Salarios E Ordenados ADM",
    "SALCOM": "Salarios E Ordenados Comercial",
    "ALIMEN": "Alimentacao Operaçao",
    "ALIADM": "Alimentação Adm",
    "TRANSV": "Transporte",
    "VALETR": "Transporte",
    "VTFOLH": "Transporte",
    "FERIAS": "Ferias",
    "FERIA2": "Ferias ADM",
    "PREMIO": "Premios e Bonus Operaçao",
    "BONUS":  "Premios e Bonus Operaçao",
    "FGTSRE": "Fgts Multa Recisoria",
    "FGTSR2": "Fgts Multa Recisoria ADM",
    "PESEXA": "Assistencia Medica E Hospitalar",
    "PLANO":  "Plano De Saude",
    "PLANO2": "Plano De Saude ADM",
    "EPI2":   "Uniformes E Epis ADM",
    "INTRAB": "Custas Judiciais Trabalhistas",
    "CONT":   "Contribuicao Sindical",
    "INFOL2": "Adiantamento De Salario",
    # --- SERVIÇOS PÚBLICOS ---
    "ENERGI": "Energia Eletrica",
    "AGUA":   "Agua e Esgoto",
    "TELEF":  "Telefone",
    # --- ALUGUÉIS ---
    "ALUG":   "Aluguel De Imoveis",
    # --- MANUTENÇÃO ---
    "MANUTE": "Manutencao da Loja",
    "EQUIP":  "Material E Equipamentos Da Operação",
    "MAEQLJ": "Manutenção Construçao E Reformas",
    "INFEQ":  "Computadores e Perifericos",
    "INFEQ2": "Computadores e Perifericos ADM",
    # --- PUBLICIDADE ---
    "PROPAG": "Agencias de Propaganda",
    "MIDIA":  "Anuncios em Midia Social",
    "PANFLE": "Panfletagem",
    "IMPRES": "Material Impresso Em Tabloide",
    "PROREC": "Producao Grafica",
    # --- LOGÍSTICA ---
    "LOGALU": "Aluguel de Veiculos",
    "LOGCOM": "Despesas Diversas Com Logistica",
    "CONSOR": "Logistica Consorcio",
    # --- SERVIÇOS TERCEIRIZADOS ---
    "SERVT":  "Serviços De Consultoria Externa",
    "SERVTS": "Servicos Terceirizados de Consultoria",
    "SERVTC": "Servicos Contratos Mensais Comercial",
    # --- IMPOSTOS ---
    "ICMSST": "ICMS-ST",
    "ICMSAN": "ICMS Antecipação",
    "TAXADM": "Taxa Administrativa",
    # --- DESPESAS COM VENDAS ---
    "RECARG": "Desagio Recargas",
    # --- EMBALAGENS / EXPEDIENTE ---
    "MATADM": "Material De Expediente Do Adm",
    "DESPU":  "Material De Expediente Da Operaçao",
    # --- JURÍDICAS ---
    "CUSCAR": "Custas Cartoriais",
    "CUSTJU": "Custas Judiciais Trabalhistas",
    "CUSJF":  "Custas Juridicas",
    "ADIAJU": "Adiantamento Judicial",
    # --- INVESTIMENTOS ---
    "INLJ29": "Investimento Loja 29",
    "INLJ30": "Investimento Loja 29",     # placeholder — conferir
    "AQUISE": "Aquisicao Imoveis",
    "INEQUI": "Investimentos Equipamentos",
    # --- EMPRÉSTIMOS / MÚTUOS ---
    "EMPREC": "Emprestimo A Receber",
    "EMPRES": "Emprestimo",
    "MUTREC": "Mútuo Entre Lojas a Receber",
    "MUTPAG": "Mútuo Entre Lojas a Pagar",
    # --- RETIRADAS DE SÓCIOS ---
    "DIRET2": "Socio 30",                  # placeholder
    "DISTLU": "Socio 60",                  # placeholder
    # --- DESPESAS FINANCEIRAS — descartar ---
    # "TESCPG" — ignorar (igual no DRE)
}

# CODESPECIEs a descartar do fluxo_pago (decisão consciente).
CODESPECIE_IGNORAR_FLUXO = {"TESCPG"}


def classify_fluxo_pago(rows: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """BASE_PAGO — codoperacao 5 (recebto) + 6 (pagto).
    obrigdireito='D' = direito (recebimento, +) | 'O' = obrigação (pagamento, -)."""
    fatos = []
    nao_mapeados: dict[str, int] = {}
    for r in rows:
        codespecie = _val(r, "CODESPECIE")
        if codespecie in CODESPECIE_IGNORAR_FLUXO:
            continue
        nro = _val(r, "NROEMPRESA")
        valor = _val(r, "VLROPERACAO")
        data = _to_date(_val(r, "DTACONTABILIZA", "DTAQUITACAO", "DTAOPERACAO"))
        obrigdireito = _val(r, "OBRIGDIREITO")
        if data is None or valor is None:
            continue
        linha = CODESPECIE_TO_LINHA_FLUXO.get(codespecie)
        if not linha:
            nao_mapeados[codespecie or "—"] = nao_mapeados.get(codespecie or "—", 0) + 1
            continue
        # Se for pagamento (obrigação), inverte sinal
        sign = -1 if obrigdireito == "O" else +1
        fatos.append({
            "data": data.isoformat(),
            "nroempresa": int(nro) if nro is not None else None,
            "linha": linha,
            "valor": round(float(valor) * sign, 2),
            "_fonte": "fluxo_pago",
            "_codespecie": codespecie,
        })
    return fatos, nao_mapeados


# ─── FLUXO_JUROS — codoperacao 7 ──────────────────────────────────────────
def classify_fluxo_juros(rows: list[dict]) -> list[dict]:
    fatos = []
    for r in rows:
        nro = _val(r, "NROEMPRESA")
        valor = _val(r, "VLROPERACAO")
        data = _to_date(_val(r, "DTACONTABILIZA", "DTAQUITACAO", "DTAOPERACAO"))
        obrigdireito = _val(r, "OBRIGDIREITO")
        if data is None or valor is None:
            continue
        sign = -1 if obrigdireito == "O" else +1
        fatos.append({
            "data": data.isoformat(),
            "nroempresa": int(nro) if nro is not None else None,
            "linha": "Juros e Multas",
            "valor": round(float(valor) * sign, 2),
            "_fonte": "fluxo_juros",
        })
    return fatos


# ─── FLUXO_OPFIN — codoperacao várias (FI_CTACORLANCA) ────────────────────
# Mapa CODOPERACAO → LINHA do fluxo. Reaproveitado e adaptado do BASE5 do
# DRE, com extras 920, 15, 54 que aparecem só no fluxo.
CODOPERACAO_TO_LINHA_FLUXO = {
    34:  "Tarifa Bancária",      73:  "IOF",
    108: "Tarifa Bancária",      112: "Tarifa Bancária",
    129: "Tarifa Bancária",      132: "Tarifa Bancária",
    136: "Tarifa Bancária",      142: "Tarifa Bancária",
    191: "Tarifa Bancária",      205: "Tarifa Bancária",
    69:  "Tarifa Bancária",      130: "Tarifa Bancária",
    139: "Tarifa Bancária",
    # 140 (estorno) — ignorado, igual no DRE
    # 920, 15, 54 — pendentes, vão pra "Não classificado" até user mapear
    223: None, 217: None, 225: None, 214: None, 218: None, 220: None,
    216: None, 167: None, 219: None, 157: None,
}
CODOPERACAO_IGNORAR_FLUXO = {140}


def classify_fluxo_opfin(rows: list[dict]) -> tuple[list[dict], dict[int, int]]:
    fatos = []
    nao_mapeados: dict[int, int] = {}
    for r in rows:
        codop = _val(r, "CODOPERACAO")
        try: codop = int(codop) if codop is not None else None
        except (ValueError, TypeError): codop = None
        if codop in CODOPERACAO_IGNORAR_FLUXO:
            continue
        nro = _val(r, "NROEMPRESA")
        valor = _val(r, "VLRLANCAMENTO", "VLROPERACAO")
        data = _to_date(_val(r, "DTALANCTO", "DTAOPERACAO"))
        tipo = _val(r, "TIPOLANCTO")  # 'D' (débito) ou 'C' (crédito)
        if data is None or valor is None:
            continue
        linha = CODOPERACAO_TO_LINHA_FLUXO.get(codop)
        if not linha:
            nao_mapeados[codop] = nao_mapeados.get(codop, 0) + 1
            continue
        sign = -1 if tipo == "D" else +1
        fatos.append({
            "data": data.isoformat(),
            "nroempresa": int(nro) if nro is not None else None,
            "linha": linha,
            "valor": round(float(valor) * sign, 2),
            "_fonte": "fluxo_opfin",
            "_codoperacao": codop,
        })
    return fatos, nao_mapeados


def classificar_fluxo(slug: str, rows: list[dict]) -> tuple[list[dict], dict]:
    """Dispatcher: slug → função classifier. Retorna (fatos, warnings)."""
    if slug == "fluxo_pago":
        fatos, nao_mapeados = classify_fluxo_pago(rows)
        return fatos, {"codespecies_nao_mapeados": nao_mapeados} if nao_mapeados else {}
    if slug == "fluxo_juros":
        return classify_fluxo_juros(rows), {}
    if slug == "fluxo_opfin":
        fatos, nao_mapeados = classify_fluxo_opfin(rows)
        return fatos, {"codops_nao_mapeados": nao_mapeados} if nao_mapeados else {}
    return [], {}
