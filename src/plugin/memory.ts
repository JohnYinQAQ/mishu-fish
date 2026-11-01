import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../config.ts'

export type MemoryScope = 'chat' | 'agent' | 'system'

export interface MemoryEntry {
  /** 毫秒时间戳 */
  at: number
  role: 'user' | 'assistant'
  text: string
  /** 谁写的：聊天 / 后台 agent / 系统。以后接入别的机器人时用来隔离 */
  scope: MemoryScope
  meta?: string
}

/**
 * 记忆的读写接口。
 *
 * 刻意只暴露五个动作：写、读最近、读事实卡、写事实卡、列出某天。
 * 以后接入别的机器人（养鱼、别的 IM）时，只要能拿到这三样，就能共用这份记忆，
 * 不需要知道它是怎么存的。
 */
export interface MemoryMatch extends MemoryEntry {
  score: number
}

export interface MemoryStore {
  append: (entry: MemoryEntry) => void
  recent: (count: number, options?: { scope?: MemoryScope; before?: number }) => MemoryEntry[]
  /** 关键词检索：中文按二元组打分，不依赖分词库 */
  search: (query: string, options?: { days?: number; limit?: number; scope?: MemoryScope }) => MemoryMatch[]
  day: (date?: Date) => MemoryEntry[]
  writeSummary: (date: Date, text: string) => void
  readSummary: (date: Date) => string
  hasDigest: (date: Date) => boolean
  summariesDir: string
  facts: () => string
  writeFacts: (text: string) => void
  dayFile: (date?: Date) => string
  dir: string
}

function dayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shiftDays(date: Date, delta: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + delta)
  return next
}

export function createMemoryStore(baseDir?: string): MemoryStore {
  const dir = baseDir ?? path.join(homeDir(), 'memory')

  function dayFile(date: Date = new Date()): string {
    return path.join(dir, `${dayKey(date)}.jsonl`)
  }

  function ensure(): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  function append(entry: MemoryEntry): void {
    try {
      ensure()
      fs.appendFileSync(dayFile(new Date(entry.at)), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      /* 记忆写失败不能影响回复 */
    }
  }

  function readDay(date: Date): MemoryEntry[] {
    const file = dayFile(date)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out: MemoryEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as MemoryEntry
        if (value && typeof value.text === 'string' && (value.role === 'user' || value.role === 'assistant')) {
          out.push(value)
        }
      } catch {
        /* 单行坏了就跳过，不整份作废 */
      }
    }
    return out
  }

  function recent(count: number, options: { scope?: MemoryScope; before?: number } = {}): MemoryEntry[] {
    if (count <= 0) return []
    const cutoff = options.before ?? Date.now()
    const start = new Date(cutoff)
    const collected: MemoryEntry[] = []
    // 从今天往回翻，最多翻 7 天；按时间正序返回
    for (let offset = 0; offset < 7 && collected.length < count; offset++) {
      const day = shiftDays(start, -offset)
      const entries = readDay(day)
        .filter((entry) => entry.at <= cutoff)
        .filter((entry) => (options.scope ? entry.scope === options.scope : true))
      collected.unshift(...entries)
    }
    return collected.slice(-count)
  }

  /** 中文没有空格，用二元组 + 英文单词做特征，够用且不引依赖 */
  function features(text: string): string[] {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ')
    const out = new Set<string>()
    for (const word of normalized.match(/[a-z0-9]{2,}/g) ?? []) out.add(word)
    const cjk = normalized.replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
    return [...out]
  }

  function search(query: string, options: { days?: number; limit?: number; scope?: MemoryScope } = {}): MemoryMatch[] {
    const limit = options.limit ?? 6
    const days = options.days ?? 7
    const wanted = features(query)
    if (wanted.length === 0) return []

    const scored: MemoryMatch[] = []
    const today = new Date()
    for (let offset = 0; offset < days; offset++) {
      for (const entry of readDay(shiftDays(today, -offset))) {
        if (options.scope && entry.scope !== options.scope) continue
        const have = new Set(features(entry.text))
        let score = 0
        for (const feature of wanted) if (have.has(feature)) score += 1
        if (score >= 1) scored.push({ ...entry, score })
      }
    }
    scored.sort((a, b) => b.score - a.score || b.at - a.at)
    return scored.slice(0, limit)
  }

  function summariesDir(): string {
    return path.join(dir, 'summaries')
  }

  function summaryFile(date: Date): string {
    return path.join(summariesDir(), `${dayKey(date)}.md`)
  }

  function writeSummary(date: Date, text: string): void {
    try {
      fs.mkdirSync(summariesDir(), { recursive: true, mode: 0o700 })
      fs.writeFileSync(summaryFile(date), `${text.trim()}\n`, { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  function readSummary(date: Date): string {
    try {
      return fs.readFileSync(summaryFile(date), 'utf8').trim()
    } catch {
      return ''
    }
  }

  function hasDigest(date: Date): boolean {
    return fs.existsSync(summaryFile(date))
  }

  function factsFile(): string {
    return path.join(dir, 'facts.md')
  }

  function facts(): string {
    try {
      return fs.readFileSync(factsFile(), 'utf8').trim()
    } catch {
      return ''
    }
  }

  function writeFacts(text: string): void {
    try {
      ensure()
      fs.writeFileSync(factsFile(), `${text.trim()}\n`, { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  return {
    append,
    recent,
    search,
    day: (date: Date = new Date()) => readDay(date),
    writeSummary,
    readSummary,
    hasDigest,
    summariesDir: summariesDir(),
    facts,
    writeFacts,
    dayFile,
    dir,
  }
}
