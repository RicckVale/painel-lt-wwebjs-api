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
- `setAutoDownload*`, `resetState`. O `setBackgroundSync` passou a ser implementado no complemento de histórico; não é 501.
- `message.getInfo`, `getOrder`, `getPayment`, `getReactions`, `getPollVotes`

A API Nest (`api/src/wwebjs/*`) **não mudou**.

### Config

Novas variáveis (opcionais):

- `BAILEYS_LOG_LEVEL` (padrão `warn`)
- `BAILEYS_FETCH_LATEST_VERSION` (padrão `true`)
- `BAILEYS_SYNC_FULL_HISTORY` (padrão `true` desde o complemento de histórico abaixo)

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
- `fetchMessages` lê o store local: o histórico que o celular manda (completo, ver abaixo) mais o que chegou ao vivo. Fica limitado a `BAILEYS_STORE_MAX_MESSAGES_PER_CHAT` mensagens por chat em memória e `BAILEYS_STORE_PERSIST_MESSAGES_PER_CHAT` no `floume-store.json`. Pedido acima do que existe no store dispara `fetchMessageHistory` em segundo plano, no máximo uma vez a cada 10 min por chat.
- Unidade do timestamp no `fetchMessageHistory`: passamos o `messageTimestamp` em segundos, como no exemplo do Baileys e no pedido. O campo do protocolo se chama `oldestMsgTimestampMs`. Se em produção o celular não devolver nada, essa é a primeira coisa a conferir.

## Complemento (25/11/2026): sincronização de histórico

Referência: https://baileys.wiki/pt-BR/advanced/history-sync. A versão em inglês detalha mais. O nível mais completo da página é:

- `browser: Browsers.macOS('Desktop')`, porque o perfil Chrome padrão limita o histórico que o WhatsApp devolve no pareamento
- `syncFullHistory: true`
- guardar as mensagens (também usadas pelo `getMessage`)
- paginar com `sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`

### Socket

- `syncFullHistory: true`, que fica `false` se `BAILEYS_SYNC_FULL_HISTORY=false`, depois de `setBackgroundSync` com flag `false` e, desde a correção abaixo, na primeira conexão sem pareamento.
- `shouldSyncHistoryMessage: () => true`. Nenhum tipo é descartado: INITIAL_BOOTSTRAP, INITIAL_STATUS_V3, FULL, RECENT, PUSH_NAME, NON_BLOCKING_DATA e ON_DEMAND.
- `browser: Browsers.macOS('Desktop')`. No celular, o aparelho vinculado aparece como Mac/Desktop.
- Também é escutado `messaging-history.status` (complete/paused por tipo). O estado fica em `client.getHistorySyncState()`.

### `messaging-history.set`

- O handler do socket só enfileira e devolve na hora. Uma fila por sessão (`historyQueue`) processa em blocos de 200 com `setImmediate` entre eles, para não travar o event loop.
- Grava `lidPnMappings`, contatos, chats e mensagens no mesmo store que `fetchMessages`, `getChats` e `downloadMedia` leem, com upsert por id. Payload repetido não duplica.
- Guarda `syncType` (nome), `progress` e `isLatest` do último bloco recebido.
- Webhook (`message` para recebida, `message_create` para enviada) **só para id novo** e só se a mensagem tiver até `BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS`. O padrão é 900 s; `0` desliga e `-1` tira o limite. A URL continua vindo só do ambiente.
- **Por que a janela de idade:** o `wwebjs-ingest` trata todo webhook `message` como mensagem ao vivo (`historical: false`). Isso aciona chatbot, notificação em tempo real e lead scoring. Mandar o histórico inteiro por webhook faria o bot responder conversas de meses atrás.
- O histórico antigo chega ao CRM pelo caminho que já existe: `syncHistoryForChat` → `syncMessagesForChat` → `fetchMessages`.
- O formato do id não muda: `@c.us` quando o telefone é conhecido, `@lid` quando não é, e `@g.us` para grupo. A conversão para JID do Baileys acontece na borda.

### `POST /chat/syncHistory/:sessionId` e `POST /client/syncHistory/:sessionId`

As duas rotas seguem o mesmo caminho (`src/controllers/historySync.js`). Saiu o `sessionValidation` dessas rotas, para o controller poder responder 422 em vez de 404 quando a sessão está desconectada.

