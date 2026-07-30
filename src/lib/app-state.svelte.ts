import { tick } from 'svelte'
import { showErrorToast, showInfoToast, showWarningToast } from './toast.svelte'
import {
  buildDeletedArgv,
  buildForkCreateArgv,
  buildForkDeleteArgv,
  buildForkListArgv,
  buildForkRestoreArgv,
  buildGatewayArgv,
  buildMountArgv,
  buildSnapshotArgv,
  buildUploadCancelArgv,
  buildUploadListArgv,
  buildUploadPruneArgv,
  buildUploadResumeArgv,
  buildUploadRetryFailedArgv,
  buildUploadStartArgv,
  buildVersionArgv,
  classifyMountError,
  errorClassLabel,
  isAbsolutePath,
  isValidFolderName,
  parseArgvInput,
  validateExtraArgs,
  validateMountPathForBackend,
} from './cli'
import type { UploadStartParams } from './cli'
import { viewModeBadge } from './health'
import {
  browseCliBinary,
  browseFolder,
  browseVersionFile as pickVersionFile,
  cancelUpload,
  createDiagnosticsBundle,
  defaultViewDestination,
  deleteProfile,
  deleteProfileSecret,
  exportProfile,
  forkCreate,
  forkDelete,
  forkList,
  forkRestore,
  getInstanceConfig,
  getProfileSecretStatus,
  getSettings,
  getSystemState,
  getThirdPartyLicenses,
  launchDashboard,
  listProfiles,
  mcpInstall,
  mcpStatus,
  mcpUninstall,
  mountHelp,
  mountProfile,
  openDeletedView,
  openDeletedViewForInstance,
  openDiagnosticsBundle,
  openGateway,
  openLostFound,
  openSnapshotView,
  openTarget,
  openVersionView,
  openVersionViewForInstance,
  listUploads,
  pruneUploads,
  resumeUpload,
  retryFailedUpload,
  saveProfile,
  saveSettings,
  setProfileSecret,
  startUpload,
  stopGateway,
  stopGatewayOnly,
  unmountTarget,
  unmountAllTargets,
  validateCliCandidate,
} from './tauri'
import type {
  Backend,
  DesktopSettings,
  DiagnosticsBundle,
  Fork,
  GatewayEndpointInfo,
  MountInstance,
  MountProfile,
  SystemState,
  ThirdPartyLicenses,
  UploadJob,
} from './types'

export type View = 'instances' | 'profiles' | 'uploads' | 'settings'

// The profile editor's right-hand pane: the plain editor form, or one of the
// five full-width sub-views nested under the selected profile (Forks and the
// four former Snapshot/Deleted/Version/Gateway dialogs).
export type ProfileSubView = 'editor' | 'forks' | 'snapshot' | 'deleted' | 'version' | 'gateway'

// The subset of an instance's own live .mountOS/.config (read via
// getInstanceConfig) relevant to the external Deleted/Version dialogs --
// enough to know whether a secret is needed and to render a real COMMAND
// PREVIEW, without a MountProfile to read from.
export interface ExternalMountConfig {
  discoveryUrl: string
  fork: string
  volume: string
  accessKeyId: string
}

// mountOS access key IDs are fixed-length; this only checks length (not
// charset) since that's the one constraint the GUI can enforce cheaply.
export const ACCESS_KEY_ID_LENGTH = 20
export const SECRET_ACCESS_KEY_LENGTH = 40

// Mount-list refresh cadence. The options are fixed rather than a free number
// field: the useful range is small, and a typo'd 0 would hammer the CLI.
export const DEFAULT_POLL_SECONDS = 10
export const HIDDEN_POLL_MS = 30_000
export const POLL_CHOICES = [0, 2, 5, 10, 30, 60]

// Starting point offered when a user turns off Auto disk-cache sizing --
// not a hidden default (Auto, i.e. no --disk-cache-size at all, leaving the
// CLI's own free-disk-scaled [10G, 100G] clamp in charge, is the real
// default and what ships unset).
export const AGGRESSIVE_CACHE_SIZE = '100G'

// Matches the old banner's auto-dismiss window.
const NOTICE_AUTO_DISMISS_MS = 6000

export interface GatewayLaunchRecord {
  id: string
  profileId: string
  profileName: string
  // Present only for a mount+gateway combo launch (matches an instance row
  // by mountPath for badging); absent for gateway-only, which has no
  // matching row at all.
  mountPath?: string
  protocols: string[]
  pid?: number
  endpoints: GatewayEndpointInfo[]
}

function initialSidebarCollapsed(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('mountos-desktop-sidebar-collapsed') === 'true'
}

function initialSkipUnmountConfirm(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem('mountos-desktop-skip-unmount-confirm') === 'true'
}

const state = $state({
  view: 'instances' as View,
  loaded: false,
  profiles: [] as MountProfile[],
  systemState: { platform: 'macos', checkOk: false, issues: [], instances: [], cliPathAlternates: [], terminals: [] } as SystemState,
  selectedProfileId: null as string | null,
  // The volume kind as last known persisted (selectProfile/refresh/save),
  // NOT the live-edited draft in `profiles` -- patchProfile mutates that
  // immediately on every keystroke/selection, before Save is ever pressed,
  // so using it directly would show the "locked" read-only state (and grey
  // out accessKeyId/discoveryUrl/volume) the instant a value is picked in
  // the dropdown, not once it's actually saved and the backend's
  // require_stable_identity actually locks it.
  selectedProfileSnapshotVolumeKind: undefined as 'general' | 'iceberg' | undefined,
  query: '',
  profileQuery: '',
  busy: false,
  commandText: '',
  rejectedArgs: [] as string[],
  extraArgsInput: '',
  extraArgsError: '',
  settings: { defaultBackend: 'auto', allowForkForceDelete: false, allowUnmountForce: false } as DesktopSettings,
  vaultStatus: {} as Record<string, boolean>,
  diagnosticsBundle: null as DiagnosticsBundle | null,
  mcpStatusText: '',
  expandedConfig: {} as Record<string, string>,
  mountHelpText: '',
  mountHelpVisible: false,
  sidebarCollapsed: initialSidebarCollapsed(),
  skipUnmountConfirm: initialSkipUnmountConfirm(),
  tipsOpen: false,
  licensesOpen: false,
  licensesKind: 'rust' as 'rust' | 'js',
  licensesLoading: false,
  licensesError: '',
  licensesData: {} as Partial<Record<'rust' | 'js', ThirdPartyLicenses>>,

  // Secret prompt (mount)
  secretPromptFor: null as string | null,
  secretValue: '',
  secretError: '',
  savePromptedSecret: false,

  // Delete-profile confirm
  deletePromptFor: null as MountProfile | null,

  // Unmount confirm
  unmountPromptFor: null as MountInstance | 'all' | null,
  // Per-prompt opt-in to --force, only offered when settings.allowUnmountForce
  // is on. Reset every time the prompt opens or closes.
  unmountPromptForce: false,

  // Stop-gateway confirm (standalone gateway-only rows -- see runStopGatewayOnly)
  stopGatewayPromptFor: null as MountInstance | null,

  // Fork management: its own navigable place (ForkBrowserView), reached from
  // the profile editor via a "Forks" satellite button -- not embedded inline
  // in the editor form. Always available; only --force on delete is gated
  // (settings.allowForkForceDelete).
  profileSubView: 'editor' as ProfileSubView,
  forks: [] as Fork[],
  // null = viewing the profile's own root ("main"); otherwise the fid of the
  // fork currently drilled into. Pure client-side navigation over `forks`,
  // no CLI call -- see drillIntoFork.
  forkDrillFid: null as number | null,
  forkListSecretValue: '',
  forkBusy: false,
  forkError: '',

  // Create/delete/restore are dialogs, same secret-conditional-field
  // convention as mount and the Snapshot/Deleted/Version/Gateway dialogs.
  forkCreatePromptFor: null as MountProfile | null,
  forkCreateName: '',
  forkCreateParent: '',
  forkCreateAsOfLocal: '',
  forkCreateSecretValue: '',
  forkCreateError: '',

  // Delete/restore target one specific fork (a row action), not a free-text
  // or Select-picked name -- this dialog is also the delete confirmation
  // fork delete previously had none of.
  forkDeletePromptFor: null as Fork | null,
  forkDeleteForce: false,
  forkDeleteSecretValue: '',
  forkDeleteError: '',

  forkRestorePromptFor: null as Fork | null,
  forkRestoreSecretValue: '',
  forkRestoreError: '',

  // Uploads: a top-level view (like Instances/Profiles), not entered from a
  // specific profile the way Forks/Snapshot/Deleted/Version/Gateway are --
  // `mountos list --kind upload --json` reports every job regardless of
  // which profile started it, so the list itself needs no profile selection.
  // Only the start/resume forms need one (to source discovery-url/fork/
  // credentials), reusing the same selectedProfileId/selectedProfile every
  // other profile-scoped action already uses.
  uploads: [] as UploadJob[],
  uploadsBusy: false,
  uploadsError: '',

  // Start form fields. include/exclude are newline-separated textareas
  // (split into glob arrays at submit time) rather than a dynamic list of
  // inputs -- simpler to bind, and --include/--exclude are themselves
  // free-form globs a user is likely to paste several of at once.
  uploadSource: '',
  uploadDest: '',
  uploadFork: '',
  uploadOnce: false,
  uploadOverwrite: false,
  uploadDryRun: false,
  uploadRescanInterval: '',
  uploadRestart: false,
  uploadBwlimit: '',
  uploadIncludeText: '',
  uploadExcludeText: '',
  uploadFollowSymlinks: false,
  uploadCreateSourceDirectory: false,
  uploadStartSecretValue: '',
  uploadStartError: '',
  // Populated only after a --dry-run start (the report text itself, not a
  // real job) -- cleared the moment the form's source/dest/flags change
  // again, since a stale report would otherwise look like it still applies.
  uploadDryRunReport: '',

  uploadResumePromptFor: null as UploadJob | null,
  uploadResumeOnce: false,
  uploadResumeRescanInterval: '',
  uploadResumeSecretValue: '',
  uploadResumeError: '',

  // Prune is the one upload action that's a permanent, irreversible delete
  // of job records (unlike cancel/retry-failed, which only touch live state
  // and stay resumable) -- same reason fork delete gets a confirm dialog.
  uploadPrunePromptOpen: false,
  uploadPruneKeep: '0',
  uploadPruneError: '',

  // Snapshot/Deleted/Version view-mounts: destination is always an explicit
  // folder pick (browseFolder), never free-typed -- -m/--destination is
  // mandatory server-side for all three (no auto-derivation exists).
  // Profile-based, not instance-based: none of these CLI commands need an
  // existing running mount, they connect to discovery+dataserv independently.
  // Which profile: computed.selectedProfile (see profileSubView), not a
  // separately-captured field -- patchProfile replaces objects in
  // state.profiles on every edit, so a second captured copy would drift.
  snapshotDestination: '',
  snapshotTimeMode: 'absolute' as 'absolute' | 'relative',
  snapshotAbsoluteValue: '',
  snapshotRelativeQty: '',
  snapshotRelativeUnit: 'h' as 'm' | 'h' | 'd',
  snapshotSecretValue: '',
  snapshotError: '',

  deletedDestination: '',
  // --from has the same absolute-or-relative duality as snapshot's
  // --timestamp (CLI default applies when omitted, hence the extra 'default'
  // mode rather than always forcing a value).
  deletedFromMode: 'default' as 'default' | 'absolute' | 'relative',
  deletedFromAbsoluteValue: '',
  deletedFromRelativeQty: '',
  deletedFromRelativeUnit: 'd' as 'm' | 'h' | 'd',
  deletedIdleTimeout: '30m',
  deletedSecretValue: '',
  deletedError: '',

  versionDestination: '',
  versionPath: '',
  // Advanced/power-user fallback: hand-typed inode, plain by-inode lookup
  // only (no browse-derived parent/name, so no multi-key discovery).
  versionInode: '',
  versionFullChain: false,
  versionFormat: 'number' as 'number' | 'date',
  versionIdleTimeout: '30m',
  versionSecretValue: '',
  versionError: '',

  // Gateway launch (S3/HDFS): same family as Snapshot/Deleted/Version --
  // profile-based, never persisted to the profile (launch params, not identity).
  gatewayS3: true,
  gatewayHdfs: false,
  gatewayPort: '',
  gatewayOnly: false,
  gatewayNoLoopback: false,
  gatewayCertPath: '',
  gatewayKeyPath: '',
  gatewaySecretValue: '',
  gatewayError: '',
  gatewayLaunches: [] as GatewayLaunchRecord[],

  // Deleted/Version for an instance with NO saved profile at all (mounted
  // from the terminal, or any tool outside this app) -- profile is
  // deliberately optional, see openDeletedViewForInstance/
  // openVersionViewForInstance in tauri.ts. Kept as a modal (operates on a
  // MountInstance, not a MountProfile) rather than folded into
  // DeletedView/VersionView -- same field shape as the profile-based
  // deletedX/versionX fields above, duplicated on purpose rather than
  // forcing one component to serve two different underlying data shapes.
  externalDeletedPromptFor: null as MountInstance | null,
  externalDeletedDestination: '',
  externalDeletedFromMode: 'default' as 'default' | 'absolute' | 'relative',
  externalDeletedFromAbsoluteValue: '',
  externalDeletedFromRelativeQty: '',
  externalDeletedFromRelativeUnit: 'd' as 'm' | 'h' | 'd',
  externalDeletedIdleTimeout: '30m',
  externalDeletedSecretValue: '',
  externalDeletedError: '',
  // Live-read off the instance's own .mountOS/.config when the dialog opens
  // (see requestExternalDeletedView) -- there is no MountProfile to answer
  // "does this need a secret" or build a COMMAND PREVIEW the way
  // profile.secretRef/vaultStatus and buildDeletedArgv(profile, ...) do for
  // the profile-based case. null means not yet fetched (or unreadable) --
  // computed.externalDeletedNeedsSecret treats that as "assume yes": hiding
  // the field on an unreadable config risks a launch that fails with
  // "secret required" and no field visible to fix it.
  externalDeletedConfig: null as ExternalMountConfig | null,

  externalVersionPromptFor: null as MountInstance | null,
  externalVersionDestination: '',
  externalVersionPath: '',
  externalVersionInode: '',
  externalVersionFullChain: false,
  externalVersionFormat: 'number' as 'number' | 'date',
  externalVersionIdleTimeout: '30m',
  externalVersionSecretValue: '',
  externalVersionError: '',
  externalVersionConfig: null as ExternalMountConfig | null,
})

