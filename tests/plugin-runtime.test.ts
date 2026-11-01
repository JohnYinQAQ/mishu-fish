import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createRuntime } from '../src/plugin/runtime.ts'
import type { LlmService } from '../src/plugin/reply.ts'

let dir: string

const llm: LlmService = {
  stream() {
    return (async function* () {})()
  },
  listProviders() {
    return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
  },
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-runtime-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('启动时从磁盘回填日志面板', () => {
  const lines = [
    { level: 'info', at: Date.now() - 5000, dir: 'in', text: '之前的一条' },
    { level: 'warn', at: Date.now() - 3000, dir: 'sys', text: '之前的警告', rid: 'aaa111' },
  ]
  fs.writeFileSync(
    path.join(dir, 'mishu.log.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  )

  const runtime = createRuntime({ llm, defaults: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const logs = runtime.logs()
  assert.equal(logs.length, 2)
  assert.equal(logs[0].text, '之前的一条')
  assert.equal(logs[1].rid, 'aaa111')
  runtime.dispose()
})

test('启动时汇总当天用量，忽略昨天及更早的记录', () => {
  const now = Date.now()
  const yesterday = now - 26 * 60 * 60 * 1000
  fs.writeFileSync(
    path.join(dir, 'usage.jsonl'),
    [
      JSON.stringify({ at: yesterday, input: 999, output: 99 }),
      JSON.stringify({ at: now - 1000, input: 100, output: 20 }),
      JSON.stringify({ at: now - 500, input: 300, output: 30 }),
    ].join('\n') + '\n',
    'utf8',
  )

  const runtime = createRuntime({ llm, defaults: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const usage = runtime.usageInfo()
  assert.equal(usage.calls, 2)
  assert.equal(usage.input, 400)
  assert.equal(usage.output, 50)
  runtime.dispose()
})
