import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  MIN_SAMPLES_FOR_GREETING,
  MIN_SAMPLES_FOR_GREETING_WEEKEND,
  canGreet,
  clockOfMinutes,
  createRhythmStore,
  describeProfile,
  profileForDay,
} from '../src/plugin/rhythm.ts'
import type { ManualPriors } from '../src/plugin/rhythm.ts'

let dir: string

const EMPTY: ManualPriors = { wake: '', sleep: '', homeworkStart: '', homeworkEnd: '' }

/** 最近某个星期几的时刻（保证落在工作日/周末，不受“今天是周几”影响） */
function lastWeekday(weekday: number, weeksAgo = 0, hour = 12, minute = 0): number {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  let diff = (date.getDay() - weekday + 7) % 7
  if (diff === 0) diff = 7
  date.setDate(date.getDate() - diff - weeksAgo * 7)
  return date.getTime()
}

function at(daysAgo: number, hour: number, minute: number): number {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-rhythm-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('record：同一天多次消息只更新首尾时间', () => {
  const store = createRhythmStore()
  store.record(at(0, 8, 10))
  store.record(at(0, 9, 0))
  store.record(at(0, 22, 30))

  const day = store.days()[0]
  assert.equal(day.first, 8 * 60 + 10)
  assert.equal(day.last, 22 * 60 + 30)
  assert.equal(store.days().length, 1)
})

test('profile：用中位数，忽略极端的一天', () => {
  const store = createRhythmStore()
  for (let day = 1; day <= 6; day++) store.record(at(day, 7, 40))
  store.record(at(7, 12, 0)) // 一次睡过头，不该把中位数拉偏

  const profile = store.profile(EMPTY)
  const weekday = profile.weekday.wake
  assert.ok(weekday)
  assert.ok(weekday!.median <= 8 * 60, `中位数应接近 7:40，实际 ${clockOfMinutes(weekday!.median)}`)
  assert.ok(weekday!.samples >= 1)
})

test('canGreet：样本不足且没手动先验 → 不启动；填了先验 → 启动', () => {
  const store = createRhythmStore()
  store.record(at(1, 7, 40))
  store.record(at(2, 7, 45))

  const auto = store.profile(EMPTY)
  assert.equal(canGreet(profileForDay(auto)), false)
  assert.ok((profileForDay(auto).wake?.samples ?? 0) < MIN_SAMPLES_FOR_GREETING)

  const manual = store.profile({ ...EMPTY, wake: '07:40' })
  assert.equal(canGreet(profileForDay(manual)), true)
  // 周末门槛更低：4 天样本也够了
  assert.equal(canGreet({ wake: { median: 570, samples: 4, confidence: 0.5 }, sleep: null, activeHours: [], homework: null, manual: false }, true), true)
  assert.equal(canGreet({ wake: { median: 570, samples: 4, confidence: 0.5 }, sleep: null, activeHours: [], homework: null, manual: false }, false), false)
  assert.equal(profileForDay(manual).manual, true)
})

test('手动先验覆盖统计值', () => {
  const store = createRhythmStore()
  for (let day = 1; day <= 5; day++) store.record(at(day, 9, 0))

  const manual = store.profile({ ...EMPTY, wake: '07:10', sleep: '23:50' })
  assert.equal(manual.weekday.wake?.median, 7 * 60 + 10)
  assert.equal(manual.weekday.sleep?.median, 23 * 60 + 50)
})

test('作业时段：只有起止都填了才算', () => {
  const store = createRhythmStore()
  store.record(lastWeekday(3, 0, 15, 0))
  assert.equal(store.profile(EMPTY).weekday.homework, null)

  const withWindow = store.profile({ ...EMPTY, homeworkStart: '15:00', homeworkEnd: '17:00' })
  assert.deepEqual(withWindow.weekday.homework, { start: 15 * 60, end: 17 * 60, hits: 1 })
})

test('describeProfile：样本为空时明说，不编造', () => {
  assert.match(describeProfile({ wake: null, sleep: null, activeHours: [], homework: null, manual: false }), /样本还不够/)
  assert.match(
    describeProfile({
      wake: { median: 7 * 60 + 40, samples: 6, confidence: 0.86 },
      sleep: { median: 23 * 60 + 30, samples: 6, confidence: 0.86 },
      activeHours: [],
      homework: null,
      manual: false,
    }),
    /07:40 起/,
  )
})

test('clear：清空后没有样本', () => {
  const store = createRhythmStore()
  store.record(Date.now())
  assert.equal(store.days().length, 1)
  store.clear()
  assert.equal(store.days().length, 0)
})

test('recordSleep：明确晚安优先于“最后一条消息”', () => {
  const store = createRhythmStore()
  const wednesday = 3
  store.record(lastWeekday(wednesday, 0, 21, 30))
  store.record(lastWeekday(wednesday, 0, 23, 50)) // 后来又发了一条，但已经说过晚安
  store.recordSleep(lastWeekday(wednesday, 0, 21, 30))

  const profile = store.profile(EMPTY)
  const sleep = profile.weekday.sleep
  assert.ok(sleep)
  assert.equal(sleep!.source, 'explicit')
  assert.equal(sleep!.median, 21 * 60 + 30)
  assert.match(describeProfile(profile.weekday), /21:30 睡（按你说的晚安）/)
})

test('没有晚安信号时，退回“最后一条消息”并标注来源', () => {
  const store = createRhythmStore()
  store.record(lastWeekday(3, 0, 8, 0))
  store.record(lastWeekday(3, 0, 23, 10))

  const sleep = store.profile(EMPTY).weekday.sleep
  assert.equal(sleep!.source, 'last-message')
  assert.equal(sleep!.median, 23 * 60 + 10)
})

test('写作业时段：从 3 次记录里学出来，中位数起止', () => {
  const store = createRhythmStore()
  // 三天，每次 15:10 开始、17:00 左右结束（其中一天偏晚，测中位数）
  // 三天必须都落在最近 14 天的窗口里，所以用本周的三天，而不是往前推三周
  const sessions: Array<[number, number, number, number, number]> = [
    [1, 15, 10, 17, 0],
    [2, 15, 20, 16, 50],
    [3, 16, 30, 18, 20],
  ]
  for (const [weekday, sh, sm, eh, em] of sessions) {
    const startMs = lastWeekday(weekday, 0, sh, sm)
    store.recordHomeworkStart(startMs)
    const end = new Date(startMs)
    end.setHours(eh, em, 0, 0)
    store.recordHomeworkEnd(end.getTime())
  }

  const homework = store.profile(EMPTY).weekday.homework
  assert.ok(homework, '三天样本应该能学出作业时段')
  assert.equal(homework!.hits, 3)
  // 起点中位数 15:20，终点中位数 17:00
  assert.equal(homework!.start, 15 * 60 + 20)
  assert.equal(homework!.end, 17 * 60)
})

test('写作业时段：不足 3 次不启用', () => {
  const store = createRhythmStore()
  const start = new Date()
  start.setDate(start.getDate() - 1)
  start.setHours(15, 0, 0, 0)
  store.recordHomeworkStart(start.getTime())
  const end = new Date(start)
  end.setHours(16, 0, 0, 0)
  store.recordHomeworkEnd(end.getTime())

  assert.equal(store.profile(EMPTY).weekday.homework, null)
})

test('recordHomeworkEnd：没有开始记录时不会崩', () => {
  const store = createRhythmStore()
  assert.doesNotThrow(() => store.recordHomeworkEnd(Date.now()))
})

test('跨零点写作业：能正确结束，但不参与时段学习', () => {
  const store = createRhythmStore()
  for (const day of [26, 27, 28]) {
    store.recordHomeworkStart(new Date(2026, 9, day, 23, 0, 0).getTime())
    store.recordHomeworkEnd(new Date(2026, 9, day + 1, 1, 0, 0).getTime())
  }

  const sessions = store.days().flatMap((day) => day.homework ?? [])
  assert.equal(sessions.length, 3)
  for (const session of sessions) {
    assert.equal(session.start, 23 * 60)
    assert.equal(session.end, 25 * 60, '跨零点记成 24 小时之后的数')
  }
  // 跨零点的不参与学习，避免起止反掉
  assert.equal(store.profile(EMPTY, new Date(2026, 9, 30)).weekday.homework, null)
})

test('同一天内结束的作业仍能学出时段', () => {
  const store = createRhythmStore()
  for (const day of [26, 27, 28]) {
    store.recordHomeworkStart(new Date(2026, 9, day, 20, 0, 0).getTime())
    store.recordHomeworkEnd(new Date(2026, 9, day, 22, 0, 0).getTime())
  }
  const hw = store.profile(EMPTY, new Date(2026, 9, 30)).weekday.homework
  assert.ok(hw)
  assert.equal(hw!.start, 20 * 60)
  assert.equal(hw!.end, 22 * 60)
})

test('凌晨消息算前一天：不会把 00:30 当成“起床”', () => {
  const store = createRhythmStore()
  const base = new Date(2026, 10, 2, 15, 0) // 11-02 15:00
  store.record(base.getTime())

  // 次日 00:30 发消息，应该归到 11-02
  const afterMidnight = new Date(2026, 10, 3, 0, 30)
  store.record(afterMidnight.getTime())

  const days = store.days()
  assert.equal(days.length, 1, '应该只有一条日期记录')
  assert.equal(days[0].date, '2026-11-02')
  assert.equal(days[0].first, 15 * 60, '起床时间仍是 15:00')
  assert.equal(days[0].last, 24 * 60 + 30, '最后一条接在 24 点之后')
})
