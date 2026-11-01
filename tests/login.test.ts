import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { loginWithQr } from '../src/ilink/login.ts'

interface MockServer {
  url: string
  close: () => Promise<void>
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

function serve(handler: Handler): Promise<MockServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

test('loginWithQr: 扫码 → wait → scaned → confirmed，拿到并返回凭据', async (t) => {
  let statusCalls = 0
  let qrCalls = 0
  let base = ''

  const mock = await serve((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      qrCalls++
      json(res, { ret: 0, qrcode: `qr-${qrCalls}`, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' })
      return
    }

    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      statusCalls++
      if (statusCalls === 1) return json(res, { status: 'wait' })
      if (statusCalls === 2) return json(res, { status: 'scaned' })
      return json(res, {
        status: 'confirmed',
        bot_token: 'ilinkbot_demo',
        ilink_bot_id: 'bot-demo@im.bot',
        ilink_user_id: 'owner@im.wechat',
        baseurl: base,
      })
    }

    json(res, { ret: 404 })
  })
  base = mock.url
  t.after(() => mock.close())

  const qrContents: string[] = []
  const statuses: string[] = []

  const creds = await loginWithQr({
    baseUrl: mock.url,
    deadlineMs: 10_000,
    onQr: (ticket) => {
      qrContents.push(ticket.qrcodeImgContent)
    },
    onStatus: (status) => statuses.push(status),
  })

  assert.equal(qrCalls, 1)
  assert.deepEqual(qrContents, ['https://liteapp.weixin.qq.com/q/abc'])
  assert.deepEqual(statuses, ['wait', 'scaned', 'confirmed'])

  assert.equal(creds.token, 'ilinkbot_demo')
  assert.equal(creds.accountId, 'bot-demo@im.bot')
  assert.equal(creds.userId, 'owner@im.wechat')
  assert.equal(creds.baseUrl, mock.url)
  assert.ok(creds.savedAt)
})

test('loginWithQr: 二维码过期会自动换一张', async (t) => {
  let qrCalls = 0
  let statusCalls = 0

  const mock = await serve((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      qrCalls++
      json(res, { ret: 0, qrcode: `qr-${qrCalls}`, qrcode_img_content: `https://example.com/qr/${qrCalls}` })
      return
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      statusCalls++
      if (statusCalls === 1) return json(res, { status: 'expired' })
      return json(res, {
        status: 'confirmed',
        bot_token: 'tok2',
        ilink_bot_id: 'bot2@im.bot',
        ilink_user_id: 'u2@im.wechat',
      })
    }
    json(res, { ret: 404 })
  })
  t.after(() => mock.close())

  const seen: string[] = []
  const creds = await loginWithQr({
    baseUrl: mock.url,
    deadlineMs: 10_000,
    onQr: (ticket) => {
      seen.push(ticket.qrcode)
    },
  })

  assert.equal(qrCalls, 2)
  assert.deepEqual(seen, ['qr-1', 'qr-2'])
  assert.equal(creds.token, 'tok2')
  // 服务端没返回 baseurl 时，沿用传入的地址
  assert.equal(creds.baseUrl, mock.url)
})
