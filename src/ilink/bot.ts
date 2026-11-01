import crypto from 'node:crypto'
import { CHANNEL_VERSION, LONG_POLL_TIMEOUT_MS } from '../config.ts'
import { assertOk, postBot, sleep } from './http.ts'
import type { Credentials, GetUpdatesResponse } from './types.ts'
import { chunkText } from '../text.ts'

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: 'mishu-fish/0.1.0' }
}

/** 拉取新消息。长轮询：没有消息时会在服务端挂住几十秒。 */
export async function getUpdates(
  creds: Credentials,
  getUpdatesBuf: string,
  timeoutMs: number = LONG_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResponse> {
  const json = await postBot<GetUpdatesResponse>(
    `${creds.baseUrl}/ilink/bot/getupdates`,
    { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
    creds.token,
    { timeoutMs },
  )
  assertOk(json, '拉取消息')
  return json
}

function newClientId(): string {
  return `mishu-fish:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * 回复一条文本。超过 2000 字符会自动分片，每片独立 client_id、复用同一个 context_token。
 * 注意：context_token 是会话锚点，没有它发不出去。
 */
export async function sendText(
  creds: Credentials,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<number> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return 0
  if (!contextToken) throw new Error('缺少 context_token：只能回复最近给你发过消息的人')

  for (let i = 0; i < chunks.length; i++) {
    const json = await postBot<{ ret?: number; errcode?: number; errmsg?: string }>(
      `${creds.baseUrl}/ilink/bot/sendmessage`,
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: newClientId(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunks[i] } }],
        },
        base_info: baseInfo(),
      },
      creds.token,
    )
    assertOk(json, '发送消息')
    // 多片之间稍微留点间隔，避免被当成刷屏
    if (i < chunks.length - 1) await sleep(300)
  }
  return chunks.length
}

interface TypingCacheEntry {
  ticket: string
  at: number
}

const TYPING_TTL_MS = 20 * 60_000
const typingCache = new Map<string, TypingCacheEntry>()

async function typingTicket(creds: Credentials, userId: string, contextToken: string): Promise<string> {
  const cached = typingCache.get(userId)
  if (cached && Date.now() - cached.at < TYPING_TTL_MS) return cached.ticket

  const json = await postBot<{ ret?: number; errcode?: number; errmsg?: string; typing_ticket?: string }>(
    `${creds.baseUrl}/ilink/bot/getconfig`,
    { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
    creds.token,
  )
  assertOk(json, '获取 typing 票据')
  if (!json.typing_ticket) throw new Error('getconfig 没有返回 typing_ticket')
  typingCache.set(userId, { ticket: json.typing_ticket, at: Date.now() })
  return json.typing_ticket
}

/** 「对方正在输入…」。失败不影响正常回复，调用方自行 catch。 */
export async function sendTyping(
  creds: Credentials,
  userId: string,
  contextToken: string,
  typing: boolean,
): Promise<void> {
  const ticket = await typingTicket(creds, userId, contextToken)
  const json = await postBot<{ ret?: number; errcode?: number; errmsg?: string }>(
    `${creds.baseUrl}/ilink/bot/sendtyping`,
    {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: typing ? 1 : 2,
      base_info: baseInfo(),
    },
    creds.token,
  )
  assertOk(json, '发送 typing 状态')
}
