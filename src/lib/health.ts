import type { Backend, GatewayEndpointInfo, HealthState } from './types'

export function healthTone(health: HealthState | string): 'success' | 'destructive' | 'warning' | '' {
  if (health === 'healthy') return 'success'
  if (health === 'lost') return 'destructive'
  if (health === 'launching') return 'warning'
  return ''
}

/**
 * Explains the state rather than restating it: the dot is the only thing on
 * screen once the Health column is gone, and "lost" means nothing on its
 * own. Doubles as the accessible name, so it must read as a sentence.
 */
export function healthTitle(health: HealthState | string): string {
  if (health === 'healthy') return 'Healthy: mounted and reporting live stats'
  if (health === 'lost') return 'Lost: no live process owns this mount; unmount to reclaim it'
  if (health === 'launching') return 'Launching: the mount is still starting up'
  return `Unknown state: ${health}`
}

/**
 * `viewMode` is a comma-joined flag string ("r,del", "r,ver", "r,snap", "rw",
 * "r") from Go's MountMode.String(), never an exact-match value, so an equality
 * check against a single literal would never fire. Identifies a satellite
 * Deleted/Version/Snapshot view so its row can carry a badge and skip
 * Save-as-profile/Clone-profile (cloning one would silently produce a
 * profile that mounts the wrong thing at that path).
 */
export function viewModeBadge(viewMode?: string): string | null {
  if (!viewMode) return null
  if (viewMode.includes('del')) return 'Deleted view'
  if (viewMode.includes('ver')) return 'Version view'
  if (viewMode.includes('snap')) return 'Snapshot view'
  return null
}

/**
 * Backend column stand-in for a gateway-only instance: the API it actually
 * exposes (s3, hdfs, or both), not the FUSE transport concept "backend"
 * means for a real mount, a gateway has no FUSE transport at all.
 */
export function gatewayProtocolsLabel(endpoints?: GatewayEndpointInfo[]): string {
  if (!endpoints || endpoints.length === 0) return 'gateway'
  return endpoints.map((endpoint) => endpoint.protocol).join(', ')
}

/**
 * Single-line target summary for a gateway-only instance, for compact
 * contexts (the tray popover) that have no room for InstancesView's
 * per-protocol badged rows. A single endpoint (the common case) shows just
 * the bare URL; multiple protocols are labeled so they aren't ambiguous.
 */
export function gatewayTargetSummary(endpoints?: GatewayEndpointInfo[]): string {
  if (!endpoints || endpoints.length === 0) return ''
  if (endpoints.length === 1) return endpoints[0].url
  return endpoints.map((endpoint) => `${endpoint.protocol}: ${endpoint.url}`).join(', ')
}

// 'auto' isn't a real backend identity (it means "let the CLI decide"), so it
// stays neutral rather than claiming one of these categorical colors.
const BACKEND_PASTEL: Partial<Record<Backend, string>> = {
  macfuse: 'mount',
  fskit: 'volume',
  nfs: 'storage',
  smb: 'session',
  mountosio: 'region',
}

/** Inline style for a per-backend color-coded Badge; empty for 'auto'/unknown. */
export function backendBadgeStyle(backend?: string): string {
  const tone = BACKEND_PASTEL[backend as Backend]
  if (!tone) return ''
  return pastelBadgeStyle(tone)
}

// Fixed, not derived from the label: the same kind must always read as the
// same color everywhere it appears (Running Instances row, profile form),
// rather than picking one of the 7 tones arbitrarily per render.
const VOLUME_KIND_PASTEL = { general: 'mount', iceberg: 'lake' } as const

/** Inline style for a color-coded volume-kind Badge (General/Iceberg). */
export function volumeKindBadgeStyle(kind?: string): string {
  const tone = VOLUME_KIND_PASTEL[kind as keyof typeof VOLUME_KIND_PASTEL]
  if (!tone) return ''
  return pastelBadgeStyle(tone)
}

function pastelBadgeStyle(tone: string): string {
  return `background: transparent; color: var(--pastel-${tone}-text); border-color: oklch(from var(--pastel-${tone}) l c h / 0.3);`
}

// Intl.NumberFormat's unit style, not hand-rolled pluralization: correct
// pluralization/wording is a locale problem (English "add an s" rules don't
// generalize), and the platform already solves it, same reasoning as
// formatMountedSince using toLocaleString() for the absolute side. narrow
// display (not long) since this is the row badge text itself, where space is
// tight, the title tooltip already carries the full "Mounted at ..." form.
function formatUnit(quantity: number, unit: 'day' | 'hour' | 'minute'): string {
  return new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'narrow' }).format(quantity)
}

/**
 * "Up 18m" style compact duration since `mountTime`, or undefined when it's
 * missing/unparseable (older CLI, config not written yet). Recomputed on
 * every poll tick rather than ticking live on its own timer, meant for
 * when auto-refresh is actually on, so the row keeps recomputing this on a
 * real cadence. With polling off nothing re-renders this row again until a
 * manual refresh, so a relative duration would silently freeze and read as
 * live when it isn't, use formatMountedSince instead in that case.
 */
export function formatUptime(mountTime?: string): string | undefined {
  if (!mountTime) return undefined
  const started = Date.parse(mountTime)
  if (Number.isNaN(started)) return undefined
  const totalMinutes = Math.max(0, Math.floor((Date.now() - started) / 60_000))
  if (totalMinutes < 1) return 'just now'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${formatUnit(days, 'day')} ${formatUnit(hours, 'hour')}` : formatUnit(days, 'day')
  if (hours > 0) return minutes > 0 ? `${formatUnit(hours, 'hour')} ${formatUnit(minutes, 'minute')}` : formatUnit(hours, 'hour')
  return formatUnit(minutes, 'minute')
}

/**
 * Absolute local time for `mountTime`, in whatever date/time format the
 * user's own OS locale already uses (no custom format options), it should
 * read the way every other timestamp on their machine already does, not
 * some format this app invented. Unlike formatUptime, this never goes stale
 * between refreshes. An absolute instant in time is just as correct read
 * a minute or a day after the last poll, which is exactly what you want
 * once auto-refresh is off and nothing is going to recompute a relative
 * duration for you.
 */
export function formatMountedSince(mountTime?: string): string | undefined {
  if (!mountTime) return undefined
  const started = Date.parse(mountTime)
  if (Number.isNaN(started)) return undefined
  return new Date(started).toLocaleString()
}
