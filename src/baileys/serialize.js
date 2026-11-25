// Converte mensagens/chats/contatos do Baileys para o JSON que o whatsapp-web.js produzia
// (o formato que o wwebjs-ingest e o sync do Floume já parseiam).
const { toWid, toWwebjsId, isGroupJid, isLidJid } = require('./jid')
const { toNumber } = require('./store')

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'groupMentionedMessage',
  'botInvokeMessage'
]

/** Desembrulha ephemeral/viewOnce/documentWithCaption até o conteúdo real. */
const unwrapContent = (message) => {
  let content = message || null
  for (let i = 0; i < 5 && content; i++) {
    const wrapper = WRAPPERS.find((k) => content[k]?.message)
    if (!wrapper) break
    content = content[wrapper].message
  }
  return content
}

const IGNORED_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

const contentKey = (content) => {
  if (!content) return null
  return Object.keys(content).find((k) => !IGNORED_KEYS.has(k) && content[k] != null) || null
}

const MEDIA_KEYS = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'])

/** Tipo whatsapp-web.js (MessageTypes) para o conteúdo do Baileys. */
const messageType = (content) => {
  const key = contentKey(content)
  switch (key) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'chat'
    case 'imageMessage':
      return 'image'
    case 'videoMessage':
    case 'ptvMessage':
      return 'video'
    case 'audioMessage':
      return content.audioMessage?.ptt ? 'ptt' : 'audio'
    case 'documentMessage':
      return 'document'
    case 'stickerMessage':
      return 'sticker'
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location'
    case 'contactMessage':
      return 'vcard'
    case 'contactsArrayMessage':
      return 'multi_vcard'
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return 'poll_creation'
    case 'pollUpdateMessage':
      return 'poll_update'
    case 'reactionMessage':
      return 'reaction'
    case 'protocolMessage':
      return content.protocolMessage?.type === 0 ? 'revoked' : 'protocol'
    case 'buttonsResponseMessage':
    case 'templateButtonReplyMessage':
      return 'buttons_response'
    case 'listResponseMessage':
      return 'list_response'
    case 'buttonsMessage':
    case 'templateMessage':
    case 'interactiveMessage':
      return 'buttons'
    case 'listMessage':
      return 'list'
    case 'orderMessage':
      return 'order'
    case 'productMessage':
      return 'product'
    case 'groupInviteMessage':
      return 'groups_v4_invite'
    case 'call':
    case 'bcallMessage':
      return 'call_log'
    case null:
      return 'unknown'
    default:
      return 'unknown'
  }
}

const messageBody = (content) => {
  const key = contentKey(content)
  if (!key) return ''
  const inner = content[key]
  switch (key) {
    case 'conversation':
      return content.conversation || ''
    case 'extendedTextMessage':
      return inner?.text || ''
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
    case 'ptvMessage':
      return inner?.caption || ''
    case 'contactMessage':
      return inner?.vcard || ''
    case 'locationMessage':
    case 'liveLocationMessage':
      return inner?.name || inner?.caption || ''
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return inner?.name || ''
    case 'buttonsResponseMessage':
      return inner?.selectedDisplayText || inner?.selectedButtonId || ''
    case 'templateButtonReplyMessage':
      return inner?.selectedDisplayText || inner?.selectedId || ''
    case 'listResponseMessage':
      return inner?.title || inner?.singleSelectReply?.selectedRowId || ''
    case 'buttonsMessage':
      return inner?.contentText || ''
    case 'listMessage':
      return inner?.description || inner?.title || ''
    case 'reactionMessage':
      return inner?.text || ''
    default:
      return ''
  }
}

const contextInfoOf = (content) => {
  const key = contentKey(content)
  return (key && content[key] && typeof content[key] === 'object' && content[key].contextInfo) || null
}

/** ID serializado igual ao do whatsapp-web.js: fromMe_remote_id[_participant] */
const serializeMessageId = ({ fromMe, remote, id, participant }) => {
  const base = `${fromMe ? 'true' : 'false'}_${remote}_${id}`
  return participant ? `${base}_${participant}` : base
}

/** Aceita id "puro" (ABCD123) ou serializado (true_5511…@c.us_ABCD123[_participant]). */
const parseMessageId = (value) => {
  const raw = String(value || '').trim()
  const match = raw.match(/^(true|false)_([^_]+@[^_]+)_([^_]+)(?:_(.+))?$/)
  if (match) {
    return { fromMe: match[1] === 'true', remote: match[2], id: match[3], participant: match[4] || null }
  }
  return { fromMe: null, remote: null, id: raw, participant: null }
}

