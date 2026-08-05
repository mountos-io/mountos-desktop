// Ported from mountos-admin-client/src/lib/core/themes.ts: the same 15 named
// color-skin presets (Catppuccin, Dracula, Gruvbox, M365 Princess, Nord,
// Solarized, Tokyo Night, plus a default pair), so users of either app
// recognize the same palette by name. `applySkin`/`clearSkin` are trimmed to
// only the CSS custom properties this app's app.css actually defines/maps
// (@theme inline), no --sidebar-*, --chart-*, --scrollbar-track,
// --warning-foreground, or --success-foreground here, unlike admin-client.
export type SkinMode = 'light' | 'dark'

export interface SkinColors {
  background: string
  cardBg: string
  textPrimary: string
  textSecondary: string
  primary: string
  accentBlue: string
  accentGreen: string
  dangerRed: string
  warningYellow: string
  border: string
  // Structural-label text tone. A literal swatch already in this theme's
  // palette (never synthesized), picked so it neither blends into muted text
  // nor borrows a color already meaning "interactive"/"destructive" elsewhere.
  labelForeground: string
  // One more elevation step above cardBg, below border (used for --accent).
  // A literal swatch from the theme's own published surface ramp where one
  // exists (Gruvbox bg3, Catppuccin surface1, Nord's 4th Polar Night tone,
  // Tokyo Night's sidebar background); themes whose real spec has no further
  // background tier (Dracula, Solarized, Alucard) repeat cardBg/border here
  // rather than invent a color that doesn't exist in the real theme.
  surfaceRaised: string
}

export interface ThemePreset {
  name: string
  family: string
  mode: SkinMode
  colors: SkinColors
}

const WHITE = 'oklch(1 0 0)'

