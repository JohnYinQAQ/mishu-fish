import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createRuntime } from '../src/plugin/runtime.ts'
import type { LlmService } from '../src/plugin/reply.ts'

let dir: string

function llmReturning(payload: unknown, options: { throws?: boolean } = {}): LlmService {
  return {
    stream() {
      return (async function* () {
        if (options.throws) throw new Error('MISSING_CREDENTIAL: 测试里故意失败')
        yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
}

function makeRuntime(llm: LlmService) {
  const runtime = createRuntime({ llm, defaults: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  // 这些用例测的是日程/完成/习惯，首次自我介绍会抢在前面，默认关掉
  runtime.updateConfig({ onboarding: { welcome: false } })
  return runtime
}

/** 需要测首次介绍的用例用这个 */
function makeRuntimeWithWelcome(llm: LlmService) {
  const runtime = createRuntime({ llm, defaults: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  runtime.updateConfig({ onboarding: { welcome: true } })
  return runtime
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-sched-chat-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('“记一下：周五交报告” → 解析并写入，回复里带时间', async () => {
  const due = new Date(2026, 10, 1, 23, 59)
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: due.toISOString() }))
  const reply = await runtime.quickReply('记一下：周五交报告', runtime.getConfig())

  assert.ok(reply)
  assert.match(reply!, /记下了：交报告/)
  assert.equal(runtime.scheduleList().length, 1)
  assert.equal(runtime.scheduleList()[0].source, 'chat')
  runtime.dispose()
})

test('没提时间 → 按无期限记，并说明', async () => {
  const runtime = makeRuntime(llmReturning({ title: '问老师那道题', due: null }))
  const reply = await runtime.quickReply('记一下：问老师那道题', runtime.getConfig())

  assert.match(reply!, /没有时间/)
  assert.equal(runtime.scheduleList()[0].due, null)
  runtime.dispose()
})

test('模型没给时间、但话里有“周五” → 兜底到那天结束前', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  const reply = await runtime.quickReply('记一下：周五交报告', runtime.getConfig())

  assert.match(reply!, /结束前/)
  const item = runtime.scheduleList()[0]
  assert.ok(item.due, '应该有一个兜底日期，而不是无期限')
  assert.equal(new Date(item.due!).getDay(), 5, '周五')
  assert.equal(new Date(item.due!).getHours(), 23)
  runtime.dispose()
})

test('解析模型失败 → 不写入，给出可操作的提示', async () => {
  const runtime = makeRuntime(llmReturning({}, { throws: true }))
  const reply = await runtime.quickReply('记一下：周五交报告', runtime.getConfig())

  assert.match(reply!, /没解析成功/)
  assert.equal(runtime.scheduleList().length, 0)
  runtime.dispose()
})

test('查询：今天有什么安排', async () => {
  const today = new Date()
  today.setHours(20, 0, 0, 0)
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: today.toISOString() }))
  await runtime.quickReply('记一下：今晚交报告', runtime.getConfig())

  const reply = await runtime.quickReply('我今天有什么安排', runtime.getConfig())
  assert.match(reply!, /今天有 1 件事/)
  assert.match(reply!, /交报告/)
  runtime.dispose()
})

test('完成：“报告交了” 把待办标成完成', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  await runtime.quickReply('记一下：交报告', runtime.getConfig())

  const reply = await runtime.quickReply('报告交了', runtime.getConfig())
  assert.match(reply!, /标记完成了/)
  assert.equal(runtime.scheduleList()[0].status, 'done')
  runtime.dispose()
})

test('普通聊天不受影响：返回 null，交给模型', async () => {
  const runtime = makeRuntime(llmReturning({ title: 'x' }))
  assert.equal(await runtime.quickReply('今天好累', runtime.getConfig()), null)
  assert.equal(await runtime.quickReply('帮我安排一下', runtime.getConfig()), null)
  runtime.dispose()
})

test('日程关掉后，指令不再生效', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  runtime.updateConfig({ schedule: { enabled: false } })
  assert.equal(await runtime.quickReply('记一下：交报告', runtime.getConfig()), null)
  runtime.dispose()
})

