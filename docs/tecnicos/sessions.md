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

## Sincronização de histórico

- **Padrão: histórico sob demanda.** Todo socket sobe com `syncFullHistory: false`, antes e depois do pareamento, e com o perfil de cliente web `Browsers.macOS('Chrome')`, que é o padrão da doc do Baileys (socket-config) e anuncia `webSubPlatform` WEB_BROWSER.
- `shouldSyncHistoryMessage: () => true`: INITIAL_BOOTSTRAP, RECENT, ON_DEMAND e demais tipos são processados e trazem também o mapa LID → telefone.
- O histórico completo só liga com `BAILEYS_SYNC_FULL_HISTORY=true` explícito (ou `setBackgroundSync(true)`) **e** sessão já pareada (`client.socketSyncFullHistory()`). O perfil `Browsers.macOS('Desktop')` só volta com a env explícita em `true`.
- **Por que não é mais o padrão:** com `syncFullHistory: true` + `Desktop`, o Baileys se anuncia como app nativo (`webSubPlatform` DARWIN/WIN32).
  - Em 25/11, a primeira conexão caía com 428 antes do QR.
  - Depois, já com a primeira conexão sem histórico completo, o QR era lido e o 515 chegava, mas a **reconexão pós-QR** subia pareada com `syncFullHistory: true` + Desktop. O WhatsApp fechava com 428 "Connection Terminated" em loop e a sessão nunca chegava a `ready`.
- **Restart pós-QR (515):** reconecta na hora, sem contar como queda e sem ligar o histórico completo. É reconhecido por:
  - `statusCode` 515
  - `attrs.code` 515 no `stream:error` (`err.data`)
  - mensagem "restart required"
  - 428 que chega logo depois do `creds.update` com `me` (QR lido) e antes do primeiro `open`
- No QR, o Baileys preenche `creds.me`; `creds.registered` só vira `true` no código de pareamento. Por isso `isRegistered()` considera os dois.
- `messaging-history.set` entra numa fila assíncrona por sessão (blocos de 200 com `setImmediate`) e grava no store do `fetchMessages`, com upsert por id.
- Webhook só para id novo e só até `BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS` (900 s), porque o ingest trata webhook como ao vivo (chatbot e notificação). O histórico antigo chega ao CRM pelo `fetchMessages`.
- `POST /chat/syncHistory` e `POST /client/syncHistory` (`controllers/historySync.js`) chamam `fetchMessageHistory(count|50, chave da mais antiga, messageTimestamp)` e esperam a resposta ON_DEMAND por até 15 s. As respostas possíveis:
  - sucesso: `{ success, syncType, progress, isLatest }`
  - sem mensagem guardada: `history_sync_waiting_initial`
  - desconectado: 422 `history_sync_not_connected`
- `POST /client/setBackgroundSync/:sessionId { flag }` **existe e não é 501**. Ele só liga (`true`) ou desliga (`false`) o `syncFullHistory` das próximas conexões da sessão pareada, sem apagar o store. O padrão é desligado. Ligado por esta rota, o perfil continua Chrome (Desktop só com a env). O pedido automático de histórico antigo a partir do `fetchMessages` também segue esta flag; o `syncHistory` explícito do CRM funciona sempre.

## Reconexão

O log de queda (`Conexão Baileys fechada; reconectando` ou `Conexão Baileys encerrada sem reconexão`) traz `code`, a `reason` (message do Boom/erro, sem credencial e sem QR) e o `syncFullHistory` do socket que caiu.


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
- `setAutoDownload*`, `resetState`
- `message.getInfo`, `getOrder`, `getPayment`, `getReactions`, `getPollVotes`

O mapeamento acontece em `utils.sendErrorResponse`: a message `not_supported_by_baileys` vira status 501.

## Graceful Shutdown (server.js)

`SIGTERM`/`SIGINT`, enviados pelo PM2 no restart, chamam `destroyAllSessions()`. Ele encerra cada socket sem logout e grava o store. A limpeza de Chrome órfão no boot (`browserOrphans.js`) continua ativa só para processos deixados pela versão antiga.

## Histórico de Modificações Recentes

- Conexão não completava depois do QR (428 em loop na reconexão pós-515 com `syncFullHistory` + Desktop). O padrão passou a ser histórico sob demanda: `syncFullHistory` false, perfil `macOS('Chrome')` e restart 515 robusto. Ver `../2026/11/semana-48/24112026_implementacao_baileys.md` (seção "Correção 2")
- QR não saía em produção (428 antes do QR): primeira conexão sem `syncFullHistory`, `setBackgroundSync` fora da lista 501 e `reason` no log de queda. Ver `../2026/11/semana-48/24112026_implementacao_baileys.md` (seção "Correção 25/11")
- Sincronização de histórico completa (messaging-history.set) e syncHistory sob demanda: `../2026/11/semana-48/24112026_implementacao_baileys.md` (seção "Complemento")
- Troca do motor whatsapp-web.js/Chrome por Baileys, start 202 sem `pupPage`, QR novo obrigatório e rotas 501: `../2026/11/semana-48/24112026_implementacao_baileys.md`
- Para detalhes sobre a correção de sessões Chrome infinitas e graceful shutdown, veja: `../23022026_fix_sessoes_chrome_infinitas.md`
