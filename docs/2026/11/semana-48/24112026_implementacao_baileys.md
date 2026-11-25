# Implementação: motor da API não oficial trocado de whatsapp-web.js para Baileys

**Data:** 24/11/2026  
**Tipo:** implementação  
**Módulo:** sessões (`src/sessions.js`, `src/baileys/*`, `src/controllers/*`)  
**Impacto:** alto. Toda conexão WhatsApp não oficial do Floume passa a usar Baileys. As sessões antigas precisam de QR novo.

## Problema

A instância `henrique-zap` (badge "Não oficial") ficava em "Desconectado" com o spinner "Aguardando QR…" para sempre.

A causa estava no `sessionController.startSession`: ele esperava `waitForNestedObject(client, 'pupPage')` antes de responder. Quando o Chrome/Puppeteer não subia, isso travava a resposta. O evento `qr` do whatsapp-web.js também nunca disparava, então `sessions.get(id).qr` ficava vazio e `GET /session/qr/:id` não devolvia código.

O dono decidiu tirar o Chrome do caminho e migrar o motor para `@whiskeysockets/baileys`, mantendo as rotas que o CRM já chama.

## O que mudou

### Dependência

- `@whiskeysockets/baileys` pinado em `7.0.0-rc14`, versão exata. É a dist-tag `latest`, com suporte a LID; a linha 6.7.x é a `legacy` e puxa `libsignal` direto do Git.
- Instalado com `npm install --ignore-scripts`. Nenhum pacote da árvore precisa de script de instalação para funcionar:
  - `whatsapp-rust-bridge` é wasm já compilado.
  - `libsignal` 6 é JS puro.
  - `sharp` usa os binários de `@img/*`.
- `whatsapp-web.js` removido, junto com o override `@puppeteer/browsers`. Puppeteer saiu da árvore.
- O `package.json` continua sem `postinstall`.
- Baileys é ESM e é carregado com `import()` dinâmico em `src/baileys/loader.js`. O projeto continua CommonJS.

### Camada `src/baileys/`

| Arquivo | Papel |
| --- | --- |
| `loader.js` | `import('@whiskeysockets/baileys')` com cache. Os testes trocam este módulo por um mock. |
| `jid.js` | Converte `@c.us` ↔ `@s.whatsapp.net` e mantém `@g.us` e `@lid`. Remove o sufixo de device. Monta `{ server, user, _serialized }`. |
| `store.js` | Store por sessão com chats, contatos, mensagens recentes (200 por chat em memória, 50 persistidas) e o mapa LID → telefone. É gravado em `floume-store.json` dentro da pasta da sessão. |
| `serialize.js` | Converte mensagem, chat e contato do Baileys para o JSON do whatsapp-web.js que o `wwebjs-ingest` já parseia. |
| `client.js` | `BaileysClient`, com os mesmos métodos do `Client` do whatsapp-web.js, e as fachadas `Chat`, `Message` e `Contact`. Os controllers mudaram pouco. |
| `structures.js` | `MessageMedia` (inclusive `fromUrl`), `Location`, `Poll` e `NotSupportedError`. |

### Sessão

- `setupSession` cria o `BaileysClient`, registra no `Map sessions` na hora e chama `initialize()` em segundo plano.
- `initialize()` executa `useMultiFileAuthState` e depois `makeWASocket`.
- A credencial fica em `<SESSIONS_PATH>/baileys-<sessionId>/`. A pasta antiga `session-<sessionId>` (perfil do Chrome/LocalAuth) não é lida nem apagada.
- O evento `connection.update` com `qr` grava `client.qr`, que é o mesmo campo lido por `GET /session/qr/:id`, e dispara o webhook `qr`.
- `GET /session/start/:id` responde sem esperar navegador nem QR:

  | Situação | Status | Corpo |
  | --- | --- | --- |
  | sessão nova | `202` | `{ success: true, message: 'session_initialization_started' }` |
  | já existe e está subindo ou aguardando QR | `202` | `{ success: true, message: 'session_initialization_in_progress' }` |
  | já existe e está conectada | `200` | `{ success: true, message: 'session_already_connected' }` |
  | falha ao criar | `422` | igual a antes |

