<script lang="ts">
  import {
    ArrowRight,
    Check,
    ChevronLeft,
    Clock,
    Copy,
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
    Upload,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Select } from '$lib/components/ui/select'
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
    browseUploadDestination,
    browseUploadSource,
    buildUploadResumeArgv,
    cancelUploadResume,
    clearTransferSourceProfileSelection,
    closeSaveTransferSourceProfile,
    computed,
    confirmUploadResume,
    copyUploadJobLogPath,
    effectiveUploadSource,
    enterUploadCreate,
    exitUploadCreate,
    isExternalUploadSource,
    openSaveTransferSourceProfile,
    openUploadJobLog,
    removeTransferSourceProfile,
    requestUploadPrune,
    requestUploadResume,
    runUploadCancel,
    runUploadFinish,
    runUploadList,
    runUploadRetryFailed,
    runUploadSourceTest,
    runUploadStart,
    saveCurrentAsTransferSourceProfile,
    selectTransferSourceProfile,
    selectUploadInstance,
    selectUploadProfile,
    selectUploadSourceType,
    uploadSourceProfileUsesVault,
    closeJobPanelFloating,
    setJobPanelCollapsed,
  } from '$lib/app-state.svelte'
  import type { MountInstance, MountProfile, UploadJob } from '$lib/types'
  import { cn, formatBytes, lastFetchedLabel, matchesSearch } from '$lib/utils'

  const SOURCE_TYPE_OPTIONS = [
    { value: 'local', label: 'Local folder / file list' },
    { value: 'external', label: 'Object storage (S3 / Azure / GCS)' },
  ]
  const NEW_SOURCE_OPTION = '__new__'
  const savedSourceOptions = $derived([
    { value: NEW_SOURCE_OPTION, label: '+ New source' },
    ...appState.transferSourceProfiles.map((p) => ({ value: p.id, label: p.name })),
  ])

  // Fetch exactly once per mount, not gated on uploads.length === 0. Unlike
  // forks (every profile always has at least "main", so that gate never
  // stays true after a real fetch), a genuinely empty job list is the normal
  // first-run state here, and re-gating on length would refetch forever.
  let fetchedOnce = false
  $effect(() => {
    if (!fetchedOnce) {
      fetchedOnce = true
      void runUploadList()
    }
  })

  // Ticks so "Updated Xs ago" stays live without a real refetch. There's
  // no auto-poll for the uploads list (see uploadsLastFetchedAt's own doc
  // comment), so this is purely a staleness indicator, not a feed.
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

  // The server's own state classification has no "completed with failures"
  // concept (a settle-and-exit with permanent failures still stamps
  // CompletedAt and clears HaltReason, see mountos-servers cmd_upload.go,
  // exit code 3 is the only place that distinction is visible), so a job
  // that permanently dropped files would otherwise render an identical
  // calm "completed" badge to a fully clean one. Derived client-side from
  // the counts map this GUI already has, not a new field.
  function displayState(job: UploadJob): string {
    return job.state === 'completed' && (job.counts.failed ?? 0) > 0 ? 'completed (failures)' : job.state
  }

  // A daemon-mode job (started/resumed without --once) never transitions to
  // "completed" on its own, no matter how empty its queue is. It just
  // idles and rescans on --rescan-interval forever (mountos-servers
  // upload_daemon.go: only --once, or a settled source-profile job, ever
  // exits on a settled pass). Without this, "running" looks identical
  // whether it's actively transferring data or has nothing left to do,
  // the state most likely to be mistaken for "stuck".
  function isIdleRunning(job: UploadJob): boolean {
    return job.state === 'running' && !(job.counts.pending || job.counts.uploading)
  }

  // A resumable job that never reached a terminal transition (cancelled, or
  // otherwise interrupted) despite having drained everything (0 pending, 0
  // uploading) has no way to become "completed" short of reconnecting and
  // running resume just to confirm what's already true locally. This is the
  // gate for offering "Mark complete" (runUploadFinish), which does the
  // same thing offline.
  function isUploadFinishable(job: UploadJob): boolean {
    return job.state === 'resumable' && !(job.counts.pending || job.counts.uploading)
  }

  const selectedJob = $derived(appState.uploads.find((job) => job.jobId === appState.uploadSelectedJobId) ?? null)
  const panelSide = $derived(appState.jobPanelSide.uploads ?? 'left')

  $effect(() => {
    // The selected job can vanish from the list after a refresh (pruned, or
    // simply not returned this pass), or drop out of view because it just
    // completed cleanly and "show completed" is off. Fall back to the
    // first VISIBLE row (not just any row) rather than keeping a selection
    // with nothing highlighted to show for it.
    if (appState.uploadSelectedJobId && !computed.uploadVisibleJobs.some((job) => job.jobId === appState.uploadSelectedJobId)) {
      appState.uploadSelectedJobId = computed.uploadVisibleJobs[0]?.jobId ?? null
    } else if (!appState.uploadSelectedJobId && computed.uploadVisibleJobs.length > 0) {
      appState.uploadSelectedJobId = computed.uploadVisibleJobs[0].jobId
    }
  })

  function instanceLabel(instance: MountInstance): string {
    return instance.name || instance.mountPath
  }

  // One combined picker instead of a profile/instance toggle plus two
  // separate comboboxes. Values are prefixed to disambiguate on
  // selection, since a profile id and a mount path share no namespace.
  const uploadSourceOptions = $derived([
    ...computed.uploadFilteredProfiles.map((p) => ({ value: `profile:${p.id}`, label: `Profile - ${p.name}` })),
    ...computed.uploadEligibleInstances.map((i) => ({ value: `instance:${i.mountPath}`, label: `Running - ${instanceLabel(i)}` })),
  ])

  const uploadSourceValue = $derived(
    appState.uploadSourceKind === 'profile' && appState.uploadSourceProfileId
      ? `profile:${appState.uploadSourceProfileId}`
      : appState.uploadSourceKind === 'instance' && appState.uploadSourceInstance
        ? `instance:${appState.uploadSourceInstance.mountPath}`
        : '',
  )

  function selectUploadSource(value: string) {
    if (value.startsWith('profile:')) {
      selectUploadProfile(value.slice('profile:'.length))
    } else if (value.startsWith('instance:')) {
      const mountPath = value.slice('instance:'.length)
      const instance = computed.uploadEligibleInstances.find((i) => i.mountPath === mountPath)
      if (instance) void selectUploadInstance(instance)
    }
  }

  const uploadSourceReady = $derived(
    appState.uploadSourceKind === 'profile' ? Boolean(appState.uploadSourceProfileId) : Boolean(appState.uploadSourceInstance),
  )

  const resumeJob = $derived(appState.uploadResumePromptFor)

  // Resume works from discoveryUrl/accessKeyId alone (see resumeUpload's
  // own comment), not a saved profile, so this synthetic object exists
  // purely to feed the shared argv builder/command preview the same way
  // start/browse's own synthetic profiles do for their no-profile sources.
  const resumeProfile = $derived({
    id: 'resume',
    schemaVersion: 1,
    kind: 'mount',
    name: '',
    volume: '',
    fork: '',
    mountPath: '',
    discoveryUrl: appState.uploadResumeDiscoveryUrl.trim(),
    accessKeyId: appState.uploadResumeAccessKeyId.trim(),
    secretRef: 'prompt',
    backend: 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  } satisfies MountProfile)

  const resumeCommandText = $derived(
    resumeJob
      ? `mountos ${buildUploadResumeArgv(resumeProfile, resumeJob.jobId, appState.uploadResumeOnce, appState.uploadResumeRescanInterval || undefined).join(' ')}`
      : '',
  )
