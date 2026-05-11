"""Engine do Fluxo de Caixa: pega rawOracle/{ano-mes}__fluxo_*, classifica,
junta com lançamentosManuaisFluxo + saldosBancarios e produz:
    fluxoCaixa/{ano-mes} no formato compacto consumido pela UI.

Sem rateio (usuário decisão: DFC não usa rateio).

Formato do doc gerado (semelhante ao meses/{ano-mes} do DRE):
{
  ano: 2026, mes: 5, v: 1,
  dim: { dias: ["01","02",...], grupos:[...], agrupamentos:[...], linhas:[...] },
  porGrupo:       [{d, g, v}],
  porAgrupamento: [{d, a, v}],
  porLinha:       [{d, g, a, n, v}],
  saldoInicial: 12345.67,
  saldoFinalDiario: [{d, v}],   # acumulado dia a dia
}
"""
from __future__ import annotations
import datetime as dt
from collections import defaultdict
from firebase_admin import firestore

import classifier_fluxo


def _carregar_raw_fluxo(db, ano: int, mes: int) -> dict[str, list]:
    """Lê rawOracle/{ano-mes}__fluxo_pago, ..._juros, ..._opfin."""
    chave = f"{ano:04d}-{mes:02d}"
    out = {}
    for slug in ["fluxo_pago", "fluxo_juros", "fluxo_opfin"]:
        doc_id = f"{chave}__{slug}"
        snap = db.collection("rawOracle").document(doc_id).get()
        if snap.exists:
            data = snap.to_dict() or {}
            rows = data.get("rows", [])
            # Se chunked, junta os chunks
            if data.get("chunked"):
                chunks = db.collection("rawOracle").document(doc_id).collection("chunks").stream()
                rows = []
                for ch in sorted(chunks, key=lambda c: int(c.id)):
                    rows.extend((ch.to_dict() or {}).get("rows", []))
            out[slug] = rows
        else:
            out[slug] = []
    return out


def _carregar_lancamentos_fluxo(db, ano: int, mes: int) -> list[dict]:
    """Lê lancamentosManuaisFluxo/ filtrando por mes (YYYY-MM)."""
    chave = f"{ano:04d}-{mes:02d}"
    out = []
    for d in db.collection("lancamentosManuaisFluxo").stream():
        data = d.to_dict() or {}
        if data.get("mes") != chave:
            continue
        # Manuais podem ter data específica do dia OU só o mês — assume dia 1 se só mês
        data_dia = data.get("data") or f"{chave}-01"
        out.append({
            "data": data_dia,
            "nroempresa": data.get("nroempresa"),
            "banco": data.get("banco"),
            "linha": data.get("linha", ""),
            "valor": float(data.get("valor", 0) or 0),
            "_fonte": "manualFluxo",
        })
    return out


def _carregar_saldo_inicial(db, ano: int, mes: int) -> tuple[float, list[dict]]:
    """Lê saldosBancarios/{ano-mes} → (total, [{banco, valor}])."""
    chave = f"{ano:04d}-{mes:02d}"
    snap = db.collection("saldosBancarios").document(chave).get()
    if not snap.exists:
        return 0.0, []
    saldos = (snap.to_dict() or {}).get("saldos", [])
    total = sum(float(s.get("valor", 0) or 0) for s in saldos)
    return total, saldos


def _carregar_dimensoes_fluxo(db) -> dict:
    """Lê meta/gruposFluxo + meta/agrupamentosFluxo + meta/linhasFluxo."""
    out = {
        "linha_para_grupo": {},      # linha → (grupo, agrupamento)
        "agrupamento_para_grupo": {},
        "grupos_ordenados": [],
        "agrupamentos_ordenados": [],
        "linhas_ordenadas": [],
    }
    snap = db.collection("meta").document("gruposFluxo").get()
    if snap.exists:
        items = sorted((snap.to_dict() or {}).get("items", []),
                       key=lambda x: x.get("ordem", 9999))
        out["grupos_ordenados"] = [it["nome"] for it in items if it.get("nome")]
    snap = db.collection("meta").document("agrupamentosFluxo").get()
    if snap.exists:
        for it in (snap.to_dict() or {}).get("items", []):
            n, g = it.get("nome", ""), it.get("grupo", "")
            if n:
                out["agrupamento_para_grupo"][n] = g
                if n not in out["agrupamentos_ordenados"]:
                    out["agrupamentos_ordenados"].append(n)
    snap = db.collection("meta").document("linhasFluxo").get()
    if snap.exists:
        for it in (snap.to_dict() or {}).get("items", []):
            n, a = it.get("nome", ""), it.get("agrupamento", "")
            if not n: continue
            g = out["agrupamento_para_grupo"].get(a, "")
            out["linha_para_grupo"][n] = (g, a)
            if n not in out["linhas_ordenadas"]:
                out["linhas_ordenadas"].append(n)
    return out


