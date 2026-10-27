# Editar PDF

Troca o texto já escrito num PDF por outro. Roda direto no navegador, sem
instalação, sem servidor e sem internet. O PDF é aberto no próprio computador
e não é enviado para lugar nenhum.

## Como usar

1. Abra `index.html` no Chrome ou no Edge e clique em **Abrir PDF…**.
2. Clique no texto que quer mudar, apague e digite o novo.
   **Enter** confirma, **Esc** cancela. Texto alterado fica com contorno verde.
   A barra que aparece embaixo muda fonte, tamanho, negrito/itálico e cor, e
   move o texto (setas ou arrastando a alça ✥).
3. **Baixar PDF editado** gera `<nome>-editado.pdf`. O arquivo original não é alterado.

## Correção

**Correção** recebe um PDF já baixado por este app (`…-editado.pdf`) e o refaz
com as regras atuais: tira a camada que o app tinha desenhado (o que devolve o
PDF original), lê dela cada alteração (texto, posição, fonte, tamanho, cor) e
as aplica de novo. Confira e toque em **Baixar**. Serve para PDFs baixados antes
de uma correção do app e também para PDF editado mais de uma vez. Um PDF sem
alterações deste app é recusado (use **Abrir**).

## Continuar depois

- **Automático:** as alterações ficam guardadas no aparelho. Abrindo o mesmo PDF
  de novo (mesmo conteúdo, o nome não importa), elas voltam sozinhas.
  **Desfazer** (↺ no celular) apaga as alterações e essa memória.
- **Salvar edição** baixa `<nome>.edicao.json` com o PDF original e as alterações.
  Abra esse arquivo pelo **Abrir** em qualquer aparelho para continuar. Ele
  contém o PDF inteiro: trate como o próprio documento.

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

No PDF baixado, o texto antigo é **escondido no próprio comando do PDF** que o
escreve (`js/conteudo.js`): o app lê os comandos da página, acha o que desenha
aquele texto e o deixa invisível (modo de renderização 3). Nada em volta é
coberto, então bordas, cantos, linhas e fundo ficam exatamente como eram. O
texto novo é escrito no mesmo lugar, tamanho e cor, numa fonte padrão parecida
(sem serifa, com serifa ou monoespaçada; negrito/itálico), porque as fontes
embutidas no PDF costumam vir só com as letras usadas. A prévia na tela é
redesenhada a partir desse mesmo PDF, então mostra o que vai sair.

Se o comando não for encontrado (texto dentro de um objeto reutilizado, comando
que mistura o texto com outro vizinho…), o app usa a cobertura: pinta o fundo
(cor mais frequente dentro do retângulo do texto), sem cobrir linhas logo
abaixo/acima e redesenhando bordas verticais que atravessam o texto.

As alterações também ficam gravadas dentro do PDF baixado (chave `EditarPDF` do
catálogo), para a **Correção** refazer com exatidão.

Limitações:
- o texto antigo continua no arquivo, invisível: some da vista e da impressão,
  mas pode ser copiado/selecionado em alguns leitores;
- texto girado e texto que é imagem (PDF escaneado) não aparecem para edição;
- emojis e caracteres fora do alfabeto latino não são suportados pela fonte padrão.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | tela |
| `manifest.webmanifest`, `icons/` | nome e ícone do app instalado |
| `sw.js` | guarda os arquivos para funcionar sem internet |
| `js/editor.js` | mostra as páginas, edição do texto, geração do PDF, Correção |
| `js/conteudo.js` | lê os comandos da página e esconde o texto antigo |
| `css/app.css` | estilo da tela |
| `vendor/pdf.min.js`, `vendor/pdf.worker.min.js` | [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 (Apache-2.0): desenha as páginas e lê o texto |
| `vendor/pdf-lib.min.js` | [pdf-lib](https://pdf-lib.js.org) 1.17.1 (MIT): grava o PDF editado |
