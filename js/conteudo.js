// Esconde um texto do PDF sem cobrir nada por cima, como um editor de verdade:
// lê os comandos que desenham a página (o "content stream"), acha o comando que
// escreve aquele texto e o deixa invisível (modo de renderização 3, do próprio
// formato PDF). Bordas, linhas e fundo em volta não são tocados.
// Os trechos inseridos ficam marcados (/EdPdf BMC … EMC) para a Correção desfazer.
window.Conteudo = (function () {
  const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
  const MARCA = 'EdPdf';
  const RE_MARCA = /\s?\/EdPdf BMC [\d.]+ Tr EMC\s?/g;

  // ---------- Bytes <-> texto (1 caractere por byte) ----------

  function paraTexto(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return s;
  }

  function paraBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function bytesDoStream(doc, ref) {
    const s = doc.context.lookup(ref);
    return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : new Uint8Array();
  }

  // Os streams de conteúdo da página, como [ref].
  function refsConteudo(page) {
    const bruto = page.node.get(PDFName.of('Contents'));
    if (!bruto) return [];
    const cont = page.doc.context.lookup(bruto);
    return cont instanceof PDFArray ? cont.asArray() : [bruto];
  }

  function trocarConteudo(doc, page, texto) {
    const ref = doc.context.register(doc.context.flateStream(paraBytes(texto)));
    page.node.set(PDFName.of('Contents'), ref);
  }

  // ---------- Leitura dos comandos ----------

  const branco = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const DELIM = '()<>[]{}/%';

  // [{ op, args: [{ t, v }], ini, fim }]: ini/fim = posição no texto (args + operador)
  function operacoes(s) {
    const ops = [];
    let args = [];
    let iniArgs = -1;
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (branco(s.charCodeAt(i))) { i++; continue; }
      const ch = s[i];
      const ini = i;
      let tk;
      if (ch === '%') {
        while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
        continue;
      } else if (ch === '(') {
        let nivel = 1;
        i++;
        while (i < n && nivel) {
          if (s[i] === '\\') i += 2;
          else { if (s[i] === '(') nivel++; else if (s[i] === ')') nivel--; i++; }
        }
        tk = { t: 'str', v: s.slice(ini, i) };
      } else if (ch === '<' && s[i + 1] === '<') { i += 2; tk = { t: 'delim', v: '<<' }; }
      else if (ch === '>' && s[i + 1] === '>') { i += 2; tk = { t: 'delim', v: '>>' }; }
      else if (ch === '<') {
        const f = s.indexOf('>', i);
        i = f < 0 ? n : f + 1;
        tk = { t: 'hex', v: s.slice(ini, i) };
      } else if ('[]{}'.includes(ch)) { i++; tk = { t: 'delim', v: ch }; }
      else if (ch === '/') {
        i++;
        while (i < n && !branco(s.charCodeAt(i)) && !DELIM.includes(s[i])) i++;
        tk = { t: 'nome', v: s.slice(ini, i) };
      } else {
        while (i < n && !branco(s.charCodeAt(i)) && !DELIM.includes(s[i])) i++;
        if (i === ini) { i++; continue; } // caractere solto (ex.: ")" sem par)
        const v = s.slice(ini, i);
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) tk = { t: 'num', v: parseFloat(v) };
        else if (v === 'true' || v === 'false' || v === 'null') tk = { t: 'kw', v };
        else tk = { t: 'op', v };
      }
      if (tk.t !== 'op') {
        if (iniArgs < 0) iniArgs = ini;
        args.push(tk);
        continue;
      }
      if (tk.v === 'BI') {
        // imagem embutida: pula os dados binários entre ID e EI
        const id = /\sID\s/g;
        id.lastIndex = i;
        const mId = id.exec(s);
        const ei = /\sEI(?=\s|$)/g;
        ei.lastIndex = mId ? mId.index + mId[0].length : i;
        const mEi = ei.exec(s);
        i = mEi ? mEi.index + mEi[0].length : n;
      }
      ops.push({ op: tk.v, args, ini: iniArgs >= 0 ? iniArgs : ini, fim: i });
      args = [];
      iniArgs = -1;
    }
    return ops;
  }

  function bytesDaString(tk) {
    if (tk.t === 'hex') {
      let h = tk.v.slice(1, -1).replace(/\s/g, '');
      if (h.length % 2) h += '0';
      return (h.match(/../g) || []).map((x) => parseInt(x, 16));
    }
    const s = tk.v.slice(1, -1);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s[i];
      if (c !== '\\') { out.push(s.charCodeAt(i) & 0xff); continue; }
      c = s[++i];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (c in esc) out.push(esc[c]);
      else if (/[0-7]/.test(c)) {
        let o = c;
        while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i];
        out.push(parseInt(o, 8) & 0xff);
      } else if (c === '\r') { if (s[i + 1] === '\n') i++; } // quebra de linha escapada
      else if (c !== '\n' && c !== undefined) out.push(c.charCodeAt(0) & 0xff);
    }
    return out;
  }

  // ---------- Fontes (largura de cada caractere, para saber onde o texto termina) ----------

  const numero = (x) => (x instanceof PDFNumber ? x.asNumber() : undefined);

  function lerFonte(recursos, nome) {
    const fontes = recursos?.lookup(PDFName.of('Font'));
    const f = fontes instanceof PDFDict ? fontes.lookup(PDFName.of(nome.slice(1))) : null;
    if (!(f instanceof PDFDict)) return { doisBytes: false, largura: () => 500 };
    if (String(f.lookup(PDFName.of('Subtype'))) === '/Type0') {
      const descendentes = f.lookup(PDFName.of('DescendantFonts'));
      const desc = descendentes instanceof PDFArray ? descendentes.lookup(0) : null;
      const dw = numero(desc?.lookup(PDFName.of('DW'))) ?? 1000;
      const mapa = new Map();
      const W = desc?.lookup(PDFName.of('W'));
      if (W instanceof PDFArray) {
        for (let i = 0; i < W.size();) {
          const c1 = numero(W.lookup(i));
          const prox = W.lookup(i + 1);
          if (prox instanceof PDFArray) {
            for (let k = 0; k < prox.size(); k++) mapa.set(c1 + k, numero(prox.lookup(k)) ?? dw);
            i += 2;
          } else {
            const c2 = numero(prox);
            const w = numero(W.lookup(i + 2)) ?? dw;
            for (let c = c1; c <= c2 && c - c1 < 65536; c++) mapa.set(c, w);
            i += 3;
          }
        }
      }
      return { doisBytes: true, largura: (c) => mapa.get(c) ?? dw };
    }
    const primeiro = numero(f.lookup(PDFName.of('FirstChar'))) ?? 0;
    const W = f.lookup(PDFName.of('Widths'));
    const larguras = W instanceof PDFArray ? Array.from({ length: W.size() }, (_, k) => numero(W.lookup(k)) ?? 0) : null;
    const descritor = f.lookup(PDFName.of('FontDescriptor'));
    const falta = numero(descritor instanceof PDFDict ? descritor.lookup(PDFName.of('MissingWidth')) : undefined) ?? 0;
    if (larguras) return { doisBytes: false, largura: (c) => larguras[c - primeiro] ?? falta };
    const padrao = fontePadrao(String(f.lookup(PDFName.of('BaseFont')) || ''));
    return { doisBytes: false, largura: padrao || (() => 500) };
  }

  // As 14 fontes padrão do PDF podem vir sem tabela de larguras: usa as medidas
  // que o pdf-lib traz (código -> caractere pela codificação WinAnsi).
  const WINANSI = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
  function fontePadrao(baseFont) {
    let nome = baseFont.replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
    const negrito = /bold/i.test(nome);
    const italico = /italic|oblique/i.test(nome);
    const familia = /times|serif/i.test(nome) && !/sans/i.test(nome) ? 'Times' : /courier|mono/i.test(nome) ? 'Courier' : /helvetica|arial/i.test(nome) ? 'Helvetica' : null;
    if (!familia) return null;
    nome = familia === 'Times'
      ? ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'][(negrito ? 1 : 0) + (italico ? 2 : 0)]
      : `${familia}${negrito || italico ? '-' : ''}${negrito ? 'Bold' : ''}${italico ? 'Oblique' : ''}`;
    try {
      const fonte = PDFLib.StandardFontEmbedder.for(nome);
      const cache = new Map();
      return (c) => {
        if (!cache.has(c)) {
          let w = 500;
          try { w = fonte.widthOfTextAtSize(WINANSI[c] ?? String.fromCharCode(c), 1000); } catch { /* caractere sem medida */ }
          cache.set(c, w);
        }
        return cache.get(c);
      };
    } catch { return null; }
  }

  // ---------- Onde cada comando de texto escreve ----------

  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const ponto = (m) => [m[4], m[5]];

  // [{ k (índice do comando), x0, y0, x1, y1 (início e fim na página), tr }]
  // larguras: por comando de texto, na ordem da página, as larguras (em "em") que o
  // pdf.js usou para desenhar cada caractere (ver largurasDoPdfjs). Com elas o fim
  // de cada comando é exato; sem elas, usa as tabelas da fonte, que às vezes erram
  // um pouco — e um pedaço do texto (ex.: o "1" de "2017", escrito num comando
  // separado) parecia cair fora do número e ficava visível.
  function textosDaPagina(ops, recursos, larguras) {
    let nTexto = 0;
    const segmentos = [];
    const fontes = new Map();
    let ctm = [1, 0, 0, 1, 0, 0];
    let ts = { fonte: null, info: null, tam: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, Tr: 0 };
    let tm = null;
    let tlm = null;
    const pilha = [];
    const mover = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = [...tlm]; };
    const trm = () => mul([ts.tam * ts.Th, 0, 0, ts.tam, 0, ts.Ts], mul(tm, ctm));

    function mostrar(k, partes) {
      const doPdfjs = larguras?.[nTexto++];
      if (!tm || !ts.info) return;
      const [x0, y0] = ponto(trm());
      const passo = ts.info.doisBytes ? 2 : 1;
      const codigos = partes.filter((p) => p.t === 'str' || p.t === 'hex')
        .reduce((n, p) => n + Math.floor(bytesDaString(p).length / passo), 0);
      // só confia nas larguras do pdf.js se a contagem de caracteres bater
      const exatas = doPdfjs && doPdfjs.length === codigos ? doPdfjs : null;
      let g = 0;
      for (const p of partes) {
        if (p.t === 'num') {
          tm = mul([1, 0, 0, 1, (-p.v / 1000) * ts.tam * ts.Th, 0], tm);
          continue;
        }
        if (p.t !== 'str' && p.t !== 'hex') continue;
        const b = bytesDaString(p);
        for (let i = 0; i + passo - 1 < b.length; i += passo) {
          const c = passo === 2 ? (b[i] << 8) | b[i + 1] : b[i];
          const em = exatas ? exatas[g] : ts.info.largura(c) / 1000;
          g++;
          const avanco = (em * ts.tam + ts.Tc + (passo === 1 && c === 32 ? ts.Tw : 0)) * ts.Th;
          tm = mul([1, 0, 0, 1, avanco, 0], tm);
        }
      }
      const [x1, y1] = ponto(trm());
      segmentos.push({ k, x0, y0, x1, y1, tr: ts.Tr });
    }

    ops.forEach((o, k) => {
      const a = o.args;
      const n = (i) => (a[i]?.t === 'num' ? a[i].v : 0);
      switch (o.op) {
        case 'q': pilha.push({ ctm: [...ctm], ts: { ...ts } }); break;
        case 'Q': { const s = pilha.pop(); if (s) { ctm = s.ctm; ts = s.ts; } break; }
        case 'cm': ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], ctm); break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'ET': tm = null; tlm = null; break;
        case 'Tf':
          ts.fonte = a[0]?.v;
          ts.tam = n(1);
          if (!fontes.has(ts.fonte)) fontes.set(ts.fonte, lerFonte(recursos, ts.fonte || '/'));
          ts.info = fontes.get(ts.fonte);
          break;
        case 'Tc': ts.Tc = n(0); break;
        case 'Tw': ts.Tw = n(0); break;
        case 'Tz': ts.Th = n(0) / 100; break;
        case 'TL': ts.TL = n(0); break;
        case 'Ts': ts.Ts = n(0); break;
        case 'Tr': ts.Tr = n(0); break;
        case 'Td': if (tlm) mover(n(0), n(1)); break;
        case 'TD': if (tlm) { ts.TL = -n(1); mover(n(0), n(1)); } break;
        case 'Tm': tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tm = [...tlm]; break;
        case 'T*': if (tlm) mover(0, -ts.TL); break;
        case 'Tj': mostrar(k, a); break;
        case "'": if (tlm) mover(0, -ts.TL); mostrar(k, a); break;
        case '"': ts.Tw = n(0); ts.Tc = n(1); if (tlm) mover(0, -ts.TL); mostrar(k, a.slice(2)); break;
        case 'TJ': mostrar(k, a); break;
        default: break;
      }
    });
    return segmentos;
  }

  // ---------- Esconder ----------

  // Larguras (em "em") de cada caractere de cada comando de texto da página, como o
  // pdf.js desenhou. Ordem = ordem dos comandos de texto no conteúdo da página
  // (textos de objetos internos, os "forms", ficam de fora, como em ocultar()).
  async function largurasDoPdfjs(pagePdfjs) {
    const { OPS, AnnotationMode } = pdfjsLib;
    const lista = await pagePdfjs.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
    const MOSTRAR = new Map([[OPS.showText, 0], [OPS.showSpacedText, 0], [OPS.nextLineShowText, 0], [OPS.nextLineSetSpacingShowText, 2]]);
    const resultado = [];
    let matrizFonte = [0.001];
    let nivelForm = 0;
    lista.fnArray.forEach((fn, i) => {
      const args = lista.argsArray[i];
      if (fn === OPS.paintFormXObjectBegin) nivelForm++;
      else if (fn === OPS.paintFormXObjectEnd) nivelForm--;
      else if (fn === OPS.setFont) {
        try { matrizFonte = pagePdfjs.commonObjs.get(args[0])?.fontMatrix || [0.001]; } catch { matrizFonte = [0.001]; }
      } else if (MOSTRAR.has(fn) && nivelForm === 0) {
        const glifos = args[MOSTRAR.get(fn)] || [];
        resultado.push(glifos.filter((x) => typeof x !== 'number').map((x) => (x?.width ?? 0) * matrizFonte[0]));
      }
    });
    return resultado;
  }

  // alvos: [{ id, x, y, w, tamanho }] (linha de base, em pontos do PDF).
  // Esconde, na página, os comandos de texto que caem dentro de cada alvo.
  // Devolve os ids escondidos por completo; os outros ficam para a cobertura antiga.
  function ocultar(doc, indicePagina, alvos, larguras) {
    const page = doc.getPages()[indicePagina];
    const refs = refsConteudo(page);
    if (!refs.length || !alvos.length) return new Set();
    const s = refs.map((r) => paraTexto(bytesDoStream(doc, r))).join('\n');
    const ops = operacoes(s);
    const segmentos = textosDaPagina(ops, page.node.Resources(), larguras);

    const ocultos = new Set();
    const escolhidos = new Map(); // k -> segmento
    for (const alvo of alvos) {
      const ini = alvo.x - 0.6;
      const fim = alvo.x + alvo.w + 0.6;
      let soma = 0;
      const meus = [];
      for (const sg of segmentos) {
        if (Math.abs(sg.y0 - alvo.y) > 0.35 * alvo.tamanho || Math.abs(sg.y1 - sg.y0) > 0.2 * alvo.tamanho) continue;
        const a0 = Math.min(sg.x0, sg.x1);
        const a1 = Math.max(sg.x0, sg.x1);
        const dentro = Math.min(a1, fim) - Math.max(a0, ini);
        const comprimento = a1 - a0;
        // o comando tem de estar quase todo dentro do alvo (não esconder texto vizinho);
        // reserva: se começa dentro do alvo e não passa muito do fim, também conta
        // (cobre um erro pequeno na largura calculada)
        const quaseTodo = comprimento < 0.01 ? a0 >= ini && a0 <= fim : dentro / comprimento >= 0.9;
        const comecaDentro = sg.x0 >= ini && sg.x0 <= alvo.x + alvo.w - 0.2 && a1 <= fim + 0.25 * alvo.tamanho;
        if (!quaseTodo && !comecaDentro) continue;
        meus.push(sg);
        soma += Math.max(0, Math.min(a1, alvo.x + alvo.w) - Math.max(a0, alvo.x));
      }
      if (meus.length && soma >= 0.7 * alvo.w) {
        ocultos.add(alvo.id);
        for (const sg of meus) escolhidos.set(sg.k, sg);
      }
    }
    if (!escolhidos.size) return ocultos;

    let novo = '';
    let pos = 0;
    ops.forEach((o, k) => {
      const sg = escolhidos.get(k);
      if (!sg) return;
      novo += `${s.slice(pos, o.ini)}/${MARCA} BMC 3 Tr EMC ${s.slice(o.ini, o.fim)} /${MARCA} BMC ${sg.tr} Tr EMC`;
      pos = o.fim;
    });
    novo += s.slice(pos);
    trocarConteudo(doc, page, novo);
    return ocultos;
  }

  // Tira as marcas inseridas por ocultar() (o texto antigo volta a aparecer).
  function desocultar(doc, page) {
    const refs = refsConteudo(page);
    const textos = refs.map((r) => paraTexto(bytesDoStream(doc, r)));
    if (!textos.some((t) => t.includes(`/${MARCA} BMC`))) return false;
    trocarConteudo(doc, page, textos.join('\n').replace(RE_MARCA, ' '));
    return true;
  }

  return { ocultar, desocultar, largurasDoPdfjs };
})();
