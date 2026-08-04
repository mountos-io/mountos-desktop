use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

#[derive(Debug, thiserror::Error)]
enum DesktopError {
    #[error("mountos CLI not found in PATH")]
    CliNotFound,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("tauri path error: {0}")]
    Path(#[from] tauri::Error),
    #[error("{0}")]
    Message(String),
}

impl Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Backend {
    Auto,
    Macfuse,
    Fskit,
    Nfs,
    Smb,
    Mountosio,
}

// Hand-written so an unrecognised id degrades to Auto instead of failing the
// parse. read_profiles aborts the entire listing on a single unreadable
// profile file, so a profile written by an older build (naming a backend that
// no longer exists) would otherwise take every other profile down with it.
// Auto is the safe landing spot: the CLI probes and picks a real backend for
// that machine, and validate_backend_for_platform still gates the result.
impl<'de> Deserialize<'de> for Backend {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "macfuse" => Backend::Macfuse,
            "fskit" => Backend::Fskit,
            "nfs" => Backend::Nfs,
            "smb" => Backend::Smb,
            "mountosio" => Backend::Mountosio,
            _ => Backend::Auto,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountProfile {
    id: String,
    schema_version: u32,
    kind: String,
    name: String,
    volume: String,
    fork: String,
    mount_path: String,
    discovery_url: String,
    access_key_id: String,
    secret_ref: String,
    backend: Backend,
    cache_dir: Option<String>,
    cache_size: Option<String>,
    read_only: bool,
    auto_remount: bool,
    // Added after the original schema; #[serde(default)] so profiles saved
    // before this field existed still deserialize (bool has no implicit
    // default the way Option<T> does).
    #[serde(default)]
    temporary_fork: bool,
    trusted_discovery_host: Option<String>,
    extra_args: Vec<String>,
    created_at: String,
    updated_at: String,
    // Detected once, from the mounted volume's own `.mountOS/.volume-type`
    // reserved file, the first time this profile mounts successfully (or at
    // creation time via Save-as-profile off an already-running external
    // mount). "general" | "iceberg", lowercase. None until detected. Never
    // reset once set: save_profile rejects any incoming value that
    // contradicts what's already on disk (see require_stable_identity), and
    // once set it also locks access_key_id/discovery_url/volume against
    // further edits -- the whole point is a stable answer to "which real
    // volume does this profile point at", not a value that could drift.
    // Option<T> deserializes a missing key (profiles saved before this field
    // existed) as None automatically, no #[serde(default)] needed.
    volume_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MountInstance {
    key: String,
    name: String,
    mount_path: String,
    fs_name: Option<String>,
    // The transport the mount actually runs on (macfuse/fskit/nfs/smb/
    // mountosio), as reported by `mountos list`.
    // fs_name is the device string ("mountos:<volume>") and says nothing about
    // the backend, so it is not a stand-in for this.
    backend: Option<String>,
    view_mode: Option<String>,
    volume_identifier: Option<String>,
    volume_id: Option<u32>,
    unc_path: Option<String>,
    version_inode: Option<String>,
    orphaned: Option<bool>,
    // "mount" (the default assumed by an older CLI that predates this field)
    // or "gateway" -- a gateway-only instance has no mountPath/backend/
    // fsName at all, only gatewayEndpoints, and the frontend must branch on
    // this before assuming any of those are populated.
    kind: Option<String>,
    gateway_endpoints: Option<Vec<GatewayEndpointInfo>>,
    // Only meaningful for a "gateway" entry today -- stop_gateway_only is
    // the one thing that needs it, to send a signal at a specific process.
    pid: Option<u32>,
    // Not part of `mountos list --json` (confirmed: name/mountPath/fsName/
    // viewMode/backend/etc only) -- filled in afterward from each instance's
    // own .mountOS/.config, the same file get_instance_config reads.
    mount_time: Option<String>,
    // Also read live from .mountOS/.config (InstanceConfigExtras, below) --
    // works for external mounts too, unlike MountProfile's own volume_kind
    // field, which only ever populates for profile-backed mounts.
    volume_kind: Option<String>,
    temporary_fork: Option<bool>,
    external: bool,
    // Id of the saved profile whose mount path matches this mount, if any.
    // external is simply this being absent.
    profile_id: Option<String>,
    health: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckIssue {
    id: String,
    severity: String,
    title: String,
    detail: Option<String>,
    fix_command: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemState {
    platform: String,
    cli_path: Option<String>,
    cli_version: Option<String>,
    check_ok: bool,
    issues: Vec<CheckIssue>,
    instances: Vec<MountInstance>,
    // Other mountos binaries found on PATH besides the one actually in use
    // (empty when there's exactly one, the common case). Surfaces ambiguity
    // instead of silently trusting whichever which() happened to resolve.
    cli_path_alternates: Vec<String>,
    // Terminal emulators detected on this machine, in preference order. The
    // settings picker lists exactly these, so it can only ever offer a
    // terminal that is actually installed.
    terminals: Vec<TerminalOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOption {
    id: String,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretStatus {
    profile_id: String,
    stored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsCommandOutput {
    status: Option<i32>,
    stdout: Value,
    stderr: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsProfileSummary {
    id: String,
    name: String,
    kind: String,
    mount_path: String,
    discovery_url: String,
    backend: Backend,
    secret_ref: String,
    extra_args_count: usize,
    auto_remount: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsContent {
    created_at_unix: u64,
    cli_path: Option<String>,
    cli_version: Option<String>,
    check: Option<DiagnosticsCommandOutput>,
    list: Option<DiagnosticsCommandOutput>,
    profiles: Vec<DiagnosticsProfileSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsBundle {
    path: String,
    content: DiagnosticsContent,
}

#[derive(Debug, Serialize)]
struct ExportedProfile {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    default_backend: Backend,
    // How often the mount list is refreshed while the window is visible, in
    // seconds. None means the default. A hidden window always backs off
    // regardless (see the poll effect).
    poll_seconds: Option<u32>,
    // Terminal emulator id for the dashboard launcher (see KNOWN_TERMINALS).
    // None means the platform's stock terminal. A pinned terminal that is no
    // longer installed silently falls back rather than failing: it is a
    // preference, not a hard pin like cli_path_override.
    terminal: Option<String>,
    // Seeds new profiles' discoveryUrl; each profile can still override it
    // independently afterward. Existing profiles are never retroactively
    // rewritten when this changes. Option<T> deserializes missing older
    // settings.json files (pre-dating this field) as None automatically.
    default_discovery_url: Option<String>,
    // Seeds new profiles' cacheDir; each profile can still override it
    // independently afterward (or be hand-edited to clear it back to the
    // CLI's own ~/.mountOS/cache default). None means no override.
    default_cache_dir: Option<String>,
    // Seeds new profiles' cacheSize (--disk-cache-size). None means Auto:
    // no flag emitted, so the CLI's own free-disk-scaled [10G, 100G] clamp
    // applies. The Settings UI offers a fixed override via an Auto checkbox.
    default_cache_size: Option<String>,
    // Pins an exact mountos binary instead of the first PATH match. Once
    // set, a moved/missing pinned binary is a hard error (see
    // mountos_path) rather than a silent fallback to a different install.
    cli_path_override: Option<String>,
    // Gates --force on fork delete, which also removes the fork's entire
    // subtree. Off by default: it mutates shared server-side volume state
    // used by every OTHER mount of the same volume, not just this profile's.
    // Fork list/create/delete/restore themselves are always available.
    // #[serde(default)] so settings.json files written before this field
    // existed still deserialize to `false` rather than failing, matching the
    // temporary_fork precedent on MountProfile.
    #[serde(default)]
    allow_fork_force_delete: bool,
    // Offers --force on unmount, which disconnects whatever still holds a busy
    // mount. Off by default, because apps reading or writing files there get an
    // I/O error and lose unsaved work. Without it a busy mount is reported as
    // busy and stays mounted and working.
    #[serde(default)]
    allow_unmount_force: bool,
    // User overrides for optional-feature visibility, keyed by feature id
    // (see src/lib/features.ts's FEATURE_REGISTRY). Absent id means "use the
    // registry default", not "off". Local to this install only, never synced
    // anywhere. #[serde(default)] so settings.json files written before this
    // field existed still deserialize to an empty map rather than failing.
    #[serde(default)]
    feature_overrides: std::collections::HashMap<String, bool>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            default_backend: Backend::Auto,
            default_discovery_url: None,
            default_cache_dir: None,
            default_cache_size: None,
            cli_path_override: None,
            poll_seconds: None,
            terminal: None,
            allow_fork_force_delete: false,
            allow_unmount_force: false,
            feature_overrides: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
struct MountResult {
    state: String,
    target: String,
}

// Mirrors mountos-servers' mountListEntry's upload-only fields (`mountos
// list --kind upload --json`) -- source_path/dest_path/fork_name/halt_reason
// are Option since the server field carries `omitempty` and won't appear at
// all for every state (e.g. a freshly-started job has no halt_reason).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadJob {
    job_id: String,
    name: String,
    source_path: Option<String>,
    dest_path: Option<String>,
    fork_name: Option<String>,
    // running | halted | completed | resumable
    state: String,
    counts: std::collections::HashMap<String, i64>,
    halt_reason: Option<String>,
    pid: Option<u32>,
    // The volume this job was created against (mountos-servers'
    // spec.VolumeSID). Server-side `validateResumeVolumeMatch` already
    // refuses to resume a job under mismatched credentials, so this is
    // informational (lets the UI show/warn which volume a job belongs to),
    // not itself the enforcement point.
    volume_id: Option<u32>,
    // job.json's own UnixNano timestamps, unrelated to any filesystem mtime
    // -- lets the GUI sort the job list meaningfully; `mountos list --kind
    // upload` otherwise returns directory-name (hex-hash lexical) order.
    created_at: Option<i64>,
    completed_at: Option<i64>,
    // Path to the file logger's output for this job's last terminal run,
    // only present when that file still exists on disk (see
    // mountos-servers' uploadjob.JobSpec.LogPath doc comment).
    log_path: Option<String>,
    // A live aggregate as of the server's last scan pass, not a fixed total
    // -- see uploadjob.JobSpec's TotalFiles/TotalBytes doc comment.
    total_bytes: Option<i64>,
    total_files: Option<i64>,
}

// Frontend-supplied flags for the `mountos upload <source> <dest>` run form
// -- one struct rather than a long parameter list, deserialized straight off
// the IPC call.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadStartParams {
    once: bool,
    overwrite: bool,
    dry_run: bool,
    rescan_interval: Option<String>,
    restart: bool,
    bwlimit: Option<u32>,
    include: Vec<String>,
    exclude: Vec<String>,
    follow_symlinks: bool,
    create_source_directory: bool,
}

// Mirrors mountos-servers' mountListEntry's download-only fields (`mountos
// list --kind download --json`) -- verified identical Go struct/field names
// to UploadJob above, only the counts keys differ in meaning (pending |
// downloading | done | failed | skipped | missing, plus a synthetic
// "retrying" key for entries currently in backoff -- self-clearing, distinct
// from "failed" which needs `download retry-failed`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadJob {
    job_id: String,
    name: String,
    source_path: Option<String>,
    dest_path: Option<String>,
    fork_name: Option<String>,
    // running | halted | completed | resumable
    state: String,
    counts: std::collections::HashMap<String, i64>,
    halt_reason: Option<String>,
    pid: Option<u32>,
    volume_id: Option<u32>,
    created_at: Option<i64>,
    completed_at: Option<i64>,
    log_path: Option<String>,
    total_bytes: Option<i64>,
    total_files: Option<i64>,
}

// The GUI's own SOURCE-mode concept (mirrors upload's 'profile'/'instance'
// naming in src/lib/cli.ts) -- the Go CLI auto-detects mounted-vs-remote
// from the raw SOURCE path itself (detectDownloadSourceKind, cmd_download.go),
// but the GUI needs to know the mode up front to decide the form fields AND
// how build_download_start_argv shapes the command: Instance means SOURCE is
// a local filesystem path read straight through an already-live mount (mode
// A: no RPC, no connection, no credentials at all); Profile means SOURCE is
// a mountOS-relative path string on a saved profile's fork, connected fresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DownloadSourceKind {
    Instance,
    Profile,
}

// Frontend-supplied flags for the `mountos download <source> <dest>` run
// form. No once/overwrite/rescan_interval (download has neither --once nor
// --overwrite -- see cmd_download.go's own doc comment) -- if_exists/depth/
// as_of are new instead.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadStartParams {
    if_exists: String,
    depth: i32,
    as_of: Option<String>,
    dry_run: bool,
    restart: bool,
    bwlimit_mbps: Option<u32>,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    follow_symlinks: bool,
    create_source_directory: bool,
}

// Mirrors mountos-servers' sinkListEntry (`mountos sink list --json`,
// cmd_list_sink.go) -- a sink job's live state is rate/lag counters, not a
// bounded per-status work list, so this is a genuinely different shape from
// UploadJob/DownloadJob's `counts` map, not a reuse of it. Every counter
// field carries `omitempty` server-side and is 0/absent for a job that has
// neither a live daemon nor cached counters. A stopped job with cached
// final counters (JobSpec.CachedCounts) reports them here too, tagged
// last_known -- lag fields stay 0 in that case, they describe an active
// fetch loop that no longer exists (see cmd_list_sink.go's own doc comment).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SinkJob {
    job_id: String,
    name: String,
    // running | halted | completed | resumable | finished
    state: String,
    source: String, // redacted stream URL
    sink_template: String,
    fork: String,
    lag_segments: Option<i64>,
    lag_seconds: Option<f64>,
    wal_bytes: Option<i64>,
    wal_segments: Option<i32>,
    discontinuities: Option<i64>,
    segments_fetched: Option<i64>,
    bytes_committed: Option<i64>,
    fetch_errors: Option<i64>,
    commit_retries: Option<i64>,
    halt_reason: Option<String>,
    pid: Option<u32>,
    created_at: Option<i64>,
    completed_at: Option<i64>,
    log_path: Option<String>,
    last_known: bool,
    // Number of destination files this job has produced so far, and the
    // rendered path of the one currently being written -- see cmd_list_
    // sink.go's sinkListEntry.FileCount/.CurrentPath doc comments. Both
    // omitempty Go-side (absent before the first file opens).
    file_count: Option<i64>,
    current_path: Option<String>,
}

// Mirrors mountos-servers' SinkSnapshot (sink_runner.go) -- the fuller
// single-job rate/lag reading from `mountos sink status --job <id> --json`.
// Present for a running job (a live reading) or for a stopped job with
// cached final counters (SinkStatus.last_known true) -- see
// sinkStatusPayload's own doc comment. last_commit_at/last_segment_at are
// always None in the cached case: SinkCachedCounts does not persist them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SinkSnapshot {
    state: String,
    lag_segments: i64,
    lag_seconds: f64,
    wal_bytes: i64,
    wal_segments: i32,
    discontinuities: i64,
    segments_fetched: i64,
    segments_committed: i64,
    bytes_committed: i64,
    file_size: i64,
    bitrate_observed: f64,
    fetch_errors: i64,
    commit_retries: i64,
    // Number of destination files opened so far, and the rendered path of
    // the one currently being written -- see sink_runner.go's SinkSnapshot.
    // FileCount/.CurrentPath doc comments. Neither is omitempty Go-side.
    file_count: i64,
    current_path: String,
    // Go's zero time.Time ("0001-01-01T00:00:00Z") is normalized to None
    // rather than passed through -- see parse_sink_snapshot_value.
    last_commit_at: Option<String>,
    last_segment_at: Option<String>,
}

// Mirrors mountos-servers' sinkStatusPayload (cmd_sink.go).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SinkStatus {
    job_id: String,
    running: bool,
    state: String,
    friendly_name: Option<String>,
    source: Option<String>,
    sink_template: Option<String>,
    fork: Option<String>,
    halt_reason: Option<String>,
    snapshot: Option<SinkSnapshot>,
    last_known: bool,
}

// Frontend-supplied flags for the `mountos sink <M3U8_URL> <SINK_PATH>` run
// form -- confirmed against cmd_sink.go: only --variant/--max-latency/
// --wal-max exist beyond the shared --fork/credentials every satellite
// builder already handles. No once/overwrite/dryRun/bwlimit/include/
// exclude the way UploadStartParams has, sink has none of those.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SinkStartParams {
    variant: Option<String>,
    max_latency: Option<String>,
    wal_max: Option<String>,
}

#[derive(Debug, Serialize)]
struct UnmountResult {
    state: String,
    target: String,
}

#[derive(Debug, Serialize)]
struct UnmountAllResult {
    attempted: usize,
    failed: Vec<String>,
    // Targets the CLI reported as busy rather than failed. These are still
    // mounted and serving, and are the ones a forced retry can get past.
    busy: Vec<String>,
}

// One entry of `mountos unmount --json`. state is one of unmounted, busy,
// refused, cancelled, failed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnmountOutcome {
    mount_path: String,
    state: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    busy: bool,
}

impl UnmountOutcome {
    fn unmounted(&self) -> bool {
        self.state == "unmounted"
    }

    // Prefers the CLI's own message, which already explains a busy mount and
    // what to do about it, over a generic restatement of the state.
    fn detail(&self) -> String {
        if self.error.is_empty() {
            format!("unmount reported {}", self.state)
        } else {
            self.error.clone()
        }
    }
}

// Parses `mountos unmount --json`. The document goes to stdout and any error
// text to stderr, so a non-zero exit still carries a usable document.
fn parse_unmount_outcomes(
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Vec<UnmountOutcome>, DesktopError> {
    serde_json::from_slice::<Vec<UnmountOutcome>>(stdout).map_err(|error| {
        let detail = String::from_utf8_lossy(stderr).trim().to_string();
        DesktopError::Message(if detail.is_empty() {
            format!("could not read unmount result: {error}")
        } else {
            detail
        })
    })
}

const KEYRING_SERVICE: &str = "sh.mountos.desktop";
const ACCESS_KEY_ID_LENGTH: usize = 20;
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(65);
#[cfg(windows)]
const WINDOWS_READY_TIMEOUT: Duration = Duration::from_secs(60);
const INDETERMINATE_TIMEOUT: Duration = Duration::from_secs(120);
const UNMOUNT_TIMEOUT: Duration = Duration::from_secs(120);
// Fork subcommands are a real network round trip (one-shot TCP call to the
// discovery/data server), unlike a local `list --json`/`mcp status` call --
// every other spawn helper in this file already bounds its wait; this one
// didn't, so an unreachable server could hang it (and forkBusy) forever.
// Matches mountos-servers' own `context.WithTimeout(cmd.Context(), 30*time.
// Second)` in cmd_fork.go by coincidence, not a shared constant -- keep the
// two in sync intentionally, since a shorter value here would mask that
// server-side context's own descriptive timeout error with a generic one.
const FORK_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
// `upload --dry-run` walks the entire source tree (runUploadDryRun,
// cmd_upload.go) rather than doing one quick RPC like every other one-shot
// upload subcommand -- a large tree on a slow/network disk can legitimately
// take longer than FORK_COMMAND_TIMEOUT's 30s. Bounded well under
// LAUNCH_TIMEOUT (65s) x-several rather than unbounded: this is a manual,
// explicitly-triggered action the user is actively watching for, so a firm
// upper bound with a clear timeout message still beats hanging forever.
const DRY_RUN_TIMEOUT: Duration = Duration::from_secs(300);
// `upload --once`/`upload resume --once` deliberately do NOT daemonize
// server-side (shouldDaemonizeUpload/startUploadJob, cmd_upload.go) --
// --once's whole purpose is to block in the foreground until the job
// actually settles, then report a definitive exit code. Using LAUNCH_
// TIMEOUT's 65s here (as if exit 0 were a daemonize confirmation, which it
// never is for --once) would SIGKILL a perfectly healthy job mid-upload
// the moment it ran longer than a minute. This bounds the wait for the
// REAL settle instead -- generous since --once uploads data, not just
// scans a tree like DRY_RUN_TIMEOUT's read-only walk -- while still firm
// per this file's own established preference for a clear timeout over
// hanging forever.
const UPLOAD_ONCE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
// A local `--version` probe of a user-picked candidate binary, not a network
// round trip -- bounded tight so an unresponsive/hung pick fails fast rather
// than leaving the settings UI stuck validating.
const CLI_VALIDATE_TIMEOUT: Duration = Duration::from_secs(5);
// mountOS's Apple Developer Team ID, pinned here rather than read from
// tauri.conf.json: the bundle config has no signingIdentity key (the build
// scripts supply APPLE_TEAM_ID/MOUNTOS_CODESIGN_IDENTITY as env vars at sign
// time instead), so there's nothing to read it from at runtime.
#[cfg(target_os = "macos")]
const MOUNTOS_MACOS_TEAM_ID: &str = "2J6SJSDP78";

fn keyring_entry(profile_id: &str) -> Result<keyring::Entry, DesktopError> {
    validate_profile_id(profile_id)?;
    Ok(keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("profile/{profile_id}"),
    )?)
}

fn read_profile_secret(
    profile: &MountProfile,
    provided: Option<String>,
) -> Result<Option<String>, DesktopError> {
    if let Some(secret) = provided {
        return Ok(Some(secret));
    }
    if profile.secret_ref == "vault" {
        return Ok(Some(keyring_entry(&profile.id)?.get_password()?));
    }
    Ok(None)
}

static CLI_PATH_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn cli_path_override_cell() -> &'static Mutex<Option<PathBuf>> {
    CLI_PATH_OVERRIDE.get_or_init(|| Mutex::new(None))
}

// Populated from DesktopSettings.cli_path_override whenever settings are
// read or saved (get_settings/save_settings), not read from disk on every
// mountos_path() call. There is a small startup race: the very first
// get_system_state poll can land before the frontend's initial
// loadSettings() call finishes, using the plain PATH lookup for one cycle.
// Self-corrects on the next poll (5s) and every settings.json write races
// nothing since it happens strictly after this function is populated.
fn set_cli_path_override(path: Option<PathBuf>) {
    *cli_path_override_cell()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = path;
}

fn cli_path_override() -> Option<PathBuf> {
    cli_path_override_cell()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn mountos_path() -> Result<PathBuf, DesktopError> {
    if let Some(pinned) = cli_path_override() {
        return if pinned.is_file() {
            Ok(pinned)
        } else {
            // Fail loudly rather than silently falling back to a different
            // PATH match -- that would defeat the point of pinning a path.
            Err(DesktopError::Message(format!(
                "pinned CLI path no longer exists: {}",
                pinned.display()
            )))
        };
    }
    which::which("mountos").map_err(|_| DesktopError::CliNotFound)
}

// Every mountos binary on PATH other than the one actually in use. which
// 8.0.4's which_all() walks the full PATH; used to warn about ambiguous
// installs (e.g. a stale dev build shadowing a real one) rather than
// silently trusting whichever happens to resolve first.
fn other_cli_paths_on_path(resolved: Option<&Path>) -> Vec<String> {
    let Ok(all) = which::which_all("mountos") else {
        return Vec::new();
    };
    all.filter(|p| resolved.is_none_or(|r| p != r))
        .map(|p| p.display().to_string())
        .collect()
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, DesktopError> {
    let dir = app.path().app_config_dir()?.join("profiles");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn profile_path(app: &AppHandle, id: &str) -> Result<PathBuf, DesktopError> {
    validate_profile_id(id)?;
    Ok(profile_dir(app)?.join(format!("{id}.json")))
}

fn validate_profile_id(id: &str) -> Result<(), DesktopError> {
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err(DesktopError::Message("invalid profile id".to_string()))
    }
}

fn find_profile(app: &AppHandle, profile_id: &str) -> Result<MountProfile, DesktopError> {
    validate_profile_id(profile_id)?;
    read_profiles(app)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| DesktopError::Message("profile not found".to_string()))
}

// Uploads can be started/browsed from either a saved profile OR a live
// running mount instance that has no saved profile at all (the same "no
// profile, re-derive credentials from the live mount's own .mountOS/.config"
// pattern open_deleted_view_for_instance/open_version_view_for_instance
// already use via synthetic_profile_for_live_mount -- reused here rather
// than a second implementation of the same idea). Exactly one of
// profile_id/instance_mount_path is expected; profile_id wins if both are
// somehow set.
// A running mount instance chosen as an upload's source, carrying the
// config the frontend already captured (via getInstanceConfig) the moment
// it was selected -- discovery_url/fork/volume/access_key_id are static
// config values, not tied to the mount being currently up, so they stay
// valid to reuse even if the instance unmounts before Browse/Start actually
// runs (which can happen well after selection). Only a live local FILESYSTEM
// path genuinely needs the mount to still exist, and that's handled
// separately by the browse-mount always creating its OWN scratch mount
// rather than trusting this instance's mount_path to still be reachable.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadInstanceRef {
    mount_path: String,
    backend: Backend,
    discovery_url: String,
    fork: String,
    volume: String,
    access_key_id: String,
}

fn resolve_upload_source_profile(
    app: &AppHandle,
    profile_id: Option<&str>,
    instance: Option<&UploadInstanceRef>,
) -> Result<MountProfile, DesktopError> {
    if let Some(profile_id) = profile_id.filter(|id| !id.is_empty()) {
        return find_profile(app, profile_id);
    }
    if let Some(instance) = instance.filter(|i| !i.mount_path.is_empty()) {
        if list_contains_target(&instance.mount_path)? {
            // Still active: re-derive fresh from the live mount's own
            // config rather than trusting whatever the frontend cached,
            // matching open_deleted_view_for_instance's own precedent.
            return synthetic_profile_for_live_mount(
                &instance.mount_path,
                instance.backend.clone(),
            );
        }
        // No longer active -- fall back to the config captured at
        // selection time instead of failing outright.
        if instance.discovery_url.is_empty() && instance.access_key_id.is_empty() {
            return Err(DesktopError::Message(format!(
                "instance is no longer mounted and no cached configuration is available: {}",
                instance.mount_path
            )));
        }
        return live_mount_config_to_profile(
            &instance.mount_path,
            instance.backend.clone(),
            LiveMountConfig {
                discovery_url: instance.discovery_url.clone(),
                fork_name: instance.fork.clone(),
                access_id: instance.access_key_id.clone(),
                volume_name: instance.volume.clone(),
                volume_type: String::new(),
            },
        );
    }
    Err(DesktopError::Message(
        "either a profile or a running mount instance is required".to_string(),
    ))
}

// Download's SOURCE resolution mirrors resolve_upload_source_profile's
// profile-vs-instance shape, but the two modes genuinely differ in what they
// need here (unlike upload, where both dest modes resolve full credentials):
// DownloadSourceKind::Profile needs a real saved MountProfile (discoveryUrl/
// fork/accessKeyId) looked up by id -- no live-instance fallback the way
// upload's dest has, a download source picked from a saved profile is always
// "connect fresh" (mode B). DownloadSourceKind::Instance needs nothing from
// this at all -- SOURCE is a raw local path the caller already resolved,
// read straight through the live mount with no RPC/credentials (mirrors
// mountos-servers' detectDownloadSourceKind mode A) -- so this returns None
// rather than re-deriving a profile nothing will read.
fn resolve_download_source_profile(
    app: &AppHandle,
    source_kind: DownloadSourceKind,
    profile_id: Option<&str>,
) -> Result<Option<MountProfile>, DesktopError> {
    match source_kind {
        DownloadSourceKind::Instance => Ok(None),
        DownloadSourceKind::Profile => {
            let profile_id = profile_id.filter(|id| !id.is_empty()).ok_or_else(|| {
                DesktopError::Message(
                    "a profile is required for a remote download source".to_string(),
                )
            })?;
            Ok(Some(find_profile(app, profile_id)?))
        }
    }
}

// Destination-path Browse needs a real local folder tree to hand the native
// file picker (browseFolder), but a mountOS destination path lives on the
// REMOTE volume -- there is no existing "list a remote directory" RPC/CLI to
// call instead. Rather than build one, this mounts the volume READ-ONLY at a
// throwaway scratch path (reusing the exact same mount/spawn_daemonizing_
// and_wait machinery a real mount uses) so the native picker can browse it
// like any other local folder, then leaves it mounted for a while in case
// the user browses again soon (every click mounting+unmounting would be
// slow and noisy) but reaps it after IDLE_TIMEOUT of inactivity so it's
// never left mounted forever either. Keyed by the resolved profile's own id
// (stable per profile / per live-instance-mount-path, see MountProfile::id
// and live_mount_config_to_profile's "ext-<hash(mount_path)>").
struct BrowseMountEntry {
    local_path: PathBuf,
    last_used: Instant,
}

const BROWSE_MOUNT_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BROWSE_MOUNT_SWEEP_INTERVAL: Duration = Duration::from_secs(60);

fn browse_mounts() -> &'static Mutex<HashMap<String, BrowseMountEntry>> {
    static BROWSE_MOUNTS: OnceLock<Mutex<HashMap<String, BrowseMountEntry>>> = OnceLock::new();
    BROWSE_MOUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Only one sweeper thread ever runs at a time; it exits once the map is
// empty (nothing left to reap) rather than looping forever, and a fresh one
// is spawned the next time a browse-mount is created if the map was empty.
fn browse_sweeper_running() -> &'static Mutex<bool> {
    static RUNNING: OnceLock<Mutex<bool>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(false))
}

fn spawn_browse_mount_sweeper(app: AppHandle) {
    {
        let mut running = browse_sweeper_running()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *running {
            return;
        }
        *running = true;
    }
    thread::spawn(move || loop {
        thread::sleep(BROWSE_MOUNT_SWEEP_INTERVAL);
        let idle: Vec<(String, PathBuf)> = {
            let mounts = browse_mounts().lock().unwrap_or_else(|e| e.into_inner());
            mounts
                .iter()
                .filter(|(_, entry)| entry.last_used.elapsed() >= BROWSE_MOUNT_IDLE_TIMEOUT)
                .map(|(key, entry)| (key.clone(), entry.local_path.clone()))
                .collect()
        };
        for (key, local_path) in idle {
            // Re-check under the lock, right before the (possibly slow)
            // unmount call: a Browse click landing between the snapshot
            // above and here refreshes last_used, and this entry must not
            // be reaped out from under whatever just opened it.
            let still_idle = browse_mounts()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .is_some_and(|entry| entry.last_used.elapsed() >= BROWSE_MOUNT_IDLE_TIMEOUT);
            if !still_idle {
                continue;
            }
            let target = local_path.to_string_lossy().into_owned();
            // Best-effort: an unmount failure (busy, already gone) just means
            // this entry is retried next sweep rather than removed now, so a
            // stale registry entry can never point at something that
            // silently vanished without ever being cleaned up.
            if unmount_target_blocking(app.clone(), target, false).is_ok() {
                browse_mounts()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key);
            }
        }
        let empty = browse_mounts()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if empty {
            *browse_sweeper_running()
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = false;
            break;
        }
    });
}

fn ensure_upload_browse_mount_blocking(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let mut profile =
        resolve_upload_source_profile(&app, profile_id.as_deref(), instance.as_ref())?;
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;

    let key = profile.id.clone();
    {
        let mounts = browse_mounts().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = mounts.get(&key) {
            let local_path = entry.local_path.clone();
            drop(mounts);
            if list_contains_target(&local_path.to_string_lossy())? {
                if let Some(entry) = browse_mounts()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(&key)
                {
                    entry.last_used = Instant::now();
                }
                return Ok(local_path.to_string_lossy().into_owned());
            }
            // Reaped or otherwise gone since we last checked -- fall through
            // and mount a fresh one.
        }
    }

    // FSKit mounts are jailed to FSKIT_MOUNT_PREFIX by validate_mount_path_for_backend
    // (checked right below) -- runtime_dir lives outside that jail, so an FSKit-backed
    // scratch mount must go under the prefix instead, or every FSKit browse fails outright.
    let local_path = if matches!(profile.backend, Backend::Fskit) {
        PathBuf::from(FSKIT_MOUNT_PREFIX).join(format!("upload-browse-{}", short_hash(&key)))
    } else {
        runtime_dir(&app)?
            .join("upload-browse")
            .join(short_hash(&key))
    };
    fs::create_dir_all(&local_path)?;
    profile.read_only = true;
    profile.mount_path = local_path.to_string_lossy().into_owned();
    validate_mount_path_for_backend(&profile.backend, &profile.mount_path)?;
    reject_managed_extra_args(&profile)?;
    if !list_contains_target(&profile.mount_path)? {
        let mount_secret = resolve_satellite_secret(&profile, secret)?;
        let args = build_mount_argv(&profile);
        let suffix = short_hash(&key);
        let stderr_path = runtime_dir(&app)?.join(format!("upload-browse-{suffix}-stderr.log"));
        let stdout_path = runtime_dir(&app)?.join(format!("upload-browse-{suffix}-stdout.log"));
        let target = profile.mount_path.clone();
        spawn_daemonizing_and_wait(
            &mountos_path()?,
            &args,
            mount_secret.as_deref(),
            &stdout_path,
            &stderr_path,
            &target,
        )?;
    }
    browse_mounts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            key,
            BrowseMountEntry {
                local_path: local_path.clone(),
                last_used: Instant::now(),
            },
        );
    spawn_browse_mount_sweeper(app);
    Ok(local_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn ensure_upload_browse_mount(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_upload_browse_mount_blocking(app, profile_id, instance, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("browse mount task failed: {error}")))?
}

