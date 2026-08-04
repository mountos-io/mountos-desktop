<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { appState, cancelDelete, confirmDelete } from '$lib/app-state.svelte'
</script>

<Dialog.Root bind:open={() => appState.deletePromptFor !== null, (open) => { if (!open) cancelDelete() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.deletePromptFor}
      <form onsubmit={(event) => { event.preventDefault(); void confirmDelete() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Delete profile</Dialog.Title>
        </Dialog.Header>
        <p class="py-4 wrap-anywhere">Deletes "{appState.deletePromptFor.name}" and its vaulted secret. Running mounts are not affected.</p>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelDelete}>Cancel</Button>
          <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.busy}>Delete</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
