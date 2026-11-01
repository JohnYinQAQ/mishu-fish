import fs from 'node:fs'
import { credentialsFile, dataDir, loadCredentials, loadState, maskToken, stateFile } from '../store.ts'
import { fail, info, warn } from '../log.ts'

function perms(file: string): string {
  try {
    return `0o${(fs.statSync(file).mode & 0o777).toString(8)}`
  } catch {
    return '(不存在)'
  }
}

function main(): void {
  console.log('')
  console.log('  秘书鱼 · 状态')
  console.log('  ─────────────────────────')
  console.log(`  数据目录: ${dataDir()}`)

  const creds = loadCredentials()
  if (!creds) {
    warn('还没有机器人账号')
    console.log('  下一步: ./bin/mishu login')
    return
  }

  console.log('')
  console.log(`  机器人 ID : ${creds.accountId}`)
  console.log(`  授权微信  : ${creds.userId || '(未返回)'}`)
  console.log(`  业务地址  : ${creds.baseUrl}`)
  console.log(`  token     : ${maskToken(creds.token)}`)
  console.log(`  登录时间  : ${creds.savedAt || '(未知)'}`)
  console.log(`  凭据文件  : ${credentialsFile()} ${perms(credentialsFile())}`)

  const state = loadState()
  console.log('')
  console.log(`  游标      : ${state.getUpdatesBuf ? `${state.getUpdatesBuf.length} 字符` : '(空，下次从最新开始)'}`)
  console.log(`  状态更新  : ${state.updatedAt}`)
  console.log(`  会话令牌  : ${Object.keys(state.contextTokens).length} 个用户`)
  console.log(`  去重记录  : ${state.seen.length} 条`)

  for (const [userId, entry] of Object.entries(state.contextTokens)) {
    const age = Math.round((Date.now() - entry.at) / 60000)
    console.log(`    · ${userId}   ${age} 分钟前`)
  }

  console.log('')
  console.log(`  状态文件  : ${stateFile()} ${perms(stateFile())}`)
  if (perms(credentialsFile()) !== '0o600') fail('凭据文件权限不是 0600，建议 chmod 600')
}

main()
