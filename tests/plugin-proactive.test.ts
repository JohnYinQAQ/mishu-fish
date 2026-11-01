import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig } from '../src/plugin/config.ts'
import { buildProactiveMessages, generateProactive } from '../src/plugin/proactive.ts'
import type { LlmService } from '../src/plugin/reply.ts'

const defaults = { provider: 'deepseek-account', model: 'deepseek-flash' }

function llmReturning(text: string, options: { throws?: boolean } = {}): LlmService {
  return {
    stream() {
      return (async function* () {
        if (options.throws) throw new Error('MISSING_CREDENTIAL')
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
}

test('buildProactiveMessages：人设、事实卡、当天事项、上一次的话都进提示词', () => {
  const config = normalizeConfig({ persona: { name: '秘书鱼', callUser: '主人', text: '别客套。' } })
  const { system, user } = buildProactiveMessages(config, '- 物理 92 分', {
    kind: 'morning',
    today: ['14:00 去图书馆'],
    rhythm: '通常 07:45 起',
    previous: '早上好，今天也要加油。',
  })

  assert.match(system, /秘书鱼/)
  assert.match(system, /物理 92 分/)
  assert.match(system, /不能重复|必须换一种说法/)
  assert.match(system, /不超过 \d+ 字/)
  assert.match(user, /14:00 去图书馆/)
  assert.match(user, /07:45/)
  assert.match(user, /上一次我说过/)
})

test('buildProactiveMessages：不同场景的任务说明不同', () => {
  const config = normalizeConfig({})
  const start = buildProactiveMessages(config, '', { kind: 'homework-start' }).system
  const nudge = buildProactiveMessages(config, '', { kind: 'homework-nudge' }).system
  const evening = buildProactiveMessages(config, '', { kind: 'evening' }).system

  assert.match(start, /打算多久写完/)
  assert.match(nudge, /写完了没有/)
  assert.match(evening, /早点睡/)
})

test('generateProactive：清洗 Markdown、空回复返回 null', async () => {
  const config = normalizeConfig({})
  const text = await generateProactive(llmReturning('**早上好**，主人'), defaults, config, '', { kind: 'morning' })
  assert.equal(text, '早上好，主人')

  const empty = await generateProactive(llmReturning('   '), defaults, config, '', { kind: 'morning' })
  assert.equal(empty, null)
})

test('generateProactive：模型失败会抛出，调用方兜底', async () => {
  const config = normalizeConfig({})
  await assert.rejects(
    generateProactive(llmReturning('', { throws: true }), defaults, config, '', { kind: 'evening' }),
    /MISSING_CREDENTIAL/,
  )
})
