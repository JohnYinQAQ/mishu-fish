import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { appendLine, createLogger, levelOf, rotateIfNeeded, withinLevel } from '../src/plugin/logger.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mishu-log-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createLogger: 人读一行 + 机器读 JSONL 双写', () => {
  const file = path.join(dir, 'mishu.log')
  const logger = createLogger(file)

  logger.write({ at: Date.now(), dir: 'in', text: '你好', rid: 'abc123' })
  logger.write({
    at: Date.now(),
    dir: 'sys',
    level: 'warn',
    text: '模型用量',
    rid: 'abc123',
    usage: { input: 100, output: 20 },
  })

  const human = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(human.length, 2)
  assert.match(human[0], /<- \[abc123\] 你好/)
  assert.match(human[1], /!! \[abc123\] 模型用量 tokens=100\/20/)

  const machine = fs
    .readFileSync(`${file}.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(machine.length, 2)
  assert.equal(machine[0].level, 'info')
  assert.equal(machine[1].level, 'warn')
  assert.deepEqual(machine[1].usage, { input: 100, output: 20 })
  assert.equal(machine[1].rid, 'abc123')
})

test('级别过滤：warn 只放行 warn 和 error', () => {
  const info = { at: 0, dir: 'in' as const, text: 'a', level: 'info' as const }
  const warn = { at: 0, dir: 'sys' as const, text: 'b', level: 'warn' as const }
  const error = { at: 0, dir: 'sys' as const, text: 'c', level: 'error' as const }

  assert.equal(levelOf(info), 'info')
  assert.deepEqual([info, warn, error].filter((entry) => withinLevel(entry, 'info')).length, 3)
  assert.deepEqual([info, warn, error].filter((entry) => withinLevel(entry, 'warn')).length, 2)
  assert.deepEqual([info, warn, error].filter((entry) => withinLevel(entry, 'error')).length, 1)
})

test('轮转：超过上限就归档，并保留指定份数', () => {
  const file = path.join(dir, 'big.log')
  appendLine(file, 'a'.repeat(200), { maxBytes: 100, keep: 2 })
  appendLine(file, 'b'.repeat(200), { maxBytes: 100, keep: 2 })
  // 第二次写入前已经超限，原文件被移走
  assert.ok(fs.existsSync(`${file}.1`))
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'b'.repeat(200))

  appendLine(file, 'c'.repeat(200), { maxBytes: 100, keep: 2 })
  assert.ok(fs.existsSync(`${file}.2`))
  // keep=2，最老的那份被删掉，最多两个归档
  assert.equal(fs.existsSync(`${file}.3`), false)
})

test('rotateIfNeeded: 文件不存在时不抛错', () => {
  assert.doesNotThrow(() => rotateIfNeeded(path.join(dir, 'nope.log')))
})
