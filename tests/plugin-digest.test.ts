import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { normalizeConfig } from '../src/plugin/config.ts'
import { createMemoryStore } from '../src/plugin/memory.ts'
import { buildReportText, parseDigest, runDigest, salvageField } from '../src/plugin/digest.ts'
import { createRuntime } from '../src/plugin/runtime.ts'
import type { LlmService } from '../src/plugin/reply.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-digest-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function jsonLlm(payload: unknown): LlmService {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
}

test('parseDigest: 能剥掉 ```json 包裹', () => {
  const parsed = parseDigest('```json\n{"summary":"今天","facts":"- a","report":"ok"}\n```')
  assert.deepEqual(parsed, { summary: '今天', facts: '- a', report: 'ok' })
})

test('parseDigest: 不是 JSON 时退化成整段摘要', () => {
  const parsed = parseDigest('今天就聊了数学和物理。')
  assert.equal(parsed?.summary, '今天就聊了数学和物理。')
  assert.equal(parsed?.facts, '')
})

test('runDigest: 没有原文时返回 null', async () => {
  const memory = createMemoryStore()
  const result = await runDigest({
    llm: jsonLlm({}),
    config: normalizeConfig({}),
    memory,
    route: { provider: 'deepseek-account', model: 'deepseek-flash' },
    date: new Date(),
  })
  assert.equal(result, null)
})

test('runDigest: 生成摘要、事实卡和汇报，并受 factsLimit 限制', async () => {
  const memory = createMemoryStore()
  memory.append({ at: Date.now(), role: 'user', text: '我物理考了 92', scope: 'chat' })

  const result = await runDigest({
    llm: jsonLlm({ summary: '今天聊了成绩。', facts: '- 物理 92 分', report: '记下了物理 92' }),
    config: normalizeConfig({ memory: { factsLimit: 400 } }),
    memory,
    route: { provider: 'deepseek-account', model: 'deepseek-flash' },
    date: new Date(),
  })

  assert.ok(result)
  assert.equal(result.summary, '今天聊了成绩。')
  assert.equal(result.facts, '- 物理 92 分')
  assert.equal(result.entries, 1)
  assert.match(buildReportText(result!, new Date()), /记忆整理好了/)
})

test('runDigestNow: 写入摘要与事实卡，窗口关闭时挂起日报', async () => {
  const memory = createMemoryStore()
  memory.append({ at: Date.now(), role: 'user', text: '我物理考了 92', scope: 'chat' })

  const runtime = createRuntime({
    llm: jsonLlm({ summary: '今天聊了成绩。', facts: '- 物理 92 分', report: '记下了物理 92' }),
    defaults: { provider: 'deepseek-account', model: 'deepseek-flash' },
    memory,
  })

  const result = await runtime.runDigestNow(new Date())
  assert.equal(result.ok, true)
  assert.equal(result.sent, false) // 测试里没有凭据，发不出去
  assert.match(memory.readSummary(new Date()), /今天聊了成绩/)
  assert.match(memory.facts(), /物理 92/)
  assert.equal(runtime.digestState().pending, true)

  runtime.dispose()
})

test('parseDigest: 被截断的 JSON 也能捞出字段', async () => {
  const truncated = '{"summary":"今天聊了数学和物理","facts":"- 物理 92 分","report":"记下了物理'
  const parsed = parseDigest(truncated)
  assert.ok(parsed)
  assert.equal(parsed!.summary, '今天聊了数学和物理')
  assert.equal(parsed!.facts, '- 物理 92 分')
  assert.equal(parsed!.report, '记下了物理')
})

test('salvageField: 处理转义换行', () => {
  const raw = '{"summary":"第一行\\n第二行"}'
  assert.equal(salvageField(raw, 'summary'), '第一行\n第二行')
})

test('weekKey：同一周同键，跨周变化', async () => {
  const { weekKey } = await import('../src/plugin/digest.ts')
  const monday = new Date(2026, 9, 26)
  const sunday = new Date(2026, 10, 1)
  const nextMonday = new Date(2026, 10, 2)

  assert.equal(weekKey(monday), weekKey(sunday), '周一到周日应该同一周')
  assert.notEqual(weekKey(monday), weekKey(nextMonday))
  assert.match(weekKey(monday), /^\d{4}-W\d{2}$/)
})

test('runWeekly：摘要不足两天时不生成', async () => {
  const { runWeekly } = await import('../src/plugin/digest.ts')
  const memory = {
    readSummary: () => '',
  } as never

  const result = await runWeekly({
    llm: { stream: () => (async function* () {})() } as never,
    config: { memory: { weeklyReport: true } } as never,
    memory,
    route: { provider: 'p', model: 'm' },
  })
  assert.equal(result, null)
})

test('runWeekly：把 7 天摘要合成一条，带标题', async () => {
  const { runWeekly } = await import('../src/plugin/digest.ts')
  const summaries: Record<string, string> = {}
  for (let offset = 1; offset <= 4; offset++) {
    const date = new Date()
    date.setDate(date.getDate() - offset)
    summaries[`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`] = `第 ${offset} 天的摘要`
  }

  const memory = {
    readSummary: (date: Date) => summaries[`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`] ?? '',
  } as never

  const llm = {
    stream: () =>
      (async function* () {
        yield { type: 'text-delta', index: 0, text: '这周主要在弄插件，睡得偏晚。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
  } as never

  const result = await runWeekly({
    llm,
    config: { memory: { weeklyReport: true } } as never,
    memory,
    route: { provider: 'p', model: 'm' },
  })

  assert.ok(result)
  assert.equal(result!.days, 4)
  assert.match(result!.text, /这周的小结/)
  assert.match(result!.text, /睡得偏晚/)
})
