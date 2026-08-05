import { tick } from 'svelte'
import { showErrorToast, showInfoToast, showWarningToast } from './toast.svelte'
import {
  buildDeletedArgv,
  buildDownloadCancelArgv,
  buildDownloadListArgv,
  buildDownloadPruneArgv,
  buildDownloadRemoveArgv,
  buildDownloadResumeArgv,
  buildDownloadRetryFailedArgv,
  buildDownloadStartArgv,
  buildExternalSourceUri,
  buildForkCreateArgv,
  buildForkDeleteArgv,
  buildForkListArgv,
  buildForkRestoreArgv,
  buildGatewayArgv,
  buildMountArgv,
  buildSinkPruneArgv,
  buildSinkRemoveArgv,
  buildSinkResumeArgv,
  buildSinkStartArgv,
  buildSnapshotArgv,
  buildUploadCancelArgv,
  buildUploadListArgv,
  buildUploadPruneArgv,
  buildUploadRemoveArgv,
  buildUploadResumeArgv,
  buildUploadRetryFailedArgv,
  buildUploadStartArgv,
  buildVersionArgv,
  classifyMountError,
  errorClassLabel,
  isAbsolutePath,
  isValidFolderName,
  parseArgvInput,
  validateExternalSourceFields,
  validateExtraArgs,
  validateGlobPattern,
  validateMountPathForBackend,
  validateUploadPositional,
} from './cli'
import type { DownloadStartParams, SinkStartParams, UploadStartParams } from './cli'
import { viewModeBadge } from './health'
import { FEATURE_REGISTRY, resolveFeatures } from './features'
import {
  browseCliBinary,
  browseFolder,
  browseVersionFile as pickVersionFile,
  cancelUpload,
  createDiagnosticsBundle,
  defaultViewDestination,
  deleteProfile,
  deleteProfileSecret,
  deleteTransferSourceProfile,
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
  listTransferSourceProfiles,
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
  openUploadLog,
  openVersionView,
  openVersionViewForInstance,
  randomFriendlyName,
  ensureUploadBrowseMount,
  listUploads,
  pruneUploads,
  removeUpload,
  resumeUpload,
  retryFailedUpload,
  finishUpload,
  listDownloads,
  startDownload,
  ensureDownloadBrowseMount,
  resumeDownload,
  cancelDownload,
  retryFailedDownload,
  finishDownload,
  pruneDownloads,
  removeDownload,
  openDownloadLog,
  listSinks,
  startSink,
  resumeSink,
  cancelSink,
  finishSink,
  pruneSinks,
  removeSink,
  getSinkStatus,
  openSinkLog,
  saveProfile,
  saveSettings,
  saveTransferSourceProfile,
  setProfileSecret,
  setTransferSourceProfileSecret,
  startUpload,
  stopGateway,
  stopGatewayOnly,
  unmountTarget,
  unmountAllTargets,
  validateCliCandidate,
  verifyCliSignature,
} from './tauri'
import type {
  Backend,
  CliSignatureStatus,
  DesktopSettings,
  DiagnosticsBundle,
  DownloadJob,
  Fork,
  GatewayEndpointInfo,
  MountInstance,
  MountProfile,
  SinkJob,
  SinkSnapshot,
  SinkStatus,
  SystemState,
  ThirdPartyLicenses,
  TransferSourceProfile,
  UploadInstanceRef,
  UploadJob,
} from './types'

export type View = 'instances' | 'profiles' | 'uploads' | 'downloads' | 'sink' | 'settings'

// The profile editor's right-hand pane: the plain editor form, or one of the
// five full-width sub-views nested under the selected profile (Forks and the
// four former Snapshot/Deleted/Version/Gateway dialogs).
export type ProfileSubView = 'editor' | 'forks' | 'snapshot' | 'deleted' | 'version' | 'gateway'

// Settings view's sidebar-tab category. Lives here, not as local component
// state, so the command palette (goToSettingsSection) can select a tab from
// outside SettingsView.
export type SettingsTab = 'appearance' | 'mounting' | 'monitoring' | 'actions' | 'features' | 'mcp' | 'diagnostics' | 'about'

// The subset of an instance's own live .mountOS/.config (read via
// getInstanceConfig) relevant to the external Deleted/Version dialogs,
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

// Starting point offered when a user turns off Auto disk-cache sizing,
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

