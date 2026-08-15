import { getCurrentWindow } from '@tauri-apps/api/window'
import { hasDesktopBridge } from './tauri'
import { applySkin, clearSkin, familyVariant, findPreset } from './themes'
import { applyAccent, DEFAULT_ACCENT_CHROMA } from './accent-palette'

export type Theme = 'system' | 'light' | 'dark'
export type FontSize = 'standard' | 'medium' | 'large' | 'extra-large' | 'jumbo'

export const THEME_STORAGE_KEY = 'mountos-desktop-theme'
const STORAGE_KEY = THEME_STORAGE_KEY
export const SKIN_STORAGE_KEY = 'mountos-desktop-skin'
export const FONT_SIZE_STORAGE_KEY = 'mountos-desktop-font-size'
export const GRAYSCALE_STORAGE_KEY = 'mountos-desktop-grayscale'
export const BRIGHTNESS_STORAGE_KEY = 'mountos-desktop-brightness'
export const ACCENT_HUE_LIGHT_STORAGE_KEY = 'mountos-desktop-accent-hue-light'
export const ACCENT_HUE_DARK_STORAGE_KEY = 'mountos-desktop-accent-hue-dark'
export const ACCENT_CUSTOM_HUE_LIGHT_STORAGE_KEY = 'mountos-desktop-accent-custom-hue-light'
export const ACCENT_CUSTOM_HUE_DARK_STORAGE_KEY = 'mountos-desktop-accent-custom-hue-dark'
export const ACCENT_CHROMA_LIGHT_STORAGE_KEY = 'mountos-desktop-accent-chroma-light'
export const ACCENT_CHROMA_DARK_STORAGE_KEY = 'mountos-desktop-accent-chroma-dark'

// Percentage on <html>'s own font-size (not a rem/px constant), so every
// Tailwind rem-based size in the app scales proportionally with it.
export const FONT_SCALE: Record<FontSize, string> = {
  standard: '100%',
  medium: '112.5%',
  large: '125%',
  'extra-large': '137.5%',
  jumbo: '150%',
}

function loadTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'system'
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function saveTheme(theme: Theme) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, theme)
}

function loadSkin(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(SKIN_STORAGE_KEY) ?? ''
}

function saveSkin(skin: string) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SKIN_STORAGE_KEY, skin)
}

function loadFontSize(): FontSize {
  if (typeof localStorage === 'undefined') return 'standard'
  const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY)
  return stored && stored in FONT_SCALE ? (stored as FontSize) : 'standard'
}

function saveFontSize(fontSize: FontSize) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize)
}

function loadGrayscale(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(GRAYSCALE_STORAGE_KEY) === 'true'
}

function saveGrayscale(grayscale: boolean) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(GRAYSCALE_STORAGE_KEY, String(grayscale))
}

function loadBrightness(): number {
  if (typeof localStorage === 'undefined') return 100
  const stored = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY))
  return Number.isFinite(stored) && stored >= 50 && stored <= 150 ? stored : 100
}

function saveBrightness(brightness: number) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness))
}

function loadHue(key: string): number | null {
  if (typeof localStorage === 'undefined') return null
  const stored = Number(localStorage.getItem(key))
  return Number.isFinite(stored) && stored >= 0 && stored <= 360 ? stored : null
}

function saveHue(key: string, hue: number | null) {
  if (typeof localStorage === 'undefined') return
  if (hue === null) localStorage.removeItem(key)
  else localStorage.setItem(key, String(hue))
}

function loadChroma(key: string): number {
  if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_CHROMA
  const stored = Number(localStorage.getItem(key))
  return Number.isFinite(stored) && stored > 0 && stored <= 0.24 ? stored : DEFAULT_ACCENT_CHROMA
}

function saveChroma(key: string, chroma: number) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(chroma))
}

function applyFontSize(fontSize: FontSize) {
  if (typeof document === 'undefined') return
  document.documentElement.style.fontSize = FONT_SCALE[fontSize]
}

// Grayscale and brightness are blunt document-wide filters, not OKLCH
// adjustments to the active skin, they're meant to layer on top of
// whichever skin is picked, not reinterpret its colors.
function applyFilters() {
  if (typeof document === 'undefined') return
  const parts: string[] = []
  if (state.grayscale) parts.push('grayscale(1)')
  if (state.brightness !== 100) parts.push(`brightness(${state.brightness / 100})`)
  document.documentElement.style.filter = parts.length ? parts.join(' ') : ''
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

// Sets color-scheme inline (not just the .dark class) so native form controls
// match the chosen theme even when a browser extension injects its own.
// Also pushes the resolved mode to the native window (setTheme). Without
// this, macOS keeps the titlebar/traffic-lights on the OS-level appearance,
// which can go native-dark against light webview content (or vice versa).
// Passing null (not a resolved mode) for 'system' is required, not cosmetic:
// on macOS, Window.setTheme forwards to `[NSApp setAppearance:]` (app-wide,
// not per-window), so a concrete value pins prefers-color-scheme for every
// webview in the process, permanently, until something un-pins it. Only null
// clears that override and lets the OS appearance (and this webview's own
// matchMedia read below) actually follow the system again.
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const mode = resolveTheme(theme)
  document.documentElement.classList.toggle('dark', mode === 'dark')
  document.documentElement.style.colorScheme = mode
  applySkinPreset()
  if (hasDesktopBridge()) {
    getCurrentWindow()
      .setTheme(theme === 'system' ? null : mode)
      .catch(() => {})
  }
}

