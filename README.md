# PersonalizeWppConect

Projeto local e separado para testar o **pré-atendimento do cliente da Personalize via WPPConnect**, sem alterar o sistema oficial em produção.

A intenção desta base é portar o fluxo do cliente para o canal não oficial, mantendo a mesma lógica principal:

- cliente manda uma ou várias mensagens;
- sistema agrupa com buffer;
- primeira resposta do bot é saudação + lista de serviços;
- se o cliente escolher **Letreiro de acrílico**, envia o mostruário e segue o fluxo de letreiro;
- se escolher **Plotagem** ou **Outros**, salva lead e orienta atendimento humano;
- salva sessões e leads em arquivos locais;
- quando o pré-atendimento de letreiro fica pronto para orçamento, grava uma nota no contato e tenta aplicar a lista/etiqueta configurada.

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

## Comandos de teste

Com `ENABLE_TEST_COMMANDS=true`, estes comandos funcionam pelo WhatsApp:

```txt
/reset
```

Reinicia somente a sessão do contato atual.

```txt
/resetarsys
```

Reseta o sistema local de teste: limpa todas as sessões em `data/sessions.json` e apaga os leads em `data/leads.jsonl`. Depois disso, o próximo contato começa como primeiro atendimento.

Antes de usar com clientes reais, coloque:

```env
ENABLE_TEST_COMMANDS=false
```

## Assets usados no fluxo

O bot procura os arquivos dentro de `assets/` usando estes nomes base:

```txt
assets/capa-mostruario.png|jpg|jpeg|webp
assets/mostruario.pdf
assets/tabela-cores-v2.png|jpg|jpeg|webp
assets/tabela-espessura.png|jpg|jpeg|webp
assets/tabela-profundidade-3mm.png|jpg|jpeg|webp
```

Uso atual no fluxo:

- `capa-mostruario`: enviada quando o cliente escolhe **Letreiro de acrílico**.
- `mostruario.pdf`: não é enviado como anexo. O projeto o disponibiliza por HTTP e manda somente o link.
- `tabela-cores-v2`: enviada antes de perguntar a quantidade/cores do letreiro colorido.
- `tabela-espessura`: enviada quando o cliente escolhe acrílico personalizado/Pantone.
- `tabela-profundidade-3mm`: enviada antes da pergunta de acréscimo/profundidade.
- `ticket-logo`: por enquanto não é usado no fluxo de coleta do orçamento.

No WPPConnect, botão CTA de URL como na API oficial não é estável. Por isso o sistema envia a imagem e, em seguida, o link clicável do PDF.

## Servidor local do PDF

Quando `MOSTRUARIO_LETREIRO_PDF_URL` está vazio, o projeto abre automaticamente uma porta HTTP e serve `assets/mostruario.pdf` em:

```txt
http://IP-DO-NOTEBOOK:3030/mostruario.pdf
```

Configuração padrão:

```env
ENABLE_ASSET_SERVER=true
ASSET_SERVER_HOST=0.0.0.0
ASSET_SERVER_PORT=3030
ASSET_PUBLIC_BASE_URL=
MOSTRUARIO_LETREIRO_PDF_URL=
```

No teste local, o terminal mostra a URL gerada. Ela funciona no celular apenas quando o aparelho consegue acessar o notebook, normalmente estando na mesma rede Wi-Fi e com a porta liberada no firewall.

Para clientes externos, configure uma base pública:

```env
ASSET_PUBLIC_BASE_URL=https://arquivos.seudominio.com
```

O sistema enviará:

```txt
https://arquivos.seudominio.com/mostruario.pdf
```

Também é possível ignorar o servidor local e informar diretamente a URL completa de um PDF já hospedado:

```env
MOSTRUARIO_LETREIRO_PDF_URL=https://arquivos.seudominio.com/mostruario.pdf
```

O sistema nunca usa o PDF local como anexo. Se nenhuma URL puder ser criada, ele envia a imagem e registra um aviso no terminal.

## Nota e lista no WhatsApp Business

Ao finalizar a coleta de letreiro, o sistema salva o lead localmente e tenta registrar no contato:

- nota com dados coletados: nome, telefone, origem, tipo, cores, medida, cidade, envio e endereço;
- lista/etiqueta correspondente ao tipo do atendimento.

Essas opções ficam no `.env`:

```env
ENABLE_CONTACT_NOTES=true
ENABLE_CONTACT_LABELS=true
SERVICE_LABEL_LETREIRO=Orçamento letreiro
SERVICE_LABEL_PLOTAGEM=Plotagens
SERVICE_LABEL_OUTROS=Outros
```

A aplicação usa tentativa segura porque o suporte a notas/listas pode variar conforme versão do WPPConnect/WA-JS e conforme a sessão estar conectada a uma conta WhatsApp Business. Se não funcionar, o fluxo continua e mostra aviso no terminal.

## Estrutura

```txt
src/
  config/env.js                Configuracao de ambiente
  core/bufferManager.js        Buffer de multiplas mensagens
  core/intent.js               Identificacao inicial: landing, nome, telefone e intenção
  core/menuCatalog.js          Menus/listas interativas com fallback texto
  core/messages.js             Textos do fluxo cliente
  core/mostruario.js           Envio da capa e link do mostruario
  core/parsers.js              Extracao de nome, telefone e medidas
  flow/customerFlow.js         Maquina de estados do pre-atendimento
  services/assetServer.js      Servidor HTTP do PDF local
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