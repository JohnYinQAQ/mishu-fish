import { sendText } from '../ilink/bot.ts'
import { fail, info, ok, warn } from '../log.ts'
import { loadCredentials, loadState } from '../store.ts'

/**
 * 主动发一条消息。
 *
 * 注意：iLink 没有「打开会话」的接口，只能复用最近一次入站消息带来的 context_token。
 * 所以这个命令能验证的正是「主动消息」这条路：token 还在不在、能活多久。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let to = ''
  let text = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--to') to = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: mishu send "要说的话" [--to <userId>]')
      process.exit(0)
    } else if (!text) text = arg
  }

  if (!text.trim()) {
    fail('没有要发送的内容。用法: ./bin/mishu send "hello world"')
    process.exitCode = 1
    return
  }

  const creds = loadCredentials()
  if (!creds) {
    fail('还没有机器人账号。先运行：./bin/mishu login')
    process.exitCode = 1
    return
  }

  const state = loadState()
  const entries = Object.entries(state.contextTokens)
  if (entries.length === 0) {
    fail('还没有可用的会话令牌：需要先有人给机器人发过一条消息')
    process.exitCode = 1
    return
  }

  // 默认发给授权微信本人；没有就取最近一次会话
  let target = to
  if (!target) {
    target = entries.some(([id]) => id === creds.userId)
      ? creds.userId
      : entries.sort((a, b) => b[1].at - a[1].at)[0][0]
  }

  const entry = state.contextTokens[target]
  if (!entry) {
    fail(`没有 ${target} 的会话令牌。可用的人：${entries.map(([id]) => id).join(', ')}`)
    process.exitCode = 1
    return
  }

  const ageMin = Math.round((Date.now() - entry.at) / 60000)
  info(`目标 ${target}`)
  info(`context_token 来自 ${ageMin} 分钟前的入站消息`)

  const parts = await sendText(creds, target, entry.token, text)
  ok(`已发出 ${parts} 条`)
}

main().catch((err: unknown) => {
  const message = (err as Error)?.message ?? String(err)
  fail(`发送失败：${message}`)
  if (/context_token/.test(message)) warn('会话令牌可能已失效，让对方先给机器人发一条消息再试')
  process.exitCode = 1
})
