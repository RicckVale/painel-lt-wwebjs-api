# Módulo: Sessions (src/sessions.js)

## Visão Geral

Módulo responsável pelo ciclo de vida das sessões WhatsApp: criação, parada, logout, reconexão e limpeza.

Desde 24/11/2026 o motor é **Baileys** (`@whiskeysockets/baileys`, WebSocket direto com o WhatsApp), sem Chrome/Puppeteer. A camada `src/baileys/` expõe um `BaileysClient` com a mesma interface do `Client` do whatsapp-web.js. Por isso os controllers e o contrato HTTP/webhook usado pelo Floume continuam iguais.

## Estruturas de Dados

| Estrutura | Tipo | Finalidade |
|-----------|------|------------|
| `sessions` | `Map<sessionId, BaileysClient>` | Sessões em memória. A entrada nasce no `start`, antes de conectar. |
| `sessionLocks` | `Map<sessionId, boolean>` | Mutex por sessão para stop, restart e terminate concorrentes |
| `client.qr` | `string \| null` | Último QR emitido pelo `connection.update`, lido por `GET /session/qr/:id` |
| `client.store` | `SessionStore` | Chats, contatos, mensagens recentes e mapa LID → telefone, persistido em `floume-store.json` |

## Pastas

- `<SESSIONS_PATH>/baileys-<sessionId>/`: credencial do Baileys (`useMultiFileAuthState`: `creds.json` e chaves) e `floume-store.json`.
- `<SESSIONS_PATH>/session-<sessionId>/`: perfil Chrome/LocalAuth da versão antiga. **Não é lido nem apagado.** Não migra para o Baileys: a sessão precisa de QR novo.

## Funções Principais

### `setupSession(sessionId)`

- Cria o `BaileysClient`, põe no `Map` na hora e roda `initialize()` em segundo plano (`useMultiFileAuthState` e depois `makeWASocket`). Não espera QR nem conexão.
- Se a sessão já existe e está viva, devolve `alreadyExists`. O controller responde `202 session_initialization_in_progress`, ou `200 session_already_connected` se já estiver conectada.
- Se a sessão existente está em estado terminal (logout, conflito, `forbidden`), ela é descartada e recriada.

### `validateSession(sessionId)`

- Sessão ausente: `session_not_found`.
- Sessão conectada: `{ success: true, state: 'CONNECTED', message: 'session_connected' }`.
- Qualquer outro estado: `{ success: false, state, message: 'session_not_connected' }`. Os estados possíveis são:
  - `STARTING`: o adapter do Floume mapeia para INITIALIZING
  - `UNPAIRED`: aguardando QR
  - `OPENING`: reconectando
  - `CONFLICT`

### `destroySession` (stop) / `reloadSession` (restart)

Encerram o socket sem logout. A credencial continua na pasta e o restart reconecta sem QR.

### `deleteSession` (terminate)

Faz logout se a sessão estiver conectada, encerra o socket e remove **só** `baileys-<id>`.

### `flushSessions(deleteOnlyInactive)`

- `terminateInactive` remove sessões não conectadas e pastas `baileys-*` órfãs que nunca parearam.
- Preserva a credencial de sessão pareada que está reconectando (`STARTING`/`OPENING`) e a de pasta pareada sem sessão em memória.
- `terminateAll` remove tudo.

### `restoreSessions()`

No boot, sobe as pastas `baileys-*` com `creds.json` registrado. Pastas `session-*` só geram um aviso.

## Reconexão

| Motivo do fechamento | Ação |
|---|---|
| `restartRequired` (515, logo após ler o QR) | reconecta na hora, sem webhook de queda |
| `loggedOut` (401) | webhook `disconnected` `LOGOUT`, remove a sessão do `Map` e apaga `baileys-<id>` (credencial revogada) |
| `connectionReplaced` (440) | webhook `disconnected` `CONFLICT`; o próximo `start` recria |
| `forbidden` (403) / `multideviceMismatch` (411) | `auth_failure` + `disconnected` |
| demais (queda de rede, timeout, 503) | backoff de 1s a 30s. Se já estava pareada: `change_state OPENING` e, depois de 3 falhas seguidas, um `disconnected` `CONNECTION_LOST` |

## Rotas sem equivalente no Baileys

Respondem `501` com `{ success: false, error: 'not_supported_by_baileys', message: 'not_supported_by_baileys' }`:

- screenshot de página, `openChatWindow*`
- `runMethod` (continua bloqueado)
- etiquetas e canais
- `getCommonGroups`, `getCountryCode`, `getFormattedNumber`, `getContactDeviceCount`
- `setAutoDownload*`, `resetState`, `setBackgroundSync`
- `message.getInfo`, `getOrder`, `getPayment`, `getReactions`, `getPollVotes`

O mapeamento acontece em `utils.sendErrorResponse`: a message `not_supported_by_baileys` vira status 501.

## Graceful Shutdown (server.js)

`SIGTERM`/`SIGINT`, enviados pelo PM2 no restart, chamam `destroyAllSessions()`. Ele encerra cada socket sem logout e grava o store. A limpeza de Chrome órfão no boot (`browserOrphans.js`) continua ativa só para processos deixados pela versão antiga.

## Histórico de Modificações Recentes

- Troca do motor whatsapp-web.js/Chrome por Baileys, start 202 sem `pupPage`, QR novo obrigatório e rotas 501: `../2026/11/semana-48/24112026_implementacao_baileys.md`
- Para detalhes sobre a correção de sessões Chrome infinitas e graceful shutdown, veja: `../23022026_fix_sessoes_chrome_infinitas.md`
