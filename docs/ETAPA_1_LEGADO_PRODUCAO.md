# Etapa 1 — legado oficial da Personalize

## Referência

Esta branch nasceu diretamente de `PersonalizeProd/main` no commit:

```text
a9daeb1d69a4e043589a97eb63cece8775ab7228
```

Versão declarada da aplicação: `0.7.3`.

Este commit é o ponto de partida do sistema que estava versionado como produção antes da evolução estrutural com a BaseBots.

## Objetivo desta etapa

Registrar e proteger o comportamento atual antes de alterar conexão, recuperação, handoff, etiquetas ou comando administrativo.

Nesta etapa não existe mudança de comportamento do atendimento.

## Fonte do produto Personalize

Os arquivos abaixo permanecem responsáveis pelo produto e pelo fluxo comercial:

```text
src/flow/customerFlow.js
src/core/messages.js
src/core/menuCatalog.js
src/core/mostruario.js
src/core/parsers.js
src/core/intent.js
src/domain/acrilicoThickness.js
assets/
```

Mudanças estruturais futuras não podem alterar esses arquivos incidentalmente. Uma mudança comercial neles deverá ser solicitada, testada e registrada separadamente.

## Estrutura atual observada

### Entrada e operação

```text
src/index.js
├── recebe mensagens
├── identifica contato
├── verifica bloqueio humano
├── aplica buffer por etapa
├── enfileira por contato
└── chama processCustomerMessage()
```

### Estado comercial

```text
src/services/leadStore.js
├── sessões do fluxo
├── perfis recorrentes
├── leads concluídos
└── bloqueio humano leve
```

### Recursos específicos

```text
src/core/serviceLabels.js   → etiquetas comerciais
src/core/sellerHandoff.js   → bloqueio atual por etiqueta de vendedor
src/core/messageExperience.js → digitação e bloco visual de boas-vindas
src/services/wppconnectClient.js → integração atual com WPPConnect
```

## Contrato do fluxo atual

Os testes de legado registram os caminhos abaixo.

### Letreiro colorido

```text
inicio
→ escolher_servico
→ tipo_acrilico
→ cor_basica_qtd
→ cor_basica_tipo
→ cor_basica_select_solida/espelhado
→ tamanho
→ espessura_extra_3mm
→ arte_menu
→ arte_coleta
→ cidade
→ envio
→ endereco ou retirada
→ observacao_pedido_menu
→ observacao_pedido_coleta ou conclusão
→ concluido
```

### Acrílico personalizado

```text
tipo_acrilico
→ pantone
→ tamanho
→ espessura_personalizada
→ arte_menu
→ arte_coleta
→ cidade
→ envio
```

### Plotagem

```text
escolher_servico
→ plotagem_descricao
→ plotagem_medida
→ plotagem_local
→ plotagem_prazo
→ concluido
```

### Outros

```text
escolher_servico
→ outros_descricao
→ outros_referencia
→ outros_prazo
→ concluido
```

## O que os testes protegem

- transições persistidas das etapas comerciais;
- sequência inicial de saudação, imagem vinculada e lista;
- mostruário e tabelas enviados como imagem;
- listas interativas essenciais;
- conclusão dos fluxos de letreiro, plotagem e outros;
- persistência da etapa em disco após recarregar o armazenamento;
- arquivos e assets mínimos do produto.

Os testes usam uma pasta temporária. Eles não leem nem alteram `data/`, `.env`, tokens ou sessão do WhatsApp da instalação real.

## Problemas conhecidos — ainda não corrigidos nesta etapa

1. Mensagens enviadas manualmente pela equipe não são observadas de forma confiável como handoff.
2. O handoff depende de regras limitadas de etiquetas e pode expirar.
3. A recuperação após reinício depende principalmente das mensagens não lidas e de deduplicação em memória.
4. Uma resposta recebida enquanto o sistema estava desligado pode não voltar para a etapa persistida.
5. Etiquetas são tratadas por uma mistura de `WPP.labels` e `WPP.lists`.
6. `/resetarsys` ainda está dentro do fluxo comercial.
7. Não existe journal persistente de entrada e saída na aplicação atual.

Esses pontos serão tratados em etapas separadas. Nenhum deles foi "corrigido" silenciosamente nesta branch.

## Comandos de validação

```bash
npm ci
npm run verify:legacy
```

`verify:legacy` executa validação de sintaxe, teste existente de etiquetas e os contratos de produção adicionados nesta etapa.
