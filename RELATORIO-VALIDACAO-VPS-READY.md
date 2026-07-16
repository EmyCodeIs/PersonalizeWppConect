# Validação — Personalize WPPConnect VPS Ready

## Resultado

- `npm test`: aprovado.
- 86 arquivos JavaScript/CommonJS verificados por sintaxe.
- Fluxo validado: catálogo → texto confirmado → lista.
- Falha de texto bloqueia a lista.
- SQLite validado com migração de arquivos legados.
- Conteúdo sensível não aparece em texto puro no arquivo SQLite.
- Chave incorreta impede descriptografia.
- Arquivos JSON/JSONL legados são selados em arquivo criptografado antes da remoção.
- Snapshot consistente do SQLite e backup criptografado validados.
- Cache pesado do Chrome validado em `data/browser-cache`, fora de `tokens`.
- Limpeza de cache de `tokens` preserva autenticação e bloqueia limpeza com perfil ativo.
- Configuração noVNC/Nginx mantém 5901/6080 no localhost.

## Estrutura de produção preparada

- Node.js 22 a 24.
- SQLite nativo do Node em `data/personalize.sqlite`.
- AES-256-GCM em nível de aplicação para documentos e eventos persistidos.
- Chave gerada automaticamente no `.env` da VPS.
- `.env`, banco, tokens e backups com permissões restritas.
- Backup diário criptografado via PM2 às 03:15.
- noVNC público somente por Nginx + HTTPS.
- Usuário HTTP: `personalize`.
- Senha HTTP e VNC solicitada: `2580`.

## Limites honestos

- O domínio e o certificado HTTPS só podem ser concluídos dentro da VPS, após o DNS apontar para ela.
- A senha `2580` é fraca. Foi deixada porque foi solicitada e exige `ALLOW_WEAK_SESSION_PASSWORD=true`.
- A sessão do WhatsApp não foi incluída. A VPS poderá exigir leitura de QR Code.
- `npm audit` encontrou 5 avisos moderados transitivos do WPPConnect e nenhum alto/crítico. Não foi aplicado downgrade/alteração major para não arriscar regressão no bot validado.
- O SQLite usa `node:sqlite`, disponível no Node 22, ainda marcado como experimental por essa versão do Node.

## Comando de implantação

```bash
bash scripts/deploy-vps-ready.sh whatsapp.seudominio.com.br
```
