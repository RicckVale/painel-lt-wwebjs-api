// Fluxo de sessão sobre o Baileys com socket mockado: sem rede, sem WhatsApp real, sem Chrome.
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const request = require('supertest')

process.env.API_KEY = 'test_api_key'
process.env.SESSIONS_PATH = './sessions_test_baileys'
process.env.BASE_WEBHOOK_URL = 'http://webhook.test/webhook/whatsapp'
process.env.ENABLE_WEBHOOK = 'TRUE'

const mockSockets = []

const mockMakeSocket = () => {
  const ev = new EventEmitter()
  const sock = {
    ev,
    user: { id: '5511900000000:7@s.whatsapp.net', name: 'Loja Teste' },
    sendMessage: jest.fn(async (jid, content) => ({
      key: { remoteJid: jid, fromMe: true, id: `OUT${mockSockets.length}${Date.now()}` },
      message: content.text ? { conversation: content.text } : { imageMessage: { caption: content.caption, mimetype: content.mimetype } },
      messageTimestamp: 1732400000,
      status: 1
    })),
    sendPresenceUpdate: jest.fn(async () => { }),
    readMessages: jest.fn(async () => { }),
    onWhatsApp: jest.fn(async (digits) => [{ jid: `${digits}@s.whatsapp.net`, exists: true }]),
    profilePictureUrl: jest.fn(async () => 'https://pps.whatsapp.net/v/foto.jpg'),
    chatModify: jest.fn(async () => { }),
    requestPairingCode: jest.fn(async () => 'ABCD1234'),
    logout: jest.fn(async () => { }),
    end: jest.fn(),
    fetchMessageHistory: jest.fn(async () => 'req-1')
  }
  return sock
}

jest.mock('../src/baileys/loader', () => ({
  loadBaileys: async () => ({
    makeWASocket: (opts) => {
      const sock = mockMakeSocket()
      sock.opts = opts
      mockSockets.push(sock)
      return sock
    },
    useMultiFileAuthState: async () => ({
      state: { creds: { registered: false }, keys: {} },
      saveCreds: jest.fn(async () => { })
    }),
    downloadMediaMessage: async () => Buffer.from('conteudo-do-arquivo')
  })
}))

const mockWebhookCalls = []
jest.mock('axios', () => {
  const post = jest.fn(async (url, body) => {
    mockWebhookCalls.push({ url, body })
    return { status: 200, data: { ok: true } }
  })
  return { post, get: jest.fn(), create: jest.fn() }
})

const app = require('../src/app')
const { sessions } = require('../src/sessions')

const KEY = { 'x-api-key': 'test_api_key' }

const waitFor = async (check, timeoutMs = 3000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

const socketOf = async (sessionId) => waitFor(() => sessions.get(sessionId)?.sock)
const webhooksOf = (dataType) => mockWebhookCalls.filter((c) => c.body.dataType === dataType)

beforeAll(() => {
  fs.rmSync(process.env.SESSIONS_PATH, { recursive: true, force: true })
})

afterAll(async () => {
  for (const [, client] of sessions) await client.destroy().catch(() => { })
  fs.rmSync(process.env.SESSIONS_PATH, { recursive: true, force: true })
})

describe('Sessão Baileys: start e QR', () => {
  it('start responde 202 na hora, sem esperar navegador nem QR', async () => {
    const res = await request(app).get('/session/start/sessao-a').set(KEY)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ success: true, message: 'session_initialization_started' })
  })

  it('start repetido enquanto sobe responde 202 session_initialization_in_progress', async () => {
    const res = await request(app).get('/session/start/sessao-a').set(KEY)
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ success: true, message: 'session_initialization_in_progress' })
  })

  it('sem QR ainda, GET /session/qr devolve a message atual', async () => {
    await socketOf('sessao-a')
    const res = await request(app).get('/session/qr/sessao-a').set(KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: false, message: 'qr code not ready or already scanned' })
  })

  it('sessão inexistente devolve session_not_found', async () => {
    const res = await request(app).get('/session/qr/nao-existe').set(KEY)
    expect(res.body).toEqual({ success: false, message: 'session_not_found' })
  })

  it('ao emitir qr, GET /session/qr devolve { success: true, qr } e o webhook qr sai', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('connection.update', { qr: '2@QR-DE-TESTE' })

    const res = await request(app).get('/session/qr/sessao-a').set(KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, qr: '2@QR-DE-TESTE' })

    const img = await request(app).get('/session/qr/sessao-a/image').set(KEY)
    expect(img.status).toBe(200)
    expect(img.headers['content-type']).toBe('image/png')

    const qrHook = webhooksOf('qr').pop()
    expect(qrHook.url).toBe('http://webhook.test/webhook/whatsapp')
    expect(qrHook.body).toEqual({ dataType: 'qr', data: { qr: '2@QR-DE-TESTE' }, sessionId: 'sessao-a' })
  })

  it('status aguardando QR segue o JSON atual (session_not_connected)', async () => {
    const res = await request(app).get('/session/status/sessao-a').set(KEY)
    expect(res.body).toEqual({ success: false, state: 'UNPAIRED', message: 'session_not_connected' })
  })

  it('não usa Chrome: credencial vai para a pasta baileys-<id> e o socket não pede navegador', async () => {
    const sock = await socketOf('sessao-a')
    expect(sock.opts.auth.creds).toEqual({ registered: false })
    expect(fs.existsSync(path.join(process.env.SESSIONS_PATH, 'baileys-sessao-a'))).toBe(true)
    expect(fs.existsSync(path.join(process.env.SESSIONS_PATH, 'session-sessao-a'))).toBe(false)
  })
})

