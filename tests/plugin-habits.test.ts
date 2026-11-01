import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  DEFAULT_LEAD_MINUTES,
  createHabitStore,
  discoverHabits,
  habitsDue,
  normalizeRule,
  ruleText,
  titleSimilarity,
} from '../src/plugin/habits.ts'
import type { ScheduleItem } from '../src/plugin/schedule.ts'

let dir: string

function item(partial: Partial<ScheduleItem>): ScheduleItem {
  return {
    id: partial.id ?? 's_1',
    title: partial.title ?? '滑冰',
    due: partial.due ?? null,
    status: partial.status ?? 'pending',
    source: 'manual',
    createdAt: Date.now(),
    doneAt: null,
    repeat: partial.repeat,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-habits-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('normalizeRule / ruleText：时间与星期校验', () => {
  assert.deepEqual(normalizeRule({ kind: 'weekly', time: '17:00', weekday: 3 }), { kind: 'weekly', time: '17:00', weekday: 3 })
  assert.equal(normalizeRule({ kind: 'weekly', time: '17:00' }), null)
  assert.equal(normalizeRule({ kind: 'daily', time: '25:00' }), null)
  assert.equal(ruleText({ kind: 'weekly', time: '17:00', weekday: 3 }), '每周三 17:00')
  assert.equal(ruleText({ kind: 'daily', time: '22:00' }), '每天 22:00')
})

test('titleSimilarity：同一件事的不同说法能对上', () => {
  assert.ok(titleSimilarity('滑冰', '去滑冰') >= 0.5)
  assert.ok(titleSimilarity('去图书馆', '图书馆') >= 0.5)
  assert.ok(titleSimilarity('滑冰', '买菜') < 0.5)
})

test('store：增删改查 + 默认提前量', () => {
  const store = createHabitStore()
  const habit = store.add({ label: '滑冰', category: '运动', rule: { kind: 'weekly', time: '17:00', weekday: 3 } })

  assert.equal(habit.leadMinutes, DEFAULT_LEAD_MINUTES)
  assert.equal(habit.status, 'candidate')
  assert.equal(store.list().length, 1)

  const updated = store.update(habit.id, { status: 'active', leadMinutes: 45 })
  assert.equal(updated?.status, 'active')
  assert.equal(updated?.leadMinutes, 45)

  assert.equal(store.remove(habit.id), true)
  assert.equal(store.list().length, 0)
})

test('discover：日程里的“每周三 17:00 滑冰”直接成为 active 习惯', () => {
  const items = [item({ id: 'r1', title: '滑冰', repeat: { kind: 'weekly', time: '17:00', weekday: 3 } })]
  const found = discoverHabits(items, [])

  assert.equal(found.length, 1)
  assert.equal(found[0].status, 'active')
  assert.equal(found[0].source, 'explicit')
  assert.deepEqual(found[0].rule, { kind: 'weekly', time: '17:00', weekday: 3 })
})

test('discover：同一个星期三出现三次 → 候选，而不是直接启用', () => {
  const items = [0, 7, 14].map((daysAgo, index) => {
    const date = new Date(2026, 9, 28 - daysAgo, 17, 0, 0) // 都是周三
    return item({ id: `s${index}`, title: '去滑冰', due: date.toISOString() })
  })

  const found = discoverHabits(items, [])
  const candidate = found.find((entry) => entry.source === 'repeated')
  assert.ok(candidate, '应该发现一个候选')
  assert.equal(candidate!.status, 'candidate')
  assert.equal(candidate!.rule.weekday, 3)
  assert.equal(candidate!.rule.time, '17:00')
})

test('discover：只出现两次不算习惯', () => {
  const items = [0, 7].map((daysAgo, index) => {
    const date = new Date(2026, 9, 28 - daysAgo, 17, 0, 0)
    return item({ id: `s${index}`, title: '去滑冰', due: date.toISOString() })
  })
  assert.equal(discoverHabits(items, []).filter((entry) => entry.source === 'repeated').length, 0)
})

test('discover：已经存在的习惯不会重复添加', () => {
  const store = createHabitStore()
  store.add({ label: '滑冰', rule: { kind: 'weekly', time: '17:00', weekday: 3 }, status: 'active' })
  const items = [item({ id: 'r1', title: '滑冰', repeat: { kind: 'weekly', time: '17:00', weekday: 3 } })]

  assert.equal(discoverHabits(items, store.list()).length, 0)
})

test('habitsDue：到提前量窗口才提醒，发过的不再提醒', () => {
  const store = createHabitStore()
  const habit = store.add({
    label: '滑冰',
    rule: { kind: 'weekly', time: '17:00', weekday: 3 },
    status: 'active',
    leadMinutes: 30,
    afterAsk: false,
  })

  const wednesday = new Date(2026, 9, 28) // 周三
  const at = (hour: number, minute: number) => {
    const date = new Date(wednesday)
    date.setHours(hour, minute, 0, 0)
    return date
  }

  assert.equal(habitsDue(store.list(), at(16, 29), '2026-10-28').length, 0, '还没到点')
  assert.deepEqual(
    habitsDue(store.list(), at(16, 30), '2026-10-28').map((entry) => entry.phase),
    ['remind'],
    '提前 30 分钟，16:30 该提醒',
  )
  assert.equal(habitsDue(store.list(), at(16, 30), '2026-10-29').length, 1, '换一天可以再提醒')

  store.markSent(habit.id, '2026-10-28')
  assert.equal(habitsDue(store.list(), at(16, 30), '2026-10-28').length, 0, '今天已经发过')

  // 非周三不提醒
  assert.equal(habitsDue(store.list(), new Date(2026, 9, 29, 16, 30), '2026-10-29').length, 0)
})

test('habitsDue：事后追问只在 1–3 小时后出现一次', () => {
  const store = createHabitStore()
  store.add({
    label: '滑冰',
    rule: { kind: 'weekly', time: '17:00', weekday: 3 },
    status: 'active',
    leadMinutes: 30,
    afterAsk: true,
  })

  const habit = store.list()[0]
  store.markSent(habit.id, '2026-10-28') // 提醒已经发过，避免和“追问”混在一起

  const at = (hour: number) => new Date(2026, 9, 28, hour, 0)
  assert.equal(habitsDue(store.list(), at(17), '2026-10-28').length, 0, '刚提醒完，不追问')
  assert.deepEqual(habitsDue(store.list(), at(18), '2026-10-28').map((entry) => entry.phase), ['after'])
  assert.equal(habitsDue(store.list(), at(20), '2026-10-28').length, 0, '超过 3 小时不追问')
})
