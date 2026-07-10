# PersonalizeWppConect

Projeto local e separado para testar o **pré-atendimento do cliente da Personalize via WPPConnect**, sem alterar o sistema oficial em produção.

A intenção desta base é portar o fluxo do cliente para o canal não oficial, mantendo a mesma lógica principal:

- cliente manda uma ou várias mensagens;
- sistema agrupa com buffer;
- primeira resposta do bot é saudação + lista de serviços;
- se o cliente escolher **Letreiro de acrílico**, envia a capa do mostruário, um link comum e segue o fluxo;
- se escolher **Plotagem** ou **Outros**, coleta os dados básicos e encaminha ao vendedor;
- salva sessões e leads em arquivos locais;
- quando o pré-atendimento termina, grava uma nota e tenta aplicar a lista/etiqueta correspondente.

> Este projeto não substitui o repositório `Personalize` e não mexe na API oficial.

## Como puxar e testar

```bash
git clone https://github.com/EmyCodeIs/PersonalizeWppConect.git
cd PersonalizeWppConect
npm install
cp .env.example .env
npm run check
npm start
```

Depois leia o QR Code no navegador aberto pelo WPPConnect.

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

Ao escolher **Letreiro de acrílico**, o bot envia:

1. a imagem `assets/capa-mostruario.png|jpg|jpeg|webp`;
2. uma mensagem separada contendo somente um link comum;
3. a próxima etapa do fluxo de letreiro.

## Link do mostruário

Configure no `.env`:

```env
MOSTRUARIO_LINK_URL=https://personalizeseuambiente.com.br/mostruario-letreiros
```

Esse endereço pode ser provisório durante os testes. Depois basta trocar pela página real.

O sistema **não envia `mostruario.pdf`**, não abre servidor de PDF e não usa URL terminada em `.pdf`.

Mesmo que exista um arquivo `assets/mostruario.pdf`, ele é ignorado pelo fluxo.

## Comandos de teste

Com `ENABLE_TEST_COMMANDS=true`:

```txt
/reset
```

Reinicia somente a sessão do contato atual.

```txt
/resetarsys
```

Limpa todas as sessões e leads locais de teste.

Antes de usar com clientes reais:

```env
ENABLE_TEST_COMMANDS=false
```

## Assets usados no fluxo

```txt
assets/capa-mostruario.png|jpg|jpeg|webp
assets/tabela-cores-v2.png|jpg|jpeg|webp
assets/tabela-espessura.png|jpg|jpeg|webp
assets/tabela-profundidade-3mm.png|jpg|jpeg|webp
```

- `capa-mostruario`: capa enviada ao escolher Letreiro.
- `tabela-cores-v2`: enviada durante a seleção de cores.
- `tabela-espessura`: referência para acrílico personalizado.
- `tabela-profundidade-3mm`: referência de profundidade.

## Nota e lista no WhatsApp Business

Ao concluir a triagem, o sistema tenta registrar:

- nota com os dados coletados;
- lista/etiqueta correspondente ao tipo de atendimento;
- conversa marcada como não lida para o vendedor assumir.

Configuração:

```env
ENABLE_CONTACT_NOTES=true
ENABLE_CONTACT_LABELS=true
SERVICE_LABEL_LETREIRO=Orçamento letreiro
SERVICE_LABEL_PLOTAGEM=Plotagens
SERVICE_LABEL_OUTROS=Outros
```

## Estrutura

```txt
src/
  config/env.js
  core/bufferManager.js
  core/intent.js
  core/menuCatalog.js
  core/messages.js
  core/mostruario.js
  core/parsers.js
  flow/customerFlow.js
  services/contactIdentity.js
  services/leadStore.js
  services/wppconnectClient.js
assets/
scripts/test-flow.js
```

## Comandos úteis

```bash
npm run check
npm run test:flow
npm start
```

Antes de usar em produção, revisar autenticação, persistência, logs, fallback humano e os riscos de uma integração baseada no WhatsApp Web.
