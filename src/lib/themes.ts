// Each skin owns a named palette (its real published colors, or this app's
// own hand-picked set for the two mountOS presets) plus a `color()` function
// that decides which palette entry answers each CSS role. There is no shared
// generic field ("cardBg", "accentBlue") every theme is forced through - a
// theme with a 26-tone palette (Catppuccin) and one with an 11-tone palette
// (Dracula) each just implement `color()` however their own palette
// supports it. `applySkin` is the only generic part: it walks CSS_VAR_NAMES
// and asks the active preset for each role in turn.
//
// `card`/`popover`/`muted` and `sidebar` are deliberately separate roles.
// `card` is this theme's real "Surface"/"Selection" swatch (used by actual
// Card/Dialog/Popover UI, always lighter than Background in dark mode, more
// tinted in light mode - its authentic, natural role in every published
// spec). `sidebar` is the nav rail specifically: the theme's real darkest
// (dark mode) / most-recessed (light mode) tone, which is sometimes the same
// swatch as `background` and sometimes a distinct one a theme's own spec
// provides for exactly this purpose (Catppuccin's crust, Gruvbox's bg0_h,
// Tokyo Night's bg_dark). Keeping them apart means neither compromises the
// other: Card/Dialog/Popover stay textbook-correct, and the sidebar can be
// tuned to read as a darker anchor without borrowing Card's role.
export type SkinMode = 'light' | 'dark'

export type CSSColorRole =
  | 'background'
  | 'foreground'
  | 'card'
  | 'cardForeground'
  | 'popover'
  | 'popoverForeground'
  | 'primary'
  | 'primaryForeground'
  | 'secondary'
  | 'secondaryForeground'
  | 'muted'
  | 'mutedForeground'
  | 'label'
  | 'accent'
  | 'accentForeground'
  | 'destructive'
  | 'destructiveForeground'
  | 'warning'
  | 'warningForeground'
  | 'success'
  | 'successForeground'
  | 'border'
  | 'input'
  | 'ring'
  | 'sidebar'
  | 'sidebarForeground'
  | 'sidebarPrimary'
  | 'sidebarPrimaryForeground'
  | 'sidebarAccent'
  | 'sidebarAccentForeground'
  | 'sidebarBorder'
  | 'sidebarRing'
  | 'scrollbarThumb'
  | 'scrollbarTrack'

const CSS_VAR_NAMES: Record<CSSColorRole, string> = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  label: '--label-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  destructive: '--destructive',
  destructiveForeground: '--destructive-foreground',
  warning: '--warning',
  warningForeground: '--warning-foreground',
  success: '--success',
  successForeground: '--success-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
  sidebar: '--sidebar',
  sidebarForeground: '--sidebar-foreground',
  sidebarPrimary: '--sidebar-primary',
  sidebarPrimaryForeground: '--sidebar-primary-foreground',
  sidebarAccent: '--sidebar-accent',
  sidebarAccentForeground: '--sidebar-accent-foreground',
  sidebarBorder: '--sidebar-border',
  sidebarRing: '--sidebar-ring',
  scrollbarThumb: '--scrollbar-thumb',
  scrollbarTrack: '--scrollbar-track',
}

export interface ThemePreset {
  name: string
  family: string
  mode: SkinMode
  color: (role: CSSColorRole) => string
}

const WHITE = 'oklch(1 0 0)'

// ---------------------------------------------------------------------------
// mountOS (this app's own default palette, not a real third-party theme -
// picking it is an identity operation, not a real skin swap).
// ---------------------------------------------------------------------------

