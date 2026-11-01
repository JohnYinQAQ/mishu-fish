import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeConfig } from '../src/plugin/config.ts'
import {
  TEMPLATE_PRESETS,
  buildEscalationPrompt,
  buildMergedMessages,
  buildSystemPrompt,
  buildUserMessages,
  inQuietHours,
  stripMarkdown,
  templateText,
} from '../src/plugin/persona.ts'

test('模板：四套预设 + 自定义', () => {
  assert.equal(TEMPLATE_PRESETS.length, 5)
  assert.ok(templateText('gentle').includes('轻'))
  assert.equal(templateText('custom'), '')
})

test('系统提示词：包含名字、模板、自由文本、长度、禁用词', () => {
  const config = normalizeConfig({
    persona: {
      name: '小鱼',
      selfCall: '本鱼',
      callUser: '主人',
      template: 'blunt',
      text: '你说话要像我认识十年的朋友，别客气。',
      bannedWords: ['亲', '呢'],
    },
    style: { maxChars: 60, emoji: 'none', language: 'zh', markdown: false },
  })

  const prompt = buildSystemPrompt(config)
  assert.ok(prompt.includes('小鱼'))
  assert.ok(prompt.includes('本鱼'))
  assert.ok(prompt.includes('主人'))
  assert.ok(prompt.includes('直说'))
  assert.ok(prompt.includes('认识十年的朋友'))
  assert.ok(prompt.includes('60'))
  assert.ok(prompt.includes('亲、呢'))
  assert.ok(prompt.includes('不要使用任何 emoji'))
  assert.ok(prompt.includes('如实回答'))
})

test('系统提示词：custom 模板时不包含预设语气', () => {
  const config = normalizeConfig({ persona: { template: 'custom', text: '只按我写的来。' } })
  const prompt = buildSystemPrompt(config)
  assert.ok(prompt.includes('只按我写的来'))
  assert.ok(!prompt.includes('温柔'))
})

test('提示词是纯函数：同配置两次结果一样', () => {
  const config = normalizeConfig({ persona: { text: '随便写点' } })
  assert.equal(buildSystemPrompt(config), buildSystemPrompt(config))
})

test('buildUserMessages: 只产出 user 消息（system 走独立字段）', () => {
  const messages = buildUserMessages('在吗')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content[0].text, '在吗')
})

test('buildMergedMessages: 兼容模式把提示词并进 user', () => {
  const merged = buildMergedMessages(normalizeConfig({}), '在吗')
  assert.equal(merged.length, 1)
  assert.equal(merged[0].role, 'user')
  assert.ok(merged[0].content[0].text.includes('在吗'))
  assert.ok(merged[0].content[0].text.includes('秘书鱼'))
})

test('stripMarkdown: 清掉微信不渲染的符号', () => {
  const input = '## 标题\n**重点** 和 `代码`\n- 第一项\n- 第二项'
  const output = stripMarkdown(input)
  assert.equal(output.includes('##'), false)
  assert.equal(output.includes('**'), false)
  assert.equal(output.includes('`'), false)
  assert.ok(output.includes('重点'))
})

test('inQuietHours: 支持跨零点', () => {
  const config = normalizeConfig({ behavior: { quietStart: '23:00', quietEnd: '07:00' } })
  assert.equal(inQuietHours(config, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inQuietHours(config, new Date(2026, 0, 1, 3, 0)), true)
  assert.equal(inQuietHours(config, new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(inQuietHours(config, new Date(2026, 0, 1, 7, 0)), false)
})

test('inQuietHours: 没设置时段就永远不静音', () => {
  const config = normalizeConfig({ behavior: { quietStart: '', quietEnd: '' } })
  assert.equal(inQuietHours(config, new Date(2026, 0, 1, 3, 0)), false)
})

test('系统提示词：检索到的记忆单独成块，并标注可能过期', () => {
  const config = normalizeConfig({})
  const prompt = buildSystemPrompt(config, '- 称呼：主人', '- [10-28 21:00] 主人：物理考了 92')
  assert.match(prompt, /检索到的相关记忆/)
  assert.match(prompt, /物理考了 92/)
  assert.match(prompt, /可能过期/)
})

test('buildEscalationPrompt: 把人设、事实卡、最近对话和输出约束一起包进去', () => {
  const config = normalizeConfig({
    persona: { name: '秘书鱼', callUser: '主人', template: 'blunt', text: '别客气。' },
    style: { maxChars: 100 },
  })

  const prompt = buildEscalationPrompt(config, {
    facts: '- 物理 92 分',
    recent: [{ role: 'user', text: '我物理考了 92' }],
    task: '帮我查一下电量',
  })

  assert.match(prompt, /秘书鱼/)
  assert.match(prompt, /主人/)
  assert.match(prompt, /别客气/)
  assert.match(prompt, /物理 92 分/)
  assert.match(prompt, /我物理考了 92/)
  assert.match(prompt, /纯文本/)
  assert.match(prompt, /帮我查一下电量/)
  // 任务必须在最后，模型先读背景再读任务
  assert.ok(prompt.trimEnd().endsWith('帮我查一下电量'))
})
