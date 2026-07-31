<script lang="ts">
  import {
    ChevronLeft,
    FolderOpen,
    HardDrive,
    ListChecks,
    MonitorDot,
    OctagonX,
    Plus,
    RefreshCw,
    RotateCcw,
    Trash2,
    Upload,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge'
  import Combobox from '$lib/components/shared/Combobox.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseUploadDestination,
    browseUploadSource,
    computed,
    enterUploadCreate,
    exitUploadCreate,
    requestUploadPrune,
    requestUploadResume,
    resetUploadForm,
    runUploadCancel,
    runUploadList,
    runUploadRetryFailed,
    runUploadStart,
    selectUploadInstance,
    selectUploadProfile,
  } from '$lib/app-state.svelte'
  import type { MountInstance, UploadJob } from '$lib/types'

  // Fetch exactly once per mount, not gated on uploads.length === 0 -- unlike
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

  const stateBadgeVariant: Record<string, BadgeVariant> = {
    running: 'success',
    halted: 'destructive',
    completed: 'secondary',
    'completed (failures)': 'warning',
    resumable: 'warning',
  }

  // The server's own state classification has no "completed with failures"
  // concept (a settle-and-exit with permanent failures still stamps
  // CompletedAt and clears HaltReason -- see mountos-servers cmd_upload.go,
  // exit code 3 is the only place that distinction is visible), so a job
  // that permanently dropped files would otherwise render an identical
  // calm "completed" badge to a fully clean one. Derived client-side from
  // the counts map this GUI already has, not a new field.
  function displayState(job: UploadJob): string {
    return job.state === 'completed' && (job.counts.failed ?? 0) > 0 ? 'completed (failures)' : job.state
  }

  function countsSummary(job: UploadJob): string {
    const parts = Object.entries(job.counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`)
    return parts.length ? parts.join(', ') : 'no entries yet'
  }

  const selectedJob = $derived(appState.uploads.find((job) => job.jobId === appState.uploadSelectedJobId) ?? null)

  $effect(() => {
    // The selected job can vanish from the list after a refresh (pruned, or
    // simply not returned this pass), or drop out of view because it just
    // completed cleanly and "show completed" is off -- fall back to the
    // first VISIBLE row (not just any row) rather than keeping a selection
    // with nothing highlighted to show for it.
    if (appState.uploadSelectedJobId && !computed.uploadVisibleJobs.some((job) => job.jobId === appState.uploadSelectedJobId)) {
      appState.uploadSelectedJobId = computed.uploadVisibleJobs[0]?.jobId ?? null
    } else if (!appState.uploadSelectedJobId && computed.uploadVisibleJobs.length > 0) {
      appState.uploadSelectedJobId = computed.uploadVisibleJobs[0].jobId
    }
  })

  const profileOptions = $derived(computed.uploadFilteredProfiles.map((p) => ({ value: p.id, label: p.name })))

  function instanceLabel(instance: MountInstance): string {
    return instance.name || instance.mountPath
  }

  function selectSourceKind(kind: 'profile' | 'instance') {
    if (appState.uploadSourceKind === kind) return
    appState.uploadSourceKind = kind
    appState.uploadSourceProfileId = kind === 'profile' ? (appState.profiles[0]?.id ?? null) : null
    appState.uploadSourceInstance = null
    resetUploadForm()
  }

  const uploadSourceReady = $derived(
    appState.uploadSourceKind === 'profile' ? Boolean(appState.uploadSourceProfileId) : Boolean(appState.uploadSourceInstance),
  )
</script>

{#if appState.uploadSubView === 'create'}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <button
      type="button"
      class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
      onclick={exitUploadCreate}
    >
      <ChevronLeft size={16} aria-hidden="true" /> Back to upload jobs
    </button>

    <h3 class="flex items-center gap-2"><Upload size={19} aria-hidden="true" /> New upload</h3>

    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void runUploadStart() }}>
      <div class="flex justify-end">
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy || !uploadSourceReady || !appState.uploadSource.trim() || !appState.uploadDest.trim()}>
          <Upload size={16} aria-hidden="true" />
          {appState.uploadDryRun ? 'Run dry run' : 'Start upload'}
        </Button>
      </div>

      <div class="grid gap-1.5">
        <Label>Source</Label>
        <div class="flex gap-1.5" role="group" aria-label="Upload source kind">
          <Button type="button" size="sm" variant={appState.uploadSourceKind === 'profile' ? 'primary' : 'outline'} onclick={() => selectSourceKind('profile')}>
            <HardDrive size={14} aria-hidden="true" /> Saved profile
          </Button>
          <Button type="button" size="sm" variant={appState.uploadSourceKind === 'instance' ? 'primary' : 'outline'} onclick={() => selectSourceKind('instance')}>
            <MonitorDot size={14} aria-hidden="true" /> Running instance
          </Button>
        </div>
      </div>

      {#if appState.uploadSourceKind === 'profile'}
        {#if appState.profiles.length === 0}
          <div class="tech-grid p-5 text-center">
            <p>Add a profile first -- an upload needs a discovery URL and credentials to connect against.</p>
          </div>
        {:else}
          <div class="grid gap-1.5 max-w-sm">
            <Label id="upload-profile-label">Profile</Label>
            <Combobox
              options={profileOptions}
              placeholder="Choose a profile..."
              emptyText="No matching profiles."
              aria-labelledby="upload-profile-label"
              bind:value={() => appState.uploadSourceProfileId ?? '', (value) => selectUploadProfile(value)}
            />
          </div>
        {/if}
      {:else if computed.uploadEligibleInstances.length === 0}
        <div class="tech-grid p-5 text-center">
          <p>No mounted, active instances found. Mount a volume first (Snapshot/Deleted/Version views don't count).</p>
        </div>
      {:else}
        <div class="grid gap-1.5 max-w-sm">
          <Label id="upload-instance-label">Running instance</Label>
          <Combobox
            options={computed.uploadEligibleInstances.map((i) => ({ value: i.mountPath, label: instanceLabel(i) }))}
            placeholder="Choose a running instance..."
            emptyText="No matching instances."
            aria-labelledby="upload-instance-label"
            bind:value={
              () => appState.uploadSourceInstance?.mountPath ?? '',
              (value) => {
                const instance = computed.uploadEligibleInstances.find((i) => i.mountPath === value)
                if (instance) void selectUploadInstance(instance)
              }
            }
          />
        </div>
      {/if}

      {#if uploadSourceReady}
        <div class="flex items-center gap-2">
          <span class="text-sm text-muted-foreground">Fork</span>
          <Badge variant="secondary">{computed.uploadResolvedFork || 'main'}</Badge>
        </div>

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
            <small class="text-destructive text-sm">{appState.uploadBrowseError}</small>
          {/if}
        </div>

        {#if computed.uploadNeedsSecret}
          <div class="grid gap-1.5 max-w-sm">
            <Label for="upload-start-secret">Secret access key</Label>
            <Input id="upload-start-secret" type="password" bind:value={appState.uploadStartSecretValue} autocomplete="current-password" />
            <small class="text-muted-foreground text-sm">Used for both Browse and Start -- entering it once covers both.</small>
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
              <InfoTip text="Runs until a rescan finds nothing new, then exits (--once). Without it, the job keeps running in the background and re-scanning the source." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadOverwrite} label="Re-upload changed files" />
              <InfoTip text="On a rescan, re-uploads a done path if its local size has changed (--overwrite). Without this, a done path is never re-checked." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadDryRun} label="Dry run" />
              <InfoTip text="Scans and reports the plan only -- no connection, no writes at all (--dry-run)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadRestart} label="Force a fresh job" />
              <InfoTip text="Starts a brand new job even if a resumable one already matches this (source, dest) pair (--restart)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadFollowSymlinks} label="Follow symlinks" />
              <InfoTip text="Dereferences symlinks to regular files instead of skipping them (--follow-symlinks)." />
            </div>
            <div class="flex items-center gap-1.5">
              <Checkbox bind:checked={appState.uploadCreateSourceDirectory} label="Nest under source folder name" />
              <InfoTip text="Uploads into DEST_PATH/<source-folder-name>/ instead of writing directly into DEST_PATH (--create-source-directory)." />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-rescan-interval">Rescan interval</Label>
                  <InfoTip text="How often to re-walk the source for new/changed files while the job keeps running (default 30s)." />
                </span>
                <Input id="upload-rescan-interval" bind:value={appState.uploadRescanInterval} placeholder="30s" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-bwlimit">Bandwidth limit, Mbps</Label>
                  <InfoTip text="Caps upload bandwidth in Mbps. 0 or blank means unlimited." />
                </span>
                <Input id="upload-bwlimit" type="number" min="0" bind:value={appState.uploadBwlimit} placeholder="0 (unlimited)" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-include">Include globs (one per line)</Label>
                  <InfoTip text="Only upload paths matching one of these globs. Repeatable, one pattern per line." />
                </span>
                <Textarea id="upload-include" bind:value={appState.uploadIncludeText} rows={3} placeholder="*.jpg" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="upload-exclude">Exclude globs (one per line)</Label>
                  <InfoTip text="Never upload paths matching one of these globs. Wins over include when both match." />
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
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy || !uploadSourceReady || !appState.uploadSource.trim() || !appState.uploadDest.trim()}>
          <Upload size={16} aria-hidden="true" />
          {appState.uploadDryRun ? 'Run dry run' : 'Start upload'}
        </Button>
      </div>
    </form>
  </section>
{:else}
  <section class="grid grid-cols-[280px_minmax(0,1fr)] gap-4 m-[22px] outline-hidden" tabindex="-1" use:focusOnMount>
    <div class="surface p-4">
      <div class="flex items-center justify-between gap-2 mb-4">
        <h3 class="flex items-center gap-2"><Upload size={18} aria-hidden="true" /> Uploads</h3>
        <div class="flex items-center gap-1">
          <Button type="button" size="icon" variant="ghost" onclick={runUploadList} disabled={appState.uploadsBusy} title="Refresh job list" aria-label="Refresh job list">
            <RefreshCw size={15} aria-hidden="true" />
          </Button>
          <Button type="button" size="icon" variant="ghost" onclick={requestUploadPrune} disabled={appState.uploadsBusy} title="Prune completed/halted jobs" aria-label="Prune completed/halted jobs">
            <Trash2 size={15} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <Button type="button" variant="primary" class="w-full mb-3 cyberpunk-skewed-sm" onclick={enterUploadCreate}>
        <Plus size={16} aria-hidden="true" />
        New upload
      </Button>
      {#if appState.uploadsError}
        <p class="text-destructive text-sm mb-2" role="alert">{appState.uploadsError}</p>
      {/if}
      {#if computed.uploadHiddenCompletedCount > 0}
        <button
          type="button"
          class="mb-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
          onclick={() => (appState.uploadShowCompleted = !appState.uploadShowCompleted)}
        >
          {appState.uploadShowCompleted ? 'Hide' : 'Show'} completed ({computed.uploadHiddenCompletedCount})
        </button>
      {/if}
      <div class="grid gap-1.5">
        {#if appState.uploadsBusy && appState.uploads.length === 0}
          <p class="text-muted-foreground text-sm">Loading upload jobs...</p>
        {:else if appState.uploads.length === 0}
          <div class="tech-grid p-5 text-center">
            <p>No active uploads.</p>
          </div>
        {:else if computed.uploadVisibleJobs.length === 0}
          <div class="tech-grid p-5 text-center">
            <p>All {appState.uploads.length} job{appState.uploads.length === 1 ? '' : 's'} completed cleanly.</p>
          </div>
        {:else}
          {#each computed.uploadVisibleJobs as job (job.jobId)}
            <button
              class:bg-accent={appState.uploadSelectedJobId === job.jobId}
              class="flex min-w-0 items-center gap-2.5 border border-transparent p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => (appState.uploadSelectedJobId = job.jobId)}
            >
              <Upload size={16} aria-hidden="true" class="shrink-0" />
              <span class="min-w-0 flex-1">
                <strong class="block truncate">{job.destPath || job.jobId}</strong>
                <span class="block truncate text-muted-foreground text-sm">{job.sourcePath ?? 'source profile'}</span>
              </span>
              <Badge variant={stateBadgeVariant[displayState(job)] ?? 'default'}>{job.state}</Badge>
            </button>
          {/each}
          {#if computed.uploadVisibleJobsTruncated}
            <p class="text-muted-foreground text-sm p-2">
              Showing the first {computed.uploadVisibleJobs.length} of {computed.uploadVisibleJobsTotal} jobs -- prune old jobs to see the rest.
            </p>
          {/if}
        {/if}
      </div>
    </div>

    {#if selectedJob}
      {@const job = selectedJob}
      <div class="surface corner-brackets p-4 grid gap-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h3 class="flex items-center gap-2 truncate"><Upload size={19} aria-hidden="true" class="shrink-0" /> {job.destPath || job.jobId}</h3>
            <code class="text-muted-foreground text-sm">{job.jobId}</code>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if job.state === 'running'}
              <Button type="button" variant="destructive" disabled={appState.uploadsBusy} onclick={() => runUploadCancel(job)}>
                <OctagonX size={16} aria-hidden="true" /> Cancel
              </Button>
            {:else}
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

        <div class="grid grid-cols-2 gap-4">
          <div class="grid gap-1">
            <Label>Source</Label>
            <p class="truncate" title={job.sourcePath}>{job.sourcePath ?? 'source profile'}</p>
          </div>
          <div class="grid gap-1">
            <Label>Destination</Label>
            <p class="truncate" title={job.destPath}>{job.destPath}</p>
          </div>
          <div class="grid gap-1">
            <Label>Fork</Label>
            <Badge variant="secondary">{job.forkName || 'main'}</Badge>
          </div>
          <div class="grid gap-1">
            <Label>State</Label>
            <Badge variant={stateBadgeVariant[displayState(job)] ?? 'default'}>{displayState(job)}</Badge>
          </div>
        </div>

        {#if job.haltReason}
          <CliErrorOutput role="alert" text={job.haltReason} />
        {/if}

        <div class="grid gap-1">
          <Label>Progress</Label>
          <p>{countsSummary(job)}</p>
        </div>
      </div>
    {:else}
      <div class="surface tech-grid grid justify-items-center gap-2 p-7 text-center">
        <Upload size={28} aria-hidden="true" />
        <strong>No active uploads</strong>
        <p>Start a bulk upload from a saved profile or a running mount instance, with the exact CLI command shown before every action.</p>
        <Button variant="primary" type="button" class="cyberpunk-skewed-sm" onclick={enterUploadCreate}>
          <Plus size={17} aria-hidden="true" />
          New upload
        </Button>
      </div>
    {/if}
  </section>
{/if}
