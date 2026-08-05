<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildSinkRemoveArgv, cancelSinkRemove, confirmSinkRemove } from '$lib/app-state.svelte'

  const job = $derived(appState.sinkRemovePromptFor)
  const commandText = $derived(job ? `mountos ${buildSinkRemoveArgv(job.jobId).join(' ')}` : '')
</script>

<Dialog.Root bind:open={() => appState.sinkRemovePromptFor !== null, (open) => { if (!open) cancelSinkRemove() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    <form onsubmit={(event) => { event.preventDefault(); void confirmSinkRemove() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Remove ingest job</Dialog.Title>
      </Dialog.Header>
      {#if job}
        <div class="grid gap-4 py-4">
          <p>Permanently removes <strong>{job.name}</strong>'s local record, whatever its state.</p>
          <Callout>This deletes the job's local record (job.json, wal/, pid), not recoverable. Recorded media already committed to the destination is not touched. Use this to clear a job stuck resumable because its process was killed before it could finish -- cancel and prune can't touch that case.</Callout>
          {#if appState.sinkRemoveError}
            <CliErrorOutput role="alert" text={appState.sinkRemoveError} command={commandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={commandText}>
            <code>{commandText}</code>
          </CommandPreview>
        </div>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelSinkRemove}>Cancel</Button>
        <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy}>Remove</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
