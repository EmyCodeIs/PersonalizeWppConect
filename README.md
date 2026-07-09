# PersonalizeWppConect

Projeto local e separado para testar o **pré-atendimento do cliente da Personalize via WPPConnect**, sem alterar o sistema oficial em produção.

A intenção desta base é portar o fluxo do cliente para o canal não oficial, mantendo a mesma lógica principal:

- cliente manda uma ou várias mensagens;
- sistema agrupa com buffer;
- tenta identificar origem/landing, nome, telefone e intenção;
- se for letreiro, segue o fluxo de letreiro;
- se for outro serviço, salva lead e orienta atendimento humano;
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
  config/env.js              Configuracao de ambiente
  core/bufferManager.js      Buffer de multiplas mensagens
  core/intent.js             Identificacao inicial: letreiro, landing, outro servico
  core/messages.js           Textos do fluxo cliente
  core/parsers.js            Extracao de nome, telefone e medidas
  flow/customerFlow.js       Maquina de estados do pre-atendimento
  services/leadStore.js      Persistencia local de sessoes/leads
  services/wppconnectClient.js Adaptador do WPPConnect
scripts/test-flow.js         Simulador de conversa no terminal
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
