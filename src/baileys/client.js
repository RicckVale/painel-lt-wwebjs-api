// Cliente WhatsApp sobre o Baileys com a mesma interface que os controllers usavam do
// Client do whatsapp-web.js (sendMessage, getChats, getChatById, getNumberId...), sem Chrome.
const EventEmitter = require('events')
const fs = require('fs')
const pino = require('pino')
const { logger } = require('../logger')
const { loadBaileys } = require('./loader')
const { SessionStore, toNumber } = require('./store')
const { MessageMedia, Location, Poll, NotSupportedError } = require('./structures')
const {
  serializeMessage, serializeChat, serializeContact, parseMessageId, unwrapContent, contentKey, messageBody, MEDIA_KEYS
} = require('./serialize')
const { toBaileysJid, toWwebjsId, toWid, isGroupJid, isLidJid, isPnJid, isNewsletterJid, phoneDigits } = require('./jid')

// proto.HistorySync.HistorySyncType
const HISTORY_SYNC_TYPES = {
  0: 'INITIAL_BOOTSTRAP',
  1: 'INITIAL_STATUS_V3',
  2: 'FULL',
  3: 'RECENT',
  4: 'PUSH_NAME',
  5: 'NON_BLOCKING_DATA',
  6: 'ON_DEMAND'
}
const historySyncTypeName = (value) => {
  if (value == null) return null
  if (typeof value === 'string') return value
  return HISTORY_SYNC_TYPES[value] || String(value)
}
const HISTORY_CHUNK = 200
// Resposta ON_DEMAND pode chegar depois do timeout; ainda entra no chat que pediu.
const ON_DEMAND_ALIAS_MS = 120_000
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve))

class HistorySyncError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'HistorySyncError'
    this.statusCode = statusCode
  }
}

const DisconnectCode = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503
}

const NUMBER_ID_TTL_MS = 10 * 60 * 1000
const NUMBER_ID_MISS_TTL_MS = 60 * 1000
const HISTORY_REQUEST_COOLDOWN_MS = 10 * 60 * 1000
const MAX_RECONNECT_DELAY_MS = 30000
const DISCONNECT_NOTIFY_AFTER_FAILURES = 3

const withTimeout = (promise, ms, label) => {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
  ])
}

/** Copia o conteúdo da mensagem sem campos binários (Buffer/Uint8Array) e com Long → number. */
const lightContent = (value, depth = 0) => {
  if (value == null || depth > 8) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined
  if (Array.isArray(value)) return value.map((v) => lightContent(v, depth + 1))
  if (typeof value === 'object') {
    if (typeof value.low === 'number' && typeof value.high === 'number') return toNumber(value)
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const next = lightContent(v, depth + 1)
      if (next !== undefined) out[k] = next
    }
    return out
  }
  return value
}

// =====================================================================
// Fachadas (mesmos nomes de método do whatsapp-web.js)
// =====================================================================

class BaileysMessage {
  constructor (client, raw) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false })
    Object.defineProperty(this, 'raw', { value: raw, enumerable: false })
    Object.assign(this, serializeMessage(raw, { store: client.store, meId: client.meId }))
    const content = lightContent(unwrapContent(raw?.message))
    if (content && Object.keys(content).length) this.message = content
  }

  get chatJid () {
    return this.raw.key.remoteJid
  }

  async getChat () {
    return this.client.getChatById(this.id.remote)
  }

  async getContact () {
    return this.client.getContactById(this.author || this.from)
  }

  async downloadMedia () {
    if (!this.hasMedia) return undefined
    return this.client._downloadMedia(this.raw)
  }

  async reply (content, chatId, options = {}) {
    return this.client.sendMessage(chatId || this.id.remote, content, { ...options, quotedMessage: this.raw })
  }

  async react (reaction) {
    await this.client._sock().sendMessage(this.chatJid, { react: { text: reaction || '', key: this.raw.key } })
    return true
  }

  async delete (everyone, clearMedia = true) {
    const sock = this.client._sock()
    if (everyone) {
      await sock.sendMessage(this.chatJid, { delete: this.raw.key })
    } else {
      await sock.chatModify({
        deleteForMe: { deleteMedia: !!clearMedia, key: this.raw.key, timestamp: toNumber(this.raw.messageTimestamp) }
      }, this.chatJid)
    }
    return true
  }

  async forward (chat) {
    const target = typeof chat === 'string' ? chat : chat?.id?._serialized
    const jid = await this.client._resolveSendJid(target)
    const sent = await this.client._sock().sendMessage(jid, { forward: this.raw })
    return this.client._wrapSent(sent)
  }

  async edit (content) {
    const sent = await this.client._sock().sendMessage(this.chatJid, { text: String(content ?? ''), edit: this.raw.key })
    return this.client._wrapSent(sent)
  }

  async star () {
    await this.client._sock().chatModify({ star: { messages: [{ id: this.raw.key.id, fromMe: !!this.raw.key.fromMe }], star: true } }, this.chatJid)
    return true
  }

  async unstar () {
    await this.client._sock().chatModify({ star: { messages: [{ id: this.raw.key.id, fromMe: !!this.raw.key.fromMe }], star: false } }, this.chatJid)
    return true
  }

  async getQuotedMessage () {
    const stanzaId = this._data?.quotedStanzaID
    if (!stanzaId) return undefined
    const stored = this.client.store.getMessage(this.id.remote, stanzaId)
    return stored ? new BaileysMessage(this.client, stored) : undefined
  }

  async getMentions () {
    return Promise.all((this.mentionedIds || []).map((id) => this.client.getContactById(id)))
  }

  async getGroupMentions () { return [] }
  async getInfo () { throw new NotSupportedError('message.getInfo') }
  async getOrder () { throw new NotSupportedError('message.getOrder') }
  async getPayment () { throw new NotSupportedError('message.getPayment') }
  async getReactions () { throw new NotSupportedError('message.getReactions') }
  async getPollVotes () { throw new NotSupportedError('message.getPollVotes') }
}

class BaileysContact {
  constructor (client, contact) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false })
    Object.assign(this, serializeContact(contact, { meId: client.meId }))
  }

  async getProfilePicUrl () { return this.client.getProfilePicUrl(this.id._serialized) }
  async getChat () { return this.isMe ? null : this.client.getChatById(this.id._serialized) }
  async getAbout () {
    const res = await this.client._sock().fetchStatus(toBaileysJid(this.id._serialized))
    const first = Array.isArray(res) ? res[0] : res
    return first?.status?.status ?? first?.status ?? null
  }

  async block () {
    await this.client._sock().updateBlockStatus(toBaileysJid(this.id._serialized), 'block')
    return true
  }

  async unblock () {
    await this.client._sock().updateBlockStatus(toBaileysJid(this.id._serialized), 'unblock')
    return true
  }

  async getFormattedNumber () { return this.number ? `+${this.number}` : null }
  async getCountryCode () { throw new NotSupportedError('contact.getCountryCode') }
  async getCommonGroups () { throw new NotSupportedError('contact.getCommonGroups') }
}

