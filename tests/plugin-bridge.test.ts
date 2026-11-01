import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { ILinkError, TimeoutError } from '../src/ilink/http.ts'
import { normalizeConfig } from '../src/plugin/config.ts'
import { createBridge } from '../src/plugin/bridge.ts'
import type { LogEntry } from '../src/plugin/bridge.ts'
import type { Credentials, GetUpdatesResponse, WeixinMessage } from '../src/ilink/types.ts'

const creds: Credentials = {
  token: 'tok',
  baseUrl: 'http://127.0.0.1:1',
  accountId: 'bot@im.bot',
  userId: 'u@im.wechat',
  savedAt: new Date().toISOString(),
}

const message: WeixinMessage = {
  message_id: 1001,
  message_type: 1,
  from_user_id: 'u@im.wechat',
  to_user_id: 'bot@im.bot',
  context_token: 'ctx-1',
  item_list: [{ type: 1, text_item: { text: '在吗' } }],
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-bridge-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('等待条件超时')
}

interface Harness {
  sent: Array<{ to: string; token: string; text: string }>
  logs: LogEntry[]
}

function makeBridge(options: {
  messages: WeixinMessage[]
  config?: ReturnType<typeof normalizeConfig>
  generateText?: string
}): { bridge: ReturnType<typeof createBridge>; harness: Harness } {
  const harness: Harness = { sent: [], logs: [] }
  let polls = 0

  const api = {
    getUpdates: async (): Promise<GetUpdatesResponse> => {
      polls++
      if (polls === 1) return { ret: 0, msgs: options.messages, get_updates_buf: 'cursor-1' }
      throw new TimeoutError('空轮询')
    },
    sendText: async (_creds: Credentials, to: string, token: string, text: string): Promise<number> => {
      harness.sent.push({ to, token, text })
      return 1
    },
    sendTyping: async (): Promise<void> => {},
  }

  const bridge = createBridge({
    creds,
    getConfig: () => options.config ?? normalizeConfig({}),
    generate: async () => ({ text: options.generateText ?? '收到啦', ok: true }),
    log: (entry) => harness.logs.push(entry),
    onStatus: () => {},
    api: api as never,
  })

  return { bridge, harness }
}

test('收到一条文本 → 生成回复 → 发回去，并带上 context_token', async () => {
  const { bridge, harness } = makeBridge({ messages: [message] })
  bridge.start()
  await waitFor(() => harness.sent.length === 1)
  bridge.stop()

  assert.deepEqual(harness.sent[0], { to: 'u@im.wechat', token: 'ctx-1', text: '收到啦' })
  const inbound = harness.logs.find((entry) => entry.dir === 'in')
  assert.equal(inbound?.text, '在吗')
})

test('同一条消息不会被回复两次（游标 + 去重都落盘）', async () => {
  const first = makeBridge({ messages: [message] })
  first.bridge.start()
  await waitFor(() => first.harness.sent.length === 1)
  first.bridge.stop()
  await sleep(60)

  const second = makeBridge({ messages: [message] })
  second.bridge.start()
  await sleep(150)
  second.bridge.stop()

  assert.equal(second.harness.sent.length, 0)
  assert.ok(second.harness.logs.some((entry) => entry.text.includes('重复消息')))
})

test('总开关关掉时不回复，但日志留痕', async () => {
  const config = normalizeConfig({ enabled: false })
  const { bridge, harness } = makeBridge({ messages: [message], config })
  bridge.start()
  await waitFor(() => harness.logs.some((entry) => entry.text.includes('总开关关闭')))
  bridge.stop()

  assert.equal(harness.sent.length, 0)
})

test('模型失败时把兜底话术发出去，并记一条失败日志', async () => {
  const harness: Harness = { sent: [], logs: [] }
  let polls = 0

  const bridge = createBridge({
    creds,
    getConfig: () => normalizeConfig({}),
    generate: async () => ({ text: '我这边卡了一下', ok: false, error: 'AUTH: bad key' }),
    log: (entry) => harness.logs.push(entry),
    onStatus: () => {},
    api: {
      getUpdates: async () => {
        polls++
        if (polls === 1) return { ret: 0, msgs: [message], get_updates_buf: 'c1' } as GetUpdatesResponse
        throw new TimeoutError('空轮询')
      },
      sendText: async (_c: Credentials, to: string, token: string, text: string) => {
        harness.sent.push({ to, token, text })
        return 1
      },
      sendTyping: async () => {},
    } as never,
  })

  bridge.start()
  await waitFor(() => harness.sent.length === 1)
  bridge.stop()

  assert.equal(harness.sent[0].text, '我这边卡了一下')
  assert.ok(harness.logs.some((entry) => entry.text.includes('模型失败')))
})