// Download's source-picker Browse for DownloadSourceKind::Profile, mirroring
// ensure_upload_browse_mount_blocking's scratch-mount-pool/sweeper machinery
// verbatim, with one addition: an optional AsOf launches a read-only
// `snapshot` view (build_snapshot_argv) instead of a plain `mount`
// (build_mount_argv) fork mount, so Browse can root the native folder picker
// at the exact historical tree the download will actually read from. No
// `instance` parameter -- unlike upload's dest browse (which can fall back to
// a live instance with no saved profile, see resolve_upload_source_profile),
// resolve_download_source_profile's Profile branch only ever resolves a real
// saved MountProfile by id; DownloadSourceKind::Instance (mode A) never calls
// this at all, it browses directly at the already-live instance's own
// mount_path instead (see browseDownloadSource in app-state.svelte.ts).
//
// Keyed into the SAME shared browse_mounts() map as upload's browse-mounts:
// a live/no-AsOf browse (key == profile.id) intentionally can collide with
// and reuse an upload dest browse-mount of the same profile -- both are just
// a read-only mount of that profile's fork at its current state, so sharing
// one avoids a redundant mount. An AsOf browse gets its own distinct key
// (profile.id + hash of the trimmed AsOf string) so it never collides with
// the live-state entry or with a different AsOf value.
fn ensure_download_browse_mount_blocking(
    app: AppHandle,
    profile_id: String,
    as_of: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;

    let as_of = as_of
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let key = match &as_of {
        Some(timestamp) => format!("{}@{}", profile.id, short_hash(timestamp)),
        None => profile.id.clone(),
    };
    {
        let mounts = browse_mounts().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = mounts.get(&key) {
            let local_path = entry.local_path.clone();
            drop(mounts);
            if list_contains_target(&local_path.to_string_lossy())? {
                if let Some(entry) = browse_mounts()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_mut(&key)
                {
                    entry.last_used = Instant::now();
                }
                return Ok(local_path.to_string_lossy().into_owned());
            }
            // Reaped or otherwise gone since we last checked -- fall through
            // and mount a fresh one.
        }
    }

    // Same FSKit jail as ensure_upload_browse_mount_blocking -- FSKIT_MOUNT_PREFIX
    // is the only writable/mountable root FSKit will accept.
    let local_path = if matches!(profile.backend, Backend::Fskit) {
        PathBuf::from(FSKIT_MOUNT_PREFIX).join(format!("download-browse-{}", short_hash(&key)))
    } else {
        runtime_dir(&app)?
            .join("download-browse")
            .join(short_hash(&key))
    };
    fs::create_dir_all(&local_path)?;
    profile.read_only = true;
    profile.mount_path = local_path.to_string_lossy().into_owned();
    validate_mount_path_for_backend(&profile.backend, &profile.mount_path)?;
    reject_managed_extra_args(&profile)?;
    if !list_contains_target(&profile.mount_path)? {
        let mount_secret = resolve_satellite_secret(&profile, secret)?;
        let args = match &as_of {
            Some(timestamp) => build_snapshot_argv(&profile, &profile.mount_path, timestamp),
            None => build_mount_argv(&profile),
        };
        let suffix = short_hash(&key);
        let stderr_path = runtime_dir(&app)?.join(format!("download-browse-{suffix}-stderr.log"));
        let stdout_path = runtime_dir(&app)?.join(format!("download-browse-{suffix}-stdout.log"));
        let target = profile.mount_path.clone();
        spawn_daemonizing_and_wait(
            &mountos_path()?,
            &args,
            mount_secret.as_deref(),
            &stdout_path,
            &stderr_path,
            &target,
        )?;
    }
    browse_mounts()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(
            key,
            BrowseMountEntry {
                local_path: local_path.clone(),
                last_used: Instant::now(),
            },
        );
    spawn_browse_mount_sweeper(app);
    Ok(local_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn ensure_download_browse_mount(
    app: AppHandle,
    profile_id: String,
    as_of: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_download_browse_mount_blocking(app, profile_id, as_of, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("browse mount task failed: {error}")))?
}

fn read_profiles(app: &AppHandle) -> Result<Vec<MountProfile>, DesktopError> {
    let mut profiles: Vec<MountProfile> = Vec::new();
    for entry in fs::read_dir(profile_dir(app)?)? {
        let entry = entry?;
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        profiles.push(serde_json::from_slice(&bytes)?);
    }
    profiles.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(profiles)
}

// SECURITY BOUNDARY, hand-synced against a separate repo. These two flag
// sets (and their TS mirrors in src/lib/cli.ts) are what stops a profile's
// "extra args" field from overriding security-sensitive managed flags
// (discovery URL, credentials, mount target). They must be updated whenever
// mountos-servers' cmd/mfuse CLI adds a new flag -- especially a new
// value-taking SHORT flag, since validate_extra_args's short-cluster scan
// only special-cases '-o' as a value-absorbing flag; any other new
// value-taking short flag would need the same treatment or it risks being
// silently misparsed. No automated check currently catches drift here.
fn managed_flags() -> HashSet<&'static str> {
    [
        "a",
        "access-key-id",
        "s",
        "secret-access-key",
        "discovery-url",
        "m",
        "mount",
        "mount-point",
        "destination",
        "f",
        "foreground",
        "gateway",
        "gateway-only",
        "fork-name",
        "volname",
        "n",
        "read-only",
        "r",
        "disk-cache-dir",
        "disk-cache-size",
        "backend",
        "macfuse",
        "fskit",
        "k",
        "nfs",
        "N",
        "smb",
        "temporary-fork",
    ]
    .into_iter()
    .collect()
}

// gateway-* flags are deliberately excluded: validate_extra_args rejects any
// long flag starting with "gateway-" outright (see the `name.starts_with
// ("gateway-")` check below), regardless of what's listed here. Gateway
// launches have their own dedicated fields and argv builder
// (build_gateway_argv/open_gateway) rather than the extraArgs escape hatch,
// so smuggling gateway-* through extraArgs stays rejected on a mount profile.
fn boolean_long_flags() -> HashSet<&'static str> {
    [
        "acl",
        "agent",
        "blockserv-auto-degrade",
        "browse",
        "debug",
        "disable-cache-dir",
        "ioctl",
        "null-permissions",
        "session-audit",
        "xattr",
    ]
    .into_iter()
    .collect()
}

fn validate_extra_args(args: &[String]) -> Vec<String> {
    let managed = managed_flags();
    let boolean_flags = boolean_long_flags();
    let mut rejected = Vec::new();

    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if !arg.starts_with('-') || arg == "--" {
            rejected.push(arg.clone());
            index += 1;
            continue;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or(long);
            if managed.contains(name) || name.starts_with("gateway-") {
                rejected.push(arg.clone());
                if !arg.contains('=')
                    && args
                        .get(index + 1)
                        .is_some_and(|value| !value.starts_with('-'))
                {
                    index += 1;
                    rejected.push(args[index].clone());
                }
            } else if !arg.contains('=')
                && !boolean_flags.contains(name)
                && args
                    .get(index + 1)
                    .is_some_and(|value| !value.starts_with('-'))
            {
                index += 1;
            }
            index += 1;
            continue;
        }
        for ch in arg.trim_start_matches('-').chars() {
            if managed.contains(ch.to_string().as_str()) {
                rejected.push(arg.clone());
                break;
            }
            if ch == 'o' {
                break;
            }
        }
        index += 1;
    }

    rejected
}

// Defense-in-depth, not just a save-time check: save_profile already rejects
// a managed-flag-containing extra_args before it ever reaches disk, but a
// hand-edited profile JSON file bypasses that entirely, so every call site
// that actually shells extra_args out to the CLI re-validates at use time
// too (mount_profile_blocking and the gateway combo path already did this
// inline; factored out so the satellite view-mount launchers and the
// gateway-only path -- which started emitting extra_args once
// push_cache_and_extra_args was added to them -- get the same guarantee
// instead of trusting an unrevalidated on-disk value).
fn reject_managed_extra_args(profile: &MountProfile) -> Result<(), DesktopError> {
    let rejected = validate_extra_args(&profile.extra_args);
    if rejected.is_empty() {
        Ok(())
    } else {
        Err(DesktopError::Message(format!(
            "managed extra args rejected: {}",
            rejected.join(", ")
        )))
    }
}

fn build_mount_argv(profile: &MountProfile) -> Vec<String> {
    let mut argv = vec!["mount".to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if !profile.volume.is_empty() {
        argv.extend(["--volname".to_string(), profile.volume.clone()]);
    }
    if !profile.fork.is_empty() {
        argv.extend(["--fork-name".to_string(), profile.fork.clone()]);
    }
    if !profile.mount_path.is_empty() {
        argv.extend(["-m".to_string(), profile.mount_path.clone()]);
    }
    if !profile.access_key_id.is_empty() {
        argv.extend([
            "-a".to_string(),
            profile.access_key_id.clone(),
            "-s".to_string(),
        ]);
    }
    if profile.read_only {
        argv.push("--read-only".to_string());
    }
    if profile.temporary_fork {
        argv.push("--temporary-fork".to_string());
    }
    push_cache_and_extra_args(&mut argv, profile);
    push_backend_flag(&mut argv, &profile.backend);
    argv
}

// server_standalone.go resolves disk-cache-dir and applies extraArgs
// unconditionally before branching on mount vs. deleted/version/snapshot vs.
// gateway-only -- shared by build_mount_argv and every satellite/gateway
// argv builder so a profile's configured cache dir and extra flags
// (--debug, --agent, --xattr, etc.) don't silently revert to CLI defaults
// for those launches.
fn push_cache_and_extra_args(argv: &mut Vec<String>, profile: &MountProfile) {
    if let Some(cache_dir) = &profile.cache_dir {
        if !cache_dir.is_empty() {
            argv.extend(["--disk-cache-dir".to_string(), cache_dir.clone()]);
        }
    }
    if let Some(cache_size) = &profile.cache_size {
        if !cache_size.is_empty() {
            argv.extend(["--disk-cache-size".to_string(), cache_size.clone()]);
        }
    }
    argv.extend(profile.extra_args.clone());
}

fn push_backend_flag(argv: &mut Vec<String>, backend: &Backend) {
    match backend {
        Backend::Auto => {}
        Backend::Macfuse => argv.push("--macfuse".to_string()),
        Backend::Fskit => argv.push("--fskit".to_string()),
        Backend::Nfs => argv.push("--nfs".to_string()),
        Backend::Smb => argv.push("--smb".to_string()),
        Backend::Mountosio => argv.extend(["--backend".to_string(), "mountosio".to_string()]),
    }
}

// Gives the resulting Finder/Explorer window (and the Instances-table Name
// column, sourced from `mountos list`'s own Name field) a label that visibly
// differs from the parent mount, so a snapshot/deleted/version row is never
// mistaken for a second copy of the real volume.
// Short, collision-unlikely digit suffix. Not cryptographically random --
// just needs to differ across satellite mounts of the same profile, same
// role subsec_nanos plays for the destination-folder suffix already
// generated frontend-side (see defaultViewDestination's randomDigits).
fn satellite_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:04}", nanos % 10000)
}

fn satellite_volname(profile: &MountProfile, kind: &str) -> String {
    // Short and non-linguistic: "(deleted)"/"(snapshot)"/"(version)" reads
    // fine once, but this label shows up in Finder/Explorer, `mountos list`,
    // and the GUI's own instance rows every time a satellite view is opened,
    // and a plain kind name never disambiguates two deleted-view mounts of
    // the same profile from each other.
    let abbrev = match kind {
        "snapshot" => "snap",
        "deleted" => "del",
        "version" => "ver",
        other => other,
    };
    let suffix = satellite_suffix();
    if profile.volume.is_empty() {
        format!("mountOS-{abbrev}-{suffix}")
    } else {
        format!("{}-{}-{}", profile.volume, abbrev, suffix)
    }
}

// Shared discovery-url/fork-name/volname/credential prefix for the three
// satellite view subcommands (snapshot/deleted/version). Backend/mount-path
// flags are appended by each caller since snapshot uses -m while
// deleted/version use --destination (see build_deleted_argv/build_version_argv).
fn build_satellite_prefix(subcommand: &str, profile: &MountProfile, kind: &str) -> Vec<String> {
    let mut argv = vec![subcommand.to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if !profile.fork.is_empty() {
        argv.extend(["--fork-name".to_string(), profile.fork.clone()]);
    }
    argv.extend(["--volname".to_string(), satellite_volname(profile, kind)]);
    argv
}

fn push_satellite_credentials(argv: &mut Vec<String>, profile: &MountProfile) {
    if !profile.access_key_id.is_empty() {
        argv.extend([
            "-a".to_string(),
            profile.access_key_id.clone(),
            "-s".to_string(),
        ]);
    }
}

// snapshot has no --destination flag (verified against cmd_snapshot.go): -m
// is its only mount-point flag, and it daemonizes normally (see
// spawn_daemonizing_and_wait).
fn build_snapshot_argv(profile: &MountProfile, destination: &str, timestamp: &str) -> Vec<String> {
    let mut argv = build_satellite_prefix("snapshot", profile, "snapshot");
    argv.extend(["-m".to_string(), destination.to_string()]);
    // Trimmed here, not just by the caller: ParseSnapshotTime doesn't trim,
    // so surrounding whitespace would otherwise reach argv as part of a
    // single fused token and fail to parse server-side.
    // Fused form: the CLI's own --timestamp examples document leading-minus
    // relative values ("-1d"), which a separate `--timestamp -1d` token pair
    // would risk pflag misparsing as another flag.
    argv.push(format!("--timestamp={}", timestamp.trim()));
    push_satellite_credentials(&mut argv, profile);
    push_cache_and_extra_args(&mut argv, profile);
    push_backend_flag(&mut argv, &profile.backend);
    argv
}

// deleted/version take --destination (now wired server-side to behave as an
// -m alias, see mountos-servers cmd_deleted.go/cmd_version.go) and never
// daemonize (Foreground is hardcoded true server-side), so their readiness
// is polled rather than awaited on child exit (see
// spawn_foreground_view_and_poll).
fn build_deleted_argv(
    profile: &MountProfile,
    destination: &str,
    from: Option<&str>,
    idle_timeout: Option<&str>,
) -> Vec<String> {
    let mut argv = build_satellite_prefix("deleted", profile, "deleted");
    argv.extend(["--destination".to_string(), destination.to_string()]);
    if let Some(from) = from.map(str::trim).filter(|value| !value.is_empty()) {
        argv.push(format!("--from={from}"));
    }
    if let Some(idle) = idle_timeout
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        argv.push(format!("--idle-timeout={idle}"));
    }
    push_satellite_credentials(&mut argv, profile);
    push_cache_and_extra_args(&mut argv, profile);
    push_backend_flag(&mut argv, &profile.backend);
    argv
}

// Exactly one of path/inode is expected (validated by the caller before this
// runs); path is preferred if both are somehow set. path lets the CLI
// resolve inode/parent/name itself via stat(2) and enables multi-key
// discovery (see mountos-servers cmd_version.go); inode is the advanced/
// power-user fallback, a plain by-inode lookup only.
fn build_version_argv(
    profile: &MountProfile,
    destination: &str,
    path: Option<&str>,
    inode: Option<u64>,
    version_format: Option<&str>,
    idle_timeout: Option<&str>,
    full_chain: bool,
) -> Vec<String> {
    let mut argv = build_satellite_prefix("version", profile, "version");
    argv.extend(["--destination".to_string(), destination.to_string()]);
    if let Some(path) = path {
        argv.extend(["--path".to_string(), path.to_string()]);
    } else if let Some(inode) = inode {
        argv.extend(["-i".to_string(), inode.to_string()]);
    }
    if full_chain {
        argv.push("--full-chain".to_string());
    }
    if let Some(format) = version_format
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "number")
    {
        argv.push(format!("--version-format={format}"));
    }
    if let Some(idle) = idle_timeout
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        argv.push(format!("--idle-timeout={idle}"));
    }
    push_satellite_credentials(&mut argv, profile);
    push_cache_and_extra_args(&mut argv, profile);
    push_backend_flag(&mut argv, &profile.backend);
    argv
}

