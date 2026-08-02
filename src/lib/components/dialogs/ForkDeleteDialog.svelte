<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildForkDeleteArgv, cancelForkDelete, computed, confirmForkDelete } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile)
</script>

<Dialog.Root bind:open={() => appState.forkDeletePromptFor !== null, (open) => { if (!open) cancelForkDelete() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.forkDeletePromptFor && profile}
      <form onsubmit={(event) => { event.preventDefault(); void confirmForkDelete() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Delete fork</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p>Deletes fork "{appState.forkDeletePromptFor.name}", recoverable within its grace period.</p>
          <Callout>Acts on the shared volume, not just this profile. Every other mount of the volume sees this fork disappear too.</Callout>
          {#if appState.settings.allowForkForceDelete}
            <Checkbox bind:checked={appState.forkDeleteForce} label="Also delete subtree (--force)" />
          {/if}
          {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
            <div class="grid gap-1.5">
              <Label for="fork-delete-secret">Secret access key</Label>
              <Input id="fork-delete-secret" type="password" bind:value={appState.forkDeleteSecretValue} autocomplete="current-password" />
            </div>
          {/if}
          {#if appState.forkDeleteError}
            <CliErrorOutput
              role="alert"
              text={appState.forkDeleteError}
              command={`mountos ${buildForkDeleteArgv(profile, appState.forkDeletePromptFor.name, appState.forkDeleteForce).join(' ')}`}
            />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={`mountos ${buildForkDeleteArgv(profile, appState.forkDeletePromptFor.name, appState.forkDeleteForce).join(' ')}`}>
            <code>{`mountos ${buildForkDeleteArgv(profile, appState.forkDeletePromptFor.name, appState.forkDeleteForce).join(' ')}`}</code>
          </CommandPreview>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelForkDelete}>Cancel</Button>
          <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.forkBusy}>Delete</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
