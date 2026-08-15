// Pastel accent-hue override for the mountOS Light and mountOS Dark skins
// only. One hue (plus an optional saturation dial) drives every
// primary/accent-role CSS var, at the same lightness/chroma bands app.css
// already uses for --primary/--ring (bold, saturated) and
// --accent/--sidebar-accent (soft, muted) - only the hue moves. Applied as
// inline styles on <html>, same mechanism as themes.ts's
// applySkin/clearSkin, so it composes on top of (and is cleared alongside)
// the active skin.
//
// --primary pairs with a fixed-contrast foreground everywhere else in this
// app (every skin in themes.ts does the same: white text in light, near-
// black text in dark), so a fixed lightness can't just be re-hued: OKLCH's L
// axis is only approximately perceptually uniform across hues, and
// yellow/green swing bright enough at a "safe" red/blue lightness to wash
// the foreground text out. safePrimaryLightness solves for the lightness,
// per hue and chroma, that reproduces the SAME contrast ratio the theme's
// own default primary already has against its own foreground - real OKLCH
// -> sRGB -> WCAG math, calibrated off the theme's own numbers rather than
// a generic guess. Light targets ~5:1 against white text; dark targets
// ~10.4:1 against its near-black text/background (dark's own default gold
// primary already sits at that ratio - a deliberately bright "pop" against
// the dark page, not just bare legibility).
//
// Ported from mountos-admin-client's src/lib/core/accent-palette.ts, which
// shares this app's exact --primary/--ring/--accent oklch values - keep the
// two in sync if either changes.

export type AccentMode = 'light' | 'dark'

export interface AccentPreset {
  name: string
  hue: number
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: 'Rose', hue: 0 },
  { name: 'Coral', hue: 30 },
  { name: 'Amber', hue: 60 },
  { name: 'Citrus', hue: 90 },
  { name: 'Mint', hue: 120 },
  { name: 'Jade', hue: 150 },
  { name: 'Teal', hue: 180 },
  { name: 'Sky', hue: 210 },
  { name: 'Azure', hue: 240 },
  { name: 'Iris', hue: 270 },
  { name: 'Orchid', hue: 300 },
  { name: 'Blush', hue: 330 },
]

// Matches app.css's own --primary/--ring chroma (0.14 light, 0.13 dark;
// close enough to share one default) as the default; the Saturation control
// lets it range from --accent's soft band up to a firmer ceiling without
// ever leaving the "current accent range" the rest of the theme already
// uses.
export const DEFAULT_ACCENT_CHROMA = 0.14
export const MIN_ACCENT_CHROMA = 0.06
export const MAX_ACCENT_CHROMA = 0.18

// app.css's own --primary hue per mode - the actual "off" state (no accent
// override) renders this, so the picker needs it as a real point to land
// on, not just an absence.
export function defaultAccentHue(mode: AccentMode): number {
  return mode === 'dark' ? 92 : 39
}

const ACCENT_VAR_NAMES = [
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--ring',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-ring',
  '--scrollbar-thumb',
  // Neutral chrome: app.css pins these to one fixed hue per mode (~95° warm
  // cream in light, ~200° cool gray in dark) regardless of accent, so a
  // differently-hued accent used to sit on a backdrop that didn't follow it.
  // Re-hued at each token's own existing chroma (only the hue moves, same
  // tint strength as the default theme already uses) so the page reads as
  // one blended palette instead of an accent color dropped onto an
  // unrelated backdrop.
  '--background',
  '--card',
  '--popover',
  '--muted',
  '--border',
  '--input',
  '--sidebar',
  '--sidebar-border',
  '--scrollbar-track',
] as const

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 360 - d)
}

// Nearest preset name for a hue, or a "Custom (N°)" label when it falls
// clearly between presets (spacing is 30°, so anything past 1° off a preset
// reads as a deliberate custom pick, not a rounding artifact).
export function accentHueLabel(hue: number): string {
  const h = normalizeHue(hue)
  let closest = ACCENT_PRESETS[0]
  let closestDist = 360
  for (const preset of ACCENT_PRESETS) {
    const d = hueDistance(preset.hue, h)
    if (d < closestDist) { closestDist = d; closest = preset }
  }
  return closestDist < 1 ? closest.name : `Custom (${Math.round(h)}°)`
}

