import type { AppConfig } from './config.ts'
import type { MemoryStore } from './memory.ts'
import type { LlmService, Route } from './reply.ts'

export interface DigestResult {
  /** 这一天的概括 */
  summary: string
  /** 更新后的完整事实卡 */
  facts: string
  /** 给主人看的汇报，一句话级别 */
  report: string
  entries: number
  usage?: { input: number; output: number }
}

export interface DigestOptions {
  llm: LlmService
  config: AppConfig
  memory: MemoryStore
  route: Route
  date?: Date
  signal?: AbortSignal
}

const DIGEST_TIMEOUT_MS = 60_000

function dayLabel(date: Date): string {
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

async function callOnce(
  llm: LlmService,
  route: Route,
  system: string,
  user: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { input: number; output: number } }> {
  const signals = [AbortSignal.timeout(DIGEST_TIMEOUT_MS)]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)

  let text = ''
  let failure = ''
  let usage: { input: number; output: number } | undefined
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature: 0.3,
    maxTokens,
    signal: combined,
  })
  for await (const chunk of stream) {
    const value = (chunk ?? {}) as Record<string, unknown>
    if (value.type === 'finish') {
      const reason = (value.reason ?? {}) as Record<string, unknown>
      if (reason.kind === 'error') {
        const fail = (reason.failure ?? {}) as Record<string, unknown>
        failure = [fail.code, fail.message].filter(Boolean).join(': ') || '模型调用失败'
      }
    }
    if (value.type === 'usage' && value.usage && typeof value.usage === 'object') {
      const raw = value.usage as Record<string, unknown>
      usage = { input: Number(raw.inputTokens ?? 0), output: Number(raw.outputTokens ?? 0) }
    }
    if (value.type === 'text-delta' && typeof value.text === 'string') text += value.text
  }
  if (failure) throw new Error(failure)
  return { text: text.trim(), usage }
}

/** 模型偶尔会用 ```json 包裹，或者前后带解释，这里都兜住 */
/** 从半截 JSON 里捞一个字符串字段（模型被 maxTokens 截断时用） */
export function salvageField(raw: string, key: string): string {
  const marker = `"${key}"`
  let index = raw.indexOf(marker)
  if (index < 0) return ''
  index += marker.length
  while (index < raw.length && (raw[index] === ' ' || raw[index] === ':')) index += 1
  if (raw[index] !== '"') return ''
  index += 1
  let out = ''
  while (index < raw.length) {
    const char = raw[index]
    if (char === '\\') {
      const next = raw[index + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '')
      index += 2
      continue
    }
    if (char === '"') break
    out += char
    index += 1
  }
  return out.trim()
}

export function parseDigest(raw: string): { summary: string; facts: string; report: string } | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const value = JSON.parse(cleaned) as Record<string, unknown>
    const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
    const facts = typeof value.facts === 'string' ? value.facts.trim() : ''
    const report = typeof value.report === 'string' ? value.report.trim() : ''
    if (!summary && !facts) return null
    return { summary, facts, report }
  } catch {
    // JSON 被截断/夹了杂质：逐个字段捞，能捞多少算多少
    const summary = salvageField(cleaned, 'summary')
    const facts = salvageField(cleaned, 'facts')
    const report = salvageField(cleaned, 'report')
    if (summary || facts) return { summary, facts, report }
    return { summary: cleaned.slice(0, 1200), facts: '', report: '' }
  }
}

/**
 * 把某一天的原文压成：摘要 + 新的事实卡 + 一条汇报。
 * 纯函数式：读什么、调哪个模型、写哪里都由调用方决定，方便测试。
 */
