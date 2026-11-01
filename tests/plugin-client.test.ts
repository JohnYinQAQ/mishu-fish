import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 客户端半边的接线测试：不渲染 React，只验证
 *   1. 模块能被 DSH 的 __ModuleLoader__ 加载
 *   2. apply() 注册的是 settings.section，id/order/label 对
 *   3. 组件是函数组件
 */

interface Registration {
  spec: { name: string; id: string; order: number; label: () => string }
  component: unknown
}

const registrations: Registration[] = []
const injected: string[] = []

const fakeReact = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: () => ({ current: null }),
}

const g = globalThis as unknown as {
  window?: { __ModuleLoader__: { load: (entry: { id: string; factory: (require: (name: string) => unknown) => unknown }) => void } }
  document?: unknown
}

g.window = {
  __ModuleLoader__: {
    load(entry) {
      const exported = entry.factory((name: string) => {
        if (name === 'react') return fakeReact
        throw new Error(`没预期的 require：${name}`)
      }) as { apply: (ctx: unknown) => void; inject: string[]; MsfSection: unknown }
      ;(g as unknown as { __msf: unknown }).__msf = exported
    },
  },
}

await import('../lib/client.js')

const mod = (g as unknown as { __msf: { apply: (ctx: unknown) => void; inject: string[]; MsfSection: unknown } }).__msf

test('客户端模块导出 apply / inject / 组件', () => {
  assert.ok(mod, '模块没有被 __ModuleLoader__ 装载')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.MsfSection, 'function')
})

test('apply 注册的是 settings.section，id=secretary，label=秘书鱼', () => {
  const ctx = {
    effect(fn: () => unknown) {
      fn()
    },
    slots: {
      inject(name: string, register: () => void) {
        injected.push(name)
        register()
      },
      register(spec: Registration['spec'], component: unknown) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }

  mod.apply(ctx)

  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].spec.name, 'settings.section')
  assert.equal(registrations[0].spec.id, 'secretary')
  assert.equal(registrations[0].spec.order, 7)
  assert.equal(registrations[0].spec.label(), '秘书鱼')
  assert.equal(registrations[0].component, mod.MsfSection)
})