describe('Sessão Baileys conectada', () => {
  it('connection open → status conectado, webhooks authenticated e ready, QR limpo', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('connection.update', { connection: 'open' })

    const status = await request(app).get('/session/status/sessao-a').set(KEY)
    expect(status.body).toEqual({ success: true, state: 'CONNECTED', message: 'session_connected' })

    const qr = await request(app).get('/session/qr/sessao-a').set(KEY)
    expect(qr.body).toEqual({ success: false, message: 'qr code not ready or already scanned' })

    expect(webhooksOf('authenticated').length).toBeGreaterThan(0)
    expect(webhooksOf('ready').length).toBeGreaterThan(0)

    const info = await request(app).get('/client/getClassInfo/sessao-a').set(KEY)
    expect(info.body.success).toBe(true)
    expect(info.body.sessionInfo.wid.user).toBe('5511900000000')
    expect(info.body.sessionInfo.pushname).toBe('Loja Teste')
  })

  it('start com sessão conectada responde 200 sem recriar', async () => {
    const res = await request(app).get('/session/start/sessao-a').set(KEY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, message: 'session_already_connected' })
  })

  it('sendMessage chama sendMessage do socket com o JID do Baileys', async () => {
    const sock = await socketOf('sessao-a')
    const res = await request(app).post('/client/sendMessage/sessao-a').set(KEY)
      .send({ chatId: '5511988887777@c.us', contentType: 'string', content: 'Olá do Floume', options: {} })
    expect(res.status).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511988887777@s.whatsapp.net', { text: 'Olá do Floume' }, undefined)
    expect(res.body.success).toBe(true)
    expect(res.body.message.id._serialized).toMatch(/^true_5511988887777@c\.us_OUT/)
    expect(res.body.message.fromMe).toBe(true)
    expect(res.body.message.body).toBe('Olá do Floume')
  })

  it('sendMessage de mídia base64 envia image com legenda', async () => {
    const sock = await socketOf('sessao-a')
    const res = await request(app).post('/client/sendMessage/sessao-a').set(KEY).send({
      chatId: '5511988887777@c.us',
      contentType: 'MessageMedia',
      content: { mimetype: 'image/png', data: Buffer.from('png').toString('base64'), filename: 'a.png' },
      options: { caption: 'foto' }
    })
    expect(res.status).toBe(200)
    const [jid, payload] = sock.sendMessage.mock.calls.pop()
    expect(jid).toBe('5511988887777@s.whatsapp.net')
    expect(payload.caption).toBe('foto')
    expect(Buffer.isBuffer(payload.image)).toBe(true)
  })

  it('mensagem recebida dispara webhook message no formato que o ingest lê', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: '3EB0AAA111' },
        pushName: 'Cliente',
        messageTimestamp: 1732400100,
        message: { conversation: 'quero comprar' }
      }]
    })
    const hook = await waitFor(() => webhooksOf('message').pop())
    expect(hook.body.sessionId).toBe('sessao-a')
    const msg = hook.body.data.message
    expect(msg._data.id).toEqual({ fromMe: false, remote: '5511977776666@c.us', id: '3EB0AAA111', _serialized: 'false_5511977776666@c.us_3EB0AAA111' })
    expect(msg._data.body).toBe('quero comprar')
    expect(msg._data.type).toBe('chat')
    expect(msg._data.t).toBe(1732400100)
    expect(msg._data.notifyName).toBe('Cliente')
    expect(msg.from).toBe('5511977776666@c.us')
    expect(msg.to).toBe('5511900000000@c.us')
    expect(msg.fromMe).toBe(false)
    expect(msg.hasMedia).toBe(false)
    expect(webhooksOf('message_create').some((c) => c.body.data.message.id.id === '3EB0AAA111')).toBe(true)
  })

  it('ack do Baileys vira message_ack com a escala do whatsapp-web.js', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('messages.update', [{ key: { remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: '3EB0AAA111' }, update: { status: 4 } }])
    const hook = await waitFor(() => webhooksOf('message_ack').pop())
    expect(hook.body.data.ack).toBe(3)
    expect(hook.body.data.message.id.id).toBe('3EB0AAA111')
  })

  it('getChats e fetchMessages leem o store da sessão', async () => {
    const chats = await request(app).get('/client/getChats/sessao-a').set(KEY)
    expect(chats.body.success).toBe(true)
    const chat = chats.body.chats.find((c) => c.id._serialized === '5511977776666@c.us')
    expect(chat).toBeDefined()
    expect(chat.isGroup).toBe(false)
    expect(chat.lastMessage.timestamp).toBe(1732400100)

    const res = await request(app).post('/chat/fetchMessages/sessao-a').set(KEY)
      .send({ chatId: '5511977776666@c.us', searchOptions: { limit: 50 } })
    expect(res.body.success).toBe(true)
    expect(res.body.messages.map((m) => m.id.id)).toEqual(['3EB0AAA111'])
  })

  it('sendStateTyping manda presença composing para o chat (digitando no debounce)', async () => {
    const sock = await socketOf('sessao-a')
    const res = await request(app).post('/chat/sendStateTyping/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' })
    expect(res.status).toBe(200)
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '5511977776666@s.whatsapp.net')
  })

  it('sendSeen marca as mensagens recebidas como lidas', async () => {
    const sock = await socketOf('sessao-a')
    const res = await request(app).post('/chat/sendSeen/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' })
    expect(res.status).toBe(200)
    expect(sock.readMessages).toHaveBeenCalledWith([{ remoteJid: '5511977776666@s.whatsapp.net', fromMe: false, id: '3EB0AAA111' }])
  })

  it('getNumberId devolve o wid @c.us', async () => {
    const res = await request(app).post('/client/getNumberId/sessao-a').set(KEY).send({ number: '5511955554444' })
    expect(res.body).toEqual({ success: true, result: { server: 'c.us', user: '5511955554444', _serialized: '5511955554444@c.us' } })
  })

  it('archive/mute/pin chamam chatModify', async () => {
    const sock = await socketOf('sessao-a')
    await request(app).post('/client/archiveChat/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' }).expect(200)
    await request(app).post('/client/pinChat/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' }).expect(200)
    await request(app).post('/client/muteChat/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' }).expect(200)
    const kinds = sock.chatModify.mock.calls.map(([mod]) => Object.keys(mod)[0])
    expect(kinds).toEqual(expect.arrayContaining(['archive', 'pin', 'mute']))
  })

  it('getProfilePicUrl usa profilePictureUrl do socket', async () => {
    const res = await request(app).post('/client/getProfilePicUrl/sessao-a').set(KEY).send({ contactId: '5511977776666@c.us' })
    expect(res.body).toEqual({ success: true, result: 'https://pps.whatsapp.net/v/foto.jpg' })
  })

  it('rotas sem equivalente no Baileys respondem 501 estável', async () => {
    const shot = await request(app).get('/session/getPageScreenshot/sessao-a').set(KEY)
    expect(shot.status).toBe(501)
    expect(shot.body).toEqual({ success: false, error: 'not_supported_by_baileys', message: 'not_supported_by_baileys' })

    const open = await request(app).post('/client/openChatWindow/sessao-a').set(KEY).send({ chatId: '5511977776666@c.us' })
    expect(open.status).toBe(501)

    const run = await request(app).post('/client/runMethod/sessao-a').set(KEY).send({ method: 'logout' })
    expect(run.status).toBe(501)
    expect((await socketOf('sessao-a')).logout).not.toHaveBeenCalled()
  })

  it('terminate faz logout e remove só a pasta baileys-<id>', async () => {
    const legacyDir = path.join(process.env.SESSIONS_PATH, 'session-sessao-a')
    fs.mkdirSync(legacyDir, { recursive: true })
    const sock = await socketOf('sessao-a')
    const res = await request(app).get('/session/terminate/sessao-a').set(KEY)
    expect(res.body).toEqual({ success: true, message: 'Logged out successfully' })
    expect(sock.logout).toHaveBeenCalled()
    expect(fs.existsSync(path.join(process.env.SESSIONS_PATH, 'baileys-sessao-a'))).toBe(false)
    expect(fs.existsSync(legacyDir)).toBe(true)
  })
})

