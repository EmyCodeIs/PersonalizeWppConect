# Etapa 1 — Legado oficial da Personalize em produção

## Referência

- Repositório: `EmyCodeIs/PersonalizeProd`
- Origem da branch: `main`
- Commit de produção usado como ponto de partida: `a9daeb1d69a4e043589a97eb63cece8775ab7228`
- Branch desta etapa: `agent/etapa-1-proteger-legado-prod`
- Versão declarada no projeto: `0.7.3`

Esta etapa não altera o comportamento do atendimento. Ela registra o sistema atual como ponto de partida para a evolução estrutural e cria testes que acusarão mudanças involuntárias no fluxo.

## Regra de desenvolvimento

Mudanças estruturais futuras não podem alterar silenciosamente:

- textos;
- menus;
- imagens;
- sequência das perguntas;
- dados coletados;
- nota final;
- regras comerciais.

Quando uma alteração comercial for desejada, ela deverá ser tratada separadamente e atualizar conscientemente os testes de legado.

## Estrutura atual

### Produto e fluxo da Personalize

Arquivos que definem o atendimento e continuam pertencendo à Personalize:

```text
src/flow/customerFlow.js
src/core/messages.js
src/core/menuCatalog.js
src/core/mostruario.js
src/core/intent.js
src/core/parsers.js
src/domain/acrilicoThickness.js
assets/
```

Responsabilidades atuais:

- início e identificação do contexto;
- escolha entre Letreiro, Plotagem e Outros;
- tipo de acrílico;
- cores e espessura;
- medida;
- arte;
- cidade;
- forma de recebimento;
- endereço e observação;
- conclusão e nota do contato.

### Estado comercial da Personalize

```text
src/services/leadStore.js
src/services/contactIdentity.js
```

Responsabilidades atuais:

- sessão e etapa do fluxo;
- dados coletados;
- perfil recorrente;
- leads finalizados;
- identidade `@lid`/`@c.us`;
- bloqueio humano leve atualmente usado pela produção.

Esses dados não serão substituídos pela sessão interna da BaseBots. A Base cuidará de estado operacional; a Personalize continuará cuidando do orçamento e da experiência comercial.

### Infraestrutura atual que será revisada gradualmente

```text
src/index.js
src/core/bufferManager.js
src/core/chatTaskQueue.js
src/services/wppconnectClient.js
src/core/sellerHandoff.js
src/core/serviceLabels.js
```

Responsabilidades atuais:

- conexão WPPConnect;
- entrada de mensagens;
- recuperação de não lidas;
- deduplicação em memória;
- buffer;
- fila;
- handoff por etiquetas conhecidas;
- criação e aplicação de etiquetas comerciais.

Essas partes não serão removidas de uma vez. Cada responsabilidade será comparada com a BaseBots, substituída isoladamente e testada no WhatsApp real.

## Comportamentos protegidos pelos testes

A suíte `test/legacy-flow.test.js` registra:

1. saudação, capa de boas-vindas e menu de serviços;
2. entrada no fluxo de letreiro com mostruário e tipo de acrílico;
3. fluxo completo de letreiro até nota e conclusão;
4. fluxo completo de plotagem;
5. fluxo completo de outros;
6. persistência em disco da etapa ativa;
7. bloqueio da mesma sessão após conclusão.

Os testes usam uma pasta temporária. Eles não leem nem alteram o `.env`, `data/`, tokens ou sessão do WhatsApp da instalação real.

## Lacunas registradas, ainda não corrigidas

As seguintes necessidades ficam documentadas como testes futuros, sem implementação nesta etapa:

- mensagem manual `fromMe` ativar handoff persistente;
- qualquer etiqueta externa às etiquetas comerciais ativar handoff;
- cancelar buffer e fila somente do contato assumido;
- impedir envio quando o histórico ou a identidade estiverem inconclusivos;
- recuperar uma resposta recebida enquanto o sistema estava desligado;
- continuar da etapa comercial persistida;
- não reproduzir mensagens anteriores ao marco de adoção da nova estrutura;
- corrigir etiquetas sem misturar `WPP.labels` e `WPP.lists`;
- mover `/resetarsys` para antes de handoff, buffer e fila.

## Limites desta etapa

Não foram alterados:

```text
src/flow/customerFlow.js
src/core/messages.js
src/core/menuCatalog.js
src/core/mostruario.js
src/domain/acrilicoThickness.js
src/index.js
src/services/wppconnectClient.js
src/core/serviceLabels.js
src/core/sellerHandoff.js
src/services/leadStore.js
```

Também não foram criados:

- outro painel;
- outra conexão WPPConnect;
- outro fluxo;
- outra persistência comercial;
- cópia da BaseBots dentro deste repositório.

## Comandos de validação

```bash
npm ci
npm run verify
```

O comando deverá validar sintaxe, fluxo legado e testes atuais de etiquetas, sem iniciar o WhatsApp.

## Próxima etapa

A Etapa 2 será apenas observabilidade: completar os logs de decisão mantendo o mesmo comportamento. Handoff, recuperação, etiquetas e reset continuarão sem alteração até a etapa específica de cada um.
