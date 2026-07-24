# Proteção de integridade UTF-8

## Objetivo

Impedir que edições manuais ou geradas por IA introduzam símbolos corrompidos nos textos do atendimento, nos logs, nos scripts ou na documentação.

## Regra para futuras alterações

Todos os arquivos de texto versionados devem permanecer em UTF-8 e normalizados em Unicode NFC.

Antes de enviar uma alteração:

```bash
npm run check
```

Essa verificação aceita normalmente:

- português com acentos;
- emojis válidos;
- o separador `·` dos logs;
- setas como `→`;
- BOM inicial nos scripts PowerShell que já o utilizam.

Ela reprova:

- arquivo que não possa ser decodificado como UTF-8;
- caractere substituto `�`;
- sequências corrompidas como `FranÃ§a`, `Â·`, `â†’` e `ðŸ...`;
- caracteres de controle ou direcionamento invisíveis;
- BOM no meio do arquivo;
- texto fora da normalização NFC.

Não adicione exceções para fazer o CI passar. A correção deve acontecer no texto de origem.

## Escopo auditado

O verificador usa os arquivos versionados pelo Git. Dados de clientes, tokens, caches e arquivos binários não entram na auditoria.

Na ausência do Git, ele percorre o projeto e ignora explicitamente diretórios de execução e ativos binários.
