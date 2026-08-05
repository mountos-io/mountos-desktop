<script lang="ts">
  import {
    ArrowRight,
    Check,
    ChevronLeft,
    Clock,
    Copy,
    ExternalLink,
    OctagonX,
    PanelLeftClose,
    PanelRightClose,
    Plus,
    Radio,
    RefreshCw,
    RotateCcw,
    Tag,
    Trash2,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
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
    buildSinkResumeArgv,
    cancelSinkResume,
    closeJobPanelFloating,
    computed,
    confirmSinkResume,
    copySinkJobLogPath,
    enterSinkCreate,
    exitSinkCreate,
    openSinkJobLog,
    requestSinkPrune,
    requestSinkRemove,
    requestSinkResume,
    runSinkCancel,
    runSinkFinish,
    runSinkList,
    runSinkStart,
    runSinkStatus,
    schedulePoll,
    selectSinkInstance,
    selectSinkProfile,
    setJobPanelCollapsed,
    sinkDisplaySnapshot,
    withSinkSnapshotCached,
  } from '$lib/app-state.svelte'
  import type { MountInstance, MountProfile, SinkSnapshot } from '$lib/types'
  import { cn, formatBytes, lastFetchedLabel, matchesSearch } from '$lib/utils'

  // Fetch at most once per mount, mirrors UploadsView/DownloadsView's own
  // fetchedOnce gate (an empty job list is the normal first-run state, so
  // gating on length would refetch forever). App.svelte's own effect
  // already fires runSinkList whenever the feature is (or becomes) enabled,
  // covering both "already on at launch" and "just turned on in Settings",
  // so only start a second fetch here if neither an in-flight nor a
  // completed one already exists, since otherwise this view and the sidebar
  // badge would race two concurrent `sink list --json` subprocesses that
  // both clear sinkStatusByJobId.
  let fetchedOnce = false
  $effect(() => {
    if (!fetchedOnce) {
      fetchedOnce = true
      if (appState.sinksLastFetchedAt == null && !appState.sinksBusy) void runSinkList()
    }
  })

  // Auto-refreshes the job list while this view is active, mirrors
  // UploadsView's own schedulePoll effect exactly.
  $effect(() => schedulePoll(() => void runSinkList()))

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
    // `sink finish`'s own terminal state: distinct from 'resumable', same
    // treatment as 'completed' since both are non-error endpoints.
    finished: 'primary',
    resumable: 'warning',
  }

  const selectedJob = $derived(appState.sinks.find((job) => job.jobId === appState.sinkSelectedJobId) ?? null)
  const panelSide = $derived(appState.jobPanelSide.sink ?? 'left')

  $effect(() => {
    if (appState.sinkSelectedJobId && !computed.sinkVisibleJobs.some((job) => job.jobId === appState.sinkSelectedJobId)) {
      appState.sinkSelectedJobId = computed.sinkVisibleJobs[0]?.jobId ?? null
    } else if (!appState.sinkSelectedJobId && computed.sinkVisibleJobs.length > 0) {
      appState.sinkSelectedJobId = computed.sinkVisibleJobs[0].jobId
    }
  })

  // The fuller rate/lag snapshot (segmentsCommitted/fileSize/
  // bitrateObserved/lastCommitAt/lastSegmentAt) isn't in the list response,
  // only `sink status --job <id>` has it (see runSinkStatus's own doc
  // comment); fetched once per selection, then kept fresh by the poll
  // below while its job stays running.
  $effect(() => {
    const jobId = selectedJob?.jobId
    if (jobId) void runSinkStatus(jobId)
  })

  // Bounded poll: unlike uploads/downloads (completion counts, no
  // background shell-out by design, see runSinkList's own comment), every
  // number on this page is a liveness reading for a job that is actively
  // ingesting, so a frozen page would be actively misleading. Runs only
  // while this view is mounted AND at least one job is running; stops the
  // moment sinkRunningCount reaches zero, since the effect re-runs on that
  // dependency and returns before scheduling a new timer. Awaits the list
  // refresh before the status refetch, since runSinkStatus only re-fetches
  // once runSinkList has cleared its cached entry.
  const SINK_POLL_MS = 5000
  $effect(() => {
    if (computed.sinkRunningCount === 0) return
    const id = setInterval(() => {
      void (async () => {
        await runSinkList()
        const jobId = selectedJob?.jobId
        if (jobId) void runSinkStatus(jobId)
      })()
    }, SINK_POLL_MS)
    return () => clearInterval(id)
  })

  const selectedSnapshot = $derived(selectedJob ? appState.sinkStatusByJobId[selectedJob.jobId]?.snapshot : undefined)

  // Stale-while-revalidate: selectedSnapshot goes undefined for a beat every
  // poll tick (runSinkList clears the cache it's derived from, see its own
  // comment), so this view keeps the last snapshot seen per job and shows
  // that instead of flickering to "Not available" and back, but only
  // while the job is still running, see withSinkSnapshotCached/
  // sinkDisplaySnapshot's own doc comment for why the fallback stops once
  // the job has genuinely halted/completed/finished/resumable.
  let sinkSnapshotCache: Record<string, SinkSnapshot> = $state({})
  $effect(() => {
    sinkSnapshotCache = withSinkSnapshotCached(sinkSnapshotCache, selectedJob?.jobId, selectedSnapshot)
  })
  const displaySnapshot = $derived(
    sinkDisplaySnapshot(sinkSnapshotCache, selectedJob?.jobId, selectedSnapshot, selectedJob?.state === 'running'),
  )

  function instanceLabel(instance: MountInstance): string {
    return instance.name || instance.mountPath
  }

  // One combined picker, mirrors UploadsView's uploadSourceOptions exactly:
  // sink's connection needs (fork/discovery-url/credentials to write into
  // the volume) are identical to upload's, only the positionals' meaning
  // differs (an M3U8 URL, not a local path).
  const sinkTargetOptions = $derived([
    ...computed.sinkFilteredProfiles.map((p) => ({ value: `profile:${p.id}`, label: `Profile - ${p.name}` })),
    ...computed.sinkEligibleInstances.map((i) => ({ value: `instance:${i.mountPath}`, label: `Running - ${instanceLabel(i)}` })),
  ])

  const sinkTargetValue = $derived(
    appState.sinkSourceKind === 'profile' && appState.sinkSourceProfileId
      ? `profile:${appState.sinkSourceProfileId}`
      : appState.sinkSourceKind === 'instance' && appState.sinkSourceInstance
        ? `instance:${appState.sinkSourceInstance.mountPath}`
        : '',
  )

  function selectSinkTarget(value: string) {
    if (value.startsWith('profile:')) {
      selectSinkProfile(value.slice('profile:'.length))
    } else if (value.startsWith('instance:')) {
      const mountPath = value.slice('instance:'.length)
      const instance = computed.sinkEligibleInstances.find((i) => i.mountPath === mountPath)
      if (instance) void selectSinkInstance(instance)
    }
  }

  const sinkTargetReady = $derived(
    appState.sinkSourceKind === 'profile' ? Boolean(appState.sinkSourceProfileId) : Boolean(appState.sinkSourceInstance),
  )

  const resumeJob = $derived(appState.sinkResumePromptFor)

  // Resume works from discoveryUrl/accessKeyId alone (see resumeSink's own
  // comment), not a saved profile, so this synthetic object exists purely
  // to feed the shared argv builder/command preview, mirrors UploadsView's
  // own resumeProfile trick exactly.
  const resumeProfile = $derived({
    id: 'resume',
    schemaVersion: 1,
    kind: 'mount',
    name: '',
    volume: '',
    fork: '',
    mountPath: '',
    discoveryUrl: appState.sinkResumeDiscoveryUrl.trim(),
    accessKeyId: appState.sinkResumeAccessKeyId.trim(),
    secretRef: 'prompt',
    backend: 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  } satisfies MountProfile)

  const resumeCommandText = $derived(resumeJob ? `mountos ${buildSinkResumeArgv(resumeProfile, resumeJob.jobId).join(' ')}` : '')

  // job.currentPath is always mountOS-relative ('/'-separated regardless of
  // host OS, never a Windows path), so a plain split is enough.
  function sinkFileBasename(path: string | undefined): string {
    if (!path) return ''
    const parts = path.split('/')
    return parts[parts.length - 1] || path
  }

  function formatSeconds(seconds: number | undefined): string {
    if (!seconds) return '0s'
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = Math.round(seconds % 60)
    return `${minutes}m ${remainder}s`
  }

  function formatBitrate(bitsPerSecond: number | undefined): string {
    if (!bitsPerSecond) return '0 Mbps'
    return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  }

  function formatTimestamp(iso: string | undefined): string {
    if (!iso) return 'never'
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
  }

  // Rate/lag counters shown in the detail table below the prominent lag/WAL
  // tiles. Values come from the list response first (available instantly
  // for every job), the fuller status snapshot fills in the fields the
  // list doesn't carry (segmentsCommitted/fileSize/bitrateObserved) once it
  // resolves, per the plan's "surface lag and WAL depth prominently, the
  // rest is detail" instruction.
  // A status snapshot is present for a running job (a live reading) or for
  // a stopped job with cached final counters (job.lastKnown true, see
  // querySinkStatus's own cached-counts branch); an absent snapshot here
  // means neither applies, so rendering 0 for a halted job that ingested
  // gigabytes before stopping would misreport it as never having done
  // anything.
  const NOT_AVAILABLE = 'Not available'
  // lastCommitAt/lastSegmentAt are never persisted in the cached-counts
  // fallback (SinkCachedCounts carries no timestamps), so a lastKnown
  // snapshot's missing timestamp means "not tracked", not "never happened";
  // only a live (non-lastKnown) snapshot's absent timestamp is the
  // legitimate "hasn't committed/arrived yet this run" case, which
  // formatTimestamp renders as "never".
  function formatLastActivity(isLastKnown: boolean, snapshot: SinkSnapshot | undefined, iso: string | undefined): string {
    if (!snapshot || isLastKnown) return NOT_AVAILABLE
    return formatTimestamp(iso)
  }
  // Two groups rather than one long column: throughput answers "how much has
  // moved", trouble answers "what went wrong and how recently". They render
  // side by side when there is room and stack when there is not.
  const detailGroups = $derived.by(() => {
    const job = selectedJob
    if (!job) return []
    // displaySnapshot, not selectedSnapshot: see the stale-while-revalidate
    // comment above displaySnapshot's declaration.
    const snapshot = displaySnapshot
    const isLastKnown = job.lastKnown ?? false
    const suffix = isLastKnown ? ' (last known)' : ''
    return [
      {
        title: `Throughput${suffix}`,
        rows: [
          { label: 'Segments fetched', value: (job.segmentsFetched ?? 0).toLocaleString(), tone: '' },
          { label: 'Segments committed', value: snapshot ? snapshot.segmentsCommitted.toLocaleString() : NOT_AVAILABLE, tone: '' },
          { label: 'Bytes committed', value: formatBytes(job.bytesCommitted ?? 0), tone: '' },
          { label: 'File size', value: snapshot ? formatBytes(snapshot.fileSize) : NOT_AVAILABLE, tone: '' },
          { label: 'Observed bitrate', value: snapshot ? formatBitrate(snapshot.bitrateObserved) : NOT_AVAILABLE, tone: '' },
        ],
      },
      {
        title: `Trouble and recency${suffix}`,
        rows: [
          { label: 'Discontinuities', value: (job.discontinuities ?? 0).toLocaleString(), tone: (job.discontinuities ?? 0) > 0 ? 'text-warning' : '' },
          { label: 'Fetch errors', value: (job.fetchErrors ?? 0).toLocaleString(), tone: (job.fetchErrors ?? 0) > 0 ? 'text-destructive' : '' },
          { label: 'Commit retries', value: (job.commitRetries ?? 0).toLocaleString(), tone: (job.commitRetries ?? 0) > 0 ? 'text-warning' : '' },
          { label: 'Last commit', value: formatLastActivity(isLastKnown, snapshot, snapshot?.lastCommitAt), tone: '' },
          { label: 'Last segment', value: formatLastActivity(isLastKnown, snapshot, snapshot?.lastSegmentAt), tone: '' },
        ],
      },
    ]
  })
