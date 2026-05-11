"""Agente local que roda na máquina 192.168.0.225.

Função: receber requisição do dashboard (botão "Atualizar Tudo" na aba
Importação SQL), rodar as 18 queries Consinco e gravar os resultados crus
em Firestore (collection rawOracle/), preservando 100% das colunas
originais do ERP.

Endpoints:
    GET  /          -> ping
    GET  /health    -> status (Oracle + Firebase conectados?)
    POST /atualizar?ano=YYYY&mes=MM   -> roda 1 mês
    POST /atualizar?ano=YYYY          -> roda todos os meses do ano até hoje

Pra rodar:
    pip install -r requirements.txt
    python agente.py
"""

import os
import sys
import time
import calendar
import threading
import traceback
import datetime as dt
from pathlib import Path
from typing import Any, Optional

import oracledb
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

from queries import QUERIES, QUERIES_DIMENSOES
import classificador
import engine
import engine_fluxo

# ─── CONFIG ─────────────────────────────────────────────────────────────────
load_dotenv()

ORACLE_HOST     = os.getenv("ORACLE_HOST", "10.61.1.1")
ORACLE_PORT     = int(os.getenv("ORACLE_PORT", "1521"))
ORACLE_SERVICE  = os.getenv("ORACLE_SERVICE", "orcl")
ORACLE_USER     = os.getenv("ORACLE_USER")
ORACLE_PASSWORD = os.getenv("ORACLE_PASSWORD")
ORACLE_CLIENT   = os.getenv("ORACLE_CLIENT_DIR")  # caminho do Instant Client
FIREBASE_SA     = os.getenv("FIREBASE_SA_PATH", "../serviceAccount.json")
PORT            = int(os.getenv("PORT", "8765"))
# Origens permitidas: localhost (mesmo PC), site deployado e o IP da rede
ORIGINS = [
    "http://localhost",
    "http://127.0.0.1",
    "https://controllsv.web.app",
    "https://controllsv.firebaseapp.com",
]

if not ORACLE_USER or not ORACLE_PASSWORD:
    print("✗ Credenciais Oracle ausentes. Crie o arquivo .env (veja .env.example)")
    sys.exit(1)

# ─── INIT ORACLE ────────────────────────────────────────────────────────────
try:
    if ORACLE_CLIENT:
        oracledb.init_oracle_client(lib_dir=ORACLE_CLIENT)
        print(f"✓ Oracle Instant Client carregado de {ORACLE_CLIENT}")
    else:
        # Tenta thin mode (não suporta verifier 11g — provável que falhe)
        print("⚠ ORACLE_CLIENT_DIR não definido — tentando thin mode")
except Exception as e:
    print(f"✗ Falha ao iniciar Oracle Client: {e}")
    sys.exit(1)

ORACLE_DSN = f"{ORACLE_HOST}:{ORACLE_PORT}/{ORACLE_SERVICE}"

def conectar_oracle() -> oracledb.Connection:
    return oracledb.connect(user=ORACLE_USER, password=ORACLE_PASSWORD, dsn=ORACLE_DSN)

# ─── INIT FIREBASE ──────────────────────────────────────────────────────────
sa_path = Path(FIREBASE_SA)
if not sa_path.is_absolute():
    sa_path = (Path(__file__).parent / sa_path).resolve()
if not sa_path.exists():
    print(f"✗ serviceAccount.json não encontrado em {sa_path}")
    print(f"  Configure FIREBASE_SA_PATH no .env")
    sys.exit(1)

firebase_admin.initialize_app(credentials.Certificate(str(sa_path)))
db = firestore.client()
print(f"✓ Firebase conectado (serviceAccount em {sa_path})")

# ─── HELPERS ────────────────────────────────────────────────────────────────
def periodo_do_mes(ano: int, mes: int) -> tuple[dt.date, dt.date]:
    """Retorna (primeiro_dia, ultimo_dia) do mês. Se mês corrente, fim = ontem."""
    primeiro = dt.date(ano, mes, 1)
    ultimo_dia = calendar.monthrange(ano, mes)[1]
    fim_mes = dt.date(ano, mes, ultimo_dia)
    hoje = dt.date.today()
    # Se for o mês corrente, fim = ontem (queries do Consinco usam trunc(sysdate)-1)
    if ano == hoje.year and mes == hoje.month:
        fim_mes = hoje - dt.timedelta(days=1)
    return primeiro, fim_mes