// Rejects a name that would be misparsed as a flag by cobra's positional-arg
// scanner rather than surfaced as a friendly "fork name is required" error.
fn validate_fork_name(name: &str) -> Result<String, DesktopError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(DesktopError::Message("fork name is required".to_string()));
    }
    if trimmed.starts_with('-') {
        return Err(DesktopError::Message(
            "fork name must not start with '-'".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

// No --type flag is ever emitted: it defaults to "general" server-side, and
// iceberg-typed volumes have no profile representation in this GUI yet.
// No volume-identifying flag is needed either (verified: forkConnect() in
// cmd_fork.go scopes the volume from the access key alone).
fn build_fork_list_argv(profile: &MountProfile) -> Vec<String> {
    let mut argv = vec!["fork".to_string(), "list".to_string(), "--json".to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

fn build_fork_create_argv(
    profile: &MountProfile,
    name: &str,
    parent: Option<&str>,
    as_of: Option<&str>,
) -> Vec<String> {
    let mut argv = vec!["fork".to_string(), "create".to_string(), name.to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if let Some(parent) = parent.map(str::trim).filter(|value| !value.is_empty()) {
        argv.push(format!("--parent={parent}"));
    }
    if let Some(as_of) = as_of.map(str::trim).filter(|value| !value.is_empty()) {
        argv.push(format!("--as-of={as_of}"));
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

fn build_fork_delete_argv(profile: &MountProfile, name: &str, force: bool) -> Vec<String> {
    let mut argv = vec!["fork".to_string(), "delete".to_string(), name.to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if force {
        argv.push("--force".to_string());
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

fn build_fork_restore_argv(profile: &MountProfile, name: &str) -> Vec<String> {
    let mut argv = vec!["fork".to_string(), "restore".to_string(), name.to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

// Server-side re-check for whatever a user typed/pasted into source/dest --
// not itself the security boundary (build_upload_start_argv's own "--"
// separator is what actually makes an arbitrary value safe in argv), but a
// value starting with '-' is *rejected outright* here rather than silently
// forwarded, since even though "--" prevents it from being misparsed as a
// flag, a destination that's literally "-rf" or "--restart" is almost
// certainly a mistake (a stray paste, a copy-paste of a flag instead of a
// path) the user would want to know about before a real upload starts.
// Mirrors uploadjob.validJobID server-side (cmd/mfuse/uploadjob/job.go):
// exactly 16 lowercase hex characters, the only shape FolderJobID/
// ProfileJobID ever produce. job_id reaches resume/cancel/retry-failed as a
// bare positional with no `--` separator ahead of it (unlike source/dest),
// so a value shaped like a flag would otherwise be eaten by pflag and
// surface as a confusing cobra arity error instead of a clear one here.
fn validate_upload_job_id(job_id: &str) -> Result<(), DesktopError> {
    let valid = job_id.len() == 16
        && job_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if valid {
        Ok(())
    } else {
        Err(DesktopError::Message(format!("invalid job id: {job_id:?}")))
    }
}

fn validate_upload_positional(value: &str, field: &str) -> Result<(), DesktopError> {
    if value.starts_with('-') {
        return Err(DesktopError::Message(format!(
            "{field} must not start with '-': {value:?}"
        )));
    }
    if value.contains('\0') {
        return Err(DesktopError::Message(format!(
            "{field} must not contain a NUL byte"
        )));
    }
    Ok(())
}

// The upload run form's flag surface, confirmed against cmd_upload.go: --fork
// (not --fork-name, unlike every mount/fork/gateway builder above), plus
// --once/--overwrite/--dry-run/--rescan-interval/--restart/--bwlimit/
// --include/--exclude/--follow-symlinks/--create-source-directory, all only
// on the top-level `upload <source> <dest>`. Included even for a dry run
// (harmless -- runUploadDryRun never reads --fork/credentials at all, and
// cobra parses global flags regardless of which branch RunE takes), so this
// one builder covers both branches upload_start_blocking takes.
fn build_upload_start_argv(
    profile: &MountProfile,
    source: &str,
    dest: &str,
    params: &UploadStartParams,
) -> Vec<String> {
    // Every flag first, source/dest last behind a literal "--": pflag scans
    // the whole token stream for anything starting with '-' regardless of
    // position, so a source/dest value that happens to look like a flag
    // (a folder genuinely named "-tmp", a pasted "--restart") would
    // otherwise be misparsed as a NEW flag instead of the positional
    // argument it is. "--" unconditionally ends flag parsing, so everything
    // after it reaches cobra as the two positional args no matter what it
    // contains -- this is the one argv shape that's actually safe for
    // arbitrary user input, not just typical-looking paths.
    let mut argv = vec!["upload".to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    // Fork is always derived from the resolved profile (saved profile or
    // live/cached instance config), never a free-typed value -- there is no
    // form field for it anymore.
    if !profile.fork.is_empty() {
        argv.extend(["--fork".to_string(), profile.fork.clone()]);
    }
    if params.once {
        argv.push("--once".to_string());
    }
    if params.overwrite {
        argv.push("--overwrite".to_string());
    }
    if params.dry_run {
        argv.push("--dry-run".to_string());
    }
    if let Some(interval) = params
        .rescan_interval
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        argv.extend(["--rescan-interval".to_string(), interval.to_string()]);
    }
    if params.restart {
        argv.push("--restart".to_string());
    }
    if let Some(bwlimit) = params.bwlimit.filter(|v| *v > 0) {
        argv.extend(["--bwlimit".to_string(), bwlimit.to_string()]);
    }
    for pattern in params
        .include
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        argv.extend(["--include".to_string(), pattern.to_string()]);
    }
    for pattern in params
        .exclude
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        argv.extend(["--exclude".to_string(), pattern.to_string()]);
    }
    if params.follow_symlinks {
        argv.push("--follow-symlinks".to_string());
    }
    if params.create_source_directory {
        argv.push("--create-source-directory".to_string());
    }
    push_satellite_credentials(&mut argv, profile);
    argv.extend(["--".to_string(), source.to_string(), dest.to_string()]);
    argv
}

// `resume` re-registers only --once/--rescan-interval on its own subcommand
// (cobra local flags on the parent `upload` command aren't inherited by
// subcommands -- confirmed the hard way server-side, see cmd_upload_
// subcommands.go), so this builder's flag surface is deliberately smaller
// than build_upload_start_argv's.
fn build_upload_resume_argv(
    profile: &MountProfile,
    job_id: &str,
    once: bool,
    rescan_interval: Option<&str>,
) -> Vec<String> {
    let mut argv = vec![
        "upload".to_string(),
        "resume".to_string(),
        job_id.to_string(),
    ];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if once {
        argv.push("--once".to_string());
    }
    if let Some(interval) = rescan_interval.map(str::trim).filter(|v| !v.is_empty()) {
        argv.extend(["--rescan-interval".to_string(), interval.to_string()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

// list/cancel/retry-failed/prune are all purely local (job dir + control
// socket, confirmed against cmd_list_upload.go/cmd_upload_subcommands.go --
// none of the four touch resolveUploadCredentials), so unlike every builder
// above these take no MountProfile at all: no --discovery-url, no --fork, no
// satellite credentials.
fn build_upload_list_argv() -> Vec<String> {
    vec![
        "list".to_string(),
        "--kind".to_string(),
        "upload".to_string(),
        "--json".to_string(),
    ]
}

fn build_upload_cancel_argv(job_id: &str) -> Vec<String> {
    vec![
        "upload".to_string(),
        "cancel".to_string(),
        job_id.to_string(),
    ]
}

fn build_upload_retry_failed_argv(job_id: &str) -> Vec<String> {
    vec![
        "upload".to_string(),
        "retry-failed".to_string(),
        job_id.to_string(),
    ]
}

fn build_upload_finish_argv(job_id: &str) -> Vec<String> {
    vec![
        "upload".to_string(),
        "finish".to_string(),
        job_id.to_string(),
    ]
}

fn build_upload_prune_argv(keep: u32) -> Vec<String> {
    let mut argv = vec!["upload".to_string(), "prune".to_string()];
    if keep > 0 {
        argv.extend(["--keep".to_string(), keep.to_string()]);
    }
    argv
}

// `download <source> <dest>`'s flag surface, confirmed against
// cmd_download.go: --fork/--if-exists/--depth/--as-of/--dry-run/--restart/
// --bwlimit/--include/--exclude/--follow-symlinks/--create-source-directory.
// No --once/--overwrite/--rescan-interval (download never daemon-watches
// forever and --overwrite is superseded by --if-exists=overwrite).
// `profile` is None for DownloadSourceKind::Instance (mode A: SOURCE is a
// local path read straight through an already-live mount, no connection/
// credentials at all) -- discoveryUrl/fork/as-of/-a/-s are only ever emitted
// for DownloadSourceKind::Profile. Same flags-first-then-"--" ordering as
// build_upload_start_argv, for the same reason (see that function's comment).
fn build_download_start_argv(
    profile: Option<&MountProfile>,
    source_kind: DownloadSourceKind,
    source: &str,
    dest: &str,
    params: &DownloadStartParams,
) -> Vec<String> {
    let mut argv = vec!["download".to_string()];
    if source_kind == DownloadSourceKind::Profile {
        if let Some(profile) = profile {
            if !profile.discovery_url.is_empty() {
                argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
            }
            if !profile.fork.is_empty() {
                argv.extend(["--fork".to_string(), profile.fork.clone()]);
            }
        }
        if let Some(as_of) = params
            .as_of
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            argv.push(format!("--as-of={as_of}"));
        }
    }
    // Value flags with a server-side default are only emitted when they
    // diverge from it.
    if params.if_exists != "skip" {
        argv.extend(["--if-exists".to_string(), params.if_exists.clone()]);
    }
    if params.depth != 1 {
        argv.extend(["--depth".to_string(), params.depth.to_string()]);
    }
    if params.dry_run {
        argv.push("--dry-run".to_string());
    }
    if params.restart {
        argv.push("--restart".to_string());
    }
    if let Some(bwlimit) = params.bwlimit_mbps.filter(|v| *v > 0) {
        argv.extend(["--bwlimit".to_string(), bwlimit.to_string()]);
    }
    for pattern in params
        .include_globs
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        argv.extend(["--include".to_string(), pattern.to_string()]);
    }
    for pattern in params
        .exclude_globs
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        argv.extend(["--exclude".to_string(), pattern.to_string()]);
    }
    if params.follow_symlinks {
        argv.push("--follow-symlinks".to_string());
    }
    if params.create_source_directory {
        argv.push("--create-source-directory".to_string());
    }
    if source_kind == DownloadSourceKind::Profile {
        if let Some(profile) = profile {
            push_satellite_credentials(&mut argv, profile);
        }
    }
    argv.extend(["--".to_string(), source.to_string(), dest.to_string()]);
    argv
}

// `download resume <job-id>` registers no distinctive flags of its own
// (unlike `upload resume`'s --once/--rescan-interval -- download has
// neither, every run is already single-pass), but a remote-mode job still
// needs --discovery-url/-a/-s (root-inherited global flags) to reconnect.
// Same profile-emptiness-gated pattern as build_upload_resume_argv: a
// mounted-source job's profile (blank discovery_url/access_key_id) naturally
// emits neither.
fn build_download_resume_argv(profile: &MountProfile, job_id: &str) -> Vec<String> {
    let mut argv = vec![
        "download".to_string(),
        "resume".to_string(),
        job_id.to_string(),
    ];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

// list/cancel/retry-failed/prune are all purely local (job dir + control
// socket, confirmed against cmd_list_download.go/cmd_download_subcommands.go
// -- none of the four touch resolveUploadCredentials), so these take no
// MountProfile at all.
fn build_download_list_argv() -> Vec<String> {
    vec![
        "list".to_string(),
        "--kind".to_string(),
        "download".to_string(),
        "--json".to_string(),
    ]
}

fn build_download_cancel_argv(job_id: &str) -> Vec<String> {
    vec![
        "download".to_string(),
        "cancel".to_string(),
        job_id.to_string(),
    ]
}

fn build_download_retry_failed_argv(job_id: &str) -> Vec<String> {
    vec![
        "download".to_string(),
        "retry-failed".to_string(),
        job_id.to_string(),
    ]
}

fn build_download_finish_argv(job_id: &str) -> Vec<String> {
    vec![
        "download".to_string(),
        "finish".to_string(),
        job_id.to_string(),
    ]
}

fn build_download_prune_argv(keep: u32) -> Vec<String> {
    let mut argv = vec!["download".to_string(), "prune".to_string()];
    if keep > 0 {
        argv.extend(["--keep".to_string(), keep.to_string()]);
    }
    argv
}

// `mountos sink <M3U8_URL> <SINK_PATH>`'s flag surface, confirmed against
// cmd_sink.go: --fork (not --fork-name, matches upload's convention), plus
// --variant/--max-latency/--wal-max. No --config here: the desktop only
// ever drives the single-stream form, never the multi-stream YAML file. No
// once/overwrite/dryRun/bwlimit/include/exclude/follow-symlinks/
// create-source-directory either, do not carry those over from upload/
// download by habit. Same flags-first-then-"--"-then-positionals ordering
// as build_upload_start_argv, for the same reason (see that function's
// comment) -- source is an operator-supplied URL and dest a path template,
// both free text.
fn build_sink_start_argv(
    profile: &MountProfile,
    source: &str,
    dest: &str,
    params: &SinkStartParams,
) -> Vec<String> {
    let mut argv = vec!["sink".to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    if !profile.fork.is_empty() {
        argv.extend(["--fork".to_string(), profile.fork.clone()]);
    }
    if let Some(variant) = params
        .variant
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        argv.extend(["--variant".to_string(), variant.to_string()]);
    }
    if let Some(max_latency) = params
        .max_latency
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        argv.extend(["--max-latency".to_string(), max_latency.to_string()]);
    }
    if let Some(wal_max) = params
        .wal_max
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        argv.extend(["--wal-max".to_string(), wal_max.to_string()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv.extend(["--".to_string(), source.to_string(), dest.to_string()]);
    argv
}

// `sink resume <job-id>` registers no flags of its own (confirmed against
// createSinkResumeCommand, cmd_sink.go: no --variant/--max-latency/
// --wal-max on the resume subcommand, job.json already fixes those
// server-side), only the root-inherited --discovery-url/-a/-s needed to
// reconnect.
fn build_sink_resume_argv(profile: &MountProfile, job_id: &str) -> Vec<String> {
    let mut argv = vec!["sink".to_string(), "resume".to_string(), job_id.to_string()];
    if !profile.discovery_url.is_empty() {
        argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
    }
    push_satellite_credentials(&mut argv, profile);
    argv
}

// list/cancel/status are purely local (job dir + control socket, confirmed
// against cmd_sink.go/cmd_list_sink.go: none of the three call
// resolveUploadCredentials), so these take no MountProfile at all. `sink
// list` is its own subcommand, not `mountos list --kind sink` (a sink row's
// rate/lag shape doesn't fit mountListEntry's per-status counts map, see
// cmd_list_sink.go's own doc comment), so this differs from
// build_upload_list_argv/build_download_list_argv's shape.
fn build_sink_list_argv() -> Vec<String> {
    vec!["sink".to_string(), "list".to_string(), "--json".to_string()]
}

fn build_sink_cancel_argv(job_id: &str) -> Vec<String> {
    vec!["sink".to_string(), "cancel".to_string(), job_id.to_string()]
}

// Mirrors cmd_sink.go's `sink finish <job-id>`. While the job is running
// this signals a live control-socket shutdown (drains the WAL, writes the
// real EXT-X-ENDLIST, ends the job); when not running it stamps the
// terminal state directly once the WAL is already drained. Same subcommand
// either way, no separate flag, matches build_upload_finish_argv's shape.
fn build_sink_finish_argv(job_id: &str) -> Vec<String> {
    vec!["sink".to_string(), "finish".to_string(), job_id.to_string()]
}

fn build_sink_status_argv(job_id: &str) -> Vec<String> {
    vec![
        "sink".to_string(),
        "status".to_string(),
        "--job".to_string(),
        job_id.to_string(),
        "--json".to_string(),
    ]
}

fn build_sink_prune_argv(keep: u32) -> Vec<String> {
    let mut argv = vec!["sink".to_string(), "prune".to_string()];
    if keep > 0 {
        argv.extend(["--keep".to_string(), keep.to_string()]);
    }
    argv
}

// gateway-only mode uses the standalone `gateway` subcommand (no -m, no
// backend flag, no --volname -- there is no FUSE mount at all, confirmed
// against cmd_gateway.go/cmd_mount.go: -m is optional whenever
// --gateway-only is set). The mount+gateway combo instead reuses the full
// regular `mount` argv (build_mount_argv already emits -m/backend/
// credentials/--read-only/--temporary-fork/cache-dir/extraArgs) with gateway
// flags appended -- confirmed as the CLI's actual combo invocation shape
// (`mount -m <dir> --gateway s3,hdfs`, no --gateway-only).
fn build_gateway_argv(
    profile: &MountProfile,
    protocols: &[String],
    port: Option<&str>,
    gateway_only: bool,
    no_loopback: bool,
    cert_path: Option<&str>,
    key_path: Option<&str>,
) -> Vec<String> {
    let mut argv = if gateway_only {
        let mut argv = vec!["gateway".to_string()];
        if !profile.discovery_url.is_empty() {
            argv.extend(["--discovery-url".to_string(), profile.discovery_url.clone()]);
        }
        if !profile.fork.is_empty() {
            argv.extend(["--fork-name".to_string(), profile.fork.clone()]);
        }
        if profile.temporary_fork {
            argv.push("--temporary-fork".to_string());
        }
        push_satellite_credentials(&mut argv, profile);
        push_cache_and_extra_args(&mut argv, profile);
        argv
    } else {
        build_mount_argv(profile)
    };
    if !protocols.is_empty() {
        argv.extend(["--gateway".to_string(), protocols.join(",")]);
    }
    if let Some(port) = port.filter(|value| !value.trim().is_empty()) {
        argv.extend(["--gateway-port".to_string(), port.trim().to_string()]);
    }
    if no_loopback {
        argv.push("--gateway-no-loopback".to_string());
    }
    if let (Some(cert), Some(key)) = (
        cert_path.filter(|value| !value.trim().is_empty()),
        key_path.filter(|value| !value.trim().is_empty()),
    ) {
        argv.extend([
            "--gateway-cert".to_string(),
            cert.trim().to_string(),
            "--gateway-key".to_string(),
            key.trim().to_string(),
        ]);
    }
    argv
}

fn validate_backend_for_platform(backend: &Backend) -> Result<(), DesktopError> {
    let valid = match std::env::consts::OS {
        "macos" => matches!(
            backend,
            Backend::Auto | Backend::Macfuse | Backend::Fskit | Backend::Nfs | Backend::Smb
        ),
        "windows" => matches!(backend, Backend::Auto | Backend::Mountosio),
        _ => matches!(backend, Backend::Auto | Backend::Nfs),
    };
    if valid {
        Ok(())
    } else {
        Err(DesktopError::Message(format!(
            "backend is unavailable on {}",
            std::env::consts::OS
        )))
    }
}

// FSKit requires its mount point to live under this exact directory -- the
// kernel-side FSKit extension registration only resolves volumes rooted
// here, mirroring the same constraint the mos-sanity/mos-tests skills
// already document for manual FSKit testing.
const FSKIT_MOUNT_PREFIX: &str = "/Volumes/MountOS/";

fn validate_mount_path_for_backend(
    backend: &Backend,
    mount_path: &str,
) -> Result<(), DesktopError> {
    // Empty stays legal here: build_mount_argv omits -m entirely in that case
    // and the mountos CLI picks its own default. What's rejected is a NON-empty
    // value that isn't a real absolute path for this OS (Unix "/..." or a
    // Windows drive-letter path), e.g. a relative path or garbage typed into
    // the field.
    if !mount_path.is_empty() && !is_openable_target(mount_path) {
        return Err(DesktopError::Message(format!(
            "mount path must be an absolute filesystem path, got {mount_path:?}"
        )));
    }
    if matches!(backend, Backend::Fskit) {
        let trimmed = mount_path.trim_end_matches('/');
        // The prefix check below is a plain byte comparison, not a resolved
        // path check -- it never touches the filesystem (the mount point
        // usually doesn't exist yet), so a ".." component must be rejected
        // explicitly instead of relying on canonicalization to normalize it
        // away, or "/Volumes/MountOS/x/../../../etc" would pass the prefix
        // test despite resolving well outside the jail.
        let has_parent_component = Path::new(trimmed)
            .components()
            .any(|component| component == std::path::Component::ParentDir);
        if trimmed.is_empty()
            || has_parent_component
            || !(trimmed.starts_with(FSKIT_MOUNT_PREFIX)
                && trimmed.len() > FSKIT_MOUNT_PREFIX.len())
        {
            return Err(DesktopError::Message(format!(
                "FSKit requires a mount point under {FSKIT_MOUNT_PREFIX}<name>, got {mount_path:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn resolve_auto_backend(profile: &mut MountProfile) -> Result<(), DesktopError> {
    if !matches!(profile.backend, Backend::Auto) {
        return Ok(());
    }
    let output = command_output(&["check", "--json"])?;
    let value = serde_json::from_slice::<Value>(&output.stdout)?;
    let outputs = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    let usable = |feature: &str| {
        outputs.iter().any(|item| {
            item.get("feature")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case(feature))
                && (item
                    .get("supported")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || item
                        .get("capable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false))
        })
    };
    if !usable("MountOsIo") {
        return Err(DesktopError::Message(
            "no usable Windows mount backend was reported by mountos check".to_string(),
        ));
    }
    profile.backend = Backend::Mountosio;
    Ok(())
}

#[cfg(not(windows))]
fn resolve_auto_backend(_profile: &mut MountProfile) -> Result<(), DesktopError> {
    Ok(())
}

fn command_output(args: &[&str]) -> Result<std::process::Output, DesktopError> {
    let path = mountos_path()?;
    Ok(Command::new(path).args(args).output()?)
}

fn normalized_target(target: &str) -> String {
    let target = fs::canonicalize(target)
        .unwrap_or_else(|_| PathBuf::from(target))
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    #[cfg(windows)]
    {
        target.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        target
    }
}

fn targets_equal(left: &str, right: &str) -> bool {
    normalized_target(left) == normalized_target(right)
}

fn is_openable_target(target: &str) -> bool {
    if PathBuf::from(target).is_absolute() {
        return true;
    }
    #[cfg(windows)]
    {
        let bytes = target.as_bytes();
        return bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn list_contains_target(target: &str) -> Result<bool, DesktopError> {
    let output = command_output(&["list", "--json"])?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("mounts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(entries.iter().any(|entry| {
        entry
            .get("mountPath")
            .and_then(Value::as_str)
            .is_some_and(|candidate| targets_equal(candidate, target))
    }))
}

fn poll_target(target: &str, expected_present: bool, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if list_contains_target(target).is_ok_and(|present| present == expected_present) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn wait_child(child: &mut Child, timeout: Duration) -> Result<Option<ExitStatus>, DesktopError> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, DesktopError> {
    let dir = app.path().app_cache_dir()?.join("runtime");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

// Raw plain-text output from `mountos mcp <sub>`, trimmed. Per-client status
// shapes vary too much to usefully parse ("registered but stale" vs "CLI
// present, check with `claude mcp list`"), and showing the exact CLI output
// matches this app's own convention of never obscuring what the CLI said.
fn mcp_subcommand_output(sub: &str) -> Result<String, DesktopError> {
    let output = command_output(&["mcp", sub])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}").trim().to_string();
    if !output.status.success() && combined.is_empty() {
        return Err(DesktopError::Message(format!(
            "mountos mcp {sub} exited with {}",
            output.status
        )));
    }
    Ok(combined)
}

fn mcp_status_blocking() -> Result<String, DesktopError> {
    mcp_subcommand_output("status")
}

fn mcp_install_blocking() -> Result<String, DesktopError> {
    mcp_subcommand_output("install")
}

fn mcp_uninstall_blocking() -> Result<String, DesktopError> {
    mcp_subcommand_output("uninstall")
}

#[tauri::command]
async fn mcp_status() -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(mcp_status_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("mcp status task failed: {error}")))?
}

#[tauri::command]
async fn mcp_install() -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(mcp_install_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("mcp install task failed: {error}")))?
}

// Unlike command_output() (used by mount_help_blocking/mcp_subcommand_output/
// --version/check --json, none of which take -a/-s), fork subcommands need a
// piped secret, so they get their own spawn helper rather than reusing
// command_output.
fn run_cli_with_secret(
    argv: &[String],
    secret: Option<&str>,
    timeout: Duration,
) -> Result<std::process::Output, DesktopError> {
    let mut child = Command::new(mountos_path()?)
        .args(argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(secret) = secret {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(secret.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
    }
    drop(child.stdin.take());
    // Drained on their own threads rather than via wait_with_output(), which
    // has no timeout variant: wait_child's kill-on-timeout closes the child's
    // end of these pipes, so a timed-out call still lets these reads reach
    // EOF and join() rather than hang.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let Some(status) = wait_child(&mut child, timeout)? else {
        return Err(DesktopError::Message(format!(
            "mountos {} timed out after {}s",
            argv.join(" "),
            timeout.as_secs()
        )));
    };
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

// Fork subcommands are one-shot TCP calls (connect, do the op, print, exit),
// not mounts -- no daemonize, no list --json polling, just exit-code +
// stdout/stderr, mirroring mount_help_blocking's shape.
fn fork_command_blocking(
    argv: Vec<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let output = run_cli_with_secret(&argv, secret.as_deref(), FORK_COMMAND_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("mountos {} exited with {}", argv.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn mount_help_blocking() -> Result<String, DesktopError> {
    let output = command_output(&["mount", "-h"])?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(DesktopError::Message(format!(
            "mountos mount -h exited with {}",
            output.status
        )));
    }
    Ok(text)
}

#[tauri::command]
async fn mount_help() -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(mount_help_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("mount help task failed: {error}")))?
}

#[tauri::command]
async fn mcp_uninstall() -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(mcp_uninstall_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("mcp uninstall task failed: {error}")))?
}

// Bundled builds ship LICENSES/ as a Tauri resource; `tauri dev` runs
// unbundled, so resource_dir() won't have it and we read straight from the
// repo checkout instead.
fn licenses_dir(app: &AppHandle) -> Result<PathBuf, DesktopError> {
    let bundled = app.path().resource_dir()?.join("LICENSES");
    if bundled.is_dir() {
        return Ok(bundled);
    }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../LICENSES"))
}

#[tauri::command]
fn get_third_party_licenses(app: AppHandle, kind: String) -> Result<Value, DesktopError> {
    let file_name = match kind.as_str() {
        "rust" => "rust.json",
        "js" => "js.json",
        _ => {
            return Err(DesktopError::Message(format!(
                "unknown license kind: {kind}"
            )))
        }
    };
    let content = fs::read_to_string(licenses_dir(&app)?.join(file_name))?;
    Ok(serde_json::from_str(&content)?)
}

// Frontend-supplied URL (a license package's repository link), so scheme-gated
// to http(s) -- open::that_detached otherwise hands whatever string it's given
// straight to the OS shell, which is a broader "open anything" primitive than
// a link needs.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), DesktopError> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(DesktopError::Message(
            "only http/https URLs can be opened".to_string(),
        ));
    }
    open::that_detached(url)?;
    Ok(())
}

// Runs `<path> --version` and checks the output starts with "mountos" --
// cheap, side-effect-free confirmation that a user-picked binary (from the
// pin-CLI-path file browser) is actually our CLI, rather than pinning
// whatever executable the file picker happened to return. stdin is closed so
// a program that reads from it can't block waiting for input; stdout/stderr
// are drained on their own threads (mirrors run_cli_with_secret) so a chatty
// candidate can't deadlock the pipe before wait_child's timeout applies.
#[tauri::command]
fn validate_cli_candidate(path: String) -> Result<String, DesktopError> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_file() {
        return Err(DesktopError::Message(format!("{path} is not a file")));
    }
    let mut child = Command::new(&candidate)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let Some(status) = wait_child(&mut child, CLI_VALIDATE_TIMEOUT)? else {
        return Err(DesktopError::Message(format!(
            "{path} --version did not respond within {}s",
            CLI_VALIDATE_TIMEOUT.as_secs()
        )));
    };
    let stdout = String::from_utf8_lossy(&stdout_handle.join().unwrap_or_default())
        .trim()
        .to_string();
    let stderr = String::from_utf8_lossy(&stderr_handle.join().unwrap_or_default())
        .trim()
        .to_string();
    if !status.success() {
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("{path} --version exited with {status}")
        } else {
            stderr
        }));
    }
    if stdout.split_whitespace().next() != Some("mountos") {
        return Err(DesktopError::Message(format!(
            "{path} does not look like the mountos CLI ({})",
            if stdout.is_empty() {
                "--version printed nothing".to_string()
            } else {
                format!("--version printed: {stdout}")
            }
        )));
    }
    Ok(stdout)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliSignatureStatus {
    verified: bool,
    detail: String,
}

// Stronger than validate_cli_candidate's "--version prints mountos" text
// sniff: checks the binary's actual code-signing signature rather than
// trusting whatever it prints. On macOS this confirms the signer is
// mountOS's own Developer ID (not just "signed by someone"). On Windows it
// only confirms the Authenticode signature is valid -- no certificate
// thumbprint is checked into this repo to pin the signer against (see
// MOUNTOS_MACOS_TEAM_ID's comment). Unsigned dev/local builds correctly
// report unverified; that's expected, not an error.
#[tauri::command]
fn verify_cli_signature(path: String) -> Result<CliSignatureStatus, DesktopError> {
    let candidate = PathBuf::from(&path);
    if !candidate.is_file() {
        return Err(DesktopError::Message(format!("{path} is not a file")));
    }
    Ok(verify_cli_signature_impl(&candidate))
}

#[cfg(target_os = "macos")]
fn verify_cli_signature_impl(path: &Path) -> CliSignatureStatus {
    let output = match Command::new("codesign")
        .args(["-dv", "--verbose=2"])
        .arg(path)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return CliSignatureStatus {
                verified: false,
                detail: format!("Could not run codesign: {error}"),
            }
        }
    };
    if !output.status.success() {
        return CliSignatureStatus {
            verified: false,
            detail: "Not signed, or the signature is invalid".to_string(),
        };
    }
    // codesign -dv writes its report to stderr, not stdout.
    let info = String::from_utf8_lossy(&output.stderr);
    let team_id = info
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .unwrap_or("");
    if team_id == MOUNTOS_MACOS_TEAM_ID {
        CliSignatureStatus {
            verified: true,
            detail: format!("Signed by mountOS (Team ID {MOUNTOS_MACOS_TEAM_ID})"),
        }
    } else if team_id.is_empty() || team_id == "not set" {
        CliSignatureStatus {
            verified: false,
            detail: "Not signed".to_string(),
        }
    } else {
        CliSignatureStatus {
            verified: false,
            detail: format!("Signed, but not by mountOS (Team ID {team_id})"),
        }
    }
}

#[cfg(windows)]
fn verify_cli_signature_impl(path: &Path) -> CliSignatureStatus {
    let script = format!(
        "(Get-AuthenticodeSignature -LiteralPath '{}').Status",
        path.display().to_string().replace('\'', "''")
    );
    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return CliSignatureStatus {
                verified: false,
                detail: format!("Could not run Get-AuthenticodeSignature: {error}"),
            }
        }
    };
    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if status == "Valid" {
        CliSignatureStatus {
            verified: true,
            detail: "Signed with a valid Authenticode signature".to_string(),
        }
    } else {
        CliSignatureStatus {
            verified: false,
            detail: format!(
                "Signature status: {}",
                if status.is_empty() {
                    "NotSigned".to_string()
                } else {
                    status
                }
            ),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn verify_cli_signature_impl(_path: &Path) -> CliSignatureStatus {
    CliSignatureStatus {
        verified: false,
        detail: "Signature verification is not available on this platform".to_string(),
    }
}

fn cli_version() -> Option<String> {
    command_output(&["--version"]).ok().and_then(|output| {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

fn parse_check(output: &std::process::Output) -> (bool, Vec<CheckIssue>) {
    parse_check_bytes(&output.stdout, &output.stderr)
}

fn parse_check_bytes(stdout: &[u8], stderr: &[u8]) -> (bool, Vec<CheckIssue>) {
    let value = match serde_json::from_slice::<Value>(stdout) {
        Ok(value) => value,
        Err(error) => {
            let stderr = String::from_utf8_lossy(stderr).trim().to_string();
            return (
                false,
                vec![CheckIssue {
                    id: "check-invalid-json".to_string(),
                    severity: "error".to_string(),
                    title: "mountos check returned invalid JSON".to_string(),
                    detail: Some(if stderr.is_empty() {
                        error.to_string()
                    } else {
                        stderr
                    }),
                    fix_command: None,
                }],
            );
        }
    };

    let outputs = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    let any_supported = outputs.iter().any(|item| {
        item.get("supported")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let mut issues = Vec::new();

    for (index, item) in outputs.iter().enumerate() {
        let feature = item
            .get("feature")
            .and_then(Value::as_str)
            .unwrap_or("Backend");
        let supported = item
            .get("supported")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if supported {
            continue;
        }
        let capable = item
            .get("capable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut details = item
            .get("checks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|check| !check.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .map(|check| {
                let name = check.get("name").and_then(Value::as_str).unwrap_or("Check");
                let reason = check
                    .get("error")
                    .or_else(|| check.get("required"))
                    .and_then(Value::as_str)
                    .unwrap_or("not ready");
                format!("{name}: {reason}")
            })
            .collect::<Vec<_>>();
        if let Some(hint) = item
            .get("hint")
            .and_then(Value::as_str)
            .filter(|hint| !hint.is_empty())
        {
            details.push(hint.to_string());
        }
        let fix_command = item
            .get("diagnostics")
            .and_then(Value::as_object)
            .and_then(|diagnostics| {
                ["openHostApp", "pluginKitAdd", "pluginKitReset"]
                    .into_iter()
                    .find_map(|key| diagnostics.get(key).and_then(Value::as_str))
            })
            .map(ToString::to_string);
        issues.push(CheckIssue {
            id: format!(
                "backend-{}-{index}",
                feature.to_ascii_lowercase().replace(' ', "-")
            ),
            severity: if any_supported { "warning" } else { "error" }.to_string(),
            title: if capable {
                format!("{feature} requires setup")
            } else {
                format!("{feature} unavailable")
            },
            detail: (!details.is_empty()).then(|| details.join("\n")),
            fix_command,
        });
    }

    if outputs.is_empty() {
        issues.push(CheckIssue {
            id: "check-empty".to_string(),
            severity: "error".to_string(),
            title: "mountos check returned no backend records".to_string(),
            detail: None,
            fix_command: None,
        });
    }
    (any_supported, issues)
}

fn parse_instances(output: &std::process::Output) -> Result<Vec<MountInstance>, DesktopError> {
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)?;
    Ok(parse_instances_value(&value))
}

fn parse_instances_value(value: &Value) -> Vec<MountInstance> {
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("mounts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    entries
        .into_iter()
        // "upload"/"download" entries (mountos-servers' `mountos list --json`
        // mixes mount + gateway + upload + download kinds unconditionally,
        // `--kind` is a CLI-side filter only) have no mountPath/backend at
        // all and would otherwise render as broken mount rows here -- every
        // existing kind check in this codebase is the binary
        // `kind !== "gateway"`, which treats anything else as a mount.
        // Uploads/downloads get their own list_uploads/list_downloads
        // commands instead.
        .filter(|entry| !matches!(entry.get("kind").and_then(Value::as_str), Some("upload") | Some("download")))
        .map(|entry| {
            let mount_path = entry
                .get("mountPath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let fs_name = entry
                .get("fsName")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let orphaned = entry.get("orphaned").and_then(Value::as_bool);
            let volume_identifier = entry
                .get("volumeIdentifier")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let gateway_endpoints = entry
                .get("gatewayEndpoints")
                .and_then(Value::as_object)
                .map(|endpoints| {
                    endpoints
                        .iter()
                        .filter_map(|(protocol, endpoint)| {
                            Some(GatewayEndpointInfo {
                                protocol: protocol.clone(),
                                url: endpoint.get("url").and_then(Value::as_str)?.to_string(),
                                region: endpoint
                                    .get("region")
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|endpoints| !endpoints.is_empty());
            // A "gateway" entry has no mountPath, so its key falls back to the
            // volume identifier (always present for both kinds) to stay unique
            // and stable across polls.
            let key = if mount_path.is_empty() {
                volume_identifier.clone().unwrap_or_default()
            } else {
                mount_path.clone()
            };
            MountInstance {
                key,
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("mountOS volume")
                    .to_string(),
                mount_path,
                fs_name,
                backend: entry
                    .get("backend")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                view_mode: entry
                    .get("viewMode")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                volume_identifier,
                volume_id: entry
                    .get("volumeId")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                unc_path: entry
                    .get("uncPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                version_inode: entry
                    .get("versionInode")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                orphaned,
                kind: entry
                    .get("kind")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                gateway_endpoints,
                pid: entry
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                // All are filled in / corrected afterward in get_system_state
                // -- listing alone can't know any of them.
                mount_time: None,
                volume_kind: None,
                temporary_fork: None,
                external: true,
                profile_id: None,
                health: if orphaned == Some(true) {
                    "lost"
                } else {
                    "healthy"
                }
                .to_string(),
            }
        })
        .collect()
}

fn scrub_secrets(input: &str) -> String {
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static SECRET_TOKEN: OnceLock<Regex> = OnceLock::new();
    let assignment = ASSIGNMENT.get_or_init(|| {
        Regex::new(r#"(?i)(secret(?:[ _-]?access[ _-]?key)?|password|authorization|auth[_-]?token)(\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,}\]]+)"#)
            .expect("valid secret assignment regex")
    });
    let bearer = BEARER
        .get_or_init(|| Regex::new(r"(?i)\bbearer\s+[^\s,}\]]+").expect("valid bearer regex"));
    let secret_token = SECRET_TOKEN
        .get_or_init(|| Regex::new(r"\b[A-Za-z0-9_+/=-]{40}\b").expect("valid secret token regex"));
    let scrubbed = assignment.replace_all(input, "$1$2[REDACTED]");
    let scrubbed = bearer.replace_all(&scrubbed, "Bearer [REDACTED]");
    secret_token
        .replace_all(&scrubbed, "[REDACTED]")
        .into_owned()
}

fn scrub_json(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let key = key.to_ascii_lowercase();
                if key.contains("secret")
                    || key.contains("password")
                    || key.contains("authorization")
                    || key.contains("auth_token")
                    || key.contains("auth-token")
                {
                    *child = Value::String("[REDACTED]".to_string());
                } else {
                    scrub_json(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_json),
        Value::String(text) => *text = scrub_secrets(text),
        _ => {}
    }
}

fn scrub_output(bytes: &[u8]) -> Value {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(mut value) => {
            scrub_json(&mut value);
            value
        }
        Err(_) => Value::String(scrub_secrets(&String::from_utf8_lossy(bytes))),
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, DesktopError> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<DesktopSettings, DesktopError> {
    let settings = match fs::read(settings_path(&app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => DesktopSettings::default(),
        Err(err) => return Err(err.into()),
    };
    set_cli_path_override(settings.cli_path_override.as_ref().map(PathBuf::from));
    Ok(settings)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    settings: DesktopSettings,
) -> Result<DesktopSettings, DesktopError> {
    validate_backend_for_platform(&settings.default_backend)?;
    // Bounded here, not just in the picker: settings.json is a plain file a user
    // can hand-edit, and a huge value would look like the list had frozen. 0 is
    // the explicit "Off" sentinel (auto-refresh disabled, manual Refresh button
    // only) -- not a busy-loop interval, since the frontend never starts a
    // timer for it.
    if let Some(seconds) = settings.poll_seconds {
        if seconds != 0 && !(1..=3600).contains(&seconds) {
            return Err(DesktopError::Message(format!(
                "refresh interval must be 0 (off) or between 1 and 3600 seconds, got {seconds}"
            )));
        }
    }
    if let Some(pinned) = &settings.cli_path_override {
        if !PathBuf::from(pinned).is_file() {
            return Err(DesktopError::Message(format!("not a file: {pinned}")));
        }
    }
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(&settings)?)?;
    set_cli_path_override(settings.cli_path_override.as_ref().map(PathBuf::from));
    Ok(settings)
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<MountProfile>, DesktopError> {
    read_profiles(&app)
}

#[tauri::command]
fn delete_profile(app: AppHandle, profile_id: String) -> Result<(), DesktopError> {
    let path = profile_path(&app, &profile_id)?;
    match keyring_entry(&profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(err) => return Err(DesktopError::Keyring(err)),
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

// Export never carries a secret; the vault entry is keyed to the local
// profile id, so the file downgrades to prompt-on-mount.
fn export_file_stem(name: &str, fallback: &str) -> String {
    let stem: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ' ') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('-').to_string();
    if stem.is_empty() {
        fallback.to_string()
    } else {
        stem
    }
}

#[tauri::command]
fn export_profile(app: AppHandle, profile_id: String) -> Result<ExportedProfile, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    profile.secret_ref = "prompt".to_string();
    let path = app.path().download_dir()?.join(format!(
        "{}.mosprofile",
        export_file_stem(&profile.name, &profile.id)
    ));
    fs::write(&path, serde_json::to_vec_pretty(&profile)?)?;
    Ok(ExportedProfile {
        path: path.display().to_string(),
    })
}

// Once a profile's volume kind is known (see detect_and_persist_volume_kind),
// its identity -- which real volume it points at -- must not silently
// change out from under it. access_key_id/discovery_url/volume are the
// identity triple; fork/backend are left editable since switching forks or
// transport doesn't repoint the profile at a different volume. A brand-new
// profile.id (not yet on disk) has no existing record and so is never
// locked, regardless of what volume_kind the incoming payload carries.
fn require_stable_identity(app: &AppHandle, profile: &MountProfile) -> Result<(), DesktopError> {
    let Ok(existing) = find_profile(app, &profile.id) else {
        return Ok(());
    };
    let Some(kind) = &existing.volume_kind else {
        return Ok(());
    };
    if existing.access_key_id != profile.access_key_id
        || existing.discovery_url != profile.discovery_url
        || existing.volume != profile.volume
    {
        return Err(DesktopError::Message(
            "this profile's identity is locked: access key ID, discovery URL, and volume \
             name cannot change once the volume kind is known (after first mount). Delete \
             and recreate the profile to point at a different volume."
                .to_string(),
        ));
    }
    if profile.volume_kind.as_deref() != Some(kind.as_str()) {
        return Err(DesktopError::Message(
            "volume kind cannot be changed once detected".to_string(),
        ));
    }
    Ok(())
}

// Reads the mounted volume's own `.mountOS/.volume-type` reserved file
// (plain text "General"/"Iceberg\n") the first time a profile mounts
// successfully, and persists it to the profile so its identity locks (see
// require_stable_identity). Best-effort and silent on any failure -- a
// volume-kind badge is not worth failing an otherwise-successful mount over,
// and the next successful mount tries again since volume_kind stays None.
fn detect_and_persist_volume_kind(app: &AppHandle, profile: &MountProfile) {
    if profile.volume_kind.is_some() {
        return;
    }
    let Ok(bytes) = fs::read(
        PathBuf::from(&profile.mount_path)
            .join(".mountOS")
            .join(".volume-type"),
    ) else {
        return;
    };
    let kind = String::from_utf8_lossy(&bytes).trim().to_ascii_lowercase();
    if kind.is_empty() {
        return;
    }
    let Ok(path) = profile_path(app, &profile.id) else {
        return;
    };
    // Re-read the on-disk profile immediately before writing, rather than
    // reusing the in-memory `profile` argument: by this point it may carry
    // an in-memory-only mutation (e.g. resolve_auto_backend resolving
    // "auto" to a concrete backend just for this mount attempt) that must
    // never be persisted, and a concurrent save_profile may have landed
    // while the mount was in flight.
    let Ok(bytes) = fs::read(&path) else {
        return;
    };
    let Ok(mut updated) = serde_json::from_slice::<MountProfile>(&bytes) else {
        return;
    };
    updated.volume_kind = Some(kind);
    if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
        let _ = fs::write(path, bytes);
    }
}

// Mirrors the daemon/CLI's own friendly-name generator: same word lists
// (kept in sync so a CLI-created job and a GUI-created profile draw from the
// same vocabulary) and the same "adjective-noun-xxxx" shape. Not a job/
// profile identifier, a display label only, generated once by the caller
// and then persisted as-is (here, a new profile's name field) -- so this
// doesn't need cryptographic randomness, which is why it doesn't pull in
// the `rand` crate for a cosmetic string. A splitmix64 mix seeded from
// wall-clock time, process id, and a per-process call counter is plenty to
// avoid same-instant collisions.
const FRIENDLY_ADJECTIVES: &[&str] = &[
    "amber", "arid", "auburn", "azure", "bold", "brave", "brisk", "calm", "clever", "cosmic",
    "crimson", "crisp", "daring", "dusky", "eager", "electric", "emerald", "fleet", "fluent",
    "frosty", "gentle", "golden", "grand", "hardy", "hazy", "honest", "humble", "ivory", "jade",
    "jolly", "keen", "lively", "lucid", "lunar", "mellow", "merry", "mighty", "misty", "mossy",
    "nimble", "noble", "quiet", "quick", "radiant", "rapid", "rosy", "rugged", "rustic", "sandy",
    "sharp", "silent", "silver", "sleek", "snowy", "solar", "sonic", "sparse", "steady", "stellar",
    "stormy", "sturdy", "sunny", "swift", "tidal", "vast", "velvet", "vivid", "warm", "windy",
    "wise", "witty", "zesty",
];

const FRIENDLY_NOUNS: &[&str] = &[
    "albatross", "antelope", "aurora", "badger", "basin", "beacon", "bison", "bobcat", "boulder",
    "canyon", "cascade", "cavern", "cedar", "comet", "condor", "cougar", "coyote", "crane",
    "creek", "delta", "dolphin", "dune", "eagle", "ember", "estuary", "falcon", "fern", "fjord",
    "fox", "geyser", "glacier", "gorge", "grove", "gulch", "harbor", "hawk", "heron", "hollow",
    "horizon", "ibis", "island", "jackal", "jaguar", "juniper", "kestrel", "lagoon", "lark",
    "lynx", "magpie", "marsh", "meadow", "meteor", "mirage", "moraine", "nebula", "orca", "oriole",
    "osprey", "otter", "outpost", "panther", "pelican", "phoenix", "pinnacle", "plateau",
    "prairie", "quail", "quarry", "quasar", "raven", "reef", "ridge", "sable", "savanna",
    "sequoia", "shoal", "sierra", "solstice", "sparrow", "summit", "swallow", "talon", "terrace",
    "thicket", "thistle", "tundra", "valley", "viper", "vista", "vortex", "warbler", "willow",
    "wren", "zephyr",
];

const FRIENDLY_NAME_HEX_DIGITS: &[u8] = b"0123456789abcdef";

static FRIENDLY_NAME_CALLS: AtomicU64 = AtomicU64::new(0);

fn friendly_name_splitmix64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn friendly_name_next_seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let call = FRIENDLY_NAME_CALLS.fetch_add(1, Ordering::Relaxed);
    friendly_name_splitmix64(
        nanos ^ pid.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ call.wrapping_mul(0xD6E8_FEB8_6659_FD93),
    )
}

fn random_friendly_name_value() -> String {
    let adjective = FRIENDLY_ADJECTIVES[(friendly_name_next_seed() as usize) % FRIENDLY_ADJECTIVES.len()];
    let noun = FRIENDLY_NOUNS[(friendly_name_next_seed() as usize) % FRIENDLY_NOUNS.len()];
    let mut seed = friendly_name_next_seed();
    let mut suffix = [0u8; 4];
    for byte in suffix.iter_mut() {
        *byte = FRIENDLY_NAME_HEX_DIGITS[(seed as usize) % FRIENDLY_NAME_HEX_DIGITS.len()];
        seed = friendly_name_splitmix64(seed);
    }
    // suffix is built entirely from FRIENDLY_NAME_HEX_DIGITS, always valid UTF-8.
    format!("{adjective}-{noun}-{}", std::str::from_utf8(&suffix).unwrap())
}

#[tauri::command]
fn random_friendly_name() -> String {
    random_friendly_name_value()
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: MountProfile) -> Result<MountProfile, DesktopError> {
    validate_profile_id(&profile.id)?;
    if profile.schema_version != 1 {
        return Err(DesktopError::Message(format!(
            "unsupported profile schema version {}",
            profile.schema_version
        )));
    }
    if profile.kind != "mount" {
        return Err(DesktopError::Message(
            "unsupported profile kind".to_string(),
        ));
    }
    if profile.secret_ref == "vault" && profile.access_key_id.is_empty() {
        return Err(DesktopError::Message(
            "vault storage requires an access key ID".to_string(),
        ));
    }
    // Length-only: mountOS access key IDs are fixed-length, but the exact
    // charset isn't this GUI's contract to police.
    if !profile.access_key_id.is_empty()
        && profile.access_key_id.chars().count() != ACCESS_KEY_ID_LENGTH
    {
        return Err(DesktopError::Message(format!(
            "access key ID must be {ACCESS_KEY_ID_LENGTH} characters"
        )));
    }
    require_stable_identity(&app, &profile)?;
    validate_mount_path_for_backend(&profile.backend, &profile.mount_path)?;
    reject_managed_extra_args(&profile)?;
    let path = profile_path(&app, &profile.id)?;
    fs::write(path, serde_json::to_vec_pretty(&profile)?)?;
    Ok(profile)
}

#[tauri::command]
fn set_profile_secret(profile_id: String, secret: String) -> Result<SecretStatus, DesktopError> {
    keyring_entry(&profile_id)?.set_password(&secret)?;
    Ok(SecretStatus {
        profile_id,
        stored: true,
    })
}

#[tauri::command]
fn delete_profile_secret(profile_id: String) -> Result<SecretStatus, DesktopError> {
    match keyring_entry(&profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(SecretStatus {
            profile_id,
            stored: false,
        }),
        Err(err) => Err(DesktopError::Keyring(err)),
    }
}

#[tauri::command]
fn get_profile_secret_status(profile_id: String) -> Result<SecretStatus, DesktopError> {
    let stored = match keyring_entry(&profile_id)?.get_password() {
        Ok(_) => true,
        Err(keyring::Error::NoEntry) => false,
        Err(err) => return Err(DesktopError::Keyring(err)),
    };
    Ok(SecretStatus { profile_id, stored })
}

fn get_system_state_blocking(app: AppHandle) -> Result<SystemState, DesktopError> {
    let cli_path = mountos_path().ok();
    let cli_path_string = cli_path.as_ref().map(|path| path.display().to_string());
    let cli_version = cli_version();
    let check_output = command_output(&["check", "--json"]);
    let (mut check_ok, mut issues) = match check_output {
        Ok(output) => parse_check(&output),
        Err(DesktopError::CliNotFound) => (
            false,
            vec![CheckIssue {
                id: "cli-missing".to_string(),
                severity: "error".to_string(),
                title: "mountos binary not found".to_string(),
                detail: Some(
                    "No mountos binary was found on PATH. Install the mountos CLI, or if it's \
                     already installed somewhere non-standard, pin its exact path under \
                     Settings \u{2192} About."
                        .to_string(),
                ),
                fix_command: None,
            }],
        ),
        Err(err) => (
            false,
            vec![CheckIssue {
                id: "cli-unavailable".to_string(),
                severity: "error".to_string(),
                title: "mountos CLI unavailable".to_string(),
                detail: Some(err.to_string()),
                fix_command: None,
            }],
        ),
    };
    let mut instances =
        match command_output(&["list", "--json"]).and_then(|output| parse_instances(&output)) {
            Ok(instances) => instances,
            Err(error) => {
                check_ok = false;
                issues.push(CheckIssue {
                    id: "list-failed".to_string(),
                    severity: "error".to_string(),
                    title: "Unable to enumerate mounts".to_string(),
                    detail: Some(error.to_string()),
                    fix_command: None,
                });
                Vec::new()
            }
        };
    let profile_targets = read_profiles(&app)
        .unwrap_or_default()
        .into_iter()
        .filter(|profile| !profile.mount_path.is_empty())
        .map(|profile| (profile.id, profile.mount_path))
        .collect::<Vec<_>>();
    for instance in &mut instances {
        // Report WHICH profile matched, not just that one did: the row offers to
        // clone it, and re-deriving the match in the frontend would mean
        // duplicating targets_equal's path normalisation (/tmp vs /private/tmp)
        // where it could silently drift from this.
        instance.profile_id = profile_targets
            .iter()
            .find(|(_, target)| targets_equal(target, &instance.mount_path))
            .map(|(id, _)| id.clone());
        instance.external = instance.profile_id.is_none();
        let extras = read_instance_config_extras(&instance.mount_path);
        instance.mount_time = extras.mount_time;
        instance.volume_kind = extras.volume_kind;
        instance.temporary_fork = extras.temporary_fork;
    }
    let cli_path_alternates = other_cli_paths_on_path(cli_path.as_deref());
    Ok(SystemState {
        platform: match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            value => value,
        }
        .to_string(),
        cli_path: cli_path_string,
        cli_version,
        check_ok,
        issues,
        instances,
        cli_path_alternates,
        terminals: available_terminals(),
    })
}

#[tauri::command]
async fn get_system_state(app: AppHandle) -> Result<SystemState, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || get_system_state_blocking(app))
        .await
        .map_err(|error| DesktopError::Message(format!("system state task failed: {error}")))?
}

fn mount_profile_blocking(
    app: AppHandle,
    profile_id: String,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    validate_mount_path_for_backend(&profile.backend, &profile.mount_path)?;
    reject_managed_extra_args(&profile)?;
    if profile.mount_path.is_empty() {
        return Err(DesktopError::Message("mount path is required".to_string()));
    }
    if list_contains_target(&profile.mount_path)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {}",
            profile.mount_path
        )));
    }
    let mount_secret = if profile.access_key_id.is_empty() {
        None
    } else {
        Some(
            read_profile_secret(&profile, secret)?
                .ok_or_else(|| DesktopError::Message("secret required for mount".to_string()))?,
        )
    };
    let args = build_mount_argv(&profile);
    let stderr_path = runtime_dir(&app)?.join(format!("mount-{}-stderr.log", profile.id));
    let stdout_path = runtime_dir(&app)?.join(format!("mount-{}-stdout.log", profile.id));
    let target = profile.mount_path.clone();
    let result = spawn_daemonizing_and_wait(
        &mountos_path()?,
        &args,
        mount_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &target,
    )?;
    detect_and_persist_volume_kind(&app, &profile);
    Ok(result)
}

// Shared by mount_profile_blocking and open_snapshot_view_blocking: both
// subcommands daemonize normally (parent forks, blocks on the readiness
// pipe up to LAUNCH_TIMEOUT, exits 0 with "started with PID" on success) --
// confirmed for `snapshot` by reading cmd_snapshot.go (Config.Foreground is
// never set there, unlike deleted/version).
fn spawn_daemonizing_and_wait(
    mountos: &Path,
    args: &[String],
    secret: Option<&str>,
    stdout_path: &Path,
    stderr_path: &Path,
    ready_target: &str,
) -> Result<MountResult, DesktopError> {
    let stderr_file = fs::File::create(stderr_path)?;
    let stdout_file = fs::File::create(stdout_path)?;
    let mut child = Command::new(mountos)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()?;

    if let Some(secret) = secret {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(secret.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
    }
    drop(child.stdin.take());

    let Some(status) = wait_child(&mut child, LAUNCH_TIMEOUT)? else {
        return Err(DesktopError::Message(
            "launch timed out and the child process was terminated".to_string(),
        ));
    };
    if status.success() {
        #[cfg(windows)]
        if !poll_target(ready_target, true, WINDOWS_READY_TIMEOUT) {
            let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
            let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
            let detail = format!("{stderr}\n{stdout}").trim().to_string();
            return Err(DesktopError::Message(if detail.is_empty() {
                "process exited, but the target did not become ready within 60 seconds".to_string()
            } else {
                detail
            }));
        }
        return Ok(MountResult {
            state: "ready".to_string(),
            target: ready_target.to_string(),
        });
    }
    let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
    let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
    let detail = format!("{stderr}\n{stdout}").trim().to_string();
    let indeterminate =
        detail.contains("did not become ready within") || detail.contains("no readiness signal");
    if indeterminate && poll_target(ready_target, true, INDETERMINATE_TIMEOUT) {
        return Ok(MountResult {
            state: "ready".to_string(),
            target: ready_target.to_string(),
        });
    }
    if detail.is_empty() {
        Err(DesktopError::Message(format!(
            "mountos exited with {status}"
        )))
    } else if indeterminate {
        Err(DesktopError::Message(format!(
            "indeterminate launch did not appear in the mount table after reconciliation: {detail}"
        )))
    } else {
        Err(DesktopError::Message(detail))
    }
}

// `upload <source> <dest>` and `upload resume` daemonize the same way mount
// does (parent forks, blocks on the readiness pipe, exits 0 once
// utils.NotifyDaemonReady fires child-side) -- but unlike a mount there is
// no single mount-path-shaped target to poll for readiness, and exit code 0
// IS the confirmation. Callers re-fetch list_uploads afterward rather than
// this returning a job id, so this only needs to report success/failure, not
// a MountResult. `timeout` is caller-supplied rather than a hardcoded
// LAUNCH_TIMEOUT because --once breaks the "exit 0 means daemonized"
// assumption entirely -- it never daemonizes, exit 0 there means the job
// actually settled (see UPLOAD_ONCE_TIMEOUT's own comment).
fn spawn_daemonizing_upload_and_wait(
    mountos: &Path,
    args: &[String],
    secret: Option<&str>,
    stdout_path: &Path,
    stderr_path: &Path,
    timeout: Duration,
) -> Result<(), DesktopError> {
    let stderr_file = fs::File::create(stderr_path)?;
    let stdout_file = fs::File::create(stdout_path)?;
    let mut child = Command::new(mountos)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()?;

    if let Some(secret) = secret {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(secret.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
    }
    drop(child.stdin.take());

    let Some(status) = wait_child(&mut child, timeout)? else {
        return Err(DesktopError::Message(
            "upload launch timed out and the child process was terminated".to_string(),
        ));
    };
    if status.success() {
        return Ok(());
    }
    let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
    let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
    let detail = format!("{stderr}\n{stdout}").trim().to_string();
    Err(DesktopError::Message(if detail.is_empty() {
        format!("mountos exited with {status}")
    } else {
        detail
    }))
}

// deleted/version never daemonize (Foreground: true is hardcoded
// server-side, confirmed in cmd_deleted.go/cmd_version.go, and
// server_standalone.go skips the daemonize re-exec whenever config.Foreground
// is true): the spawned child runs the FUSE server in-process for the
// mount's lifetime and never exits on its own. This polls `list --json` for
// readiness while concurrently checking try_wait() so a fast failure (bad
// credentials, discovery error) is caught promptly rather than waiting out
// the full timeout. On success the Child handle is dropped without being
// waited on -- std::process::Child has no kill-on-drop behavior, so this
// correctly releases Rust's ownership while leaving the OS process running
// as the mount's own server, same as any other backend's detached child.
fn spawn_foreground_view_and_poll(
    mountos: &Path,
    args: &[String],
    secret: Option<&str>,
    stdout_path: &Path,
    stderr_path: &Path,
    ready_target: &str,
    timeout: Duration,
) -> Result<MountResult, DesktopError> {
    let stderr_file = fs::File::create(stderr_path)?;
    let stdout_file = fs::File::create(stdout_path)?;
    let mut child = Command::new(mountos)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()?;

    if let Some(secret) = secret {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(secret.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
    }
    drop(child.stdin.take());

    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
            let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
            let detail = format!("{stderr}\n{stdout}").trim().to_string();
            return Err(DesktopError::Message(if detail.is_empty() {
                format!("mountos exited with {status} before the view became ready")
            } else {
                detail
            }));
        }
        if list_contains_target(ready_target).unwrap_or(false) {
            // This Child IS the long-running FUSE server (Foreground is
            // hardcoded server-side for deleted/version, no daemonize/
            // re-parent ever happens) -- unlike spawn_daemonizing_and_wait's
            // tracked Child, which is always reaped by wait_child, dropping
            // this one leaks a zombie for the rest of the app's lifetime
            // (Child has no reap-on-drop). Reap it on a detached thread once
            // it eventually exits (unmount, crash, idle-timeout) without
            // blocking this call on that.
            thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(MountResult {
                state: "ready".to_string(),
                target: ready_target.to_string(),
            });
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DesktopError::Message(
                "view mount timed out before becoming ready and was terminated".to_string(),
            ));
        }
        thread::sleep(Duration::from_millis(500));
    }
}

// gateway-only has no `list --json` entry to poll for readiness at all
// (confirmed: gateway-only lifecycle has no control socket and no mount
// entry), unlike the mount+gateway combo (which reuses
// spawn_daemonizing_and_wait exactly, its ready_target being the real mount
// path). This mirrors spawn_daemonizing_and_wait's primary, non-polling path
// only: child exits 0 => ready, anything else is surfaced as-is. Gateway
// mode is NOT hardcoded Foreground server-side (verified: no such reference
// in cmd_gateway.go/cmd_mount.go), so it daemonizes normally like a regular
// mount -- this is not a new spawn contract, just the existing one without a
// target to double-check readiness against.
fn spawn_gateway_only_and_wait(
    mountos: &Path,
    args: &[String],
    secret: Option<&str>,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<MountResult, DesktopError> {
    let stderr_file = fs::File::create(stderr_path)?;
    let stdout_file = fs::File::create(stdout_path)?;
    let mut child = Command::new(mountos)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()?;

    if let Some(secret) = secret {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(secret.as_bytes())?;
            stdin.write_all(b"\n")?;
        }
    }
    drop(child.stdin.take());

    let Some(status) = wait_child(&mut child, LAUNCH_TIMEOUT)? else {
        return Err(DesktopError::Message(
            "gateway launch timed out and the child process was terminated".to_string(),
        ));
    };
    if status.success() {
        return Ok(MountResult {
            state: "ready".to_string(),
            target: "gateway".to_string(),
        });
    }
    let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
    let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
    let detail = format!("{stderr}\n{stdout}").trim().to_string();
    Err(DesktopError::Message(if detail.is_empty() {
        format!("mountos gateway exited with {status}")
    } else {
        detail
    }))
}

// Cheap non-crypto hash for log-file names: a single profile can legitimately
// drive multiple concurrent Deleted/Version/Snapshot views at different
// destinations, so profile-id-only filenames (as mount-*.log uses, fine
// there since a profile has exactly one mount_path) would collide.
fn short_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command]
async fn mount_profile(
    app: AppHandle,
    profile_id: String,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || mount_profile_blocking(app, profile_id, secret))
        .await
        .map_err(|error| DesktopError::Message(format!("mount task failed: {error}")))?
}

// Shared by the fork commands and the three satellite view-mount commands:
// resolves a profile's secret from vault or an explicitly-provided value,
// exactly like mount_profile_blocking's inline version.
fn resolve_satellite_secret(
    profile: &MountProfile,
    secret: Option<String>,
) -> Result<Option<String>, DesktopError> {
    if profile.access_key_id.is_empty() {
        Ok(None)
    } else {
        Ok(Some(read_profile_secret(profile, secret)?.ok_or_else(
            || DesktopError::Message("secret required".to_string()),
        )?))
    }
}

// Server-side re-check, not just a hidden checkbox, so fork_delete reached by
// any other in-app code path still honors the same gate as the setting. This
// is NOT a boundary against a hostile renderer: `allow_fork_force_delete`
// lives in settings.json, and save_settings writes it back verbatim, so any
// invoke() caller can flip it on with one extra call before calling
// fork_delete with force=true. Closing that would require treating the
// webview as adversarial, which no other command in this app does either
// (mount/unmount/save_profile are all equally reachable) -- accepted, same
// trust model as the rest of this file's Tauri commands.
fn require_force_delete_allowed(app: &AppHandle) -> Result<(), DesktopError> {
    if get_settings(app.clone())?.allow_fork_force_delete {
        Ok(())
    } else {
        Err(DesktopError::Message(
            "Force fork delete is disabled. Enable it in Settings first.".to_string(),
        ))
    }
}

fn fork_list_blocking(
    app: AppHandle,
    profile_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = find_profile(&app, &profile_id)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    fork_command_blocking(build_fork_list_argv(&profile), resolved_secret)
}

#[tauri::command]
async fn fork_list_raw(
    app: AppHandle,
    profile_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || fork_list_blocking(app, profile_id, secret))
        .await
        .map_err(|error| DesktopError::Message(format!("fork list task failed: {error}")))?
}

fn fork_create_blocking(
    app: AppHandle,
    profile_id: String,
    name: String,
    parent: Option<String>,
    as_of: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = find_profile(&app, &profile_id)?;
    let name = validate_fork_name(&name)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    fork_command_blocking(
        build_fork_create_argv(&profile, &name, parent.as_deref(), as_of.as_deref()),
        resolved_secret,
    )
}

#[tauri::command]
async fn fork_create(
    app: AppHandle,
    profile_id: String,
    name: String,
    parent: Option<String>,
    as_of: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        fork_create_blocking(app, profile_id, name, parent, as_of, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("fork create task failed: {error}")))?
}

fn fork_delete_blocking(
    app: AppHandle,
    profile_id: String,
    name: String,
    force: bool,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    if force {
        require_force_delete_allowed(&app)?;
    }
    let profile = find_profile(&app, &profile_id)?;
    let name = validate_fork_name(&name)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    fork_command_blocking(
        build_fork_delete_argv(&profile, &name, force),
        resolved_secret,
    )
}

#[tauri::command]
async fn fork_delete(
    app: AppHandle,
    profile_id: String,
    name: String,
    force: bool,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        fork_delete_blocking(app, profile_id, name, force, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("fork delete task failed: {error}")))?
}

fn fork_restore_blocking(
    app: AppHandle,
    profile_id: String,
    name: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = find_profile(&app, &profile_id)?;
    let name = validate_fork_name(&name)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    fork_command_blocking(build_fork_restore_argv(&profile, &name), resolved_secret)
}

#[tauri::command]
async fn fork_restore(
    app: AppHandle,
    profile_id: String,
    name: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        fork_restore_blocking(app, profile_id, name, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("fork restore task failed: {error}")))?
}

// entry.get("kind") == "upload" here comes from mountos-servers' `mountos
// list --json` mixing mount + gateway + upload kinds unconditionally
// (--kind is a CLI-side filter only) -- filtered defensively even though
// this call already passes --kind upload, so a future server change to that
// filter can't silently leak the wrong rows into the uploads list either.
fn parse_uploads_value(value: &Value) -> Vec<UploadJob> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("upload"))
        .filter_map(|entry| {
            let job_id = entry.get("jobId").and_then(Value::as_str)?.to_string();
            let counts = entry
                .get("counts")
                .and_then(Value::as_object)
                .map(|counts| {
                    counts
                        .iter()
                        .filter_map(|(status, n)| n.as_i64().map(|n| (status.clone(), n)))
                        .collect()
                })
                .unwrap_or_default();
            Some(UploadJob {
                job_id,
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                source_path: entry
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                dest_path: entry
                    .get("destPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                fork_name: entry
                    .get("forkName")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                state: entry
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("resumable")
                    .to_string(),
                counts,
                halt_reason: entry
                    .get("haltReason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                pid: entry
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                volume_id: entry
                    .get("volumeId")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                created_at: entry.get("createdAt").and_then(Value::as_i64),
                completed_at: entry.get("completedAt").and_then(Value::as_i64),
                log_path: entry
                    .get("logPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                total_bytes: entry.get("totalBytes").and_then(Value::as_i64),
                total_files: entry.get("totalFiles").and_then(Value::as_i64),
            })
        })
        .collect()
}

fn list_uploads_blocking() -> Result<Vec<UploadJob>, DesktopError> {
    let argv = build_upload_list_argv();
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = command_output(&args)?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list --kind upload failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|error| {
        DesktopError::Message(format!(
            "mountos list --kind upload returned unparseable output: {error}"
        ))
    })?;
    Ok(parse_uploads_value(&value))
}

#[tauri::command]
async fn list_uploads() -> Result<Vec<UploadJob>, DesktopError> {
    tauri::async_runtime::spawn_blocking(list_uploads_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("list uploads task failed: {error}")))?
}

fn start_upload_blocking(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    source: String,
    dest: String,
    params: UploadStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = resolve_upload_source_profile(&app, profile_id.as_deref(), instance.as_ref())?;
    let source = source.trim();
    let dest = dest.trim();
    if source.is_empty() {
        return Err(DesktopError::Message("source path is required".to_string()));
    }
    if dest.is_empty() {
        return Err(DesktopError::Message(
            "destination path is required".to_string(),
        ));
    }
    validate_upload_positional(source, "source")?;
    validate_upload_positional(dest, "destination")?;
    let argv = build_upload_start_argv(&profile, source, dest, &params);
    if params.dry_run {
        // Never connects (runUploadDryRun is checked before credentials are
        // even resolved server-side) and prints its report to stdout -- a
        // one-shot foreground call, same shape as upload_command_blocking,
        // captures and returns exactly that report text instead of waiting
        // on a daemonize confirmation that will never come. Uses
        // DRY_RUN_TIMEOUT, not FORK_COMMAND_TIMEOUT's 30s -- a dry run walks
        // the ENTIRE source tree (unlike every other one-shot upload
        // subcommand, which just touches local job state or a control
        // socket), and a large/slow-disk source can legitimately take
        // longer than that.
        return upload_command_blocking(argv, DRY_RUN_TIMEOUT);
    }
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    // A single profile can legitimately drive multiple concurrent upload
    // starts at different (source, dest) pairs (unlike a mount, which is
    // 1:1 with a profile) -- profile-id-only filenames would let one
    // launch's log-file creation truncate another's mid-write. Same
    // short_hash-of-destination convention as the Snapshot/Deleted/Version
    // views below.
    let suffix = short_hash(&format!("{source}->{dest}"));
    let stderr_path = runtime_dir(&app)?.join(format!("upload-{}-{suffix}-stderr.log", profile.id));
    let stdout_path = runtime_dir(&app)?.join(format!("upload-{}-{suffix}-stdout.log", profile.id));
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        if params.once {
            UPLOAD_ONCE_TIMEOUT
        } else {
            LAUNCH_TIMEOUT
        },
    )?;
    Ok("upload job started".to_string())
}

#[tauri::command]
async fn start_upload(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    source: String,
    dest: String,
    params: UploadStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_upload_blocking(app, profile_id, instance, source, dest, params, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("start upload task failed: {error}")))?
}

// Resume only ever needs discovery_url + access_key_id -- build_upload_
// resume_argv reads neither volume/fork/mountPath/backend from its profile
// (job.json already fixes those server-side; a job resumes purely by id).
// This lets Resume work for ANY job, including one started from the CLI
// with no corresponding saved GUI profile at all: the caller supplies
// discovery_url/access_key_id directly (the frontend defaults them from a
// matching saved profile when one is selected, but they're always
// editable) instead of requiring a profile_id lookup. Backend is never
// read by this argv builder; Auto is just a neutral placeholder.
fn resume_profile(discovery_url: String, access_key_id: String) -> MountProfile {
    MountProfile {
        id: "resume".to_string(),
        schema_version: 1,
        kind: "mount".to_string(),
        name: String::new(),
        volume: String::new(),
        fork: String::new(),
        mount_path: String::new(),
        discovery_url,
        access_key_id,
        secret_ref: "prompt".to_string(),
        backend: Backend::Auto,
        cache_dir: None,
        cache_size: None,
        read_only: false,
        auto_remount: false,
        temporary_fork: false,
        trusted_discovery_host: None,
        extra_args: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
        volume_kind: None,
    }
}

// An access key id has exactly one matching secret (it encodes a specific
// user+volume pairing server-side), so Resume doesn't need the caller to
// pick a saved profile -- if a saved profile happens to share this access
// key id, reuse whatever secret is already cached for it; otherwise fall
// through to requiring an explicit secret, exactly like resolve_satellite_
// secret's own "not cached, ask for it" behavior.
// Pulled out of resolve_secret_for_access_key as a pure function so the
// matching logic is unit-testable without a real AppHandle. Matches on
// BOTH access_key_id AND secret_ref == "vault" together, not access_key_id
// alone -- multiple saved profiles can share one access key id (e.g. one
// created via "save as profile" off a live mount, another added manually),
// and if the first one found (read_profiles sorts newest-updated-first) has
// secret_ref == "prompt" while an older sibling has the actual cached vault
// secret, matching on access_key_id alone would shadow the vault entry that
// actually exists and wrongly demand a fresh secret every time.
fn matching_vault_profile<'a>(
    profiles: &'a [MountProfile],
    access_key_id: &str,
) -> Option<&'a MountProfile> {
    profiles
        .iter()
        .find(|profile| profile.access_key_id == access_key_id && profile.secret_ref == "vault")
}

fn resolve_secret_for_access_key(
    app: &AppHandle,
    access_key_id: &str,
    secret: Option<String>,
) -> Result<Option<String>, DesktopError> {
    if access_key_id.is_empty() {
        return Ok(None);
    }
    if let Some(secret) = secret {
        return Ok(Some(secret));
    }
    let profiles = read_profiles(app)?;
    if let Some(profile) = matching_vault_profile(&profiles, access_key_id) {
        return Ok(Some(keyring_entry(&profile.id)?.get_password()?));
    }
    Err(DesktopError::Message("secret required".to_string()))
}

fn resume_upload_blocking(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    once: bool,
    rescan_interval: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let discovery_url = discovery_url.trim().to_string();
    let access_key_id = access_key_id.trim().to_string();
    if discovery_url.is_empty() {
        return Err(DesktopError::Message(
            "discovery URL is required".to_string(),
        ));
    }
    if access_key_id.is_empty() {
        return Err(DesktopError::Message(
            "access key ID is required".to_string(),
        ));
    }
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(&job_id)?;
    let resolved_secret = resolve_secret_for_access_key(&app, &access_key_id, secret)?;
    let profile = resume_profile(discovery_url, access_key_id);
    let argv = build_upload_resume_argv(&profile, &job_id, once, rescan_interval.as_deref());
    let stderr_path = runtime_dir(&app)?.join(format!("upload-resume-{job_id}-stderr.log"));
    let stdout_path = runtime_dir(&app)?.join(format!("upload-resume-{job_id}-stdout.log"));
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        if once {
            UPLOAD_ONCE_TIMEOUT
        } else {
            LAUNCH_TIMEOUT
        },
    )?;
    Ok("upload job resumed".to_string())
}

#[tauri::command]
async fn resume_upload(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    once: bool,
    rescan_interval: Option<String>,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        resume_upload_blocking(
            app,
            discovery_url,
            access_key_id,
            job_id,
            once,
            rescan_interval,
            secret,
        )
    })
    .await
    .map_err(|error| DesktopError::Message(format!("resume upload task failed: {error}")))?
}

// Upload's status/cancel/retry-failed/prune subcommands are one-shot local
// calls (control-socket or on-disk state only, no cluster connection, no
// credentials ever needed) -- same shape as fork_command_blocking/
// mount_help_blocking, kept as its own sibling rather than reused across
// features for the same naming-clarity reason those two are separate.
fn upload_command_blocking(argv: Vec<String>, timeout: Duration) -> Result<String, DesktopError> {
    let output = run_cli_with_secret(&argv, None, timeout)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("mountos {} exited with {}", argv.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn cancel_upload_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    upload_command_blocking(build_upload_cancel_argv(job_id), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn cancel_upload(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || cancel_upload_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("cancel upload task failed: {error}")))?
}

fn retry_failed_upload_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    upload_command_blocking(build_upload_retry_failed_argv(job_id), FORK_COMMAND_TIMEOUT)
}

fn finish_upload_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    upload_command_blocking(build_upload_finish_argv(job_id), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn finish_upload(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || finish_upload_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("finish upload task failed: {error}")))?
}

