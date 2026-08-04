<script lang="ts">
  import { Unplug } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import Callout from '$lib/components/Callout.svelte'
  import { appState, cancelUnmountPrompt, confirmUnmountPrompt } from '$lib/app-state.svelte'
</script>

<Dialog.Root bind:open={() => appState.unmountPromptFor !== null, (open) => { if (!open) cancelUnmountPrompt() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.unmountPromptFor}
      <form onsubmit={(event) => { event.preventDefault(); void confirmUnmountPrompt() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2">
            <Unplug size={20} aria-hidden="true" />
            {appState.unmountPromptFor === 'all' ? 'Unmount all mounts' : 'Unmount'}
          </Dialog.Title>
        </Dialog.Header>
        {#if appState.unmountPromptFor === 'all'}
          <p class="py-4">Unmount all {appState.systemState.instances.length} running mounts?</p>
        {:else}
          <p class="py-4 wrap-anywhere">Unmount "{appState.unmountPromptFor.name || appState.unmountPromptFor.mountPath}"?</p>
        {/if}
        {#if appState.settings.allowUnmountForce}
          <div class="grid gap-4 pb-4">
            <Checkbox bind:checked={appState.unmountPromptForce} label="Unmount anyway (--force)" />
            {#if appState.unmountPromptForce}
              <Callout>Disconnects whatever is still using this mount. Apps reading or writing files there will get an error and lose unsaved work.</Callout>
            {/if}
          </div>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelUnmountPrompt}>Cancel</Button>
          <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.busy}>Unmount</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
