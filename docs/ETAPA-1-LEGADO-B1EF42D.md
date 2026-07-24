# Etapa 1 — proteção e mapa da produção ativa

## Ponto de partida oficial

- Repositório: `EmyCodeIs/PersonalizeProd`
- Branch de origem: `main`
- Commit que espelha a VPS ativa: `b1ef42daddba021a4eda7269c514a1958ba62f9d`
- Mensagem do commit: `sync active VPS release fixes`
- Versão declarada: `0.7.3`
- Branch desta etapa: `agent/etapa-1-legado-b1ef42d`

A Etapa 1 não corrige handoff, recuperação, etiquetas ou `/resetarsys`. Ela transforma a versão ativa em uma referência verificável antes das correções.

## Caminho real de inicialização

```text
npm start
  -> src/start-with-required-labels.js
     -> safeLoggingPreload
     -> preloads de etiquetas, handoff, reset, fluxo, recuperação e confiabilidade
     -> manutenção de cache, banco e acesso por QR
     -> src/bootstrap.js
        -> envolve createWppChannel
        -> instala limpeza de reset
        -> confere etiquetas na inicialização
        -> src/index.js
```

A ordem importa: vários preloads substituem funções em tempo de execução. Uma correção feita apenas no arquivo principal pode ser sobrescrita por uma camada carregada depois.

## Mapa de responsabilidades

| Área | Arquivos centrais | Responsabilidade observada |
|---|---|---|
| Entrada | `src/start-with-required-labels.js`, `src/bootstrap.js`, `src/index.js` | Preloads, conexão e escutas |
| Fluxo comercial | `src/flow/customerFlow.js` | Sequência do atendimento e conclusão |
| Conteúdo comercial | `src/core/messages.js`, `src/core/menuCatalog.js`, `src/core/mostruario.js` | Mensagens, menus, imagens e mostruário |
| Interpretação | `src/core/intent.js`, `src/core/parsers.js`, `src/domain/acrilicoThickness.js` | Intenção, dados e regras do acrílico |
| Buffer e fila | `src/core/bufferManager.js`, `src/core/chatTaskQueue.js` | Agrupamento e processamento por contato |
| Estado e identidade | `src/services/leadStore.js`, `src/services/contactIdentity.js` | Sessão, perfil, leads e aliases `@lid`/`@c.us` |
| Transporte | `src/services/wppconnectClient.js` | Entrada e saída pelo WPPConnect |
| Handoff | `src/core/sellerHandoff.js` e preloads relacionados | Bloqueios por atendimento humano |
| Etiquetas | `src/core/serviceLabels.js` e preloads relacionados | Catálogo e vínculo operacional |
| Recuperação | `src/index.js`, `src/core/unreadReconnectRecoveryPreload.js` | Não lidas, retomada e reconexão |

## Contrato criado

O teste `scripts/test-production-legacy-contract.js` valida:

1. versão, entrada e comando de inicialização usados pela produção;
2. ordem das camadas carregadas antes do `index.js`;
3. instalação do bootstrap antes da entrada principal;
4. presença de buffer, fila, handoff, identidade, estado e transporte;
5. integridade exata dos sete arquivos que definem mensagens, menus, sequência e regras comerciais.

Os sete arquivos comerciais são comparados pelos mesmos hashes de blob do commit `b1ef42d`. Assim, uma alteração incidental falha no CI. Uma mudança comercial intencional continua possível, mas exige atualização consciente do contrato.

## Validação automática

O workflow `.github/workflows/etapa-1-legado.yml` usa Node 22, compatível com o `engines` atual, e executa:

```bash
npm ci --no-audit --no-fund
npm run check
node scripts/test-production-legacy-contract.js
npm test
```

Esses comandos não iniciam o WhatsApp nem usam a sessão real. Eles validam o repositório e a suíte automatizada já existente.

## O que foi preservado

Nenhum arquivo executado pelo bot foi modificado. Permanecem iguais ao commit da VPS:

- mensagens e listas;
- imagens e assets;
- sequência comercial;
- conexão WPPConnect;
- buffer e fila;
- persistência;
- handoff;
- recuperação;
- etiquetas e notas;
- comandos `/reset`, `/reiniciar` e `/resetarsys`;
- painel e configuração da VPS.

## Pontos observados para as próximas etapas

- a inicialização atual depende de muitas substituições por preload;
- `src/index.js` não é a entrada direta de produção;
- o projeto exige Node 22 ou superior, por isso a validação não usa Node 20;
- a suíte existente é ampla, mas não substitui testes reais no WhatsApp;
- deduplicação persistente, proteção imediatamente antes de cada envio, decisão inconclusiva na recuperação, API correta de etiquetas e reset verificável continuam pertencendo às etapas 3 a 6;
- a Etapa 2 deve acrescentar observabilidade sem alterar os hashes dos arquivos comerciais protegidos.

## Critério de aprovação

A Etapa 1 está aprovada quando:

- a branch parte de `b1ef42d`;
- o workflow fica verde;
- o diff contém apenas documentação, contrato e CI;
- nenhum arquivo de runtime muda;
- a `main` e a VPS permanecem inalteradas.
