<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildUploadPruneArgv, cancelUploadPrune, confirmUploadPrune } from '$lib/app-state.svelte'

  const keep = $derived(Number.parseInt(appState.uploadPruneKeep, 10) || 0)
  const commandText = $derived(`mountos ${buildUploadPruneArgv(keep).join(' ')}`)
</script>

<Dialog.Root bind:open={() => appState.uploadPrunePromptOpen, (open) => { if (!open) cancelUploadPrune() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    <form onsubmit={(event) => { event.preventDefault(); void confirmUploadPrune() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Prune upload jobs</Dialog.Title>
      </Dialog.Header>
      <div class="grid gap-4 py-4">
        <p>Permanently removes completed/halted job records (never a currently running job).</p>
        <Callout>This deletes the job's local record (job.json, scan.db, pid), not recoverable, unlike cancel.</Callout>
        <div class="grid gap-1.5 max-w-[10rem]">
          <Label for="upload-prune-keep">Keep N most recent</Label>
          <Input id="upload-prune-keep" type="number" min="0" bind:value={appState.uploadPruneKeep} />
        </div>
        {#if appState.uploadPruneError}
          <CliErrorOutput role="alert" text={appState.uploadPruneError} command={commandText} />
        {/if}
        <CommandPreview label="COMMAND PREVIEW" text={commandText}>
          <code>{commandText}</code>
        </CommandPreview>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelUploadPrune}>Cancel</Button>
        <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy}>Prune</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