#[tauri::command]
async fn retry_failed_upload(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || retry_failed_upload_blocking(job_id))
        .await
        .map_err(|error| {
            DesktopError::Message(format!("retry-failed upload task failed: {error}"))
        })?
}

fn prune_uploads_blocking(keep: u32) -> Result<String, DesktopError> {
    upload_command_blocking(build_upload_prune_argv(keep), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn prune_uploads(keep: u32) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || prune_uploads_blocking(keep))
        .await
        .map_err(|error| DesktopError::Message(format!("prune uploads task failed: {error}")))?
}

// entry.get("kind") == "download" here comes from `mountos list --json`
// mixing mount + gateway + upload + download kinds unconditionally (--kind
// is a CLI-side filter only) -- filtered defensively even though this call
// already passes --kind download, same reasoning as parse_uploads_value.
fn parse_downloads_value(value: &Value) -> Vec<DownloadJob> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("download"))
        .filter_map(|entry| {
            let job_id = entry.get("jobId").and_then(Value::as_str)?.to_string();
            let counts = entry
                .get("counts")
                .and_then(Value::as_object)
                .map(|counts| {
                    counts
                        .iter()
                        .filter_map(|(status, n)| n.as_i64().map(|n| (status.clone(), n)))
                        .collect()
                })
                .unwrap_or_default();
            Some(DownloadJob {
                job_id,
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                source_path: entry
                    .get("sourcePath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                dest_path: entry
                    .get("destPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                fork_name: entry
                    .get("forkName")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                state: entry
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("resumable")
                    .to_string(),
                counts,
                halt_reason: entry
                    .get("haltReason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                pid: entry
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                volume_id: entry
                    .get("volumeId")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                created_at: entry.get("createdAt").and_then(Value::as_i64),
                completed_at: entry.get("completedAt").and_then(Value::as_i64),
                log_path: entry
                    .get("logPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                total_bytes: entry.get("totalBytes").and_then(Value::as_i64),
                total_files: entry.get("totalFiles").and_then(Value::as_i64),
            })
        })
        .collect()
}

fn list_downloads_blocking() -> Result<Vec<DownloadJob>, DesktopError> {
    let argv = build_download_list_argv();
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = command_output(&args)?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list --kind download failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|error| {
        DesktopError::Message(format!(
            "mountos list --kind download returned unparseable output: {error}"
        ))
    })?;
    Ok(parse_downloads_value(&value))
}

#[tauri::command]
async fn list_downloads() -> Result<Vec<DownloadJob>, DesktopError> {
    tauri::async_runtime::spawn_blocking(list_downloads_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("list downloads task failed: {error}")))?
}

// Unlike upload_command_blocking (list/cancel/retry-failed/prune-only, never
// needs a secret), download's dry-run branch genuinely connects for a
// remote source (see start_download_blocking's own comment) and needs the
// resolved secret piped through, so this takes one explicitly rather than
// hardcoding None.
fn download_command_blocking(
    argv: Vec<String>,
    secret: Option<String>,
    timeout: Duration,
) -> Result<String, DesktopError> {
    let output = run_cli_with_secret(&argv, secret.as_deref(), timeout)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("mountos {} exited with {}", argv.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn start_download_blocking(
    app: AppHandle,
    source_kind: DownloadSourceKind,
    profile_id: Option<String>,
    source: String,
    dest: String,
    params: DownloadStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = resolve_download_source_profile(&app, source_kind, profile_id.as_deref())?;
    let source = source.trim();
    let dest = dest.trim();
    if source.is_empty() {
        return Err(DesktopError::Message("source path is required".to_string()));
    }
    if dest.is_empty() {
        return Err(DesktopError::Message(
            "destination path is required".to_string(),
        ));
    }
    validate_upload_positional(source, "source")?;
    validate_upload_positional(dest, "destination")?;
    let argv = build_download_start_argv(profile.as_ref(), source_kind, source, dest, &params);

    // Mode A (Instance) never resolves a secret -- profile is None, so this
    // short-circuits explicitly rather than depending on resolve_satellite_
    // secret's own empty-access-key-id branch.
    let resolved_secret = match &profile {
        Some(profile) => resolve_satellite_secret(profile, secret)?,
        None => None,
    };

    if params.dry_run {
        // Unlike upload's dry-run (never connects -- upload's SOURCE is
        // always local disk, confirmed by cmd_upload.go's own "no
        // connection, no writes" flag help text), a mode-B download's
        // dry-run genuinely connects to discover the remote source
        // (runDownloadDryRun calls resolveUploadCredentials for a
        // non-mounted source, cmd_download.go) -- the resolved secret must
        // actually be piped here, not dropped the way upload_command_
        // blocking's None does.
        return download_command_blocking(argv, resolved_secret, DRY_RUN_TIMEOUT);
    }

    let suffix = short_hash(&format!("{source}->{dest}"));
    let profile_key = profile.as_ref().map_or("instance", |p| p.id.as_str());
    let stderr_path =
        runtime_dir(&app)?.join(format!("download-{profile_key}-{suffix}-stderr.log"));
    let stdout_path =
        runtime_dir(&app)?.join(format!("download-{profile_key}-{suffix}-stdout.log"));
    // Download always daemonizes on a successful start (shouldDaemonizeDownload,
    // cmd_download.go: `!foreground`, unconditionally -- there is no --once
    // exception the way upload has) -- exit 0 IS the daemonize confirmation,
    // never a "job settled" signal the way upload's --once path is, so
    // LAUNCH_TIMEOUT (a plain daemonize wait) applies unconditionally.
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        LAUNCH_TIMEOUT,
    )?;
    Ok("download job started".to_string())
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    source_kind: DownloadSourceKind,
    profile_id: Option<String>,
    source: String,
    dest: String,
    params: DownloadStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_download_blocking(app, source_kind, profile_id, source, dest, params, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("start download task failed: {error}")))?
}

// Unlike resume_upload_blocking (every upload job needs dest credentials,
// since upload's dest is always the remote mountOS volume regardless of
// source mode), a download job can be genuinely mode-A (mounted source) --
// discovery_url/access_key_id are both empty for one of those, and this must
// not demand them the way resume_upload_blocking unconditionally does.
fn resume_download_blocking(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let discovery_url = discovery_url.trim().to_string();
    let access_key_id = access_key_id.trim().to_string();
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(&job_id)?;
    let resolved_secret = if access_key_id.is_empty() {
        None
    } else {
        resolve_secret_for_access_key(&app, &access_key_id, secret)?
    };
    let profile = resume_profile(discovery_url, access_key_id);
    let argv = build_download_resume_argv(&profile, &job_id);
    let stderr_path = runtime_dir(&app)?.join(format!("download-resume-{job_id}-stderr.log"));
    let stdout_path = runtime_dir(&app)?.join(format!("download-resume-{job_id}-stdout.log"));
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        LAUNCH_TIMEOUT,
    )?;
    Ok("download job resumed".to_string())
}