- **Body:** `{ chatId, count? }`. `count` vale se for número positivo; senão 50.
- **Chave:** a mensagem mais antiga já guardada do chat, `{ remoteJid (JID original do Baileys), id, fromMe }`, e o `messageTimestamp` dela.
- **Respostas:**

  | Situação | Status | Corpo |
  | --- | --- | --- |
  | sem mensagem guardada | `200` | `{ success: true, message: 'history_sync_waiting_initial' }` |
  | socket desconectado | `422` | `{ success: false, error: 'history_sync_not_connected', message: 'history_sync_not_connected' }` |
  | sessão inexistente | `404` | `session_not_found` |
  | resposta chegou | `200` | `{ success: true, syncType: 'ON_DEMAND', progress, isLatest, received, requestId, count }` |
  | celular não respondeu no prazo | `200` | `{ ..., pending: true }` |

- **Espera:** o controller aguarda o `messaging-history.set` com `syncType` ON_DEMAND (casado por `peerDataRequestSessionId` ou pelo chat) até `BAILEYS_HISTORY_ON_DEMAND_TIMEOUT_MS` (15 s, abaixo dos 30 s do HTTP do CRM). Assim, o `fetchMessages` que o CRM chama em seguida já enxerga as mensagens.
- **Sem resposta no prazo:** o pedido foi aceito e a resposta, quando chegar, vai para o store.
- O contrato do CRM não mudou: qualquer 2xx é sucesso, e o adapter tenta `/client` se `/chat` falhar.

### `setBackgroundSync`

`POST /client/setBackgroundSync/:sessionId { flag }`:

- `true` mantém o `syncFullHistory`.
- `false` desliga a partir da próxima conexão e o pedido automático de histórico antigo, sem apagar nada do store.

### Novas variáveis

- `BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS` (900)
- `BAILEYS_HISTORY_ON_DEMAND_TIMEOUT_MS` (15000)
- `BAILEYS_STORE_MAX_MESSAGES_PER_CHAT` (500)
- `BAILEYS_STORE_PERSIST_MESSAGES_PER_CHAT` (200)

### Como conferir

1. `npm test` → 42 testes verdes. O bloco "Sincronização de histórico" prova:
   - opções do socket (syncFullHistory, shouldSyncHistoryMessage, perfil macOS)
   - 2 mensagens + 1 repetida → 2 no `fetchMessages` e um webhook por id
   - mensagem velha fica no store sem webhook
   - `@lid` preservado
   - `/chat/syncHistory` chama `fetchMessageHistory(30, chave mais antiga, timestamp)` e devolve `syncType`/`progress`/`isLatest`
   - `/client/syncHistory` com `count` inválido usa 50
   - 422 quando desconectado e `history_sync_waiting_initial` sem mensagem
   - `setBackgroundSync`
2. Em produção, depois de ler o QR, os logs devem mostrar o histórico chegando. Testar com:

   ```bash
   curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
     -d '{"chatId":"55DDDNUMERO@c.us","count":50}' https://crmwwebjs.opsyn.com.br/chat/syncHistory/<instanceId>
   ```

   A resposta esperada é `{ success: true, syncType: 'ON_DEMAND', progress, isLatest }`. Em seguida, `fetchMessages` do mesmo chat deve trazer as mensagens mais antigas.

## Correção (25/11/2026): QR não saía em produção

### Sintoma

Em produção (commit 8f665ee), na sessão `f28787ad-…`:

- `GET /session/start` respondeu `session_initialization_started`.
- Cerca de 1 s depois o socket fechou com code 428 e entrou em reconexão; o estado ficou em `STARTING`.
- `GET /session/qr` respondeu `qr code not ready or already scanned`.

### Causa

Reproduzida com o Baileys real, credencial nova e pasta temporária no mesmo host:

| Socket da primeira conexão | Resultado |
| --- | --- |
| `syncFullHistory: true` + `Windows/Desktop` | 428 "Connection Terminated" antes do QR, em 3 de 3 tentativas |
| `syncFullHistory: true` + `Mac OS/Desktop` | 428 em 2 tentativas seguidas; depois passou em outras |
| `Ubuntu/Chrome`, `Mac OS/Chrome`, `Ubuntu/Desktop` | QR em cerca de 1,5 s |
| `syncFullHistory: false` + `Mac OS/Desktop` | QR em 4 de 4 |

O mecanismo está em `Utils/validate-connection.js` do Baileys 7.0.0-rc14. Quando `syncFullHistory` é true e o browser é `Mac OS`/`Windows` + `Desktop`, o `webSubPlatform` do ClientPayload vira DARWIN/WIN32: o Baileys se anuncia como app nativo de desktop. Com credencial nova, o WhatsApp fecha a conexão (428) antes de mandar o `pair-device` com o QR.

### Ajuste

