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
    PanelRightClose,
    Plus,
    Radar,
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
  import { UPLOAD_SOURCE_PROVIDERS } from '$lib/cli'
  import {
    appState,
    browseDownloadDestination,
    browseDownloadSource,
    buildDownloadResumeArgv,
    cancelDownloadResume,
    clearDownloadDestProfileSelection,
    closeJobPanelFloating,
    closeSaveDownloadDestTransferProfile,
    computed,
    confirmDownloadResume,
    copyDownloadJobLogPath,
    downloadDestProfileUsesVault,
    effectiveDownloadDest,
    enterDownloadCreate,
    exitDownloadCreate,
    isExternalDownloadDest,
    openDownloadJobLog,
    openSaveDownloadDestTransferProfile,
    removeTransferSourceProfile,
    requestDownloadPrune,
    requestDownloadRemove,
    requestDownloadResume,
    resetDownloadForm,
    runDownloadCancel,
    runDownloadDestTest,
    runDownloadFinish,
    runDownloadList,
    runDownloadRetryFailed,
    runDownloadStart,
    saveDownloadDestAsTransferProfile,
    schedulePoll,
    selectDownloadDestTransferProfile,
    selectDownloadDestType,
    selectDownloadInstance,
    selectDownloadProfile,
    setJobPanelCollapsed,
    transferSourceProfileNeedsReentry,
  } from '$lib/app-state.svelte'
  import type { DownloadJob, MountInstance, MountProfile } from '$lib/types'
  import { cn, formatBytes, lastFetchedLabel, matchesSearch } from '$lib/utils'

  const DEST_TYPE_OPTIONS = [
    { value: 'local', label: 'Local folder' },
    { value: 'external', label: 'Object storage (S3 / Azure / GCS)' },
  ]
  const NEW_DEST_OPTION = '__new__'
  const savedDestOptions = $derived([
    { value: NEW_DEST_OPTION, label: '+ New destination' },
    ...appState.transferSourceProfiles.map((p) => ({
      value: p.id,
      label: transferSourceProfileNeedsReentry(p) ? `(needs re-entry) ${p.name}` : p.name,
    })),
  ])

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

  // Auto-refreshes the job list while this view is active, mirrors
  // UploadsView's own schedulePoll effect exactly.
  $effect(() => schedulePoll(() => void runDownloadList()))

  // Ticks so "Updated Xs ago" stays live between refetches, mirrors
  // UploadsView's identical staleness indicator.
  let now = $state(Date.now())
  $effect(() => {
    const id = setInterval(() => { now = Date.now() }, 1000)
    return () => clearInterval(id)
  })

  const stateBadgeVariant: Record<string, BadgeVariant> = {
    running: 'success',
    halted: 'destructive',
    completed: 'primary',
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
  const panelSide = $derived(appState.jobPanelSide.downloads ?? 'left')

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
        info: 'Waits in backoff after a transient error (quota, lock, or temporary read failure). Retries automatically. Needs no action.',
      },
      {
        label: 'Failed',
        count: job.counts.failed,
        tone: 'text-destructive',
        info: 'The job stopped retrying this path. Fix the cause, then use Retry failed, or accept the loss.',
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
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy || !downloadSourceReady || !appState.downloadSource.trim() || !effectiveDownloadDest()}>
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
        {#if appState.downloadSourceKind === 'profile'}
          <p class="text-muted-foreground text-sm">
            Connects fresh to a saved profile's fork (optionally as of a past snapshot).
          </p>
        {/if}
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
              <InfoTip text="Reads from a snapshot instead of the fork's live state (`--as-of`). Leave blank to read the fork's live content." />
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

        <div class="grid gap-1.5 max-w-sm">
          <Label id="download-dest-type-label">Destination type</Label>
          <Select
            id="download-dest-type"
            options={DEST_TYPE_OPTIONS}
            value={appState.downloadDestType}
            ariaLabelledby="download-dest-type-label"
            onchange={(value) => selectDownloadDestType(value)}
          />
        </div>

        {#if !isExternalDownloadDest()}
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
        {:else}
          <div class="grid gap-3 border border-border p-3">
            {#if appState.transferSourceProfiles.length > 0}
              <div class="grid gap-1.5 max-w-sm">
                <Label id="download-dest-saved-label">Saved destination</Label>
                <Select
                  id="download-dest-saved"
                  options={savedDestOptions}
                  value={appState.downloadDestProfileSelectedId ?? NEW_DEST_OPTION}
                  ariaLabelledby="download-dest-saved-label"
                  onchange={(value) => (value === NEW_DEST_OPTION ? clearDownloadDestProfileSelection() : selectDownloadDestTransferProfile(value))}
                />
              </div>
            {/if}

            <div class="grid gap-1.5 max-w-sm">
              <Label id="download-dest-provider-label">Provider</Label>
              <Select
                id="download-dest-provider"
                options={UPLOAD_SOURCE_PROVIDERS}
                value={appState.downloadDestProvider}
                placeholder="Choose a provider..."
                ariaLabelledby="download-dest-provider-label"
                onchange={(value) => (appState.downloadDestProvider = value)}
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-1.5">
                <Label for="download-dest-bucket">{appState.downloadDestProvider === 'azure' ? 'Container' : 'Bucket'}</Label>
                <Input id="download-dest-bucket" bind:value={appState.downloadDestBucket} autocomplete="off" />
              </div>
              <div class="grid gap-1.5">
                <Label for="download-dest-prefix">Prefix (optional)</Label>
                <Input id="download-dest-prefix" bind:value={appState.downloadDestPrefix} placeholder="backups/2026" autocomplete="off" />
              </div>
            </div>
            {#if appState.downloadDestProvider !== 'gcs'}
              <div class="grid grid-cols-2 gap-3">
                <div class="grid gap-1.5">
                  <Label for="download-dest-endpoint">Endpoint{appState.downloadDestProvider === 's3compatible' ? ' (required)' : ''}</Label>
                  <Input id="download-dest-endpoint" bind:value={appState.downloadDestEndpoint} placeholder={appState.downloadDestProvider === 's3compatible' ? 'https://...' : 'auto-derived if left blank'} />
                </div>
                <div class="grid gap-1.5">
                  <Label for="download-dest-region">Region</Label>
                  <Input id="download-dest-region" bind:value={appState.downloadDestRegion} />
                </div>
              </div>
            {/if}
            {#if appState.downloadDestProvider === 's3compatible'}
              <div class="grid gap-1.5 max-w-sm">
                <Label for="download-dest-provider-hint">Provider name (optional)</Label>
                <Input id="download-dest-provider-hint" bind:value={appState.downloadDestProviderHint} placeholder="e.g. my internal MinIO" autocomplete="off" />
              </div>
            {/if}
            {#if appState.downloadDestProvider === 'azure'}
              <div class="grid gap-1.5">
                <Label for="download-dest-account">Storage account name</Label>
                <Input id="download-dest-account" bind:value={appState.downloadDestAccount} />
              </div>
            {:else}
              <div class="grid gap-1.5">
                <Label for="download-dest-access-key-id">Access key id</Label>
                <Input id="download-dest-access-key-id" bind:value={appState.downloadDestAccessKeyId} autocomplete="off" />
              </div>
            {/if}
            <div class="grid gap-1.5">
              <Label for="download-dest-secret">
                Secret access key
                {#if downloadDestProfileUsesVault()}<span class="text-muted-foreground font-normal">(optional, using saved vault credential)</span>{/if}
              </Label>
              <Input id="download-dest-secret" type="password" bind:value={appState.downloadDestSecretValue} autocomplete="off" placeholder={downloadDestProfileUsesVault() ? 'Leave blank to use the saved vault credential' : ''} />
            </div>
            {#if appState.downloadDestError}
              <small class="text-destructive text-sm">{appState.downloadDestError}</small>
            {/if}

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="secondary" onclick={() => runDownloadDestTest()} disabled={appState.downloadDestTestBusy}>
                <Radar size={16} aria-hidden="true" /> {appState.downloadDestTestBusy ? 'Testing...' : 'Test connection'}
              </Button>
              <Button type="button" variant="secondary" onclick={openSaveDownloadDestTransferProfile}>
                Save as transfer source
              </Button>
              {#if appState.downloadDestProfileSelectedId}
                <Button type="button" variant="ghost" onclick={() => removeTransferSourceProfile(appState.downloadDestProfileSelectedId ?? '')} class="text-destructive">
                  <Trash2 size={16} aria-hidden="true" /> Delete saved destination
                </Button>
              {/if}
            </div>
            {#if appState.downloadDestTestReport}
              <p class="text-sm font-mono whitespace-pre-wrap border border-border/40 p-2">{appState.downloadDestTestReport}</p>
            {/if}
            {#if appState.downloadDestTestError}
              <small class="text-destructive text-sm wrap-anywhere">{appState.downloadDestTestError}</small>
            {/if}

            {#if appState.downloadDestSaveOpen}
              <div class="grid gap-3 border border-border/40 p-3 bg-muted/20">
                <div class="grid gap-1.5 max-w-sm">
                  <Label for="download-dest-save-name">Name</Label>
                  <Input id="download-dest-save-name" bind:value={appState.downloadDestSaveName} placeholder="My S3 bucket" />
                </div>
                <div class="flex items-center gap-1.5">
                  <Checkbox bind:checked={appState.downloadDestSaveToVault} label="Store secret in OS vault" />
                  <InfoTip text="Stores the secret in the OS credential store, so this destination does not ask for it again. Leave the secret field blank to be prompted next time." />
                </div>
                {#if appState.downloadDestSaveError}
                  <small class="text-destructive text-sm">{appState.downloadDestSaveError}</small>
                {/if}
                <div class="flex gap-2">
                  <Button type="button" variant="primary" onclick={() => saveDownloadDestAsTransferProfile()}>Save</Button>
                  <Button type="button" variant="ghost" onclick={closeSaveDownloadDestTransferProfile}>Cancel</Button>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <div class="grid grid-cols-2 gap-4 max-w-2xl">
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label id="download-if-exists-label">If a file already exists</Label>
              <InfoTip text="Sets the action for a destination path that already exists (`--if-exists`).

• **Skip** keeps the existing file (default).
• **Overwrite** replaces the existing file.
• **Bounce** adds a numbered copy, e.g. `name (1).ext`.

No option halts with an error." />
            </span>
            <Select options={ifExistsOptions} bind:value={appState.downloadIfExists} ariaLabelledby="download-if-exists-label" />
          </div>
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label for="download-depth">Depth</Label>
              <InfoTip text="Sets how many directory levels to descend below the source (`--depth`, like `find -maxdepth`).

**1** (default) downloads only the source root's direct children. It lists deeper subdirectories but does not enter them.
**0** removes the limit and descends fully.

Prevents an accidental full pull of a large remote tree." />
            </span>
            <Input id="download-depth" type="number" min="0" bind:value={appState.downloadDepth} />
          </div>
        </div>

        {#if computed.downloadNeedsSecret}
          <div class="grid gap-1.5 max-w-sm">
            <Label for="download-start-secret">Profile secret access key</Label>
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
              <InfoTip text="Reports the download plan only (`--dry-run`). Writes nothing to disk." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadRestart} label="Force a fresh job" />
              <InfoTip text="Starts a new job (`--restart`), even if a resumable job already matches this **(source, dest)** pair." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadFollowSymlinks} label="Follow symlinks" />
              <InfoTip text="Follows symlinks to their target files, instead of skipping them (`--follow-symlinks`)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.downloadCreateSourceDirectory} label="Nest under source folder name" />
              <InfoTip text="Downloads into `DEST_PATH/<source-folder-name>/`, not directly into `DEST_PATH` (`--create-source-directory`)." />
            </div>

            <div class="grid gap-1.5 max-w-[16rem]">
              <span class="inline-flex items-center gap-1">
                <Label for="download-bwlimit">Bandwidth limit, Mbps</Label>
                <InfoTip text="Caps download bandwidth in Mbps. `0` or blank sets no limit." />
              </span>
              <Input id="download-bwlimit" type="number" min="0" bind:value={appState.downloadBwlimit} placeholder="0 (unlimited)" />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="download-include">Include globs (one per line)</Label>
                  <InfoTip text="Downloads only paths that match one of these globs. Enter one pattern per line, e.g. `*.jpg`." />
                </span>
                <Textarea id="download-include" bind:value={appState.downloadIncludeText} rows={3} placeholder="*.jpg" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="download-exclude">Exclude globs (one per line)</Label>
                  <InfoTip text="Skips paths that match one of these globs. **Exclude wins** when a path also matches include." />
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
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy || !downloadSourceReady || !appState.downloadSource.trim() || !effectiveDownloadDest()}>
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
            <InfoTip text="Needed only to resume a profile-sourced job. Leave blank for an instance-sourced job. Needs no credentials." />
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
    class="grid flex-1 grid-rows-1 m-[22px] outline-hidden transition-[grid-template-columns,column-gap] duration-200 ease-out"
    style:grid-template-columns={appState.jobPanelCollapsed.downloads ? '0px minmax(0,1fr)' : '280px minmax(0,1fr)'}
    style:column-gap={appState.jobPanelCollapsed.downloads ? '0px' : '1rem'}
    style:direction={panelSide === 'left' ? 'ltr' : 'rtl'}
    tabindex="-1"
    use:focusOnMount
  >
    <JobPanel id="downloads" searchPlaceholder="Search downloads...">
      {#snippet children(query, floating)}
        {@const filteredJobs = computed.downloadVisibleJobs.filter((job) => matchesSearch(query, job.name, job.sourcePath, job.destPath, job.jobId))}
        <div class={cn('mb-4 flex items-center justify-between gap-2', floating && 'flex-wrap')}>
          <h3 class="flex items-center gap-2"><Download size={18} aria-hidden="true" /> Downloads</h3>
          <div class={cn('flex items-center gap-1', floating && 'flex-wrap')}>
            {#if !floating}
              <Button type="button" size="icon" variant="ghost" onclick={() => setJobPanelCollapsed('downloads', true)} title="Collapse panel" aria-label="Collapse panel">
                {#if panelSide === 'left'}
                  <PanelLeftClose size={15} aria-hidden="true" />
                {:else}
                  <PanelRightClose size={15} aria-hidden="true" />
                {/if}
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
      <div class="surface corner-brackets p-4 grid content-start gap-4 min-w-0" style:direction="ltr">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1 basis-48">
            <h3 class="flex min-w-0 items-center gap-2">
              <Download size={19} aria-hidden="true" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{job.name || job.sourcePath || job.jobId}</span>
              <Badge variant="secondary" class="shrink-0" title="Fork name">{job.forkName || 'main'}</Badge>
              {#if job.providerHint}
                <Badge variant="secondary" class="shrink-0" title="Provider">{job.providerHint}</Badge>
              {/if}
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
            {:else}
              {#if resumable}
                {#if isDownloadFinishable(job)}
                  <Button type="button" variant="outline" title="Nothing is pending or downloading, this just needs the terminal state confirmed. No reconnect needed." onclick={() => runDownloadFinish(job)} disabled={appState.downloadsBusy}>
                    <Check size={16} aria-hidden="true" /> Mark complete
                  </Button>
                {/if}
                <Button type="button" onclick={() => requestDownloadResume(job)} disabled={appState.downloadsBusy}>
                  <RotateCcw size={16} aria-hidden="true" /> Resume
                </Button>
              {/if}
              <Button
                type="button"
                variant="destructive"
                title="Delete this job's local record, whatever its state. Files already downloaded are not touched."
                onclick={() => requestDownloadRemove(job)}
                disabled={appState.downloadsBusy}
              >
                <Trash2 size={16} aria-hidden="true" /> Remove
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
            <p class="wrap-anywhere">{job.sourcePath ?? 'source profile'}</p>
          </div>
          <div class="grid gap-1 min-w-0 sm:col-span-2">
            <Label>Destination</Label>
            <p class="wrap-anywhere">{job.destPath}</p>
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
                    <InfoTip text="From the last discovery scan, not final. Stops changing once the job settles." />
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
                  <TableCell class="text-label-foreground text-xs uppercase tracking-wide">
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
          {#if appState.jobPanelCollapsed.downloads}
            <!-- The panel's own "New download" button is inert/hidden while
                 collapsed (JobPanel.svelte), so this is the only reachable
                 CTA until it's expanded again. -->
            <p>The job panel is collapsed. Expand it to pick a job, or start a new one below.</p>
            <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterDownloadCreate}>
              <Plus size={16} aria-hidden="true" />
              New download
            </Button>
          {:else}
            <!-- No "New download" button here: the panel's own CTA is
                 visible right above this same empty state, so a second
                 identical one on screen at once would be pure duplication. -->
            <p>Pick a job on the {panelSide} to see its progress and details.</p>
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}
