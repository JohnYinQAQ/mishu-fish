import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createScheduleStore, dayRange, doneToday, inDay, normalizeDue, normalizeRepeat, occursToday } from '../src/plugin/schedule.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-schedule-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

test('add / list：按截止时间排序，无期限的排最后', () => {
  const store = createScheduleStore()
  const later = new Date(Date.now() + 3 * 86400000).toISOString()
  const sooner = new Date(Date.now() + 86400000).toISOString()

  store.add({ title: '没有期限的事' })
  store.add({ title: '后天交', due: later })
  store.add({ title: '明天交', due: sooner })

  assert.deepEqual(
    store.list().map((item) => item.title),
    ['明天交', '后天交', '没有期限的事'],
  )
})

test('add：空标题拒绝，标题被截到 60 字', () => {
  const store = createScheduleStore()
  assert.throws(() => store.add({ title: '   ' }), /标题不能为空/)
  const item = store.add({ title: 'x'.repeat(100) })
  assert.equal(item.title.length, 60)
})

test('normalizeDue：非法时间为 null，合法时间统一成 ISO', () => {
  assert.equal(normalizeDue(''), null)
  assert.equal(normalizeDue('不是时间'), null)
  assert.equal(normalizeDue('2026-11-01T23:59:00-07:00'), '2026-11-02T06:59:00.000Z')
})

test('update：改标题和截止时间，不改状态', () => {
  const store = createScheduleStore()
  const item = store.add({ title: '交报告', due: '2026-11-01T23:59:00-07:00' })
  const next = store.update(item.id, { title: '交周报', due: '2026-11-03T23:59:00-08:00' })

  assert.equal(next?.title, '交周报')
  assert.equal(next?.status, 'pending')
  assert.equal(store.update('不存在', { title: 'x' }), null)
})

test('done / remove：状态流转与删除', () => {
  const store = createScheduleStore()
  const item = store.add({ title: '交报告' })

  const done = store.done(item.id)
  assert.equal(done?.status, 'done')
  assert.ok(done?.doneAt)

  assert.equal(store.remove(item.id), true)
  assert.equal(store.remove(item.id), false)
  assert.equal(store.list().length, 0)
})

test('落盘：重新读取后内容还在', () => {
  const first = createScheduleStore()
  first.add({ title: '交报告', due: '2026-11-01T23:59:00-07:00' })

  const second = createScheduleStore()
  assert.equal(second.list().length, 1)
  assert.equal(second.list()[0].title, '交报告')
  assert.equal(fs.statSync(second.file).mode & 0o777, 0o600)
})

test('文件损坏时当作空列表，不抛错', () => {
  const store = createScheduleStore()
  fs.mkdirSync(path.dirname(store.file), { recursive: true })
  fs.writeFileSync(store.file, '{ 坏掉的 json')
  assert.deepEqual(store.list(), [])
})

test('dayRange / inDay：按本地自然日判断', () => {
  const store = createScheduleStore()
  const today = new Date()
  today.setHours(20, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const a = store.add({ title: '今天的事', due: today.toISOString() })
  const b = store.add({ title: '明天的事', due: tomorrow.toISOString() })

  assert.equal(inDay(a, 0), true)
  assert.equal(inDay(b, 0), false)
  assert.equal(inDay(b, 1), true)
  assert.ok(dayRange(0).start < dayRange(0).end)
})

test('normalizeRepeat：校验时间与星期，非法值返回 null', () => {
  assert.deepEqual(normalizeRepeat({ kind: 'daily', time: '22:00' }), { kind: 'daily', time: '22:00' })
  assert.deepEqual(normalizeRepeat({ kind: 'weekly', time: '9:5', weekday: 3 }), {
    kind: 'weekly',
    time: '09:05',
    weekday: 3,
  })
  assert.equal(normalizeRepeat({ kind: 'daily', time: '25:00' }), null)
  assert.equal(normalizeRepeat({ kind: 'weekly', time: '10:00' }), null)
  assert.equal(normalizeRepeat({ kind: 'monthly', time: '10:00' }), null)
  assert.equal(normalizeRepeat(null), null)
})

test('重复习惯：每天都会发生；每周只在指定星期', () => {
  const store = createScheduleStore()
  const daily = store.add({ title: '写作业', repeat: { kind: 'daily', time: '15:00' } })
  const weekly = store.add({ title: '开会', repeat: { kind: 'weekly', time: '10:00', weekday: 3 } })

  assert.equal(daily.due, null)
  assert.equal(occursToday(daily), true)
  assert.equal(occursToday(weekly, new Date(2026, 9, 28)), true) // 周三
  assert.equal(occursToday(weekly, new Date(2026, 9, 29)), false) // 周四
})

test('重复习惯完成：只记今天，任务本身还在', () => {
  const store = createScheduleStore()
  const item = store.add({ title: '写作业', repeat: { kind: 'daily', time: '15:00' } })

  const done = store.done(item.id)
  assert.equal(done?.status, 'pending') // 不是一次性任务，状态不变
  assert.ok(done?.lastDoneOn)
  assert.equal(doneToday(done!), true)

  const reloaded = store.list()[0]
  assert.equal(doneToday(reloaded), true)
})
