// Store por sessão: chats, contatos, mensagens recentes e mapa LID→telefone.
// O Baileys não guarda histórico; getChats/fetchMessages/downloadMedia leem daqui.
// Persistido em JSON dentro da pasta da sessão Baileys para sobreviver a restart do processo.
const fs = require('fs')
const path = require('path')
const { logger } = require('../logger')
const { toWwebjsId, isLidJid, isPnJid, isGroupJid, toBaileysJid } = require('./jid')

const STORE_FILE = 'floume-store.json'
const SAVE_DEBOUNCE_MS = 10000

// Mesmo formato do BufferJSON do Baileys (Buffer ↔ { type: 'Buffer', data: base64 }).
const bufferReplacer = (key, value) => {
  if (value && (Buffer.isBuffer(value) || value instanceof Uint8Array || value.type === 'Buffer')) {
    return { type: 'Buffer', data: Buffer.from(value.data || value).toString('base64') }
  }
  return value
}
const bufferReviver = (key, value) => {
  if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
    return Buffer.from(value.data, 'base64')
  }
  return value
}

/** messageTimestamp do Baileys pode vir number, string ou Long ({ low, high }). Devolve segundos. */
const toNumber = (value) => {
  if (value == null) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value) || 0
  if (typeof value.toNumber === 'function') return value.toNumber()
  if (typeof value.low === 'number') return (value.high >>> 0) * 4294967296 + (value.low >>> 0)
  return Number(value) || 0
}

class SessionStore {
  constructor ({ dir = null, maxMessagesPerChat = 200, maxPersistedMessagesPerChat = 50 } = {}) {
    this.filePath = dir ? path.join(dir, STORE_FILE) : null
    this.maxMessagesPerChat = maxMessagesPerChat
    this.maxPersistedMessagesPerChat = maxPersistedMessagesPerChat
    this.chats = new Map()
    this.contacts = new Map()
    this.messages = new Map()
    this.lidToPn = new Map()
    this.saveTimer = null
  }

  // ===== LID ↔ telefone =====
  addLidMapping (lid, pn) {
    if (!lid || !pn || !isLidJid(lid) || !isPnJid(pn)) return
    const lidKey = toWwebjsId(lid)
    const pnId = toWwebjsId(pn)
    if (this.lidToPn.get(lidKey) === pnId) return
    this.lidToPn.set(lidKey, pnId)
    // Conversa que nasceu com o LID passa a usar o telefone (forma que o Floume conhece).
    if (this.chats.has(lidKey) && !this.chats.has(pnId)) {
      const chat = this.chats.get(lidKey)
      this.chats.delete(lidKey)
      this.chats.set(pnId, { ...chat, id: pnId, jid: toBaileysJid(pnId) })
      if (this.messages.has(lidKey)) {
        this.messages.set(pnId, this.messages.get(lidKey))
        this.messages.delete(lidKey)
      }
    }
    this.scheduleSave()
  }

  pnForLid (lid) {
    return this.lidToPn.get(toWwebjsId(lid)) || null
  }

  /** ID de conversa no formato do Floume: telefone (@c.us) quando conhecido, senão LID/grupo. */
  canonicalChatId (jid, altJid) {
    if (!jid) return ''
    if (isLidJid(jid)) {
      if (altJid && isPnJid(altJid)) {
        this.addLidMapping(jid, altJid)
        return toWwebjsId(altJid)
      }
      return this.pnForLid(jid) || toWwebjsId(jid)
    }
    if (isPnJid(jid) && altJid && isLidJid(altJid)) {
      this.addLidMapping(altJid, jid)
    }
    return toWwebjsId(jid)
  }

