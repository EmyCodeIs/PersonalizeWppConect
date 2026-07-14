# Acesso local à sessão do WhatsApp Web no Windows

Este projeto agora possui um modo de acesso local por link para a **mesma sessão do Chrome** usada pelo bot.

## O que você precisa

- Windows local
- o bot rodando normalmente (`npm run dev`)
- um servidor VNC para Windows ativo na mesma máquina
  - TightVNC Server **ou** UltraVNC Server
- senha do VNC configurada como `2580`

## Configuração recomendada

No `.env`:

```env
SESSION_ACCESS_HOST=127.0.0.1
SESSION_ACCESS_PORT=6080
SESSION_VNC_HOST=127.0.0.1
SESSION_VNC_PORT=5900
SESSION_ACCESS_PASSWORD=2580
SESSION_VNC_PASSWORD=2580
```

## Dependências do link local

Instale as dependências do projeto:

```bash
npm install
```

Isso instalará também:

- `@novnc/novnc`
- `ws`

## Comando para subir o link

Em outro terminal, com o bot já aberto:

```bash
npm run session:access:windows
```

Depois abra:

```text
http://127.0.0.1:6080
```

Senha:

```text
2580
```

## Se quiser abrir de outro dispositivo da mesma rede

Troque no `.env`:

```env
SESSION_ACCESS_HOST=0.0.0.0
```

Depois abra:

```text
http://IP-DA-SUA-MAQUINA:6080
```

## Observações

- esse link não cria outro WhatsApp Web
- ele abre a mesma sessão gráfica do Chrome usada pelo sistema
- se o vendedor responder por essa tela, o sistema deve tratar como handoff humano
- para encerrar o acesso local, basta fechar o terminal do `session:access:windows`