test('完成：口语化的“木条已经带到学校了”也能标记', async () => {
  const runtime = makeRuntime(llmReturning({ title: '把木条带到学校', due: null }))
  await runtime.quickReply('记一下：明天早上把木条带到学校', runtime.getConfig())
  const reply = await runtime.quickReply('我木条已经带到学校了', runtime.getConfig())
  assert.match(reply!, /标记完成了/)
  assert.equal(runtime.scheduleList()[0].status, 'done')
  runtime.dispose()
})

test('完成语气但没有对应待办 → 当作普通聊天，不硬猜', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  await runtime.quickReply('记一下：交报告', runtime.getConfig())
  assert.equal(await runtime.quickReply('我今天吃了饭', runtime.getConfig()), null)
  assert.equal(runtime.scheduleList()[0].status, 'pending')
  runtime.dispose()
})

test('开启“完成前先确认”：先问一句，回“是”才改', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  runtime.updateConfig({ schedule: { confirmOnComplete: true } })
  await runtime.quickReply('记一下：交报告', runtime.getConfig())

  const ask = await runtime.quickReply('报告交了', runtime.getConfig())
  assert.match(ask!, /标记成完成吗/)
  assert.equal(runtime.scheduleList()[0].status, 'pending')

  const yes = await runtime.quickReply('是', runtime.getConfig())
  assert.match(yes!, /标记完成了/)
  assert.equal(runtime.scheduleList()[0].status, 'done')
  runtime.dispose()
})

test('二次确认：回“不是”就保留', async () => {
  const runtime = makeRuntime(llmReturning({ title: '交报告', due: null }))
  runtime.updateConfig({ schedule: { confirmOnComplete: true } })
  await runtime.quickReply('记一下：交报告', runtime.getConfig())
  await runtime.quickReply('报告交了', runtime.getConfig())

  const no = await runtime.quickReply('不是', runtime.getConfig())
  assert.match(no!, /先留着/)
  assert.equal(runtime.scheduleList()[0].status, 'pending')
  runtime.dispose()
})

test('完成：口语“我到图书馆了”能标记对应待办', async () => {
  const due = new Date(2026, 9, 30, 14, 0).toISOString()
  const runtime = makeRuntime(llmReturning({ title: '去图书馆', due }))
  await runtime.quickReply('记一下：明天下午2:00去图书馆', runtime.getConfig())
  const reply = await runtime.quickReply('我到图书馆了', runtime.getConfig())
  assert.match(reply!, /标记完成了/)
  assert.equal(runtime.scheduleList()[0].status, 'done')
  runtime.dispose()
})

