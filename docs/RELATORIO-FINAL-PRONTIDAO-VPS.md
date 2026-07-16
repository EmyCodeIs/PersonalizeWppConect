# Relatório final de prontidão para VPS

Data da revisão: 15/07/2026  
Branch: `feat/stage-a-short-memory-ttl`

## Veredito

A estrutura foi corrigida e está **apta para subir em uma VPS de homologação**.

Ela ainda não deve ser considerada produção aprovada antes de passar por duas validações reais:

1. `npm test` na cópia atualizada do projeto;
2. `npm run vps:preflight` e teste do WhatsApp/noVNC dentro da VPS real.

Essa distinção é necessária porque testes de código não simulam permissões, DNS, certificado, navegador, RAM e sessão real do WhatsApp da hospedagem.

## 1. Concorrência e fila

### Problema encontrado

`MAX_CONCURRENT_CHATS=2` existia no ambiente, mas a fila considerava somente as unidades globais. Quatro tarefas leves poderiam executar ao mesmo tempo.

O timeout também podia liberar o cliente enquanto a tarefa original ainda estivesse terminando, permitindo duas alterações simultâneas na mesma sessão.

### Correção

- limite real de chats simultâneos aplicado;
- padrão seguro de dois clientes;
- unidades globais continuam limitadas;
- mesmo cliente nunca executa duas tarefas reais simultaneamente;
- timeout é informado no momento correto;
- o lock do cliente permanece até a tarefa original terminar;
- fila continua limitada a 40 itens.

### Validação direcionada

Teste isolado executado com quatro clientes:

- pico observado: dois clientes simultâneos;
- timeout observado em aproximadamente 21 ms no cenário de teste;
- segunda tarefa do mesmo cliente iniciou somente depois da primeira terminar.

## 2. Padrões seguros de produção

### Correções

Os padrões internos agora são:

```env
ENABLE_TEST_COMMANDS=false
ENABLE_UNREAD_BOOTSTRAP=false
LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES=false
MAX_CONCURRENT_CHATS=2
```

Uma variável ausente não ativa comandos destrutivos nem recuperação de conversas antigas.

Os modelos `.env` foram atualizados para:

- não conter dados pessoais reais;
- começar com recuperação de não lidas desligada;
- começar apenas auditando etiquetas duplicadas;
- usar whitelist fictícia somente nos exemplos locais;
- manter a produção sem whitelist.

## 3. Etiquetas e handoff humano

### Vendedores reconhecidos

```text
Adriano     — verde-claro
Ana         — azul
Emy         — verde-limão
C. Eduardo  — laranja
```

### Regras preservadas

- reconhecimento pelo nome exato;
- outras etiquetas não são confundidas com vendedor;
- etiqueta de vendedor bloqueia o bot;
- mensagem manual bloqueia o bot;
- remover a etiqueta de vendedor libera o bloqueio criado pela etiqueta;
- bloqueio por mensagem manual continua persistente.

### Exclusão de duplicatas

A manutenção agora apenas relata duplicatas por padrão.

Mesmo que um `.env` antigo ainda contenha:

```env
LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES=true
```

nenhuma etiqueta será apagada sem a confirmação adicional:

```env
LABEL_MAINTENANCE_CONFIRM_DELETE=CONFIRMAR_EXCLUSAO
```

Na primeira implantação, essa confirmação deve permanecer vazia.

## 4. Recuperação de mensagens não lidas

### Proteções confirmadas

A recuperação verifica:

- idade máxima da mensagem;
- grupos;
- etiqueta de vendedor;
- bloqueio humano persistente;
- histórico da conversa;
- mensagem manual posterior à última saída registrada do bot;
- disponibilidade do histórico necessário para decidir com segurança.

### Primeira conexão

O ambiente da VPS começa com:

```env
ENABLE_UNREAD_BOOTSTRAP=false
```

Assim o número antigo não começa respondendo conversas anteriores ao ligar o sistema.

A ativação deve ocorrer somente depois da conferência da sessão e das etiquetas.

## 5. Memória, cache e armazenamento

### Limites mantidos

```env
FLOW_SESSION_TTL_HOURS=24
COMPLETED_SESSION_TTL_HOURS=24
RUNTIME_CACHE_MAX_ENTRIES=5000
BOT_ACTIVITY_TTL_DAYS=30
MAX_QUEUE_SIZE=40
PM2_MAX_MEMORY_RESTART=1200M
```

### Correções adicionais

- limpeza periódica dos registros temporários;
- limite de checkpoints recentes;
- rotação dos logs do PM2;
- retenção de 14 arquivos rotacionados;
- compressão de logs;
- backup local de `.env`, `tokens/` e `data/`;
- exclusão de logs, PIDs e senha VNC temporária do arquivo de backup;
- arquivo de backup protegido com permissão `600`.

O limite de memória do PM2 agora é carregado corretamente do `.env`.

O Chrome é um processo separado do Node. O consumo total ainda precisa ser medido na VPS real.

## 6. Chrome da automação na VPS

### Correções

- instalador verifica e instala Chrome/Chromium;
- WPPConnect continua com `headless=false`;
- Chrome herda o mesmo `DISPLAY=:1` compartilhado pelo noVNC;
- Linux recebe `--disable-dev-shm-usage`;
- execução como root recebe automaticamente `--no-sandbox` e `--disable-setuid-sandbox`;
- execução como usuário Linux comum mantém o sandbox;
- parâmetros extras podem ser definidos por `WPP_BROWSER_ARGS`.

