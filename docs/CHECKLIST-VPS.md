# Checklist final de implantação na VPS

Este procedimento foi pensado para um número do WhatsApp Business que já possui histórico, etiquetas e atendimentos feitos por vendedores. A ordem evita respostas antigas, perda de sessão e exposição do Chrome.

## 1. Validar o código antes da VPS

No computador local:

```bash
git pull origin feat/stage-a-short-memory-ttl
npm install
npm test
```

O teste verifica:

- textos atuais e etapas principais do fluxo;
- TTL das sessões;
- etiquetas e cores dos vendedores;
- handoff ao vendedor;
- limite de duas conversas simultâneas;
- serialização do mesmo cliente mesmo depois de timeout;
- limite de idade das mensagens não lidas;
- parâmetros necessários para o Chrome abrir no Linux.

Não prossiga se `npm test` terminar com erro.

## 2. Requisitos mínimos recomendados

- Ubuntu 22.04 ou 24.04;
- Node.js entre 20 e 24;
- pelo menos 2 GB de RAM; 4 GB oferece margem melhor para Chrome, Node e desktop virtual;
- pelo menos 2 GB livres em disco;
- domínio ou subdomínio apontando para o IP da VPS;
- portas públicas 80 e 443;
- portas 5901 e 6080 não devem ficar expostas.

Prefira executar o projeto com um usuário Linux dedicado, sem ser `root`. Quando executado como root, o sistema adiciona automaticamente os argumentos exigidos pelo Chrome, mas o navegador fica sem sandbox.

## 3. Instalar a camada da VPS

Dentro da pasta do projeto:

```bash
npm install
bash scripts/install-session-access-ubuntu.sh
```

O instalador prepara:

- Chrome ou Chromium;
- Xvfb;
- Openbox;
- x11vnc;
- noVNC/websockify;
- Nginx;
- Certbot;
- autenticação HTTP;
- PM2;
- rotação dos logs do PM2.

## 4. Criar o `.env` de produção

```bash
cp deploy/.env.vps.example .env
nano .env
```

Preencha obrigatoriamente:

```env
SESSION_ACCESS_PASSWORD=UMA_SENHA_VNC_FORTE_E_EXCLUSIVA
SESSION_ACCESS_PUBLIC_URL=https://whatsapp.seudominio.com.br/vnc.html?autoconnect=true&resize=scale
```

Mantenha na primeira conexão:

```env
MOCK_MODE=false
WPP_HEADLESS=false
ENABLE_TEST_COMMANDS=false
ALLOWED_CLIENT_NUMBERS=
ALLOWED_CHAT_IDS=
LID_NUMBER_MAP=
ENABLE_UNREAD_BOOTSTRAP=false
LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES=false
SESSION_ACCESS_HOST=127.0.0.1
SESSION_ACCESS_ALLOW_PUBLIC_BIND=false
```

A senha VNC não deve ser a mesma senha usada no Nginx.

## 5. Configurar DNS, HTTPS e acesso do vendedor

Antes do Certbot, crie um registro DNS do tipo `A` apontando o subdomínio para o IP público da VPS.

Depois execute:

```bash
sudo bash scripts/configure-nginx-access.sh whatsapp.seudominio.com.br vendedor
```

O comando:

- cria a senha HTTP do vendedor;
- emite o certificado HTTPS;
- redireciona HTTP para HTTPS;
- publica somente o Nginx;
- mantém noVNC e VNC em `127.0.0.1`;
- adiciona limitação de requisições;
- configura o proxy WebSocket.

O vendedor passará por duas camadas:

1. usuário e senha do Nginx;
2. senha VNC definida no `.env`.

## 6. Executar a pré-verificação

```bash
npm run vps:preflight
```

A verificação bloqueia a subida quando encontra:

- Node incompatível;
- Chrome ausente;
- ferramenta da área de trabalho ausente;
- domínio ainda genérico ou sem HTTPS;
- senha VNC de teste;
- whitelist local na produção;
- comandos de teste ativos;
- bind público do noVNC;
- diretórios persistentes sem permissão;
- erro nos testes do sistema.

Avisos não bloqueiam o processo, mas devem ser lidos. Falhas bloqueiam.

## 7. Primeira conexão com o número antigo

Mantenha:

```env
ENABLE_UNREAD_BOOTSTRAP=false
LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES=false
```

Inicie manualmente:

```bash
npm run vps:start
```

Abra o domínio configurado. A tela exibida será o mesmo `DISPLAY=:1` em que o WPPConnect abriu o Chrome.

Na primeira conexão:

1. escaneie o QR Code;
2. confirme que o WhatsApp Web abriu no link;
3. confirme que as etiquetas existentes permanecem intactas;
4. confira no terminal o relatório de duplicatas;
5. não ative remoção automática nessa etapa;
6. envie uma mensagem nova de um número de teste e percorra o fluxo.

