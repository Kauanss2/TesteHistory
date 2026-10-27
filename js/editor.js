// Edita o texto já escrito num PDF: clique no texto, digite o novo, baixe o PDF.
// No PDF baixado o texto antigo é coberto com a cor do fundo e o novo é escrito
// no mesmo lugar, tamanho e cor (fonte padrão parecida: sem/com serifa, negrito, itálico).
(function () {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const arquivo = document.getElementById('arquivo');
  const area = document.getElementById('paginas');
  const status = document.getElementById('status');
  const botaoBaixar = document.querySelector('[data-acao="baixar"]');
  const botaoDesfazer = document.querySelector('[data-acao="desfazer"]');

  let original = null; // bytes do PDF aberto, nunca alterados
  let pdfAtual = null; // o mesmo PDF, lido pelo pdf.js para desenhar
  let zoom = 1;
  let nomeArquivo = 'documento';
  let trechos = []; // um por pedaço de texto do PDF
  const edicoes = new Map(); // id do trecho -> texto novo

  // ---------- Abrir e desenhar ----------

  async function abrir(bytes, nome) {
    original = bytes;
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
    atualizarStatus(trechos.length ? undefined : 'Este PDF não tem texto editável (o texto pode estar como imagem).');
  }

  // Desenha as páginas no zoom atual (zoom 1 = largura da tela). As edições são
  // guardadas pelo id do trecho, que é o mesmo a cada desenho, e reaplicadas.
  async function desenhar() {
    const pdf = pdfAtual;
    document.activeElement?.blur?.();
    area.innerHTML = '';
    trechos = [];
    const largura = Math.min(1100, area.clientWidth - 32) * zoom;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
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

      const { items, styles } = await page.getTextContent();
      for (const item of items) {
        if (!item.str.trim()) continue;
        const t = criarTrecho(n - 1, item, styles[item.fontName] || {}, page, viewport, canvas, dpr);
        if (t) { trechos.push(t); camada.append(t.el); }
      }
    }
    for (const [id, novo] of edicoes) {
      trechos[id].el.textContent = novo;
      trechos[id].el.classList.add('alterado');
    }
  }

  function criarTrecho(pagina, item, estilo, page, viewport, canvas, dpr) {
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) return null; // texto girado: não suportado
    const tamanho = Math.hypot(c, d);
    const ascent = estilo.ascent || 0.8;
    const descent = estilo.descent || -0.2;
    const fonte = descreverFonte(page, item.fontName, estilo);

    // retângulo do texto em pontos do PDF (y para cima)
    const pdfRet = { x, y: y + descent * tamanho, w: item.width || a * item.str.length * 0.5, h: (ascent - descent) * tamanho };
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([pdfRet.x, pdfRet.y, pdfRet.x + pdfRet.w, pdfRet.y + pdfRet.h]);
    const tela = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    const cores = amostrarCores(canvas, tela, dpr);

    const el = document.createElement('span');
    el.className = 'trecho';
    el.textContent = item.str;
    el.spellcheck = false;
    el.title = 'Clique para editar';
    const px = tamanho * viewport.scale;
    Object.assign(el.style, {
      left: `${tela.left}px`, top: `${tela.top}px`, minWidth: `${tela.width}px`, height: `${tela.height}px`,
      fontSize: `${px}px`, lineHeight: `${tela.height}px`, fontFamily: fonte.css,
      fontWeight: fonte.negrito ? 'bold' : 'normal', fontStyle: fonte.italico ? 'italic' : 'normal',
    });
    el.style.setProperty('--fundo', css(cores.fundo));
    el.style.setProperty('--cor', css(cores.texto));

    const t = { id: trechos.length, pagina, original: item.str, x, y, tamanho, pdfRet, fonte, cores, el };
    el.dataset.id = t.id;
    return t;
  }

  // Fonte padrão mais parecida com a do PDF (as embutidas costumam vir incompletas).
  function descreverFonte(page, fontName, estilo) {
    let nome = '';
    try { nome = page.commonObjs.get(fontName)?.name || ''; } catch { /* fonte ainda não carregada */ }
    const negrito = /bold|black|heavy|semibold|demi|extrabold/i.test(nome);
    const italico = /italic|oblique/i.test(nome);
    const mono = estilo.fontFamily === 'monospace' || /mono|courier|consol/i.test(nome);
    const serifa = !mono && !/sans/i.test(nome) && (estilo.fontFamily === 'serif' || /times|serif|georgia|garamond|playfair|merriweather|lora|baskerville/i.test(nome));
    const familia = mono ? 'Courier' : serifa ? 'Times' : 'Helvetica';
    return {
      negrito, italico, familia,
      css: { Courier: '"Courier New", monospace', Times: '"Times New Roman", serif', Helvetica: 'Helvetica, Arial, sans-serif' }[familia],
    };
  }

  // Cor do fundo (borda em volta do texto) e do texto (pixel mais diferente do fundo).
  function amostrarCores(canvas, r, dpr) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pegar = (x, y) => {
      const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x * dpr)));
      const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y * dpr)));
      return ctx.getImageData(px, py, 1, 1).data;
    };
    const borda = [];
    for (let i = 0; i <= 10; i++) {
      const x = r.left - 2 + (r.width + 4) * (i / 10);
      borda.push(pegar(x, r.top - 2), pegar(x, r.top + r.height + 2));
    }
    borda.push(pegar(r.left - 3, r.top + r.height / 2), pegar(r.left + r.width + 3, r.top + r.height / 2));
    const fundo = [0, 1, 2].map((k) => mediana(borda.map((p) => p[k])));

    const img = ctx.getImageData(Math.round(r.left * dpr), Math.round(r.top * dpr),
      Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr))).data;
    let texto = [0, 0, 0];
    let maior = -1;
    for (let i = 0; i < img.length; i += 4) {
      const dist = Math.abs(img[i] - fundo[0]) + Math.abs(img[i + 1] - fundo[1]) + Math.abs(img[i + 2] - fundo[2]);
      if (dist > maior) { maior = dist; texto = [img[i], img[i + 1], img[i + 2]]; }
    }
    return { fundo, texto };
  }

  function mediana(v) {
    const s = [...v].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  }

  const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

  // ---------- Edição na tela ----------

  function trechoDe(el) {
    return trechos[Number(el.closest('.trecho')?.dataset.id)];
  }

  area.addEventListener('click', (e) => {
    const t = e.target.closest('.trecho') && trechoDe(e.target);
    if (!t || t.el.isContentEditable) return;
    t.el.contentEditable = 'plaintext-only';
    t.el.classList.add('editando');
    t.el.focus();
    // seleciona tudo para já poder digitar por cima
    const sel = getSelection();
    sel.selectAllChildren(t.el);
    t.antes = edicoes.get(t.id) ?? t.original; // para o Esc voltar
  });

  area.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('.trecho') && trechoDe(e.target);
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); t.el.blur(); }
    if (e.key === 'Escape') { t.el.textContent = t.antes ?? t.original; registrar(t); t.el.blur(); }
  });

  // grava a cada letra, para não depender de sair do campo (no celular nem sempre acontece)
  function registrar(t) {
    const novo = t.el.textContent.replace(/\s*\n\s*/g, ' ');
    if (novo === t.original) edicoes.delete(t.id);
    else edicoes.set(t.id, novo);
    t.el.classList.toggle('alterado', edicoes.has(t.id));
    atualizarStatus();
  }

  area.addEventListener('input', (e) => {
    const t = e.target.closest?.('.trecho') && trechoDe(e.target);
    if (t) registrar(t);
  });

  area.addEventListener('focusout', (e) => {
    const t = e.target.closest?.('.trecho') && trechoDe(e.target);
    if (!t) return;
    t.el.contentEditable = 'false';
    t.el.classList.remove('editando');
    registrar(t);
  });

  function atualizarStatus(msg) {
    botaoDesfazer.disabled = !edicoes.size;
    status.textContent = msg ?? (edicoes.size ? `${edicoes.size} texto(s) alterado(s)` : 'Toque/clique em um texto para editar.');
  }

  // ---------- Gerar o PDF ----------

  async function gerar() {
    const doc = await PDFDocument.load(original);
    const pages = doc.getPages();
    const fontes = {};
    const fonte = async ({ familia, negrito, italico }) => {
      const nome = {
        Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
        Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
        Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
      }[familia][(negrito ? 1 : 0) + (italico ? 2 : 0)];
      fontes[nome] ??= await doc.embedFont(StandardFonts[nome]);
      return fontes[nome];
    };
    const cor = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

    for (const [id, novo] of edicoes) {
      const t = trechos[id];
      const page = pages[t.pagina];
      const r = t.pdfRet;
      page.drawRectangle({ x: r.x - 1, y: r.y - 1, width: r.w + 2, height: r.h + 2, color: cor(t.cores.fundo) });
      if (!novo.trim()) continue;
      const f = await fonte(t.fonte);
      try {
        page.drawText(novo, { x: t.x, y: t.y, size: t.tamanho, font: f, color: cor(t.cores.texto) });
      } catch {
        throw new Error(`O texto "${novo}" tem caractere que a fonte padrão não suporta (ex.: emoji).`);
      }
    }
    return doc.save();
  }

  // ---------- Ações ----------

  const acoes = {
    abrir() {
      if (edicoes.size && !confirm('Abrir outro PDF? As alterações não baixadas serão perdidas.')) return;
      arquivo.click();
    },
    desfazer() {
      if (!confirm('Desfazer todas as alterações?')) return;
      for (const id of edicoes.keys()) {
        const t = trechos[id];
        t.el.textContent = t.original;
        t.el.classList.remove('alterado');
      }
      edicoes.clear();
      atualizarStatus();
    },
    async baixar() {
      document.activeElement?.blur(); // grava a edição em andamento
      let bytes;
      try {
        bytes = await gerar();
      } catch (e) {
        alert(`Não foi possível gerar o PDF: ${e.message}`);
        return;
      }
      const nome = `${nomeArquivo}-editado.pdf`;
      // no celular abre o compartilhar (WhatsApp, salvar em Arquivos…); no computador baixa
      const pdf = new File([bytes], nome, { type: 'application/pdf' });
      if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [pdf] })) {
        try {
          await navigator.share({ files: [pdf], title: nome });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return; // usuário fechou o compartilhar
        }
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(pdf);
      link.download = nome;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    },
    mais() { mudarZoom(+1); },
    menos() { mudarZoom(-1); },
  };

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
  document.querySelector('.acoes').addEventListener('click', (e) => {
    const botao = e.target.closest('[data-acao]');
    if (botao && !botao.disabled) acoes[botao.dataset.acao]();
  });

  arquivo.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) abrir(new Uint8Array(await f.arrayBuffer()), f.name);
  });

  window.addEventListener('beforeunload', (e) => { if (edicoes.size) e.preventDefault(); });
})();
