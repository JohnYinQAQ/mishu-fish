import os from 'node:os'
import path from 'node:path'

/** 应用名：同时也是 ~/.dsh 下的目录名 */
export const APP_NAME = 'mishu-fish'

/** iLink 业务基座（登录返回的 baseurl 可能不同，以服务端返回为准） */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 媒体 CDN（demo 暂未用到，先留着） */
export const DEFAULT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/**
 * 随请求上报的通道版本号。协议里叫 channel_version / iLink-App-ClientVersion。
 * 保持与官方 openclaw 实现接近的值，便于服务端做兼容。
 */
export const CHANNEL_VERSION = '1.0.0'
export const APP_CLIENT_VERSION = '1'

/** 单条文本上限：协议没有公开常量，社区实现以 2000 字符为保守上限 */
export const MAX_TEXT_LENGTH = 2000

/** getupdates 是长轮询，服务端窗口约 35s；客户端给 45s 留余量 */
export const LONG_POLL_TIMEOUT_MS = 45_000

/** 扫码状态轮询同样是长轮询 */
export const QR_POLL_TIMEOUT_MS = 45_000

/**
 * 数据目录。默认 ~/.dsh/mishu-fish，可用 MISHU_HOME 覆盖（测试用）。
 * 用函数而不是常量：测试里改环境变量后能立刻生效。
 */
export function homeDir(): string {
  return process.env.MISHU_HOME || path.join(os.homedir(), '.dsh', APP_NAME)
}

export type DataFile = 'credentials.json' | 'state.json' | 'qrcode.png' | 'mishu.log' | 'config.json'

export function filePath(name: DataFile): string {
  return path.join(homeDir(), name)
}
