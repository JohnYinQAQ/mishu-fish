/**
 * 秘书鱼 · DSH 插件宿主半边
 *
 * 职责：
 *   1. 把 src/plugin/runtime 挂起来（配置、凭据、长轮询、模型回复）
 *   2. 暴露 /dsh-secretary/api/* 给设置页用
 *   3. 插件卸载/热重载时把长轮询停干净（否则消息会回两遍）
 *
 * 这里不写业务逻辑：配置收敛在 dist/plugin/config.js，桥接在 bridge.js，
 * 回复在 reply.js。宿主半边只做接线和信任栅栏。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API = '/dsh-secretary/api'

/** 跨热重载的当前实例：新实例起来前先把旧的停掉 */
let activeRuntime = null

/**
 * 一次性迁移：CLI demo 把凭据放在项目 .data/，插件默认用 ~/.dsh/mishu-fish/。
 * 插件第一次起来时如果目标不存在、源存在，就搬过去（0600），省得再扫一次码。
 */
function migrateDemoData() {
  // MISHU_HOME 被设置时（测试/自定义数据目录）不做迁移：
  // 否则测试会把真实的 ~/.dsh/mishu-fish 当成目标，污染线上状态。
  if (process.env.MISHU_HOME) return
  const dir = path.join(os.homedir(), '.dsh', 'mishu-fish')
  const pairs = ['credentials.json', 'state.json']
  for (const name of pairs) {
    const source = path.join(HERE, '..', '.data', name)
    const target = path.join(dir, name)
    try {
      if (fs.existsSync(target) || !fs.existsSync(source)) continue
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.copyFileSync(source, target)
      fs.chmodSync(target, 0o600)
      console.log(`[dsh-secretary] 已迁移 ${name} 到 ${dir}`)
    } catch (err) {
      console.warn(`[dsh-secretary] 迁移 ${name} 失败：${String(err?.message ?? err)}`)
    }
  }
}

/**
 * 启动日志：DSH 是从 Finder 起的，stdout 看不到。
 * 把关键节点和真实错误写到文件里，出问题时有据可查。
 */
