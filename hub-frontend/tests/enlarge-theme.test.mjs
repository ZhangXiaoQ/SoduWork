import test from 'node:test'
import assert from 'node:assert/strict'

let sequence = 0
async function fixture(t, initial, { failRead = false, failWrite = false } = {}) {
  const previous = Object.fromEntries(['localStorage', 'window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const values = new Map(initial == null ? [] : [['soduwork-hub-scale', initial]])
  const attrs = new Map()
  const storage = {
    getItem(key) { if (failRead) throw Error('storage denied'); return values.get(key) ?? null },
    setItem(key, value) { if (failWrite) throw Error('quota exceeded'); values.set(key, value) },
    removeItem(key) { if (failWrite) throw Error('storage denied'); values.delete(key) },
  }
  const events = new Set()
  const window = { localStorage: storage, addEventListener(type, callback) {
    assert.equal(type, 'storage'); events.add(callback)
  }, removeEventListener(type, callback) { assert.equal(type, 'storage'); events.delete(callback) } }
  Object.assign(globalThis, { localStorage: storage, window, document: { documentElement: {
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
  } } })
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const theme = await import('../src/enlarge-theme.js?fixture=' + ++sequence)
  return { theme, values, attrs, events, storage,
    storageEvent: event => {
      // Real storage events arrive after the other tab has changed shared storage.
      if (!event.storageArea || event.storageArea === storage) {
        if (event.key === null) values.clear()
        else if (event.newValue === null) values.delete(event.key)
        else values.set(event.key, event.newValue)
      }
      events.forEach(callback => callback({ storageArea: storage, ...event }))
    } }
}

test('legacy enlarged preference applies before rendering without changing color theme', async t => {
  const { theme, attrs } = await fixture(t, 'enlarge')
  attrs.set('data-theme', 'dark')
  theme.initScale()
  assert.equal(theme.readScaleStep(), 1)
  assert.equal(attrs.get('data-scale'), '1')
  assert.equal(attrs.get('data-theme'), 'dark')
})

test('scale steps persist, clamp both bounds and remove the default preference', async t => {
  const { theme, attrs, values } = await fixture(t)
  theme.initScale()
  assert.equal(theme.stepScale(1), 1)
  assert.equal(theme.stepScale(1), 2)
  assert.equal(theme.stepScale(1), 2)
  assert.equal(values.get('soduwork-hub-scale'), '2')
  assert.equal(theme.setScaleStep(-99), -2)
  assert.equal(theme.stepScale(-1), -2)
  assert.equal(theme.setScaleStep(0), 0)
  assert.equal(attrs.has('data-scale'), false)
  assert.equal(values.has('soduwork-hub-scale'), false)
})

for (const options of [{ failRead: true, failWrite: true }, { failWrite: true }]) {
  test('blocked storage keeps successive changes in memory: ' + JSON.stringify(options), async t => {
    const { theme, attrs } = await fixture(t, null, options)
    const seen = []
    theme.subscribeScale(step => seen.push(step))
    theme.initScale()
    for (const expected of [1, 2, 2]) assert.equal(theme.stepScale(1), expected)
    assert.equal(theme.stepScale(-1), 1)
    assert.equal(theme.stepScale(-1), 0)
    assert.equal(theme.stepScale(-1), -1)
    assert.equal(attrs.get('data-scale'), '-1')
    assert.deepEqual(seen, [1, 2, 2, 1, 0, -1])
  })
}

test('cross-tab updates, key removal and storage clear notify subscribers and update the DOM together', async t => {
  const { theme, attrs, storageEvent } = await fixture(t, '1')
  const seen = []
  const unsubscribe = theme.subscribeScale(step => seen.push(step))
  theme.initScale()
  storageEvent({ key: 'soduwork-hub-scale', newValue: '2' })
  assert.equal(theme.readScaleStep(), 2)
  assert.equal(attrs.get('data-scale'), '2')
  storageEvent({ key: 'soduwork-hub-scale', newValue: null })
  assert.equal(theme.readScaleStep(), 0)
  storageEvent({ key: 'soduwork-hub-scale', newValue: '-2' })
  storageEvent({ key: null, newValue: null })
  assert.equal(theme.readScaleStep(), 0)
  assert.equal(attrs.has('data-scale'), false)
  assert.deepEqual(seen, [2, 0, -2, 0])
  unsubscribe()
  storageEvent({ key: 'soduwork-hub-scale', newValue: '1' })
  assert.deepEqual(seen, [2, 0, -2, 0])
})

test('initialization is idempotent and unrelated or session-storage events are ignored', async t => {
  const { theme, events, storageEvent } = await fixture(t, '-1')
  theme.initScale(); theme.initScale()
  assert.equal(events.size, 1)
  storageEvent({ key: 'another-setting', newValue: '2' })
  storageEvent({ key: 'soduwork-hub-scale', newValue: '2', storageArea: {} })
  assert.equal(theme.readScaleStep(), -1)
})

test('invalid stored values recover to default and new malformed values cannot escape bounds', async t => {
  const { theme, storageEvent } = await fixture(t, 'not-a-step')
  theme.initScale()
  assert.equal(theme.readScaleStep(), 0)
  storageEvent({ key: 'soduwork-hub-scale', newValue: 'Infinity' })
  assert.equal(theme.readScaleStep(), 0)
  storageEvent({ key: 'soduwork-hub-scale', newValue: '1000' })
  assert.equal(theme.readScaleStep(), 2)
  assert.equal(theme.setScaleStep(NaN), 0)
})

test('server rendering can import and read default scale without browser globals', async t => {
  await fixture(t)
  delete globalThis.localStorage; delete globalThis.window; delete globalThis.document
  const theme = await import('../src/enlarge-theme.js?fixture=' + ++sequence)
  assert.doesNotThrow(() => theme.initScale())
  assert.equal(theme.readScaleStep(), 0)
})