export const appState = state

// datetime-local's native value ("2025-12-05T14:30") isn't one of
// parseForkAsOf's accepted formats (RFC3339 with an offset, or the naive
// space-separated "2006-01-02 15:04") -- unlike ParseSnapshotTime, it has no
// relative-offset support and no T-separated ISO variant, so the T must be
// swapped for a space before use.
const forkCreateAsOf = $derived(state.forkCreateAsOfLocal ? state.forkCreateAsOfLocal.replace('T', ' ') : '')

// snapshot --timestamp accepts both the datetime-local T-separated ISO form
// and relative offsets ("2h", "3d") directly (ParseSnapshotTime) -- unlike
// fork create's --as-of, no space-swap is needed here.
const snapshotTimestampValue = $derived(
  state.snapshotTimeMode === 'absolute'
    ? state.snapshotAbsoluteValue
    : state.snapshotRelativeQty.trim()
      ? `${state.snapshotRelativeQty.trim()}${state.snapshotRelativeUnit}`
      : '',
)

const deletedFromValue = $derived(
  state.deletedFromMode === 'default'
    ? ''
    : state.deletedFromMode === 'absolute'
      ? state.deletedFromAbsoluteValue
      : state.deletedFromRelativeQty.trim()
        ? `${state.deletedFromRelativeQty.trim()}${state.deletedFromRelativeUnit}`
        : '',
)

const externalDeletedFromValue = $derived(
  state.externalDeletedFromMode === 'default'
    ? ''
    : state.externalDeletedFromMode === 'absolute'
      ? state.externalDeletedFromAbsoluteValue
      : state.externalDeletedFromRelativeQty.trim()
        ? `${state.externalDeletedFromRelativeQty.trim()}${state.externalDeletedFromRelativeUnit}`
        : '',
)

// Fills in just the fields buildDeletedArgv/buildVersionArgv actually read
// (discoveryUrl/fork/volume/accessKeyId/cacheDir/extraArgs -- confirmed
// against cli.ts, neither reads backend) so the external dialogs' COMMAND
// PREVIEW can reuse the exact same builders the profile-based views do,
// rather than a second, drift-prone reimplementation of the same argv
// logic. Never sent anywhere -- purely local, display-only; the real launch
// goes through open_deleted_view_for_instance/open_version_view_for_instance,
// which re-derive their own profile server-side from the live mount itself.
function previewProfileFromExternalConfig(instance: MountInstance, config: ExternalMountConfig | null): MountProfile {
  return {
    id: 'external',
    schemaVersion: 1,
    kind: 'mount',
    name: instance.name || 'External mount',
    volume: config?.volume ?? '',
    fork: config?.fork ?? '',
    mountPath: instance.mountPath,
    discoveryUrl: config?.discoveryUrl ?? '',
    accessKeyId: config?.accessKeyId ?? '',
    secretRef: 'prompt',
    backend: instance.backend ?? 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  }
}

// null (not yet fetched, or unreadable) is treated as "assume yes": hiding
// the secret field on an unreadable config risks a launch that fails with
// "secret required" and no field visible to fix it.
const externalDeletedNeedsSecret = $derived(!state.externalDeletedConfig || Boolean(state.externalDeletedConfig.accessKeyId))

const externalDeletedCommandText = $derived.by(() => {
  const instance = state.externalDeletedPromptFor
  if (!instance) return ''
  const profile = previewProfileFromExternalConfig(instance, state.externalDeletedConfig)
  const destination = state.externalDeletedDestination || '<destination>'
  return `mountos ${buildDeletedArgv(profile, destination, externalDeletedFromValue || undefined, state.externalDeletedIdleTimeout).join(' ')}`
})

const externalVersionNeedsSecret = $derived(!state.externalVersionConfig || Boolean(state.externalVersionConfig.accessKeyId))

const externalVersionCommandText = $derived.by(() => {
  const instance = state.externalVersionPromptFor
  if (!instance) return ''
  const profile = previewProfileFromExternalConfig(instance, state.externalVersionConfig)
  const destination = state.externalVersionDestination || '<destination>'
  const path = state.externalVersionPath.trim()
  const inode = state.externalVersionInode.trim()
  const selector = path ? { path } : { inode: inode || '<inode>' }
  return `mountos ${buildVersionArgv(profile, destination, selector, state.externalVersionFormat, state.externalVersionIdleTimeout, state.externalVersionFullChain).join(' ')}`
})

const gatewayProtocols = $derived([...(state.gatewayS3 ? ['s3'] : []), ...(state.gatewayHdfs ? ['hdfs'] : [])])

// The root/"main" fork is fid=0, self-parented (parentFid=0 too) -- excluding
// fid===parentFid keeps the root out of its own children list when viewing
// the profile's own top level (forkDrillFid === null, so parentFid here is 0).
const forkChildren = $derived.by(() => {
  const parentFid = state.forkDrillFid ?? 0
  return state.forks.filter((fork) => fork.parentFid === parentFid && fork.fid !== parentFid)
})

const currentFork = $derived(state.forkDrillFid === null ? null : (state.forks.find((fork) => fork.fid === state.forkDrillFid) ?? null))

// Walk parentFid from the drilled-into fork up to (not including) the root,
// for a multi-level breadcrumb. Cycle-guarded the same way printForkTree is
// server-side: a corrupt parent chain must terminate, not loop forever.
const forkBreadcrumbTrail = $derived.by(() => {
  if (state.forkDrillFid === null) return []
  const byFid = new Map(state.forks.map((fork) => [fork.fid, fork]))
  const trail: Fork[] = []
  const seen = new Set<number>()
  let cursor: number | undefined = state.forkDrillFid
  while (cursor !== undefined && cursor !== 0 && !seen.has(cursor)) {
    seen.add(cursor)
    const fork = byFid.get(cursor)
    if (!fork) break
    trail.unshift(fork)
    cursor = fork.parentFid
  }
  return trail
})

const selectedProfile = $derived(state.profiles.find((profile) => profile.id === state.selectedProfileId) ?? state.profiles[0])

const filteredInstances = $derived(
  state.systemState.instances.filter((instance) => {
    const haystack = `${instance.name} ${instance.mountPath} ${instance.fsName ?? ''} ${instance.volumeId ?? ''}`.toLowerCase()
    return haystack.includes(state.query.toLowerCase())
  }),
)

