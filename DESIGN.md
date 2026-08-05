---
name: mountOS Desktop
description: Desktop mount client for mountOS, profiles, credentials, mounts, health, diagnostics. Native macOS/Windows app, desktop only, not responsive.
colors:
  background-light: "oklch(0.95 0.02 94.63)"
  background-dark: "oklch(0.07 0.005 200)"
  foreground-light: "oklch(0.12 0 0)"
  foreground-dark: "oklch(0.93 0.005 200)"
  card-light: "oklch(0.96 0.025 94.63)"
  card-dark: "oklch(0.03 0 0)"
  popover-light: "oklch(0.96 0.025 94.63)"
  popover-dark: "oklch(0.09 0.006 200)"
  primary-rust: "oklch(0.54 0.14 39)"
  primary-gold: "oklch(0.78 0.13 92)"
  secondary-light: "oklch(0.94 0 0)"
  secondary-dark: "oklch(0.15 0.005 200)"
  muted-light: "oklch(0.92 0.04 94.64)"
  muted-dark: "oklch(0.09 0.005 200)"
  muted-foreground-light: "oklch(0.42 0.05 70)"
  muted-foreground-dark: "oklch(0.55 0.01 200)"
  label-foreground-light: "oklch(0.42 0.05 70)"
  label-foreground-dark: "oklch(0.55 0.01 200)"
  accent-amber-tint: "oklch(0.92 0.06 80)"
  accent-dark: "oklch(0.16 0.008 200)"
  destructive-light: "oklch(0.54 0.24 24.42)"
  destructive-dark: "oklch(0.59 0.20 21)"
  destructive-foreground: "oklch(1 0 0)"
  warning-light: "oklch(0.45 0.16 55)"
  warning-dark: "oklch(0.78 0.15 75)"
  success-light: "oklch(0.49 0.17 155)"
  success-dark: "oklch(0.65 0.19 155)"
  border-light: "oklch(0.88 0 0)"
  border-dark: "oklch(0.21 0.008 200)"
  input-light: "oklch(0.96 0 0)"
  input-dark: "oklch(0.09 0.005 200)"
  ring-light: "oklch(0.61 0.14 39)"
  ring-dark: "oklch(0.78 0.13 92)"
  scrollbar-thumb-light: "oklch(0.61 0.14 39)"
  scrollbar-thumb-dark: "oklch(0.78 0.13 92)"
  pastel-mount: "oklch(0.75 0.14 90)"
  pastel-volume: "oklch(0.72 0.15 155)"
  pastel-storage: "oklch(0.72 0.15 200)"
  pastel-session: "oklch(0.72 0.15 175)"
  pastel-node: "oklch(0.72 0.15 125)"
  pastel-region: "oklch(0.72 0.15 310)"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontFeature: "'cv02', 'cv03', 'cv04', 'cv11'"
  headline:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.01em"
  body-sm:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  label:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, Menlo, monospace"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.1em"
rounded:
  sm: "0"
  md: "2px"
  lg: "4px"
  xl: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-default:
    backgroundColor: "transparent"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-primary:
    backgroundColor: "{colors.primary-rust}"
    textColor: "{colors.card-light}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.destructive-light}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-sm:
    backgroundColor: "transparent"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "32px"
  card:
    backgroundColor: "{colors.card-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.md}"
    padding: "16px"
  input:
    backgroundColor: "{colors.input-light}"
    textColor: "{colors.foreground-light}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "36px"
---

# Design System: mountOS Desktop

**Provenance.** This system mirrors `mountos-admin-client/DESIGN.md` ("The Operator's Console") — read that file first; it's the source of truth for tokens, typography, and component behavior. Both apps share the same `src/lib/components/ui/*` component set (Button, Input, Textarea, Checkbox, Label, Badge, Separator, Select, Popover, Dialog, Table, Skeleton, Sonner, Calendar/DateTimePicker), the same `src/lib/components/shared/{DateTimePicker,InfoTip}.svelte`, and the same `src/lib/styles/corner-brackets.css` cyberpunk system — all copied file-for-file from `mountos-admin-client` and kept in sync deliberately; a change to a shared component, token, or style file there should be mirrored here, and vice versa. `src/lib/utils.ts`'s `cn()` and Tailwind v4 (via `@theme inline`, mapped onto the OKLCH custom properties in `src/app.css`) work the same way in both repos.

This file exists only to record what's genuinely different about the desktop client: a handful of app-specific leftovers with no admin-client equivalent, and platform constraints admin-client doesn't have.

## Platform

**Desktop only, not responsive.** A native macOS/Windows app window (Tauri), not a web page. `tauri.conf.json` enforces `minWidth: 860 / minHeight: 560` on the main window; there is no mobile or tablet target. The tray-popover window (`TrayPopover.svelte`) is a second, fixed-size native surface with its own minimal layout, not a breakpoint of the main window.

## What's shared verbatim with mountos-admin-client

