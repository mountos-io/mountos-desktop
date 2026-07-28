import type { Backend, ErrorClass, MountProfile } from './types'

// UI-only mirror of src-tauri/src/lib.rs's validate_extra_args — gives the
// user inline "rejected" feedback before they hit Save/Mount. The Rust side
// independently re-validates everything from the on-disk profile before
// acting, so this copy is not itself a security boundary, but it IS a
// hand-synced duplicate: any change to the flag sets below (or to the
// short-cluster scan logic) must be mirrored in lib.rs's managed_flags()/
// boolean_long_flags(), and both must stay in sync with mountos-servers'
// cmd/mfuse CLI flag surface. No automated check currently catches drift.
const managedFlags = new Set([
  'a',
  'access-key-id',
  's',
  'secret-access-key',
  'discovery-url',
  'm',
  'mount',
  'mount-point',
  'destination',
  'foreground',
  'f',
  'gateway',
  'gateway-only',
  'fork-name',
  'volname',
  'n',
  'read-only',
  'r',
  'disk-cache-dir',
  'disk-cache-size',
  'backend',
  'macfuse',
  'fskit',
  'k',
  'nfs',
  'N',
  'smb',
  'temporary-fork',
])

// gateway-* flags are deliberately excluded: validateExtraArgs rejects any
// long flag starting with "gateway-" outright (see the `rawName.startsWith
// ('gateway-')` check below), regardless of what's listed here. Gateway
// launches have their own dedicated fields and argv builder
// (buildGatewayArgv/openGateway) rather than the extraArgs escape hatch, so
// smuggling gateway-* through extraArgs stays rejected on a mount profile.
const booleanLongFlags = new Set([
  'acl',
  'agent',
  'blockserv-auto-degrade',
  'browse',
  'debug',
  'disable-cache-dir',
  'ioctl',
  'null-permissions',
  'session-audit',
  'xattr',
])

const shortValueFlags = new Set(['o'])

const backendArgv: Partial<Record<Backend, string[]>> = {
  macfuse: ['--macfuse'],
  fskit: ['--fskit'],
  nfs: ['--nfs'],
  smb: ['--smb'],
  mountosio: ['--backend', 'mountosio'],
}

// Every backend takes a real mount point, so regular mounts and view-mounts
// alike state their backend rather than relying on the CLI's no-flag default
// order. Mirrors src-tauri/src/lib.rs's push_backend_flag.
function pushBackendFlag(argv: string[], backend: Backend): void {
  const flags = backendArgv[backend]
  if (flags) argv.push(...flags)
}

// Accepts a Unix absolute path or a Windows drive-letter path (bare "C:",
// "C:\", "C:/", or "C:\..."/"C:/..."), regardless of which OS this build is
// running on — the authoritative, OS-specific check lives in Rust's
// is_openable_target; this is only for immediate UI feedback.
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]?$/.test(path) || /^[A-Za-z]:[\\/]/.test(path)
}

export const FSKIT_MOUNT_PREFIX = '/Volumes/MountOS/'

// A "folder name" here means one path segment: no separators (either OS's),
// no control bytes, and not a literal "." or ".." alias. Only relevant when
// the value is used to build a filesystem path (FSKit's volume name doubles
// as the mount point's leaf folder); other backends just pass it to --volname.
export function isValidFolderName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  return !/[/\\\x00-\x1f]/.test(name)
}

// UI-only mirror of src-tauri/src/lib.rs's validate_mount_path_for_backend —
// same hand-synced-duplicate caveat as the flag allowlists above; the Rust
// side independently re-validates.
export function validateMountPathForBackend(backend: Backend, mountPath: string): string | null {
  // Empty stays legal: buildMountArgv omits -m and the mountos CLI picks its
  // own default. A non-empty value has to actually be an absolute path.
  if (mountPath && !isAbsolutePath(mountPath)) {
    return 'Mount path must be an absolute filesystem path'
  }
  if (backend !== 'fskit') return null
  const trimmed = mountPath.replace(/\/+$/, '')
  // Mirrors Rust's has_parent_component check: this is a byte-prefix test,
  // not a resolved-path check, so a ".." segment must be rejected explicitly
  // or "/Volumes/MountOS/x/../../../etc" would pass it.
  const hasParentComponent = trimmed.split('/').some((segment) => segment === '..')
  if (hasParentComponent || !trimmed.startsWith(FSKIT_MOUNT_PREFIX) || trimmed.length <= FSKIT_MOUNT_PREFIX.length) {
    return `FSKit requires a mount point under ${FSKIT_MOUNT_PREFIX}<name>`
  }
  return null
}

