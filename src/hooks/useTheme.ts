import { useSyncExternalStore } from 'react'

type Theme = 'light' | 'dark' | 'system'
const STORAGE_KEY = 'spenza-theme'
const listeners = new Set<() => void>()
const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
function readPreference(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch { return 'system' }
}
let theme = readPreference()
let resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme
function publish() {
  resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    document.documentElement.setAttribute('data-theme', resolved)
  }
  listeners.forEach(listener => listener())
}
function setTheme(value: Theme) {
  theme = value
  try { localStorage.setItem(STORAGE_KEY, value) } catch { /* Keep the current session usable. */ }
  publish()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
if (typeof window !== 'undefined') {
  media?.addEventListener('change', publish)
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) { theme = readPreference(); publish() }
  })
  publish()
}

/** One shared preference and resolved appearance for every theme control. */
export function useTheme() {
  useSyncExternalStore(subscribe, () => `${theme}:${resolved}`, () => 'system:light')
  return { theme, isDark: resolved === 'dark', isLight: resolved === 'light', setTheme,
    toggleTheme: () => setTheme(resolved === 'dark' ? 'light' : 'dark') }
}
