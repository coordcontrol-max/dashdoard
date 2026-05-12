// Parser do CSV exportado da planilha de Vagas (Google Sheets).
// Usa âncoras textuais (não números de linha) pra ser robusto a mudanças.

// CSV parser simples (suporta aspas e vírgula dentro de campo quoted)
function parseCsv(text) {
  const linhas = [];
  let i = 0, atual = [], campo = '', dentroAspas = false;
  while (i < text.length) {
    const c = text[i];
    if (dentroAspas) {
      if (c === '"' && text[i + 1] === '"') { campo += '"'; i += 2; continue; }
      if (c === '"') { dentroAspas = false; i++; continue; }
      campo += c; i++; continue;
    }
    if (c === '"') { dentroAspas = true; i++; continue; }
    if (c === ',') { atual.push(campo); campo = ''; i++; continue; }
    if (c === '\n') { atual.push(campo); linhas.push(atual); atual = []; campo = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    campo += c; i++;
  }
  if (campo !== '' || atual.length) { atual.push(campo); linhas.push(atual); }
  return linhas;
}

// Helpers
const isText = (v) => v != null && String(v).trim() !== '';
const norm = (v) => String(v ?? '').trim();
const cleanNum = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[%R$\s.]/g, '').replace(/,/g, '.');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
};
const cleanInt = (v) => {
  const n = cleanNum(v);
  return n == null ? null : Math.round(n);
};
const cleanPct = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s.includes('%')) {
    // Pode vir como número (0.22 = 22%) ou como inteiro 22
    const n = cleanNum(s);
    if (n == null) return null;
    return n > 1 ? n / 100 : n;
  }
  const n = cleanNum(s.replace('%', ''));
  return n == null ? null : n / 100;
};

// Encontra primeira linha cuja qualquer célula contém o trecho (case-insensitive)
function acharLinhaIdx(linhas, trecho, fromIdx = 0) {
  const t = trecho.toLowerCase();
  for (let i = fromIdx; i < linhas.length; i++) {
    if (linhas[i].some(c => norm(c).toLowerCase().includes(t))) return i;
  }
  return -1;
}

// ===== Seção: Assistentes =====
// Cabeçalho: ASSISTENTE | Vagas Abertas nº | FORA DO PRAZO - 10% | % | PRONT ADM | 80% de entrega semanal | LOJAS | QLP LOJAS | % QLP | REGIÃO | Rank menos Vagas
function parseAssistentes(linhas) {
  const idx = acharLinhaIdx(linhas, 'ASSISTENTE');
  if (idx < 0) return [];
  const out = [];
  // Lê até linha vazia ou que não tenha nome no col F (índice 5)
  for (let i = idx + 1; i < linhas.length; i++) {
    const r = linhas[i];
    const nome = norm(r[5]);
    if (!nome) break;
    if (nome.toLowerCase().includes('total')) break;
    out.push({
      nome,
      vagas_abertas: cleanInt(r[6]),
      fora_prazo:    cleanInt(r[7]),
      fora_prazo_pct: cleanPct(r[8]),
      pront_adm:     cleanInt(r[9]),
      meta_80_pct:   cleanPct(r[10]),
      lojas:         norm(r[11]),
      qlp_lojas:     cleanInt(r[12]),
      qlp_pct:       cleanPct(r[13]),
      regiao:        norm(r[14]),
      rank:          cleanInt(r[15]),
    });
  }
  return out;
}

// ===== Seção: Status de Vagas =====
function parseStatus(linhas) {
  const idx = acharLinhaIdx(linhas, 'STATUS DE VAGAS REAL');
  if (idx < 0) return {};
  const out = {};
  for (let i = idx + 1; i < linhas.length; i++) {
    const r = linhas[i];
    const label = norm(r[1]);
    if (!label) break;
    if (label.toLowerCase().startsWith('rotinas')) break;
    // Valor pode estar na coluna 3 (D) ou 4
    const valor = r[3] ?? r[4];
    out[label] = {
      label,
      valor_raw: norm(valor),
      valor: label.includes('%') || /percentual|atendendo|prazo/i.test(label) ? cleanPct(valor) : cleanInt(valor),
    };
  }
  return out;
}

// ===== Seção: Analistas =====
function parseAnalistas(linhas) {
  const idx = acharLinhaIdx(linhas, 'ANALISTA');
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < linhas.length; i++) {
    const r = linhas[i];
    const nome = norm(r[7]);
    if (!nome) break;
    out.push({
      nome,
      qtd_abertas:    cleanInt(r[8]),
      pronto_admissao: cleanInt(r[9]),
      fora_prazo_pct: cleanPct(r[10]),
    });
  }
  return out;
}

