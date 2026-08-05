<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildUploadRemoveArgv, cancelUploadRemove, confirmUploadRemove } from '$lib/app-state.svelte'

  const job = $derived(appState.uploadRemovePromptFor)
  const commandText = $derived(job ? `mountos ${buildUploadRemoveArgv(job.jobId).join(' ')}` : '')
</script>

<Dialog.Root bind:open={() => appState.uploadRemovePromptFor !== null, (open) => { if (!open) cancelUploadRemove() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    <form onsubmit={(event) => { event.preventDefault(); void confirmUploadRemove() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Remove upload job</Dialog.Title>
      </Dialog.Header>
      {#if job}
        <div class="grid gap-4 py-4">
          <p>Permanently removes <strong>{job.name}</strong>'s local record, whatever its state.</p>
          <Callout>This deletes the job's local record (job.json, scan.db, pid), not recoverable. Files already uploaded are not touched. Use this to clear a job stuck resumable because its process was killed before it could finish -- cancel and prune can't touch that case.</Callout>
          {#if appState.uploadRemoveError}
            <CliErrorOutput role="alert" text={appState.uploadRemoveError} command={commandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={commandText}>
            <code>{commandText}</code>
          </CommandPreview>
        </div>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelUploadRemove}>Cancel</Button>
        <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy}>Remove</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