function llmRouter(schedulePayload: unknown, verdict: boolean, counter?: { calls: string[] }): LlmService {
  return {
    stream(options: Record<string, unknown>) {
      const system = String(options.system ?? '')
      const isClassify = system.includes('报告某件事已经做完了')
      if (counter) counter.calls.push(isClassify ? 'classify' : 'parse')
      const payload = isClassify ? { done: verdict } : schedulePayload
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

test('语气不明但标题对得上 → 问模型，判定为是就完成', async () => {
  const due = new Date(2026, 9, 30, 14, 0).toISOString()
  const counter = { calls: [] as string[] }
  const runtime = makeRuntime(llmRouter({ title: '去图书馆', due }, true, counter))
  await runtime.quickReply('记一下：明天下午2:00去图书馆', runtime.getConfig())

  const reply = await runtime.quickReply('图书馆我待了一会儿就走', runtime.getConfig())
  assert.match(reply!, /标记完成了/)
  assert.equal(runtime.scheduleList()[0].status, 'done')
  assert.deepEqual(counter.calls, ['parse', 'classify'])
  runtime.dispose()
})

test('模型判定为否 → 不完成，交回聊天', async () => {
  const due = new Date(2026, 9, 30, 14, 0).toISOString()
  const runtime = makeRuntime(llmRouter({ title: '去图书馆', due }, false))
  await runtime.quickReply('记一下：明天下午2:00去图书馆', runtime.getConfig())

  const reply = await runtime.quickReply('图书馆我待了一会儿就走', runtime.getConfig())
  assert.equal(reply, null)
  assert.equal(runtime.scheduleList()[0].status, 'pending')
  runtime.dispose()
})

test('疑问句不触发完成判定，也不调模型', async () => {
  const due = new Date(2026, 9, 30, 14, 0).toISOString()
  const counter = { calls: [] as string[] }
  const runtime = makeRuntime(llmRouter({ title: '去图书馆', due }, true, counter))
  // 这个用例只关心“疑问句不调完成判定”，把习惯学习关掉免得干扰
  runtime.updateConfig({ habits: { learnFromChat: false } })
  await runtime.quickReply('记一下：明天下午2:00去图书馆', runtime.getConfig())

  const reply = await runtime.quickReply('图书馆你去吗？', runtime.getConfig())
  assert.equal(reply, null)
  assert.deepEqual(counter.calls, ['parse'])
  runtime.dispose()
})

test('“记一下：每天 22:00 写作业” → 存成重复习惯，不占具体日期', async () => {
  const runtime = makeRuntime(llmReturning({ title: '写作业', due: null, repeat: { kind: 'daily', time: '22:00' } }))
  const reply = await runtime.quickReply('记一下：每天 22:00 写作业', runtime.getConfig())

  assert.match(reply!, /记下了/)
  const saved = runtime.scheduleList()[0]
  assert.equal(saved.due, null)
  assert.deepEqual(saved.repeat, { kind: 'daily', time: '22:00' })
  runtime.dispose()
})

test('逾期超过 24 小时：晚间会问要不要作废，回“作废”就丢掉', async () => {
  const runtime = makeRuntime(llmReturning({ title: '去图书馆', due: null }))
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  runtime.scheduleAdd({ title: '去图书馆', due: twoDaysAgo, source: 'manual' })

  runtime.updateConfig({ rhythm: { wakeTime: '07:00' } })
  const sent = await runtime.runGreeting('evening')
  assert.equal(sent.ok, true)
  assert.match(sent.text ?? '', /已经过期一天了/)
  assert.match(sent.text ?? '', /作废/)

  const reply = await runtime.quickReply('作废', runtime.getConfig())
  assert.match(reply!, /不再提醒/)
  assert.equal(runtime.scheduleList()[0].status, 'dropped')
  runtime.dispose()
})

test('逾期追问：回“留着”就保留，之后不再问', async () => {
  const runtime = makeRuntime(llmReturning({ title: '去图书馆', due: null }))
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  runtime.scheduleAdd({ title: '去图书馆', due: twoDaysAgo, source: 'manual' })

  runtime.updateConfig({ rhythm: { wakeTime: '07:00' } })
  await runtime.runGreeting('evening')
  const reply = await runtime.quickReply('留着', runtime.getConfig())
  assert.match(reply!, /先留着/)
  assert.equal(runtime.scheduleList()[0].status, 'pending')
  assert.ok(runtime.scheduleList()[0].overdueAskedAt)
  runtime.dispose()
})

test('聊天里说“开始写作业”：立刻问时长，回答后进入催促流程', async () => {
  const llm: LlmService = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '那你打算多久写完？' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntime(llm)

  const ask = await runtime.quickReply('我准备开始写作业了', runtime.getConfig())
  assert.match(ask!, /多久写完/)

  const estimate = await runtime.quickReply('大概一个半小时', runtime.getConfig())
  assert.match(estimate!, /90 分钟/)

  const done = await runtime.quickReply('写完了', runtime.getConfig())
  assert.match(done!, /到这儿/)
  runtime.dispose()
})

test('触发词留空：她自动判断“明天下午三点去医院”该记成日程', async () => {
  const llm: LlmService = {
    stream(options: Record<string, unknown>) {
      const system = String(options.system ?? '')
      const payload = system.includes('分成三类')
        ? { kind: 'schedule', title: '去医院', due: '2026-11-01T15:00', repeat: null }
        : { title: 'x', due: null }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntime(llm)
  runtime.updateConfig({ schedule: { triggerWord: '' } })

  const reply = await runtime.quickReply('我明天下午三点要去医院', runtime.getConfig())
  assert.match(reply!, /记下了/)
  assert.equal(runtime.scheduleList().length, 1)
  assert.equal(runtime.scheduleList()[0].title, '去医院')
  runtime.dispose()
})

test('触发词留空：闲聊不会被记成日程', async () => {
  const llm: LlmService = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'chat' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntime(llm)
  runtime.updateConfig({ schedule: { triggerWord: '' } })

  assert.equal(await runtime.quickReply('今天好累啊', runtime.getConfig()), null)
  assert.equal(runtime.scheduleList().length, 0)
  runtime.dispose()
})

test('聊天里说“每周三下午五点去滑冰” → 生成习惯候选，不直接提醒', async () => {
  const llm: LlmService = {
    stream(options: Record<string, unknown>) {
      const system = String(options.system ?? '')
      const payload = system.includes('分成三类')
        ? { kind: 'habit', label: '滑冰', rule: { kind: 'weekly', time: '17:00', weekday: 3 } }
        : { kind: 'chat' }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntime(llm)

  const reply = await runtime.quickReply('我每周三下午五点都去滑冰', runtime.getConfig())
  assert.match(reply!, /记下了/)
  assert.match(reply!, /每周三 17:00/)

  const habit = runtime.habits().find((entry) => entry.label === '滑冰')
  assert.ok(habit)
  assert.equal(habit!.status, 'candidate')
  runtime.dispose()
})

test('一次性的安排不会被当成习惯', async () => {
  const llm: LlmService = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ kind: 'chat' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntime(llm)
  assert.equal(await runtime.quickReply('明天下午三点去医院', runtime.getConfig()), null)
  assert.equal(runtime.habits().length, 0)
  runtime.dispose()
})

test('首次对话：先自我介绍并问三件事，第二次不再重复', async () => {
  let calls = 0
  const llm: LlmService = {
    stream() {
      calls++
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '我是秘书鱼，先问你三件事：怎么称呼你？几点睡？想让我记什么？' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntimeWithWelcome(llm)
  // 关掉习惯识别，否则第二条消息会多一次意图判断，干扰“不该再调模型”的断言
  runtime.updateConfig({ habits: { learnFromChat: false } })

  const first = await runtime.quickReply('你好', runtime.getConfig())
  assert.match(first!, /专属秘书鱼/)
  assert.match(first!, /记一下：周五交报告/)
  assert.doesNotMatch(first!, /怎么称呼你/, '不该再问问题')
  assert.equal(runtime.onboarding().sent, true)

  const before = calls
  const second = await runtime.quickReply('你好', runtime.getConfig())
  assert.equal(second, null, '第二次不再自我介绍')
  assert.equal(calls, before)
  runtime.dispose()
})

test('重置首次介绍后，会再发一次', async () => {
  const llm: LlmService = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '又见面了，再问一次。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek Account' }]
    },
  }
  const runtime = makeRuntimeWithWelcome(llm)
  await runtime.quickReply('你好', runtime.getConfig())
  runtime.resetOnboarding()

  const again = await runtime.quickReply('咦', runtime.getConfig())
  assert.match(again!, /专属秘书鱼/)
  runtime.dispose()
})