  // ===== Chats =====
  upsertChat (jid, patch = {}, altJid) {
    const id = this.canonicalChatId(jid, altJid)
    if (!id || id === 'status@broadcast') return null
    const prev = this.chats.get(id) || { id, jid: toBaileysJid(id), unreadCount: 0, timestamp: 0, archived: false, pinned: 0, muteEndTime: 0, isGroup: isGroupJid(id) }
    const next = { ...prev }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key] = value
    }
    this.chats.set(id, next)
    this.scheduleSave()
    return next
  }

  applyBaileysChat (chat) {
    if (!chat || !chat.id) return
    const patch = {}
    if (chat.name) patch.name = chat.name
    if (chat.unreadCount != null) patch.unreadCount = Math.max(0, chat.unreadCount)
    if (chat.conversationTimestamp != null) patch.timestamp = toNumber(chat.conversationTimestamp)
    if (chat.archived != null) patch.archived = !!chat.archived
    if (chat.pinned != null) patch.pinned = toNumber(chat.pinned)
    if (chat.muteEndTime != null) patch.muteEndTime = toNumber(chat.muteEndTime)
    const alt = chat.pnJid || chat.lidJid
    this.upsertChat(chat.id, patch, alt)
  }

  deleteChat (jid) {
    const id = this.canonicalChatId(jid)
    this.chats.delete(id)
    this.messages.delete(id)
    this.scheduleSave()
  }

  getChat (id) {
    return this.chats.get(this.canonicalChatId(toBaileysJid(id))) || null
  }

  listChats () {
    return [...this.chats.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  }

  // ===== Contatos =====
  upsertContact (contact) {
    if (!contact || !contact.id) return
    if (contact.lid && contact.phoneNumber) this.addLidMapping(contact.lid, contact.phoneNumber)
    if (isLidJid(contact.id) && contact.phoneNumber) this.addLidMapping(contact.id, contact.phoneNumber)
    if (isPnJid(contact.id) && contact.lid) this.addLidMapping(contact.lid, contact.id)
    const id = this.canonicalChatId(contact.id)
    const prev = this.contacts.get(id) || { id }
    const next = { ...prev }
    for (const key of ['name', 'notify', 'verifiedName', 'imgUrl', 'status']) {
      if (contact[key]) next[key] = contact[key]
    }
    if (contact.lid) next.lid = toWwebjsId(contact.lid)
    this.contacts.set(id, next)
    if (next.name && this.chats.has(id) && !this.chats.get(id).name) {
      this.chats.get(id).name = next.name
    }
    this.scheduleSave()
  }

  getContact (id) {
    return this.contacts.get(this.canonicalChatId(toBaileysJid(id))) || null
  }

  // ===== Mensagens =====
  chatIdForMessage (msg) {
    const key = msg?.key || {}
    return this.canonicalChatId(key.remoteJid, key.remoteJidAlt)
  }

  upsertMessage (msg) {
    const id = msg?.key?.id
    if (!id) return null
    const chatId = this.chatIdForMessage(msg)
    if (!chatId || chatId === 'status@broadcast') return null
    if (!this.messages.has(chatId)) this.messages.set(chatId, new Map())
    const bucket = this.messages.get(chatId)
    const prev = bucket.get(id)
    bucket.set(id, prev ? { ...prev, ...msg, message: msg.message || prev.message } : msg)
    if (bucket.size > this.maxMessagesPerChat) {
      const sorted = [...bucket.values()].sort((a, b) => toNumber(a.messageTimestamp) - toNumber(b.messageTimestamp))
      for (const old of sorted.slice(0, bucket.size - this.maxMessagesPerChat)) bucket.delete(old.key.id)
    }
    const ts = toNumber(msg.messageTimestamp)
    const chat = this.chats.get(chatId)
    if (!chat || ts >= (chat.timestamp || 0)) {
      this.upsertChat(toBaileysJid(chatId), { timestamp: ts || chat?.timestamp })
    }
    this.scheduleSave()
    return chatId
  }

  updateMessage (key, update) {
    const chatId = this.canonicalChatId(key?.remoteJid, key?.remoteJidAlt)
    const msg = this.messages.get(chatId)?.get(key?.id)
    if (!msg) return null
    Object.assign(msg, update)
    this.scheduleSave()
    return msg
  }

  getMessage (chatId, messageId) {
    const bucket = this.messages.get(this.canonicalChatId(toBaileysJid(chatId)))
    return bucket ? bucket.get(messageId) || null : null
  }

  findMessageById (messageId) {
    for (const bucket of this.messages.values()) {
      if (bucket.has(messageId)) return bucket.get(messageId)
    }
    return null
  }

  listMessages (chatId) {
    const bucket = this.messages.get(this.canonicalChatId(toBaileysJid(chatId)))
    if (!bucket) return []
    return [...bucket.values()].sort((a, b) => toNumber(a.messageTimestamp) - toNumber(b.messageTimestamp))
  }

  allMessages () {
    const out = []
    for (const bucket of this.messages.values()) out.push(...bucket.values())
    return out
  }

  // ===== Persistência =====
  load () {
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'), bufferReviver)
      for (const [k, v] of data.lidToPn || []) this.lidToPn.set(k, v)
      for (const chat of data.chats || []) this.chats.set(chat.id, chat)
      for (const contact of data.contacts || []) this.contacts.set(contact.id, contact)
      for (const [chatId, msgs] of data.messages || []) {
        this.messages.set(chatId, new Map(msgs.map((m) => [m.key.id, m])))
      }
    } catch (err) {
      logger.warn({ err, file: this.filePath }, 'Store da sessão ilegível; começando vazio')
    }
  }

  scheduleSave () {
    if (!this.filePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch((err) => logger.warn({ err }, 'Falha ao salvar store da sessão'))
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  async flush () {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.filePath) return
    const messages = []
    for (const [chatId, bucket] of this.messages) {
      const sorted = [...bucket.values()].sort((a, b) => toNumber(a.messageTimestamp) - toNumber(b.messageTimestamp))
      messages.push([chatId, sorted.slice(-this.maxPersistedMessagesPerChat)])
    }
    const payload = JSON.stringify({
      version: 1,
      lidToPn: [...this.lidToPn.entries()],
      chats: [...this.chats.values()],
      contacts: [...this.contacts.values()],
      messages
    }, bufferReplacer)
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.promises.writeFile(tmp, payload)
    await fs.promises.rename(tmp, this.filePath)
  }

  close () {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }
}

module.exports = { SessionStore, toNumber, STORE_FILE }