def linha_para_dict(cols: list[str], row: tuple) -> dict[str, Any]:
    """Converte tuple do oracledb pra dict serializável JSON."""
    out = {}
    for c, v in zip(cols, row):
        if isinstance(v, (dt.datetime, dt.date)):
            out[c] = v.isoformat()
        elif isinstance(v, oracledb.LOB):
            out[c] = v.read()
        else:
            out[c] = v
    return out

def rodar_query(conn, slug: str, info: dict, dta_ini: dt.date, dta_fim: dt.date) -> dict:
    """Executa uma query e retorna {ok, rows, count, ms, error?}."""
    t0 = time.time()
    try:
        cur = conn.cursor()
        cur.execute(info["sql"], dta_ini=dta_ini, dta_fim=dta_fim)
        cols = [d[0] for d in cur.description]
        rows = [linha_para_dict(cols, r) for r in cur.fetchall()]
        cur.close()
        ms = int((time.time() - t0) * 1000)
        return {"ok": True, "slug": slug, "nome": info["nome"], "rows": rows, "count": len(rows), "ms": ms}
    except Exception as e:
        ms = int((time.time() - t0) * 1000)
        return {"ok": False, "slug": slug, "nome": info["nome"], "rows": [], "count": 0, "ms": ms, "error": str(e)}

def gravar_classificados(ano: int, mes: int, fatos_por_slug: dict, detalhes_despesas: list) -> dict:
    """Junta os fatos de todas as queries num doc fatosClassificados/{ano-mes}
    e grava os detalhes das despesas em despesasDetalhadas/{ano-mes}.
    """
    chave = f"{ano:04d}-{mes:02d}"

    # Une todos os fatos (cada item: ano, mes, nroempresa, linha, valor)
    todos_fatos = []
    for slug, fatos in fatos_por_slug.items():
        for f in fatos:
            todos_fatos.append({**f, "_fonte": slug})

    # Grava fatosClassificados/{ano-mes}
    db.collection("fatosClassificados").document(chave).set({
        "ano": ano,
        "mes": mes,
        "fatos": todos_fatos,
        "geradoEm": firestore.SERVER_TIMESTAMP,
        "totalFatos": len(todos_fatos),
    }, merge=False)

    # Grava despesasDetalhadas/{ano-mes} (com chunking se necessário)
    base_doc = {
        "ano": ano,
        "mes": mes,
        "totalDetalhes": len(detalhes_despesas),
        "geradoEm": firestore.SERVER_TIMESTAMP,
    }
    CHUNK = 500
    if len(detalhes_despesas) <= CHUNK:
        base_doc["detalhes"] = detalhes_despesas
        base_doc["chunked"] = False
        db.collection("despesasDetalhadas").document(chave).set(base_doc, merge=False)
    else:
        base_doc["chunked"] = True
        base_doc["totalChunks"] = (len(detalhes_despesas) + CHUNK - 1) // CHUNK
        db.collection("despesasDetalhadas").document(chave).set(base_doc, merge=False)
        # Apaga chunks antigos primeiro
        for old in db.collection("despesasDetalhadas").document(chave).collection("chunks").stream():
            old.reference.delete()
        for i in range(0, len(detalhes_despesas), CHUNK):
            n = i // CHUNK
            db.collection("despesasDetalhadas").document(chave).collection("chunks").document(str(n)).set({
                "n": n, "detalhes": detalhes_despesas[i:i+CHUNK]
            })

    return {
        "totalFatos": len(todos_fatos),
        "totalDetalhes": len(detalhes_despesas),
        "porSlug": {s: len(f) for s, f in fatos_por_slug.items()},
    }


