<script lang="ts">
  import {
    ArrowRight,
    Check,
    ChevronLeft,
    Clock,
    Copy,
    Download,
    ExternalLink,
    FolderOpen,
    ListChecks,
    OctagonX,
    PanelLeftClose,
    Plus,
    RefreshCw,
    RotateCcw,
    Tag,
    Trash2,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Select } from '$lib/components/ui/select'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge'
  import { Table, TableBody, TableRow, TableCell } from '$lib/components/ui/table'
  import Combobox from '$lib/components/shared/Combobox.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import JobPanel from '$lib/components/shared/JobPanel.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseDownloadDestination,
    browseDownloadSource,
    buildDownloadResumeArgv,
    cancelDownloadResume,
    closeJobPanelFloating,
    computed,
    confirmDownloadResume,
    copyDownloadJobLogPath,
    enterDownloadCreate,
    exitDownloadCreate,
    openDownloadJobLog,
    requestDownloadPrune,
    requestDownloadResume,
    resetDownloadForm,
    runDownloadCancel,
    runDownloadFinish,
    runDownloadList,
    runDownloadRetryFailed,
    runDownloadStart,
    selectDownloadInstance,
    selectDownloadProfile,
    setJobPanelCollapsed,
  } from '$lib/app-state.svelte'
  import type { DownloadJob, MountInstance, MountProfile } from '$lib/types'
  import { formatBytes, lastFetchedLabel, matchesSearch } from '$lib/utils'

  // Fetch exactly once per mount, mirrors UploadsView's own fetchedOnce
  // gate (an empty job list is the normal first-run state, so gating on
  // length would refetch forever).
  let fetchedOnce = false
  $effect(() => {
    if (!fetchedOnce) {
      fetchedOnce = true
      void runDownloadList()
    }
  })

  // Ticks so "Updated Xs ago" stays live without a real refetch, mirrors
  // UploadsView's identical staleness indicator.
  let now = $state(Date.now())
  $effect(() => {
    const id = setInterval(() => { now = Date.now() }, 1000)
    return () => clearInterval(id)
  })

  const stateBadgeVariant: Record<string, BadgeVariant> = {
    running: 'success',
    halted: 'destructive',
    completed: 'secondary',
    'completed (failures)': 'warning',
    resumable: 'warning',
  }

  // Same client-side synthesis as UploadsView's displayState. The server's
  // own state has no "completed with failures" concept, so a settled job
  // that permanently dropped files would otherwise render an identical calm
  // "completed" badge to a fully clean one.
  function displayState(job: DownloadJob): string {
    return job.state === 'completed' && (job.counts.failed ?? 0) > 0 ? 'completed (failures)' : job.state
  }

  // A resumable job that never reached a terminal transition (cancelled
  // mid-drain, or an initial-scan failure that wasn't classified as a halt)
  // despite having 0 pending/downloading left has no way to become
  // "completed" short of reconnecting just to confirm what's already true
  // locally. Gates offering "Mark complete" (runDownloadFinish), which does
  // the same thing offline. Rarer than upload's equivalent case (download
  // never idles in a running-but-settled state, it stamps CompletedAt the
  // moment it settles), but the same cancellation gap can still produce it.
  function isDownloadFinishable(job: DownloadJob): boolean {
    return job.state === 'resumable' && !(job.counts.pending || job.counts.downloading)
  }

  const selectedJob = $derived(appState.downloads.find((job) => job.jobId === appState.downloadSelectedJobId) ?? null)

  $effect(() => {
    if (appState.downloadSelectedJobId && !computed.downloadVisibleJobs.some((job) => job.jobId === appState.downloadSelectedJobId)) {
      appState.downloadSelectedJobId = computed.downloadVisibleJobs[0]?.jobId ?? null
    } else if (!appState.downloadSelectedJobId && computed.downloadVisibleJobs.length > 0) {
      appState.downloadSelectedJobId = computed.downloadVisibleJobs[0].jobId
    }
  })

  function instanceLabel(instance: MountInstance): string {
    return instance.name || instance.mountPath
  }

  // Unlike UploadsView's single combined Combobox (profiles + instances
  // sharing one value namespace via a value prefix), download's two source
  // modes have genuinely different browse mechanics (an already-live mount
  // vs. a fresh scratch-mounted connection with its own fork/AsOf fields),
  // a segmented toggle picks the mode explicitly first, mirroring the
  // existing appState.snapshotTimeMode absolute/relative Button-group
  // pattern (see SnapshotView.svelte), then a mode-scoped Combobox picks the
  // actual source within it.
  function selectSourceKind(kind: 'instance' | 'profile') {
    if (kind === appState.downloadSourceKind) return
    if (kind === 'instance') {
      appState.downloadSourceKind = 'instance'
      appState.downloadSourceProfileId = null
      appState.downloadSourceInstance = null
      resetDownloadForm()
      return
    }
    const first = computed.downloadFilteredProfiles[0]
    if (first) {
      // selectDownloadProfile already resets the form as part of switching.
      selectDownloadProfile(first.id)
      return
    }
    appState.downloadSourceKind = 'profile'
    appState.downloadSourceProfileId = null
    appState.downloadSourceInstance = null
    resetDownloadForm()
  }

  const downloadInstanceOptions = $derived(computed.downloadEligibleInstances.map((i) => ({ value: i.mountPath, label: instanceLabel(i) })))
  const downloadProfileOptions = $derived(computed.downloadFilteredProfiles.map((p) => ({ value: p.id, label: p.name })))

  function selectDownloadInstanceByPath(mountPath: string) {
    const instance = computed.downloadEligibleInstances.find((i) => i.mountPath === mountPath)
    if (instance) void selectDownloadInstance(instance)
  }

  const downloadSourceReady = $derived(
    appState.downloadSourceKind === 'instance' ? Boolean(appState.downloadSourceInstance) : Boolean(appState.downloadSourceProfileId),
  )

  const ifExistsOptions = [
    { value: 'skip', label: 'Skip' },
    { value: 'overwrite', label: 'Overwrite' },
    { value: 'bounce', label: 'Bounce (numbered copy)' },
  ]

  const resumeJob = $derived(appState.downloadResumePromptFor)

  // Resume works from discoveryUrl/accessKeyId alone (or neither, for a
  // mode-A job), not a saved profile, same synthetic-profile trick
  // UploadsView's own resumeProfile uses to feed the shared argv builder.
  const resumeProfile = $derived({
    id: 'resume',
    schemaVersion: 1,
    kind: 'mount',
    name: '',
    volume: '',
    fork: '',
    mountPath: '',
    discoveryUrl: appState.downloadResumeDiscoveryUrl.trim(),
    accessKeyId: appState.downloadResumeAccessKeyId.trim(),
    secretRef: 'prompt',
    backend: 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  } satisfies MountProfile)

  const resumeCommandText = $derived(resumeJob ? `mountos ${buildDownloadResumeArgv(resumeProfile, resumeJob.jobId).join(' ')}` : '')

  // failure vs fault split: "retrying" (self-clearing, backoff, no action
  // needed) is presented distinctly from "failed" (won't clear on its own),
  // per the plan's explicit "Retry/control/health" requirement, a flat
  // counts table would conflate the two.
  function progressRows(job: DownloadJob) {
    return [
      { label: 'Pending', count: job.counts.pending, tone: '' },
      { label: 'Downloading', count: job.counts.downloading, tone: '' },
      { label: 'Done', count: job.counts.done, tone: 'text-success' },
      {
        label: 'Retrying',
        count: job.counts.retrying,
        tone: 'text-warning',
        info: 'Currently in backoff after a transient error (quota, volume lock, or a temporary read failure). Retried automatically as the job runs, self-clearing, no action needed.',
      },
      {
        label: 'Failed',
        count: job.counts.failed,
        tone: 'text-destructive',
        info: "Won't clear on its own. The job gave up on this path. Fix the underlying cause, then use Retry failed, or accept the loss.",
      },
      { label: 'Skipped', count: job.counts.skipped, tone: '' },
      { label: 'Missing', count: job.counts.missing, tone: '' },
    ]
  }