- Sem pareamento, o socket sobe com `syncFullHistory: false`. "Sem pareamento" quer dizer sem `creds.me`, sem `creds.registered` e sem conexão aberta antes. O login vai como `WEB_BROWSER` e o QR sai.
- Pareada, a partir da reconexão 515 logo depois de ler o QR: usa `BAILEYS_SYNC_FULL_HISTORY` (padrão `true`) ou o último `setBackgroundSync`.
- `shouldSyncHistoryMessage` continua `true` e o store não é apagado.
- `isRegistered()` passa a considerar `creds.me`. No pareamento por QR o Baileys não marca `creds.registered`; isso só acontece no código de pareamento.
- O log de queda inclui `reason`, a message do erro (ex.: `"Connection Terminated"`), além de `code` e do `syncFullHistory` do socket. Não leva credencial nem QR.
- Depois do ajuste, o mesmo teste real gerou QR também com `Windows/Desktop` (2 de 2) e `Mac OS/Desktop` (2 de 2).

### Efeito colateral

O Baileys só envia o pedido de histórico completo (`requireFullSync`) no registro do aparelho, que é a conexão do QR. Pareando com `false`, o celular manda o histórico padrão do pareamento, não o completo. O histórico mais antigo continua chegando pelo `syncHistory` sob demanda (`fetchMessageHistory`) por chat.

As reconexões da sessão pareada usam `syncFullHistory: true` com `Mac OS/Desktop`, ou seja, o login se anuncia como DARWIN. Se o 428 voltar a aparecer em sessão já pareada, o log agora mostra `reason` e `syncFullHistory`. Nesse caso, o próximo passo é trocar o browser para `Browsers.macOS('Chrome')`, que deu QR em todos os testes.

### Como conferir

1. `npm test` → 45 testes verdes. Os novos provam:
   - socket sem credencial pareada nasce com `syncFullHistory: false`
   - depois do QR, a reconexão 515 sobe com `true`
   - socket com credencial pareada nasce com `true`
   - o bloco de histórico completo continua valendo para a sessão pareada
2. Em produção, depois do deploy e do restart (feitos pelo maestro): `GET /session/start/<id>`, e em poucos segundos `GET /session/qr/<id>` deve responder `{ success: true, qr }`. O log não deve ter 428 antes do QR.

## Correção 2 (25/11/2026): conexão não completava depois do QR. Padrão passa a ser histórico sob demanda

### Sintoma

Produção no commit e7bd2fe, sessão `f28787ad-…`:

1. O QR saiu e foi lido.
2. Chegou o `stream:error` code 515 (restart pós-QR, normal).
3. Em seguida, loop de code 428 "Connection Terminated" com `syncFullHistory: true` e backoff de 1s a 30s, nas tentativas 1 a 9.
4. A sessão nunca chegou a `authenticated`/`ready`.

### Causa

A correção anterior desligava o histórico completo só **antes** do pareamento. Ao ler o QR, o Baileys grava `creds.me`, então `isRegistered()` passa a ser true. Por isso o socket da reconexão pós-515 já subia com `syncFullHistory: true` + `Browsers.macOS('Desktop')`.

Essa combinação faz o login se anunciar como app nativo (`webSubPlatform` DARWIN), e o WhatsApp fecha com 428. O 428 pós-QR vinha dessa reconexão com `syncFullHistory: true`, e não do 515 em si.

### Decisão do dono

Se o histórico avançado atrapalha a conexão, sai. O que precisa funcionar é o histórico sob demanda.

### Ajuste

- `BAILEYS_SYNC_FULL_HISTORY` passa a ter padrão `false` (`src/config.js`, `.env.example`). Todo socket sobe com `syncFullHistory: false`, antes e depois do pareamento.
  - Com a env explícita em `true` e sessão pareada, o histórico completo liga.
  - `setBackgroundSync(true)` também liga nas próximas conexões.
  - O store não é apagado.
- O perfil passa a ser `Browsers.macOS('Chrome')`, padrão de cliente web na página socket-config do Baileys, cujo exemplo de produção usa `macOS('Chrome')` com `syncFullHistory: false`. `Desktop` só volta com a env explícita em `true`.
- O restart 515 reconecta na hora, sem contar queda e sem ligar o histórico completo. É reconhecido por:
  - `statusCode` 515
  - `attrs.code` do `stream:error`
  - mensagem "restart required"
  - 428 logo após o `creds.update` com `me` e antes do primeiro `open`
- O histórico sob demanda continua igual:
  - `shouldSyncHistoryMessage: () => true` (INITIAL_BOOTSTRAP, RECENT, ON_DEMAND…)
  - `messaging-history.set` grava no store com upsert
  - `/chat/syncHistory` e `/client/syncHistory` chamam `fetchMessageHistory(count|50, chave da mais antiga, messageTimestamp)`
  - webhook só para id novo dentro de `BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS`
  - o CRM não mudou