### Validação direcionada

O resolvedor de argumentos foi testado para:

- Windows sem argumentos Linux;
- Linux com usuário comum;
- Linux com usuário root;
- remoção de argumentos duplicados.

## 7. Acesso do vendedor ao mesmo Chrome

### Estrutura final

```text
WPPConnect
  ↓ abre o Chrome em DISPLAY=:1
Xvfb/Openbox
  ↓ formam a área de trabalho virtual
x11vnc
  ↓ compartilha somente em 127.0.0.1
noVNC/websockify
  ↓ publica somente em 127.0.0.1:6080
Nginx
  ↓ HTTPS + autenticação HTTP
Domínio do vendedor
```

O vendedor visualiza e controla o mesmo Chrome usado pelo bot.

### Segurança adicionada

- VNC interno somente em loopback;
- noVNC interno somente em loopback;
- bind público bloqueado pelo script;
- senha VNC fraca ou de teste recusada;
- HTTPS obrigatório;
- segunda autenticação no Nginx;
- limitação de requisições e conexões;
- cabeçalhos de segurança;
- cache desativado para a tela remota;
- proxy WebSocket configurado;
- portas internas não precisam ser abertas no firewall.

A sintaxe do modelo Nginx foi validada com certificado temporário.

## 8. Supervisão e recuperação

O PM2 agora supervisiona dois processos:

```text
personalize-wppconnect
personalize-session-access
```

O segundo processo verifica:

- Xvfb;
- Openbox;
- x11vnc;
- noVNC;
- PIDs;
- portas internas;
- disponibilidade de `vnc.html`.

Se um componente do acesso remoto morrer, o watchdog tenta recuperá-lo.

Uma trava com `flock` impede que o bot e o watchdog iniciem duas áreas de trabalho simultaneamente.

## 9. Pré-verificação da VPS

Foi criado:

```bash
npm run vps:preflight
```

Ele verifica:

- `.env`;
- Node 22 a 24;
- npm;
- navegador;
- Xvfb/Openbox/x11vnc/noVNC;
- Nginx e autenticação HTTP;
- utilitário de trava;
- domínio HTTPS;
- senha VNC;
- whitelist;
- comandos de teste;
- bind das portas;
- diretórios persistentes;
- assets;
- sintaxe Bash;
- RAM;
- espaço em disco;
- `npm test`.

Falhas impedem a aprovação. Avisos precisam ser lidos, mas não bloqueiam automaticamente.

## 10. Instalação automatizada

O instalador Ubuntu agora prepara:

- Chrome ou Chromium;
- Xvfb;
- Openbox;
- x11vnc;
- noVNC;
- websockify;
- Nginx;
- Certbot;
- `htpasswd`;
- PM2;
- `pm2-logrotate`;
- ferramentas de rede e trava.

Também foi criado um script para configurar domínio, certificado e autenticação:

```bash
sudo bash scripts/configure-nginx-access.sh DOMINIO USUARIO
```

## 11. Fluxo e textos

Nenhum texto comercial foi intencionalmente alterado durante esta revisão.

Os testes de prontidão continuam travando:

- boas-vindas;
- serviços;
- mostruário;
- cores;
- espessuras;
- medida;
- arte;
- cidade;
- endereço;
- observação;
- finalização;
- nomes e cores dos vendedores.

Foi preservada a correção da etapa de observação para impedir mensagem vazia.

## 12. Persistência

As pastas abaixo continuam fora do Git e precisam permanecer entre deploys:

```text
tokens/
data/
```

Elas guardam sessão do WhatsApp, memória curta, identidades, bloqueios humanos e checkpoints.

Comando de backup:

```bash
npm run vps:backup
```

## 13. Validações realizadas nesta revisão

Foram realizadas:

- leitura dos arquivos críticos da branch;
- revisão de inicialização e persistência;
- teste isolado da fila e do timeout;
- teste isolado dos argumentos do Chrome;
- teste de sintaxe do modelo Nginx com certificado temporário;
- conferência dos parâmetros `browserArgs` e `puppeteerOptions` documentados pelo WPPConnect;
- conferência do formato oficial de `novnc_proxy --listen`, `--vnc` e `--web`;
- inclusão de testes automáticos e workflow do GitHub.

## 14. Validações que ainda dependem do ambiente real

Ainda precisam ser executadas fora desta revisão estática:

```bash
npm test
npm run vps:preflight
npm run vps:start
npm run session:access:health
```

Também é necessário confirmar manualmente:

- QR Code e restauração da sessão;
- consumo real de RAM do Chrome;
- domínio e certificado da VPS;
- acesso do vendedor pelo navegador;
- etiquetas reais no número;
- um fluxo novo completo;
- uma tomada de atendimento por vendedor;
- recuperação de uma mensagem não lida recente depois da ativação controlada.

## Conclusão

Os bloqueadores encontrados na auditoria foram corrigidos no código e na infraestrutura.

A próxima etapa não é alterar mais a lógica do bot. É executar a validação local e depois subir para uma VPS de homologação seguindo `docs/CHECKLIST-VPS.md`.