import { getUpdates, sendText, sendTyping } from '../ilink/bot.ts'
import { ILinkError, isSessionExpired, isTimeout, sleep } from '../ilink/http.ts'
import { describeNonText, isFromUser, isGroupMessage, messageKey, textOf } from '../text.ts'
import { dumpInbound } from './media.ts'
import { loadState, rememberMessage, saveState } from '../store.ts'
import type { State } from '../store.ts'
import type { Credentials, WeixinMessage } from '../ilink/types.ts'
import type { LogEntry, LogLevel } from './logger.ts'
import type { AppConfig } from './config.ts'
import { inQuietHours } from './persona.ts'

export type { LogEntry, LogLevel } from './logger.ts'

export interface BridgeStatus {
  running: boolean
  accountId: string
  lastError: string
  lastMessageAt: number | null
  lastReplyAt: number | null
  tokenAgeMin: number | null
  windowLeftMin: number | null
  handled: number
  startedAt: number | null
}

export interface ReplyOutcome {
  text: string
  ok: boolean
  error?: string
}

export interface BridgeDeps {
  creds: Credentials
  getConfig: () => AppConfig
  /** 生成回复；由插件接到 ctx.llm */
  generate: (text: string, config: AppConfig, rid: string) => Promise<ReplyOutcome>
  /** !dsh 前缀：把任务交给 DSH 的 agent，拿它的最终回答 */
  escalate?: (task: string, config: AppConfig, rid: string) => Promise<ReplyOutcome>
  /** 日程这类确定性指令：命中就返回一句话，不经过聊天模型 */
  quickReply?: (text: string, config: AppConfig, rid: string) => Promise<string | null>
  /** 每条入站消息都会调一次（作息采样用） */
  onInbound?: (text: string, rid: string) => void
  /** 收到图片/文件时调用；返回要回给他的话，null 表示回兜底话术 */
  onMedia?: (msg: unknown, rid: string) => Promise<string | null>
  log: (entry: LogEntry) => void
  onStatus: (patch: Partial<BridgeStatus>) => void
  /** 测试注入点 */
  api?: {
    getUpdates: typeof getUpdates
    sendText: typeof sendText
    sendTyping: typeof sendTyping
  }
  now?: () => number
}

export interface Bridge {
  start: () => void
  stop: () => void
  readonly running: boolean
}

/** 24 小时会话窗口：iLink 回复必须带最近一条入站消息的 context_token */
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

function shortId(id: string): string {
  return id.includes('@') ? id.split('@')[0].slice(0, 10) : id.slice(0, 10)
}

/**
 * 微信 ↔ 模型的桥。
 *
 * 只做四件事：拉消息、去重、按配置决定回不回、把回复发回去。
 * 所有外部依赖都从 deps 进来，所以测试里可以完全不碰网络。
 */
