const app = require('./src/app')
const {
  servicePort,
  baseWebhookURL,
  enableWebHook,
  enableWebSocket,
  autoStartSessions,
  cleanupOrphanBrowsersOnStartup,
  sessionFolderPath,
  wwebjsBrowserMarker
} = require('./src/config')
const { logger } = require('./src/logger')
const { handleUpgrade } = require('./src/websocket')
const { restoreSessions, destroyAllSessions } = require('./src/sessions')
const { cleanupOrphanBrowsers } = require('./src/browserOrphans')

// Check if BASE_WEBHOOK_URL environment variable is available when WebHook is enabled
if (!baseWebhookURL && enableWebHook) {
  logger.error('BASE_WEBHOOK_URL environment variable is not set. Exiting...')
  process.exit(1)
}

// puppeteer uses subscriptions to SIGINT, SIGTERM, and SIGHUP to know when to close browser instances
// this disables the warnings when you starts more than 10 browser instances
process.setMaxListeners(0)

const bootstrap = async () => {
  if (cleanupOrphanBrowsersOnStartup) {
    try {
      const r = await cleanupOrphanBrowsers({ sessionFolderPath, marker: wwebjsBrowserMarker })
      if (r.skipped) {
        logger.info({ skipped: r.skipped }, 'Limpeza de Chrome órfão ignorada nesta plataforma')
      } else if (r.killed && r.killed.length > 0) {
        logger.warn({ count: r.killed.length, sample: r.killed.slice(0, 25) }, 'Processos Chrome desta API encerrados no boot (órfãos da execução anterior)')
      } else {
        logger.info('Chrome órfão: nenhum processo encontrado para este SESSIONS_PATH / marcador')
      }
    } catch (err) {
      logger.error({ err }, 'Falha na limpeza de Chrome órfão; seguindo com o boot')
    }
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

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Encerramento: fechando servidor e sessões WhatsApp/Puppeteer')
    try {
      await destroyAllSessions()
    } catch (err) {
      logger.error({ err }, 'Erro ao destruir sessões durante shutdown')
    }
    server.close(() => process.exit(0))
    setTimeout(() => {
      logger.error('Timeout no encerramento do servidor; saindo com código 1')
      process.exit(1)
    }, 20000)
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error({ err }, 'Erro em shutdown SIGTERM')
      process.exit(1)
    })
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error({ err }, 'Erro em shutdown SIGINT')
      process.exit(1)
    })
  })
}

bootstrap().catch((err) => {
  logger.error(err, 'Falha no bootstrap do servidor')
  process.exit(1)
})
