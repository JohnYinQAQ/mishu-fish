import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createMemoryStore } from '../src/plugin/memory.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-memory-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('append → recent：按时间正序返回，且只取 scope 匹配的', () => {
  const store = createMemoryStore()
  const base = Date.now() - 5000
  store.append({ at: base, role: 'user', text: '第一句', scope: 'chat' })
  store.append({ at: base + 1000, role: 'assistant', text: '第一句的回复', scope: 'chat' })
  store.append({ at: base + 2000, role: 'user', text: '后台任务', scope: 'agent' })
  store.append({ at: base + 3000, role: 'user', text: '第二句', scope: 'chat' })

  const recent = store.recent(3, { scope: 'chat' })
  assert.deepEqual(recent.map((entry) => entry.text), ['第一句', '第一句的回复', '第二句'])

  const agentOnly = store.recent(10, { scope: 'agent' })
  assert.deepEqual(agentOnly.map((entry) => entry.text), ['后台任务'])
})

test('recent：能翻到前一天的记录', () => {
  const store = createMemoryStore()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(22, 0, 0, 0)

  store.append({ at: yesterday.getTime(), role: 'user', text: '昨天说的话', scope: 'chat' })
  store.append({ at: Date.now(), role: 'user', text: '今天说的话', scope: 'chat' })

  const recent = store.recent(5, { scope: 'chat' })
  assert.deepEqual(recent.map((entry) => entry.text), ['昨天说的话', '今天说的话'])
})

test('recent：坏行跳过，不影响其它记录', () => {
  const store = createMemoryStore()
  store.append({ at: Date.now(), role: 'user', text: '好的记录', scope: 'chat' })
  fs.appendFileSync(store.dayFile(), '{ 这不是 json\n', 'utf8')

  const recent = store.recent(5)
  assert.equal(recent.length, 1)
  assert.equal(recent[0].text, '好的记录')
})

test('facts：读不到时返回空串，写入后可读回', () => {
  const store = createMemoryStore()
  assert.equal(store.facts(), '')
  store.writeFacts('- 称呼：主人\n- 作息：晚睡')
  assert.match(store.facts(), /称呼：主人/)
})

test('文件权限：目录 0700，日志 0600', () => {
  const store = createMemoryStore()
  store.append({ at: Date.now(), role: 'user', text: 'x', scope: 'chat' })
  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(store.dayFile()).mode & 0o777, 0o600)
})

test('接口稳定：MemoryStore 只暴露约定的几个动作', () => {
  const store = createMemoryStore()
  assert.deepEqual(Object.keys(store).sort(), ['append', 'day', 'dayFile', 'dir', 'facts', 'hasDigest', 'readSummary', 'recent', 'search', 'summariesDir', 'writeFacts', 'writeSummary'])
})

test('search: 中文二元组能命中相关旧话', () => {
  const store = createMemoryStore()
  const now = Date.now()
  store.append({ at: now - 3000, role: 'user', text: '我物理考了 92 分', scope: 'chat' })
  store.append({ at: now - 2000, role: 'user', text: '今天天气不错', scope: 'chat' })

  const hits = store.search('还记得物理吗', { days: 7, limit: 3, scope: 'chat' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].text, '我物理考了 92 分')
  assert.equal(hits[0].role, 'user')
})

test('search: 不超过 limit，且只搜指定 scope', () => {
  const store = createMemoryStore()
  const now = Date.now()
  for (let index = 0; index < 5; index++) {
    store.append({ at: now - index * 1000, role: 'user', text: `物理作业第 ${index} 题`, scope: 'chat' })
  }
  store.append({ at: now, role: 'user', text: '物理 agent 任务', scope: 'agent' })

  const hits = store.search('物理作业', { days: 7, limit: 2, scope: 'chat' })
  assert.equal(hits.length, 2)
  assert.ok(hits.every((hit) => hit.scope === 'chat'))
})
