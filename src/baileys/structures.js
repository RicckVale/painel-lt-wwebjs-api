// Estruturas com a mesma forma das classes do whatsapp-web.js que os controllers usam
// (MessageMedia, Location, Poll), sem depender do Chrome.
const path = require('path')
const axios = require('axios')
const { maxAttachmentSize } = require('../config')

const NOT_SUPPORTED_MESSAGE = 'not_supported_by_baileys'

class NotSupportedError extends Error {
  constructor (feature) {
    super(NOT_SUPPORTED_MESSAGE)
    this.name = 'NotSupportedError'
    this.feature = feature
    this.statusCode = 501
  }
}

const isNotSupportedMessage = (message) => typeof message === 'string' && message === NOT_SUPPORTED_MESSAGE

class MessageMedia {
  constructor (mimetype, data, filename, filesize) {
    this.mimetype = mimetype
    this.data = data
    this.filename = filename || null
    this.filesize = filesize || null
  }

  static fromBuffer (buffer, mimetype, filename) {
    return new MessageMedia(mimetype || 'application/octet-stream', Buffer.from(buffer).toString('base64'), filename || null, buffer.length)
  }

  static async fromUrl (url, options = {}) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid media url')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid media url protocol')
    }
    const response = await axios.get(parsed.toString(), {
      responseType: 'arraybuffer',
      maxContentLength: maxAttachmentSize,
      maxBodyLength: maxAttachmentSize,
      timeout: 60000,
      headers: options.reqOptions?.headers || undefined
    })
    const buffer = Buffer.from(response.data)
    const headerMime = String(response.headers?.['content-type'] || '').split(';')[0].trim()
    if (!headerMime && !options.unsafeMime) {
      throw new Error('Unable to determine MIME type using URL. Set unsafeMime to true to download it anyway.')
    }
    let filename = options.filename || null
    if (!filename) {
      const disposition = String(response.headers?.['content-disposition'] || '')
      const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
      filename = match ? decodeURIComponent(match[1]) : (path.basename(parsed.pathname) || null)
    }
    return new MessageMedia(headerMime || 'application/octet-stream', buffer.toString('base64'), filename, buffer.length)
  }
}

class Location {
  constructor (latitude, longitude, options = {}) {
    this.latitude = latitude
    this.longitude = longitude
    // whatsapp-web.js aceita string (descrição) ou objeto { name, address, url }
    if (typeof options === 'string') {
      this.description = options
      this.name = options
    } else {
      this.name = options?.name
      this.address = options?.address
      this.url = options?.url
      this.description = options?.name && options?.address ? `${options.name}\n${options.address}` : (options?.name || options?.address)
    }
  }
}

class Poll {
  constructor (pollName, pollOptions, options = {}) {
    this.pollName = String(pollName || '').trim()
    this.pollOptions = (pollOptions || []).map((o) => (typeof o === 'string' ? o : o?.name)).filter(Boolean)
    this.options = { allowMultipleAnswers: options?.allowMultipleAnswers === true, ...options }
  }
}

module.exports = {
  MessageMedia,
  Location,
  Poll,
  NotSupportedError,
  NOT_SUPPORTED_MESSAGE,
  isNotSupportedMessage
}
