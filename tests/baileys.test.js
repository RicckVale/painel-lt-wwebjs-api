// Fluxo de sessão sobre o Baileys com socket mockado: sem rede, sem WhatsApp real, sem Chrome.
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const request = require('supertest')

process.env.API_KEY = 'test_api_key'
process.env.SESSIONS_PATH = './sessions_test_baileys'
process.env.BASE_WEBHOOK_URL = 'http://webhook.test/webhook/whatsapp'
process.env.ENABLE_WEBHOOK = 'TRUE'
process.env.BAILEYS_HISTORY_ON_DEMAND_TIMEOUT_MS = '250'

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
    // Pastas de sessão "pareada" (sessao-h, sessao-pareada) já têm credencial: creds.me preenchido no QR.
    useMultiFileAuthState: async (dir) => ({
      state: {
        creds: /sessao-h$|pareada/.test(dir) ? { registered: false, me: { id: '5511900000000:9@s.whatsapp.net' } } : { registered: false },
        keys: {}
      },
      saveCreds: jest.fn(async () => { })
    }),
    downloadMediaMessage: async () => Buffer.from('conteudo-do-arquivo'),
    Browsers: { macOS: (name) => ['Mac OS', name, '14.4.1'], ubuntu: (name) => ['Ubuntu', name, '22.04.4'] }
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

  it('envio pela API gera um único message_create quando o Baileys ecoa a mensagem', async () => {
    const sock = await socketOf('sessao-a')
    const res = await request(app).post('/client/sendMessage/sessao-a').set(KEY)
      .send({ chatId: '5511966665555@c.us', contentType: 'string', content: 'eco' })
    const sentId = res.body.message.id.id
    const echo = { key: { remoteJid: '5511966665555@s.whatsapp.net', fromMe: true, id: sentId }, message: { conversation: 'eco' }, messageTimestamp: 1732400050 }
    sock.ev.emit('messages.upsert', { type: 'append', messages: [echo] })
    sock.ev.emit('messages.upsert', { type: 'append', messages: [echo] })
    const creates = webhooksOf('message_create').filter((c) => c.body.data.message.id.id === sentId)
    expect(creates).toHaveLength(1)
    expect(creates[0].body.data.message.fromMe).toBe(true)
    expect(creates[0].body.data.message.from).toBe('5511900000000@c.us')
    expect(webhooksOf('message').some((c) => c.body.data.message.id.id === sentId)).toBe(false)
  })

  it('mensagem de LID com telefone alternativo chega com from @c.us', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: '123456789012345@lid', remoteJidAlt: '5511944443333@s.whatsapp.net', fromMe: false, id: 'LIDMSG1' },
        messageTimestamp: 1732400200,
        message: { extendedTextMessage: { text: 'oi via lid' } }
      }]
    })
    const msg = (await waitFor(() => webhooksOf('message').find((c) => c.body.data.message.id.id === 'LIDMSG1'))).body.data.message
    expect(msg.from).toBe('5511944443333@c.us')
    expect(msg._data.id.remote).toBe('5511944443333@c.us')
    expect(msg.body).toBe('oi via lid')

    const lid = await request(app).post('/client/getContactLidAndPhone/sessao-a').set(KEY).send({ userIds: ['123456789012345@lid'] })
    expect(lid.body).toEqual({ success: true, data: [{ lid: '123456789012345@lid', pn: '5511944443333@c.us' }] })
  })

  it('mensagem de grupo traz author do participante', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { remoteJid: '120363000000000001@g.us', participant: '5511933332222@s.whatsapp.net', fromMe: false, id: 'GRP1' },
        pushName: 'Membro',
        messageTimestamp: 1732400300,
        message: { imageMessage: { caption: 'olha', mimetype: 'image/jpeg', fileLength: 1234, mediaKey: Buffer.from('k') } }
      }]
    })
    const msg = (await waitFor(() => webhooksOf('message').find((c) => c.body.data.message.id.id === 'GRP1'))).body.data.message
    expect(msg.from).toBe('120363000000000001@g.us')
    expect(msg.author).toBe('5511933332222@c.us')
    expect(msg.id._serialized).toBe('false_120363000000000001@g.us_GRP1_5511933332222@c.us')
    expect(msg.type).toBe('image')
    expect(msg.hasMedia).toBe(true)
    expect(msg._data.body).toBe('olha')
    expect(msg.message.imageMessage.mediaKey).toBeUndefined()
    const media = await waitFor(() => webhooksOf('media').find((c) => c.body.data.message.id.id === 'GRP1'))
    expect(media.body.data.messageMedia).toEqual({ mimetype: 'image/jpeg', data: Buffer.from('conteudo-do-arquivo').toString('base64'), filename: null, filesize: 19 })
  })

  it('unreadCount do chats.update é incremento e dispara unread_count', async () => {
    const sock = await socketOf('sessao-a')
    sock.ev.emit('chats.update', [{ id: '5511977776666@s.whatsapp.net', unreadCount: 1 }])
    sock.ev.emit('chats.update', [{ id: '5511977776666@s.whatsapp.net', unreadCount: 2 }])
    const hook = webhooksOf('unread_count').pop()
    expect(hook.body.data.chatId).toBe('5511977776666@c.us')
    expect(hook.body.data.unreadCount).toBe(3)
    sock.ev.emit('chats.update', [{ id: '5511977776666@s.whatsapp.net', unreadCount: 0 }])
    expect(webhooksOf('unread_count').pop().body.data.unreadCount).toBe(0)
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

  it('getProfilePicUrl aceita @c.us, @s.whatsapp.net e @lid', async () => {
    const sock = await socketOf('sessao-a')
    const ids = ['5511977776666@c.us', '5511977776666@s.whatsapp.net', '7770001112223@lid']
    for (const contactId of ids) {
      const res = await request(app).post('/client/getProfilePicUrl/sessao-a').set(KEY).send({ contactId })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, result: 'https://pps.whatsapp.net/v/foto.jpg' })
    }
    const jids = sock.profilePictureUrl.mock.calls.map((call) => call[0])
    expect(jids).toEqual(expect.arrayContaining(['5511977776666@s.whatsapp.net', '7770001112223@lid']))
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

describe('syncFullHistory: padrão histórico sob demanda', () => {
  const { BaileysClient } = require('../src/baileys/client')
  const directClients = []
  const startDirect = async (dirName, options) => {
    const client = new BaileysClient({ sessionId: dirName, authDir: path.join(process.env.SESSIONS_PATH, dirName), options: { fetchLatestVersion: false, ...options } })
    directClients.push(client)
    await client.initialize()
    return client
  }
  const closeWith = (sock, error) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error } })
  const nextSocket = (sessionId, previous) => waitFor(() => (sessions.get(sessionId).sock !== previous ? sessions.get(sessionId).sock : null))

  afterAll(async () => {
    for (const c of directClients) await c.destroy().catch(() => { })
  })

  it('socket sem parear nasce com syncFullHistory false e perfil web macOS Chrome (env padrão)', async () => {
    await request(app).get('/session/start/sessao-nova').set(KEY).expect(202)
    const sock = await socketOf('sessao-nova')
    expect(sock.opts.syncFullHistory).toBe(false)
    expect(sock.opts.browser).toEqual(['Mac OS', 'Chrome', '14.4.1'])
    for (const syncType of [0, 3, 6]) expect(sock.opts.shouldSyncHistoryMessage({ syncType })).toBe(true)
  })

  it('socket pareado também nasce com syncFullHistory false e Chrome quando a env é false', async () => {
    await request(app).get('/session/start/sessao-pareada').set(KEY).expect(202)
    const sock = await socketOf('sessao-pareada')
    expect(sock.opts.syncFullHistory).toBe(false)
    expect(sock.opts.browser).toEqual(['Mac OS', 'Chrome', '14.4.1'])
  })

  it('com a opção true e pareado, nasce com syncFullHistory true (e só então perfil Desktop)', async () => {
    const paired = await startDirect('direto-pareada-full', { syncFullHistory: true })
    expect(paired.sock.opts.syncFullHistory).toBe(true)
    expect(paired.sock.opts.browser).toEqual(['Mac OS', 'Desktop', '14.4.1'])
    const fresh = await startDirect('direto-nova-full', { syncFullHistory: true })
    expect(fresh.sock.opts.syncFullHistory).toBe(false)
    expect(fresh.sock.opts.browser).toEqual(['Mac OS', 'Chrome', '14.4.1'])
  })

  it('fechamento 515 depois do QR agenda reconexão imediata e não liga syncFullHistory', async () => {
    const first = await socketOf('sessao-nova')
    first.ev.emit('connection.update', { qr: '2@QR-NOVA' })
    first.ev.emit('creds.update', { me: { id: '5511900000000:11@s.whatsapp.net' } })
    const client = sessions.get('sessao-nova')
    client.authState.creds.me = { id: '5511900000000:11@s.whatsapp.net' }
    const t0 = Date.now()
    closeWith(first, { message: 'Stream Errored (restart required)', output: { statusCode: 515 }, data: { tag: 'stream:error', attrs: { code: '515' } } })
    const second = await nextSocket('sessao-nova', first)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(client.reconnectAttempts).toBe(0)
    expect(second.opts.syncFullHistory).toBe(false)
    expect(second.opts.browser).toEqual(['Mac OS', 'Chrome', '14.4.1'])
  })

  it('515 só nos attrs do stream:error (statusCode ausente) também é restart', async () => {
    const client = sessions.get('sessao-nova')
    const current = client.sock
    closeWith(current, { message: 'Stream Errored (unknown)', data: { attrs: { code: '515' } } })
    const next = await nextSocket('sessao-nova', current)
    expect(client.reconnectAttempts).toBe(0)
    expect(next.opts.syncFullHistory).toBe(false)
  })

  it('428 logo após o pareamento (antes do primeiro open) é tratado como o restart pós-QR', async () => {
    await request(app).get('/session/start/sessao-qr428').set(KEY).expect(202)
    const first = await socketOf('sessao-qr428')
    first.ev.emit('connection.update', { qr: '2@QR-428' })
    first.ev.emit('creds.update', { me: { id: '5511900000000:12@s.whatsapp.net' } })
    closeWith(first, { message: 'Connection Terminated', output: { statusCode: 428 } })
    const second = await nextSocket('sessao-qr428', first)
    const client = sessions.get('sessao-qr428')
    expect(client.reconnectAttempts).toBe(0)
    expect(second.opts.syncFullHistory).toBe(false)
  })
})

