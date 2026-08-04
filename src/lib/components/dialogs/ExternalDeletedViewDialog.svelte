<script lang="ts">
  import { FolderOpen, Recycle } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Select } from '$lib/components/ui/select'
  import DateTimePicker from '$lib/components/shared/DateTimePicker.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import {
    appState,
    browseExternalDeletedDestination,
    cancelExternalDeletedView,
    computed,
    confirmExternalDeletedView,
  } from '$lib/app-state.svelte'

  const relativeUnitOptions = [
    { value: 'm', label: 'minutes ago' },
    { value: 'h', label: 'hours ago' },
    { value: 'd', label: 'days ago' },
  ]
</script>

<Dialog.Root bind:open={() => appState.externalDeletedPromptFor !== null, (open) => { if (!open) cancelExternalDeletedView() }}>
  <Dialog.Content class="sm:max-w-2xl" aria-describedby={undefined}>
    {#if appState.externalDeletedPromptFor}
      <form onsubmit={(event) => { event.preventDefault(); void confirmExternalDeletedView() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><Recycle size={20} aria-hidden="true" /> Open deleted-files view</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p class="wrap-anywhere">
            Mounts a flat, read-only listing of deleted files from "{appState.externalDeletedPromptFor.name || 'this mount'}" at a folder you choose. It
            appears as its own row once ready. This mount has no saved profile, so credentials are re-read from its own live configuration.
          </p>
          <div class="grid gap-1.5">
            <Label>Destination folder (optional)</Label>
            <div class="flex gap-2">
              <Input value={appState.externalDeletedDestination} readonly placeholder="Auto-generated in a temp folder" class="flex-1" />
              <Button type="button" onclick={browseExternalDeletedDestination} disabled={appState.busy} title="Choose a folder" class="shrink-0">
                <FolderOpen size={16} aria-hidden="true" />
                Browse
              </Button>
            </div>
          </div>
          <div class="grid gap-1.5">
            <Label for="external-deleted-from">From (optional, defaults to 7 days)</Label>
            <div class="flex gap-1.5" role="group" aria-label="From mode">
              <Button type="button" size="sm" variant={appState.externalDeletedFromMode === 'default' ? 'primary' : 'outline'} onclick={() => (appState.externalDeletedFromMode = 'default')}>Default</Button>
              <Button type="button" size="sm" variant={appState.externalDeletedFromMode === 'absolute' ? 'primary' : 'outline'} onclick={() => (appState.externalDeletedFromMode = 'absolute')}>Absolute</Button>
              <Button type="button" size="sm" variant={appState.externalDeletedFromMode === 'relative' ? 'primary' : 'outline'} onclick={() => (appState.externalDeletedFromMode = 'relative')}>Relative</Button>
            </div>
            {#if appState.externalDeletedFromMode === 'absolute'}
              <DateTimePicker id="external-deleted-from" bind:value={appState.externalDeletedFromAbsoluteValue} />
            {:else if appState.externalDeletedFromMode === 'relative'}
              <div class="flex gap-2">
                <Input id="external-deleted-from" type="number" min="1" bind:value={appState.externalDeletedFromRelativeQty} placeholder="e.g. 7" class="flex-1" />
                <Select options={relativeUnitOptions} bind:value={appState.externalDeletedFromRelativeUnit} class="shrink-0 w-40" />
              </div>
            {/if}
          </div>
          <div class="grid gap-1.5">
            <Label for="external-deleted-idle-timeout">Idle timeout (optional)</Label>
            <Input id="external-deleted-idle-timeout" bind:value={appState.externalDeletedIdleTimeout} placeholder="30m" />
          </div>
          {#if computed.externalDeletedNeedsSecret}
            <div class="grid gap-1.5">
              <Label for="external-deleted-secret">Secret access key</Label>
              <Input id="external-deleted-secret" type="password" bind:value={appState.externalDeletedSecretValue} autocomplete="current-password" />
            </div>
          {/if}
          {#if appState.externalDeletedError}
            <CliErrorOutput role="alert" text={appState.externalDeletedError} command={computed.externalDeletedCommandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={computed.externalDeletedCommandText}>
            <code>{computed.externalDeletedCommandText}</code>
          </CommandPreview>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelExternalDeletedView}>Cancel</Button>
          <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy}>Open</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