// ===== Seção: Vagas por Loja =====
// Procura linha com "LJ01" e na próxima tem os números
function parseVagasPorLoja(linhas) {
  for (let i = 0; i < linhas.length; i++) {
    const r = linhas[i];
    if (r.some(c => /^LJ\d+/.test(norm(c)))) {
      const cabec = r;
      const valores = linhas[i + 1] || [];
      const out = [];
      for (let c = 0; c < cabec.length; c++) {
        const lj = norm(cabec[c]);
        if (!/^LJ\d+/.test(lj)) continue;
        out.push({ loja: lj, qtd: cleanInt(valores[c]) || 0 });
      }
      return out;
    }
  }
  return [];
}

// ===== Seção: Admissão Semanal =====
function parseAdmissaoSemanal(linhas) {
  const idx = acharLinhaIdx(linhas, 'ADMISSÃO SEMANAL NO MÊS');
  if (idx < 0) return null;
  // Cabeçalho fica em idx+2 (ITEM, 01 a 04/04, 05 a 11/04, ...)
  const cabec = linhas[idx + 2] || [];
  const meta = linhas[idx + 3] || [];
  const real = linhas[idx + 4] || [];
  const dif  = linhas[idx + 5] || [];
  const semanas = [];
  for (let c = 2; c < cabec.length; c++) {
    const periodo = norm(cabec[c]);
    if (!periodo) continue;
    semanas.push({
      periodo,
      meta: cleanInt(meta[c]),
      real: cleanInt(real[c]),
      diff: cleanInt(dif[c]),
    });
  }
  // Última coluna costuma ser "TOTAL" — se tiver, separa
  let total = null;
  if (semanas.length && semanas[semanas.length - 1].periodo.toLowerCase().includes('total')) {
    total = semanas.pop();
  } else {
    // Fallback: soma
    total = {
      periodo: 'Total',
      meta: semanas.reduce((s, x) => s + (x.meta || 0), 0),
      real: semanas.reduce((s, x) => s + (x.real || 0), 0),
      diff: semanas.reduce((s, x) => s + (x.diff || 0), 0),
    };
  }
  return { semanas, total };
}

// ===== Cabeçalho com totais =====
// Linha 2: VAGAS TOTAIS ABERTAS (logo abaixo o número)
function parseTotaisCabecalho(linhas) {
  const idx = acharLinhaIdx(linhas, 'VAGAS TOTAIS ABERTAS');
  if (idx < 0) return null;
  const r = linhas[idx + 1] || [];
  return cleanInt(r[1]);
}

// ===== Aba individual de assistente — vagas detalhadas =====
// Cada aba (LIGIA/PEDRO/NATY/NATAN/YASMIN/POSTOS) tem cabeçalho ligeiramente diferente.
// Detecta cabeçalho pelo texto "CARGO" ou "FUNÇÃO" e mapeia colunas dinamicamente.
function detectarColunas(cabecalho) {
  const idx = {};
  cabecalho.forEach((c, i) => {
    const txt = norm(c).toUpperCase();
    if (!txt) return;
    if (idx.cargo == null && /CARGO|FUNÇÃO|FUNCAO/i.test(txt)) idx.cargo = i;
    else if (idx.requ == null && /\bREQU?\b/i.test(txt)) idx.requ = i;
    else if (idx.loja == null && /\bLOJA\b|POSTO|SETOR/i.test(txt)) idx.loja = i;
    else if (idx.assistente == null && /ASSIS|RESP/i.test(txt)) idx.assistente = i;
    else if (idx.gestor == null && /COORD|GESTOR/i.test(txt)) idx.gestor = i;
    else if (idx.abertura == null && /ABERTURA|INICIO/i.test(txt)) idx.abertura = i;
    else if (idx.prazo == null && /PRAZO|ADMITIR/i.test(txt)) idx.prazo = i;
    else if (idx.classificacao == null && /CLASS|FORA DO PRAZO/i.test(txt)) idx.classificacao = i;
    else if (idx.substituindo == null && /SUBSITU|SUBSTITU/i.test(txt) && !/NOME/i.test(txt)) idx.substituindo = i;
    else if (idx.motivo == null && /MOTIVO/i.test(txt)) idx.motivo = i;
    else if (idx.admissao == null && /^ADM\b|ADMITIDO|^ADMISSÃO/i.test(txt)) idx.admissao = i;
    else if (idx.status_final == null && /\bSTATU?S?\b|ANDAM/i.test(txt) && idx.status != null) idx.status_final = i;
    else if (idx.status == null && /\bSTATU?S?\b|SATUS|ANDAM/i.test(txt)) idx.status = i;
    else if (idx.substituto == null && (/NOME.*SUBST|CANDIDATO/i.test(txt) || /SUBSTITUT[OA]\s*\/|NOME DO SUBST/i.test(txt))) idx.substituto = i;
  });
  return idx;
}

