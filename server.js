const app = require('./src/app')
const { servicePort, baseWebhookURL, enableWebHook, enableWebSocket, autoStartSessions } = require('./src/config')
const { logger } = require('./src/logger')
const { handleUpgrade } = require('./src/websocket')
const { restoreSessions, sessions } = require('./src/sessions')

if (!baseWebhookURL && enableWebHook) {
  logger.error('BASE_WEBHOOK_URL environment variable is not set. Exiting...')
  process.exit(1)
}

const server = app.listen(servicePort, () => {
  logger.info(`Server running on port ${servicePort}`)
  logger.debug({ configuration: require('./src/config') }, 'Service configuration')
  if (autoStartSessions) {
    logger.info('Starting all sessions')
    restoreSessions()
  }
})

if (enableWebSocket) {
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head)
  })
}

process.setMaxListeners(0)

let isShuttingDown = false

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info({ signal }, 'Shutdown signal received, closing all browser sessions...')

  const SHUTDOWN_TIMEOUT_MS = 30000
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, force killing remaining Chrome processes')
    for (const [sessionId, client] of sessions) {
      try {
        const proc = client?.pupBrowser?.process()
        if (proc) {
          proc.kill('SIGKILL')
          logger.info({ sessionId, pid: proc.pid }, 'Force killed Chrome on timeout')
        }
      } catch (e) { /* ignore */ }
    }
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceExitTimer.unref()

  try {
    server.close()

    const destroyPromises = []
    for (const [sessionId, client] of sessions) {
      destroyPromises.push(
        (async () => {
          try {
            client.pupPage?.removeAllListeners('close')
            client.pupPage?.removeAllListeners('error')
            await client.destroy()
            logger.info({ sessionId }, 'Session closed gracefully')
          } catch (e) {
            try {
              const proc = client?.pupBrowser?.process()
              if (proc) {
                proc.kill('SIGKILL')
                logger.info({ sessionId, pid: proc.pid }, 'Force killed Chrome after destroy failure')
              }
            } catch (killErr) { /* ignore */ }
          }
        })()
      )
    }

    await Promise.allSettled(destroyPromises)
    logger.info(`All ${destroyPromises.length} sessions closed. Exiting.`)
    clearTimeout(forceExitTimer)
    process.exit(0)
  } catch (error) {
    logger.error({ err: error }, 'Error during graceful shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