- O pedido automático de histórico antigo, disparado pelo `fetchMessages`, segue a flag de background sync, que agora começa desligada. O `syncHistory` explícito do CRM funciona sempre.

### Como conferir

1. `npm test` → 48 testes verdes. Os novos provam que:
   - socket sem parear e socket pareado nascem com `syncFullHistory: false` e perfil Chrome com a env padrão
   - com a opção `true` e sessão pareada, o socket nasce com `true` e Desktop; com a opção `true` e sem parear, nasce com `false`
   - fechamento 515 (por `statusCode` ou só pelos attrs do `stream:error`) reconecta em menos de 500 ms, sem contar tentativa e com `syncFullHistory: false`
   - 428 logo após o pareamento também reconecta na hora
   - `setBackgroundSync(true)` liga o histórico completo para a próxima conexão
   - `POST /chat/syncHistory` segue chamando `fetchMessageHistory`
2. Teste real com o Baileys, credencial nova e pasta temporária: QR em cerca de 1,5 s com `syncFullHistory: false` e perfil Chrome, em 2 de 2 tentativas. Não dá para testar a leitura do QR aqui, porque precisa do celular.
3. Em produção, depois do deploy e do restart (feitos pelo maestro), confira que `BAILEYS_SYNC_FULL_HISTORY` **não** está em `true` no `.env`. Depois:
   - `GET /session/start/<id>` e em seguida `GET /session/qr/<id>`
   - ler o QR
   - o log deve mostrar `Restart pós-QR (515): reconectando na hora` com `syncFullHistory: false`, seguido de `authenticated`/`ready`, sem loop de 428

## Inbox ao conectar (25/11/2026)

### Problema

Com o histórico completo desligado, o inbox conectava e listava poucos previews. `fetchMessages` lia o store e pedia o histórico antigo sem esperar, então a API recebia lista vazia (HTTP 200) e tratava como erro.

### O que mudou

- `BaileysChat.fetchMessages` (`src/baileys/client.js`), quando o store tem menos mensagens que o `limit`, espera o `fetchMessageHistory` até `BAILEYS_HISTORY_ON_DEMAND_TIMEOUT_MS` e só então responde. Sem mensagem antiga para servir de chave, devolve o que já tem, sem 500. Não liga `syncFullHistory` e não volta o perfil Desktop.
- Quando `messaging-history.set` de `INITIAL_BOOTSTRAP`, `RECENT` ou `FULL` termina com `isLatest: true`, sai um único webhook `history_ready` com `{ syncType, isLatest: true, chats, messages }` (contagens daquele bloco). O disparo está em `src/sessions.js`. Mensagem antiga continua sem webhook `message`. A janela `BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS` segue só para a mensagem ao vivo.
- `getProfilePicUrl` aceita `@c.us`, `@s.whatsapp.net` e `@lid` (o JID do Baileys).

### API e banco

Nada de schema. Contrato novo: webhook `dataType: history_ready`. O CRM (repositório `api`) consome esse evento.

### Validação

`npx jest --runInBand tests/baileys.test.js` — 46 testes verdes, incluindo a espera do on-demand, o único `history_ready` e a foto mockada nos três formatos de id.

## Subida da conversa (25/11/2026)

### Problema

No grupo, só a mensagem mais nova aparecia. Ao subir, o celular não devolvia o que estava acima: a chave do `fetchMessageHistory` saía da primeira mensagem da lista, e a resposta ON_DEMAND de grupo às vezes chega com outro JID (`@s.whatsapp.net` ou `@lid`). O waiter de 15 s não casava e o CRM marcava a conversa como parada.

### O que mudou

- `BaileysClient.syncHistory` escolhe a mensagem de menor `messageTimestamp` daquele chat. A chave leva `remoteJid`, `id` e `fromMe`. Em grupo, inclui `participant` quando a mensagem tem.
- O waiter ON_DEMAND resolve o mesmo chat se o JID da resposta tiver o mesmo usuário (`@g.us`, `@lid` ou `@s.whatsapp.net`). A mensagem entra no store desse chat. Se chegar depois do timeout, a próxima subida já a encontra.
- `syncFullHistory` continua desligado. O pedido em segundo plano (`_requestOlderHistory`) segue sem rodar quando o histórico completo está desligado. O scroll usa o `POST /chat/syncHistory`.

### API e banco

Nada de schema. `syncHistory` pode responder `{ success: true, syncType: 'ON_DEMAND', pending: true }` quando o celular ainda não devolveu o bloco.

### Validação

`npx jest --runInBand tests/baileys.test.js` — 48 testes verdes. A lista da mais nova para a mais antiga pede a chave da mais antiga, com `participant`. O ON_DEMAND com JID equivalente de grupo entra no store, inclusive o que chega depois do timeout.
