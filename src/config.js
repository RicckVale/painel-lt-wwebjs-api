// Load environment variables from .env file
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: process.env.ENV_PATH || '.env' })

// setup global const
const servicePort = process.env.PORT || 3000
const sessionFolderPath = process.env.SESSIONS_PATH || './sessions'
const resolvedSessionsPath = path.resolve(sessionFolderPath)
const enableLocalCallbackExample = (process.env.ENABLE_LOCAL_CALLBACK_EXAMPLE || '').toLowerCase() === 'true'
const globalApiKey = process.env.API_KEY
const baseWebhookURL = process.env.BASE_WEBHOOK_URL
const maxAttachmentSize = parseInt(process.env.MAX_ATTACHMENT_SIZE) || 10000000
const setMessagesAsSeen = (process.env.SET_MESSAGES_AS_SEEN || '').toLowerCase() === 'true'
const disabledCallbacks = process.env.DISABLED_CALLBACKS ? process.env.DISABLED_CALLBACKS.split('|') : []
const enableSwaggerEndpoint = (process.env.ENABLE_SWAGGER_ENDPOINT || '').toLowerCase() === 'true'
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 1000
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 1000
const logLevel = process.env.LOG_LEVEL || 'info'
const enableWebHook = process.env.ENABLE_WEBHOOK ? (process.env.ENABLE_WEBHOOK).toLowerCase() === 'true' : true
const enableWebSocket = process.env.ENABLE_WEBSOCKET ? (process.env.ENABLE_WEBSOCKET).toLowerCase() === 'true' : false
const autoStartSessions = process.env.AUTO_START_SESSIONS ? (process.env.AUTO_START_SESSIONS).toLowerCase() === 'true' : true
const basePath = process.env.BASE_PATH || '/'
const trustProxy = process.env.TRUST_PROXY ? (process.env.TRUST_PROXY).toLowerCase() === 'true' : false
// Identifica processos Chrome lançados por esta API (flag + pasta user-data-dir); permitir override por instância/tenant no mesmo host
const rawWwebjsBrowserMarker = (process.env.WWEBJS_BROWSER_MARKER || '').trim()
const wwebjsBrowserMarker = /^[a-zA-Z0-9_-]{4,128}$/.test(rawWwebjsBrowserMarker)
  ? rawWwebjsBrowserMarker
  : crypto.createHash('sha256').update(resolvedSessionsPath).digest('hex').slice(0, 24)
// Baileys: nível de log do socket (warn por padrão; debug/trace é muito verboso)
const baileysLogLevel = process.env.BAILEYS_LOG_LEVEL || 'warn'
// Baileys: buscar a versão mais recente do WhatsApp Web ao conectar (padrão true; false usa a versão embutida no pacote)
const baileysFetchLatestVersion = (process.env.BAILEYS_FETCH_LATEST_VERSION || 'true').toLowerCase() === 'true'
// Baileys: histórico completo no pareamento (padrão true, nível mais completo da doc advanced/history-sync)
const baileysSyncFullHistory = (process.env.BAILEYS_SYNC_FULL_HISTORY || 'true').toLowerCase() === 'true'
// Mensagem nova vinda do histórico só vira webhook se tiver até N segundos (padrão 900; 0 = nunca; -1 = sem limite).
// O ingest trata webhook "message" como ao vivo (chatbot/notificação); o resto chega ao CRM pelo fetchMessages.
const baileysHistoryWebhookMaxAgeSeconds = parseInt(process.env.BAILEYS_HISTORY_WEBHOOK_MAX_AGE_SECONDS ?? '900', 10)
// Quanto POST /chat/syncHistory espera a resposta ON_DEMAND do celular (padrão 15s, abaixo do timeout HTTP do CRM)
const baileysHistoryOnDemandTimeoutMs = Math.max(0, parseInt(process.env.BAILEYS_HISTORY_ON_DEMAND_TIMEOUT_MS || '15000', 10))
// Mensagens por chat no store: em memória e persistidas em floume-store.json
const baileysStoreMaxMessagesPerChat = Math.max(50, parseInt(process.env.BAILEYS_STORE_MAX_MESSAGES_PER_CHAT || '500', 10))
const baileysStorePersistMessagesPerChat = Math.max(20, parseInt(process.env.BAILEYS_STORE_PERSIST_MESSAGES_PER_CHAT || '200', 10))
// Mantido só para a limpeza de Chrome órfão deixado pela versão antiga (whatsapp-web.js)
const cleanupOrphanBrowsersOnStartup = (process.env.CLEANUP_ORPHAN_BROWSERS_ON_STARTUP || 'true').toLowerCase() === 'true'

module.exports = {
  servicePort,
  sessionFolderPath,
  resolvedSessionsPath,
  enableLocalCallbackExample,
  globalApiKey,
  baseWebhookURL,
  maxAttachmentSize,
  setMessagesAsSeen,
  disabledCallbacks,
  enableSwaggerEndpoint,
  rateLimitMax,
  rateLimitWindowMs,
  logLevel,
  enableWebHook,
  enableWebSocket,
  autoStartSessions,
  basePath,
  trustProxy,
  wwebjsBrowserMarker,
  cleanupOrphanBrowsersOnStartup,
  baileysLogLevel,
  baileysFetchLatestVersion,
  baileysSyncFullHistory,
  baileysHistoryWebhookMaxAgeSeconds,
  baileysHistoryOnDemandTimeoutMs,
  baileysStoreMaxMessagesPerChat,
  baileysStorePersistMessagesPerChat
}
