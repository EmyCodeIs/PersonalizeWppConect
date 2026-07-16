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

## Chrome local e Chrome compartilhado na VPS

### Windows local

Use somente:

```powershell
npm start
```

O WPPConnect abre o Chrome normalmente no computador. O projeto não inicia portal, TightVNC ou link remoto no Windows.

### VPS Ubuntu

Use:

```bash
npm run session:access:install:ubuntu
npm run vps:start
```

O segundo comando cria um desktop virtual, publica essa tela com noVNC e inicia o WPPConnect dentro do mesmo desktop. Assim, o vendedor acessa pelo navegador exatamente o mesmo Chrome usado pela automação.

A configuração completa está em:

```txt
docs/ACESSO-VENDEDOR-VPS.md
```

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

1. o catálogo nativo `Mostruário Letreiros`;
2. o texto de transição confirmado;
3. a lista de tipo de acrílico.

A lista só é liberada depois da confirmação do texto. Se o catálogo nativo estiver indisponível, o sistema usa `MOSTRUARIO_LINK_URL` como contingência simples.

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
assets/capa_bem_vindos.png|jpg|jpeg|webp
assets/tabela-cores-v2.png|jpg|jpeg|webp
assets/tabela-espessura.png|jpg|jpeg|webp
assets/tabela-profundidade-3mm.png|jpg|jpeg|webp
```

- `capa_bem_vindos`: capa de boas-vindas vinculada ao Instagram.
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