test('会话失效（-14）时停止轮询并给出重新扫码提示', async () => {
  const harness: Harness = { sent: [], logs: [] }
  const bridge = createBridge({
    creds,
    getConfig: () => normalizeConfig({}),
    generate: async () => ({ text: 'x', ok: true }),
    log: (entry) => harness.logs.push(entry),
    onStatus: () => {},
    api: {
      getUpdates: async () => {
        throw new ILinkError('session timeout', { ret: -14 })
      },
      sendText: async () => 1,
      sendTyping: async () => {},
    } as never,
  })

  bridge.start()
  await waitFor(() => harness.logs.some((entry) => entry.text.includes('会话失效')))
  bridge.stop()

  assert.ok(harness.logs.some((entry) => entry.text.includes('重新扫码')))
})

test('游标失效（ret=-1）时自动重置，并继续收消息', async () => {
  const harness: Harness = { sent: [], logs: [] }
  let polls = 0

  // 先塞一个坏游标，模拟“继承了脏状态”
  const { loadState, saveState } = await import('../src/store.ts')
  const state = loadState()
  state.getUpdatesBuf = 'c1'
  saveState(state)

  const bridge = createBridge({
    creds,
    getConfig: () => normalizeConfig({}),
    generate: async () => ({ text: '恢复成功', ok: true }),
    log: (entry) => harness.logs.push(entry),
    onStatus: () => {},
    api: {
      getUpdates: async () => {
        polls++
        if (polls === 1) throw new ILinkError('bad cursor', { ret: -1 })
        if (polls === 2) return { ret: 0, msgs: [message], get_updates_buf: 'good-cursor' } as GetUpdatesResponse
        throw new TimeoutError('空轮询')
      },
      sendText: async (_c: Credentials, to: string, token: string, text: string) => {
        harness.sent.push({ to, token, text })
        return 1
      },
      sendTyping: async () => {},
    } as never,
  })

  bridge.start()
  await waitFor(() => harness.sent.length === 1)
  bridge.stop()

  assert.equal(harness.sent[0].text, '恢复成功')
  assert.ok(harness.logs.some((entry) => entry.text.includes('游标失效')))
  assert.equal(loadState().getUpdatesBuf, 'good-cursor')
})

test('!dsh 前缀：任务转给 escalate，把它的回答发回去', async () => {
  const harness: Harness = { sent: [], logs: [] }
  const calls: string[] = []
  let polls = 0
  const taskMessage = { ...message, message_id: 2002, item_list: [{ type: 1, text_item: { text: '!dsh 总结一下桌面上的 md' } }] }

  const bridge = createBridge({
    creds,
    // 开源版默认关闭转后台，这个用例要显式打开
    getConfig: () => normalizeConfig({ escalation: { enabled: true, prefix: '!dsh' } }),
    generate: async () => ({ text: '不该走到这里', ok: true }),
    escalate: async (task) => {
      calls.push(task)
      return { text: '这是 agent 的回答', ok: true }
    },
    log: (entry) => harness.logs.push(entry),
    onStatus: () => {},
    api: {
      getUpdates: async () => {
        polls++
        if (polls === 1) return { ret: 0, msgs: [taskMessage], get_updates_buf: 'c2' } as GetUpdatesResponse
        throw new TimeoutError('空轮询')
      },
      sendText: async (_c: Credentials, to: string, token: string, text: string) => {
        harness.sent.push({ to, token, text })
        return 1
      },
      sendTyping: async () => {},
    } as never,
  })

  bridge.start()
  await waitFor(() => harness.sent.length === 1)
  bridge.stop()

  assert.deepEqual(calls, ['总结一下桌面上的 md'])
  assert.equal(harness.sent[0].text, '这是 agent 的回答')
})
