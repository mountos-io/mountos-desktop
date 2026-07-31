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
  // against further edits (fork/backend stay editable) -- see
  // require_stable_identity in src-tauri/src/lib.rs.
  volumeKind?: 'general' | 'iceberg'
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
  // job.json's own UnixNano timestamps, unrelated to any filesystem mtime
  // -- lets the list be sorted meaningfully (list --kind upload otherwise
  // returns directory-name/hex-hash order, arbitrary with respect to
  // recency).
  createdAt?: number
  completedAt?: number
}

// An upload source that's a live running mount instance rather than a
// saved profile -- discoveryUrl/fork/volume/accessKeyId are captured once
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
  /** "mount" (implied when absent, for an older CLI) or "gateway" -- a gateway-only instance has no mountPath/backend/fsName, only gatewayEndpoints. */
  kind?: 'mount' | 'gateway'
  gatewayEndpoints?: GatewayEndpointInfo[]
  /** Only meaningful for a "gateway" entry -- lets Stop gateway target the right process. */
  pid?: number
  /** ISO timestamp from this instance's own .mountOS/.config, read fresh on every poll. */
  mountTime?: string
  /** "general"/"iceberg" from this instance's own .mountOS/.config -- unlike MountProfile.volumeKind, works for external mounts too. */
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

export interface DiagnosticsContent {
  createdAtUnix: number
  cliPath?: string
  cliVersion?: string
  check?: DiagnosticsCommandOutput
  list?: DiagnosticsCommandOutput
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
