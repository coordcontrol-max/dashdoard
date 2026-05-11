"""Engine de rateio: pega fatosClassificados + lancamentosManuais + rateios
e produz meses/{ano-mes} no formato compacto v=2 que o dashboard consome.

Fluxo:
  1. Lê fatosClassificados/{ano-mes}              (saída do classificador)
  2. Lê lancamentosManuais/ filtrado por mes      (provisões/ajustes manuais)
  3. Lê meta/lojas e meta/linhas                  (mapeamentos NROEMPRESA→loja
                                                    e LINHA→grupo/agrupamento)
  4. (V2 — TODO) aplica rateios/                  (driver / matriz / duplicacao)
  5. Agrega por (loja, grupo, agrupamento, linha)
  6. Aplica LINHAS_CALCULADAS                     (fórmulas tipo Margem Operacional)
  7. Empacota como doc compacto v=2 e grava meses/{ano-mes}
"""
from __future__ import annotations
from collections import defaultdict
from firebase_admin import firestore


# ─── Inferência de GRUPO pelo nome da LINHA ─────────────────────────────────
# 5 agrupamentos ('Despesas c/ Pessoal', 'Despesas Jurídicas', 'Despesas com
# Informática', 'Material de Expediente', 'Serviços Terceirizados') são
# compartilhados entre os grupos Despesas Operacionais / Despesa Comerciais /
# Despesas Administrativas. O nome da LINHA traz o sufixo (Operacao/Comercial/
# ADM) que diz a qual grupo ela pertence. Esta função aplica essa regra; pra
# LINHAs sem sufixo (a maioria), cai pro fallback agrupamento_para_grupo.
SUFIXO_PARA_GRUPO = [
    # Ordem importa: prefixos mais longos antes pra evitar match parcial.
    ("Operação", "Despesas Operacionais"),
    ("Operaçao", "Despesas Operacionais"),
    ("Operacao", "Despesas Operacionais"),
    ("Comercial", "Despesa Comerciais"),    # nota: "Despesa" sem 's' (vem do meta/grupos)
    ("ADM",       "Despesas Administrativas"),
]


def _grupo_por_linha(nome_linha: str, agrupamento: str, agrup_para_grupo: dict) -> str:
    """Decide o grupo de uma LINHA usando sufixo + fallback."""
    for sufixo, grupo in SUFIXO_PARA_GRUPO:
        if nome_linha.endswith(" " + sufixo) or (" " + sufixo + " ") in nome_linha:
            return grupo
    return agrup_para_grupo.get(agrupamento, "")


# ─── LINHAs CALCULADAS ──────────────────────────────────────────────────────
# Fórmulas aplicadas POR LOJA depois da agregação base. Cada entrada cria
# uma LINHA derivada no DRE. `calc` recebe duas funções de lookup:
#   l(nome) → valor da LINHA "nome" naquela loja  (0 se inexistente)
#   a(nome) → valor do AGRUPAMENTO "nome" naquela loja  (0 se inexistente)
# `agrupamento` é a coluna onde a LINHA derivada vai aparecer no plano.
LINHAS_CALCULADAS = [
    {
        "nome":         "Margem C/ Acordos",
        "agrupamento":  "Margem C/ Acordos",
        "calc":         lambda l, a: l("Margem S/ Acordos") + a("Receitas Comerciais"),
    },
    {
        "nome":         "Margem Operacional",
        "agrupamento":  "Margem Operacional",
        "calc":         lambda l, a: l("Margem C/ Acordos") + a("Quebra Contábil"),
    },
]


def _carregar_fatos_classificados(db, ano: int, mes: int) -> list[dict]:
    """Lê fatosClassificados/{ano-mes} → lista de fatos."""
    chave = f"{ano:04d}-{mes:02d}"
    snap = db.collection("fatosClassificados").document(chave).get()
    if not snap.exists:
        return []
    data = snap.to_dict() or {}
    return list(data.get("fatos") or [])