def gravar_firestore(ano: int, mes: int, slug: str, resultado: dict) -> None:
    """Grava resultado de uma query em rawOracle/{ano-mes-slug}.

    Se rows excede 1MB (limite do doc), divide em chunks de 1000 linhas.
    """
    chave = f"{ano:04d}-{mes:02d}__{slug}"
    rows = resultado["rows"]
    CHUNK = 1000

    # Doc principal: meta + 1º chunk
    base_doc = {
        "ano": ano,
        "mes": mes,
        "slug": slug,
        "nome": resultado["nome"],
        "count": resultado["count"],
        "geradoEm": firestore.SERVER_TIMESTAMP,
        "ms": resultado["ms"],
    }
    if len(rows) <= CHUNK:
        base_doc["rows"] = rows
        base_doc["chunked"] = False
        db.collection("rawOracle").document(chave).set(base_doc)
    else:
        base_doc["chunked"] = True
        base_doc["totalChunks"] = (len(rows) + CHUNK - 1) // CHUNK
        db.collection("rawOracle").document(chave).set(base_doc)
        # Cada chunk vira sub-doc rawOracle/{chave}/chunks/{n}
        for i in range(0, len(rows), CHUNK):
            n = i // CHUNK
            db.collection("rawOracle").document(chave).collection("chunks").document(str(n)).set({
                "n": n, "rows": rows[i:i+CHUNK]
            })

# ─── FASTAPI ────────────────────────────────────────────────────────────────
app = FastAPI(title="Agente Oracle Controllsv", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"agente": "controllsv-oracle", "versao": "1.0", "status": "rodando"}

@app.get("/health")
def health():
    """Testa Oracle + Firebase ao vivo."""
    out = {"oracle": False, "firebase": False, "queries": len(QUERIES)}
    try:
        c = conectar_oracle()
        cur = c.cursor()
        cur.execute("SELECT 1 FROM DUAL")
        cur.fetchone()
        cur.close(); c.close()
        out["oracle"] = True
    except Exception as e:
        out["oracleError"] = str(e)
    try:
        # Tenta uma leitura simples
        list(db.collection("meta").limit(1).stream())
        out["firebase"] = True
    except Exception as e:
        out["firebaseError"] = str(e)
    return out

@app.post("/atualizar")
def atualizar(
    ano: int = Query(..., ge=2020, le=2099),
    mes: Optional[int] = Query(None, ge=1, le=12),
    slug: Optional[str] = Query(None, description="Se informado, roda só essa query"),
    slugs: Optional[list[str]] = Query(None, description="Se informado, roda só essas queries"),
):
    """Roda as queries Oracle pra (ano, mes). Se mes for omitido, roda todos
    os meses do ano até o atual. Se slug ou slugs forem informados, roda só
    aquele subconjunto (slugs tem precedência).
    """
    # Quando chamada como função normal (do worker), os defaults Query(...)
    # vêm como objetos FastAPI FieldInfo. Normaliza:
    if not isinstance(mes, (int, type(None))):
        mes = None
    if not isinstance(slug, (str, type(None))):
        slug = None
    if not isinstance(slugs, (list, type(None))):
        slugs = None
    hoje = dt.date.today()
    if mes is None:
        meses = list(range(1, hoje.month + 1)) if ano == hoje.year else list(range(1, 13))
    else:
        meses = [mes]

    if ano > hoje.year or (ano == hoje.year and meses[-1] > hoje.month):
        raise HTTPException(400, "Período no futuro")

    # Filtra QUERIES por slugs (lista) ou slug (singular). Lista tem precedência.
    queries_a_rodar = QUERIES
    slugs_alvo = list(slugs) if slugs else ([slug] if slug else None)
    if slugs_alvo:
        invalidos = [s for s in slugs_alvo if s not in QUERIES]
        if invalidos:
            raise HTTPException(400, f"slugs desconhecidos: {invalidos}")
        queries_a_rodar = {s: QUERIES[s] for s in slugs_alvo}

    relatorio = {"ano": ano, "meses": []}
    try:
        conn = conectar_oracle()
    except Exception as e:
        raise HTTPException(500, f"Falha conectando ao Oracle: {e}")

    try:
        for m in meses:
            dta_ini, dta_fim = periodo_do_mes(ano, m)
            print(f"\n=== {ano}-{m:02d}  ({dta_ini} → {dta_fim}) {'· slug=' + slug if slug else ''} ===")
            r_mes = {"mes": m, "dta_ini": dta_ini.isoformat(), "dta_fim": dta_fim.isoformat(), "queries": []}
            rows_por_slug: dict[str, list[dict]] = {}
            for slug_q, info in queries_a_rodar.items():
                print(f"  → {info['nome']:35}", end="", flush=True)
                resultado = rodar_query(conn, slug_q, info, dta_ini, dta_fim)
                if resultado["ok"]:
                    print(f"  ✓ {resultado['count']:>6} linhas em {resultado['ms']}ms")
                    rows_por_slug[slug_q] = resultado["rows"]
                    try:
                        gravar_firestore(ano, m, slug_q, resultado)
                    except Exception as e:
                        resultado["ok"] = False
                        resultado["error"] = f"firestore: {e}"
                        print(f"     ✗ Firestore: {e}")
                else:
                    print(f"  ✗ {resultado['error'][:60]}")
                r_mes["queries"].append({
                    "slug": slug_q, "nome": info["nome"],
                    "ok": resultado["ok"], "count": resultado["count"],
                    "ms": resultado["ms"], "error": resultado.get("error"),
                })

            # ── CLASSIFICAÇÃO (Onda 1) ──────────────────────────────────
            print(f"\n  >> Classificando {ano}-{m:02d}...")
            fatos_por_slug = {}
            detalhes_despesas = []
            for slug_c, rows in rows_por_slug.items():
                fatos, detalhes = classificador.classificar_query(slug_c, rows)
                if fatos:
                    fatos_por_slug[slug_c] = fatos
                    print(f"     {slug_c:25}  → {len(fatos):>5} fatos classificados")
                if detalhes:
                    detalhes_despesas.extend(detalhes)
                    print(f"     {slug_c:25}  → {len(detalhes):>5} detalhes (drill-down)")
            try:
                resumo_class = gravar_classificados(ano, m, fatos_por_slug, detalhes_despesas)
                r_mes["classificacao"] = resumo_class
                print(f"     ✓ Total: {resumo_class['totalFatos']} fatos + {resumo_class['totalDetalhes']} detalhes")
            except Exception as e:
                print(f"     ✗ Classificação falhou: {e}")
                r_mes["classificacaoErro"] = str(e)

            relatorio["meses"].append(r_mes)
    finally:
        conn.close()

    return JSONResponse(relatorio)


