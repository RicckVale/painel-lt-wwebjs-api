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
// Baileys: pedir histórico completo no pareamento (padrão false = só o histórico recente)
const baileysSyncFullHistory = (process.env.BAILEYS_SYNC_FULL_HISTORY || 'false').toLowerCase() === 'true'
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
  baileysSyncFullHistory
}