def _carregar_lancamentos_manuais(db, ano: int, mes: int, cenario: str = "realizado") -> list[dict]:
    """Lê lancamentosManuais/ filtrando por mes (formato 'YYYY-MM') e cenario."""
    chave = f"{ano:04d}-{mes:02d}"
    out = []
    for d in db.collection("lancamentosManuais").stream():
        data = d.to_dict() or {}
        if data.get("mes") != chave:
            continue
        if data.get("cenario", "realizado") != cenario:
            continue
        # Lançamento manual ainda não tem nroempresa — engine de rateio
        # (V2) precisa distribuir nas lojas. Por enquanto, pula na agregação.
        out.append({
            "ano": ano, "mes": mes,
            "nroempresa": None,
            "linha": data.get("linha", ""),
            "valor": float(data.get("valor", 0) or 0),
            "_fonte": "lancamentoManual",
            "_obs": data.get("obs", ""),
        })
    return out


def _carregar_dimensoes(db) -> dict:
    """Carrega meta/lojas, meta/grupos, meta/agrupamentos e meta/linhas.

    O `meta/linhas` em geral tem `grupo` vazio — só `agrupamento`.
    O `meta/agrupamentos` traz o mapa agrupamento→grupo, que aplicamos pra
    inferir o grupo de cada LINHA. `meta/grupos` define a ordem dos grupos.
    """
    out = {
        "nroempresa_para_loja":   {},   # {1: "Loja Centro"}
        "agrupamento_para_grupo": {},   # {"Mercadoria para Revenda": "CMV"}
        "linha_para_grupo":       {},   # {"Venda Bruta": ("Venda Bruta", "Venda Bruta")}
        "linhas_ordenadas":       [],
        "grupos_ordenados":       [],
        "agrupamentos_ordenados": [],
    }

    snap = db.collection("meta").document("lojas").get()
    if snap.exists:
        for item in (snap.to_dict() or {}).get("items", []):
            nome = item.get("descricao") or ""
            ativo = item.get("ativo", True)
            if not nome or not ativo:
                continue
            for nro in item.get("nroempresa", []):
                try:
                    out["nroempresa_para_loja"][int(nro)] = nome
                except (ValueError, TypeError):
                    pass

    # meta/grupos: ordenado por campo `ordem`
    snap = db.collection("meta").document("grupos").get()
    if snap.exists:
        items = sorted(
            (snap.to_dict() or {}).get("items", []),
            key=lambda x: x.get("ordem", 9999),
        )
        out["grupos_ordenados"] = [it.get("nome") for it in items if it.get("nome")]

    # meta/agrupamentos: mapa agrupamento→grupo + ordem
    snap = db.collection("meta").document("agrupamentos").get()
    if snap.exists:
        items = (snap.to_dict() or {}).get("items", [])
        for it in items:
            n = it.get("nome") or ""
            g = it.get("grupo") or ""
            if n and g:
                out["agrupamento_para_grupo"][n] = g
            if n and n not in out["agrupamentos_ordenados"]:
                out["agrupamentos_ordenados"].append(n)

    # meta/linhas: usa agrupamento dela e infere grupo via sufixo do nome +
    # fallback no map de agrupamento. Isso cobre os 5 agrupamentos que aparecem
    # em múltiplos grupos (ex: "Despesas c/ Pessoal" em Operacionais/Comercial/ADM).
    snap = db.collection("meta").document("linhas").get()
    if snap.exists:
        for item in (snap.to_dict() or {}).get("items", []):
            nome = item.get("nome") or ""
            grupo = item.get("grupo") or ""   # se cadastrado explicitamente, respeita
            agrupamento = item.get("agrupamento") or ""
            if not nome:
                continue
            if not grupo:
                grupo = _grupo_por_linha(nome, agrupamento, out["agrupamento_para_grupo"])
            out["linha_para_grupo"][nome] = (grupo, agrupamento)
            if nome not in out["linhas_ordenadas"]:
                out["linhas_ordenadas"].append(nome)
    return out