@app.post("/rateio")
def rateio(ano: int, mes: int | None = None, cenario: str = "realizado"):
    """Executa engine de rateio.

    Lê fatosClassificados/{ano-mes} + lancamentosManuais/, agrega por
    (loja × LINHA) e grava em meses/{ano-mes} no formato compacto v=2.

      POST /rateio?ano=2026&mes=5         → roda só maio/2026
      POST /rateio?ano=2026               → roda os 12 meses de 2026
    """
    meses = [mes] if mes else list(range(1, 13))
    relatorio = {"ano": ano, "cenario": cenario, "meses": []}
    for m in meses:
        try:
            r = engine.executar_rateio(db, ano, m, cenario)
            relatorio["meses"].append(r)
        except Exception as e:
            print(f"  ✗ {ano}-{m:02d}: {e}")
            relatorio["meses"].append({"ano": ano, "mes": m, "erro": str(e)})
    return JSONResponse(relatorio)


@app.post("/dimensoes")
def atualizar_dimensoes():
    """Roda QUERIES_DIMENSOES (queries sem :dta_ini/:dta_fim) e grava o
    resultado no destino especificado em cada (ex: meta/produtosClassif).

    Usada pra cache de classificação de produtos × comprador × categoria,
    que muda com pouca frequência. Recomendado rodar 1x ao dia via cron.
    """
    relatorio = {"queries": []}
    try:
        conn = conectar_oracle()
    except Exception as e:
        raise HTTPException(500, f"Falha conectando ao Oracle: {e}")
    try:
        for slug, info in QUERIES_DIMENSOES.items():
            print(f"\n=== dimensão {slug} → {info.get('destino')} ===")
            t0 = time.time()
            try:
                cur = conn.cursor()
                cur.execute(info["sql"])
                cols = [d[0] for d in cur.description]
                rows = [linha_para_dict(cols, r) for r in cur.fetchall()]
                cur.close()
                ms = int((time.time() - t0) * 1000)
                destino = info["destino"]  # ex: "meta/produtosClassif"
                if "/" in destino:
                    col, doc_id = destino.split("/", 1)
                else:
                    col, doc_id = "meta", destino
                # Chunking se muito grande
                CHUNK = 2000
                base = {
                    "slug": slug, "nome": info["nome"],
                    "count": len(rows),
                    "geradoEm": firestore.SERVER_TIMESTAMP,
                    "ms": ms,
                }
                if len(rows) <= CHUNK:
                    base["rows"] = rows
                    base["chunked"] = False
                    db.collection(col).document(doc_id).set(base)
                else:
                    base["chunked"] = True
                    base["totalChunks"] = (len(rows) + CHUNK - 1) // CHUNK
                    db.collection(col).document(doc_id).set(base)
                    # Apaga chunks antigos
                    for old in db.collection(col).document(doc_id).collection("chunks").stream():
                        old.reference.delete()
                    for i in range(0, len(rows), CHUNK):
                        n = i // CHUNK
                        db.collection(col).document(doc_id).collection("chunks").document(str(n)).set({
                            "n": n, "rows": rows[i:i+CHUNK]
                        })
                print(f"  ✓ {len(rows)} linhas em {ms}ms → {destino}")
                relatorio["queries"].append({"slug": slug, "ok": True, "count": len(rows), "ms": ms, "destino": destino})
            except Exception as e:
                ms = int((time.time() - t0) * 1000)
                print(f"  ✗ {e}")
                relatorio["queries"].append({"slug": slug, "ok": False, "error": str(e), "ms": ms})
    finally:
        conn.close()
    return JSONResponse(relatorio)