class BaileysChat {
  constructor (client, chat, groupMetadata) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false })
    Object.defineProperty(this, 'jid', { value: chat.jid || toBaileysJid(chat.id), enumerable: false })
    Object.assign(this, serializeChat({ ...chat, groupMetadata: groupMetadata ? serializeGroupMetadata(groupMetadata, client) : undefined }, { store: client.store, meId: client.meId }))
    this.isChannel = false
    if (groupMetadata) {
      this.groupMetadata = serializeGroupMetadata(groupMetadata, client)
      this.participants = this.groupMetadata.participants
      this.owner = this.groupMetadata.owner
      this.description = this.groupMetadata.desc
      this.createdAt = this.groupMetadata.creation
      if (!this.name) this.name = groupMetadata.subject
    }
  }

  _lastMessages () {
    const last = this.client.store.listMessages(this.id._serialized).slice(-1)
    return last.map((m) => ({ key: m.key, messageTimestamp: m.messageTimestamp }))
  }

  async fetchMessages (searchOptions = {}) {
    const { limit, fromMe, messageId, since } = searchOptions || {}
    const wanted = messageId ? parseMessageId(messageId).id : null
    const read = () => {
      let list = this.client.store.listMessages(this.id._serialized)
      list = list.filter((m) => {
        const content = unwrapContent(m.message)
        const ckey = contentKey(content)
        if (!ckey || ckey === 'protocolMessage' || ckey === 'reactionMessage') return wanted ? m.key.id === wanted : false
        if (fromMe !== undefined && !!m.key.fromMe !== !!fromMe) return false
        if (since !== undefined && Number.isFinite(since) && toNumber(m.messageTimestamp) < since) return false
        if (wanted && m.key.id !== wanted) return false
        return true
      })
      if (limit > 0 && list.length > limit) list = list.slice(list.length - limit)
      return list
    }
    let list = read()
    // Store curto: espera o celular (fetchMessageHistory) até o timeout e só então responde.
    // Sem mensagem antiga para servir de chave, devolve o que já tem — sem 500.
    if (!wanted && limit > 0 && list.length < limit) {
      try {
        await this.client.syncHistory(this.id._serialized, {
          count: limit,
          timeoutMs: this.client.options.historyOnDemandTimeoutMs
        })
      } catch (err) {
        logger.warn({ sessionId: this.client.sessionId, chatId: this.id._serialized, err: err?.message }, 'fetchMessages sem histórico extra')
      }
      list = read()
    }
    return list.map((m) => new BaileysMessage(this.client, m))
  }

  async sendMessage (content, options) { return this.client.sendMessage(this.id._serialized, content, options) }

  async sendSeen () {
    const sock = this.client._sock()
    const unread = this.client.store.listMessages(this.id._serialized).filter((m) => !m.key.fromMe && !m.readByMe).slice(-20)
    if (unread.length) {
      await sock.readMessages(unread.map((m) => m.key))
      for (const m of unread) m.readByMe = true
      this.client.store.scheduleSave()
    }
    this.client.store.upsertChat(this.jid, { unreadCount: 0 })
    return true
  }

  async sendStateTyping () {
    await this.client._sock().sendPresenceUpdate('composing', this.jid)
    return true
  }

  async sendStateRecording () {
    await this.client._sock().sendPresenceUpdate('recording', this.jid)
    return true
  }

  async clearState () {
    await this.client._sock().sendPresenceUpdate('paused', this.jid)
    return true
  }

  async archive () {
    await this.client._sock().chatModify({ archive: true, lastMessages: this._lastMessages() }, this.jid)
    this.client.store.upsertChat(this.jid, { archived: true })
    return true
  }

  async unarchive () {
    await this.client._sock().chatModify({ archive: false, lastMessages: this._lastMessages() }, this.jid)
    this.client.store.upsertChat(this.jid, { archived: false })
    return true
  }

  async pin () {
    await this.client._sock().chatModify({ pin: true }, this.jid)
    this.client.store.upsertChat(this.jid, { pinned: Math.floor(Date.now() / 1000) })
    return true
  }

  async unpin () {
    await this.client._sock().chatModify({ pin: false }, this.jid)
    this.client.store.upsertChat(this.jid, { pinned: 0 })
    return false
  }

  async mute (unmuteDate) {
    const end = unmuteDate instanceof Date ? unmuteDate.getTime() : (unmuteDate ? Number(unmuteDate) * 1000 : -1)
    await this.client._sock().chatModify({ mute: end }, this.jid)
    this.client.store.upsertChat(this.jid, { muteEndTime: end === -1 ? -1 : Math.floor(end / 1000) })
    return { isMuted: true, muteExpiration: end === -1 ? -1 : Math.floor(end / 1000) }
  }

  async unmute () {
    await this.client._sock().chatModify({ mute: null }, this.jid)
    this.client.store.upsertChat(this.jid, { muteEndTime: 0 })
    return { isMuted: false, muteExpiration: 0 }
  }

  async markUnread () {
    await this.client._sock().chatModify({ markRead: false, lastMessages: this._lastMessages() }, this.jid)
    return true
  }

  async delete () {
    await this.client._sock().chatModify({ delete: true, lastMessages: this._lastMessages() }, this.jid)
    this.client.store.deleteChat(this.jid)
    return true
  }

  async clearMessages () {
    await this.client._sock().chatModify({ clear: true, lastMessages: this._lastMessages() }, this.jid)
    return true
  }

  async getContact () { return this.client.getContactById(this.id._serialized) }
  async syncHistory (options) { return this.client.syncHistory(this.id._serialized, options) }
  async getLabels () { throw new NotSupportedError('chat.getLabels') }
  async changeLabels () { throw new NotSupportedError('chat.changeLabels') }

  // ===== Grupo =====
  async _participants (action, ids) {
    const jids = (Array.isArray(ids) ? ids : [ids]).map(toBaileysJid)
    const res = await this.client._sock().groupParticipantsUpdate(this.jid, jids, action)
    this.client._invalidateGroup(this.jid)
    const out = {}
    for (const item of res || []) {
      out[toWwebjsId(item.jid)] = { code: Number(item.status) || 200, message: String(item.status || '') }
    }
    return out
  }

  async addParticipants (ids) { return this._participants('add', ids) }
  async removeParticipants (ids) { return this._participants('remove', ids) }
  async promoteParticipants (ids) { return this._participants('promote', ids) }
  async demoteParticipants (ids) { return this._participants('demote', ids) }
  async getInviteCode () { return this.client._sock().groupInviteCode(this.jid) }
  async revokeInvite () { return this.client._sock().groupRevokeInvite(this.jid) }
  async leave () {
    await this.client._sock().groupLeave(this.jid)
    return true
  }

  async setSubject (subject) {
    await this.client._sock().groupUpdateSubject(this.jid, subject)
    this.client._invalidateGroup(this.jid)
    return true
  }

  async setDescription (description) {
    await this.client._sock().groupUpdateDescription(this.jid, description)
    this.client._invalidateGroup(this.jid)
    return true
  }

  async setMessagesAdminsOnly (adminsOnly = true) {
    await this.client._sock().groupSettingUpdate(this.jid, adminsOnly ? 'announcement' : 'not_announcement')
    return true
  }

  async setInfoAdminsOnly (adminsOnly = true) {
    await this.client._sock().groupSettingUpdate(this.jid, adminsOnly ? 'locked' : 'unlocked')
    return true
  }

  async setPicture (media) {
    await this.client._sock().updateProfilePicture(this.jid, Buffer.from(media.data, 'base64'))
    return true
  }

  async deletePicture () {
    await this.client._sock().removeProfilePicture(this.jid)
    return true
  }

  async getGroupMembershipRequests () {
    const list = await this.client._sock().groupRequestParticipantsList(this.jid)
    return (list || []).map((r) => ({ id: toWid(r.jid), addedBy: r.add_by ? toWid(r.add_by) : null, requestMethod: r.request_method, t: toNumber(r.request_time) }))
  }

  async _membership (action, options = {}) {
    let ids = options?.requesterIds
    if (!ids || (Array.isArray(ids) && !ids.length)) {
      ids = (await this.getGroupMembershipRequests()).map((r) => r.id._serialized)
    }
    const jids = (Array.isArray(ids) ? ids : [ids]).map(toBaileysJid)
    const res = await this.client._sock().groupRequestParticipantsUpdate(this.jid, jids, action)
    return (res || []).map((r) => ({ requesterId: toWwebjsId(r.jid), message: String(r.status || '') }))
  }

  async approveGroupMembershipRequests (options) { return this._membership('approve', options) }
  async rejectGroupMembershipRequests (options) { return this._membership('reject', options) }
}

