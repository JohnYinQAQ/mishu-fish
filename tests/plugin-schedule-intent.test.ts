import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectCompletion,
  detectDone,
  detectQuery,
  formatAdded,
  formatList,
  itemsInRange,
  looksLikeItHasTime,
  matchPending,
  matchTrigger,
} from '../src/plugin/schedule-intent.ts'
import type { ScheduleItem } from '../src/plugin/schedule.ts'

const LOCAL_DUE = new Date(2026, 10, 1, 23, 59).toISOString()

function item(partial: Partial<ScheduleItem>): ScheduleItem {
  return {
    id: partial.id ?? 's_1',
    title: partial.title ?? '交报告',
    due: partial.due ?? null,
    status: partial.status ?? 'pending',
    source: 'manual',
    createdAt: Date.now(),
    doneAt: null,
  }
}

test('matchTrigger：带冒号、空格、逗号都能剥掉', () => {
  assert.equal(matchTrigger('记一下：周五交报告', '记一下'), '周五交报告')
  assert.equal(matchTrigger('记一下 周五交报告', '记一下'), '周五交报告')
  assert.equal(matchTrigger('记一下，周五交报告', '记一下'), '周五交报告')
  assert.equal(matchTrigger('记一下', '记一下'), '')
  assert.equal(matchTrigger('今天好累', '记一下'), null)
  assert.equal(matchTrigger('记一下：x', ''), null)
})

test('looksLikeItHasTime：识别常见时间词', () => {
  assert.equal(looksLikeItHasTime('周五交报告'), true)
  assert.equal(looksLikeItHasTime('明天下午三点开会'), true)
  assert.equal(looksLikeItHasTime('交报告'), false)
})

test('detectQuery：只认带时间词或问句的请求', () => {
  assert.equal(detectQuery('我今天有什么安排'), 'today')
  assert.equal(detectQuery('明天的日程'), 'tomorrow')
  assert.equal(detectQuery('这周还有什么事'), 'week')
  assert.equal(detectQuery('今天有安排吗'), 'today')
  assert.equal(detectQuery('帮我安排一下'), null)
  assert.equal(detectQuery('今天好累'), null)
})

test('detectDone：识别“做完了/交了”，太短的不算', () => {
  assert.equal(detectDone('报告交了'), '报告')
  assert.equal(detectDone('交周报做完了'), '交周报')
  assert.equal(detectDone('我交了'), null)
  assert.equal(detectDone('今天天气不错'), null)
})

test('matchPending：模糊匹配、排除已完成', () => {
  const items = [
    item({ id: 'a', title: '交报告' }),
    item({ id: 'b', title: '交周报', status: 'done' }),
    item({ id: 'c', title: '问老师题' }),
  ]
  assert.deepEqual(matchPending(items, '报告').map((entry) => entry.id), ['a'])
  assert.deepEqual(matchPending(items, '交').map((entry) => entry.id), ['a'])
  assert.deepEqual(matchPending(items, '老师').map((entry) => entry.id), ['c'])
})

test('formatAdded / formatList：没有内容就明说没有', () => {
  const withDue = item({ due: LOCAL_DUE })
  assert.match(formatAdded(withDue), /记下了：交报告 · 11 月 1 日 23:59/)
  assert.match(formatAdded(item({})), /没有时间/)

  assert.equal(formatList([], 'today'), '今天没有安排。')
  const list = formatList([item({ due: null }), item({ id: 'b', due: LOCAL_DUE })], 'today')
  assert.match(list, /今天有 2 件事/)
  assert.match(list, /23:59 交报告/)
})

test('itemsInRange：今天 / 明天 / 本周', () => {
  const today = new Date()
  today.setHours(20, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 20)

  const items = [
    item({ id: 't', due: today.toISOString() }),
    item({ id: 'm', due: tomorrow.toISOString() }),
    item({ id: 'w', due: nextWeek.toISOString() }),
    item({ id: 'n', due: null }),
  ]

  assert.deepEqual(itemsInRange(items, 'today').map((entry) => entry.id), ['t'])
  assert.deepEqual(itemsInRange(items, 'tomorrow').map((entry) => entry.id), ['m'])
  assert.deepEqual(itemsInRange(items, 'week').map((entry) => entry.id), ['t', 'm'])
})

test('detectCompletion：真实说法「木条已经带到学校了」也能命中', () => {
  const items = [item({ id: 'a', title: '把木条带到学校' })]
  const hits = detectCompletion('我木条已经带到学校了', items)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].item.id, 'a')
})

test('detectCompletion：短标题也能靠关键词命中', () => {
  const items = [item({ id: 'a', title: '交报告' })]
  assert.equal(detectCompletion('报告交了', items).length, 1)
})

