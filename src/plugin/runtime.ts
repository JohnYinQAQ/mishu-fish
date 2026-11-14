import { loadConfig, normalizeConfig, saveConfig } from './config.ts'
import type { AppConfig } from './config.ts'
import { createBridge, SESSION_WINDOW_MS } from './bridge.ts'
import type { Bridge, BridgeStatus, LogEntry, ReplyOutcome } from './bridge.ts'
import { generateReply, resolveRoute } from './reply.ts'
import { createMemoryStore } from './memory.ts'
import { createScheduleStore } from './schedule.ts'
import type { ScheduleInput, SchedulePatch } from './schedule.ts'
import { buildReportText, runDigest, runWeekly, weekKey } from './digest.ts'
import { sendText } from '../ilink/bot.ts'
import type { MemoryStore } from './memory.ts'
import type { ChatMessage } from './persona.ts'
import { buildEscalationPrompt } from './persona.ts'
import { completionCandidates, detectCompletion, detectQuery, formatAdded, formatList, inferDueFromText, isQuestion, itemsInRange, looksLikeItHasTime, matchTrigger, rangeLabel } from './schedule-intent.ts'
import { classifyCompletion, classifyHomeworkState, detectActivity, detectMessageIntent, parseScheduleText } from './schedule-parse.ts'
import { clockMinutes, dayKey, greetingsDue } from './reminder.ts'
import { canGreet, createRhythmStore, describeProfile, profileForDay } from './rhythm.ts'
import { DEFAULT_LEAD_MINUTES, createHabitStore, discoverHabits, habitsDue, ruleText } from './habits.ts'
import { createActivityStore, describeActivity, toHabitInput } from './activities.ts'
import type { Habit } from './habits.ts'
import { composeReply, generateProactive, looksLikeData } from './proactive.ts'
import type { ProactiveContext, ProactiveKind } from './proactive.ts'
import { doneToday, repeatText } from './schedule.ts'
import { itemLines } from './format.ts'
import { downloadImage } from './media.ts'
import { composeImageReply, createTopicStore, shouldRecordTopic, topicFactLine } from './image-reply.ts'
import type { LlmService, Route } from './reply.ts'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { filePath, homeDir } from '../config.ts'
import { createLogger } from './logger.ts'
import { loadCredentials, loadState, saveCredentials } from '../store.ts'
import type { Credentials } from '../ilink/types.ts'

export interface ProviderInfo {
  provider: string
  models: string[]
}

export interface RuntimeStatus {
  enabled: boolean
  running: boolean
  accountId: string
  userId: string
  lastError: string
  lastMessageAt: number | null
  lastReplyAt: number | null
  handled: number
  /** iLink 24h 会话窗口还剩多少分钟 */
  windowLeftMin: number | null
  provider: string
  model: string
}

const MAX_LOGS = 100

/**
 * 插件宿主侧的「大脑」：配置、凭据、桥接、状态、日志都收在这里。
 * lib/index.js 只负责 HTTP 接线，不写业务逻辑。
 */
