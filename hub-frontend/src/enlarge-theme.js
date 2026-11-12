/*
 * Display-scale preference (issue #27) — persistence and application for the
 * font-size steps. Kept separate from the color theme: light/dark live in
 * `data-theme` (ui.jsx ThemeToggle), the scale level lives in `data-scale`
 * and is consumed by src/enlarge-theme.css.
 *
 * The preference is a step count rather than a boolean so the A+/A- controls
 * can step the text through several levels in either direction: the stored
 * value ranges from MIN_STEP to MAX_STEP, with 0 as the standard size.
 */

const KEY = 'soduwork-hub-scale'
const LEGACY_VALUE = 'enlarge'
const listeners = new Set()
let currentStep
let subscribedWindow

/* Step bounds keep the layout readable: two steps out in each direction. */
export const MIN_STEP = -2
export const MAX_STEP = 2
export const DEFAULT_STEP = 0

function clampStep(step) {
  const value = Number(step)
  if (!Number.isFinite(value)) return DEFAULT_STEP
  return Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(value)))
}

function parseStep(stored) {
  /* Migrate the earlier boolean preference onto the first enlarged step. */
  return stored === LEGACY_VALUE ? 1 : clampStep(stored)
}

export function readScaleStep() {
  if (currentStep !== undefined) return currentStep
  try { currentStep = parseStep(localStorage.getItem(KEY)) }
  catch (_e) { currentStep = DEFAULT_STEP }
  return currentStep
}

function applyScaleStep(step) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  /* Test hosts and partial DOM shims may expose a documentElement without the
     attribute API; the preference still persists in that case. */
  if (!root || typeof root.setAttribute !== 'function') return
  if (step === DEFAULT_STEP) {
    if (typeof root.removeAttribute === 'function') root.removeAttribute('data-scale')
  } else root.setAttribute('data-scale', String(step))
}

function updateScaleStep(next) {
  currentStep = next
  applyScaleStep(next)
  listeners.forEach(notify => notify(next))
}

export function setScaleStep(step) {
  const next = clampStep(step)
  try {
    if (next === DEFAULT_STEP) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch (_e) { /* Private mode: keep the choice for this page view only. */ }
  updateScaleStep(next)
  return next
}

/* Step the current level by one position and return the new level. */
export function stepScale(delta) {
  return setScaleStep(readScaleStep() + (Number(delta) || 0))
}

export function subscribeScale(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

function onStorage(event) {
  if (event.key !== KEY && event.key !== null) return
  /* sessionStorage uses the same event type but is a separate preference scope. */
  try { if (event.storageArea && event.storageArea !== window.localStorage) return }
  catch (_e) { return }
  updateScaleStep(event.key === null ? DEFAULT_STEP : parseStep(event.newValue))
}

/* Call at startup so the saved preference applies before first paint. */
export function initScale() {
  applyScaleStep(readScaleStep())
  if (typeof window === 'undefined' || subscribedWindow === window) return
  subscribedWindow?.removeEventListener('storage', onStorage)
  subscribedWindow = window
  subscribedWindow.addEventListener('storage', onStorage)
}
