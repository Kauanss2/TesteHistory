// Edita o texto já escrito num PDF: toque no texto, digite o novo, ajuste fonte,
// tamanho, cor e posição, e baixe o PDF.
// No PDF baixado o texto antigo é coberto com a cor do fundo (parando antes de uma
// linha/pontilhado logo abaixo dele, para não apagá-la) e o novo é escrito por cima.
(function () {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const arquivo = document.getElementById('arquivo');
  const area = document.getElementById('paginas');
  const status = document.getElementById('status');
  const botaoBaixar = document.querySelector('[data-acao="baixar"]');
  const botaoDesfazer = document.querySelector('[data-acao="desfazer"]');
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

  // Desenha as páginas no zoom atual (zoom 1 = largura da tela).
  async function desenhar() {
    desselecionar();
    area.innerHTML = '';
    trechos = [];
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
      await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;

      const { items, styles } = await page.getTextContent();
      for (const item of items) {
        if (!item.str.trim()) continue;
        const t = criarTrecho(n - 1, item, styles[item.fontName] || {}, page, viewport, canvas, dpr);
        if (!t) continue;
        trechos.push(t);
        camada.append(t.capa, t.el);
        aplicar(t);
      }
    }
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
      id: trechos.length, pagina, original: item.str, x, y, tamanho, ascent, descent, viewport,
      fonte: descreverFonte(page, item.fontName, estilo), cores,
      capaPdf: calcularCapa(ctx, canvas, dpr, viewport, y, tela, cores.fundo),
    };
    t.el = document.createElement('span');
    t.el.className = 'trecho';
    t.el.textContent = item.str;
    t.el.spellcheck = false;
    t.el.dataset.id = t.id;
    t.capa = document.createElement('div');
    t.capa.className = 'capa';
    Object.assign(t.capa.style, posicao(retanguloTela(viewport, t.capaPdf)), { background: css(cores.fundo) });
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

  // Cor do fundo (borda em volta do texto) e do texto (pixel mais diferente do fundo).
  function amostrarCores(ctx, canvas, r, dpr) {
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
      const dist = distancia(img, i, fundo);
      if (dist > maior) { maior = dist; texto = [img[i], img[i + 1], img[i + 2]]; }
    }
    return { fundo, texto };
  }

  // Área que cobre o texto antigo. Se logo abaixo da linha de base houver uma
  // linha/pontilhado (fileira de pixels que ocupa boa parte da largura), a
  // cobertura para antes dela, para a linha continuar no PDF.
  function calcularCapa(ctx, canvas, dpr, viewport, baseY, tela, fundo) {
    const [, base] = viewport.convertToViewportPoint(0, baseY);
    const x0 = Math.max(0, Math.round((tela.left - 4) * dpr));
    const x1 = Math.min(canvas.width, Math.round((tela.left + tela.width + 4) * dpr));
    const y0 = Math.max(0, Math.round((base + 1) * dpr));
    const y1 = Math.min(canvas.height, Math.round((tela.top + tela.height + 3) * dpr));
    let fim = tela.top + tela.height + 1;
    if (x1 > x0 && y1 > y0) {
      const w = x1 - x0;
      const img = ctx.getImageData(x0, y0, w, y1 - y0).data;
      for (let linha = 0; linha < y1 - y0; linha++) {
        let n = 0;
        for (let col = 0; col < w; col++) if (distancia(img, (linha * w + col) * 4, fundo) > 80) n++;
        if (n / w > 0.4) { fim = (y0 + linha) / dpr - 0.3; break; }
      }
    }
    const [ax, ay] = viewport.convertToPdfPoint(tela.left - 1, fim);
    const [bx, by] = viewport.convertToPdfPoint(tela.left + tela.width + 1, tela.top - 1);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  }

  const distancia = (img, i, c) => Math.abs(img[i] - c[0]) + Math.abs(img[i + 1] - c[1]) + Math.abs(img[i + 2] - c[2]);

  function mediana(v) {
    const s = [...v].sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  }

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
    t.capa.hidden = !visivel;
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
      const nome = FAMILIAS[familia].pdf[(negrito ? 1 : 0) + (italico ? 2 : 0)];
      fontes[nome] ??= await doc.embedFont(StandardFonts[nome]);
      return fontes[nome];
    };
    const cor = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);

    for (const [id, e] of edicoes) {
      const t = trechos[id];
      const page = pages[t.pagina];
      const r = t.capaPdf;
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: cor(t.cores.fundo) });
      if (!e.texto.trim()) continue;
      const f = await fonte(e);
      try {
        page.drawText(e.texto, { x: t.x + e.dx, y: t.y + e.dy, size: e.tamanho, font: f, color: cor(e.cor) });
      } catch {
        throw new Error(`O texto "${e.texto}" tem caractere que a fonte padrão não suporta (ex.: emoji).`);
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

  arquivo.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) abrir(new Uint8Array(await f.arrayBuffer()), f.name);
  });

  window.addEventListener('beforeunload', (e) => { if (edicoes.size) e.preventDefault(); });
})();
