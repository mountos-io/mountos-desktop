<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildDownloadRemoveArgv, cancelDownloadRemove, confirmDownloadRemove } from '$lib/app-state.svelte'

  const job = $derived(appState.downloadRemovePromptFor)
  const commandText = $derived(job ? `mountos ${buildDownloadRemoveArgv(job.jobId).join(' ')}` : '')
</script>

<Dialog.Root bind:open={() => appState.downloadRemovePromptFor !== null, (open) => { if (!open) cancelDownloadRemove() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    <form onsubmit={(event) => { event.preventDefault(); void confirmDownloadRemove() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Remove download job</Dialog.Title>
      </Dialog.Header>
      {#if job}
        <div class="grid gap-4 py-4">
          <p>Permanently removes <strong>{job.name}</strong>'s local record, whatever its state.</p>
          <Callout>This deletes the job's local record (job.json, scan.db, pid), not recoverable. Files already downloaded are not touched. Use this to clear a job stuck resumable because its process was killed before it could finish -- cancel and prune can't touch that case.</Callout>
          {#if appState.downloadRemoveError}
            <CliErrorOutput role="alert" text={appState.downloadRemoveError} command={commandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={commandText}>
            <code>{commandText}</code>
          </CommandPreview>
        </div>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelDownloadRemove}>Cancel</Button>
        <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.downloadsBusy}>Remove</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
