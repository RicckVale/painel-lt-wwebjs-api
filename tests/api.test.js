const request = require('supertest')
const fs = require('fs')

// Mock your application's environment variables
process.env.API_KEY = 'test_api_key'
process.env.SESSIONS_PATH = './sessions_test'
process.env.ENABLE_LOCAL_CALLBACK_EXAMPLE = 'TRUE'
process.env.BASE_WEBHOOK_URL = 'http://localhost:3000/localCallbackExample'

const app = require('../src/app')
jest.mock('qrcode-terminal')

beforeAll(() => {
  fs.rmSync(process.env.SESSIONS_PATH, { recursive: true, force: true })
})

beforeEach(() => {
  if (fs.existsSync('./sessions_test/message_log.txt')) {
    fs.writeFileSync('./sessions_test/message_log.txt', '')
  }
})

afterAll(() => {
  fs.rmSync(process.env.SESSIONS_PATH, { recursive: true, force: true })
})

// Define test cases
describe('API health checks', () => {
  it('should return valid health check', async () => {
    const response = await request(app).get('/ping')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ message: 'pong', success: true })
  })

  it('should return a valid callback status', async () => {
    const response = await request(app).post('/localCallbackExample')
      .set('x-api-key', 'test_api_key')
      .send({ sessionId: '1', dataType: 'testDataType', data: 'testData' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true })

    expect(fs.existsSync('./sessions_test/message_log.txt')).toBe(true)
    expect(fs.readFileSync('./sessions_test/message_log.txt', 'utf-8')).toEqual('{"sessionId":"1","dataType":"testDataType","data":"testData"}\r\n')
  })
})

describe('API Authentication Tests', () => {
  it('should return 403 Forbidden for invalid API key', async () => {
    const response = await request(app).get('/session/start/1')
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ success: false, error: 'Invalid API key' })
  })

  it('should fail invalid sessionId', async () => {
    const response = await request(app).get('/session/start/ABCD1@').set('x-api-key', 'test_api_key')
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ success: false, error: 'Session should be alphanumerical or -' })
  })

  it('should return session_not_found for unknown session status and qr', async () => {
    const status = await request(app).get('/session/status/nao-existe').set('x-api-key', 'test_api_key')
    expect(status.body).toEqual({ success: false, state: null, message: 'session_not_found' })
    const qr = await request(app).get('/session/qr/nao-existe').set('x-api-key', 'test_api_key')
    expect(qr.body).toEqual({ success: false, message: 'session_not_found' })
  })
})

// O fluxo de sessão (start 202, QR, envio, terminate) com socket Baileys mockado fica em tests/baileys.test.js.