// The selected profile always stays in the list even when it doesn't match
// the search text -- filtering it out would silently swap what the editor
// below is showing without any visible cue why it vanished from the list.
const filteredProfiles = $derived.by(() => {
  const q = state.profileQuery.trim().toLowerCase()
  if (!q) return state.profiles
  return state.profiles.filter((profile) => profile.id === state.selectedProfileId || profile.name.toLowerCase().includes(q))
})

const backends = $derived<Backend[]>(
  state.systemState.platform === 'windows'
    ? ['auto', 'mountosio']
    : state.systemState.platform === 'macos'
      ? ['auto', 'macfuse', 'fskit', 'nfs', 'smb']
      : ['auto', 'nfs'],
)

const mountPathError = $derived.by(() => {
  if (!selectedProfile) return ''
  if (!selectedProfile.mountPath.trim()) return 'Mount path is required for this backend'
  return validateMountPathForBackend(selectedProfile.backend, selectedProfile.mountPath) ?? ''
})
// Trimmed once and used for both the check and the mount: a secret pasted with
// a stray leading/trailing space is the user's intent minus a copy artefact,
// and validating the trimmed value while submitting the raw one would fail
// the mount for a reason the dialog said was fine.
const trimmedSecret = $derived(state.secretValue.trim())
const secretLengthError = $derived(
  trimmedSecret.length === SECRET_ACCESS_KEY_LENGTH ? '' : `Secret access key must be ${SECRET_ACCESS_KEY_LENGTH} characters`,
)

const accessKeyError = $derived.by(() => {
  if (!selectedProfile || !selectedProfile.accessKeyId) return ''
  return selectedProfile.accessKeyId.length === ACCESS_KEY_ID_LENGTH ? '' : `Access key ID must be ${ACCESS_KEY_ID_LENGTH} characters`
})
// Only FSKit turns the volume name into a filesystem path segment
// (browseMountPath appends it to the picked folder); other backends just
// pass it through as --volname, so it isn't constrained there.
const volumeNameError = $derived.by(() => {
  if (!selectedProfile || selectedProfile.backend !== 'fskit' || !selectedProfile.volume) return ''
  return isValidFolderName(selectedProfile.volume) ? '' : 'Volume name must be a valid folder name (no /, \\, or control characters)'
})

// Getters, not plain re-exports: a plain `export const x = someDerived` would
// snapshot the value at import time, not track it. Reading through a getter
// on every access is what keeps consumers in another module reactive.
export const computed = {
  get forkCreateAsOf() { return forkCreateAsOf },
  get forkChildren() { return forkChildren },
  get currentFork() { return currentFork },
  get forkBreadcrumbTrail() { return forkBreadcrumbTrail },
  get snapshotTimestampValue() { return snapshotTimestampValue },
  get deletedFromValue() { return deletedFromValue },
  get externalDeletedFromValue() { return externalDeletedFromValue },
  get externalDeletedNeedsSecret() { return externalDeletedNeedsSecret },
  get externalDeletedCommandText() { return externalDeletedCommandText },
  get externalVersionNeedsSecret() { return externalVersionNeedsSecret },
  get externalVersionCommandText() { return externalVersionCommandText },
  get gatewayProtocols() { return gatewayProtocols },
  get selectedProfile() { return selectedProfile },
  get filteredInstances() { return filteredInstances },
  get filteredProfiles() { return filteredProfiles },
  get backends() { return backends },
  get mountPathError() { return mountPathError },
  get trimmedSecret() { return trimmedSecret },
  get secretLengthError() { return secretLengthError },
  get accessKeyError() { return accessKeyError },
  get volumeNameError() { return volumeNameError },
}

// Lost-mount detection compares only against snapshots taken during THIS
// session, so pre-existing state at startup is never classified as a loss.
let knownInstances = new Map<string, string>()
const expectedGone = new Set<string>()

// Extra guard on top of expectedGone's exact-key tracking: a poll can still
// land at an awkward moment relative to an in-flight app-initiated unmount,
// so also blanket-suppress the "disappeared" notice for a short window right
// after ANY unmount this app started, rather than relying solely on precise
// key bookkeeping.
const UNMOUNT_GRACE_MS = 5000
let unmountGraceUntil = 0

function markUnmountInFlight() {
  unmountGraceUntil = Date.now() + UNMOUNT_GRACE_MS
}

export function notify(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
  if (kind === 'error') showErrorToast(text)
  else if (kind === 'warn') showWarningToast(text, NOTICE_AUTO_DISMISS_MS)
  else showInfoToast(text, NOTICE_AUTO_DISMISS_MS)
}

export function describeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return `${errorClassLabel(classifyMountError(text))}. ${text}`
}

function detectLost(next: SystemState) {
  const nextInstances = new Map(next.instances.map((instance) => [instance.key, instance.mountPath || instance.name]))
  const inUnmountGrace = Date.now() < unmountGraceUntil
  for (const [key, label] of knownInstances) {
    if (nextInstances.has(key)) continue
    if (expectedGone.delete(key)) continue
    if (inUnmountGrace) continue
    // Not an error: expectedGone already absorbed the unmounts this app did,
    // so reaching here means the mount went away on its own (CLI unmount,
    // daemon exit). Worth saying once, not worth an alert that sticks.
    notify(`Unmounted: ${label}`, 'warn')
  }
  knownInstances = nextInstances
}

// A combo gateway's mount disappearing (unmount, crash) takes the gateway
// down with it -- there is no independent lifecycle to track once the mount
// is gone. Gateway-only records have no mountPath and are untouched here;
// they only clear via Stop gateway. Shared by refresh() and the periodic
// pollSystem(): pruning only on manual refresh left a phantom badge/Stop-
// action stuck on a remounted profile until the user happened to click
// Refresh.
function pruneGatewayLaunches(instances: MountInstance[]) {
  const activeProfileIds = new Set(instances.map((instance) => instance.profileId).filter((id) => id !== undefined))
  state.gatewayLaunches = state.gatewayLaunches.filter((launch) => !launch.mountPath || activeProfileIds.has(launch.profileId))
}

export async function pollSystem() {
  if (state.busy || state.secretPromptFor || state.deletePromptFor) return
  try {
    const nextState = await getSystemState()
    detectLost(nextState)
    state.systemState = nextState
    pruneGatewayLaunches(nextState.instances)
  } catch {
    // Silent; the manual refresh path reports errors.
  }
}

