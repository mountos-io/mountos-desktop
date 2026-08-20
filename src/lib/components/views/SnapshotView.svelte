<script lang="ts">
  import { Camera, ChevronLeft, FolderOpen } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Select } from '$lib/components/ui/select'
  import DateTimePicker from '$lib/components/shared/DateTimePicker.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseSnapshotDestination,
    buildSnapshotArgv,
    confirmSnapshotView,
    computed,
    exitProfileSubView,
  } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile!)

  const relativeUnitOptions = [
    { value: 'm', label: 'minutes ago' },
    { value: 'h', label: 'hours ago' },
    { value: 'd', label: 'days ago' },
  ]

  const commandText = $derived(
    `mountos ${buildSnapshotArgv(profile, appState.snapshotDestination || '<destination>', computed.snapshotTimestampValue || '<timestamp>').join(' ')}`,
  )
</script>

<section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
  <button
    type="button"
    class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    onclick={exitProfileSubView}
  >
    <ChevronLeft size={16} aria-hidden="true" /> Back to profile
  </button>

  <h3 class="flex items-center gap-2 wrap-anywhere"><Camera size={19} aria-hidden="true" /> {profile.name}: snapshot view</h3>

  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmSnapshotView() }}>
    <p class="max-w-[70ch] wrap-anywhere">Mounts a read-only, point-in-time view of this profile's volume ("{profile.volume || profile.name}") at a folder you choose. It appears as its own row once ready.</p>
    <div class="grid gap-1.5">
      <Label>Destination folder (optional)</Label>
      <div class="flex gap-2">
        <Input value={appState.snapshotDestination} readonly placeholder="Auto-generated in a temp folder" class="flex-1" />
        <Button type="button" onclick={browseSnapshotDestination} disabled={appState.busy} title="Choose a folder" class="shrink-0">
          <FolderOpen size={16} aria-hidden="true" />
          Browse
        </Button>
      </div>
    </div>
    <div class="grid gap-1.5">
      <Label for="snapshot-timestamp">Timestamp</Label>
      <div class="flex gap-1.5" role="group" aria-label="Timestamp mode">
        <Button type="button" size="sm" variant={appState.snapshotTimeMode === 'absolute' ? 'primary' : 'outline'} onclick={() => (appState.snapshotTimeMode = 'absolute')}>Absolute</Button>
        <Button type="button" size="sm" variant={appState.snapshotTimeMode === 'relative' ? 'primary' : 'outline'} onclick={() => (appState.snapshotTimeMode = 'relative')}>Relative</Button>
      </div>
      {#if appState.snapshotTimeMode === 'absolute'}
        <DateTimePicker id="snapshot-timestamp" bind:value={appState.snapshotAbsoluteValue} />
      {:else}
        <div class="flex gap-2">
          <Input id="snapshot-timestamp" type="number" min="1" bind:value={appState.snapshotRelativeQty} placeholder="e.g. 2" class="flex-1" />
          <Select options={relativeUnitOptions} bind:value={appState.snapshotRelativeUnit} class="shrink-0 w-40" />
        </div>
      {/if}
      {#if computed.snapshotAsOfError}
        <small class="text-destructive text-sm">{computed.snapshotAsOfError}</small>
      {/if}
    </div>
    {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
      <div class="grid gap-1.5">
        <Label for="snapshot-secret">Secret access key</Label>
        <Input id="snapshot-secret" type="password" bind:value={appState.snapshotSecretValue} autocomplete="current-password" />
      </div>
    {/if}
    {#if appState.snapshotError}
      <CliErrorOutput role="alert" text={appState.snapshotError} command={commandText} />
    {/if}
    <CommandPreview label="COMMAND PREVIEW" text={commandText}>
      <code>{commandText}</code>
    </CommandPreview>
    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={exitProfileSubView}>Cancel</Button>
      <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy || !computed.snapshotTimestampValue || !!computed.snapshotAsOfError}>Open</Button>
    </div>
  </form>
</section>