export function validateExtraArgs(args: string[]): string[] {
  const rejected: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('-')) {
      rejected.push(arg)
      continue
    }

    if (arg === '--') {
      rejected.push(arg)
      continue
    }

    if (arg.startsWith('--')) {
      const [rawName] = arg.slice(2).split('=', 1)
      if (managedFlags.has(rawName) || rawName.startsWith('gateway-')) {
        rejected.push(arg)
        if (!arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) {
          rejected.push(args[i + 1])
          i += 1
        }
      } else if (!arg.includes('=') && !booleanLongFlags.has(rawName) && args[i + 1] && !args[i + 1].startsWith('-')) {
        i += 1
      }
      continue
    }

    const cluster = arg.slice(1)
    for (const ch of cluster) {
      if (managedFlags.has(ch)) {
        rejected.push(arg)
        break
      }
      if (shortValueFlags.has(ch)) break
    }
  }

  return rejected
}

export function buildMountArgv(profile: MountProfile): string[] {
  const argv = ['mount']

  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (profile.volume) argv.push('--volname', profile.volume)
  if (profile.fork) argv.push('--fork-name', profile.fork)
  if (profile.mountPath) argv.push('-m', profile.mountPath)
  if (profile.accessKeyId) argv.push('-a', profile.accessKeyId, '-s')
  if (profile.readOnly) argv.push('--read-only')
  if (profile.temporaryFork) argv.push('--temporary-fork')
  if (profile.cacheDir) argv.push('--disk-cache-dir', profile.cacheDir)
  if (profile.cacheSize) argv.push('--disk-cache-size', profile.cacheSize)
  pushBackendFlag(argv, profile.backend)
  argv.push(...profile.extraArgs)
  return argv
}