// --- OKLCH -> sRGB -> WCAG relative luminance (Björn Ottosson's OKLab
// reference matrices; no external dependency). Used only to keep
// safePrimaryLightness's contrast search accurate. ---

function oklchToLinearSrgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b)
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2) + 0.05
  const lo = Math.min(l1, l2) + 0.05
  return hi / lo
}

interface NeutralSpec { l: number; c: number }

interface ModeConfig {
  // Luminance of the fixed foreground primary pairs with (1 = white, in
  // light; 0 = near-black, in dark).
  textRef: number
  // Contrast ratio primary must hit against textRef, calibrated from the
  // theme's own default primary color for this mode.
  contrastTarget: number
  // Light searches for the brightest legible L (a lower L reads "washed");
  // dark searches for the darkest legible L (a lower L reads "muddy" -
  // dark's primary needs to stay bright to pop off the near-black page).
  minimizeL: boolean
  ringOffset: number
  primaryFg: string
  softFg: string
  softL: number
  softChromaRatio: number
  sidebarSoftL: number
  sidebarSoftChromaRatio: number
  neutrals: {
    background: NeutralSpec
    card: NeutralSpec
    popover: NeutralSpec
    muted: NeutralSpec
    border: NeutralSpec
    input: NeutralSpec
    sidebar: NeutralSpec
    sidebarBorder: NeutralSpec
    scrollbarTrack: NeutralSpec
  }
}

const WHITE = 'oklch(1 0 0)'
const NEAR_BLACK = 'oklch(0.15 0 0)'
const NEAR_WHITE = 'oklch(0.95 0 0)'

const LIGHT: ModeConfig = {
  textRef: 1,
  contrastTarget: 5,
  minimizeL: false,
  ringOffset: 0.07,
  primaryFg: WHITE,
  softFg: NEAR_BLACK,
  softL: 0.92,
  softChromaRatio: 0.06 / DEFAULT_ACCENT_CHROMA,
  sidebarSoftL: 0.9,
  sidebarSoftChromaRatio: 0.05 / DEFAULT_ACCENT_CHROMA,
  neutrals: {
    background: { l: 0.95, c: 0.02 },
    card: { l: 0.96, c: 0.025 },
    popover: { l: 0.96, c: 0.025 },
    muted: { l: 0.92, c: 0.04 },
    // --border/--input ship fully neutral (chroma 0) in app.css, so there's
    // no existing tint ratio to preserve - a small chroma matching
    // --background's own magnitude links them to the accent instead.
    border: { l: 0.88, c: 0.02 },
    input: { l: 0.96, c: 0.01 },
    sidebar: { l: 0.95, c: 0.02 },
    sidebarBorder: { l: 0.9, c: 0.03 },
    scrollbarTrack: { l: 0.95, c: 0.01 },
  },
}

const DARK: ModeConfig = {
  textRef: 0,
  // Dark's own default primary (0.78 0.13 92) already sits at ~10.4:1
  // against near-black - a deliberate glow, not the bare WCAG minimum.
  contrastTarget: 10.4,
  minimizeL: true,
  ringOffset: 0,
  primaryFg: NEAR_BLACK,
  softFg: NEAR_WHITE,
  softL: 0.16,
  softChromaRatio: 0.008 / DEFAULT_ACCENT_CHROMA,
  sidebarSoftL: 0.16,
  sidebarSoftChromaRatio: 0.008 / DEFAULT_ACCENT_CHROMA,
  neutrals: {
    background: { l: 0.07, c: 0.005 },
    // --card/--sidebar ship fully neutral (chroma 0) in app.css - a small
    // chroma matching --background's own magnitude links them to the
    // accent instead.
    card: { l: 0.03, c: 0.005 },
    popover: { l: 0.09, c: 0.006 },
    muted: { l: 0.09, c: 0.005 },
    border: { l: 0.21, c: 0.008 },
    input: { l: 0.09, c: 0.005 },
    sidebar: { l: 0.09, c: 0.005 },
    sidebarBorder: { l: 0.18, c: 0.006 },
    scrollbarTrack: { l: 0.11, c: 0.005 },
  },
}

function modeConfig(mode: AccentMode): ModeConfig {
  return mode === 'dark' ? DARK : LIGHT
}

