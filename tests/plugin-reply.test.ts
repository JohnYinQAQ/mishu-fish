import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig } from '../src/plugin/config.ts'
import { extractDelta, extractFailure, generateReply, resolveRoute } from '../src/plugin/reply.ts'
import type { LlmService } from '../src/plugin/reply.ts'

interface Behavior {
  chunks?: unknown[]
  throws?: string
}

function makeLlm(behaviors: Behavior[]): LlmService & { calls: Record<string, unknown>[] } {
  let index = 0
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    stream(options: Record<string, unknown>) {
      calls.push(options)
      const behavior = behaviors[Math.min(index, behaviors.length - 1)]
      index++
      return (async function* () {
        for (const chunk of behavior.chunks ?? []) yield chunk
        if (behavior.throws) throw new Error(behavior.throws)
      })()
    },
  }
}

const defaults = { provider: 'deepseek-account', model: 'deepseek-flash' }

test('extractDelta: 兼容几种 chunk 形态', () => {
  assert.equal(extractDelta({ kind: 'text-delta', delta: 'abc' }), 'abc')
  assert.equal(extractDelta({ type: 'text-delta', text: 'abc' }), 'abc')
  assert.equal(extractDelta({ kind: 'text', content: 'abc' }), 'abc')
  assert.equal(extractDelta({ kind: 'usage', total: 12 }), '')
  assert.equal(extractDelta(null), '')
})

test('extractFailure: 认 finish.reason 里的失败（真实协议）', () => {
  assert.equal(extractFailure({ type: 'text-delta', index: 0, text: 'x' }), null)
  assert.match(
    String(extractFailure({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })),
    /AUTH/,
  )
  assert.equal(extractFailure({ type: 'finish', reason: { kind: 'aborted', failure: {} } }), 'aborted')
  assert.equal(extractFailure({ type: 'finish', reason: { kind: 'stop' } }), null)
})

test('resolveRoute: 继承 vs 手动', () => {
  assert.deepEqual(resolveRoute(normalizeConfig({}), defaults), defaults)
  const manual = normalizeConfig({ model: { mode: 'manual', provider: 'openai', model: 'gpt-x' } })
  assert.deepEqual(resolveRoute(manual, defaults), { provider: 'openai', model: 'gpt-x' })
})

test('generateReply: 拼出增量文本', async () => {
  const llm = makeLlm([{ chunks: [{ kind: 'text-delta', delta: '你好' }, { kind: 'text-delta', delta: '呀' }, { kind: 'usage' }] }])
  const result = await generateReply(llm, normalizeConfig({}), '在吗', defaults)

  assert.equal(result.ok, true)
  assert.equal(result.text, '你好呀')
  assert.equal(llm.calls.length, 1)
  const options = llm.calls[0] as { provider: string; model: string; messages: unknown[]; system?: string }
  assert.equal(options.provider, defaults.provider)
  assert.equal((options.messages as unknown[]).length, 1)
  assert.ok(options.system && options.system.includes('秘书鱼'))
})

test('generateReply: 关掉 Markdown 时自动清洗', async () => {
  const llm = makeLlm([{ chunks: [{ kind: 'text-delta', delta: '**重点**`code`' }] }])
  const result = await generateReply(llm, normalizeConfig({ style: { markdown: false } }), '说重点', defaults)
  assert.equal(result.text, '重点code')
})

test('generateReply: 第一次失败后退回合并形态再试一次', async () => {
  const llm = makeLlm([{ throws: 'NO_ADAPTER' }, { chunks: [{ kind: 'text-delta', delta: '第二次成功' }] }])
  const result = await generateReply(llm, normalizeConfig({}), '在吗', defaults)

  assert.equal(result.ok, true)
  assert.equal(result.text, '第二次成功')
  assert.equal(llm.calls.length, 2)
  const retry = llm.calls[1] as { messages: Array<{ role: string }> }
  assert.equal(retry.messages.length, 1)
  assert.equal(retry.messages[0].role, 'user')
})

test('generateReply: 两次都失败就走兜底话术，并把错误带出来', async () => {
  const llm = makeLlm([{ throws: 'AUTH: bad key' }])
  const config = normalizeConfig({ behavior: { fallback: '我这边卡了一下。' } })
  const result = await generateReply(llm, config, '在吗', defaults)

  assert.equal(result.ok, false)
  assert.equal(result.text, '我这边卡了一下。')
  assert.match(result.error ?? '', /AUTH/)
})

test('generateReply: 流里出现 finish.reason=error 也算失败', async () => {
  const llm = makeLlm([
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '半句' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } },
      ],
    },
  ])
  const result = await generateReply(llm, normalizeConfig({}), '在吗', defaults)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /RATE_LIMIT/)
})

test('generateReply: 默认路由缺凭据时自动换下一条可用路由', async () => {
  const llm = makeLlm([
    { throws: 'MISSING_CREDENTIAL: no API key' },
    { throws: 'MISSING_CREDENTIAL: no API key' },
    { chunks: [{ type: 'text-delta', index: 0, text: '换路由后成功' }, { type: 'finish', reason: { kind: 'stop' } }] },
  ])

  const result = await generateReply(llm, normalizeConfig({}), '在吗', [
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'deepseek-account', model: 'deepseek-flash' },
  ])

  assert.equal(result.ok, true)
  assert.equal(result.text, '换路由后成功')
  assert.equal(result.provider, 'deepseek-account')
  assert.equal(llm.calls.length, 3)
})

test('generateReply: 历史与事实卡都进请求', async () => {
  const llm = makeLlm([{ chunks: [{ type: 'text-delta', index: 0, text: '记得，你叫小明' }] }])
  const history = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: '我叫小明' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: '记住了' }] },
  ]

  const result = await generateReply(llm, normalizeConfig({}), '我叫什么', defaults, {
    history,
    facts: '- 称呼：小明',
  })

  assert.equal(result.ok, true)
  const options = llm.calls[0] as { messages: unknown[]; system: string }
  assert.equal(options.messages.length, 3)
  assert.match(options.system, /称呼：小明/)
})

test('generateReply: 收下 usage（input/output）', async () => {
  const llm = makeLlm([
    {
      chunks: [
        { type: 'text-delta', index: 0, text: '好' },
        { type: 'usage', usage: { inputTokens: 321, outputTokens: 45 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    },
  ])
  const result = await generateReply(llm, normalizeConfig({}), '在吗', defaults)
  assert.deepEqual(result.usage, { input: 321, output: 45 })
})
