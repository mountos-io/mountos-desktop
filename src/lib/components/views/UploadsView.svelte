<script lang="ts">
  import { FolderOpen, ListChecks, OctagonX, RefreshCw, RotateCcw, Trash2, Upload } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Select } from '$lib/components/ui/select'
  import { Badge, type BadgeVariant } from '$lib/components/ui/badge'
  import * as Table from '$lib/components/ui/table'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseUploadSource,
    buildUploadStartArgv,
    computed,
    requestUploadPrune,
    requestUploadResume,
    runUploadCancel,
    runUploadList,
    runUploadRetryFailed,
    runUploadStart,
    uploadStartParams,
  } from '$lib/app-state.svelte'
  import type { UploadJob } from '$lib/types'

  const profileOptions = $derived(appState.profiles.map((p) => ({ value: p.id, label: p.name })))
  const profile = $derived(computed.selectedProfile)

  const uploadCommandText = $derived(
    profile && appState.uploadSource.trim() && appState.uploadDest.trim()
      ? `mountos ${buildUploadStartArgv(profile, appState.uploadSource.trim(), appState.uploadDest.trim(), uploadStartParams()).join(' ')}`
      : '',
  )

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
    resumable: 'warning',
  }

  function countsSummary(job: UploadJob): string {
    const parts = Object.entries(job.counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`)
    return parts.length ? parts.join(', ') : 'no entries yet'
  }
</script>

<section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
  <div class="flex items-center justify-between gap-4">
    <h3 class="flex items-center gap-2"><Upload size={19} aria-hidden="true" /> Uploads</h3>
    <div class="flex items-center gap-2">
      <Button type="button" size="icon" variant="ghost" onclick={runUploadList} disabled={appState.uploadsBusy} title="Refresh job list" aria-label="Refresh job list">
        <RefreshCw size={15} aria-hidden="true" />
      </Button>
      <Button type="button" size="sm" variant="outline" onclick={requestUploadPrune} disabled={appState.uploadsBusy}>
        <Trash2 size={15} aria-hidden="true" />
        Prune
      </Button>
    </div>
  </div>

  {#if appState.profiles.length === 0}
    <div class="tech-grid p-7 text-center">
      <p>Add a profile first -- an upload needs a discovery URL and credentials to connect against.</p>
    </div>
  {:else}
    <div class="grid gap-1.5 max-w-sm">
      <Label id="upload-profile-label" for="upload-profile">Profile</Label>
      <Select
        id="upload-profile"
        options={profileOptions}
        bind:value={() => appState.selectedProfileId ?? '', (value) => (appState.selectedProfileId = value)}
        ariaLabelledby="upload-profile-label"
      />
    </div>

    <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void runUploadStart() }}>
      <div class="grid gap-1.5">
        <Label for="upload-source">Source folder</Label>
        <div class="flex gap-2">
          <Input id="upload-source" bind:value={appState.uploadSource} placeholder="/local/photos" class="flex-1" />
          <Button type="button" onclick={browseUploadSource} disabled={appState.uploadsBusy} class="shrink-0">
            <FolderOpen size={16} aria-hidden="true" /> Browse
          </Button>
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for="upload-dest">Destination path</Label>
        <Input id="upload-dest" bind:value={appState.uploadDest} placeholder="/photos" />
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="grid gap-1.5">
          <Label for="upload-fork">Fork (optional)</Label>
          <Input id="upload-fork" bind:value={appState.uploadFork} placeholder="main" />
        </div>
        <div class="grid gap-1.5">
          <Label for="upload-rescan-interval">Rescan interval (optional)</Label>
          <Input id="upload-rescan-interval" bind:value={appState.uploadRescanInterval} placeholder="30s" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="grid gap-1.5">
          <Label for="upload-bwlimit">Bandwidth limit, Mbps (optional)</Label>
          <Input id="upload-bwlimit" type="number" min="0" bind:value={appState.uploadBwlimit} placeholder="0 (unlimited)" />
        </div>
      </div>
      <div class="flex flex-wrap gap-4">
        <Checkbox bind:checked={appState.uploadOnce} label="Settle and exit (--once)" />
        <Checkbox bind:checked={appState.uploadOverwrite} label="Re-upload changed files (--overwrite)" />
        <Checkbox bind:checked={appState.uploadDryRun} label="Dry run (report only)" />
        <Checkbox bind:checked={appState.uploadRestart} label="Force a fresh job (--restart)" />
        <Checkbox bind:checked={appState.uploadFollowSymlinks} label="Follow symlinks" />
        <Checkbox bind:checked={appState.uploadCreateSourceDirectory} label="Nest under source folder name" />
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="grid gap-1.5">
          <Label for="upload-include">Include globs (one per line, optional)</Label>
          <Textarea id="upload-include" bind:value={appState.uploadIncludeText} rows={3} placeholder="*.jpg" />
        </div>
        <div class="grid gap-1.5">
          <Label for="upload-exclude">Exclude globs (one per line, optional)</Label>
          <Textarea id="upload-exclude" bind:value={appState.uploadExcludeText} rows={3} placeholder="*.tmp" />
        </div>
      </div>
      {#if profile && (profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id])}
        <div class="grid gap-1.5 max-w-sm">
          <Label for="upload-start-secret">Secret access key</Label>
          <Input id="upload-start-secret" type="password" bind:value={appState.uploadStartSecretValue} autocomplete="current-password" />
        </div>
      {/if}
      {#if appState.uploadStartError}
        <CliErrorOutput role="alert" text={appState.uploadStartError} command={uploadCommandText} />
      {/if}
      {#if appState.uploadDryRunReport}
        <div class="grid gap-1.5">
          <Label>Dry run report</Label>
          <pre class="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border p-2.5 font-mono text-xs">{appState.uploadDryRunReport}</pre>
        </div>
      {/if}
      <CommandPreview label="COMMAND PREVIEW" text={uploadCommandText}>
        <code>{uploadCommandText}</code>
      </CommandPreview>
      <div class="flex justify-end gap-2">
        <Button
          type="submit"
          variant="primary"
          class="cyberpunk-skewed-sm"
          disabled={appState.uploadsBusy || !profile || !appState.uploadSource.trim() || !appState.uploadDest.trim()}
        >
          {appState.uploadDryRun ? 'Run dry run' : 'Start upload'}
        </Button>
      </div>
    </form>
  {/if}

  {#if appState.uploadsError}
    <p class="text-destructive text-sm" role="alert">{appState.uploadsError}</p>
  {/if}

  <div class="grid gap-2">
    {#if appState.uploadsBusy && appState.uploads.length === 0}
      <p class="text-muted-foreground text-sm">Loading upload jobs...</p>
    {:else if appState.uploads.length === 0}
      <div class="tech-grid p-7 text-center">
        <p>No upload jobs yet.</p>
      </div>
    {:else}
      <Table.Root containerLabel="Upload jobs">
        <Table.Header>
          <Table.Row>
            <Table.Head class="th-cyber">Job</Table.Head>
            <Table.Head class="th-cyber">Source -&gt; dest</Table.Head>
            <Table.Head class="th-cyber">Fork</Table.Head>
            <Table.Head class="th-cyber">State</Table.Head>
            <Table.Head class="th-cyber">Progress</Table.Head>
            <Table.Head class="th-cyber">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each appState.uploads as job (job.jobId)}
            <Table.Row>
              <Table.Cell><code class="text-xs">{job.jobId}</code></Table.Cell>
              <Table.Cell>
                <div class="truncate max-w-[28ch]" title={job.sourcePath}>{job.sourcePath ?? 'source profile'}</div>
                <div class="truncate max-w-[28ch] text-muted-foreground text-sm" title={job.destPath}>-&gt; {job.destPath}</div>
              </Table.Cell>
              <Table.Cell>{job.forkName || 'main'}</Table.Cell>
              <Table.Cell>
                <Badge variant={stateBadgeVariant[job.state] ?? 'default'}>{job.state}</Badge>
                {#if job.haltReason}
                  <div class="text-destructive text-sm mt-1" title={job.haltReason}>{job.haltReason}</div>
                {/if}
              </Table.Cell>
              <Table.Cell><span class="text-sm">{countsSummary(job)}</span></Table.Cell>
              <Table.Cell>
                <div class="flex items-center gap-1 shrink-0">
                  {#if job.state === 'running'}
                    <Button type="button" size="icon" variant="destructive" title="Cancel upload" aria-label="Cancel upload" disabled={appState.uploadsBusy} onclick={() => runUploadCancel(job)}>
                      <OctagonX size={15} aria-hidden="true" />
                    </Button>
                  {:else}
                    <Button type="button" size="icon" variant="outline" title="Resume upload" aria-label="Resume upload" disabled={appState.uploadsBusy} onclick={() => requestUploadResume(job)}>
                      <RotateCcw size={15} aria-hidden="true" />
                    </Button>
                  {/if}
                  {#if job.counts.failed}
                    <Button type="button" size="icon" variant="outline" title="Retry failed paths" aria-label="Retry failed paths" disabled={appState.uploadsBusy} onclick={() => runUploadRetryFailed(job)}>
                      <ListChecks size={15} aria-hidden="true" />
                    </Button>
                  {/if}
                </div>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </div>
</section>
