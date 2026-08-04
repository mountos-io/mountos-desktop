<script lang="ts">
  import { ChevronLeft, FolderOpen, Recycle } from '@lucide/svelte'
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
    browseDeletedDestination,
    buildDeletedArgv,
    confirmDeletedView,
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
    `mountos ${buildDeletedArgv(profile, appState.deletedDestination || '<destination>', computed.deletedFromValue, appState.deletedIdleTimeout).join(' ')}`,
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

  <h3 class="flex items-center gap-2 wrap-anywhere"><Recycle size={19} aria-hidden="true" /> {profile.name}: deleted files</h3>

  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmDeletedView() }}>
    <p class="max-w-[70ch] wrap-anywhere">Mounts a flat, read-only listing of deleted files from this profile's volume ("{profile.volume || profile.name}") at a folder you choose. It appears as its own row once ready.</p>
    <div class="grid gap-1.5">
      <Label>Destination folder (optional)</Label>
      <div class="flex gap-2">
        <Input value={appState.deletedDestination} readonly placeholder="Auto-generated in a temp folder" class="flex-1" />
        <Button type="button" onclick={browseDeletedDestination} disabled={appState.busy} title="Choose a folder" class="shrink-0">
          <FolderOpen size={16} aria-hidden="true" />
          Browse
        </Button>
      </div>
    </div>
    <div class="grid gap-1.5">
      <Label for="deleted-from">From (optional, defaults to 7 days)</Label>
      <div class="flex gap-1.5" role="group" aria-label="From mode">
        <Button type="button" size="sm" variant={appState.deletedFromMode === 'default' ? 'primary' : 'outline'} onclick={() => (appState.deletedFromMode = 'default')}>Default</Button>
        <Button type="button" size="sm" variant={appState.deletedFromMode === 'absolute' ? 'primary' : 'outline'} onclick={() => (appState.deletedFromMode = 'absolute')}>Absolute</Button>
        <Button type="button" size="sm" variant={appState.deletedFromMode === 'relative' ? 'primary' : 'outline'} onclick={() => (appState.deletedFromMode = 'relative')}>Relative</Button>
      </div>
      {#if appState.deletedFromMode === 'absolute'}
        <DateTimePicker id="deleted-from" bind:value={appState.deletedFromAbsoluteValue} />
      {:else if appState.deletedFromMode === 'relative'}
        <div class="flex gap-2">
          <Input id="deleted-from" type="number" min="1" bind:value={appState.deletedFromRelativeQty} placeholder="e.g. 7" class="flex-1" />
          <Select options={relativeUnitOptions} bind:value={appState.deletedFromRelativeUnit} class="shrink-0 w-40" />
        </div>
      {/if}
    </div>
    <div class="grid gap-1.5">
      <Label for="deleted-idle-timeout">Idle timeout (optional)</Label>
      <Input id="deleted-idle-timeout" bind:value={appState.deletedIdleTimeout} placeholder="30m" />
    </div>
    {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
      <div class="grid gap-1.5">
        <Label for="deleted-secret">Secret access key</Label>
        <Input id="deleted-secret" type="password" bind:value={appState.deletedSecretValue} autocomplete="current-password" />
      </div>
    {/if}
    {#if appState.deletedError}
      <CliErrorOutput role="alert" text={appState.deletedError} command={commandText} />
    {/if}
    <CommandPreview label="COMMAND PREVIEW" text={commandText}>
      <code>{commandText}</code>
    </CommandPreview>
    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={exitProfileSubView}>Cancel</Button>
      <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy}>Open</Button>
    </div>
  </form>
</section>
