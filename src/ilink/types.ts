/** iLink Bot API 的数据结构（只声明 demo 用得到的那部分） */

export const ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const MESSAGE_TYPE = {
  /** 用户发来的消息 */
  USER: 1,
  /** 机器人发出的消息 */
  BOT: 2,
} as const

export const MESSAGE_STATE = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

export type ItemType = (typeof ITEM_TYPE)[keyof typeof ITEM_TYPE]

export interface TextItem {
  text?: string
}

export interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

export interface ImageItem {
  media?: CdnMedia
  thumb_media?: CdnMedia
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  hd_size?: number
}

export interface VoiceItem {
  media?: CdnMedia
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  /** 服务端已经转好的文字（iLink 自带 ASR，很省事） */
  text?: string
}

export interface FileItem {
  media?: CdnMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface VideoItem {
  media?: CdnMedia
  video_size?: number
  play_length?: number
  video_md5?: string
}

export interface RefMessage {
  title?: string
  message_item?: MessageItem
}

export interface MessageItem {
  type?: number
  msg_id?: string
  is_completed?: boolean
  create_time_ms?: number
  update_time_ms?: number
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  ref_msg?: RefMessage
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  /** 群会话 ID：协议里有，但公开实现基本只处理单聊 */
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  /** 回复时必须原样带回的会话上下文令牌 */
  context_token?: string
}

export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  /** 不透明游标，原样保存，不要解码 */
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface BaseInfo {
  channel_version: string
  bot_agent?: string
}

/** 扫码登录成功后要持久化的东西 */
export interface Credentials {
  /** Bearer token */
  token: string
  /** 业务基座地址（以登录返回的为准） */
  baseUrl: string
  /** ilink_bot_id，形如 xxx@im.bot */
  accountId: string
  /** ilink_user_id，形如 xxx@im.wechat，也就是扫码授权的那个微信号 */
  userId: string
  savedAt: string
}

export interface QrTicket {
  qrcode: string
  /** 二维码的内容（一段 URL），需要我们自己渲染成二维码图片 */
  qrcodeImgContent: string
}

export type QrStatus =
  | { status: 'wait' }
  | { status: 'scaned' }
  | { status: 'expired' }
  | {
      status: 'confirmed'
      botToken: string
      botId: string
      userId: string
      baseUrl: string
    }
