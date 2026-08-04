<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildForkRestoreArgv, cancelForkRestore, computed, confirmForkRestore } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile)
</script>

<Dialog.Root bind:open={() => appState.forkRestorePromptFor !== null, (open) => { if (!open) cancelForkRestore() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.forkRestorePromptFor && profile}
      <form onsubmit={(event) => { event.preventDefault(); void confirmForkRestore() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><RotateCcw size={20} aria-hidden="true" /> Restore fork</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p class="wrap-anywhere">Restores fork "{appState.forkRestorePromptFor.name}" within its grace period.</p>
          {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
            <div class="grid gap-1.5">
              <Label for="fork-restore-secret">Secret access key</Label>
              <Input id="fork-restore-secret" type="password" bind:value={appState.forkRestoreSecretValue} autocomplete="current-password" />
            </div>
          {/if}
          {#if appState.forkRestoreError}
            <CliErrorOutput
              role="alert"
              text={appState.forkRestoreError}
              command={`mountos ${buildForkRestoreArgv(profile, appState.forkRestorePromptFor.name).join(' ')}`}
            />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={`mountos ${buildForkRestoreArgv(profile, appState.forkRestorePromptFor.name).join(' ')}`}>
            <code>{`mountos ${buildForkRestoreArgv(profile, appState.forkRestorePromptFor.name).join(' ')}`}</code>
          </CommandPreview>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelForkRestore}>Cancel</Button>
          <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.forkBusy}>Restore</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
