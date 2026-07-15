# Acesso do vendedor ao mesmo Chrome do WPPConnect

## O que será compartilhado

Na VPS existe uma área de trabalho virtual Linux identificada por `DISPLAY=:1`.

O comando `npm run vps:start` faz, nesta ordem:

1. cria a área de trabalho virtual com Xvfb;
2. inicia o Openbox nessa área de trabalho;
3. compartilha a tela com x11vnc;
4. publica essa tela no navegador com noVNC;
5. inicia o bot com `DISPLAY=:1`;
6. o WPPConnect abre o Chrome dentro desse mesmo `DISPLAY=:1`.

Por isso, o vendedor não abre outra sessão do WhatsApp. Ele controla pelo navegador exatamente o mesmo Chrome que está sendo usado pelo WPPConnect.

## Uso local no Windows

No Windows não existe portal local automático.

Use somente:

```powershell
npm start
```

O Chrome será aberto normalmente no próprio computador.

## Instalação inicial na VPS Ubuntu

Dentro do projeto:

```bash
npm install
npm run session:access:install:ubuntu
```

Configure no `.env`:

```env
WPP_HEADLESS=false
SESSION_DISPLAY=:1
SESSION_SCREEN_SIZE=1366x768x24
SESSION_ACCESS_HOST=127.0.0.1
SESSION_ACCESS_PORT=6080
SESSION_VNC_PORT=5901
SESSION_ACCESS_PASSWORD=coloque-uma-senha-forte
SESSION_ACCESS_PUBLIC_URL=https://whatsapp.seudominio.com.br/vnc.html?autoconnect=true&resize=scale
```

## Iniciar bot e tela compartilhada

```bash
npm run vps:start
```

Esse é o comando que garante que o bot e o acesso do vendedor usem o mesmo desktop.

## Publicar em domínio próprio

1. crie um subdomínio, por exemplo `whatsapp.seudominio.com.br`;
2. aponte o DNS para o IP da VPS;
3. copie `deploy/nginx/whatsapp-novnc.conf.example` para a configuração do Nginx;
4. troque `whatsapp.seudominio.com.br` pelo domínio real;
5. valide e recarregue o Nginx;
6. gere o HTTPS com Certbot.

O noVNC continua escutando apenas em `127.0.0.1:6080`. O vendedor entra pelo domínio HTTPS do Nginx.

## Parar somente o desktop remoto

```bash
npm run session:access:stop
```

## Regra de uso para o vendedor

O vendedor pode abrir conversas, responder, consultar dados e usar etiquetas. Como ele estará controlando o mesmo Chrome da automação, não deve fechar a aba do WhatsApp, sair da conta, apagar os dados do navegador ou encerrar o Chrome.