O sistema atenderá somente mensagens recebidas depois que estiver ativo.

## 8. Conferir o handoff dos vendedores

Etiquetas reconhecidas:

```env
SELLER_LABEL_RULES=Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100
```

Comportamento esperado:

- `Adriano`, `Ana`, `Emy` ou `C. Eduardo` no contato: bot não responde;
- `Acompanhar`, `Fornecedor`, `Personalize`, `Voltar` e outras etiquetas: não são vendedores;
- mensagem enviada manualmente pelo vendedor: bloqueio humano persistente;
- etiqueta de vendedor removida: bloqueio dessa etiqueta é liberado após leitura conclusiva;
- bloqueio causado por mensagem manual não é liberado automaticamente.

## 9. Ativar recuperação de não lidas

Somente depois da conferência inicial, pare o processo e altere:

```env
ENABLE_UNREAD_BOOTSTRAP=true
UNREAD_BOOTSTRAP_MAX_AGE_HOURS=24
UNREAD_BOOTSTRAP_MAX_CHATS=30
UNREAD_BOOTSTRAP_MAX_MESSAGES_PER_CHAT=8
UNREAD_RECOVERY_HISTORY_LIMIT=120
```

A recuperação ignora:

- grupos;
- mensagens com timestamp superior a 24 horas;
- contatos com etiqueta de vendedor;
- contatos com bloqueio humano;
- conversas em que houve mensagem manual depois da última saída identificada do bot;
- conversas cujo histórico necessário não pôde ser consultado.

Quando o WhatsApp não fornece timestamp, as proteções de etiqueta, bloqueio e histórico ainda são aplicadas.

## 10. Limites de memória e processamento

Configuração inicial:

```env
FLOW_SESSION_TTL_HOURS=24
COMPLETED_SESSION_TTL_HOURS=24
MAINTENANCE_INTERVAL_MS=900000
RUNTIME_CACHE_MAX_ENTRIES=5000
BOT_ACTIVITY_TTL_DAYS=30
QUEUE_MAX_UNITS=4
MAX_CONCURRENT_CHATS=2
MAX_QUEUE_SIZE=40
CHAT_PROCESS_TIMEOUT_MS=45000
PM2_MAX_MEMORY_RESTART=1200M
```

Garantias:

- no máximo dois clientes processados ao mesmo tempo;
- uma única tarefa real por cliente;
- timeout não libera o mesmo cliente enquanto a tarefa anterior ainda estiver terminando;
- fila global limitada;
- caches temporários limitados;
- sessões vencidas removidas periodicamente;
- checkpoints do bot expiram;
- logs do PM2 são rotacionados.

O limite do PM2 vale para o processo Node. O Chrome é um processo separado; acompanhe o consumo total com `htop`, `free -h` ou o painel da hospedagem.

## 11. Iniciar permanentemente com PM2

Depois do teste manual:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

O arquivo inicia dois processos supervisionados:

- `personalize-wppconnect`: bot e Chrome;
- `personalize-session-access`: verificação e recuperação do desktop/noVNC.

Acompanhe com:

```bash
pm2 status
pm2 logs personalize-wppconnect
pm2 logs personalize-session-access
pm2 monit
npm run session:access:health
```

## 12. Backup e atualização

Pastas obrigatórias:

```text
tokens/
data/
```

Elas não entram no Git e não podem ser apagadas durante deploys.

Crie um backup manual:

```bash
npm run vps:backup
```

O backup inclui `.env`, `tokens/` e os dados persistentes, exclui logs/PIDs e recebe permissão `600`. Por padrão, fica em:

```text
~/personalize-backups/
```

Para backup diário às 03:00:

```bash
crontab -e
```

Adicione, ajustando a pasta do projeto:

```cron
0 3 * * * cd /CAMINHO/PersonalizeWppConect && npm run vps:backup >> "$HOME/personalize-backups/backup.log" 2>&1
```

## 13. O que o vendedor pode fazer no link

O vendedor pode:

- visualizar o mesmo Chrome do bot;
- responder clientes;
- usar notas e etiquetas;
- escanear um novo QR Code;
- conferir o estado real da sessão.

Não deve:

- fechar o Chrome;
- fechar a aba do WhatsApp;
- sair da conta;
- limpar dados do navegador;
- abrir outra sessão do sistema usando o mesmo diretório `tokens/`.

## 14. Critérios de aprovação

A implantação só está aprovada quando:

- `npm test` passa;
- `npm run vps:preflight` termina sem falhas;
- o domínio abre com HTTPS e duas senhas;
- `npm run session:access:health` retorna saudável;
- o vendedor vê o mesmo Chrome do WPPConnect;
- uma etiqueta de vendedor bloqueia o bot;
- uma mensagem manual bloqueia o bot;
- um fluxo novo termina com nota e etiqueta corretas;
- a recuperação de não lidas permanece desligada até a conferência inicial;
- `tokens/` e `data/` possuem backup.