export function createBridge(deps: BridgeDeps): Bridge {
  const api = deps.api ?? { getUpdates, sendText, sendTyping }
  const now = deps.now ?? (() => Date.now())

  let stopped = true
  let running = false
  let loop: Promise<void> | null = null
  const recentReplies: number[] = []
  const state: State = loadState()

  function rememberToken(userId: string, token: string): void {
    if (!token) return
    state.contextTokens[userId] = { token, at: now() }
  }

  function throttled(): boolean {
    const limit = deps.getConfig().behavior.perMinute
    const cutoff = now() - 60_000
    while (recentReplies.length > 0 && recentReplies[0] < cutoff) recentReplies.shift()
    return recentReplies.length >= limit
  }

  async function handle(msg: WeixinMessage, config: AppConfig): Promise<void> {
    if (!isFromUser(msg, deps.creds.accountId)) return

    // 一条消息一个短 id：它的收到 / 模型调用 / 回复 / 记忆写入共用，排查时一搜就是完整链路
    const rid = Math.random().toString(36).slice(2, 8)
    try {
      deps.onInbound?.(textOf(msg) || '', rid)
    } catch {
      /* 采样失败不影响主流程 */
    }

    const key = messageKey(msg)
    if (!rememberMessage(state, key)) {
      deps.log({ at: now(), dir: 'sys', text: `重复消息已忽略 ${key}`, rid })
      return
    }

    if (isGroupMessage(msg)) {
      deps.log({ at: now(), dir: 'sys', text: '群消息：iLink 不支持群聊，已跳过', rid })
      saveState(state)
      return
    }

    const userId = msg.from_user_id ?? ''
    if (!userId) return

    const contextToken = msg.context_token ?? ''
    if (contextToken) rememberToken(userId, contextToken)

    const text = textOf(msg) || msg.item_list?.find((item) => item.voice_item?.text)?.voice_item?.text || ''
    const display = text || describeNonText(msg)

    deps.log({ at: now(), dir: 'in', text: display, meta: shortId(userId), rid })
    deps.onStatus({ lastMessageAt: now() })

    if (!contextToken) {
      deps.log({ at: now(), dir: 'sys', level: 'warn', text: '这条消息没带 context_token，无法回复', rid })
      return
    }

    if (!config.enabled) {
      deps.log({ at: now(), dir: 'sys', text: '总开关关闭，未回复', rid })
      saveState(state)
      return
    }

    if (inQuietHours(config, new Date(now()))) {
      deps.log({ at: now(), dir: 'sys', text: '免打扰时段，未回复', rid })
      saveState(state)
      return
    }

    if (!config.behavior.replyToAll) {
      deps.log({ at: now(), dir: 'sys', text: '当前是「被叫才回」模式，未回复', rid })
      saveState(state)
      return
    }

    if (throttled()) {
      deps.log({ at: now(), dir: 'sys', level: 'warn', text: '超过每分钟上限，未回复', rid })
      saveState(state)
      return
    }

    let reply: string
    const prefix = config.escalation.prefix
    const escalating = config.escalation.enabled && Boolean(prefix) && text.startsWith(prefix)

    // 确定性指令（记一下 / 今天有什么 / 报告交了）优先，命中就不调聊天模型
    const quick = text && deps.quickReply ? await deps.quickReply(text, config, rid) : null

    if (quick !== null) {
      reply = quick
    } else if (!text) {
      let handled: string | null = null
      if (deps.onMedia) {
        try {
          handled = await deps.onMedia(msg, rid)
        } catch (err) {
          deps.log({ at: Date.now(), dir: 'sys', level: 'warn', rid, text: `媒体处理失败：${String((err as Error)?.message ?? err)}` })
        }
      }

      if (handled) {
        reply = handled
      } else {
      // 暂时还看不了图片/文件：把完整结构写到文件里，方便做媒体下载
      const dumped = dumpInbound(deps, msg, rid)
      deps.log({
        at: Date.now(),
        dir: 'sys',
        level: 'warn',
        rid,
        text: `收到非文本消息：${describeNonText(msg)}${dumped ? `｜完整结构已写到 ${dumped}` : ''}`,
      })
      reply = '我暂时只能看文字，图片和文件还接不了。'
      }
    } else {
      try {
        await api.sendTyping(deps.creds, userId, contextToken, true)
      } catch {
        /* typing 只是锦上添花 */
      }

      if (escalating) {
        const task = text.slice(prefix.length).trim()
        deps.log({ at: now(), dir: 'sys', text: `转给 DSH agent：${task.slice(0, 40) || '(空)'}`, rid })
        if (!task) {
          reply = '要在 DSH 里做什么？把任务写在 !dsh 后面。'
        } else if (!deps.escalate) {
          reply = '这条通道还没接上 agent。'
        } else {
          try {
            const outcome = await deps.escalate(task, config, rid)
            if (!outcome.ok) {
              deps.log({ at: now(), dir: 'sys', level: 'warn', text: `agent 失败：${outcome.error ?? '未知'}`, rid })
            }
            reply = outcome.text
          } catch (err) {
            const message = (err as Error)?.message ?? String(err)
            deps.log({ at: now(), dir: 'sys', level: 'error', text: `agent 异常：${message}`, rid })
            reply = `刚才那件事没做成：${message.slice(0, 120)}`
          }
        }
      } else {
        const outcome = await deps.generate(text, config, rid)
        if (!outcome.ok) {
          deps.log({ at: now(), dir: 'sys', level: 'warn', text: `模型失败：${outcome.error ?? '未知'}`, meta: 'fallback', rid })
        }
        reply = outcome.text
      }
    }

    try {
      await api.sendText(deps.creds, userId, contextToken, reply)
      recentReplies.push(now())
      deps.log({ at: now(), dir: 'out', text: reply, rid })
      deps.onStatus({ lastReplyAt: now(), handled: 1 })
    } catch (err) {
      deps.log({ at: now(), dir: 'sys', level: 'error', text: `发送失败：${(err as Error).message}`, rid })
      deps.onStatus({ lastError: (err as Error).message })
    } finally {
      try {
        await api.sendTyping(deps.creds, userId, contextToken, false)
      } catch {
        /* ignore */
      }
      saveState(state)
    }
  }

  /** 一轮轮询如果几乎瞬间返回，就补足到 250ms，避免热循环把 CPU 和对方接口打满 */
  async function coolDown(startedAt: number): Promise<void> {
    const elapsed = now() - startedAt
    if (elapsed < 250) await sleep(250 - elapsed)
  }

  async function run(): Promise<void> {
    running = true
    deps.onStatus({ running: true, startedAt: now(), lastError: '' })
    deps.log({ at: now(), dir: 'sys', text: '长轮询已启动' })

    let backoff = 2000
    let recoveredCursor = false
    while (!stopped) {
      const pollStartedAt = now()
      try {
        const res = await api.getUpdates(deps.creds, state.getUpdatesBuf)
        backoff = 2000
        if (res.get_updates_buf) {
          state.getUpdatesBuf = res.get_updates_buf
          saveState(state)
        }
        for (const msg of res.msgs ?? []) {
          if (stopped) break
          await handle(msg, deps.getConfig())
        }
        await coolDown(pollStartedAt)
      } catch (err) {
        if (isSessionExpired(err)) {
          deps.log({ at: now(), dir: 'sys', level: 'error', text: '会话失效（ret=-14），需要重新扫码登录' })
          deps.onStatus({ lastError: '会话失效，需要重新扫码', running: false })
          break
        }
        if (isTimeout(err)) {
          // 空轮询没有成本，但服务端如果立刻返回就不能热循环：至少让出 250ms
          await coolDown(pollStartedAt)
          continue
        }
        // 游标失效（ret=-1）：服务端不认这个 buf，重置成空串从最新重新开始。
        // 每个进程只自动恢复一次，避免服务端持续报错时来回刷。
        if (!recoveredCursor && state.getUpdatesBuf && err instanceof ILinkError && err.ret === -1) {
          recoveredCursor = true
          deps.log({ at: now(), dir: 'sys', level: 'warn', text: '游标失效（ret=-1），已重置游标，从最新消息重新开始' })
          state.getUpdatesBuf = ''
          saveState(state)
          await coolDown(pollStartedAt)
          continue
        }
        const message = (err as Error)?.message ?? String(err)
        deps.log({ at: now(), dir: 'sys', level: 'warn', text: `拉取失败：${message}，${Math.round(backoff / 1000)} 秒后重试` })
        deps.onStatus({ lastError: message })
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    running = false
    deps.onStatus({ running: false })
    deps.log({ at: now(), dir: 'sys', text: '长轮询已停止' })
    saveState(state)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      loop = run().catch((err) => {
        deps.log({ at: now(), dir: 'sys', level: 'error', text: `桥接异常退出：${(err as Error).message}` })
        running = false
        deps.onStatus({ running: false, lastError: (err as Error).message })
      })
    },
    stop() {
      stopped = true
      // 不 await：调用方（插件卸载）是同步钩子；游标已即时落盘，中途退出不丢消息
      void loop
    },
    get running() {
      return running
    },
  }
}

export function tokenAgeMinutes(state: State, userId: string, at: number = Date.now()): number | null {
  const entry = state.contextTokens[userId]
  if (!entry) return null
  return Math.round((at - entry.at) / 60000)
}
