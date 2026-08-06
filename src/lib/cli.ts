import type { Backend, ErrorClass, MountProfile } from './types'

// UI-only mirror of src-tauri/src/lib.rs's validate_extra_args, which gives the
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
// running on. The authoritative, OS-specific check lives in Rust's
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

// UI-only mirror of src-tauri/src/lib.rs's validate_mount_path_for_backend,
// with the same hand-synced-duplicate caveat as the flag allowlists above; the Rust
// side independently re-validates.
export function validateMountPathForBackend(backend: Backend, mountPath: string): string | null {
  // Empty stays legal: buildMountArgv omits the positional path and the
  // mountos CLI picks its own default. A non-empty value has to actually be
  // an absolute path.
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

  if (profile.mountPath) argv.push(profile.mountPath)
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (profile.volume) argv.push('--volname', profile.volume)
  if (profile.fork) argv.push('--fork-name', profile.fork)
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
// build_snapshot_argv/build_deleted_argv/build_version_argv/build_fork_*_argv,
// with the same hand-synced-duplicate caveat as buildMountArgv: these only drive the
// live command preview shown in each dialog, Rust independently rebuilds and
// re-validates everything from the on-disk profile before acting.
// Short and non-linguistic: "(deleted)"/"(snapshot)"/"(version)" reads fine
// once, but a bare parenthesized suffix breaks a shell (unquoted "(" opens a
// subshell) if this argv is ever copied out of the preview and pasted
// directly, mirrors Rust's satellite_volname/satellite_suffix exactly.
function satelliteSuffix(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function satelliteVolname(profile: MountProfile, kind: string): string {
  const abbrev = kind === 'snapshot' ? 'snap' : kind === 'deleted' ? 'del' : kind === 'version' ? 'ver' : kind
  const suffix = satelliteSuffix()
  return profile.volume ? `${profile.volume}-${abbrev}-${suffix}` : `mountOS-${abbrev}-${suffix}`
}

function buildSatellitePrefix(subcommand: string, profile: MountProfile, kind: string, path: string): string[] {
  const argv = [subcommand]
  if (path) argv.push(path)
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
// so this is shared by buildMountArgv and every satellite/gateway builder,
// otherwise the command preview would show a profile's cache dir and extra
// flags for a regular mount but silently omit them for these other launches.
function pushCacheAndExtraArgs(argv: string[], profile: MountProfile): void {
  if (profile.cacheDir) argv.push('--disk-cache-dir', profile.cacheDir)
  if (profile.cacheSize) argv.push('--disk-cache-size', profile.cacheSize)
  argv.push(...profile.extraArgs)
}

// snapshot daemonizes normally (unlike deleted/version).
export function buildSnapshotArgv(profile: MountProfile, destination: string, timestamp: string): string[] {
  const argv = buildSatellitePrefix('snapshot', profile, 'snapshot', destination)
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
  const argv = buildSatellitePrefix('deleted', profile, 'deleted', destination)
  if (from?.trim()) argv.push(`--from=${from.trim()}`)
  if (idleTimeout?.trim()) argv.push(`--idle-timeout=${idleTimeout.trim()}`)
  pushSatelliteCredentials(argv, profile)
  pushCacheAndExtraArgs(argv, profile)
  // No backend flag: verified against cmd_deleted.go, deleted/version accept
  // any backend flag as a root-persistent flag but need none of them to run,
  // and forcing the primary mount's backend here would wrongly drag along
  // e.g. FSKit's rigid /Volumes/MountOS/<name> mount-point convention onto an
  // arbitrary destination folder these views have no reason to share.
  return argv
}

// selector picks the target: a browsed local path (preferred, lets the CLI
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
  const argv = buildSatellitePrefix('version', profile, 'version', destination)
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
  // No backend flag, same reasoning as buildDeletedArgv above.
  return argv
}

// No --type flag is ever emitted (defaults to "general" server-side; iceberg
// volumes have no profile representation in this GUI). No volume-identifying
// flag is needed either, since the access key alone scopes the volume.
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

// gateway-only uses the standalone `gateway` subcommand (no mount path, no
// backend flag, no --volname, confirmed against cmd_gateway.go/cmd_mount.go,
// the mount point is optional whenever --gateway-only is set, there is no
// FUSE mount at all). The mount+gateway combo instead reuses the full
// regular `buildMountArgv` output with gateway flags appended, matching the
// CLI's real combo invocation (`mount <dir> --gateway s3,hdfs`, no
// --gateway-only). Mirrors src-tauri/src/lib.rs's build_gateway_argv.
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

// Mirrors uploadjob.LooksLikeURI (mountos-servers): a "scheme://..." shape,
// requiring at least 2 chars before "://" so a Windows drive-letter path
// ("C:\...", or even a stray "c://" typo) never misdetects as a URI scheme.
// The upload form itself never sniffs a typed string to decide this --
// object-storage vs. local is an explicit toggle (see UploadsView.svelte's
// Source type selector) -- this is used only as a self-check on
// buildExternalSourceUri's OWN output before it's ever sent to argv, never
// as a security boundary (the CLI's own scheme table is authoritative).
export function looksLikeSourceUri(source: string): boolean {
  const idx = source.indexOf('://')
  return idx >= 2
}

// buildExternalSourceUri renders the "scheme://bucket/prefix" form from the
// upload form's structured provider/bucket/prefix fields -- the user never
// hand-types a URI (and so can never hand a malformed one to the CLI): gcs
// gets gs://, azure gets az://, every other provider (s3 and every
// S3-compatible one) gets s3://, mirroring mountos-servers'
// ParseExternalSourceURI's own scheme table exactly in reverse. Returns null
// when bucket is blank -- there is nothing valid to build yet.
export function buildExternalSourceUri(provider: string, bucket: string, prefix: string): string | null {
  const trimmedBucket = bucket.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmedBucket) return null
  const scheme = provider === 'azure' ? 'az' : provider === 'gcs' ? 'gs' : 's3'
  const trimmedPrefix = prefix.trim().replace(/^\/+|\/+$/g, '')
  const uri = `${scheme}://${trimmedBucket}${trimmedPrefix ? `/${trimmedPrefix}` : ''}`
  // Self-check: this construction must always produce something the CLI's
  // own detection recognizes as a URI, or a bug here would silently send an
  // external source down the local-path code path instead.
  return looksLikeSourceUri(uri) ? uri : null
}

// UPLOAD_SOURCE_PROVIDERS is the known --source-provider vocabulary
// (constants.ProviderType* in mountos-servers), for the form's Provider
// select -- a real dropdown, not free text, so a typo can never reach argv
// as an unrecognized provider the CLI would only reject after a launch
// attempt.
export const UPLOAD_SOURCE_PROVIDERS: { value: string; label: string }[] = [
  { value: 's3', label: 'S3 (AWS)' },
  { value: 's3compatible', label: 'S3-compatible (custom endpoint)' },
  { value: 'backblaze', label: 'Backblaze B2' },
  { value: 'wasabi', label: 'Wasabi' },
  { value: 'cloudflare', label: 'Cloudflare R2' },
  { value: 'digitalocean', label: 'DigitalOcean Spaces' },
  { value: 'ibmcloud', label: 'IBM Cloud Object Storage' },
  { value: 'impossiblecloud', label: 'Impossible Cloud' },
  { value: 'lyve', label: 'Seagate Lyve Cloud' },
  { value: 'azure', label: 'Azure Blob Storage' },
  { value: 'gcs', label: 'Google Cloud Storage' },
]

// validateExternalSourceFields checks the object-storage form's structured
// fields, mirroring mountos-servers' own hard requirements exactly (so a
// mistake is caught here, inline, instead of after a process is already
// spawned and failing): bucket is always required; s3compatible has no
// default endpoint (resolveEndpoint, mountos-servers) so it must be typed;
// azure authenticates with account+key so the account name is required;
// every other provider needs an access-key-id/secret pair, so the id is
// required too (gcs is the one exception -- its whole credential is the
// secret, a service-account key, no separate id). The secret itself is
// validated by the caller (runUploadStart/runUploadSourceTest), which also
// has uploadSourceSecretValue in scope.
export function validateExternalSourceFields(provider: string, bucket: string, endpoint: string, account: string, accessKeyId: string): string | null {
  if (!provider.trim()) return 'Provider is required'
  if (!bucket.trim()) return 'Bucket/container name is required'
  if (provider === 's3compatible' && !endpoint.trim()) return 'Endpoint is required for a custom S3-compatible provider'
  if (provider === 'azure' && !account.trim()) return 'Storage account name is required for Azure Blob'
  if (provider !== 'azure' && provider !== 'gcs' && !accessKeyId.trim()) return 'Access key id is required'
  return null
}

export interface UploadStartParams {
  once: boolean
  overwrite: boolean
  dryRun: boolean
  rescanInterval?: string
  restart: boolean
  bwlimit?: number
  include: string[]
  exclude: string[]
  followSymlinks: boolean
  createSourceDirectory: boolean
  // Non-secret identifiers for a URI SOURCE (s3://, az://, azblob://,
  // gs://). The secret itself is never a field here -- see
  // buildUploadStartArgv's own sourceSecretFile parameter, which is the
  // ONLY place a resolved source secret reaches this builder, and only as
  // a file path already written to disk, matching the mountos CLI's
  // --source-temporary-secret-file contract exactly.
  sourceProvider?: string
  sourceEndpoint?: string
  sourceRegion?: string
  sourceAccount?: string
  sourceAccessKeyId?: string
}

// Mirrors src-tauri/src/lib.rs's validate_upload_positional. Not itself the
// security boundary. buildUploadStartArgv's own "--" separator is what
// actually makes an arbitrary value safe in argv, but a value starting
// with '-' is rejected outright here so the user sees a clear inline error
// instead of a cryptic CLI failure (or, without the "--" fix, a genuinely
// misparsed flag).
export function validateUploadPositional(value: string, field: string): string | null {
  if (value.startsWith('-')) return `${field} must not start with '-'`
  if (value.includes('\0')) return `${field} must not contain a NUL byte`
  return null
}

// --include/--exclude glob patterns are always sent as a flag's VALUE
// (`--include <pattern>`), never scanned for flag-ness themselves. pflag
// consumes the token immediately following a value-taking flag
// unconditionally, so a leading '-' or '*' here is not an argv-injection
// risk the way a bare positional is. This is sanity validation only: reject
// what can never be a meaningful glob (empty, NUL/control bytes), not what
// looks unusual.
export function validateGlobPattern(pattern: string): string | null {
  const trimmed = pattern.trim()
  if (!trimmed) return 'pattern must not be empty'
  // eslint-disable-next-line no-control-regex (deliberately matching control bytes to reject them)
  if (/[\0-\x1f]/.test(trimmed)) return 'pattern must not contain control characters'
  return null
}

// The upload run form's flag surface, confirmed against cmd_upload.go: --fork
// (not --fork-name, unlike every mount/fork/gateway builder above), plus
// --once/--overwrite/--dry-run/--rescan-interval/--restart/--bwlimit/
// --include/--exclude/--follow-symlinks/--create-source-directory, all only
// on the top-level `upload <source> <dest>`. Included even for a dry run
// (harmless, runUploadDryRun never reads --fork/credentials at all).
// Mirrors src-tauri/src/lib.rs's build_upload_start_argv, including the
// flags-first-then-"--"-then-positionals ordering: pflag scans the whole
// token stream for anything starting with '-' regardless of position, so a
// source/dest value that happens to look like a flag would otherwise be
// misparsed as a NEW flag instead of the positional argument it is. "--"
// unconditionally ends flag parsing, making this the one argv shape that's
// actually safe for arbitrary user input, not just typical-looking paths.
export function buildUploadStartArgv(
  profile: MountProfile,
  source: string,
  dest: string,
  params: UploadStartParams,
  sourceSecretFile?: string,
): string[] {
  const argv = ['upload']
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  // Fork is always derived from the resolved profile (saved profile or
  // live/cached instance config), never a free-typed value.
  if (profile.fork) argv.push('--fork', profile.fork)
  if (params.once) argv.push('--once')
  if (params.overwrite) argv.push('--overwrite')
  if (params.dryRun) argv.push('--dry-run')
  if (params.rescanInterval?.trim()) argv.push('--rescan-interval', params.rescanInterval.trim())
  if (params.restart) argv.push('--restart')
  if (params.bwlimit && params.bwlimit > 0) argv.push('--bwlimit', String(params.bwlimit))
  for (const pattern of params.include) {
    if (pattern.trim()) argv.push('--include', pattern.trim())
  }
  for (const pattern of params.exclude) {
    if (pattern.trim()) argv.push('--exclude', pattern.trim())
  }
  if (params.followSymlinks) argv.push('--follow-symlinks')
  if (params.createSourceDirectory) argv.push('--create-source-directory')
  // Non-secret identifiers for a URI SOURCE; sourceSecretFile is the ONLY
  // secret-bearing thing this builder ever touches, and only as a path,
  // never the secret's own content -- mirrors src-tauri's
  // build_upload_start_argv exactly, including never emitting the
  // persistent --source-secret-file flag (the desktop app always uses the
  // single-use --source-temporary-secret-file handoff).
  if (params.sourceProvider?.trim()) argv.push('--source-provider', params.sourceProvider.trim())
  if (params.sourceEndpoint?.trim()) argv.push('--source-endpoint', params.sourceEndpoint.trim())
  if (params.sourceRegion?.trim()) argv.push('--source-region', params.sourceRegion.trim())
  if (params.sourceAccount?.trim()) argv.push('--source-account', params.sourceAccount.trim())
  if (params.sourceAccessKeyId?.trim()) argv.push('--source-access-key-id', params.sourceAccessKeyId.trim())
  if (sourceSecretFile) argv.push('--source-temporary-secret-file', sourceSecretFile)
  pushSatelliteCredentials(argv, profile)
  argv.push('--', source, dest)
  return argv
}

// `resume` re-registers only --once/--rescan-interval on its own subcommand
// (cobra local flags on the parent `upload` command aren't inherited by
// subcommands), so this builder's flag surface is deliberately smaller than
// buildUploadStartArgv's. Mirrors src-tauri/src/lib.rs's build_upload_resume_argv.
export function buildUploadResumeArgv(profile: MountProfile, jobId: string, once: boolean, rescanInterval?: string): string[] {
  const argv = ['upload', 'resume', jobId]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  if (once) argv.push('--once')
  if (rescanInterval?.trim()) argv.push('--rescan-interval', rescanInterval.trim())
  pushSatelliteCredentials(argv, profile)
  return argv
}

// list/cancel/retry-failed/prune are all purely local (job dir + control
// socket, none of the four touch resolveUploadCredentials server-side), so
// unlike every builder above these take no MountProfile at all: no
// --discovery-url, no --fork, no satellite credentials.
export function buildUploadListArgv(): string[] {
  return ['list', '--kind', 'upload', '--json']
}

export function buildUploadCancelArgv(jobId: string): string[] {
  return ['upload', 'cancel', jobId]
}

export function buildUploadRetryFailedArgv(jobId: string): string[] {
  return ['upload', 'retry-failed', jobId]
}

// Mirrors cmd_upload_subcommands.go's `upload finish <job-id>`, offline,
// no connection/credentials, only valid when scan.db already shows 0
// pending/uploading rows (a daemon-mode job that drained but was cancelled,
// or otherwise never reached a terminal transition on its own).
export function buildUploadFinishArgv(jobId: string): string[] {
  return ['upload', 'finish', jobId]
}

export function buildUploadPruneArgv(keep: number): string[] {
  const argv = ['upload', 'prune']
  if (keep > 0) argv.push('--keep', String(keep))
  return argv
}

// Mirrors cmd_upload_subcommands.go's `upload remove <job-id>`: deletes a
// non-running job's local record whatever its state, including resumable
// -- unlike prune, which only ever sweeps jobs already carrying a terminal
// stamp.
export function buildUploadRemoveArgv(jobId: string): string[] {
  return ['upload', 'remove', jobId]
}

export interface DownloadStartParams {
  ifExists: 'skip' | 'overwrite' | 'bounce'
  depth: number
  // Remote-mode only. Flexible format ("2025-12-05 14:30", "1d", "-5d",
  // "2h30m"), the same one `snapshot --timestamp`/`fork create --as-of`
  // accept, see buildForkCreateArgv's own `--as-of=` fused-form convention,
  // mirrored below.
  asOf?: string
  dryRun: boolean
  restart: boolean
  bwlimitMbps?: number
  includeGlobs: string[]
  excludeGlobs: string[]
  followSymlinks: boolean
  createSourceDirectory: boolean
  // Non-secret identifiers for a URI DEST_PATH (s3://, az://, azblob://,
  // gs://), the export mirror of UploadStartParams' source* fields. The
  // secret itself is never a field here -- see buildDownloadStartArgv's own
  // destSecretFile parameter, which is the ONLY place a resolved
  // destination secret reaches this builder, and only as a file path
  // already written to disk, matching the mountos CLI's
  // --dest-temporary-secret-file contract exactly.
  destProvider?: string
  destEndpoint?: string
  destRegion?: string
  destAccount?: string
  destAccessKeyId?: string
}

// `download <SOURCE> <DEST_PATH>`'s flag surface, confirmed against
// cmd_download.go: --fork/--if-exists/--depth/--as-of/--dry-run/--restart/
// --bwlimit/--include/--exclude/--follow-symlinks/--create-source-directory.
// No --once/--rescan-interval (unlike upload, a download job never
// daemon-watches forever, every run is single-pass) and no --overwrite
// (superseded by --if-exists=overwrite, never both spellings).
//
// sourceKind is the GUI's OWN mode concept (mirrors uploadSourceKind's
// 'profile'/'instance' naming), the Go CLI auto-detects mounted-vs-remote
// from the raw SOURCE path itself (detectDownloadSourceKind), but the GUI
// needs to know the mode up front to decide the form fields AND how to build
// SOURCE: 'instance' means SOURCE is a local filesystem path read straight
// through an already-live mount, so this emits NO --discovery-url/--fork/
// --as-of/-a/-s at all (mode A: "No RPC, no connection, no creds"); 'profile'
// means SOURCE is a mountOS-relative path string on a saved profile's fork,
// so this emits all of those from `profile`/`params.asOf`.
//
// Mirrors src-tauri/src/lib.rs's build_download_start_argv, including the
// flags-first-then-"--"-then-positionals ordering (see buildUploadStartArgv's
// own comment for why "--" is the actual safety boundary for an arbitrary
// source/dest value, not this function's up-front validation).
export function buildDownloadStartArgv(
  profile: MountProfile | null,
  sourceKind: 'instance' | 'profile',
  source: string,
  dest: string,
  params: DownloadStartParams,
  destSecretFile?: string,
): string[] {
  const argv = ['download']
  if (sourceKind === 'profile') {
    if (!profile) throw new Error('a profile is required for a remote download source')
    if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
    // Fork is always derived from the resolved profile, never a free-typed
    // value, mirrors buildUploadStartArgv's own --fork sourcing. Omitted
    // when empty, same as every other profile-derived flag here: the CLI's
    // own "main" default then applies.
    if (profile.fork) argv.push('--fork', profile.fork)
    if (params.asOf?.trim()) argv.push(`--as-of=${params.asOf.trim()}`)
  }
  // Value flags with a server-side default are only emitted when they
  // diverge from it, same convention as buildVersionArgv's versionFormat.
  if (params.ifExists !== 'skip') argv.push('--if-exists', params.ifExists)
  if (params.depth !== 1) argv.push('--depth', String(params.depth))
  if (params.dryRun) argv.push('--dry-run')
  if (params.restart) argv.push('--restart')
  if (params.bwlimitMbps && params.bwlimitMbps > 0) argv.push('--bwlimit', String(params.bwlimitMbps))
  for (const pattern of params.includeGlobs) {
    if (pattern.trim()) argv.push('--include', pattern.trim())
  }
  for (const pattern of params.excludeGlobs) {
    if (pattern.trim()) argv.push('--exclude', pattern.trim())
  }
  if (params.followSymlinks) argv.push('--follow-symlinks')
  if (params.createSourceDirectory) argv.push('--create-source-directory')
  // Non-secret identifiers for a URI DEST_PATH; destSecretFile is the ONLY
  // secret-bearing thing this builder ever touches, and only as a path,
  // never the secret's own content -- mirrors buildUploadStartArgv's
  // sourceSecretFile handling exactly, including never emitting the
  // persistent --dest-secret-file flag (the desktop app always uses the
  // single-use --dest-temporary-secret-file handoff).
  if (params.destProvider?.trim()) argv.push('--dest-provider', params.destProvider.trim())
  if (params.destEndpoint?.trim()) argv.push('--dest-endpoint', params.destEndpoint.trim())
  if (params.destRegion?.trim()) argv.push('--dest-region', params.destRegion.trim())
  if (params.destAccount?.trim()) argv.push('--dest-account', params.destAccount.trim())
  if (params.destAccessKeyId?.trim()) argv.push('--dest-access-key-id', params.destAccessKeyId.trim())
  if (destSecretFile) argv.push('--dest-temporary-secret-file', destSecretFile)
  if (sourceKind === 'profile' && profile) pushSatelliteCredentials(argv, profile)
  argv.push('--', source, dest)
  return argv
}

// `download resume <job-id>` registers no distinctive flags of its own on
// the resume subcommand (unlike `upload resume`'s --once/--rescan-interval,
// download has neither, every run is already single-pass), but a
// remote-mode job still needs --discovery-url/-a/-s (root-inherited global
// flags) to reconnect. Mirrors buildUploadResumeArgv's exact credential-flag
// pattern minus once/rescanInterval: profile-emptiness-gated, so passing a
// profile with blank discoveryUrl/accessKeyId (a mounted-source job, which
// needs no credentials to resume) naturally emits neither flag.
export function buildDownloadResumeArgv(profile: MountProfile, jobId: string): string[] {
  const argv = ['download', 'resume', jobId]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  pushSatelliteCredentials(argv, profile)
  return argv
}

// list/cancel/retry-failed/prune are all purely local (job dir + control
// socket, confirmed against cmd_list_download.go/cmd_download_subcommands.go,
// none of the four touch resolveUploadCredentials), so unlike
// buildDownloadStartArgv/buildDownloadResumeArgv these take no MountProfile
// at all: no --discovery-url, no --fork, no satellite credentials.
export function buildDownloadListArgv(): string[] {
  return ['list', '--kind', 'download', '--json']
}

export function buildDownloadCancelArgv(jobId: string): string[] {
  return ['download', 'cancel', jobId]
}

export function buildDownloadRetryFailedArgv(jobId: string): string[] {
  return ['download', 'retry-failed', jobId]
}

// Mirrors cmd_download_subcommands.go's `download finish <job-id>`, offline,
// no connection/credentials, only valid when scan.db already shows 0
// pending/downloading rows (a job that was cancelled or otherwise never
// reached a terminal transition on its own despite having nothing left).
export function buildDownloadFinishArgv(jobId: string): string[] {
  return ['download', 'finish', jobId]
}

export function buildDownloadPruneArgv(keep: number): string[] {
  const argv = ['download', 'prune']
  if (keep > 0) argv.push('--keep', String(keep))
  return argv
}

// Mirrors cmd_download_subcommands.go's `download remove <job-id>`: deletes
// a non-running job's local record whatever its state, including resumable
// -- unlike prune, which only ever sweeps jobs already carrying a terminal
// stamp.
export function buildDownloadRemoveArgv(jobId: string): string[] {
  return ['download', 'remove', jobId]
}

export interface SinkStartParams {
  variant?: string
  maxLatency?: string
  walMax?: string
}

// `mountos sink <M3U8_URL> <SINK_PATH>`'s flag surface, confirmed against
// cmd_sink.go: --fork (not --fork-name, matches upload's convention), plus
// --variant/--max-latency/--wal-max. No --config here: the desktop only
// drives the single-stream form, never the multi-stream YAML file. No
// --once/--overwrite/--dry-run/--bwlimit/--include/--exclude/
// --follow-symlinks/--create-source-directory either, sink has none of
// those, do not carry them over from upload/download by habit. Mirrors
// src-tauri/src/lib.rs's build_sink_start_argv, including the
// flags-first-then-"--"-then-positionals ordering (see
// buildUploadStartArgv's own comment for why "--" is the actual safety
// boundary for an arbitrary source/dest value).
export function buildSinkStartArgv(profile: MountProfile, source: string, dest: string, params: SinkStartParams): string[] {
  const argv = ['sink']
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  // Fork is always derived from the resolved profile, never a free-typed
  // value, mirrors buildUploadStartArgv's own --fork sourcing.
  if (profile.fork) argv.push('--fork', profile.fork)
  if (params.variant?.trim()) argv.push('--variant', params.variant.trim())
  if (params.maxLatency?.trim()) argv.push('--max-latency', params.maxLatency.trim())
  if (params.walMax?.trim()) argv.push('--wal-max', params.walMax.trim())
  pushSatelliteCredentials(argv, profile)
  argv.push('--', source, dest)
  return argv
}

// `sink resume <job-id>` registers no flags of its own (confirmed against
// createSinkResumeCommand, cmd_sink.go: no --variant/--max-latency/
// --wal-max on the resume subcommand, job.json already fixes those
// server-side), only the root-inherited --discovery-url/-a/-s needed to
// reconnect. Mirrors buildUploadResumeArgv's credential-flag pattern minus
// once/rescanInterval, which sink never had to begin with.
export function buildSinkResumeArgv(profile: MountProfile, jobId: string): string[] {
  const argv = ['sink', 'resume', jobId]
  if (profile.discoveryUrl) argv.push('--discovery-url', profile.discoveryUrl)
  pushSatelliteCredentials(argv, profile)
  return argv
}

// list/cancel/status are purely local (job dir + control socket, confirmed
// against cmd_sink.go/cmd_list_sink.go: none of the three call
// resolveUploadCredentials), so unlike buildSinkStartArgv/buildSinkResumeArgv
// these take no MountProfile at all. `sink list` is its own subcommand, not
// `mountos list --kind sink` (a sink row's rate/lag shape doesn't fit
// mountListEntry's per-status counts map, see cmd_list_sink.go's own doc
// comment), so the argv shape differs from buildUploadListArgv/
// buildDownloadListArgv.
export function buildSinkListArgv(): string[] {
  return ['sink', 'list', '--json']
}

export function buildSinkCancelArgv(jobId: string): string[] {
  return ['sink', 'cancel', jobId]
}

// Mirrors cmd_sink.go's `sink finish <job-id>`. While the job is running this
// signals a live control-socket shutdown (drains the WAL, writes the real
// EXT-X-ENDLIST, ends the job); when not running it stamps the terminal
// state directly once the WAL is already drained. Same subcommand either
// way, no separate flag, same reasoning as buildUploadFinishArgv.
export function buildSinkFinishArgv(jobId: string): string[] {
  return ['sink', 'finish', jobId]
}

export function buildSinkStatusArgv(jobId: string): string[] {
  return ['sink', 'status', '--job', jobId, '--json']
}

export function buildSinkPruneArgv(keep: number): string[] {
  const argv = ['sink', 'prune']
  if (keep > 0) argv.push('--keep', String(keep))
  return argv
}

// Mirrors cmd_sink.go's `sink remove <job-id>`: deletes a non-running job's
// local record whatever its state, including resumable -- unlike prune,
// which only ever sweeps jobs already carrying a terminal stamp.
export function buildSinkRemoveArgv(jobId: string): string[] {
  return ['sink', 'remove', jobId]
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
