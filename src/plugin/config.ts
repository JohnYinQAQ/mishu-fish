import { filePath } from '../config.ts'
import { writeJsonAtomic } from '../store.ts'
import fs from 'node:fs'

export const TEMPLATES = ['gentle', 'blunt', 'work', 'playful', 'custom'] as const
export type TemplateId = (typeof TEMPLATES)[number]

export const EMOJI_MODES = ['none', 'some', 'lots'] as const
export const LANGUAGES = ['zh', 'en', 'follow'] as const
export const MODEL_MODES = ['inherit', 'manual'] as const

export interface PersonaConfig {
  name: string
  selfCall: string
  callUser: string
  template: TemplateId
  /** 自由文本：写给她的“人设信”，会拼在模板后面 */
  text: string
  bannedWords: string[]
}

export interface StyleConfig {
  maxChars: number
  emoji: (typeof EMOJI_MODES)[number]
  language: (typeof LANGUAGES)[number]
  /** 微信不渲染 Markdown，默认关 */
  markdown: boolean
}

export interface BehaviorConfig {
  replyToAll: boolean
  /** HH:MM，空字符串表示不启用 */
  quietStart: string
  quietEnd: string
  perMinute: number
  fallback: string
}

export interface ModelConfig {
  mode: (typeof MODEL_MODES)[number]
  provider: string
  model: string
  temperature: number
  maxTokens: number
}

export interface EscalationConfig {
  enabled: boolean
  prefix: string
  timeoutSec: number
  /** 转后台时把秘书鱼的人设一起带过去 */
  carryPersona: boolean
  /** 转后台时把最近的聊天记忆一起带过去 */
  carryMemory: boolean
  /** 给后台 agent 的权限预设；空字符串表示不干预 */
  permissionPreset: string
  /** 后台 agent 的工作目录；空字符串用用户主目录 */
  cwd: string
}

export interface MemoryConfig {
  enabled: boolean
  /** 每条消息固定带最近几条原文 */
  recentCount: number
  injectFacts: boolean
  /** 命中触发词时才检索日摘要 */
  retrieveSummaries: boolean
  /** 命中触发词时检索相关原文（现在就在用） */
  recallEnabled: boolean
  recallMaxLines: number
  triggerWords: string[]
  /** 事实卡字符上限 */
  factsLimit: number
  /** 每日摘要时间 HH:MM */
  summaryTime: string
  /** 周报：每周固定一天，把 7 天摘要合成一条 */
  weeklyReport: boolean
  /** 0=周日 … 6=周六 */
  weeklyDay: number
  weeklyTime: string
  /** 摘要完成后发一条日报 */
  dailyReport: boolean
  digestRetentionDays: number
}

export interface ScheduleConfig {
  enabled: boolean
  /** 晚间提醒：今天没做完的 + 明天的安排 */
  eveningTime: string
  /** 早间提醒：今天要做的 */
  morningTime: string
  /** 微信里触发“新增日程”的词 */
  triggerWord: string
  /** 微信发不出去时弹系统通知 */
  notifyFallback: boolean
  /** 判断“这条算完成”时先问一句再改状态 */
  confirmOnComplete: boolean
}

export interface RhythmConfig {
  enabled: boolean
  /** 手动先验，空字符串表示自动推断 */
  wakeTime: string
  sleepTime: string
  homeworkStart: string
  homeworkEnd: string
  /** 早间问候的时刻；空字符串表示不问候 */
  morningGreeting: string
  /** 晚间问候的时刻；空字符串表示不问候 */
  eveningGreeting: string
}

export interface OnboardingConfig {
  /** 第一次对话时先做自我介绍和征询 */
  welcome: boolean
}

export interface HabitsConfig {
  /** 从聊天里学习惯（每条消息多一次判断） */
  learnFromChat: boolean
}

export interface AppConfig {
  enabled: boolean
  persona: PersonaConfig
  style: StyleConfig
  behavior: BehaviorConfig
  model: ModelConfig
  escalation: EscalationConfig
  memory: MemoryConfig
  schedule: ScheduleConfig
  rhythm: RhythmConfig
  habits: HabitsConfig
  onboarding: OnboardingConfig
}

