import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { decodeAesKey, decryptEcb, saveMedia, sniffImageType } from '../src/plugin/media.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-media-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

const KEY = crypto.randomBytes(16)

test('decodeAesKey：base64(16 字节) 和 base64(32 位 hex) 都认', () => {
  const raw = KEY.toString('base64')
  assert.deepEqual(decodeAesKey(raw), KEY)

  const hexEncodedTwice = Buffer.from(KEY.toString('hex'), 'utf8').toString('base64')
  assert.deepEqual(decodeAesKey(hexEncodedTwice), KEY)

  assert.deepEqual(decodeAesKey(KEY.toString('hex')), KEY)
  assert.equal(decodeAesKey(''), null)
  assert.equal(decodeAesKey('这不是密钥'), null)
})

test('decryptEcb：解出来和原文一致', () => {
  const plain = Buffer.from('这是一张图片的字节'.repeat(10), 'utf8')
  const cipher = encrypt(plain, KEY)
  assert.deepEqual(decryptEcb(cipher, KEY), plain)
})

test('sniffImageType：按文件头判断类型', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(sniffImageType(png)?.mediaType, 'image/png')

  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
  assert.equal(sniffImageType(jpg)?.ext, 'jpg')

  assert.equal(sniffImageType(Buffer.from('not an image')), null)
})

test('saveMedia：写进 media/YYYY-MM 并返回路径', () => {
  const file = saveMedia(Buffer.from('abc'), 'png', new Date(2026, 10, 14))
  assert.ok(fs.existsSync(file))
  assert.match(file, /media\/2026-11\//)
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc')
})

test('downloadImage：从 URL 拉密文、解密、落盘', async () => {
  const { downloadImage } = await import('../src/plugin/media.ts')
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake png body'.repeat(8), 'utf8'),
  ])
  const cipher = encrypt(png, KEY)
  const dataUrl = `data:application/octet-stream;base64,${cipher.toString('base64')}`

  const result = await downloadImage(dataUrl, KEY.toString('hex'))
  assert.equal(result.mediaType, 'image/png')
  assert.ok(fs.existsSync(result.file))
  assert.deepEqual(fs.readFileSync(result.file), png)
})

test('downloadImage：密钥不对时报错，不会写出坏文件', async () => {
  const { downloadImage } = await import('../src/plugin/media.ts')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const cipher = encrypt(png, KEY)
  const dataUrl = `data:application/octet-stream;base64,${cipher.toString('base64')}`

  await assert.rejects(downloadImage(dataUrl, crypto.randomBytes(16).toString('hex')), /解密|图片/)
})