// Reconciles the picked skin against the CURRENT resolved mode (state.
// resolvedMode is always kept in sync with state.theme before this runs,
// see setTheme/initThemeSync). A skin's `family` pairs a light/dark variant
// (e.g. Dracula <-> Alucard) so flipping mode re-derives the matching member
// instead of showing a light skin's colors under a dark toggle. No family
// (or no match) falls back to no skin, i.e. this app's own plain palette.
function applySkinPreset() {
  applySkinPresetInner()
  applyAccentOverride()
}

function applySkinPresetInner() {
  if (typeof document === 'undefined') return
  const mode = state.resolvedMode
  if (!state.skin) {
    clearSkin()
    if (mode === 'dark') {
      const mountOSDark = findPreset('mountOS Dark')
      if (mountOSDark) applySkin(mountOSDark)
    }
    return
  }
  let preset = findPreset(state.skin)
  if (preset && preset.mode !== mode) {
    const variant = familyVariant(state.skin, mode)
    if (variant) {
      preset = variant
      state.skin = variant.name
      saveSkin(variant.name)
    } else {
      state.skin = ''
      saveSkin('')
      clearSkin()
      return
    }
  }
  if (!preset) {
    state.skin = ''
    saveSkin('')
    clearSkin()
    return
  }
  clearSkin()
  applySkin(preset)
}

// The accent-hue override only makes sense on the mountOS Light/Dark skins -
// other skins bring their own hand-tuned accent. Every property applyAccent
// touches is also one applySkin/clearSkin (always run just before this,
// same call) fully owns and overwrites for the active skin - so when a
// non-mountOS skin is active this must do nothing at all, not clear
// anything. Clearing would remove the skin's own just-applied inline
// values (same property, same element), not just ours. Called from the end
// of applySkinPreset() itself so every caller (applyTheme, setSkin) picks
// it up automatically.
function applyAccentOverride() {
  if (typeof document === 'undefined') return
  const mode = state.resolvedMode
  const isMountOSDefault = mode === 'dark'
    ? (!state.skin || state.skin === 'mountOS Dark')
    : (!state.skin || state.skin === 'mountOS Light')
  if (!isMountOSDefault) return
  if (mode === 'dark') applyAccent(state.accentHueDark, state.accentChromaDark, 'dark')
  else applyAccent(state.accentHueLight, state.accentChromaLight, 'light')
}

// Reactive across every component in THIS webview (module-level $state is a
// singleton). Each of App.svelte/TrayPopover.svelte is its own separate Tauri
// window/webview though, so this does NOT sync between them on its own,
// initThemeSync()'s 'storage' listener still does that part, same as before.
const state = $state({
  theme: loadTheme(),
  resolvedMode: resolveTheme(loadTheme()),
  skin: loadSkin(),
  fontSize: loadFontSize(),
  grayscale: loadGrayscale(),
  brightness: loadBrightness(),
  // Tracked separately per mode - a hue picked for light shouldn't silently
  // reappear on dark. null = theme default.
  accentHueLight: loadHue(ACCENT_HUE_LIGHT_STORAGE_KEY),
  accentHueDark: loadHue(ACCENT_HUE_DARK_STORAGE_KEY),
  // Last hue picked off the continuous strip, kept even after Reset or
  // after switching to a preset, so the user can return to it in one click.
  accentCustomHueLight: loadHue(ACCENT_CUSTOM_HUE_LIGHT_STORAGE_KEY),
  accentCustomHueDark: loadHue(ACCENT_CUSTOM_HUE_DARK_STORAGE_KEY),
  // Saturation dial for the accent override; independent of hue so Reset
  // can restore just the color while keeping the user's preferred intensity.
  accentChromaLight: loadChroma(ACCENT_CHROMA_LIGHT_STORAGE_KEY),
  accentChromaDark: loadChroma(ACCENT_CHROMA_DARK_STORAGE_KEY),
})

export const themeState = state

export function setTheme(next: Theme) {
  state.theme = next
  state.resolvedMode = resolveTheme(next)
  saveTheme(next)
  applyTheme(next)
}