export async function runDigest(options: DigestOptions): Promise<DigestResult | null> {
  const date = options.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000)
  const entries = options.memory.day(date)
  if (entries.length === 0) return null

  const oldFacts = options.memory.facts()
  const limit = options.config.memory.factsLimit
  const transcript = entries
    .map((entry) => `${entry.role === 'user' ? '主人' : '秘书鱼'}：${entry.text}`)
    .join('\n')

  const system = [
    '你是记忆整理员。输入某一天的对话原文，输出严格 JSON（不要 Markdown 代码块，不要解释）：',
    '{"summary": "150-250 字中文概括", "facts": "更新后的完整事实卡", "report": "一句话汇报"}',
    '',
    '规则：',
    '1. summary 概括当天要紧的事、情绪和结论，不要逐句复述。它是“日志”，可以写具体事件。',
    '',
    '2. facts 是“关于主人长期成立的事”，是“档案”，不是日志。判定标准只有一条：三个月后还成立吗？',
    '   ✅ 该写：稳定的偏好、称呼、正在长期做的事、作息规律、重要的人际关系、明确的禁忌。',
    '   ❌ 不该写：',
    '      - 一次性的考试分数、成绩、比赛结果；',
    '      - 测试用的数字、句子、暗号；',
    '      - 某天的情绪、单次事件、只出现过一次的信息；',
    '      - 你对他的性格、心理、动机的猜测；',
    '      - 你自己说过的话、你做过的事。',
    '   - 拿不准就不写。事实卡每轮都会发给模型，写错会长期污染判断；短一点没关系。',
    '   - 一行一条，以 "- " 开头，单条不超过 40 字，总数不超过 12 条。',
    '   - 旧事实卡里仍然成立的保留；已经不成立的删掉；矛盾时以新信息为准。',
    '   - 当天没有任何符合条件的内容时，facts 返回空字符串。',
    '',
    '3. report 是发给主人看的，说清楚新增/删除/修改了哪几条；没有变化就写“今天没有新的长期记忆”，不超过 120 字。',
  ].join('\n')

  const user = [
    `日期：${dayLabel(date)}`,
    '',
    '【旧事实卡】',
    oldFacts || '（空）',
    '',
    '【当天对话】',
    transcript.slice(0, 12_000),
  ].join('\n')

  const { text: raw, usage } = await callOnce(options.llm, options.route, system, user, 2400, options.signal)
  const parsed = parseDigest(raw)
  if (!parsed) throw new Error('摘要结果为空')

  return {
    summary: parsed.summary,
    facts: parsed.facts.slice(0, limit),
    report: parsed.report || (parsed.facts ? '记忆已更新。' : '今天没有新的长期记忆。'),
    entries: entries.length,
    usage,
  }
}

export function buildReportText(result: DigestResult, date: Date): string {
  return `🌙 ${dayLabel(date)}的记忆整理好了\n${result.report}`
}

export interface WeeklyResult {
  text: string
  days: number
  usage?: { input: number; output: number }
}

/** ISO 周编号，用来判断“这周的周报发过没有” */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 周报：把最近 7 天的日摘要合成一条。
 * 少于 2 天有效摘要就返回 null——一周没怎么说话，硬凑一篇反而假。
 */
export async function runWeekly(options: {
  llm: LlmService
  config: AppConfig
  memory: MemoryStore
  route: Route
  now?: Date
  signal?: AbortSignal
}): Promise<WeeklyResult | null> {
  const now = options.now ?? new Date()
  const days: Array<{ date: Date; summary: string }> = []

  for (let offset = 1; offset <= 7; offset++) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    const summary = options.memory.readSummary(date)
    if (summary) days.push({ date, summary })
  }

  if (days.length < 2) return null

  const system = [
    '你是秘书鱼，给主人写一条“一周小结”。',
    '要求：',
    '1. 纯文本，不要 Markdown，不超过 400 字。',
    '2. 说三件事：这周做了什么、有什么反复出现的模式、下周一件事的建议。',
    '3. 不要逐天罗列，不要编造摘要里没有的事。',
    '4. 语气按人设来，像朋友在总结，不要像工作汇报。',
  ].join('\n')

  const user = days
    .slice()
    .reverse()
    .map((entry) => `${dayLabel(entry.date)}：${entry.summary}`)
    .join('\n\n')

  const { text, usage } = await callOnce(options.llm, options.route, system, user.slice(0, 12_000), 1200, options.signal)
  const clean = text.trim()
  if (!clean) return null
  return { text: `📅 这周的小结\n${clean}`, days: days.length, usage }
}
