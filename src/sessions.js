// Ciclo de vida das sessões WhatsApp sobre o Baileys (sem Chrome/Puppeteer).
// Cada sessão guarda as credenciais em <SESSIONS_PATH>/baileys-<sessionId>/ (useMultiFileAuthState).
// As pastas antigas do whatsapp-web.js (session-<sessionId>, perfil do Chrome) não são lidas nem apagadas.
const fs = require('fs')
const path = require('path')
const sessions = new Map()
const sessionLocks = new Map()
const {
  baseWebhookURL, sessionFolderPath, maxAttachmentSize, setMessagesAsSeen, baileysLogLevel, baileysFetchLatestVersion, baileysSyncFullHistory,
  baileysHistoryWebhookMaxAgeSeconds, baileysHistoryOnDemandTimeoutMs, baileysStoreMaxMessagesPerChat, baileysStorePersistMessagesPerChat
} = require('./config')
const { triggerWebhook, isEventEnabled, sendMessageSeenStatus, sleep } = require('./utils')
const { logger } = require('./logger')
const { initWebSocketServer, terminateWebSocketServer, triggerWebSocket } = require('./websocket')
const { BaileysClient } = require('./baileys/client')

const BAILEYS_DIR_PREFIX = 'baileys-'

const ensureSessionDirectory = async () => {
  await fs.promises.mkdir(sessionFolderPath, { recursive: true })
}

const authDirFor = (sessionId) => path.join(sessionFolderPath, `${BAILEYS_DIR_PREFIX}${sessionId}`)

const acquireSessionLock = async (sessionId) => {
  while (sessionLocks.get(sessionId)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  sessionLocks.set(sessionId, true)
}

const releaseSessionLock = (sessionId) => {
  sessionLocks.delete(sessionId)
}

// Function to validate if the session is ready
const validateSession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return { success: false, state: null, message: 'session_not_found' }
    }
    const state = client.getStateSync()
    if (state !== 'CONNECTED') {
      return { success: false, state, message: 'session_not_connected' }
    }
    return { success: true, state, message: 'session_connected' }
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to validate session')
    return { success: false, state: null, message: error.message }
  }
}

const hasRegisteredCreds = async (dir) => {
  try {
    const creds = JSON.parse(await fs.promises.readFile(path.join(dir, 'creds.json'), 'utf8'))
    return !!creds?.registered || !!creds?.me?.id
  } catch {
    return false
  }
}

// Sobe de novo as sessões Baileys que já têm credencial salva.
const restoreSessions = async () => {
  try {
    await ensureSessionDirectory()
    const files = await fs.promises.readdir(sessionFolderPath)
    const legacy = files.filter((f) => /^session-.+$/.test(f))
    if (legacy.length) {
      logger.warn({ count: legacy.length }, 'Pastas session-<id> do whatsapp-web.js ignoradas: o motor agora é Baileys e essas sessões precisam de QR novo')
    }
    for (const file of files) {
      const match = file.match(/^baileys-([\w-]+)$/)
      if (!match) continue
      const sessionId = match[1]
      if (!(await hasRegisteredCreds(path.join(sessionFolderPath, file)))) continue
      logger.warn({ sessionId }, 'Existing session detected')
      await setupSession(sessionId)
    }
  } catch (error) {
    logger.error(error, 'Failed to restore sessions')
  }
}

const removeAuthDir = async (sessionId) => {
  const resolvedBase = path.resolve(sessionFolderPath)
  const target = path.resolve(authDirFor(sessionId))
  if (!target.startsWith(`${resolvedBase}${path.sep}`) || !path.basename(target).startsWith(BAILEYS_DIR_PREFIX)) {
    throw new Error('Invalid path: Directory traversal detected')
  }
  await fs.promises.rm(target, { recursive: true, force: true })
}

/**
 * Cria a sessão e devolve na hora (sem esperar conexão nem QR).
 * O QR chega depois pelo evento connection.update e fica em sessions.get(id).qr.
 */
