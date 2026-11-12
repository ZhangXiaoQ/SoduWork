import * as selectPopover from '../../src/select-popover.js'
import * as orgOptions from '../../src/org-options.js'
import * as enlargeTheme from '../../src/enlarge-theme.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { transform } from 'esbuild'
import * as locale from '../../src/i18n.js'
import * as dialogFocus from '../../src/dialog-focus.js'
import * as polling from '../../src/polling.js'

let harnessSequence = 0

// Execute real JSX and its handlers/effects without a browser. This host tests
// component logic, not DOM focus, CSS, layout, or React reconciliation.
export async function createComponentHarness(file, { dependencies = {}, exportName = 'default', props = {}, privateExports = [] } = {}) {
  const source = await fs.readFile(file, 'utf8')
  const exposedSource = source + (privateExports.length ? '\nexport { ' + privateExports.join(', ') + ' }' : '')
  const { code } = await transform(exposedSource, { loader: 'jsx', format: 'cjs', jsx: 'automatic' })
  const slots = [], effects = []
  const instanceId = ++harnessSequence
  let cursor = 0, dirty = true, tree, mounted = true, currentProps = props
  const same = (next, previous) => next && previous && next.length === previous.length && next.every((value, i) => Object.is(value, previous[i]))
  const hooks = {
    ...React,
    useContext: (context) => context._currentValue,
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        assert.ok(mounted, 'a completed request must not update an unmounted component')
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (!Object.is(slots[index], value)) { slots[index] = value; dirty = true }
      }]
    },
    useRef(initial) {
      const index = cursor++
      return slots[index] ||= { current: initial }
    },
    useId() {
      const index = cursor++
      return slots[index] ||= `:harness-${instanceId}-${index}:`
    },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index]
      if (previous && same(deps, previous.dependencies)) return
      effects.push(() => {
        previous?.cleanup?.()
        slots[index] = { dependencies: deps, cleanup: callback() }
      })
    },
    useMemo(callback, deps) {
      const index = cursor++, previous = slots[index]
      if (!previous || !same(deps, previous.dependencies)) slots[index] = { dependencies: deps, value: callback() }
      return slots[index].value
    },
  }
  hooks.useCallback = (callback, deps) => hooks.useMemo(() => callback, deps)
  hooks.useLayoutEffect = hooks.useEffect
  // Keep the real translator/maps; locale subscriptions themselves belong to React.
  const localeHost = { ...locale, useLocale: () => locale.getLocale() }
  // Geometry is covered separately in viewport-height.test.mjs. This logic host
  // has no DOM, so list refs are inert unless the test supplies its own adapter.
  const viewportHost = { useViewportHeight: () => () => {} }
  const imports = { './i18n.js': localeHost, '../i18n.js': localeHost, './dialog-focus.js': dialogFocus, './select-popover.js': selectPopover, './org-options.js': orgOptions, '../org-options.js': orgOptions,
    '../viewport-height.js': viewportHost, './polling.js': polling, '../polling.js': polling, './enlarge-theme.js': enlargeTheme, '../enlarge-theme.js': enlargeTheme,
    'react-dom': { createPortal: (children) => children }, 'react/jsx-runtime': jsxRuntime, ...dependencies, react: hooks }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(name in imports, `unknown test dependency: ${name}`)
    return imports[name]
  }, module, module.exports)
  const Component = module.exports[exportName]
  assert.equal(typeof Component, 'function', `missing component export ${exportName}`)
  function render(nextProps) {
    if (nextProps) { currentProps = nextProps; dirty = true }
    for (let count = 0; dirty; count++) {
      assert.ok(count < 20, 'component must settle')
      dirty = false; cursor = 0
      tree = Component(currentProps)
      effects.splice(0).forEach((effect) => effect())
    }
    return tree
  }
  function walk(predicate, value, result) {
    if (Array.isArray(value)) value.forEach((item) => walk(predicate, item, result))
    else if (React.isValidElement(value)) {
      if (predicate(value)) result.push(value)
      walk(predicate, value.props.children, result)
    }
    return result
  }
  return {
    render,
    nodes: (predicate) => walk(predicate, render(), []),
    act(callback) { callback(); return render() },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); return render() },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); mounted = false },
  }
}