@app.post("/fluxo")
def fluxo(ano: int, mes: int | None = None):
    """Executa engine de fluxo de caixa.

    Lê rawOracle/{ano-mes}__fluxo_* + lancamentosManuaisFluxo/ +
    saldosBancarios/{ano-mes}, classifica e grava fluxoCaixa/{ano-mes}.

      POST /fluxo?ano=2026&mes=5         → roda só maio/2026
      POST /fluxo?ano=2026               → roda os 12 meses de 2026
    """
    meses = [mes] if mes else list(range(1, 13))
    relatorio = {"ano": ano, "meses": []}
    for m in meses:
        try:
            r = engine_fluxo.executar_fluxo(db, ano, m)
            relatorio["meses"].append(r)
        except Exception as e:
            print(f"  ✗ {ano}-{m:02d}: {e}")
            relatorio["meses"].append({"ano": ano, "mes": m, "erro": str(e)})
    return JSONResponse(relatorio)


# ─── WORKER DE TASKS (mobile-friendly) ─────────────────────────────────────
# Usuário no celular não consegue chamar localhost:8765 da 225. Solução:
# UI grava um doc em tasks/{id} com {tipo, ano, mes, status:"pending"}.
# Esta thread escuta a coleção e executa a task localmente, atualizando
# status no Firestore (UI mostra progresso em tempo real via listener).
def _executar_task(task_id: str, task: dict) -> dict:
    """Executa uma task localmente. Retorna o resultado."""
    tipo = task.get("tipo")
    ano  = int(task.get("ano"))
    mes  = task.get("mes")
    if mes is not None: mes = int(mes)
    cenario = task.get("cenario", "realizado")
    slug = task.get("slug") or None  # None se ausente/vazio
    slugs = task.get("slugs") or None  # lista, ou None

    if tipo == "atualizar":
        # Reusa a função do endpoint /atualizar. IMPORTANTE: passar slug/slugs
        # explícitos — sem isso o default vira o objeto FastAPI Query(...)
        # e dispara "slug desconhecido".
        resp = atualizar(ano=ano, mes=mes, slug=slug, slugs=slugs)
        # JSONResponse → dict
        import json
        return json.loads(resp.body.decode("utf-8"))
    elif tipo == "rateio":
        meses = [mes] if mes else list(range(1, 13))
        relatorio = {"ano": ano, "cenario": cenario, "meses": []}
        for m in meses:
            try:
                r = engine.executar_rateio(db, ano, m, cenario)
                relatorio["meses"].append(r)
            except Exception as e:
                relatorio["meses"].append({"ano": ano, "mes": m, "erro": str(e)})
        return relatorio
    elif tipo == "fluxo":
        meses = [mes] if mes else list(range(1, 13))
        relatorio = {"ano": ano, "meses": []}
        for m in meses:
            try:
                r = engine_fluxo.executar_fluxo(db, ano, m)
                relatorio["meses"].append(r)
            except Exception as e:
                relatorio["meses"].append({"ano": ano, "mes": m, "erro": str(e)})
        return relatorio
    elif tipo == "dimensoes":
        # Roda QUERIES_DIMENSOES (sem data) e grava em meta/*
        resp = atualizar_dimensoes()
        import json
        return json.loads(resp.body.decode("utf-8"))
    elif tipo == "set_password":
        # Trocar senha de outro usuário no Firebase Auth via Admin SDK.
        # Rule do Firestore só deixa admin/diretoria criar essa task.
        from firebase_admin import auth as fb_auth
        email_alvo = task.get("email")
        nova_senha = task.get("password")
        if not email_alvo or not nova_senha:
            raise ValueError("set_password: 'email' e 'password' obrigatórios")
        if len(nova_senha) < 6:
            raise ValueError("set_password: senha precisa de pelo menos 6 caracteres")
        try:
            u = fb_auth.get_user_by_email(email_alvo)
            fb_auth.update_user(u.uid, password=nova_senha, email_verified=True)
            return {"ok": True, "email": email_alvo, "uid": u.uid, "acao": "senha atualizada"}
        except fb_auth.UserNotFoundError:
            u = fb_auth.create_user(email=email_alvo, password=nova_senha, email_verified=True)
            return {"ok": True, "email": email_alvo, "uid": u.uid, "acao": "auth criado + senha"}
    elif tipo == "tudo":
        # Pipeline completo: atualizar → rateio → fluxo
        out = {"ano": ano, "mes": mes, "etapas": {}}
        try:
            r1 = atualizar(ano=ano, mes=mes, slug=slug, slugs=slugs)
            import json
            out["etapas"]["atualizar"] = json.loads(r1.body.decode("utf-8"))
        except Exception as e:
            out["etapas"]["atualizar"] = {"erro": str(e)}
        meses = [mes] if mes else list(range(1, 13))
        out["etapas"]["rateio"] = []
        out["etapas"]["fluxo"] = []
        for m in meses:
            try: out["etapas"]["rateio"].append(engine.executar_rateio(db, ano, m, cenario))
            except Exception as e: out["etapas"]["rateio"].append({"ano": ano, "mes": m, "erro": str(e)})
            try: out["etapas"]["fluxo"].append(engine_fluxo.executar_fluxo(db, ano, m))
            except Exception as e: out["etapas"]["fluxo"].append({"ano": ano, "mes": m, "erro": str(e)})
        return out
    else:
        raise ValueError(f"Tipo de task desconhecido: {tipo!r}")


