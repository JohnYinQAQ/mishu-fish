import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReminder, clockMinutes, dayKey, reminderExpiry, windowAt } from '../src/plugin/reminder.ts'
import type { ScheduleItem } from '../src/plugin/schedule.ts'

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

function at(hour: number, minute = 0): Date {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return date
}

test('clockMinutes：解析 HH:MM', () => {
  assert.equal(clockMinutes('07:00'), 420)
  assert.equal(clockMinutes('23:30'), 1410)
  assert.equal(clockMinutes('坏值'), null)
})

test('windowAt：早间 07:00–09:00，晚间 23:00–次日 01:00', () => {
  const times = { morningTime: '07:00', eveningTime: '23:00' }
  assert.equal(windowAt(at(7, 0), times), 'morning')
  assert.equal(windowAt(at(8, 59), times), 'morning')
  assert.equal(windowAt(at(6, 59), times), null)
  assert.equal(windowAt(at(12, 0), times), null)
  assert.equal(windowAt(at(23, 30), times), 'evening')
  assert.equal(windowAt(at(0, 30), times), 'evening')
  assert.equal(windowAt(at(1, 30), times), null)
})

test('buildReminder：早间只列今天，晚间列今天没做完的 + 明天', () => {
  const today = at(14, 0)
  const tomorrow = at(9, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const items = [
    item({ id: 'a', title: '交报告', due: today.toISOString() }),
    item({ id: 'b', title: '去图书馆', due: tomorrow.toISOString() }),
    item({ id: 'c', title: '已完成的事', due: today.toISOString(), status: 'done' }),
  ]

  const morning = buildReminder('morning', items, at(7, 5))
  assert.match(morning!, /今天有 1 件事/)
  assert.match(morning!, /交报告/)
  assert.equal(morning!.includes('去图书馆'), false)

  const evening = buildReminder('evening', items, at(23, 5))
  assert.match(evening!, /今天还有 1 件没做完/)
  assert.match(evening!, /明天有 1 件事/)
  assert.match(evening!, /去图书馆/)

  assert.equal(buildReminder('morning', [], at(7, 0)), null)
  assert.equal(buildReminder('evening', [], at(23, 0)), null)
})

test('reminderExpiry：晚间到次日 07:00 作废，早间 4 小时', () => {
  const now = at(23, 5)
  const evening = new Date(reminderExpiry('evening', now))
  assert.equal(evening.getHours(), 7)
  assert.equal(evening.getDate(), new Date(now.getTime() + 86400000).getDate())

  const morningExpiry = reminderExpiry('morning', now)
  assert.equal(morningExpiry - now.getTime(), 4 * 60 * 60 * 1000)
})

test('dayKey：本地日期字符串', () => {
  assert.match(dayKey(at(23, 0)), /^\d{4}-\d{2}-\d{2}$/)
})

test('提醒：早间包含今天的重复习惯，晚间把它们算成没做完', () => {
  const habit = item({ id: 'h', title: '写作业', due: null })
  habit.repeat = { kind: 'daily', time: '15:00' }

  const morning = buildReminder('morning', [habit], at(7, 5))
  assert.match(morning!, /每天 15:00 写作业/)

  const evening = buildReminder('evening', [habit], at(23, 5))
  assert.match(evening!, /今天还有 1 件没做完/)
  assert.match(evening!, /写作业/)
})

test('composeMorningGreeting：有日程时列日程，没有就只说早上好', async () => {
  const { composeMorningGreeting } = await import('../src/plugin/greeting.ts')
  const withList = composeMorningGreeting({
    callUser: '主人',
    reminderText: '☀️ 今天有 1 件事：\n· 14:00 去图书馆',
    description: '通常 07:46 起（10 天样本）',
  })
  assert.match(withList, /早上好，主人。/)
  assert.match(withList, /今天有 1 件事/)
  assert.match(withList, /14:00 去图书馆/)
  assert.match(withList, /作息参考：通常 07:46 起/)

  const bare = composeMorningGreeting({ callUser: '主人', reminderText: null, description: '' })
  assert.equal(bare, '早上好，主人。')
})

test('composeEveningMessage：清单后附一句作息提醒，没有就不加', async () => {
  const { composeEveningMessage } = await import('../src/plugin/greeting.ts')
  const withSleep = composeEveningMessage({ reminderText: '🌙 今天还有 1 件没做完：\n· 交报告', sleepClock: '23:30' })
  assert.match(withSleep, /今天还有 1 件没做完/)
  assert.match(withSleep, /23:30 左右睡/)

  const noSleep = composeEveningMessage({ reminderText: '🌙 今天还有 1 件没做完', sleepClock: '' })
  assert.equal(noSleep, '🌙 今天还有 1 件没做完')
})

test('greetingsDue：早晚窗口各自命中，留空不发', async () => {
  const { greetingsDue } = await import('../src/plugin/reminder.ts')
  const times = { morningGreeting: '07:30', eveningGreeting: '23:00' }

  assert.deepEqual(greetingsDue(times, at(7, 30)), ['morning'])
  assert.deepEqual(greetingsDue(times, at(8, 59)), ['morning'])
  assert.deepEqual(greetingsDue(times, at(23, 30)), ['evening'])
  assert.deepEqual(greetingsDue(times, at(12, 0)), [])
  assert.deepEqual(greetingsDue({ morningGreeting: '', eveningGreeting: '23:00' }, at(7, 30)), [])
})
