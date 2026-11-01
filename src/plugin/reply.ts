import type { AppConfig } from './config.ts'
import { buildMergedMessages, buildSystemPrompt, buildUserMessages, stripMarkdown } from './persona.ts'
import type { ChatMessage } from './persona.ts'

/** 只声明我们用到的那一小部分 ctx.llm */
export interface LlmService {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
  listProviders?(): unknown
}

export interface Route {
  provider: string
  model: string
}

export interface ReplyUsage {
  input: number
  output: number
}

export interface ReplyResult {
  text: string
  ok: boolean
  error?: string
  provider: string
  model: string
  usage?: ReplyUsage
}

const REPLY_TIMEOUT_MS = 40_000

/** 从流里的一句 chunk 取文本增量；不同适配器的字段略有差异，这里都兼容 */
export function extractDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return ''
  const value = chunk as Record<string, unknown>
  const kind = value.kind ?? value.type
  if (kind !== 'text-delta' && kind !== 'text' && kind !== 'content-delta') return ''
  for (const key of ['delta', 'text', 'content', 'value']) {
    const candidate = value[key]
    if (typeof candidate === 'string') return candidate
    if (candidate && typeof candidate === 'object') {
      const nested = (candidate as Record<string, unknown>).text
      if (typeof nested === 'string') return nested
    }
  }
  return ''
}

/** 终止 chunk 里的失败信息 */
function describeFailure(failure: unknown): string {
  const value = (failure ?? {}) as Record<string, unknown>
  const code = typeof value.code === 'string' ? value.code : ''
  const message = typeof value.message === 'string' ? value.message : ''
  return [code, message].filter(Boolean).join(': ') || '模型调用失败'
}

/**
 * iLink 之外的第二个协议坑：失败是包在 `{ type:'finish', reason:{ kind:'error', failure } }`
 * 里的，不是顶层的 kind:'error'。两种都认。
 */
export function extractFailure(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== 'object') return null
  const value = chunk as Record<string, unknown>
  const type = value.type ?? value.kind

  if (type === 'finish') {
    const reason = (value.reason ?? {}) as Record<string, unknown>
    const kind = typeof reason.kind === 'string' ? reason.kind : ''
    if (kind === 'error') return describeFailure(reason.failure)
    if (kind === 'aborted') return 'aborted'
    return null
  }

  if (type === 'error') return describeFailure(value.failure)
  if (type === 'aborted') return 'aborted'
  return null
}

export function resolveRoute(config: AppConfig, defaults: Route): Route {
  const useManual = config.model.mode === 'manual' && config.model.provider.trim() !== ''
  return useManual
    ? { provider: config.model.provider.trim(), model: config.model.model.trim() || defaults.model }
    : defaults
}

async function runStream(
  llm: LlmService,
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: ReplyUsage }> {
  let text = ''
  const signals: AbortSignal[] = [AbortSignal.timeout(REPLY_TIMEOUT_MS)]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)

  const stream = llm.stream({ ...options, signal: combined })
  const seen: string[] = []
  let usage: ReplyUsage | undefined
  for await (const chunk of stream) {
    const failure = extractFailure(chunk)
    if (failure) throw new Error(failure)
    if (seen.length < 8) {
      const value = (chunk ?? {}) as Record<string, unknown>
      seen.push(String(value.type ?? value.kind ?? '?') + (value.blockType ? `:${value.blockType}` : ''))
    }
    // usage 只在末尾出现一次；取最后一次，不做累加（避免重复计）
    const value = (chunk ?? {}) as Record<string, unknown>
    if (value.type === 'usage' && value.usage && typeof value.usage === 'object') {
      const raw = value.usage as Record<string, unknown>
      const input = Number(raw.inputTokens ?? 0)
      const output = Number(raw.outputTokens ?? 0)
      if (Number.isFinite(input) || Number.isFinite(output)) usage = { input, output }
    }
    text += extractDelta(chunk)
  }
  const trimmed = text.trim()
  // 空回复要把收到的 chunk 类型写进错误里，否则只能看到「模型返回了空内容」，无从下手
  if (!trimmed) throw new Error(`模型没有返回文本（chunk: ${seen.length ? seen.join(', ') : '零个'}）`)
  return { text: trimmed, usage }
}

/**
 * 生成一条回复。
 *
 * 失败策略分两层：
 *   1. 先用 system + user 的标准形态；
 *   2. 失败就退回「把提示词并进 user」的兼容形态，并去掉额外参数。
 * 两次都失败才返回兜底话术，错误码留给设置页显示——不静默。
 */
export async function generateReply(
  llm: LlmService,
  config: AppConfig,
  userText: string,
  routes: Route | Route[],
  options: { history?: ChatMessage[]; facts?: string; recall?: string; signal?: AbortSignal } = {},
): Promise<ReplyResult> {
  const { history = [], facts, recall, signal } = options
  // 允许传单条路由（老调用）或多条候选：按顺序试，第一条成功的就用它，
  // 这样「继承 DSH 默认」在默认路由缺 key 时会自动落到可用的账号路由上。
  const candidates = (Array.isArray(routes) ? routes : [routes]).filter(
    (route) => route && route.provider && route.model,
  )
  if (candidates.length === 0) {
    return { text: config.behavior.fallback, ok: false, error: '没有可用的模型路由', provider: '', model: '' }
  }

  const attempts: Array<{ messages: unknown; system?: string; extra: Record<string, unknown> }> = [
    {
      system: buildSystemPrompt(config, facts, recall),
      messages: [...history, ...buildUserMessages(userText)],
      extra: { temperature: config.model.temperature, maxTokens: config.model.maxTokens },
    },
    {
      messages: buildMergedMessages(config, userText, history, facts, recall),
      extra: {},
    },
  ]

  let lastError = ''
  let lastRoute = candidates[0]
  for (const route of candidates) {
    lastRoute = route
    for (const attempt of attempts) {
      try {
        const options: Record<string, unknown> = {
          provider: route.provider,
          model: route.model,
          ...attempt.extra,
          messages: attempt.messages,
        }
        if (attempt.system) options.system = attempt.system
        const { text: raw, usage } = await runStream(llm, options, signal)
        const text = config.style.markdown ? raw : stripMarkdown(raw)
        return { text, ok: true, provider: route.provider, model: route.model, usage }
      } catch (err) {
        lastError = (err as Error)?.message ?? String(err)
        if (signal?.aborted) break
      }
    }
    if (signal?.aborted) break
  }

  return {
    text: config.behavior.fallback,
    ok: false,
    error: lastError || '未知错误',
    provider: lastRoute.provider,
    model: lastRoute.model,
  }
}