test('detectCompletion：口语“我到图书馆了”“到达了”都算完成', () => {
  const items = [item({ id: 'a', title: '去图书馆' })]
  assert.equal(detectCompletion('我到图书馆了', items).length, 1)
  assert.equal(detectCompletion('我到达图书馆了', items).length, 1)
})

test('detectCompletion：将来时/否定不能算完成', () => {
  const items = [item({ id: 'a', title: '去图书馆' })]
  assert.equal(detectCompletion('我明天要去图书馆了', items).length, 0)
  assert.equal(detectCompletion('我还没到图书馆', items).length, 0)
  assert.equal(detectCompletion('我准备去图书馆了', items).length, 0)
})

test('detectCompletion：普通聊天不误伤', () => {
  const items = [item({ id: 'a', title: '把木条带到学校' })]
  assert.equal(detectCompletion('今天好累', items).length, 0)
  assert.equal(detectCompletion('我已经吃过饭了', items).length, 0)
})

test('detectCompletion：多条相似待办时返回全部，交给调用方追问', () => {
  const items = [item({ id: 'a', title: '交报告' }), item({ id: 'b', title: '交周报' })]
  assert.ok(detectCompletion('报告交了', items).length >= 1)
})

test('查询：重复习惯出现在今天；已完成今天那次的不出现', () => {
  const daily = item({ id: 'r1', title: '写作业', due: null })
  daily.repeat = { kind: 'daily', time: '15:00' }
  const doneTodayItem = item({ id: 'r2', title: '跑步', due: null })
  doneTodayItem.repeat = { kind: 'daily', time: '07:00' }
  doneTodayItem.lastDoneOn = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  assert.deepEqual(itemsInRange([daily, doneTodayItem], 'today').map((entry) => entry.id), ['r1'])
  assert.match(formatList([daily], 'today'), /每天 15:00 写作业/)
})

test('parseMessageIntent：日程 / 习惯 / 闲聊三分类', async () => {
  const { parseMessageIntent } = await import('../src/plugin/schedule-parse.ts')

  const schedule = parseMessageIntent(
    JSON.stringify({ kind: 'schedule', title: '去医院', due: '2026-11-02T15:00', repeat: null }),
  )
  assert.equal(schedule.kind, 'schedule')
  if (schedule.kind === 'schedule') {
    assert.equal(schedule.title, '去医院')
    assert.ok(schedule.due)
  }

  const habit = parseMessageIntent(
    JSON.stringify({ kind: 'habit', label: '滑冰', rule: { kind: 'weekly', time: '17:00', weekday: 3 } }),
  )
  assert.equal(habit.kind, 'habit')
  if (habit.kind === 'habit') assert.deepEqual(habit.rule, { kind: 'weekly', time: '17:00', weekday: 3 })

  assert.equal(parseMessageIntent(JSON.stringify({ kind: 'chat' })).kind, 'chat')
  assert.equal(parseMessageIntent('乱码').kind, 'chat')
  assert.equal(parseMessageIntent(JSON.stringify({ kind: 'habit', label: '', rule: {} })).kind, 'chat')
})

test('matchTrigger：前面带称呼也能认出来', () => {
  assert.equal(matchTrigger('秘书鱼，记一下，明天带小木条', '记一下'), '明天带小木条')
  assert.equal(matchTrigger('秘书鱼 记一下 明天带小木条', '记一下'), '明天带小木条')
  assert.equal(matchTrigger('鱼鱼，记一下：明天带小木条', '记一下'), '明天带小木条')
  assert.equal(matchTrigger('记得明天带小木条', '记一下'), null, '不同词不该误判')
})

test('inferDueFromText：明天 / 后天 / 周三 都能推出日期', async () => {
  const { inferDueFromText } = await import('../src/plugin/schedule-intent.ts')
  const now = new Date(2026, 10, 2, 21, 0) // 2026-11-02 周一 21:00

  const tomorrow = inferDueFromText('我明天要带小木条去学校', now)
  assert.ok(tomorrow)
  assert.equal(tomorrow!.label, '明天')
  assert.equal(tomorrow!.date.getDate(), 3)
  assert.equal(tomorrow!.date.getHours(), 23)
  assert.equal(tomorrow!.date.getMinutes(), 59)

  const after = inferDueFromText('后天交报告', now)
  assert.equal(after!.date.getDate(), 4)

  const wednesday = inferDueFromText('周三交', now)
  assert.equal(wednesday!.date.getDay(), 3, '应该是周三')

  assert.equal(inferDueFromText('随便记一下', now), null, '没有时间线索就不猜')
})
