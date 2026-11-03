import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../config.ts'

/** 一天的活跃样本：第一条/最后一条消息的时刻（分钟），以及按小时计数 */
export interface HomeworkSession {
  /** 开始时刻（分钟） */
  start: number
  /** 结束时刻（分钟）；没结束就不写 */
  end?: number
}

export interface DaySample {
  date: string
  first: number
  last: number
  hours: Record<string, number>
  /** 明确说了“晚安/睡了”的时刻；比“最后一条消息”可靠得多 */
  sleepAt?: number
  /** 当天写作业的时段，用来学出“他通常几点写作业” */
  homework?: HomeworkSession[]
}

export interface Estimate {
  /** 一天内的分钟数 */
  median: number
  samples: number
  confidence: number
  /** 这个估计来自：手填 / 明确晚安 / 最后一条消息 */
  source?: 'manual' | 'explicit' | 'last-message'
}

export interface HomeworkWindow {
  start: number
  end: number
  hits: number
}

export interface DayProfile {
  wake: Estimate | null
  sleep: Estimate | null
  activeHours: number[]
  homework: HomeworkWindow | null
  /** 是否用了手动先验 */
  manual: boolean
}

export interface RhythmProfile {
  weekday: DayProfile
  weekend: DayProfile
  updatedAt: number
}

export interface ManualPriors {
  wake: string
  sleep: string
  homeworkStart: string
  homeworkEnd: string
}

export interface RhythmStore {
  record: (at: number) => void
  /** 记录一次“明确说要睡了”的信号 */
  recordSleep: (at: number) => void
  /** 开始/结束一次写作业 */
  recordHomeworkStart: (at: number) => void
  recordHomeworkEnd: (at: number) => void
  days: () => DaySample[]
  profile: (manual: ManualPriors, now?: Date) => RhythmProfile
  clear: () => void
  file: string
}

const MAX_DAYS = 30
/** 少于这个样本天数就不算“有把握”，主动问候不启动 */
export const MIN_SAMPLES_FOR_GREETING = 5
/** 周末天数天然只有工作日的一半，门槛放低 */
export const MIN_SAMPLES_FOR_GREETING_WEEKEND = 3
const WINDOW_DAYS = 14

/** 凌晨 4 点前算前一天：熬夜聊到 1 点，不该把那天记成“1 点起床” */
const DAY_CUTOFF_HOUR = 4

function logicalDate(date: Date): Date {
  if (date.getHours() < DAY_CUTOFF_HOUR) {
    const prev = new Date(date)
    prev.setDate(prev.getDate() - 1)
    return prev
  }
  return date
}