/**
 * Serializa um WAMessage do Baileys para o formato JSON do Message do whatsapp-web.js.
 * ctx: { store, meId, ack? }
 */
const serializeMessage = (msg, ctx = {}) => {
  const { store, meId } = ctx
  const key = msg?.key || {}
  const content = unwrapContent(msg?.message)
  const ckey = contentKey(content)
  const inner = ckey ? content[ckey] : null
  const type = messageType(content)
  const fromMe = !!key.fromMe
  const remote = store ? store.canonicalChatId(key.remoteJid, key.remoteJidAlt) : toWwebjsId(key.remoteJid)
  const isGroup = isGroupJid(remote)
  const participantRaw = key.participant || msg?.participant || null
  const participant = participantRaw
    ? (store ? store.canonicalChatId(participantRaw, key.participantAlt) : toWwebjsId(participantRaw))
    : null
  const me = meId || ''
  const timestamp = toNumber(msg?.messageTimestamp)
  const ctxInfo = contextInfoOf(content)
  const hasMedia = MEDIA_KEYS.has(ckey)
  const body = messageBody(content)
  const status = msg?.status != null ? Number(msg.status) : null
  // Baileys: ERROR=0 PENDING=1 SERVER_ACK=2 DELIVERY_ACK=3 READ=4 PLAYED=5
  // whatsapp-web.js: ERROR=-1 PENDING=0 SERVER=1 DEVICE=2 READ=3 PLAYED=4
  const ack = ctx.ack != null ? ctx.ack : (status != null ? status - 1 : (fromMe ? 1 : 0))

  const from = fromMe ? me : remote
  const to = fromMe ? remote : (me || remote)
  const author = isGroup ? (fromMe ? me : participant) : undefined

  const serializedId = serializeMessageId({ fromMe, remote, id: key.id, participant: isGroup && !fromMe ? participant : null })
  const id = { fromMe, remote, id: key.id, _serialized: serializedId }
  if (isGroup && participant) id.participant = toWid(participant)

  let quotedMsg = null
  if (ctxInfo?.quotedMessage) {
    const qContent = unwrapContent(ctxInfo.quotedMessage)
    quotedMsg = {
      type: messageType(qContent),
      body: messageBody(qContent),
      ...(ctxInfo.participant ? { author: store ? store.canonicalChatId(ctxInfo.participant) : toWwebjsId(ctxInfo.participant) } : {})
    }
  }

  const mentionedIds = (ctxInfo?.mentionedJid || []).map((j) => (store ? store.canonicalChatId(j) : toWwebjsId(j)))

  const _data = {
    id,
    body,
    type,
    t: timestamp,
    from,
    to,
    author,
    notifyName: msg?.pushName || msg?.verifiedBizName || undefined,
    ack,
    isNewMsg: true,
    star: !!msg?.starred,
    broadcast: !!msg?.broadcast,
    fromMe
  }
  if (isLidJid(key.remoteJid)) _data.lid = toWwebjsId(key.remoteJid)
  if (hasMedia && inner) {
    _data.mimetype = inner.mimetype || undefined
    _data.size = toNumber(inner.fileLength) || undefined
    _data.filename = inner.fileName || undefined
    _data.caption = inner.caption || undefined
    _data.duration = inner.seconds != null ? String(inner.seconds) : undefined
    _data.isViewOnce = !!(msg?.message?.viewOnceMessage || msg?.message?.viewOnceMessageV2)
    // Diferente do whatsapp-web.js (que punha a miniatura base64 aqui), _data.body leva a legenda,
    // que o ingest do Floume já trata como texto.
  }
  if (quotedMsg) {
    _data.quotedMsg = quotedMsg
    _data.quotedStanzaID = ctxInfo.stanzaId || undefined
    _data.quotedParticipant = ctxInfo.participant ? toWid(ctxInfo.participant) : undefined
  }

  const out = {
    _data,
    id,
    ack,
    hasMedia,
    body,
    type,
    timestamp,
    from,
    to,
    author,
    deviceType: guessDeviceType(key.id),
    isForwarded: !!ctxInfo?.isForwarded,
    forwardingScore: ctxInfo?.forwardingScore || 0,
    isStatus: key.remoteJid === 'status@broadcast',
    isStarred: !!msg?.starred,
    broadcast: !!msg?.broadcast,
    fromMe,
    hasQuotedMsg: !!quotedMsg,
    hasReaction: false,
    duration: _data.duration,
    location: undefined,
    vCards: [],
    inviteV4: undefined,
    mentionedIds,
    groupMentions: [],
    isGif: !!(ckey === 'videoMessage' && inner?.gifPlayback),
    isEphemeral: !!msg?.message?.ephemeralMessage,
    links: []
  }
  if (out.type === 'location' && inner) {
    out.location = {
      latitude: inner.degreesLatitude,
      longitude: inner.degreesLongitude,
      description: [inner.name, inner.address].filter(Boolean).join('\n') || undefined,
      name: inner.name || undefined,
      address: inner.address || undefined,
      url: inner.url || undefined
    }
  }
  if (out.type === 'vcard' && inner?.vcard) out.vCards = [inner.vcard]
  if (out.type === 'multi_vcard' && Array.isArray(inner?.contacts)) {
    out.vCards = inner.contacts.map((c) => c.vcard).filter(Boolean)
    out.body = inner.displayName || ''
    _data.body = out.body
  }
  if (out.type === 'poll_creation' && inner) {
    out.pollName = inner.name
    out.pollOptions = (inner.options || []).map((o, localId) => ({ name: o.optionName, localId }))
    out.allowMultipleAnswers = (inner.selectableOptionsCount || 0) !== 1
  }
  if (out.type === 'buttons_response' && inner) {
    out.selectedButtonId = inner.selectedButtonId || inner.selectedId
  }
  if (out.type === 'list_response' && inner) {
    out.selectedRowId = inner.singleSelectReply?.selectedRowId
  }
  return out
}

