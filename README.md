# Editar PDF

Troca o texto já escrito num PDF por outro. Roda direto no navegador, sem
instalação, sem servidor e sem internet. O PDF é aberto no próprio computador
e não é enviado para lugar nenhum.

## Como usar

1. Abra `index.html` no Chrome ou no Edge e clique em **Abrir PDF…**.
2. Clique no texto que quer mudar, apague e digite o novo.
   **Enter** confirma, **Esc** cancela. Texto alterado fica com contorno verde.
3. **Baixar PDF editado** gera `<nome>-editado.pdf`. O arquivo original não é alterado.

## No celular (app instalável)

O site é um PWA: depois de publicado num endereço `https://`, abra no celular e
- **Android (Chrome):** menu ⋮ → **Instalar app** / **Adicionar à tela inicial**;
- **iPhone (Safari):** botão Compartilhar → **Adicionar à Tela de Início**.

Vira um ícone na tela inicial e funciona sem internet. Os botões **−/+** dão
zoom para tocar em textos pequenos. **Baixar** abre o compartilhar do celular
(WhatsApp, salvar em Arquivos…).

Para publicar, envie só os arquivos do app (`index.html`, `manifest.webmanifest`,
`sw.js`, `css/`, `js/`, `vendor/`, `icons/`), nunca PDFs. O PDF é editado no
aparelho: o site publicado não recebe nem guarda nenhum arquivo.

Ao alterar qualquer arquivo do app, aumente `VERSAO` em `sw.js`, senão os
celulares continuam com a versão antiga guardada.

## Como funciona

No PDF baixado, o texto antigo é coberto com a cor do fundo e o novo é escrito
no mesmo lugar, tamanho e cor. A fonte é a padrão mais parecida (sem serifa,
com serifa ou monoespaçada; negrito/itálico), porque as fontes embutidas no
PDF costumam vir só com as letras usadas.

Limitações:
- o texto antigo continua no arquivo por baixo da cobertura: some da vista e
  da impressão, mas pode ser copiado/selecionado em alguns leitores;
- texto girado e texto que é imagem (PDF escaneado) não aparecem para edição;
- emojis e caracteres fora do alfabeto latino não são suportados pela fonte padrão.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | tela |
| `manifest.webmanifest`, `icons/` | nome e ícone do app instalado |
| `sw.js` | guarda os arquivos para funcionar sem internet |
| `js/editor.js` | mostra as páginas, edição do texto, geração do PDF |
| `css/app.css` | estilo da tela |
| `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` | [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache-2.0): desenha as páginas e lê o texto |
| `vendor/pdf-lib.min.js` | [pdf-lib](https://pdf-lib.js.org) 1.17.1 (MIT): grava o PDF editado |
