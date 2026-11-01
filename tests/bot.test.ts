import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { sendText } from '../src/ilink/bot.ts'
import type { Credentials } from '../src/ilink/types.ts'

interface Captured {
  body: {
    msg?: {
      to_user_id?: string
      context_token?: string
      client_id?: string
      message_type?: number
      item_list?: Array<{ type?: number; text_item?: { text?: string } }>
    }
  }
  authorization?: string
}

async function startSink(): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    captured.push({
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      authorization: req.headers.authorization,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ret: 0 }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

test('sendText: 长文本分片，每片都带 context_token 与唯一 client_id', async (t) => {
  const sink = await startSink()
  t.after(() => sink.close())

  const creds: Credentials = {
    token: 'tok',
    baseUrl: sink.url,
    accountId: 'bot@im.bot',
    userId: 'u@im.wechat',
    savedAt: new Date().toISOString(),
  }

  const parts = await sendText(creds, 'u@im.wechat', 'ctx-123', 'x'.repeat(2100))
  assert.equal(parts, 2)
  assert.equal(sink.captured.length, 2)

  const clientIds = new Set<string>()
  for (const { body, authorization } of sink.captured) {
    assert.equal(authorization, 'Bearer tok')
    assert.equal(body.msg?.to_user_id, 'u@im.wechat')
    assert.equal(body.msg?.context_token, 'ctx-123')
    assert.equal(body.msg?.message_type, 2)
    const text = body.msg?.item_list?.[0]?.text_item?.text ?? ''
    assert.ok(text.length > 0 && text.length <= 2000)
    clientIds.add(body.msg?.client_id ?? '')
  }
  assert.equal(clientIds.size, 2)
})

test('sendText: 没有 context_token 时直接拒绝，不发请求', async (t) => {
  const sink = await startSink()
  t.after(() => sink.close())

  const creds: Credentials = {
    token: 'tok',
    baseUrl: sink.url,
    accountId: 'bot@im.bot',
    userId: '',
    savedAt: new Date().toISOString(),
  }

  await assert.rejects(sendText(creds, 'u@im.wechat', '', 'hi'), /context_token/)
  assert.equal(sink.captured.length, 0)
})

test('sendText: 空文本不发请求', async (t) => {
  const sink = await startSink()
  t.after(() => sink.close())

  const creds: Credentials = {
    token: 'tok',
    baseUrl: sink.url,
    accountId: 'bot@im.bot',
    userId: '',
    savedAt: new Date().toISOString(),
  }

  assert.equal(await sendText(creds, 'u@im.wechat', 'ctx', '   '), 0)
  assert.equal(sink.captured.length, 0)
})
