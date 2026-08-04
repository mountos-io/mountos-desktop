# Product

## Register

product

## Users

Developers, data engineers, and operators who mount mountOS volumes on their own workstations (macOS and Windows). They are technical and CLI-fluent, but want one-click mount, saved profiles, credentials in the OS vault, and trustworthy status without keeping a terminal open. They value precision and data density over decorative UI. Many also run the `mountos` CLI directly; the GUI must coexist with it, never replace it.

## Product Purpose

mountOS Desktop is a supervisor over the public `mountos` CLI. It manages mount profiles, stores secrets in the OS keychain/credential vault, launches and monitors mounts, surfaces backend readiness (`check --json`), and produces diagnostics bundles. It re-implements zero protocols; every action shells out to documented CLI surface, and the UI always shows the exact command it will run. Success: a saved profile mounts in one click, status is honest (including the limited-observability backends), and failures map to a clear next action.

## Brand Personality

**Technical, Precise, Bold.** Engineering-forward, no-nonsense, confident. The interface speaks the operator's language, no hand-holding, no fluff. Every element earns its place.

**Emotional goal:** Confidence & Control. Users trust what the app says about their mounts and feel secure about where their credentials live.

## Anti-references

- Consumer cloud-drive clients (OneDrive/Dropbox marketing softness, mascots, celebratory confetti). This is an operator tool.
- SaaS dashboard reflex: soft rounded cards, decorative gradients, hero metrics, purple-to-cyan splash.
- Wizard-heavy flows that hide the underlying command. The CLI is the source of truth; the GUI never obscures it.

## Design Principles

1. **Data density over decoration.** Every pixel serves the operator's decision. Tables and inline status over charts and tiles.
2. **Sharp geometry, deliberate ornamentation.** Corner brackets and near-zero radii are the signature; they frame primary content, never compete with it.
3. **Contrast through restraint.** Narrow palette; the warm primary marks what matters; grayscale carries the rest.
4. **The command is the contract.** Always show the argv that will run, the file paths touched, and the honest health state (including "limited" where live stats are impossible).
5. **System-grade reliability.** Predictable layouts, consistent spacing, no surprises. The app must feel as dependable as the filesystem it mounts.

## Accessibility & Inclusion

WCAG AA target. M1 acceptance criteria: complete keyboard-only path for mount/unmount/quit, labeled controls in the profile editor and instance list, VoiceOver pass on both, template tray icon for light/dark menu bars, `prefers-reduced-motion` respected globally. No UI text below 16px.

## Tech Stack

- Tauri 2 (Rust core: spawn/supervise CLI, keyring vault, profile store)
- Svelte 5 + TypeScript, Vite (single-window UI)
- Vanilla CSS with OKLCH design tokens in `src/app.css` (no Tailwind; tokens mirror mountos-admin-client)
- Icons: @lucide/svelte (outline, consistent stroke)

## Platform

web

**Desktop only, not responsive.** Tauri wraps the UI in a native macOS/Windows app window, not a web page; there is no mobile or tablet target and never will be. The main window enforces `minWidth: 860 / minHeight: 560` in `tauri.conf.json`, so the practical viewport range is "≥860px" with a tray-popover window as the only other surface (a fixed-size native panel, not a breakpoint target). Judge responsive/adaptive-layout audit criteria against that reality: a `@media (max-width: 860px)` rule is edge-case tolerance for tiling window managers at the exact floor, not a mobile layout, and should not be scored as if it needs to support phone/tablet widths.