#[tauri::command]
async fn resume_download(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        resume_download_blocking(app, discovery_url, access_key_id, job_id, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("resume download task failed: {error}")))?
}

fn cancel_download_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    download_command_blocking(build_download_cancel_argv(job_id), None, FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn cancel_download(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || cancel_download_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("cancel download task failed: {error}")))?
}

fn retry_failed_download_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    download_command_blocking(
        build_download_retry_failed_argv(job_id),
        None,
        FORK_COMMAND_TIMEOUT,
    )
}

#[tauri::command]
async fn retry_failed_download(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || retry_failed_download_blocking(job_id))
        .await
        .map_err(|error| {
            DesktopError::Message(format!("retry-failed download task failed: {error}"))
        })?
}

fn finish_download_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    download_command_blocking(build_download_finish_argv(job_id), None, FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn finish_download(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || finish_download_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("finish download task failed: {error}")))?
}

fn prune_downloads_blocking(keep: u32) -> Result<String, DesktopError> {
    download_command_blocking(build_download_prune_argv(keep), None, FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn prune_downloads(keep: u32) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || prune_downloads_blocking(keep))
        .await
        .map_err(|error| DesktopError::Message(format!("prune downloads task failed: {error}")))?
}

// `sink list --json` returns a plain array of sinkListEntry directly (no
// "kind" field to filter on, unlike parse_uploads_value/parse_downloads_value
// -- confirmed against cmd_list_sink.go: sink list is its own subcommand,
// never mixed with mount/upload/download/gateway kinds the way `mountos
// list --json` is).
fn parse_sinks_value(value: &Value) -> Vec<SinkJob> {
    value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let job_id = entry.get("jobId").and_then(Value::as_str)?.to_string();
            Some(SinkJob {
                job_id,
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                state: entry
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("resumable")
                    .to_string(),
                source: entry
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                sink_template: entry
                    .get("sinkTemplate")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                fork: entry
                    .get("fork")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                lag_segments: entry.get("lagSegments").and_then(Value::as_i64),
                lag_seconds: entry.get("lagSeconds").and_then(Value::as_f64),
                wal_bytes: entry.get("walBytes").and_then(Value::as_i64),
                wal_segments: entry
                    .get("walSegments")
                    .and_then(Value::as_i64)
                    .and_then(|v| i32::try_from(v).ok()),
                discontinuities: entry.get("discontinuities").and_then(Value::as_i64),
                segments_fetched: entry.get("segmentsFetched").and_then(Value::as_i64),
                bytes_committed: entry.get("bytesCommitted").and_then(Value::as_i64),
                fetch_errors: entry.get("fetchErrors").and_then(Value::as_i64),
                commit_retries: entry.get("commitRetries").and_then(Value::as_i64),
                halt_reason: entry
                    .get("haltReason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                pid: entry
                    .get("pid")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok()),
                created_at: entry.get("createdAt").and_then(Value::as_i64),
                completed_at: entry.get("completedAt").and_then(Value::as_i64),
                log_path: entry
                    .get("logPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                last_known: entry
                    .get("lastKnown")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                file_count: entry.get("fileCount").and_then(Value::as_i64),
                current_path: entry
                    .get("currentPath")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
            })
        })
        .collect()
}

fn list_sinks_blocking() -> Result<Vec<SinkJob>, DesktopError> {
    let argv = build_sink_list_argv();
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = command_output(&args)?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos sink list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|error| {
        DesktopError::Message(format!(
            "mountos sink list returned unparseable output: {error}"
        ))
    })?;
    Ok(parse_sinks_value(&value))
}

#[tauri::command]
async fn list_sinks() -> Result<Vec<SinkJob>, DesktopError> {
    tauri::async_runtime::spawn_blocking(list_sinks_blocking)
        .await
        .map_err(|error| DesktopError::Message(format!("list sinks task failed: {error}")))?
}

// sink's start/resolve-source needs are identical to upload's (a saved
// profile, or an already-mounted instance's credentials/fork) -- sink and
// upload only differ in what the positionals mean (an M3U8 URL, not a local
// path), never in how the connection is resolved -- so this reuses
// UploadInstanceRef/resolve_upload_source_profile directly rather than a
// second, identical Sink-prefixed copy.
fn sink_command_blocking(argv: Vec<String>, timeout: Duration) -> Result<String, DesktopError> {
    let output = run_cli_with_secret(&argv, None, timeout)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("mountos {} exited with {}", argv.join(" "), output.status)
        } else {
            stderr
        }));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn start_sink_blocking(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    source: String,
    dest: String,
    params: SinkStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let profile = resolve_upload_source_profile(&app, profile_id.as_deref(), instance.as_ref())?;
    let source = source.trim();
    let dest = dest.trim();
    if source.is_empty() {
        return Err(DesktopError::Message("stream URL is required".to_string()));
    }
    if dest.is_empty() {
        return Err(DesktopError::Message("sink path is required".to_string()));
    }
    validate_upload_positional(source, "stream URL")?;
    validate_upload_positional(dest, "sink path")?;
    let argv = build_sink_start_argv(&profile, source, dest, &params);
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    // A single profile can legitimately drive multiple concurrent sink
    // starts at different (source, dest) pairs, same reasoning as
    // start_upload_blocking's own suffix.
    let suffix = short_hash(&format!("{source}->{dest}"));
    let stderr_path = runtime_dir(&app)?.join(format!("sink-{}-{suffix}-stderr.log", profile.id));
    let stdout_path = runtime_dir(&app)?.join(format!("sink-{}-{suffix}-stdout.log", profile.id));
    // Sink always daemonizes on a successful start (shouldDaemonizeSink
    // parity with upload/download's default path -- sink has no --once
    // foreground-block exception the way upload does), so exit 0 IS the
    // daemonize confirmation and LAUNCH_TIMEOUT applies unconditionally.
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        LAUNCH_TIMEOUT,
    )?;
    Ok("sink job started".to_string())
}

#[tauri::command]
async fn start_sink(
    app: AppHandle,
    profile_id: Option<String>,
    instance: Option<UploadInstanceRef>,
    source: String,
    dest: String,
    params: SinkStartParams,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        start_sink_blocking(app, profile_id, instance, source, dest, params, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("start sink task failed: {error}")))?
}

fn resume_sink_blocking(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    let discovery_url = discovery_url.trim().to_string();
    let access_key_id = access_key_id.trim().to_string();
    if discovery_url.is_empty() {
        return Err(DesktopError::Message(
            "discovery URL is required".to_string(),
        ));
    }
    if access_key_id.is_empty() {
        return Err(DesktopError::Message(
            "access key ID is required".to_string(),
        ));
    }
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(&job_id)?;
    let resolved_secret = resolve_secret_for_access_key(&app, &access_key_id, secret)?;
    let profile = resume_profile(discovery_url, access_key_id);
    let argv = build_sink_resume_argv(&profile, &job_id);
    let stderr_path = runtime_dir(&app)?.join(format!("sink-resume-{job_id}-stderr.log"));
    let stdout_path = runtime_dir(&app)?.join(format!("sink-resume-{job_id}-stdout.log"));
    spawn_daemonizing_upload_and_wait(
        &mountos_path()?,
        &argv,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        LAUNCH_TIMEOUT,
    )?;
    Ok("sink job resumed".to_string())
}

#[tauri::command]
async fn resume_sink(
    app: AppHandle,
    discovery_url: String,
    access_key_id: String,
    job_id: String,
    secret: Option<String>,
) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        resume_sink_blocking(app, discovery_url, access_key_id, job_id, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("resume sink task failed: {error}")))?
}

fn cancel_sink_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    sink_command_blocking(build_sink_cancel_argv(job_id), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn cancel_sink(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || cancel_sink_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("cancel sink task failed: {error}")))?
}

// Sink's own graceful stop: unlike finish_upload/finish_download (only valid
// once a halted job's WAL is already drained), sink's control socket lets a
// RUNNING job be told to finish live. Works the same way finish_upload/
// finish_download do when the job isn't running.
fn finish_sink_blocking(job_id: String) -> Result<String, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    sink_command_blocking(build_sink_finish_argv(job_id), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn finish_sink(job_id: String) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || finish_sink_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("finish sink task failed: {error}")))?
}

fn prune_sinks_blocking(keep: u32) -> Result<String, DesktopError> {
    sink_command_blocking(build_sink_prune_argv(keep), FORK_COMMAND_TIMEOUT)
}

#[tauri::command]
async fn prune_sinks(keep: u32) -> Result<String, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || prune_sinks_blocking(keep))
        .await
        .map_err(|error| DesktopError::Message(format!("prune sinks task failed: {error}")))?
}

// Go's zero time.Time ("0001-01-01T00:00:00Z") means "never happened yet
// this run" (LastCommitAt/LastSegmentAt start zero-valued, see sink_
// runner.go's sinkMetrics), not a real timestamp -- normalized to None so
// the frontend never has to special-case that string.
fn normalize_sink_timestamp(raw: Option<&str>) -> Option<String> {
    raw.filter(|v| !v.is_empty() && *v != "0001-01-01T00:00:00Z")
        .map(ToString::to_string)
}

fn parse_sink_snapshot_value(value: &Value) -> SinkSnapshot {
    SinkSnapshot {
        state: value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        lag_segments: value
            .get("lagSegments")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        lag_seconds: value
            .get("lagSeconds")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        wal_bytes: value.get("walBytes").and_then(Value::as_i64).unwrap_or(0),
        wal_segments: value
            .get("walSegments")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or(0),
        discontinuities: value
            .get("discontinuities")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        segments_fetched: value
            .get("segmentsFetched")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        segments_committed: value
            .get("segmentsCommitted")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        bytes_committed: value
            .get("bytesCommitted")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        file_size: value.get("fileSize").and_then(Value::as_i64).unwrap_or(0),
        bitrate_observed: value
            .get("bitrateObserved")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        fetch_errors: value
            .get("fetchErrors")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        commit_retries: value
            .get("commitRetries")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        file_count: value.get("fileCount").and_then(Value::as_i64).unwrap_or(0),
        current_path: value
            .get("currentPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        last_commit_at: normalize_sink_timestamp(value.get("lastCommitAt").and_then(Value::as_str)),
        last_segment_at: normalize_sink_timestamp(
            value.get("lastSegmentAt").and_then(Value::as_str),
        ),
    }
}

fn parse_sink_status_value(value: &Value) -> Result<SinkStatus, DesktopError> {
    let job_id = value
        .get("jobId")
        .and_then(Value::as_str)
        .ok_or_else(|| DesktopError::Message("sink status: missing jobId".to_string()))?
        .to_string();
    Ok(SinkStatus {
        job_id,
        running: value
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        state: value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("resumable")
            .to_string(),
        friendly_name: value
            .get("friendlyName")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sink_template: value
            .get("sinkTemplate")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        fork: value
            .get("fork")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        halt_reason: value
            .get("haltReason")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        snapshot: value.get("snapshot").map(parse_sink_snapshot_value),
        last_known: value
            .get("lastKnown")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn sink_status_blocking(job_id: String) -> Result<SinkStatus, DesktopError> {
    let job_id = job_id.trim();
    if job_id.is_empty() {
        return Err(DesktopError::Message("job id is required".to_string()));
    }
    validate_upload_job_id(job_id)?;
    let argv = build_sink_status_argv(job_id);
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = command_output(&args)?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos sink status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout).map_err(|error| {
        DesktopError::Message(format!(
            "mountos sink status returned unparseable output: {error}"
        ))
    })?;
    parse_sink_status_value(&value)
}

#[tauri::command]
async fn get_sink_status(job_id: String) -> Result<SinkStatus, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || sink_status_blocking(job_id))
        .await
        .map_err(|error| DesktopError::Message(format!("sink status task failed: {error}")))?
}

// Shared guard for the three satellite view-mount commands: the destination
// must be a real absolute path and must differ from the parent profile's own
// mount path.
fn validate_view_destination(
    profile: &MountProfile,
    destination: &str,
) -> Result<(), DesktopError> {
    if destination.trim().is_empty() || !is_openable_target(destination) {
        return Err(DesktopError::Message(
            "destination must be an absolute filesystem path".to_string(),
        ));
    }
    // Reuses the same FSKit /Volumes/MountOS/<name> prefix check the primary
    // mount path already enforces: push_backend_flag emits --fskit for these
    // view-mounts too, so an FSKit destination is bound by the same real
    // constraint, not just a plain absolute path.
    validate_mount_path_for_backend(&profile.backend, destination)?;
    if !profile.mount_path.is_empty() && targets_equal(destination, &profile.mount_path) {
        return Err(DesktopError::Message(
            "destination must differ from the profile's own mount path".to_string(),
        ));
    }
    Ok(())
}

fn open_snapshot_view_blocking(
    app: AppHandle,
    profile_id: String,
    destination: String,
    timestamp: String,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    validate_view_destination(&profile, &destination)?;
    if timestamp.trim().is_empty() {
        return Err(DesktopError::Message("timestamp is required".to_string()));
    }
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    if list_contains_target(&destination)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {destination}"
        )));
    }
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_snapshot_argv(&profile, &destination, timestamp.trim());
    let suffix = short_hash(&destination);
    let stderr_path =
        runtime_dir(&app)?.join(format!("snapshot-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("snapshot-{}-{suffix}-stdout.log", profile.id));
    spawn_daemonizing_and_wait(
        &mountos_path()?,
        &args,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &destination,
    )
}

#[tauri::command]
async fn open_snapshot_view(
    app: AppHandle,
    profile_id: String,
    destination: String,
    timestamp: String,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_snapshot_view_blocking(app, profile_id, destination, timestamp, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("snapshot view task failed: {error}")))?
}

fn open_deleted_view_blocking(
    app: AppHandle,
    profile_id: String,
    destination: String,
    from: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    validate_view_destination(&profile, &destination)?;
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    if list_contains_target(&destination)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {destination}"
        )));
    }
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_deleted_argv(
        &profile,
        &destination,
        from.as_deref(),
        idle_timeout.as_deref(),
    );
    let suffix = short_hash(&destination);
    let stderr_path =
        runtime_dir(&app)?.join(format!("deleted-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("deleted-{}-{suffix}-stdout.log", profile.id));
    spawn_foreground_view_and_poll(
        &mountos_path()?,
        &args,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &destination,
        LAUNCH_TIMEOUT,
    )
}

#[tauri::command]
async fn open_deleted_view(
    app: AppHandle,
    profile_id: String,
    destination: String,
    from: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_deleted_view_blocking(app, profile_id, destination, from, idle_timeout, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("deleted view task failed: {error}")))?
}

// Bundling path/inode/version_format/idle_timeout/secret/full_chain into a
// struct would need the frontend's flat invoke() payload nested under a new
// key to match -- one arg per Tauri-visible field is the plainer tradeoff.
#[allow(clippy::too_many_arguments)]
fn open_version_view_blocking(
    app: AppHandle,
    profile_id: String,
    destination: String,
    path: Option<String>,
    inode: Option<String>,
    version_format: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
    full_chain: bool,
) -> Result<MountResult, DesktopError> {
    let mut profile = find_profile(&app, &profile_id)?;
    validate_view_destination(&profile, &destination)?;
    let path = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // Inodes travel as strings end-to-end (see MountInstance.version_inode):
    // a JS `number` silently loses precision above Number.MAX_SAFE_INTEGER.
    let parsed_inode: Option<u64> = match inode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => Some(
            raw.parse()
                .map_err(|_| DesktopError::Message(format!("invalid inode number: {raw:?}")))?,
        ),
        None => None,
    };
    if path.is_none() && parsed_inode.is_none() {
        return Err(DesktopError::Message(
            "provide a file path or an inode number".to_string(),
        ));
    }
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    if list_contains_target(&destination)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {destination}"
        )));
    }
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_version_argv(
        &profile,
        &destination,
        path,
        parsed_inode,
        version_format.as_deref(),
        idle_timeout.as_deref(),
        full_chain,
    );
    let suffix = short_hash(&destination);
    let stderr_path =
        runtime_dir(&app)?.join(format!("version-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("version-{}-{suffix}-stdout.log", profile.id));
    spawn_foreground_view_and_poll(
        &mountos_path()?,
        &args,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &destination,
        LAUNCH_TIMEOUT,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn open_version_view(
    app: AppHandle,
    profile_id: String,
    destination: String,
    path: Option<String>,
    inode: Option<String>,
    version_format: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
    full_chain: bool,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_version_view_blocking(
            app,
            profile_id,
            destination,
            path,
            inode,
            version_format,
            idle_timeout,
            secret,
            full_chain,
        )
    })
    .await
    .map_err(|error| DesktopError::Message(format!("version view task failed: {error}")))?
}

// Deleted/Version view for an instance with no saved profile at all --
// mounted from the terminal (or any tool outside this app). Profile is
// deliberately optional here: forcing one into existence just to open a
// satellite view would bloat the profile list for anyone who mounts from the
// CLI as their main workflow. Credentials are re-derived from the live
// mount's own .mountOS/.config instead of a persisted profile file,
// preserving the same trust boundary find_profile enforces elsewhere in this
// file -- nothing about identity or credentials is taken on the frontend's
// word, it's re-read from a source this process didn't write.
#[derive(Debug, Deserialize, Default)]
struct LiveMountConfig {
    #[serde(rename = "discoveryUrl", default)]
    discovery_url: String,
    #[serde(rename = "forkName", default)]
    fork_name: String,
    #[serde(rename = "accessId", default)]
    access_id: String,
    #[serde(rename = "volumeName", default)]
    volume_name: String,
    // "general" | "iceberg" | "" (legacy/unset, treated as general) -- same
    // casing as MountConfig.VolumeType (mfusetypes/types.go). Iceberg
    // volumes don't support Deleted/Version, mirroring the profile editor's
    // own gate (ProfilesView.svelte's `{#if selectedProfile.volumeKind !==
    // 'iceberg'}`).
    #[serde(rename = "volumeType", default)]
    volume_type: String,
}

// Pure and unit-testable on purpose: kept separate from the fs::read/
// list_contains_target I/O in synthetic_profile_for_live_mount below, which
// shells out to the real mountos binary and can't run in a test environment.
fn live_mount_config_to_profile(
    mount_path: &str,
    backend: Backend,
    config: LiveMountConfig,
) -> Result<MountProfile, DesktopError> {
    if config.volume_type.eq_ignore_ascii_case("iceberg") {
        return Err(DesktopError::Message(
            "Iceberg volumes don't support this view".to_string(),
        ));
    }
    Ok(MountProfile {
        id: format!("ext-{}", short_hash(mount_path)),
        schema_version: 1,
        kind: "mount".to_string(),
        name: config.volume_name.clone(),
        volume: config.volume_name,
        fork: config.fork_name,
        mount_path: mount_path.to_string(),
        discovery_url: config.discovery_url,
        access_key_id: config.access_id,
        // Never "vault": this profile is never persisted, so there is no
        // vault entry keyed by its (synthetic) id to read from. A non-empty
        // access_key_id still requires the frontend to supply `secret`, via
        // resolve_satellite_secret below, exactly like the profile-based
        // flow's own secret-prompt UI.
        secret_ref: "prompt".to_string(),
        backend,
        cache_dir: None,
        cache_size: None,
        read_only: false,
        auto_remount: false,
        temporary_fork: false,
        trusted_discovery_host: None,
        extra_args: Vec::new(),
        created_at: String::new(),
        updated_at: String::new(),
        volume_kind: None,
    })
}

fn synthetic_profile_for_live_mount(
    mount_path: &str,
    backend: Backend,
) -> Result<MountProfile, DesktopError> {
    if !list_contains_target(mount_path)? {
        return Err(DesktopError::Message(format!(
            "not a currently active mount: {mount_path}"
        )));
    }
    let config_path = PathBuf::from(mount_path).join(".mountOS").join(".config");
    let bytes = fs::read(&config_path).map_err(|err| {
        DesktopError::Message(format!("failed to read {}: {err}", config_path.display()))
    })?;
    let config: LiveMountConfig = serde_json::from_slice(&bytes)?;
    live_mount_config_to_profile(mount_path, backend, config)
}

fn open_deleted_view_for_instance_blocking(
    app: AppHandle,
    mount_path: String,
    backend: Backend,
    destination: String,
    from: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    let mut profile = synthetic_profile_for_live_mount(&mount_path, backend)?;
    validate_view_destination(&profile, &destination)?;
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    if list_contains_target(&destination)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {destination}"
        )));
    }
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_deleted_argv(
        &profile,
        &destination,
        from.as_deref(),
        idle_timeout.as_deref(),
    );
    let suffix = short_hash(&destination);
    let stderr_path =
        runtime_dir(&app)?.join(format!("deleted-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("deleted-{}-{suffix}-stdout.log", profile.id));
    spawn_foreground_view_and_poll(
        &mountos_path()?,
        &args,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &destination,
        LAUNCH_TIMEOUT,
    )
}

#[tauri::command]
async fn open_deleted_view_for_instance(
    app: AppHandle,
    mount_path: String,
    backend: Backend,
    destination: String,
    from: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_deleted_view_for_instance_blocking(
            app,
            mount_path,
            backend,
            destination,
            from,
            idle_timeout,
            secret,
        )
    })
    .await
    .map_err(|error| DesktopError::Message(format!("deleted view task failed: {error}")))?
}

#[allow(clippy::too_many_arguments)]
fn open_version_view_for_instance_blocking(
    app: AppHandle,
    mount_path: String,
    backend: Backend,
    destination: String,
    path: Option<String>,
    inode: Option<String>,
    version_format: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
    full_chain: bool,
) -> Result<MountResult, DesktopError> {
    let mut profile = synthetic_profile_for_live_mount(&mount_path, backend)?;
    validate_view_destination(&profile, &destination)?;
    let path = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // Inodes travel as strings end-to-end (see MountInstance.version_inode):
    // a JS `number` silently loses precision above Number.MAX_SAFE_INTEGER.
    let parsed_inode: Option<u64> = match inode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => Some(
            raw.parse()
                .map_err(|_| DesktopError::Message(format!("invalid inode number: {raw:?}")))?,
        ),
        None => None,
    };
    if path.is_none() && parsed_inode.is_none() {
        return Err(DesktopError::Message(
            "provide a file path or an inode number".to_string(),
        ));
    }
    validate_backend_for_platform(&profile.backend)?;
    resolve_auto_backend(&mut profile)?;
    if list_contains_target(&destination)? {
        return Err(DesktopError::Message(format!(
            "target is already mounted: {destination}"
        )));
    }
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_version_argv(
        &profile,
        &destination,
        path,
        parsed_inode,
        version_format.as_deref(),
        idle_timeout.as_deref(),
        full_chain,
    );
    let suffix = short_hash(&destination);
    let stderr_path =
        runtime_dir(&app)?.join(format!("version-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("version-{}-{suffix}-stdout.log", profile.id));
    spawn_foreground_view_and_poll(
        &mountos_path()?,
        &args,
        resolved_secret.as_deref(),
        &stdout_path,
        &stderr_path,
        &destination,
        LAUNCH_TIMEOUT,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn open_version_view_for_instance(
    app: AppHandle,
    mount_path: String,
    backend: Backend,
    destination: String,
    path: Option<String>,
    inode: Option<String>,
    version_format: Option<String>,
    idle_timeout: Option<String>,
    secret: Option<String>,
    full_chain: bool,
) -> Result<MountResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_version_view_for_instance_blocking(
            app,
            mount_path,
            backend,
            destination,
            path,
            inode,
            version_format,
            idle_timeout,
            secret,
            full_chain,
        )
    })
    .await
    .map_err(|error| DesktopError::Message(format!("version view task failed: {error}")))?
}

// Mirrors mountos-servers' gatewayDescriptor JSON exactly (snake_case keys
// as written by Go's `json:"..."` tags, hence no #[serde(rename_all)] here
// -- Rust's own field names already are snake_case). Deliberately reading
// this file from the GUI, overriding the original "not public GUI contract"
// caution: the only alternative is no live PID/endpoint readback at all, and
// the descriptor already excludes the secret by design (comment in
// gateway_descriptor.go), so the read is not a credential-exposure risk.
#[derive(Debug, Deserialize)]
struct GatewayDescriptorFile {
    #[serde(default)]
    endpoints: std::collections::HashMap<String, GatewayEndpointFile>,
    // Looked up by exact pid (the filename itself), so volume/fork identity
    // in the payload doesn't need cross-checking here -- kept only for the
    // `pid` assertion in tests and to document the schema shape.
    pid: i64,
}

#[derive(Debug, Deserialize)]
struct GatewayEndpointFile {
    url: String,
    #[serde(default)]
    region: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GatewayEndpointInfo {
    protocol: String,
    url: String,
    region: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLaunchResult {
    state: String,
    // None when the descriptor couldn't be found (best-effort discovery) --
    // the launch may still have succeeded; a missing PID just means the
    // Stop-gateway action won't be offered for it.
    pid: Option<u32>,
    endpoints: Vec<GatewayEndpointInfo>,
}

// Reads this launch's own `mountOS-<pid>.gateway.json` directly (written by
// writeGatewayDescriptor; the home-dir copy needs an internal volShardID this
// GUI has no way to compute, so only the tmp copy is used). Keyed by the
// EXACT pid this process parsed from its own spawned child's stdout (see
// parse_started_pid) -- deliberately not a volume-name+recency scan: this
// machine can easily have multiple gateways from unrelated launches running
// concurrently (including for the same volume), and a fuzzy match risked
// attributing a different launch's PID/endpoints to this one, which then
// fed straight into Stop-gateway. Best-effort: returns None on any I/O/parse
// failure, never an error -- a missing descriptor shouldn't fail an
// otherwise-successful launch.
fn find_gateway_descriptor(pid: u32) -> Option<GatewayDescriptorFile> {
    let path = std::env::temp_dir().join(format!("mountOS-{pid}.gateway.json"));
    let bytes = fs::read(path).ok()?;
    let descriptor = serde_json::from_slice::<GatewayDescriptorFile>(&bytes).ok()?;
    // Cheap integrity check: the file's own claimed pid must match the exact
    // pid its filename was looked up under. A mismatch means either a
    // corrupted write or a forged file (the temp dir is per-user but still
    // shared with every other process this user runs) -- either way, not a
    // descriptor this launch should trust.
    (descriptor.pid == i64::from(pid)).then_some(descriptor)
}

// The daemonizing spawn's own readiness signal (Unix's pipe, Windows'
// poll_target on the eventual mount) only orders around the FUSE mount, not
// the gateway descriptor write -- for a gateway-only launch there is no mount
// to wait on at all, and on Windows daemon_windows.go's Daemonize returns as
// soon as CreateProcess succeeds, well before the child has bound its
// listeners and written its descriptor. Poll briefly rather than accepting
// whatever's there (or isn't) on the very first read.
const GATEWAY_DESCRIPTOR_POLL_TIMEOUT: Duration = Duration::from_secs(5);

fn find_gateway_descriptor_with_retry(pid: u32) -> Option<GatewayDescriptorFile> {
    let started = Instant::now();
    loop {
        if let Some(descriptor) = find_gateway_descriptor(pid) {
            return Some(descriptor);
        }
        if started.elapsed() >= GATEWAY_DESCRIPTOR_POLL_TIMEOUT {
            return None;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

// Matches the pinned "<title> started with PID: <pid>" contract both
// daemon.go and daemon_windows.go print on their parent's stdout right
// before exiting 0 -- the same string the original desktop-gui design doc
// already treats as a stable, documented pinned string for other purposes.
fn parse_started_pid(text: &str) -> Option<u32> {
    let idx = text.find("started with PID: ")?;
    let rest = &text[idx + "started with PID: ".len()..];
    rest.split(|c: char| !c.is_ascii_digit())
        .next()
        .filter(|digits| !digits.is_empty())
        .and_then(|digits| digits.parse().ok())
}

// PIDs this process has itself discovered via a successful gateway launch's
// own stdout (see parse_started_pid) -- the only PIDs stop_gateway is willing
// to act on. Without this, stop_gateway would trust whatever u32 an
// invoke('stop_gateway', {pid}) caller supplied, name-checked only by
// pid_is_mountos_process, which can't distinguish "the gateway this app
// launched" from "any other mountOS-family process the same user has
// running" (this machine alone can have dozens, see mos-load-*).
static KNOWN_GATEWAY_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();

fn known_gateway_pids() -> &'static Mutex<HashSet<u32>> {
    KNOWN_GATEWAY_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayLaunchParams {
    protocols: Vec<String>,
    port: Option<String>,
    gateway_only: bool,
    no_loopback: bool,
    cert_path: Option<String>,
    key_path: Option<String>,
}

fn open_gateway_blocking(
    app: AppHandle,
    profile_id: String,
    params: GatewayLaunchParams,
    secret: Option<String>,
) -> Result<GatewayLaunchResult, DesktopError> {
    let GatewayLaunchParams {
        protocols,
        port,
        gateway_only,
        no_loopback,
        cert_path,
        key_path,
    } = params;
    reconcile_known_gateway_pids();
    let mut profile = find_profile(&app, &profile_id)?;
    if protocols.is_empty() {
        return Err(DesktopError::Message(
            "select at least one gateway protocol (S3 and/or HDFS)".to_string(),
        ));
    }
    if no_loopback
        && (cert_path.as_deref().unwrap_or("").trim().is_empty()
            || key_path.as_deref().unwrap_or("").trim().is_empty())
    {
        return Err(DesktopError::Message(
            "binding on all interfaces (--gateway-no-loopback) requires a TLS certificate and key"
                .to_string(),
        ));
    }
    if !gateway_only {
        validate_backend_for_platform(&profile.backend)?;
        resolve_auto_backend(&mut profile)?;
        validate_mount_path_for_backend(&profile.backend, &profile.mount_path)?;
        if profile.mount_path.is_empty() {
            return Err(DesktopError::Message(
                "mount path is required for a mount+gateway combo; enable gateway-only if this \
                 profile doesn't need a FUSE mount"
                    .to_string(),
            ));
        }
        if list_contains_target(&profile.mount_path)? {
            return Err(DesktopError::Message(format!(
                "target is already mounted: {}",
                profile.mount_path
            )));
        }
    }
    // Applies to both branches: gateway-only also emits extra_args now (see
    // push_cache_and_extra_args), not just the mount+gateway combo.
    reject_managed_extra_args(&profile)?;
    let resolved_secret = resolve_satellite_secret(&profile, secret)?;
    let args = build_gateway_argv(
        &profile,
        &protocols,
        port.as_deref(),
        gateway_only,
        no_loopback,
        cert_path.as_deref(),
        key_path.as_deref(),
    );
    let suffix = short_hash(&format!("{gateway_only}-{}", protocols.join(",")));
    let stderr_path =
        runtime_dir(&app)?.join(format!("gateway-{}-{suffix}-stderr.log", profile.id));
    let stdout_path =
        runtime_dir(&app)?.join(format!("gateway-{}-{suffix}-stdout.log", profile.id));
    let result = if gateway_only {
        spawn_gateway_only_and_wait(
            &mountos_path()?,
            &args,
            resolved_secret.as_deref(),
            &stdout_path,
            &stderr_path,
        )?
    } else {
        spawn_daemonizing_and_wait(
            &mountos_path()?,
            &args,
            resolved_secret.as_deref(),
            &stdout_path,
            &stderr_path,
            &profile.mount_path,
        )?
    };
    // The parent's own stdout is the authoritative source for the pid --
    // parsed from this process's own spawned child, never from anything the
    // frontend could supply. Only a pid discovered this way ever becomes
    // stoppable (see known_gateway_pids/stop_gateway_blocking).
    let stdout_text = fs::read_to_string(&stdout_path).unwrap_or_default();
    let pid = parse_started_pid(&stdout_text);
    if let Some(pid) = pid {
        known_gateway_pids()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(pid);
    }
    let descriptor = pid.and_then(find_gateway_descriptor_with_retry);
    let endpoints = descriptor
        .map(|d| {
            d.endpoints
                .into_iter()
                .map(|(protocol, endpoint)| GatewayEndpointInfo {
                    protocol,
                    url: endpoint.url,
                    region: (!endpoint.region.is_empty()).then_some(endpoint.region),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(GatewayLaunchResult {
        state: result.state,
        pid,
        endpoints,
    })
}

#[tauri::command]
async fn open_gateway(
    app: AppHandle,
    profile_id: String,
    params: GatewayLaunchParams,
    secret: Option<String>,
) -> Result<GatewayLaunchResult, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || {
        open_gateway_blocking(app, profile_id, params, secret)
    })
    .await
    .map_err(|error| DesktopError::Message(format!("gateway launch task failed: {error}")))?
}

// Scoped, single-purpose stop for a gateway launched via open_gateway --
// there is no `unmount` equivalent for it (no control socket, no mount
// entry), and this is deliberately narrower than the general Force-stop
// pattern reserved for §17.8 (opt-in, any wedged mount). Two independent
// checks gate this, not one: `pid` must be in known_gateway_pids() (a pid
// THIS process itself parsed from its own spawned child's stdout in
// open_gateway_blocking, never trusted from whatever a frontend caller
// supplies -- Tauri's own capability system gates only plugin commands, not
// app-defined ones, so a compromised/buggy renderer could otherwise invoke
// this with any u32), AND pid_is_mountos_process must still hold (closes the
// window where a known-but-since-reused pid was picked up by an unrelated
// process after the gateway already exited on its own). A small residual
// TOCTOU remains between that check and the kill/taskkill call below; no
// atomic cross-platform check-and-kill-by-identity primitive exists, so this
// is an accepted residual, same class as the symlink-race note in
// mountos-servers' gateway_descriptor.go.
// A pid launched via open_gateway and never stopped through this app (killed
// externally, crashed, exited on idle-timeout) stays in known_gateway_pids
// forever otherwise -- widening, without bound, the window in which the OS
// could hand that same pid number to an unrelated mountos-family process
// (this machine alone runs dozens, see mos-load-*) that stop_gateway would
// then also be willing to act on. Opportunistic, not exhaustive: still a
// residual TOCTOU between this call and the next (no cross-platform
// process-identity/start-time check exists to close it further), but no
// longer unbounded -- every gateway launch/stop call now re-checks every pid
// this process still thinks is live.
fn reconcile_known_gateway_pids() {
    let mut guard = known_gateway_pids()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    guard.retain(|&pid| pid_is_mountos_process(pid).unwrap_or(true));
}

fn stop_gateway_blocking(pid: u32) -> Result<(), DesktopError> {
    reconcile_known_gateway_pids();
    let is_known = known_gateway_pids()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains(&pid);
    if !is_known {
        return Err(DesktopError::Message(format!(
            "PID {pid} was not discovered by this app's own gateway launch -- refusing to stop it"
        )));
    }
    if !pid_is_mountos_process(pid)? {
        known_gateway_pids()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&pid);
        return Err(DesktopError::Message(format!(
            "no running mountos process at PID {pid} -- it may have already exited"
        )));
    }
    let result = send_graceful_stop(pid);
    known_gateway_pids()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&pid);
    result
}

// SIGTERM (Unix) is the same signal mfuse's own signal.Notify handler reacts
// to on Ctrl+C, so this drives the identical graceful-shutdown sequence
// (detach mount, flush, drain) rather than an abrupt kill. Windows has no
// equivalent graceful request for a console process without its own IPC
// listener -- `taskkill /F` is what stop_gateway has always used here; kept
// as-is rather than silently changing existing launched-by-this-app behavior
// as a side effect of adding the gateway-only case below.
fn send_graceful_stop(pid: u32) -> Result<(), DesktopError> {
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status()?;
    #[cfg(not(windows))]
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(DesktopError::Message(format!(
            "failed to stop gateway process {pid} (exit {status})"
        )))
    }
}

#[tauri::command]
async fn stop_gateway_only(pid: u32) -> Result<(), DesktopError> {
    tauri::async_runtime::spawn_blocking(move || stop_gateway_only_blocking(pid))
        .await
        .map_err(|error| DesktopError::Message(format!("stop gateway task failed: {error}")))?
}

// A standalone gateway-only row (mountos gateway / mount --gateway-only) has
// no launch record in known_gateway_pids -- it was very likely started from
// a terminal, not this app -- so there is nothing to check that trust chain
// against. Instead this re-derives trust from mountos list --json itself,
// the same "the renderer's claim about what to act on must be corroborated
// by the CLI's own live listing" pattern list_contains_target/open_target
// already use for mount targets: the pid must currently appear as a live
// "gateway" kind entry before this sends it anything.
fn stop_gateway_only_blocking(pid: u32) -> Result<(), DesktopError> {
    let output = command_output(&["list", "--json"])?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("mounts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let is_live_gateway = entries.iter().any(|entry| {
        entry.get("kind").and_then(Value::as_str) == Some("gateway")
            && entry.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
    });
    if !is_live_gateway {
        return Err(DesktopError::Message(format!(
            "PID {pid} is not a currently active gateway-only instance"
        )));
    }
    if !pid_is_mountos_process(pid)? {
        return Err(DesktopError::Message(format!(
            "no running mountos process at PID {pid} -- it may have already exited"
        )));
    }
    send_graceful_stop(pid)
}

#[cfg(windows)]
fn pid_is_mountos_process(pid: u32) -> Result<bool, DesktopError> {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()?;
    let text = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    Ok(text.contains("mountos") || text.contains("mfuse"))
}

#[cfg(not(windows))]
fn pid_is_mountos_process(pid: u32) -> Result<bool, DesktopError> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()?;
    if !output.status.success() {
        return Ok(false);
    }
    let comm = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    Ok(comm.contains("mountos") || comm.contains("mfuse"))
}

#[tauri::command]
async fn stop_gateway(pid: u32) -> Result<(), DesktopError> {
    tauri::async_runtime::spawn_blocking(move || stop_gateway_blocking(pid))
        .await
        .map_err(|error| DesktopError::Message(format!("stop gateway task failed: {error}")))?
}

// Same shape and same trust model as require_force_delete_allowed, a
// server-side re-check so every in-app path honors the setting, not a boundary
// against a hostile renderer.
fn require_force_unmount_allowed(app: &AppHandle) -> Result<(), DesktopError> {
    if get_settings(app.clone())?.allow_unmount_force {
        Ok(())
    } else {
        Err(DesktopError::Message(
            "Force unmount is disabled. Enable it in Settings first.".to_string(),
        ))
    }
}

fn unmount_target_blocking(
    app: AppHandle,
    target: String,
    force: bool,
) -> Result<UnmountResult, DesktopError> {
    if target.trim().is_empty() {
        return Err(DesktopError::Message(
            "unmount target is required".to_string(),
        ));
    }
    if force {
        require_force_unmount_allowed(&app)?;
    }
    // Mirrors open_target's guard: the UI's mount list can be up to 30s
    // stale (background polling interval), so re-verify against a fresh
    // `list --json` immediately before acting rather than trusting a
    // possibly-stale row the user is looking at. Closes the window where a
    // different volume could have taken over the same mount path since the
    // last poll.
    if !list_contains_target(&target)? {
        return Err(DesktopError::Message(format!(
            "refusing to unmount a path that is not an active mount target: {target}"
        )));
    }
    let mut args = vec!["unmount", "-y", "--json"];
    if force {
        args.push("--force");
    }
    args.push(&target);
    let output = Command::new(mountos_path()?).args(&args).output()?;

    // The CLI answers once the mount is gone from the system, and reports a
    // busy mount as busy rather than tearing it down, so its verdict is
    // authoritative. Anything it did not unmount is a real failure to surface.
    let outcomes = parse_unmount_outcomes(&output.stdout, &output.stderr)?;
    let Some(outcome) = outcomes.first() else {
        return Err(DesktopError::Message(
            "mountos unmount returned no result".to_string(),
        ));
    };
    if !outcome.unmounted() {
        return Err(DesktopError::Message(outcome.detail()));
    }

    // Unmounted means gone from the mount table; flushing to the server can
    // still be running behind it.
    let removed = poll_target(&target, false, UNMOUNT_TIMEOUT);
    Ok(UnmountResult {
        state: if removed { "idle" } else { "flushing" }.to_string(),
        target,
    })
}

#[tauri::command]
async fn unmount_target(
    app: AppHandle,
    target: String,
    force: Option<bool>,
) -> Result<UnmountResult, DesktopError> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || unmount_target_blocking(app, target, force))
        .await
        .map_err(|error| DesktopError::Message(format!("unmount task failed: {error}")))?
}

