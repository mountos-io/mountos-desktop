export type Backend = 'auto' | 'macfuse' | 'fskit' | 'nfs' | 'smb' | 'mountosio'
export type SecretRef = 'vault' | 'prompt'
export type ProfileKind = 'mount' | 'gateway'
export type HealthState = 'healthy' | 'launching' | 'flushing' | 'lost' | 'stalled' | 'reconnecting' | 'idle'
export type ErrorClass =
  | 'cli-unavailable'
  | 'auth'
  | 'network-discovery'
  | 'backend-missing'
  | 'mountpoint'
  | 'capacity'
  | 'volume-state'
  | 'indeterminate'
  | 'unknown'

export interface MountProfile {
  id: string
  schemaVersion: 1
  kind: ProfileKind
  name: string
  volume: string
  fork: string
  mountPath: string
  discoveryUrl: string
  accessKeyId: string
  secretRef: SecretRef
  backend: Backend
  cacheDir?: string
  cacheSize?: string
  readOnly: boolean
  autoRemount: boolean
  temporaryFork: boolean
  trustedDiscoveryHost?: string
  extraArgs: string[]
  createdAt: string
  updatedAt: string
  // Detected once from the mounted volume's own `.mountOS/.volume-type` file,
  // the first time this profile mounts successfully (or at creation time via
  // Save-as-profile off an already-running external mount). Undefined until
  // detected. Once set, the backend locks accessKeyId/discoveryUrl/volume
  // against further edits (fork/backend stay editable), see
  // require_stable_identity in src-tauri/src/lib.rs.
  volumeKind?: 'general' | 'iceberg'
}

// TransferSourceProfile is a saved `upload`/`import` external-object-store
// source (provider/bucket/prefix/credentials) -- deliberately NOT a
// MountProfile: it names a bucket to pull FROM, never a mountOS volume to
// mount. See src-tauri/src/lib.rs's own doc comment on TransferSourceProfile
// for why this is a distinct persisted+vaulted entity, not a variant.
export interface TransferSourceProfile {
  id: string
  schemaVersion: 1
  name: string
  provider: string
  bucket: string
  prefix?: string
  endpoint?: string
  region?: string
  account?: string
  accessKeyId?: string
  secretRef: SecretRef
  createdAt: string
  updatedAt: string
}

export interface Fork {
  name: string
  fid: number
  parentName?: string
  parentFid: number
  createdAt?: number
  inactiveAt?: number
  childrenCount?: number
  isTemporary?: boolean
  inactive?: boolean
}

// One row from `mountos list --kind upload --json`, as returned by the
// list_uploads Tauri command (src-tauri/src/lib.rs's UploadJob).
export interface UploadJob {
  jobId: string
  name: string
  sourcePath?: string
  destPath?: string
  forkName?: string
  // running | halted | completed | resumable
  state: string
  counts: Record<string, number>
  haltReason?: string
  pid?: number
  // The volume this job was created against. Server-side
  // validateResumeVolumeMatch already refuses to resume under mismatched
  // credentials, so this is informational only (lets the UI show/warn
  // which volume a job belongs to), not itself the enforcement point.
  volumeId?: number
  // job.json's own UnixNano timestamps, unrelated to any filesystem mtime.
  // Lets the list be sorted meaningfully (list --kind upload otherwise
  // returns directory-name/hex-hash order, arbitrary with respect to
  // recency).
  createdAt?: number
  completedAt?: number
  // Path to the file logger's output for this job's last terminal run, only
  // present when that file still exists on disk (see uploadjob.JobSpec's
  // LogPath doc comment server-side).
  logPath?: string
  // A live aggregate as of the server's last scan pass, not a fixed total,
  // a daemon-mode job (state running/resumable) can keep discovering more on
  // every rescan, so treat this as provisional unless state is
  // completed/halted.
  totalFiles?: number
  totalBytes?: number
}

// One row from `mountos list --kind download --json`, as returned by the
// list_downloads Tauri command (src-tauri/src/lib.rs's DownloadJob). Same
// shape as UploadJob field-for-field (verified identical Go mountListEntry
// struct, same field names), so its field comments above apply here
// unchanged; only the counts keys differ in meaning (pending | downloading |
// done | failed | skipped | missing, plus a synthetic "retrying" key for
// entries currently in backoff, self-clearing, distinct from "failed"
// which needs `download retry-failed`).
export interface DownloadJob {
  jobId: string
  name: string
  sourcePath?: string
  destPath?: string
  forkName?: string
  // running | halted | completed | resumable
  state: string
  counts: Record<string, number>
  haltReason?: string
  pid?: number
  volumeId?: number
  createdAt?: number
  completedAt?: number
  logPath?: string
  totalFiles?: number
  totalBytes?: number
}

