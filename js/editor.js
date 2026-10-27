// Edita o texto já escrito num PDF: toque no texto, digite o novo, ajuste fonte,
// tamanho, cor e posição, e baixe o PDF.
// No PDF baixado o texto antigo é coberto com a cor do fundo (parando antes de uma
// linha/pontilhado logo abaixo dele, para não apagá-la) e o novo é escrito por cima.
(function () {
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const arquivo = document.getElementById('arquivo');
  const area = document.getElementById('paginas');
  const status = document.getElementById('status');
  const botaoBaixar = document.querySelector('[data-acao="baixar"]');
  const botaoDesfazer = document.querySelector('[data-acao="desfazer"]');
  const botaoSalvar = document.querySelector('[data-acao="salvar"]');
  const barraTexto = document.getElementById('barra-texto');
  const ctl = Object.fromEntries([...barraTexto.querySelectorAll('[data-ctl]')].map((el) => [el.dataset.ctl, el]));

  // Fontes padrão do PDF (as embutidas no arquivo costumam vir só com as letras usadas).
  const FAMILIAS = {
    Helvetica: { css: 'Helvetica, Arial, sans-serif', pdf: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'] },
    Times: { css: '"Times New Roman", Times, serif', pdf: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'] },
    Courier: { css: '"Courier New", Courier, monospace', pdf: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] },
  };

  let original = null; // bytes do PDF aberto, nunca alterados
  let pdfAtual = null; // o mesmo PDF, lido pelo pdf.js para desenhar
  let zoom = 1;
  let nomeArquivo = 'documento';
  let trechos = []; // um por pedaço de texto do PDF
  let selecionado = null;
  // id do trecho -> { texto, familia, negrito, italico, tamanho, cor: [r, g, b], dx, dy }
  // (dx/dy = deslocamento em pontos do PDF). O id é o mesmo a cada desenho.
  const edicoes = new Map();

  // ---------- Abrir e desenhar ----------

  // lista: edições vindas de um arquivo .edicao.json ou da Correção (senão, as
  // lembradas deste PDF). aviso: texto do status quando alguma edição é aplicada.
  async function abrir(bytes, nome, lista = null, aviso = (n) => `${n} alteração(ões) anterior(es) restaurada(s). "Desfazer" começa do zero.`) {
    original = bytes;
    idPdf = impressao(bytes);
    nomeArquivo = nome.replace(/\.pdf$/i, '');
    edicoes.clear();
    trechos = [];
    area.innerHTML = '';
    atualizarStatus('Abrindo…');

    try {
      pdfAtual = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    } catch (e) {
      original = null;
      atualizarStatus(/password/i.test(e.name + e.message) ? 'Este PDF tem senha e não pode ser editado.' : 'Não foi possível ler este arquivo como PDF.');
      return;
    }
    zoom = 1;
    await desenhar();
    botaoBaixar.disabled = false;
    botaoSalvar.disabled = false;
    if (!trechos.length) {
      atualizarStatus('Este PDF não tem texto editável (o texto pode estar como imagem).');
      return;
    }
    const n = restaurarEdicoes(lista ?? lembradas());
    atualizarStatus(n ? aviso(n) : undefined);
    lembrar();
    if (n) agendarFundo();
  }

  // ---------- Memória das edições ----------
  // As alterações de cada PDF ficam guardadas no próprio aparelho (só os textos e
  // ajustes, não o PDF). Ao abrir o mesmo PDF de novo, elas voltam sozinhas.

  const MEMORIA = 'editar-pdf:';
  let idPdf = null;

  // identifica o PDF pelo conteúdo (FNV-1a), não pelo nome do arquivo
  function impressao(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return `${(h >>> 0).toString(16)}-${bytes.length}`;
  }

  function listaEdicoes() {
    return [...edicoes].map(([id, estado]) => ({ id, pagina: trechos[id].pagina, original: trechos[id].original, estado }));
  }

  function lembrar() {
    try {
      if (edicoes.size) localStorage.setItem(MEMORIA + idPdf, JSON.stringify({ nome: nomeArquivo, quando: Date.now(), edicoes: listaEdicoes() }));
      else localStorage.removeItem(MEMORIA + idPdf);
    } catch { /* sem armazenamento (aba anônima, cheio…) */ }
  }

  function lembradas() {
    try { return JSON.parse(localStorage.getItem(MEMORIA + idPdf))?.edicoes || []; } catch { return []; }
  }

  // Liga cada edição ao trecho certo: pelo id, conferindo o texto original;
  // se não bater, procura o mesmo texto na mesma página.
  // Edições da Correção não têm id: vêm com a cobertura antiga e a posição do texto
  // (pontos do PDF) e são ligadas pelo trecho que a cobertura escondia.
  function restaurarEdicoes(lista) {
    const usados = new Set();
    for (const s of lista) {
      if ('capa' in s) {
        if (!s.capa) continue; // texto de camada nova: a alteração vem da gravação no PDF
        const t = trechoSobCapa(s);
        if (!t) continue;
        usados.add(t.id);
        const e = s.estado;
        edicoes.set(t.id, e.texto === undefined
          ? { ...padrao(t), texto: '' } // só cobriu (texto apagado)
          : { texto: e.texto, familia: e.familia, negrito: e.negrito, italico: e.italico, tamanho: e.tamanho, cor: e.cor, dx: e.x - t.x, dy: e.y - t.y });
        aplicar(t);
        continue;
      }
      let t = trechos[s.id];
      if (!t || t.original !== s.original || usados.has(t.id)) {
        t = trechos.find((x) => x.pagina === s.pagina && x.original === s.original && !usados.has(x.id));
      }
      if (!t) continue;
      usados.add(t.id);
      edicoes.set(t.id, s.estado);
      aplicar(t);
    }
    return usados.size;
  }

  // O trecho da página que a cobertura antiga mais escondia (mais da metade dele),
  // ou, se nenhum, o que tem a linha de base dentro dela.
  function trechoSobCapa({ pagina, capa: c }) {
    let melhor = null;
    let nota = 0.5;
    for (const t of trechos) {
      if (t.pagina !== pagina) continue;
      const r = t.capaPdf;
      const w = Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
      const h = Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y);
      const n = w > 0 && h > 0 ? (w * h) / (r.w * r.h) : 0;
      if (n > nota) { nota = n; melhor = t; }
    }
    return melhor ?? trechos.find((t) => t.pagina === pagina && t.x >= c.x && t.x <= c.x + c.w && t.y >= c.y && t.y <= c.y + c.h);
  }

  // ---------- Correção ----------
  // Um PDF baixado por este app tem, em cada página, o conteúdo original entre um
  // "q" e um "Q" e depois a camada do app: só retângulos (cobertura e bordas
  // redesenhadas) e textos nas fontes padrão Helvetica/Times/Courier. A Correção
  // tira essa camada (o que devolve o PDF original), lê dela as alterações e as
  // aplica de novo, agora com as medições atuais. Funciona também com PDF editado
  // mais de uma vez (camadas uma dentro da outra).

  function conteudo(doc, ref, limite = Infinity) {
    const s = doc.context.lookup(ref);
    if (!(s instanceof PDFRawStream)) return null;
    if (s.contents.length > limite) return null;
    try { return new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()); } catch { return null; }
  }

  async function desfazerCamadas(bytes) {
    const doc = await PDFDocument.load(bytes);
    const gravadas = lerMeta(doc); // PDFs do formato novo trazem as alterações gravadas
    doc.catalog.delete(PDFName.of(META));
    let lista = [];
    doc.getPages().forEach((page, pagina) => {
      for (;;) {
        const cont = page.node.get(PDFName.of('Contents'));
        if (!(cont instanceof PDFArray) || cont.size() < 3) break;
        const refs = cont.asArray();
        if (conteudo(doc, refs[0], 64)?.trim() !== 'q') break;
        let k = -1; // o "Q" sozinho mais ao fim: depois dele vem a camada do app
        for (let i = refs.length - 2; i > 0; i--) if (conteudo(doc, refs[i], 64)?.trim() === 'Q') { k = i; break; }
        if (k < 0) break;
        const camada = lerCamada(refs.slice(k + 1).map((r) => conteudo(doc, r) ?? '').join('\n'));
        if (!camada) break;
        // camadas de dentro são mais antigas: ficam antes na lista
        lista = [...camada.map((e) => ({ ...e, pagina })), ...lista];
        page.node.set(PDFName.of('Contents'), doc.context.obj(refs.slice(1, k)));
      }
      Conteudo.desocultar(doc, page); // o texto antigo, escondido pelo comando, volta
    });
    // as gravadas no PDF já incluem as das camadas de formato novo (sem cobertura)
    lista = [...lista.filter((e) => e.capa), ...gravadas];
    return lista.length ? { bytes: await doc.save(), edicoes: lista } : null;
  }

  // WinAnsi (codificação das fontes padrão) nos códigos 0x80–0x9F; o resto é Latin-1.
  const WINANSI = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
  const deHexWinAnsi = (h) => (h.replace(/\s/g, '').match(/../g) || []).map((b) => {
    const c = parseInt(b, 16);
    return WINANSI[c] ?? String.fromCharCode(c);
  }).join('');

  // Lê a camada do app. Retorna [{ capa: {x,y,w,h}, estado: {texto, familia, negrito,
  // italico, tamanho, cor, x, y} }], ou null se tiver qualquer coisa que o app não
  // desenha (aí não é uma camada dele e o PDF fica como está).
  function lerCamada(texto) {
    const tokens = texto.match(/<[0-9A-Fa-f\s]*>|\[[^\]]*\]|\/[^\s/[\]<>()]+|[^\s[\]<>/()]+/g) || [];
    const OPERADORES = new Set(['q', 'Q', 'rg', 'w', 'd', 'cm', 'm', 'l', 'h', 'f', 'BT', 'ET', 'Tf', 'TL', 'Tm', 'Tj', 'T*']);
    const blocos = [];
    const pilha = [];
    let args = [];
    let cor = [0, 0, 0];
    let tx = 0;
    let ty = 0;
    let pontos = [];
    let fonte = null;
    let tamanho = 0;
    let tm = [0, 0];
    for (const tk of tokens) {
      if (!/^[A-Za-z*]+$/.test(tk) || tk === 'T') { args.push(tk); continue; }
      if (!OPERADORES.has(tk)) return null;
      const n = args.map(Number);
      switch (tk) {
        case 'q': pilha.push([tx, ty]); break;
        case 'Q': [tx, ty] = pilha.pop() || [0, 0]; break;
        case 'rg': cor = n.slice(0, 3).map((v) => Math.round(v * 255)); break;
        case 'cm':
          if (n[0] !== 1 || n[1] !== 0 || n[2] !== 0 || n[3] !== 1) return null; // o app só translada
          tx += n[4]; ty += n[5];
          break;
        case 'm': case 'l': pontos.push([n[0] + tx, n[1] + ty]); break;
        case 'f': {
          if (!pontos.length) return null;
          const xs = pontos.map((p) => p[0]);
          const ys = pontos.map((p) => p[1]);
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          blocos.push({ tipo: 'ret', x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, cor });
          pontos = [];
          break;
        }
        case 'Tf': {
          const nome = args[0].slice(1);
          if (!/^(Helvetica|Times|Courier)(-[A-Za-z]+)?-\d+$/.test(nome)) return null;
          fonte = nome;
          tamanho = n[1];
          break;
        }
        case 'Tm': tm = [n[4], n[5]]; break;
        case 'Tj':
          if (!fonte || !/^</.test(args[0] || '')) return null;
          blocos.push({
            tipo: 'texto', texto: deHexWinAnsi(args[0].slice(1, -1)), x: tm[0], y: tm[1], tamanho, cor,
            familia: fonte.startsWith('Times') ? 'Times' : fonte.startsWith('Courier') ? 'Courier' : 'Helvetica',
            negrito: /Bold/.test(fonte), italico: /Oblique|Italic/.test(fonte),
          });
          break;
        default: break;
      }
      args = [];
    }

    // cada alteração = cobertura, bordas redesenhadas (mesma altura, mais finas) e, se não foi apagado, o texto
    const lista = [];
    let atual = null;
    const perto = (a, b) => Math.abs(a - b) < 0.01;
    for (const b of blocos) {
      if (b.tipo === 'ret') {
        const borda = atual && !atual.temTexto && perto(b.y, atual.capa.y) && perto(b.h, atual.capa.h) && b.w < atual.capa.w;
        if (!borda) { atual = { capa: { x: b.x, y: b.y, w: b.w, h: b.h }, estado: {} }; lista.push(atual); }
      } else {
        // texto sem cobertura antes: o antigo foi escondido pelo comando (formato
        // novo); a alteração em si vem gravada no PDF (lerMeta)
        if (!atual || atual.temTexto) { atual = { capa: null, estado: {} }; lista.push(atual); }
        const { tipo, ...estado } = b;
        atual.estado = estado;
        atual.temTexto = true;
      }
    }
    return lista.length ? lista.map(({ capa, estado }) => ({ capa, estado })) : null;
  }

  // Arquivo .edicao.json: o PDF original + as alterações, para continuar em outro aparelho.
  function paraBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function deBase64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  // Desenha as páginas no zoom atual (zoom 1 = largura da tela).
  async function desenhar() {
    desselecionar();
    area.innerHTML = '';
    trechos = [];
    paginasTela = [];
    ocultosTela = new Set();
    const largura = Math.min(1100, area.clientWidth - 32) * zoom;
    for (let n = 1; n <= pdfAtual.numPages; n++) {
      const page = await pdfAtual.getPage(n);
      const viewport = page.getViewport({ scale: largura / page.getViewport({ scale: 1 }).width });
      // celulares limitam o tamanho do canvas (~16 milhões de pixels)
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (viewport.width * viewport.height)));
      const div = document.createElement('div');
      div.className = 'pagina-edicao';
      div.style.width = `${viewport.width}px`;
      div.style.height = `${viewport.height}px`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const camada = document.createElement('div');
      camada.className = 'camada-texto';
      div.append(canvas, camada);
      area.append(div);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      // larguras exatas de cada caractere, para achar o comando de cada texto (conteudo.js)
      let larguras = null;
      try { larguras = await Conteudo.largurasDoPdfjs(page); } catch { /* usa as tabelas da fonte */ }
      paginasTela.push({ canvas, viewport, dpr, larguras });

      // Cópia invisível em alta resolução (~4 px por ponto do PDF) só para medir
      // fundo, cor do texto e bordas: na tela uma borda fina tem menos de 1 px e
      // sai mais clara e grossa do que é. Descartada depois da página.
      const fator = Math.max(dpr, Math.min(4 / viewport.scale, Math.sqrt(16e6 / (viewport.width * viewport.height))));
      const analise = document.createElement('canvas');
      analise.width = Math.floor(viewport.width * fator);
      analise.height = Math.floor(viewport.height * fator);
      await page.render({ canvasContext: analise.getContext('2d', { willReadFrequently: true }), viewport, transform: [fator, 0, 0, fator, 0, 0] }).promise;

      const { items, styles } = await page.getTextContent();
      for (const item of items) {
        if (!item.str.trim()) continue;
        const t = criarTrecho(n - 1, item, styles[item.fontName] || {}, page, viewport, analise, fator);
        if (!t) continue;
        trechos.push(t);
        camada.append(t.capa, t.el);
        aplicar(t);
      }
      analise.width = analise.height = 0; // libera a memória (importante no celular)
    }
    if (edicoes.size) atualizarFundo();
  }

  function criarTrecho(pagina, item, estilo, page, viewport, canvas, dpr) {
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) return null; // texto girado: não suportado
    const tamanho = Math.hypot(c, d);
    const ascent = estilo.ascent || 0.8;
    const descent = estilo.descent || -0.2;

    // retângulo do texto em pontos do PDF (y para cima) e na tela
    const ret = { x, y: y + descent * tamanho, w: item.width || a * item.str.length * 0.5, h: (ascent - descent) * tamanho };
    const tela = retanguloTela(viewport, ret);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cores = amostrarCores(ctx, canvas, tela, dpr);

    const t = {
      id: trechos.length, pagina, original: item.str, x, y, largura: ret.w, tamanho, ascent, descent, viewport,
      fonte: descreverFonte(page, item.fontName, estilo), cores,
      capaPdf: calcularCapa(ctx, canvas, dpr, viewport, y, tela, cores.fundo, tamanho * viewport.scale),
    };
    t.el = document.createElement('span');
    t.el.className = 'trecho';
    t.el.textContent = item.str;
    t.el.spellcheck = false;
    t.el.dataset.id = t.id;
    const capaTela = retanguloTela(viewport, t.capaPdf);
    t.linhas = bordasVerticais(ctx, canvas, dpr, viewport, capaTela, cores.fundo);
    t.capa = document.createElement('div');
    t.capa.className = 'capa';
    Object.assign(t.capa.style, posicao(capaTela), { background: css(cores.fundo) });
    for (const l of t.linhas) {
      const borda = document.createElement('div');
      const r = retanguloTela(viewport, { x: l.x, y: t.capaPdf.y, w: l.w, h: t.capaPdf.h });
      Object.assign(borda.style, { position: 'absolute', left: `${r.left - capaTela.left}px`, top: 0, width: `${r.width}px`, height: '100%', background: css(l.cor) });
      t.capa.append(borda);
    }
    return t;
  }

  function retanguloTela(viewport, r) {
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  const posicao = (r) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

  // Fonte padrão mais parecida com a do PDF.
  function descreverFonte(page, fontName, estilo) {
    let nome = '';
    try { nome = page.commonObjs.get(fontName)?.name || ''; } catch { /* fonte ainda não carregada */ }
    const negrito = /bold|black|heavy|semibold|demi|extrabold/i.test(nome);
    const italico = /italic|oblique/i.test(nome);
    const mono = estilo.fontFamily === 'monospace' || /mono|courier|consol/i.test(nome);
    const serifa = !mono && !/sans/i.test(nome) && (estilo.fontFamily === 'serif' || /times|serif|georgia|garamond|playfair|merriweather|lora|baskerville/i.test(nome));
    return { familia: mono ? 'Courier' : serifa ? 'Times' : 'Helvetica', negrito, italico };
  }

  // Cor do fundo e do texto. O fundo é a cor que MAIS aparece dentro do retângulo
  // do texto (os espaços entre as letras): é exatamente o que está embaixo dele.
  // Amostrar em volta não serve: numa tabela os pontos caem nas bordas das células,
  // que na tela saem cinza (suavizadas), e o fundo virava cinza.
  // O texto é o pixel mais diferente do fundo.
  function amostrarCores(ctx, canvas, r, dpr) {
    const x0 = Math.max(0, Math.round(r.left * dpr));
    const y0 = Math.max(0, Math.round(r.top * dpr));
    const w = Math.max(1, Math.min(canvas.width - x0, Math.round(r.width * dpr)));
    const h = Math.max(1, Math.min(canvas.height - y0, Math.round(r.height * dpr)));
    const img = ctx.getImageData(x0, y0, w, h).data;
    const grupos = new Map(); // cor arredondada -> { n, soma }
    for (let i = 0; i < img.length; i += 4) {
      const chave = (img[i] >> 3) << 10 | (img[i + 1] >> 3) << 5 | (img[i + 2] >> 3);
      const g = grupos.get(chave) || { n: 0, soma: [0, 0, 0] };
      g.n++;
      g.soma[0] += img[i]; g.soma[1] += img[i + 1]; g.soma[2] += img[i + 2];
      grupos.set(chave, g);
    }
    let maisComum = { n: 0, soma: [255, 255, 255] };
    for (const g of grupos.values()) if (g.n > maisComum.n) maisComum = g;
    const fundo = maisComum.soma.map((v) => Math.round(v / (maisComum.n || 1)));

    let texto = [0, 0, 0];
    let maior = -1;
    for (let i = 0; i < img.length; i += 4) {
      const dist = distancia(img, i, fundo);
      if (dist > maior) { maior = dist; texto = [img[i], img[i + 1], img[i + 2]]; }
    }
    return { fundo, texto };
  }

  // Área que cobre o texto antigo. Se logo abaixo da linha de base (ou acima do
  // topo das letras) houver uma linha/pontilhado/borda de tabela — fileira de
  // pixels que ocupa boa parte da largura —, a cobertura para antes dela, para a
  // linha continuar no PDF.
  function calcularCapa(ctx, canvas, dpr, viewport, baseY, tela, fundo, px) {
    const [, base] = viewport.convertToViewportPoint(0, baseY);
    const x0 = Math.max(0, Math.round((tela.left - 4) * dpr));
    const x1 = Math.min(canvas.width, Math.round((tela.left + tela.width + 4) * dpr));
    const w = x1 - x0;
    const ehLinha = (yTela) => {
      const y = Math.round(yTela * dpr);
      if (w <= 0 || y < 0 || y >= canvas.height) return false;
      const img = ctx.getImageData(x0, y, w, 1).data;
      let n = 0;
      for (let col = 0; col < w; col++) if (distancia(img, col * 4, fundo) > 80) n++;
      return n / w > 0.4;
    };
    const passo = 1 / dpr;
    // para baixo, a partir de logo abaixo da linha de base
    let fim = tela.top + tela.height + 0.5;
    for (let y = base + 1; y <= tela.top + tela.height + 3; y += passo) {
      if (ehLinha(y)) { fim = y - 0.3; break; }
    }
    // para cima, a partir do topo das letras (≈ 0,8 do tamanho acima da base)
    let inicio = tela.top - 0.5;
    for (let y = base - 0.8 * px; y >= tela.top - 3; y -= passo) {
      if (ehLinha(y)) { inicio = y + passo + 0.3; break; }
    }
    // um pouco além das laterais (~0,6 pt): letras podem passar um tiquinho da
    // largura oficial e sobrar encostadas numa borda (as bordas são redesenhadas)
    const lado = Math.max(0.5, 0.6 * viewport.scale);
    const [ax, ay] = viewport.convertToPdfPoint(tela.left - lado, fim);
    const [bx, by] = viewport.convertToPdfPoint(tela.left + tela.width + lado, inicio);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  // Bordas verticais (de tabela) que atravessam a área coberta. Uma coluna de pixels
  // só conta como borda se:
  // - continua por pelo menos BORDA_MIN pontos acima OU abaixo da cobertura (borda
  //   de tabela atravessa a célula; letra não: o "ANO" logo acima do ano tem ~7 pt,
  //   e antes uma coluna do "2" com o "A" em cima e a linha da célula embaixo era
  //   tomada por borda e redesenhada como um bloco grosso);
  // - ocupa ~toda a altura da cobertura (perna de letra não chega a tanto).
  // Elas são redesenhadas por cima da cobertura, para a tabela não ficar quebrada.
  // Retorna [{ x, w (pontos do PDF), cor }].
  const BORDA_MIN = 12;
  function bordasVerticais(ctx, canvas, dpr, viewport, capa, fundo) {
    const pt = viewport.scale * dpr; // pixels de análise por ponto do PDF
    const x0 = Math.max(0, Math.floor((capa.left - 1) * dpr));
    const x1 = Math.min(canvas.width, Math.ceil((capa.left + capa.width + 1) * dpr));
    const yTopo = Math.max(0, Math.floor(capa.top * dpr - (BORDA_MIN + 2) * pt));
    const yBase = Math.min(canvas.height, Math.ceil((capa.top + capa.height) * dpr + (BORDA_MIN + 2) * pt));
    const w = x1 - x0;
    const h = yBase - yTopo;
    if (w <= 0 || h <= 0) return [];
    const img = ctx.getImageData(x0, yTopo, w, h).data;
    const dentroDe = Math.round(capa.top * dpr) - yTopo;
    const dentroAte = Math.round((capa.top + capa.height) * dpr) - yTopo;
    const tinta = (col, lin) => col >= 0 && col < w && distancia(img, (lin * w + col) * 4, fundo) > 80;
    // tolera 1 px para os lados (suavização, borda levemente inclinada/curva)
    const perto = (col, lin) => tinta(col - 1, lin) || tinta(col, lin) || tinta(col + 1, lin);
    // quantos pontos a coluna continua com tinta, a partir de uma linha, num sentido
    const seguidas = (col, de, passo) => {
      let n = 0;
      for (let lin = de; lin >= 0 && lin < h && perto(col, lin); lin += passo) n++;
      return n / pt;
    };

    const colunas = [];
    for (let col = 0; col < w; col++) {
      if (!tinta(col, Math.max(0, dentroDe - 1)) && !tinta(col, Math.min(h - 1, dentroAte))) continue;
      const acima = seguidas(col, dentroDe - 1, -1);
      const abaixo = seguidas(col, dentroAte, +1);
      if (Math.max(acima, abaixo) < BORDA_MIN) continue;
      let n = 0;
      for (let lin = Math.max(0, dentroDe); lin < Math.min(h, dentroAte); lin++) if (perto(col, lin)) n++;
      if (n / Math.max(1, dentroAte - dentroDe) < 0.9) continue;
      colunas.push({ col, acima: acima >= abaixo });
    }

    // junta colunas vizinhas numa linha só
    const grupos = [];
    for (const c of colunas) {
      const ult = grupos[grupos.length - 1];
      if (ult && c.col === ult.fim + 1) ult.fim = c.col; else grupos.push({ ini: c.col, fim: c.col, acima: c.acima });
    }
    // Espessura, centro e cor são medidos numa fileira "limpa": do lado onde a borda
    // é longa, a fileira (até BORDA_MIN pt do texto) em que o trecho de tinta em
    // volta da borda é o mais estreito, ou seja, onde nada encosta nela. (Uma fileira
    // fixa caía no "ANO" logo acima do ano, cujas letras encostam na borda e eram
    // somadas à espessura.) O trecho de tinta é estendido para os lados porque,
    // perto de um canto arredondado, só parte das colunas passa nos testes acima.
    const trechoDeTinta = (ini, fim, lin) => {
      let a = -1;
      for (let col = ini; col <= fim; col++) if (tinta(col, lin)) { a = col; break; }
      if (a < 0) return null;
      let b = a;
      while (a > 0 && tinta(a - 1, lin)) a--;
      while (b < w - 1 && tinta(b + 1, lin)) b++;
      return { ini: a, fim: b };
    };
    return grupos.map((g) => {
      let melhor = null;
      for (let d = Math.round(pt); d <= Math.round((BORDA_MIN - 1) * pt); d++) {
        const lin = g.acima ? dentroDe - d : dentroAte + d;
        if (lin < 0 || lin >= h) break;
        const r = trechoDeTinta(g.ini, g.fim, lin);
        if (r && (!melhor || r.fim - r.ini < melhor.fim - melhor.ini)) melhor = { ...r, lin };
      }
      if (!melhor) return null;
      const { ini, fim, lin } = melhor;
      const cols = [];
      for (let col = Math.max(0, ini - 1); col <= Math.min(w - 1, fim + 1); col++) {
        const i = (lin * w + col) * 4;
        cols.push({ col, cor: [img[i], img[i + 1], img[i + 2]], forca: distancia(img, i, fundo) });
      }
      // cor: a mais escura (o centro). Espessura e centro pesados pela intensidade:
      // as colunas suavizadas das beiradas contam só em parte.
      const centro = cols.reduce((a, b) => (a.forca >= b.forca ? a : b));
      const soma = cols.reduce((s, c) => s + c.forca, 0);
      const largura = Math.max(0.5, soma / centro.forca);
      const meio = cols.reduce((s, c) => s + (c.col + 0.5) * c.forca, 0) / soma;
      const [ax] = viewport.convertToPdfPoint((x0 + meio - largura / 2) / dpr, 0);
      const [bx] = viewport.convertToPdfPoint((x0 + meio + largura / 2) / dpr, 0);
      return { x: Math.min(ax, bx), w: Math.abs(bx - ax), cor: centro.cor };
    }).filter(Boolean);
  }

  const distancia = (img, i, c) => Math.abs(img[i] - c[0]) + Math.abs(img[i + 1] - c[1]) + Math.abs(img[i + 2] - c[2]);

  const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const deHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  // ---------- Estado de cada trecho ----------

  function padrao(t) {
    return { texto: t.original, ...t.fonte, tamanho: t.tamanho, cor: t.cores.texto, dx: 0, dy: 0 };
  }

  const estado = (t) => edicoes.get(t.id) ?? padrao(t);

  function salvar(t, e) {
    const p = padrao(t);
    const igual = Object.keys(p).every((k) => String(p[k]) === String(e[k]));
    if (igual) edicoes.delete(t.id);
    else edicoes.set(t.id, e);
    aplicar(t);
    atualizarStatus();
  }

  // Mostra o trecho na tela como vai sair no PDF.
  function aplicar(t) {
    const e = estado(t);
    const visivel = edicoes.has(t.id) || selecionado === t;
    const [sx, sy] = t.viewport.convertToViewportPoint(t.x + e.dx, t.y + e.dy);
    const px = e.tamanho * t.viewport.scale;
    const altura = (t.ascent - t.descent) * px;
    Object.assign(t.el.style, {
      left: `${sx}px`, top: `${sy - t.ascent * px}px`, height: `${altura}px`, lineHeight: `${altura}px`,
      fontSize: `${px}px`, fontFamily: FAMILIAS[e.familia].css,
      fontWeight: e.negrito ? 'bold' : 'normal', fontStyle: e.italico ? 'italic' : 'normal',
      color: visivel ? css(e.cor) : 'transparent',
    });
    if (document.activeElement !== t.el && t.el.textContent !== e.texto) t.el.textContent = e.texto;
    t.el.classList.toggle('alterado', edicoes.has(t.id));
    // cobertura só enquanto a página ainda não foi redesenhada com o texto escondido
    t.capa.hidden = !visivel || ocultosTela.has(t.id);
    if (selecionado === t) posicionarAlca();
  }

  // ---------- Seleção e barra de ferramentas ----------

  let alca = null;

  function selecionar(t) {
    if (selecionado === t) return;
    desselecionar();
    selecionado = t;
    t.antes = estado(t); // para o Esc voltar
    t.el.contentEditable = 'plaintext-only';
    t.el.classList.add('editando');
    t.el.focus();
    getSelection().selectAllChildren(t.el); // já dá para digitar por cima
    alca = document.createElement('div');
    alca.className = 'alca';
    alca.textContent = '✥';
    alca.title = 'Arraste para mover';
    t.el.parentNode.append(alca);
    aplicar(t);
    mostrarBarra();
  }

  function desselecionar() {
    const t = selecionado;
    if (!t) return;
    selecionado = null;
    t.el.contentEditable = 'false';
    t.el.classList.remove('editando');
    alca?.remove();
    alca = null;
    barraTexto.hidden = true;
    document.body.classList.remove('com-barra');
    aplicar(t);
  }

  function posicionarAlca() {
    const el = selecionado.el;
    const esquerda = el.offsetLeft - 34;
    alca.style.left = `${esquerda >= 0 ? esquerda : el.offsetLeft + el.offsetWidth + 6}px`;
    alca.style.top = `${el.offsetTop + el.offsetHeight / 2 - 14}px`;
  }

  function mostrarBarra() {
    const e = estado(selecionado);
    ctl.familia.value = e.familia;
    ctl.tamanho.value = Math.round(e.tamanho * 10) / 10;
    ctl.negrito.classList.toggle('ativo', e.negrito);
    ctl.italico.classList.toggle('ativo', e.italico);
    ctl.cor.value = hex(e.cor);
    barraTexto.hidden = false;
    document.body.classList.add('com-barra');
  }

  function mudar(props) {
    const t = selecionado;
    if (!t) return;
    salvar(t, { ...estado(t), texto: lerTexto(t), ...props });
    mostrarBarra();
  }

  const lerTexto = (t) => t.el.textContent.replace(/\s*\n\s*/g, ' ');

  // botões da barra não tiram o foco do texto (o teclado do celular continua aberto)
  barraTexto.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  barraTexto.addEventListener('click', (e) => {
    const botao = e.target.closest('button');
    if (!botao || !selecionado) return;
    const e0 = estado(selecionado);
    const passo = 1; // pontos do PDF
    const acoesBarra = {
      menor: () => mudar({ tamanho: Math.max(2, Math.round((e0.tamanho - 0.5) * 10) / 10) }),
      maior: () => mudar({ tamanho: Math.round((e0.tamanho + 0.5) * 10) / 10 }),
      negrito: () => mudar({ negrito: !e0.negrito }),
      italico: () => mudar({ italico: !e0.italico }),
      esq: () => mudar({ dx: e0.dx - passo }),
      dir: () => mudar({ dx: e0.dx + passo }),
      cima: () => mudar({ dy: e0.dy + passo }),
      baixo: () => mudar({ dy: e0.dy - passo }),
      restaurar: () => { edicoes.delete(selecionado.id); selecionado.el.textContent = selecionado.original; aplicar(selecionado); atualizarStatus(); mostrarBarra(); },
      pronto: () => desselecionar(),
    };
    acoesBarra[botao.dataset.ctl || botao.dataset.mover]?.();
  });

  ctl.familia.addEventListener('change', () => mudar({ familia: ctl.familia.value }));
  ctl.tamanho.addEventListener('input', () => { if (Number(ctl.tamanho.value) >= 2) mudar({ tamanho: Number(ctl.tamanho.value) }); });
  ctl.cor.addEventListener('input', () => mudar({ cor: deHex(ctl.cor.value) }));

  // ---------- Edição na tela ----------

  function trechoDe(el) {
    return trechos[Number(el.closest?.('.trecho')?.dataset.id)];
  }

  area.addEventListener('click', (e) => {
    if (e.target.closest('.alca')) return;
    const t = trechoDe(e.target);
    if (t) selecionar(t);
    else desselecionar();
  });

  area.addEventListener('keydown', (e) => {
    const t = trechoDe(e.target);
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); desselecionar(); }
    if (e.key === 'Escape') {
      t.el.textContent = t.antes.texto;
      salvar(t, t.antes);
      desselecionar();
    }
  });

  // grava a cada letra, para não depender de sair do campo (no celular nem sempre acontece)
  area.addEventListener('input', (e) => {
    const t = trechoDe(e.target);
    if (t) salvar(t, { ...estado(t), texto: lerTexto(t) });
  });

  // arrastar a alça move o texto
  area.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.alca') || !selecionado) return;
    e.preventDefault();
    const t = selecionado;
    const inicio = { x: e.clientX, y: e.clientY, ...estado(t) };
    const escala = t.viewport.scale;
    const mover = (ev) => {
      mudar({ dx: inicio.dx + (ev.clientX - inicio.x) / escala, dy: inicio.dy - (ev.clientY - inicio.y) / escala });
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
  });

  // msg vazio = chamada depois de uma alteração: também guarda na memória
  function atualizarStatus(msg) {
    if (msg === undefined && idPdf && trechos.length) { lembrar(); agendarFundo(); }
    botaoDesfazer.disabled = !edicoes.size;
    status.textContent = msg ?? (edicoes.size ? `${edicoes.size} texto(s) alterado(s)` : 'Toque/clique em um texto para editar.');
  }

  // ---------- Gerar o PDF ----------

  // Esconde no próprio PDF o texto antigo de cada trecho alterado (ver conteudo.js).
  // Devolve os ids escondidos; os outros ficam com a cobertura.
  function ocultarEdicoes(doc) {
    const porPagina = new Map();
    for (const id of edicoes.keys()) {
      const t = trechos[id];
      if (!porPagina.has(t.pagina)) porPagina.set(t.pagina, []);
      porPagina.get(t.pagina).push({ id, x: t.x, y: t.y, w: t.largura, tamanho: t.tamanho });
    }
    const ocultos = new Set();
    for (const [pagina, alvos] of porPagina) {
      try {
        for (const id of Conteudo.ocultar(doc, pagina, alvos, paginasTela[pagina]?.larguras)) ocultos.add(id);
      } catch { /* comandos que o app não entende: fica a cobertura */ }
    }
    return ocultos;
  }

  // Alterações gravadas dentro do PDF baixado, para a Correção refazer com exatidão.
  // Pela posição na página (não pelo id), igual à leitura das camadas antigas.
  const META = 'EditarPDF';

  function lerMeta(doc) {
    const s = doc.context.lookup(doc.catalog.get(PDFName.of(META)));
    if (!(s instanceof PDFRawStream)) return [];
    try { return JSON.parse(new TextDecoder().decode(decodePDFRawStream(s).decode())).edicoes || []; } catch { return []; }
  }

  async function gerar() {
    const doc = await PDFDocument.load(original);
    const pages = doc.getPages();
    const ocultos = ocultarEdicoes(doc);
    const fontes = {};
    const fonte = async ({ familia, negrito, italico }) => {
      const nome = FAMILIAS[familia].pdf[(negrito ? 1 : 0) + (italico ? 2 : 0)];
      fontes[nome] ??= await doc.embedFont(StandardFonts[nome]);
      return fontes[nome];
    };
    const cor = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

    for (const [id, e] of edicoes) {
      const t = trechos[id];
      const page = pages[t.pagina];
      if (!ocultos.has(id)) {
        // não deu para esconder pelo comando: cobre e redesenha as bordas
        const r = t.capaPdf;
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: cor(t.cores.fundo) });
        for (const l of t.linhas) page.drawRectangle({ x: l.x, y: r.y, width: l.w, height: r.h, color: cor(l.cor) });
      }
      if (!e.texto.trim()) continue;
      const f = await fonte(e);
      try {
        page.drawText(e.texto, { x: t.x + e.dx, y: t.y + e.dy, size: e.tamanho, font: f, color: cor(e.cor) });
      } catch {
        throw new Error(`O texto "${e.texto}" tem caractere que a fonte padrão não suporta (ex.: emoji).`);
      }
    }
    // as de um PDF que já tinha sido editado vêm antes (mais antigas)
    const meta = [...lerMeta(doc), ...[...edicoes].map(([id, e]) => {
      const t = trechos[id];
      return {
        pagina: t.pagina, capa: t.capaPdf,
        estado: { texto: e.texto, familia: e.familia, negrito: e.negrito, italico: e.italico, tamanho: e.tamanho, cor: e.cor, x: t.x + e.dx, y: t.y + e.dy },
      };
    })];
    const ref = doc.context.register(doc.context.flateStream(new TextEncoder().encode(JSON.stringify({ versao: 2, edicoes: meta }))));
    doc.catalog.set(PDFName.of(META), ref);
    return doc.save();
  }

  // ---------- Prévia igual ao PDF ----------
  // As páginas alteradas são redesenhadas a partir de uma cópia do PDF com os
  // textos antigos escondidos, então a tela mostra exatamente o que vai sair.

  let ocultosTela = new Set(); // ids escondidos no desenho atual das páginas
  let paginasTela = []; // por página: { canvas, viewport, dpr }
  let fundoAgendado = null;
  let versaoFundo = 0;

  function agendarFundo() {
    clearTimeout(fundoAgendado);
    fundoAgendado = setTimeout(atualizarFundo, 300);
  }

  async function atualizarFundo() {
    if (!original) return;
    const versao = ++versaoFundo;
    const telas = paginasTela;
    let ocultos;
    let bytes;
    try {
      const doc = await PDFDocument.load(original);
      ocultos = ocultarEdicoes(doc);
      bytes = await doc.save();
    } catch { return; }
    // páginas com texto escondido agora ou antes (para mostrar de volta o que voltou)
    const paginas = new Set([...ocultosTela, ...ocultos].map((id) => trechos[id]?.pagina).filter((p) => p !== undefined));
    if (versao !== versaoFundo || telas !== paginasTela) return;
    if (paginas.size) {
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      try {
        for (const p of paginas) {
          const { canvas, viewport, dpr } = telas[p];
          const tmp = document.createElement('canvas');
          tmp.width = canvas.width;
          tmp.height = canvas.height;
          await (await pdf.getPage(p + 1)).render({ canvasContext: tmp.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
          if (versao !== versaoFundo || telas !== paginasTela) return;
          canvas.getContext('2d').drawImage(tmp, 0, 0);
          tmp.width = tmp.height = 0;
        }
      } finally {
        pdf.destroy();
      }
    }
    if (versao !== versaoFundo || telas !== paginasTela) return;
    ocultosTela = ocultos;
    trechos.forEach(aplicar);
  }

  // ---------- Ações ----------

  const acoes = {
    abrir() {
      desselecionar(); // as alterações já estão guardadas na memória
      modoCorrecao = false;
      arquivo.click();
    },
    correcao() {
      desselecionar();
      modoCorrecao = true;
      arquivo.click();
    },
    desfazer() {
      if (!confirm('Desfazer todas as alterações?')) return;
      desselecionar();
      const alterados = [...edicoes.keys()].map((id) => trechos[id]);
      edicoes.clear();
      alterados.forEach(aplicar);
      atualizarStatus();
    },
    async baixar() {
      desselecionar();
      let bytes;
      try {
        bytes = await gerar();
      } catch (e) {
        alert(`Não foi possível gerar o PDF: ${e.message}`);
        return;
      }
      await entregar(new File([bytes], `${nomeArquivo}-editado.pdf`, { type: 'application/pdf' }));
    },
    async salvar() {
      desselecionar();
      const dados = { tipo: 'editar-pdf', versao: 1, nome: nomeArquivo, pdf: paraBase64(original), edicoes: listaEdicoes() };
      await entregar(new File([JSON.stringify(dados)], `${nomeArquivo}.edicao.json`, { type: 'application/json' }));
    },
    mais() { mudarZoom(+1); },
    menos() { mudarZoom(-1); },
  };
  document.querySelector('.acoes').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-acao]');
    if (botao && !botao.disabled) acoes[botao.dataset.acao]();
  });

  const ZOOMS = [1, 1.5, 2, 3];
  async function mudarZoom(passo) {
    if (!pdfAtual) return;
    const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + passo));
    if (ZOOMS[i] === zoom) return;
    // mantém o mesmo ponto da página no meio da tela
    const cx = (area.scrollLeft + area.clientWidth / 2) / area.scrollWidth;
    const cy = (area.scrollTop + area.clientHeight / 2) / area.scrollHeight;
    zoom = ZOOMS[i];
    await desenhar();
    area.scrollLeft = cx * area.scrollWidth - area.clientWidth / 2;
    area.scrollTop = cy * area.scrollHeight - area.clientHeight / 2;
  }

  // No celular abre o compartilhar (WhatsApp, salvar em Arquivos…); no computador baixa.
  async function entregar(arquivoSaida) {
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [arquivoSaida] })) {
      try {
        await navigator.share({ files: [arquivoSaida], title: arquivoSaida.name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // usuário fechou o compartilhar
      }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(arquivoSaida);
    link.download = arquivoSaida.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }

  // Abrir aceita o PDF ou um .edicao.json salvo por "Salvar edição".
  // Correção aceita um PDF já baixado por este app (ver desfazerCamadas).
  let modoCorrecao = false;
  arquivo.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (modoCorrecao) {
      modoCorrecao = false;
      atualizarStatus('Corrigindo…');
      let r = null;
      try { r = await desfazerCamadas(bytes); } catch { /* não é PDF ou está protegido */ }
      if (!r) {
        atualizarStatus('Este PDF não tem alterações feitas por este app para corrigir. Para editar, use "Abrir".');
        return;
      }
      const nome = f.name.replace(/\.pdf$/i, '').replace(/(-editado)+$/i, '');
      abrir(r.bytes, `${nome}.pdf`, r.edicoes,
        (n) => `Correção: ${n} alteração(ões) refeita(s) a partir do original. Confira e toque em "Baixar".`);
      return;
    }
    if (/\.json$/i.test(f.name) || f.type === 'application/json') {
      let dados;
      try {
        dados = JSON.parse(new TextDecoder().decode(bytes));
        if (dados.tipo !== 'editar-pdf') throw new Error();
      } catch {
        atualizarStatus('Este arquivo não é uma edição salva por este app.');
        return;
      }
      abrir(deBase64(dados.pdf), `${dados.nome}.pdf`, dados.edicoes);
      return;
    }
    abrir(bytes, f.name);
  });
})();