describe('Sincronização de histórico (messaging-history.set e fetchMessageHistory)', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const chatJid = '5511922221111@s.whatsapp.net'
  const chatId = '5511922221111@c.us'
  let base

  it('sessão pareada: histórico sob demanda (syncFullHistory false, shouldSyncHistoryMessage true, perfil web Chrome)', async () => {
    await request(app).get('/session/start/sessao-h').set(KEY).expect(202)
    const sock = await socketOf('sessao-h')
    expect(sock.opts.syncFullHistory).toBe(false)
    for (const syncType of [0, 1, 2, 3, 4, 5, 6]) {
      expect(sock.opts.shouldSyncHistoryMessage({ syncType })).toBe(true)
    }
    expect(sock.opts.browser).toEqual(['Mac OS', 'Chrome', '14.4.1'])
  })

  it('desconectado: as duas rotas respondem 422 history_sync_not_connected', async () => {
    const sock = await socketOf('sessao-h')
    sock.ev.emit('connection.update', { qr: '2@QR-H' })
    for (const route of ['/chat/syncHistory/sessao-h', '/client/syncHistory/sessao-h']) {
      const res = await request(app).post(route).set(KEY).send({ chatId })
      expect(res.status).toBe(422)
      expect(res.body).toEqual({ success: false, error: 'history_sync_not_connected', message: 'history_sync_not_connected' })
    }
    expect(sock.fetchMessageHistory).not.toHaveBeenCalled()
  })

  it('chat sem mensagem guardada responde history_sync_waiting_initial', async () => {
    const sock = await socketOf('sessao-h')
    sock.ev.emit('connection.update', { connection: 'open' })
    const res = await request(app).post('/chat/syncHistory/sessao-h').set(KEY).send({ chatId })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, message: 'history_sync_waiting_initial' })
    expect(sock.fetchMessageHistory).not.toHaveBeenCalled()
  })

  it('messaging-history.set com 2 mensagens e uma repetida grava 2 e o webhook sai uma vez por id', async () => {
    const sock = await socketOf('sessao-h')
    base = now()
    const m1 = { key: { remoteJid: chatJid, fromMe: false, id: 'HIST-IN-1' }, pushName: 'Cliente H', messageTimestamp: base - 120, message: { conversation: 'mensagem antiga recebida' } }
    const m2 = { key: { remoteJid: chatJid, fromMe: true, id: 'HIST-OUT-2' }, messageTimestamp: base - 60, message: { conversation: 'resposta da loja' } }
    const payload = {
      chats: [{ id: chatJid, name: 'Cliente H', conversationTimestamp: base - 60, unreadCount: 1 }],
      contacts: [{ id: chatJid, notify: 'Cliente H' }],
      messages: [m2, m1, { ...m1 }],
      isLatest: false,
      progress: 40,
      syncType: 0
    }
    sock.ev.emit('messaging-history.set', payload)
    sock.ev.emit('messaging-history.set', payload)
    await sessions.get('sessao-h').historyQueue

    const fetched = await request(app).post('/chat/fetchMessages/sessao-h').set(KEY).send({ chatId, searchOptions: { limit: 50 } })
    expect(fetched.body.messages.map((m) => m.id.id)).toEqual(['HIST-IN-1', 'HIST-OUT-2'])
    expect(fetched.body.messages[0].from).toBe(chatId)

    const inHooks = webhooksOf('message').filter((c) => c.body.data.message.id.id === 'HIST-IN-1')
    const outHooks = webhooksOf('message_create').filter((c) => c.body.data.message.id.id === 'HIST-OUT-2')
    expect(inHooks).toHaveLength(1)
    expect(outHooks).toHaveLength(1)
    expect(inHooks[0].body.sessionId).toBe('sessao-h')
    expect(inHooks[0].body.data.message._data.id.remote).toBe(chatId)
    expect(inHooks[0].body.data.message._data.notifyName).toBe('Cliente H')

    const chats = await request(app).get('/client/getChats/sessao-h').set(KEY)
    expect(chats.body.chats.find((c) => c.id._serialized === chatId).name).toBe('Cliente H')
    expect(sessions.get('sessao-h').getHistorySyncState()).toMatchObject({ syncType: 'INITIAL_BOOTSTRAP', progress: 40, isLatest: false })
  })

  it('mensagem antiga do histórico vai para o store mas não vira webhook (não aciona chatbot)', async () => {
    const sock = await socketOf('sessao-h')
    sock.ev.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [{ key: { remoteJid: '5511911110000@s.whatsapp.net', fromMe: false, id: 'HIST-OLD' }, messageTimestamp: now() - 3 * 86400, message: { conversation: 'de três dias atrás' } }],
      syncType: 2,
      progress: 80,
      isLatest: false
    })
    await sessions.get('sessao-h').historyQueue
    const fetched = await request(app).post('/chat/fetchMessages/sessao-h').set(KEY).send({ chatId: '5511911110000@c.us', searchOptions: { limit: 10 } })
    expect(fetched.body.messages.map((m) => m.id.id)).toEqual(['HIST-OLD'])
    expect(mockWebhookCalls.some((c) => c.body.data?.message?.id?.id === 'HIST-OLD')).toBe(false)
  })

  it('chat @lid sem telefone conhecido devolve o id no formato antigo (@lid)', async () => {
    const sock = await socketOf('sessao-h')
    sock.ev.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [{ key: { remoteJid: '7770001112223@lid', fromMe: false, id: 'HIST-LID' }, messageTimestamp: now() - 30, message: { conversation: 'oi lid' } }],
      syncType: 3
    })
    await sessions.get('sessao-h').historyQueue
    const fetched = await request(app).post('/chat/fetchMessages/sessao-h').set(KEY).send({ chatId: '7770001112223@lid', searchOptions: { limit: 10 } })
    expect(fetched.body.messages[0].id._serialized).toBe('false_7770001112223@lid_HIST-LID')
    const hook = webhooksOf('message').find((c) => c.body.data.message.id.id === 'HIST-LID')
    expect(hook.body.data.message.from).toBe('7770001112223@lid')
  })

  it('POST /chat/syncHistory chama fetchMessageHistory com a chave mais antiga e devolve syncType, progress e isLatest', async () => {
    const sock = await socketOf('sessao-h')
    sock.fetchMessageHistory.mockImplementationOnce(async () => {
      setImmediate(() => sock.ev.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [{ key: { remoteJid: chatJid, fromMe: false, id: 'HIST-OLDER-0' }, messageTimestamp: base - 86400, message: { conversation: 'mais antiga ainda' } }],
        syncType: 6,
        progress: 100,
        isLatest: true,
        peerDataRequestSessionId: 'pdo-1'
      }))
      return 'pdo-1'
    })
    const res = await request(app).post('/chat/syncHistory/sessao-h').set(KEY).send({ chatId, count: 30 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, syncType: 'ON_DEMAND', progress: 100, isLatest: true, received: 1, requestId: 'pdo-1', count: 30 })
    expect(sock.fetchMessageHistory).toHaveBeenCalledWith(30, { remoteJid: chatJid, id: 'HIST-IN-1', fromMe: false }, base - 120)

    const fetched = await request(app).post('/chat/fetchMessages/sessao-h').set(KEY).send({ chatId, searchOptions: { limit: 50 } })
    expect(fetched.body.messages.map((m) => m.id.id)).toEqual(['HIST-OLDER-0', 'HIST-IN-1', 'HIST-OUT-2'])
  })

  it('POST /client/syncHistory segue o mesmo caminho (count padrão 50, nova chave mais antiga)', async () => {
    const sock = await socketOf('sessao-h')
    sock.fetchMessageHistory.mockImplementationOnce(async () => {
      setImmediate(() => sock.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], syncType: 6, progress: 100, isLatest: true, peerDataRequestSessionId: 'pdo-2' }))
      return 'pdo-2'
    })
    const res = await request(app).post('/client/syncHistory/sessao-h').set(KEY).send({ chatId, count: 'abc' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, syncType: 'ON_DEMAND', progress: 100, isLatest: true, received: 0, count: 50 })
    expect(sock.fetchMessageHistory).toHaveBeenLastCalledWith(50, { remoteJid: chatJid, id: 'HIST-OLDER-0', fromMe: false }, base - 86400)
  })

  it('fetchMessages espera o on-demand quando o store tem menos que o limit e não estoura sem chave', async () => {
    await request(app).get('/session/start/sessao-ond').set(KEY).expect(202)
    const sock = await socketOf('sessao-ond')
    sock.ev.emit('connection.update', { connection: 'open' })
    const stamp = now()
    const ondJid = '5511933334444@s.whatsapp.net'
    sock.ev.emit('messaging-history.set', {
      chats: [{ id: ondJid, conversationTimestamp: stamp }],
      contacts: [],
      messages: [{ key: { remoteJid: ondJid, fromMe: false, id: 'OND-NEW' }, messageTimestamp: stamp, message: { conversation: 'recente' } }],
      syncType: 3,
      isLatest: false
    })
    await sessions.get('sessao-ond').historyQueue
    sock.fetchMessageHistory.mockImplementationOnce(async () => {
      setImmediate(() => sock.ev.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [{ key: { remoteJid: ondJid, fromMe: false, id: 'OND-OLD' }, messageTimestamp: stamp - 5000, message: { conversation: 'anterior' } }],
        syncType: 6,
        progress: 100,
        isLatest: true,
        peerDataRequestSessionId: 'ond-1'
      }))
      return 'ond-1'
    })
    const res = await request(app).post('/chat/fetchMessages/sessao-ond').set(KEY)
      .send({ chatId: '5511933334444@c.us', searchOptions: { limit: 10 } })
    expect(res.status).toBe(200)
    expect(res.body.messages.map((m) => m.id.id)).toEqual(['OND-OLD', 'OND-NEW'])
    expect(sock.fetchMessageHistory).toHaveBeenCalledWith(10, { remoteJid: ondJid, id: 'OND-NEW', fromMe: false }, stamp)
    expect(webhooksOf('history_ready').some((c) => c.body.data?.syncType === 'ON_DEMAND')).toBe(false)

    const empty = await request(app).post('/chat/fetchMessages/sessao-ond').set(KEY)
      .send({ chatId: '5511900001111@c.us', searchOptions: { limit: 10 } })
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ success: true, messages: [] })
  })

  it('INITIAL_BOOTSTRAP com isLatest emite um único history_ready e não um message por mensagem antiga', async () => {
    const sock = await socketOf('sessao-ond')
    const beforeReady = webhooksOf('history_ready').length
    const oldTs = now() - 3 * 86400
    const ondJid = '5511933334444@s.whatsapp.net'
    sock.ev.emit('messaging-history.set', {
      chats: [{ id: ondJid }],
      contacts: [],
      messages: [{ key: { remoteJid: ondJid, fromMe: false, id: 'BOOT-OLD' }, messageTimestamp: oldTs, message: { conversation: 'velha' } }],
      syncType: 0,
      progress: 40,
      isLatest: false
    })
    await sessions.get('sessao-ond').historyQueue
    expect(webhooksOf('history_ready').length).toBe(beforeReady)
    expect(mockWebhookCalls.some((c) => c.body.data?.message?.id?.id === 'BOOT-OLD')).toBe(false)

    sock.ev.emit('messaging-history.set', {
      chats: [{ id: ondJid }, { id: '5511900002222@s.whatsapp.net' }],
      contacts: [],
      messages: [{ key: { remoteJid: ondJid, fromMe: false, id: 'BOOT-END' }, messageTimestamp: oldTs, message: { conversation: 'fim' } }],
      syncType: 0,
      progress: 100,
      isLatest: true
    })
    await sessions.get('sessao-ond').historyQueue
    const ready = webhooksOf('history_ready').slice(beforeReady)
    expect(ready).toHaveLength(1)
    expect(ready[0].body).toMatchObject({
      dataType: 'history_ready',
      sessionId: 'sessao-ond',
      data: { syncType: 'INITIAL_BOOTSTRAP', isLatest: true, chats: 2, messages: 1 }
    })
    expect(mockWebhookCalls.some((c) => c.body.data?.message?.id?.id === 'BOOT-END')).toBe(false)
  })

  it('setBackgroundSync: false desliga nas próximas conexões sem apagar o store; true volta', async () => {
    const client = sessions.get('sessao-h')
    await request(app).post('/client/setBackgroundSync/sessao-h').set(KEY).send({ flag: false }).expect(200)
    expect(client.getHistorySyncState().backgroundSync).toBe(false)
    expect(client.store.listMessages(chatId)).toHaveLength(3)
    await request(app).post('/client/setBackgroundSync/sessao-h').set(KEY).send({ flag: true }).expect(200)
    expect(client.getHistorySyncState().backgroundSync).toBe(true)
    // liga nas próximas conexões da sessão pareada; perfil segue Chrome (Desktop só com a env explícita)
    expect(client.socketSyncFullHistory()).toBe(true)
    expect(client.options.syncFullHistory).not.toBe(true)
  })
})