export const DEFAULT_CONFIG: AppConfig = {
  enabled: true,
  persona: {
    name: '秘书鱼',
    selfCall: '我',
    callUser: '你',
    template: 'gentle',
    text: '',
    bannedWords: [],
  },
  style: { maxChars: 120, emoji: 'some', language: 'zh', markdown: false },
  behavior: {
    replyToAll: true,
    quietStart: '',
    quietEnd: '',
    perMinute: 6,
    fallback: '我这边卡了一下，等下再试。',
  },
  model: { mode: 'inherit', provider: '', model: '', temperature: 0.7, maxTokens: 400 },
  escalation: {
    // 开源版默认关闭：拿到你微信的人等于拿到你电脑的命令执行权
    enabled: false,
    prefix: '!dsh',
    timeoutSec: 60,
    carryPersona: true,
    carryMemory: true,
    permissionPreset: 'danger-full-access',
    cwd: '',
  },
  schedule: {
    enabled: true,
    eveningTime: '23:00',
    morningTime: '07:00',
    triggerWord: '记一下',
    notifyFallback: true,
    confirmOnComplete: false,
  },
  habits: {
    learnFromChat: true,
  },
  onboarding: {
    welcome: true,
  },
  rhythm: {
    enabled: true,
    wakeTime: '',
    sleepTime: '',
    homeworkStart: '',
    homeworkEnd: '',
    morningGreeting: '07:30',
    eveningGreeting: '23:00',
  },
  memory: {
    enabled: true,
    recentCount: 8,
    injectFacts: true,
    retrieveSummaries: false,
    recallEnabled: true,
    recallMaxLines: 6,
    triggerWords: ['上次', '前几天', '之前', '那个事', '还记得', '记得我', '我说过'],
    factsLimit: 400,
    summaryTime: '05:00',
    weeklyReport: true,
    weeklyDay: 0,
    weeklyTime: '20:00',
    dailyReport: true,
    digestRetentionDays: 90,
  },
}

