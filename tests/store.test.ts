import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  emptyState,
  loadCredentials,
  loadState,
  maskToken,
  rememberMessage,
  saveCredentials,
  saveState,
  credentialsFile,
} from '../src/store.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-test-'))
  process.env.MISHU_HOME = dir
})

afterEach(() => {
  delete process.env.MISHU_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

const creds = {
  token: 'ilinkbot_test_token_value',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  accountId: 'abc@im.bot',
  userId: 'u@im.wechat',
  savedAt: '2026-10-27T00:00:00.000Z',
}

test('凭据写入/读出，文件权限 0600', () => {
  saveCredentials(creds)
  const file = credentialsFile()
  assert.ok(fs.existsSync(file))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(loadCredentials(), creds)
})

test('没有凭据时返回 null', () => {
  assert.equal(loadCredentials(), null)
})

test('凭据文件损坏时报出可操作的错误', () => {
  saveCredentials(creds)
  fs.writeFileSync(credentialsFile(), '{ 不是 json')
  assert.throws(() => loadCredentials(), /重新登录/)
})

test('状态写入/读出并保留游标与会话令牌', () => {
  const state = emptyState()
  state.getUpdatesBuf = 'opaque-cursor'
  state.contextTokens['u@im.wechat'] = { token: 'ctx', at: 123 }
  saveState(state)

  const loaded = loadState()
  assert.equal(loaded.getUpdatesBuf, 'opaque-cursor')
  assert.equal(loaded.contextTokens['u@im.wechat']?.token, 'ctx')
})

test('rememberMessage 去重且不无限增长', () => {
  const state = emptyState()
  assert.equal(rememberMessage(state, 'm:1'), true)
  assert.equal(rememberMessage(state, 'm:1'), false)
  for (let i = 0; i < 300; i++) rememberMessage(state, `m:${i}`)
  assert.ok(state.seen.length <= 200)
  // 最近的消息仍在记录里
  assert.equal(state.seen.at(-1), 'm:299')
})

test('maskToken 不泄漏完整 token', () => {
  const masked = maskToken(creds.token)
  assert.equal(masked.includes(creds.token), false)
  assert.ok(masked.includes('…'))
  assert.equal(maskToken(''), '(空)')
})
