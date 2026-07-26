// Update availability check for mountOS Desktop.
//
// Desktop ships INSIDE the platform installer bundle (mountos-macos / mountos-windows),
// alongside the FSKit extension and the CLI. So the honest question is not "is there a
// newer Desktop.app" but "is there a newer installer", because that is the artifact a
// user downloads and it updates all three together.
//
// Fetched here rather than through Tauri because the app has no backend of its own. The
// distribution host is named explicitly in the CSP `connect-src` (src-tauri/tauri.conf.json);
// a partner repointing DIST_BASE must widen that entry to match.
//
// Everything degrades to "show nothing". No network, an air-gapped machine or a malformed
// document must never produce a false "up to date" claim: callers get `available: null`
// and render no row.

/** Distribution base. Empty disables the check entirely. */
declare const __MOUNTOS_DIST_URL__: string | undefined
export const DIST_BASE = (typeof __MOUNTOS_DIST_URL__ === 'string' ? __MOUNTOS_DIST_URL__ : 'https://mountos.sh/install').replace(/\/+$/, '')

/** The installer bundle this build ships inside. */
function bundlePackage(): string {
  return navigator.userAgent.includes('Windows') ? 'mountos-windows' : 'mountos-macos'
}

export interface UpdateState {
  /** False when the check is disabled by build config; the UI hides the row entirely. */
  enabled: boolean
  /** Newest published bundle version, only when it is newer than the running one. */
  available: string | null
  /** Where to get it. Only set alongside `available`. */
  downloadUrl: string | null
  /** Last failure, so a stale answer is distinguishable from a fresh one. */
  error: string | null
}

/** Component-wise semver compare. Matches relver's ordering in mountos-servers. */
export function semverLess(a: string, b: string): boolean {
  const parse = (s: string): number[] =>
    s.split('.').slice(0, 3).map(p => {
      const n = parseInt(p, 10)
      return Number.isFinite(n) ? n : 0
    })
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * Checks whether a newer installer bundle has been published.
 * Never throws; a failure comes back as `available: null` with `error` set.
 */
export async function checkForUpdate(current: string): Promise<UpdateState> {
  const state: UpdateState = {
    enabled: DIST_BASE !== '',
    available: null,
    downloadUrl: null,
    error: null,
  }
  if (!state.enabled || !current) return state

  const pkg = bundlePackage()
  try {
    const res = await fetch(`${DIST_BASE}/dist/${pkg}/latest.json`, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)

    const manifest = (await res.json()) as { version?: string }
    if (!manifest?.version) throw new Error('release manifest has no version')

    if (semverLess(current, manifest.version)) {
      state.available = manifest.version
      state.downloadUrl = `${DIST_BASE}/dist/${pkg}`
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
  }
  return state
}
