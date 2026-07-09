# PersonalizeWppConect

Projeto local e separado para testar o **pré-atendimento do cliente da Personalize via WPPConnect**, sem alterar o sistema oficial em produção.

A intenção desta base é portar o fluxo do cliente para o canal não oficial, mantendo a mesma lógica principal:

- cliente manda uma ou várias mensagens;
- sistema agrupa com buffer;
- primeira resposta do bot é saudação + lista de serviços;
- se o cliente escolher **Letreiro de acrílico**, envia o mostruário e segue o fluxo de letreiro;
- se escolher **Plotagem** ou **Outros**, salva lead e orienta atendimento humano;
- salva sessões e leads em arquivos locais;
- quando o pré-atendimento de letreiro fica pronto para orçamento, grava uma nota no contato e tenta aplicar a etiqueta verde **Aguardando orçamento**.

> Este projeto não substitui o repositório `Personalize` e não mexe na API oficial.

## Como puxar e testar

```bash
git clone https://github.com/EmyCodeIs/PersonalizeWppConect.git
cd PersonalizeWppConect
npm install
cp .env.example .env
npm run test:flow
```

Para testar com WhatsApp Web/WPPConnect:

```bash
npm start
```

Depois leia o QR Code que aparecer no terminal/navegador.

## Entrada do fluxo

A primeira resposta após o buffer é:

```txt
Olá, {nome}! 👋
Bem-vindo(a) ao Canal de Atendimento da Personalize!
```

Depois o bot envia a lista:

```txt
🔸
Qual dos nossos serviço deseja?

* Letreiro de acrílico
* Plotagem
* Outros
```

Ao clicar em **Letreiro de acrílico**, ele envia o mostruário e depois a lista de tipo de acrílico.

## Assets do mostruário

Salve a imagem do mostruário em uma destas opções:

```txt
assets/Mostruario_Letreiro.png
assets/Mostruario_Letreiro.jpg
assets/Mostruario_Letreiro.jpeg
assets/Mostruario_Letreiro.webp
```

Se o PDF ficar online, configure no `.env`:

```env
MOSTRUARIO_LETREIRO_PDF_URL=https://seu-link-do-pdf-aqui
```

Se quiser enviar PDF local, use:

```txt
assets/Mostruario_Letreiro.pdf
```

ou configure:

```env
MOSTRUARIO_LETREIRO_PDF_PATH=assets/Mostruario_Letreiro.pdf
```

No WPPConnect, botão CTA de URL como na API oficial pode não estar disponível de forma estável. Por isso o sistema envia a imagem e depois envia o link do PDF como fallback seguro.

## Nota e etiqueta no WhatsApp Business

Ao finalizar a coleta de letreiro, o sistema salva o lead localmente e tenta registrar no contato:

- Nota com dados coletados: nome, telefone, origem, tipo, cores, medida, cidade, envio e endereço.
- Etiqueta verde: `Aguardando orçamento`.

Essas opções ficam no `.env`:

```env
ENABLE_CONTACT_NOTES=true
ENABLE_CONTACT_LABELS=true
AWAITING_QUOTE_LABEL_NAME=Aguardando orçamento
AWAITING_QUOTE_LABEL_COLOR=green
```

A aplicação usa tentativa segura porque o suporte a notas/etiquetas pode variar conforme versão do WPPConnect/WA-JS e conforme a sessão estar conectada a uma conta WhatsApp Business. Se não funcionar, o fluxo continua e mostra aviso no terminal.

## Estrutura

```txt
src/
  config/env.js                Configuracao de ambiente
  core/bufferManager.js        Buffer de multiplas mensagens
  core/intent.js               Identificacao inicial: landing, nome, telefone e intenção
  core/menuCatalog.js          Menus/listas interativas com fallback texto
  core/messages.js             Textos do fluxo cliente
  core/mostruario.js           Envio do mostruario por imagem/PDF/link
  core/parsers.js              Extracao de nome, telefone e medidas
  flow/customerFlow.js         Maquina de estados do pre-atendimento
  services/leadStore.js        Persistencia local de sessoes/leads
  services/wppconnectClient.js Adaptador do WPPConnect
assets/                         Imagens/PDFs locais do fluxo
scripts/test-flow.js            Simulador de conversa no terminal
```

## Comandos uteis

```bash
npm run check
npm run test:flow
npm start
```

## Observacao importante

Esta primeira versao foi criada para validar o fluxo cliente. Ela ainda nao implementa painel visual, vendedor multiusuario, agenda, pagamentos ou envio real de orcamento completo.

Antes de usar em producao, revisar risco de banimento/limitacao do WhatsApp Web, autenticação, logs, politicas de atendimento e fallback humano.
