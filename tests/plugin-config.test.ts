import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { DEFAULT_CONFIG, configFile, loadConfig, normalizeConfig, saveConfig } from '../src/plugin/config.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-plugin-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('normalizeConfig: 空输入给默认值', () => {
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG)
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
})

test('normalizeConfig: 越界值被夹紧而不是报错', () => {
  const config = normalizeConfig({
    style: { maxChars: 5, emoji: 'weird', language: 'klingon', markdown: 'yes' },
    behavior: { perMinute: 999, fallback: '' },
    model: { temperature: 9, maxTokens: 10 },
    escalation: { timeoutSec: 1 },
    persona: { template: 'nope' },
  })

  assert.equal(config.style.maxChars, 20)
  assert.equal(config.style.emoji, 'some')
  assert.equal(config.style.language, 'zh')
  assert.equal(config.style.markdown, false)
  assert.equal(config.behavior.perMinute, 30)
  assert.equal(config.model.temperature, 2)
  assert.equal(config.model.maxTokens, 50)
  assert.equal(config.escalation.timeoutSec, 10)
  assert.equal(config.persona.template, 'gentle')
})

test('normalizeConfig: 时间格式不合法就当没设置', () => {
  assert.equal(normalizeConfig({ behavior: { quietStart: '25:00' } }).behavior.quietStart, '')
  assert.equal(normalizeConfig({ behavior: { quietStart: '9:5' } }).behavior.quietStart, '09:05')
  assert.equal(normalizeConfig({ behavior: { quietStart: '23:5' } }).behavior.quietStart, '23:05')
})

test('normalizeConfig: 名字不能被清空成空串', () => {
  assert.equal(normalizeConfig({ persona: { name: '   ' } }).persona.name, '秘书鱼')
  assert.equal(normalizeConfig({ persona: { name: '小鱼' } }).persona.name, '小鱼')
})

test('normalizeConfig: 禁用词去空白、限长', () => {
  const words = normalizeConfig({ persona: { bannedWords: [' 哈哈 ', '', '嗯', 42] } }).persona.bannedWords
  assert.deepEqual(words, ['哈哈', '嗯'])
})

test('saveConfig/loadConfig: 落盘后读回来一致', () => {
  const config = normalizeConfig({ persona: { text: '你是我养的一条鱼。' }, style: { maxChars: 88 } })
  saveConfig(config)
  assert.ok(fs.existsSync(configFile()))
  assert.deepEqual(loadConfig(), config)
})

test('loadConfig: 文件损坏时回默认值，不崩', () => {
  fs.writeFileSync(configFile(), '{ 坏掉的 json')
  assert.deepEqual(loadConfig(), DEFAULT_CONFIG)
})

test('normalizeConfig: memory 默认值与越界夹紧', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.memory.recentCount, 8)
  assert.equal(defaults.memory.summaryTime, '05:00')
  assert.equal(defaults.memory.factsLimit, 400)
  assert.equal(defaults.memory.enabled, true)

  const clamped = normalizeConfig({
    memory: { recentCount: 1, factsLimit: 9999, summaryTime: '25:99', triggerWords: [' 上次 ', '', '那个事'] },
  })
  assert.equal(clamped.memory.recentCount, 4)
  assert.equal(clamped.memory.factsLimit, 1000)
  assert.equal(clamped.memory.summaryTime, '05:00')
  assert.deepEqual(clamped.memory.triggerWords, ['上次', '那个事'])
})

test('normalizeConfig: schedule 默认值与夹紧', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.schedule.eveningTime, '23:00')
  assert.equal(defaults.schedule.morningTime, '07:00')
  assert.equal(defaults.schedule.triggerWord, '记一下')
  assert.equal(defaults.schedule.notifyFallback, true)

  const custom = normalizeConfig({ schedule: { eveningTime: '9:5', morningTime: '25:00', triggerWord: '  ' } })
  assert.equal(custom.schedule.eveningTime, '09:05')
  assert.equal(custom.schedule.morningTime, '07:00')
  // 留空是合法状态：表示“让她自动判断”，不能再回落成默认词
  assert.equal(custom.schedule.triggerWord, '')
  assert.equal(normalizeConfig({}).schedule.triggerWord, '记一下')
})

test('buildSystemPrompt：带上当前本地时间，避免模型把晚上当成早上', async () => {
  const { buildSystemPrompt, formatNow } = await import('../src/plugin/persona.ts')
  const config = normalizeConfig({})
  const night = new Date(2026, 10, 1, 20, 55)
  const morning = new Date(2026, 10, 2, 7, 30)

  assert.equal(formatNow(night), '2026-11-01 周日 20:55')

  const prompt = buildSystemPrompt(config, '', undefined, night)
  assert.match(prompt, /现在/)
  assert.match(prompt, /2026-11-01 周日 20:55/)
  assert.match(prompt, /本地时间/)

  assert.match(buildSystemPrompt(config, '', undefined, morning), /07:30/)
})

test('normalizeConfig: 原话检索范围默认 30 天，可改并夹紧', () => {
  assert.equal(normalizeConfig({}).memory.recallDays, 30)
  assert.equal(normalizeConfig({ memory: { recallDays: 14 } }).memory.recallDays, 14)
  assert.equal(normalizeConfig({ memory: { recallDays: 0 } }).memory.recallDays, 1)
  assert.equal(normalizeConfig({ memory: { recallDays: 999 } }).memory.recallDays, 90)
})