def _agregar_em_doc_compacto(fatos: list[dict], dimensoes: dict, ano: int, mes: int) -> dict:
    """Agrega fatos por (loja, grupo, agrupamento, linha) → doc compacto v=2.

    Formato consumido pelo dashboard (loadFromFirestore):
      { ano, mes, v:2, dim:{lojas,grupos,agrupamentos,linhas},
        porGrupo:[{l,g,v}], porAgrupamento:[{l,a,v}], porLinha:[{l,g,a,n,v}] }
    onde l/g/a/n são índices nos arrays de dim.
    """
    nro2loja = dimensoes["nroempresa_para_loja"]
    linha2grupo = dimensoes["linha_para_grupo"]

    porLinha: dict[tuple, float]       = defaultdict(float)
    porAgrupamento: dict[tuple, float] = defaultdict(float)
    porGrupo: dict[tuple, float]       = defaultdict(float)

    lojas_set, linhas_set, grupos_set, agrups_set = set(), set(), set(), set()
    nros_sem_loja: set = set()
    linhas_fora_plano: dict[str, float] = {}   # LINHA → total absoluto (pra ranking)

    for f in fatos:
        nro = f.get("nroempresa")
        if nro is None:
            nros_sem_loja.add(None)
            continue
        try:
            nro = int(nro)
        except (ValueError, TypeError):
            nros_sem_loja.add(nro)
            continue
        loja = nro2loja.get(nro)
        if not loja:
            nros_sem_loja.add(nro)
            continue
        linha = f.get("linha") or ""
        valor = float(f.get("valor") or 0)
        if not linha or valor == 0:
            continue
        if linha not in linha2grupo:
            # LINHA não cadastrada em meta/linhas — agrega mesmo assim em
            # porLinha mas com grupo/agrup vazios (aparece no dashboard
            # como linha órfã). Conta pra warning.
            linhas_fora_plano[linha] = linhas_fora_plano.get(linha, 0.0) + abs(valor)
        grupo, agrupamento = linha2grupo.get(linha, ("", ""))

        porLinha[(loja, grupo, agrupamento, linha)] += valor
        if agrupamento:
            porAgrupamento[(loja, agrupamento)] += valor
        if grupo:
            porGrupo[(loja, grupo)] += valor

        lojas_set.add(loja)
        linhas_set.add(linha)
        if grupo: grupos_set.add(grupo)
        if agrupamento: agrups_set.add(agrupamento)

    # ─── Aplica LINHAS_CALCULADAS (fórmulas pós-agregação) ───────────────
    # Index por loja pra lookup rápido nas fórmulas
    linha_por_loja: dict[str, dict[str, float]]    = defaultdict(lambda: defaultdict(float))
    agrup_por_loja: dict[str, dict[str, float]]    = defaultdict(lambda: defaultdict(float))
    for (loja, _g, _a, ln), v in porLinha.items():
        linha_por_loja[loja][ln] += v
    for (loja, ag), v in porAgrupamento.items():
        agrup_por_loja[loja][ag] += v

    for f in LINHAS_CALCULADAS:
        nome  = f["nome"]
        agrup = f.get("agrupamento", "")
        grupo = dimensoes["agrupamento_para_grupo"].get(agrup, "")
        for loja in list(lojas_set):
            valor = f["calc"](
                lambda n, _l=loja: linha_por_loja[_l].get(n, 0.0),
                lambda n, _l=loja: agrup_por_loja[_l].get(n, 0.0),
            )
            if valor == 0:
                continue
            porLinha[(loja, grupo, agrup, nome)] = valor
            # Linhas calculadas são totais — também populam o agrupamento
            # e o grupo (assumindo que não há outras LINHAs no mesmo
            # agrupamento, o que é o caso típico de totais como
            # Margem Operacional, Margem C/ Acordos, etc).
            if agrup:
                porAgrupamento[(loja, agrup)] = valor
                agrup_por_loja[loja][agrup] = valor
            if grupo:
                porGrupo[(loja, grupo)] = valor
            # Atualiza o index local pra que fórmulas posteriores possam
            # referenciar essa nova LINHA.
            linha_por_loja[loja][nome] = valor
            linhas_set.add(nome)
            if grupo: grupos_set.add(grupo)
            if agrup: agrups_set.add(agrup)

    # Constrói índices ordenados — preserva ordem do meta/linhas quando possível
    def _ordena(presentes, ordenadas_meta):
        out = [x for x in ordenadas_meta if x in presentes]
        for x in sorted(presentes):
            if x not in out:
                out.append(x)
        return out

    lojas  = sorted(lojas_set)
    linhas = _ordena(linhas_set, dimensoes["linhas_ordenadas"])
    grupos = _ordena(grupos_set, dimensoes["grupos_ordenados"])
    agrups = _ordena(agrups_set, dimensoes["agrupamentos_ordenados"])

    iloja  = {x: i for i, x in enumerate(lojas)}
    igrupo = {x: i for i, x in enumerate(grupos)}
    iagrup = {x: i for i, x in enumerate(agrups)}
    ilinha = {x: i for i, x in enumerate(linhas)}

    return {
        "ano": ano,
        "mes": mes,
        "v": 2,
        "dim": {
            "lojas": lojas,
            "grupos": grupos,
            "agrupamentos": agrups,
            "linhas": linhas,
        },
        "porGrupo": [
            {"l": iloja[l], "g": igrupo[g], "v": round(v, 2)}
            for (l, g), v in porGrupo.items()
        ],
        "porAgrupamento": [
            {"l": iloja[l], "a": iagrup[a], "v": round(v, 2)}
            for (l, a), v in porAgrupamento.items()
        ],
        "porLinha": [
            {"l": iloja[l],
             "g": igrupo.get(g, 0),
             "a": iagrup.get(a, 0),
             "n": ilinha[ln],
             "v": round(v, 2)}
            for (l, g, a, ln), v in porLinha.items()
        ],
        "_diag": {
            "nrosSemLoja":      sorted(str(n) for n in nros_sem_loja if n is not None),
            "linhasForaPlano":  sorted(linhas_fora_plano.keys()),
            # TOP 10 LINHAs por valor absoluto agregado (pra priorizar no fix)
            "linhasForaPlanoTop": sorted(
                linhas_fora_plano.items(), key=lambda kv: -kv[1]
            )[:10],
        },
    }