// Texto que indica entrar em OUTRA tabela embutida (parar de processar).
// Não inclui cargos reais como "FISCAL PP", "AÇOUGUEIRO" — esses são vagas.
const NAO_E_CARGO_RE = /^(LOJAS|TOTAL\b|ASSISTENTES\b|RELATORIO\b|RELATÓRIO\b|CONTROLE\b|TURNOVER\b|ROTINAS\b|FONE\b|JUSTIFICATIVA\b|NATANAEL\b|NATY\b|PEDRO\b|LIGIA\b|YASMIN\b|WILL\b|VIVI\b|CRIS\b|WALAS\b|LUCAS\b|LOJA \d)/i;

// Status válidos (linha realmente é vaga em aberto)
const STATUS_VALIDOS_RE = /(EM SELE[ÇC][ÃA]O|DOCUMENTA[ÇC][ÃA]O|EXAME|JURIDICO|JURÍDICO|FORMA[ÇC]|AGUARDANDO|PRONTO PARA|EM PROCESSO)/i;

function parseAbaIndividual(csvText, assistenteHint) {
  const linhas = parseCsv(csvText);
  // Acha cabeçalho: linha que tem "CARGO" ou "FUNÇÃO" entre as primeiras 5 colunas
  let headerIdx = -1;
  for (let i = 0; i < linhas.length && i < 10; i++) {
    if (linhas[i].slice(0, 6).some(c => /CARGO|FUNÇÃO|FUNCAO/i.test(norm(c)))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return [];
  const idx = detectarColunas(linhas[headerIdx]);
  if (idx.cargo == null) return [];

  const out = [];
  let linhasVaziasConsecutivas = 0;
  for (let i = headerIdx + 1; i < linhas.length; i++) {
    const r = linhas[i];
    const cargo = norm(r[idx.cargo]);

    // Se 2 linhas em branco consecutivas, parou a tabela de vagas
    const linhaToda = r.map(c => norm(c)).join('');
    if (!linhaToda) {
      linhasVaziasConsecutivas++;
      if (linhasVaziasConsecutivas >= 2) break;
      continue;
    }
    linhasVaziasConsecutivas = 0;

    if (!cargo) continue;
    // Bloqueia textos que não são cargo (títulos de outras seções, nomes, etc)
    if (NAO_E_CARGO_RE.test(cargo)) {
      // Provavelmente entrou em outra tabela — para
      break;
    }

    const loja = norm(r[idx.loja]);
    if (!loja) continue;  // Sem loja = vaga fechada/consolidada

    const statusRaw = norm(r[idx.status_final ?? idx.status]) || norm(r[idx.status]);
    if (statusRaw && statusRaw.toUpperCase() === 'OK') continue;  // Vaga fechada
    // Se tem status, exige que seja um status válido de andamento
    if (statusRaw && !STATUS_VALIDOS_RE.test(statusRaw)) continue;

    out.push({
      cargo,
      requ:          norm(r[idx.requ]),
      loja,
      assistente:    norm(r[idx.assistente]) || assistenteHint || '',
      gestor:        norm(r[idx.gestor]),
      abertura:      norm(r[idx.abertura]),
      prazo:         norm(r[idx.prazo]),
      classificacao: norm(r[idx.classificacao]),
      substituindo:  norm(r[idx.substituindo]),
      motivo:        norm(r[idx.motivo]),
      admissao:      norm(r[idx.admissao]),
      status:        statusRaw,
      substituto:    norm(r[idx.substituto]),
    });
  }
  return out;
}

// ===== Função principal — painel geral =====
export function parseVagasCsv(csvText) {
  const linhas = parseCsv(csvText);
  return {
    gerado_em: new Date().toISOString(),
    total_abertas:    parseTotaisCabecalho(linhas),
    assistentes:      parseAssistentes(linhas),
    analistas:        parseAnalistas(linhas),
    status_vagas:     parseStatus(linhas),
    vagas_por_loja:   parseVagasPorLoja(linhas),
    admissao_semanal: parseAdmissaoSemanal(linhas),
    vagas_detalhadas: [],  // Preenchido depois pelas abas individuais
  };
}

// ===== Junta dados do painel geral + todas abas individuais =====
export function parseVagasCompleto(csvPainel, abasIndividuais) {
  // abasIndividuais = [{ csv, assistente }]
  const dados = parseVagasCsv(csvPainel);
  const detalhe = [];
  for (const aba of abasIndividuais) {
    detalhe.push(...parseAbaIndividual(aba.csv, aba.assistente));
  }
  dados.vagas_detalhadas = detalhe;

  // Recalcula vagas_por_loja a partir das vagas detalhadas (mais preciso
  // que o número manual do painel — esse pode estar defasado).
  // Mantém os nomes "LJ01 - DF", "LJ02"... do painel mas atualiza qtd.
  const numLoja = (n) => {
    const m = String(n || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const contagem = {};
  for (const v of detalhe) {
    const k = numLoja(v.loja);
    if (k != null) contagem[k] = (contagem[k] || 0) + 1;
  }
  dados.vagas_por_loja = (dados.vagas_por_loja || []).map(l => ({
    loja: l.loja,
    qtd: contagem[numLoja(l.loja)] || 0,
  }));

  return dados;
}
