import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../config.ts'
import type { AppConfig } from './config.ts'
import { buildSystemPrompt, stripMarkdown } from './persona.ts'
import type { LlmService, Route } from './reply.ts'

export interface ImageReply {
  reply: string
  /** 预设类别，固定枚举里的一个 */
  topic: string
  /** 模型自由总结的关键词，1–3 个 */
  keywords: string[]
}

/** 预设类别：主题统计先落在这个框里，保证能聚合 */
export const IMAGE_CATEGORIES = ['海边', '学校', '宠物', '食物', '风景', '工作', '动漫', '截图', '其他'] as const

export function parseImageReply(raw: string): ImageReply | null {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim()
  try {
    const value = JSON.parse(cleaned) as Record<string, unknown>
    const reply = typeof value.reply === 'string' ? stripMarkdown(value.reply).trim() : ''
    const topic = typeof value.topic === 'string' ? value.topic.trim() : ''
    const rawKeywords = Array.isArray(value.keywords) ? value.keywords : []
    const keywords = rawKeywords
      .filter((word): word is string => typeof word === 'string')
      .map((word) => word.trim().slice(0, 12))
      .filter((word) => word.length > 0)
      .slice(0, 3)
    if (!reply) return null
    return { reply: reply.slice(0, 500), topic: topic.slice(0, 12), keywords }
  } catch {
    return null
  }
}

/**
 * 收到图片后：用她的人设 + 事实卡回应，同时给这张图归一个类别。
 * 一次调用同时产出「回应」和「主题」，避免为同一张图花两次钱。
 */
export async function composeImageReply(
  llm: LlmService,
  route: Route,
  config: AppConfig,
  facts: string,
  description: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }> = [],
): Promise<ImageReply | null> {
  const system = [
    buildSystemPrompt(config, facts),
    '',
    '## 这次的场景',
    '他刚给你发了一张图片。后台看图的描述在下面。',
    '你要像平时聊天那样回应他：可能是分享日常、分享一件要做的事、或单纯给你看个景。',
    '不要复述描述，也不要逐条列举画面里的东西；挑你注意到的、和他有关的点说，1–3 句。',
    '',
    '同时判断这张图属于哪一类，只能从下面选一个：',
    `${IMAGE_CATEGORIES.join('、')}。`,
    'topic 必须原样返回其中一个。',
    '',
    '另外用你自己的话总结 1–3 个关键词，描述这张图里的具体东西（地点、物品、活动），',
    '每个 2–6 个字，例如：教室、图书馆、海边日落、猫、数学题。',
    '关键词要具体，不要重复 topic。',
    '',
    '只输出 JSON，不要代码块：{"reply":"你要说的话","topic":"类别","keywords":["关键词1","关键词2"]}',
  ].join('\n')

  const recent = history.slice(-4).map((entry) => `${entry.role === 'user' ? '他' : '你'}：${entry.text}`).join('\n')
  const user = [recent ? `最近的对话：\n${recent}` : '', `图片描述：${description}`].filter(Boolean).join('\n\n')

  const signal = AbortSignal.timeout(40_000)
  let text = ''
  let failure = ''
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature: 0.7,
    maxTokens: 400,
    signal,
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
    if (value.type === 'text-delta' && typeof value.text === 'string') text += value.text
  }
  if (failure) throw new Error(failure)
  return parseImageReply(text)
}

export interface TopicRecord {
  topic: string
  /** category = 预设类别；keyword = 模型自由总结 */
  kind: 'category' | 'keyword'
  count: number
  days: string[]
  firstSeen: number
  lastSeen: number
}

/** 图片主题计数：同一类图反复出现，说明他生活里常出现这个场景 */
export function createTopicStore(baseDir?: string) {
  const dir = baseDir ?? path.join(homeDir(), 'memory')
  const file = path.join(dir, 'image-topics.json')

  function read(): Record<string, TopicRecord> {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { topics?: Record<string, TopicRecord> }
      return parsed.topics ?? {}
    } catch {
      return {}
    }
  }

  function write(topics: Record<string, TopicRecord>): void {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, `${JSON.stringify({ topics }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      /* ignore */
    }
  }

  return {
    file,
    list: () => Object.values(read()),

    record(topic: string, kind: 'category' | 'keyword' = 'category', at: number = Date.now()): TopicRecord | null {
      const clean = topic.trim().slice(0, 12)
      if (!clean) return null
      const topics = read()
      const key = `${kind}:${clean}`
      const date = new Date(at)
      const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      const existing = topics[key] ?? { topic: clean, kind, count: 0, days: [], firstSeen: at, lastSeen: at }
      existing.count += 1
      if (!existing.days.includes(day)) existing.days.push(day)
      existing.lastSeen = at
      topics[key] = existing
      write(topics)
      return existing
    },
  }
}

/** 同一类图跨 ≥3 天出现过 5 次以上，就值得写进事实卡 */
export function shouldRecordTopic(record: TopicRecord): boolean {
  return record.count >= 5 && record.days.length >= 3
}

/** 给事实卡准备的那一行 */
export function topicFactLine(topic: string, kind: 'category' | 'keyword' = 'category'): string {
  return kind === 'keyword' ? `- 常发与「${topic}」有关的图片` : `- 常发${topic}相关的图片`
}