export async function refresh(announce = true) {
  state.busy = true
  try {
    const [nextState, nextProfiles] = await Promise.all([getSystemState(), listProfiles()])
    detectLost(nextState)
    state.systemState = nextState
    pruneGatewayLaunches(nextState.instances)
    state.profiles = nextProfiles
    state.selectedProfileId ??= nextProfiles[0]?.id ?? null
    const selected = nextProfiles.find((profile) => profile.id === state.selectedProfileId) ?? nextProfiles[0]
    state.extraArgsInput = selected ? selected.extraArgs.map(quoteArg).join(' ') : ''
    state.selectedProfileSnapshotVolumeKind = selected?.volumeKind
    await refreshVaultStatus(nextProfiles)
    updatePreview()
    await autofixVolumeKinds(nextState.instances)
    if (announce) notify(`Refreshed ${nextState.instances.length} instance${nextState.instances.length === 1 ? '' : 's'}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Refresh failed', 'error')
  } finally {
    state.busy = false
    state.loaded = true
  }
}

// Fills in a not-yet-detected volumeKind the first time a live instance's own
// config reveals it -- the same detection newProfileFromInstance does at
// creation time, but for existing profiles that were saved before ever
// mounting. Never touches a profile that already has volumeKind set:
// require_stable_identity (src-tauri/src/lib.rs) would reject that save
// outright, and correcting an already-locked value isn't this function's job.
async function autofixVolumeKinds(instances: MountInstance[]) {
  for (const instance of instances) {
    const profile = profileForInstance(instance)
    if (!profile || profile.volumeKind) continue
    try {
      const config = JSON.parse(await getInstanceConfig(instance.mountPath))
      if (config.volumeType !== 'general' && config.volumeType !== 'iceberg') continue
      const saved = await saveProfile({ ...profile, volumeKind: config.volumeType, updatedAt: new Date().toISOString() })
      state.profiles = state.profiles.map((candidate) => (candidate.id === saved.id ? saved : candidate))
      if (state.selectedProfileId === saved.id) state.selectedProfileSnapshotVolumeKind = saved.volumeKind
      notify(`Volume kind detected: ${config.volumeType === 'iceberg' ? 'Iceberg' : 'General'} for "${profile.name}"`)
    } catch {
      // Best-effort: an unreadable config (mount not fully up yet, etc.) just
      // means detection is retried on the next refresh.
    }
  }
}

export function newProfile(preset: Partial<MountProfile> = {}) {
  const now = new Date().toISOString()
  const profile: MountProfile = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    kind: 'mount',
    name: 'New profile',
    volume: '',
    fork: 'main',
    mountPath: '',
    discoveryUrl: state.settings.defaultDiscoveryUrl ?? '',
    accessKeyId: '',
    secretRef: 'prompt',
    backend: backends.includes(state.settings.defaultBackend) ? state.settings.defaultBackend : 'auto',
    cacheDir: state.settings.defaultCacheDir || undefined,
    cacheSize: state.settings.defaultCacheSize || undefined,
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: now,
    updatedAt: now,
    ...preset,
  }
  state.profiles = [profile, ...state.profiles]
  state.view = 'profiles'
  selectProfile(profile)
}

// Read back everything the mount records about itself rather than making the
// user retype it. Only the secret cannot come from here (by design -- the
// config stores the access key id, which is an identifier, never the secret).
export async function saveAsProfile(instance: MountInstance) {
  const preset: Partial<MountProfile> = {
    name: instance.name || 'External mount',
    volume: instance.name ?? '',
    mountPath: instance.mountPath,
    // viewMode is a comma-joined flag string ("rw", "r", "r,del", ...) from
    // Go's MountMode.String(), never the literal "ro" this used to compare
    // against -- that check could never match anything the CLI actually
    // emits, so every saved-as-profile mount silently defaulted to
    // read/write regardless of the source mount's real mode.
    readOnly: (instance.viewMode?.split(',') ?? []).includes('r'),
  }
  // Only adopt a backend the profile editor can actually offer on this
  // platform: `mountos list` reports the transport in use (e.g. "fuse" on
  // Linux), which is not always one of the mount flags.
  if (instance.backend && backends.includes(instance.backend)) {
    preset.backend = instance.backend
  }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (typeof config.discoveryUrl === 'string' && config.discoveryUrl) {
      preset.discoveryUrl = config.discoveryUrl
    }
    // volumeName is what was actually passed as --volname; the row's name can
    // be a display fallback.
    if (typeof config.volumeName === 'string' && config.volumeName) {
      preset.volume = config.volumeName
    }
    if (typeof config.accessId === 'string' && config.accessId) {
      preset.accessKeyId = config.accessId
    }
    if (config.volumeType === 'general' || config.volumeType === 'iceberg') {
      preset.volumeKind = config.volumeType
    }
  } catch {
    // Unreadable config (e.g. the mount's daemon is gone): keep what the row
    // already knows rather than failing the whole action.
  }
  newProfile(preset)
  notify('Profile created from the running mount. Add the secret, then save.')
}

export function duplicateSelected() {
  if (!selectedProfile) return
  duplicateProfile(selectedProfile)
}

// secretRef resets to 'prompt' rather than carrying the vault reference over:
// a copy is a new profile, and it should not silently inherit access to a
// secret the user stored against a different one.
export function duplicateProfile(profile: MountProfile) {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = profile
  newProfile({
    ...rest,
    name: `${profile.name} copy`,
    secretRef: 'prompt',
  })
}

// A mount that already has a profile has nothing to "save", so the row offers
// to clone that profile instead -- the useful move from here is starting a
// variant (another fork, another mount path) from a config known to work.
export function cloneProfileFor(instance: MountInstance) {
  const profile = state.profiles.find((candidate) => candidate.id === instance.profileId)
  if (!profile) return
  duplicateProfile(profile)
  notify(`Cloned "${profile.name}". Adjust and save.`)
}

export function profileForInstance(instance: MountInstance): MountProfile | undefined {
  return state.profiles.find((candidate) => candidate.id === instance.profileId)
}

// The profile's primary data mount, if currently mounted -- excludes
// satellite view instances (deleted/version/snapshot), same filter as
// canOpenViewsFor. Used to root the version-view file browser at a real,
// live mount path.
export function primaryInstanceForProfile(profileId: string): MountInstance | undefined {
  return state.systemState.instances.find((instance) => instance.profileId === profileId && !viewModeBadge(instance.viewMode))
}

// Broader than primaryInstanceForProfile: any instance tied to this profile,
// including a satellite Deleted/Version/Snapshot/Gateway view, blocks
// deletion -- not just the primary data mount. Deleting a profile out from
// under a running instance would orphan it: the instance keeps its
// profileId, but find_profile server-side (src-tauri/src/lib.rs) can no
// longer resolve it.
export function hasRunningInstance(profileId: string): boolean {
  return state.systemState.instances.some((instance) => instance.profileId === profileId)
}

// A profile-backed instance resolves credentials/discoveryUrl/fork from the
// matching profile (requestDeletedView/requestVersionView); a profile-less
// one gets them re-derived server-side from its own live .mountOS/.config
// (requestExternalDeletedView/requestExternalVersionView, backed by
// open_deleted_view_for_instance/open_version_view_for_instance) -- profile
// is deliberately optional, not a requirement for these views. volumeKind
// mirrors the profile editor's own gate (these views are only offered for
// general volumes there); instance.volumeKind is the live read that works
// for both cases, unlike the profile's own cached value. There is no
// server-side rejection of Iceberg for these either, so this client-side
// check is the only place it's enforced at all.
export function canOpenViewsFor(instance: MountInstance): boolean {
  return (
    canOpen(instance) &&
    !viewModeBadge(instance.viewMode) &&
    (instance.volumeKind ?? profileForInstance(instance)?.volumeKind) !== 'iceberg'
  )
}

// Pure client-side navigation over the already-fetched fork list -- no CLI
// call. `fid: null` returns to the profile's own root ("main").
export function drillIntoFork(fid: number | null) {
  state.forkDrillFid = fid
}

// Enters ForkBrowserView for the given profile, reached from the profile
// editor's "Forks" satellite button. Always available -- no settings gate.
export function enterForkBrowser(profile: MountProfile | undefined) {
  if (!profile) return
  state.profileSubView = 'forks'
  state.forkDrillFid = null
  state.forks = []
  state.forkListSecretValue = ''
  state.forkError = ''
}

// Shared "leave whatever sub-view is open" exit for all five (Forks and the
// four former dialogs) -- one back button/breadcrumb-root action, not five.
export function exitProfileSubView() {
  state.profileSubView = 'editor'
  state.forkDrillFid = null
}

export async function runForkList() {
  if (!selectedProfile) return
  const targetId = selectedProfile.id
  state.forkBusy = true
  state.forkError = ''
  try {
    const result = await forkList(selectedProfile.id, state.forkListSecretValue || undefined)
    // The user may have switched to a different profile (and had its own
    // browser state reset by selectProfile) while this request was in flight
    // -- a late response must never overwrite the wrong profile's view.
    if (state.selectedProfileId !== targetId) return
    state.forks = result
    state.forkListSecretValue = ''
  } catch (error) {
    if (state.selectedProfileId === targetId) state.forkError = describeError(error)
  } finally {
    // Unconditional: forkBusy gates the buttons for whichever profile is now
    // selected, not just targetId -- leaving it stuck true after a switch
    // would permanently disable the new profile's fork actions.
    state.forkBusy = false
  }
}

// Create/delete/restore below follow the same request/confirm/cancel triple
// as the Snapshot/Deleted/Version/Gateway dialogs (secret-conditional field,
// same convention as mount) -- "same logic in place" per the profile editor's
// other satellite actions.

export function requestForkCreate(profile: MountProfile | undefined) {
  if (!profile) return
  state.forkCreatePromptFor = profile
  state.forkCreateName = ''
  state.forkCreateParent = ''
  state.forkCreateAsOfLocal = ''
  state.forkCreateSecretValue = ''
  state.forkCreateError = ''
}

export function cancelForkCreate() {
  state.forkCreatePromptFor = null
  state.forkCreateSecretValue = ''
}

export async function confirmForkCreate() {
  const profile = state.forkCreatePromptFor
  if (!profile) return
  const name = state.forkCreateName.trim()
  if (!name) return
  state.forkBusy = true
  state.forkCreateError = ''
  try {
    await forkCreate(profile.id, name, state.forkCreateParent.trim() || undefined, forkCreateAsOf.trim() || undefined, state.forkCreateSecretValue || undefined)
    state.forkCreatePromptFor = null
    state.forkCreateSecretValue = ''
    notify(`Fork "${name}" created`)
    await runForkList()
  } catch (error) {
    state.forkCreateError = describeError(error)
  } finally {
    state.forkBusy = false
  }
}

export function requestForkDelete(fork: Fork) {
  state.forkDeletePromptFor = fork
  state.forkDeleteForce = false
  state.forkDeleteSecretValue = ''
  state.forkDeleteError = ''
}

export function cancelForkDelete() {
  state.forkDeletePromptFor = null
  state.forkDeleteSecretValue = ''
}

export async function confirmForkDelete() {
  const fork = state.forkDeletePromptFor
  const profile = selectedProfile
  if (!fork || !profile) return
  state.forkBusy = true
  state.forkDeleteError = ''
  try {
    await forkDelete(profile.id, fork.name, state.forkDeleteForce, state.forkDeleteSecretValue || undefined)
    state.forkDeletePromptFor = null
    state.forkDeleteSecretValue = ''
    notify(`Fork "${fork.name}" deleted`)
    await runForkList()
  } catch (error) {
    state.forkDeleteError = describeError(error)
  } finally {
    state.forkBusy = false
  }
}

export function requestForkRestore(fork: Fork) {
  state.forkRestorePromptFor = fork
  state.forkRestoreSecretValue = ''
  state.forkRestoreError = ''
}

export function cancelForkRestore() {
  state.forkRestorePromptFor = null
  state.forkRestoreSecretValue = ''
}

export async function confirmForkRestore() {
  const fork = state.forkRestorePromptFor
  const profile = selectedProfile
  if (!fork || !profile) return
  state.forkBusy = true
  state.forkRestoreError = ''
  try {
    await forkRestore(profile.id, fork.name, state.forkRestoreSecretValue || undefined)
    state.forkRestorePromptFor = null
    state.forkRestoreSecretValue = ''
    notify(`Fork "${fork.name}" restored`)
    await runForkList()
  } catch (error) {
    state.forkRestoreError = describeError(error)
  } finally {
    state.forkBusy = false
  }
}

// Uploads: list is authoritative (fetched from `mountos list --kind upload
// --json`, same "list is authoritative" pattern as runForkList), while
// start/resume are session-local launches that re-fetch the list afterward
// rather than threading a job id back through the launch result.

export async function browseUploadSource() {
  const chosen = await browseFolder('Choose a folder to upload')
  if (chosen) state.uploadSource = chosen
}

export async function runUploadList() {
  state.uploadsBusy = true
  state.uploadsError = ''
  try {
    state.uploads = await listUploads()
  } catch (error) {
    state.uploadsError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

function splitGlobLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function uploadStartParams(): UploadStartParams {
  const bwlimit = Number.parseInt(state.uploadBwlimit, 10)
  return {
    fork: state.uploadFork.trim() || undefined,
    once: state.uploadOnce,
    overwrite: state.uploadOverwrite,
    dryRun: state.uploadDryRun,
    rescanInterval: state.uploadRescanInterval.trim() || undefined,
    restart: state.uploadRestart,
    bwlimit: Number.isFinite(bwlimit) && bwlimit > 0 ? bwlimit : undefined,
    include: splitGlobLines(state.uploadIncludeText),
    exclude: splitGlobLines(state.uploadExcludeText),
    followSymlinks: state.uploadFollowSymlinks,
    createSourceDirectory: state.uploadCreateSourceDirectory,
  }
}

export async function runUploadStart() {
  const profile = selectedProfile
  const source = state.uploadSource.trim()
  const dest = state.uploadDest.trim()
  if (!profile || !source || !dest) return
  state.uploadsBusy = true
  state.uploadStartError = ''
  state.uploadDryRunReport = ''
  try {
    const result = await startUpload(profile.id, source, dest, uploadStartParams(), state.uploadStartSecretValue || undefined)
    state.uploadStartSecretValue = ''
    if (state.uploadDryRun) {
      state.uploadDryRunReport = result
    } else {
      notify(`Upload started: ${source} -> ${dest}`)
      await runUploadList()
    }
  } catch (error) {
    state.uploadStartError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export function requestUploadResume(job: UploadJob) {
  state.uploadResumePromptFor = job
  state.uploadResumeOnce = false
  state.uploadResumeRescanInterval = ''
  state.uploadResumeSecretValue = ''
  state.uploadResumeError = ''
}

export function cancelUploadResume() {
  state.uploadResumePromptFor = null
  state.uploadResumeSecretValue = ''
}

export async function confirmUploadResume() {
  const job = state.uploadResumePromptFor
  const profile = selectedProfile
  if (!job || !profile) return
  state.uploadsBusy = true
  state.uploadResumeError = ''
  try {
    await resumeUpload(
      profile.id,
      job.jobId,
      state.uploadResumeOnce,
      state.uploadResumeRescanInterval.trim() || undefined,
      state.uploadResumeSecretValue || undefined,
    )
    state.uploadResumePromptFor = null
    state.uploadResumeSecretValue = ''
    notify(`Upload job ${job.jobId} resumed`)
    await runUploadList()
  } catch (error) {
    state.uploadResumeError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

// Cancel/retry-failed are non-destructive (the job stays resumable, same
// reasoning fork restore gets no confirm dialog either), so these run
// directly from a row button.

export async function runUploadCancel(job: UploadJob) {
  state.uploadsBusy = true
  state.uploadsError = ''
  try {
    await cancelUpload(job.jobId)
    notify(`Upload job ${job.jobId} cancelled`)
    await runUploadList()
  } catch (error) {
    state.uploadsError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export async function runUploadRetryFailed(job: UploadJob) {
  state.uploadsBusy = true
  state.uploadsError = ''
  try {
    await retryFailedUpload(job.jobId)
    notify(`Retrying failed paths for ${job.jobId}`)
    await runUploadList()
  } catch (error) {
    state.uploadsError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export function requestUploadPrune() {
  state.uploadPrunePromptOpen = true
  state.uploadPruneKeep = '0'
  state.uploadPruneError = ''
}

export function cancelUploadPrune() {
  state.uploadPrunePromptOpen = false
}

export async function confirmUploadPrune() {
  const keep = Number.parseInt(state.uploadPruneKeep, 10)
  state.uploadsBusy = true
  state.uploadPruneError = ''
  try {
    await pruneUploads(Number.isFinite(keep) && keep > 0 ? keep : 0)
    state.uploadPrunePromptOpen = false
    notify('Completed/halted upload jobs pruned')
    await runUploadList()
  } catch (error) {
    state.uploadPruneError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

// Snapshot/Deleted/Version/Gateway are all profile-based, not instance-based:
// none of these mountos commands need an existing running mount, they
// connect to discovery+dataserv independently using the profile's own
// credentials. Reached from the profile editor (any profile, mounted or
// not), or -- for Deleted/Version only, per owner decision -- as a
// row-action shortcut on a live instance via profileForInstance. Either way
// this navigates to the Profiles view and selects the profile first, so the
// same inline sub-view opens regardless of where it was triggered from.
export async function requestSnapshotView(profile: MountProfile | undefined) {
  if (!profile) return
  state.view = 'profiles'
  selectProfile(profile)
  state.profileSubView = 'snapshot'
  try {
    // Best-effort default so the folder picker isn't required; Browse still
    // overrides it, and confirmSnapshotView falls back to a fresh one anyway
    // if this never resolved (bridge unavailable, permission denied, etc).
    const destination = await defaultViewDestination(profile.name, 'snap')
    if (state.selectedProfileId === profile.id && state.profileSubView === 'snapshot') state.snapshotDestination = destination
  } catch {
    // Left blank; confirmSnapshotView computes its own fallback.
  }
}

export async function browseSnapshotDestination() {
  const chosen = await browseFolder('Choose snapshot view destination folder')
  if (chosen) state.snapshotDestination = chosen
}

export async function confirmSnapshotView() {
  const profile = computed.selectedProfile
  if (!profile) return
  state.busy = true
  state.snapshotError = ''
  try {
    const destination = state.snapshotDestination || (await defaultViewDestination(profile.name, 'snap'))
    const result = await openSnapshotView(profile.id, destination, snapshotTimestampValue, state.snapshotSecretValue || undefined)
    state.profileSubView = 'editor'
    state.snapshotSecretValue = ''
    await refresh(false)
    notify(`Snapshot view ready at ${result.target}`)
  } catch (error) {
    state.snapshotError = describeError(error)
  } finally {
    state.busy = false
  }
}

export async function requestDeletedView(profile: MountProfile | undefined) {
  if (!profile) return
  state.view = 'profiles'
  selectProfile(profile)
  state.profileSubView = 'deleted'
  try {
    // Best-effort default so the folder picker isn't required; Browse still
    // overrides it, and confirmDeletedView falls back to a fresh one anyway
    // if this never resolved (bridge unavailable, permission denied, etc).
    const destination = await defaultViewDestination(profile.name, 'del')
    if (state.selectedProfileId === profile.id && state.profileSubView === 'deleted') state.deletedDestination = destination
  } catch {
    // Left blank; confirmDeletedView computes its own fallback.
  }
}

export async function browseDeletedDestination() {
  const chosen = await browseFolder('Choose deleted-files view destination folder')
  if (chosen) state.deletedDestination = chosen
}

export async function confirmDeletedView() {
  const profile = computed.selectedProfile
  if (!profile) return
  state.busy = true
  state.deletedError = ''
  try {
    const destination = state.deletedDestination || (await defaultViewDestination(profile.name, 'del'))
    const result = await openDeletedView(
      profile.id,
      destination,
      deletedFromValue || undefined,
      state.deletedIdleTimeout.trim() || undefined,
      state.deletedSecretValue || undefined,
    )
    state.profileSubView = 'editor'
    state.deletedSecretValue = ''
    await refresh(false)
    notify(`Deleted-files view ready at ${result.target}`)
  } catch (error) {
    state.deletedError = describeError(error)
  } finally {
    state.busy = false
  }
}

export async function requestVersionView(profile: MountProfile | undefined) {
  if (!profile) return
  state.view = 'profiles'
  selectProfile(profile)
  state.profileSubView = 'version'
  try {
    // Best-effort default so the folder picker isn't required; Browse still
    // overrides it, and confirmVersionView falls back to a fresh one anyway
    // if this never resolved (bridge unavailable, permission denied, etc).
    const destination = await defaultViewDestination(profile.name, 'ver')
    if (state.selectedProfileId === profile.id && state.profileSubView === 'version') state.versionDestination = destination
  } catch {
    // Left blank; confirmVersionView computes its own fallback.
  }
}

export async function browseVersionDestination() {
  const chosen = await browseFolder('Choose file-version view destination folder')
  if (chosen) state.versionDestination = chosen
}

// Primary action for the mounted case: pick a file directly from the live
// mount. Rooting the native picker there is enough -- the CLI resolves
// inode/parent/name itself via stat(2), see buildVersionArgv/--path.
export async function browseVersionFile(profile: MountProfile) {
  const instance = primaryInstanceForProfile(profile.id)
  if (!instance?.mountPath) return
  const chosen = await pickVersionFile(`Choose a file from "${profile.name}"`, instance.mountPath)
  if (chosen) {
    state.versionPath = chosen
    state.versionError = ''
  }
}

// Unmounted case: mount the profile first (reusing the normal mount flow,
// including its own secret-prompt handling), then open the same file
// picker if the mount completed synchronously (secret already in vault).
// If a secret prompt interrupted it, the user completes that via the
// existing flow and can click Browse again once mounted. If the mount
// failed outright, runMount/doMount already reported it via their own
// error toast -- do not also emit a second, contradictory "Mounting..."
// toast implying it's still in progress.
export async function mountAndBrowseVersionFile(profile: MountProfile) {
  await runMount(profile)
  if (state.secretPromptFor) {
    notify('Enter the secret to finish mounting, then click Browse to pick a file.')
    return
  }
  const instance = primaryInstanceForProfile(profile.id)
  if (!instance?.mountPath) return
  await browseVersionFile(profile)
}

export async function confirmVersionView() {
  const profile = computed.selectedProfile
  if (!profile) return
  const path = state.versionPath.trim()
  const inode = state.versionInode.trim()
  if (!path && !inode) {
    state.versionError = 'Browse to a file, or enter an inode number'
    return
  }
  state.busy = true
  state.versionError = ''
  try {
    const destination = state.versionDestination || (await defaultViewDestination(profile.name, 'ver'))
    const result = await openVersionView(
      profile.id,
      destination,
      path ? { path } : { inode },
      state.versionFormat,
      state.versionIdleTimeout.trim() || undefined,
      state.versionSecretValue || undefined,
      state.versionFullChain,
    )
    state.profileSubView = 'editor'
    state.versionSecretValue = ''
    await refresh(false)
    notify(`Version view ready at ${result.target}`)
  } catch (error) {
    state.versionError = describeError(error)
  } finally {
    state.busy = false
  }
}

export function cancelExternalDeletedView() {
  state.externalDeletedPromptFor = null
  state.externalDeletedSecretValue = ''
}

// Reached only from InstancesView's row dropdown, for an instance
// canOpenViewsFor allows but profileForInstance can't resolve. Fetches a
// destination suggestion and a needs-secret hint from the live mount's own
// config -- best-effort, same as requestDeletedView's own destination
// fetch; confirmExternalDeletedView computes its own fallback either way.
export async function requestExternalDeletedView(instance: MountInstance) {
  state.externalDeletedPromptFor = instance
  state.externalDeletedDestination = ''
  state.externalDeletedFromMode = 'default'
  state.externalDeletedFromAbsoluteValue = ''
  state.externalDeletedFromRelativeQty = ''
  state.externalDeletedFromRelativeUnit = 'd'
  state.externalDeletedIdleTimeout = '30m'
  state.externalDeletedSecretValue = ''
  state.externalDeletedError = ''
  state.externalDeletedConfig = null
  try {
    const destination = await defaultViewDestination(instance.name || 'mount', 'del')
    if (state.externalDeletedPromptFor === instance) state.externalDeletedDestination = destination
  } catch {
    // Left blank; confirmExternalDeletedView computes its own fallback.
  }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (state.externalDeletedPromptFor === instance) {
      state.externalDeletedConfig = {
        discoveryUrl: typeof config.discoveryUrl === 'string' ? config.discoveryUrl : '',
        fork: typeof config.forkName === 'string' ? config.forkName : '',
        volume: typeof config.volumeName === 'string' ? config.volumeName : '',
        accessKeyId: typeof config.accessId === 'string' ? config.accessId : '',
      }
    }
  } catch {
    // Unreadable config: externalDeletedConfig stays null, which
    // computed.externalDeletedNeedsSecret treats as "assume yes" rather
    // than hiding a field the launch might need.
  }
}

export async function browseExternalDeletedDestination() {
  const chosen = await browseFolder('Choose deleted-files view destination folder')
  if (chosen) state.externalDeletedDestination = chosen
}

export async function confirmExternalDeletedView() {
  const instance = state.externalDeletedPromptFor
  if (!instance) return
  state.busy = true
  state.externalDeletedError = ''
  try {
    const destination = state.externalDeletedDestination || (await defaultViewDestination(instance.name || 'mount', 'del'))
    const result = await openDeletedViewForInstance(
      instance.mountPath,
      instance.backend ?? 'auto',
      destination,
      externalDeletedFromValue || undefined,
      state.externalDeletedIdleTimeout.trim() || undefined,
      state.externalDeletedSecretValue || undefined,
    )
    state.externalDeletedPromptFor = null
    state.externalDeletedSecretValue = ''
    await refresh(false)
    notify(`Deleted-files view ready at ${result.target}`)
  } catch (error) {
    state.externalDeletedError = describeError(error)
  } finally {
    state.busy = false
  }
}

export function cancelExternalVersionView() {
  state.externalVersionPromptFor = null
  state.externalVersionSecretValue = ''
}

export async function requestExternalVersionView(instance: MountInstance) {
  state.externalVersionPromptFor = instance
  state.externalVersionDestination = ''
  state.externalVersionPath = ''
  state.externalVersionInode = ''
  state.externalVersionFullChain = false
  state.externalVersionFormat = 'number'
  state.externalVersionIdleTimeout = '30m'
  state.externalVersionSecretValue = ''
  state.externalVersionError = ''
  state.externalVersionConfig = null
  try {
    const destination = await defaultViewDestination(instance.name || 'mount', 'ver')
    if (state.externalVersionPromptFor === instance) state.externalVersionDestination = destination
  } catch {
    // Left blank; confirmExternalVersionView computes its own fallback.
  }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (state.externalVersionPromptFor === instance) {
      state.externalVersionConfig = {
        discoveryUrl: typeof config.discoveryUrl === 'string' ? config.discoveryUrl : '',
        fork: typeof config.forkName === 'string' ? config.forkName : '',
        volume: typeof config.volumeName === 'string' ? config.volumeName : '',
        accessKeyId: typeof config.accessId === 'string' ? config.accessId : '',
      }
    }
  } catch {
    // Unreadable config: externalVersionConfig stays null, which
    // computed.externalVersionNeedsSecret treats as "assume yes" rather
    // than hiding a field the launch might need.
  }
}

export async function browseExternalVersionDestination() {
  const chosen = await browseFolder('Choose file-version view destination folder')
  if (chosen) state.externalVersionDestination = chosen
}

// Unlike browseVersionFile (profile-based, may not be mounted yet), an
// external instance in the dropdown IS already a live mount -- that's the
// only way it got a row to click this from -- so there is no "mount first"
// branch to handle here.
export async function browseExternalVersionFile(instance: MountInstance) {
  const chosen = await pickVersionFile(`Choose a file from "${instance.name || 'this mount'}"`, instance.mountPath)
  if (chosen) {
    state.externalVersionPath = chosen
    state.externalVersionError = ''
  }
}

export async function confirmExternalVersionView() {
  const instance = state.externalVersionPromptFor
  if (!instance) return
  const path = state.externalVersionPath.trim()
  const inode = state.externalVersionInode.trim()
  if (!path && !inode) {
    state.externalVersionError = 'Browse to a file, or enter an inode number'
    return
  }
  state.busy = true
  state.externalVersionError = ''
  try {
    const destination = state.externalVersionDestination || (await defaultViewDestination(instance.name || 'mount', 'ver'))
    const result = await openVersionViewForInstance(
      instance.mountPath,
      instance.backend ?? 'auto',
      destination,
      path ? { path } : { inode },
      state.externalVersionFormat,
      state.externalVersionIdleTimeout.trim() || undefined,
      state.externalVersionSecretValue || undefined,
      state.externalVersionFullChain,
    )
    state.externalVersionPromptFor = null
    state.externalVersionSecretValue = ''
    await refresh(false)
    notify(`Version view ready at ${result.target}`)
  } catch (error) {
    state.externalVersionError = describeError(error)
  } finally {
    state.busy = false
  }
}

export function requestGatewayView(profile: MountProfile | undefined) {
  if (!profile) return
  state.view = 'profiles'
  selectProfile(profile)
  state.profileSubView = 'gateway'
}

export async function browseGatewayCert() {
  const chosen = await browseFolder('Choose TLS certificate file')
  if (chosen) state.gatewayCertPath = chosen
}

export async function browseGatewayKey() {
  const chosen = await browseFolder('Choose TLS key file')
  if (chosen) state.gatewayKeyPath = chosen
}

// Gateway launches never appear in `mountos list --json` at all when
// gateway-only (no control socket, no mount entry -- confirmed against
// cmd_gateway.go), and even the mount+gateway combo case has no field there
// indicating gateway is active on that mount (mountListEntry has no such
// field). Tracked client-side, session-only: this GUI can only know about
// gateways it launched itself, same class of gap as any externally-managed
// process this app doesn't own.
export async function confirmGatewayView() {
  const profile = computed.selectedProfile
  if (!profile) return
  state.busy = true
  state.gatewayError = ''
  try {
    const result = await openGateway(
      profile.id,
      {
        protocols: gatewayProtocols,
        port: state.gatewayPort.trim() || undefined,
        gatewayOnly: state.gatewayOnly,
        noLoopback: state.gatewayNoLoopback,
        certPath: state.gatewayCertPath.trim() || undefined,
        keyPath: state.gatewayKeyPath.trim() || undefined,
      },
      state.gatewaySecretValue || undefined,
    )
    state.gatewayLaunches = [
      // A profile can only have one live combo gateway at a time -- drop any
      // earlier combo record for this profile first, rather than leaving a
      // stale one (from a mount that died outside this app) sitting before
      // the fresh one, where gatewayInfoForInstance's .find() would keep
      // matching the dead record instead.
      ...state.gatewayLaunches.filter((launch) => state.gatewayOnly || launch.mountPath === undefined || launch.profileId !== profile.id),
      {
        id: crypto.randomUUID(),
        profileId: profile.id,
        profileName: profile.name,
        mountPath: state.gatewayOnly ? undefined : profile.mountPath,
        protocols: gatewayProtocols,
        pid: result.pid,
        endpoints: result.endpoints,
      },
    ]
    state.profileSubView = 'editor'
    state.gatewaySecretValue = ''
    await refresh(false)
    // An Iceberg-typed volume silently skips the gateway server-side
    // (auto-starts its own REST/S3 lake mode instead, no descriptor ever
    // written) and this launch still exits 0 -- an empty endpoints list is
    // the only signal available to tell the difference from a real, working
    // gateway with a not-yet-discovered descriptor.
    if (result.endpoints.length === 0) {
      notify(
        'Launch finished, but no S3/HDFS endpoints were found. This volume may be Iceberg-typed, which exposes its own REST/S3 catalog instead of a gateway.',
        'warn',
      )
    } else {
      notify(state.gatewayOnly ? 'Gateway launched' : `Mount ready with gateway at ${profile.mountPath}`)
    }
  } catch (error) {
    state.gatewayError = describeError(error)
  } finally {
    state.busy = false
  }
}

// Matched by profileId, not the raw mountPath string: this codebase's own
// Rust side has a normalized_target/targets_equal helper specifically
// because comparing a profile's stored mount path against a running
// instance's reported path with bare `===` is unreliable (trailing slashes,
// case, etc.) -- reusing profileId (already on both sides) avoids needing to
// replicate that normalization in TS. A profile can only have one
// combo-gateway mount at a time, but it can ALSO have Deleted/Version
// satellite rows open concurrently for the same profileId -- excluding rows
// with a viewModeBadge (always set for satellite views, never for the
// primary mount) keeps those from matching a gateway that has nothing to do
// with them.
export function gatewayInfoForInstance(instance: MountInstance) {
  if (!instance.profileId || viewModeBadge(instance.viewMode)) return undefined
  return state.gatewayLaunches.find((launch) => launch.mountPath && launch.profileId === instance.profileId)
}

// stop_gateway_blocking's two "the pid isn't real" errors ("was not
// discovered by this app's own gateway launch" / "no running mountos process
// at PID") mean this record's backing gateway is already gone -- e.g. a
// stale record surviving an external remount this app's poll never observed
// as an intermediate "gone" state. Only those two confirm that; a generic
// kill failure ("failed to stop gateway process") doesn't, and must not drop
// a record for a gateway that may still be running.
function confirmsGatewayAlreadyGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('was not discovered by this app') || message.includes('no running mountos process')
}

export async function stopGatewayLaunch(id: string) {
  const launch = state.gatewayLaunches.find((candidate) => candidate.id === id)
  if (!launch?.pid) return
  state.busy = true
  try {
    await stopGateway(launch.pid)
    state.gatewayLaunches = state.gatewayLaunches.filter((candidate) => candidate.id !== id)
    notify('Gateway stopped')
  } catch (error) {
    if (confirmsGatewayAlreadyGone(error)) {
      state.gatewayLaunches = state.gatewayLaunches.filter((candidate) => candidate.id !== id)
    }
    notify(describeError(error), 'error')
  } finally {
    state.busy = false
  }
}

export async function exportSelected() {
  if (!selectedProfile) return
  state.busy = true
  try {
    const exported = await exportProfile(selectedProfile.id)
    notify(`Profile exported to ${exported.path}`)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Profile export failed', 'error')
  } finally {
    state.busy = false
  }
}

export function cancelDelete() {
  state.deletePromptFor = null
}

export async function confirmDelete() {
  const target = state.deletePromptFor
  if (!target) return
  state.busy = true
  try {
    await deleteProfile(target.id)
    state.profiles = state.profiles.filter((profile) => profile.id !== target.id)
    if (state.selectedProfileId === target.id) {
      const fallback = state.profiles[0]
      if (fallback) {
        selectProfile(fallback)
      } else {
        state.selectedProfileId = null
        updatePreview()
      }
    }
    const { [target.id]: _removed, ...rest } = state.vaultStatus
    state.vaultStatus = rest
    notify(`Deleted profile ${target.name} and its vaulted secret`)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Profile delete failed', 'error')
  } finally {
    state.busy = false
    state.deletePromptFor = null
  }
}

export async function persistSelected() {
  if (!selectedProfile) return
  state.busy = true
  try {
    const saved = await saveProfile({ ...selectedProfile, updatedAt: new Date().toISOString() })
    state.profiles = state.profiles.map((profile) => (profile.id === saved.id ? saved : profile))
    state.selectedProfileId = saved.id
    state.selectedProfileSnapshotVolumeKind = saved.volumeKind
    notify('Profile saved')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Profile save failed', 'error')
  } finally {
    state.busy = false
  }
}

// Resets every piece of sub-view state, not just each one's secret: a stale
// --force checkbox, "as of" value, or destination carrying over to a
// different profile's action would be silently submitted without the user
// ever having set it for that profile. Also unconditionally lands back on
// the plain editor (profileSubView = 'editor'), regardless of which of the
// five sub-views was open for the profile being switched away from.
export function selectProfile(profile: MountProfile) {
  state.selectedProfileId = profile.id
  state.selectedProfileSnapshotVolumeKind = profile.volumeKind
  state.extraArgsInput = profile.extraArgs.map(quoteArg).join(' ')
  state.extraArgsError = ''
  updatePreview(profile)

  state.profileSubView = 'editor'

  state.forks = []
  state.forkDrillFid = null
  state.forkListSecretValue = ''
  state.forkError = ''
  state.forkCreatePromptFor = null
  state.forkCreateName = ''
  state.forkCreateParent = ''
  state.forkCreateAsOfLocal = ''
  state.forkCreateSecretValue = ''
  state.forkCreateError = ''
  state.forkDeletePromptFor = null
  state.forkDeleteForce = false
  state.forkDeleteSecretValue = ''
  state.forkDeleteError = ''
  state.forkRestorePromptFor = null
  state.forkRestoreSecretValue = ''
  state.forkRestoreError = ''

  state.snapshotDestination = ''
  state.snapshotTimeMode = 'absolute'
  state.snapshotAbsoluteValue = ''
  state.snapshotRelativeQty = ''
  state.snapshotRelativeUnit = 'h'
  state.snapshotSecretValue = ''
  state.snapshotError = ''

  state.deletedDestination = ''
  state.deletedFromMode = 'default'
  state.deletedFromAbsoluteValue = ''
  state.deletedFromRelativeQty = ''
  state.deletedFromRelativeUnit = 'd'
  state.deletedIdleTimeout = '30m'
  state.deletedSecretValue = ''
  state.deletedError = ''

  state.versionDestination = ''
  state.versionPath = ''
  state.versionInode = ''
  state.versionFullChain = false
  state.versionFormat = 'number'
  state.versionIdleTimeout = '30m'
  state.versionSecretValue = ''
  state.versionError = ''

  state.gatewayS3 = true
  state.gatewayHdfs = false
  state.gatewayPort = ''
  state.gatewayOnly = false
  state.gatewayNoLoopback = false
  state.gatewayCertPath = ''
  state.gatewayKeyPath = ''
  state.gatewaySecretValue = ''
  state.gatewayError = ''
}

export function updatePreview(profile = selectedProfile) {
  if (!profile) {
    state.commandText = ''
    state.rejectedArgs = []
    return
  }
  state.commandText = `mountos ${buildMountArgv(profile).map(quoteArg).join(' ')}`
  state.rejectedArgs = validateExtraArgs(profile.extraArgs)
}

export function quoteArg(arg: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}

export function patchProfile(patch: Partial<MountProfile>) {
  if (!selectedProfile) return
  const next = { ...selectedProfile, ...patch }
  state.profiles = state.profiles.map((profile) => (profile.id === selectedProfile.id ? next : profile))
  updatePreview(next)
}

export function setAccessKeyId(value: string) {
  if (!selectedProfile) return
  // Vault storage needs an access key ID to pair the vaulted secret with;
  // clearing it while Vault is selected would leave an orphaned choice.
  const clearingVault = !value && selectedProfile.secretRef === 'vault'
  patchProfile({ accessKeyId: value, ...(clearingVault ? { secretRef: 'prompt' } : {}) })
}

export async function browseMountPath() {
  if (!selectedProfile) return
  try {
    const isFskit = selectedProfile.backend === 'fskit'
    const selected = await browseFolder('Choose mount folder', isFskit ? '/Volumes' : undefined)
    if (!selected) return
    // FSKit's mount point is a fixed container (/Volumes/MountOS/<name>);
    // browsing picks that container, and the leaf folder name comes from the
    // volume name already set above, so it isn't retyped here too.
    const volume = selectedProfile.volume
    const mountPath = isFskit && volume && isValidFolderName(volume) ? `${selected.replace(/\/+$/, '')}/${volume}` : selected
    patchProfile({ mountPath })
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to open folder picker', 'error')
  }
}

export function setExtraArgs(value: string) {
  state.extraArgsInput = value
  try {
    patchProfile({ extraArgs: parseArgvInput(value) })
    state.extraArgsError = ''
  } catch (error) {
    state.extraArgsError = error instanceof Error ? error.message : 'Invalid extra args'
  }
}

export async function runMount(profile: MountProfile) {
  state.busy = true
  let saved: MountProfile
  try {
    saved = await saveProfile({ ...profile, updatedAt: new Date().toISOString() })
    state.profiles = state.profiles.map((candidate) => (candidate.id === saved.id ? saved : candidate))
    if (!state.profiles.some((candidate) => candidate.id === saved.id)) state.profiles = [saved, ...state.profiles]
    state.selectedProfileId = saved.id
    const stored = saved.secretRef === 'vault' ? (await getProfileSecretStatus(saved.id)).stored : false
    state.vaultStatus = { ...state.vaultStatus, [saved.id]: stored }
    if (saved.secretRef === 'prompt' || !stored) {
      state.secretPromptFor = saved.id
      state.secretValue = ''
      state.secretError = ''
      state.savePromptedSecret = saved.secretRef === 'vault'
      return
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Profile save failed', 'error')
    return
  } finally {
    state.busy = false
  }
  await doMount(saved.id)
}

export async function doMount(profileId: string, secret?: string) {
  state.busy = true
  try {
    if (secret && state.savePromptedSecret) {
      await setProfileSecret(profileId, secret)
      state.profiles = state.profiles.map((profile) => (profile.id === profileId ? { ...profile, secretRef: 'vault' } : profile))
      const profile = state.profiles.find((candidate) => candidate.id === profileId)
      if (profile) await saveProfile({ ...profile, secretRef: 'vault', updatedAt: new Date().toISOString() })
      state.vaultStatus = { ...state.vaultStatus, [profileId]: true }
    }
    const result = await mountProfile(profileId, secret)
    state.secretPromptFor = null
    state.secretValue = ''
    state.secretError = ''
    await refresh(false)
    notify(`Mount ready at ${result.target}`)
  } catch (error) {
    if (secret !== undefined && state.secretPromptFor) {
      state.secretError = describeError(error)
    } else {
      notify(describeError(error), 'error')
    }
  } finally {
    state.busy = false
  }
}

export function cancelSecret() {
  state.secretPromptFor = null
  state.secretValue = ''
  state.secretError = ''
}

export async function refreshVaultStatus(nextProfiles = state.profiles) {
  const entries = await Promise.all(nextProfiles.map(async (profile) => [profile.id, (await getProfileSecretStatus(profile.id)).stored] as const))
  state.vaultStatus = Object.fromEntries(entries)
}

export async function forgetSecret(profileId: string) {
  state.busy = true
  try {
    await deleteProfileSecret(profileId)
    state.vaultStatus = { ...state.vaultStatus, [profileId]: false }
    const profile = state.profiles.find((candidate) => candidate.id === profileId)
    if (profile?.secretRef === 'vault') {
      const updated = { ...profile, secretRef: 'prompt' as const, updatedAt: new Date().toISOString() }
      await saveProfile(updated)
      state.profiles = state.profiles.map((candidate) => (candidate.id === profileId ? updated : candidate))
    }
    notify('Secret forgotten')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to forget secret', 'error')
  } finally {
    state.busy = false
  }
}

export async function createBundle() {
  state.busy = true
  try {
    state.diagnosticsBundle = await createDiagnosticsBundle()
    notify('Diagnostics bundle created')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Diagnostics bundle failed', 'error')
  } finally {
    state.busy = false
  }
}

export async function openBundle() {
  if (!state.diagnosticsBundle) return
  try {
    await openDiagnosticsBundle(state.diagnosticsBundle.path)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Could not open the bundle', 'error')
  }
}

export function requestStopGatewayOnly(instance: MountInstance) {
  state.stopGatewayPromptFor = instance
}

export function cancelStopGatewayPrompt() {
  state.stopGatewayPromptFor = null
}

export async function confirmStopGatewayPrompt() {
  const instance = state.stopGatewayPromptFor
  if (!instance) return
  state.stopGatewayPromptFor = null
  await runStopGatewayOnly(instance)
}

async function runStopGatewayOnly(instance: MountInstance) {
  if (instance.pid == null) {
    notify('No process id known for this gateway -- cannot stop it', 'error')
    return
  }
  state.busy = true
  expectedGone.add(instance.key)
  markUnmountInFlight()
  try {
    await stopGatewayOnly(instance.pid)
    await refresh(false)
    notify('Gateway stopped')
  } catch (error) {
    // Still running on any failure, so the row belongs back in the list
    // rather than being hidden as on its way out.
    expectedGone.delete(instance.key)
    notify(error instanceof Error ? error.message : 'Failed to stop gateway', 'error')
  } finally {
    state.busy = false
  }
}

export async function runUnmount(instance: MountInstance, force = false) {
  state.busy = true
  expectedGone.add(instance.key)
  markUnmountInFlight()
  try {
    const result = await unmountTarget(instance.mountPath, force)
    await refresh(false)
    notify(result.state === 'idle' ? 'Unmount complete' : 'Unmount is still flushing in the background')
  } catch (error) {
    // The mount is still there on any failure, so the row belongs back in the
    // list rather than being hidden as on its way out.
    expectedGone.delete(instance.key)
    notify(error instanceof Error ? error.message : 'Unmount failed', 'error')
  } finally {
    state.busy = false
  }
}

export async function runUnmountAll(force = false) {
  const keys = state.systemState.instances.map((instance) => instance.key)
  if (keys.length === 0) return
  state.busy = true
  for (const key of keys) expectedGone.add(key)
  markUnmountInFlight()
  try {
    const result = await unmountAllTargets(force)
    for (const failedTarget of result.failed) expectedGone.delete(failedTarget)
    await refresh(false)
    if (result.failed.length === 0) {
      notify(`Unmounted all ${result.attempted} mounts`)
    } else {
      const busySuffix = result.busy.length > 0 ? ` (${result.busy.length} still in use and left mounted)` : ''
      // The attempted count and the outcomes come from two separate listings, so
      // a mount that appeared in between can make failed exceed attempted.
      const unmounted = Math.max(0, result.attempted - result.failed.length)
      notify(`Unmounted ${unmounted} of ${result.attempted}; ${result.failed.length} failed${busySuffix}`, 'error')
    }
  } catch (error) {
    for (const key of keys) expectedGone.delete(key)
    notify(error instanceof Error ? error.message : 'Unmount all failed', 'error')
  } finally {
    state.busy = false
  }
}

export function requestUnmount(instance: MountInstance) {
  if (state.skipUnmountConfirm) {
    void runUnmount(instance)
  } else {
    state.unmountPromptForce = false
    state.unmountPromptFor = instance
  }
}

export function requestUnmountAll() {
  if (state.systemState.instances.length === 0) return
  if (state.skipUnmountConfirm) {
    void runUnmountAll()
  } else {
    state.unmountPromptForce = false
    state.unmountPromptFor = 'all'
  }
}

export function cancelUnmountPrompt() {
  state.unmountPromptFor = null
  state.unmountPromptForce = false
}

export async function confirmUnmountPrompt() {
  const target = state.unmountPromptFor
  // Force never carries over to the next prompt; each unmount opts in on its own.
  const force = state.unmountPromptForce && state.settings.allowUnmountForce
  state.unmountPromptFor = null
  state.unmountPromptForce = false
  if (target === 'all') await runUnmountAll(force)
  else if (target) await runUnmount(target, force)
}

export async function runOpen(instance: MountInstance) {
  try {
    await openTarget(instance.mountPath)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to open mount target', 'error')
  }
}

export function canOpen(instance: MountInstance) {
  return isAbsolutePath(instance.mountPath)
}

export async function runOpenLostFound(instance: MountInstance) {
  try {
    await openLostFound(instance.mountPath)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to open .lost+found', 'error')
  }
}

export async function toggleInstanceConfig(instance: MountInstance) {
  if (instance.key in state.expandedConfig) {
    const next = { ...state.expandedConfig }
    delete next[instance.key]
    state.expandedConfig = next
    return
  }
  try {
    const config = await getInstanceConfig(instance.mountPath)
    state.expandedConfig = { ...state.expandedConfig, [instance.key]: config }
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to read mount config', 'error')
  }
}

export async function copyConfig(key: string) {
  const text = state.expandedConfig[key]
  if (!text) return
  await copyText(text, 'Mount flags copied')
}

export async function copyText(text: string, successMessage = 'Copied') {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    notify(successMessage)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Copy failed', 'error')
  }
}

export async function openDashboard(instance: MountInstance, gui: boolean) {
  try {
    await launchDashboard(instance.mountPath, gui)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to launch dashboard', 'error')
  }
}

export async function toggleMountHelp() {
  if (state.mountHelpVisible) {
    state.mountHelpVisible = false
    return
  }
  if (!state.mountHelpText) {
    try {
      state.mountHelpText = await mountHelp()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to load mountos mount -h', 'error')
      return
    }
  }
  state.mountHelpVisible = true
}

export function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed
  if (typeof localStorage !== 'undefined') localStorage.setItem('mountos-desktop-sidebar-collapsed', String(state.sidebarCollapsed))
}

export function setSkipUnmountConfirm(next: boolean) {
  state.skipUnmountConfirm = next
  if (typeof localStorage !== 'undefined') localStorage.setItem('mountos-desktop-skip-unmount-confirm', String(next))
}

export function showTips() {
  state.tipsOpen = true
}

export function hideTips() {
  state.tipsOpen = false
}

async function loadLicenses(kind: 'rust' | 'js') {
  if (state.licensesData[kind]) return
  state.licensesLoading = true
  state.licensesError = ''
  try {
    state.licensesData[kind] = await getThirdPartyLicenses(kind)
  } catch (error) {
    state.licensesError = error instanceof Error ? error.message : 'Failed to load licenses'
  } finally {
    state.licensesLoading = false
  }
}

export async function showLicenses() {
  state.licensesOpen = true
  await loadLicenses(state.licensesKind)
}

export function hideLicenses() {
  state.licensesOpen = false
}

export function setLicensesKind(kind: 'rust' | 'js') {
  state.licensesKind = kind
  void loadLicenses(kind)
}

// Jumps to Settings and scrolls the matching section into view. tick() waits
// for the view swap to actually render before the id exists in the DOM.
// block: 'nearest' rather than 'start' -- pinning a near-the-bottom section
// to the viewport top can overscroll past the page's real content, leaving a
// blank gap below it since there's nothing left to fill the revealed space.
export async function goToSettingsSection(id: string) {
  state.view = 'settings'
  await tick()
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

export async function loadSettings() {
  try {
    state.settings = await getSettings()
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to load settings', 'error')
  }
}

export async function changeDefaultBackend(backend: Backend) {
  try {
    state.settings = await saveSettings({ ...state.settings, defaultBackend: backend })
    notify(`New profiles default to the ${backend} backend`)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changeAllowForkForceDelete(enabled: boolean) {
  try {
    state.settings = await saveSettings({ ...state.settings, allowForkForceDelete: enabled })
    notify(enabled ? 'Force fork delete allowed' : 'Force fork delete disallowed')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changeAllowUnmountForce(enabled: boolean) {
  try {
    state.settings = await saveSettings({ ...state.settings, allowUnmountForce: enabled })
    notify(enabled ? 'Force unmount allowed' : 'Force unmount disallowed')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changePollSeconds(seconds: number) {
  try {
    state.settings = await saveSettings({ ...state.settings, pollSeconds: seconds })
    notify(seconds === 0 ? 'Auto-refresh is off' : `Mount list refreshes every ${seconds}s`)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changeTerminal(terminal: string) {
  try {
    // Empty string is the "System default" option: store it as undefined so
    // settings.json carries no stale id once the choice is cleared.
    state.settings = await saveSettings({ ...state.settings, terminal: terminal || undefined })
    const label = state.systemState.terminals.find((option) => option.id === terminal)?.label
    notify(label ? `Dashboards open in ${label}` : 'Dashboards open in the system default terminal')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changeDefaultDiscoveryUrl(discoveryUrl: string) {
  const trimmed = discoveryUrl.trim()
  try {
    state.settings = await saveSettings({ ...state.settings, defaultDiscoveryUrl: trimmed || undefined })
    notify(trimmed ? 'New profiles default to this discovery URL' : 'Default discovery URL cleared')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function changeDefaultCacheDir(cacheDir: string) {
  const trimmed = cacheDir.trim()
  try {
    state.settings = await saveSettings({ ...state.settings, defaultCacheDir: trimmed || undefined })
    notify(trimmed ? 'New profiles default to this cache directory' : 'Default cache directory cleared')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function browseDefaultCacheDir() {
  const chosen = await browseFolder('Choose default disk cache directory', state.settings.defaultCacheDir)
  if (chosen) await changeDefaultCacheDir(chosen)
}

export async function changeDefaultCacheSize(cacheSize: string) {
  const trimmed = cacheSize.trim()
  try {
    state.settings = await saveSettings({ ...state.settings, defaultCacheSize: trimmed || undefined })
    notify(trimmed ? `New profiles default to a ${trimmed} disk cache` : 'Default cache size cleared')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

// Auto is the absence of an override (undefined defaultCacheSize), not a
// separate persisted flag -- turning it back on just clears the field.
// Turning it off seeds AGGRESSIVE_CACHE_SIZE rather than leaving the field
// blank, so the UI never shows "Auto off" next to an empty value.
export async function toggleDefaultCacheSizeAuto(auto: boolean) {
  await changeDefaultCacheSize(auto ? '' : state.settings.defaultCacheSize || AGGRESSIVE_CACHE_SIZE)
}

// Browse-only (no free-typed path): a mistyped or malicious path could pin
// to something that isn't mountos at all, so the candidate is both picked
// from disk and validated (validateCliCandidate runs `--version` and checks
// the output) before it's ever written to settings.
export async function pickCliPathOverride() {
  const chosen = await browseCliBinary(state.settings.cliPathOverride ?? state.systemState.cliPath ?? undefined)
  if (!chosen) return
  try {
    await validateCliCandidate(chosen)
    state.settings = await saveSettings({ ...state.settings, cliPathOverride: chosen })
    notify('Pinned mountos CLI path')
    await refresh(false)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'That binary does not look like the mountos CLI', 'error')
  }
}

export async function clearCliPathOverride() {
  try {
    state.settings = await saveSettings({ ...state.settings, cliPathOverride: undefined })
    notify('CLI path pin cleared, using PATH lookup again')
    await refresh(false)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

export async function checkMcpStatus() {
  state.busy = true
  try {
    state.mcpStatusText = await mcpStatus()
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to check MCP status', 'error')
  } finally {
    state.busy = false
  }
}

export async function installMcp() {
  state.busy = true
  try {
    state.mcpStatusText = await mcpInstall()
    notify('mountos registered as an MCP server')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'MCP install failed', 'error')
  } finally {
    state.busy = false
  }
}

export async function uninstallMcp() {
  state.busy = true
  try {
    state.mcpStatusText = await mcpUninstall()
    notify('mountos MCP server removed')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'MCP uninstall failed', 'error')
  } finally {
    state.busy = false
  }
}

export function viewTitle(nextView: View) {
  return nextView === 'instances' ? 'Instances' : nextView === 'profiles' ? 'Profiles' : nextView === 'uploads' ? 'Uploads' : 'Settings'
}

export {
  buildDeletedArgv,
  buildForkCreateArgv,
  buildForkDeleteArgv,
  buildForkListArgv,
  buildForkRestoreArgv,
  buildGatewayArgv,
  buildMountArgv,
  buildSnapshotArgv,
  buildUploadCancelArgv,
  buildUploadListArgv,
  buildUploadPruneArgv,
  buildUploadResumeArgv,
  buildUploadRetryFailedArgv,
  buildUploadStartArgv,
  buildVersionArgv,
}
