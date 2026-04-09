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
const webVersion = process.env.WEB_VERSION
const webVersionCacheType = process.env.WEB_VERSION_CACHE_TYPE || 'none'
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 1000
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 1000
const recoverSessions = (process.env.RECOVER_SESSIONS || '').toLowerCase() === 'true'
const chromeBin = process.env.CHROME_BIN || null
const headless = process.env.HEADLESS ? (process.env.HEADLESS).toLowerCase() === 'true' : true
const releaseBrowserLock = process.env.RELEASE_BROWSER_LOCK ? (process.env.RELEASE_BROWSER_LOCK).toLowerCase() === 'true' : true
const logLevel = process.env.LOG_LEVEL || 'info'
const enableWebHook = process.env.ENABLE_WEBHOOK ? (process.env.ENABLE_WEBHOOK).toLowerCase() === 'true' : true
const enableWebSocket = process.env.ENABLE_WEBSOCKET ? (process.env.ENABLE_WEBSOCKET).toLowerCase() === 'true' : false
const autoStartSessions = process.env.AUTO_START_SESSIONS ? (process.env.AUTO_START_SESSIONS).toLowerCase() === 'true' : true
const basePath = process.env.BASE_PATH || '/'
const trustProxy = process.env.TRUST_PROXY ? (process.env.TRUST_PROXY).toLowerCase() === 'true' : false
// Retentativas ao inicializar o Client (WhatsApp Web pode navegar durante inject e destruir o execution context)
const clientInitializeMaxRetries = Math.max(1, parseInt(process.env.CLIENT_INITIALIZE_MAX_RETRIES || '5', 10))
const clientInitializeRetryBaseMs = Math.max(200, parseInt(process.env.CLIENT_INITIALIZE_RETRY_BASE_MS || '1500', 10))
const puppeteerProtocolTimeoutMs = Math.max(0, parseInt(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || '300000', 10))
// Padrão true: após esgotar retentativas, apaga session-<id> e tenta initialize uma vez do zero (novo QR se necessário). Defina false para desativar
const wipeSessionDataAfterInitFailure = (process.env.WIPE_SESSION_DATA_AFTER_INIT_FAILURE || 'true').toLowerCase() === 'true'
// Identifica processos Chrome lançados por esta API (flag + pasta user-data-dir); permitir override por instância/tenant no mesmo host
const rawWwebjsBrowserMarker = (process.env.WWEBJS_BROWSER_MARKER || '').trim()
const wwebjsBrowserMarker = /^[a-zA-Z0-9_-]{4,128}$/.test(rawWwebjsBrowserMarker)
  ? rawWwebjsBrowserMarker
  : crypto.createHash('sha256').update(resolvedSessionsPath).digest('hex').slice(0, 24)
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
  webVersion,
  webVersionCacheType,
  rateLimitMax,
  rateLimitWindowMs,
  recoverSessions,
  chromeBin,
  headless,
  releaseBrowserLock,
  logLevel,
  enableWebHook,
  enableWebSocket,
  autoStartSessions,
  basePath,
  trustProxy,
  clientInitializeMaxRetries,
  clientInitializeRetryBaseMs,
  puppeteerProtocolTimeoutMs,
  wipeSessionDataAfterInitFailure,
  wwebjsBrowserMarker,
  cleanupOrphanBrowsersOnStartup
}