// Solves, per hue and chroma, for the lightness that reproduces this mode's
// calibrated contrastTarget against its fixed foreground (contrast is
// monotonic in L, so a binary search converges on the boundary).
function safePrimaryLightness(hue: number, chroma: number, cfg: ModeConfig): number {
  let lo = 0.2, hi = 0.92
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    const lum = relativeLuminance(oklchToLinearSrgb(mid, chroma, hue))
    const passes = contrastRatio(cfg.textRef, lum) >= cfg.contrastTarget
    if (cfg.minimizeL) {
      if (passes) hi = mid; else lo = mid
    } else {
      if (passes) lo = mid; else hi = mid
    }
  }
  return cfg.minimizeL ? hi : lo
}

interface AccentVars {
  primary: string
  primaryForeground: string
  ring: string
  soft: string
  softForeground: string
  sidebarSoft: string
  background: string
  card: string
  popover: string
  muted: string
  border: string
  input: string
  sidebar: string
  sidebarBorder: string
  scrollbarTrack: string
}

function neutral(hue: number, spec: NeutralSpec): string {
  return `oklch(${spec.l} ${spec.c} ${hue})`
}

function accentVars(hue: number, chroma: number, mode: AccentMode): AccentVars {
  const cfg = modeConfig(mode)
  const primaryL = safePrimaryLightness(hue, chroma, cfg)
  const ringL = Math.min(Math.max(primaryL + cfg.ringOffset, 0.1), 0.95)
  const softC = chroma * cfg.softChromaRatio
  const sidebarSoftC = chroma * cfg.sidebarSoftChromaRatio
  const n = cfg.neutrals
  return {
    primary: `oklch(${primaryL.toFixed(3)} ${chroma} ${hue})`,
    primaryForeground: cfg.primaryFg,
    ring: `oklch(${ringL.toFixed(3)} ${chroma} ${hue})`,
    soft: `oklch(${cfg.softL} ${softC.toFixed(3)} ${hue})`,
    softForeground: cfg.softFg,
    sidebarSoft: `oklch(${cfg.sidebarSoftL} ${sidebarSoftC.toFixed(3)} ${hue})`,
    background: neutral(hue, n.background),
    card: neutral(hue, n.card),
    popover: neutral(hue, n.popover),
    muted: neutral(hue, n.muted),
    border: neutral(hue, n.border),
    input: neutral(hue, n.input),
    sidebar: neutral(hue, n.sidebar),
    sidebarBorder: neutral(hue, n.sidebarBorder),
    scrollbarTrack: neutral(hue, n.scrollbarTrack),
  }
}

// The actual color a hue/chroma pick renders as - used for the strip
// gradient, preset dots, and slider thumb, so the picker previews the real
// primary color instead of a paler stand-in.
export function accentSwatchColor(hue: number, chroma = DEFAULT_ACCENT_CHROMA, mode: AccentMode = 'light'): string {
  return accentVars(normalizeHue(hue), chroma, mode).primary
}

export function applyAccent(hue: number | null, chroma = DEFAULT_ACCENT_CHROMA, mode: AccentMode = 'light') {
  if (typeof document === 'undefined') return
  const s = document.documentElement.style
  if (hue === null) {
    for (const name of ACCENT_VAR_NAMES) s.removeProperty(name)
    return
  }
  const v = accentVars(normalizeHue(hue), chroma, mode)
  s.setProperty('--primary', v.primary)
  s.setProperty('--primary-foreground', v.primaryForeground)
  s.setProperty('--accent', v.soft)
  s.setProperty('--accent-foreground', v.softForeground)
  s.setProperty('--ring', v.ring)
  s.setProperty('--sidebar-accent', v.sidebarSoft)
  s.setProperty('--sidebar-accent-foreground', v.softForeground)
  s.setProperty('--sidebar-ring', v.ring)
  s.setProperty('--scrollbar-thumb', v.ring)
  s.setProperty('--background', v.background)
  s.setProperty('--card', v.card)
  s.setProperty('--popover', v.popover)
  s.setProperty('--muted', v.muted)
  s.setProperty('--border', v.border)
  s.setProperty('--input', v.input)
  s.setProperty('--sidebar', v.sidebar)
  s.setProperty('--sidebar-border', v.sidebarBorder)
  s.setProperty('--scrollbar-track', v.scrollbarTrack)
}
