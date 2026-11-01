import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, describeNonText, isFromUser, isGroupMessage, messageKey, textOf } from '../src/text.ts'
import type { WeixinMessage } from '../src/ilink/types.ts'

test('chunkText: 短文本原样返回', () => {
  assert.deepEqual(chunkText('你好呀'), ['你好呀'])
})

test('chunkText: 空文本返回空数组', () => {
  assert.deepEqual(chunkText('   \n '), [])
})

test('chunkText: 按空行切分且每片不超限', () => {
  const paragraph = '这是一段比较长的内容。'.repeat(20)
  const text = Array.from({ length: 12 }, () => paragraph).join('\n\n')
  const chunks = chunkText(text, 500)

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok([...chunk].length <= 500, `分片超长: ${[...chunk].length}`)
    assert.ok(chunk.trim().length > 0)
  }
  // 内容不丢：去掉空白后应能拼回原文
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})

test('chunkText: 不会切断 emoji', () => {
  const text = '🐟'.repeat(3000)
  const chunks = chunkText(text, 1000)
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  for (const chunk of chunks) {
    assert.equal(loneSurrogate.test(chunk), false)
    assert.ok([...chunk].length <= 1000)
  }
  assert.equal(chunks.join(''), text)
})

test('chunkText: 没有换行和空格时硬切', () => {
  const chunks = chunkText('x'.repeat(2500), 2000)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 2000)
  assert.equal(chunks[1].length, 500)
})

test('textOf: 拼接多个 text item 并 trim', () => {
  const msg: WeixinMessage = {
    item_list: [{ type: 1, text_item: { text: '第一行' } }, { type: 1, text_item: { text: '第二行 ' } }],
  }
  assert.equal(textOf(msg), '第一行\n第二行')
})

test('isFromUser: 过滤机器人自己发的消息和别人的消息', () => {
  assert.equal(isFromUser({ message_type: 1, to_user_id: 'bot@im.bot' }, 'bot@im.bot'), true)
  assert.equal(isFromUser({ message_type: 2, to_user_id: 'bot@im.bot' }, 'bot@im.bot'), false)
  assert.equal(isFromUser({ message_type: 1, to_user_id: 'other@im.bot' }, 'bot@im.bot'), false)
})

test('isGroupMessage / messageKey', () => {
  assert.equal(isGroupMessage({ group_id: 'g1' }), true)
  assert.equal(isGroupMessage({}), false)
  assert.equal(messageKey({ message_id: 42 }), 'm:42')
  assert.equal(messageKey({ client_id: 'abc' }), 'c:abc')
  assert.equal(messageKey({ session_id: 's1', create_time_ms: 9 }), 's:s1:9')
})

test('describeNonText: 语音消息带出转写文字', () => {
  const msg: WeixinMessage = {
    item_list: [{ type: 3, voice_item: { text: '我下午三点到', playtime: 4200 } }],
  }
  assert.match(describeNonText(msg), /语音转文字：我下午三点到/)
})