// One JSON blob keyed by panel id (uploads/downloads/sink/profiles/...), not
// a hand-rolled boolean per panel like sidebarCollapsed above, since JobPanel is
// a shared component mounted by every job-list view, so a new view gets
// collapse persistence for free instead of needing its own storage key.
function initialJobPanelCollapsed(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem('mountos-desktop-job-panel-collapsed')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export type JobPanelSide = 'left' | 'right'

// Same one-JSON-blob-keyed-by-id shape as jobPanelCollapsed above. Which side
// a panel docks on is set by which expand button the user clicks on its
// header chip (App.svelte), not a separate toggle; see setJobPanelSide.
function initialJobPanelSide(): Record<string, JobPanelSide> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem('mountos-desktop-job-panel-side')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const state = $state({
  view: 'instances' as View,
  loaded: false,
  profiles: [] as MountProfile[],
  systemState: { platform: 'macos', checkOk: false, issues: [], instances: [], cliPathAlternates: [], terminals: [] } as SystemState,
  selectedProfileId: null as string | null,
  // The volume kind as last known persisted (selectProfile/refresh/save),
  // NOT the live-edited draft in `profiles`, patchProfile mutates that
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
  settings: { defaultBackend: 'auto', allowForkForceDelete: false, allowUnmountForce: false, featureOverrides: {} } as DesktopSettings,
  vaultStatus: {} as Record<string, boolean>,
  diagnosticsBundle: null as DiagnosticsBundle | null,
  mcpStatusText: '',
  // Result of the last "Verify" click for the CLI path currently in effect
  // (pinned override or PATH lookup). Cleared whenever that path changes, so
  // a stale result never appears to describe a different binary.
  cliSignatureStatus: null as CliSignatureStatus | null,
  cliSignatureChecking: false,
  expandedConfig: {} as Record<string, string>,
  mountHelpText: '',
  mountHelpVisible: false,
  sidebarCollapsed: initialSidebarCollapsed(),
  skipUnmountConfirm: initialSkipUnmountConfirm(),
  // Collapse preference per JobPanel id, persisted. jobPanelFloatingId/
  // jobPanelMounted are both transient (session-only): floating tracks which
  // panel's quick-select overlay is open (at most one at a time), mounted
  // tracks which panel ids currently have a live JobPanel instance in the
  // DOM, since a view can swap its job-list section out entirely for a
  // create/resume/sub-view form. This gates the header chip so it never offers
  // to reopen a panel that isn't actually there right now.
  jobPanelCollapsed: initialJobPanelCollapsed() as Record<string, boolean>,
  jobPanelFloatingId: null as string | null,
  jobPanelMounted: {} as Record<string, boolean>,
  // Which side a panel docks on, persisted like jobPanelCollapsed. Set by
  // clicking the matching (left/right) expand button on the collapsed
  // header chip, not a separate toggle.
  jobPanelSide: initialJobPanelSide() as Record<string, JobPanelSide>,
  tipsOpen: false,
  licensesOpen: false,
  licensesKind: 'rust' as 'rust' | 'js',
  licensesLoading: false,
  licensesError: '',
  licensesData: {} as Partial<Record<'rust' | 'js', ThirdPartyLicenses>>,

  // Secret prompt (mount). secretPromptResume, when set, is what the
  // dialog's submit calls instead of the hardcoded main-mount doMount. It is
  // the generic path a scratch-mount Browse flow uses (see
  // ensureBrowseSecret) to fill the prompted secret into its own form field
  // and retry, rather than failing with a raw "secret required" error.
  secretPromptFor: null as string | null,
  secretValue: '',
  secretError: '',
  savePromptedSecret: false,
  secretPromptResume: null as ((secret: string) => Promise<void>) | null,

  // Delete-profile confirm
  deletePromptFor: null as MountProfile | null,

  // Unmount confirm
  unmountPromptFor: null as MountInstance | 'all' | null,
  // Per-prompt opt-in to --force, only offered when settings.allowUnmountForce
  // is on. Reset every time the prompt opens or closes.
  unmountPromptForce: false,

  // Stop-gateway confirm (standalone gateway-only rows, see runStopGatewayOnly)
  stopGatewayPromptFor: null as MountInstance | null,

  // Settings view's active sidebar tab (see SettingsTab); shared state so
  // goToSettingsSection can select it from the command palette.
  settingsTab: 'appearance' as SettingsTab,

  // Fork management: its own navigable place (ForkBrowserView), reached from
  // the profile editor via a "Forks" satellite button, not embedded inline
  // in the editor form. Always available; only --force on delete is gated
  // (settings.allowForkForceDelete).
  profileSubView: 'editor' as ProfileSubView,
  forks: [] as Fork[],
  // null = viewing the profile's own root ("main"); otherwise the fid of the
  // fork currently drilled into. Pure client-side navigation over `forks`,
  // no CLI call, see drillIntoFork.
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
  // or Select-picked name, this dialog is also the delete confirmation
  // fork delete previously had none of.
  forkDeletePromptFor: null as Fork | null,
  forkDeleteForce: false,
  forkDeleteSecretValue: '',
  forkDeleteError: '',

  forkRestorePromptFor: null as Fork | null,
  forkRestoreSecretValue: '',
  forkRestoreError: '',

  // Uploads: a top-level view (like Instances/Profiles). List is the
  // default sub-view (master-detail: job list on the left, selected job's
  // detail on the right, same layout as ProfilesView); "New upload" and
  // "Resume" each open their own full-panel sub-view with a back button
  // (not a modal, a resume/create form has too many fields to cram into
  // a dialog cleanly), mirroring Profiles' editor/forks/snapshot/... split.
  uploadSubView: 'list' as 'list' | 'create' | 'resume',
  uploads: [] as UploadJob[],
  uploadsBusy: false,
  uploadsError: '',
  // Wall-clock ms of the last successful runUploadList(). There's no
  // auto-poll for this list (only the mount-on-first-view fetch plus a
  // refetch after every mutating action), so surfacing this tells the user
  // how stale the list might be rather than implying a live feed.
  uploadsLastFetchedAt: null as number | null,
  uploadSelectedJobId: null as string | null,
  // Cleanly-completed jobs are historical noise once done, nothing
  // pruned automatically accumulates them indefinitely (mountos-servers
  // upload prune is manual-only), so the left panel hides them by default
  // rather than growing unbounded. A completed job with failures still
  // needs attention and stays visible regardless of this toggle.
  uploadShowCompleted: false,

  // Create-job form: source is either a saved profile OR a live running
  // mount instance with no saved profile (mirrors requestExternalDeletedView's
  // "no profile, re-derive from the live mount's own config" pattern).
  // Fork/discovery-url/access-key always come from whichever is picked
  // (never a free-typed value), so there is no separate form field for any
  // of them.
  uploadSourceKind: 'profile' as 'profile' | 'instance',
  uploadSourceProfileId: null as string | null,
  uploadProfileQuery: '',
  // Captured once (via getInstanceConfig) the moment an instance is picked;
  // reused verbatim by the Rust side if the instance is no longer mounted
  // by the time Browse/Start actually runs (resolve_upload_source_profile's
  // own fallback), so this is intentionally NOT re-fetched on every use.
  uploadSourceInstance: null as UploadInstanceRef | null,

  // Form fields. include/exclude are newline-separated textareas (split
  // into glob arrays at submit time) rather than a dynamic list of inputs
  // (simpler to bind), and --include/--exclude are themselves free-form
  // globs a user is likely to paste several of at once. bwlimit/rescan-
  // interval/include/exclude/restart/follow-symlinks/create-source-dir all
  // live behind the collapsed "Advanced options" disclosure.
  uploadSource: '',
  uploadDest: '',
  uploadSourceError: '',
  uploadDestError: '',
  uploadAdvancedOpen: false,
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
  // uploadSourceType is an explicit, deliberate choice (a Select, not
  // inferred from what's typed into a text field) between a local
  // folder/profile-manifest source and an external object store --
  // isExternalUploadSource() below reads this, nothing sniffs uploadSource's
  // own text for a scheme prefix anymore. 'local' leaves every field below
  // unused; uploadSource itself is ONLY used in 'local' mode (externalSourceUri
  // builds the equivalent URI from the structured fields for 'external').
  uploadSourceType: 'local' as 'local' | 'external',
  uploadSourceProvider: '',
  uploadSourceBucket: '',
  uploadSourcePrefix: '',
  uploadSourceEndpoint: '',
  uploadSourceRegion: '',
  uploadSourceAccount: '',
  uploadSourceAccessKeyId: '',
  // Plaintext secret held only in memory for the duration of a Start or Test
  // call (see runUploadStart/runUploadSourceTest: passed straight to
  // startUpload, never persisted, never logged) -- Rust writes it to a
  // private temp file and the CLI unlinks that file itself immediately
  // after reading it.
  uploadSourceSecretValue: '',
  // A saved TransferSourceProfile currently backing the form's fields --
  // set by selectTransferSourceProfile, cleared by resetTransferSourceForm/
  // switching to 'local'. Threaded through to Start/Test as
  // transferSourceProfileId so Rust resolves a "vault" profile's secret
  // itself (see startUpload's own doc comment) rather than this app ever
  // holding the decrypted secret just to hand it back for the same profile.
  uploadSourceProfileSelectedId: null as string | null,
  transferSourceProfiles: [] as TransferSourceProfile[],
  transferSourceProfilesLoaded: false,
  // "Save as transfer profile" panel state, shown after a successful Test
  // Connection or Start -- entirely separate from the live form fields
  // above so filling in a save-name never affects what Start/Test submits.
  uploadSourceSaveOpen: false,
  uploadSourceSaveName: '',
  uploadSourceSaveToVault: true,
  uploadSourceSaveError: '',
  // Test Connection's own result slot, deliberately separate from
  // uploadDryRunReport/uploadStartError: a pre-flight check the user runs
  // before Start must never be confused with, or overwritten by, an actual
  // Start attempt's own dry-run report or failure.
  uploadSourceTestBusy: false,
  uploadSourceTestReport: '',
  uploadSourceTestError: '',
  uploadStartSecretValue: '',
  uploadStartError: '',
  uploadBrowseError: '',
  // Populated only after a --dry-run start (the report text itself, not a
  // real job), cleared at the start of the NEXT runUploadStart call
  // (dry-run or not), so a stale report never lingers past the point the
  // form's inputs have actually changed and been resubmitted.
  uploadDryRunReport: '',

  uploadResumePromptFor: null as UploadJob | null,
  // Resume works from these two fields alone (job.json already fixes the
  // job's volume/fork/paths server-side, see resumeUpload's own comment),
  // not a saved profile, a job may not have one at all (e.g. started via
  // CLI). Prefilled from the Profiles-page selection as a convenience
  // default when requestUploadResume opens, always editable.
  uploadResumeDiscoveryUrl: '',
  uploadResumeAccessKeyId: '',
  uploadResumeOnce: false,
  uploadResumeRescanInterval: '',
  uploadResumeSecretValue: '',
  uploadResumeError: '',

  // Prune is the one upload action that's a permanent, irreversible delete
  // of job records (unlike cancel/retry-failed, which only touch live state
  // and stay resumable), same reason fork delete gets a confirm dialog.
  uploadPrunePromptOpen: false,
  uploadPruneKeep: '0',
  uploadPruneError: '',

  // Remove is prune's single-job sibling: it clears a job stuck resumable
  // because its process was killed before it could stamp a terminal field
  // (crash, OOM, power loss) -- cancel refuses it (no live process) and
  // prune skips it (no terminal stamp) -- so it also needs a confirm
  // dialog, same reasoning as uploadPrunePromptOpen above.
  uploadRemovePromptFor: null as UploadJob | null,
  uploadRemoveError: '',

  // Downloads: the same top-level view/subview shape as Uploads (list is the
  // default master-detail sub-view; "New download"/"Resume" are their own
  // full-panel sub-views), reversed direction (pull FROM a mountOS volume TO
  // local disk). See downloadSourceKind's own comment for why its two modes
  // are NOT the same "profile vs live instance" tradeoff uploadSourceKind's
  // identical-looking naming represents.
  downloadSubView: 'list' as 'list' | 'create' | 'resume',
  downloads: [] as DownloadJob[],
  downloadsBusy: false,
  downloadsError: '',
  downloadsLastFetchedAt: null as number | null,
  downloadSelectedJobId: null as string | null,
  downloadShowCompleted: false,

  // Create-job form. 'instance' means SOURCE is a local path read straight
  // through an already-mounted live instance. No RPC, no connection, no
  // credentials at all (mode A). 'profile' means SOURCE is a mountOS-relative
  // path on a saved profile's fork, connecting fresh, optionally pinned to
  // a historical AsOf snapshot rather than the fork's live state (mode B).
  // Unlike uploadSourceKind, 'instance' here is NOT "a live instance I still
  // need to authenticate a new connection to", see downloadNeedsSecret.
  downloadSourceKind: 'instance' as 'instance' | 'profile',
  downloadSourceProfileId: null as string | null,
  downloadProfileQuery: '',
  // Captured once (via getInstanceConfig) the moment an instance is picked,
  // same one-shot pattern as uploadSourceInstance, reusing the identical
  // UploadInstanceRef shape (a generic "live instance identity", not
  // upload-specific in content).
  downloadSourceInstance: null as UploadInstanceRef | null,

  // Mode A: an absolute local path under the instance's own mount, chosen via
  // browseDownloadSource. CLI reads it straight off local disk, no
  // mountOS-relative translation. Mode B: a mountOS-relative path on the
  // profile's fork (translated from a scratch-mount browse the same way
  // uploadDest is). ifExists/depth are visible top-level fields (not behind
  // Advanced), both meaningfully change default behavior, see cmd_download.
  // go's own --if-exists/--depth doc comments.
  downloadSource: '',
  downloadDest: '',
  downloadSourceError: '',
  downloadDestError: '',
  downloadIfExists: 'skip' as 'skip' | 'overwrite' | 'bounce',
  downloadDepth: '1',
  // Profile-mode only, see downloadAsOf's own derivation (mirrors
  // forkCreateAsOfLocal's datetime-local pattern exactly).
  downloadAsOfLocal: '',
  downloadAdvancedOpen: false,
  downloadDryRun: false,
  downloadRestart: false,
  downloadBwlimit: '',
  downloadIncludeText: '',
  downloadExcludeText: '',
  downloadFollowSymlinks: false,
  downloadCreateSourceDirectory: false,
  // downloadDestType mirrors uploadSourceType exactly, on the opposite
  // positional: an explicit, deliberate choice between a local disk
  // destination and pushing to an external object store. 'local' leaves
  // every field below unused; downloadDest itself is ONLY used in 'local'
  // mode (effectiveDownloadDest below builds the equivalent URI from the
  // structured fields for 'external').
  downloadDestType: 'local' as 'local' | 'external',
  downloadDestProvider: '',
  downloadDestBucket: '',
  downloadDestPrefix: '',
  downloadDestEndpoint: '',
  downloadDestRegion: '',
  downloadDestAccount: '',
  downloadDestAccessKeyId: '',
  // Plaintext secret held only in memory for the duration of a Start or Test
  // call (see runDownloadStart/runDownloadDestTest: passed straight to
  // startDownload, never persisted, never logged) -- Rust writes it to a
  // private temp file and the CLI unlinks that file itself immediately
  // after reading it.
  downloadDestSecretValue: '',
  // A saved TransferSourceProfile currently backing the form's fields --
  // the SAME store uploadSourceProfileSelectedId picks from (see that
  // field's own doc comment on TransferSourceProfile being provider/bucket/
  // prefix/credential-generic, not upload-specific), just selected as a
  // destination here instead of a source. Threaded through to Start/Test as
  // transferDestProfileId so Rust resolves a "vault" profile's secret itself
  // rather than this app ever holding the decrypted secret just to hand it
  // back for the same profile.
  downloadDestProfileSelectedId: null as string | null,
  // "Save as transfer profile" panel state, shown after a successful Test
  // Connection or Start -- entirely separate from the live form fields
  // above so filling in a save-name never affects what Start/Test submits.
  downloadDestSaveOpen: false,
  downloadDestSaveName: '',
  downloadDestSaveToVault: true,
  downloadDestSaveError: '',
  // Test Connection's own result slot, deliberately separate from
  // downloadDryRunReport/downloadStartError: a pre-flight check the user
  // runs before Start must never be confused with, or overwritten by, an
  // actual Start attempt's own dry-run report or failure.
  downloadDestTestBusy: false,
  downloadDestTestReport: '',
  downloadDestTestError: '',
  downloadStartSecretValue: '',
  downloadStartError: '',
  downloadBrowseError: '',
  downloadDryRunReport: '',

  // download resume has no --once/--rescan-interval (every run is already
  // single-pass), so this needs far fewer fields than uploadResume*.
  downloadResumePromptFor: null as DownloadJob | null,
  downloadResumeDiscoveryUrl: '',
  downloadResumeAccessKeyId: '',
  downloadResumeSecretValue: '',
  downloadResumeError: '',

  downloadPrunePromptOpen: false,
  downloadPruneKeep: '0',
  downloadPruneError: '',

  // Remove is prune's single-job sibling, same reasoning as
  // uploadRemovePromptFor above.
  downloadRemovePromptFor: null as DownloadJob | null,
  downloadRemoveError: '',

  // Sink (Media ingest): same top-level view/subview shape as Uploads/
  // Downloads (list is the default master-detail sub-view; "New ingest"/
  // "Resume" are their own full-panel sub-views). A sink job's live state is
  // rate/lag counters, not a bounded per-status work list, so there is no
  // showCompleted-style counts derivation the way upload/download have;
  // sortSinkJobs/sinkStateRank cover ordering only.
  sinkSubView: 'list' as 'list' | 'create' | 'resume',
  sinks: [] as SinkJob[],
  sinksBusy: false,
  sinksError: '',
  // Mount-on-first-view fetch, manual refresh, and a refetch after every
  // mutating action, same baseline as uploadsLastFetchedAt, plus SinkView's
  // own bounded poll while a job is running (see runSinkStatus's comment);
  // unlike uploads/downloads which never auto-refresh.
  sinksLastFetchedAt: null as number | null,
  sinkSelectedJobId: null as string | null,
  sinkShowCompleted: false,
  // The fuller single-job rate/lag snapshot (`sink status --job <id>
  // --json`), fetched on demand for whichever job is selected, keyed by job
  // id so switching between jobs doesn't have to re-fetch one already seen
  // this session. Cleared on runSinkList (a fresh list pass invalidates any
  // stale per-job snapshot).
  sinkStatusByJobId: {} as Record<string, SinkStatus>,

  // Create-job form: the connection (fork/discovery-url/access-key) is
  // either a saved profile OR a live running mount instance, identical
  // resolution to uploadSourceKind (sink's dest is always the mountOS
  // volume, same as upload's, regardless of source mode; sink has no
  // "read straight through a live mount" source the way download's instance
  // mode does, its source is always a remote M3U8 URL).
  sinkSourceKind: 'profile' as 'profile' | 'instance',
  sinkSourceProfileId: null as string | null,
  sinkProfileQuery: '',
  sinkSourceInstance: null as UploadInstanceRef | null,

  // Form fields. streamUrl is the M3U8_URL positional (always a remote
  // URL, never local/browsable), sinkPath is the SINK_PATH positional (a
  // template, %Y/%m/%d/%H/%M substitutions apply server-side, so this is
  // free text, not a Browse-picked path the way upload/download's dest is).
  sinkStreamUrl: '',
  sinkPath: '',
  sinkStreamUrlError: '',
  sinkPathError: '',
  sinkAdvancedOpen: false,
  sinkVariant: '',
  sinkMaxLatency: '',
  sinkWalMax: '',
  sinkStartSecretValue: '',
  sinkStartError: '',

  sinkResumePromptFor: null as SinkJob | null,
  sinkResumeDiscoveryUrl: '',
  sinkResumeAccessKeyId: '',
  sinkResumeSecretValue: '',
  sinkResumeError: '',

  sinkPrunePromptOpen: false,
  sinkPruneKeep: '0',
  sinkPruneError: '',

  // Remove is prune's single-job sibling, same reasoning as
  // uploadRemovePromptFor above.
  sinkRemovePromptFor: null as SinkJob | null,
  sinkRemoveError: '',

  // Snapshot/Deleted/Version view-mounts: destination is always an explicit
  // folder pick (browseFolder), never free-typed. -m/--destination is
  // mandatory server-side for all three (no auto-derivation exists).
  // Profile-based, not instance-based: none of these CLI commands need an
  // existing running mount, they connect to discovery+dataserv independently.
  // Which profile: computed.selectedProfile (see profileSubView), not a
  // separately-captured field, patchProfile replaces objects in
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

  // Gateway launch (S3/HDFS): same family as Snapshot/Deleted/Version,
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
  // from the terminal, or any tool outside this app), profile is
  // deliberately optional, see openDeletedViewForInstance/
  // openVersionViewForInstance in tauri.ts. Kept as a modal (operates on a
  // MountInstance, not a MountProfile) rather than folded into
  // DeletedView/VersionView, same field shape as the profile-based
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
  // (see requestExternalDeletedView), there is no MountProfile to answer
  // "does this need a secret" or build a COMMAND PREVIEW the way
  // profile.secretRef/vaultStatus and buildDeletedArgv(profile, ...) do for
  // the profile-based case. null means not yet fetched (or unreadable);
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
// space-separated "2006-01-02 15:04"), unlike ParseSnapshotTime, it has no
// relative-offset support and no T-separated ISO variant, so the T must be
// swapped for a space before use.
const forkCreateAsOf = $derived(state.forkCreateAsOfLocal ? state.forkCreateAsOfLocal.replace('T', ' ') : '')

// download's --as-of accepts the same flexible format as fork create's
// --as-of (see buildDownloadStartArgv's own comment), same datetime-local
// T-to-space swap as forkCreateAsOf, for the same reason.
const downloadAsOf = $derived(state.downloadAsOfLocal ? state.downloadAsOfLocal.replace('T', ' ') : '')

// snapshot --timestamp accepts both the datetime-local T-separated ISO form
// and relative offsets ("2h", "3d") directly (ParseSnapshotTime), unlike
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
// (discoveryUrl/fork/volume/accessKeyId/cacheDir/extraArgs, confirmed
// against cli.ts, neither reads backend) so the external dialogs' COMMAND
// PREVIEW can reuse the exact same builders the profile-based views do,
// rather than a second, drift-prone reimplementation of the same argv
// logic. Never sent anywhere, purely local, display-only; the real launch
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

// The root/"main" fork is fid=0, self-parented (parentFid=0 too). Excluding
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
// the search text. Filtering it out would silently swap what the editor
// below is showing without any visible cue why it vanished from the list.
const filteredProfiles = $derived.by(() => {
  const q = state.profileQuery.trim().toLowerCase()
  if (!q) return state.profiles
  return state.profiles.filter((profile) => profile.id === state.selectedProfileId || profile.name.toLowerCase().includes(q))
})

// Search-filtered for the upload create form's profile picker. Unlike
// filteredProfiles above, there's no "selected profile must stay visible"
// exception needed here (uploadSourceProfileId is reset whenever the query
// changes the visible set enough to matter, via selectUploadProfile).
const uploadFilteredProfiles = $derived.by(() => {
  const q = state.uploadProfileQuery.trim().toLowerCase()
  if (!q) return state.profiles
  return state.profiles.filter((profile) => profile.name.toLowerCase().includes(q))
})

const uploadSelectedProfile = $derived(state.profiles.find((profile) => profile.id === state.uploadSourceProfileId))

// Mounted, active, and NOT a Snapshot/Deleted/Version view or a gateway-only
// entry, those are read-only historical/derived views, not a real
// browsable filesystem an upload could source from. viewModeBadge is the
// same check InstancesView itself uses to badge those rows. Exported as a
// standalone predicate (not just the derived list below) so InstancesView's
// own per-row "Upload from here" action can gate on the identical
// criterion without depending on array-reference equality against this
// derived list.
export function canUploadFrom(instance: MountInstance): boolean {
  return instance.kind !== 'gateway' && instance.health === 'healthy' && !instance.orphaned && !viewModeBadge(instance.viewMode)
}

const uploadEligibleInstances = $derived(state.systemState.instances.filter(canUploadFrom))

// The fork badge shown next to the create form, always derived from
// whichever source is picked, never a form field.
const uploadResolvedFork = $derived(
  state.uploadSourceKind === 'profile' ? (uploadSelectedProfile?.fork ?? '') : (state.uploadSourceInstance?.fork ?? ''),
)

// A saved profile may have its secret cached in the vault already, so the
// field is conditional there. A running-instance source is never a saved
// profile (there's no vault entry to check, ever), so the secret field
// always needs to be offered (this is also the "browse doesn't need a
// secret, only upload does" case from the source spec).
const uploadNeedsSecret = $derived(
  state.uploadSourceKind === 'profile'
    ? Boolean(uploadSelectedProfile) && (uploadSelectedProfile!.secretRef === 'prompt' || !state.vaultStatus[uploadSelectedProfile!.id])
    : Boolean(state.uploadSourceInstance),
)

// A profile-shaped object purely for COMMAND PREVIEW / argv building,
// never sent anywhere itself (the real start_upload call re-derives its own
// profile server-side, see resolve_upload_source_profile), same trick
// previewProfileFromExternalConfig below uses for Deleted/Version.
const uploadPreviewProfile = $derived.by((): MountProfile | null => {
  if (state.uploadSourceKind === 'profile') return uploadSelectedProfile ?? null
  const instance = state.uploadSourceInstance
  if (!instance) return null
  return {
    id: 'instance',
    schemaVersion: 1,
    kind: 'mount',
    name: instance.volume || 'Running instance',
    volume: instance.volume,
    fork: instance.fork,
    mountPath: instance.mountPath,
    discoveryUrl: instance.discoveryUrl,
    accessKeyId: instance.accessKeyId,
    secretRef: 'prompt',
    backend: instance.backend,
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  }
})

// isExternalUploadSource reads the explicit Source type toggle -- nothing
// sniffs uploadSource's own text for a scheme prefix; local vs. object
// storage is a deliberate choice the same way Profile vs. running-Instance
// already is, not inferred from what happens to be typed.
export function isExternalUploadSource(): boolean {
  return state.uploadSourceType === 'external'
}

// effectiveUploadSource is the actual SOURCE positional argv/preview/submit
// ever see: uploadSource verbatim in 'local' mode, or the URI built from the
// structured provider/bucket/prefix fields in 'external' mode -- the ONE
// place those two modes converge back into a single string, so every other
// call site (preview, start, test) reads this instead of branching itself.
export function effectiveUploadSource(): string {
  if (!isExternalUploadSource()) return state.uploadSource.trim()
  return buildExternalSourceUri(state.uploadSourceProvider, state.uploadSourceBucket, state.uploadSourcePrefix) ?? ''
}

const uploadCommandText = $derived.by(() => {
  const profile = uploadPreviewProfile
  const source = effectiveUploadSource()
  if (!profile || !source || !state.uploadDest.trim()) return ''
  // A real secret is never written to a temp file just to render this
  // preview -- the placeholder makes clear a real run substitutes an actual
  // path, matching this app's existing "show the exact command, never a
  // secret value" convention (see cli.ts's own doc comments elsewhere on
  // never letting secrets reach argv/preview text). Shown whenever a
  // secret will actually be resolved, whether typed here or supplied by a
  // selected vault profile -- checking only the typed field would drop the
  // flag from the preview for a vault-backed profile even though the real
  // spawned command still includes it.
  const sourceSecretFile =
    isExternalUploadSource() && (state.uploadSourceSecretValue.trim() || uploadSourceProfileUsesVault()) ? '<temp-file-written-at-start>' : undefined
  return `mountos ${buildUploadStartArgv(profile, source, state.uploadDest.trim(), uploadStartParams(), sourceSecretFile).join(' ')}`
})

// Sidebar badge count, lazily updated (whatever `uploads` last held from
// the most recent runUploadList call, not a dedicated poll loop), per the
// design's deliberate choice not to add background CLI shell-outs for a
// feature most sessions never touch.
const uploadRunningCount = $derived(state.uploads.filter((job) => job.state === 'running').length)

// Sidebar CLI-status tooltip: names the actual problem (or version, when
// healthy) instead of a generic "see Settings for details". The most
// severe issue is the one worth surfacing without opening Settings at all.
const cliStatusSummary = $derived.by(() => {
  if (state.systemState.checkOk) {
    return state.systemState.cliVersion ? `mountOS CLI ready (${state.systemState.cliVersion})` : 'mountOS CLI ready'
  }
  const severityRank = { error: 0, warning: 1, info: 2 } as const
  const worst = [...state.systemState.issues].sort((a, b) => severityRank[a.severity] - severityRank[b.severity])[0]
  return worst ? worst.title : 'mountOS CLI issue, see Settings for details'
})

function isCleanlyCompletedUpload(job: UploadJob): boolean {
  return job.state === 'completed' && (job.counts.failed ?? 0) === 0
}

// A completed job with permanent failures still needs attention and stays
// visible regardless of the toggle, only a clean completion is hidden.
const uploadHiddenCompletedCount = $derived(state.uploads.filter(isCleanlyCompletedUpload).length)

// Bounded independent of how many historical jobs `list --kind upload`
// returns (nothing prunes them automatically, see uploadShowCompleted's
// own comment): the left panel never renders more than this many rows even
// with "show completed" on, so a long-lived install's job history can't
// turn the list into thousands of unvirtualized DOM nodes.
const UPLOAD_VISIBLE_JOB_CAP = 300

// `list --kind upload` has no stable ordering of its own (ListJobDirs
// returns directory-name/hex-hash order, arbitrary with respect to state or
// recency), so without this a genuinely running job could sort behind an
// old completed one and get pushed past the cap.
export function uploadStateRank(job: UploadJob): number {
  if (job.state === 'running') return 0
  if (job.state === 'halted' || job.state === 'resumable') return 1
  return 2 // completed
}

// Pulled out of the $derived below as a plain function so the ordering
// logic is unit-testable without a reactive context.
export function sortUploadJobs(jobs: UploadJob[]): UploadJob[] {
  return [...jobs].sort((a, b) => {
    const rankDiff = uploadStateRank(a) - uploadStateRank(b)
    return rankDiff !== 0 ? rankDiff : (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
}

const uploadVisibleJobs = $derived.by(() => {
  const base = state.uploadShowCompleted ? state.uploads : state.uploads.filter((job) => !isCleanlyCompletedUpload(job))
  const sorted = sortUploadJobs(base)
  return sorted.slice(0, UPLOAD_VISIBLE_JOB_CAP)
})

const uploadVisibleJobsTotal = $derived(
  state.uploadShowCompleted ? state.uploads.length : state.uploads.length - uploadHiddenCompletedCount,
)
const uploadVisibleJobsTruncated = $derived(uploadVisibleJobsTotal > UPLOAD_VISIBLE_JOB_CAP)

// Search-filtered for the download create form's profile picker (profile
// mode only, instance mode uses downloadEligibleInstances instead).
const downloadFilteredProfiles = $derived.by(() => {
  const q = state.downloadProfileQuery.trim().toLowerCase()
  if (!q) return state.profiles
  return state.profiles.filter((profile) => profile.name.toLowerCase().includes(q))
})

const downloadSelectedProfile = $derived(state.profiles.find((profile) => profile.id === state.downloadSourceProfileId))

// Reused verbatim, not duplicated: "a real browsable filesystem this could
// read a source from" is the identical criterion canUploadFrom already
// checks (healthy, not orphaned, not gateway-only, not a Snapshot/Deleted/
// Version view mount), there's no genuine reason download's eligibility
// should differ.
export function canDownloadFrom(instance: MountInstance): boolean {
  return canUploadFrom(instance)
}

const downloadEligibleInstances = $derived(state.systemState.instances.filter(canDownloadFrom))

// The fork badge shown next to the create form, always derived from
// whichever source is picked, never a form field.
const downloadResolvedFork = $derived(
  state.downloadSourceKind === 'profile' ? (downloadSelectedProfile?.fork ?? '') : (state.downloadSourceInstance?.fork ?? ''),
)

// Deliberate asymmetry vs uploadNeedsSecret (NOT a copy of its
// Boolean(state.uploadSourceInstance) instance-branch logic): an
// instance-mode download SOURCE reads straight through the already-live
// local mount with no RPC/connection at all (mode A, cmd_download.go's
// detectDownloadSourceKind), upload's instance-sourced flow, by contrast,
// still opens a FRESH connection to its (always-remote) destination, so it
// unconditionally needs a secret. Only a profile-mode download source
// (mode B, connect fresh) ever needs one here, gated the same way upload's
// profile branch is: a cached vault secret makes the field unnecessary.
const downloadNeedsSecret = $derived(
  state.downloadSourceKind === 'profile'
    ? Boolean(downloadSelectedProfile) && (downloadSelectedProfile!.secretRef === 'prompt' || !state.vaultStatus[downloadSelectedProfile!.id])
    : false,
)

// isExternalDownloadDest mirrors isExternalUploadSource exactly, on the
// opposite positional: an explicit Destination type toggle, never sniffed
// from downloadDest's own text.
export function isExternalDownloadDest(): boolean {
  return state.downloadDestType === 'external'
}

// effectiveDownloadDest is the actual DEST_PATH positional argv/preview/
// submit ever see, mirrors effectiveUploadSource: downloadDest verbatim in
// 'local' mode, or the URI built from the structured provider/bucket/prefix
// fields in 'external' mode.
export function effectiveDownloadDest(): string {
  if (!isExternalDownloadDest()) return state.downloadDest.trim()
  return buildExternalSourceUri(state.downloadDestProvider, state.downloadDestBucket, state.downloadDestPrefix) ?? ''
}

// Unlike uploadCommandText (which always needs a synthetic preview profile,
// even for an instance source, because buildUploadStartArgv's profile
// parameter is non-nullable), buildDownloadStartArgv takes `profile:
// MountProfile | null` and only reads it for sourceKind 'profile'. An
// instance-mode source needs no profile object here at all.
const downloadCommandText = $derived.by(() => {
  const source = state.downloadSource.trim()
  const dest = effectiveDownloadDest()
  if (!source || !dest) return ''
  if (state.downloadSourceKind === 'profile' && !downloadSelectedProfile) return ''
  const profile = state.downloadSourceKind === 'profile' ? (downloadSelectedProfile ?? null) : null
  // A real secret is never written to a temp file just to render this
  // preview, same convention as uploadCommandText's own sourceSecretFile
  // placeholder, including showing it for a vault-backed profile even
  // when the field itself is left blank.
  const destSecretFile =
    isExternalDownloadDest() && (state.downloadDestSecretValue.trim() || downloadDestProfileUsesVault()) ? '<temp-file-written-at-start>' : undefined
  return `mountos ${buildDownloadStartArgv(profile, state.downloadSourceKind, source, dest, downloadStartParams(), destSecretFile).join(' ')}`
})

// Sidebar badge count, same lazily-updated convention as uploadRunningCount
// (whatever `downloads` last held from the most recent runDownloadList call).
const downloadRunningCount = $derived(state.downloads.filter((job) => job.state === 'running').length)

function isCleanlyCompletedDownload(job: DownloadJob): boolean {
  return job.state === 'completed' && (job.counts.failed ?? 0) === 0
}

const downloadHiddenCompletedCount = $derived(state.downloads.filter(isCleanlyCompletedDownload).length)

const DOWNLOAD_VISIBLE_JOB_CAP = 300

export function downloadStateRank(job: DownloadJob): number {
  if (job.state === 'running') return 0
  if (job.state === 'halted' || job.state === 'resumable') return 1
  return 2 // completed
}

export function sortDownloadJobs(jobs: DownloadJob[]): DownloadJob[] {
  return [...jobs].sort((a, b) => {
    const rankDiff = downloadStateRank(a) - downloadStateRank(b)
    return rankDiff !== 0 ? rankDiff : (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
}

const downloadVisibleJobs = $derived.by(() => {
  const base = state.downloadShowCompleted ? state.downloads : state.downloads.filter((job) => !isCleanlyCompletedDownload(job))
  const sorted = sortDownloadJobs(base)
  return sorted.slice(0, DOWNLOAD_VISIBLE_JOB_CAP)
})

const downloadVisibleJobsTotal = $derived(
  state.downloadShowCompleted ? state.downloads.length : state.downloads.length - downloadHiddenCompletedCount,
)
const downloadVisibleJobsTruncated = $derived(downloadVisibleJobsTotal > DOWNLOAD_VISIBLE_JOB_CAP)

// Search-filtered for the sink create form's profile picker, mirrors
// uploadFilteredProfiles exactly.
const sinkFilteredProfiles = $derived.by(() => {
  const q = state.sinkProfileQuery.trim().toLowerCase()
  if (!q) return state.profiles
  return state.profiles.filter((profile) => profile.name.toLowerCase().includes(q))
})

const sinkSelectedProfile = $derived(state.profiles.find((profile) => profile.id === state.sinkSourceProfileId))

// Reused verbatim, not duplicated: sink's connection needs (fork/discovery-
// url/credentials to write into the volume) are identical to upload's, see
// canUploadFrom's own doc comment for the eligibility criterion.
const sinkEligibleInstances = $derived(state.systemState.instances.filter(canUploadFrom))

const sinkResolvedFork = $derived(
  state.sinkSourceKind === 'profile' ? (sinkSelectedProfile?.fork ?? '') : (state.sinkSourceInstance?.fork ?? ''),
)

const sinkNeedsSecret = $derived(
  state.sinkSourceKind === 'profile'
    ? Boolean(sinkSelectedProfile) && (sinkSelectedProfile!.secretRef === 'prompt' || !state.vaultStatus[sinkSelectedProfile!.id])
    : Boolean(state.sinkSourceInstance),
)

// A profile-shaped object purely for COMMAND PREVIEW / argv building, never
// sent anywhere itself (the real start_sink call re-derives its own profile
// server-side via resolve_upload_source_profile), mirrors
// uploadPreviewProfile exactly.
const sinkPreviewProfile = $derived.by((): MountProfile | null => {
  if (state.sinkSourceKind === 'profile') return sinkSelectedProfile ?? null
  const instance = state.sinkSourceInstance
  if (!instance) return null
  return {
    id: 'instance',
    schemaVersion: 1,
    kind: 'mount',
    name: instance.volume || 'Running instance',
    volume: instance.volume,
    fork: instance.fork,
    mountPath: instance.mountPath,
    discoveryUrl: instance.discoveryUrl,
    accessKeyId: instance.accessKeyId,
    secretRef: 'prompt',
    backend: instance.backend,
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  }
})

export function sinkStartParams(): SinkStartParams {
  return {
    variant: state.sinkVariant.trim() || undefined,
    maxLatency: state.sinkMaxLatency.trim() || undefined,
    walMax: state.sinkWalMax.trim() || undefined,
  }
}

const sinkCommandText = $derived.by(() => {
  const profile = sinkPreviewProfile
  if (!profile || !state.sinkStreamUrl.trim() || !state.sinkPath.trim()) return ''
  return `mountos ${buildSinkStartArgv(profile, state.sinkStreamUrl.trim(), state.sinkPath.trim(), sinkStartParams()).join(' ')}`
})

// Sidebar badge count, same lazily-updated convention as
// uploadRunningCount/downloadRunningCount.
const sinkRunningCount = $derived(state.sinks.filter((job) => job.state === 'running').length)

function isCleanlyCompletedSink(job: SinkJob): boolean {
  // 'finished' is `sink finish`'s own terminal state (distinct from
  // 'completed', see querySinkStatus's state machine server-side), just as
  // hideable behind "Show completed" once it carries no haltReason.
  return (job.state === 'completed' || job.state === 'finished') && !job.haltReason
}

const sinkHiddenCompletedCount = $derived(state.sinks.filter(isCleanlyCompletedSink).length)

const SINK_VISIBLE_JOB_CAP = 300

// `sink list` has no stable ordering of its own either (ListJobDirs, same
// caveat as uploadStateRank's own comment), so without this a genuinely
// running job could sort behind an old completed one and get pushed past
// the cap.
export function sinkStateRank(job: SinkJob): number {
  if (job.state === 'running') return 0
  if (job.state === 'halted' || job.state === 'resumable') return 1
  return 2 // completed
}

export function sortSinkJobs(jobs: SinkJob[]): SinkJob[] {
  return [...jobs].sort((a, b) => {
    const rankDiff = sinkStateRank(a) - sinkStateRank(b)
    return rankDiff !== 0 ? rankDiff : (b.createdAt ?? 0) - (a.createdAt ?? 0)
  })
}

const sinkVisibleJobs = $derived.by(() => {
  const base = state.sinkShowCompleted ? state.sinks : state.sinks.filter((job) => !isCleanlyCompletedSink(job))
  const sorted = sortSinkJobs(base)
  return sorted.slice(0, SINK_VISIBLE_JOB_CAP)
})

const sinkVisibleJobsTotal = $derived(
  state.sinkShowCompleted ? state.sinks.length : state.sinks.length - sinkHiddenCompletedCount,
)
const sinkVisibleJobsTruncated = $derived(sinkVisibleJobsTotal > SINK_VISIBLE_JOB_CAP)

// Layers state.settings.featureOverrides over FEATURE_REGISTRY's defaults.
// Anything reading feature visibility (sidebar, Settings list) goes through
// this rather than the registry directly, so an override always wins.
const resolvedFeatures = $derived(resolveFeatures(state.settings.featureOverrides))

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
  get uploadFilteredProfiles() { return uploadFilteredProfiles },
  get uploadSelectedProfile() { return uploadSelectedProfile },
  get uploadEligibleInstances() { return uploadEligibleInstances },
  get uploadResolvedFork() { return uploadResolvedFork },
  get uploadNeedsSecret() { return uploadNeedsSecret },
  get uploadCommandText() { return uploadCommandText },
  get uploadRunningCount() { return uploadRunningCount },
  get cliStatusSummary() { return cliStatusSummary },
  get uploadHiddenCompletedCount() { return uploadHiddenCompletedCount },
  get uploadVisibleJobs() { return uploadVisibleJobs },
  get uploadVisibleJobsTotal() { return uploadVisibleJobsTotal },
  get uploadVisibleJobsTruncated() { return uploadVisibleJobsTruncated },
  get downloadAsOf() { return downloadAsOf },
  get downloadFilteredProfiles() { return downloadFilteredProfiles },
  get downloadSelectedProfile() { return downloadSelectedProfile },
  get downloadEligibleInstances() { return downloadEligibleInstances },
  get downloadResolvedFork() { return downloadResolvedFork },
  get downloadNeedsSecret() { return downloadNeedsSecret },
  get downloadCommandText() { return downloadCommandText },
  get downloadRunningCount() { return downloadRunningCount },
  get downloadHiddenCompletedCount() { return downloadHiddenCompletedCount },
  get downloadVisibleJobs() { return downloadVisibleJobs },
  get downloadVisibleJobsTotal() { return downloadVisibleJobsTotal },
  get downloadVisibleJobsTruncated() { return downloadVisibleJobsTruncated },
  get sinkFilteredProfiles() { return sinkFilteredProfiles },
  get sinkEligibleInstances() { return sinkEligibleInstances },
  get sinkResolvedFork() { return sinkResolvedFork },
  get sinkNeedsSecret() { return sinkNeedsSecret },
  get sinkCommandText() { return sinkCommandText },
  get sinkRunningCount() { return sinkRunningCount },
  get sinkHiddenCompletedCount() { return sinkHiddenCompletedCount },
  get sinkVisibleJobs() { return sinkVisibleJobs },
  get sinkVisibleJobsTotal() { return sinkVisibleJobsTotal },
  get sinkVisibleJobsTruncated() { return sinkVisibleJobsTruncated },
  get backends() { return backends },
  get mountPathError() { return mountPathError },
  get trimmedSecret() { return trimmedSecret },
  get secretLengthError() { return secretLengthError },
  get accessKeyError() { return accessKeyError },
  get volumeNameError() { return volumeNameError },
  get resolvedFeatures() { return resolvedFeatures },
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
// down with it, there is no independent lifecycle to track once the mount
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
// config reveals it, the same detection newProfileFromInstance does at
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

// name generation only runs when the caller doesn't already have one to
// give (duplicateProfile/saveAsProfile always set preset.name): the ??
// short-circuit means the Rust round trip is skipped entirely for those.
export async function newProfile(preset: Partial<MountProfile> = {}) {
  const now = new Date().toISOString()
  const profile: MountProfile = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    kind: 'mount',
    name: preset.name ?? (await randomFriendlyName()),
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
// user retype it. Only the secret cannot come from here (by design, the
// config stores the access key id, which is an identifier, never the secret).
export async function saveAsProfile(instance: MountInstance) {
  const preset: Partial<MountProfile> = {
    name: instance.name || 'External mount',
    volume: instance.name ?? '',
    mountPath: instance.mountPath,
    // viewMode is a comma-joined flag string ("rw", "r", "r,del", ...) from
    // Go's MountMode.String(), never the literal "ro". Comparing against that
    // literal can never match anything the CLI actually emits, which would
    // silently default every saved-as-profile mount to read/write regardless
    // of the source mount's real mode.
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
// to clone that profile instead. The useful move from here is starting a
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

// The profile's primary data mount, if currently mounted, excludes
// satellite view instances (deleted/version/snapshot), same filter as
// canOpenViewsFor. Used to root the version-view file browser at a real,
// live mount path.
export function primaryInstanceForProfile(profileId: string): MountInstance | undefined {
  return state.systemState.instances.find((instance) => instance.profileId === profileId && !viewModeBadge(instance.viewMode))
}

// Broader than primaryInstanceForProfile: any instance tied to this profile,
// including a satellite Deleted/Version/Snapshot/Gateway view, blocks
// deletion, not just the primary data mount. Deleting a profile out from
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
// open_deleted_view_for_instance/open_version_view_for_instance), profile
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

// Pure client-side navigation over the already-fetched fork list, no CLI
// call. `fid: null` returns to the profile's own root ("main").
export function drillIntoFork(fid: number | null) {
  state.forkDrillFid = fid
}

// Enters ForkBrowserView for the given profile, reached from the profile
// editor's "Forks" satellite button. Always available, no settings gate.
export function enterForkBrowser(profile: MountProfile | undefined) {
  if (!profile) return
  state.profileSubView = 'forks'
  state.forkDrillFid = null
  state.forks = []
  state.forkListSecretValue = ''
  state.forkError = ''
}

// Shared "leave whatever sub-view is open" exit for all five (Forks and the
// four former dialogs), one back button/breadcrumb-root action, not five.
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
    // browser state reset by selectProfile) while this request was in flight.
    // A late response must never overwrite the wrong profile's view.
    if (state.selectedProfileId !== targetId) return
    state.forks = result
    state.forkListSecretValue = ''
  } catch (error) {
    if (state.selectedProfileId === targetId) state.forkError = describeError(error)
  } finally {
    // Unconditional: forkBusy gates the buttons for whichever profile is now
    // selected, not just targetId. Leaving it stuck true after a switch
    // would permanently disable the new profile's fork actions.
    state.forkBusy = false
  }
}

// Create/delete/restore below follow the same request/confirm/cancel triple
// as the Snapshot/Deleted/Version/Gateway dialogs (secret-conditional field,
// same convention as mount), "same logic in place" per the profile editor's
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
    // `list --kind upload` itself returns directory-name/hex-hash order,
    // arbitrary with respect to recency (see UploadJob.createdAt's own doc
    // comment). Sort newest-first here so a just-started job lands at the
    // top of the list and becomes the default selection instead of an
    // unrelated older job.
    const jobs = await listUploads()
    jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    state.uploads = jobs
    state.uploadsLastFetchedAt = Date.now()
  } catch (error) {
    state.uploadsError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

// Clears every create-form field back to defaults, called both when
// entering the create sub-view fresh and whenever the source (profile or
// instance) changes, so a value typed against the PREVIOUS source (a
// destination path, a fork-specific include glob) can never be silently
// carried over and submitted against a different volume.
export function resetUploadForm() {
  state.uploadSource = ''
  state.uploadDest = ''
  state.uploadSourceError = ''
  state.uploadDestError = ''
  state.uploadAdvancedOpen = false
  state.uploadOnce = false
  state.uploadOverwrite = false
  state.uploadDryRun = false
  state.uploadRescanInterval = ''
  state.uploadRestart = false
  state.uploadBwlimit = ''
  state.uploadIncludeText = ''
  state.uploadExcludeText = ''
  state.uploadFollowSymlinks = false
  state.uploadCreateSourceDirectory = false
  state.uploadSourceType = 'local'
  clearTransferSourceProfileSelection()
  state.uploadSourceTestBusy = false
  state.uploadSourceTestReport = ''
  state.uploadSourceTestError = ''
  state.uploadStartSecretValue = ''
  state.uploadStartError = ''
  state.uploadBrowseError = ''
  state.uploadDryRunReport = ''
}

export function enterUploadCreate() {
  state.uploadSubView = 'create'
  state.uploadSourceKind = 'profile'
  state.uploadSourceProfileId = selectedProfile?.id ?? appState.profiles[0]?.id ?? null
  state.uploadProfileQuery = ''
  state.uploadSourceInstance = null
  resetUploadForm()
  void loadTransferSourceProfiles()
}

// selectUploadSourceType applies the explicit Local/Object storage toggle.
// Switching away from 'external' clears its form fields (clearTransferSourceProfileSelection)
// so a stale bucket/secret can never linger invisibly and get submitted if
// the user switches back without noticing; switching TO 'external' starts
// from the same blank slate rather than carrying over whatever a prior
// external session had.
export function selectUploadSourceType(value: string) {
  const next = value === 'external' ? 'external' : 'local'
  if (state.uploadSourceType === next) return
  state.uploadSourceType = next
  state.uploadSourceError = ''
  clearTransferSourceProfileSelection()
}

export function exitUploadCreate() {
  state.uploadSubView = 'list'
}

export function selectUploadProfile(profileId: string) {
  if (state.uploadSourceKind === 'profile' && state.uploadSourceProfileId === profileId) return
  state.uploadSourceKind = 'profile'
  state.uploadSourceProfileId = profileId
  state.uploadSourceInstance = null
  resetUploadForm()
}

// Captures the instance's live config once (getInstanceConfig) rather than
// re-reading it on every subsequent Browse/Start. resolve_upload_source_
// profile (Rust) falls back to exactly this cached value if the instance is
// no longer mounted by the time it's actually used.
export async function selectUploadInstance(instance: MountInstance) {
  state.uploadSourceKind = 'instance'
  state.uploadSourceProfileId = null
  resetUploadForm()
  // requestUploadFromInstance jumps straight here, bypassing
  // enterUploadCreate entirely, so the saved-source list would otherwise
  // never load on that entry path and the "Saved source" picker would stay
  // permanently absent even when profiles exist.
  void loadTransferSourceProfiles()
  const backend = instance.backend ?? 'auto'
  state.uploadSourceInstance = { mountPath: instance.mountPath, backend, discoveryUrl: '', fork: '', volume: '', accessKeyId: '' }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (state.uploadSourceInstance?.mountPath !== instance.mountPath) return
    state.uploadSourceInstance = {
      mountPath: instance.mountPath,
      backend,
      discoveryUrl: typeof config.discoveryUrl === 'string' ? config.discoveryUrl : '',
      fork: typeof config.forkName === 'string' ? config.forkName : '',
      volume: typeof config.volumeName === 'string' ? config.volumeName : '',
      accessKeyId: typeof config.accessId === 'string' ? config.accessId : '',
    }
  } catch (error) {
    state.uploadStartError = describeError(error)
  }
}

// Entry point from the Instances view's own per-row action menu, jumps
// straight into the create form with this instance already selected as the
// source, instead of requiring New upload -> Running instance -> find it
// again in the combobox.
export function requestUploadFromInstance(instance: MountInstance) {
  state.view = 'uploads'
  state.uploadSubView = 'create'
  void selectUploadInstance(instance)
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
    // Only meaningful (and only rendered in the form) for a URI Source --
    // isExternalUploadSource gates whether these are ever non-empty in
    // practice, but they're harmless to include unconditionally since
    // buildUploadStartArgv already skips blank values.
    sourceProvider: state.uploadSourceProvider.trim() || undefined,
    sourceEndpoint: state.uploadSourceEndpoint.trim() || undefined,
    sourceRegion: state.uploadSourceRegion.trim() || undefined,
    sourceAccount: state.uploadSourceAccount.trim() || undefined,
    sourceAccessKeyId: state.uploadSourceAccessKeyId.trim() || undefined,
  }
}

// Every glob line entered (include and exclude) must be individually valid,
// not just non-empty, reported against the field it came from so the
// error is actionable.
function uploadGlobError(): string {
  for (const [label, text] of [['Include', state.uploadIncludeText], ['Exclude', state.uploadExcludeText]] as const) {
    for (const line of splitGlobLines(text)) {
      const error = validateGlobPattern(line)
      if (error) return `${label} glob "${line}": ${error}`
    }
  }
  return ''
}

// validateUploadSourceAndSecret is the Source-side validation shared by
// Start and Test Connection. Local mode keeps the existing positional
// check; external mode validates the structured provider/bucket/endpoint/
// account fields (validateExternalSourceFields) plus a secret requirement
// that applies to EVERY external provider, not just gcs -- s3 and azure
// need one exactly as much (objectstore.CreateS3Client/CreateAzureBlobClient,
// mountos-servers, both refuse to build a client with an empty secret); an
// earlier version of this form only gated gcs, which was a real gap.
// Returns an error message, or '' when the source side is valid. Never
// touches uploadDest/uploadDestError -- the caller's own responsibility.
function validateUploadSourceAndSecret(): string {
  if (!isExternalUploadSource()) {
    const source = state.uploadSource.trim()
    return source ? (validateUploadPositional(source, 'Source folder') ?? '') : 'Source folder is required'
  }
  const fieldError = validateExternalSourceFields(
    state.uploadSourceProvider,
    state.uploadSourceBucket,
    state.uploadSourceEndpoint,
    state.uploadSourceAccount,
    state.uploadSourceAccessKeyId,
  )
  if (fieldError) return fieldError
  // A selected "vault" profile needs nothing re-typed -- Rust resolves its
  // secret straight from the keychain (see startUpload's own doc comment).
  // Only when there's no vault backing it does a blank field mean "no
  // secret at all", the same failure an ad hoc unsaved source would have.
  if (!state.uploadSourceSecretValue.trim() && !uploadSourceProfileUsesVault()) {
    return state.uploadSourceProvider.trim() === 'gcs'
      ? 'A service-account key (JSON) is required -- paste its content into the secret field'
      : 'A secret is required'
  }
  return ''
}

export async function runUploadStart() {
  const profileId = state.uploadSourceKind === 'profile' ? (state.uploadSourceProfileId ?? undefined) : undefined
  const instance = state.uploadSourceKind === 'instance' ? (state.uploadSourceInstance ?? undefined) : undefined
  if (!profileId && !instance) return
  const source = effectiveUploadSource()
  const dest = state.uploadDest.trim()
  state.uploadSourceError = validateUploadSourceAndSecret()
  state.uploadDestError = dest ? (validateUploadPositional(dest, 'Destination path') ?? '') : 'Destination path is required'
  if (state.uploadSourceError || state.uploadDestError) return
  const globError = uploadGlobError()
  if (globError) {
    state.uploadStartError = globError
    return
  }
  state.uploadsBusy = true
  state.uploadStartError = ''
  state.uploadDryRunReport = ''
  try {
    const sourceSecret = isExternalUploadSource() ? state.uploadSourceSecretValue.trim() || undefined : undefined
    const transferSourceProfileId = isExternalUploadSource() ? (state.uploadSourceProfileSelectedId ?? undefined) : undefined
    const result = await startUpload(
      profileId,
      instance,
      source,
      dest,
      uploadStartParams(),
      state.uploadStartSecretValue || undefined,
      sourceSecret,
      transferSourceProfileId,
    )
    if (state.uploadDryRun) {
      state.uploadDryRunReport = result
    } else {
      notify(`Upload started: ${source} -> ${dest}`)
      state.uploadSubView = 'list'
      await runUploadList()
    }
  } catch (error) {
    state.uploadStartError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

// runUploadSourceTest is the "Test connection" affordance object storage
// gets in place of a local source's folder Browse: there's no bucket-
// listing UI to browse INTO, so this is the closest equivalent -- runs the
// same --dry-run path Start's own Dry Run checkbox uses (already lists the
// bucket server-side, see runUploadDryRun's doc comment, mountos-servers),
// into its own report/error slots so it never collides with a real Start
// attempt's state.
export async function runUploadSourceTest() {
  const profileId = state.uploadSourceKind === 'profile' ? (state.uploadSourceProfileId ?? undefined) : undefined
  const instance = state.uploadSourceKind === 'instance' ? (state.uploadSourceInstance ?? undefined) : undefined
  if (!profileId && !instance) return
  state.uploadSourceError = validateUploadSourceAndSecret()
  if (state.uploadSourceError) return
  state.uploadSourceTestBusy = true
  state.uploadSourceTestError = ''
  state.uploadSourceTestReport = ''
  try {
    const source = effectiveUploadSource()
    // A dry run needs SOME destination positional (cobra requires 2 args),
    // but Test Connection deliberately doesn't require Destination to be
    // filled in yet -- '/' is a harmless placeholder a dry run never
    // actually writes to regardless of what's passed.
    const dest = state.uploadDest.trim() || '/'
    const result = await startUpload(
      profileId,
      instance,
      source,
      dest,
      { ...uploadStartParams(), dryRun: true },
      state.uploadStartSecretValue || undefined,
      state.uploadSourceSecretValue.trim() || undefined,
      state.uploadSourceProfileSelectedId ?? undefined,
    )
    state.uploadSourceTestReport = result
  } catch (error) {
    state.uploadSourceTestError = describeError(error)
  } finally {
    state.uploadSourceTestBusy = false
  }
}

// loadTransferSourceProfiles fetches the saved list once per view visit
// (mirrors runUploadList's own fetchedOnce gate in UploadsView.svelte,
// called the same way). Best-effort: a failure here just leaves the picker
// showing "no saved sources" rather than blocking the rest of the form.
export async function loadTransferSourceProfiles() {
  try {
    const profiles = await listTransferSourceProfiles()
    profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    state.transferSourceProfiles = profiles
  } catch {
    state.transferSourceProfiles = []
  } finally {
    state.transferSourceProfilesLoaded = true
  }
}

// selectTransferSourceProfile fills the form's structured fields from a
// saved profile. The secret is deliberately NOT populated here even for a
// "vault" profile -- this app never round-trips a decrypted vault secret
// into JS state just to redisplay it; Start/Test instead pass the profile's
// id through (uploadSourceProfileSelectedId) and let Rust resolve it
// directly from the keychain. A "prompt" profile leaves the secret field
// empty and the user re-enters it, same as a MountProfile with secretRef
// "prompt" always has.
export function selectTransferSourceProfile(id: string) {
  const profile = state.transferSourceProfiles.find((p) => p.id === id)
  if (!profile) return
  state.uploadSourceProfileSelectedId = profile.id
  state.uploadSourceProvider = profile.provider
  state.uploadSourceBucket = profile.bucket
  state.uploadSourcePrefix = profile.prefix ?? ''
  state.uploadSourceEndpoint = profile.endpoint ?? ''
  state.uploadSourceRegion = profile.region ?? ''
  state.uploadSourceAccount = profile.account ?? ''
  state.uploadSourceAccessKeyId = profile.accessKeyId ?? ''
  state.uploadSourceSecretValue = ''
  state.uploadSourceError = ''
  state.uploadSourceSaveOpen = false
  // A stale success report from testing a DIFFERENT source must never
  // keep showing once the fields underneath it have changed.
  state.uploadSourceTestReport = ''
  state.uploadSourceTestError = ''
}

// clearTransferSourceProfileSelection resets the external-source form back
// to a blank, unsaved state -- "New source" in the picker, or switching
// Source type away from and back to 'external'.
export function clearTransferSourceProfileSelection() {
  state.uploadSourceProfileSelectedId = null
  state.uploadSourceProvider = ''
  state.uploadSourceBucket = ''
  state.uploadSourcePrefix = ''
  state.uploadSourceEndpoint = ''
  state.uploadSourceRegion = ''
  state.uploadSourceAccount = ''
  state.uploadSourceAccessKeyId = ''
  state.uploadSourceSecretValue = ''
  state.uploadSourceSaveOpen = false
  state.uploadSourceSaveName = ''
  state.uploadSourceSaveError = ''
  state.uploadSourceTestReport = ''
  state.uploadSourceTestError = ''
}

// uploadSourceProfileUsesVault reports whether the currently-selected saved
// profile (if any) keeps its secret in the vault -- gates whether the form
// shows a secret input at all (a vault profile needs none re-entered) vs.
// the "using saved vault credential" indicator.
export function uploadSourceProfileUsesVault(): boolean {
  const id = state.uploadSourceProfileSelectedId
  if (!id) return false
  return state.transferSourceProfiles.find((p) => p.id === id)?.secretRef === 'vault'
}

export function openSaveTransferSourceProfile() {
  const existing = state.transferSourceProfiles.find((p) => p.id === state.uploadSourceProfileSelectedId)
  state.uploadSourceSaveName = existing?.name ?? ''
  state.uploadSourceSaveToVault = true
  state.uploadSourceSaveError = ''
  state.uploadSourceSaveOpen = true
}

export function closeSaveTransferSourceProfile() {
  state.uploadSourceSaveOpen = false
}

// saveCurrentAsTransferSourceProfile persists the form's current structured
// fields (never uploadDest/local-mode fields, which have nothing to do with
// this) as a named, reusable source -- creating a new profile normally, or
// overwriting the currently-selected one if the name matches an existing
// save-in-place flow the same way MountProfile editing does (save_profile
// is itself an upsert keyed by id). storeInVault true additionally calls
// setTransferSourceProfileSecret so next time this profile is selected,
// Start/Test never need the secret re-typed.
export async function saveCurrentAsTransferSourceProfile() {
  const name = state.uploadSourceSaveName.trim()
  if (!name) {
    state.uploadSourceSaveError = 'Name is required'
    return
  }
  const fieldError = validateExternalSourceFields(
    state.uploadSourceProvider,
    state.uploadSourceBucket,
    state.uploadSourceEndpoint,
    state.uploadSourceAccount,
    state.uploadSourceAccessKeyId,
  )
  if (fieldError) {
    state.uploadSourceSaveError = fieldError
    return
  }
  const id = state.uploadSourceProfileSelectedId ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const existing = state.transferSourceProfiles.find((p) => p.id === id)
  const hasExistingVaultSecret = existing?.secretRef === 'vault'
  const typedSecret = state.uploadSourceSecretValue.trim()
  if (state.uploadSourceSaveToVault && !typedSecret && !hasExistingVaultSecret) {
    state.uploadSourceSaveError = 'Enter the secret above before saving it to the vault'
    return
  }
  try {
    // Vault write/delete happens BEFORE the profile record is saved, not
    // after: if it fails, the JSON record must never claim a secretRef the
    // keychain doesn't actually match (a new profile is never created at
    // all in that case; an existing one is left untouched rather than
    // half-updated). Unchecking "Store in vault" for a profile that
    // currently has one is a real downgrade, not a silent no-op: it
    // deletes the vault entry and the saved secretRef flips to "prompt".
    if (state.uploadSourceSaveToVault && typedSecret) {
      await setTransferSourceProfileSecret(id, typedSecret)
    } else if (!state.uploadSourceSaveToVault && hasExistingVaultSecret) {
      await deleteTransferSourceProfileSecret(id)
    }
    const saved = await saveTransferSourceProfile({
      id,
      schemaVersion: 1,
      name,
      provider: state.uploadSourceProvider.trim(),
      bucket: state.uploadSourceBucket.trim(),
      prefix: state.uploadSourcePrefix.trim() || undefined,
      endpoint: state.uploadSourceEndpoint.trim() || undefined,
      region: state.uploadSourceRegion.trim() || undefined,
      account: state.uploadSourceAccount.trim() || undefined,
      accessKeyId: state.uploadSourceAccessKeyId.trim() || undefined,
      secretRef: state.uploadSourceSaveToVault ? 'vault' : 'prompt',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await loadTransferSourceProfiles()
    state.uploadSourceProfileSelectedId = saved.id
    state.uploadSourceSaveOpen = false
    notify(`Saved transfer source "${name}"`)
  } catch (error) {
    state.uploadSourceSaveError = describeError(error)
  }
}

// removeTransferSourceProfile deletes both the saved JSON record and its
// vault entry (delete_transfer_source_profile handles both server-side,
// mirroring deleteProfile's own MountProfile behavior). The SAME profile
// store backs both the upload Source picker and the download Destination
// picker (see TransferSourceProfile's own doc comment), so a deletion
// clears whichever form(s) currently reference it -- either, neither, or
// both, independently -- rather than leaving one with a dangling id.
export async function removeTransferSourceProfile(id: string) {
  // Read before the delete/clear below can null either one out, so a
  // failure lands on whichever view(s) actually had this profile selected,
  // not always the upload view's own error slot regardless of which view
  // the user clicked "Delete" from.
  const inUpload = state.uploadSourceProfileSelectedId === id
  const inDownload = state.downloadDestProfileSelectedId === id
  try {
    await deleteTransferSourceProfile(id)
    await loadTransferSourceProfiles()
    if (inUpload) clearTransferSourceProfileSelection()
    if (inDownload) clearDownloadDestProfileSelection()
  } catch (error) {
    // uploadSourceError/downloadDestError, not the save-panel's own error
    // slot: that panel is normally closed, so an error written there would
    // never actually render for a plain "Delete saved source/destination"
    // click (as opposed to a Save click, which the save panel being open
    // for is a precondition of).
    const message = describeError(error)
    if (inUpload) state.uploadSourceError = message
    if (inDownload) state.downloadDestError = message
  }
}

// selectDownloadDestTransferProfile fills the destination form's structured
// fields from a saved profile, mirrors selectTransferSourceProfile exactly:
// the secret is deliberately NOT populated even for a "vault" profile --
// Start/Test instead pass the profile's id through
// (downloadDestProfileSelectedId) and let Rust resolve it directly from the
// keychain.
export function selectDownloadDestTransferProfile(id: string) {
  const profile = state.transferSourceProfiles.find((p) => p.id === id)
  if (!profile) return
  state.downloadDestProfileSelectedId = profile.id
  state.downloadDestProvider = profile.provider
  state.downloadDestBucket = profile.bucket
  state.downloadDestPrefix = profile.prefix ?? ''
  state.downloadDestEndpoint = profile.endpoint ?? ''
  state.downloadDestRegion = profile.region ?? ''
  state.downloadDestAccount = profile.account ?? ''
  state.downloadDestAccessKeyId = profile.accessKeyId ?? ''
  state.downloadDestSecretValue = ''
  state.downloadDestError = ''
  state.downloadDestSaveOpen = false
  // A stale success report from testing a DIFFERENT destination must
  // never keep showing once the fields underneath it have changed.
  state.downloadDestTestReport = ''
  state.downloadDestTestError = ''
}

// clearDownloadDestProfileSelection resets the external-destination form
// back to a blank, unsaved state, mirrors clearTransferSourceProfileSelection.
export function clearDownloadDestProfileSelection() {
  state.downloadDestProfileSelectedId = null
  state.downloadDestProvider = ''
  state.downloadDestBucket = ''
  state.downloadDestPrefix = ''
  state.downloadDestEndpoint = ''
  state.downloadDestRegion = ''
  state.downloadDestAccount = ''
  state.downloadDestAccessKeyId = ''
  state.downloadDestSecretValue = ''
  state.downloadDestSaveOpen = false
  state.downloadDestSaveName = ''
  state.downloadDestSaveError = ''
  state.downloadDestTestReport = ''
  state.downloadDestTestError = ''
}

// downloadDestProfileUsesVault mirrors uploadSourceProfileUsesVault exactly.
export function downloadDestProfileUsesVault(): boolean {
  const id = state.downloadDestProfileSelectedId
  if (!id) return false
  return state.transferSourceProfiles.find((p) => p.id === id)?.secretRef === 'vault'
}

export function openSaveDownloadDestTransferProfile() {
  const existing = state.transferSourceProfiles.find((p) => p.id === state.downloadDestProfileSelectedId)
  state.downloadDestSaveName = existing?.name ?? ''
  state.downloadDestSaveToVault = true
  state.downloadDestSaveError = ''
  state.downloadDestSaveOpen = true
}

export function closeSaveDownloadDestTransferProfile() {
  state.downloadDestSaveOpen = false
}

// saveDownloadDestAsTransferProfile persists the destination form's current
// structured fields as a named, reusable transfer profile, mirrors
// saveCurrentAsTransferSourceProfile exactly on the opposite positional --
// same upsert-by-id/vault-storage/secretRef-preservation behavior, into the
// same shared profile store.
export async function saveDownloadDestAsTransferProfile() {
  const name = state.downloadDestSaveName.trim()
  if (!name) {
    state.downloadDestSaveError = 'Name is required'
    return
  }
  const fieldError = validateExternalSourceFields(
    state.downloadDestProvider,
    state.downloadDestBucket,
    state.downloadDestEndpoint,
    state.downloadDestAccount,
    state.downloadDestAccessKeyId,
  )
  if (fieldError) {
    state.downloadDestSaveError = fieldError
    return
  }
  const storeInVault = state.downloadDestSaveToVault && Boolean(state.downloadDestSecretValue.trim())
  if (state.downloadDestSaveToVault && !state.downloadDestSecretValue.trim() && !state.downloadDestProfileSelectedId) {
    state.downloadDestSaveError = 'Enter the secret above before saving it to the vault'
    return
  }
  const id = state.downloadDestProfileSelectedId ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const existing = state.transferSourceProfiles.find((p) => p.id === id)
  try {
    // Vault write happens BEFORE the profile record is saved, mirrors
    // saveCurrentAsTransferSourceProfile's own ordering fix: a failed
    // keychain write must never leave a JSON record claiming secretRef
    // "vault" for an entry that doesn't actually exist.
    if (storeInVault) {
      await setTransferSourceProfileSecret(id, state.downloadDestSecretValue.trim())
    }
    const saved = await saveTransferSourceProfile({
      id,
      schemaVersion: 1,
      name,
      provider: state.downloadDestProvider.trim(),
      bucket: state.downloadDestBucket.trim(),
      prefix: state.downloadDestPrefix.trim() || undefined,
      endpoint: state.downloadDestEndpoint.trim() || undefined,
      region: state.downloadDestRegion.trim() || undefined,
      account: state.downloadDestAccount.trim() || undefined,
      accessKeyId: state.downloadDestAccessKeyId.trim() || undefined,
      secretRef: storeInVault || existing?.secretRef === 'vault' ? 'vault' : 'prompt',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    await loadTransferSourceProfiles()
    state.downloadDestProfileSelectedId = saved.id
    state.downloadDestSaveOpen = false
    notify(`Saved transfer source "${name}"`)
  } catch (error) {
    state.downloadDestSaveError = describeError(error)
  }
}

// Opens the shared secret-prompt dialog for a scratch-mount Browse flow.
// Mirrors runMount's own prompt setup, but the resume action is generic
// (onSecretKnown) instead of the hardcoded doMount. The dialog closes
// first (mirroring doMount's own success path), then onSecretKnown runs;
// any error from it lands back in secretError so the dialog reopens with
// the failure shown rather than silently vanishing.
function openSecretPrompt(profile: MountProfile, onSecretKnown: (secret: string) => Promise<void>) {
  state.secretPromptFor = profile.id
  state.secretValue = ''
  state.secretError = ''
  state.savePromptedSecret = profile.secretRef === 'vault'
  state.secretPromptResume = async (secret: string) => {
    state.busy = true
    try {
      if (state.savePromptedSecret) {
        await setProfileSecret(profile.id, secret)
        state.profiles = state.profiles.map((candidate) => (candidate.id === profile.id ? { ...candidate, secretRef: 'vault' } : candidate))
        state.vaultStatus = { ...state.vaultStatus, [profile.id]: true }
      }
      state.secretPromptFor = null
      state.secretValue = ''
      state.secretError = ''
      state.secretPromptResume = null
      await onSecretKnown(secret)
    } catch (error) {
      state.secretError = describeError(error)
    } finally {
      state.busy = false
    }
  }
}

// Proactive secret check for every scratch-mount Browse flow (the pattern
// runMount already uses for the real mount action, applied here too instead
// of attempting the mount and parsing "secret required" out of a generic
// error string). When a secret is already typed in the form, or the vault
// already has one, this is a no-op and the caller proceeds immediately.
// Otherwise it opens the prompt, writes the entered secret into secretField
// (the SAME field Start/Confirm reads, so it survives past this one
// browse), and re-invokes retry (the caller's own function), now that the
// field is populated and this check passes on the second call.
async function ensureBrowseSecret(
  profileId: string,
  secretField: 'uploadStartSecretValue' | 'downloadStartSecretValue',
  retry: () => Promise<void>,
): Promise<boolean> {
  if (state[secretField]) return true
  const profile = state.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return true
  const stored = profile.secretRef === 'vault' ? (await getProfileSecretStatus(profile.id)).stored : false
  if (profile.secretRef !== 'prompt' && stored) return true
  openSecretPrompt(profile, async (secret) => {
    state[secretField] = secret
    await retry()
  })
  return false
}

// Destination Browse has no "list a remote directory" RPC to call. It
// mounts the source's volume read-only at a throwaway scratch path
// (ensureUploadBrowseMount) and hands that local path to the native folder
// picker, then translates the picked local path back into a mountOS-
// relative destination. The secret typed here is the SAME field Start
// uses (and vice versa): entering it once during a browse must not
// require re-entering it again to actually start the job.
export async function browseUploadDestination() {
  const profileId = state.uploadSourceKind === 'profile' ? (state.uploadSourceProfileId ?? undefined) : undefined
  const instance = state.uploadSourceKind === 'instance' ? (state.uploadSourceInstance ?? undefined) : undefined
  if (!profileId && !instance) return
  state.uploadsBusy = true
  state.uploadBrowseError = ''
  try {
    if (profileId && !(await ensureBrowseSecret(profileId, 'uploadStartSecretValue', browseUploadDestination))) return
    const mountPath = await ensureUploadBrowseMount(profileId, instance, state.uploadStartSecretValue || undefined)
    const chosen = await browseFolder('Choose destination folder', mountPath)
    if (!chosen) return
    const normalized = chosen.replace(/\/+$/, '')
    const root = mountPath.replace(/\/+$/, '')
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      // The native picker isn't sandboxed to the scratch mount. A pick
      // outside it (root re-navigated away from) is a local filesystem
      // path, not a mountOS-relative one, and must never be accepted as
      // the destination as-is.
      state.uploadDestError = 'Choose a folder inside the browsed volume'
      return
    }
    const relative = normalized === root ? '' : normalized.slice(root.length)
    state.uploadDest = relative || '/'
    state.uploadDestError = ''
  } catch (error) {
    state.uploadBrowseError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export function requestUploadResume(job: UploadJob) {
  state.uploadResumePromptFor = job
  state.uploadSubView = 'resume'
  // Best-effort convenience default, not a requirement. The Uploads list
  // is cross-profile, so the job being resumed may have nothing to do with
  // whatever's selected on the Profiles page (or there may be no profiles
  // at all). Both fields stay editable regardless.
  state.uploadResumeDiscoveryUrl = selectedProfile?.discoveryUrl ?? ''
  state.uploadResumeAccessKeyId = selectedProfile?.accessKeyId ?? ''
  state.uploadResumeOnce = false
  state.uploadResumeRescanInterval = ''
  state.uploadResumeSecretValue = ''
  state.uploadResumeError = ''
}

export function cancelUploadResume() {
  state.uploadResumePromptFor = null
  state.uploadResumeSecretValue = ''
  state.uploadSubView = 'list'
}

export async function confirmUploadResume() {
  const job = state.uploadResumePromptFor
  if (!job) return
  const discoveryUrl = state.uploadResumeDiscoveryUrl.trim()
  const accessKeyId = state.uploadResumeAccessKeyId.trim()
  if (!discoveryUrl || !accessKeyId) {
    state.uploadResumeError = !discoveryUrl ? 'Discovery URL is required' : 'Access key ID is required'
    return
  }
  state.uploadsBusy = true
  state.uploadResumeError = ''
  try {
    await resumeUpload(
      discoveryUrl,
      accessKeyId,
      job.jobId,
      state.uploadResumeOnce,
      state.uploadResumeRescanInterval.trim() || undefined,
      state.uploadResumeSecretValue || undefined,
    )
    state.uploadResumePromptFor = null
    state.uploadResumeSecretValue = ''
    state.uploadSubView = 'list'
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

// Marks an already-drained resumable job (0 pending, 0 uploading) completed
// without reconnecting, see cmd_upload_subcommands.go's `upload finish`
// doc comment. Only ever offered when isFinishable already confirms the job
// qualifies, but the CLI re-checks anyway and refuses otherwise.
export async function runUploadFinish(job: UploadJob) {
  state.uploadsBusy = true
  state.uploadsError = ''
  try {
    await finishUpload(job.jobId)
    notify(`${job.jobId} marked completed`)
    await runUploadList()
  } catch (error) {
    state.uploadsError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export async function openUploadJobLog(job: UploadJob) {
  if (!job.logPath) return
  try {
    await openUploadLog(job.logPath)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Could not open the log file', 'error')
  }
}

export async function copyUploadJobLogPath(job: UploadJob) {
  if (!job.logPath) return
  try {
    await navigator.clipboard.writeText(job.logPath)
    notify('Log path copied')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to copy log path', 'error')
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

// Remove is prune's single-job sibling: the only way to clear a job stuck
// resumable because its process was killed before it could stamp a
// terminal field, since cancel refuses it (no live process) and prune
// skips it (no terminal stamp). Permanent and irreversible like prune, so
// it gets the same confirm-dialog treatment rather than running directly
// from a row button.
export function requestUploadRemove(job: UploadJob) {
  state.uploadRemovePromptFor = job
  state.uploadRemoveError = ''
}

export function cancelUploadRemove() {
  state.uploadRemovePromptFor = null
}

export async function confirmUploadRemove() {
  const job = state.uploadRemovePromptFor
  if (!job) return
  state.uploadsBusy = true
  state.uploadRemoveError = ''
  try {
    await removeUpload(job.jobId)
    state.uploadRemovePromptFor = null
    notify(`Upload job ${job.jobId} removed`)
    await runUploadList()
  } catch (error) {
    state.uploadRemoveError = describeError(error)
  } finally {
    state.uploadsBusy = false
  }
}

export async function runDownloadList() {
  state.downloadsBusy = true
  state.downloadsError = ''
  try {
    // Same "list --kind X returns directory-name/hex-hash order" caveat as
    // runUploadList. Sort newest-first so a just-started job lands at the
    // top and becomes the default selection.
    const jobs = await listDownloads()
    jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    state.downloads = jobs
    state.downloadsLastFetchedAt = Date.now()
  } catch (error) {
    state.downloadsError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// Clears every create-form field back to defaults, called both when
// entering the create sub-view fresh and whenever the source changes, same
// reasoning as resetUploadForm.
export function resetDownloadForm() {
  state.downloadSource = ''
  state.downloadDest = ''
  state.downloadSourceError = ''
  state.downloadDestError = ''
  state.downloadIfExists = 'skip'
  state.downloadDepth = '1'
  state.downloadAsOfLocal = ''
  state.downloadAdvancedOpen = false
  state.downloadDryRun = false
  state.downloadRestart = false
  state.downloadBwlimit = ''
  state.downloadIncludeText = ''
  state.downloadExcludeText = ''
  state.downloadFollowSymlinks = false
  state.downloadCreateSourceDirectory = false
  state.downloadDestType = 'local'
  clearDownloadDestProfileSelection()
  state.downloadDestTestBusy = false
  state.downloadDestTestReport = ''
  state.downloadDestTestError = ''
  state.downloadStartSecretValue = ''
  state.downloadStartError = ''
  state.downloadBrowseError = ''
  state.downloadDryRunReport = ''
}

// Defaults to 'instance' (no credentials, simplest first click) rather than
// uploadSourceKind's 'profile' default, there is no equivalent "usually
// has a saved profile ready" bias here, and an already-mounted instance is
// the lower-friction starting point when one exists.
export function enterDownloadCreate() {
  state.downloadSubView = 'create'
  state.downloadSourceKind = 'instance'
  state.downloadSourceProfileId = null
  state.downloadProfileQuery = ''
  state.downloadSourceInstance = null
  resetDownloadForm()
  void loadTransferSourceProfiles()
}

// selectDownloadDestType applies the explicit Local/Object storage toggle
// for DEST_PATH, mirrors selectUploadSourceType exactly on the opposite
// positional. Switching away from 'external' clears its form fields
// (clearDownloadDestProfileSelection) so a stale bucket/secret can never
// linger invisibly and get submitted if the user flips back to 'local' and
// then back to 'external' again.
export function selectDownloadDestType(value: string) {
  const next = value === 'external' ? 'external' : 'local'
  if (state.downloadDestType === next) return
  state.downloadDestType = next
  state.downloadDestError = ''
  clearDownloadDestProfileSelection()
}

export function exitDownloadCreate() {
  state.downloadSubView = 'list'
}

export function selectDownloadProfile(profileId: string) {
  if (state.downloadSourceKind === 'profile' && state.downloadSourceProfileId === profileId) return
  state.downloadSourceKind = 'profile'
  state.downloadSourceProfileId = profileId
  state.downloadSourceInstance = null
  resetDownloadForm()
}

// Captures the instance's live config once (getInstanceConfig), same
// one-shot pattern as selectUploadInstance, purely for display (fork
// badge, browse root) here, since start_download's Instance branch never
// reads discoveryUrl/fork/volume/accessKeyId at all (mountPath is the only
// thing that matters for mode A).
export async function selectDownloadInstance(instance: MountInstance) {
  state.downloadSourceKind = 'instance'
  state.downloadSourceProfileId = null
  resetDownloadForm()
  // requestDownloadFromInstance jumps straight here, bypassing
  // enterDownloadCreate entirely, so the saved-destination list would
  // otherwise never load on that entry path, mirrors selectUploadInstance's
  // own fix.
  void loadTransferSourceProfiles()
  const backend = instance.backend ?? 'auto'
  state.downloadSourceInstance = { mountPath: instance.mountPath, backend, discoveryUrl: '', fork: '', volume: '', accessKeyId: '' }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (state.downloadSourceInstance?.mountPath !== instance.mountPath) return
    state.downloadSourceInstance = {
      mountPath: instance.mountPath,
      backend,
      discoveryUrl: typeof config.discoveryUrl === 'string' ? config.discoveryUrl : '',
      fork: typeof config.forkName === 'string' ? config.forkName : '',
      volume: typeof config.volumeName === 'string' ? config.volumeName : '',
      accessKeyId: typeof config.accessId === 'string' ? config.accessId : '',
    }
  } catch (error) {
    state.downloadStartError = describeError(error)
  }
}

// Entry point from the Instances view's own per-row action menu, mirrors
// requestUploadFromInstance.
export function requestDownloadFromInstance(instance: MountInstance) {
  state.view = 'downloads'
  state.downloadSubView = 'create'
  void selectDownloadInstance(instance)
}

export function downloadStartParams(): DownloadStartParams {
  const bwlimit = Number.parseInt(state.downloadBwlimit, 10)
  const depth = Number.parseInt(state.downloadDepth, 10)
  return {
    ifExists: state.downloadIfExists,
    depth: Number.isFinite(depth) && depth >= 0 ? depth : 1,
    asOf: state.downloadSourceKind === 'profile' ? downloadAsOf.trim() || undefined : undefined,
    dryRun: state.downloadDryRun,
    restart: state.downloadRestart,
    bwlimitMbps: Number.isFinite(bwlimit) && bwlimit > 0 ? bwlimit : undefined,
    includeGlobs: splitGlobLines(state.downloadIncludeText),
    excludeGlobs: splitGlobLines(state.downloadExcludeText),
    followSymlinks: state.downloadFollowSymlinks,
    createSourceDirectory: state.downloadCreateSourceDirectory,
    // Only meaningful (and only rendered in the form) for a URI DEST_PATH --
    // isExternalDownloadDest gates whether these are ever non-empty in
    // practice, but they're harmless to include unconditionally since
    // buildDownloadStartArgv already skips blank values.
    destProvider: state.downloadDestProvider.trim() || undefined,
    destEndpoint: state.downloadDestEndpoint.trim() || undefined,
    destRegion: state.downloadDestRegion.trim() || undefined,
    destAccount: state.downloadDestAccount.trim() || undefined,
    destAccessKeyId: state.downloadDestAccessKeyId.trim() || undefined,
  }
}

// Every glob line entered (include and exclude) must be individually valid,
// mirrors uploadGlobError.
function downloadGlobError(): string {
  for (const [label, text] of [['Include', state.downloadIncludeText], ['Exclude', state.downloadExcludeText]] as const) {
    for (const line of splitGlobLines(text)) {
      const error = validateGlobPattern(line)
      if (error) return `${label} glob "${line}": ${error}`
    }
  }
  return ''
}

// validateDownloadDestAndSecret is the Destination-side validation shared
// by Start and Test Connection, mirrors validateUploadSourceAndSecret
// exactly on the opposite positional: local mode keeps the existing
// positional check; external mode validates the structured provider/
// bucket/endpoint/account fields plus a secret requirement that applies to
// every external provider. Never touches downloadSource/downloadSourceError
// -- the caller's own responsibility.
function validateDownloadDestAndSecret(): string {
  if (!isExternalDownloadDest()) {
    const dest = state.downloadDest.trim()
    return dest ? (validateUploadPositional(dest, 'Destination folder') ?? '') : 'Destination folder is required'
  }
  const fieldError = validateExternalSourceFields(
    state.downloadDestProvider,
    state.downloadDestBucket,
    state.downloadDestEndpoint,
    state.downloadDestAccount,
    state.downloadDestAccessKeyId,
  )
  if (fieldError) return fieldError
  // A selected "vault" profile needs nothing re-typed -- Rust resolves its
  // secret straight from the keychain (see startDownload's own doc comment).
  if (!state.downloadDestSecretValue.trim() && !downloadDestProfileUsesVault()) {
    return state.downloadDestProvider.trim() === 'gcs'
      ? 'A service-account key (JSON) is required -- paste its content into the secret field'
      : 'A secret is required'
  }
  return ''
}

export async function runDownloadStart() {
  const profileId = state.downloadSourceKind === 'profile' ? (state.downloadSourceProfileId ?? undefined) : undefined
  if (state.downloadSourceKind === 'profile' && !profileId) return
  const source = state.downloadSource.trim()
  const dest = effectiveDownloadDest()
  state.downloadSourceError = source ? (validateUploadPositional(source, 'Source path') ?? '') : 'Source path is required'
  state.downloadDestError = validateDownloadDestAndSecret()
  if (state.downloadSourceError || state.downloadDestError) return
  const globError = downloadGlobError()
  if (globError) {
    state.downloadStartError = globError
    return
  }
  state.downloadsBusy = true
  state.downloadStartError = ''
  state.downloadDryRunReport = ''
  try {
    const destSecret = isExternalDownloadDest() ? state.downloadDestSecretValue.trim() || undefined : undefined
    const transferDestProfileId = isExternalDownloadDest() ? (state.downloadDestProfileSelectedId ?? undefined) : undefined
    const result = await startDownload(
      state.downloadSourceKind,
      profileId,
      source,
      dest,
      downloadStartParams(),
      state.downloadStartSecretValue || undefined,
      destSecret,
      transferDestProfileId,
    )
    if (state.downloadDryRun) {
      state.downloadDryRunReport = result
    } else {
      notify(`Download started: ${source} -> ${dest}`)
      state.downloadSubView = 'list'
      await runDownloadList()
    }
  } catch (error) {
    state.downloadStartError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// runDownloadDestTest is the export mirror of runUploadSourceTest: the
// "Test connection" affordance for an external destination. Unlike
// upload's Test Connection (which can submit a harmless '/' placeholder
// DEST_PATH, since a URI SOURCE dry-run never reads it), a download's
// dry-run genuinely walks/discovers SOURCE too (runDownloadDryRun,
// cmd_download.go), so this requires a real, already-valid Source exactly
// like a real Start does -- there is no meaningful way to test "can I reach
// this bucket" independent of a real source to report a plan against.
export async function runDownloadDestTest() {
  const profileId = state.downloadSourceKind === 'profile' ? (state.downloadSourceProfileId ?? undefined) : undefined
  if (state.downloadSourceKind === 'profile' && !profileId) return
  const source = state.downloadSource.trim()
  state.downloadSourceError = source ? (validateUploadPositional(source, 'Source path') ?? '') : 'Source path is required'
  state.downloadDestError = validateDownloadDestAndSecret()
  if (state.downloadSourceError || state.downloadDestError) return
  state.downloadDestTestBusy = true
  state.downloadDestTestError = ''
  state.downloadDestTestReport = ''
  try {
    const dest = effectiveDownloadDest()
    const result = await startDownload(
      state.downloadSourceKind,
      profileId,
      source,
      dest,
      { ...downloadStartParams(), dryRun: true },
      state.downloadStartSecretValue || undefined,
      state.downloadDestSecretValue.trim() || undefined,
      state.downloadDestProfileSelectedId ?? undefined,
    )
    state.downloadDestTestReport = result
  } catch (error) {
    state.downloadDestTestError = describeError(error)
  } finally {
    state.downloadDestTestBusy = false
  }
}

// Mode A: browses directly at the already-live instance's own mount path,
// no scratch mount involved, mirrors the pickVersionFile-rooted-at-mountPath
// pattern used elsewhere for a live instance. The chosen absolute local path
// is used as-is for `downloadSource`, unlike a mountOS destination, mode
// A's SOURCE positional wants a literal local path, not a mountOS-relative
// one (see buildDownloadStartArgv's sourceKind doc comment).
async function browseDownloadSourceFromInstance() {
  const instance = state.downloadSourceInstance
  if (!instance) return
  const chosen = await browseFolder('Choose a folder to download from', instance.mountPath)
  if (chosen) {
    state.downloadSource = chosen
    state.downloadSourceError = ''
  }
}

// Mode B has no "list a remote directory" RPC either, same as
// browseUploadDestination, it mounts the source's volume read-only at a
// throwaway scratch path (ensureDownloadBrowseMount) and hands that local
// path to the native folder picker, then translates the picked local path
// back into a mountOS-relative source. AsOf-aware: passing a non-empty AsOf
// roots the scratch mount at that historical snapshot instead of the fork's
// live state, so Browse always reflects exactly what the download will read.
async function browseDownloadSourceFromProfile() {
  const profileId = state.downloadSourceProfileId
  if (!profileId) return
  state.downloadsBusy = true
  state.downloadBrowseError = ''
  try {
    if (!(await ensureBrowseSecret(profileId, 'downloadStartSecretValue', browseDownloadSourceFromProfile))) return
    const mountPath = await ensureDownloadBrowseMount(profileId, downloadAsOf.trim() || undefined, state.downloadStartSecretValue || undefined)
    const chosen = await browseFolder('Choose a folder to download from', mountPath)
    if (!chosen) return
    const normalized = chosen.replace(/\/+$/, '')
    const root = mountPath.replace(/\/+$/, '')
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      state.downloadSourceError = 'Choose a folder inside the browsed volume'
      return
    }
    const relative = normalized === root ? '' : normalized.slice(root.length)
    state.downloadSource = relative || '/'
    state.downloadSourceError = ''
  } catch (error) {
    state.downloadBrowseError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

export async function browseDownloadSource() {
  if (state.downloadSourceKind === 'instance') {
    await browseDownloadSourceFromInstance()
  } else {
    await browseDownloadSourceFromProfile()
  }
}

// Only meaningful in 'local' mode (an external DEST_PATH has no local
// folder to browse into, see isExternalDownloadDest -- the view itself
// hides this button in that mode). Mirrors browseUploadSource's simple
// shape, not browseUploadDestination's scratch-mount complexity (there's
// no remote destination to browse into for a download's local mode
// either).
export async function browseDownloadDestination() {
  const chosen = await browseFolder('Choose a destination folder')
  if (chosen) state.downloadDest = chosen
}

export function requestDownloadResume(job: DownloadJob) {
  state.downloadResumePromptFor = job
  state.downloadSubView = 'resume'
  state.downloadResumeDiscoveryUrl = selectedProfile?.discoveryUrl ?? ''
  state.downloadResumeAccessKeyId = selectedProfile?.accessKeyId ?? ''
  state.downloadResumeSecretValue = ''
  state.downloadResumeError = ''
}

export function cancelDownloadResume() {
  state.downloadResumePromptFor = null
  state.downloadResumeSecretValue = ''
  state.downloadSubView = 'list'
}

export async function confirmDownloadResume() {
  const job = state.downloadResumePromptFor
  if (!job) return
  const discoveryUrl = state.downloadResumeDiscoveryUrl.trim()
  const accessKeyId = state.downloadResumeAccessKeyId.trim()
  // Unlike confirmUploadResume (every upload job needs dest credentials
  // regardless of source mode), a mode-A download job resumes with BOTH left
  // blank (no credentials at all), so only reject a PARTIAL fill, not an
  // empty one.
  if ((discoveryUrl || accessKeyId) && (!discoveryUrl || !accessKeyId)) {
    state.downloadResumeError = !discoveryUrl ? 'Discovery URL is required' : 'Access key ID is required'
    return
  }
  state.downloadsBusy = true
  state.downloadResumeError = ''
  try {
    await resumeDownload(discoveryUrl, accessKeyId, job.jobId, state.downloadResumeSecretValue || undefined)
    state.downloadResumePromptFor = null
    state.downloadResumeSecretValue = ''
    state.downloadSubView = 'list'
    notify(`Download job ${job.jobId} resumed`)
    await runDownloadList()
  } catch (error) {
    state.downloadResumeError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// Cancel/retry-failed are non-destructive (the job stays resumable), same
// reasoning as the upload equivalents, run directly from a row button.

export async function runDownloadCancel(job: DownloadJob) {
  state.downloadsBusy = true
  state.downloadsError = ''
  try {
    await cancelDownload(job.jobId)
    notify(`Download job ${job.jobId} cancelled`)
    await runDownloadList()
  } catch (error) {
    state.downloadsError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

export async function runDownloadRetryFailed(job: DownloadJob) {
  state.downloadsBusy = true
  state.downloadsError = ''
  try {
    await retryFailedDownload(job.jobId)
    notify(`Retrying failed paths for ${job.jobId}`)
    await runDownloadList()
  } catch (error) {
    state.downloadsError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// Marks an already-drained resumable job (0 pending, 0 downloading)
// completed without reconnecting, mirrors runUploadFinish, see its own
// comment for the full reasoning.
export async function runDownloadFinish(job: DownloadJob) {
  state.downloadsBusy = true
  state.downloadsError = ''
  try {
    await finishDownload(job.jobId)
    notify(`${job.jobId} marked completed`)
    await runDownloadList()
  } catch (error) {
    state.downloadsError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

export async function openDownloadJobLog(job: DownloadJob) {
  if (!job.logPath) return
  try {
    await openDownloadLog(job.logPath)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Could not open the log file', 'error')
  }
}

export async function copyDownloadJobLogPath(job: DownloadJob) {
  if (!job.logPath) return
  try {
    await navigator.clipboard.writeText(job.logPath)
    notify('Log path copied')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to copy log path', 'error')
  }
}

export function requestDownloadPrune() {
  state.downloadPrunePromptOpen = true
  state.downloadPruneKeep = '0'
  state.downloadPruneError = ''
}

export function cancelDownloadPrune() {
  state.downloadPrunePromptOpen = false
}

export async function confirmDownloadPrune() {
  const keep = Number.parseInt(state.downloadPruneKeep, 10)
  state.downloadsBusy = true
  state.downloadPruneError = ''
  try {
    await pruneDownloads(Number.isFinite(keep) && keep > 0 ? keep : 0)
    state.downloadPrunePromptOpen = false
    notify('Completed/halted download jobs pruned')
    await runDownloadList()
  } catch (error) {
    state.downloadPruneError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// Remove is prune's single-job sibling, same reasoning as
// requestUploadRemove above.
export function requestDownloadRemove(job: DownloadJob) {
  state.downloadRemovePromptFor = job
  state.downloadRemoveError = ''
}

export function cancelDownloadRemove() {
  state.downloadRemovePromptFor = null
}

export async function confirmDownloadRemove() {
  const job = state.downloadRemovePromptFor
  if (!job) return
  state.downloadsBusy = true
  state.downloadRemoveError = ''
  try {
    await removeDownload(job.jobId)
    state.downloadRemovePromptFor = null
    notify(`Download job ${job.jobId} removed`)
    await runDownloadList()
  } catch (error) {
    state.downloadRemoveError = describeError(error)
  } finally {
    state.downloadsBusy = false
  }
}

// Sink (Media ingest): list is authoritative (fetched from `mountos sink
// list --json`, same "list is authoritative" pattern as runUploadList),
// while start/resume are session-local launches that re-fetch the list
// afterward rather than threading a job id back through the launch result.

// Bumped by runSinkList so an in-flight runSinkStatus can detect that its
// result raced a list refresh and must not write a snapshot back over the
// invalidated map (see runSinkStatus).
let sinkListGeneration = 0

export async function runSinkList() {
  state.sinksBusy = true
  state.sinksError = ''
  sinkListGeneration++
  try {
    // `sink list` has no stable ordering of its own either, same caveat as
    // runUploadList's own comment. Sort newest-first so a just-started job
    // lands at the top and becomes the default selection.
    const jobs = await listSinks()
    jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    state.sinks = jobs
    state.sinksLastFetchedAt = Date.now()
    // A fresh list pass invalidates any cached per-job snapshot: a job that
    // was running may have halted/completed since, and a stale "running"
    // snapshot must never outlive the list refresh that would have shown
    // otherwise.
    state.sinkStatusByJobId = {}
  } catch (error) {
    state.sinksError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

// The fuller single-job rate/lag snapshot, fetched on demand for whichever
// job is currently selected, then kept fresh by SinkView's own bounded poll
// while that job is running (unlike uploads/downloads, whose rows are
// completion counts, not a liveness reading, so they never auto-refresh).
// Silently no-ops on failure rather than surfacing a separate error: the
// list-derived summary (lag/wal/discontinuities) already covers the job's
// health, this only enriches the detail pane with segmentsCommitted/
// fileSize/bitrateObserved/lastCommitAt/lastSegmentAt.
export async function runSinkStatus(jobId: string) {
  if (state.sinkStatusByJobId[jobId]) return
  const generation = sinkListGeneration
  try {
    const status = await getSinkStatus(jobId)
    // A list refresh cleared the map while this was in flight; writing
    // back now would resurrect a snapshot the refresh just invalidated.
    if (generation !== sinkListGeneration) return
    state.sinkStatusByJobId = { ...state.sinkStatusByJobId, [jobId]: status }
  } catch {
    // No error surfaced, see doc comment above.
  }
}

// Stale-while-revalidate pair for SinkView's detail snapshot. runSinkList
// clears sinkStatusByJobId on every list refresh (a job's state may have
// changed since), so the live snapshot is briefly undefined each poll tick
// while runSinkStatus refetches it. Rendering "Not available" for that gap
// is misleading for a job that already has a known reading, so SinkView
// keeps its own per-job cache: withSinkSnapshotCached folds a fresh live
// snapshot into it, sinkDisplaySnapshot prefers the live value and falls
// back to the cached one, but only while jobRunning, i.e. only across the
// sub-second gap runSinkList's own clear creates for a job that is still
// actually running. Once a job stops for good (halted/completed/finished/
// resumable, including a SIGKILLed daemon that never got to cache final
// counters), live goes to undefined permanently, not just for one poll
// tick, and falling back would freeze the pane on a stale live reading
// forever with no staleness marker, so the freshly resolved status (nil
// snapshot, or a cached one tagged lastKnown) must win instead.
export function withSinkSnapshotCached(
  cache: Record<string, SinkSnapshot>,
  jobId: string | null | undefined,
  live: SinkSnapshot | undefined,
): Record<string, SinkSnapshot> {
  if (!jobId || !live || cache[jobId] === live) return cache
  return { ...cache, [jobId]: live }
}

export function sinkDisplaySnapshot(
  cache: Record<string, SinkSnapshot>,
  jobId: string | null | undefined,
  live: SinkSnapshot | undefined,
  jobRunning: boolean,
): SinkSnapshot | undefined {
  if (live) return live
  if (!jobRunning || !jobId) return undefined
  return cache[jobId]
}

export function resetSinkForm() {
  state.sinkStreamUrl = ''
  state.sinkPath = ''
  state.sinkStreamUrlError = ''
  state.sinkPathError = ''
  state.sinkAdvancedOpen = false
  state.sinkVariant = ''
  state.sinkMaxLatency = ''
  state.sinkWalMax = ''
  state.sinkStartSecretValue = ''
  state.sinkStartError = ''
}

export function enterSinkCreate() {
  state.sinkSubView = 'create'
  state.sinkSourceKind = 'profile'
  state.sinkSourceProfileId = selectedProfile?.id ?? appState.profiles[0]?.id ?? null
  state.sinkProfileQuery = ''
  state.sinkSourceInstance = null
  resetSinkForm()
}

export function exitSinkCreate() {
  state.sinkSubView = 'list'
}

export function selectSinkProfile(profileId: string) {
  if (state.sinkSourceKind === 'profile' && state.sinkSourceProfileId === profileId) return
  state.sinkSourceKind = 'profile'
  state.sinkSourceProfileId = profileId
  state.sinkSourceInstance = null
  resetSinkForm()
}

// Captures the instance's live config once (getInstanceConfig), same
// one-shot pattern as selectUploadInstance: resolve_upload_source_profile
// (Rust) falls back to exactly this cached value if the instance is no
// longer mounted by the time it's actually used.
export async function selectSinkInstance(instance: MountInstance) {
  state.sinkSourceKind = 'instance'
  state.sinkSourceProfileId = null
  resetSinkForm()
  const backend = instance.backend ?? 'auto'
  state.sinkSourceInstance = { mountPath: instance.mountPath, backend, discoveryUrl: '', fork: '', volume: '', accessKeyId: '' }
  try {
    const config = JSON.parse(await getInstanceConfig(instance.mountPath))
    if (state.sinkSourceInstance?.mountPath !== instance.mountPath) return
    state.sinkSourceInstance = {
      mountPath: instance.mountPath,
      backend,
      discoveryUrl: typeof config.discoveryUrl === 'string' ? config.discoveryUrl : '',
      fork: typeof config.forkName === 'string' ? config.forkName : '',
      volume: typeof config.volumeName === 'string' ? config.volumeName : '',
      accessKeyId: typeof config.accessId === 'string' ? config.accessId : '',
    }
  } catch (error) {
    state.sinkStartError = describeError(error)
  }
}

export async function runSinkStart() {
  const profileId = state.sinkSourceKind === 'profile' ? (state.sinkSourceProfileId ?? undefined) : undefined
  const instance = state.sinkSourceKind === 'instance' ? (state.sinkSourceInstance ?? undefined) : undefined
  if (!profileId && !instance) return
  const streamUrl = state.sinkStreamUrl.trim()
  const sinkPath = state.sinkPath.trim()
  state.sinkStreamUrlError = streamUrl ? (validateUploadPositional(streamUrl, 'Stream URL') ?? '') : 'Stream URL is required'
  state.sinkPathError = sinkPath ? (validateUploadPositional(sinkPath, 'Destination path') ?? '') : 'Destination path is required'
  if (state.sinkStreamUrlError || state.sinkPathError) return
  state.sinksBusy = true
  state.sinkStartError = ''
  try {
    await startSink(profileId, instance, streamUrl, sinkPath, sinkStartParams(), state.sinkStartSecretValue || undefined)
    notify(`Ingest started: ${streamUrl} -> ${sinkPath}`)
    state.sinkSubView = 'list'
    await runSinkList()
  } catch (error) {
    state.sinkStartError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

export function requestSinkResume(job: SinkJob) {
  state.sinkResumePromptFor = job
  state.sinkSubView = 'resume'
  // Best-effort convenience default, not a requirement, mirrors
  // requestUploadResume's own comment.
  state.sinkResumeDiscoveryUrl = selectedProfile?.discoveryUrl ?? ''
  state.sinkResumeAccessKeyId = selectedProfile?.accessKeyId ?? ''
  state.sinkResumeSecretValue = ''
  state.sinkResumeError = ''
}

export function cancelSinkResume() {
  state.sinkResumePromptFor = null
  state.sinkResumeSecretValue = ''
  state.sinkSubView = 'list'
}

export async function confirmSinkResume() {
  const job = state.sinkResumePromptFor
  if (!job) return
  const discoveryUrl = state.sinkResumeDiscoveryUrl.trim()
  const accessKeyId = state.sinkResumeAccessKeyId.trim()
  if (!discoveryUrl || !accessKeyId) {
    state.sinkResumeError = !discoveryUrl ? 'Discovery URL is required' : 'Access key ID is required'
    return
  }
  state.sinksBusy = true
  state.sinkResumeError = ''
  try {
    await resumeSink(discoveryUrl, accessKeyId, job.jobId, state.sinkResumeSecretValue || undefined)
    state.sinkResumePromptFor = null
    state.sinkResumeSecretValue = ''
    state.sinkSubView = 'list'
    notify(`Ingest job ${job.jobId} resumed`)
    await runSinkList()
  } catch (error) {
    state.sinkResumeError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

// Cancel is a graceful stop, the job stays resumable. No retry-failed for
// sink (cmd_sink.go has no such subcommand): there is no per-file batch to
// retry, transient failures are already retried internally by the runner.
// Runs directly from a row button, same as runUploadCancel.
export async function runSinkCancel(job: SinkJob) {
  state.sinksBusy = true
  state.sinksError = ''
  try {
    await cancelSink(job.jobId)
    notify(`Ingest job ${job.jobId} cancelled`)
    await runSinkList()
  } catch (error) {
    state.sinksError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

// Finish is the graceful stop: unlike cancel, it finalizes the recording
// (a real EXT-X-ENDLIST, not a resumable cutoff) and ends the job rather
// than leaving it resumable. Runs directly from a row button while the job
// is running, same as runSinkCancel.
export async function runSinkFinish(job: SinkJob) {
  state.sinksBusy = true
  state.sinksError = ''
  try {
    await finishSink(job.jobId)
    notify(`Ingest job ${job.jobId} finished`)
    await runSinkList()
  } catch (error) {
    state.sinksError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

export function requestSinkPrune() {
  state.sinkPrunePromptOpen = true
  state.sinkPruneKeep = '0'
  state.sinkPruneError = ''
}

export function cancelSinkPrune() {
  state.sinkPrunePromptOpen = false
}

export async function confirmSinkPrune() {
  const keep = Number.parseInt(state.sinkPruneKeep, 10)
  state.sinksBusy = true
  state.sinkPruneError = ''
  try {
    await pruneSinks(Number.isFinite(keep) && keep > 0 ? keep : 0)
    state.sinkPrunePromptOpen = false
    notify('Completed/halted ingest jobs pruned')
    await runSinkList()
  } catch (error) {
    state.sinkPruneError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

// Remove is prune's single-job sibling: the only way to clear a job stuck
// resumable because its process was killed before it could stamp a
// terminal field (crash, OOM, power loss) -- indistinguishable from a
// cleanly cancelled job otherwise, and unreachable by cancel (no live
// process) or prune (no terminal stamp). Same confirm-dialog treatment as
// requestUploadRemove above.
export function requestSinkRemove(job: SinkJob) {
  state.sinkRemovePromptFor = job
  state.sinkRemoveError = ''
}

export function cancelSinkRemove() {
  state.sinkRemovePromptFor = null
}

export async function confirmSinkRemove() {
  const job = state.sinkRemovePromptFor
  if (!job) return
  state.sinksBusy = true
  state.sinkRemoveError = ''
  try {
    await removeSink(job.jobId)
    state.sinkRemovePromptFor = null
    notify(`Ingest job ${job.jobId} removed`)
    await runSinkList()
  } catch (error) {
    state.sinkRemoveError = describeError(error)
  } finally {
    state.sinksBusy = false
  }
}

export async function openSinkJobLog(job: SinkJob) {
  if (!job.logPath) return
  try {
    await openSinkLog(job.logPath)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Could not open the log file', 'error')
  }
}

export async function copySinkJobLogPath(job: SinkJob) {
  if (!job.logPath) return
  try {
    await navigator.clipboard.writeText(job.logPath)
    notify('Log path copied')
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to copy log path', 'error')
  }
}

// Snapshot/Deleted/Version/Gateway are all profile-based, not instance-based:
// none of these mountos commands need an existing running mount, they
// connect to discovery+dataserv independently using the profile's own
// credentials. Reached from the profile editor (any profile, mounted or
// not), or (for Deleted/Version only, per owner decision) as a
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
// mount. Rooting the native picker there is enough, since the CLI resolves
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
// error toast, so do not also emit a second, contradictory "Mounting..."
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
// config, best-effort, same as requestDeletedView's own destination
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
// external instance in the dropdown IS already a live mount, since that's the
// only way it got a row to click this from, so there is no "mount first"
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
// gateway-only (no control socket, no mount entry, confirmed against
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
      // A profile can only have one live combo gateway at a time, so drop any
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
    // written) and this launch still exits 0, so an empty endpoints list is
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
// case, etc.), so reusing profileId (already on both sides) avoids needing to
// replicate that normalization in TS. A profile can only have one
// combo-gateway mount at a time, but it can ALSO have Deleted/Version
// satellite rows open concurrently for the same profileId, so excluding rows
// with a viewModeBadge (always set for satellite views, never for the
// primary mount) keeps those from matching a gateway that has nothing to do
// with them.
export function gatewayInfoForInstance(instance: MountInstance) {
  if (!instance.profileId || viewModeBadge(instance.viewMode)) return undefined
  return state.gatewayLaunches.find((launch) => launch.mountPath && launch.profileId === instance.profileId)
}

// stop_gateway_blocking's two "the pid isn't real" errors ("was not
// discovered by this app's own gateway launch" / "no running mountos process
// at PID") mean this record's backing gateway is already gone, e.g. a
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
    const parsed = parseArgvInput(value)
    patchProfile({ extraArgs: parsed })
    // While the user is still typing the last token (no trailing space yet),
    // validating it against the managed-flag list produces false-positive
    // rejections mid-word (e.g. "--" on the way to "--attr-cache"). Only the
    // already-committed tokens are checked live; commitExtraArgs re-checks
    // the trailing token once the field is done being edited.
    const committed = parsed.length && !/\s$/.test(value) ? parsed.slice(0, -1) : parsed
    state.rejectedArgs = validateExtraArgs(committed)
    state.extraArgsError = ''
  } catch (error) {
    state.extraArgsError = error instanceof Error ? error.message : 'Invalid extra args'
  }
}

// Runs on blur so the trailing token setExtraArgs deferred (see above) still
// gets validated once editing stops, e.g. before Save/Mount's disabled state
// is read.
export function commitExtraArgs() {
  if (!selectedProfile) return
  state.rejectedArgs = validateExtraArgs(selectedProfile.extraArgs)
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
  state.secretPromptResume = null
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
    notify('No process id known for this gateway, cannot stop it', 'error')
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

export function setJobPanelCollapsed(id: string, collapsed: boolean) {
  state.jobPanelCollapsed[id] = collapsed
  if (typeof localStorage !== 'undefined') localStorage.setItem('mountos-desktop-job-panel-collapsed', JSON.stringify(state.jobPanelCollapsed))
}

export function openJobPanelFloating(id: string) {
  state.jobPanelFloatingId = id
}

export function closeJobPanelFloating() {
  state.jobPanelFloatingId = null
}

export function setJobPanelSide(id: string, side: JobPanelSide) {
  state.jobPanelSide[id] = side
  if (typeof localStorage !== 'undefined') localStorage.setItem('mountos-desktop-job-panel-side', JSON.stringify(state.jobPanelSide))
}

// Docks the panel on the given side and expands it in one step. The
// header chip's two expand buttons each call this with their own side, so
// clicking either one both picks the layout and reopens the panel.
export function expandJobPanel(id: string, side: JobPanelSide) {
  setJobPanelSide(id, side)
  setJobPanelCollapsed(id, false)
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
// block: 'nearest' rather than 'start', since pinning a near-the-bottom section
// to the viewport top can overscroll past the page's real content, leaving a
// blank gap below it since there's nothing left to fill the revealed space.
export async function goToSettingsSection(tab: SettingsTab, elementId?: string) {
  state.view = 'settings'
  state.settingsTab = tab
  await tick()
  if (elementId) document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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

// Visibility only: turning a feature off just hides its sidebar entry. It
// never touches a running job or the CLI, which don't know this toggle
// exists.
export async function setFeatureEnabled(id: string, enabled: boolean) {
  const label = FEATURE_REGISTRY.find((feature) => feature.id === id)?.label ?? id
  try {
    const nextOverrides = { ...state.settings.featureOverrides, [id]: enabled }
    state.settings = await saveSettings({ ...state.settings, featureOverrides: nextOverrides })
    notify(`${label} ${enabled ? 'enabled' : 'disabled'}`)
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
// separate persisted flag, since turning it back on just clears the field.
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
    state.cliSignatureStatus = null
    notify('Pinned mountos CLI path')
    await refresh(false)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'That binary does not look like the mountos CLI', 'error')
  }
}

export async function clearCliPathOverride() {
  try {
    state.settings = await saveSettings({ ...state.settings, cliPathOverride: undefined })
    state.cliSignatureStatus = null
    notify('CLI path pin cleared, using PATH lookup again')
    await refresh(false)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to save settings', 'error')
  }
}

// Checks the code-signing signature of whichever binary is actually in
// effect (the pinned override if set, else the PATH-resolved one), a
// stronger claim than validateCliCandidate's "--version prints mountos" text
// sniff, which a spoofed binary could trivially satisfy.
export async function verifyCliBinary() {
  const path = state.settings.cliPathOverride ?? state.systemState.cliPath
  if (!path) return
  state.cliSignatureChecking = true
  try {
    state.cliSignatureStatus = await verifyCliSignature(path)
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Failed to verify the CLI signature', 'error')
  } finally {
    state.cliSignatureChecking = false
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
  const feature = FEATURE_REGISTRY.find((candidate) => candidate.id === nextView)
  if (feature) return feature.label
  return nextView === 'instances'
    ? 'Instances'
    : nextView === 'profiles'
      ? 'Profiles'
      : nextView === 'uploads'
        ? 'Uploads'
        : nextView === 'downloads'
          ? 'Downloads'
          : 'Settings'
}

export {
  buildDeletedArgv,
  buildDownloadCancelArgv,
  buildDownloadListArgv,
  buildDownloadPruneArgv,
  buildDownloadRemoveArgv,
  buildDownloadResumeArgv,
  buildDownloadRetryFailedArgv,
  buildDownloadStartArgv,
  buildForkCreateArgv,
  buildForkDeleteArgv,
  buildForkListArgv,
  buildForkRestoreArgv,
  buildGatewayArgv,
  buildMountArgv,
  buildSinkPruneArgv,
  buildSinkRemoveArgv,
  buildSinkResumeArgv,
  buildSinkStartArgv,
  buildSnapshotArgv,
  buildUploadCancelArgv,
  buildUploadListArgv,
  buildUploadPruneArgv,
  buildUploadRemoveArgv,
  buildUploadResumeArgv,
  buildUploadRetryFailedArgv,
  buildUploadStartArgv,
  buildVersionArgv,
}