</script>

{#if appState.downloadSubView === 'create'}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void runDownloadStart() }}>
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={exitDownloadCreate}
          >
            <ChevronLeft size={16} aria-hidden="true" /> Back to download jobs
          </button>
          {#if downloadSourceReady && computed.downloadResolvedFork}
            <Badge variant="secondary" class="min-w-0 shrink truncate" title="Fork: {computed.downloadResolvedFork}">{computed.downloadResolvedFork}</Badge>
          {/if}
        </div>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy || !downloadSourceReady || !appState.downloadSource.trim() || !appState.downloadDest.trim()}>
          <Download size={16} aria-hidden="true" />
          {appState.downloadDryRun ? 'Run dry run' : 'Start download'}
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><Download size={19} aria-hidden="true" /> New download</h3>

      <div class="grid gap-1.5 max-w-md">
        <Label id="download-source-kind-label">Source</Label>
        <div class="flex gap-1.5" role="group" aria-labelledby="download-source-kind-label">
          <Button type="button" size="sm" variant={appState.downloadSourceKind === 'instance' ? 'primary' : 'outline'} onclick={() => selectSourceKind('instance')}>Mounted instance</Button>
          <Button type="button" size="sm" variant={appState.downloadSourceKind === 'profile' ? 'primary' : 'outline'} onclick={() => selectSourceKind('profile')}>Saved profile</Button>
        </div>
        <p class="text-muted-foreground text-sm">
          {#if appState.downloadSourceKind === 'instance'}
            Reads straight through an already-mounted volume, no connection, no credentials.
          {:else}
            Connects fresh to a saved profile's fork (optionally as of a past snapshot).
          {/if}
        </p>
      </div>

      {#if appState.downloadSourceKind === 'instance'}
        <div class="grid gap-1.5 max-w-sm">
          <Combobox
            options={downloadInstanceOptions}
            placeholder="Choose a running instance..."
            emptyText="No matching instance."
            aria-label="Download source instance"
            bind:value={() => appState.downloadSourceInstance?.mountPath ?? '', (value) => selectDownloadInstanceByPath(value)}
          />
          {#if computed.downloadEligibleInstances.length === 0}
            <p class="text-muted-foreground text-sm">No running mount instances found. Mount a volume first, or switch to Saved profile.</p>
          {/if}
        </div>
      {:else}
        <div class="grid gap-3 max-w-sm">
          <div class="grid gap-1.5">
            <Combobox
              options={downloadProfileOptions}
              placeholder="Choose a profile..."
              emptyText="No matching profile."
              aria-label="Download source profile"
              bind:value={() => appState.downloadSourceProfileId ?? '', (value) => selectDownloadProfile(value)}
            />
            {#if computed.downloadFilteredProfiles.length === 0}
              <p class="text-muted-foreground text-sm">No saved profiles found. Add a profile first, or switch to Mounted instance.</p>
            {/if}
          </div>
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label for="download-as-of">As of (optional)</Label>
              <InfoTip text="Reads from a historical snapshot instead of the fork's live state (`--as-of`).

Leave blank to read the fork's current, live content." />
            </span>
            <Input id="download-as-of" type="datetime-local" bind:value={appState.downloadAsOfLocal} />
          </div>
        </div>
      {/if}

      {#if downloadSourceReady}
        <div class="grid gap-1.5">
          <Label for="download-source">Source path</Label>
          <div class="flex gap-2">
            <Input
              id="download-source"
              bind:value={appState.downloadSource}
              placeholder={appState.downloadSourceKind === 'instance' ? '/Volumes/MountOS/Work/photos' : '/photos'}
              class="flex-1"
            />
            <Button type="button" onclick={browseDownloadSource} disabled={appState.downloadsBusy} class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" /> Browse
            </Button>
          </div>
          {#if appState.downloadSourceError}
            <small class="text-destructive text-sm">{appState.downloadSourceError}</small>
          {/if}
          {#if appState.downloadBrowseError}
            <small class="text-destructive text-sm wrap-anywhere">{appState.downloadBrowseError}</small>
          {/if}
        </div>

        <div class="grid gap-1.5">
          <Label for="download-dest">Destination folder</Label>
          <div class="flex gap-2">
            <Input id="download-dest" bind:value={appState.downloadDest} placeholder="/local/backups/photos" class="flex-1" />
            <Button type="button" onclick={browseDownloadDestination} disabled={appState.downloadsBusy} class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" /> Browse
            </Button>
          </div>
          {#if appState.downloadDestError}
            <small class="text-destructive text-sm">{appState.downloadDestError}</small>
          {/if}
        </div>

        <div class="grid grid-cols-2 gap-4 max-w-2xl">
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label id="download-if-exists-label">If a file already exists</Label>
              <InfoTip text="How to handle a destination path that already exists (`--if-exists`).

• **Skip** leaves the existing file alone (default).
• **Overwrite** replaces it.
• **Bounce** writes alongside it as a numbered copy, e.g. `name (1).ext`.

There is no error-and-halt option; every case has a defined, non-failing outcome." />
            </span>
            <Select options={ifExistsOptions} bind:value={appState.downloadIfExists} ariaLabelledby="download-if-exists-label" />
          </div>
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label for="download-depth">Depth</Label>
              <InfoTip text="How many directory levels below the source to descend into (`--depth`, `find -maxdepth` semantics).

**1** (default) downloads only the source root's direct children; subdirectories are listed but not descended into.
**0** is unlimited, fully recursive.

Guards against an unbounded pull from a large remote tree by accident." />
            </span>
            <Input id="download-depth" type="number" min="0" bind:value={appState.downloadDepth} />
          </div>
        </div>

        {#if computed.downloadNeedsSecret}
          <div class="grid gap-1.5 max-w-sm">
            <Label for="download-start-secret">Secret access key</Label>
            <Input id="download-start-secret" type="password" bind:value={appState.downloadStartSecretValue} autocomplete="current-password" />
          </div>
        {/if}

        <div class="grid gap-1.5">
          <button
            type="button"
            class="flex items-center gap-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={() => (appState.downloadAdvancedOpen = !appState.downloadAdvancedOpen)}
            aria-expanded={appState.downloadAdvancedOpen}
          >
            <ChevronLeft size={14} aria-hidden="true" class={appState.downloadAdvancedOpen ? '-rotate-90' : 'rotate-180'} />
            Advanced options
          </button>
        </div>

        {#if appState.downloadAdvancedOpen}
          <div class="grid gap-3 border border-border/40 p-3">
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadDryRun} label="Dry run" />
              <InfoTip text="Discovers and reports the plan only (`--dry-run`).

No writes to local disk." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadRestart} label="Force a fresh job" />
              <InfoTip text="Starts a brand new job (`--restart`), even if a resumable one already matches this **(source, dest)** pair." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadFollowSymlinks} label="Follow symlinks" />
              <InfoTip text="Dereferences symlinks to regular files instead of skipping them (`--follow-symlinks`)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadCreateSourceDirectory} label="Nest under source folder name" />
              <InfoTip text="Downloads into `DEST_PATH/<source-folder-name>/` instead of writing directly into `DEST_PATH` (`--create-source-directory`)." />
            </div>

            <div class="grid gap-1.5 max-w-[16rem]">
              <span class="inline-flex items-center gap-1">
                <Label for="download-bwlimit">Bandwidth limit, Mbps</Label>
                <InfoTip text="Caps download bandwidth in Mbps.

`0` or blank means unlimited." />
              </span>
              <Input id="download-bwlimit" type="number" min="0" bind:value={appState.downloadBwlimit} placeholder="0 (unlimited)" />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="download-include">Include globs (one per line)</Label>
                  <InfoTip text="Only download paths matching one of these globs.

Repeatable, one pattern per line, e.g. `*.jpg`." />
                </span>
                <Textarea id="download-include" bind:value={appState.downloadIncludeText} rows={3} placeholder="*.jpg" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="download-exclude">Exclude globs (one per line)</Label>
                  <InfoTip text="Never download paths matching one of these globs.

**Exclude always wins** over include when both match." />
                </span>
                <Textarea id="download-exclude" bind:value={appState.downloadExcludeText} rows={3} placeholder="*.tmp" />
              </div>
            </div>
          </div>
        {/if}

        {#if appState.downloadStartError}
          <CliErrorOutput role="alert" text={appState.downloadStartError} command={computed.downloadCommandText} />
        {/if}
        {#if appState.downloadDryRunReport}
          <div class="grid gap-1.5">
            <Label>Dry run report</Label>
            <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border p-2.5 font-mono text-xs">{appState.downloadDryRunReport}</pre>
          </div>
        {/if}
        <CommandPreview label="COMMAND PREVIEW" text={computed.downloadCommandText}>
          <code>{computed.downloadCommandText}</code>
        </CommandPreview>
      {/if}

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={exitDownloadCreate}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy || !downloadSourceReady || !appState.downloadSource.trim() || !appState.downloadDest.trim()}>
          <Download size={16} aria-hidden="true" />
          {appState.downloadDryRun ? 'Run dry run' : 'Start download'}
        </Button>
      </div>
    </form>
  </section>
{:else if appState.downloadSubView === 'resume' && resumeJob}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmDownloadResume() }}>
      <div class="flex items-center justify-between gap-4">
        <button
          type="button"
          class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
          onclick={cancelDownloadResume}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Back to download jobs
        </button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><RefreshCw size={19} aria-hidden="true" /> Resume download</h3>

      <div class="grid min-w-0 gap-1 max-w-sm">
        <Label>Job ID</Label>
        <code class="truncate">{resumeJob.jobId}</code>
      </div>

      <div class="corner-brackets grid grid-cols-[1fr_auto_1fr] items-end gap-3 p-3 max-w-2xl">
        <div class="grid min-w-0 gap-1">
          <Label>Source</Label>
          <p class="truncate" title={resumeJob.sourcePath}>{resumeJob.sourcePath ?? 'source profile'}</p>
        </div>
        <ArrowRight size={18} aria-hidden="true" class="text-muted-foreground mb-1 shrink-0" />
        <div class="grid min-w-0 gap-1">
          <Label>Destination</Label>
          <p class="truncate" title={resumeJob.destPath}>{resumeJob.destPath}</p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 max-w-2xl">
        <div class="grid gap-1.5">
          <span class="inline-flex items-center gap-1">
            <Label for="download-resume-discovery-url">Discovery URL</Label>
            <InfoTip text="Only needed to resume a profile-sourced job. Leave both this and Access key ID blank for a job that reads straight through an already-mounted instance; it needs no credentials at all." />
          </span>
          <Input id="download-resume-discovery-url" bind:value={appState.downloadResumeDiscoveryUrl} placeholder="https://discovery.example.com" />
        </div>
        <div class="grid gap-1.5">
          <Label for="download-resume-access-key">Access key ID</Label>
          <Input id="download-resume-access-key" bind:value={appState.downloadResumeAccessKeyId} />
        </div>
      </div>

      <div class="grid gap-1.5 max-w-sm">
        <Label for="download-resume-secret">Secret access key (optional)</Label>
        <Input id="download-resume-secret" type="password" bind:value={appState.downloadResumeSecretValue} autocomplete="current-password" />
      </div>
      <p class="text-muted-foreground text-sm -mt-2">Leave the secret blank to reuse a saved profile's cached secret for this access key ID, if one exists.</p>

      {#if appState.downloadResumeError}
        <CliErrorOutput role="alert" text={appState.downloadResumeError} command={resumeCommandText} />
      {/if}
      <CommandPreview label="COMMAND PREVIEW" text={resumeCommandText}>
        <code>{resumeCommandText}</code>
      </CommandPreview>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={cancelDownloadResume}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>
    </form>
  </section>
{:else if appState.downloads.length === 0}
  <!-- Covers BOTH "still loading, don't know the count yet" and "confirmed
       empty" in the SAME outer panel shape (full-width, full-height);
       only the inner content swaps (a placeholder vs. the real empty
       state), so resolving the fetch never jumps the layout around the way
       switching between a 2-column "loading" shell and a single-panel
       "empty" shell would. A 280px sidebar showing only its own "no jobs"
       echo of this same panel is dead weight anyway, not a real second
       source of information. -->
  <section class="surface relative flex-1 m-[22px] outline-hidden" tabindex="-1" use:focusOnMount>
    <div class="tech-grid absolute inset-6 pointer-events-none" aria-hidden="true"></div>
    <div class="relative grid content-center justify-items-center gap-3 h-full px-7 py-10 text-center">
      {#if appState.downloadsBusy}
        <Download size={28} aria-hidden="true" class="animate-pulse" />
        <p class="text-muted-foreground">Loading download jobs...</p>
      {:else}
        <Download size={28} aria-hidden="true" />
        <strong>No active downloads</strong>
        {#if appState.downloadsError}
          <p class="text-destructive text-sm wrap-anywhere" role="alert">{appState.downloadsError}</p>
        {/if}
        <p>Pull files from an already-mounted instance or a saved profile's fork, with the exact CLI command shown before every action.</p>
        <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterDownloadCreate}>
          <Plus size={16} aria-hidden="true" />
          New download
        </Button>
      {/if}
    </div>
  </section>
{:else}
  <section
    class="grid flex-1 grid-rows-1 gap-4 m-[22px] outline-hidden"
    style:grid-template-columns={appState.jobPanelCollapsed.downloads ? 'minmax(0,1fr)' : '280px minmax(0,1fr)'}
    tabindex="-1"
    use:focusOnMount
  >
    <JobPanel id="downloads" searchPlaceholder="Search downloads...">
      {#snippet children(query, floating)}
        {@const filteredJobs = computed.downloadVisibleJobs.filter((job) => matchesSearch(query, job.name, job.sourcePath, job.destPath, job.jobId))}
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 class="flex items-center gap-2"><Download size={18} aria-hidden="true" /> Downloads</h3>
          <div class="flex flex-wrap items-center gap-2">
            {#if !floating}
              <Button type="button" size="icon" variant="ghost" onclick={() => setJobPanelCollapsed('downloads', true)} title="Collapse panel" aria-label="Collapse panel">
                <PanelLeftClose size={15} aria-hidden="true" />
              </Button>
            {/if}
            <Button type="button" size="icon" variant="ghost" onclick={runDownloadList} disabled={appState.downloadsBusy} title="Refresh job list" aria-label="Refresh job list">
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
            <Button type="button" size="icon" variant="ghost" onclick={requestDownloadPrune} disabled={appState.downloadsBusy} title="Prune completed/halted jobs" aria-label="Prune completed/halted jobs">
              <Trash2 size={15} aria-hidden="true" />
            </Button>
            {#if floating}
              <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterDownloadCreate}>
                <Plus size={16} aria-hidden="true" />
                New download
              </Button>
            {/if}
          </div>
        </div>
        {#if !floating}
          <Button type="button" variant="primary" class="w-full mb-3 cyberpunk-skewed-sm" onclick={enterDownloadCreate}>
            <Plus size={16} aria-hidden="true" />
            New download
          </Button>
        {/if}
        {#if appState.downloadsError}
          <p class="text-destructive text-sm mb-2 wrap-anywhere" role="alert">{appState.downloadsError}</p>
        {/if}
        {#if computed.downloadHiddenCompletedCount > 0}
          <Checkbox
            bind:checked={appState.downloadShowCompleted}
            label="Show completed ({computed.downloadHiddenCompletedCount})"
            class="mb-2"
          />
        {/if}
        <div class="grid gap-1.5">
          {#if computed.downloadVisibleJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>{appState.downloads.length === 1 ? 'The only job has completed.' : `All ${appState.downloads.length} jobs have completed.`}</p>
            </div>
          {:else if filteredJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>No jobs match &quot;{query}&quot;.</p>
            </div>
          {:else}
            {#each filteredJobs as job (job.jobId)}
              <button
                class:bg-accent={appState.downloadSelectedJobId === job.jobId}
                class="flex min-w-0 items-center gap-2.5 border border-transparent p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => {
                  appState.downloadSelectedJobId = job.jobId
                  closeJobPanelFloating()
                }}
              >
                <Download size={16} aria-hidden="true" class="shrink-0" />
                <span class="min-w-0 flex-1">
                  <strong class="block truncate">{job.name || job.sourcePath || job.jobId}</strong>
                  <span class="block truncate text-muted-foreground text-sm">{job.destPath ?? ''}</span>
                </span>
                <Badge variant={stateBadgeVariant[displayState(job)] ?? 'default'}>{job.state}</Badge>
              </button>
            {/each}
            {#if computed.downloadVisibleJobsTruncated}
              <p class="text-muted-foreground text-sm p-2">
                Showing the first {computed.downloadVisibleJobs.length} of {computed.downloadVisibleJobsTotal} jobs, prune old jobs to see the rest.
              </p>
            {/if}
          {/if}
        </div>
      {/snippet}
    </JobPanel>

    {#if selectedJob}
      {@const job = selectedJob}
      {@const resumable = job.state === 'halted' || job.state === 'resumable'}
      <div class="surface corner-brackets p-4 grid content-start gap-4 min-w-0">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1 basis-48">
            <h3 class="flex min-w-0 items-center gap-2">
              <Download size={19} aria-hidden="true" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{job.name || job.sourcePath || job.jobId}</span>
              <Badge variant="secondary" class="shrink-0" title="Fork name">{job.forkName || 'main'}</Badge>
              <Badge variant="secondary" class="ml-auto min-w-0 shrink truncate" title="Job ID">
                <Tag size={12} aria-hidden="true" class="shrink-0" />
                {job.jobId}
              </Badge>
            </h3>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if job.state === 'running'}
              <Button type="button" variant="destructive" disabled={appState.downloadsBusy} onclick={() => runDownloadCancel(job)}>
                <OctagonX size={16} aria-hidden="true" /> Cancel
              </Button>
            {:else if resumable}
              {#if isDownloadFinishable(job)}
                <Button type="button" variant="outline" title="Nothing is pending or downloading, this just needs the terminal state confirmed. No reconnect needed." onclick={() => runDownloadFinish(job)} disabled={appState.downloadsBusy}>
                  <Check size={16} aria-hidden="true" /> Mark complete
                </Button>
              {/if}
              <Button type="button" onclick={() => requestDownloadResume(job)} disabled={appState.downloadsBusy}>
                <RotateCcw size={16} aria-hidden="true" /> Resume
              </Button>
            {/if}
            {#if job.counts.failed}
              <Button type="button" variant="outline" disabled={appState.downloadsBusy} onclick={() => runDownloadRetryFailed(job)}>
                <ListChecks size={16} aria-hidden="true" /> Retry failed
              </Button>
            {/if}
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="grid gap-1 min-w-0 sm:col-span-2">
            <Label>Source</Label>
            <p class="truncate" title={job.sourcePath}>{job.sourcePath ?? 'source profile'}</p>
          </div>
          <div class="grid gap-1 min-w-0 sm:col-span-2">
            <Label>Destination</Label>
            <p class="truncate" title={job.destPath}>{job.destPath}</p>
          </div>
          <div class="grid gap-1">
            <Label>State</Label>
            <Badge variant={stateBadgeVariant[displayState(job)] ?? 'default'} class="w-fit">{displayState(job)}</Badge>
          </div>
          <div class="grid gap-1">
            <Label>Total</Label>
            {#if job.totalFiles}
              <p class="tabular-nums">
                {job.totalFiles} file{job.totalFiles === 1 ? '' : 's'}, {formatBytes(job.totalBytes ?? 0)}
                {#if job.state !== 'completed' && job.state !== 'halted'}
                  <span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
                    (as of last scan)
                    <InfoTip text="This job is still draining its backlog, so the file count and byte total shown here are a snapshot from the last discovery pass, not final. They'll stop changing once the job settles." />
                  </span>
                {/if}
              </p>
            {:else}
              <p class="text-muted-foreground">unknown</p>
            {/if}
          </div>
        </div>

        {#if job.haltReason}
          <CliErrorOutput role="alert" text={job.haltReason} />
        {/if}

        {#if job.logPath}
          <div class="grid gap-1 min-w-0">
            <Label>Log</Label>
            <div class="flex items-center gap-2 min-w-0">
              <code class="min-w-0 flex-1 truncate" title={job.logPath}>{job.logPath}</code>
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Copy log path" aria-label="Copy log path" onclick={() => copyDownloadJobLogPath(job)}>
                <Copy size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Open log" aria-label="Open log" onclick={() => openDownloadJobLog(job)}>
                <ExternalLink size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        {/if}

        <div class="grid gap-2">
          <div class="flex items-center justify-between gap-2 border-b-2 border-primary pb-2 mb-2">
            <p class="text-xs font-bold uppercase tracking-wide">Progress</p>
            {#if appState.downloadsLastFetchedAt != null}
              <span
                class="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground"
                title={new Date(appState.downloadsLastFetchedAt).toLocaleString()}
              >
                <Clock size={12} aria-hidden="true" />
                {lastFetchedLabel(appState.downloadsLastFetchedAt, now)}
              </span>
            {/if}
          </div>
          <Table containerLabel="Download progress by status" class="max-w-sm">
            <TableBody>
              {#each progressRows(job) as row (row.label)}
                <TableRow>
                  <TableCell class="text-muted-foreground text-xs uppercase tracking-wide">
                    <span class="inline-flex items-center gap-1">
                      {row.label}
                      {#if row.info}
                        <InfoTip text={row.info} />
                      {/if}
                    </span>
                  </TableCell>
                  <TableCell class="text-right tabular-nums {row.tone}">{row.count ?? 0}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      </div>
    {:else}
      <div class="surface relative">
        <div class="tech-grid absolute inset-6 pointer-events-none" aria-hidden="true"></div>
        <div class="relative grid content-center justify-items-center gap-3 h-full px-7 py-10 text-center">
          <Download size={28} aria-hidden="true" />
          <strong>No job selected</strong>
          <p>Pick a job on the left to see its progress and details.</p>
        </div>
      </div>
    {/if}
  </section>
{/if}