# ─── Linhas calculadas (tipo Margem Operacional do DRE) ───────────────────
# (Caixa Operacional removido a pedido do user — vinha duplicando a soma
#  de "ATIVIDADES OPERACIONAIS" como linha extra no DFC.)
LINHAS_CALCULADAS_FLUXO = []


def executar_fluxo(db, ano: int, mes: int) -> dict:
    """Pipeline completo: lê raw + manuais + saldo, classifica, agrega,
    grava em fluxoCaixa/{ano-mes}."""
    print(f"\n>> Executando fluxo de caixa {ano}-{mes:02d}...")

    raws = _carregar_raw_fluxo(db, ano, mes)
    print(f"   rawOracle: pago={len(raws['fluxo_pago'])}  juros={len(raws['fluxo_juros'])}  opfin={len(raws['fluxo_opfin'])}")

    fatos = []
    warnings = {}
    for slug, rows in raws.items():
        f, w = classifier_fluxo.classificar_fluxo(slug, rows)
        fatos.extend(f)
        if w:
            for k, v in w.items():
                warnings.setdefault(k, {}).update(v if isinstance(v, dict) else {})

    manuais = _carregar_lancamentos_fluxo(db, ano, mes)
    fatos.extend(manuais)
    print(f"   fatos classificados: {len(fatos) - len(manuais)}  +  manuais: {len(manuais)}")

    saldo_inicial, saldos_por_banco = _carregar_saldo_inicial(db, ano, mes)
    print(f"   saldo inicial: R$ {saldo_inicial:,.2f}  ({len(saldos_por_banco)} bancos)")

    dim = _carregar_dimensoes_fluxo(db)
    print(f"   dimensões: {len(dim['grupos_ordenados'])} grupos · {len(dim['agrupamentos_ordenados'])} agrups · {len(dim['linhas_ordenadas'])} linhas")

    # ─── Agregação por (data, grupo, agrup, linha) ──────────────────────
    porLinha       = defaultdict(float)   # (data, grupo, agrup, linha) → valor
    porAgrupamento = defaultdict(float)   # (data, agrup) → valor
    porGrupo       = defaultdict(float)   # (data, grupo) → valor
    dias_set       = set()
    grupos_set, agrups_set, linhas_set = set(), set(), set()
    linhas_fora    = {}

    for f in fatos:
        data = f.get("data")
        if not data: continue
        dia = data[8:10]   # "YYYY-MM-DD" → "DD"
        linha = f.get("linha") or ""
        valor = float(f.get("valor") or 0)
        if not linha or valor == 0: continue
        if linha not in dim["linha_para_grupo"]:
            linhas_fora[linha] = linhas_fora.get(linha, 0.0) + abs(valor)
        grupo, agrup = dim["linha_para_grupo"].get(linha, ("", ""))

        porLinha[(dia, grupo, agrup, linha)] += valor
        if agrup: porAgrupamento[(dia, agrup)] += valor
        if grupo: porGrupo[(dia, grupo)] += valor
        dias_set.add(dia)
        linhas_set.add(linha)
        if grupo: grupos_set.add(grupo)
        if agrup: agrups_set.add(agrup)

    # ─── LINHAS_CALCULADAS_FLUXO ─────────────────────────────────────────
    linha_por_dia: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    agrup_por_dia: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    grupo_por_dia: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for (dia, _g, _a, ln), v in porLinha.items():
        linha_por_dia[dia][ln] += v
    for (dia, ag), v in porAgrupamento.items():
        agrup_por_dia[dia][ag] += v
    for (dia, gr), v in porGrupo.items():
        grupo_por_dia[dia][gr] += v

    for f in LINHAS_CALCULADAS_FLUXO:
        nome  = f["nome"]
        agrup = f.get("agrupamento", "")
        grupo = f.get("grupo") or dim["agrupamento_para_grupo"].get(agrup, "")
        for dia in list(dias_set):
            valor = f["calc"](
                lambda n, _d=dia: linha_por_dia[_d].get(n, 0.0),
                lambda n, _d=dia: agrup_por_dia[_d].get(n, 0.0),
                lambda n, _d=dia: grupo_por_dia[_d].get(n, 0.0),
            )
            if valor == 0: continue
            porLinha[(dia, grupo, agrup, nome)] = valor
            if agrup:
                porAgrupamento[(dia, agrup)] = valor
                agrup_por_dia[dia][agrup] = valor
            if grupo:
                porGrupo[(dia, grupo)] = valor
                grupo_por_dia[dia][grupo] = valor
            linhas_set.add(nome)
            if grupo: grupos_set.add(grupo)
            if agrup: agrups_set.add(agrup)

    # ─── Saldo acumulado por dia ─────────────────────────────────────────
    dias_ordenados = sorted(dias_set)
    saldo_final_por_dia = []
    saldo_acum = saldo_inicial
    for dia in dias_ordenados:
        # Soma de tudo (entradas - saídas) daquele dia. Pra simplificar,
        # "movimento líquido" = soma de TODOS os porGrupo do dia
        # (operacional + investimento + financiamento).
        liq_dia = sum(grupo_por_dia[dia].values())
        saldo_acum += liq_dia
        saldo_final_por_dia.append({"d": dia, "v": round(saldo_acum, 2)})

    # ─── Empacota como doc compacto ──────────────────────────────────────
    def _ordena(presentes, ordenadas):
        out = [x for x in ordenadas if x in presentes]
        for x in sorted(presentes):
            if x not in out: out.append(x)
        return out

    dias = dias_ordenados
    grupos = _ordena(grupos_set, dim["grupos_ordenados"])
    agrups = _ordena(agrups_set, dim["agrupamentos_ordenados"])
    linhas = _ordena(linhas_set, dim["linhas_ordenadas"])
    idia = {x: i for i, x in enumerate(dias)}
    igrupo = {x: i for i, x in enumerate(grupos)}
    iagrup = {x: i for i, x in enumerate(agrups)}
    ilinha = {x: i for i, x in enumerate(linhas)}

    chave = f"{ano:04d}-{mes:02d}"
    doc = {
        "ano": ano, "mes": mes, "v": 1,
        "dim": {
            "dias": dias, "grupos": grupos,
            "agrupamentos": agrups, "linhas": linhas,
        },
        "porGrupo": [
            {"d": idia[d], "g": igrupo[g], "v": round(v, 2)}
            for (d, g), v in porGrupo.items()
        ],
        "porAgrupamento": [
            {"d": idia[d], "a": iagrup[a], "v": round(v, 2)}
            for (d, a), v in porAgrupamento.items()
        ],
        "porLinha": [
            {"d": idia[d], "g": igrupo.get(g, 0), "a": iagrup.get(a, 0),
             "n": ilinha[ln], "v": round(v, 2)}
            for (d, g, a, ln), v in porLinha.items()
        ],
        "saldoInicial": round(saldo_inicial, 2),
        "saldoFinalDiario": saldo_final_por_dia,
        "geradoEm": firestore.SERVER_TIMESTAMP,
    }
    db.collection("fluxoCaixa").document(chave).set(doc, merge=False)

    print(f"   ✓ fluxoCaixa/{chave}: {len(dias)} dias × {len(linhas)} linhas, "
          f"{len(doc['porLinha'])} pontos. Saldo final: R$ {saldo_acum:,.2f}")
    if linhas_fora:
        print(f"   ⚠ {len(linhas_fora)} LINHAs fora do plano DFC (TOP 10):")
        for ln, total in sorted(linhas_fora.items(), key=lambda kv: -kv[1])[:10]:
            print(f"      {total:>15,.2f}  {ln}")
    if warnings:
        print(f"   ⚠ Warnings de classificação: {warnings}")

    return {
        "ano": ano, "mes": mes,
        "fatos":           len(fatos) - len(manuais),
        "manuais":         len(manuais),
        "saldoInicial":    round(saldo_inicial, 2),
        "saldoFinal":      round(saldo_acum, 2),
        "dias":            len(dias),
        "linhas":          len(linhas),
        "pontos":          len(doc["porLinha"]),
        "linhasForaPlano": list(linhas_fora.keys()),
        "warnings":        warnings,
    }