// One row from `mountos sink list --json` (src-tauri/src/lib.rs's SinkJob,
// mirroring mountos-servers cmd_list_sink.go's sinkListEntry). A sink job's
// live state is rate/lag counters, not a bounded per-status work list, so
// this is a genuinely different shape from UploadJob/DownloadJob's
// `counts` map, not a reuse of it. Every counter is 0/absent for a job with
// neither a live daemon nor cached counters. A stopped job with cached
// final counters (JobSpec.CachedCounts) reports them too, with lastKnown
// true. lagSegments/lagSeconds stay 0 in that case, since they describe an
// active fetch loop that no longer exists; never render them as a real
// reading when lastKnown is set.
export interface SinkJob {
  jobId: string
  name: string
  // running | halted | completed | resumable | finished
  state: string
  source: string // redacted stream URL
  sinkTemplate: string
  fork: string
  lagSegments?: number
  lagSeconds?: number
  walBytes?: number
  walSegments?: number
  discontinuities?: number
  segmentsFetched?: number
  bytesCommitted?: number
  fetchErrors?: number
  commitRetries?: number
  haltReason?: string
  pid?: number
  createdAt?: number
  completedAt?: number
  logPath?: string
  lastKnown?: boolean
  // Number of destination files this job has produced so far, and the
  // rendered path of the one currently being written, both absent before the
  // first file opens; see cmd_list_sink.go's sinkListEntry.FileCount/
  // .CurrentPath doc comments.
  fileCount?: number
  currentPath?: string
}

// The fuller single-job snapshot from `mountos sink status --job <id>
// --json` (src-tauri/src/lib.rs's SinkSnapshot, mirroring mountos-servers
// sink_runner.go's SinkSnapshot). Present for a running job (a live
// reading) or for a stopped job with cached final counters (SinkStatus.
// lastKnown true); see SinkStatus's own doc comment. lastCommitAt/
// lastSegmentAt are ISO timestamps, absent (not the Go zero-time string)
// when nothing has committed/arrived yet this run, and always absent for a
// cached snapshot: the cache does not persist them.
export interface SinkSnapshot {
  state: string
  lagSegments: number
  lagSeconds: number
  walBytes: number
  walSegments: number
  discontinuities: number
  segmentsFetched: number
  segmentsCommitted: number
  bytesCommitted: number
  fileSize: number
  bitrateObserved: number
  fetchErrors: number
  commitRetries: number
  // Number of destination files opened so far, and the rendered path of the
  // one currently being written; neither is omitempty Go-side, see
  // sink_runner.go's SinkSnapshot.FileCount/.CurrentPath doc comments.
  fileCount: number
  currentPath: string
  lastCommitAt?: string
  lastSegmentAt?: string
}

// As returned by the get_sink_status Tauri command (src-tauri/src/lib.rs's
// SinkStatus, mirroring mountos-servers cmd_sink.go's sinkStatusPayload).
// lastKnown marks snapshot as job.json's cached final counters rather than
// a live reading (running false, a stopped job with JobSpec.CachedCounts).
export interface SinkStatus {
  jobId: string
  running: boolean
  // running | halted | completed | resumable
  state: string
  friendlyName?: string
  source?: string
  sinkTemplate?: string
  fork?: string
  haltReason?: string
  snapshot?: SinkSnapshot
  lastKnown?: boolean
}

// An upload source that's a live running mount instance rather than a
// saved profile, discoveryUrl/fork/volume/accessKeyId are captured once
// (via getInstanceConfig) the moment the instance is picked, and reused
// verbatim by the Rust side if the instance is no longer mounted by the
// time Browse/Start actually runs (see src-tauri/src/lib.rs's
// resolve_upload_source_profile). Mirrors src-tauri/src/lib.rs's
// UploadInstanceRef field-for-field.
export interface UploadInstanceRef {
  mountPath: string
  backend: Backend
  discoveryUrl: string
  fork: string
  volume: string
  accessKeyId: string
}

export interface MountInstance {
  key: string
  name: string
  mountPath: string
  /** Device string ("mountos:<volume>"). Identifies the volume, not the backend. */
  fsName?: string
  /** Transport the mount runs on, from `mountos list`. Absent on older CLIs. */
  backend?: Backend
  viewMode?: string
  volumeIdentifier?: string
  volumeId?: number
  uncPath?: string
  versionInode?: string
  orphaned?: boolean
  /** "mount" (implied when absent, for an older CLI) or "gateway", a gateway-only instance has no mountPath/backend/fsName, only gatewayEndpoints. */
  kind?: 'mount' | 'gateway'
  gatewayEndpoints?: GatewayEndpointInfo[]
  /** Only meaningful for a "gateway" entry, lets Stop gateway target the right process. */
  pid?: number
  /** ISO timestamp from this instance's own .mountOS/.config, read fresh on every poll. */
  mountTime?: string
  /** "general"/"iceberg" from this instance's own .mountOS/.config, unlike MountProfile.volumeKind, works for external mounts too. */
  volumeKind?: string
  /** From this instance's own .mountOS/.config; not in `mountos list --json` at all. */
  temporaryFork?: boolean
  external: boolean
  /** Saved profile matching this mount's path, if any. `external` is this being absent. */
  profileId?: string
  health: HealthState
}

export interface CheckIssue {
  id: string
  severity: 'info' | 'warning' | 'error'
  title: string
  detail?: string
  fixCommand?: string
}

export interface TerminalOption {
  id: string
  label: string
}

