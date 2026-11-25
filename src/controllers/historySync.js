// POST /chat/syncHistory/:sessionId e POST /client/syncHistory/:sessionId (mesmo caminho).
// Body: { chatId, count? }. Chama sock.fetchMessageHistory com a mensagem mais antiga já guardada.
const { sessions } = require('../sessions')
const { sendErrorResponse } = require('../utils')
const { logger } = require('../logger')

const syncHistoryHandler = async (req, res) => {
  const sessionId = req.params.sessionId
  try {
    const { chatId, count } = req.body || {}
    const client = sessions.get(sessionId)
    if (!client) {
      return sendErrorResponse(res, 404, 'session_not_found')
    }
    if (client.getStateSync() !== 'CONNECTED') {
      return res.status(422).json({ success: false, error: 'history_sync_not_connected', message: 'history_sync_not_connected' })
    }
    if (!chatId || typeof chatId !== 'string') {
      return sendErrorResponse(res, 400, 'chatId is required')
    }
    const result = await client.syncHistory(chatId, { count })
    return res.json(result)
  } catch (error) {
    if (error?.statusCode === 422) {
      return res.status(422).json({ success: false, error: error.message, message: error.message })
    }
    logger.error({ sessionId, err: error }, 'Falha ao pedir histórico sob demanda')
    return sendErrorResponse(res, 500, error.message)
  }
}

module.exports = { syncHistoryHandler }
