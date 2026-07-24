# Etapa 2 — logs de decisão

## Base

Esta etapa parte de `agent/limpeza-fluxos-paralelos` no commit `68f3994`. Assim, os logs observam somente os fluxos comerciais que permaneceram como fonte de verdade.

## Escopo

A Etapa 2 acrescenta observabilidade sem mudar mensagens, menus, imagens, escolhas ou sequência comercial.

Categorias padronizadas:

```text
ENTRADA
IDENTIDADE
RECUPERAÇÃO
HANDOFF
BUFFER
FILA
FLUXO
ENVIO
ETIQUETA
NOTA
ADMIN
CONEXÃO
ERRO
```

## Correlação

Cada mensagem recebe um identificador curto e estável, derivado do ID real sem expô-lo:

```text
ENTRADA · chat=5531*****999@c.us · msg=A82F · etapa=cidade · evento=recebida · texto=Betim
```

O mesmo `chat/msg/etapa` acompanha buffer, fila, fluxo e os envios executados dentro da resposta.

## Decisões agora observáveis

- entrada recebida, duplicada ou ignorada;
- identidade canônica e quantidade de aliases;
- handoff livre ou bloqueado;
- espera e liberação do buffer;
- agendamento, início, conclusão e falha da fila;
- etapa anterior e etapa posterior do fluxo;
- transporte de texto, imagem, documento e lista;
- registro e confirmação na outbox;
- localização, aplicação e confirmação de etiqueta;
- salvamento de nota;
- comandos administrativos;
- estados de conexão;
- início, bloqueio, resultado inconclusivo e conclusão da recuperação;
- erros fatais, de fila e de transporte.

## Privacidade e leitura

O logger reutiliza a máscara já existente para números e segredos. Em terminal interativo, usa roxo, branco e rosa; em CI ou arquivo de log, mantém texto limpo sem códigos ANSI.

## Validação

`scripts/test-decision-logs.js` protege:

- as 13 categorias;
- máscara de identificadores;
- correlação curta e estável;
- propagação de contexto;
- fallback seguro para categoria inválida.

A suíte completa deve ser executada pelo workflow da PR antes do teste no WhatsApp real.