export interface SystemState {
  platform: 'macos' | 'windows' | 'linux' | string
  cliPath?: string
  cliVersion?: string
  checkOk: boolean
  issues: CheckIssue[]
  instances: MountInstance[]
  // Other mountos binaries found on PATH besides the one in use (empty in
  // the common single-install case). Surfaces ambiguity instead of
  // silently trusting whichever PATH match resolved first.
  cliPathAlternates: string[]
  // Terminal emulators detected on this machine, in preference order. The
  // settings picker offers exactly these, so it can only list installed ones.
  terminals: TerminalOption[]
}

export interface SecretStatus {
  profileId: string
  stored: boolean
}

export interface CliSignatureStatus {
  verified: boolean
  detail: string
}

export interface DesktopSettings {
  defaultBackend: Backend
  // Seeds new profiles' discoveryUrl; each profile can still override it
  // independently afterward. Existing profiles are never retroactively
  // rewritten when this changes.
  defaultDiscoveryUrl?: string
  // Seeds new profiles' cacheDir. Undefined means no override (the CLI's
  // own ~/.mountOS/cache default applies).
  defaultCacheDir?: string
  // Seeds new profiles' cacheSize (--disk-cache-size). Undefined means Auto:
  // no flag emitted, so the CLI's own free-disk-scaled [10G, 100G] clamp
  // applies. The Settings UI offers a fixed override via an Auto checkbox.
  defaultCacheSize?: string
  // Pins an exact mountos binary instead of the first PATH match. Once
  // set, a moved/missing pinned binary is a hard error rather than a
  // silent fallback to a different install.
  cliPathOverride?: string
  // How often the mount list refreshes while the window is visible, in seconds.
  // Undefined means the default. A hidden window backs off regardless.
  pollSeconds?: number
  // Terminal emulator id for the dashboard launcher. Empty/undefined means the
  // platform's stock terminal. Unlike cliPathOverride this is a preference, not
  // a pin: an uninstalled choice falls back instead of failing.
  terminal?: string
  // Gates the Fork management surface (fork list/create/delete/restore) in
  // the profile editor. Off by default: fork delete/restore mutate shared
  // server-side volume state used by every other mount of the volume, not
  // just this profile's. Required (not optional): Rust always emits this
  // key via a plain bool + #[serde(default)], it just defaults to false.
  allowForkForceDelete: boolean
  // Offers Force on the unmount prompt. Required (not optional) for the same
  // reason as allowForkForceDelete.
  allowUnmountForce: boolean
  // User overrides for optional-feature visibility (see $lib/features),
  // keyed by feature id. Absent id means "use the registry default", not
  // "off". Local to this install only, never synced anywhere. Required (not
  // optional): the field is a plain (non-Option) map on the Rust struct, so
  // it is always present in outgoing JSON; #[serde(default)] only lets a
  // settings.json written before this field existed still deserialize, to
  // an empty map, rather than failing.
  featureOverrides: Record<string, boolean>
}

export interface ExportedProfile {
  path: string
}

export interface DiagnosticsCommandOutput {
  status: number | null
  stdout: unknown
  stderr: unknown
}

export interface DiagnosticsProfileSummary {
  id: string
  name: string
  kind: string
  mountPath: string
  discoveryUrl: string
  backend: Backend
  secretRef: SecretRef
  extraArgsCount: number
  autoRemount: boolean
}

// mountosio kernel driver counters. Absent on non-Windows, or when the driver
// is not installed / its control device is inaccessible.
export interface KernelDiagnostics {
  invariantTotal: number
  irpDoubleCompletions: number
  faultInjections: number
  invariantSites?: Record<string, number>
}

export interface DiagnosticsContent {
  createdAtUnix: number
  cliPath?: string
  cliVersion?: string
  check?: DiagnosticsCommandOutput
  list?: DiagnosticsCommandOutput
  kernelDiagnostics?: KernelDiagnostics
  profiles: DiagnosticsProfileSummary[]
}

export interface DiagnosticsBundle {
  path: string
  content?: DiagnosticsContent
}

export interface MountResult {
  state: 'ready' | 'indeterminate'
  target: string
}

export interface UnmountResult {
  state: 'idle' | 'flushing'
  target: string
}

export interface GatewayEndpointInfo {
  protocol: string
  url: string
  region?: string
}

export interface GatewayLaunchResult {
  state: 'ready' | 'indeterminate'
  // Discovered from the gateway descriptor file (best-effort); absent means
  // the descriptor wasn't found, not that the launch failed. No PID means no
  // Stop-gateway action can be offered for it.
  pid?: number
  endpoints: GatewayEndpointInfo[]
}

export interface UnmountAllResult {
  attempted: number
  failed: string[]
  // Subset of failed that the CLI reported as busy. Those are still mounted
  // and serving, and are the ones a forced retry can get past.
  busy: string[]
}

export interface LicensedPackage {
  name: string
  version: string
  repository: string | null
}

export interface LicenseGroup {
  id: string
  name: string
  text: string
  packages: LicensedPackage[]
}

export interface ThirdPartyLicenses {
  licenses: LicenseGroup[]
}