export function setSkin(next: string) {
  state.skin = next
  saveSkin(next)
  applySkinPreset()
}

export function setFontSize(next: FontSize) {
  state.fontSize = next
  saveFontSize(next)
  applyFontSize(next)
}

export function setGrayscale(next: boolean) {
  state.grayscale = next
  saveGrayscale(next)
  applyFilters()
}

export function setBrightness(next: number) {
  state.brightness = Math.max(50, Math.min(150, next))
  saveBrightness(state.brightness)
  applyFilters()
}

export function setAccentHue(next: number | null) {
  if (state.resolvedMode === 'dark') {
    state.accentHueDark = next
    saveHue(ACCENT_HUE_DARK_STORAGE_KEY, next)
  } else {
    state.accentHueLight = next
    saveHue(ACCENT_HUE_LIGHT_STORAGE_KEY, next)
  }
  applyAccentOverride()
}

export function setAccentCustomHue(next: number | null) {
  if (state.resolvedMode === 'dark') {
    state.accentCustomHueDark = next
    saveHue(ACCENT_CUSTOM_HUE_DARK_STORAGE_KEY, next)
  } else {
    state.accentCustomHueLight = next
    saveHue(ACCENT_CUSTOM_HUE_LIGHT_STORAGE_KEY, next)
  }
}

export function setAccentChroma(next: number) {
  const clamped = Math.max(0.02, Math.min(0.24, next))
  if (state.resolvedMode === 'dark') {
    state.accentChromaDark = clamped
    saveChroma(ACCENT_CHROMA_DARK_STORAGE_KEY, clamped)
  } else {
    state.accentChromaLight = clamped
    saveChroma(ACCENT_CHROMA_LIGHT_STORAGE_KEY, clamped)
  }
  applyAccentOverride()
}

export function resetAccent() {
  setAccentHue(null)
  setAccentChroma(DEFAULT_ACCENT_CHROMA)
}

// Applies the current theme immediately and wires up the two things that can
// change it without a local setTheme() call: the OS appearance (when
// following "system") and another window writing THEME_STORAGE_KEY. Call
// once per window (App.svelte's root shell, TrayPopover.svelte).
export function initThemeSync(): () => void {
  applyTheme(state.theme)
  applyFontSize(state.fontSize)
  applyFilters()

  const cleanups: Array<() => void> = []

  if (typeof matchMedia !== 'undefined') {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (state.theme === 'system') {
        state.resolvedMode = resolveTheme(state.theme)
        applyTheme(state.theme)
      }
    }
    query.addEventListener('change', onChange)
    cleanups.push(() => query.removeEventListener('change', onChange))
  }

  if (typeof window !== 'undefined') {
    const onStorage = (event: StorageEvent) => {
      if (event.key === FONT_SIZE_STORAGE_KEY) {
        state.fontSize = loadFontSize()
        applyFontSize(state.fontSize)
        return
      }
      if (event.key === GRAYSCALE_STORAGE_KEY || event.key === BRIGHTNESS_STORAGE_KEY) {
        state.grayscale = loadGrayscale()
        state.brightness = loadBrightness()
        applyFilters()
        return
      }
      if (
        event.key === ACCENT_HUE_LIGHT_STORAGE_KEY || event.key === ACCENT_HUE_DARK_STORAGE_KEY ||
        event.key === ACCENT_CHROMA_LIGHT_STORAGE_KEY || event.key === ACCENT_CHROMA_DARK_STORAGE_KEY ||
        event.key === ACCENT_CUSTOM_HUE_LIGHT_STORAGE_KEY || event.key === ACCENT_CUSTOM_HUE_DARK_STORAGE_KEY
      ) {
        state.accentHueLight = loadHue(ACCENT_HUE_LIGHT_STORAGE_KEY)
        state.accentHueDark = loadHue(ACCENT_HUE_DARK_STORAGE_KEY)
        state.accentCustomHueLight = loadHue(ACCENT_CUSTOM_HUE_LIGHT_STORAGE_KEY)
        state.accentCustomHueDark = loadHue(ACCENT_CUSTOM_HUE_DARK_STORAGE_KEY)
        state.accentChromaLight = loadChroma(ACCENT_CHROMA_LIGHT_STORAGE_KEY)
        state.accentChromaDark = loadChroma(ACCENT_CHROMA_DARK_STORAGE_KEY)
        applyAccentOverride()
        return
      }
      if (event.key !== STORAGE_KEY && event.key !== SKIN_STORAGE_KEY) return
      state.theme = loadTheme()
      state.skin = loadSkin()
      state.resolvedMode = resolveTheme(state.theme)
      applyTheme(state.theme)
    }
    window.addEventListener('storage', onStorage)
    cleanups.push(() => window.removeEventListener('storage', onStorage))
  }

  return () => cleanups.forEach((cleanup) => cleanup())
}