export function createRuntime(options: {
  llm: LlmService
  defaults: Route
  credentials?: Credentials | null
  /** !dsh 前缀的处理：通常是 DSH agent；测试里可以注入假的 */
  escalate?: (task: string, config: AppConfig) => Promise<ReplyOutcome>
  /** 记忆存储；测试里可以指到临时目录 */
  memory?: MemoryStore
}) {
  const memory: MemoryStore = options.memory ?? createMemoryStore()
  const schedule = createScheduleStore()
  const rhythm = createRhythmStore()
  const habits = createHabitStore()
  const activities = createActivityStore()
  const imageTopics = createTopicStore()
  /** 写作业流程：先问用多久，再按估计间隔催，最多三次 */
  let homeworkSession: {
    startedAt: number
    estimateMin: number | null
    lastNudgeAt: number
    count: number
    intervalMinutes?: number
    maxNudges?: number
    /** 他说“到 3 点开始”，到这个时刻再问时长 */
    startAt?: number
    /** 他说要休息，暂停到这个时刻之前不催 */
    pausedUntil?: number
  } | null =
    null
  /** 最近一次问“这条过期的还要不要”的对象 */
  let lastOverdueAsk: { id: string; title: string; at: number } | null = null
  let config: AppConfig = loadConfig()
  let creds: Credentials | null = options.credentials === undefined ? loadCredentials() : options.credentials
  let bridge: Bridge | null = null
  let digestTimer: ReturnType<typeof setInterval> | null = null
  let digestRunning = false
  let scheduleTimer: ReturnType<typeof setInterval> | null = null
  /** 二次确认：等你回一句“对/是”，5 分钟内有效 */
  let pendingConfirm: { id: string; title: string; at: number } | null = null

  function isConfirmYes(text: string): boolean {
    return /^(对|是|是的|嗯|确认|好的|好|没错|对呀)[。.!！]?$/.test(text.trim())
  }

  function isConfirmNo(text: string): boolean {
    return /^(不是|不对|错了|算了|取消)[。.!！]?$/.test(text.trim())
  }
  /** 第一次成功的路由；后续直接用它，避免每条消息都先撞一次缺 key 的路由 */
  let chosenRoute: Route | null = null
  const logger = createLogger(filePath('mishu.log'))
  const usageFile = path.join(homeDir(), 'usage.jsonl')
  // 面板和用量都是内存态；启动时从磁盘回填，避免一重启就“什么都没有”
  let logs: LogEntry[] = loadRecentLogs(logger.jsonlFile)
  let usageToday = loadUsageToday()

  function loadRecentLogs(file: string): LogEntry[] {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOGS)
      const entries: LogEntry[] = []
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as LogEntry
          if (value && typeof value.text === 'string' && (value.dir === 'in' || value.dir === 'out' || value.dir === 'sys')) {
            entries.push(value)
          }
        } catch {
          /* 单行坏了跳过 */
        }
      }
      return entries
    } catch {
      return []
    }
  }

  function loadUsageToday() {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    let calls = 0
    let input = 0
    let output = 0
    try {
      for (const line of fs.readFileSync(usageFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as { at?: number; input?: number; output?: number }
          if (typeof value.at === 'number' && value.at >= startOfDay.getTime()) {
            calls += 1
            input += Number(value.input) || 0
            output += Number(value.output) || 0
          }
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 还没有用量文件 */
    }
    return { date: new Date().toDateString(), calls, input, output }
  }
  let status: BridgeStatus = {
    running: false,
    accountId: creds?.accountId ?? '',
    lastError: '',
    lastMessageAt: null,
    lastReplyAt: null,
    tokenAgeMin: null,
    windowLeftMin: null,
    handled: 0,
    startedAt: null,
  }

  function pushLog(entry: LogEntry): void {
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS)
    logger.write(entry)
  }

  function rollUsageDay(): void {
    const today = new Date().toDateString()
    if (usageToday.date !== today) usageToday = { date: today, calls: 0, input: 0, output: 0 }
  }

  function recordUsage(rid: string, result: { usage?: { input: number; output: number } }, route: { provider: string; model: string }): void {
    if (!result.usage) return
    rollUsageDay()
    usageToday.calls += 1
    usageToday.input += result.usage.input
    usageToday.output += result.usage.output
    try {
      fs.appendFileSync(
        usageFile,
        `${JSON.stringify({ at: Date.now(), rid, provider: route.provider, model: route.model, input: result.usage.input, output: result.usage.output })}\n`,
        { mode: 0o600 },
      )
    } catch {
      /* 用量落盘失败不影响回复 */
    }
    pushLog({
      at: Date.now(),
      dir: 'sys',
      rid,
      text: `模型用量（${route.provider}/${route.model}）`,
      usage: result.usage,
    })
  }

  function readProviders(): ProviderInfo[] {
    try {
      const raw = options.llm.listProviders?.()
      if (!Array.isArray(raw)) return []
      return raw
        .map((item) => {
          if (typeof item === 'string') return { provider: item, models: [] }
          const value = (item ?? {}) as Record<string, unknown>
          // LlmProviderInfo 的字段是 { id, name }：id 才是路由键，name 只是给人看的。
          // 之前把 name 当 id 用，导致路由变成 "DeepSeek Account"，服务端直接 NO_ADAPTER。
          const provider =
            typeof value.id === 'string'
              ? value.id
              : typeof value.provider === 'string'
                ? value.provider
                : ''
          const modelsRaw = Array.isArray(value.models)
            ? value.models
            : Array.isArray(value.modelIds)
              ? value.modelIds
              : []
          const models = modelsRaw
            .map((model) => {
              if (typeof model === 'string') return model
              const id = (model as Record<string, unknown> | null)?.id
              return typeof id === 'string' ? id : ''
            })
            .filter(Boolean)
          return { provider, models }
        })
        .filter((item) => item.provider)
    } catch {
      return []
    }
  }

  function windowLeftMin(): number | null {
    try {
      const times = Object.values(loadState().contextTokens).map((entry) => entry.at)
      if (times.length === 0) return null
      const latest = Math.max(...times)
      return Math.max(0, Math.round((SESSION_WINDOW_MS - (Date.now() - latest)) / 60000))
    } catch {
      return null
    }
  }

  /**
   * 候选路由：先试 DSH 的默认选择，再试其它 provider（优先带 account 的，
   * 因为账号登录态不需要 API key），最后兜底任意一个。
   */
  function buildRoutes(): Route[] {
    const manual = config.model.mode === 'manual' && config.model.provider.trim()
    if (manual) {
      return [{ provider: config.model.provider.trim(), model: config.model.model.trim() || options.defaults.model }]
    }

    const routes: Route[] = []
    const push = (route: Route) => {
      if (!route.provider || !route.model) return
      if (routes.some((item) => item.provider === route.provider && item.model === route.model)) return
      routes.push(route)
    }

    push(options.defaults)
    const others = readProviders().filter((item) => item.provider !== options.defaults.provider)
    const account = others.filter((item) => /account/i.test(item.provider))
    const rest = others.filter((item) => !/account/i.test(item.provider))
    for (const provider of [...account, ...rest]) {
      push({ provider: provider.provider, model: provider.models[0] ?? options.defaults.model })
    }

    // listProviders 万一没把账号路由列出来（例如适配器没 advertise 模型），
    // 这里再兜两个已知的路由名：账号登录态优先，不需要 API key。
    push({ provider: 'deepseek-account', model: 'deepseek-flash' })
    push({ provider: 'deepseek-account', model: options.defaults.model })
    return routes
  }

  /** 当前最可能可用的路由：优先用验证过能跑通的，其次挑账号登录态那种不需要 key 的 */
  function bestRoute(): Route {
    if (chosenRoute) return chosenRoute
    const routes = buildRoutes()
    return routes.find((route) => /account/i.test(route.provider)) ?? routes[0] ?? resolveRoute(config, options.defaults)
  }

  function computeStatus(): RuntimeStatus {
    const route = bestRoute()
    return {
      enabled: config.enabled,
      running: bridge?.running ?? false,
      accountId: creds?.accountId ?? '',
      userId: creds?.userId ?? '',
      lastError: status.lastError,
      lastMessageAt: status.lastMessageAt,
      lastReplyAt: status.lastReplyAt,
      handled: logs.filter((entry) => entry.dir === 'out').length,
      windowLeftMin: windowLeftMin(),
      provider: route.provider,
      model: route.model,
    }
  }

  /**
   * 从记忆里取“最近几条原文 + 事实卡 + 按需检索到的片段”。
   * 检索只在消息命中触发词时发生，避免每条消息都翻旧账。
   */
  function memoryContext(userText: string): { history: ChatMessage[]; facts: string; recall: string } {
    const mem = config.memory
    if (!mem.enabled) return { history: [], facts: '', recall: '' }
    try {
      const entries = memory.recent(mem.recentCount, { scope: 'chat' })
      const history: ChatMessage[] = entries.map((entry) => ({
        role: entry.role,
        content: [{ type: 'text' as const, text: entry.text }],
      }))
      const facts = mem.injectFacts ? memory.facts().slice(0, mem.factsLimit) : ''

      let recall = ''
      if (mem.recallEnabled && mem.triggerWords.some((word) => word && userText.includes(word))) {
        const inWindow = new Set(entries.map((entry) => entry.at))
        const matches = memory
          .search(userText, { days: mem.recallDays ?? 30, limit: mem.recallMaxLines, scope: 'chat' })
          .filter((match) => !inWindow.has(match.at))
        recall = matches
          .map((match) => {
            const when = new Date(match.at).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })
            return `- [${when}] ${match.role === 'user' ? '主人' : '秘书鱼'}：${match.text}`
          })
          .join('\n')
        if (recall) {
          pushLog({ at: Date.now(), dir: 'sys', text: `检索到 ${matches.length} 条相关记忆`, rid: '-' })
        }
      }

      return { history, facts, recall }
    } catch {
      return { history: [], facts: '', recall: '' }
    }
  }

  function pendingReportFile(): string {
    return path.join(homeDir(), 'memory', 'pending-report.json')
  }

  function readPendingReport(): string {
    try {
      const value = JSON.parse(fs.readFileSync(pendingReportFile(), 'utf8')) as { text?: string }
      return typeof value.text === 'string' ? value.text : ''
    } catch {
      return ''
    }
  }

  function savePendingReport(text: string): void {
    try {
      fs.mkdirSync(path.dirname(pendingReportFile()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(pendingReportFile(), JSON.stringify({ text, at: Date.now() }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  function clearPendingReport(): void {
    try {
      fs.rmSync(pendingReportFile())
    } catch {
      /* ignore */
    }
  }

  /** 主动发一条给主人：需要凭据 + 最近的会话令牌（24 小时窗口） */
  async function sendToOwner(text: string): Promise<boolean> {
    if (!creds) return false
    try {
      const tokens = Object.entries(loadState().contextTokens).sort((a, b) => b[1].at - a[1].at)
      const latest = tokens[0]
      if (!latest) return false
      await sendText(creds, latest[0], latest[1].token, text)
      return true
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `主动发送失败：${(err as Error)?.message ?? err}` })
      return false
    }
  }

  async function flushPendingReport(): Promise<void> {
    const text = readPendingReport()
    if (!text) return
    if (await sendToOwner(text)) {
      clearPendingReport()
      pushLog({ at: Date.now(), dir: 'sys', text: '已补发挂起的日报' })
    }
  }

  /**
   * 立即跑一次摘要（默认处理“昨天”）。
   * 5:00 的定时任务和设置页里的“立即执行”都走这里。
   */
  /** 从今天往回找最近有对话的一天；手动执行时用它，避免撞上空日期 */
  function latestDayWithEntries(): Date {
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date()
      day.setDate(day.getDate() - offset)
      if (memory.day(day).length > 0) return day
    }
    return new Date()
  }

  async function runDigestNow(date?: Date): Promise<{ ok: boolean; report?: string; sent?: boolean; entries?: number; error?: string }> {
    if (digestRunning) return { ok: false, error: '上一次摘要还在跑' }
    const target = date ?? latestDayWithEntries()
    const label = `${target.getMonth() + 1} 月 ${target.getDate()} 日`
    pushLog({ at: Date.now(), dir: 'sys', text: `开始摘要：${label}` })
    digestRunning = true
    try {
      const result = await runDigest({ llm: options.llm, config, memory, route: bestRoute(), date: target })
      if (!result) {
        const label = `${target.getMonth() + 1} 月 ${target.getDate()} 日`
        pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `摘要跳过：${label}没有对话记录` })
        return { ok: false, error: `${label}没有对话记录，没什么可整理的` }
      }

      if (result.usage) {
        rollUsageDay()
        usageToday.calls += 1
        usageToday.input += result.usage.input
        usageToday.output += result.usage.output
        pushLog({
          at: Date.now(),
          dir: 'sys',
          text: `摘要用量（${bestRoute().provider}/${bestRoute().model}）`,
          usage: result.usage,
        })
        try {
          fs.appendFileSync(
            usageFile,
            `${JSON.stringify({ at: Date.now(), rid: 'digest', provider: bestRoute().provider, model: bestRoute().model, input: result.usage.input, output: result.usage.output })}\n`,
            { mode: 0o600 },
          )
        } catch {
          /* ignore */
        }
      }
      memory.writeSummary(target, result.summary)
      if (result.facts) {
        memory.writeFacts(result.facts)
        // 事实卡每次变更留一份，方便回溯“这条是什么时候被写进去的”
        try {
          fs.appendFileSync(
            path.join(homeDir(), 'memory', 'facts-history.jsonl'),
            `${JSON.stringify({ at: Date.now(), date: `${target.getMonth() + 1}-${target.getDate()}`, facts: result.facts })}\n`,
            { mode: 0o600 },
          )
        } catch {
          /* ignore */
        }
      }
      pushLog({
        at: Date.now(),
        dir: 'sys',
        text: `摘要完成：${result.entries} 条原文 → ${result.summary.length} 字摘要、${result.facts.length} 字事实卡`,
      })

      const desc = describeProfile(profileForDay(rhythm.profile(manualPriors())))
      const text = buildReportText(result, target) + (desc ? `\n\n作息参考：${desc}` : '')
      let sent = false
      if (config.memory.dailyReport) {
        sent = await sendToOwner(text)
        if (sent) pushLog({ at: Date.now(), dir: 'sys', text: '日报已发送' })
        else {
          savePendingReport(text)
          pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: '日报发不出去（窗口关闭），已挂起等下次说话补发' })
        }
      }
      return { ok: true, report: text, sent, entries: result.entries }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `摘要失败：${message}` })
      return { ok: false, error: message }
    } finally {
      digestRunning = false
    }
  }

  /** 每天 5 点那次是否已经跑过（用标记文件，而不是“摘要文件存在”）——
   *  否则手动跑过一次当天摘要后，第二天 5 点会误以为已完成而跳过，丢掉后半夜的内容。 */
  function scheduledMarkerFile(): string {
    return path.join(homeDir(), 'memory', '.last-scheduled-digest')
  }

  function readScheduledMarker(): string {
    try {
      return fs.readFileSync(scheduledMarkerFile(), 'utf8').trim()
    } catch {
      return ''
    }
  }

  function writeScheduledMarker(day: Date): void {
    try {
      fs.mkdirSync(path.dirname(scheduledMarkerFile()), { recursive: true, mode: 0o700 })
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      fs.writeFileSync(scheduledMarkerFile(), key, { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  /** 放置 ~/.dsh/mishu-fish/run-digest 就会立刻跑一次摘要；给运维和调试用 */
  function digestTriggerFile(): string {
    return path.join(homeDir(), 'run-digest')
  }

  function checkDigestTrigger(): void {
    try {
      if (!fs.existsSync(digestTriggerFile())) return
      fs.rmSync(digestTriggerFile())
      pushLog({ at: Date.now(), dir: 'sys', text: '检测到 run-digest，手动触发摘要' })
      void runDigestNow()
    } catch {
      /* ignore */
    }
  }

  function startDigestScheduler(): void {
    if (digestTimer) return
    const tick = () => {
      try {
        checkDigestTrigger()
        if (!config.memory.enabled) return
        const [hour, minute] = config.memory.summaryTime.split(':').map(Number)
        const now = new Date()
        if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return
        const target = new Date(Date.now() - 24 * 60 * 60 * 1000)
        const key = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`
        // 用标记文件判断“今天这次定时跑过没有”：手动跑过不会挡住它
        if (readScheduledMarker() === key) return
        void runDigestNow(target).then((result) => {
          // 空日期也算“处理过”，否则每分钟都会重试一次，日志被刷满
          if (result.ok || /没有对话记录/.test(result.error ?? '')) writeScheduledMarker(target)
        })
      } catch {
        /* 调度失败不影响运行 */
      }
    }
    digestTimer = setInterval(tick, 15_000)
    digestTimer.unref?.()
    const boot = setTimeout(tick, 8000)
    boot.unref?.()
  }

  startDigestScheduler()

  function windowsMarkerFile(): string {
    return path.join(homeDir(), 'memory', '.schedule-windows.json')
  }

  function readWindowMarkers(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(windowsMarkerFile(), 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  function writeWindowMarker(window: string, key: string): void {
    try {
      const markers = readWindowMarkers()
      markers[window] = key
      fs.mkdirSync(path.dirname(windowsMarkerFile()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(windowsMarkerFile(), JSON.stringify(markers), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  /** 系统通知兜底：按平台选实现，失败不影响主流程 */
  function notifyDesktop(text: string): void {
    // 保险：结构化数据绝不进通知
    if (looksLikeData(text)) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: '通知内容像结构化数据，已丢弃' })
      return
    }
    const body = text.slice(0, 200)
    try {
      if (process.platform === 'darwin') {
        const script = `display notification ${JSON.stringify(body)} with title "秘书鱼"`
        execFile('osascript', ['-e', script], () => {})
        return
      }
      if (process.platform === 'win32') {
        const escaped = body.replace(/'/g, "''")
        const script =
          "Add-Type -AssemblyName System.Windows.Forms; " +
          "$n = New-Object System.Windows.Forms.NotifyIcon; " +
          "$n.Icon = [System.Drawing.SystemIcons]::Information; " +
          "$n.Visible = $true; " +
          `$n.ShowBalloonTip(5000, '秘书鱼', '${escaped}', 'Info'); ` +
          "Start-Sleep -Seconds 6; $n.Dispose()"
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], () => {})
        return
      }
      // Linux：有 notify-send 就用，没有就算了
      execFile('notify-send', ['秘书鱼', body], () => {})
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  /** 逾期超过 24 小时、还没问过的：返回要追加的问题（没有就空串） */
  function overdueQuestion(): string {
    const overdue = schedule
      .list()
      .filter((item) => item.status === 'pending' && !item.repeat && item.due)
      .filter((item) => Date.now() - Date.parse(item.due as string) > 24 * 60 * 60 * 1000)
      .filter((item) => !item.overdueAskedAt)
      .sort((a, b) => Date.parse(a.due as string) - Date.parse(b.due as string))[0]

    if (!overdue) return ''
    lastOverdueAsk = { id: overdue.id, title: overdue.title, at: Date.now() }
    return `\n\n「${overdue.title}」已经过期一天了，还要保留吗？回「作废」我就删掉，不回就先留着。`
  }

  function greetingContext(kind: 'morning' | 'evening'): { today?: string[]; unfinished?: string[]; tomorrow?: string[]; rhythm?: string } {
    const day = todayProfile()
    const rhythmText = describeProfile(day)

    if (kind === 'morning') {
      return { today: itemLines(itemsInRange(schedule.list(), 'today')), rhythm: rhythmText }
    }

    const endOfToday = (() => {
      const end = new Date()
      end.setHours(23, 59, 59, 999)
      return end.getTime()
    })()
    const unfinished = schedule
      .list()
      .filter(
        (item) =>
          item.status === 'pending' &&
          ((item.due && Date.parse(item.due) < endOfToday) || (item.repeat && !doneToday(item))),
      )
    return {
      unfinished: itemLines(unfinished),
      tomorrow: itemLines(itemsInRange(schedule.list(), 'tomorrow')),
      rhythm: rhythmText,
    }
  }

  /** 早/晚各一条问候；内容由人设 + 事实卡 + 当天上下文生成 */
  async function sendGreeting(kind: 'morning' | 'evening'): Promise<{ ok: boolean; text?: string; sent?: boolean; error?: string }> {
    const now = new Date()
    const day = todayProfile()
    const weekend = [0, 6].includes(now.getDay())
    if (!canGreet(day, weekend)) {
      pushLog({
        at: Date.now(),
        dir: 'sys',
        text: `${kind === 'morning' ? '早间' : '晚间'}问候跳过：样本不足（${day.wake?.samples ?? 0} 天），可在设置里手填作息`,
      })
      return { ok: false, error: '样本不足' }
    }

    const fallback =
      kind === 'morning' ? `早上好，${config.persona.callUser}。` : `晚上好，${config.persona.callUser}，早点休息。`
    let text = await composeProactive(kind, greetingContext(kind), fallback)
    if (kind === 'evening') text += overdueQuestion()

    const sent = await sendToOwner(text)
    if (!sent && config.schedule.notifyFallback) notifyDesktop(text)
    pushLog({
      at: Date.now(),
      dir: 'sys',
      level: sent ? 'info' : 'warn',
      text: `${kind === 'morning' ? '早间' : '晚间'}问候${sent ? '已发送' : '发不出去，已丢弃（不补发）'}`,
    })
    return { ok: true, text, sent }
  }

  /** 放 ~/.dsh/mishu-fish/run-greeting 就会立刻发一次；内容写 morning / evening */
  async function checkWeeklyTrigger(): Promise<boolean> {
    const file = path.join(homeDir(), 'run-weekly')
    try {
      if (!fs.existsSync(file)) return false
      fs.rmSync(file)
      const result = await runWeekly({ llm: options.llm, config, memory, route: bestRoute(), now: new Date() })
      if (!result) {
        pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: '周报：摘要不足，未生成' })
        return true
      }
      markWeekly(weekKey(new Date()))
      const sent = await sendToOwner(result.text)
      pushLog({ at: Date.now(), dir: 'sys', text: `手动触发周报：${sent ? '已发送' : '发送失败'}` })
      return true
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `周报失败：${(err as Error)?.message ?? err}` })
      return true
    }
  }

  async function checkGreetingTrigger(): Promise<boolean> {
    const file = path.join(homeDir(), 'run-greeting')
    try {
      if (!fs.existsSync(file)) return false
      const raw = fs.readFileSync(file, 'utf8').trim()
      fs.rmSync(file)
      const kind: 'morning' | 'evening' = raw === 'morning' ? 'morning' : 'evening'
      pushLog({ at: Date.now(), dir: 'sys', text: `检测到 run-greeting，立即发送${kind === 'morning' ? '早间' : '晚间'}问候` })
      await sendGreeting(kind)
      return true
    } catch {
      return false
    }
  }

  function weeklyMarkerFile(): string {
    return path.join(homeDir(), 'memory', '.weekly.json')
  }

  function lastWeekly(): string {
    try {
      const value = JSON.parse(fs.readFileSync(weeklyMarkerFile(), 'utf8')) as { last?: string }
      return String(value.last ?? '')
    } catch {
      return ''
    }
  }

  function markWeekly(key: string): void {
    try {
      fs.mkdirSync(path.dirname(weeklyMarkerFile()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(weeklyMarkerFile(), JSON.stringify({ last: key }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  async function weeklyTick(): Promise<void> {
    if (!config.memory.enabled || !config.memory.weeklyReport) return

    const now = new Date()
    if (now.getDay() !== config.memory.weeklyDay) return

    const target = clockMinutes(config.memory.weeklyTime)
    if (target === null) return
    const current = now.getHours() * 60 + now.getMinutes()
    if (current < target || current >= target + 120) return

    const key = weekKey(now)
    if (lastWeekly() === key) return

    const result = await runWeekly({ llm: options.llm, config, memory, route: bestRoute(), now })
    if (!result) {
      pushLog({ at: Date.now(), dir: 'sys', text: '周报跳过：最近 7 天有效摘要不足 2 天' })
      return
    }

    markWeekly(key)
    const sent = await sendToOwner(result.text)
    pushLog({
      at: Date.now(),
      dir: 'sys',
      level: sent ? 'info' : 'warn',
      text: `周报${sent ? '已发送' : '发不出去（本周不再重试）'}（${result.days} 天摘要）`,
    })
    if (!sent && config.schedule.notifyFallback) notifyDesktop(result.text)
  }

  async function greetingTick(): Promise<void> {
    if (!config.rhythm.enabled) return
    const now = new Date()
    const today = dayKey(now)

    for (const kind of greetingsDue(
      { morningGreeting: config.rhythm.morningGreeting, eveningGreeting: config.rhythm.eveningGreeting },
      now,
    )) {
      const markerKey = `greeting-${kind}`
      if (readWindowMarkers()[markerKey] === today) continue
      writeWindowMarker(markerKey, today)
      await sendGreeting(kind)
    }
  }

  function startScheduleScheduler(): void {
    if (scheduleTimer) return
    const tick = () => {
      void checkWeeklyTrigger()
      void checkGreetingTrigger()
      void greetingTick()
      void habitTick()
      void weeklyTick()
      scheduleDueTick()
      homeworkNudgeTick()
    }
    scheduleTimer = setInterval(tick, 60_000)
    scheduleTimer.unref?.()
    const boot = setTimeout(tick, 12_000)
    boot.unref?.()
  }

  startScheduleScheduler()
  ensureHomeworkHabit()
  syncHabits()

  function onboardedFile(): string {
    return path.join(homeDir(), 'memory', '.onboarded.json')
  }

  function welcomeSent(): boolean {
    try {
      const value = JSON.parse(fs.readFileSync(onboardedFile(), 'utf8')) as { sentAt?: number }
      return Number(value.sentAt) > 0
    } catch {
      return false
    }
  }

  function markWelcomeSent(): void {
    try {
      fs.mkdirSync(path.dirname(onboardedFile()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(onboardedFile(), JSON.stringify({ sentAt: Date.now() }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  function proactiveHistoryFile(): string {
    return path.join(homeDir(), 'memory', '.proactive.json')
  }

  function readProactiveHistory(): Record<string, { text: string; at: number }> {
    try {
      return JSON.parse(fs.readFileSync(proactiveHistoryFile(), 'utf8')) as Record<string, { text: string; at: number }>
    } catch {
      return {}
    }
  }

  function rememberProactive(kind: ProactiveKind, text: string): void {
    try {
      const history = readProactiveHistory()
      history[kind] = { text: text.slice(0, 300), at: Date.now() }
      fs.mkdirSync(path.dirname(proactiveHistoryFile()), { recursive: true, mode: 0o700 })
      fs.writeFileSync(proactiveHistoryFile(), JSON.stringify(history), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  }

  /**
   * 所有主动消息都走这里：人设 + 事实卡 + 当天上下文 + 上一次说过的话。
   * 模型失败就回落到传入的固定模板，保证不会因为一次调用失败而彻底沉默。
   */
  /**
   * 说一句给用户看的话：默认走模型，失败或关掉时用固定文案。
   * 结构化事实通过 data 传进去，要求模型原样保留。
   */
  async function say(
    cfg: AppConfig,
    instruction: string,
    data: string[],
    fallback: string,
    rid = '-',
  ): Promise<string> {
    if (!cfg.reply.modelReplies) return fallback
    const facts =
      config.memory.enabled && config.memory.injectFacts ? memory.facts().slice(0, config.memory.factsLimit) : ''
    try {
      return await composeReply(options.llm, bestRoute(), config, facts, { instruction, data, fallback })
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `回复生成失败，用模板兜底：${(err as Error)?.message ?? err}` })
      return fallback
    }
  }

  /**
   * 收到图片：下载 → 解密 → 存盘 → 交给后台 agent 看。
   * agent 不可用时如实告诉他图已经存下来了。
   */
  async function handleMedia(msg: unknown, rid: string): Promise<string | null> {
    const items = (msg as { item_list?: Array<Record<string, unknown>> })?.item_list ?? []
    const image = items.find((item) => item.image_item)?.['image_item'] as
      | { aeskey?: string; media?: { full_url?: string } }
      | undefined
    if (!image?.media?.full_url || !image.aeskey) return null

    let saved
    try {
      saved = await downloadImage(image.media.full_url, image.aeskey)
      pushLog({ at: Date.now(), dir: 'sys', rid, text: `收到图片：${saved.file}（${saved.mediaType}，${Math.round(saved.bytes / 1024)}KB）` })
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `图片下载/解密失败：${(err as Error)?.message ?? err}` })
      return '这张图我收不到，能再发一次吗？'
    }

    if (!config.escalation.enabled || !options.escalate) {
      return `图我收到了，先存着（${saved.file}）。我现在还看不懂图里的内容，等这功能做好再帮你看。`
    }

    let description = ''
    try {
      const outcome = await options.escalate(`看一下这张图片，用两三句话客观描述里面是什么：${saved.file}`, config)
      if (outcome.ok) description = outcome.text.trim()
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `看图失败：${(err as Error)?.message ?? err}` })
    }

    if (!description) {
      return `图我收下了（${saved.file}），但这次没能看清，能再说说你想问什么吗？`
    }
    pushLog({ at: Date.now(), dir: 'sys', rid, text: `图片描述：${description.slice(0, 120)}` })

    // 用她自己的语气回应，而不是把描述原样丢回去
    const facts = config.memory.enabled && config.memory.injectFacts ? memory.facts().slice(0, config.memory.factsLimit) : ''
    const history = memory.recent(Math.min(config.memory.recentCount, 8), { scope: 'chat' }).map((entry) => ({
      role: entry.role,
      text: entry.text,
    }))

    try {
      const composed = await composeImageReply(options.llm, bestRoute(), config, facts, description, history)
      if (composed) {
        const records = [
          imageTopics.record(composed.topic, 'category'),
          ...composed.keywords.map((keyword) => imageTopics.record(keyword, 'keyword')),
        ].filter((record): record is NonNullable<typeof record> => Boolean(record))

        for (const record of records) {
          pushLog({
            at: Date.now(),
            dir: 'sys',
            rid,
            text: `图片${record.kind === 'category' ? '类别' : '关键词'}：${record.topic}（${record.count} 次 / ${record.days.length} 天）`,
          })
          if (!shouldRecordTopic(record)) continue
          const line = topicFactLine(record.topic, record.kind)
          const current = memory.facts()
          if (current && !current.includes(line)) {
            memory.writeFacts([current, line].filter(Boolean).join('\n'))
            pushLog({ at: Date.now(), dir: 'sys', rid, text: `写进事实卡：${line}` })
          }
        }
        return composed.reply
      }
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `图片回应生成失败：${(err as Error)?.message ?? err}` })
    }

    return description
  }

  async function composeProactive(kind: ProactiveKind, context: Omit<ProactiveContext, 'kind' | 'previous'>, fallback: string): Promise<string> {
    const facts =
      config.memory.enabled && config.memory.injectFacts ? memory.facts().slice(0, config.memory.factsLimit) : ''
    const previous = readProactiveHistory()[kind]?.text
    try {
      const text = await generateProactive(options.llm, bestRoute(), config, facts, { ...context, kind, previous })
      if (text) {
        rememberProactive(kind, text)
        return text
      }
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `主动消息生成失败（${kind}）：模型返回空，用模板兜底` })
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `主动消息生成失败（${kind}），用模板兜底：${(err as Error)?.message ?? err}` })
    }
    rememberProactive(kind, fallback)
    return fallback
  }

  /** 从日程里同步习惯：显式重复项直接生效，反复出现的进候选 */
  function syncHabits(): void {
    try {
      for (const input of discoverHabits(schedule.list(), habits.list())) {
        habits.upsertCandidate(input)
      }
    } catch (err) {
      pushLog({ at: Date.now(), dir: 'sys', level: 'warn', text: `习惯同步失败：${(err as Error)?.message ?? err}` })
    }
  }

  /** 手动配置了作业时段、又没有对应习惯时，补一条 */
  function ensureHomeworkHabit(): void {
    const start = config.rhythm.homeworkStart
    if (!start) return
    const exists = habits.list().some((habit) => habit.askEstimate && habit.status !== 'dismissed')
    if (exists) return
    habits.add({
      label: '写作业',
      category: '学习',
      rule: { kind: 'daily', time: start },
      leadMinutes: 30,
      status: 'active',
      source: 'explicit',
      afterAsk: false,
      askEstimate: true,
    })
  }

  function habitContext(habit: Habit, kind: 'habit' | 'habit-after'): { extra: string; previous?: string } {
    const parts = [
      `这件事：${habit.label}（${habit.category}类）`,
      `时间：${ruleText(habit.rule)}，提前 ${habit.leadMinutes} 分钟提醒`,
    ]
    if (habit.evidence.count > 0) parts.push(`你已经见过这件事 ${habit.evidence.count} 次`)
    return { extra: parts.join('\n') }
  }

  async function habitTick(): Promise<void> {
    if (!config.rhythm.enabled) return
    const now = new Date()
    const today = dayKey(now)

    for (const entry of habitsDue(habits.list(), now, today)) {
      const { habit, phase } = entry

      if (phase === 'remind') {
        habits.markSent(habit.id, today)

        if (habit.askEstimate) {
          homeworkSession = { startedAt: Date.now(), estimateMin: null, lastNudgeAt: Date.now(), count: 0 }
          rhythm.recordHomeworkStart(Date.now())
          const text = await composeProactive('homework-start', habitContext(habit, 'habit'), '该写作业了。你打算多久写完？')
          await sendToOwner(text)
          pushLog({ at: Date.now(), dir: 'sys', text: `习惯触发（问时长）：${habit.label}` })
          continue
        }

        const text = await composeProactive(
          'habit',
          habitContext(habit, 'habit'),
          `${config.persona.callUser}，${habit.label}的时间快到了。`,
        )
        const sent = await sendToOwner(text)
        pushLog({
          at: Date.now(),
          dir: 'sys',
          level: sent ? 'info' : 'warn',
          text: `习惯触发：${habit.label}${sent ? '' : '（发送失败）'}`,
        })
        continue
      }

      habits.markAfterAsk(habit.id, today)
      const text = await composeProactive('habit-after', habitContext(habit, 'habit-after'), `${habit.label}弄完了吗？`)
      await sendToOwner(text)
      pushLog({ at: Date.now(), dir: 'sys', text: `习惯追问：${habit.label}` })
    }
  }

  /**
   * 统一决定一条新日程的截止时间：
   * 模型给了就用；没给但话里有“明天/周几/今晚”就按那天兜底；再不行才无期限。
   */
  function resolveDue(parsed: { due: string | null; repeat?: unknown }, text: string): { due: string | null; note?: string } {
    if (parsed.repeat) return { due: null }
    if (parsed.due) return { due: parsed.due }

    const inferred = inferDueFromText(text)
    if (inferred) return { due: inferred.date.toISOString(), note: `没听出几点，按${inferred.label}记` }
    if (looksLikeItHasTime(text)) return { due: null, note: '没听出具体时间，先按无期限记' }
    return { due: null }
  }

  function manualPriors() {
    return {
      wake: config.rhythm.wakeTime,
      sleep: config.rhythm.sleepTime,
      homeworkStart: config.rhythm.homeworkStart,
      homeworkEnd: config.rhythm.homeworkEnd,
    }
  }

  function rhythmProfile() {
    return rhythm.profile(manualPriors())
  }

  function todayProfile() {
    return profileForDay(rhythmProfile())
  }

  /** “一个半小时”“45 分钟”“半小时” */
  /** “一个半小时”“45 分钟”“两个小时”都认；中文数字也支持 */
  function parseDurationMinutes(text: string): number | null {
    const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const toNumber = (raw: string): number | null => {
      if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
      return cn[raw] ?? null
    }

    // 先看“X个半小时”：一个半小时 = 90 分钟
    const halfHour = /([一二两三四五六七八九十\d]+)\s*个?\s*半\s*(?:个)?\s*小时/.exec(text)
    if (halfHour) {
      const base = toNumber(halfHour[1])
      if (base !== null) return Math.round((base + 0.5) * 60)
    }

    const hours = /([一二两三四五六七八九十\d]+(?:\.[05])?)\s*个?\s*小时/.exec(text)
    if (hours) {
      const base = toNumber(hours[1])
      if (base !== null) return Math.round(base * 60)
    }

    const minutes = /(\d+)\s*分钟/.exec(text)
    if (minutes) return Number(minutes[1])

    if (/半(?:个)?小时/.test(text)) return 30
    return null
  }

  /** 作业催促：只要有进行中的会话，就按估时间隔催；不再依赖配置的时段 */
  /** “每十分钟”“每隔 20 分钟”这类要求；支持阿拉伯数字和常用中文数字 */
  /** “休息十分钟”“歇一会儿”里的分钟数 */
  function parsePauseMinutes(text: string): number | null {
    const cn: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 五: 5, 十: 10, 十五: 15, 二十: 20, 三十: 30 }
    const match = /([0-9]+|[一二两三四五六七八九十]+)\s*分钟/.exec(text)
    if (match) {
      const value = /^\d+$/.test(match[1]) ? Number(match[1]) : cn[match[1]]
      if (value) return Math.min(60, Math.max(1, value))
    }
    if (/半(?:个)?小时/.test(text)) return 30
    if (/一(?:个)?小时/.test(text)) return 60
    if (/(一会|一会儿|休息一下|歇一下)/.test(text)) return 10
    return null
  }

  /** “3 点”“三点”“15:00” → 今晚之前最近的这个时刻 */
  function parseClockMention(text: string, now: Date = new Date()): Date | null {
    const cn: Record<string, number> = {
      一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
    }
    const match = /([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|:|：)/.exec(text)
    if (!match) return null
    const raw = match[1]
    const hour = /^\d+$/.test(raw) ? Number(raw) : cn[raw]
    if (!Number.isFinite(hour) || hour > 23) return null

    const later = /(下午|晚上|傍晚|夜里)/.test(text)
    const base = new Date(now)
    const candidates = [hour, hour + 12].filter((value) => value <= 23)
    const resolved = later && hour < 12 ? hour + 12 : candidates.find((value) => value > base.getHours()) ?? hour

    const target = new Date(now)
    target.setHours(resolved, 0, 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return target
  }

  function parseIntervalMinutes(text: string): number | null {
    const cn: Record<string, number> = {
      五: 5, 十: 10, 十五: 15, 二十: 20, 二十五: 25, 三十: 30, 四十: 40, 四十五: 45, 六十: 60,
    }
    const match =
      /每(?:隔)?\s*([0-9]+|[一二三四五六七八九十]+)\s*分钟/.exec(text) ??
      /([0-9]+|[一二三四五六七八九十]+)\s*分钟(?:后|之后)\s*(?:提醒|叫我|提醒我)/.exec(text)
    if (!match) {
      if (/每半(?:个)?小时/.test(text)) return 30
      if (/每(?:个)?小时/.test(text)) return 60
      return null
    }
    const raw = match[1]
    const value = /^\d+$/.test(raw) ? Number(raw) : cn[raw]
    if (!value) return null
    return Math.min(60, Math.max(5, value))
  }

  /** 到点提醒：今天有截止时间的日程，到点前后一分钟内发一次 */
  function scheduleDueTick(): void {
    if (!config.schedule.enabled) return
    const now = Date.now()
    const today = dayKey(new Date())

    for (const item of schedule.list()) {
      if (item.status !== 'pending' || item.repeat || !item.due) continue
      if (item.lastReminded === today) continue
      const due = Date.parse(item.due)
      if (Number.isNaN(due)) continue
      // 只在到点前后 60 秒内触发，错过的（比如电脑关机）不补
      if (Math.abs(now - due) > 60_000) continue

      schedule.update(item.id, { lastReminded: today })
      void composeProactive(
        'habit',
        { extra: `到点提醒：${item.title}\n时间：${new Date(due).toLocaleString('zh-CN')}` },
        `${config.persona.callUser}，${item.title}的时间到了。`,
      ).then((text) => sendToOwner(text))
      pushLog({ at: Date.now(), dir: 'sys', text: `到点提醒：${item.title}` })
    }
  }

  function homeworkNudgeTick(): void {
    if (!config.rhythm.enabled) return
    if (!homeworkSession || homeworkSession.estimateMin === null) return

    if (homeworkSession.startAt && Date.now() >= homeworkSession.startAt) {
      homeworkSession.startAt = undefined
      homeworkSession.lastNudgeAt = Date.now()
      void composeProactive('homework-start', {}, '到点了，打算多久写完？').then((text) => sendToOwner(text))
      return
    }

    if (homeworkSession.pausedUntil) {
      if (Date.now() < homeworkSession.pausedUntil) return
      // 休息结束，重新开始计间隔
      homeworkSession.pausedUntil = undefined
      homeworkSession.lastNudgeAt = Date.now()
    }

    const maxNudges = homeworkSession.maxNudges ?? 3
    if (homeworkSession.count >= maxNudges) return

    // 他说了“每 N 分钟”就按他说的；没说就短任务 15、长任务 30
    const interval = homeworkSession.intervalMinutes ?? (homeworkSession.estimateMin <= 60 ? 15 : 30)
    if (Date.now() - homeworkSession.lastNudgeAt < interval * 60_000) return

    homeworkSession.count += 1
    homeworkSession.lastNudgeAt = Date.now()
    void composeProactive(
      'homework-nudge',
      { extra: `他估计要写 ${homeworkSession.estimateMin} 分钟，已经催了 ${homeworkSession.count} 次。` },
      '写完了吗？写完跟我说一声，我就不催了。',
    ).then((text) => sendToOwner(text))
  }

  /**
   * 微信里的日程指令。命中就返回一句话，交给桥接直接发出去，不经过聊天模型。
   * 顺序：新增 → 查询 → 完成。都不命中返回 null，走正常聊天。
   */
  async function quickReply(text: string, cfg: AppConfig, rid = '-'): Promise<string | null> {
    // 习惯提醒触发了，但他今天不打算去 → 别再追问
    if (/(今天不|不去了|不打了|取消|改天|算了)/.test(text)) {
      const today = dayKey(new Date())
      const hit = habits.list().find((habit) => habit.lastSentOn === today && habit.lastAfterAskOn !== today)
      if (hit) {
        habits.markAfterAsk(hit.id, today)
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `今天跳过：${hit.label}` })
        return say(
          cfg,
          '他今天不打算去了，答应他，别再提这件事。',
          [`今天不去：${hit.label}`],
          `好，${hit.label}今天先算了，我不再提。`,
          rid,
        )
      }
    }

    // 第一次说话：先打招呼介绍自己，这段话是固定的，不走模型
    if (cfg.onboarding.welcome && !welcomeSent()) {
      markWelcomeSent()
      pushLog({ at: Date.now(), dir: 'sys', rid, text: '首次对话：发送打招呼消息' })
      return [
        `你好！我是你的专属${cfg.persona.name}！从现在起住在你的微信里。`,
        '作为一个秘书，我可以记住你说过的事，你在忙什么。',
        '我也能记日程并提前提醒你完成，只要说一句「记一下：周五交报告」就行。',
        '我能学作息，你只要每天跟我睡前道晚安，起来道早安，我就可以从你的作息里判断你几点睡，几点起，在该说话的时候开口！',
      ].join('\n')
    }

    // 聊天里说“我要开始写作业了”：立刻进入流程，并记下开始时间
    // 明确开始 + 学习类动词也算；“我复习完了”这种不算
    const STUDY = /(写作业|做作业|复习|学习|刷题|做题|看书|背书|背单词|写论文|写报告|写代码)/
    const START_CUE = /(现在|开始|这就|马上|我准备)/
    const finishedCue = /(完了|结束了|做完了|写完了)/
    const wantsHomework =
      !finishedCue.test(text) &&
      (/(开始写作业|开始做作业|要写作业|准备写作业|写作业了|做作业了|写作业去)/.test(text) ||
        (START_CUE.test(text) && STUDY.test(text)))
    if (cfg.rhythm.enabled && wantsHomework && !homeworkSession) {
      const interval = parseIntervalMinutes(text)
      homeworkSession = {
        startedAt: Date.now(),
        estimateMin: null,
        lastNudgeAt: Date.now(),
        count: 0,
        ...(interval ? { intervalMinutes: interval, maxNudges: interval <= 15 ? 6 : 3 } : {}),
      }
      rhythm.recordHomeworkStart(Date.now())
      pushLog({
        at: Date.now(),
        dir: 'sys',
        rid,
        text: `开始写作业（提醒间隔 ${homeworkSession?.intervalMinutes ?? '默认'} 分钟，最多 ${homeworkSession?.maxNudges ?? 3} 次）`,
      })
      return composeProactive('homework-start', {}, '那你打算多久写完？给我个大概时间，我按这个节奏来问。')
    }

    // 写作业流程：结束/放弃/估时，都在这条通道里处理
    if (cfg.rhythm.enabled && homeworkSession) {
      const trimmed = text.trim()
      const stillWorking = /(没写完|还没|还差|差点|没做完|没弄完)/.test(trimmed)
      const DONE = /(写完|做完|搞定|弄完|完成|交了|收尾|结束)/

      let verdict: { state: string; minutes?: number } | null = null
      const clearEnough = stillWorking || DONE.test(trimmed) || /(不写|不做了|算了|今天不写|不想写)/.test(trimmed) || /(?:再给|再等|延长|宽限|给我)\s*([0-9]+|[一二三四五六七八九十]+)\s*分钟/.test(trimmed)
      // 还没问到时长时，这条消息多半就是时长本身，先别让模型判完成
      if (!clearEnough && homeworkSession.estimateMin !== null) {
        try {
          verdict = await classifyHomeworkState(options.llm, bestRoute(), trimmed)
        } catch (err) {
          pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `作业状态判断失败：${(err as Error)?.message ?? err}` })
        }
      }

      if (verdict?.state === 'done') {
        homeworkSession = null
        rhythm.recordHomeworkEnd(Date.now())
        pushLog({ at: Date.now(), dir: 'sys', rid, text: '写作业结束（模型判断）' })
        return say(cfg, '他写完了作业，收个尾，别继续催。', ['状态：作业已完成'], '好，那今天就到这儿。', rid)
      }
      if (verdict?.state === 'abandon') {
        homeworkSession = null
        return say(cfg, '他今天不想写，答应不再催。', ['状态：今天不写作业'], '行，那今天不催了。', rid)
      }
      if (verdict?.state === 'extend') {
        const minutes = verdict.minutes ?? 10
        homeworkSession.lastNudgeAt = Date.now()
        homeworkSession.maxNudges = (homeworkSession.maxNudges ?? 3) + 1
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `延长 ${minutes} 分钟（模型判断）` })
        return say(cfg, '他要再要一点时间，答应他，说明到点会再问一次。', [`延长：${minutes} 分钟`], `好，再给你 ${minutes} 分钟，到点我再问一次。`, rid)
      }

      if (!stillWorking && DONE.test(trimmed)) {
        homeworkSession = null
        rhythm.recordHomeworkEnd(Date.now())
        pushLog({ at: Date.now(), dir: 'sys', rid, text: '写作业结束（记录用时）' })
        return say(cfg, '他写完了作业，收个尾，别继续催。', ['状态：作业已完成'], '好，那今天就到这儿。', rid)
      }
      if (/(不写|不做了|算了|今天不写|不想写)/.test(trimmed)) {
        homeworkSession = null
        return say(cfg, '他今天不想写，答应不再催。', ['状态：今天不写作业'], '行，那今天不催了。', rid)
      }

      // “我先不复习了，休息十分钟” → 暂停提醒，休息完继续
      if (/(休息|歇一会|歇一下|暂停|先不(?:复习|写|做|学|看)了)/.test(trimmed)) {
        const minutes = parsePauseMinutes(trimmed) ?? 10
        homeworkSession.pausedUntil = Date.now() + minutes * 60_000
        homeworkSession.lastNudgeAt = Date.now()
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `暂停提醒 ${minutes} 分钟` })
        return say(
          cfg,
          '他要休息一会儿，答应他，并说明休息结束后会继续陪他。',
          [`休息：${minutes} 分钟`, '之后再继续'],
          `好，休息 ${minutes} 分钟，到点我再喊你。`,
          rid,
        )
      }

      // “再给我十分钟” → 从现在重新计时，并多给一次机会
      const extend = /(?:再给|再等|延长|宽限|给我)\s*([0-9]+|[一二三四五六七八九十]+)\s*分钟/.exec(trimmed)
      if (extend) {
        const minutes = parseIntervalMinutes(`每${extend[1]}分钟`) ?? 10
        homeworkSession.lastNudgeAt = Date.now()
        homeworkSession.maxNudges = (homeworkSession.maxNudges ?? 3) + 1
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `延长 ${minutes} 分钟（上限 +1）` })
        return say(
          cfg,
          '他要再要一点时间，答应他，说明到点会再问一次。',
          [`延长：${minutes} 分钟`],
          `好，再给你 ${minutes} 分钟，到点我再问一次。`,
          rid,
        )
      }
      if (homeworkSession.estimateMin === null) {
        const startAt = parseClockMention(trimmed)
        if (startAt) {
          homeworkSession.startAt = startAt.getTime()
          homeworkSession.lastNudgeAt = Date.now()
          pushLog({ at: Date.now(), dir: 'sys', rid, text: `约定开始时间：${startAt.toLocaleString('zh-CN')}` })
          return say(
            cfg,
            '他和你说好几点开始，确认这个时间，并说清到点会先问时长再提醒。',
            [`开始时间：${startAt.toLocaleString('zh-CN')}`],
            `好，${startAt.getHours()} 点开始，到点我先问你要写多久。`,
            rid,
          )
        }

        const minutes = parseDurationMinutes(trimmed)
        if (minutes !== null) {
          homeworkSession.estimateMin = minutes
          homeworkSession.lastNudgeAt = Date.now()
          return say(
            cfg,
            '确认收到预计时长，并说清楚你会多久问一次、问几次。',
            [
              `预计时长：${minutes} 分钟`,
              `提醒间隔：每 ${homeworkSession?.intervalMinutes ?? (minutes <= 60 ? 15 : 30)} 分钟一次`,
              `最多提醒：${homeworkSession?.maxNudges ?? 3} 次`,
            ],
            `好，${minutes} 分钟后我再来问一次。`,
            rid,
          )
        }
      }
    }

    // 逾期项的去留
    if (lastOverdueAsk) {
      const fresh = Date.now() - lastOverdueAsk.at < 48 * 60 * 60 * 1000
      const trimmed = text.trim()
      if (fresh && /(作废|不要了|删掉|删了|不保留|取消)/.test(trimmed)) {
        schedule.drop(lastOverdueAsk.id)
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `逾期任务作废：${lastOverdueAsk.title}` })
        const title = lastOverdueAsk.title
        lastOverdueAsk = null
        return say(cfg, '确认这件过期的安排不再提醒了。', [`已作废：${title}`], `好，「${title}」不再提醒了。`, rid)
      }
      if (fresh && /(留着|保留|还要|不用删)/.test(trimmed)) {
        schedule.markOverdueAsked(lastOverdueAsk.id)
        const title = lastOverdueAsk.title
        lastOverdueAsk = null
        return say(cfg, '确认这件过期的安排先留着。', [`保留：${title}`], `好，「${title}」先留着。`, rid)
      }
      if (!fresh) lastOverdueAsk = null
    }

    if (!cfg.schedule.enabled) return null

    // 上一次“要不要标记完成”的追问，先处理它
    if (pendingConfirm) {
      const fresh = Date.now() - pendingConfirm.at < 5 * 60_000
      if (fresh && isConfirmYes(text)) {
        schedule.done(pendingConfirm.id)
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `完成日程（已确认）：${pendingConfirm.title}` })
        const title = pendingConfirm.title
        pendingConfirm = null
        return `好，「${title}」标记完成了。`
      }
      if (fresh && isConfirmNo(text)) {
        const title = pendingConfirm.title
        pendingConfirm = null
        return `好，「${title}」先留着。`
      }
      if (!fresh) pendingConfirm = null
    }

    const payload = matchTrigger(text, cfg.schedule.triggerWord)
    if (payload !== null) {
      if (!payload) {
        return say(
          cfg,
          '他用了触发词但没说记什么，问一句要记什么，给个例子。',
          [`触发词：${cfg.schedule.triggerWord}`],
          `记什么？说一句内容，比如「${cfg.schedule.triggerWord}：周五交报告」。`,
          rid,
        )
      }

      let parsed = null
      try {
        parsed = await parseScheduleText(options.llm, bestRoute(), payload)
      } catch (err) {
        pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `日程解析失败：${(err as Error)?.message ?? err}` })
      }
      if (!parsed) {
        return say(
          cfg,
          '这次没解析出内容，请他换个说法再说一遍。',
          ['状态：解析失败'],
          '这次没解析成功，能用「记一下：内容 时间」再说一遍吗？',
          rid,
        )
      }

      const { due, note } = resolveDue(parsed, payload)
      const item = schedule.add({
        title: parsed.title,
        due,
        repeat: parsed.repeat ?? null,
        source: 'chat',
        sourceText: payload,
      })
      pushLog({
        at: Date.now(),
        dir: 'sys',
        rid,
        text: `新增日程：${item.title}（${
          item.repeat ? repeatText(item) : item.due ? new Date(item.due).toLocaleString('zh-CN') : '无期限'
        }）`,
      })
      syncHabits()
      return say(
        cfg,
        '确认你记下了一件事。必须保留事项名称和时间；如果没听出时间，用一句话说明你按无期限记了。',
        [
          `事项：${item.title}`,
          `时间：${item.due ? new Date(item.due).toLocaleString('zh-CN') : '无期限'}`,
          ...(note ? [`备注：${note}`] : []),
        ],
        formatAdded(item, note),
        rid,
      )
    }

    const range = detectQuery(text)
    if (range) {
      const list = itemsInRange(schedule.list(), range)
      pushLog({ at: Date.now(), dir: 'sys', rid, text: `查询日程：${range}（${list.length} 条）` })
      return say(
        cfg,
        '回答他的日程查询。没有安排就照实说没有；有安排就逐条列出，不要增删条目。',
        list.length === 0 ? [`范围：${rangeLabel(range)}`, '结果：没有安排'] : [`范围：${rangeLabel(range)}`, ...list.map((entry) => `· ${entry.title}${entry.due ? `（${new Date(entry.due).toLocaleString('zh-CN')}）` : '（无期限）'}`)],
        formatList(list, range),
        rid,
      )
    }

    // 完成判断分两级：
    //   1) 本地：完成语气 + 标题重合 → 直接判定
    //   2) 语气不明但标题对得上 → 问模型一次（只在有候选时发生）
    const all = schedule.list()
    const strong = detectCompletion(text, all)

    let completionCandidates_ = strong
    if (strong.length === 0 && !isQuestion(text)) {
      const loose = completionCandidates(text, all)
      if (loose.length > 0) {
        try {
          const done = await classifyCompletion(options.llm, bestRoute(), text, loose.map((entry) => entry.item.title))
          pushLog({ at: Date.now(), dir: 'sys', rid, text: `完成判定（模型）：${done ? '是' : '否'}` })
          if (done) completionCandidates_ = loose
        } catch (err) {
          pushLog({
            at: Date.now(),
            dir: 'sys',
            level: 'warn',
            rid,
            text: `完成判定失败：${(err as Error)?.message ?? err}`,
          })
        }
      }
    }

    if (completionCandidates_.length > 0) {
      if (completionCandidates_.length > 1) {
        return say(
          cfg,
          '有多件事对得上，问他指的是哪一件，把候选都列出来。',
          completionCandidates_.map((entry) => `· ${entry.item.title}`),
          `找到 ${completionCandidates_.length} 条相关的：${completionCandidates_
            .map((entry) => entry.item.title)
            .join('、')}。是哪一条？`,
          rid,
        )
      }
      const target = completionCandidates_[0].item
      if (cfg.schedule.confirmOnComplete) {
        pendingConfirm = { id: target.id, title: target.title, at: Date.now() }
        pushLog({ at: Date.now(), dir: 'sys', rid, text: `完成待确认：${target.title}` })
        return say(
          cfg,
          '向他确认这件事是不是做完了，告诉他回「是」或「不是」。',
          [`待确认：${target.title}`],
          `是把「${target.title}」标记成完成吗？回「是」或「不是」。`,
          rid,
        )
      }
      schedule.done(target.id)
      pushLog({ at: Date.now(), dir: 'sys', rid, text: `完成日程：${target.title}` })
      return say(cfg, '确认他把这件事做完了，语气轻松。', [`已完成：${target.title}`], `好，「${target.title}」标记完成了。`, rid)
    }

    // “我准备去打游戏”这类：静默记一次活动，攒够次数再建议成习惯
    if (cfg.habits.learnFromActivities && /(准备|开始|正在|马上|要去|我去|先去|得去)/.test(text) && text.length <= 40) {
      try {
        const mention = await detectActivity(options.llm, bestRoute(), text)
        if (mention) {
          const observation = activities.record(mention.label)
          if (observation) {
            pushLog({
              at: Date.now(),
              dir: 'sys',
              rid,
              text: `活动记录：${observation.label}（周${'日一二三四五六'[observation.weekday]} ${observation.hour} 点）`,
            })

            const candidates = activities.promotable(habits.list())
            const candidate = candidates.find((entry) => entry.label === mention.label)
            if (candidate) {
              const habit = habits.upsertCandidate(toHabitInput(candidate))
              if (habit) {
                pushLog({
                  at: Date.now(),
                  dir: 'sys',
                  rid,
                  text: `从活动推断出习惯候选：${habit.label}（${describeActivity(candidate)}）`,
                })
                return say(
                  cfg,
                  '你发现了他一个重复出现的规律，想建议设成习惯。说清楚：时间、做什么、要他去设置里确认才会开始提醒。',
                  [`规律：${describeActivity(candidate)}`],
                  `我注意到你${describeActivity(candidate)}。要不要把它设成习惯？我在设置里放了个候选，你确认后我才会在事前提醒你。`,
                  rid,
                )
              }
            }
          }
        }
      } catch (err) {
        pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `活动识别失败：${(err as Error)?.message ?? err}` })
      }
    }

    // 一次判断：这是日程、习惯，还是闲聊
    const autoSchedule = !cfg.schedule.triggerWord
    const learnHabits = cfg.habits.learnFromChat
    if (autoSchedule || learnHabits) {
      try {
        const intent = await detectMessageIntent(options.llm, bestRoute(), text)

        if (intent.kind === 'habit' && learnHabits) {
          const habit = habits.upsertCandidate({
            label: intent.label,
            rule: intent.rule,
            source: 'inferred',
            status: 'candidate',
            afterAsk: true,
            askEstimate: /作业|学习|复习|背单词/.test(intent.label),
          })
          if (habit) {
            pushLog({ at: Date.now(), dir: 'sys', rid, text: `发现习惯候选：${habit.label}（${ruleText(habit.rule)}）` })
            return `记下了：${habit.label} · ${ruleText(habit.rule)}。我先把它当习惯放着，你在设置里确认后我才会提前提醒。`
          }
        }

        if (intent.kind === 'schedule' && autoSchedule) {
          const { due, note } = resolveDue({ due: intent.due, repeat: intent.repeat }, text)
          const item = schedule.add({
            title: intent.title,
            due,
            repeat: intent.repeat,
            source: 'chat',
            sourceText: text,
          })
          syncHabits()
          pushLog({ at: Date.now(), dir: 'sys', rid, text: `自动识别日程：${item.title}` })
          return say(
            cfg,
            '确认你记下了一件事。必须保留事项名称和时间；如果没听出时间，用一句话说明你按无期限记了。',
            [
              `事项：${item.title}`,
              `时间：${item.due ? new Date(item.due).toLocaleString('zh-CN') : '无期限'}`,
              ...(note ? [`备注：${note}`] : []),
            ],
            formatAdded(item, note),
            rid,
          )
        }
      } catch (err) {
        pushLog({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `意图判断失败：${(err as Error)?.message ?? err}` })
      }
    }

    return null
  }

  async function generate(text: string, currentConfig: AppConfig, rid = '-'): Promise<ReplyOutcome> {
    // 有挂起的日报就先补发，再回当前这条
    if (currentConfig.memory.enabled) await flushPendingReport()
    const routes = chosenRoute ? [chosenRoute] : buildRoutes()
    const { history, facts, recall } = memoryContext(text)
    // 先落用户这条，再生成；history 是落之前取的，所以不会把当前这条算进去
    if (currentConfig.memory.enabled) {
      memory.append({ at: Date.now(), role: 'user', text, scope: 'chat' })
    }
    const result = await generateReply(options.llm, currentConfig, text, routes, { history, facts, recall })
    if (result.ok) {
      if (!chosenRoute || chosenRoute.provider !== result.provider || chosenRoute.model !== result.model) {
        chosenRoute = { provider: result.provider, model: result.model }
        const fallback = result.provider !== options.defaults.provider
        pushLog({
          at: Date.now(),
          dir: 'sys',
          text: `模型路由：${result.provider}/${result.model}${fallback ? '（默认路由不可用，已自动回退）' : ''}`,
        })
      }
    } else {
      pushLog({
        at: Date.now(),
        dir: 'sys',
        rid,
        level: 'warn',
        text: `模型调用失败（试过 ${routes.map((r) => `${r.provider}/${r.model}`).join('、')}）：${result.error ?? '未知'}`,
      })
    }
    if (result.ok) {
      recordUsage(rid, result, { provider: result.provider, model: result.model })
    }
    if (currentConfig.memory.enabled && result.ok) {
      memory.append({ at: Date.now(), role: 'assistant', text: result.text, scope: 'chat' })
    }
    return { text: result.text, ok: result.ok, error: result.error }
  }

  function ensureBridge(): void {
    if (bridge) return
    if (!creds) {
      status = { ...status, lastError: '还没有机器人账号，需要先扫码登录' }
      return
    }
    bridge = createBridge({
      creds,
      getConfig: () => config,
      onInbound: (text) => {
        if (!config.rhythm.enabled) return
        const now = Date.now()
        // “晚安 / 睡了”是明确的睡眠信号，比“最后一条消息”可靠
        if (/(晚安|睡了|睡觉了|去睡|先睡了|要睡了)/.test(text)) rhythm.recordSleep(now)
        else rhythm.record(now)
      },
      generate,
      quickReply,
      onMedia: handleMedia,
      escalate: options.escalate
        ? async (task, cfg, rid = '-') => {
            const recent = cfg.memory.enabled && cfg.escalation.carryMemory
              ? memory.recent(Math.min(cfg.memory.recentCount, 8), { scope: 'chat' }).map((entry) => ({ role: entry.role, text: entry.text }))
              : []
            const facts = cfg.memory.enabled && cfg.memory.injectFacts ? memory.facts().slice(0, cfg.memory.factsLimit) : ''
            const prompt = buildEscalationPrompt(cfg, { facts, recent, task })
            pushLog({
              at: Date.now(),
              dir: 'sys',
              rid,
              text: `后台上下文：人设${cfg.escalation.carryPersona ? '✓' : '✗'} 记忆${cfg.escalation.carryMemory ? '✓' : '✗'} 共 ${prompt.length} 字`,
            })
            const outcome = await options.escalate!(prompt, cfg)
            if (cfg.memory.enabled && outcome.text) {
              memory.append({ at: Date.now(), role: 'user', text: task, scope: 'agent' })
              memory.append({ at: Date.now(), role: 'assistant', text: outcome.text, scope: 'agent' })
            }
            return outcome
          }
        : undefined,
      log: pushLog,
      onStatus: (patch) => {
        status = { ...status, ...patch }
      },
    })
  }

  function start(): RuntimeStatus {
    ensureBridge()
    bridge?.start()
    return computeStatus()
  }

  function stop(): RuntimeStatus {
    bridge?.stop()
    return computeStatus()
  }

  function reloadCredentials(next?: Credentials | null): RuntimeStatus {
    const wasRunning = bridge?.running ?? false
    bridge?.stop()
    bridge = null
    creds = next === undefined ? loadCredentials() : next
    status = { ...status, accountId: creds?.accountId ?? '', lastError: '' }
    if (wasRunning) start()
    return computeStatus()
  }

  return {
    getConfig: () => config,

    usageInfo: () => {
      rollUsageDay()
      return { ...usageToday }
    },

    memoryInfo: () => {
      try {
        const facts = memory.facts()
        const recent = memory.recent(config.memory.recentCount, { scope: 'chat' })
        const chars = facts.length + recent.reduce((sum, entry) => sum + entry.text.length, 0)
        return {
          enabled: config.memory.enabled,
          facts: facts.slice(0, config.memory.factsLimit),
          factsChars: facts.length,
          recentCount: recent.length,
          approxExtraTokens: Math.round(chars / 1.6),
          dir: memory.dir,
        }
      } catch {
        return { enabled: false, facts: '', factsChars: 0, recentCount: 0, approxExtraTokens: 0, dir: '' }
      }
    },

    writeFacts: (text: string) => {
      memory.writeFacts(String(text ?? ''))
      return { ok: true }
    },

    paths: () => ({
      dataDir: homeDir(),
      configFile: filePath('config.json'),
      credentialsFile: filePath('credentials.json'),
    }),
    providers: readProviders,
    bestRoute,

    onboarding: () => ({ welcome: config.onboarding.welcome, sent: welcomeSent() }),
    resetOnboarding: () => {
      try {
        fs.rmSync(onboardedFile())
      } catch {
        /* ignore */
      }
      pushLog({ at: Date.now(), dir: 'sys', text: '已重置首次介绍，下次说话会重新发' })
      return { ok: true, sent: welcomeSent() }
    },

    habits: () => habits.list(),
    activities: () => ({ entries: activities.list().length, recent: activities.list().slice(-5) }),
    addHabit: (input: Parameters<typeof habits.add>[0]) => habits.add(input),
    updateHabit: (id: string, patch: Partial<Habit>) => habits.update(id, patch),
    removeHabit: (id: string) => habits.remove(id),
    syncHabits: () => {
      syncHabits()
      return habits.list()
    },
    rhythmProfile: () => {
      const profile = rhythmProfile()
      const day = profileForDay(profile)
      return {
        weekday: profile.weekday,
        weekend: profile.weekend,
        today: day,
        description: describeProfile(day),
        canGreet: canGreet(day, [0, 6].includes(new Date().getDay())),
        samples: day.wake?.samples ?? 0,
        file: rhythm.file,
      }
    },
    clearRhythm: () => {
      rhythm.clear()
      pushLog({ at: Date.now(), dir: 'sys', text: '作息样本已清空' })
      return { ok: true }
    },
    recordActivity: (at: number = Date.now()) => {
      if (!config.rhythm.enabled) return
      rhythm.record(at)
    },

    scheduleList: () => schedule.list(),
    scheduleAdd: (input: ScheduleInput) => schedule.add(input),
    scheduleUpdate: (id: string, patch: SchedulePatch) => schedule.update(id, patch),
    scheduleRemove: (id: string) => schedule.remove(id),
    scheduleDone: (id: string) => schedule.done(id),
    status: computeStatus,
    logs: () => logs.slice(-MAX_LOGS),

    updateConfig(patch: unknown): AppConfig {
      config = saveConfig(normalizeConfig({ ...config, ...(patch as object) }))
      chosenRoute = null
      pushLog({ at: Date.now(), dir: 'sys', text: '配置已更新' })
      return config
    },

    start,
    stop,
    reloadCredentials,

    saveNewCredentials(next: Credentials): RuntimeStatus {
      saveCredentials(next)
      return reloadCredentials(next)
    },

    clearLogs(): void {
      logs = []
    },

    quickReply,
    homeworkState: () => homeworkSession,
    runGreeting: (kind: 'morning' | 'evening') => sendGreeting(kind),
    runDigestNow,
    digestState: () => ({ running: digestRunning, pending: Boolean(readPendingReport()) }),

    dispose(): void {
      bridge?.stop()
      bridge = null
      if (digestTimer) {
        clearInterval(digestTimer)
        digestTimer = null
      }
      if (scheduleTimer) {
        clearInterval(scheduleTimer)
        scheduleTimer = null
      }
    },

    pushLog,
  }
}

export type Runtime = ReturnType<typeof createRuntime>