/** 一天内的分钟数；跨零点的时间往后接（00:30 → 1470），方便排序和取中位数 */
function minutesOf(date: Date): number {
  const minutes = date.getHours() * 60 + date.getMinutes()
  return date.getHours() < DAY_CUTOFF_HOUR ? minutes + 1440 : minutes
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function minutesOfClock(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(clock.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

export function clockOfMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24
  const minute = Math.round(minutes % 60)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function estimate(values: number[], manualClock: string, now: Date): { value: Estimate | null; manual: boolean } {
  const manual = minutesOfClock(manualClock)
  if (manual !== null) {
    return { value: { median: manual, samples: values.length, confidence: 1 }, manual: true }
  }
  if (values.length === 0) return { value: null, manual: false }
  const confidence = Math.min(1, Math.round((values.length / 7) * 100) / 100)
  return { value: { median: median(values), samples: values.length, confidence }, manual: false }
}

function profileFor(days: DaySample[], manual: ManualPriors, weekend: boolean, now: Date): DayProfile {
  const picked = days.filter((day) => {
    const date = new Date(`${day.date}T12:00:00`)
    const isWeekend = date.getDay() === 0 || date.getDay() === 6
    return isWeekend === weekend
  })

  const wakes = picked.map((day) => day.first)
  const explicitSleeps = picked.filter((day) => typeof day.sleepAt === 'number').map((day) => day.sleepAt as number)
  const sleeps = picked.map((day) => day.last)
  const wake = estimate(wakes, manual.wake, now)
  // 有“晚安”就用它；没有才退回“最后一条消息”
  const sleep = estimate(explicitSleeps.length > 0 ? explicitSleeps : sleeps, manual.sleep, now)
  if (sleep.value) {
    sleep.value.source = sleep.manual ? 'manual' : explicitSleeps.length > 0 ? 'explicit' : 'last-message'
  }

  const hourCounts: Record<number, number> = {}
  for (const day of picked) {
    for (const [hour, count] of Object.entries(day.hours)) {
      const key = Number(hour)
      hourCounts[key] = (hourCounts[key] ?? 0) + Number(count)
    }
  }
  const activeHours = Object.entries(hourCounts)
    .filter(([, count]) => count >= Math.max(2, picked.length * 0.4))
    .map(([hour]) => Number(hour))
    .sort((a, b) => a - b)

  const manualStart = minutesOfClock(manual.homeworkStart)
  const manualEnd = minutesOfClock(manual.homeworkEnd)
  let homework: HomeworkWindow | null =
    manualStart !== null && manualEnd !== null && manualEnd > manualStart
      ? { start: manualStart, end: manualEnd, hits: picked.length }
      : null

  // 没有手动配置时，从“开始写作业”的记录里学
  if (!homework) {
    // 只学“当天内结束”的时段；跨零点的不参与，否则起止会反掉
    const sessions = picked
      .flatMap((day) => day.homework ?? [])
      .filter((session) => typeof session.end === 'number')
      .filter((session) => (session.end as number) > session.start && (session.end as number) <= 1440)
    if (sessions.length >= 3) {
      homework = {
        start: median(sessions.map((session) => session.start)),
        end: median(sessions.map((session) => session.end as number)),
        hits: sessions.length,
      }
    }
  }

  return {
    wake: wake.value,
    sleep: sleep.value,
    activeHours,
    homework,
    manual: wake.manual || sleep.manual || Boolean(homework),
  }
}

/**
 * 作息画像。和日志、事实卡都分开：
 *   · 日志记“发生了什么”
 *   · 事实卡记“你是谁”
 *   · 这里记“你的时间分布”，定量、会自动过期、不进模型上下文
 */
export function createRhythmStore(baseDir?: string): RhythmStore {
  const dir = baseDir ?? path.join(homeDir(), 'memory')
  const file = path.join(dir, 'rhythm.json')

  function read(): DaySample[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { days?: unknown }
      if (!Array.isArray(parsed.days)) return []
      return parsed.days
        .filter((day): day is Record<string, unknown> => Boolean(day) && typeof day === 'object')
        .map((day) => ({
          date: String(day.date ?? ''),
          first: Number(day.first) || 0,
          last: Number(day.last) || 0,
          hours: (day.hours && typeof day.hours === 'object' ? day.hours : {}) as Record<string, number>,
          sleepAt: typeof day.sleepAt === 'number' ? day.sleepAt : undefined,
          homework: Array.isArray(day.homework)
            ? (day.homework as Array<Record<string, unknown>>)
                .filter((item) => typeof item?.start === 'number')
                .map((item) => ({
                  start: Number(item.start),
                  end: typeof item.end === 'number' ? Number(item.end) : undefined,
                }))
            : undefined,
        }))
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
    } catch {
      return []
    }
  }

  function write(days: DaySample[]): void {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const trimmed = days.slice(-MAX_DAYS)
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, `${JSON.stringify({ days: trimmed }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      /* ignore */
    }
  }

  return {
    file,

    record(at: number) {
      const date = new Date(at)
      const key = dateKey(logicalDate(date))
      const minutes = minutesOf(date)
      const hour = String(date.getHours())
      const days = read()
      const existing = days.find((day) => day.date === key)
      if (existing) {
        existing.first = Math.min(existing.first, minutes)
        existing.last = Math.max(existing.last, minutes)
        existing.hours[hour] = (existing.hours[hour] ?? 0) + 1
      } else {
        days.push({ date: key, first: minutes, last: minutes, hours: { [hour]: 1 } })
      }
      write(days)
    },

    days: () => read(),

    recordHomeworkStart(at: number) {
      const date = new Date(at)
      const minutes = minutesOf(date)
      const days = read()
      const key = dateKey(logicalDate(date))
      const existing = days.find((day) => day.date === key)
      if (existing) {
        existing.homework = [...(existing.homework ?? []), { start: minutes }]
      } else {
        days.push({ date: key, first: minutes, last: minutes, hours: {}, homework: [{ start: minutes }] })
      }
      write(days)
    },

    recordHomeworkEnd(at: number) {
      const date = new Date(at)
      const minutes = date.getHours() * 60 + date.getMinutes()
      const days = read()

      // 先看今天有没有没结束的；没有就看昨天——跨零点写作业会落在昨天的记录里
      const today = days.find((entry) => entry.date === dateKey(date))
      let target = today?.homework?.slice().reverse().find((session) => typeof session.end !== 'number')

      if (!target) {
        const yesterday = new Date(date)
        yesterday.setDate(yesterday.getDate() - 1)
        const prev = days.find((entry) => entry.date === dateKey(yesterday))
        target = prev?.homework?.slice().reverse().find((session) => typeof session.end !== 'number')
      }

      if (!target) return
      // 结束时刻早于开始，说明跨了零点：记成 24 小时制之后的数
      target.end = minutes < target.start ? minutes + 1440 : minutes
      write(days)
    },

    recordSleep(at: number) {
      const date = new Date(at)
      const key = dateKey(logicalDate(date))
      const minutes = minutesOf(date)
      const days = read()
      const existing = days.find((day) => day.date === key)
      if (existing) {
        existing.sleepAt = minutes
        existing.first = Math.min(existing.first, minutes)
        existing.last = Math.max(existing.last, minutes)
      } else {
        days.push({ date: key, first: minutes, last: minutes, hours: {}, sleepAt: minutes })
      }
      write(days)
    },

    profile(manual: ManualPriors, now: Date = new Date()): RhythmProfile {
      const cutoff = new Date(now)
      cutoff.setDate(cutoff.getDate() - WINDOW_DAYS)
      const cutoffKey = dateKey(cutoff)
      const recent = read().filter((day) => day.date >= cutoffKey)

      return {
        weekday: profileFor(recent, manual, false, now),
        weekend: profileFor(recent, manual, true, now),
        updatedAt: Date.now(),
      }
    },

    clear() {
      try {
        fs.rmSync(file)
      } catch {
        /* ignore */
      }
    },
  }
}

/** 主动问候能不能启动：样本够，或者你手动给了先验 */
export function canGreet(day: DayProfile, weekend = false): boolean {
  if (day.manual) return true
  const need = weekend ? MIN_SAMPLES_FOR_GREETING_WEEKEND : MIN_SAMPLES_FOR_GREETING
  return Boolean(day.wake && day.wake.samples >= need)
}

export function profileForDay(profile: RhythmProfile, day: Date = new Date()): DayProfile {
  const weekend = day.getDay() === 0 || day.getDay() === 6
  return weekend ? profile.weekend : profile.weekday
}

/** 一句话描述：给日报和设置页用 */
export function describeProfile(day: DayProfile): string {
  if (!day.wake && !day.sleep) return '样本还不够，还看不出作息'
  const parts: string[] = []
  if (day.wake) {
    parts.push(`通常 ${clockOfMinutes(day.wake.median)} 起（${day.wake.samples} 天样本）`)
  }
  if (day.sleep) {
    const clock = clockOfMinutes(day.sleep.median)
    parts.push(
      day.sleep.source === 'manual'
        ? `大约 ${clock} 睡（你填的）`
        : day.sleep.source === 'explicit'
          ? `大约 ${clock} 睡（按你说的晚安）`
          : `最后一条消息约 ${clock}`,
    )
  }
  if (day.homework) {
    parts.push(`写作业多在 ${clockOfMinutes(day.homework.start)}–${clockOfMinutes(day.homework.end)}`)
  }
  return parts.join('，')
}
