// Conversão entre o formato de ID que o Floume já usa (whatsapp-web.js: @c.us, @g.us, @lid)
// e o JID do Baileys (@s.whatsapp.net, @g.us, @lid).

const USER_SERVER_WWEBJS = 'c.us'
const USER_SERVER_BAILEYS = 's.whatsapp.net'

const splitJid = (value) => {
  const raw = String(value || '').trim()
  const at = raw.lastIndexOf('@')
  if (at < 0) return { user: raw, server: '' }
  return { user: raw.slice(0, at), server: raw.slice(at + 1) }
}

// Remove sufixo de device (":12") e de agente ("_1") do usuário de JIDs de pessoa.
const stripDevice = (user) => String(user || '').split(':')[0].split('_')[0]

/** '5511999999999@c.us' | '5511999999999' | '...@s.whatsapp.net' → JID Baileys */
const toBaileysJid = (id) => {
  const raw = String(id || '').trim()
  if (!raw) return raw
  if (!raw.includes('@')) {
    const digits = raw.replace(/\D/g, '')
    return digits ? `${digits}@${USER_SERVER_BAILEYS}` : ''
  }
  const { user, server } = splitJid(raw)
  if (server === USER_SERVER_WWEBJS || server === USER_SERVER_BAILEYS) {
    return `${stripDevice(user)}@${USER_SERVER_BAILEYS}`
  }
  if (server === 'lid') return `${stripDevice(user)}@lid`
  return raw
}

/** JID Baileys → ID no formato whatsapp-web.js (o que o Floume grava e devolve). */
const toWwebjsId = (jid) => {
  const raw = String(jid || '').trim()
  if (!raw) return raw
  if (!raw.includes('@')) return raw
  const { user, server } = splitJid(raw)
  if (server === USER_SERVER_BAILEYS || server === USER_SERVER_WWEBJS) {
    return `${stripDevice(user)}@${USER_SERVER_WWEBJS}`
  }
  if (server === 'lid') return `${stripDevice(user)}@lid`
  return raw
}

/** Objeto de ID igual ao do whatsapp-web.js: { server, user, _serialized } */
const toWid = (jid) => {
  const serialized = toWwebjsId(jid)
  if (!serialized) return null
  const { user, server } = splitJid(serialized)
  return { server, user, _serialized: serialized }
}

const isGroupJid = (jid) => String(jid || '').endsWith('@g.us')
const isLidJid = (jid) => String(jid || '').endsWith('@lid')
const isPnJid = (jid) => {
  const s = String(jid || '')
  return s.endsWith(`@${USER_SERVER_BAILEYS}`) || s.endsWith(`@${USER_SERVER_WWEBJS}`)
}
const isBroadcastJid = (jid) => String(jid || '').endsWith('@broadcast')
const isNewsletterJid = (jid) => String(jid || '').endsWith('@newsletter')

/** "5511999999999" a partir de qualquer forma de número/JID de pessoa */
const phoneDigits = (value) => {
  const raw = String(value || '')
  const user = raw.includes('@') ? splitJid(raw).user : raw
  return stripDevice(user).replace(/\D/g, '')
}

module.exports = {
  toBaileysJid,
  toWwebjsId,
  toWid,
  splitJid,
  stripDevice,
  isGroupJid,
  isLidJid,
  isPnJid,
  isBroadcastJid,
  isNewsletterJid,
  phoneDigits
}
