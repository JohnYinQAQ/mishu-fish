import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ILinkError, assertOk, botHeaders, isSessionExpired, isTimeout, randomWechatUin, TimeoutError } from '../src/ilink/http.ts'

test('randomWechatUin: base64(十进制 uint32)，每次不同', () => {
  const values = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const uin = randomWechatUin()
    const decoded = Buffer.from(uin, 'base64').toString('utf8')
    assert.match(decoded, /^\d+$/)
    const n = Number(decoded)
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
    values.add(uin)
  }
  assert.ok(values.size > 40, '随机性不足')
})

test('botHeaders: 带齐 iLink 要求的头', () => {
  const headers = botHeaders('tok')
  assert.equal(headers.Authorization, 'Bearer tok')
  assert.equal(headers.AuthorizationType, 'ilink_bot_token')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.ok(headers['X-WECHAT-UIN'])
})

test('assertOk: ret=0 通过，ret=-14 判定为会话失效', () => {
  assert.doesNotThrow(() => assertOk({ ret: 0 }, 'x'))
  assert.doesNotThrow(() => assertOk({}, 'x'))

  assert.throws(
    () => assertOk({ ret: -14, errmsg: 'session timeout' }, '拉取消息'),
    (err: unknown) => err instanceof ILinkError && isSessionExpired(err),
  )
})

test('assertOk: 其它错误码也算失败', () => {
  assert.throws(
    () => assertOk({ ret: -2, errmsg: 'param error' }, '发送消息'),
    (err: unknown) => err instanceof ILinkError && !isSessionExpired(err) && /ret=-2/.test(err.message),
  )
})

test('isTimeout: 只认 TimeoutError', () => {
  assert.equal(isTimeout(new TimeoutError()), true)
  assert.equal(isTimeout(new Error('boom')), false)
})
