const axios = require('axios')
const { globalApiKey, disabledCallbacks, enableWebHook } = require('./config')
const { logger } = require('./logger')
const { NOT_SUPPORTED_MESSAGE } = require('./baileys/structures')

// Trigger webhook endpoint
const triggerWebhook = (webhookURL, sessionId, dataType, data) => {
  if (enableWebHook) {
    axios.post(webhookURL, { dataType, data, sessionId }, { headers: { 'x-api-key': globalApiKey } })
      .then(() => logger.debug({ sessionId, dataType, data: data || '' }, `Webhook message sent to ${webhookURL}`))
      .catch(error => logger.error({ sessionId, dataType, err: error, data: data || '' }, `Failed to send webhook message to ${webhookURL}`))
  }
}

// Function to send a response with error status and message
// Recurso sem equivalente no Baileys vira 501 com mensagem estável (not_supported_by_baileys).
const sendErrorResponse = (res, status, message) => {
  if (message === NOT_SUPPORTED_MESSAGE) {
    return res.status(501).json({ success: false, error: NOT_SUPPORTED_MESSAGE, message: NOT_SUPPORTED_MESSAGE })
  }
  res.status(status).json({ success: false, error: message })
}

const sendNotSupported = (res) => sendErrorResponse(res, 501, NOT_SUPPORTED_MESSAGE)

const isEventEnabled = (event) => {
  return !disabledCallbacks.includes(event)
}

const sendMessageSeenStatus = async (message) => {
  try {
    const chat = await message.getChat()
    await chat.sendSeen()
  } catch (error) {
    logger.error(error, 'Failed to send seen status')
  }
}

const decodeBase64 = function * (base64String) {
  const chunkSize = 1024
  for (let i = 0; i < base64String.length; i += chunkSize) {
    const chunk = base64String.slice(i, i + chunkSize)
    yield Buffer.from(chunk, 'base64')
  }
}

const sleep = function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  triggerWebhook,
  sendErrorResponse,
  isEventEnabled,
  sendMessageSeenStatus,
  decodeBase64,
  sleep,
  sendNotSupported
}