</script>

{#if appState.sinkSubView === 'create'}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void runSinkStart() }}>
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <button
            type="button"
            class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={exitSinkCreate}
          >
            <ChevronLeft size={16} aria-hidden="true" /> Back to ingest jobs
          </button>
          {#if sinkTargetReady}
            <Badge variant="secondary" class="min-w-0 shrink truncate" title="Fork: {computed.sinkResolvedFork || 'main'}">{computed.sinkResolvedFork || 'main'}</Badge>
          {/if}
        </div>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy || !sinkTargetReady || !appState.sinkStreamUrl.trim() || !appState.sinkPath.trim()}>
          <Radio size={16} aria-hidden="true" />
          Start ingest
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><Radio size={19} aria-hidden="true" /> New ingest</h3>

      <div class="grid gap-1.5 max-w-sm">
        <span class="inline-flex items-center gap-1">
          <Label>Destination volume</Label>
          <InfoTip text="The profile or instance to ingest into. Supplies fork, discovery URL, and credentials, same as an upload." />
        </span>
        <Combobox
          options={sinkTargetOptions}
          placeholder="Choose a profile or running instance..."
          emptyText="No matching destination."
          aria-label="Ingest destination volume"
          bind:value={() => sinkTargetValue, (value) => selectSinkTarget(value)}
        />
        {#if computed.sinkFilteredProfiles.length === 0 && computed.sinkEligibleInstances.length === 0}
          <p class="text-muted-foreground text-sm">No saved profiles or running instances found. Add a profile, or mount a volume first.</p>
        {/if}
      </div>

      {#if sinkTargetReady}
        <div class="grid gap-1.5">
          <Label for="sink-stream-url">Stream URL</Label>
          <Input id="sink-stream-url" bind:value={appState.sinkStreamUrl} placeholder="https://example.com/live/stream.m3u8" />
          {#if appState.sinkStreamUrlError}
            <small class="text-destructive text-sm">{appState.sinkStreamUrlError}</small>
          {/if}
        </div>

        <div class="grid gap-1.5">
          <span class="inline-flex items-center gap-1">
            <Label for="sink-path">Destination path</Label>
            <InfoTip text="Where the media file and its `.m3u8` sidecar are written, mountOS-relative.

Always a template: `%Y %m %d %H %M` render per rollover, e.g. `/cams/feed-%Y%m%d-%H.mp4` rolls hourly." />
          </span>
          <Input id="sink-path" bind:value={appState.sinkPath} placeholder="/recordings/feed.mp4" />
          {#if appState.sinkPathError}
            <small class="text-destructive text-sm">{appState.sinkPathError}</small>
          {/if}
        </div>

        {#if computed.sinkNeedsSecret}
          <div class="grid gap-1.5 max-w-sm">
            <Label for="sink-start-secret">Secret access key</Label>
            <Input id="sink-start-secret" type="password" bind:value={appState.sinkStartSecretValue} autocomplete="current-password" />
          </div>
        {/if}

        <div class="grid gap-1.5">
          <button
            type="button"
            class="flex items-center gap-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
            onclick={() => (appState.sinkAdvancedOpen = !appState.sinkAdvancedOpen)}
            aria-expanded={appState.sinkAdvancedOpen}
          >
            <ChevronLeft size={14} aria-hidden="true" class={appState.sinkAdvancedOpen ? '-rotate-90' : 'rotate-180'} />
            Advanced options
          </button>
        </div>

        {#if appState.sinkAdvancedOpen}
          <div class="grid gap-3 border border-border/40 p-3">
            <div class="grid grid-cols-2 gap-4">
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="sink-variant">Rendition (optional)</Label>
                  <InfoTip text="Selects one rendition from a master playlist, by bandwidth, resolution, or NAME (`--variant`).

Default: highest bitrate. Ignored when the stream URL already points at a media playlist directly." />
                </span>
                <Input id="sink-variant" bind:value={appState.sinkVariant} placeholder="highest bitrate" />
              </div>
              <div class="grid gap-1.5">
                <span class="inline-flex items-center gap-1">
                  <Label for="sink-max-latency">Max latency (optional)</Label>
                  <InfoTip text="The commit loop's under-filled-block flush floor (`--max-latency`).

Default: self-tunes from the source's own target segment duration, floored at 30s." />
                </span>
                <Input id="sink-max-latency" bind:value={appState.sinkMaxLatency} placeholder="30s" />
              </div>
            </div>
            <div class="grid gap-1.5 max-w-[16rem]">
              <span class="inline-flex items-center gap-1">
                <Label for="sink-wal-max">WAL disk reservation (optional)</Label>
                <InfoTip text="How much local disk the write-ahead log is allowed to reserve for outage tolerance (`--wal-max`), e.g. `512M` or `2G`.

Default: the smaller of 2 GiB and 25% of free disk." />
              </span>
              <Input id="sink-wal-max" bind:value={appState.sinkWalMax} placeholder="2G" />
            </div>
          </div>
        {/if}

        {#if appState.sinkStartError}
          <CliErrorOutput role="alert" text={appState.sinkStartError} command={computed.sinkCommandText} />
        {/if}
        <CommandPreview label="COMMAND PREVIEW" text={computed.sinkCommandText}>
          <code>{computed.sinkCommandText}</code>
        </CommandPreview>
      {/if}

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={exitSinkCreate}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy || !sinkTargetReady || !appState.sinkStreamUrl.trim() || !appState.sinkPath.trim()}>
          <Radio size={16} aria-hidden="true" />
          Start ingest
        </Button>
      </div>
    </form>
  </section>
{:else if appState.sinkSubView === 'resume' && resumeJob}
  <section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmSinkResume() }}>
      <div class="flex items-center justify-between gap-4">
        <button
          type="button"
          class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring w-fit"
          onclick={cancelSinkResume}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Back to ingest jobs
        </button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>

      <h3 class="flex items-center gap-2"><RefreshCw size={19} aria-hidden="true" /> Resume ingest</h3>

      <div class="grid gap-1 max-w-sm">
        <Label>Job ID</Label>
        <code class="truncate">{resumeJob.jobId}</code>
      </div>

      <div class="corner-brackets grid grid-cols-[1fr_auto_1fr] items-end gap-3 p-3 max-w-2xl">
        <div class="grid min-w-0 gap-1">
          <Label>Stream URL</Label>
          <p class="truncate" title={resumeJob.source}>{resumeJob.source}</p>
        </div>
        <ArrowRight size={18} aria-hidden="true" class="text-muted-foreground mb-1 shrink-0" />
        <div class="grid min-w-0 gap-1">
          <Label>Destination path</Label>
          <p class="truncate" title={resumeJob.sinkTemplate}>{resumeJob.sinkTemplate}</p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 max-w-2xl">
        <div class="grid gap-1.5">
          <Label for="sink-resume-discovery-url">Discovery URL</Label>
          <Input id="sink-resume-discovery-url" bind:value={appState.sinkResumeDiscoveryUrl} placeholder="https://discovery.example.com" />
        </div>
        <div class="grid gap-1.5">
          <Label for="sink-resume-access-key">Access key ID</Label>
          <Input id="sink-resume-access-key" bind:value={appState.sinkResumeAccessKeyId} />
        </div>
      </div>

      <div class="grid gap-1.5 max-w-sm">
        <Label for="sink-resume-secret">Secret access key (optional)</Label>
        <Input id="sink-resume-secret" type="password" bind:value={appState.sinkResumeSecretValue} autocomplete="current-password" />
      </div>
      <p class="text-muted-foreground text-sm -mt-2">Leave the secret blank to reuse a saved profile's cached secret for this access key ID, if one exists.</p>

      {#if appState.sinkResumeError}
        <CliErrorOutput role="alert" text={appState.sinkResumeError} command={resumeCommandText} />
      {/if}
      <CommandPreview label="COMMAND PREVIEW" text={resumeCommandText}>
        <code>{resumeCommandText}</code>
      </CommandPreview>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={cancelSinkResume}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy}>
          <RefreshCw size={16} aria-hidden="true" /> Resume
        </Button>
      </div>
    </form>
  </section>
{:else if appState.sinks.length === 0}
  <!-- Same "loading vs confirmed-empty, one shell" shape as UploadsView's
       identical empty state, see its own comment for the full reasoning. -->
  <section class="surface relative flex-1 m-[22px] outline-hidden" tabindex="-1" use:focusOnMount>
    <div class="tech-grid absolute inset-6 pointer-events-none" aria-hidden="true"></div>
    <div class="relative grid content-center justify-items-center gap-3 h-full px-7 py-10 text-center">
      {#if appState.sinksBusy}
        <Radio size={28} aria-hidden="true" class="animate-pulse" />
        <p class="text-muted-foreground">Loading ingest jobs...</p>
      {:else}
        <Radio size={28} aria-hidden="true" />
        <strong>No active ingest jobs</strong>
        {#if appState.sinksError}
          <p class="text-destructive text-sm wrap-anywhere" role="alert">{appState.sinksError}</p>
        {/if}
        <p>Ingest a live HLS stream into a mountOS volume as one growing, playable file, with the exact CLI command shown before every action.</p>
        <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterSinkCreate}>
          <Plus size={16} aria-hidden="true" />
          New ingest
        </Button>
      {/if}
    </div>
  </section>
{:else}
  <section
    class="grid flex-1 grid-rows-1 m-[22px] outline-hidden transition-[grid-template-columns,column-gap] duration-200 ease-out"
    style:grid-template-columns={appState.jobPanelCollapsed.sink ? '0px minmax(0,1fr)' : '280px minmax(0,1fr)'}
    style:column-gap={appState.jobPanelCollapsed.sink ? '0px' : '1rem'}
    style:direction={panelSide === 'left' ? 'ltr' : 'rtl'}
    tabindex="-1"
    use:focusOnMount
  >
    <JobPanel id="sink" searchPlaceholder="Search ingest jobs...">
      {#snippet children(query, floating)}
        {@const filteredJobs = computed.sinkVisibleJobs.filter((job) => matchesSearch(query, job.name, job.sinkTemplate, job.source, job.jobId))}
        <div class={cn('mb-4 flex items-center justify-between gap-2', floating && 'flex-wrap')}>
          <h3 class="flex items-center gap-2"><Radio size={18} aria-hidden="true" /> Ingest jobs</h3>
          <div class={cn('flex items-center gap-1', floating && 'flex-wrap')}>
            {#if !floating}
              <Button type="button" size="icon" variant="ghost" onclick={() => setJobPanelCollapsed('sink', true)} title="Collapse panel" aria-label="Collapse panel">
                {#if panelSide === 'left'}
                  <PanelLeftClose size={15} aria-hidden="true" />
                {:else}
                  <PanelRightClose size={15} aria-hidden="true" />
                {/if}
              </Button>
            {/if}
            <Button type="button" size="icon" variant="ghost" onclick={runSinkList} disabled={appState.sinksBusy} title="Refresh job list" aria-label="Refresh job list">
              <RefreshCw size={15} aria-hidden="true" />
            </Button>
            <Button type="button" size="icon" variant="ghost" onclick={requestSinkPrune} disabled={appState.sinksBusy} title="Prune completed/halted jobs" aria-label="Prune completed/halted jobs">
              <Trash2 size={15} aria-hidden="true" />
            </Button>
            {#if floating}
              <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterSinkCreate}>
                <Plus size={16} aria-hidden="true" />
                New ingest
              </Button>
            {/if}
          </div>
        </div>
        {#if !floating}
          <Button type="button" variant="primary" class="w-full mb-3 cyberpunk-skewed-sm" onclick={enterSinkCreate}>
            <Plus size={16} aria-hidden="true" />
            New ingest
          </Button>
        {/if}
        {#if appState.sinksError}
          <p class="text-destructive text-sm mb-2 wrap-anywhere" role="alert">{appState.sinksError}</p>
        {/if}
        {#if computed.sinkHiddenCompletedCount > 0}
          <Checkbox
            bind:checked={appState.sinkShowCompleted}
            label="Show completed ({computed.sinkHiddenCompletedCount})"
            class="mb-2"
          />
        {/if}
        <div class="grid gap-1.5">
          {#if computed.sinkVisibleJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>{appState.sinks.length === 1 ? 'The only job has completed.' : `All ${appState.sinks.length} jobs have completed.`}</p>
            </div>
          {:else if filteredJobs.length === 0}
            <div class="tech-grid px-5 py-6 text-center">
              <p>No jobs match &quot;{query}&quot;.</p>
            </div>
          {:else}
            {#each filteredJobs as job (job.jobId)}
              <button
                class:bg-accent={appState.sinkSelectedJobId === job.jobId}
                class="flex min-w-0 items-center gap-2.5 border border-transparent p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => {
                  appState.sinkSelectedJobId = job.jobId
                  closeJobPanelFloating()
                }}
              >
                <Radio size={16} aria-hidden="true" class="shrink-0" />
                <span class="min-w-0 flex-1">
                  <strong class="block truncate">{job.name || job.sinkTemplate || job.jobId}</strong>
                  <span class="block truncate text-muted-foreground text-sm">{job.source}</span>
                </span>
                <Badge variant={stateBadgeVariant[job.state] ?? 'default'}>{job.state}</Badge>
              </button>
            {/each}
            {#if computed.sinkVisibleJobsTruncated}
              <p class="text-muted-foreground text-sm p-2">
                Showing the first {computed.sinkVisibleJobs.length} of {computed.sinkVisibleJobsTotal} jobs.
              </p>
            {/if}
          {/if}
        </div>
      {/snippet}
    </JobPanel>

    {#if selectedJob}
      {@const job = selectedJob}
      <div class="surface corner-brackets p-4 grid content-start gap-4 min-w-0" style:direction="ltr">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0 flex-1 basis-48">
            <h3 class="flex min-w-0 items-center gap-2">
              <Radio size={19} aria-hidden="true" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{job.name || job.sinkTemplate || job.jobId}</span>
              <Badge variant="secondary" class="shrink-0" title="Fork name">{job.fork || 'main'}</Badge>
              <Badge variant="secondary" class="ml-auto min-w-0 shrink truncate" title="Job ID">
                <Tag size={12} aria-hidden="true" class="shrink-0" />
                {job.jobId}
              </Badge>
            </h3>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if job.state === 'running'}
              <Button
                type="button"
                variant="destructive"
                title="Stop now. Leaves the job resumable, with an unfinalized playlist."
                disabled={appState.sinksBusy}
                onclick={() => runSinkCancel(job)}
              >
                <OctagonX size={16} aria-hidden="true" /> Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                title="Finish now. Finalizes the playlist so players see it as complete, and ends the job."
                disabled={appState.sinksBusy}
                onclick={() => runSinkFinish(job)}
              >
                <Check size={16} aria-hidden="true" /> Finish
              </Button>
            {:else}
              {#if job.state === 'halted' || job.state === 'resumable'}
                <Button type="button" onclick={() => requestSinkResume(job)} disabled={appState.sinksBusy}>
                  <RotateCcw size={16} aria-hidden="true" /> Resume
                </Button>
              {/if}
              <Button
                type="button"
                variant="destructive"
                title="Delete this job's local record, whatever its state. Recorded media already committed to the destination is not touched."
                onclick={() => requestSinkRemove(job)}
                disabled={appState.sinksBusy}
              >
                <Trash2 size={16} aria-hidden="true" /> Remove
              </Button>
            {/if}
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="grid gap-1 min-w-0 sm:col-span-2">
            <span class="inline-flex items-center gap-1"><Label>Stream URL</Label><InfoTip text="Redacted by the CLI to strip embedded credentials. The ... marks removed text, not truncation." /></span>
            <p class="wrap-anywhere">{job.source}</p>
          </div>
          <div class="grid gap-1 min-w-0 sm:col-span-2">
            <Label>Destination path</Label>
            <p class="wrap-anywhere">{job.sinkTemplate}</p>
          </div>
          {#if job.currentPath}
            <div class="grid gap-1 min-w-0 sm:col-span-2">
              <Label>Current file</Label>
              <p class="wrap-anywhere">{job.currentPath}</p>
            </div>
          {/if}
          <div class="grid gap-1">
            <Label>State</Label>
            <Badge variant={stateBadgeVariant[job.state] ?? 'default'} class="w-fit">{job.state}</Badge>
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
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Copy log path" aria-label="Copy log path" onclick={() => copySinkJobLogPath(job)}>
                <Copy size={16} aria-hidden="true" />
              </Button>
              <Button type="button" variant="outline" size="icon" class="shrink-0" title="Open log" aria-label="Open log" onclick={() => openSinkJobLog(job)}>
                <ExternalLink size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        {/if}

        <div class="grid gap-2">
          <div class="flex items-center justify-between gap-2 border-b-2 border-primary pb-2 mb-2">
            <p class="text-xs font-bold uppercase tracking-wide">Health</p>
            {#if appState.sinksLastFetchedAt != null}
              <span
                class="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground"
                title={new Date(appState.sinksLastFetchedAt).toLocaleString()}
              >
                <Clock size={12} aria-hidden="true" />
                {lastFetchedLabel(appState.sinksLastFetchedAt, now)}
              </span>
            {/if}
          </div>

          <!-- Lag, WAL depth, and Files are the health signals worth seeing
               at a glance, everything else is detail (see detailGroups
               below). Lag is always 0 in job.json's cached final counters
               (they describe an active fetch loop that no longer exists),
               so a lastKnown job renders "Not available" here rather than a
               fabricated zero; WAL depth and Files are genuine cached
               totals, kept numeric and just labeled. grid-cols-1 sm:grid-
               cols-3, never a hard-coded grid-cols-3: a fixed column count
               with no single-column fallback overflows at narrow widths. -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-lg">
            <div class="corner-accent p-3 min-w-0">
              <p class="text-label-foreground text-xs uppercase tracking-wide">Lag</p>
              {#if job.lastKnown}
                <p class="text-2xl font-semibold tabular-nums text-muted-foreground">Not available</p>
                <p class="text-muted-foreground text-xs">last known job, no live lag reading</p>
              {:else}
                <p class="text-2xl font-semibold tabular-nums" class:text-warning={(job.lagSeconds ?? 0) > 60}>
                  {formatSeconds(job.lagSeconds)}
                </p>
                <p class="text-muted-foreground text-xs tabular-nums">{(job.lagSegments ?? 0).toLocaleString()} segment{(job.lagSegments ?? 0) === 1 ? '' : 's'}</p>
              {/if}
            </div>
            <div class="corner-accent p-3 min-w-0">
              <p class="text-label-foreground text-xs uppercase tracking-wide">WAL depth{job.lastKnown ? ' (last known)' : ''}</p>
              <p class="text-2xl font-semibold tabular-nums">{formatBytes(job.walBytes ?? 0)}</p>
              <p class="text-muted-foreground text-xs tabular-nums">{(job.walSegments ?? 0).toLocaleString()} segment{(job.walSegments ?? 0) === 1 ? '' : 's'}</p>
            </div>
            <div class="corner-accent p-3 min-w-0">
              <p class="text-label-foreground text-xs uppercase tracking-wide">Files{job.lastKnown ? ' (last known)' : ''}</p>
              <p class="text-2xl font-semibold tabular-nums">{(job.fileCount ?? 0).toLocaleString()}</p>
              {#if job.currentPath}
                <p class="text-muted-foreground text-xs truncate" title={job.currentPath}>{sinkFileBasename(job.currentPath)}</p>
              {:else}
                <p class="text-muted-foreground text-xs">no file yet</p>
              {/if}
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4 max-w-3xl mt-4">
            {#each detailGroups as group (group.title)}
              <div class="grid gap-1 min-w-0">
                <p class="text-label-foreground text-xs font-semibold uppercase tracking-wide">{group.title}</p>
                <Table containerLabel={group.title} class="w-full">
                  <TableBody>
                    {#each group.rows as row (row.label)}
                      <TableRow>
                        <TableCell class="text-label-foreground text-xs uppercase tracking-wide">{row.label}</TableCell>
                        <TableCell class="text-right tabular-nums {row.tone}">{row.value}</TableCell>
                      </TableRow>
                    {/each}
                  </TableBody>
                </Table>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {:else}
      <div class="surface relative">
        <div class="tech-grid absolute inset-6 pointer-events-none" aria-hidden="true"></div>
        <div class="relative grid content-center justify-items-center gap-3 h-full px-7 py-10 text-center">
          <Radio size={28} aria-hidden="true" />
          <strong>No job selected</strong>
          {#if appState.jobPanelCollapsed.sink}
            <!-- The panel's own "New sink" button is inert/hidden while
                 collapsed (JobPanel.svelte), so this is the only reachable
                 CTA until it's expanded again. -->
            <p>The job panel is collapsed. Expand it to pick a job, or start a new one below.</p>
            <Button type="button" variant="primary" class="cyberpunk-skewed-sm" onclick={enterSinkCreate}>
              <Plus size={16} aria-hidden="true" />
              New sink
            </Button>
          {:else}
            <!-- No "New sink" button here: the panel's own CTA is visible
                 right above this same empty state, so a second identical one
                 on screen at once would be pure duplication. -->
            <p>Pick a job on the {panelSide} to see its health and details.</p>
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}