describe('Pairing code', () => {
  it('sem telefone responde 400', async () => {
    await request(app).get('/session/start/sessao-b').set(KEY).expect(202)
    const res = await request(app).post('/session/requestPairingCode/sessao-b').set(KEY).send({})
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, error: 'phoneNumber is required' })
  })

  it('com telefone usa o pairing do Baileys', async () => {
    const sock = await socketOf('sessao-b')
    sock.ev.emit('connection.update', { qr: '2@QR-B' })
    const res = await request(app).post('/session/requestPairingCode/sessao-b').set(KEY).send({ phoneNumber: '+55 11 98888-7777' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, result: 'ABCD1234', pairingCode: 'ABCD1234' })
    expect(sock.requestPairingCode).toHaveBeenCalledWith('5511988887777')
  })

  it('stop encerra o socket sem logout e mantém a pasta', async () => {
    const sock = await socketOf('sessao-b')
    const res = await request(app).get('/session/stop/sessao-b').set(KEY)
    expect(res.body).toEqual({ success: true, message: 'Session stopped successfully' })
    expect(sock.end).toHaveBeenCalled()
    expect(sock.logout).not.toHaveBeenCalled()
    expect(sessions.has('sessao-b')).toBe(false)
    expect(fs.existsSync(path.join(process.env.SESSIONS_PATH, 'baileys-sessao-b'))).toBe(true)
  })
})