- Every color, typography, spacing, and radius token (`src/app.css`'s `:root`/`.dark` blocks match admin-client's exactly).
- Every `src/lib/components/ui/*` primitive: same files, same variants, same behavior, with one deliberate exception: `badge.svelte`'s `primary`/`success`/`warning` variants dropped their resting `bg-*/N` background tint (now `bg-transparent`, matching `destructive`'s already-correct pattern) — computed contrast showed all three failing 4.5:1 AA in light mode against their own tinted background (verified: 4.20/3.98/text stays passing for warning only because of headroom, primary and success measurably failed). If admin-client fixes this upstream, reconcile back to verbatim; until then this is the one component this repo has intentionally diverged from. Otherwise, don't fork these files locally — if a variant is missing, copy it over from admin-client rather than hand-rolling one here.
- Dialogs: `bits-ui`'s `Dialog.Root`/`Content`/`Header`/`Footer`/`Title`, same as admin-client. mountos-desktop no longer uses native `<dialog>` elements.
- Toasts: `svelte-sonner` via the copied `Toaster` wrapper, same as admin-client — except the wrapper reads this app's own `src/lib/theme.svelte.ts` for light/dark instead of `mode-watcher` (mountos-desktop already had its own theme system with cross-window sync via `localStorage`, predating this integration; adding a second theme library would have been redundant), and `src/lib/styles/toast.css` is a simplified adaptation of admin-client's own (same OKLCH type-color mapping via `[data-sonner-toast][data-type=...]`, without the clip-path chamfer applied elsewhere in this app). Never rely on `<Toaster richColors>`; that's sonner's own hardcoded palette, unrelated to this app's tokens.
- **The full cyberpunk design system** (`src/lib/styles/corner-brackets.css`, copied verbatim from admin-client): gradient-painted `.corner-brackets` (hover/focus-within reactive), `.tech-grid`, and the `.cyberpunk-skewed`/`-sm`/`-lg` clip-path family. `.corner-brackets`/`.tech-grid` frame the one primary panel per view (Instances table, filter row, Profile editor) and the empty states, same "one bracketed surface per view" rule as admin-client. `.cyberpunk-skewed-sm` marks every primary CTA and every dialog footer's action pair (both buttons, matching admin-client's `ConfirmDialog`/`DeactivateVolumeDialog` convention — the clip applies to the footer-action-pair pattern regardless of the confirm button's semantic variant). `.th-cyber` marks table header cells (Instances, Gateway launches) for the scan-line-underline + corner-bracket-on-first/last-`th` treatment.
- **`InfoTip.svelte`** (`src/lib/components/shared/InfoTip.svelte`, copied verbatim): the hover/focus tooltip (portal to `document.body`, viewport-aware positioning, Escape/scroll/resize dismissal per WCAG 1.4.13) used for every inline field hint. Replaces the earlier always-visible `<small>` + `Lightbulb` text dump.

## App-specific leftovers (no admin-client equivalent)

These have no counterpart in admin-client because they solve a problem specific to a CLI-supervisor desktop app, not an infrastructure dashboard. Keep them; don't try to force-fit an admin-client pattern here instead.

- **`.command-preview` / `<CommandPreview>`** (`src/lib/components/CommandPreview.svelte`): a bordered, `--muted`-background box showing the exact `mountos` CLI invocation an action is about to run. Core interaction principle of this app — every mutating action shows its real command before (and often after) running it. Admin-client has nothing like this since it talks to an HTTP API, not a CLI.
- **`<Callout>`** (`src/lib/components/Callout.svelte`): a warning-tinted inline banner (border + `--warning` text) for non-blocking errors and cautions inside forms and dialogs. A small app-specific component, not a copied admin-client one.
- **`.led`**: 8px pulsing status dot for per-mount health (healthy/limited/lost), reused as-is from the original bespoke system. No admin-client equivalent (it has no concept of a live local mount).
- **`.mono-label` / `.sr-only`**: kept verbatim from the original system; functionally identical to admin-client's own use of the same patterns (mono microlabels on command previews and bundle paths, screen-reader-only text).
- **`src/lib/app-state.svelte.ts`**: a single shared runes-based state module holding all cross-cutting app state (profiles, running instances, settings, every dialog's fields) that `App.svelte` and its child views/dialogs import directly, instead of prop-drilling. mountos-admin-client is a SvelteKit app with route-level data loading and doesn't need this pattern; a plain Vite+Svelte app with one window and many sibling dialogs does.

## Do's and Don'ts (desktop-specific only — see admin-client's DESIGN.md for everything else)

- **Do** keep every new dialog on `bits-ui`'s `Dialog.Root`, matching admin-client, not a hand-rolled native `<dialog>`.
- **Do** show the exact CLI command (`<CommandPreview>`) for every action that shells out to `mountos`.
- **Do** copy a missing `ui/*` component from `mountos-admin-client` rather than building a local one-off equivalent.
- **Do** apply `cyberpunk-skewed-sm` to new primary CTAs and dialog footer action pairs, and `InfoTip` (not inline hint text) for field-level explanations.
- **Don't** reference internal binary names in user-facing copy; the public name is `mountos` and the product is "mountOS Desktop".
- **Don't** use em dashes anywhere in product copy (same rule as admin-client).