// UI-only mirrors of src-tauri/src/lib.rs's satellite_volname/
// build_snapshot_argv/build_deleted_argv/build_version_argv/build_fork_*_argv
// — same hand-synced-duplicate caveat as buildMountArgv: these only drive the
// live command preview shown in each dialog, Rust independently rebuilds and
// re-validates everything from the on-disk profile before acting.
// Short and non-linguistic: "(deleted)"/"(snapshot)"/"(version)" reads fine
// once, but a bare parenthesized suffix breaks a shell (unquoted "(" opens a
// subshell) if this argv is ever copied out of the preview and pasted
// directly -- mirrors Rust's satellite_volname/satellite_suffix exactly.
function satelliteSuffix(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function satelliteVolname(profile: MountProfile, kind: string): string {
  const abbrev = kind === 'snapshot' ? 'snap' : kind === 'deleted' ? 'del' : kind === 'version' ? 'ver' : kind
  const suffix = satelliteSuffix()
  return profile.volume ? `${profile.volume}-${abbrev}-${suffix}` : `mountOS-${abbrev}-${suffix}`
}

function buildSatellitePrefix(subcommand: string, profile: MountProfile, kind: string): string[] {
  const argv = [subcommand]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (profile.fork) argv.push('--fork-name', profile.fork)
  argv.push('--volname', satelliteVolname(profile, kind))
  return argv
}

function pushSatelliteCredentials(argv: string[], profile: MountProfile): void {
  if (profile.accessKeyId) argv.push('-a', profile.accessKeyId, '-s')
}

// The server resolves disk-cache-dir and applies extraArgs unconditionally
// before branching on mount vs. deleted/version/snapshot vs. gateway-only,
// so this is shared by buildMountArgv and every satellite/gateway builder --
// otherwise the command preview would show a profile's cache dir and extra
// flags for a regular mount but silently omit them for these other launches.
function pushCacheAndExtraArgs(argv: string[], profile: MountProfile): void {
  if (profile.cacheDir) argv.push('--disk-cache-dir', profile.cacheDir)
  if (profile.cacheSize) argv.push('--disk-cache-size', profile.cacheSize)
  argv.push(...profile.extraArgs)
}

// snapshot has no --destination flag: -m is its only mount-point flag, and it
// daemonizes normally (unlike deleted/version).
export function buildSnapshotArgv(profile: MountProfile, destination: string, timestamp: string): string[] {
  const argv = buildSatellitePrefix('snapshot', profile, 'snapshot')
  argv.push('-m', destination)
  // Fused form: a leading-minus relative timestamp ("-1d") risks pflag
  // misparsing a separate `--timestamp -1d` token pair as another flag.
  argv.push(`--timestamp=${timestamp.trim()}`)
  pushSatelliteCredentials(argv, profile)
  pushCacheAndExtraArgs(argv, profile)
  pushBackendFlag(argv, profile.backend)
  return argv
}

export function buildDeletedArgv(
  profile: MountProfile,
  destination: string,
  from?: string,
  idleTimeout?: string,
): string[] {
  const argv = buildSatellitePrefix('deleted', profile, 'deleted')
  argv.push('--destination', destination)
  if (from?.trim()) argv.push(`--from=${from.trim()}`)
  if (idleTimeout?.trim()) argv.push(`--idle-timeout=${idleTimeout.trim()}`)
  pushSatelliteCredentials(argv, profile)
  pushCacheAndExtraArgs(argv, profile)
  // No backend flag: verified against cmd_deleted.go -- deleted/version accept
  // any backend flag as a root-persistent flag but need none of them to run,
  // and forcing the primary mount's backend here would wrongly drag along
  // e.g. FSKit's rigid /Volumes/MountOS/<name> mount-point convention onto an
  // arbitrary destination folder these views have no reason to share.
  return argv
}

// selector picks the target: a browsed local path (preferred -- lets the CLI
// resolve inode/parent/name itself and enables multi-key discovery) or a
// hand-typed inode (advanced/power-user fallback, plain by-inode lookup only).
export function buildVersionArgv(
  profile: MountProfile,
  destination: string,
  selector: { path: string } | { inode: string },
  versionFormat?: string,
  idleTimeout?: string,
  fullChain?: boolean,
): string[] {
  const argv = buildSatellitePrefix('version', profile, 'version')
  argv.push('--destination', destination)
  if ('path' in selector) {
    argv.push('--path', selector.path)
  } else {
    argv.push('-i', selector.inode)
  }
  if (fullChain) argv.push('--full-chain')
  if (versionFormat?.trim() && versionFormat.trim() !== 'number') argv.push(`--version-format=${versionFormat.trim()}`)
  if (idleTimeout?.trim()) argv.push(`--idle-timeout=${idleTimeout.trim()}`)
  pushSatelliteCredentials(argv, profile)
  pushCacheAndExtraArgs(argv, profile)
  // No backend flag -- same reasoning as buildDeletedArgv above.
  return argv
}

// No --type flag is ever emitted (defaults to "general" server-side; iceberg
// volumes have no profile representation in this GUI). No volume-identifying
// flag is needed either — the access key alone scopes the volume.
export function buildForkListArgv(profile: MountProfile): string[] {
  const argv = ['fork', 'list']
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  pushSatelliteCredentials(argv, profile)
  return argv
}

export function buildForkCreateArgv(profile: MountProfile, name: string, parent?: string, asOf?: string): string[] {
  const argv = ['fork', 'create', name]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (parent?.trim()) argv.push(`--parent=${parent.trim()}`)
  if (asOf?.trim()) argv.push(`--as-of=${asOf.trim()}`)
  pushSatelliteCredentials(argv, profile)
  return argv
}

export function buildForkDeleteArgv(profile: MountProfile, name: string, force: boolean): string[] {
  const argv = ['fork', 'delete', name]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (force) argv.push('--force')
  pushSatelliteCredentials(argv, profile)
  return argv
}

export function buildForkRestoreArgv(profile: MountProfile, name: string): string[] {
  const argv = ['fork', 'restore', name]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  pushSatelliteCredentials(argv, profile)
  return argv
}

export interface GatewayLaunchParams {
  protocols: string[]
  port?: string
  gatewayOnly: boolean
  noLoopback: boolean
  certPath?: string
  keyPath?: string
}

// gateway-only uses the standalone `gateway` subcommand (no -m, no backend
// flag, no --volname -- confirmed against cmd_gateway.go/cmd_mount.go, -m is
// optional whenever --gateway-only is set, there is no FUSE mount at all).
// The mount+gateway combo instead reuses the full regular `buildMountArgv`
// output with gateway flags appended, matching the CLI's real combo
// invocation (`mount -m <dir> --gateway s3,hdfs`, no --gateway-only). Mirrors
// src-tauri/src/lib.rs's build_gateway_argv.
export function buildGatewayArgv(profile: MountProfile, params: GatewayLaunchParams): string[] {
  let argv: string[]
  if (params.gatewayOnly) {
    argv = ['gateway']
    if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
    if (profile.fork) argv.push('--fork-name', profile.fork)
    if (profile.temporaryFork) argv.push('--temporary-fork')
    pushSatelliteCredentials(argv, profile)
    pushCacheAndExtraArgs(argv, profile)
  } else {
    argv = buildMountArgv(profile)
  }
  if (params.protocols.length) argv.push('--gateway', params.protocols.join(','))
  if (params.port?.trim()) argv.push('--gateway-port', params.port.trim())
  if (params.noLoopback) argv.push('--gateway-no-loopback')
  if (params.certPath?.trim() && params.keyPath?.trim()) {
    argv.push('--gateway-cert', params.certPath.trim(), '--gateway-key', params.keyPath.trim())
  }
  return argv
}

export function parseArgvInput(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let started = false

  for (const ch of input) {
    if (escaped) {
      current += ch
      escaped = false
      started = true
      continue
    }
    if (ch === '\\' && quote !== 'single') {
      escaped = true
      started = true
      continue
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      started = true
      continue
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      started = true
      continue
    }
    if (/\s/.test(ch) && quote === null) {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }

  if (escaped || quote !== null) throw new Error('Unterminated quote or escape in extra args')
  if (started) args.push(current)
  return args
}

const errorClassLabels: Record<ErrorClass, string> = {
  'cli-unavailable': 'mountos CLI unavailable',
  auth: 'Authentication failed',
  'network-discovery': 'Network or discovery problem',
  'backend-missing': 'Backend not ready',
  mountpoint: 'Mount point problem',
  capacity: 'Cache or capacity problem',
  'volume-state': 'Volume state prevents this mount',
  indeterminate: 'Launch did not confirm in time',
  unknown: 'Mount failed',
}

export function errorClassLabel(errorClass: ErrorClass): string {
  return errorClassLabels[errorClass]
}

export function classifyMountError(text: string): ErrorClass {
  const stderr = text.toLowerCase()
  if (!stderr.trim()) return 'unknown'
  if (stderr.includes('no such file') || stderr.includes('not found') || stderr.includes('quarantine')) return 'cli-unavailable'
  if (stderr.includes('authentication failed') || stderr.includes('invalid access key or secret')) return 'auth'
  if (stderr.includes('discovery') || stderr.includes('connection refused') || stderr.includes('timeout') || stderr.includes('dns')) return 'network-discovery'
  if (stderr.includes('backend') || stderr.includes('driver') || stderr.includes('macfuse') || stderr.includes('fskit')) return 'backend-missing'
  if (stderr.includes('mount point') || stderr.includes('not empty') || stderr.includes('already exists') || stderr.includes('busy')) return 'mountpoint'
  if (stderr.includes('cache') || stderr.includes('no space') || stderr.includes('quota')) return 'capacity'
  if (stderr.includes('deleted volume') || stderr.includes('lake') || stderr.includes('iceberg')) return 'volume-state'
  if (stderr.includes('did not become ready within') || stderr.includes('no readiness signal')) return 'indeterminate'
  return 'unknown'
}
