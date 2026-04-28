# Melhoria: recuperação de sessão após falha no `initialize` (timeout Protocol / auth corrompida)

**Data:** 09/04/2026  
**Tipo:** `melhoria_` — robustez de sessão whatsapp-web.js  

## Problema

- Erros como `Runtime.callFunctionOn timed out` / `ProtocolError` não entravam nas retentativas como transitórios, então o fluxo parava após uma tentativa.
- Dados locais do `LocalAuth` podem ficar inconsistentes quando o WhatsApp encerra a sessão; o cliente tentava reutilizar a pasta `session-<id>` indefinidamente sem opção de “começar do zero”.
- Timeout padrão do CDP podia ser curto para inject em servidores lentos.

## O que foi feito

| Item | Detalhe |
|------|---------|
| `protocolTimeout` | Configurável via `PUPPETEER_PROTOCOL_TIMEOUT_MS` (padrão 300000 ms) em `clientOptions.puppeteer`. |
| Erros transitórios | `ProtocolError`, `Runtime.callFunctionOn timed out` e mensagens com `protocolTimeout` passam a permitir as retentativas já existentes. |
| Reset após falhas | Com `WIPE_SESSION_DATA_AFTER_INIT_FAILURE=true` (padrão), após esgotar `CLIENT_INITIALIZE_MAX_RETRIES` a API remove a pasta `session-<id>` com validação de path e chama `setupSession` **mais uma vez** sem novo wipe (evita loop). |
| API start | Resposta pode incluir `sessionDataReset: true` quando o pareamento local foi limpo e a sessão subiu depois disso (usuário pode precisar ler o QR de novo). |

## Variáveis de ambiente

- `PUPPETEER_PROTOCOL_TIMEOUT_MS` — use 0 para voltar ao padrão do Puppeteer (não recomendado em VPS lentos).
- `WIPE_SESSION_DATA_AFTER_INIT_FAILURE` — `false` se o produto não deve apagar auth local automaticamente (ex.: política de tenant).

## Correção: contador `attempt` sempre em 1 nos logs

Com `RECOVER_SESSIONS=true`, os handlers `pupPage` **close** / **error** eram registrados assim que `pupPage` existia (durante `initialize`). Qualquer fecho da página disparava `restartSession` → novo `setupSession`, abortando o `for` de retentativas interno. Os listeners **close** / **error** passaram a ser registrados só **depois** de `initialize()` concluir com sucesso (`attachRecoverSessionPageRecoveryListeners`); logs de debug (`console` / `requestfailed` / `pageerror`) continuam durante o init.

## Histórico de Modificações Recentes

- Criação deste registro; relacionado a `09042026_fix_execution_context_destroyed.md` (retentativas no inject).
- Entrada acima: alinhamento do contador de tentativas com o comportamento real do loop.
