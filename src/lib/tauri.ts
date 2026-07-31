import { invoke } from '@tauri-apps/api/core'
import { join, tempDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import type { GatewayLaunchParams, UploadStartParams } from './cli'
import type {
  DesktopSettings,
  DiagnosticsBundle,
  ExportedProfile,
  Fork,
  GatewayLaunchResult,
  MountProfile,
  MountResult,
  SecretStatus,
  SystemState,
  ThirdPartyLicenses,
  UnmountResult,
  UnmountAllResult,
  UploadInstanceRef,
  UploadJob,
} from './types'

export function hasDesktopBridge(): boolean {
  return typeof globalThis !== 'undefined' && '__TAURI_INTERNALS__' in globalThis
}

const fallbackProfiles: MountProfile[] = [
  {
    id: 'sample',
    schemaVersion: 1,
    kind: 'mount',
    name: 'Work volume',
    volume: 'vol_demo',
    fork: 'main',
    mountPath: '/Volumes/MountOS/Work',
    discoveryUrl: 'https://hub.mountos.local',
    accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
    secretRef: 'prompt',
    backend: 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

export async function getSystemState(): Promise<SystemState> {
  if (!hasDesktopBridge()) {
    return {
      platform: navigator.platform.toLowerCase().includes('win') ? 'windows' : navigator.platform.toLowerCase().includes('mac') ? 'macos' : 'linux',
      checkOk: false,
      cliVersion: 'web preview',
      issues: [
        {
          id: 'preview',
          severity: 'warning',
          title: 'Desktop bridge unavailable',
          detail: 'Run with Tauri to inspect the local mountOS binary.',
        },
      ],
      instances: [
        {
          key: 'sample',
          name: 'Work volume',
          mountPath: '/Volumes/MountOS/Work',
          fsName: 'nfs',
          volumeId: 1,
          external: false,
          health: 'healthy',
        },
      ],
      cliPathAlternates: [],
      // Web preview has no host to scan, so the picker shows only "System
      // default" rather than terminals it could never launch.
      terminals: [],
    }
  }
  return invoke<SystemState>('get_system_state')
}

export async function listProfiles(): Promise<MountProfile[]> {
  if (!hasDesktopBridge()) return fallbackProfiles
  return invoke<MountProfile[]>('list_profiles')
}

export async function saveProfile(profile: MountProfile): Promise<MountProfile> {
  if (!hasDesktopBridge()) return { ...profile, updatedAt: new Date().toISOString() }
  return invoke<MountProfile>('save_profile', { profile })
}

export async function deleteProfile(profileId: string): Promise<void> {
  if (!hasDesktopBridge()) return
  await invoke('delete_profile', { profileId })
}

export async function exportProfile(profileId: string): Promise<ExportedProfile> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<ExportedProfile>('export_profile', { profileId })
}

export async function getSettings(): Promise<DesktopSettings> {
  if (!hasDesktopBridge()) return { defaultBackend: 'auto', allowForkForceDelete: false, allowUnmountForce: false }
  return invoke<DesktopSettings>('get_settings')
}

export async function saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  if (!hasDesktopBridge()) return settings
  return invoke<DesktopSettings>('save_settings', { settings })
}

export async function setProfileSecret(profileId: string, secret: string): Promise<SecretStatus> {
  if (!hasDesktopBridge()) return { profileId, stored: true }
  return invoke<SecretStatus>('set_profile_secret', { profileId, secret })
}

export async function deleteProfileSecret(profileId: string): Promise<SecretStatus> {
  if (!hasDesktopBridge()) return { profileId, stored: false }
  return invoke<SecretStatus>('delete_profile_secret', { profileId })
}

export async function getProfileSecretStatus(profileId: string): Promise<SecretStatus> {
  if (!hasDesktopBridge()) return { profileId, stored: false }
  return invoke<SecretStatus>('get_profile_secret_status', { profileId })
}

export async function mountProfile(profileId: string, secret?: string): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('mount_profile', { profileId, secret })
}

export async function forkList(profileId: string, secret?: string): Promise<Fork[]> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  const raw = await invoke<string>('fork_list_raw', { profileId, secret })
  if (!raw.trim()) return []
  return JSON.parse(raw) as Fork[]
}