- Sessão em estado terminal (logout pelo celular, conflito, `forbidden`) é descartada no próximo `start` e recriada.
- Reconexão automática com backoff (1s a 30s):
  - `restartRequired` (515, logo após ler o QR) reconecta na hora.
  - Queda de uma sessão já pareada vira `change_state OPENING`. Depois de 3 falhas seguidas sai **um** webhook `disconnected` (`CONNECTION_LOST`).
  - `loggedOut` (401) dispara `disconnected` `LOGOUT` e apaga só a pasta `baileys-<id>`, já que a credencial foi revogada pelo celular. O próximo start gera QR novo.
- `status`, `stop`, `restart`, `terminate`, `terminateInactive` e `terminateAll` mantêm os JSON de antes.
  - `stop` encerra o socket e mantém a credencial.
  - `terminate` faz logout e remove `baileys-<id>`.
  - `terminateInactive` não apaga a credencial de sessão pareada que só está reconectando, nem a de pasta pareada sem sessão em memória.
- `requestPairingCode` exige `phoneNumber` no corpo (sem ele, `400 phoneNumber is required`). Usa `sock.requestPairingCode` e devolve `{ success: true, result, pairingCode }`; o adapter do Floume lê `pairingCode`.

### Webhooks (mesmos nomes e campos)

- `qr` (`{ qr }`), `authenticated`, `ready`, `disconnected` (`{ reason }`), `auth_failure`, `change_state`.
- `message` (só recebidas) e `message_create` (todas). Mensagem enviada pela API sai uma vez em `message_create` quando o Baileys a ecoa.
- `message_ack`: o status do Baileys (0 a 5) é convertido para a escala do whatsapp-web.js (-1 a 4).
- `media` (`{ messageMedia, message }`) para mídia recebida abaixo de `MAX_ATTACHMENT_SIZE`.
- `message_reaction` (`reaction.msgId`, `senderId`, `reaction`), `message_revoke_everyone` (com `_data.protocolMessageKey`), `message_edit`.
- `chat_archived` e `unread_count` com `id`, `chatId`, `archived` e `unreadCount` no topo, que é onde o ingest lê.
- A mensagem serializada traz:
  - `_data.id { fromMe, remote, id, _serialized }`, `_data.t`, `_data.notifyName`, `_data.type`, `_data.body`, `from`, `to`, `author` (grupo), `hasMedia`, `ack`
  - `message`: o conteúdo Baileys sem campos binários. O ingest e o cache usam esse campo para tipo e para a duração do áudio.
- Diferença intencional: em mídia, `_data.body` leva a **legenda**. O whatsapp-web.js punha ali a miniatura base64, que o ingest descartava.
- LID: quando o Baileys traz o telefone (`remoteJidAlt`, `lid-mapping.update`, histórico ou contatos), o chat e o `from` saem como `@c.us`. Sem telefone conhecido, saem como `@lid`.

### Rotas

Implementadas de verdade no Baileys:

| Grupo | Rotas |
| --- | --- |
| Envio | `sendMessage` (texto, `MessageMedia`, `MessageMediaFromURL`, `Location`, `Poll`, `Contact`; opções `sendAudioAsVoice`, `sendVideoAsGif`, `sendMediaAsSticker`, `sendMediaAsDocument`, `quotedMessageId`, `mentions`) |
| Leitura | `getChats`, `getChatById`, `fetchMessages`, `searchMessages` |
| Estado do chat | `sendSeen`, `sendStateTyping`, `sendStateRecording`, `clearState`, `archive`/`unarchive`, `mute`/`unmute`, `pin`/`unpin`, `markUnread`, `delete`, `clearMessages` |
| Contatos | `getNumberId`, `isRegisteredUser`, `getProfilePicUrl`, `getContacts`, `getContactById`, `getContactLidAndPhone`, `getBlockedContacts`, block/unblock, `getAbout` |
| Perfil e presença | `setStatus`, `setDisplayName`, foto de perfil, presença |
| Mensagem | `downloadMedia`, `downloadMediaAsData`, `reply`, `react`, `delete`, `forward`, `edit`, `star`/`unstar`, `getQuotedMessage`, `getContact`, `getMentions` |
| Grupo | participantes, convite, assunto, descrição, configurações, foto, pedidos de entrada, `leave`, `createGroup`, `acceptInvite`, `getInviteInfo` |
| Sessão e histórico | `getClassInfo`, `getState`, `getWWebVersion`, `syncHistory` (via `fetchMessageHistory`) |