fn list_active_targets() -> Result<Vec<String>, DesktopError> {
    let output = command_output(&["list", "--json"])?;
    if !output.status.success() {
        return Err(DesktopError::Message(format!(
            "mountos list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| value.get("mounts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(entries
        .iter()
        .filter_map(|entry| {
            entry
                .get("mountPath")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect())
}

// unmount --all is one shell-out for the whole fleet rather than N individual
// unmount_target calls. The CLI's own combined confirmation-free (-y) batch
// unmount is both faster (no N separate process spawns) and matches the CLI's
// own --all semantics exactly. Per-target success comes from the CLI's --json
// outcomes, which are authoritative. The before/after list diff only waits for
// the flush that trails a successful unmount to settle.
fn unmount_all_targets_blocking(
    app: AppHandle,
    force: bool,
) -> Result<UnmountAllResult, DesktopError> {
    if force {
        require_force_unmount_allowed(&app)?;
    }
    let before = list_active_targets()?;
    if before.is_empty() {
        return Ok(UnmountAllResult {
            attempted: 0,
            failed: Vec::new(),
            busy: Vec::new(),
        });
    }

    let mut args = vec!["unmount", "--all", "-y", "--json"];
    if force {
        args.push("--force");
    }
    let output = Command::new(mountos_path()?).args(&args).output()?;
    let outcomes = parse_unmount_outcomes(&output.stdout, &output.stderr)?;

    let failed: Vec<String> = outcomes
        .iter()
        .filter(|outcome| !outcome.unmounted())
        .map(|outcome| outcome.mount_path.clone())
        .collect();
    let busy: Vec<String> = outcomes
        .iter()
        .filter(|outcome| outcome.busy)
        .map(|outcome| outcome.mount_path.clone())
        .collect();

    // Everything the CLI unmounted is out of the mount table already, but its
    // flush can straggle; wait for the list to settle so the UI does not keep
    // showing a row that is on its way out. Only the targets that actually
    // unmounted are waited on, because a busy one stays mounted by design and
    // waiting on it would burn the whole timeout every time. The result is
    // discarded and the error swallowed: the outcomes above are the answer, and
    // a transient `list` failure here must not destroy them.
    let settling: Vec<String> = before
        .iter()
        .filter(|target| !failed.iter().any(|f| f == *target))
        .cloned()
        .collect();
    if !settling.is_empty() {
        let _ = poll_unmount_all(&settling, UNMOUNT_TIMEOUT);
    }
    Ok(UnmountAllResult {
        attempted: before.len(),
        failed,
        busy,
    })
}

// Unlike a single unmount_target (one poll_target call), --all's per-mount
// teardown can straggle -- some targets finish flushing sooner than others.
// Re-listing once immediately after the CLI process exits raced the
// still-in-progress unmounts and reported every target as failed even though
// they all cleared moments later. Poll the whole list instead, the same
// 500ms-interval/timeout shape as poll_target, until none of `before`'s
// targets remain (or the timeout elapses).
fn poll_unmount_all(before: &[String], timeout: Duration) -> Result<Vec<String>, DesktopError> {
    let started = Instant::now();
    loop {
        let after = list_active_targets()?;
        let remaining: Vec<String> = before
            .iter()
            .filter(|target| after.iter().any(|candidate| candidate == *target))
            .cloned()
            .collect();
        if remaining.is_empty() || started.elapsed() >= timeout {
            return Ok(remaining);
        }
        thread::sleep(Duration::from_millis(500));
    }
}

#[tauri::command]
async fn unmount_all_targets(
    app: AppHandle,
    force: Option<bool>,
) -> Result<UnmountAllResult, DesktopError> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || unmount_all_targets_blocking(app, force))
        .await
        .map_err(|error| DesktopError::Message(format!("unmount-all task failed: {error}")))?
}

// Best-effort read for the instances list poll: every instance gets this on
// every refresh, so failures (unmounted mid-read, no .config yet, unexpected
// shape) fall back to None rather than failing the whole list -- an uptime
// or volume-kind badge that's occasionally missing beats one that takes the
// entire Instances view down with it.
struct InstanceConfigExtras {
    mount_time: Option<String>,
    // Read straight off the live mount, not the profile's own persisted
    // volume_kind (require_stable_identity/detect_and_persist_volume_kind,
    // above): that path only ever populates for profile-backed mounts, since
    // it needs a MountProfile to persist onto. An external mount (no saved
    // profile) has no such record, so its badge would never show without a
    // second, profile-independent source. Same "general"/"iceberg" casing.
    volume_kind: Option<String>,
    // Not in `mountos list --json` at all (confirmed) -- server-side this is
    // MountConfig.TemporaryFork (mfusetypes/types.go), a bool, distinct from
    // the same struct's ForkName string.
    temporary_fork: Option<bool>,
}

fn read_instance_config_extras(mount_path: &str) -> InstanceConfigExtras {
    let empty = InstanceConfigExtras {
        mount_time: None,
        volume_kind: None,
        temporary_fork: None,
    };
    let config_path = PathBuf::from(mount_path).join(".mountOS").join(".config");
    let Ok(bytes) = fs::read(&config_path) else {
        return empty;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return empty;
    };
    InstanceConfigExtras {
        mount_time: value
            .get("mountTime")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        volume_kind: value
            .get("volumeType")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        temporary_fork: value.get("isTemporaryFork").and_then(Value::as_bool),
    }
}

// Reads .mountOS/.config directly off disk rather than shelling out -- it's
// a plain JSON file the mfuse process already writes for its own TUI/CLI
// tooling (cmd/mfuse/reserved.go getConfigData), so no extra CLI round
// trip is needed. Scrubbing is unnecessary: MountConfig carries the access
// key ID (a public 20-char identifier) but never the secret.
#[tauri::command]
fn get_instance_config(target: String) -> Result<String, DesktopError> {
    if !is_openable_target(&target) {
        return Err(DesktopError::Message(
            "mount target is not an absolute filesystem path".to_string(),
        ));
    }
    if !list_contains_target(&target)? {
        return Err(DesktopError::Message(
            "refusing to read config for a path that is not an active mount target".to_string(),
        ));
    }
    let config_path = PathBuf::from(&target).join(".mountOS").join(".config");
    let bytes = fs::read(&config_path).map_err(|err| {
        DesktopError::Message(format!("failed to read {}: {err}", config_path.display()))
    })?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    Ok(serde_json::to_string_pretty(&value)?)
}

// POSIX single-quote wrap: closes the quote, emits an escaped literal quote,
// reopens it. Safe for any byte sequence, including embedded quotes.
#[cfg(not(windows))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// AppleScript double-quoted string literal escaping (backslash and quote).
#[cfg(target_os = "macos")]
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

// Launches the platform's terminal running `mountos dashboard [--gui]
// <target>`, left open afterward exactly like a terminal the user opened
// themselves (Terminal.app's `do script` and `cmd /k` both do this
// natively; the Linux fallback re-execs the shell to match).
// The dashboard TUI refuses to render below 118x35 and shows a "Terminal too
// small" placeholder instead, so every launcher below sizes its window up
// front rather than inheriting the terminal's default.
const TUI_COLS: &str = "140";
const TUI_ROWS: &str = "42";

// Terminals the launcher supports, in the order `auto` falls back through. The
// platform's stock terminal is first: it is always installed and is the path
// that has always shipped, so an unset or unavailable preference behaves
// exactly as before.
//
// Membership is by verified launch, not popularity. Each entry was confirmed to
// actually run a command in a new window at the size above. Warp is absent for
// that reason: it launches, but silently ignores a command passed to it, which
// would look like a working dashboard button that opens an empty terminal.
// kitty and WezTerm are absent only because they were not available to verify.
#[cfg(target_os = "macos")]
const KNOWN_TERMINALS: &[(&str, &str, &str)] = &[
    // (id, label, .app bundle name)
    ("terminal", "Terminal", "Terminal"),
    ("iterm2", "iTerm2", "iTerm"),
    ("ghostty", "Ghostty", "Ghostty"),
    ("alacritty", "Alacritty", "Alacritty"),
    ("kitty", "kitty", "kitty"),
    ("wezterm", "WezTerm", "WezTerm"),
];

#[cfg(target_os = "macos")]
fn terminal_bundle_path(bundle: &str) -> Option<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
        .into_iter()
        .map(|root| root.join(format!("{bundle}.app")))
        .find(|path| path.exists())
}

#[cfg(target_os = "macos")]
fn available_terminals() -> Vec<TerminalOption> {
    KNOWN_TERMINALS
        .iter()
        .filter(|(_, _, bundle)| terminal_bundle_path(bundle).is_some())
        .map(|(id, label, _)| TerminalOption {
            id: (*id).to_string(),
            label: (*label).to_string(),
        })
        .collect()
}

// Ghostty and Alacritty are launched through `open -na`, not their in-bundle
// binary: Ghostty's own CLI refuses to start the emulator on macOS ("launching
// the terminal emulator from the CLI is not supported ... use open -na
// Ghostty.app") and the same form works for Alacritty, so both take one path.
#[cfg(target_os = "macos")]
fn open_app_with_args(bundle: &str, args: &[&str]) -> Result<(), DesktopError> {
    let mut command = Command::new("open");
    command.arg("-na").arg(bundle).arg("--args").args(args);
    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(DesktopError::Message(if stderr.is_empty() {
            format!("open -na {bundle} exited with {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_iterm2(shell_cmd: &str) -> Result<(), DesktopError> {
    // `write text` into a freshly created window, which is iTerm2's own
    // scripting idiom; unlike Terminal.app it has no cold-launch window race,
    // since `create window with default profile` returns the window itself.
    let script = format!(
        "tell application \"iTerm\"\n  activate\n  set newWindow to (create window with default profile)\n  tell current session of newWindow\n    set columns to {TUI_COLS}\n    set rows to {TUI_ROWS}\n    write text {}\n  end tell\nend tell",
        applescript_quote(shell_cmd)
    );
    run_osascript(script, "iTerm")
}

#[cfg(target_os = "macos")]
fn spawn_dashboard_terminal(
    mountos: &Path,
    target: &str,
    gui: bool,
    preferred: Option<&str>,
) -> Result<(), DesktopError> {
    let mut shell_cmd = shell_quote(&mountos.display().to_string());
    shell_cmd.push_str(" dashboard");
    if gui {
        shell_cmd.push_str(" --gui");
    }
    shell_cmd.push(' ');
    shell_cmd.push_str(&shell_quote(target));

    // A preference for a terminal that has since been uninstalled falls back to
    // the stock one rather than failing: the user asked to see a dashboard, not
    // to see it in one specific app.
    let available = available_terminals();
    let chosen = preferred
        .filter(|id| available.iter().any(|option| option.id == *id))
        .unwrap_or("terminal");

    match chosen {
        "iterm2" => return spawn_iterm2(&shell_cmd),
        "ghostty" => {
            return open_app_with_args(
                "Ghostty",
                &[
                    &format!("--window-width={TUI_COLS}"),
                    &format!("--window-height={TUI_ROWS}"),
                    "-e",
                    "/bin/sh",
                    "-c",
                    &shell_cmd,
                ],
            )
        }
        "alacritty" => {
            return open_app_with_args(
                "Alacritty",
                &[
                    "-o",
                    &format!("window.dimensions.columns={TUI_COLS}"),
                    "-o",
                    &format!("window.dimensions.lines={TUI_ROWS}"),
                    "-e",
                    "/bin/sh",
                    "-c",
                    &shell_cmd,
                ],
            )
        }
        // kitty takes the command as trailing args, with no -e separator, and
        // sizes in cells via the `c` suffix.
        "kitty" => {
            return open_app_with_args(
                "kitty",
                &[
                    "-o",
                    &format!("initial_window_width={TUI_COLS}c"),
                    "-o",
                    &format!("initial_window_height={TUI_ROWS}c"),
                    "/bin/sh",
                    "-c",
                    &shell_cmd,
                ],
            )
        }
        // WezTerm is the one that does NOT go through `open -na`: passed that
        // way it launches but silently drops the command. Its in-bundle CLI
        // works, and --config is a global flag that must precede `start` --
        // after it, wezterm rejects it outright.
        "wezterm" => {
            let bundle = terminal_bundle_path("WezTerm")
                .ok_or_else(|| DesktopError::Message("WezTerm.app not found".to_string()))?;
            Command::new(bundle.join("Contents/MacOS/wezterm"))
                .arg("--config")
                .arg(format!("initial_cols={TUI_COLS}"))
                .arg("--config")
                .arg(format!("initial_rows={TUI_ROWS}"))
                .arg("start")
                .arg("--")
                .arg("/bin/sh")
                .arg("-c")
                .arg(&shell_cmd)
                .spawn()?;
            return Ok(());
        }
        _ => {}
    }

    // Two `do script` calls, not one: sending the real command to a cold-launched
    // Terminal (no windows yet) can race the new window's shell coming up and the
    // typed text is silently dropped, leaving an empty window. Forcing a window to
    // exist first (an empty `do script`) and then targeting it explicitly for the
    // real command avoids that race. The column/row resize (before the real command
    // runs) works around Terminal's default new-window size (83x24) being smaller
    // than the dashboard TUI's own minimum (118x35), which otherwise replaces the
    // dashboard with a "Terminal too small" placeholder instead of rendering it.
    let script = format!(
        "tell application \"Terminal\"\n  activate\n  if (count of windows) = 0 then\n    do script \"\"\n  end if\n  set number of columns of front window to {TUI_COLS}\n  set number of rows of front window to {TUI_ROWS}\n  do script {} in front window\nend tell",
        applescript_quote(&shell_cmd)
    );
    run_osascript(script, "Terminal")
}

// .output(), not .spawn(): the scripting calls here are synchronous AppleEvents
// that return once the terminal has started the command (not once it finishes),
// so this doesn't block on the dashboard session itself -- but it DOES need to be
// awaited to catch a real failure, most notably "AppleEvent timed out" (-1712)
// when this app hasn't been granted Automation permission for that terminal yet
// (System Settings > Privacy & Security > Automation). A bare .spawn() would
// silently report success even when osascript itself failed.
#[cfg(target_os = "macos")]
fn run_osascript(script: String, app: &str) -> Result<(), DesktopError> {
    let output = Command::new("osascript").arg("-e").arg(script).output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(DesktopError::Message(if stderr.contains("-1712") {
            format!(
                "macOS blocked mountOS Desktop from controlling {app}. Grant it in System \
                 Settings \u{2192} Privacy & Security \u{2192} Automation, then try again."
            )
        } else if stderr.is_empty() {
            format!("osascript exited with {}", output.status)
        } else {
            stderr
        }));
    }
    Ok(())
}

// Windows Terminal is the Win11 default host and cmd is guaranteed present.
// Both are the forms this launcher already shipped with, i.e. the ones known to
// work. Alacritty/WezTerm/PowerShell are deliberately absent rather than added
// from documentation alone -- there was no Windows host here to verify them on,
// and an unverified entry in this list is a dashboard button that opens the
// wrong thing or nothing.
#[cfg(windows)]
const KNOWN_TERMINALS: &[(&str, &str, &str)] = &[
    // (id, label, binary to probe on PATH)
    ("wt", "Windows Terminal", "wt"),
    ("cmd", "Command Prompt", "cmd"),
];

#[cfg(windows)]
fn available_terminals() -> Vec<TerminalOption> {
    KNOWN_TERMINALS
        .iter()
        // cmd is the guaranteed fallback: ComSpec always resolves, and probing
        // PATH for it would be the one lookup that must never fail.
        .filter(|(id, _, bin)| *id == "cmd" || which::which(bin).is_ok())
        .map(|(id, label, _)| TerminalOption {
            id: (*id).to_string(),
            label: (*label).to_string(),
        })
        .collect()
}

#[cfg(windows)]
fn spawn_dashboard_terminal(
    mountos: &Path,
    target: &str,
    gui: bool,
    preferred: Option<&str>,
) -> Result<(), DesktopError> {
    let mut shell_cmd = format!(
        "mode con: cols={TUI_COLS} lines={TUI_ROWS} && \"{}\" dashboard",
        mountos.display()
    );
    if gui {
        shell_cmd.push_str(" --gui");
    }
    shell_cmd.push_str(&format!(" \"{target}\""));

    // cmd /k keeps the window open after the command finishes, like
    // Terminal.app's do script. `mode con` resizes the console before the
    // dashboard TUI starts -- its own minimum (118x35) is larger than cmd/wt's
    // default new-window/new-tab size, which otherwise shows a "Terminal too
    // small" placeholder instead of the dashboard (mirrors the macOS fix).
    //
    // An uninstalled preference falls back to cmd rather than failing: the user
    // asked to see a dashboard, not to see it in one specific app.
    let available = available_terminals();
    let chosen = preferred
        .filter(|id| available.iter().any(|option| option.id == *id))
        .unwrap_or(if which::which("wt").is_ok() {
            "wt"
        } else {
            "cmd"
        });

    if chosen == "wt" {
        if let Ok(wt) = which::which("wt") {
            Command::new(wt)
                .arg("--size")
                .arg(format!("{TUI_COLS},{TUI_ROWS}"))
                .arg("new-tab")
                .arg("cmd")
                .arg("/k")
                .arg(&shell_cmd)
                .spawn()?;
            return Ok(());
        }
    }
    Command::new("cmd").arg("/k").arg(&shell_cmd).spawn()?;
    Ok(())
}

// The chain this launcher already shipped with, now also pickable. Nothing new
// was added from documentation alone: there was no Linux host here to verify a
// launch on, and an unverified entry is a dashboard button that opens the wrong
// thing or nothing.
#[cfg(not(any(windows, target_os = "macos")))]
const KNOWN_TERMINALS: &[(&str, &str, &str)] = &[
    // (id, label, binary to probe on PATH)
    (
        "x-terminal-emulator",
        "System default",
        "x-terminal-emulator",
    ),
    ("gnome-terminal", "GNOME Terminal", "gnome-terminal"),
    ("konsole", "Konsole", "konsole"),
    ("xterm", "xterm", "xterm"),
];

#[cfg(not(any(windows, target_os = "macos")))]
fn available_terminals() -> Vec<TerminalOption> {
    KNOWN_TERMINALS
        .iter()
        .filter(|(_, _, bin)| which::which(bin).is_ok())
        .map(|(id, label, _)| TerminalOption {
            id: (*id).to_string(),
            label: (*label).to_string(),
        })
        .collect()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn spawn_dashboard_terminal(
    mountos: &Path,
    target: &str,
    gui: bool,
    preferred: Option<&str>,
) -> Result<(), DesktopError> {
    let mut shell_cmd = shell_quote(&mountos.display().to_string());
    shell_cmd.push_str(" dashboard");
    if gui {
        shell_cmd.push_str(" --gui");
    }
    shell_cmd.push(' ');
    shell_cmd.push_str(&shell_quote(target));
    // bash -c exits once the command finishes; re-exec the shell so the
    // window behaves like one the user opened themselves, matching
    // Terminal.app / cmd /k's native behavior.
    shell_cmd.push_str("; exec \"$SHELL\"");

    // Try the preference first, then fall through the chain: an uninstalled
    // preference must not fail when another terminal is right there.
    let ordered: Vec<&str> = preferred
        .into_iter()
        .chain(KNOWN_TERMINALS.iter().map(|(id, _, _)| *id))
        .collect();

    for terminal in ordered {
        if which::which(terminal).is_err() {
            continue;
        }
        let mut cmd = Command::new(terminal);
        if terminal == "gnome-terminal" || terminal == "konsole" {
            cmd.arg("--");
        } else {
            cmd.arg("-e");
        }
        cmd.arg("bash").arg("-c").arg(&shell_cmd);
        cmd.spawn()?;
        return Ok(());
    }
    Err(DesktopError::Message(
        "no terminal emulator found on PATH".to_string(),
    ))
}

fn launch_dashboard_blocking(
    app: AppHandle,
    target: String,
    gui: bool,
) -> Result<(), DesktopError> {
    if !is_openable_target(&target) {
        return Err(DesktopError::Message(
            "mount target is not an absolute filesystem path".to_string(),
        ));
    }
    if !list_contains_target(&target)? {
        return Err(DesktopError::Message(
            "refusing to launch a dashboard for a path that is not an active mount target"
                .to_string(),
        ));
    }
    // A broken/missing settings.json must not block the dashboard; fall back to
    // no preference (the stock terminal) rather than surfacing a settings error
    // from a button that has nothing to do with settings.
    let preferred = get_settings(app)
        .ok()
        .and_then(|settings| settings.terminal);
    spawn_dashboard_terminal(&mountos_path()?, &target, gui, preferred.as_deref())
}

// async + spawn_blocking: on macOS a denied/pending Automation permission
// can make the underlying osascript call take up to its own AppleEvent
// timeout (~2 minutes) to fail, and this must not freeze the Tauri IPC
// thread for that long.
#[tauri::command]
async fn launch_dashboard(app: AppHandle, target: String, gui: bool) -> Result<(), DesktopError> {
    tauri::async_runtime::spawn_blocking(move || launch_dashboard_blocking(app, target, gui))
        .await
        .map_err(|error| DesktopError::Message(format!("dashboard launch task failed: {error}")))?
}

#[tauri::command]
fn open_target(target: String) -> Result<(), DesktopError> {
    if !is_openable_target(&target) {
        return Err(DesktopError::Message(
            "mount target is not an absolute filesystem path".to_string(),
        ));
    }
    if !list_contains_target(&target)? {
        return Err(DesktopError::Message(
            "refusing to open a path that is not an active mount target".to_string(),
        ));
    }
    open::that_detached(target)?;
    Ok(())
}

// Opens the mount's reserved .lost+found directory -- every mountOS volume
// keeps one (server-side: internal/constants.LostFoundName), holding files
// whose original name/parent link was lost to a crash or cleanup. Mirrors
// open_target's guard: target must still be a live mount, the subpath itself
// is fixed rather than frontend-supplied.
#[tauri::command]
fn open_lost_found(target: String) -> Result<(), DesktopError> {
    if !is_openable_target(&target) {
        return Err(DesktopError::Message(
            "mount target is not an absolute filesystem path".to_string(),
        ));
    }
    if !list_contains_target(&target)? {
        return Err(DesktopError::Message(
            "refusing to open a path that is not an active mount target".to_string(),
        ));
    }
    open::that_detached(PathBuf::from(&target).join(".lost+found"))?;
    Ok(())
}

// Opens a diagnostics bundle this app wrote.
//
// Mirrors open_target's guard: the path is confined to our own diagnostics
// directory rather than opened because the frontend asked. Both sides are
// canonicalized first, so a symlink or `..` inside the argument cannot escape
// the directory and turn this into an arbitrary "open any file" primitive.
#[tauri::command]
fn open_diagnostics_bundle(app: AppHandle, path: String) -> Result<(), DesktopError> {
    let dir = app
        .path()
        .app_cache_dir()?
        .join("diagnostics")
        .canonicalize()?;
    let target = PathBuf::from(&path).canonicalize()?;
    if !target.starts_with(&dir) {
        return Err(DesktopError::Message(
            "refusing to open a path outside the diagnostics directory".to_string(),
        ));
    }
    open::that_detached(target)?;
    Ok(())
}

// Opens a job's file-logger output (mountos-servers'
// internal/logger.getDefaultLogDir -- always ~/.mountOS/logs for a desktop
// app, which never runs as Linux root). Shared by upload, download and sink,
// whose daemons all reuse the same logger machinery.
//
// Mirrors open_diagnostics_bundle's guard: the path is confined to that
// fixed directory rather than opened because the frontend asked. Both sides
// are canonicalized first, so a symlink or `..` inside the argument cannot
// escape the directory and turn this into an arbitrary "open any file"
// primitive.
fn open_job_log(path: String) -> Result<(), DesktopError> {
    let home =
        std::env::var("HOME").map_err(|_| DesktopError::Message("HOME is not set".to_string()))?;
    let dir = PathBuf::from(home)
        .join(".mountOS")
        .join("logs")
        .canonicalize()?;
    let target = PathBuf::from(&path).canonicalize()?;
    if !target.starts_with(&dir) {
        return Err(DesktopError::Message(
            "refusing to open a path outside the mountOS logs directory".to_string(),
        ));
    }
    open::that_detached(target)?;
    Ok(())
}

#[tauri::command]
fn open_upload_log(path: String) -> Result<(), DesktopError> {
    open_job_log(path)
}

#[tauri::command]
fn open_download_log(path: String) -> Result<(), DesktopError> {
    open_job_log(path)
}

#[tauri::command]
fn open_sink_log(path: String) -> Result<(), DesktopError> {
    open_job_log(path)
}

// The Dock icon (and Cmd+Tab entry) tracks the main window's own visibility
// rather than being permanently off: hidden behind the tray only while the
// window is actually hidden, so it doesn't strand an actively-open window
// with no OS-level way back to it (no Dock icon, no Cmd+Tab).
#[cfg(target_os = "macos")]
fn set_dock_visible(app: &AppHandle, visible: bool) {
    let _ = app.set_activation_policy(if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });
    // set_activation_policy alone is unreliable on its own for the Dock icon
    // actually appearing/disappearing; pairing it with set_dock_visibility is
    // the combination that behaves consistently (confirmed against an older
    // sibling client's tray implementation that hit the same gap).
    let _ = app.set_dock_visibility(visible);
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_app: &AppHandle, _visible: bool) {}

fn show_main_window_internal(app: &AppHandle) -> Result<(), DesktopError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| DesktopError::Message("main window not found".to_string()))?;
    set_dock_visible(app, true);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), DesktopError> {
    show_main_window_internal(&app)
}

#[tauri::command]
async fn create_diagnostics_bundle(app: AppHandle) -> Result<DiagnosticsBundle, DesktopError> {
    tauri::async_runtime::spawn_blocking(move || create_diagnostics_bundle_blocking(app))
        .await
        .map_err(|error| DesktopError::Message(format!("diagnostics task failed: {error}")))?
}

fn create_diagnostics_bundle_blocking(app: AppHandle) -> Result<DiagnosticsBundle, DesktopError> {
    let dir = app.path().app_cache_dir()?.join("diagnostics");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!(
        "mountos-desktop-diagnostics-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    ));

    let check = command_output(&["check", "--json"]).ok();
    let list = command_output(&["list", "--json"]).ok();
    let profiles = read_profiles(&app).unwrap_or_default();
    let content = DiagnosticsContent {
        created_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        cli_path: mountos_path().ok().map(|path| path.display().to_string()),
        cli_version: cli_version(),
        check: check.as_ref().map(|output| DiagnosticsCommandOutput {
            status: output.status.code(),
            stdout: scrub_output(&output.stdout),
            stderr: scrub_output(&output.stderr),
        }),
        list: list.as_ref().map(|output| DiagnosticsCommandOutput {
            status: output.status.code(),
            stdout: scrub_output(&output.stdout),
            stderr: scrub_output(&output.stderr),
        }),
        profiles: profiles
            .into_iter()
            .map(|profile| DiagnosticsProfileSummary {
                id: profile.id,
                name: profile.name,
                kind: profile.kind,
                mount_path: profile.mount_path,
                discovery_url: profile.discovery_url,
                backend: profile.backend,
                secret_ref: profile.secret_ref,
                extra_args_count: profile.extra_args.len(),
                auto_remount: profile.auto_remount,
            })
            .collect(),
    };
    fs::write(&path, serde_json::to_vec_pretty(&content)?)?;
    Ok(DiagnosticsBundle {
        path: path.display().to_string(),
        content,
    })
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let instances = get_system_state_blocking(app.clone())
        .map(|state| state.instances)
        .unwrap_or_default();

    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    if instances.is_empty() {
        items.push(Box::new(MenuItem::with_id(
            app,
            "no-mounts",
            "No active mounts",
            false,
            None::<&str>,
        )?));
    } else {
        // A menubar dropdown listing every mount doesn't scale -- cap it and
        // fold the rest into a single "+N more" item that opens the full app
        // (same id as "Open mountOS" below, same action) instead of growing
        // the native menu unboundedly.
        const MAX_MOUNT_ITEMS: usize = 15;
        let total = instances.len();
        for instance in instances.iter().take(MAX_MOUNT_ITEMS) {
            let label = if instance.name.is_empty() {
                instance.mount_path.clone()
            } else {
                instance.name.clone()
            };
            items.push(Box::new(MenuItem::with_id(
                app,
                format!("open-mount:{}", instance.mount_path),
                format!("{label} \u{2014} {}", instance.health),
                is_openable_target(&instance.mount_path),
                None::<&str>,
            )?));
        }
        if total > MAX_MOUNT_ITEMS {
            let remaining = total - MAX_MOUNT_ITEMS;
            items.push(Box::new(MenuItem::with_id(
                app,
                "show",
                format!("+{remaining} more"),
                true,
                None::<&str>,
            )?));
        }
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "show",
        "Open mountOS",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "quit",
        "Quit mountOS",
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main_window_internal(app);
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Dock icon / Cmd+Tab entry tracks the main window's own
            // visibility (see set_dock_visible) rather than being
            // permanently off, so it doesn't strand an actively-open window
            // with no OS-level way back to it. Sync once to the window's
            // actual starting visibility (visible by default at first run).
            let main_visible = app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);
            set_dock_visible(app.handle(), main_visible);

            let menu = build_tray_menu(app.handle())?;
            // macOS re-tints a template image to match the menu bar's
            // light/dark state, so it gets the grayscale asset built for
            // that. Windows/Linux trays have no such retinting -- they would
            // just render that grayscale asset flat, so they get the actual
            // color logo instead, and icon_as_template stays macOS-only.
            let is_macos = cfg!(target_os = "macos");
            let tray_icon = if is_macos {
                tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?
            } else {
                tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?
            };

            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(is_macos)
                .tooltip("mountOS")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if let Some(target) = id.strip_prefix("open-mount:") {
                        let _ = open_target(target.to_string());
                        return;
                    }
                    match id {
                        "show" => {
                            let _ = show_main_window_internal(app);
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Native menus render reliably everywhere (including over
                    // another app's fullscreen Space) since AppKit itself owns
                    // showing them -- unlike the tray-popover webview window,
                    // which repeated attempts couldn't make reliably visible
                    // there. Rebuilt on hover so the mount list is current by
                    // the time an actual click follows.
                    if let TrayIconEvent::Enter { .. } = event {
                        if let Ok(menu) = build_tray_menu(tray.app_handle()) {
                            let _ = tray.set_menu(Some(menu));
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match window.label() {
            "main" => {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    set_dock_visible(window.app_handle(), false);
                }
            }
            "tray-popover" => {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_system_state,
            get_settings,
            save_settings,
            list_profiles,
            random_friendly_name,
            save_profile,
            delete_profile,
            export_profile,
            set_profile_secret,
            delete_profile_secret,
            get_profile_secret_status,
            mount_profile,
            fork_list_raw,
            fork_create,
            fork_delete,
            fork_restore,
            list_uploads,
            start_upload,
            ensure_upload_browse_mount,
            resume_upload,
            cancel_upload,
            retry_failed_upload,
            finish_upload,
            prune_uploads,
            list_downloads,
            start_download,
            ensure_download_browse_mount,
            resume_download,
            cancel_download,
            retry_failed_download,
            finish_download,
            prune_downloads,
            list_sinks,
            start_sink,
            resume_sink,
            cancel_sink,
            finish_sink,
            prune_sinks,
            get_sink_status,
            open_snapshot_view,
            open_deleted_view,
            open_version_view,
            open_deleted_view_for_instance,
            open_version_view_for_instance,
            open_gateway,
            stop_gateway,
            stop_gateway_only,
            unmount_target,
            unmount_all_targets,
            open_target,
            open_lost_found,
            get_instance_config,
            launch_dashboard,
            create_diagnostics_bundle,
            open_diagnostics_bundle,
            open_upload_log,
            open_download_log,
            open_sink_log,
            mcp_status,
            mcp_install,
            mcp_uninstall,
            mount_help,
            get_third_party_licenses,
            open_external_url,
            validate_cli_candidate,
            verify_cli_signature,
            show_main_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building mountOS Desktop")
        .run(|app_handle, event| {
            // Best-effort cleanup on quit: a read-only browse scratch mount
            // (ensure_upload_browse_mount_blocking, ensure_download_browse_
            // mount_blocking -- both share the same browse_mounts() registry)
            // only gets reaped by the in-process idle sweeper, which dies
            // with this process and has no persisted registry -- without
            // this, quitting mid-idle-window (not just closing the window,
            // which only hides it) leaves it orphaned until the user
            // notices it manually in
            // Instances. RunEvent::Exit fires once, right before the
            // process actually terminates.
            if let tauri::RunEvent::Exit = event {
                let entries: Vec<std::path::PathBuf> = browse_mounts()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .map(|entry| entry.local_path.clone())
                    .collect();
                for local_path in entries {
                    let target = local_path.to_string_lossy().into_owned();
                    let _ = unmount_target_blocking(app_handle.clone(), target, false);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> MountProfile {
        MountProfile {
            id: "profile-1".to_string(),
            schema_version: 1,
            kind: "mount".to_string(),
            name: "Team files".to_string(),
            volume: "Team files".to_string(),
            fork: "main".to_string(),
            mount_path: "/Volumes/MountOS/Team".to_string(),
            discovery_url: "https://hub.example.com".to_string(),
            access_key_id: "ABCDEFGHIJKLMNOPQRST".to_string(),
            secret_ref: "prompt".to_string(),
            backend: Backend::Nfs,
            cache_dir: Some("/tmp/mountos cache".to_string()),
            cache_size: Some("10G".to_string()),
            read_only: true,
            auto_remount: false,
            temporary_fork: false,
            trusted_discovery_host: None,
            extra_args: vec!["--attr-cache".to_string(), "2.0".to_string()],
            created_at: "2026-07-10T00:00:00Z".to_string(),
            updated_at: "2026-07-10T00:00:00Z".to_string(),
            volume_kind: None,
        }
    }

    #[test]
    fn builds_current_cli_flags_without_a_secret_value() {
        let argv = build_mount_argv(&profile());
        assert!(argv
            .windows(2)
            .any(|args| args == ["--volname", "Team files"]));
        assert!(argv.windows(2).any(|args| args == ["--fork-name", "main"]));
        assert!(argv
            .windows(2)
            .any(|args| args == ["--disk-cache-dir", "/tmp/mountos cache"]));
        assert!(argv
            .windows(2)
            .any(|args| args == ["--disk-cache-size", "10G"]));
        assert!(argv.contains(&"--nfs".to_string()));
        assert!(argv.contains(&"-s".to_string()));
        assert!(!argv.contains(&"--volume".to_string()));
        assert!(!argv.contains(&"--fork".to_string()));
        assert!(!argv.contains(&"--cache-dir".to_string()));
        assert!(!argv.iter().any(|arg| arg.len() == 40));
    }

    // Every surviving backend mounts at a real path, so -m is emitted whenever
    // one is set and omitted only when the field is blank.
    #[test]
    fn emits_mount_flag_whenever_a_mount_path_is_set() {
        let mut p = profile();
        p.mount_path = "/some/path".to_string();
        for backend in [
            Backend::Auto,
            Backend::Macfuse,
            Backend::Fskit,
            Backend::Nfs,
            Backend::Smb,
            Backend::Mountosio,
        ] {
            p.backend = backend;
            assert!(build_mount_argv(&p).contains(&"-m".to_string()));
        }

        p.mount_path = String::new();
        assert!(!build_mount_argv(&p).contains(&"-m".to_string()));
    }

    // A profile written by an older build can still name a backend that no
    // longer exists; it must land on Auto rather than fail the whole listing.
    #[test]
    fn deserializes_unknown_backend_ids_as_auto() {
        for raw in [
            "\"fileprovider\"",
            "\"cloudfilter\"",
            "\"\"",
            "\"nonsense\"",
        ] {
            let backend: Backend = serde_json::from_str(raw).expect("unknown id must not fail");
            assert!(matches!(backend, Backend::Auto), "{raw} should map to Auto");
        }
        let known: Backend = serde_json::from_str("\"mountosio\"").expect("known id parses");
        assert!(matches!(known, Backend::Mountosio));
    }

    #[test]
    fn validates_fskit_mount_path_prefix() {
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/Volumes/MountOS/Team").is_ok());
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/Volumes/MountOS/Team/").is_ok());
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/Volumes/MountOS/").is_err());
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/Volumes/MountOS").is_err());
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/tmp/Team").is_err());
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "").is_err());
        // Case-sensitive: the real FSKit registration is a literal path match.
        assert!(validate_mount_path_for_backend(&Backend::Fskit, "/volumes/mountos/Team").is_err());
        // A ".." component must not lexically escape the jail even though the
        // path doesn't exist yet (no canonicalize) and the prefix bytes match.
        assert!(validate_mount_path_for_backend(
            &Backend::Fskit,
            "/Volumes/MountOS/x/../../../../../etc/cron.d/evil"
        )
        .is_err());
        // Non-FSKit backends are never gated by this check.
        assert!(validate_mount_path_for_backend(&Backend::Nfs, "/tmp/anything").is_ok());
        assert!(validate_mount_path_for_backend(&Backend::Nfs, "").is_ok());
    }

    #[test]
    fn rejects_non_absolute_mount_paths_for_backends_that_need_one() {
        // Empty stays legal (build_mount_argv omits -m, CLI picks a default).
        assert!(validate_mount_path_for_backend(&Backend::Nfs, "").is_ok());
        // A non-empty value has to actually be an absolute path, not garbage.
        assert!(validate_mount_path_for_backend(&Backend::Nfs, "relative/path").is_err());
        assert!(validate_mount_path_for_backend(&Backend::Nfs, "not-a-path").is_err());
        if cfg!(windows) {
            assert!(
                validate_mount_path_for_backend(&Backend::Mountosio, "C:\\Mounts\\Team").is_ok()
            );
            assert!(validate_mount_path_for_backend(&Backend::Mountosio, "D:").is_ok());
            assert!(validate_mount_path_for_backend(&Backend::Mountosio, "/Volumes/Team").is_err());
        } else {
            assert!(validate_mount_path_for_backend(&Backend::Nfs, "/Volumes/Team").is_ok());
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn shell_quote_survives_a_shell_round_trip() {
        // Every quoted value, fed through `sh -c 'printf %s ' + quoted`,
        // must come back byte-for-byte identical -- this is the actual
        // property that matters for dashboard-launcher command construction.
        for raw in [
            "/Volumes/MountOS/Team",
            "/tmp/has space",
            "it's a mount",
            "''; rm -rf /tmp/pwned; echo '",
            "$(echo pwned)",
            "back\\slash",
            "",
        ] {
            let quoted = shell_quote(raw);
            let output = Command::new("sh")
                .arg("-c")
                .arg(format!("printf '%s' {quoted}"))
                .output()
                .expect("sh must be available in test environment");
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                raw,
                "shell_quote({raw:?}) = {quoted:?} did not round-trip"
            );
        }
    }

    #[test]
    fn validates_extra_arg_values_without_treating_them_as_positionals() {
        assert!(validate_extra_args(&[
            "--attr-cache".to_string(),
            "2.0".to_string(),
            "--debug".to_string(),
        ])
        .is_empty());
        assert_eq!(
            validate_extra_args(&["--mount".to_string(), "/tmp/other".to_string()]),
            vec!["--mount".to_string(), "/tmp/other".to_string()]
        );
        // --destination is a real alias for -m on the deleted/version commands
        // now, so it must be blocked exactly like --mount -- otherwise a
        // stray value here would silently redirect a satellite view mount.
        assert_eq!(
            validate_extra_args(&["--destination".to_string(), "/tmp/other".to_string()]),
            vec!["--destination".to_string(), "/tmp/other".to_string()]
        );
        // --disk-cache-size now has its own MountProfile field; extra_args is
        // no longer a legal way to set it.
        assert_eq!(
            validate_extra_args(&["--disk-cache-size".to_string(), "10G".to_string()]),
            vec!["--disk-cache-size".to_string(), "10G".to_string()]
        );
    }

    #[test]
    fn validates_short_flag_clusters() {
        // A managed short flag anywhere before the '-o' value-absorbing
        // point is caught, regardless of position in the cluster.
        assert_eq!(
            validate_extra_args(&["-am".to_string()]),
            vec!["-am".to_string()]
        );
        assert_eq!(
            validate_extra_args(&["-ma".to_string()]),
            vec!["-ma".to_string()]
        );
        // '-o' takes a fused value (mirrors real short-opt parsing: once a
        // value-taking flag is hit in a cluster, the rest of the token is
        // its value, not further flags) -- bare '-o' and '-o<value>' are both
        // accepted even when the value text collides with a managed letter.
        assert!(validate_extra_args(&["-o".to_string()]).is_empty());
        assert!(validate_extra_args(&["-oallow_other".to_string()]).is_empty());
        assert!(validate_extra_args(&["-oa".to_string()]).is_empty());
        // Bare "--" (positional separator) is rejected like any other
        // non-managed-but-suspicious positional.
        assert_eq!(
            validate_extra_args(&["--".to_string()]),
            vec!["--".to_string()]
        );
    }

    #[test]
    fn parses_backend_check_records() {
        let payload = br#"[
          {"feature":"NFS","supported":true,"checks":[{"name":"mount_nfs","ok":true}]},
          {"feature":"FSKit","supported":false,"capable":true,"checks":[{"name":"Extension","ok":false,"error":"not enabled"}]}
        ]"#;
        let (ok, issues) = parse_check_bytes(payload, b"");
        assert!(ok);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].title, "FSKit requires setup");
        assert!(issues[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("not enabled")));
    }

    #[test]
    fn preserves_list_types_and_marks_orphans_lost() {
        let value = serde_json::json!([{
            "name": "Team",
            "mountPath": "/Volumes/Team",
            "fsName": "mountos",
            "volumeId": 42,
            "versionInode": "9007199254740993",
            "orphaned": true
        }]);
        let instances = parse_instances_value(&value);
        assert_eq!(instances[0].volume_id, Some(42));
        assert_eq!(
            instances[0].version_inode.as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(instances[0].health, "lost");
    }

    #[test]
    fn parses_gateway_only_entries_with_endpoint_target() {
        let value = serde_json::json!([{
            "kind": "gateway",
            "name": "Vol-object",
            "volumeIdentifier": "019d19b9-dae5-7000-ac89-60c07d76c408",
            "gatewayEndpoints": {
                "s3": { "url": "http://127.0.0.1:18280", "region": "mountos" }
            },
            "pid": 339
        }]);
        let instances = parse_instances_value(&value);
        assert_eq!(instances[0].kind.as_deref(), Some("gateway"));
        assert!(instances[0].mount_path.is_empty());
        // No mountPath to key on -- falls back to the volume identifier.
        assert_eq!(instances[0].key, "019d19b9-dae5-7000-ac89-60c07d76c408");
        let endpoints = instances[0].gateway_endpoints.as_ref().expect("endpoints");
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].protocol, "s3");
        assert_eq!(endpoints[0].url, "http://127.0.0.1:18280");
        assert_eq!(instances[0].pid, Some(339));
    }

    #[test]
    fn scrubs_key_value_bearer_and_raw_secret_patterns() {
        let input = "secret: hunter2\nauthorization=abc\nBearer token-value\nABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd";
        let scrubbed = scrub_secrets(input);
        assert!(!scrubbed.contains("hunter2"));
        assert!(!scrubbed.contains("abc\n"));
        assert!(!scrubbed.contains("token-value"));
        assert!(!scrubbed.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd"));
    }

    #[test]
    fn rejects_profile_path_traversal_ids() {
        assert!(validate_profile_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_profile_id("../outside").is_err());
        assert!(validate_profile_id("").is_err());
    }

    #[test]
    fn rejects_non_path_open_targets() {
        assert!(is_openable_target("/Volumes/MountOS/Team"));
        assert!(!is_openable_target("an-os-managed-domain-id"));
    }

    #[test]
    fn sanitizes_export_file_stems() {
        assert_eq!(export_file_stem("Team files", "id"), "Team files");
        assert_eq!(export_file_stem("a/b\\c:d", "id"), "a-b-c-d");
        assert_eq!(export_file_stem("///", "fallback-id"), "fallback-id");
        assert_eq!(export_file_stem("", "fallback-id"), "fallback-id");
    }

    #[test]
    fn builds_snapshot_argv_with_fused_timestamp_flag_and_dash_m() {
        let argv = build_snapshot_argv(&profile(), "/tmp/snap-view", "-1d");
        // Fused as ONE token: a separate `--timestamp -1d` pair would risk
        // pflag misparsing the leading-minus value as another flag.
        assert!(argv.contains(&"--timestamp=-1d".to_string()));
        assert!(!argv.iter().any(|arg| arg == "--timestamp"));
        // snapshot has no --destination flag (verified against
        // cmd_snapshot.go): -m is its only mount-point flag.
        assert!(argv.windows(2).any(|pair| pair == ["-m", "/tmp/snap-view"]));
        assert!(!argv.contains(&"--destination".to_string()));

        let padded = build_snapshot_argv(&profile(), "/tmp/snap-view", "  -1d  ");
        assert!(padded.contains(&"--timestamp=-1d".to_string()));
    }

    #[test]
    fn builds_deleted_argv_uses_destination_and_omits_optional_flags_when_blank() {
        let bare = build_deleted_argv(&profile(), "/tmp/deleted-view", None, None);
        assert!(bare
            .windows(2)
            .any(|pair| pair == ["--destination", "/tmp/deleted-view"]));
        assert!(!bare.contains(&"-m".to_string()));
        assert!(!bare.iter().any(|arg| arg.starts_with("--from")));
        assert!(!bare.iter().any(|arg| arg.starts_with("--idle-timeout")));

        let full = build_deleted_argv(&profile(), "/tmp/deleted-view", Some("30d"), Some("1h"));
        assert!(full.contains(&"--from=30d".to_string()));
        assert!(full.contains(&"--idle-timeout=1h".to_string()));

        // Go's DurationVar doesn't trim, so surrounding whitespace in the
        // field must be stripped here rather than passed through verbatim.
        let padded = build_deleted_argv(&profile(), "/tmp/deleted-view", None, Some("  1h  "));
        assert!(padded.contains(&"--idle-timeout=1h".to_string()));

        let padded_from =
            build_deleted_argv(&profile(), "/tmp/deleted-view", Some("  30d  "), None);
        assert!(padded_from.contains(&"--from=30d".to_string()));
    }

    #[test]
    fn builds_version_argv_treats_inode_as_string_safe_u64() {
        // Round-trips at u64::MAX unchanged: the string-not-number decision
        // guards against precision loss above Number.MAX_SAFE_INTEGER on the
        // JS side, which a numeric type here would silently reintroduce.
        let argv = build_version_argv(
            &profile(),
            "/tmp/version-view",
            None,
            Some(u64::MAX),
            None,
            None,
            false,
        );
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["-i", &u64::MAX.to_string()]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--destination", "/tmp/version-view"]));
        // "number" is the CLI's own default; omit the flag rather than
        // stating the default explicitly.
        assert!(!argv.iter().any(|arg| arg.starts_with("--version-format")));
        assert!(!argv.contains(&"--full-chain".to_string()));

        let dated = build_version_argv(
            &profile(),
            "/tmp/version-view",
            None,
            Some(1),
            Some("date"),
            Some("5m"),
            false,
        );
        assert!(dated.contains(&"--version-format=date".to_string()));
        assert!(dated.contains(&"--idle-timeout=5m".to_string()));

        // cmd_version.go checks `format != "number" && format != "date"` with
        // no trimming, so a padded value must be trimmed here or it fails
        // that exact-match check server-side.
        let padded = build_version_argv(
            &profile(),
            "/tmp/version-view",
            None,
            Some(1),
            Some("  date  "),
            None,
            false,
        );
        assert!(padded.contains(&"--version-format=date".to_string()));
    }

    #[test]
    fn builds_version_argv_with_path_and_full_chain() {
        let argv = build_version_argv(
            &profile(),
            "/tmp/version-view",
            Some("/Volumes/data/report.txt"),
            None,
            None,
            None,
            true,
        );
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--path", "/Volumes/data/report.txt"]));
        assert!(!argv.contains(&"-i".to_string()));
        assert!(argv.contains(&"--full-chain".to_string()));
    }

    // Windows has no safe no-flag default (cli_windows.go hard-codes mountosio
    // with no capability probing), so a view-mount states its backend rather
    // than relying on the CLI's default order.
    #[test]
    fn emits_backend_flag_for_view_mounts() {
        let mut p = profile();
        p.backend = Backend::Mountosio;
        let argv = build_deleted_argv(&p, "/tmp/deleted-view", None, None);
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--backend", "mountosio"]));

        p.backend = Backend::Nfs;
        let argv = build_deleted_argv(&p, "/tmp/deleted-view", None, None);
        assert!(argv.contains(&"--nfs".to_string()));

        p.backend = Backend::Macfuse;
        let argv = build_snapshot_argv(&p, "/tmp/snap-view", "1d");
        assert!(argv.contains(&"--macfuse".to_string()));
    }

    // Guards the hand-synced JSON contract against mfusetypes.MountConfig
    // (mountos-servers/cmd/mfuse/mfusetypes/types.go) -- a typo'd #[serde(rename)]
    // here would silently deserialize every field as empty rather than fail.
    #[test]
    fn live_mount_config_deserializes_the_go_field_names() {
        let config: LiveMountConfig = serde_json::from_str(
            r#"{"discoveryUrl":"https://hub.example.com","forkName":"main","accessId":"ABCDEFGHIJKLMNOPQRST","volumeName":"Team files","volumeType":"general","mountTime":"2026-07-23T00:00:00Z","pid":123}"#,
        )
        .unwrap();
        assert_eq!(config.discovery_url, "https://hub.example.com");
        assert_eq!(config.fork_name, "main");
        assert_eq!(config.access_id, "ABCDEFGHIJKLMNOPQRST");
        assert_eq!(config.volume_name, "Team files");
        assert_eq!(config.volume_type, "general");
    }

    #[test]
    fn live_mount_config_tolerates_missing_fields() {
        let config: LiveMountConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.discovery_url, "");
        assert_eq!(config.volume_type, "");
    }

    #[test]
    fn synthetic_profile_from_live_mount_config_carries_credentials_and_never_persists() {
        let config = LiveMountConfig {
            discovery_url: "https://hub.example.com".to_string(),
            fork_name: "main".to_string(),
            access_id: "ABCDEFGHIJKLMNOPQRST".to_string(),
            volume_name: "Team files".to_string(),
            volume_type: "general".to_string(),
        };
        let profile =
            live_mount_config_to_profile("/Volumes/MountOS/Team", Backend::Fskit, config).unwrap();
        assert_eq!(profile.discovery_url, "https://hub.example.com");
        assert_eq!(profile.fork, "main");
        assert_eq!(profile.access_key_id, "ABCDEFGHIJKLMNOPQRST");
        assert_eq!(profile.volume, "Team files");
        assert_eq!(profile.mount_path, "/Volumes/MountOS/Team");
        assert!(matches!(profile.backend, Backend::Fskit));
        // Never "vault": there's no vault entry for a profile that's never
        // saved, so resolve_satellite_secret must fall through to whatever
        // the frontend explicitly supplies for this call, not the keyring.
        assert_eq!(profile.secret_ref, "prompt");
        assert!(profile.extra_args.is_empty());
        assert!(profile.cache_dir.is_none());
        assert!(profile.cache_size.is_none());
    }

    #[test]
    fn synthetic_profile_rejects_iceberg_volumes() {
        let config = LiveMountConfig {
            volume_type: "Iceberg".to_string(),
            ..Default::default()
        };
        let result = live_mount_config_to_profile("/Volumes/MountOS/Lake", Backend::Fskit, config);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_fork_names_starting_with_hyphen_or_empty() {
        assert!(validate_fork_name("").is_err());
        assert!(validate_fork_name("   ").is_err());
        assert!(validate_fork_name("-oops").is_err());
        assert_eq!(validate_fork_name(" my-branch ").unwrap(), "my-branch");
    }

    #[test]
    fn fork_argv_never_emits_type_flag_or_volume_flag() {
        let p = profile();
        let list = build_fork_list_argv(&p);
        let create = build_fork_create_argv(&p, "child", Some("main"), Some("1d"));
        let delete = build_fork_delete_argv(&p, "child", true);
        let restore = build_fork_restore_argv(&p, "child");
        for argv in [&list, &create, &delete, &restore] {
            assert!(!argv.iter().any(|arg| arg.starts_with("--type")));
            assert!(!argv.contains(&"--volname".to_string()));
            assert!(!argv.contains(&"-m".to_string()));
        }
        assert!(list.contains(&"--json".to_string()));
        assert!(create.contains(&"--parent=main".to_string()));
        assert!(create.contains(&"--as-of=1d".to_string()));
        // time.Parse/time.ParseInLocation don't trim, so surrounding
        // whitespace must be stripped before it reaches argv.
        let padded = build_fork_create_argv(&p, "child", Some("  main  "), Some("  1d  "));
        assert!(padded.contains(&"--parent=main".to_string()));
        assert!(padded.contains(&"--as-of=1d".to_string()));
        assert!(delete.contains(&"--force".to_string()));
        assert!(list.contains(&"list".to_string()));
        assert!(restore.contains(&"restore".to_string()));
    }

    #[test]
    fn satellite_volname_falls_back_when_profile_volume_empty() {
        let mut p = profile();
        let snap = satellite_volname(&p, "snapshot");
        assert!(snap.starts_with("Team files-snap-"), "{snap}");
        assert_eq!(snap.len(), "Team files-snap-".len() + 4);
        p.volume = String::new();
        let deleted = satellite_volname(&p, "deleted");
        assert!(deleted.starts_with("mountOS-del-"), "{deleted}");
        assert_eq!(deleted.len(), "mountOS-del-".len() + 4);
    }

    #[test]
    fn view_destination_must_be_absolute_and_differ_from_profile_mount_path() {
        let p = profile();
        assert!(validate_view_destination(&p, "").is_err());
        assert!(validate_view_destination(&p, "relative/path").is_err());
        assert!(validate_view_destination(&p, &p.mount_path).is_err());
        assert!(validate_view_destination(&p, "/tmp/some-other-view").is_ok());
    }

    #[test]
    fn builds_gateway_only_argv_with_no_mount_point_or_volname() {
        let p = profile();
        let argv = build_gateway_argv(&p, &["s3".to_string()], None, true, false, None, None);
        assert_eq!(argv[0], "gateway");
        assert!(!argv.contains(&"-m".to_string()));
        assert!(!argv.contains(&"--volname".to_string()));
        assert!(argv.windows(2).any(|pair| pair == ["--fork-name", "main"]));
        assert!(argv.contains(&"-s".to_string()));
        assert!(argv.windows(2).any(|pair| pair == ["--gateway", "s3"]));
    }

    #[test]
    fn builds_gateway_combo_argv_reusing_full_mount_argv() {
        let p = profile();
        let argv = build_gateway_argv(
            &p,
            &["s3".to_string(), "hdfs".to_string()],
            Some("9001"),
            false,
            false,
            None,
            None,
        );
        assert_eq!(argv[0], "mount");
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["-m", p.mount_path.as_str()]));
        assert!(argv.windows(2).any(|pair| pair == ["--gateway", "s3,hdfs"]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--gateway-port", "9001"]));
        assert!(!argv.contains(&"--gateway-only".to_string()));
    }

    #[test]
    fn gateway_argv_carries_temporary_fork_in_combo_and_gateway_only() {
        let mut p = profile();
        p.temporary_fork = true;

        let combo = build_gateway_argv(&p, &["s3".to_string()], None, false, false, None, None);
        assert!(combo.contains(&"--temporary-fork".to_string()));

        let gateway_only =
            build_gateway_argv(&p, &["hdfs".to_string()], None, true, false, None, None);
        assert_eq!(gateway_only[0], "gateway");
        assert!(gateway_only.contains(&"--temporary-fork".to_string()));

        p.temporary_fork = false;
        let combo_off = build_gateway_argv(&p, &["s3".to_string()], None, false, false, None, None);
        let gateway_only_off =
            build_gateway_argv(&p, &["s3".to_string()], None, true, false, None, None);
        assert!(!combo_off.contains(&"--temporary-fork".to_string()));
        assert!(!gateway_only_off.contains(&"--temporary-fork".to_string()));
    }

    #[test]
    fn gateway_argv_omits_port_and_tls_when_blank() {
        let p = profile();
        let argv = build_gateway_argv(&p, &["s3".to_string()], Some("  "), true, false, None, None);
        assert!(!argv.iter().any(|arg| arg == "--gateway-port"));
        assert!(!argv.contains(&"--gateway-cert".to_string()));
        assert!(!argv.contains(&"--gateway-key".to_string()));
    }

    #[test]
    fn gateway_argv_emits_tls_flags_only_when_both_cert_and_key_present() {
        let p = profile();
        let argv = build_gateway_argv(
            &p,
            &["s3".to_string()],
            None,
            true,
            true,
            Some("/tmp/cert.pem"),
            Some("/tmp/key.pem"),
        );
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--gateway-cert", "/tmp/cert.pem"]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--gateway-key", "/tmp/key.pem"]));
        assert!(argv.contains(&"--gateway-no-loopback".to_string()));

        let missing_key = build_gateway_argv(
            &p,
            &["s3".to_string()],
            None,
            true,
            false,
            Some("/tmp/cert.pem"),
            None,
        );
        assert!(!missing_key.contains(&"--gateway-cert".to_string()));

        // checkCertKeyReadable opens the path verbatim (no trimming); a
        // padded value from a hand-typed field must be trimmed here or the
        // file lookup fails even though the path itself is valid.
        let padded = build_gateway_argv(
            &p,
            &["s3".to_string()],
            None,
            true,
            true,
            Some("  /tmp/cert.pem  "),
            Some("  /tmp/key.pem  "),
        );
        assert!(padded
            .windows(2)
            .any(|pair| pair == ["--gateway-cert", "/tmp/cert.pem"]));
        assert!(padded
            .windows(2)
            .any(|pair| pair == ["--gateway-key", "/tmp/key.pem"]));
    }

    #[test]
    fn satellite_and_gateway_only_argv_include_cache_dir_and_extra_args() {
        // profile() carries cache_dir "/tmp/mountos cache", cache_size "10G",
        // and extra_args ["--attr-cache", "2.0"] -- the server resolves these
        // unconditionally regardless of subcommand, so every builder besides
        // the mount+gateway combo (which already goes through
        // build_mount_argv) must emit them too.
        let p = profile();
        let snapshot = build_snapshot_argv(&p, "/tmp/snap-view", "1d");
        let deleted = build_deleted_argv(&p, "/tmp/deleted-view", None, None);
        let version = build_version_argv(&p, "/tmp/version-view", None, Some(1), None, None, false);
        let gateway_only =
            build_gateway_argv(&p, &["s3".to_string()], None, true, false, None, None);
        for argv in [&snapshot, &deleted, &version, &gateway_only] {
            assert!(
                argv.windows(2)
                    .any(|pair| pair == ["--disk-cache-dir", "/tmp/mountos cache"]),
                "missing --disk-cache-dir in {argv:?}"
            );
            assert!(
                argv.windows(2)
                    .any(|pair| pair == ["--disk-cache-size", "10G"]),
                "missing --disk-cache-size in {argv:?}"
            );
            assert!(
                argv.windows(2).any(|pair| pair == ["--attr-cache", "2.0"]),
                "missing extra_args in {argv:?}"
            );
        }
    }

    #[test]
    fn finds_gateway_descriptor_by_exact_pid_only() {
        let dir = std::env::temp_dir();
        // A same-volume, same-machine descriptor at a DIFFERENT pid must
        // never be picked up -- this is exactly the misattribution the
        // pid-exact lookup replaces a fuzzy volume-name+recency scan to
        // avoid (a stale heuristic could otherwise hand this launch a
        // different launch's live PID, which then feeds straight into
        // Stop-gateway).
        let other_path = dir.join("mountOS-999902.gateway.json");
        fs::write(
            &other_path,
            r#"{"endpoints":{"s3":{"url":"http://127.0.0.1:2"}},"volume_name":"Team files","pid":999902}"#,
        )
        .unwrap();

        let match_path = dir.join("mountOS-999903.gateway.json");
        fs::write(
            &match_path,
            r#"{"endpoints":{"s3":{"url":"http://127.0.0.1:9001","region":"us-east-1"}},"volume_name":"Team files","pid":999903}"#,
        )
        .unwrap();

        let found = find_gateway_descriptor(999903);

        fs::remove_file(&other_path).ok();
        fs::remove_file(&match_path).ok();

        let descriptor = found.expect("expected the exact-pid descriptor");
        assert_eq!(descriptor.pid, 999903);
        assert_eq!(descriptor.endpoints["s3"].url, "http://127.0.0.1:9001");
        assert_eq!(descriptor.endpoints["s3"].region, "us-east-1");

        assert!(find_gateway_descriptor(999_999_001).is_none());
    }

    #[test]
    fn parses_started_pid_from_daemon_stdout() {
        assert_eq!(
            parse_started_pid("mountOS started with PID: 12345\n"),
            Some(12345)
        );
        assert_eq!(
            parse_started_pid("some log line\nmountOS started with PID: 42\nmore output\n"),
            Some(42)
        );
        assert_eq!(parse_started_pid("no pid line here"), None);
        assert_eq!(parse_started_pid("started with PID: "), None);
    }

    #[test]
    fn stop_gateway_refuses_a_pid_it_never_discovered() {
        // Regression guard for the trust boundary itself: a pid must be
        // registered via known_gateway_pids() before stop_gateway_blocking
        // will even consider it, independent of whether a process happens
        // to exist at that number.
        let unknown_pid = 999_999_002;
        assert!(!known_gateway_pids()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(&unknown_pid));
        let result = stop_gateway_blocking(unknown_pid);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("refusing to stop"));
    }

    fn upload_params() -> UploadStartParams {
        UploadStartParams {
            once: false,
            overwrite: false,
            dry_run: false,
            rescan_interval: None,
            restart: false,
            bwlimit: None,
            include: Vec::new(),
            exclude: Vec::new(),
            follow_symlinks: false,
            create_source_directory: false,
        }
    }

    #[test]
    fn build_upload_start_argv_emits_source_and_dest_as_bare_positionals_after_dashdash() {
        let argv = build_upload_start_argv(
            &profile(),
            "/local/photos",
            "/remote/photos",
            &upload_params(),
        );
        assert_eq!(argv[0], "upload");
        // Every flag comes before "--", then exactly the two positionals --
        // this is what makes an arbitrary (even flag-shaped) source/dest
        // value safe: pflag stops scanning for flags at "--".
        let dashdash = argv
            .iter()
            .position(|a| a == "--")
            .expect("must contain a literal \"--\" separator");
        assert_eq!(&argv[dashdash + 1..], &["/local/photos", "/remote/photos"]);
        assert!(argv
            .windows(2)
            .any(|args| args == ["--discovery-url", "https://hub.example.com"]));
        // Fork is always derived from the profile now (fixture has "main"),
        // never a form field.
        assert!(argv.windows(2).any(|args| args == ["--fork", "main"]));
        assert!(argv.contains(&"-a".to_string()));
        assert!(argv.contains(&"-s".to_string()));
        // Defaults: no flags for anything the form left off.
        assert!(!argv.contains(&"--once".to_string()));
        assert!(!argv.contains(&"--overwrite".to_string()));
        assert!(!argv.contains(&"--dry-run".to_string()));
        assert!(!argv.contains(&"--restart".to_string()));
        assert!(!argv.contains(&"--follow-symlinks".to_string()));
        assert!(!argv.contains(&"--create-source-directory".to_string()));
    }

    #[test]
    fn build_upload_start_argv_emits_every_flag_when_set() {
        let mut params = upload_params();
        params.once = true;
        params.overwrite = true;
        params.dry_run = true;
        params.rescan_interval = Some(" 1m ".to_string());
        params.restart = true;
        params.bwlimit = Some(50);
        params.include = vec!["*.jpg".to_string(), "  ".to_string()];
        params.exclude = vec!["*.tmp".to_string()];
        params.follow_symlinks = true;
        params.create_source_directory = true;

        let argv = build_upload_start_argv(&profile(), "/src", "/dst", &params);
        assert!(argv.windows(2).any(|a| a == ["--fork", "main"]));
        assert!(argv.contains(&"--once".to_string()));
        assert!(argv.contains(&"--overwrite".to_string()));
        assert!(argv.contains(&"--dry-run".to_string()));
        assert!(argv.windows(2).any(|a| a == ["--rescan-interval", "1m"]));
        assert!(argv.contains(&"--restart".to_string()));
        assert!(argv.windows(2).any(|a| a == ["--bwlimit", "50"]));
        assert!(argv.windows(2).any(|a| a == ["--include", "*.jpg"]));
        // A blank include/exclude entry (e.g. a stray empty row in the form)
        // must never reach argv as a bare "--include" with nothing after it.
        assert_eq!(argv.iter().filter(|a| *a == "--include").count(), 1);
        assert!(argv.windows(2).any(|a| a == ["--exclude", "*.tmp"]));
        assert!(argv.contains(&"--follow-symlinks".to_string()));
        assert!(argv.contains(&"--create-source-directory".to_string()));
    }

    #[test]
    fn build_upload_start_argv_omits_bwlimit_when_zero() {
        let mut params = upload_params();
        params.bwlimit = Some(0);
        let argv = build_upload_start_argv(&profile(), "/src", "/dst", &params);
        assert!(!argv.contains(&"--bwlimit".to_string()));
    }

    #[test]
    fn build_upload_resume_argv_has_a_smaller_flag_surface_than_start() {
        let argv = build_upload_resume_argv(&profile(), "abcdef1234567890", true, Some(" 45s "));
        assert_eq!(argv[0], "upload");
        assert_eq!(argv[1], "resume");
        assert_eq!(argv[2], "abcdef1234567890");
        assert!(argv.contains(&"--once".to_string()));
        assert!(argv.windows(2).any(|a| a == ["--rescan-interval", "45s"]));
        assert!(!argv.contains(&"--overwrite".to_string()));
        assert!(!argv.contains(&"--bwlimit".to_string()));
        assert!(!argv.contains(&"--dry-run".to_string()));
    }

    fn sink_params() -> SinkStartParams {
        SinkStartParams {
            variant: None,
            max_latency: None,
            wal_max: None,
        }
    }

    // Fixture argv shared with src/lib/cli.test.ts's identically-named
    // TypeScript test -- both assert this EXACT array for the SAME inputs,
    // so a change to one flag's spelling/order that isn't mirrored in the
    // other builder fails one of the two suites. This is the closest a Rust
    // test and a Vitest test can get to enforcing "the preview argv IS what
    // runs" without literally invoking both from one process.
    #[test]
    fn build_sink_start_argv_emits_source_and_dest_as_bare_positionals_after_dashdash() {
        let argv = build_sink_start_argv(
            &profile(),
            "https://example.com/live/stream.m3u8",
            "/recordings/feed.mp4",
            &sink_params(),
        );
        assert_eq!(
            argv,
            vec![
                "sink",
                "--discovery-url",
                "https://hub.example.com",
                "--fork",
                "main",
                "-a",
                "ABCDEFGHIJKLMNOPQRST",
                "-s",
                "--",
                "https://example.com/live/stream.m3u8",
                "/recordings/feed.mp4",
            ]
        );
    }

    #[test]
    fn build_sink_start_argv_emits_every_flag_when_set() {
        let mut params = sink_params();
        params.variant = Some(" 1080p ".to_string());
        params.max_latency = Some(" 45s ".to_string());
        params.wal_max = Some(" 512M ".to_string());
        let argv = build_sink_start_argv(
            &profile(),
            "https://example.com/live.m3u8",
            "/feed.mp4",
            &params,
        );
        assert!(argv.windows(2).any(|a| a == ["--variant", "1080p"]));
        assert!(argv.windows(2).any(|a| a == ["--max-latency", "45s"]));
        assert!(argv.windows(2).any(|a| a == ["--wal-max", "512M"]));
        // sink never had once/overwrite/dry-run/bwlimit/include/exclude/
        // follow-symlinks/create-source-directory to begin with -- confirms
        // none of upload's flag surface leaked in by copy-paste habit.
        assert!(!argv.contains(&"--once".to_string()));
        assert!(!argv.contains(&"--overwrite".to_string()));
        assert!(!argv.contains(&"--dry-run".to_string()));
        assert!(!argv.contains(&"--bwlimit".to_string()));
        assert!(!argv.contains(&"--include".to_string()));
        assert!(!argv.contains(&"--follow-symlinks".to_string()));
        assert!(!argv.contains(&"--create-source-directory".to_string()));
        assert!(!argv.contains(&"--config".to_string()));
    }

    #[test]
    fn build_sink_start_argv_omits_unset_advanced_flags() {
        let argv = build_sink_start_argv(
            &profile(),
            "https://example.com/live.m3u8",
            "/feed.mp4",
            &sink_params(),
        );
        assert!(!argv.contains(&"--variant".to_string()));
        assert!(!argv.contains(&"--max-latency".to_string()));
        assert!(!argv.contains(&"--wal-max".to_string()));
    }

    #[test]
    fn build_sink_resume_argv_has_no_flags_of_its_own() {
        let argv = build_sink_resume_argv(&profile(), "abcdef1234567890");
        assert_eq!(
            argv,
            vec![
                "sink",
                "resume",
                "abcdef1234567890",
                "--discovery-url",
                "https://hub.example.com",
                "-a",
                "ABCDEFGHIJKLMNOPQRST",
                "-s",
            ]
        );
    }

    #[test]
    fn build_sink_list_cancel_finish_status_argv_carry_no_profile() {
        assert_eq!(build_sink_list_argv(), vec!["sink", "list", "--json"]);
        assert_eq!(
            build_sink_cancel_argv("abcdef1234567890"),
            vec!["sink", "cancel", "abcdef1234567890"]
        );
        assert_eq!(
            build_sink_finish_argv("abcdef1234567890"),
            vec!["sink", "finish", "abcdef1234567890"]
        );
        assert_eq!(
            build_sink_status_argv("abcdef1234567890"),
            vec!["sink", "status", "--job", "abcdef1234567890", "--json"]
        );
    }

    #[test]
    fn build_sink_prune_argv_omits_keep_at_zero() {
        assert_eq!(build_sink_prune_argv(0), vec!["sink", "prune"]);
        assert_eq!(
            build_sink_prune_argv(5),
            vec!["sink", "prune", "--keep", "5"]
        );
    }

    #[test]
    fn parse_sinks_value_carries_file_count_and_current_path() {
        let value: Value = serde_json::from_str(
            r#"[{"jobId": "abc", "state": "running",
                 "fileCount": 3, "currentPath": "/sinktest/roll-20260804-1015.ts"}]"#,
        )
        .unwrap();
        let jobs = parse_sinks_value(&value);
        assert_eq!(jobs[0].file_count, Some(3));
        assert_eq!(
            jobs[0].current_path.as_deref(),
            Some("/sinktest/roll-20260804-1015.ts")
        );
    }

    #[test]
    fn parse_sinks_value_defaults_file_count_and_current_path_to_none() {
        let value: Value =
            serde_json::from_str(r#"[{"jobId": "abc", "state": "running"}]"#).unwrap();
        let jobs = parse_sinks_value(&value);
        assert_eq!(jobs[0].file_count, None);
        assert_eq!(jobs[0].current_path, None);
    }

    #[test]
    fn parse_sink_snapshot_value_reads_camel_case_keys_and_normalizes_zero_time() {
        let value = serde_json::json!({
            "state": "running",
            "lagSegments": 2,
            "lagSeconds": 4.5,
            "walBytes": 1024,
            "walSegments": 3,
            "discontinuities": 0,
            "segmentsFetched": 10,
            "segmentsCommitted": 8,
            "bytesCommitted": 4096,
            "fileSize": 8192,
            "bitrateObserved": 512000.0,
            "fetchErrors": 1,
            "commitRetries": 0,
            "fileCount": 3,
            "currentPath": "/sinktest/roll-20260804-1015.ts",
            "lastCommitAt": "2026-08-04T10:15:30Z",
            "lastSegmentAt": "0001-01-01T00:00:00Z",
        });
        let snap = parse_sink_snapshot_value(&value);
        assert_eq!(snap.state, "running");
        assert_eq!(snap.lag_segments, 2);
        assert_eq!(snap.wal_segments, 3);
        assert_eq!(snap.segments_committed, 8);
        assert_eq!(snap.file_size, 8192);
        assert_eq!(snap.file_count, 3);
        assert_eq!(snap.current_path, "/sinktest/roll-20260804-1015.ts");
        assert_eq!(snap.last_commit_at.as_deref(), Some("2026-08-04T10:15:30Z"));
        // Go's zero time.Time must never reach the frontend as a real value.
        assert_eq!(snap.last_segment_at, None);
    }

    #[test]
    fn parse_sink_status_value_handles_a_non_running_job_with_no_snapshot() {
        let value = serde_json::json!({
            "jobId": "abcdef1234567890",
            "running": false,
            "state": "halted",
            "source": "https://example.com/live.m3u8",
            "sinkTemplate": "/feed.mp4",
            "fork": "main",
            "haltReason": "source ended unexpectedly",
        });
        let status = parse_sink_status_value(&value).unwrap();
        assert_eq!(status.job_id, "abcdef1234567890");
        assert!(!status.running);
        assert_eq!(status.state, "halted");
        assert_eq!(
            status.halt_reason.as_deref(),
            Some("source ended unexpectedly")
        );
        assert!(status.snapshot.is_none());
        assert!(!status.last_known);
    }

    #[test]
    fn parse_sink_status_value_carries_last_known_through_to_the_frontend() {
        let value = serde_json::json!({
            "jobId": "abcdef1234567890",
            "running": false,
            "state": "halted",
            "source": "https://example.com/live.m3u8",
            "sinkTemplate": "/feed.mp4",
            "fork": "main",
            "lastKnown": true,
            "snapshot": {
                "state": "",
                "segmentsCommitted": 500,
                "fileSize": 2_000_000_000i64,
            },
        });
        let status = parse_sink_status_value(&value).unwrap();
        assert!(status.last_known);
        let snapshot = status.snapshot.expect("cached snapshot present");
        assert_eq!(snapshot.segments_committed, 500);
        // SinkCachedCounts does not persist commit/segment timestamps, so a
        // cached snapshot must never fabricate one.
        assert_eq!(snapshot.last_commit_at, None);
    }

    #[test]
    fn matching_vault_profile_finds_none_when_no_profile_shares_the_key() {
        let profiles = vec![profile()];
        assert!(matching_vault_profile(&profiles, "SOME-OTHER-ACCESS-KEY").is_none());
    }

    #[test]
    fn matching_vault_profile_finds_none_when_the_only_match_is_prompt_only() {
        let mut p = profile();
        p.secret_ref = "prompt".to_string();
        let profiles = vec![p.clone()];
        assert!(matching_vault_profile(&profiles, &p.access_key_id).is_none());
    }

    #[test]
    fn matching_vault_profile_finds_the_single_vault_match() {
        let mut p = profile();
        p.secret_ref = "vault".to_string();
        let profiles = vec![p.clone()];
        let found = matching_vault_profile(&profiles, &p.access_key_id).expect("expected a match");
        assert_eq!(found.id, p.id);
    }

    #[test]
    fn matching_vault_profile_finds_the_vault_sibling_even_when_a_prompt_only_profile_matches_first(
    ) {
        // Regression: read_profiles sorts newest-updated-first, so a naive
        // "first profile with this access key" match can land on a
        // secret_ref: "prompt" profile while an older sibling actually has
        // the secret cached in the vault -- the vault entry must still be
        // found, not shadowed by the prompt-only profile ordered ahead of it.
        let mut prompt_only = profile();
        prompt_only.id = "profile-newer".to_string();
        prompt_only.secret_ref = "prompt".to_string();
        let mut vault_backed = profile();
        vault_backed.id = "profile-older".to_string();
        vault_backed.secret_ref = "vault".to_string();
        let profiles = vec![prompt_only, vault_backed.clone()];
        let found = matching_vault_profile(&profiles, &vault_backed.access_key_id)
            .expect("expected a match");
        assert_eq!(found.id, "profile-older");
    }

    #[test]
    fn resume_profile_carries_only_discovery_url_and_access_key_into_the_argv() {
        // Resume must work from just these two fields, independent of any
        // saved profile (e.g. a job started via the CLI with no GUI profile
        // at all) -- the synthetic profile's other fields (volume/fork/
        // mountPath/backend) must never leak into the resume argv.
        let profile = resume_profile(
            "https://discovery.example".to_string(),
            "ak_1234567890".to_string(),
        );
        let argv = build_upload_resume_argv(&profile, "abcdef1234567890", false, None);
        assert!(argv
            .windows(2)
            .any(|a| a == ["--discovery-url", "https://discovery.example"]));
        assert!(argv.windows(2).any(|a| a == ["-a", "ak_1234567890"]));
        assert!(argv.contains(&"-s".to_string()));
    }

    #[test]
    fn upload_local_only_argv_builders_carry_no_credentials_or_discovery_url() {
        assert_eq!(
            build_upload_list_argv(),
            vec!["list", "--kind", "upload", "--json"]
        );
        assert_eq!(
            build_upload_cancel_argv("job123"),
            vec!["upload", "cancel", "job123"]
        );
        assert_eq!(
            build_upload_retry_failed_argv("job123"),
            vec!["upload", "retry-failed", "job123"]
        );
        assert_eq!(build_upload_prune_argv(0), vec!["upload", "prune"]);
        assert_eq!(
            build_upload_prune_argv(5),
            vec!["upload", "prune", "--keep", "5"]
        );
    }

    #[test]
    fn validate_upload_job_id_accepts_only_16_lowercase_hex_chars() {
        assert!(validate_upload_job_id("0123456789abcdef").is_ok());
        assert!(validate_upload_job_id("").is_err());
        assert!(validate_upload_job_id("-rf").is_err());
        assert!(validate_upload_job_id("0123456789ABCDEF").is_err());
        assert!(validate_upload_job_id("0123456789abcde").is_err());
        assert!(validate_upload_job_id("0123456789abcdef0").is_err());
        assert!(validate_upload_job_id("0123456789abcdeg").is_err());
    }

    #[test]
    fn validate_upload_positional_rejects_flag_shaped_and_nul_values() {
        assert!(validate_upload_positional("/normal/path", "source").is_ok());
        assert!(validate_upload_positional("-rf", "source").is_err());
        assert!(validate_upload_positional("--restart", "destination").is_err());
        assert!(validate_upload_positional("path\0with\0nul", "source").is_err());
    }

    #[test]
    fn parse_instances_value_excludes_upload_and_download_job_rows() {
        let value: Value = serde_json::from_str(
            r#"[
                {"kind": "mount", "name": "Team", "mountPath": "/Volumes/MountOS/Team"},
                {"kind": "upload", "name": "upload-abc123", "jobId": "abc123"},
                {"kind": "download", "name": "download-def456", "jobId": "def456"}
            ]"#,
        )
        .unwrap();
        let instances = parse_instances_value(&value);
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].mount_path, "/Volumes/MountOS/Team");
    }

    #[test]
    fn parse_uploads_value_skips_non_upload_kinds_and_fills_defaults() {
        let value: Value = serde_json::from_str(
            r#"[
                {"kind": "mount", "name": "Team", "mountPath": "/Volumes/MountOS/Team"},
                {"kind": "upload", "name": "upload-abc123", "jobId": "abc123",
                 "sourcePath": "/local/photos", "destPath": "/remote/photos",
                 "state": "running", "counts": {"done": 3, "pending": 1}, "volumeId": 42}
            ]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, "abc123");
        assert_eq!(jobs[0].source_path.as_deref(), Some("/local/photos"));
        assert_eq!(jobs[0].dest_path.as_deref(), Some("/remote/photos"));
        assert_eq!(jobs[0].state, "running");
        assert_eq!(jobs[0].counts.get("done"), Some(&3));
        assert_eq!(jobs[0].counts.get("pending"), Some(&1));
        assert_eq!(jobs[0].volume_id, Some(42));
    }

    #[test]
    fn parse_uploads_value_drops_an_entry_with_no_job_id() {
        let value: Value =
            serde_json::from_str(r#"[{"kind": "upload", "name": "broken"}]"#).unwrap();
        assert!(parse_uploads_value(&value).is_empty());
    }

    #[test]
    fn parse_uploads_value_carries_created_and_completed_at() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc",
                 "state": "completed", "createdAt": 1000, "completedAt": 2000}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].created_at, Some(1000));
        assert_eq!(jobs[0].completed_at, Some(2000));
    }

    #[test]
    fn parse_uploads_value_defaults_created_and_completed_at_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs[0].created_at, None);
        assert_eq!(jobs[0].completed_at, None);
    }

    #[test]
    fn parse_uploads_value_carries_log_path() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc",
                 "state": "completed", "logPath": "/Users/x/.mountOS/logs/mountos-mfuse-123.log"}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(
            jobs[0].log_path.as_deref(),
            Some("/Users/x/.mountOS/logs/mountos-mfuse-123.log")
        );
    }

    #[test]
    fn parse_uploads_value_defaults_log_path_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs[0].log_path, None);
    }

    #[test]
    fn parse_uploads_value_carries_totals() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc",
                 "state": "completed", "totalFiles": 3, "totalBytes": 6144}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs[0].total_files, Some(3));
        assert_eq!(jobs[0].total_bytes, Some(6144));
    }

    #[test]
    fn parse_uploads_value_defaults_totals_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "upload", "name": "upload-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_uploads_value(&value);
        assert_eq!(jobs[0].total_files, None);
        assert_eq!(jobs[0].total_bytes, None);
    }

    fn download_params() -> DownloadStartParams {
        DownloadStartParams {
            if_exists: "skip".to_string(),
            depth: 1,
            as_of: None,
            dry_run: false,
            restart: false,
            bwlimit_mbps: None,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            follow_symlinks: false,
            create_source_directory: false,
        }
    }

    #[test]
    fn build_download_start_argv_emits_source_and_dest_as_bare_positionals_after_dashdash() {
        let argv = build_download_start_argv(
            Some(&profile()),
            DownloadSourceKind::Profile,
            "photos",
            "/local/backups/photos",
            &download_params(),
        );
        assert_eq!(argv[0], "download");
        let dashdash = argv
            .iter()
            .position(|a| a == "--")
            .expect("must contain a literal \"--\" separator");
        assert_eq!(
            &argv[dashdash + 1..],
            &["photos", "/local/backups/photos"]
        );
        assert!(argv
            .windows(2)
            .any(|a| a == ["--discovery-url", "https://hub.example.com"]));
        assert!(argv.windows(2).any(|a| a == ["--fork", "main"]));
        assert!(argv.contains(&"-a".to_string()));
        assert!(argv.contains(&"-s".to_string()));
        // Defaults: if-exists/depth match the server default and are
        // omitted; every optional flag the form left off is absent too.
        assert!(!argv.contains(&"--if-exists".to_string()));
        assert!(!argv.contains(&"--depth".to_string()));
        assert!(!argv.contains(&"--as-of".to_string()));
        assert!(!argv.contains(&"--dry-run".to_string()));
        assert!(!argv.contains(&"--restart".to_string()));
        assert!(!argv.contains(&"--follow-symlinks".to_string()));
        assert!(!argv.contains(&"--create-source-directory".to_string()));
    }

    #[test]
    fn build_download_start_argv_instance_mode_emits_no_connection_flags_at_all() {
        // Mode A: no --discovery-url/--fork/--as-of/-a/-s, even when a
        // populated profile is passed by mistake -- source_kind gates this,
        // not profile emptiness, so a stray Some(profile) must still be
        // fully ignored for connection flags.
        let mut params = download_params();
        params.as_of = Some("1d".to_string());
        let argv = build_download_start_argv(
            Some(&profile()),
            DownloadSourceKind::Instance,
            "/Volumes/myvol/photos",
            "/local/backups/photos",
            &params,
        );
        assert!(!argv.contains(&"--discovery-url".to_string()));
        assert!(!argv.contains(&"--fork".to_string()));
        assert!(!argv.contains(&"--as-of".to_string()));
        assert!(!argv.iter().any(|a| a.starts_with("--as-of=")));
        assert!(!argv.contains(&"-a".to_string()));
        assert!(!argv.contains(&"-s".to_string()));
        let dashdash = argv.iter().position(|a| a == "--").expect("has --");
        assert_eq!(
            &argv[dashdash + 1..],
            &["/Volumes/myvol/photos", "/local/backups/photos"]
        );
    }

    #[test]
    fn build_download_start_argv_emits_every_flag_when_set() {
        let mut params = download_params();
        params.if_exists = "overwrite".to_string();
        params.depth = 0;
        params.as_of = Some(" 1d ".to_string());
        params.dry_run = true;
        params.restart = true;
        params.bwlimit_mbps = Some(50);
        params.include_globs = vec!["*.jpg".to_string(), "  ".to_string()];
        params.exclude_globs = vec!["*.tmp".to_string()];
        params.follow_symlinks = true;
        params.create_source_directory = true;

        let argv = build_download_start_argv(
            Some(&profile()),
            DownloadSourceKind::Profile,
            "photos",
            "/dst",
            &params,
        );
        assert!(argv
            .windows(2)
            .any(|a| a == ["--if-exists", "overwrite"]));
        assert!(argv.windows(2).any(|a| a == ["--depth", "0"]));
        assert!(argv.contains(&"--as-of=1d".to_string()));
        assert!(argv.contains(&"--dry-run".to_string()));
        assert!(argv.contains(&"--restart".to_string()));
        assert!(argv.windows(2).any(|a| a == ["--bwlimit", "50"]));
        assert!(argv.windows(2).any(|a| a == ["--include", "*.jpg"]));
        assert_eq!(argv.iter().filter(|a| *a == "--include").count(), 1);
        assert!(argv.windows(2).any(|a| a == ["--exclude", "*.tmp"]));
        assert!(argv.contains(&"--follow-symlinks".to_string()));
        assert!(argv.contains(&"--create-source-directory".to_string()));
    }

    #[test]
    fn build_download_start_argv_omits_bwlimit_when_zero() {
        let mut params = download_params();
        params.bwlimit_mbps = Some(0);
        let argv = build_download_start_argv(
            Some(&profile()),
            DownloadSourceKind::Profile,
            "photos",
            "/dst",
            &params,
        );
        assert!(!argv.contains(&"--bwlimit".to_string()));
    }

    #[test]
    fn build_download_resume_argv_has_a_smaller_flag_surface_than_start() {
        let argv = build_download_resume_argv(&profile(), "abcdef1234567890");
        assert_eq!(argv[0], "download");
        assert_eq!(argv[1], "resume");
        assert_eq!(argv[2], "abcdef1234567890");
        assert!(argv
            .windows(2)
            .any(|a| a == ["--discovery-url", "https://hub.example.com"]));
        assert!(argv.contains(&"-a".to_string()));
        assert!(argv.contains(&"-s".to_string()));
        // download resume has no --once/--rescan-interval/--dry-run at all.
        assert!(!argv.contains(&"--once".to_string()));
        assert!(!argv.contains(&"--rescan-interval".to_string()));
        assert!(!argv.contains(&"--dry-run".to_string()));
    }

    #[test]
    fn build_download_resume_argv_mounted_source_carries_no_credentials() {
        // A mode-A (mounted source) resume's synthetic profile has blank
        // discoveryUrl/accessKeyId -- resume_download_blocking builds one
        // via resume_profile("".to_string(), "".to_string()) for that case.
        let mounted = resume_profile(String::new(), String::new());
        let argv = build_download_resume_argv(&mounted, "abcdef1234567890");
        assert_eq!(argv, vec!["download", "resume", "abcdef1234567890"]);
    }

    #[test]
    fn download_local_only_argv_builders_carry_no_credentials_or_discovery_url() {
        assert_eq!(
            build_download_list_argv(),
            vec!["list", "--kind", "download", "--json"]
        );
        assert_eq!(
            build_download_cancel_argv("job123"),
            vec!["download", "cancel", "job123"]
        );
        assert_eq!(
            build_download_retry_failed_argv("job123"),
            vec!["download", "retry-failed", "job123"]
        );
        assert_eq!(build_download_prune_argv(0), vec!["download", "prune"]);
        assert_eq!(
            build_download_prune_argv(5),
            vec!["download", "prune", "--keep", "5"]
        );
    }

    #[test]
    fn parse_downloads_value_skips_non_download_kinds_and_fills_defaults() {
        let value: Value = serde_json::from_str(
            r#"[
                {"kind": "upload", "name": "upload-abc", "jobId": "upl"},
                {"kind": "download", "name": "download-abc123", "jobId": "abc123",
                 "sourcePath": "/remote/photos", "destPath": "/local/photos",
                 "state": "running", "counts": {"done": 3, "retrying": 1}, "volumeId": 42}
            ]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, "abc123");
        assert_eq!(jobs[0].source_path.as_deref(), Some("/remote/photos"));
        assert_eq!(jobs[0].dest_path.as_deref(), Some("/local/photos"));
        assert_eq!(jobs[0].state, "running");
        assert_eq!(jobs[0].counts.get("done"), Some(&3));
        assert_eq!(jobs[0].counts.get("retrying"), Some(&1));
        assert_eq!(jobs[0].volume_id, Some(42));
    }

    #[test]
    fn parse_downloads_value_drops_an_entry_with_no_job_id() {
        let value: Value =
            serde_json::from_str(r#"[{"kind": "download", "name": "broken"}]"#).unwrap();
        assert!(parse_downloads_value(&value).is_empty());
    }

    #[test]
    fn parse_downloads_value_carries_created_and_completed_at() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc",
                 "state": "completed", "createdAt": 1000, "completedAt": 2000}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].created_at, Some(1000));
        assert_eq!(jobs[0].completed_at, Some(2000));
    }

    #[test]
    fn parse_downloads_value_defaults_created_and_completed_at_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs[0].created_at, None);
        assert_eq!(jobs[0].completed_at, None);
    }

    #[test]
    fn parse_downloads_value_carries_log_path() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc",
                 "state": "completed", "logPath": "/Users/x/.mountOS/logs/mountos-mfuse-123.log"}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(
            jobs[0].log_path.as_deref(),
            Some("/Users/x/.mountOS/logs/mountos-mfuse-123.log")
        );
    }

    #[test]
    fn parse_downloads_value_defaults_log_path_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs[0].log_path, None);
    }

    #[test]
    fn parse_downloads_value_carries_totals() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc",
                 "state": "completed", "totalFiles": 3, "totalBytes": 6144}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs[0].total_files, Some(3));
        assert_eq!(jobs[0].total_bytes, Some(6144));
    }

    #[test]
    fn parse_downloads_value_defaults_totals_to_none() {
        let value: Value = serde_json::from_str(
            r#"[{"kind": "download", "name": "download-abc", "jobId": "abc", "state": "running"}]"#,
        )
        .unwrap();
        let jobs = parse_downloads_value(&value);
        assert_eq!(jobs[0].total_files, None);
        assert_eq!(jobs[0].total_bytes, None);
    }
}