export async function forkCreate(
  profileId: string,
  name: string,
  parent?: string,
  asOf?: string,
  secret?: string,
): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('fork_create', { profileId, name, parent, asOf, secret })
}

export async function forkDelete(profileId: string, name: string, force: boolean, secret?: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('fork_delete', { profileId, name, force, secret })
}

export async function forkRestore(profileId: string, name: string, secret?: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('fork_restore', { profileId, name, secret })
}

export async function listUploads(): Promise<UploadJob[]> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<UploadJob[]>('list_uploads')
}

// Exactly one of profileId/instance is expected -- mirrors src-tauri/src/
// lib.rs's resolve_upload_source_profile.
export async function startUpload(
  profileId: string | undefined,
  instance: UploadInstanceRef | undefined,
  source: string,
  dest: string,
  params: UploadStartParams,
  secret?: string,
): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('start_upload', { profileId, instance, source, dest, params, secret })
}

// Ensures a read-only scratch mount of the upload source's volume exists
// (mounting it if needed, reusing an already-mounted one otherwise) and
// returns its local filesystem path, so the destination-path Browse button
// can hand that path to the native folder picker -- there is no "list a
// remote directory" RPC to call instead. The mount is left up for a while
// in case of a repeat browse, then reaped after being idle (see
// ensure_upload_browse_mount_blocking's own doc comment).
export async function ensureUploadBrowseMount(
  profileId: string | undefined,
  instance: UploadInstanceRef | undefined,
  secret?: string,
): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('ensure_upload_browse_mount', { profileId, instance, secret })
}

export async function resumeUpload(
  profileId: string,
  jobId: string,
  once: boolean,
  rescanInterval?: string,
  secret?: string,
): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('resume_upload', { profileId, jobId, once, rescanInterval, secret })
}

export async function cancelUpload(jobId: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('cancel_upload', { jobId })
}

export async function retryFailedUpload(jobId: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('retry_failed_upload', { jobId })
}

export async function pruneUploads(keep: number): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('prune_uploads', { keep })
}

export async function openSnapshotView(
  profileId: string,
  destination: string,
  timestamp: string,
  secret?: string,
): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('open_snapshot_view', { profileId, destination, timestamp, secret })
}

export async function openDeletedView(
  profileId: string,
  destination: string,
  from?: string,
  idleTimeout?: string,
  secret?: string,
): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('open_deleted_view', { profileId, destination, from, idleTimeout, secret })
}

export async function openVersionView(
  profileId: string,
  destination: string,
  selector: { path: string } | { inode: string },
  versionFormat?: string,
  idleTimeout?: string,
  secret?: string,
  fullChain?: boolean,
): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('open_version_view', {
    profileId,
    destination,
    path: 'path' in selector ? selector.path : undefined,
    inode: 'inode' in selector ? selector.inode : undefined,
    versionFormat,
    idleTimeout,
    secret,
    fullChain,
  })
}

// For an instance with no saved profile (mounted from the terminal, or any
// tool outside this app) -- the Rust side re-derives credentials from the
// live mount's own .mountOS/.config rather than trusting anything passed
// here about identity. `backend` is the instance's own already-known,
// non-sensitive backend string (from `mountos list --json`), not a secret.
export async function openDeletedViewForInstance(
  mountPath: string,
  backend: string,
  destination: string,
  from?: string,
  idleTimeout?: string,
  secret?: string,
): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('open_deleted_view_for_instance', { mountPath, backend, destination, from, idleTimeout, secret })
}

export async function openVersionViewForInstance(
  mountPath: string,
  backend: string,
  destination: string,
  selector: { path: string } | { inode: string },
  versionFormat?: string,
  idleTimeout?: string,
  secret?: string,
  fullChain?: boolean,
): Promise<MountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<MountResult>('open_version_view_for_instance', {
    mountPath,
    backend,
    destination,
    path: 'path' in selector ? selector.path : undefined,
    inode: 'inode' in selector ? selector.inode : undefined,
    versionFormat,
    idleTimeout,
    secret,
    fullChain,
  })
}

export async function openGateway(
  profileId: string,
  params: GatewayLaunchParams,
  secret?: string,
): Promise<GatewayLaunchResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<GatewayLaunchResult>('open_gateway', { profileId, params, secret })
}

