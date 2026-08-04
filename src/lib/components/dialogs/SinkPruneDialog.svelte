<script lang="ts">
  import { Trash2 } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import Callout from '$lib/components/Callout.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildSinkPruneArgv, cancelSinkPrune, confirmSinkPrune } from '$lib/app-state.svelte'

  const keep = $derived(Number.parseInt(appState.sinkPruneKeep, 10) || 0)
  const commandText = $derived(`mountos ${buildSinkPruneArgv(keep).join(' ')}`)
</script>

<Dialog.Root bind:open={() => appState.sinkPrunePromptOpen, (open) => { if (!open) cancelSinkPrune() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    <form onsubmit={(event) => { event.preventDefault(); void confirmSinkPrune() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><Trash2 size={20} aria-hidden="true" /> Prune ingest jobs</Dialog.Title>
      </Dialog.Header>
      <div class="grid gap-4 py-4">
        <p>Permanently removes completed/halted job records (never a currently running job).</p>
        <Callout>This deletes the job's local record (job.json, wal/, pid), not recoverable, unlike cancel. Recorded files already written to the destination are not touched.</Callout>
        <div class="grid gap-1.5 max-w-[10rem]">
          <Label for="sink-prune-keep">Keep N most recent</Label>
          <Input id="sink-prune-keep" type="number" min="0" bind:value={appState.sinkPruneKeep} />
        </div>
        {#if appState.sinkPruneError}
          <CliErrorOutput role="alert" text={appState.sinkPruneError} command={commandText} />
        {/if}
        <CommandPreview label="COMMAND PREVIEW" text={commandText}>
          <code>{commandText}</code>
        </CommandPreview>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelSinkPrune}>Cancel</Button>
        <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.sinksBusy}>Prune</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