export const themePresets: ThemePreset[] = [
  {
    // This app's own default palette (app.css :root), picking it is an
    // identity operation, not a real skin swap.
    // Verbatim from admin-client's themes.ts, its "mountOS Light/Dark"
    // presets are NOT the same as its own app.css base tokens (confirmed by
    // direct comparison: base .dark background is L 0.07, this preset is L
    // 0.239), so matching admin-client requires copying these preset values
    // exactly rather than substituting this app's own base tokens as an
    // "identity" skin, that substitution was the bug (gui rendered
    // noticeably darker than admin-client's actual default).
    name: 'mountOS Light',
    family: '',
    mode: 'light',
    colors: {
      background: 'oklch(0.976 0.012 91.5)',
      cardBg: 'oklch(0.958 0.018 92.7)',
      textPrimary: 'oklch(0.203 0.010 67.2)',
      textSecondary: 'oklch(0.493 0.025 69.4)',
      primary: 'oklch(0.573 0.112 39.3)',
      accentBlue: 'oklch(0.592 0.124 249.3)',
      accentGreen: 'oklch(0.577 0.109 154.8)',
      dangerRed: 'oklch(0.505 0.167 30.7)',
      warningYellow: 'oklch(0.566 0.106 75.3)',
      border: 'oklch(0.883 0.017 88.0)',
      labelForeground: 'oklch(0.203 0.010 67.2)',
      surfaceRaised: 'oklch(0.916 0.012 91.5)',
    },
  },
  {
    name: 'mountOS Dark',
    family: '',
    mode: 'dark',
    colors: {
      background: 'oklch(0.239 0 89.9)',
      cardBg: 'oklch(0.213 0 89.9)',
      textPrimary: 'oklch(0.961 0 89.9)',
      textSecondary: 'oklch(0.640 0 89.9)',
      primary: 'oklch(0.739 0.111 91.7)',
      accentBlue: 'oklch(0.728 0.119 233.6)',
      accentGreen: 'oklch(0.761 0.135 163.3)',
      dangerRed: 'oklch(0.606 0.110 25.1)',
      warningYellow: 'oklch(0.818 0.137 90.0)',
      border: 'oklch(0.321 0 89.9)',
      labelForeground: 'oklch(0.728 0.119 233.6)',
      surfaceRaised: 'oklch(0.299 0 89.9)',
    },
  },
  {
    name: 'Catppuccin Latte',
    family: 'Catppuccin',
    mode: 'light',
    colors: {
      background: 'oklch(0.958 0.006 264.5)',
      // Real "surface0" #ccd0da (same value already correctly used for
      // border below; cardBg was too close to background to read as a
      // distinct surface).
      cardBg: 'oklch(0.857 0.014 268.5)',
      textPrimary: 'oklch(0.435 0.043 279.3)',
      textSecondary: 'oklch(0.547 0.034 279.1)',
      primary: 'oklch(0.555 0.250 297.0)',
      accentBlue: 'oklch(0.559 0.226 262.1)',
      accentGreen: 'oklch(0.625 0.177 140.4)',
      dangerRed: 'oklch(0.5505 0.2155 19.81)',
      warningYellow: 'oklch(0.7140 0.1494 67.78)',
      border: 'oklch(0.857 0.014 268.5)',
      labelForeground: 'oklch(0.435 0.043 279.3)',
      // Real "surface1"/"surface2" #bcc0cc / #acb0be.
      surfaceRaised: 'oklch(0.808 0.017 271.2)',
    },
  },
  {
    name: 'Catppuccin Mocha',
    family: 'Catppuccin',
    mode: 'dark',
    colors: {
      background: 'oklch(0.243 0.030 283.9)',
      // Real "surface0" #313244 (border already had this right; cardBg was
      // a separately fabricated, too-dark value that doesn't exist in the
      // published Catppuccin Mocha palette).
      cardBg: 'oklch(0.324 0.032 282.0)',
      textPrimary: 'oklch(0.879 0.043 272.3)',
      textSecondary: 'oklch(0.550 0.034 277.1)',
      primary: 'oklch(0.787 0.119 304.8)',
      accentBlue: 'oklch(0.766 0.111 259.9)',
      accentGreen: 'oklch(0.858 0.109 142.7)',
      dangerRed: 'oklch(0.756 0.130 2.8)',
      warningYellow: 'oklch(0.919 0.070 86.5)',
      border: 'oklch(0.324 0.032 282.0)',
      labelForeground: 'oklch(0.766 0.111 259.9)',
      // Real "surface1"/"surface2" #45475a / #585b70.
      surfaceRaised: 'oklch(0.404 0.032 280.2)',
    },
  },
  {
    name: 'Dracula',
    family: 'Dracula',
    mode: 'dark',
    colors: {
      background: 'oklch(0.288 0.022 277.5)',
      // Real "Selection" #44475a per draculatheme.com/spec (same value
      // already correctly used for border below; cardBg was a separately
      // fabricated, too-dark value).
      cardBg: 'oklch(0.403 0.032 277.8)',
      textPrimary: 'oklch(0.977 0.008 106.5)',
      textSecondary: 'oklch(0.560 0.080 270.1)',
      primary: 'oklch(0.742 0.149 301.9)',
      accentBlue: 'oklch(0.8826 0.0934 212.85)',
      accentGreen: 'oklch(0.871 0.220 148.0)',
      dangerRed: 'oklch(0.682 0.206 24.4)',
      warningYellow: 'oklch(0.955 0.134 112.8)',
      border: 'oklch(0.403 0.032 277.8)',
      labelForeground: 'oklch(0.8826 0.0934 212.85)',
      // Dracula's real spec has only 3 non-accent tones (Background,
      // Selection, Comment/Current Line) - all already in use above, so no
      // further real tier exists; repeats cardBg/border rather than invent one.
      surfaceRaised: 'oklch(0.403 0.032 277.8)',
    },
  },
  {
    // Alucard: official Dracula light variant (https://draculatheme.com)
    name: 'Alucard',
    family: 'Dracula',
    mode: 'light',
    colors: {
      background: 'oklch(0.9869 0.0214 95.28)',
      cardBg: 'oklch(0.9649 0.0214 95.28)',
      textPrimary: 'oklch(0.2393 0.0000 89.88)',
      textSecondary: 'oklch(0.5084 0.0410 97.06)',
      primary: 'oklch(0.5091 0.1878 287.15)',
      accentBlue: 'oklch(0.4961 0.1061 236.17)',
      accentGreen: 'oklch(0.4784 0.1547 141.90)',
      dangerRed: 'oklch(0.5632 0.1844 30.08)',
      warningYellow: 'oklch(0.5440 0.1044 93.88)',
      border: 'oklch(0.8590 0.0206 285.96)',
      labelForeground: 'oklch(0.4961 0.1061 236.17)',
      // Alucard's real spec has only Background/Selection/Comment as
      // non-accent tones, both already in use above; repeats them.
      surfaceRaised: 'oklch(0.9649 0.0214 95.28)',
    },
  },
  {
    name: 'Gruvbox Dark',
    family: 'Gruvbox',
    mode: 'dark',
    colors: {
      // Real bg0 #282828 (the stored value had drifted to a Solarized-hued
      // 219.7deg that doesn't exist anywhere in Gruvbox's own palette;
      // cardBg/border below were each one rung too dark as a result — bg0
      // was squatting in cardBg's slot, bg1 in border's).
      background: 'oklch(0.277 0 89.9)',
      cardBg: 'oklch(0.344 0.007 48.5)',
      textPrimary: 'oklch(0.894 0.057 89.2)',
      textSecondary: 'oklch(0.619 0.029 67.3)',
      primary: 'oklch(0.725 0.143 77.7)',
      accentBlue: 'oklch(0.576 0.066 199.5)',
      accentGreen: 'oklch(0.656 0.135 109.1)',
      dangerRed: 'oklch(0.546 0.203 28.7)',
      warningYellow: 'oklch(0.622 0.171 45.8)',
      border: 'oklch(0.411 0.012 51.9)',
      labelForeground: 'oklch(0.725 0.143 77.7)',
      // Real "bg3"/"bg4" #665c54 / #7c6f64 - Gruvbox's own background ramp
      // goes to bg4, giving genuine extra elevation tiers past border/bg2.
      surfaceRaised: 'oklch(0.482 0.018 61.0)',
    },
  },
  {
    name: 'Gruvbox Light',
    family: 'Gruvbox',
    mode: 'light',
    colors: {
      background: 'oklch(0.956 0.055 96.2)',
      cardBg: 'oklch(0.922 0.055 92.5)',
      textPrimary: 'oklch(0.344 0.007 48.5)',
      textSecondary: 'oklch(0.619 0.029 67.3)',
      primary: 'oklch(0.725 0.143 77.7)',
      accentBlue: 'oklch(0.576 0.066 199.5)',
      accentGreen: 'oklch(0.656 0.135 109.1)',
      dangerRed: 'oklch(0.546 0.203 28.7)',
      warningYellow: 'oklch(0.622 0.171 45.8)',
      border: 'oklch(0.825 0.051 85.1)',
      labelForeground: 'oklch(0.344 0.007 48.5)',
      // Real "light3"/"light4" #bdae93 / #a89984.
      surfaceRaised: 'oklch(0.756 0.041 82.3)',
    },
  },
  {
    name: 'M365 Princess Dark',
    family: 'M365 Princess',
    mode: 'dark',
    colors: {
      background: 'oklch(0.236 0.034 293.8)',
      cardBg: 'oklch(0.284 0.051 291.0)',
      textPrimary: 'oklch(0.948 0.011 308.3)',
      textSecondary: 'oklch(0.624 0.036 298.7)',
      primary: 'oklch(0.506 0.171 332.8)',
      accentBlue: 'oklch(0.765 0.069 232.8)',
      accentGreen: 'oklch(0.730 0.112 188.3)',
      dangerRed: 'oklch(0.650 0.152 8.3)',
      warningYellow: 'oklch(0.792 0.119 42.3)',
      border: 'oklch(0.354 0.054 293.9)',
      labelForeground: 'oklch(0.765 0.069 232.8)',
      // No published external spec for this preset (mountOS-original, not a
      // real third-party theme) - repeats cardBg/border rather than invent.
      surfaceRaised: 'oklch(0.284 0.051 291.0)',
    },
  },
  {
    name: 'M365 Princess Light',
    family: 'M365 Princess',
    mode: 'light',
    colors: {
      background: 'oklch(0.976 0.008 349.2)',
      cardBg: 'oklch(0.941 0.014 343.2)',
      textPrimary: 'oklch(0.275 0.059 301.4)',
      textSecondary: 'oklch(0.393 0.186 304.8)',
      primary: 'oklch(0.506 0.171 332.8)',
      accentBlue: 'oklch(0.489 0.080 242.8)',
      accentGreen: 'oklch(0.540 0.091 200.7)',
      dangerRed: 'oklch(0.561 0.192 35.9)',
      warningYellow: 'oklch(0.700 0.108 50.9)',
      border: 'oklch(0.855 0.031 339.3)',
      labelForeground: 'oklch(0.489 0.080 242.8)',
      surfaceRaised: 'oklch(0.941 0.014 343.2)',
    },
  },
  {
    name: 'Nord',
    family: '',
    mode: 'dark',
    colors: {
      background: 'oklch(0.324 0.023 264.2)',
      cardBg: 'oklch(0.379 0.029 266.5)',
      textPrimary: 'oklch(0.951 0.007 260.7)',
      textSecondary: 'oklch(0.6251 0.0408 263.48)',
      primary: 'oklch(0.775 0.062 217.5)',
      accentBlue: 'oklch(0.697 0.059 248.7)',
      accentGreen: 'oklch(0.768 0.075 131.1)',
      dangerRed: 'oklch(0.606 0.121 15.3)',
      warningYellow: 'oklch(0.855 0.089 84.1)',
      border: 'oklch(0.416 0.032 264.1)',
      labelForeground: 'oklch(0.775 0.062 217.5)',
      // Real "nord2" (border, repeated) / "nord3" #4C566A - the lightest of
      // Nord's 4 official Polar Night tones, one genuine tier past border.
      surfaceRaised: 'oklch(0.416 0.032 264.1)',
    },
  },
  {
    name: 'Solarized Dark',
    family: 'Solarized',
    mode: 'dark',
    colors: {
      background: 'oklch(0.267 0.049 219.8)',
      cardBg: 'oklch(0.309 0.052 219.7)',
      // Solarized's own usage table orders content tones by emphasis, and
      // that order flips per mode: dark mode's most-emphasized tone is base1
      // (#93a1a1), not base0 (#839496) - base0 is one rung down. The old
      // value undershot WCAG AA against cardBg (4.12:1); base1 clears it
      // (4.87:1).
      textPrimary: 'oklch(0.698 0.016 196.8)',
      textSecondary: 'oklch(0.523 0.028 219.1)',
      primary: 'oklch(0.654 0.134 85.7)',
      accentBlue: 'oklch(0.615 0.139 244.9)',
      accentGreen: 'oklch(0.644 0.151 118.6)',
      dangerRed: 'oklch(0.586 0.206 27.1)',
      warningYellow: 'oklch(0.581 0.173 39.5)',
      border: 'oklch(0.372 0.063 217.5)',
      labelForeground: 'oklch(0.698 0.016 196.8)',
      // Solarized's spec designates only base03/02 as background-role tones
      // (dark mode) - both already in use above; base01/00 are content
      // (text) tones, not backgrounds, so no further surface tier exists
      // without misusing a role Solarized itself doesn't assign that way.
      surfaceRaised: 'oklch(0.309 0.052 219.7)',
    },
  },
  {
    name: 'Solarized Light',
    family: 'Solarized',
    mode: 'light',
    colors: {
      background: 'oklch(0.974 0.026 90.1)',
      cardBg: 'oklch(0.931 0.026 92.4)',
      // Mirror of the dark-mode fix: light mode's most-emphasized tone is
      // base01 (#586e75), not base00 (#657b83). Old value undershot WCAG AA
      // against cardBg (3.64:1); base01 gets much closer (4.40:1).
      textPrimary: 'oklch(0.523 0.028 219.1)',
      textSecondary: 'oklch(0.698 0.016 196.8)',
      primary: 'oklch(0.654 0.134 85.7)',
      accentBlue: 'oklch(0.615 0.139 244.9)',
      accentGreen: 'oklch(0.644 0.151 118.6)',
      dangerRed: 'oklch(0.586 0.206 27.1)',
      warningYellow: 'oklch(0.581 0.173 39.5)',
      border: 'oklch(0.876 0.029 91.7)',
      // No literal swatch in Solarized Light clears 4.5:1 against cardBg,
      // not even textPrimary (4.40:1) - this is the best real option, an
      // inherent limit of Solarized's own deliberately low-contrast palette.
      labelForeground: 'oklch(0.523 0.028 219.1)',
      surfaceRaised: 'oklch(0.931 0.026 92.4)',
    },
  },
  {
    name: 'Tokyo Night',
    family: 'Tokyo Night',
    mode: 'dark',
    colors: {
      background: 'oklch(0.226 0.021 280.5)',
      cardBg: 'oklch(0.282 0.036 274.7)',
      textPrimary: 'oklch(0.846 0.061 274.8)',
      textSecondary: 'oklch(0.5890 0.0618 276.63)',
      primary: 'oklch(0.719 0.132 264.2)',
      accentBlue: 'oklch(0.7537 0.1243 213.18)',
      accentGreen: 'oklch(0.795 0.139 130.1)',
      dangerRed: 'oklch(0.723 0.159 10.3)',
      warningYellow: 'oklch(0.784 0.106 75.4)',
      border: 'oklch(0.387 0.054 273.9)',
      labelForeground: 'oklch(0.719 0.132 264.2)',
      // Real sidebar/status-bar bg #1f2335 and line-highlight bg #292e42 -
      // two genuine extra tiers from tokyonight's own extended UI palette.
      surfaceRaised: 'oklch(0.261 0.034 274.2)',
    },
  },
  {
    name: 'Tokyo Night Light',
    family: 'Tokyo Night',
    mode: 'light',
    colors: {
      background: 'oklch(0.877 0.007 277.2)',
      cardBg: 'oklch(0.846 0.007 277.1)',
      textPrimary: 'oklch(0.359 0.051 273.2)',
      textSecondary: 'oklch(0.6837 0.0150 272.60)',
      primary: 'oklch(0.448 0.097 260.3)',
      accentBlue: 'oklch(0.474 0.076 212.3)',
      accentGreen: 'oklch(0.452 0.074 129.9)',
      dangerRed: 'oklch(0.480 0.100 9.5)',
      warningYellow: 'oklch(0.523 0.104 71.0)',
      border: 'oklch(0.774 0.006 274.9)',
      labelForeground: 'oklch(0.448 0.097 260.3)',
      // No confidently-sourced extra tier for the Storm/Day light variant;
      // repeats cardBg/border rather than invent one.
      surfaceRaised: 'oklch(0.846 0.007 277.1)',
    },
  },
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

export function applySkin(colors: SkinColors, mode: SkinMode) {
  const el = document.documentElement
  const s = el.style
  s.setProperty('--background', colors.background)
  s.setProperty('--foreground', colors.textPrimary)
  s.setProperty('--card', colors.cardBg)
  s.setProperty('--card-foreground', colors.textPrimary)
  s.setProperty('--popover', colors.cardBg)
  s.setProperty('--popover-foreground', colors.textPrimary)
  s.setProperty('--primary', colors.primary)
  s.setProperty('--primary-foreground', mode === 'dark' ? colors.background : WHITE)
  // Surface elevation ladder: literal swatches from the theme's own palette
  // (cardBg < surfaceRaised < border), never computed.
  s.setProperty('--secondary', colors.border)
  s.setProperty('--secondary-foreground', colors.textPrimary)
  s.setProperty('--muted', colors.cardBg)
  s.setProperty('--muted-foreground', colors.textSecondary)
  // Brighter sibling of muted for structural labels (mono-label, table
  // headers) so they stay legible while muted stays reserved for de-emphasis.
  s.setProperty('--label-foreground', colors.labelForeground)
  s.setProperty('--accent', colors.surfaceRaised)
  s.setProperty('--accent-foreground', colors.textPrimary)
  s.setProperty('--destructive', colors.dangerRed)
  s.setProperty('--destructive-foreground', WHITE)
  s.setProperty('--warning', colors.warningYellow)
  s.setProperty('--success', colors.accentGreen)
  s.setProperty('--border', colors.border)
  s.setProperty('--input', mode === 'dark' ? colors.background : colors.cardBg)
  // The theme's second accent (its real cyan/frost-blue/sapphire, not the
  // signature primary) - matches how these themes actually use two blues:
  // one for the brand accent, one for focus/selection.
  s.setProperty('--ring', colors.accentBlue)
  s.setProperty('--scrollbar-thumb', colors.primary)
}

export function clearSkin() {
  const el = document.documentElement
  const props = [
    '--background', '--foreground', '--card', '--card-foreground',
    '--popover', '--popover-foreground', '--primary', '--primary-foreground',
    '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
    '--label-foreground', '--accent', '--accent-foreground', '--destructive',
    '--destructive-foreground', '--warning', '--success', '--border',
    '--input', '--ring', '--scrollbar-thumb',
  ]
  props.forEach((p) => el.style.removeProperty(p))
}