function str(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function float(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 时间写成 HH:MM；不合法就当没设置 */
function clock(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 把任意输入收敛成合法配置。
 * 设置页、手改 JSON、旧版本配置都会走这里，所以边界值一律夹紧而不是报错。
 */
export function normalizeConfig(raw: unknown): AppConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const persona = (input.persona ?? {}) as Record<string, unknown>
  const style = (input.style ?? {}) as Record<string, unknown>
  const behavior = (input.behavior ?? {}) as Record<string, unknown>
  const model = (input.model ?? {}) as Record<string, unknown>
  const escalation = (input.escalation ?? {}) as Record<string, unknown>
  const memory = (input.memory ?? {}) as Record<string, unknown>
  const schedule = (input.schedule ?? {}) as Record<string, unknown>
  const rhythm = (input.rhythm ?? {}) as Record<string, unknown>
  const habits = (input.habits ?? {}) as Record<string, unknown>
  const onboarding = (input.onboarding ?? {}) as Record<string, unknown>

  const banned = Array.isArray(persona.bannedWords)
    ? persona.bannedWords
        .filter((word): word is string => typeof word === 'string')
        .map((word) => word.trim())
        .filter(Boolean)
        .slice(0, 20)
    : []

  return {
    enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
    persona: {
      name: str(persona.name, 20, DEFAULT_CONFIG.persona.name) || DEFAULT_CONFIG.persona.name,
      selfCall: str(persona.selfCall, 20, DEFAULT_CONFIG.persona.selfCall),
      callUser: str(persona.callUser, 20, DEFAULT_CONFIG.persona.callUser),
      template: oneOf(persona.template, TEMPLATES, DEFAULT_CONFIG.persona.template),
      text: str(persona.text, 4000, DEFAULT_CONFIG.persona.text),
      bannedWords: banned,
    },
    style: {
      maxChars: int(style.maxChars, 20, 2000, DEFAULT_CONFIG.style.maxChars),
      emoji: oneOf(style.emoji, EMOJI_MODES, DEFAULT_CONFIG.style.emoji),
      language: oneOf(style.language, LANGUAGES, DEFAULT_CONFIG.style.language),
      markdown: bool(style.markdown, DEFAULT_CONFIG.style.markdown),
    },
    behavior: {
      replyToAll: bool(behavior.replyToAll, DEFAULT_CONFIG.behavior.replyToAll),
      quietStart: clock(behavior.quietStart),
      quietEnd: clock(behavior.quietEnd),
      perMinute: int(behavior.perMinute, 1, 30, DEFAULT_CONFIG.behavior.perMinute),
      fallback: str(behavior.fallback, 200, DEFAULT_CONFIG.behavior.fallback),
    },
    model: {
      mode: oneOf(model.mode, MODEL_MODES, DEFAULT_CONFIG.model.mode),
      provider: str(model.provider, 60, ''),
      model: str(model.model, 60, ''),
      temperature: float(model.temperature, 0, 2, DEFAULT_CONFIG.model.temperature),
      maxTokens: int(model.maxTokens, 50, 4000, DEFAULT_CONFIG.model.maxTokens),
    },
    escalation: {
      enabled: bool(escalation.enabled, DEFAULT_CONFIG.escalation.enabled),
      prefix: str(escalation.prefix, 12, DEFAULT_CONFIG.escalation.prefix) || DEFAULT_CONFIG.escalation.prefix,
      timeoutSec: int(escalation.timeoutSec, 10, 300, DEFAULT_CONFIG.escalation.timeoutSec),
      carryPersona: bool(escalation.carryPersona, DEFAULT_CONFIG.escalation.carryPersona),
      carryMemory: bool(escalation.carryMemory, DEFAULT_CONFIG.escalation.carryMemory),
      permissionPreset: str(escalation.permissionPreset, 40, DEFAULT_CONFIG.escalation.permissionPreset),
      cwd: str(escalation.cwd, 200, DEFAULT_CONFIG.escalation.cwd),
    },
    schedule: {
      enabled: bool(schedule.enabled, DEFAULT_CONFIG.schedule.enabled),
      eveningTime: clock(schedule.eveningTime) || DEFAULT_CONFIG.schedule.eveningTime,
      morningTime: clock(schedule.morningTime) || DEFAULT_CONFIG.schedule.morningTime,
      // 留空 = 自动判断；空串要保留，不能回落到默认词
      triggerWord:
        schedule.triggerWord === undefined
          ? DEFAULT_CONFIG.schedule.triggerWord
          : String(schedule.triggerWord).trim().slice(0, 12),
      notifyFallback: bool(schedule.notifyFallback, DEFAULT_CONFIG.schedule.notifyFallback),
      confirmOnComplete: bool(schedule.confirmOnComplete, DEFAULT_CONFIG.schedule.confirmOnComplete),
    },
    habits: {
      learnFromChat: bool(habits.learnFromChat, DEFAULT_CONFIG.habits.learnFromChat),
    },
    onboarding: {
      welcome: bool(onboarding.welcome, DEFAULT_CONFIG.onboarding.welcome),
    },
    rhythm: {
      enabled: bool(rhythm.enabled, DEFAULT_CONFIG.rhythm.enabled),
      wakeTime: clock(rhythm.wakeTime),
      sleepTime: clock(rhythm.sleepTime),
      homeworkStart: clock(rhythm.homeworkStart),
      homeworkEnd: clock(rhythm.homeworkEnd),
      // 未填时用默认时刻；显式填空串表示“不要问候”
      morningGreeting:
        rhythm.morningGreeting === undefined
          ? DEFAULT_CONFIG.rhythm.morningGreeting
          : clock(rhythm.morningGreeting),
      eveningGreeting:
        rhythm.eveningGreeting === undefined
          ? DEFAULT_CONFIG.rhythm.eveningGreeting
          : clock(rhythm.eveningGreeting),
    },
    memory: {
      enabled: bool(memory.enabled, DEFAULT_CONFIG.memory.enabled),
      recentCount: int(memory.recentCount, 4, 20, DEFAULT_CONFIG.memory.recentCount),
      injectFacts: bool(memory.injectFacts, DEFAULT_CONFIG.memory.injectFacts),
      retrieveSummaries: bool(memory.retrieveSummaries, DEFAULT_CONFIG.memory.retrieveSummaries),
      recallEnabled: bool(memory.recallEnabled, DEFAULT_CONFIG.memory.recallEnabled),
      recallMaxLines: int(memory.recallMaxLines, 2, 20, DEFAULT_CONFIG.memory.recallMaxLines),
      triggerWords: Array.isArray(memory.triggerWords)
        ? memory.triggerWords
            .filter((word): word is string => typeof word === 'string')
            .map((word) => word.trim())
            .filter(Boolean)
            .slice(0, 12)
        : DEFAULT_CONFIG.memory.triggerWords,
      factsLimit: int(memory.factsLimit, 200, 1000, DEFAULT_CONFIG.memory.factsLimit),
      summaryTime: clock(memory.summaryTime) || DEFAULT_CONFIG.memory.summaryTime,
      weeklyReport: bool(memory.weeklyReport, DEFAULT_CONFIG.memory.weeklyReport),
      weeklyDay: int(memory.weeklyDay, 0, 6, DEFAULT_CONFIG.memory.weeklyDay),
      weeklyTime: clock(memory.weeklyTime) || DEFAULT_CONFIG.memory.weeklyTime,
      dailyReport: bool(memory.dailyReport, DEFAULT_CONFIG.memory.dailyReport),
      digestRetentionDays: int(memory.digestRetentionDays, 30, 365, DEFAULT_CONFIG.memory.digestRetentionDays),
    },
  }
}

export function loadConfig(): AppConfig {
  const file = filePath('config.json')
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return normalizeConfig({})
    // 配置坏了不要让人进不去设置页：回默认值，界面上会提示
    return normalizeConfig({})
  }
}

export function saveConfig(config: AppConfig): AppConfig {
  const next = normalizeConfig(config)
  writeJsonAtomic(filePath('config.json'), next)
  return next
}

export function configFile(): string {
  return filePath('config.json')
}