</script>

{#if appState.uploadSubView === 'create'}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void runUploadStart() }}>
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={exitUploadCreate}
          >
            <ChevronLeft size={16} aria-hidden="true" /> Back to upload jobs
          </button>
          {#if uploadSourceReady}
            <Badge variant="secondary" class="min-w-0 shrink truncate" title="Fork: {computed.uploadResolvedFork || 'main'}">{computed.uploadResolvedFork || 'main'}</Badge>
          {/if}
        </div>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy || !uploadSourceReady || !effectiveUploadSource() || !appState.uploadDest.trim()}>
          <Upload size={16} aria-hidden="true" />
          {appState.uploadDryRun ? 'Run dry run' : 'Start upload'}
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><Upload size={19} aria-hidden="true" /> New upload</h3>

      <div class="grid gap-1.5 max-w-sm">
        <Combobox
          options={uploadSourceOptions}
          placeholder="Choose a profile or running instance..."
          emptyText="No matching source."
          aria-label="Upload source"
          bind:value={() => uploadSourceValue, (value) => selectUploadSource(value)}
        />
        {#if computed.uploadFilteredProfiles.length === 0 && computed.uploadEligibleInstances.length === 0}
          <p class="text-muted-foreground text-sm">No saved profiles or running instances found. Add a profile, or mount a volume first.</p>
        {/if}
      </div>

      {#if uploadSourceReady}
        <div class="grid gap-1.5 max-w-sm">
          <Label id="upload-source-type-label">Source type</Label>
          <Select
            id="upload-source-type"
            options={SOURCE_TYPE_OPTIONS}
            value={appState.uploadSourceType}
            ariaLabelledby="upload-source-type-label"
            onchange={(value) => selectUploadSourceType(value)}
          />
        </div>

        {#if !isExternalUploadSource()}
          <div class="grid gap-1.5">
            <Label for="upload-source">Source folder</Label>
            <div class="flex gap-2">
              <Input id="upload-source" bind:value={appState.uploadSource} placeholder="/local/photos" class="flex-1" />
              <Button type="button" onclick={browseUploadSource} disabled={appState.uploadsBusy} class="shrink-0">
                <FolderOpen size={16} aria-hidden="true" /> Browse
              </Button>
            </div>
            {#if appState.uploadSourceError}
              <small class="text-destructive text-sm">{appState.uploadSourceError}</small>
            {/if}
          </div>
        {:else}
          <div class="grid gap-3 border border-border/40 p-3">
            {#if appState.transferSourceProfiles.length > 0}
              <div class="grid gap-1.5 max-w-sm">
                <Label id="upload-source-saved-label">Saved source</Label>
                <Select
                  id="upload-source-saved"
                  options={savedSourceOptions}
                  value={appState.uploadSourceProfileSelectedId ?? NEW_SOURCE_OPTION}
                  ariaLabelledby="upload-source-saved-label"
                  onchange={(value) => (value === NEW_SOURCE_OPTION ? clearTransferSourceProfileSelection() : selectTransferSourceProfile(value))}
                />
              </div>
            {/if}

            <div class="grid gap-1.5 max-w-sm">
              <Label id="upload-source-provider-label">Provider</Label>
              <Select
                id="upload-source-provider"
                options={UPLOAD_SOURCE_PROVIDERS}
                value={appState.uploadSourceProvider}
                placeholder="Choose a provider..."
                ariaLabelledby="upload-source-provider-label"
                onchange={(value) => (appState.uploadSourceProvider = value)}
              />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-1.5">
                <Label for="upload-source-bucket">{appState.uploadSourceProvider === 'azure' ? 'Container' : 'Bucket'}</Label>
                <Input id="upload-source-bucket" bind:value={appState.uploadSourceBucket} autocomplete="off" />
              </div>
              <div class="grid gap-1.5">
                <Label for="upload-source-prefix">Prefix (optional)</Label>
                <Input id="upload-source-prefix" bind:value={appState.uploadSourcePrefix} placeholder="photos/2026" autocomplete="off" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-1.5">
                <Label for="upload-source-endpoint">Endpoint{appState.uploadSourceProvider === 's3compatible' ? ' (required)' : ''}</Label>
                <Input id="upload-source-endpoint" bind:value={appState.uploadSourceEndpoint} placeholder={appState.uploadSourceProvider === 's3compatible' ? 'https://...' : 'auto-derived if left blank'} />
              </div>
              <div class="grid gap-1.5">
                <Label for="upload-source-region">Region</Label>
                <Input id="upload-source-region" bind:value={appState.uploadSourceRegion} />
              </div>
            </div>
            {#if appState.uploadSourceProvider === 'azure'}
              <div class="grid gap-1.5">
                <Label for="upload-source-account">Storage account name</Label>
                <Input id="upload-source-account" bind:value={appState.uploadSourceAccount} />
              </div>
            {:else if appState.uploadSourceProvider !== 'gcs'}
              <div class="grid gap-1.5">
                <Label for="upload-source-access-key-id">Access key id</Label>
                <Input id="upload-source-access-key-id" bind:value={appState.uploadSourceAccessKeyId} autocomplete="off" />
              </div>
            {/if}
            <div class="grid gap-1.5">
              <Label for="upload-source-secret">
                {appState.uploadSourceProvider === 'gcs' ? 'Service-account key (JSON)' : 'Secret access key'}
                {#if uploadSourceProfileUsesVault()}<span class="text-muted-foreground font-normal">(optional, using saved vault credential)</span>{/if}
              </Label>
              {#if appState.uploadSourceProvider === 'gcs'}
                <Textarea id="upload-source-secret" bind:value={appState.uploadSourceSecretValue} rows={4} placeholder={uploadSourceProfileUsesVault() ? 'Leave blank to use the saved vault credential' : '{"type": "service_account", ...}'} />
              {:else}
                <Input id="upload-source-secret" type="password" bind:value={appState.uploadSourceSecretValue} autocomplete="off" placeholder={uploadSourceProfileUsesVault() ? 'Leave blank to use the saved vault credential' : ''} />
              {/if}
            </div>
            {#if appState.uploadSourceError}
              <small class="text-destructive text-sm">{appState.uploadSourceError}</small>
            {/if}

            <div class="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="secondary" onclick={() => runUploadSourceTest()} disabled={appState.uploadSourceTestBusy}>
                <Radar size={16} aria-hidden="true" /> {appState.uploadSourceTestBusy ? 'Testing...' : 'Test connection'}
              </Button>
              <Button type="button" variant="secondary" onclick={openSaveTransferSourceProfile}>
                Save as transfer source
              </Button>
              {#if appState.uploadSourceProfileSelectedId}
                <Button type="button" variant="ghost" onclick={() => removeTransferSourceProfile(appState.uploadSourceProfileSelectedId ?? '')} class="text-destructive">
                  <Trash2 size={16} aria-hidden="true" /> Delete saved source
                </Button>
              {/if}
            </div>
            {#if appState.uploadSourceTestReport}
              <p class="text-sm font-mono whitespace-pre-wrap border border-border/40 p-2">{appState.uploadSourceTestReport}</p>
            {/if}
            {#if appState.uploadSourceTestError}
              <small class="text-destructive text-sm wrap-anywhere">{appState.uploadSourceTestError}</small>
            {/if}

            {#if appState.uploadSourceSaveOpen}
              <div class="grid gap-3 border border-border/40 p-3 bg-muted/20">
                <div class="grid gap-1.5 max-w-sm">
                  <Label for="upload-source-save-name">Name</Label>
                  <Input id="upload-source-save-name" bind:value={appState.uploadSourceSaveName} placeholder="My S3 bucket" />
                </div>
                <div class="flex items-center gap-1.5">
                  <Checkbox bind:checked={appState.uploadSourceSaveToVault} label="Store secret in OS vault" />
                  <InfoTip text="Stores the secret in your OS credential store so this source never asks for it again. Leave blank to be prompted next time." />
                </div>
                {#if appState.uploadSourceSaveError}
                  <small class="text-destructive text-sm">{appState.uploadSourceSaveError}</small>
                {/if}
                <div class="flex gap-2">
                  <Button type="button" variant="primary" onclick={() => saveCurrentAsTransferSourceProfile()}>Save</Button>
                  <Button type="button" variant="ghost" onclick={closeSaveTransferSourceProfile}>Cancel</Button>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <div class="grid gap-1.5">
          <Label for="upload-dest">Destination path</Label>
          <div class="flex gap-2">
            <Input id="upload-dest" bind:value={appState.uploadDest} placeholder="/photos" class="flex-1" />
            <Button type="button" onclick={browseUploadDestination} disabled={appState.uploadsBusy} class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" /> Browse
            </Button>
          </div>
          {#if appState.uploadDestError}
            <small class="text-destructive text-sm">{appState.uploadDestError}</small>
          {/if}
          {#if appState.uploadBrowseError}
            <small class="text-destructive text-sm wrap-anywhere">{appState.uploadBrowseError}</small>
          {/if}
        </div>

        {#if computed.uploadNeedsSecret}
          <div class="grid gap-1.5 max-w-sm">
            <Label for="upload-start-secret">Profile secret access key</Label>
            <Input id="upload-start-secret" type="password" bind:value={appState.uploadStartSecretValue} autocomplete="current-password" />
          </div>
        {/if}

        <div class="grid gap-1.5">
          <button
            type="button"
            class="flex items-center gap-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={() => (appState.uploadAdvancedOpen = !appState.uploadAdvancedOpen)}
            aria-expanded={appState.uploadAdvancedOpen}
          >
            <ChevronLeft size={14} aria-hidden="true" class={appState.uploadAdvancedOpen ? '-rotate-90' : 'rotate-180'} />
            Advanced options
          </button>
        </div>

        {#if appState.uploadAdvancedOpen}
          <div class="grid gap-3 border border-border/40 p-3">
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadOnce} label="Settle and exit" />
              <InfoTip text="Runs until a rescan finds nothing new, then exits (`--once`).

Without it, the job keeps running in the background and re-scanning the source." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadOverwrite} label="Re-upload changed files" />
              <InfoTip text="On a rescan, re-uploads a **done** path if its local size has changed (`--overwrite`).

Without this, a done path is never re-checked." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadDryRun} label="Dry run" />
              <InfoTip text="Scans and reports the plan only (`--dry-run`).

No connection, no writes at all." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadRestart} label="Force a fresh job" />
              <InfoTip text="Starts a brand new job (`--restart`), even if a resumable one already matches this **(source, dest)** pair." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadFollowSymlinks} label="Follow symlinks" />
              <InfoTip text="Dereferences symlinks to regular files instead of skipping them (`--follow-symlinks`)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadCreateSourceDirectory} label="Nest under source folder name" />
              <InfoTip text="Uploads into `DEST_PATH/<source-folder-name>/` instead of writing directly into `DEST_PATH` (`--create-source-directory`)." />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-rescan-interval">Rescan interval</Label>
                  <InfoTip text="How often to re-walk the source for new/changed files while the job keeps running.

Default: `30s`." />
                </span>
                <Input id="upload-rescan-interval" bind:value={appState.uploadRescanInterval} placeholder="30s" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-bwlimit">Bandwidth limit, Mbps</Label>
                  <InfoTip text="Caps upload bandwidth in Mbps.

`0` or blank means unlimited." />
                </span>
                <Input id="upload-bwlimit" type="number" min="0" bind:value={appState.uploadBwlimit} placeholder="0 (unlimited)" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-include">Include globs (one per line)</Label>
                  <InfoTip text="Only upload paths matching one of these globs.

Repeatable, one pattern per line, e.g. `*.jpg`." />
                </span>
                <Textarea id="upload-include" bind:value={appState.uploadIncludeText} rows={3} placeholder="*.jpg" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-exclude">Exclude globs (one per line)</Label>
                  <InfoTip text="Never upload paths matching one of these globs.

**Exclude always wins** over include when both match." />
                </span>
                <Textarea id="upload-exclude" bind:value={appState.uploadExcludeText} rows={3} placeholder="*.tmp" />
              </div>
            </div>
          </div>
        {/if}

        {#if appState.uploadStartError}
          <CliErrorOutput role="alert" text={appState.uploadStartError} command={computed.uploadCommandText} />
        {/if}
        {#if appState.uploadDryRunReport}
          <div class="grid gap-1.5">
            <Label>Dry run report</Label>
            <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border p-2.5 font-mono text-xs">{appState.uploadDryRunReport}</pre>
          </div>
        {/if}
        <CommandPreview label="COMMAND PREVIEW" text={computed.uploadCommandText}>
          <code>{computed.uploadCommandText}</code>
        </CommandPreview>
      {/if}

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={exitUploadCreate}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy || !uploadSourceReady || !effectiveUploadSource() || !appState.uploadDest.trim()}>
          <Upload size={16} aria-hidden="true" />
          {appState.uploadDryRun ? 'Run dry run' : 'Start upload'}
        </Button>
      </div>
    </form>
  </section>
{:else if appState.uploadSubView === 'resume' && resumeJob}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmUploadResume() }}>
      <div class="flex items-center justify-between gap-4">
        <button
          type="button"
          class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
          onclick={cancelUploadResume}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Back to upload jobs
        </button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><RefreshCw size={19} aria-hidden="true" /> Resume upload</h3>

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
          <Label for="upload-resume-discovery-url">Discovery URL</Label>
          <Input id="upload-resume-discovery-url" bind:value={appState.uploadResumeDiscoveryUrl} placeholder="https://discovery.example.com" />
        </div>
        <div class="grid gap-1.5">
          <Label for="upload-resume-access-key">Access key ID</Label>
          <Input id="upload-resume-access-key" bind:value={appState.uploadResumeAccessKeyId} />
        </div>
      </div>

      <div class="flex items-center gap-1.5">
        <Checkbox bind:checked={appState.uploadResumeOnce} label="Settle and exit (--once)" />
        <InfoTip text="Once every pending file is uploaded, exits the job with a real completed status (`--once`).

**Leave this unchecked** and the job goes back to running as a background daemon. It rescans the source on an interval forever, watching for new/changed files, and never marks itself completed on its own, even once there's nothing left to do. That's the `running` + nothing pending state you'd otherwise see.

Check this when you just want the current backlog cleared and the job to finish for real." />
      </div>

      <div class="grid grid-cols-2 gap-4 max-w-2xl">
        <div class="grid gap-1.5">
          <Label for="upload-resume-rescan-interval">Rescan interval (optional)</Label>
          <Input id="upload-resume-rescan-interval" bind:value={appState.uploadResumeRescanInterval} placeholder="30s" />
        </div>
        <div class="grid gap-1.5">
          <Label for="upload-resume-secret">Secret access key (optional)</Label>
          <Input id="upload-resume-secret" type="password" bind:value={appState.uploadResumeSecretValue} autocomplete="current-password" />
        </div>
      </div>
      <p class="text-muted-foreground text-sm -mt-2">Leave the secret blank to reuse a saved profile's cached secret for this access key ID, if one exists.</p>

      {#if appState.uploadResumeError}
        <CliErrorOutput role="alert" text={appState.uploadResumeError} command={resumeCommandText} />
      {/if}
      <CommandPreview label="COMMAND PREVIEW" text={resumeCommandText}>
        <code>{resumeCommandText}</code>
      </CommandPreview>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={cancelUploadResume}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>
    </form>
  </section>
{:else if appState.uploads.length === 0}
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
      {#if appState.uploadsBusy}
        <Upload size={28} aria-hidden="true" class="animate-pulse" />
        <p class="text-muted-foreground">Loading upload jobs...</p>
      {:else}
        <Upload size={28} aria-hidden="true" />
        <strong>No active uploads</strong>
        {#if appState.uploadsError}
          <p class="text-destructive text-sm wrap-anywhere" role="alert">{appState.uploadsError}</p>
        {/if}
        <p>Push a local folder or file list into a mountOS volume, with the exact CLI command shown before every action.</p>
        <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterUploadCreate}>
          <Plus size={16} aria-hidden="true" />
          New upload
        </Button>
      {/if}
    </div>
  </section>
{:else}
  <section
    class="grid flex-1 grid-rows-1 m-[22px] outline-hidden transition-[grid-template-columns,column-gap] duration-200 ease-out"
    style:grid-template-columns={appState.jobPanelCollapsed.uploads ? '0px minmax(0,1fr)' : '280px minmax(0,1fr)'}
    style:column-gap={appState.jobPanelCollapsed.uploads ? '0px' : '1rem'}
    style:direction={panelSide === 'left' ? 'ltr' : 'rtl'}
    tabindex="-1"
    use:focusOnMount
  >
    <JobPanel id="uploads" searchPlaceholder="Search uploads...">
      {#snippet children(query, floating)}
        {@const filteredJobs = computed.uploadVisibleJobs.filter((job) => matchesSearch(query, job.name, job.destPath, job.sourcePath, job.jobId))}
        <div class={cn('mb-4 flex items-center justify-between gap-2', floating && 'flex-wrap')}>
          <h3 class="flex items-center gap-2"><Upload size={18} aria-hidden="true" /> Uploads</h3>
          <div class={cn('flex items-center gap-1', floating && 'flex-wrap')}>
            {#if !floating}
              <Button type="button" size="icon" variant="ghost" onclick={() => setJobPanelCollapsed('uploads', true)} title="Collapse panel" aria-label="Collapse panel">
                {#if panelSide === 'left'}
                  <PanelLeftClose size={15} aria-hidden="true" />
                {:else}
                  <PanelRightClose size={15} aria-hidden="true" />
                {/if}
              </Button>
            {/if}
            <Button type="button" size="icon" variant="ghost" onclick={runUploadList} disabled={appState.uploadsBusy} title="Refresh job list" aria-label="Refresh job list">
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
            <Button type="button" size="icon" variant="ghost" onclick={requestUploadPrune} disabled={appState.uploadsBusy} title="Prune completed/halted jobs" aria-label="Prune completed/halted jobs">
              <Trash2 size={15} aria-hidden="true" />
            </Button>
            {#if floating}
              <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterUploadCreate}>
                <Plus size={16} aria-hidden="true" />
                New upload
              </Button>
            {/if}
          </div>
        </div>
        {#if !floating}
          <Button type="button" variant="primary" class="w-full mb-3 cyberpunk-skewed-sm" onclick={enterUploadCreate}>
            <Plus size={16} aria-hidden="true" />
            New upload
          </Button>
        {/if}
        {#if appState.uploadsError}
          <p class="text-destructive text-sm mb-2 wrap-anywhere" role="alert">{appState.uploadsError}</p>
        {/if}
        {#if computed.uploadHiddenCompletedCount > 0}
          <Checkbox
            bind:checked={appState.uploadShowCompleted}
            label="Show completed ({computed.uploadHiddenCompletedCount})"
            class="mb-2"
          />
        {/if}
        <div class="grid gap-1.5">
          {#if computed.uploadVisibleJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>{appState.uploads.length === 1 ? 'The only job has completed.' : `All ${appState.uploads.length} jobs have completed.`}</p>
            </div>
          {:else if filteredJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>No jobs match &quot;{query}&quot;.</p>
            </div>
          {:else}
            {#each filteredJobs as job (job.jobId)}
              <button
                class:bg-accent={appState.uploadSelectedJobId === job.jobId}
                class="flex min-w-0 items-center gap-2.5 border border-transparent p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => {
                  appState.uploadSelectedJobId = job.jobId
                  closeJobPanelFloating()
                }}
              >
                <Upload size={16} aria-hidden="true" class="shrink-0" />
                <span class="min-w-0 flex-1">
                  <strong class="block truncate">{job.name || job.destPath || job.jobId}</strong>
                  <span class="block truncate text-muted-foreground text-sm">{job.sourcePath ?? 'source profile'}</span>
                </span>
                <Badge variant={stateBadgeVariant[displayState(job)] ?? 'default'}>{job.state}</Badge>
              </button>
            {/each}
            {#if computed.uploadVisibleJobsTruncated}
              <p class="text-muted-foreground text-sm p-2">
                Showing the first {computed.uploadVisibleJobs.length} of {computed.uploadVisibleJobsTotal} jobs, prune old jobs to see the rest.
              </p>
            {/if}
          {/if}
        </div>
      {/snippet}
    </JobPanel>

    {#if selectedJob}
      {@const job = selectedJob}
      {@const resumable = job.state === 'halted' || job.state === 'resumable'}
      <!-- content-start: this panel is a grid cell stretched to the full
           section height (grid-rows-1 on the parent section above), and
           CSS grid's default align-content is stretch. Without this, the
           header/detail/progress rows spread apart to fill that height
           instead of staying compact at the top. -->
      <div class="surface corner-brackets p-4 grid content-start gap-4 min-w-0" style:direction="ltr">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1 basis-48">
            <h3 class="flex min-w-0 items-center gap-2">
              <Upload size={19} aria-hidden="true" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{job.name || job.destPath || job.jobId}</span>
              <Badge variant="secondary" class="shrink-0" title="Fork name">{job.forkName || 'main'}</Badge>
              <Badge variant="secondary" class="ml-auto min-w-0 shrink truncate" title="Job ID">
                <Tag size={12} aria-hidden="true" class="shrink-0" />
                {job.jobId}
              </Badge>
            </h3>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if job.state === 'running'}
              <Button type="button" variant="destructive" disabled={appState.uploadsBusy} onclick={() => runUploadCancel(job)}>
                <OctagonX size={16} aria-hidden="true" /> Cancel
              </Button>
            {:else if resumable}
              {#if isUploadFinishable(job)}
                <Button type="button" variant="outline" title="Nothing is pending or uploading, this just needs the terminal state confirmed. No reconnect needed." onclick={() => runUploadFinish(job)} disabled={appState.uploadsBusy}>
                  <Check size={16} aria-hidden="true" /> Mark complete
                </Button>
              {/if}
              <Button type="button" onclick={() => requestUploadResume(job)} disabled={appState.uploadsBusy}>
                <RotateCcw size={16} aria-hidden="true" /> Resume
              </Button>
            {/if}
            {#if job.counts.failed}
              <Button type="button" variant="outline" disabled={appState.uploadsBusy} onclick={() => runUploadRetryFailed(job)}>
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
                    <InfoTip text="A daemon-mode job keeps discovering more each rescan. These numbers aren't final until it settles." />
                  </span>
                {/if}
              </p>
            {:else}
              <p class="text-muted-foreground">unknown</p>
            {/if}
          </div>
        </div>

        {#if isIdleRunning(job)}
          <div class="corner-accent flex items-start gap-3 p-3.5">
            <Radar size={20} aria-hidden="true" class="text-primary mt-0.5 shrink-0 animate-pulse" />
            <div class="grid min-w-0 flex-1 gap-1">
              <p class="font-semibold">Watching for changes</p>
              <p class="text-muted-foreground text-sm">
                Nothing to upload right now, but it keeps rescanning and won't stop on its own. Use <strong class="text-foreground font-semibold">Cancel</strong> above to stop it, then resume with <strong class="text-foreground font-semibold">Settle and exit</strong> checked to finish it for good.
              </p>
            </div>
          </div>
        {/if}

        {#if job.haltReason}
          <CliErrorOutput role="alert" text={job.haltReason} />
        {/if}

        {#if job.logPath}
          <div class="grid gap-1 min-w-0">
            <Label>Log</Label>
            <div class="flex items-center gap-2 min-w-0">
              <code class="min-w-0 flex-1 truncate" title={job.logPath}>{job.logPath}</code>
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Copy log path" aria-label="Copy log path" onclick={() => copyUploadJobLogPath(job)}>
                <Copy size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Open log" aria-label="Open log" onclick={() => openUploadJobLog(job)}>
                <ExternalLink size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        {/if}

        <div class="grid gap-2">
          <div class="flex items-center justify-between gap-2 border-b-2 border-primary pb-2 mb-2">
            <p class="text-xs font-bold uppercase tracking-wide">Progress</p>
            {#if appState.uploadsLastFetchedAt != null}
              <span
                class="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground"
                title={new Date(appState.uploadsLastFetchedAt).toLocaleString()}
              >
                <Clock size={12} aria-hidden="true" />
                {lastFetchedLabel(appState.uploadsLastFetchedAt, now)}
              </span>
            {/if}
          </div>
          <Table containerLabel="Upload progress by status" class="max-w-xs">
            <TableBody>
              {#each [['Pending', job.counts.pending, ''], ['Uploading', job.counts.uploading, ''], ['Done', job.counts.done, 'text-success'], ['Failed', job.counts.failed, 'text-destructive'], ['Skipped', job.counts.skipped, ''], ['Missing', job.counts.missing, '']] as [countLabel, count, tone] (countLabel)}
                <TableRow>
                  <TableCell class="text-label-foreground text-xs uppercase tracking-wide">{countLabel}</TableCell>
                  <TableCell class="text-right tabular-nums {tone}">{count ?? 0}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </div>
      </div>
    {:else}
      <!-- No "New upload" button here, the left panel already has the
           primary one directly above this same empty state, so a second
           identical CTA on screen at once was pure duplication. -->
      <div class="surface relative">
        <div class="tech-grid absolute inset-6 pointer-events-none" aria-hidden="true"></div>
        <div class="relative grid content-center justify-items-center gap-3 h-full px-7 py-10 text-center">
          <Upload size={28} aria-hidden="true" />
          <strong>No job selected</strong>
          <p>Pick a job on the left to see its progress and details.</p>
        </div>
      </div>
    {/if}
  </section>
{/if}
