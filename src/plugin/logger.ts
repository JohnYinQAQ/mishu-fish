import fs from 'node:fs'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogUsage {
  input: number
  output: number
}

export interface LogEntry {
  /** 毫秒时间戳 */
  at: number
  dir: 'in' | 'out' | 'sys'
  text: string
  meta?: string
  level?: LogLevel
  /** 同一条消息的收到 / 模型调用 / 回复 / 记忆写入共用一个短 id */
  rid?: string
  usage?: LogUsage
}

const MARKS: Record<LogEntry['dir'], string> = { in: '<-', out: '->', sys: '!!' }

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }

export function levelOf(entry: LogEntry): LogLevel {
  return entry.level ?? 'info'
}

/** 默认 info 全看；选 warn / error 时只看该级别及以上 */
export function withinLevel(entry: LogEntry, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[levelOf(entry)] >= LEVEL_ORDER[minLevel]
}

/** 超过上限就把老文件往后挪：.log → .log.1 → .log.2 …，保留 keep 份 */
export function rotateIfNeeded(file: string, maxBytes = 2 * 1024 * 1024, keep = 3): void {
  try {
    const size = fs.statSync(file).size
    if (size < maxBytes) return
    const oldest = `${file}.${keep}`
    if (fs.existsSync(oldest)) fs.rmSync(oldest)
    for (let index = keep - 1; index >= 1; index--) {
      const from = `${file}.${index}`
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index + 1}`)
    }
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* 文件还不存在就没什么可轮转的 */
  }
}

export function appendLine(file: string, line: string, options: { maxBytes?: number; keep?: number } = {}): void {
  rotateIfNeeded(file, options.maxBytes, options.keep)
  try {
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
  } catch {
    /* 日志写失败不能影响主流程 */
  }
}

/**
 * 一份人读的 .log + 一份机器读的 .log.jsonl。
 * 人读的保持原来的一行式，方便 grep；机器读的带 level / rid / usage，方便统计。
 */
export function createLogger(file: string) {
  const jsonl = `${file}.jsonl`
  return {
    file,
    jsonlFile: jsonl,
    write(entry: LogEntry): void {
      const level = levelOf(entry)
      const rid = entry.rid ? ` [${entry.rid}]` : ''
      const usage = entry.usage ? ` tokens=${entry.usage.input}/${entry.usage.output}` : ''
      const meta = entry.meta ? ` (${entry.meta})` : ''
      appendLine(file, `${new Date(entry.at).toISOString()} ${MARKS[entry.dir] ?? '!!'}${rid} ${entry.text}${usage}${meta}`)
      appendLine(jsonl, JSON.stringify({ level, ...entry }))
    },
  }
}
