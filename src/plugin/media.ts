import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { homeDir } from '../config.ts'

/**
 * iLink 的 aes_key 有两种编码，下载方必须都兼容：
 *   · base64(16 字节原始 key)
 *   · base64(32 位十六进制字符串)
 */
export function decodeAesKey(raw: string): Buffer | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let decoded: Buffer
  try {
    decoded = Buffer.from(trimmed, 'base64')
  } catch {
    return null
  }

  if (decoded.length === 16) return decoded

  // 32 位 hex 字符串被 base64 编码过一次
  const asText = decoded.toString('utf8')
  if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, 'hex')

  // 也兼容直接把 hex 传进来的情况
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')

  return null
}

/** AES-128-ECB 解密并去掉 PKCS7 填充 */
export function decryptEcb(cipher: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(cipher), decipher.final()])
}

/** 从文件头猜图片类型，避免只靠扩展名 */
export function sniffImageType(bytes: Buffer): { mediaType: string; ext: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: 'image/png', ext: 'png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', ext: 'jpg' }
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mediaType: 'image/webp', ext: 'webp' }
  }
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mediaType: 'image/gif', ext: 'gif' }
  }
  return null
}

/** 存到 ~/.dsh/mishu-fish/media/YYYY-MM/ 下，返回绝对路径 */
export function saveMedia(bytes: Buffer, ext: string, at: Date = new Date()): string {
  const dir = path.join(homeDir(), 'media', `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `${at.getTime()}-${crypto.randomBytes(3).toString('hex')}.${ext}`
  const file = path.join(dir, name)
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  return file
}