Respondem `501 { success: false, error: 'not_supported_by_baileys', message: 'not_supported_by_baileys' }`, sem derrubar o processo:

- `getPageScreenshot`, `openChatWindow`, `openChatWindowAt`
- `runMethod` de client, chat, groupChat e message. Continua bloqueado.
- etiquetas: `getLabels`, `getChatLabels`, `changeLabels`, `addOrRemoveLabels`, `getChatsByLabelId`, `getLabelById`
- canais (`@newsletter`)
- `getCommonGroups`, `getCountryCode`, `getFormattedNumber` (client), `getContactDeviceCount`
- `setAutoDownload*`, `resetState`, `setBackgroundSync`
- `message.getInfo`, `getOrder`, `getPayment`, `getReactions`, `getPollVotes`

A API Nest (`api/src/wwebjs/*`) **não mudou**.

### Config

Novas variáveis (opcionais):

- `BAILEYS_LOG_LEVEL` (padrão `warn`)
- `BAILEYS_FETCH_LATEST_VERSION` (padrão `true`)
- `BAILEYS_SYNC_FULL_HISTORY` (padrão `false`)

Saíram as variáveis do Chrome/Puppeteer: `CHROME_BIN`, `HEADLESS`, `WEB_VERSION*`, `RECOVER_SESSIONS`, `RELEASE_BROWSER_LOCK`, `CLIENT_INITIALIZE_*`, `PUPPETEER_PROTOCOL_TIMEOUT_MS` e `WIPE_SESSION_DATA_AFTER_INIT_FAILURE`.

A limpeza de Chrome órfão no boot (`browserOrphans.js`) ficou como estava. Ela só encerra Chrome deixado pela versão antiga e não depende de Chrome instalado.

## QR novo obrigatório

A sessão do Chrome (`LocalAuth`, pasta `session-<id>`) **não é compatível** com `useMultiFileAuthState`. Depois do deploy, toda instância não oficial conectada precisa ler o QR de novo, ou usar o código de pareamento.

No boot, o processo registra um aviso com a quantidade de pastas `session-*` ignoradas. Essas pastas não são apagadas.

## Como conferir

1. Testes, sem rede e sem WhatsApp real: `npm test` (Jest `--runInBand`) → 33 testes verdes. `tests/baileys.test.js` mocka o socket e prova:
   - start `202 session_initialization_started`
   - QR em `GET /session/qr/:id` e no webhook `qr`
   - envio chama `sock.sendMessage`
   - formato do webhook `message`, ack, LID, grupo e mídia
   - typing, sendSeen, archive/mute/pin, `getNumberId`
   - rotas 501, terminate e stop
   - pairing (400 sem telefone)
2. Fumaça real feita no desenvolvimento: `BaileysClient` com pasta temporária gerou QR do WhatsApp em cerca de 1,4 s, sem Chrome. Depois foi encerrado e a pasta apagada.
3. Em produção, depois do deploy (`npm install --ignore-scripts` e `pm2 restart crm-wwebjs-api`, feitos pelo maestro):

   ```bash
   curl -H "x-api-key: $API_KEY" https://crmwwebjs.opsyn.com.br/session/start/<instanceId>
   # → 202 {"success":true,"message":"session_initialization_started"}
   curl -H "x-api-key: $API_KEY" https://crmwwebjs.opsyn.com.br/session/qr/<instanceId>
   # → {"success":true,"qr":"..."} em poucos segundos
   ```

   No CRM, abrir a instância não oficial e conferir que o QR aparece no lugar do spinner. Ler com o celular e conferir:
   - o status muda para conectado (webhooks `authenticated` e `ready`)
   - mensagem recebida entra no inbox
   - envio pelo CRM chega no celular

## Pendências conhecidas

- Etiquetas (labels do WhatsApp Business) e canais ainda respondem 501.
- `fetchMessages` lê o store local: mensagens recebidas desde o pareamento, mais o histórico recente que o WhatsApp manda no pareamento. Pedido acima do que existe no store dispara `fetchMessageHistory` em segundo plano, no máximo uma vez a cada 10 min por chat. O resultado aparece numa próxima chamada.
- `getChats` só conhece chats vistos desde o pareamento ou vindos do histórico. O store persiste em `floume-store.json` para sobreviver a restart.