const serializeGroupMetadata = (meta, client) => {
  const participants = (meta.participants || []).map((p) => {
    const pid = client.store.canonicalChatId(p.id, p.phoneNumber || p.lid)
    return {
      id: toWid(pid),
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin'
    }
  })
  return {
    id: toWid(meta.id),
    subject: meta.subject,
    desc: meta.desc,
    owner: meta.owner ? toWid(client.store.canonicalChatId(meta.owner, meta.ownerPn)) : undefined,
    creation: meta.creation,
    announce: !!meta.announce,
    restrict: !!meta.restrict,
    size: meta.size || participants.length,
    participants
  }
}

// =====================================================================
// Cliente
// =====================================================================

class BaileysClient extends EventEmitter {
  constructor ({ sessionId, authDir, options = {} }) {
    super()
    this.sessionId = sessionId
    this.authDir = authDir
    this.options = options
    this.store = new SessionStore({
      dir: authDir,
      maxMessagesPerChat: options.storeMaxMessagesPerChat,
      maxPersistedMessagesPerChat: options.storePersistMessagesPerChat
    })
    this.sock = null
    this.qr = null
    this.info = null
    this.state = 'STARTING'
    this.destroyed = false
    this.loggedOut = false
    this.terminal = false
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.connectedOnce = false
    this.disconnectNotified = false
    this.numberIdCache = new Map()
    this.groupCache = new Map()
    this.historyRequests = new Map()
    // Sincronização de histórico (messaging-history.set): fila assíncrona para não travar o socket,
    // último estado recebido e quem espera resposta ON_DEMAND de fetchMessageHistory.
    this.historyQueue = Promise.resolve()
    this.historyState = { syncType: null, progress: null, isLatest: null, chunks: 0, messages: 0, at: null }
    this.historyStatus = {}
    this.onDemandWaiters = []
    this.recentOnDemand = []
    // Histórico completo só com BAILEYS_SYNC_FULL_HISTORY=true explícito (options.syncFullHistory === true).
    // setBackgroundSync pode ligar/desligar nas próximas conexões; o padrão é histórico sob demanda.
    this.backgroundSync = options.syncFullHistory === true
    this.justPaired = false
    this.pendingOwnSends = new Set()
    this.baileysVersion = null
    this.interface = {
      openChatWindow: async () => { throw new NotSupportedError('interface.openChatWindow') },
      openChatWindowAt: async () => { throw new NotSupportedError('interface.openChatWindowAt') }
    }
  }

  get meId () {
    return this.info?.wid?._serialized || ''
  }

  // ===== Ciclo de vida =====

  async initialize () {
    this.baileys = await loadBaileys()
    await fs.promises.mkdir(this.authDir, { recursive: true })
    const { state, saveCreds } = await this.baileys.useMultiFileAuthState(this.authDir)
    this.authState = state
    this.saveCreds = saveCreds
    this.store.load()
    if (this.options.fetchLatestVersion !== false && typeof this.baileys.fetchLatestWaWebVersion === 'function') {
      try {
        const latest = await withTimeout(this.baileys.fetchLatestWaWebVersion({}), 10000, 'fetchLatestWaWebVersion')
        if (Array.isArray(latest?.version)) this.baileysVersion = latest.version
      } catch (err) {
        logger.warn({ sessionId: this.sessionId, err: err.message }, 'Não foi possível buscar a versão mais recente do WhatsApp Web; usando a padrão do Baileys')
      }
    }
    if (this.destroyed) return
    this._connect()
  }

  _baileysLogger () {
    // Instância pino própria (não child do logger da API) para o nível do Baileys não disparar
    // o aviso de level-change do logger principal a cada sessão.
    if (!this.blogger) {
      this.blogger = pino({ level: this.options.logLevel || 'warn' }).child({ module: 'baileys', sessionId: this.sessionId })
    }
    return this.blogger
  }