// whatsapp-web.js usa o prefixo do id para inferir o aparelho de origem.
const guessDeviceType = (id) => {
  const s = String(id || '')
  if (s.length > 21) return 'android'
  if (s.startsWith('3A')) return 'ios'
  if (s.startsWith('3EB0') || s.startsWith('BAE5')) return 'web'
  return 'unknown'
}

const serializeChat = (chat, ctx = {}) => {
  const { store, meId } = ctx
  const id = toWid(chat.id)
  const contact = store ? store.getContact(chat.id) : null
  const lastRaw = store ? store.listMessages(chat.id).slice(-1)[0] : null
  const muteEnd = toNumber(chat.muteEndTime)
  return {
    id,
    name: chat.name || contact?.name || contact?.notify || contact?.verifiedName || id?.user || '',
    isGroup: isGroupJid(chat.id),
    isReadOnly: false,
    unreadCount: chat.unreadCount || 0,
    timestamp: chat.timestamp || 0,
    archived: !!chat.archived,
    pinned: !!chat.pinned,
    isMuted: muteEnd === -1 || muteEnd * (muteEnd > 1e12 ? 1 : 1000) > Date.now(),
    muteExpiration: muteEnd > 1e12 ? Math.floor(muteEnd / 1000) : muteEnd,
    lastMessage: lastRaw ? serializeMessage(lastRaw, { store, meId }) : undefined,
    ...(isGroupJid(chat.id) && chat.groupMetadata ? { groupMetadata: chat.groupMetadata } : {})
  }
}

const serializeContact = (contact, ctx = {}) => {
  const { meId } = ctx
  const id = toWid(contact.id)
  const isGroup = isGroupJid(contact.id)
  const isUser = !isGroup && !String(contact.id).endsWith('@broadcast') && !String(contact.id).endsWith('@newsletter')
  return {
    id,
    number: isUser && !isLidJid(contact.id) ? id?.user : null,
    isBusiness: !!contact.verifiedName,
    isEnterprise: false,
    name: contact.name || undefined,
    pushname: contact.notify || undefined,
    shortName: contact.name ? String(contact.name).split(' ')[0] : undefined,
    verifiedName: contact.verifiedName || undefined,
    isMe: !!meId && id?._serialized === meId,
    isUser,
    isGroup,
    isWAContact: isUser,
    isMyContact: !!contact.name,
    isBlocked: !!contact.isBlocked,
    ...(contact.lid ? { lid: contact.lid } : {})
  }
}

module.exports = {
  unwrapContent,
  contentKey,
  messageType,
  messageBody,
  serializeMessage,
  serializeMessageId,
  parseMessageId,
  serializeChat,
  serializeContact,
  MEDIA_KEYS
}