function logBoot(message) {
  // 测试里 apply 也会走到这里；别把测试日志写进真实的 boot.log
  if (process.env.MISHU_HOME) return
  try {
    const dir = path.join(os.homedir(), '.dsh', 'mishu-fish')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, 'boot.log')
    // 超过 2MB 就归档，保留 3 份，避免长期积累
    try {
      if (fs.statSync(file).size >= 2 * 1024 * 1024) {
        const oldest = `${file}.3`
        if (fs.existsSync(oldest)) fs.rmSync(oldest)
        for (let index = 2; index >= 1; index--) {
          if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`)
        }
        fs.renameSync(file, `${file}.1`)
      }
    } catch {
      /* 还没有文件 */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 日志失败不影响加载 */
  }
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

/**
 * !dsh 通道：把任务交给 DSH 里的一个专用 agent，等它跑完再把最终回答取回来。
 *
 * 抓回答的方式：听 `agent/assistant-stream`，按 attemptId（`<sessionId>:<attempt>`）
 * 前缀过滤出属于我们这个会话的帧，只收 text-delta。这样即使用户同时在自己的
 * DSH 会话里聊天，也不会把别人的话混进来。
 */
function createEscalation(ctx, getRoute, log, getAgents) {
  const baseSessionId = 'mishu-fish-escalation'
  let sessionId = baseSessionId
  let handle = null
  let active = null

  /** 收一个流帧：只认属于当前这次会话的 text-delta */
  function onFrame(payload) {
    try {
      const frame = payload?.frame
      if (!active || !frame) return
      const attempt = typeof frame.attemptId === 'string' ? frame.attemptId : ''
      if (active.match.length > 0 && attempt.length > 0 && !attempt.startsWith(active.match)) return
      if (active.seen.length < 6) active.seen.push(`${frame.type}/${frame.chunk?.type ?? '-'}:${attempt.slice(-24)}`)
      if (frame.type === 'chunk' && frame.chunk?.type === 'finish') {
        const reason = frame.chunk.reason ?? {}
        active.finish = `finish:${reason.kind ?? '?'}${reason.failure?.code ? `/${reason.failure.code}` : ''}`
      }
      const chunk = frame.chunk
      if (frame.type === 'chunk' && chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        // 主路径：id 对得上的帧；同时留一份不筛选的，作为 id 不匹配时的兜底
        active.looseParts.push(chunk.text)
        if (active.match.length === 0 || attempt.startsWith(active.match)) active.parts.push(chunk.text)
      }
    } catch {
      /* 观测失败不能影响主流程 */
    }
  }

  let compositionPromise = null

  /**
   * 工具集来自 agent preset：不 mount 的话，agent 只有最基础的能力，
   * 连 bash 都没有（上一轮它自己说“没有执行系统命令的权限”就是这个原因）。
   * 这里复刻 DSH 自己创建会话时的做法：resolve 默认 preset → mount 到 agent 的 ctx。
   */
  async function composition() {
    if (compositionPromise) return compositionPromise
    compositionPromise = (async () => {
      const presets = ctx.get('agentPresets')
      if (!presets) {
        log('agent：没有 agentPresets 服务，工具集为空')
        return {}
      }
      try {
        const resolved = await presets.resolve(undefined)
        log(`agent：使用 preset ${resolved?.id ?? '?'}`)
        return {
          agentPreset: resolved?.id,
          setup: async (agentCtx) => {
            await presets.mount(agentCtx, resolved.id)
          },
        }
      } catch (err) {
        log(`agent：preset 解析失败：${String(err?.message ?? err).slice(0, 100)}`)
        return {}
      }
    })()
    return compositionPromise
  }

  /** 给后台会话套权限预设（完全权限 / 工作区可写 / 不干预） */
  function applyPermission(agent, cfg) {
    const preset = cfg?.escalation?.permissionPreset
    if (!preset) return '不干预'
    const service = ctx.get('permissionPresets')
    if (!service || typeof service.set !== 'function') return 'permissionPresets 不可用'
    try {
      service.set(agent.session, preset)
      return preset
    } catch (err) {
      return `设置失败：${String(err?.message ?? err).slice(0, 100)}`
    }
  }

  async function ensureAgent(route, cfg) {
    if (handle?.agent) return handle
    const agents = getAgents?.() ?? ctx.get('agents')
    if (!agents) throw new Error('agents 服务不可用：当前 DSH 里没有挂载 dsh-agent')

    const agentOptions = route?.provider && route?.model ? { provider: route.provider, model: route.model } : undefined
    const composed = await composition()
    const cwd = cfg?.escalation?.cwd?.trim() || os.homedir()
    const extra = {
      ...(composed.setup ? { setup: composed.setup } : {}),
      meta: {
        cwd,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
    }

    const live = agents.get?.(sessionId)
    if (live) {
      handle = { agent: live }
      log(`agent：复用活着的会话 ${sessionId}，权限=${applyPermission(live, cfg)}`)
      return handle
    }

    // 会话在磁盘上存在（上次运行留下的）→ 优先 resume，避免每轮新建
    let stored
    try {
      stored = ctx.get('sessions')?.get?.(sessionId)
    } catch {
      stored = undefined
    }

    if (stored) {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, ...(agentOptions ? { agentOptions } : {}), ...extra })
        log(`agent：恢复了已有会话 ${sessionId}，权限=${applyPermission(handle.agent, cfg)}`)
        return handle
      } catch (err) {
        log(`agent：恢复会话失败（改用新会话）：${String(err?.message ?? err).slice(0, 300)}`)
      }
    } else {
      try {
        handle = await agents.create({ sessionId, ...(agentOptions ? { agentOptions } : {}), ...extra })
        log(`agent：新建会话 ${sessionId}（cwd=${cwd}），权限=${applyPermission(handle.agent, cfg)}`)
        return handle
      } catch (err) {
        log(`agent：新建会话失败（换一个 id 重试）：${String(err?.message ?? err).slice(0, 300)}`)
      }
    }

    // 最后兜底：换一个唯一 id，保证这一轮能跑
    sessionId = `${baseSessionId}-${Date.now()}`
    handle = await agents.create({ sessionId, ...(agentOptions ? { agentOptions } : {}), ...extra })
    log(`agent：兜底新建 ${sessionId}，权限=${applyPermission(handle.agent, cfg)}`)
    return handle
  }

  return async function escalate(task, config) {
    const route = getRoute()
    const ensured = await ensureAgent(route, config)

    // create() 可能用自己 mint 的 id，不一定等于我们传的 sessionId；
    // 真实 id 从 agent.session.id 取，attemptId 的格式是 `<sessionId>:<attempt>`。
    const realId = String(ensured.agent?.session?.id ?? ensured.sessionId ?? sessionId)
    sessionId = realId
    const timeoutMs = Math.max(10, Number(config?.escalation?.timeoutSec) || 60) * 1000

    active = { match: realId, parts: [], looseParts: [], seen: [], finish: '' }

    // 优先挂在 agent 自己的 ctx 上：agent/* 事件是 agent 作用域发出的，
    // 挂在插件根 ctx 上不一定收得到（上一轮就是这个问题）。
    const agentCtx = ensured.agent?.ctx
    const subscribe = (target) => {
      try {
        return target?.on?.('agent/assistant-stream', onFrame) ?? null
      } catch {
        return null
      }
    }
    const offAgent = subscribe(agentCtx)
    const offRoot = offAgent ? null : subscribe(ctx)

    try {
      // durable Message 必须有 id / role / source，缺任何一项都会被当成非法输入丢掉
      // （上一轮就是这样：帧出现了、会话日志里却一个字都没有）
      const message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      }
      ensured.agent.followup(message)
      log(`agent：已投递（status=${ensured.agent.status ?? '?'}）`)

      let timedOut = false
      await Promise.race([
        ensured.agent.whenIdle(),
        new Promise((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve(undefined)
          }, timeoutMs)
        }),
      ])

      let text = active.parts.join('').trim()
      if (!text && active.looseParts.length > 0) {
        // 会话 id 认错了，但事件确实来了：用未筛选的兜底，并在日志里说明
        text = active.looseParts.join('').trim()
        log('agent：会话 id 没匹配上，已改用未筛选的帧')
      }
      log(
        `agent：${timedOut ? '超时' : '完成'}，取到 ${text.length} 字（session=${realId}，route=${route?.provider}/${route?.model}，${active.finish || '无 finish 帧'}）`,
      )
      if (!text) {
        log(`agent：帧样本 ${active.seen.join(' | ') || '(一个都没收到)'}`)
        return {
          text: timedOut ? '这件事有点久，我先放着，等下再试。' : 'agent 跑完了，但我没拿到它的回答。',
          ok: false,
          error: timedOut ? 'timeout' : `no assistant text; frames=${active.seen.length}`,
        }
      }
      return { text, ok: true }
    } finally {
      try {
        offAgent?.()
      } catch {}
      try {
        offRoot?.()
      } catch {}
      active = null
    }
  }
}

export default {
  name: 'mishu-fish',
  inject: ['webServer', 'connection'],

  apply(ctx) {
    const disposers = []
    let runtime = null
    let loadError = ''

    /**
     * 信任栅栏：DSH 的 Web 端口是回环地址，但浏览器里任何一个网页都能向它发请求。
     * 不拦的话，任意页面可以改她的人格、读聊天日志、甚至替她发消息。
     * 默认 fail-closed：栅栏不可用就拒绝，而不是放行。
     */
    function rejected(req, res) {
      if (!isLoopbackReq(req)) {
        json(res, 403, { ok: false, error: '只接受本机回环访问' })
        return true
      }
      try {
        const conn = ctx.get('connection') ?? ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' })
          return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (err) {
        json(res, 503, { ok: false, error: `信任栅栏异常：${String(err?.message ?? err)}` })
        return true
      }
    }

    function route(kind, pathname, handler) {
      disposers.push(
        ctx.webServer.register({
          kind,
          path: pathname,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try {
              await handler(req, res)
            } catch (err) {
              try {
                json(res, 500, { ok: false, error: String(err?.message ?? err) })
              } catch {}
            }
          },
        }),
      )
    }

    /** 默认模型：优先问 DSH 的默认选择，其次问 llm 的第一个 provider */
    function defaultRoute() {
      try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (selection?.provider && selection?.model) {
          return { provider: selection.provider, model: selection.model }
        }
      } catch {}
      try {
        const providers = ctx.get('llm')?.listProviders?.()
        const first = Array.isArray(providers) ? providers[0] : null
        const provider =
          typeof first === 'string' ? first : typeof first?.provider === 'string' ? first.provider : ''
        const model =
          typeof first?.models?.[0] === 'string'
            ? first.models[0]
            : typeof first?.models?.[0]?.id === 'string'
              ? first.models[0].id
              : ''
        if (provider && model) return { provider, model }
      } catch {}
      return { provider: 'deepseek-account', model: 'deepseek-flash' }
    }

    function snapshot() {
      if (!runtime) {
        return {
          ok: false,
          loadError: loadError || '插件尚未完成初始化',
          config: null,
          status: null,
          logs: [],
          providers: [],
          paths: {},
        }
      }
      return {
        ok: true,
        config: runtime.getConfig(),
        status: runtime.status(),
        logs: runtime.logs(),
        providers: runtime.providers(),
        memory: runtime.memoryInfo(),
        usage: runtime.usageInfo(),
        schedule: runtime.scheduleList(),
        rhythm: runtime.rhythmProfile(),
        habits: runtime.habits(),
        activities: runtime.activities(),
        onboarding: runtime.onboarding(),
        digest: runtime.digestState(),
        hasCredentials: Boolean(runtime.status().accountId),
        paths: runtime.paths?.() ?? {},
      }
    }

    /** 等某个服务出现（最多 timeoutMs），拿不到就返回 undefined */
    async function waitForService(name, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const service = ctx.get(name)
        if (service) return service
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return undefined
    }

    async function boot() {
      try {
        // 把 dist 的构建时间写进日志：一眼就能判断“跑的是不是最新代码”，
        // 省得再出现“改了但没重启、拿旧版本测”的情况。
        let distStamp = 'missing'
        try {
          const distPath = path.join(HERE, '..', 'dist', 'plugin', 'runtime.js')
          distStamp = fs.statSync(distPath).mtime.toISOString()
        } catch {
          /* ignore */
        }
        let version = '?'
        try {
          version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? '?'
        } catch {
          /* ignore */
        }
        logBoot(`boot: start (v=${version}, dist=${distStamp})`)
        migrateDemoData()
        if (activeRuntime) {
          try {
            activeRuntime.dispose()
          } catch {}
          activeRuntime = null
        }

        const llm = await waitForService('llm')
        if (!llm) {
          loadError = '模型服务（ctx.llm）没有就绪，插件其余部分可用，但回复会失败'
          console.warn(`[dsh-secretary] ${loadError}`)
          return
        }

        logBoot('boot: llm ready')
        // agents 可能比 llm 晚注册：等一小会儿，等不到也没关系，
        // escalate 内部会在真正用到时再取一次。
        const agentsReady = await waitForService('agents', 4000)
        logBoot(`boot: agents ${agentsReady ? 'ready' : 'not ready yet（!dsh 会在第一次使用时再取）'}`)
        const escalate = createEscalation(
          ctx,
          () => runtime?.bestRoute?.() ?? defaultRoute(),
          (line) => logBoot(line),
          () => ctx.get('agents'),
        )

        const modulePath = path.join(HERE, '..', 'dist', 'plugin', 'runtime.js')
        const mod = await import(pathToFileURL(modulePath).href)
        runtime = mod.createRuntime({ llm, defaults: defaultRoute(), escalate })
        activeRuntime = runtime
        logBoot(`boot: runtime created (defaults=${JSON.stringify(defaultRoute())}, account=${runtime.status().accountId || 'none'})`)

        // 总开关开着、又有凭据，就直接上线；否则状态区会告诉用户缺什么
        if (runtime.getConfig().enabled && runtime.status().accountId) {
          try {
            runtime.start()
          } catch (err) {
            runtime.pushLog({ at: Date.now(), dir: 'sys', text: `启动失败：${String(err?.message ?? err)}` })
          }
        }
      } catch (err) {
        loadError = `加载 dist 失败（先跑 npm run build）：${String(err?.message ?? err)}`
        logBoot(`boot: FAILED ${String(err?.stack ?? err)}`)
        console.warn(`[dsh-secretary] ${loadError}`)
      }
    }

    route('exact', `${API}/state`, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false })
      json(res, 200, snapshot())
    })

    route('exact', `${API}/config`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, snapshot())
      if (req.method !== 'POST') return json(res, 405, { ok: false })

      const body = await readJsonBody(req)
      const patch = body && typeof body.config === 'object' && body.config ? body.config : body
      try {
        runtime.updateConfig(patch)
        // 打开总开关但还没上线时，顺手拉起来
        if (runtime.getConfig().enabled && !runtime.status().running && runtime.status().accountId) {
          runtime.start()
        }
        if (!runtime.getConfig().enabled && runtime.status().running) {
          runtime.stop()
        }
        json(res, 200, { ok: true, ...snapshot() })
      } catch (err) {
        json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })

    route('exact', `${API}/control`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = await readJsonBody(req)
      const action = String(body.action ?? '')
      if (action === 'start') runtime.start()
      else if (action === 'stop') runtime.stop()
      else if (action === 'reload-credentials') runtime.reloadCredentials()
      else if (action === 'clear-logs') runtime.clearLogs()
      else return json(res, 400, { ok: false, error: `未知操作：${action}` })

      json(res, 200, { ok: true, ...snapshot() })
    })

    route('exact', `${API}/memory`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, { ok: true, memory: runtime.memoryInfo() })
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = await readJsonBody(req)
      runtime.writeFacts(String(body.facts ?? ''))
      return json(res, 200, { ok: true, memory: runtime.memoryInfo() })
    })

    route('exact', `${API}/schedule`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, { ok: true, items: runtime.scheduleList() })
      if (req.method !== 'POST') return json(res, 405, { ok: false })

      const body = await readJsonBody(req)
      const action = String(body.action ?? '')
      try {
        if (action === 'add') {
          const item = runtime.scheduleAdd({ title: body.title, due: body.due ?? null, source: 'manual' })
          return json(res, 200, { ok: true, item, items: runtime.scheduleList() })
        }
        if (action === 'update') {
          const item = runtime.scheduleUpdate(String(body.id ?? ''), { title: body.title, due: body.due })
          if (!item) return json(res, 404, { ok: false, error: '没有这条日程' })
          return json(res, 200, { ok: true, item, items: runtime.scheduleList() })
        }
        if (action === 'done') {
          const item = runtime.scheduleDone(String(body.id ?? ''))
          if (!item) return json(res, 404, { ok: false, error: '没有这条日程' })
          return json(res, 200, { ok: true, item, items: runtime.scheduleList() })
        }
        if (action === 'remove') {
          const removed = runtime.scheduleRemove(String(body.id ?? ''))
          return json(res, 200, { ok: true, removed, items: runtime.scheduleList() })
        }
        return json(res, 400, { ok: false, error: `未知操作：${action}` })
      } catch (err) {
        return json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })

    route('exact', `${API}/onboarding`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = await readJsonBody(req)
      if (String(body.action ?? '') !== 'reset') return json(res, 400, { ok: false, error: '未知操作' })
      runtime.resetOnboarding()
      return json(res, 200, { ok: true, onboarding: runtime.onboarding() })
    })

    route('exact', `${API}/habits`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, { ok: true, habits: runtime.habits() })
      if (req.method !== 'POST') return json(res, 405, { ok: false })

      const body = await readJsonBody(req)
      const action = String(body.action ?? '')
      try {
        if (action === 'add') {
          const habit = runtime.addHabit({
            label: String(body.label ?? '').trim(),
            category: body.category,
            rule: body.rule,
            leadMinutes: body.leadMinutes,
            status: body.status ?? 'active',
            source: 'explicit',
            afterAsk: body.afterAsk,
            askEstimate: body.askEstimate,
          })
          return json(res, 200, { ok: true, habits: runtime.habits(), habit })
        }
        if (action === 'update') {
          const habit = runtime.updateHabit(String(body.id ?? ''), body.patch ?? {})
          if (!habit) return json(res, 404, { ok: false, error: '没有这条习惯' })
          return json(res, 200, { ok: true, habits: runtime.habits(), habit })
        }
        if (action === 'confirm' || action === 'dismiss') {
          const habit = runtime.updateHabit(String(body.id ?? ''), { status: action === 'confirm' ? 'active' : 'dismissed' })
          if (!habit) return json(res, 404, { ok: false, error: '没有这条习惯' })
          return json(res, 200, { ok: true, habits: runtime.habits() })
        }
        if (action === 'remove') {
          runtime.removeHabit(String(body.id ?? ''))
          return json(res, 200, { ok: true, habits: runtime.habits() })
        }
        if (action === 'sync') {
          return json(res, 200, { ok: true, habits: runtime.syncHabits() })
        }
        return json(res, 400, { ok: false, error: `未知操作：${action}` })
      } catch (err) {
        return json(res, 400, { ok: false, error: String(err?.message ?? err) })
      }
    })

    route('exact', `${API}/rhythm`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, { ok: true, rhythm: runtime.rhythmProfile() })
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = await readJsonBody(req)
      if (String(body.action ?? '') === 'clear') {
        runtime.clearRhythm()
        return json(res, 200, { ok: true, rhythm: runtime.rhythmProfile() })
      }
      return json(res, 400, { ok: false, error: `未知操作：${String(body.action ?? '')}` })
    })

    route('exact', `${API}/digest`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = await readJsonBody(req)
      runtime.pushLog({ at: Date.now(), dir: 'sys', text: '收到摘要请求' })
      const date = typeof body.date === 'string' ? new Date(`${body.date}T12:00:00`) : undefined
      const result = await runtime.runDigestNow(date)
      return json(res, 200, { ...result, ...snapshot() })
    })

    route('exact', `${API}/log`, async (req, res) => {
      if (!runtime) return json(res, 503, { ok: false, error: loadError || '未初始化' })
      if (req.method === 'GET') return json(res, 200, { ok: true, logs: runtime.logs() })
      if (req.method === 'DELETE' || req.method === 'POST') {
        runtime.clearLogs()
        return json(res, 200, { ok: true, logs: [] })
      }
      json(res, 405, { ok: false })
    })

    // 先挂路由，再异步加载 dist：这样设置页在构建缺失时也能打开并显示原因
    ctx.effect(() => () => {
      try {
        runtime?.dispose()
      } catch {}
      if (activeRuntime === runtime) activeRuntime = null
      runtime = null
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    })

    boot()
  },
}