  _connect () {
    if (this.destroyed) return
    const b = this.baileys
    const blogger = this._baileysLogger()
    const keys = typeof b.makeCacheableSignalKeyStore === 'function'
      ? b.makeCacheableSignalKeyStore(this.authState.keys, blogger)
      : this.authState.keys
    const socketOptions = {
      auth: { creds: this.authState.creds, keys },
      logger: blogger,
      markOnlineOnConnect: false,
      // Padrão: histórico sob demanda. syncFullHistory false em todo socket (antes e depois do pareamento);
      // só liga com BAILEYS_SYNC_FULL_HISTORY=true (ou setBackgroundSync(true)) e sessão já pareada.
      // shouldSyncHistoryMessage aceita todos os tipos (INITIAL_BOOTSTRAP, RECENT, ON_DEMAND, PUSH_NAME...),
      // que também trazem o mapa LID → telefone.
      syncFullHistory: this.socketSyncFullHistory(),
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        const stored = this.store.getMessage(this.store.canonicalChatId(key.remoteJid, key.remoteJidAlt), key.id)
        return stored?.message || undefined
      },
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid)?.meta
    }
    // Perfil de cliente web recomendado pela doc do Baileys (Browsers.macOS('Chrome'), webSubPlatform WEB_BROWSER).
    // "Desktop" anuncia app nativo (DARWIN) e só volta com BAILEYS_SYNC_FULL_HISTORY=true explícito.
    if (b.Browsers && typeof b.Browsers.macOS === 'function') {
      const desktop = this.options.syncFullHistory === true && socketOptions.syncFullHistory
      socketOptions.browser = b.Browsers.macOS(desktop ? 'Desktop' : 'Chrome')
    }
    if (this.baileysVersion) socketOptions.version = this.baileysVersion
    this.lastSocketSyncFullHistory = socketOptions.syncFullHistory
    const sock = b.makeWASocket(socketOptions)
    this.sock = sock
    this._bindSocket(sock)
  }

  _bindSocket (sock) {
    const ev = sock.ev
    const guard = (name, fn) => (...args) => {
      if (this.sock !== sock) return
      try {
        const r = fn(...args)
        if (r && typeof r.catch === 'function') {
          r.catch((err) => logger.error({ sessionId: this.sessionId, err, event: name }, 'Falha ao processar evento do Baileys'))
        }
      } catch (err) {
        logger.error({ sessionId: this.sessionId, err, event: name }, 'Falha ao processar evento do Baileys')
      }
    }
    ev.on('creds.update', guard('creds.update', (update) => {
      // QR lido: o Baileys grava creds.me e em seguida o servidor pede restart (515).
      if (update?.me?.id && !this.connectedOnce) this.justPaired = true
      return this.saveCreds()
    }))
    ev.on('connection.update', guard('connection.update', (u) => this._onConnectionUpdate(u)))
    ev.on('messaging-history.set', guard('messaging-history.set', (h) => this._onHistory(h)))
    ev.on('messaging-history.status', guard('messaging-history.status', (st) => this._onHistoryStatus(st)))
    ev.on('chats.upsert', guard('chats.upsert', (chats) => chats.forEach((c) => this.store.applyBaileysChat(c))))
    ev.on('chats.update', guard('chats.update', (updates) => this._onChatsUpdate(updates)))
    ev.on('chats.delete', guard('chats.delete', (ids) => ids.forEach((id) => this.store.deleteChat(id))))
    ev.on('contacts.upsert', guard('contacts.upsert', (list) => list.forEach((c) => this.store.upsertContact(c))))
    ev.on('contacts.update', guard('contacts.update', (list) => list.forEach((c) => this.store.upsertContact(c))))
    ev.on('lid-mapping.update', guard('lid-mapping.update', (m) => this.store.addLidMapping(m?.lid, m?.pn)))
    ev.on('messages.upsert', guard('messages.upsert', (u) => this._onMessagesUpsert(u)))
    ev.on('messages.update', guard('messages.update', (list) => this._onMessagesUpdate(list)))
    ev.on('groups.update', guard('groups.update', (list) => list.forEach((g) => this._invalidateGroup(g.id))))
    ev.on('group-participants.update', guard('group-participants.update', (u) => this._onGroupParticipants(u)))
    ev.on('call', guard('call', (calls) => (calls || []).forEach((call) => this.emit('call', {
      id: call.id,
      from: toWwebjsId(call.from),
      timestamp: toNumber(call.date) || Math.floor(Date.now() / 1000),
      isVideo: !!call.isVideo,
      isGroup: !!call.isGroup,
      fromMe: false,
      status: call.status
    }))))
  }

  _setState (state) {
    if (this.state === state) return
    this.state = state
    this.emit('change_state', state)
  }

  _onConnectionUpdate (update) {
    const { connection, lastDisconnect, qr } = update || {}
    if (qr) {
      this.qr = qr
      this._setState('UNPAIRED')
      this.emit('qr', qr)
    }
    if (connection === 'connecting' && !this.qr) {
      this._setState(this.isRegistered() ? 'OPENING' : 'STARTING')
    }
    if (connection === 'open') {
      this.qr = null
      this.reconnectAttempts = 0
      this.disconnectNotified = false
      this.connectedOnce = true
      this._refreshInfo()
      this._setState('CONNECTED')
      this.emit('authenticated')
      this.emit('ready')
      return
    }
    if (connection === 'close') {
      this._onClose(lastDisconnect)
    }
  }

  _refreshInfo () {
    const user = this.sock?.user || {}
    const meJid = toWwebjsId(user.id || '')
    const wid = toWid(meJid)
    this.info = {
      pushname: user.name || user.notify || user.verifiedName || this.authState?.creds?.me?.name || '',
      wid,
      me: wid,
      lid: user.lid ? toWid(user.lid) : undefined,
      platform: this.authState?.creds?.platform || 'baileys',
      engine: 'baileys'
    }
  }

  _onClose (lastDisconnect) {
    const err = lastDisconnect?.error
    const code = err?.output?.statusCode ?? err?.statusCode ?? null
    if (this.destroyed) return
    this.qr = null
    // Só a message do Boom/erro (ex.: "Connection Terminated"); nunca credencial nem QR.
    const reason = String(err?.message || '').slice(0, 200) || null
    const terminalCodes = [DisconnectCode.loggedOut, DisconnectCode.connectionReplaced, DisconnectCode.forbidden, DisconnectCode.multideviceMismatch]
    if (terminalCodes.includes(code)) {
      logger.warn({ sessionId: this.sessionId, code, reason }, 'Conexão Baileys encerrada sem reconexão')
    }
    if (code === DisconnectCode.loggedOut) {
      this.loggedOut = true
      this.terminal = true
      this._setState('UNPAIRED')
      this.emit('disconnected', 'LOGOUT')
      this.emit('logged_out')
      return
    }
    if (code === DisconnectCode.connectionReplaced) {
      this.terminal = true
      this._setState('CONFLICT')
      this.emit('disconnected', 'CONFLICT')
      return
    }
    if (code === DisconnectCode.forbidden || code === DisconnectCode.multideviceMismatch) {
      this.terminal = true
      this._setState('UNPAIRED')
      this.emit('auth_failure', err?.message || `connection closed (${code})`)
      this.emit('disconnected', code === DisconnectCode.forbidden ? 'FORBIDDEN' : 'MULTIDEVICE_MISMATCH')
      return
    }
    // restartRequired (515) acontece logo depois de ler o QR: reconecta na hora, sem contar como queda.
    // Aceita o 515 pelo statusCode, pelos attrs do stream:error (err.data) ou pela mensagem; e um 428 que chega
    // logo após o pareamento (antes do primeiro open) também é o restart pós-QR.
    if (this._isRestartRequired(err, code)) {
      this.justPaired = false
      logger.info({ sessionId: this.sessionId, code, reason, syncFullHistory: this.socketSyncFullHistory() }, 'Restart pós-QR (515): reconectando na hora')
      this._scheduleReconnect(0)
      return
    }
    this.reconnectAttempts++
    if (this.connectedOnce) {
      this._setState('OPENING')
      if (this.reconnectAttempts >= DISCONNECT_NOTIFY_AFTER_FAILURES && !this.disconnectNotified) {
        this.disconnectNotified = true
        this.emit('disconnected', 'CONNECTION_LOST')
      }
    } else {
      this._setState('STARTING')
    }
    const delay = Math.min(1000 * (2 ** Math.min(this.reconnectAttempts - 1, 5)), MAX_RECONNECT_DELAY_MS)
    logger.warn({ sessionId: this.sessionId, code, reason, delay, attempt: this.reconnectAttempts, syncFullHistory: this.lastSocketSyncFullHistory }, 'Conexão Baileys fechada; reconectando')
    this._scheduleReconnect(delay)
  }

  _isRestartRequired (err, code) {
    if (code === DisconnectCode.restartRequired) return true
    const attrCode = Number(err?.data?.attrs?.code ?? err?.data?.code)
    if (attrCode === DisconnectCode.restartRequired) return true
    if (/restart required/i.test(String(err?.message || ''))) return true
    return this.justPaired && !this.connectedOnce && code === DisconnectCode.connectionClosed
  }

  _scheduleReconnect (delay) {
    if (this.destroyed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.destroyed) return
      try {
        this._connect()
      } catch (err) {
        logger.error({ sessionId: this.sessionId, err }, 'Falha ao reconectar o socket Baileys')
        this._scheduleReconnect(MAX_RECONNECT_DELAY_MS)
      }
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  async destroy () {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const sock = this.sock
    this.sock = null
    this.qr = null
    try {
      sock?.end?.(undefined)
    } catch (err) {
      logger.warn({ sessionId: this.sessionId, err }, 'Falha ao encerrar socket Baileys')
    }
    try {
      sock?.ev?.removeAllListeners?.()
    } catch { /* ignore */ }
    await this.store.flush().catch(() => { })
    this.store.close()
  }

  async logout () {
    const sock = this.sock
    if (sock && this.state === 'CONNECTED') {
      try {
        await withTimeout(sock.logout(), 10000, 'logout')
      } catch (err) {
        logger.warn({ sessionId: this.sessionId, err: err.message }, 'Logout no WhatsApp falhou; encerrando socket mesmo assim')
      }
    }
    await this.destroy()
  }

  getStateSync () {
    return this.state
  }

  /** Sessão já pareada (creds registradas) — usada para não apagar credencial de quem só está reconectando. */
  isRegistered () {
    // No pareamento por QR o Baileys preenche creds.me (registered só vira true no código de pareamento).
    const creds = this.authState?.creds
    return !!(creds?.registered || creds?.me?.id) || this.connectedOnce
  }

  /** syncFullHistory do próximo socket: false até parear; depois, BAILEYS_SYNC_FULL_HISTORY / setBackgroundSync. */
  socketSyncFullHistory () {
    return this.isRegistered() ? this.backgroundSync : false
  }

  async getState () {
    return this.state === 'CONNECTED' ? 'CONNECTED' : this.state
  }

  _sock () {
    if (!this.sock || this.state !== 'CONNECTED') {
      throw new Error('session_not_connected')
    }
    return this.sock
  }

  // ===== Eventos do Baileys → eventos estilo whatsapp-web.js =====

  // Não processa no handler do socket: enfileira e devolve na hora (o histórico pode ter milhares de mensagens).
  _onHistory (payload = {}) {
    this.historyQueue = this.historyQueue
      .then(() => this._processHistory(payload))
      .catch((err) => logger.error({ sessionId: this.sessionId, err }, 'Falha ao processar messaging-history.set'))
    return this.historyQueue
  }

  async _processHistory ({ chats = [], contacts = [], messages = [], lidPnMappings = [], isLatest, progress, syncType, peerDataRequestSessionId } = {}) {
    for (const m of lidPnMappings || []) this.store.addLidMapping(m?.lid, m?.pn)
    for (let i = 0; i < (contacts || []).length; i++) {
      if (i && i % HISTORY_CHUNK === 0) await yieldLoop()
      this.store.upsertContact(contacts[i])
    }
    for (let i = 0; i < (chats || []).length; i++) {
      if (i && i % HISTORY_CHUNK === 0) await yieldLoop()
      this.store.applyBaileysChat(chats[i])
    }
    const fresh = []
    const chatJids = new Set()
    const typeName = historySyncTypeName(syncType)
    for (let i = 0; i < (messages || []).length; i++) {
      if (i && i % HISTORY_CHUNK === 0) await yieldLoop()
      let raw = messages[i]
      if (!raw?.key?.id || !raw.key.remoteJid || raw.key.remoteJid === 'status@broadcast') continue
      const incomingChat = this.store.canonicalChatId(raw.key.remoteJid, raw.key.remoteJidAlt)
      chatJids.add(incomingChat)
      if (typeName === 'ON_DEMAND') {
        const target = this._onDemandTarget(raw.key.remoteJid)
        if (target && target !== incomingChat) {
          raw = { ...raw, key: { ...raw.key, remoteJid: toBaileysJid(target) } }
          chatJids.add(target)
        }
      }
      const storedChat = this.store.canonicalChatId(raw.key.remoteJid, raw.key.remoteJidAlt)
      chatJids.add(storedChat)
      const known = !!this.store.getMessage(storedChat, raw.key.id)
      this.store.upsertMessage(raw)
      if (known) continue
      const ckey = contentKey(unwrapContent(raw.message))
      if (!ckey || ckey === 'protocolMessage' || ckey === 'reactionMessage') continue
      fresh.push(raw)
    }
    this.historyState = {
      syncType: typeName,
      progress: progress ?? null,
      isLatest: isLatest ?? null,
      chunks: this.historyState.chunks + 1,
      messages: this.historyState.messages + fresh.length,
      at: Date.now()
    }
    if (typeName === 'ON_DEMAND') {
      this._resolveOnDemand({ peerDataRequestSessionId, chatIds: chatJids, syncType: typeName, progress: progress ?? null, isLatest: isLatest ?? null, received: fresh.length })
    }
    this.emit('history_sync', { syncType: typeName, progress: progress ?? null, isLatest: isLatest ?? null, chats: (chats || []).length, messages: (messages || []).length, fresh: fresh.length })
    if (isLatest === true && (typeName === 'INITIAL_BOOTSTRAP' || typeName === 'RECENT' || typeName === 'FULL')) {
      this.emit('history_ready', {
        syncType: typeName,
        isLatest: true,
        chats: (chats || []).length,
        messages: (messages || []).length
      })
    }
    await this._emitHistoryMessages(fresh)
  }

  // Webhook só para id novo e dentro da janela de idade: o ingest do Floume trata webhook "message" como
  // mensagem ao vivo (chatbot, notificação, lead scoring). O restante do histórico chega ao CRM pelo
  // fetchMessages (syncHistoryForChat), que promove como histórico.
  async _emitHistoryMessages (fresh) {
    const maxAge = Number(this.options.historyWebhookMaxAgeSeconds ?? 900)
    if (maxAge === 0) return
    const now = Math.floor(Date.now() / 1000)
    let sent = 0
    for (const raw of fresh) {
      const ts = toNumber(raw.messageTimestamp)
      if (maxAge > 0 && (!ts || now - ts > maxAge)) continue
      if (sent && sent % HISTORY_CHUNK === 0) await yieldLoop()
      const msg = new BaileysMessage(this, raw)
      if (raw.key.fromMe) {
        this.emit('message_create', msg)
      } else {
        this.emit('message', msg)
      }
      sent++
    }
  }

  _onHistoryStatus (st = {}) {
    const name = historySyncTypeName(st.syncType)
    if (name) this.historyStatus[name] = { status: st.status, explicit: !!st.explicit, at: Date.now() }
  }

  _waitOnDemand (chatId, timeoutMs) {
    const waiter = { chatId, requestId: null, done: false }
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = (value) => {
        if (waiter.done) return
        waiter.done = true
        clearTimeout(waiter.timer)
        this.onDemandWaiters = this.onDemandWaiters.filter((w) => w !== waiter)
        resolve(value)
      }
      waiter.timer = setTimeout(() => waiter.resolve(null), timeoutMs)
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
    })
    this.onDemandWaiters.push(waiter)
    return waiter
  }

  _resolveOnDemand (result) {
    const { peerDataRequestSessionId, chatIds } = result
    const pending = this.onDemandWaiters.filter((w) => !w.done)
    const match = (peerDataRequestSessionId && pending.find((w) => w.requestId === peerDataRequestSessionId)) ||
      pending.find((w) => this._sameOnDemandChat(w.chatId, chatIds)) ||
      (!chatIds.size ? pending[0] : null)
    if (match) match.resolve(result)
  }

  _onChatsUpdate (updates) {
    for (const u of updates || []) {
      const before = this.store.getChat(toWwebjsId(u.id))
      const prevArchived = before ? !!before.archived : false
      const prevUnread = before ? (before.unreadCount || 0) : 0
      // No chats.update do Baileys, unreadCount > 0 é incremento (mensagem nova); -1 = marcado como não lido.
      if (typeof u.unreadCount === 'number') {
        if (u.unreadCount > 0) u.unreadCount = prevUnread + u.unreadCount
        else if (u.unreadCount < 0) u.unreadCount = Math.max(prevUnread, 1)
      }
      this.store.applyBaileysChat(u)
      const after = this.store.getChat(toWwebjsId(u.id))
      if (!after) continue
      const chatJson = serializeChat(after, { store: this.store, meId: this.meId })
      const base = { chat: chatJson, id: chatJson.id, chatId: chatJson.id._serialized }
      if (u.archived != null && !!u.archived !== prevArchived) {
        this.emit('chat_archived', { ...base, archived: !!u.archived, currState: !!u.archived, prevState: prevArchived })
      }
      if (u.unreadCount != null && after.unreadCount !== prevUnread) {
        this.emit('unread_count', { ...base, unreadCount: after.unreadCount })
      }
    }
  }

  _onMessagesUpsert ({ messages = [], type } = {}) {
    for (const raw of messages) {
      if (!raw?.key?.id || !raw.key.remoteJid) continue
      if (raw.key.remoteJid === 'status@broadcast') continue
      const content = unwrapContent(raw.message)
      const ckey = contentKey(content)
      const known = !!this.store.getMessage(this.store.canonicalChatId(raw.key.remoteJid, raw.key.remoteJidAlt), raw.key.id)
      // Enviada pela API: já está no store (_wrapSent), mas o message_create ainda precisa sair uma vez.
      const sentByApi = this.pendingOwnSends.delete(raw.key.id)
      const isNew = !known || sentByApi

      if (ckey === 'protocolMessage') {
        this._onProtocolMessage(raw, content.protocolMessage)
        continue
      }
      if (ckey === 'reactionMessage') {
        this._emitReaction(raw, content.reactionMessage)
        continue
      }
      if (!ckey) {
        // sem conteúdo (stub, chave de grupo, mensagem que não decriptou): só guarda
        this.store.upsertMessage(raw)
        continue
      }
      this.store.upsertMessage(raw)
      if (!isNew) continue
      if (raw.pushName && !raw.key.fromMe) {
        const sender = raw.key.participant || raw.key.remoteJid
        if (!isGroupJid(sender)) this.store.upsertContact({ id: sender, notify: raw.pushName })
      }
      const msg = new BaileysMessage(this, raw)
      if (!raw.key.fromMe && (type === 'notify' || type === 'append')) {
        this.emit('message', msg)
      }
      this.emit('message_create', msg)
    }
  }

  _onProtocolMessage (raw, proto) {
    const type = proto?.type
    const target = proto?.key
    if (!target?.id) return
    const chatId = this.store.canonicalChatId(raw.key.remoteJid, raw.key.remoteJidAlt)
    const original = this.store.getMessage(chatId, target.id)
    // 0 = REVOKE
    if (type === 0 || type === 'REVOKE') {
      const revokedMsg = original ? new BaileysMessage(this, original) : undefined
      const msg = new BaileysMessage(this, raw)
      const protocolMessageKey = { id: target.id, remote: chatId, fromMe: !!target.fromMe }
      msg.type = 'revoked'
      msg._data.type = 'revoked'
      msg._data.protocolMessageKey = protocolMessageKey
      msg.protocolMessageKey = protocolMessageKey
      if (original) this.store.updateMessage(original.key, { message: null, messageStubType: 1 })
      this.emit('message_revoke_everyone', msg, revokedMsg)
      return
    }
    // 14 = MESSAGE_EDIT
    if (type === 14 || type === 'MESSAGE_EDIT') {
      const newBody = messageBody(unwrapContent(proto.editedMessage))
      const prevBody = original ? messageBody(unwrapContent(original.message)) : undefined
      if (original) {
        this.store.updateMessage(original.key, { message: proto.editedMessage })
        this.emit('message_edit', new BaileysMessage(this, this.store.getMessage(chatId, target.id)), newBody, prevBody)
      } else {
        this.emit('message_edit', new BaileysMessage(this, { ...raw, key: { ...raw.key, id: target.id }, message: proto.editedMessage }), newBody, prevBody)
      }
    }
  }

  _emitReaction (raw, reaction) {
    const targetKey = reaction?.key
    if (!targetKey?.id) return
    const chatId = this.store.canonicalChatId(raw.key.remoteJid, raw.key.remoteJidAlt)
    const fromMe = !!raw.key.fromMe
    const sender = fromMe
      ? this.meId
      : this.store.canonicalChatId(raw.key.participant || raw.key.remoteJid, raw.key.participantAlt || raw.key.remoteJidAlt)
    const targetFromMe = !!targetKey.fromMe
    const reactionId = { fromMe, remote: chatId, id: raw.key.id, _serialized: `${fromMe}_${chatId}_${raw.key.id}` }
    this.emit('message_reaction', {
      id: reactionId,
      orphan: 0,
      reaction: reaction.text || '',
      timestamp: Math.floor(toNumber(reaction.senderTimestampMs) / 1000) || toNumber(raw.messageTimestamp),
      read: false,
      msgId: { fromMe: targetFromMe, remote: chatId, id: targetKey.id, _serialized: `${targetFromMe}_${chatId}_${targetKey.id}` },
      senderId: sender,
      fromMe,
      ack: 1
    })
  }

  _onMessagesUpdate (list) {
    for (const { key, update } of list || []) {
      if (!key?.id || !update) continue
      if (update.status != null) {
        const stored = this.store.updateMessage(key, { status: update.status })
        const base = stored || { key, messageTimestamp: Math.floor(Date.now() / 1000), status: update.status }
        const msg = new BaileysMessage(this, base)
        this.emit('message_ack', msg, Number(update.status) - 1)
      }
      if (update.starred != null) this.store.updateMessage(key, { starred: update.starred })
    }
  }

  _onGroupParticipants ({ id, participants = [], action, author } = {}) {
    this._invalidateGroup(id)
    const map = { add: 'group_join', remove: 'group_leave', promote: 'group_admin_changed', demote: 'group_admin_changed' }
    const event = map[action]
    if (!event) return
    const ids = participants.map((p) => this.store.canonicalChatId(typeof p === 'string' ? p : p?.id, typeof p === 'string' ? undefined : (p?.phoneNumber || p?.lid)))
    this.emit(event, {
      id: { remote: toWwebjsId(id), _serialized: toWwebjsId(id) },
      chatId: toWwebjsId(id),
      author: author ? toWwebjsId(author) : undefined,
      type: action,
      recipientIds: ids,
      timestamp: Math.floor(Date.now() / 1000)
    })
  }

  _invalidateGroup (jid) {
    if (jid) this.groupCache.delete(jid)
  }

  async _groupMetadata (jid) {
    const cached = this.groupCache.get(jid)
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.meta
    const meta = await this._sock().groupMetadata(jid)
    this.groupCache.set(jid, { meta, at: Date.now() })
    if (meta?.subject) this.store.upsertChat(jid, { name: meta.subject })
    return meta
  }

  _rememberOnDemand (chatId) {
    const digits = phoneDigits(chatId)
    if (!digits) return
    const now = Date.now()
    this.recentOnDemand = this.recentOnDemand.filter((row) => now - row.at < ON_DEMAND_ALIAS_MS)
    this.recentOnDemand.push({ chatId, digits, at: now })
  }

  _onDemandTarget (remoteJid) {
    const digits = phoneDigits(remoteJid)
    if (!digits) return null
    const now = Date.now()
    for (let i = this.recentOnDemand.length - 1; i >= 0; i--) {
      const row = this.recentOnDemand[i]
      if (now - row.at >= ON_DEMAND_ALIAS_MS) continue
      if (row.digits === digits) return row.chatId
    }
    return null
  }

  _sameOnDemandChat (chatId, chatIds) {
    if (chatIds.has(chatId)) return true
    const digits = phoneDigits(chatId)
    if (!digits) return false
    for (const id of chatIds) {
      if (phoneDigits(id) === digits) return true
    }
    return false
  }

  _requestOlderHistory (chatId) {
    if (!this.backgroundSync) return
    const last = this.historyRequests.get(chatId) || 0
    if (Date.now() - last < HISTORY_REQUEST_COOLDOWN_MS) return
    this.historyRequests.set(chatId, Date.now())
    this.syncHistory(chatId, { timeoutMs: 0 }).catch(() => { })
  }

  // ===== Mídia =====

  async _downloadMedia (raw) {
    const b = this.baileys
    const content = unwrapContent(raw.message)
    const ckey = contentKey(content)
    if (!MEDIA_KEYS.has(ckey)) return undefined
    const inner = content[ckey]
    const sock = this._sock()
    const buffer = await b.downloadMediaMessage(
      { ...raw, message: content },
      'buffer',
      {},
      { logger: this._baileysLogger(), reuploadRequest: sock.updateMediaMessage }
    )
    return new MessageMedia(inner.mimetype || 'application/octet-stream', Buffer.from(buffer).toString('base64'), inner.fileName || null, buffer.length)
  }

  // ===== Envio =====

  async _resolveSendJid (chatId) {
    const raw = String(chatId || '').trim()
    if (!raw) throw new Error('chatId is required')
    if (isNewsletterJid(raw)) throw new NotSupportedError('channels')
    return toBaileysJid(raw)
  }

  _wrapSent (sent) {
    if (!sent) return null
    if (sent.key?.id) {
      this.pendingOwnSends.add(sent.key.id)
      if (this.pendingOwnSends.size > 1000) this.pendingOwnSends.delete(this.pendingOwnSends.values().next().value)
    }
    this.store.upsertMessage(sent)
    return new BaileysMessage(this, sent)
  }

  async _buildMediaContent (media, options = {}, caption) {
    const buffer = Buffer.from(media.data, 'base64')
    const mimetype = String(media.mimetype || 'application/octet-stream')
    const base = mimetype.split(';')[0].trim().toLowerCase()
    const text = caption ?? options.caption ?? ''
    if (options.sendMediaAsSticker) {
      return { sticker: await this._toWebp(buffer, base) }
    }
    if (options.sendMediaAsDocument) {
      return { document: buffer, mimetype, fileName: media.filename || 'file', caption: text || undefined }
    }
    if (base.startsWith('image/') && base !== 'image/gif') {
      return { image: buffer, mimetype: base, caption: text || undefined }
    }
    if (base === 'image/gif') {
      return { image: buffer, mimetype: base, caption: text || undefined }
    }
    if (base.startsWith('video/')) {
      return { video: buffer, mimetype: base, caption: text || undefined, gifPlayback: !!options.sendVideoAsGif }
    }
    if (base.startsWith('audio/')) {
      const ptt = !!options.sendAudioAsVoice
      return { audio: buffer, mimetype: ptt ? 'audio/ogg; codecs=opus' : mimetype, ptt }
    }
    return { document: buffer, mimetype, fileName: media.filename || 'file', caption: text || undefined }
  }

  async _toWebp (buffer, mimetype) {
    if (mimetype === 'image/webp') return buffer
    try {
      const sharp = require('sharp')
      return await sharp(buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer()
    } catch (err) {
      logger.warn({ sessionId: this.sessionId, err: err.message }, 'Conversão de figurinha para webp indisponível; enviando arquivo original')
      return buffer
    }
  }

  _quotedFromOptions (options = {}) {
    if (options.quotedMessage) return options.quotedMessage
    if (options.quotedMessageId) {
      const parsed = parseMessageId(options.quotedMessageId)
      if (parsed.remote) return this.store.getMessage(parsed.remote, parsed.id)
      return this.store.findMessageById(parsed.id)
    }
    return undefined
  }

  async sendMessage (chatId, content, options = {}) {
    const jid = await this._resolveSendJid(chatId)
    const sock = this._sock()
    let payload
    if (typeof content === 'string') {
      if (options.media instanceof MessageMedia) {
        payload = await this._buildMediaContent(options.media, options, content)
      } else {
        payload = { text: content }
      }
    } else if (content instanceof MessageMedia) {
      payload = await this._buildMediaContent(content, options)
    } else if (content instanceof Location) {
      payload = { location: { degreesLatitude: Number(content.latitude), degreesLongitude: Number(content.longitude), name: content.name || content.description, address: content.address, url: content.url } }
    } else if (content instanceof Poll) {
      const values = content.pollOptions
      payload = { poll: { name: content.pollName, values, selectableCount: content.options.allowMultipleAnswers ? values.length : 1 } }
    } else if (content instanceof BaileysContact) {
      const name = content.name || content.pushname || content.number || content.id.user
      const number = content.number || content.id.user
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`
      payload = { contacts: { displayName: name, contacts: [{ vcard }] } }
    } else {
      throw new Error('invalid content')
    }
    if (Array.isArray(options.mentions) && options.mentions.length) {
      payload.mentions = options.mentions.map((m) => toBaileysJid(typeof m === 'string' ? m : m?.id?._serialized))
    }
    const quoted = this._quotedFromOptions(options)
    const sent = await sock.sendMessage(jid, payload, quoted ? { quoted } : undefined)
    return this._wrapSent(sent)
  }

  // ===== Consultas =====

  async getChats (searchOptions = {}) {
    let list = this.store.listChats()
    if (searchOptions?.unread === true) list = list.filter((c) => (c.unreadCount || 0) > 0)
    if (searchOptions?.since !== undefined && Number.isFinite(searchOptions.since)) list = list.filter((c) => (c.timestamp || 0) >= searchOptions.since)
    if (searchOptions?.limit > 0) list = list.slice(0, searchOptions.limit)
    return list.map((c) => new BaileysChat(this, c, isGroupJid(c.id) ? this.groupCache.get(c.jid)?.meta : undefined))
  }

  async getChatById (chatId) {
    const raw = String(chatId || '').trim()
    if (!raw) return undefined
    if (isNewsletterJid(raw)) throw new NotSupportedError('channels')
    const jid = toBaileysJid(raw)
    if (!jid || !jid.includes('@')) return undefined
    if (!isGroupJid(jid) && !isPnJid(jid) && !isLidJid(jid)) return undefined
    const existing = this.store.getChat(raw)
    const chat = existing || { id: this.store.canonicalChatId(jid), jid, unreadCount: 0, timestamp: 0, archived: false, pinned: 0, muteEndTime: 0 }
    let meta
    if (isGroupJid(jid)) {
      try {
        meta = await this._groupMetadata(jid)
      } catch (err) {
        if (!existing) return undefined
      }
    }
    return new BaileysChat(this, chat, meta)
  }

  findMessageById (messageId) {
    const parsed = parseMessageId(messageId)
    const raw = (parsed.remote && this.store.getMessage(parsed.remote, parsed.id)) || this.store.findMessageById(parsed.id)
    return raw ? new BaileysMessage(this, raw) : undefined
  }

  async getContacts () {
    return [...this.store.contacts.values()].map((c) => new BaileysContact(this, c))
  }

  async getContactById (contactId) {
    const jid = toBaileysJid(contactId)
    const stored = this.store.getContact(contactId)
    return new BaileysContact(this, stored || { id: this.store.canonicalChatId(jid) })
  }

  async getNumberId (number) {
    const digits = phoneDigits(number)
    if (!digits) return null
    // Número que na verdade é um LID já mapeado: devolve o telefone (forma que o Floume conhece)
    const knownPn = this.store.pnForLid(`${digits}@lid`)
    if (knownPn) return toWid(knownPn)
    const cached = this.numberIdCache.get(digits)
    if (cached && Date.now() < cached.expiresAt) return cached.value
    const res = await this._sock().onWhatsApp(digits)
    const hit = Array.isArray(res) ? res.find((r) => r?.exists) : null
    const value = hit ? toWid(hit.jid) : null
    if (hit?.lid) this.store.addLidMapping(hit.lid, hit.jid)
    this.numberIdCache.set(digits, { value, expiresAt: Date.now() + (value ? NUMBER_ID_TTL_MS : NUMBER_ID_MISS_TTL_MS) })
    return value
  }

  async isRegisteredUser (number) {
    return !!(await this.getNumberId(number))
  }

  async getProfilePicUrl (contactId) {
    try {
      return await this._sock().profilePictureUrl(toBaileysJid(contactId), 'image')
    } catch (err) {
      if (err?.message === 'session_not_connected') throw err
      return undefined
    }
  }

  async getBlockedContacts () {
    const list = await this._sock().fetchBlocklist()
    return (list || []).filter(Boolean).map((jid) => new BaileysContact(this, { ...(this.store.getContact(toWwebjsId(jid)) || {}), id: this.store.canonicalChatId(jid), isBlocked: true }))
  }

  async searchMessages (query, options = {}) {
    const q = String(query || '').toLowerCase()
    const limit = Number(options?.limit) > 0 ? Number(options.limit) : 50
    const page = Number(options?.page) > 0 ? Number(options.page) : 1
    const source = options?.chatId ? this.store.listMessages(options.chatId) : this.store.allMessages()
    const hits = source
      .filter((m) => messageBody(unwrapContent(m.message)).toLowerCase().includes(q))
      .sort((a, b) => toNumber(b.messageTimestamp) - toNumber(a.messageTimestamp))
    return hits.slice((page - 1) * limit, page * limit).map((m) => new BaileysMessage(this, m))
  }

  async getContactLidAndPhone (userIds) {
    const ids = Array.isArray(userIds) ? userIds : [userIds]
    const lidMapping = this.sock?.signalRepository?.lidMapping
    const out = []
    for (const id of ids) {
      const jid = toBaileysJid(id)
      let lid = null
      let pn = null
      if (isLidJid(jid)) {
        lid = toWwebjsId(jid)
        pn = this.store.pnForLid(jid)
        if (!pn && lidMapping?.getPNForLID) pn = toWwebjsId(await lidMapping.getPNForLID(jid).catch(() => null) || '') || null
        if (pn) this.store.addLidMapping(jid, toBaileysJid(pn))
      } else if (isPnJid(jid)) {
        pn = toWwebjsId(jid)
        for (const [l, p] of this.store.lidToPn) if (p === pn) lid = l
        if (!lid && lidMapping?.getLIDForPN) lid = toWwebjsId(await lidMapping.getLIDForPN(jid).catch(() => null) || '') || null
      }
      out.push({ lid, pn })
    }
    return out
  }

  // ===== Ações =====

  async sendSeen (chatId) { return (await this._chatOrThrow(chatId)).sendSeen() }
  async archiveChat (chatId) { return (await this._chatOrThrow(chatId)).archive() }
  async unarchiveChat (chatId) { return (await this._chatOrThrow(chatId)).unarchive() }
  async pinChat (chatId) { return (await this._chatOrThrow(chatId)).pin() }
  async unpinChat (chatId) { return (await this._chatOrThrow(chatId)).unpin() }
  async muteChat (chatId, unmuteDate) { return (await this._chatOrThrow(chatId)).mute(unmuteDate) }
  async unmuteChat (chatId) { return (await this._chatOrThrow(chatId)).unmute() }
  async markChatUnread (chatId) { return (await this._chatOrThrow(chatId)).markUnread() }

  async _chatOrThrow (chatId) {
    const chat = await this.getChatById(chatId)
    if (!chat) throw new Error('Chat not Found')
    return chat
  }

  /**
   * Pede ao celular mensagens anteriores à mais antiga já guardada (HISTORY_SYNC_ON_DEMAND).
   * A resposta chega como messaging-history.set syncType ON_DEMAND; espera até o timeout para o
   * fetchMessages seguinte do CRM já enxergar as mensagens novas.
   */
  async syncHistory (chatId, options = {}) {
    if (!this.sock || this.state !== 'CONNECTED') {
      throw new HistorySyncError('history_sync_not_connected', 422)
    }
    const count = Number(options.count) > 0 ? Math.floor(Number(options.count)) : 50
    const canonical = this.store.canonicalChatId(toBaileysJid(chatId))
    const withKey = this.store.listMessages(canonical).filter((m) => m?.key?.id && m.key.remoteJid)
    let oldest = null
    for (const message of withKey) {
      if (!oldest || toNumber(message.messageTimestamp) < toNumber(oldest.messageTimestamp)) oldest = message
    }
    if (!oldest) {
      return { success: true, message: 'history_sync_waiting_initial' }
    }
    const key = { remoteJid: oldest.key.remoteJid, id: oldest.key.id, fromMe: !!oldest.key.fromMe }
    if (oldest.key.participant) key.participant = oldest.key.participant
    this._rememberOnDemand(canonical)
    const timeoutMs = Number(options.timeoutMs ?? this.options.historyOnDemandTimeoutMs ?? 15000)
    const waiter = this._waitOnDemand(canonical, timeoutMs)
    let requestId
    try {
      requestId = await this.sock.fetchMessageHistory(count, key, toNumber(oldest.messageTimestamp))
    } catch (err) {
      waiter.resolve(null)
      throw err
    }
    waiter.requestId = requestId || null
    const result = await waiter.promise
    if (!result) {
      // Pedido aceito; a resposta do celular ainda não chegou (o store recebe quando chegar).
      return { success: true, syncType: 'ON_DEMAND', progress: null, isLatest: false, pending: true, requestId: requestId || null, count }
    }
    return { success: true, syncType: result.syncType, progress: result.progress, isLatest: result.isLatest, received: result.received, requestId: requestId || null, count }
  }

  /** flag true mantém syncFullHistory; false desliga nas próximas conexões sem apagar o que já chegou. */
  async setBackgroundSync (flag) {
    // Liga/desliga syncFullHistory nas próximas conexões (perfil continua Chrome sem a env explícita).
    this.backgroundSync = flag !== false && flag !== 'false'
    return this.backgroundSync
  }

  getHistorySyncState () {
    return { ...this.historyState, status: { ...this.historyStatus }, backgroundSync: this.backgroundSync }
  }

  async sendPresenceAvailable () {
    await this._sock().sendPresenceUpdate('available')
    return true
  }

  async sendPresenceUnavailable () {
    await this._sock().sendPresenceUpdate('unavailable')
    return true
  }

  async setStatus (status) {
    await this._sock().updateProfileStatus(String(status ?? ''))
    return true
  }

  async setDisplayName (displayName) {
    await this._sock().updateProfileName(String(displayName ?? ''))
    return true
  }

  async setProfilePicture (media) {
    await this._sock().updateProfilePicture(toBaileysJid(this.meId), Buffer.from(media.data, 'base64'))
    return true
  }

  async deleteProfilePicture () {
    await this._sock().removeProfilePicture(toBaileysJid(this.meId))
    return true
  }

  async createGroup (title, participants = []) {
    const jids = (Array.isArray(participants) ? participants : [participants]).map((p) => toBaileysJid(typeof p === 'string' ? p : p?.id?._serialized))
    const meta = await this._sock().groupCreate(title, jids)
    const result = {}
    for (const p of meta?.participants || []) result[toWwebjsId(p.id)] = { statusCode: 200, message: 'The participant was added to the group successfully', isGroupCreator: p.admin === 'superadmin', isInviteV4Sent: false }
    return { title, gid: toWid(meta.id), participants: result }
  }

  async acceptInvite (inviteCode) {
    return toWwebjsId(await this._sock().groupAcceptInvite(inviteCode))
  }

  async getInviteInfo (inviteCode) {
    const meta = await this._sock().groupGetInviteInfo(inviteCode)
    return serializeGroupMetadata(meta, this)
  }

  async getWWebVersion () {
    return this.baileysVersion ? this.baileysVersion.join('.') : 'baileys'
  }

  async requestPairingCode (phoneNumber) {
    const digits = phoneDigits(phoneNumber)
    if (!digits) throw new Error('phoneNumber is required')
    if (this.state === 'CONNECTED' || this.isRegistered()) {
      throw new Error('session already paired')
    }
    // O socket precisa estar aberto (primeiro QR emitido) para aceitar o pedido de código.
    const deadline = Date.now() + 20000
    while (!this.qr && Date.now() < deadline && !this.destroyed) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!this.sock) throw new Error('session_not_ready')
    const code = await this.sock.requestPairingCode(digits)
    this.emit('code', code)
    return code
  }
}

// Métodos do whatsapp-web.js sem equivalente no Baileys: respondem 501 (not_supported_by_baileys).
const UNSUPPORTED_CLIENT_METHODS = [
  'getCommonGroups', 'getLabels', 'getLabelById', 'getChatLabels', 'getChatsByLabelId', 'addOrRemoveLabels',
  'getContactDeviceCount', 'getCountryCode', 'getFormattedNumber', 'setAutoDownloadAudio', 'setAutoDownloadDocuments',
  'setAutoDownloadPhotos', 'setAutoDownloadVideos', 'resetState', 'getChannels',
  'getChannelByInviteCode', 'createChannel', 'subscribeToChannel', 'unsubscribeFromChannel', 'searchChannels'
]
for (const name of UNSUPPORTED_CLIENT_METHODS) {
  BaileysClient.prototype[name] = async function () { throw new NotSupportedError(`client.${name}`) }
}

module.exports = { BaileysClient, BaileysChat, BaileysMessage, BaileysContact, DisconnectCode, HistorySyncError, lightContent, historySyncTypeName }