export async function stopGateway(pid: number): Promise<void> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  await invoke('stop_gateway', { pid })
}

export async function stopGatewayOnly(pid: number): Promise<void> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  await invoke('stop_gateway_only', { pid })
}

export async function unmountTarget(target: string, force = false): Promise<UnmountResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<UnmountResult>('unmount_target', { target, force })
}

export async function unmountAllTargets(force = false): Promise<UnmountAllResult> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<UnmountAllResult>('unmount_all_targets', { force })
}

export async function openTarget(target: string): Promise<void> {
  if (!hasDesktopBridge()) return
  await invoke('open_target', { target })
}

export async function openLostFound(target: string): Promise<void> {
  if (!hasDesktopBridge()) return
  await invoke('open_lost_found', { target })
}

export async function openDiagnosticsBundle(path: string): Promise<void> {
  if (!hasDesktopBridge()) return
  await invoke('open_diagnostics_bundle', { path })
}

export async function getInstanceConfig(target: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('get_instance_config', { target })
}

export async function launchDashboard(target: string, gui: boolean): Promise<void> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  await invoke('launch_dashboard', { target, gui })
}

export async function createDiagnosticsBundle(): Promise<DiagnosticsBundle> {
  if (!hasDesktopBridge()) return { path: 'Desktop bridge unavailable' }
  return invoke<DiagnosticsBundle>('create_diagnostics_bundle')
}

export async function mcpStatus(): Promise<string> {
  if (!hasDesktopBridge()) return 'Desktop bridge unavailable'
  return invoke<string>('mcp_status')
}

export async function mcpInstall(): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('mcp_install')
}

export async function mcpUninstall(): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('mcp_uninstall')
}

export async function mountHelp(): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('mount_help')
}

export async function getThirdPartyLicenses(kind: 'rust' | 'js'): Promise<ThirdPartyLicenses> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<ThirdPartyLicenses>('get_third_party_licenses', { kind })
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  await invoke('open_external_url', { url })
}

export async function browseCliBinary(defaultPath?: string): Promise<string | null> {
  if (!hasDesktopBridge()) return null
  const selected = await open({ directory: false, multiple: false, title: 'Choose the mountos CLI binary', defaultPath })
  return typeof selected === 'string' ? selected : null
}

export async function validateCliCandidate(path: string): Promise<string> {
  if (!hasDesktopBridge()) throw new Error('Desktop bridge unavailable')
  return invoke<string>('validate_cli_candidate', { path })
}

export async function showMainWindow(): Promise<void> {
  if (!hasDesktopBridge()) return
  await invoke('show_main_window')
}

export async function browseFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (!hasDesktopBridge()) return null
  // canCreateDirectories is already the macOS default; set explicitly so the
  // "New Folder" affordance in the native picker doesn't depend on a plugin
  // default that could change, and so callers browsing to an auto-generated,
  // not-yet-existing destination (e.g. defaultViewDestination) can still
  // create it from within the picker instead of only picking existing ones.
  const selected = await open({ directory: true, multiple: false, title, defaultPath, canCreateDirectories: true })
  return typeof selected === 'string' ? selected : null
}

// Picks a single file under a mounted volume's live mount path. mountOS
// volumes are real OS mounts, so the picked absolute path is enough -- the
// CLI resolves inode/parent/name itself via stat(2), no control-socket round
// trip needed here.
export async function browseVersionFile(title: string, mountPath: string): Promise<string | null> {
  if (!hasDesktopBridge()) return null
  const selected = await open({ directory: false, multiple: false, title, defaultPath: mountPath })
  return typeof selected === 'string' ? selected : null
}

// One path segment: lowercased, non-alphanumeric runs collapsed to a single
// hyphen, leading/trailing hyphens trimmed. Never empty (falls back to
// "profile") so the generated path is always a valid single segment.
function slugifyForPath(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'
}

function randomDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('')
}

// Destination folders for the read-only satellite views (deleted-files,
// version) don't need to exist beforehand -- the mountos CLI creates its own
// mount point -- so this only has to produce a plausible, collision-unlikely
// path, not touch the filesystem.
export async function defaultViewDestination(profileName: string, kind: string): Promise<string> {
  const base = await tempDir()
  return join(base, `${slugifyForPath(profileName)}-${kind}-${randomDigits(6)}`)
}
