import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  composeImageReply,
  createTopicStore,
  parseImageReply,
  shouldRecordTopic,
  topicFactLine,
} from '../src/plugin/image-reply.ts'
import { normalizeConfig } from '../src/plugin/config.ts'
import type { LlmService } from '../src/plugin/reply.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-img-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function llmReturning(text: string): LlmService {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
}

test('parseImageReply：解析回应和主题', () => {
  const parsed = parseImageReply('{"reply":"主人在海边吗喵，风大不大？","topic":"海边"}')
  assert.equal(parsed?.topic, '海边')
  assert.deepEqual(parsed?.keywords, [])
  assert.match(parsed!.reply, /海边/)

  assert.equal(parseImageReply('不是 JSON'), null, '解析失败返回 null')
  assert.equal(parseImageReply('{"reply":"","topic":"海边"}'), null, '没有回应也算失败')
})

test('composeImageReply：一次调用同时拿到回应和主题', async () => {
  const llm = llmReturning('{"reply":"这张图看着像在教室喵","topic":"学校"}')
  const result = await composeImageReply(
    llm,
    { provider: 'p', model: 'm' },
    normalizeConfig({}),
    '- 主人是在校学生',
    '一张教室的照片，桌上有书',
    [{ role: 'user', text: '今天有课' }],
  )
  assert.equal(result?.topic, '学校')
  assert.match(result!.reply, /教室/)
})

test('createTopicStore：同一主题跨天累计', () => {
  const store = createTopicStore()
  store.record('海边', 'category', new Date(2026, 10, 1, 10).getTime())
  store.record('海边', 'category', new Date(2026, 10, 2, 11).getTime())
  store.record('海边', 'category', new Date(2026, 10, 2, 12).getTime())

  const [record] = store.list()
  assert.equal(record.topic, '海边')
  assert.equal(record.count, 3)
  assert.equal(record.days.length, 2, '同一天只算一天')
})

test('shouldRecordTopic：5 次且跨 3 天才写进事实卡', () => {
  const base = { topic: '海边', kind: 'category' as const, firstSeen: 0, lastSeen: 0 }
  assert.equal(shouldRecordTopic({ ...base, count: 5, days: ['1', '2'] }), false)
  assert.equal(shouldRecordTopic({ ...base, count: 5, days: ['1', '2', '3'] }), true)
  assert.equal(shouldRecordTopic({ ...base, count: 4, days: ['1', '2', '3'] }), false)
  assert.equal(topicFactLine('海边'), '- 常发海边相关的图片')
  assert.equal(topicFactLine('猫', 'keyword'), '- 常发与「猫」有关的图片')
  assert.equal(parseImageReply('{"reply":"喵","topic":"宠物","keywords":["猫","沙发"]}')?.keywords.length, 2)
})

test('mergeKeyword：近义词并到已有标签', async () => {
  const { mergeKeyword } = await import('../src/plugin/image-reply.ts')
  assert.equal(mergeKeyword('海边日落', ['海边日落']), '海边日落')
  assert.equal(mergeKeyword('落日', ['海边日落']), '海边日落', '包含关系要并')
  assert.equal(mergeKeyword('海边黄昏', ['海边日落']), '海边日落', '相近也要并')
  assert.equal(mergeKeyword('熊猫', ['猫']), '熊猫', '短词不能被吞掉')
  assert.equal(mergeKeyword('图书馆', ['海边日落']), '图书馆', '不同的词要保留')
})

test('composeImageReply：把已有标签喂给模型，并做本地归一', async () => {
  const llm = llmReturning('{"reply":"又去海边啦喵","topic":"风景","keywords":["落日"]}')
  const result = await composeImageReply(
    llm,
    { provider: 'p', model: 'm' },
    normalizeConfig({}),
    '',
    '海边日落',
    [],
    ['海边日落', '猫'],
  )
  assert.deepEqual(result?.keywords, ['海边日落'])
})