const mountOSLight = {
  background: 'oklch(0.976 0.012 91.5)', card: 'oklch(0.958 0.018 92.7)', accent: 'oklch(0.916 0.012 91.5)',
  text: 'oklch(0.203 0.010 67.2)', textMuted: 'oklch(0.493 0.025 69.4)',
  primary: 'oklch(0.573 0.112 39.3)', blue: 'oklch(0.592 0.124 249.3)', green: 'oklch(0.577 0.109 154.8)',
  red: 'oklch(0.505 0.167 30.7)', yellow: 'oklch(0.566 0.106 75.3)', border: 'oklch(0.883 0.017 88.0)',
}
function mountOSLightColor(role: CSSColorRole): string {
  const p = mountOSLight
  switch (role) {
    case 'background': case 'muted': return p.background
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'sidebarForeground': case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'card': case 'popover': case 'input': case 'sidebar': return p.card
    case 'primary': case 'scrollbarThumb': return p.primary
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'secondary': case 'border': case 'sidebarBorder': return p.border
    case 'mutedForeground': return p.textMuted
    case 'label': return p.text
    case 'accent': case 'sidebarAccent': return p.accent
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.text
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

const mountOSDark = {
  background: 'oklch(0.239 0 89.9)', card: 'oklch(0.213 0 89.9)', accent: 'oklch(0.299 0 89.9)',
  text: 'oklch(0.961 0 89.9)', textMuted: 'oklch(0.640 0 89.9)',
  primary: 'oklch(0.739 0.111 91.7)', blue: 'oklch(0.728 0.119 233.6)', green: 'oklch(0.761 0.135 163.3)',
  red: 'oklch(0.606 0.110 25.1)', yellow: 'oklch(0.818 0.137 90.0)', border: 'oklch(0.321 0 89.9)',
}
function mountOSDarkColor(role: CSSColorRole): string {
  const p = mountOSDark
  switch (role) {
    case 'background': case 'input': return p.background
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'card': case 'popover': case 'muted': case 'sidebar': return p.card
    case 'primary': case 'scrollbarThumb': return p.primary
    case 'primaryForeground': return p.background
    case 'secondary': case 'border': case 'sidebarBorder': return p.border
    case 'mutedForeground': return p.textMuted
    case 'label': return p.blue
    case 'accent': case 'sidebarAccent': return p.accent
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.background
    case 'success': return p.green
    case 'successForeground': return p.background
    case 'ring': case 'sidebarRing': return p.blue
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

// ---------------------------------------------------------------------------
// Catppuccin - full published palette (github.com/catppuccin/catppuccin).
// ---------------------------------------------------------------------------

const catppuccinLatte = {
  rosewater: 'oklch(0.714 0.105 33.1)', flamingo: 'oklch(0.686 0.126 20.9)', pink: 'oklch(0.726 0.174 338.4)',
  mauve: 'oklch(0.555 0.250 297.0)', red: 'oklch(0.5505 0.2155 19.81)', maroon: 'oklch(0.625 0.197 20.3)',
  peach: 'oklch(0.692 0.204 42.4)', yellow: 'oklch(0.7140 0.1494 67.78)', green: 'oklch(0.625 0.177 140.4)',
  teal: 'oklch(0.602 0.098 201.1)', sky: 'oklch(0.682 0.145 235.4)', sapphire: 'oklch(0.648 0.107 212.9)',
  blue: 'oklch(0.559 0.226 262.1)', lavender: 'oklch(0.664 0.175 273.1)',
  text: 'oklch(0.435 0.043 279.3)', subtext1: 'oklch(0.492 0.038 279.3)', subtext0: 'oklch(0.547 0.034 279.1)',
  overlay2: 'oklch(0.601 0.030 278.7)', overlay1: 'oklch(0.654 0.027 278.1)', overlay0: 'oklch(0.708 0.024 274.6)',
  surface2: 'oklch(0.81 0.02 273.2)', surface1: 'oklch(0.808 0.017 271.2)', surface0: 'oklch(0.91 0.01 268.5)',
  base: 'oklch(0.958 0.006 264.5)', mantle: 'oklch(0.933 0.009 264.5)', crust: 'oklch(0.906 0.012 264.5)',
}
function catppuccinLatteColor(role: CSSColorRole): string {
  const p = catppuccinLatte
  switch (role) {
    case 'background': return p.base
    case 'card': case 'popover': case 'muted': case 'input': return p.surface0
    // Real surface1 - genuinely one tier darker than surface0/card, so the
    // border reads as a distinct line instead of colliding with card's own
    // fill (both were surface0 before).
    case 'secondary': case 'border': case 'sidebarBorder': return p.surface1
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground': return p.text
    case 'accentForeground': case 'sidebarForeground': return p.text
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.flamingo
    case 'primary': case 'scrollbarThumb': return p.mauve
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'mutedForeground': return p.subtext0
    case 'label': return p.flamingo
    case 'accent': return p.surface2
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.text
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    // Real "crust" - genuinely darker than base, a real recessed tier
    // Catppuccin's own spec provides, unlike most other themes here.
    // sidebarAccent uses base (not the neighboring mantle, only 0.027
    // apart from crust) so the active/hover state reads as clearly
    // distinct rather than a barely-perceptible shift.
    case 'sidebar': return p.crust
    case 'sidebarAccent': return p.base
    case 'sidebarPrimaryForeground': return p.base
    case 'scrollbarTrack': return p.base
  }
}

const catppuccinMocha = {
  rosewater: 'oklch(0.923 0.024 30.5)', flamingo: 'oklch(0.880 0.042 18.0)', pink: 'oklch(0.870 0.075 336.3)',
  mauve: 'oklch(0.787 0.119 304.8)', red: 'oklch(0.756 0.130 2.8)', maroon: 'oklch(0.782 0.090 8.8)',
  peach: 'oklch(0.824 0.101 52.6)', yellow: 'oklch(0.919 0.070 86.5)', green: 'oklch(0.858 0.109 142.7)',
  teal: 'oklch(0.858 0.079 182.7)', sky: 'oklch(0.847 0.083 210.3)', sapphire: 'oklch(0.791 0.096 228.7)',
  blue: 'oklch(0.766 0.111 259.9)', lavender: 'oklch(0.817 0.091 277.3)',
  text: 'oklch(0.879 0.043 272.3)', subtext1: 'oklch(0.817 0.040 272.9)', subtext0: 'oklch(0.751 0.040 273.9)',
  overlay2: 'oklch(0.687 0.037 274.7)', overlay1: 'oklch(0.618 0.037 276.0)', overlay0: 'oklch(0.550 0.034 277.1)',
  surface2: 'oklch(0.477 0.034 278.6)', surface1: 'oklch(0.404 0.032 280.2)', surface0: 'oklch(0.324 0.032 282.0)',
  base: 'oklch(0.243 0.030 283.9)', mantle: 'oklch(0.216 0.025 284.1)', crust: 'oklch(0.183 0.020 284.2)',
}
function catppuccinMochaColor(role: CSSColorRole): string {
  const p = catppuccinMocha
  switch (role) {
    case 'background': return p.base
    // Real surface0 is authentically lighter than base, but filling actual
    // panel/card surfaces with it read too bright next to a dark sidebar -
    // card/popover/muted stay on base; surface0 becomes the divider instead.
    case 'card': case 'popover': case 'muted': case 'input': return p.base
    case 'secondary': case 'border': case 'sidebarBorder': return p.surface0
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'primary': case 'scrollbarThumb': return p.mauve
    case 'primaryForeground': return p.base
    // Catppuccin's own overlay0 tier is its "comment"/de-emphasized text
    // role - a real match, not the subtext0 tier name might suggest.
    case 'mutedForeground': return p.overlay0
    case 'label': return p.blue
    case 'accent': return p.surface1
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.base
    case 'success': return p.green
    case 'successForeground': return p.base
    case 'ring': case 'sidebarRing': return p.blue
    // Real "crust" - genuinely darker than base. sidebarAccent uses base
    // (not the neighboring mantle, only 0.033 apart from crust) so the
    // active/hover state reads as clearly distinct.
    case 'sidebar': return p.crust
    case 'sidebarAccent': return p.base
    case 'sidebarPrimaryForeground': return p.base
    case 'scrollbarTrack': return p.base
  }
}

// ---------------------------------------------------------------------------
// Dracula / Alucard (draculatheme.com/spec).
// ---------------------------------------------------------------------------

const dracula = {
  background: 'oklch(0.288 0.022 277.5)', selection: 'oklch(0.403 0.032 277.8)',
  comment: 'oklch(0.560 0.080 270.1)', foreground: 'oklch(0.977 0.008 106.5)',
  red: 'oklch(0.682 0.206 24.4)', orange: 'oklch(0.834 0.124 66.6)', yellow: 'oklch(0.955 0.134 112.8)',
  green: 'oklch(0.871 0.220 148.0)', cyan: 'oklch(0.8826 0.0934 212.85)', purple: 'oklch(0.742 0.149 301.9)',
  pink: 'oklch(0.755 0.183 346.8)',
}
function draculaColor(role: CSSColorRole): string {
  const p = dracula
  switch (role) {
    case 'background': case 'input': return p.background
    // Real Selection is authentically lighter than Background, but filling
    // actual panel/card surfaces with it read too bright next to a dark
    // sidebar - card/popover/muted stay on Background; Selection becomes
    // the divider instead.
    case 'card': case 'popover': case 'muted': return p.background
    case 'secondary': case 'border': case 'sidebarBorder': return p.selection
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.foreground
    case 'primary': case 'scrollbarThumb': return p.purple
    case 'primaryForeground': return p.background
    case 'mutedForeground': return p.comment
    case 'label': return p.cyan
    // Real spec has only Background/Selection/Comment as non-accent tones -
    // no fourth tier exists, so accent repeats Selection.
    case 'accent': return p.selection
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.background
    case 'success': return p.green
    case 'successForeground': return p.background
    case 'ring': case 'sidebarRing': return p.cyan
    // No real tone exists darker than Background - sidebar repeats it.
    case 'sidebar': return p.background
    case 'sidebarAccent': return p.selection
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

const alucard = {
  background: 'oklch(0.9869 0.0214 95.28)',
  // Real Selection #CFCFDE - this was previously stored as a "darkened
  // Background" approximation (same 95.28deg hue), not the real swatch,
  // which is a cool lavender-gray (286deg), a different hue family entirely.
  // The real spec has no separate "border" tone - Dracula's own pattern.
  selection: 'oklch(0.8590 0.0206 285.96)',
  selection2: 'oklch(0.91 0.02 286.07)',
  comment: 'oklch(0.5084 0.0410 97.06)', foreground: 'oklch(0.2393 0.0000 89.88)',
  red: 'oklch(0.5632 0.1844 30.08)', orange: 'oklch(0.521 0.131 48.5)', yellow: 'oklch(0.5440 0.1044 93.88)',
  green: 'oklch(0.4784 0.1547 141.90)', cyan: 'oklch(0.4961 0.1061 236.17)', purple: 'oklch(0.5091 0.1878 287.15)',
  pink: 'oklch(0.468 0.177 5.0)',
}
function alucardColor(role: CSSColorRole): string {
  const p = alucard
  switch (role) {
    // Real Background (#FFFBEB, warm cream) and Selection (#CFCFDE, cool
    // lavender) are genuinely different hue families in Alucard's own spec,
    // unlike M365 Princess's single-family background/card/border ramp.
    // Since Selection is already the dominant tone across card/sidebar/
    // panel, background matches it too rather than reading as a mismatched
    // warm patch against an otherwise cool UI; Background is repurposed as
    // the structural border/accent tone instead, which keeps it real (not
    // invented) and keeps borders visible against card's own fill.
    case 'background': return p.selection2
    case 'card': case 'popover': case 'muted': case 'input': return p.selection
    case 'secondary': case 'accent': return p.cyan
    case 'border': case 'sidebarBorder': return p.background
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'sidebarForeground': case 'sidebarPrimary': return p.foreground
    case 'sidebarAccentForeground': return WHITE
    case 'primary': case 'scrollbarThumb': return p.purple
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'mutedForeground': return p.cyan
    case 'label': return p.cyan
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.foreground
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.cyan
    // Same 2-tone constraint: sidebar repeats Selection (matches card, the
    // darkest real option) and sidebarAccent repeats Background - the
    // border split above already keeps sidebarBorder distinct from both.
    case 'sidebar': return p.selection
    case 'sidebarAccent': return p.cyan
    case 'sidebarPrimaryForeground': return p.background
    // Tracks the new background (Selection) so the scrollbar track blends
    // with the page instead of the old cream tone.
    case 'scrollbarTrack': return p.selection
  }
}

// ---------------------------------------------------------------------------
// Gruvbox (github.com/morhetz/gruvbox, colors/gruvbox.vim).
// ---------------------------------------------------------------------------

const gruvboxDark = {
  bg0Hard: 'oklch(0.241 0.005 219.7)', bg0: 'oklch(0.277 0 89.9)', bg0Soft: 'oklch(0.311 0.003 48.6)',
  bg1: 'oklch(0.344 0.007 48.5)', bg2: 'oklch(0.411 0.012 51.9)', bg3: 'oklch(0.482 0.018 61.0)', bg4: 'oklch(0.550 0.023 62.6)',
  fg: 'oklch(0.894 0.057 89.2)', fgMuted: 'oklch(0.619 0.029 67.3)',
  red: 'oklch(0.546 0.203 28.7)', redBright: 'oklch(0.660 0.218 30.4)',
  green: 'oklch(0.656 0.135 109.1)', greenBright: 'oklch(0.765 0.158 110.8)',
  yellow: 'oklch(0.725 0.143 77.7)', yellowBright: 'oklch(0.832 0.159 83.0)',
  blue: 'oklch(0.576 0.066 199.5)', blueBright: 'oklch(0.693 0.042 169.8)',
  purple: 'oklch(0.597 0.111 352.2)', purpleBright: 'oklch(0.705 0.098 2.2)',
  aqua: 'oklch(0.645 0.094 145.3)', aquaBright: 'oklch(0.756 0.108 137.7)',
  orange: 'oklch(0.622 0.171 45.8)', orangeBright: 'oklch(0.731 0.182 51.7)',
  gray: 'oklch(0.619 0.029 67.3)',
}
function gruvboxDarkColor(role: CSSColorRole): string {
  const p = gruvboxDark
  switch (role) {
    case 'background': return p.bg0
    // Real bg1 is authentically lighter than bg0, but filling actual
    // panel/card surfaces with it read too bright next to a dark sidebar -
    // card/popover/muted stay on bg0; bg1 becomes the divider instead.
    case 'card': case 'popover': case 'muted': case 'input': return p.bg0
    case 'secondary': case 'border': case 'sidebarBorder': return p.bg1
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.fg
    case 'primary': case 'label': case 'scrollbarThumb': return p.yellow
    case 'primaryForeground': return p.bg0Hard
    case 'mutedForeground': return p.fgMuted
    case 'accent': return p.bg2
    case 'destructive': return p.red
    case 'warning': return p.orange
    case 'warningForeground': return p.bg0
    case 'success': return p.green
    case 'successForeground': return p.bg0
    case 'ring': case 'sidebarRing': return p.blue
    // Real "bg0_h" (hard) - Gruvbox's own richest ramp of any theme here (7
    // bg tones), a genuine tier darker than bg0.
    case 'sidebar': return p.bg0Hard
    case 'sidebarAccent': return p.bg0
    case 'sidebarPrimaryForeground': return p.bg0
    case 'scrollbarTrack': return p.bg0
  }
}

const gruvboxLight = {
  light0Hard: 'oklch(0.965 0.039 100.9)', light0: 'oklch(0.956 0.055 96.2)', light0Soft: 'oklch(0.922 0.055 92.5)',
  light1: 'oklch(0.894 0.057 89.2)', light2: 'oklch(0.825 0.051 85.1)', light3: 'oklch(0.756 0.041 82.3)', light4: 'oklch(0.690 0.035 76.3)',
  fg: 'oklch(0.344 0.007 48.5)', fgMuted: 'oklch(0.619 0.029 67.3)',
  red: 'oklch(0.546 0.203 28.7)', green: 'oklch(0.656 0.135 109.1)', yellow: 'oklch(0.725 0.143 77.7)',
  blue: 'oklch(0.576 0.066 199.5)', purple: 'oklch(0.597 0.111 352.2)', aqua: 'oklch(0.645 0.094 145.3)', orange: 'oklch(0.622 0.171 45.8)',
}
function gruvboxLightColor(role: CSSColorRole): string {
  const p = gruvboxLight
  switch (role) {
    case 'background': return p.light0
    case 'card': case 'popover': case 'muted': case 'input': return p.light0Soft
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground': return p.fg
    case 'accentForeground': case 'sidebarPrimary': return p.fg
    case 'sidebarAccentForeground': return p.green
    case 'sidebarForeground': return p.fg
    case 'primary': case 'scrollbarThumb': return p.yellow
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'secondary': case 'border': return p.light2
    case 'mutedForeground': return p.fgMuted
    case 'label': return p.green
    case 'accent': return p.light3
    case 'destructive': return p.red
    case 'warning': return p.orange
    case 'warningForeground': return p.fg
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    // light2 (already the border swatch) is already darker than card - a
    // real, already-established tone, genuinely reusable as the sidebar.
    // sidebarBorder uses light3 (one tier further) so it doesn't collide
    // with the sidebar's own fill.
    case 'sidebar': return p.light2
    case 'sidebarBorder': return p.light3
    case 'sidebarAccent': return p.light1
    case 'sidebarPrimaryForeground': return p.light0
    case 'scrollbarTrack': return p.light0
  }
}

// ---------------------------------------------------------------------------
// M365 Princess - no published external spec found (searched this session,
// nothing turned up); this reads as a mountOS-original preset, not a real
// third-party theme, so there's no source palette to expand it against.
// ---------------------------------------------------------------------------

const m365PrincessDark = {
  background: 'oklch(0.236 0.034 293.8)', card: 'oklch(0.284 0.051 291.0)', border: 'oklch(0.354 0.054 293.9)',
  text: 'oklch(0.948 0.011 308.3)', textMuted: 'oklch(0.624 0.036 298.7)',
  primary: 'oklch(0.506 0.171 332.8)', blue: 'oklch(0.765 0.069 232.8)', green: 'oklch(0.730 0.112 188.3)',
  red: 'oklch(0.650 0.152 8.3)', yellow: 'oklch(0.792 0.119 42.3)',
}
function m365PrincessDarkColor(role: CSSColorRole): string {
  const p = m365PrincessDark
  switch (role) {
    case 'background': case 'input': return p.background
    // No external spec, but the same "panel too bright next to a dark
    // sidebar" issue applies - card/popover/muted stay on background; the
    // preset's own lighter "card" tone becomes the divider instead.
    case 'card': case 'popover': case 'muted': return p.background
    case 'secondary': case 'border': case 'sidebarBorder': return p.card
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'primary': case 'scrollbarThumb': return p.primary
    case 'primaryForeground': return p.background
    case 'mutedForeground': return p.textMuted
    case 'label': return p.blue
    case 'accent': return p.border
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.background
    case 'success': return p.green
    case 'successForeground': return p.background
    case 'ring': case 'sidebarRing': return p.blue
    // No external spec, no darker tone to source - sidebar repeats background.
    case 'sidebar': return p.background
    case 'sidebarAccent': return p.card
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

const m365PrincessLight = {
  background: 'oklch(0.976 0.008 349.2)', card: 'oklch(0.941 0.014 343.2)', border: 'oklch(0.855 0.031 339.3)',
  text: 'oklch(0.275 0.059 301.4)', textMuted: 'oklch(0.393 0.186 304.8)',
  primary: 'oklch(0.506 0.171 332.8)', blue: 'oklch(0.489 0.080 242.8)', green: 'oklch(0.540 0.091 200.7)',
  red: 'oklch(0.561 0.192 35.9)', yellow: 'oklch(0.700 0.108 50.9)',
}
function m365PrincessLightColor(role: CSSColorRole): string {
  const p = m365PrincessLight
  switch (role) {
    case 'background': return p.background
    case 'card': case 'popover': case 'muted': case 'input': return p.card
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'sidebarForeground': case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'primary': case 'scrollbarThumb': return p.primary
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'secondary': case 'border': return p.border
    case 'mutedForeground': return p.textMuted
    case 'label': return p.blue
    case 'accent': return p.background
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.text
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    // border is already darker than card - reusable as the sidebar anchor.
    // sidebarBorder uses background (lighter still) so it doesn't collide
    // with the sidebar's own fill.
    case 'sidebar': return p.border
    case 'sidebarBorder': return p.background
    case 'sidebarAccent': return p.card
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

// ---------------------------------------------------------------------------
// Nord (nordtheme.com/docs/colors-and-palettes) - full 16-tone palette.
// ---------------------------------------------------------------------------

const nord = {
  nord0: 'oklch(0.324 0.023 264.2)', nord1: 'oklch(0.379 0.029 266.5)', nord2: 'oklch(0.416 0.032 264.1)', nord3: 'oklch(0.452 0.035 264.1)',
  nord4: 'oklch(0.899 0.016 262.7)', nord5: 'oklch(0.933 0.010 261.8)', nord6: 'oklch(0.951 0.007 260.7)',
  nord7: 'oklch(0.763 0.048 194.5)', nord8: 'oklch(0.775 0.062 217.5)', nord9: 'oklch(0.697 0.059 248.7)', nord10: 'oklch(0.594 0.077 254.0)',
  nord11: 'oklch(0.606 0.121 15.3)', nord12: 'oklch(0.693 0.096 38.2)', nord13: 'oklch(0.855 0.089 84.1)', nord14: 'oklch(0.768 0.075 131.1)', nord15: 'oklch(0.692 0.062 332.7)',
  textMuted: 'oklch(0.6251 0.0408 263.48)',
}
function nordColor(role: CSSColorRole): string {
  const p = nord
  switch (role) {
    case 'background': return p.nord0
    // Real nord1 is authentically lighter than nord0, but filling actual
    // panel/card surfaces with it read too bright next to a dark sidebar -
    // card/popover/muted stay on nord0; nord1 becomes the divider instead.
    case 'card': case 'popover': case 'muted': case 'input': return p.nord0
    case 'secondary': case 'border': case 'sidebarBorder': return p.nord1
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.nord6
    case 'primary': case 'label': case 'scrollbarThumb': return p.nord8
    case 'primaryForeground': return p.nord0
    case 'mutedForeground': return p.textMuted
    case 'accent': return p.nord2
    case 'destructive': return p.nord11
    case 'warning': return p.nord13
    case 'warningForeground': return p.nord0
    case 'success': return p.nord14
    case 'successForeground': return p.nord0
    case 'ring': case 'sidebarRing': return p.nord9
    // nord0 IS the darkest official Polar Night tone - no fourth tier
    // exists below it, so sidebar repeats background.
    case 'sidebar': return p.nord0
    case 'sidebarAccent': return p.nord1
    case 'sidebarPrimaryForeground': return p.nord0
    case 'scrollbarTrack': return p.nord0
  }
}

// ---------------------------------------------------------------------------
// Solarized (ethanschoonover.com/solarized) - 8 monotones + 8 accents,
// shared between modes; only which monotone plays which role flips.
// ---------------------------------------------------------------------------

const solarized = {
  base03: 'oklch(0.267 0.049 219.8)', base02: 'oklch(0.309 0.052 219.7)', base01: 'oklch(0.523 0.028 219.1)', base00: 'oklch(0.568 0.029 221.9)',
  base0: 'oklch(0.654 0.020 205.3)', base1: 'oklch(0.698 0.016 196.8)', base2: 'oklch(0.931 0.026 92.4)', base3: 'oklch(0.974 0.026 90.1)',
  yellow: 'oklch(0.654 0.134 85.7)', orange: 'oklch(0.581 0.173 39.5)', red: 'oklch(0.586 0.206 27.1)', magenta: 'oklch(0.592 0.202 355.9)',
  violet: 'oklch(0.582 0.126 279.1)', blue: 'oklch(0.615 0.139 244.9)', cyan: 'oklch(0.644 0.102 187.4)', green: 'oklch(0.644 0.151 118.6)',
}
function solarizedDarkColor(role: CSSColorRole): string {
  const p = solarized
  switch (role) {
    case 'background': return p.base03
    // Real base02 is authentically lighter than base03, but filling actual
    // panel/card surfaces with it read too bright next to a dark sidebar -
    // card/popover/muted stay on base03; base02 becomes the divider instead.
    case 'card': case 'popover': case 'muted': case 'input': return p.base03
    case 'secondary': case 'border': case 'sidebarBorder': return p.base02
    // Spec designates only base03/base02 as background-role tones - base01/
    // base00/base0/base1 are content (text) tones, never backgrounds, in
    // either mode.
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.base1
    case 'primary': case 'scrollbarThumb': return p.yellow
    case 'primaryForeground': return p.base03
    // Dark mode's most-emphasized content tone is base01, not base00, per
    // Solarized's own usage table.
    case 'mutedForeground': return p.base01
    // No literal swatch here clears 4.5:1 against base02/base03 - base1 is
    // the closest real option, an inherent limit of Solarized's own
    // deliberately low-contrast palette.
    case 'label': return p.base1
    case 'accent': return p.base02
    case 'destructive': return p.red
    case 'warning': return p.orange
    case 'warningForeground': return p.base03
    case 'success': return p.green
    case 'successForeground': return p.base03
    case 'ring': case 'sidebarRing': return p.blue
    // base03 IS the darkest background-role tone - no fourth tier exists,
    // so sidebar repeats background.
    case 'sidebar': return p.base03
    case 'sidebarAccent': return p.base02
    case 'sidebarPrimaryForeground': return p.base03
    case 'scrollbarTrack': return p.base03
  }
}
function solarizedLightColor(role: CSSColorRole): string {
  const p = solarized
  switch (role) {
    case 'background': return p.base3
    case 'card': case 'popover': case 'muted': case 'input': return p.base2
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'sidebarForeground': case 'sidebarPrimary': case 'sidebarAccentForeground': return p.base01
    case 'primary': case 'scrollbarThumb': return p.yellow
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    // Only 2 real background-role tones exist (base3/base2) - border and
    // accent need to differ from card's own fill (base2) or they're
    // invisible against it. base3 is the only other option, same
    // resolution used for Solarized Dark/Alucard's identical constraint.
    case 'secondary': case 'border': case 'accent': return p.base3
    // Mirror of the dark-mode fix: light mode's most-emphasized tone is
    // base01, not base00.
    case 'mutedForeground': return p.base1
    // No literal swatch clears 4.5:1 against base2/base3 - base01 gets
    // closest (4.40:1), an inherent limit of Solarized's own palette.
    case 'label': return p.base01
    case 'destructive': return p.red
    case 'warning': return p.orange
    case 'warningForeground': return p.base01
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    // sidebar repeats card's own base2 (the darkest real option); sidebarBorder
    // uses base3 so it doesn't collide with the sidebar's own fill.
    case 'sidebar': return p.base2
    case 'sidebarBorder': return p.base3
    case 'sidebarAccent': return p.base3
    case 'sidebarPrimaryForeground': return p.base3
    case 'scrollbarTrack': return p.base3
  }
}

// ---------------------------------------------------------------------------
// Tokyo Night (tokyo-night/tokyo-night-vscode-theme + terminalcolors.com) -
// dark ("Night") variant verified; Light/"Day" variant not independently
// confirmed this session, so it stays close to its prior hand-tuned values.
// ---------------------------------------------------------------------------

const tokyoNight = {
  bgDark: 'oklch(0.204 0.016 284.9)', bg: 'oklch(0.226 0.021 280.5)', bgHighlight: 'oklch(0.306 0.037 273.2)',
  sidebarBg: 'oklch(0.261 0.034 274.2)', border: 'oklch(0.387 0.054 273.9)',
  fg: 'oklch(0.846 0.061 274.8)', comment: 'oklch(0.496 0.068 274.4)',
  red: 'oklch(0.723 0.159 10.3)', green: 'oklch(0.795 0.139 130.1)', yellow: 'oklch(0.784 0.106 75.4)',
  blue: 'oklch(0.719 0.132 264.2)', magenta: 'oklch(0.751 0.134 299.5)', cyan: 'oklch(0.7537 0.1243 213.18)', white: 'oklch(0.767 0.054 275.5)',
}
function tokyoNightColor(role: CSSColorRole): string {
  const p = tokyoNight
  switch (role) {
    case 'background': return p.bg
    // Real bg_highlight is authentically lighter than bg, but filling
    // actual panel/card surfaces with it read too bright next to a dark
    // sidebar - card/popover/muted stay on bg; bg_highlight becomes the
    // divider instead.
    case 'card': case 'popover': case 'muted': case 'input': return p.bg
    case 'secondary': case 'border': case 'sidebarBorder': return p.bgHighlight
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'destructiveForeground': case 'sidebarForeground':
    case 'sidebarPrimary': case 'sidebarAccentForeground': return p.fg
    case 'primary': case 'label': case 'scrollbarThumb': return p.blue
    case 'primaryForeground': return p.bg
    case 'mutedForeground': return p.comment
    case 'accent': return p.sidebarBg
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.bg
    case 'success': return p.green
    case 'successForeground': return p.bg
    case 'ring': case 'sidebarRing': return p.cyan
    // Real "bg_dark" - tokyonight's own even-darker background variant,
    // giving a genuine tier below the true "bg".
    case 'sidebar': return p.bgDark
    case 'sidebarAccent': return p.bg
    case 'sidebarPrimaryForeground': return p.bg
    case 'scrollbarTrack': return p.bg
  }
}

const tokyoNightLight = {
  background: 'oklch(0.877 0.007 277.2)', card: 'oklch(0.846 0.007 277.1)', border: 'oklch(0.774 0.006 274.9)',
  text: 'oklch(0.359 0.051 273.2)', textMuted: 'oklch(0.51 0.01 272.61)',
  primary: 'oklch(0.448 0.097 260.3)', blue: 'oklch(0.474 0.076 212.3)', green: 'oklch(0.452 0.074 129.9)',
  red: 'oklch(0.480 0.100 9.5)', yellow: 'oklch(0.523 0.104 71.0)',
}
function tokyoNightLightColor(role: CSSColorRole): string {
  const p = tokyoNightLight
  switch (role) {
    case 'background': return p.background
    case 'card': case 'popover': case 'muted': case 'input': return p.card
    case 'foreground': case 'cardForeground': case 'popoverForeground': case 'secondaryForeground':
    case 'accentForeground': case 'sidebarForeground': case 'sidebarPrimary': case 'sidebarAccentForeground': return p.text
    case 'primary': case 'label': case 'scrollbarThumb': return p.primary
    case 'primaryForeground': case 'destructiveForeground': return WHITE
    case 'secondary': case 'border': return p.border
    case 'mutedForeground': return p.textMuted
    case 'accent': return p.background
    case 'destructive': return p.red
    case 'warning': return p.yellow
    case 'warningForeground': return p.text
    case 'success': return p.green
    case 'successForeground': return WHITE
    case 'ring': case 'sidebarRing': return p.blue
    // No confidently-sourced extra tier for the Storm/Day light variant -
    // border is already darker than card, reused as the sidebar anchor.
    // sidebarBorder uses card (lighter still) so it doesn't collide with
    // the sidebar's own fill.
    case 'sidebar': return p.border
    case 'sidebarBorder': return p.card
    case 'sidebarAccent': return p.card
    case 'sidebarPrimaryForeground': return p.background
    case 'scrollbarTrack': return p.background
  }
}

// ---------------------------------------------------------------------------

export const themePresets: ThemePreset[] = [
  { name: 'mountOS Light', family: '', mode: 'light', color: mountOSLightColor },
  { name: 'mountOS Dark', family: '', mode: 'dark', color: mountOSDarkColor },
  { name: 'Catppuccin Latte', family: 'Catppuccin', mode: 'light', color: catppuccinLatteColor },
  { name: 'Catppuccin Mocha', family: 'Catppuccin', mode: 'dark', color: catppuccinMochaColor },
  { name: 'Dracula', family: 'Dracula', mode: 'dark', color: draculaColor },
  // Alucard: official Dracula light variant (https://draculatheme.com)
  { name: 'Alucard', family: 'Dracula', mode: 'light', color: alucardColor },
  { name: 'Gruvbox Dark', family: 'Gruvbox', mode: 'dark', color: gruvboxDarkColor },
  { name: 'Gruvbox Light', family: 'Gruvbox', mode: 'light', color: gruvboxLightColor },
  { name: 'M365 Princess Dark', family: 'M365 Princess', mode: 'dark', color: m365PrincessDarkColor },
  { name: 'M365 Princess Light', family: 'M365 Princess', mode: 'light', color: m365PrincessLightColor },
  { name: 'Nord', family: '', mode: 'dark', color: nordColor },
  { name: 'Solarized Dark', family: 'Solarized', mode: 'dark', color: solarizedDarkColor },
  { name: 'Solarized Light', family: 'Solarized', mode: 'light', color: solarizedLightColor },
  { name: 'Tokyo Night', family: 'Tokyo Night', mode: 'dark', color: tokyoNightColor },
  { name: 'Tokyo Night Light', family: 'Tokyo Night', mode: 'light', color: tokyoNightLightColor },
]

export function presetsForMode(mode: SkinMode): ThemePreset[] {
  return themePresets.filter((p) => p.mode === mode)
}

export function defaultSkin(mode: SkinMode): string {
  return mode === 'dark' ? 'mountOS Dark' : 'mountOS Light'
}

export function findPreset(name: string): ThemePreset | undefined {
  return themePresets.find((p) => p.name === name)
}

export function familyVariant(name: string, targetMode: SkinMode): ThemePreset | undefined {
  const current = findPreset(name)
  if (!current || !current.family) return undefined
  return themePresets.find((p) => p.family === current.family && p.mode === targetMode)
}

export function applySkin(preset: ThemePreset) {
  const s = document.documentElement.style
  for (const role of Object.keys(CSS_VAR_NAMES) as CSSColorRole[]) {
    s.setProperty(CSS_VAR_NAMES[role], preset.color(role))
  }
}

export function clearSkin() {
  const s = document.documentElement.style
  Object.values(CSS_VAR_NAMES).forEach((cssVar) => s.removeProperty(cssVar))
}