def _worker_loop():
    """Loop que processa tasks pending. Roda em thread separada."""
    print("► Worker de tasks rodando (polling 3s)")
    while True:
        try:
            # Pega tasks pending e ordena por criadoEm em Python (FIFO).
            # where+order_by exigiria índice composto no Firestore — como a fila
            # é pequena, sortear em memória sai mais simples.
            q = db.collection("tasks").where("status", "==", "pending").limit(50)
            pendentes = [(s.id, s.to_dict() or {}, s.reference) for s in q.stream()]
            pendentes.sort(key=lambda t: t[1].get("criadoEm") or 0)
            for snap_id, task, doc_ref in pendentes[:1]:
                print(f"\n>>> Task {snap_id}: {task.get('tipo')} ano={task.get('ano')} mes={task.get('mes')} slug={task.get('slug')!r}")
                # Marca running
                doc_ref.update({
                    "status": "running",
                    "iniciadoEm": firestore.SERVER_TIMESTAMP,
                })
                try:
                    resultado = _executar_task(snap_id, task)
                    doc_ref.update({
                        "status": "done",
                        "resultado": resultado,
                        "finalizadoEm": firestore.SERVER_TIMESTAMP,
                    })
                    print(f"<<< Task {snap_id}: done")
                except Exception as e:
                    print(f"<<< Task {snap_id}: erro - {e}")
                    traceback.print_exc()
                    doc_ref.update({
                        "status": "error",
                        "erro": str(e),
                        "finalizadoEm": firestore.SERVER_TIMESTAMP,
                    })
        except Exception as e:
            print(f"⚠ Worker loop falhou: {e}")
        time.sleep(3)


# ─── MAIN ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\n► Agente subindo em http://localhost:{PORT}")
    print(f"  Origens permitidas: {', '.join(ORIGINS)}")
    print(f"  Endpoints: /, /health,")
    print(f"             POST /atualizar?ano=YYYY[&mes=MM]")
    print(f"             POST /rateio?ano=YYYY[&mes=MM][&cenario=realizado]")
    print(f"             POST /fluxo?ano=YYYY[&mes=MM]")
    print(f"  Worker: escuta tasks/ no Firestore (mobile-friendly)\n")
    # Inicia worker em background
    threading.Thread(target=_worker_loop, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