const setupSession = async (sessionId) => {
  try {
    await ensureSessionDirectory()

    const existing = sessions.get(sessionId)
    if (existing) {
      if (!existing.terminal && !existing.destroyed) {
        return { success: false, alreadyExists: true, message: `Session already exists for: ${sessionId}`, client: existing }
      }
      // Sessão morta (logout, conflito): descarta e cria outra no lugar.
      sessions.delete(sessionId)
      await existing.destroy().catch(() => { })
    }

    logger.info({ sessionId }, 'Session is being initiated')
    const client = new BaileysClient({
      sessionId,
      authDir: authDirFor(sessionId),
      options: {
        logLevel: baileysLogLevel,
        fetchLatestVersion: baileysFetchLatestVersion,
        syncFullHistory: baileysSyncFullHistory,
        historyWebhookMaxAgeSeconds: baileysHistoryWebhookMaxAgeSeconds,
        historyOnDemandTimeoutMs: baileysHistoryOnDemandTimeoutMs,
        storeMaxMessagesPerChat: baileysStoreMaxMessagesPerChat,
        storePersistMessagesPerChat: baileysStorePersistMessagesPerChat
      }
    })
    sessions.set(sessionId, client)
    initWebSocketServer(sessionId)
    initializeEvents(client, sessionId)

    client.initialize().catch((error) => {
      logger.error({ sessionId, err: error }, 'Initialize error')
      if (sessions.get(sessionId) === client) sessions.delete(sessionId)
      client.destroy().catch(() => { })
    })

    return { success: true, message: 'session_initialization_started', client }
  } catch (error) {
    return { success: false, message: error.message, client: null }
  }
}

const initializeEvents = (client, sessionId) => {
  // check if the session webhook is overridden
  const sessionWebhook = process.env[sessionId.toUpperCase() + '_WEBHOOK_URL'] || baseWebhookURL

  const forward = (event, mapArgs) => {
    if (!isEventEnabled(event)) return
    client.on(event, (...args) => {
      const data = mapArgs ? mapArgs(...args) : undefined
      triggerWebhook(sessionWebhook, sessionId, event, data)
      triggerWebSocket(sessionId, event, data)
    })
  }

  client.on('logged_out', () => {
    // Credencial revogada pelo celular: apaga só a pasta Baileys para o próximo start gerar QR novo.
    if (sessions.get(sessionId) === client) sessions.delete(sessionId)
    client.destroy()
      .then(() => removeAuthDir(sessionId))
      .catch((err) => logger.error({ sessionId, err }, 'Falha ao limpar credencial Baileys após logout'))
  })

  forward('auth_failure', (msg) => ({ msg }))
  forward('authenticated')
  forward('call', (call) => ({ call }))
  forward('change_state', (state) => ({ state }))
  forward('disconnected', (reason) => ({ reason }))
  forward('group_join', (notification) => ({ notification }))
  forward('group_leave', (notification) => ({ notification }))
  forward('group_admin_changed', (notification) => ({ notification }))
  forward('message_ack', (message, ack) => ({ message, ack }))
  forward('message_create', (message) => ({ message }))
  forward('message_reaction', (reaction) => ({ reaction }))
  forward('message_edit', (message, newBody, prevBody) => ({ message, newBody, prevBody }))
  forward('message_revoke_everyone', (message, revokedMsg) => ({ message, revokedMsg }))
  forward('ready')
  forward('chat_archived', (payload) => payload)
  forward('unread_count', (payload) => payload)
  forward('code', (code) => ({ code }))

  client.on('qr', (qr) => {
    // O QR já está em client.qr (lido por GET /session/qr/:id)
    if (isEventEnabled('qr')) {
      triggerWebhook(sessionWebhook, sessionId, 'qr', { qr })
      triggerWebSocket(sessionId, 'qr', { qr })
    }
  })

  client.on('message', async (message) => {
    if (isEventEnabled('message')) {
      triggerWebhook(sessionWebhook, sessionId, 'message', { message })
      triggerWebSocket(sessionId, 'message', { message })
      if (message.hasMedia && (message._data?.size || 0) < maxAttachmentSize && isEventEnabled('media')) {
        message.downloadMedia().then(messageMedia => {
          triggerWebhook(sessionWebhook, sessionId, 'media', { messageMedia, message })
          triggerWebSocket(sessionId, 'media', { messageMedia, message })
        }).catch(error => {
          logger.error({ sessionId, err: error }, 'Failed to download media')
        })
      }
    }
    if (setMessagesAsSeen) {
      // small delay to ensure the message is processed before sending seen status
      await sleep(1000)
      sendMessageSeenStatus(message)
    }
  })
}

