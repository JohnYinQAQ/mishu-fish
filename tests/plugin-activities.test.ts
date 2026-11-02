import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { ACTIVITY_PROMOTE_THRESHOLD, createActivityStore, describeActivity, toHabitInput } from '../src/plugin/activities.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-act-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 最近的某个星期三 15:00，往前推 weeksAgo 周 */
function wednesday(weeksAgo = 0, hour = 15): number {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  let diff = (date.getDay() - 3 + 7) % 7
  if (diff === 0) diff = 7
  date.setDate(date.getDate() - diff - weeksAgo * 7)
  return date.getTime()
}

test('record：同一天同一个活动只记一次', () => {
  const store = createActivityStore()
  const at = wednesday(0)
  assert.ok(store.record('打游戏', at))
  assert.equal(store.record('打游戏', at + 60_000), null)
  assert.equal(store.list().length, 1)
})

test(`promotable：同一个星期三凑够 ${ACTIVITY_PROMOTE_THRESHOLD} 次才升级`, () => {
  const store = createActivityStore()
  store.record('打游戏', wednesday(2))
  store.record('打游戏', wednesday(1))
  assert.equal(store.promotable([]).length, 0, '两次还不够')

  store.record('打游戏', wednesday(0))
  const found = store.promotable([])
  assert.equal(found.length, 1)
  assert.equal(found[0].label, '打游戏')
  assert.equal(found[0].weekday, 3)
  assert.equal(found[0].count, 3)
})

test('promotable：不同活动不会混在一起', () => {
  const store = createActivityStore()
  store.record('打游戏', wednesday(2))
  store.record('跑步', wednesday(1))
  store.record('打游戏', wednesday(0))
  assert.equal(store.promotable([]).length, 0)
})

test('promotable：已经有同名习惯就不再建议', () => {
  const store = createActivityStore()
  store.record('打游戏', wednesday(2))
  store.record('打游戏', wednesday(1))
  store.record('打游戏', wednesday(0))

  const existing = [
    {
      id: 'h1',
      label: '打游戏',
      category: '其他' as const,
      rule: { kind: 'weekly' as const, time: '15:00', weekday: 3 },
      leadMinutes: 30,
      status: 'active' as const,
      source: 'inferred' as const,
      evidence: { count: 3, weeks: 3 },
      afterAsk: true,
      askEstimate: false,
      createdAt: Date.now(),
    },
  ]
  assert.equal(store.promotable(existing).length, 0)
})

test('toHabitInput / describeActivity：候选与描述', () => {
  const candidate = { label: '打游戏', weekday: 3, hour: 15, count: 3 }
  const input = toHabitInput(candidate)
  assert.equal(input.rule.kind, 'weekly')
  assert.equal(input.rule.weekday, 3)
  assert.equal(input.rule.time, '15:00')
  assert.equal(input.status, 'candidate')

  assert.match(describeActivity(candidate), /周三 15:00 左右打游戏/)
})
