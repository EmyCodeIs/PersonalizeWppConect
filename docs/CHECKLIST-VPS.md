# Checklist de prontidão da VPS

Este checklist evita que a primeira inicialização responda conversas antigas ou perca o controle humano já existente no número.

## 1. Antes de enviar para a VPS

No computador local:

```bash
npm install
npm test
```

O teste confere:

- textos atuais do fluxo;
- opções de letreiro, cores e observação;
- TTL de sessões;
- fila por conversa;
- nomes e cores das etiquetas dos vendedores;
- limite de idade da recuperação de mensagens não lidas.

## 2. Arquivo de ambiente de produção

Na VPS:

```bash
cp deploy/.env.vps.example .env
```

Preencha a senha e o domínio. Não leve a whitelist do teste local para produção.

A produção deve manter:

```env
ENABLE_TEST_COMMANDS=false
ALLOWED_CLIENT_NUMBERS=
ALLOWED_CHAT_IDS=
LID_NUMBER_MAP=
```

## 3. Etiquetas dos vendedores

As etiquetas reais reconhecidas pelo sistema são:

```env
SELLER_LABEL_RULES=Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100
```

Regras:

- o reconhecimento é por nome exato, sem diferenciar maiúsculas e acentos;
- `Acompanhar`, `Fornecedor`, `Personalize`, `Voltar` e outras etiquetas não são tratadas como vendedores;
- ao encontrar uma etiqueta de vendedor, o bot não responde ao contato;
- mensagem enviada manualmente depois do bot também bloqueia a automação;
- ao remover uma etiqueta de vendedor, o bloqueio criado por essa etiqueta é liberado após a confirmação da leitura;
- bloqueio por mensagem manual continua persistente para impedir que o bot retome no meio do atendimento humano.

## 4. Primeira conexão com o número antigo

Na primeira inicialização, mantenha:

```env
ENABLE_UNREAD_BOOTSTRAP=false
```

Inicie o sistema, escaneie o QR Code e confirme no terminal que as etiquetas foram encontradas corretamente.

```bash
npm run vps:start
```

Nesse primeiro momento, o sistema atenderá somente mensagens novas recebidas depois que ele estiver ativo.

## 5. Ativar a recuperação de não lidas

Depois da conferência inicial, pare o processo e altere:

```env
ENABLE_UNREAD_BOOTSTRAP=true
UNREAD_BOOTSTRAP_MAX_AGE_HOURS=24
UNREAD_BOOTSTRAP_MAX_CHATS=30
UNREAD_BOOTSTRAP_MAX_MESSAGES_PER_CHAT=8
UNREAD_RECOVERY_HISTORY_LIMIT=120
```

A recuperação ignora:

- conversa com etiqueta de vendedor;
- conversa com bloqueio humano persistente;
- conversa em que houve mensagem manual depois da última saída identificada do bot;
- mensagem não lida com timestamp superior ao limite configurado;
- grupos.

Quando o WhatsApp não disponibilizar timestamp, as proteções de etiqueta e histórico continuam sendo aplicadas.

## 6. Memória, cache e persistência

Configuração recomendada:

```env
FLOW_SESSION_TTL_HOURS=24
COMPLETED_SESSION_TTL_HOURS=24
MAINTENANCE_INTERVAL_MS=900000
RUNTIME_CACHE_MAX_ENTRIES=5000
BOT_ACTIVITY_TTL_DAYS=30
QUEUE_MAX_UNITS=4
MAX_QUEUE_SIZE=40
```

O sistema:

- remove periodicamente sessões vencidas;
- limita caches temporários em memória;
- mantém no máximo 5.000 identificadores recentes de mensagens no processo principal;
- guarda checkpoints do bot por 30 dias;
- mantém uma única tarefa ativa por conversa;
- limita a fila global para evitar crescimento indefinido.

## 7. Pastas que não podem ser apagadas em uma atualização

Preserve na VPS:

```text
tokens/
data/
```

Elas contêm a sessão do WhatsApp, sessões curtas do fluxo, perfis mínimos, bloqueios humanos e checkpoints necessários para uma recuperação segura.

Não copie essas pastas para o Git e não as substitua por pastas vazias durante o deploy.

## 8. Processo permanente

Depois do teste manual:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

O PM2 reinicia o bot após falhas e também reinicia o processo se o limite de memória configurado for ultrapassado.

Para acompanhar:

```bash
pm2 status
pm2 logs personalize-wppconnect
pm2 monit
```

## 9. Acesso do vendedor ao mesmo Chrome

O vendedor acessará o domínio configurado no Nginx/noVNC. Essa página transmite o mesmo `DISPLAY=:1` em que o WPPConnect abriu o Chrome.

O vendedor pode responder e usar etiquetas, mas não deve:

- fechar o Chrome;
- fechar a aba do WhatsApp;
- sair da conta;
- limpar dados do navegador.