// Para a sessão sem fazer logout (credencial continua na pasta Baileys).
const stopClient = async (sessionId, client) => {
  try {
    await terminateWebSocketServer(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
  }
  client.removeAllListeners()
  await client.destroy()
}

// Function to reload client session (mantém a credencial)
const reloadSession = async (sessionId) => {
  await acquireSessionLock(sessionId)
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    sessions.delete(sessionId)
    await stopClient(sessionId, client)
    await setupSession(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to reload session')
    throw error
  } finally {
    releaseSessionLock(sessionId)
  }
}

const destroyAllSessions = async () => {
  const ids = [...sessions.keys()]
  for (const id of ids) {
    try {
      await destroySession(id)
    } catch (err) {
      logger.error({ sessionId: id, err }, 'destroyAllSessions: falha ao parar uma sessão')
    }
  }
}

const destroySession = async (sessionId) => {
  await acquireSessionLock(sessionId)
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    sessions.delete(sessionId)
    await stopClient(sessionId, client)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to stop session')
    throw error
  } finally {
    releaseSessionLock(sessionId)
  }
}

// Logout + remoção da pasta Baileys da sessão (terminate).
const deleteSession = async (sessionId, validation) => {
  await acquireSessionLock(sessionId)
  try {
    const client = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (client) {
      try {
        await terminateWebSocketServer(sessionId)
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
      }
      client.removeAllListeners()
      if (validation?.success) {
        logger.info({ sessionId }, 'Logging out session')
        await client.logout()
      } else {
        logger.info({ sessionId }, 'Destroying session')
        await client.destroy()
      }
    }
    await removeAuthDir(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to delete session')
    throw error
  } finally {
    releaseSessionLock(sessionId)
  }
}

// Function to handle session flush
const flushSessions = async (deleteOnlyInactive) => {
  try {
    await ensureSessionDirectory()
    const files = await fs.promises.readdir(sessionFolderPath)
    const ids = new Set(sessions.keys())
    for (const file of files) {
      const match = file.match(/^baileys-([\w-]+)$/)
      if (match) ids.add(match[1])
    }
    let flushedCount = 0
    let skippedCount = 0
    let orphanedCount = 0

    for (const sessionId of ids) {
      const client = sessions.get(sessionId)
      if (deleteOnlyInactive) {
        if (!client) {
          // Pasta sem sessão em memória: só remove se nunca chegou a parear (credencial pareada é preservada).
          if (await hasRegisteredCreds(authDirFor(sessionId))) {
            skippedCount++
            continue
          }
          logger.info({ sessionId }, 'Cleaning up orphaned session (no client in memory)')
          await removeAuthDir(sessionId).catch(() => { })
          orphanedCount++
          continue
        }
        const validation = await validateSession(sessionId)
        if (validation.success) {
          skippedCount++
          continue
        }
        // Sessão pareada reconectando não é inativa: apagar a credencial obrigaria a ler QR de novo.
        if (!client.terminal && client.isRegistered() && ['STARTING', 'OPENING'].includes(validation.state)) {
          skippedCount++
          continue
        }
        logger.info({ sessionId, state: validation.state }, 'Flushing inactive session')
        await deleteSession(sessionId, validation)
        flushedCount++
      } else {
        const validation = await validateSession(sessionId)
        logger.info({ sessionId, validation: validation.message }, 'Flushing session (terminate all)')
        await deleteSession(sessionId, validation)
        flushedCount++
      }
    }

    logger.info({ flushedCount, skippedCount, orphanedCount }, 'Session flush completed')
  } catch (error) {
    logger.error(error, 'Failed to flush sessions')
    throw error
  }
}

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions,
  destroySession,
  destroyAllSessions,
  authDirFor
}
