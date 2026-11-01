import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import plugin from '../lib/index.js'

/**
 * 宿主半边的接线测试：用假的 ctx 模拟 DSH，验证
 *   1. dist 能加载（构建产物路径没写错）
 *   2. 四条路由都注册上了
 *   3. 信任栅栏真的在拦
 *   4. 配置能存能读
 * 不需要真的启动 DSH。
 */

interface FakeRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

interface FakeResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader(name: string, value: string): void
  end(body?: string): void
}

let dir: string
let routes: Map<string, FakeRoute>
let cleanups: Array<() => void>
let rejection: number | undefined

function makeReq(options: { host?: string; method?: string; body?: unknown }): unknown {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  return Object.assign(Readable.from(chunks), {
    headers: { host: options.host ?? '127.0.0.1:63088' },
    method: options.method ?? 'GET',
  })
}

function makeRes(): FakeResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value
    },
    end(body?: string) {
      this.body = body ?? ''
    },
  }
}

async function call(
  pathname: string,
  options: { host?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routes.get(pathname)
  assert.ok(route, `路由没注册：${pathname}`)
  const res = makeRes()
  await route.handler(makeReq(options), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

async function waitReady(timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const { json } = await call('/dsh-secretary/api/state')
      if (json.ok === true) return
    } catch {
      /* 还没注册好 */
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('插件没能在 6 秒内完成初始化')
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-host-'))
  process.env.MISHU_HOME = dir
  routes = new Map()
  cleanups = []

  const fakeCtx = {
    webServer: {
      register(route: FakeRoute) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      requestRejection() {
        return rejection
      },
    },
    llm: {
      async *stream() {
        yield { kind: 'text-delta', delta: 'x' }
      },
      listProviders() {
        return [{ provider: 'deepseek-account', models: ['deepseek-flash'] }]
      },
    },
    agents: {
      get() {
        return undefined
      },
      async create() {
        throw new Error('测试里不创建真实 agent')
      },
    },
    get(name: string) {
      if (name === 'connection') return this.connection
      if (name === 'llm') return this.llm
      if (name === 'agents') return this.agents
      return undefined
    },
    on() {
      return () => {}
    },
    effect(fn: () => unknown) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose as () => void)
    },
  }

  plugin.apply(fakeCtx as never)
  await waitReady()
})

after(() => {
  for (const dispose of cleanups) {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('四条路由都注册上了', () => {
  assert.ok(routes.has('/dsh-secretary/api/state'))
  assert.ok(routes.has('/dsh-secretary/api/config'))
  assert.ok(routes.has('/dsh-secretary/api/control'))
  assert.ok(routes.has('/dsh-secretary/api/log'))
})

test('GET /state 返回配置、状态和 provider 列表', async () => {
  const { status, json } = await call('/dsh-secretary/api/state')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  const config = json.config as { persona: { name: string } }
  assert.equal(config.persona.name, '秘书鱼')
  const statusBody = json.status as { running: boolean; accountId: string }
  assert.equal(statusBody.running, false)
  assert.equal(statusBody.accountId, '')
  assert.deepEqual(json.providers, [{ provider: 'deepseek-account', models: ['deepseek-flash'] }])
})

test('POST /config 改人设，GET 能读回来（落盘）', async () => {
  const saved = await call('/dsh-secretary/api/config', {
    method: 'POST',
    body: { config: { persona: { name: '小鱼', text: '你有点毒舌。' } } },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.ok, true)

  const config = saved.json.config as { persona: { name: string; text: string } }
  assert.equal(config.persona.name, '小鱼')
  assert.equal(config.persona.text, '你有点毒舌。')

  const file = path.join(dir, 'config.json')
  assert.ok(fs.existsSync(file))
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).persona.name, '小鱼')
})

test('POST /config 会夹紧越界值，不报错', async () => {
  const saved = await call('/dsh-secretary/api/config', {
    method: 'POST',
    body: { config: { style: { maxChars: 9999 }, behavior: { perMinute: 0 } } },
  })
  const config = saved.json.config as { style: { maxChars: number }; behavior: { perMinute: number } }
  assert.equal(config.style.maxChars, 2000)
  assert.equal(config.behavior.perMinute, 1)
})

test('POST /control: 未知动作返回 400', async () => {
  const result = await call('/dsh-secretary/api/control', { method: 'POST', body: { action: 'nuke' } })
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
})

test('POST /control: start 在没有凭据时给出可读的错误', async () => {
  const result = await call('/dsh-secretary/api/control', { method: 'POST', body: { action: 'start' } })
  assert.equal(result.json.ok, true)
  const status = result.json.status as { running: boolean; lastError: string }
  assert.equal(status.running, false)
  assert.match(status.lastError, /机器人账号|登录/)
})

test('信任栅栏：非回环 Host 一律 403', async () => {
  const result = await call('/dsh-secretary/api/state', { host: 'evil.example.com' })
  assert.equal(result.status, 403)
  assert.equal(result.json.ok, false)
})

test('信任栅栏：connection 拒绝时按它的状态码拒绝', async () => {
  rejection = 401
  try {
    const result = await call('/dsh-secretary/api/state')
    assert.equal(result.status, 401)
  } finally {
    rejection = undefined
  }
})

test('日志接口能读、能清', async () => {
  const before = await call('/dsh-secretary/api/log')
  assert.equal(before.json.ok, true)
  assert.ok(Array.isArray(before.json.logs))

  const cleared = await call('/dsh-secretary/api/log', { method: 'DELETE' })
  assert.deepEqual(cleared.json.logs, [])
})