def executar_rateio(db, ano: int, mes: int, cenario: str = "realizado") -> dict:
    """Pipeline completo: lê tudo, agrega, grava em meses/{ano-mes}."""
    print(f"\n>> Executando rateio {ano}-{mes:02d} ({cenario})...")

    fatos = _carregar_fatos_classificados(db, ano, mes)
    print(f"   fatos classificados:  {len(fatos):>5}")

    manuais = _carregar_lancamentos_manuais(db, ano, mes, cenario)
    print(f"   lançamentos manuais:  {len(manuais):>5}")

    dimensoes = _carregar_dimensoes(db)
    n_lojas = len(set(dimensoes["nroempresa_para_loja"].values()))
    print(f"   lojas no meta/lojas:  {n_lojas:>5}")
    print(f"   linhas no meta/linhas:{len(dimensoes['linha_para_grupo']):>5}")

    # V1: pool = classificados + manuais (manuais sem nroempresa serão ignorados
    # na agregação até a engine de rateio V2 distribuir nas lojas).
    fatos_pool = list(fatos) + manuais

    # TODO V2: aplicar regras de rateio (driver/matriz/duplicacao/haircut)
    # for rateio in carregar_rateios_aplicaveis(db, mes, cenario):
    #     fatos_pool = aplicar_rateio(fatos_pool, rateio, dimensoes)

    doc = _agregar_em_doc_compacto(fatos_pool, dimensoes, ano, mes)
    diag = doc.pop("_diag", {})
    doc["geradoEm"] = firestore.SERVER_TIMESTAMP

    chave = f"{ano:04d}-{mes:02d}"
    db.collection("meses").document(chave).set(doc, merge=False)

    n_pontos = len(doc["porLinha"])
    print(f"   ✓ meses/{chave}: {len(doc['dim']['lojas'])} lojas × "
          f"{len(doc['dim']['linhas'])} linhas, {n_pontos} pontos")
    if diag.get("nrosSemLoja"):
        print(f"   ⚠ NROEMPRESAs sem loja em meta/lojas: {diag['nrosSemLoja']}")
    if diag.get("linhasForaPlano"):
        print(f"   ⚠ {len(diag['linhasForaPlano'])} LINHAs fora do plano de contas (TOP 10 por valor):")
        for linha, total in diag.get("linhasForaPlanoTop", []):
            print(f"      {total:>15,.2f}  {linha}")

    return {
        "ano": ano, "mes": mes, "cenario": cenario,
        "fatosClassificados":   len(fatos),
        "lancamentosManuais":   len(manuais),
        "lojas":                len(doc["dim"]["lojas"]),
        "linhas":               len(doc["dim"]["linhas"]),
        "pontos":               n_pontos,
        "nrosSemLoja":          diag.get("nrosSemLoja", []),
        "linhasForaPlano":      diag.get("linhasForaPlano", []),
        "linhasForaPlanoTop":   [{"linha": l, "valorAbs": v} for l, v in diag.get("linhasForaPlanoTop", [])],
    }
