<script lang="ts">
  import { BookmarkPlus } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildSinkMarkArgv, cancelSinkMark, confirmSinkMark } from '$lib/app-state.svelte'

  const job = $derived(appState.sinkMarkPromptFor)
  const commandText = $derived(
    job ? `mountos ${buildSinkMarkArgv(job.jobId, appState.sinkMarkLabel.trim(), appState.sinkMarkDuration.trim()).join(' ')}` : '',
  )
</script>

<Dialog.Root bind:open={() => appState.sinkMarkPromptFor !== null, (open) => { if (!open) cancelSinkMark() }}>
  <!-- Focus the label field, not the first focusable element: that is the
       label's info button, and focus opens its tooltip over the form. -->
  <Dialog.Content
    class="sm:max-w-md"
    aria-describedby={undefined}
    escapeKeydownBehavior={appState.sinkMarkBusy ? 'ignore' : 'close'}
    interactOutsideBehavior={appState.sinkMarkBusy ? 'ignore' : 'close'}
    onOpenAutoFocus={(event) => {
      event.preventDefault()
      document.getElementById('sink-mark-label')?.focus()
    }}
  >
    <form onsubmit={(event) => { event.preventDefault(); void confirmSinkMark() }}>
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><BookmarkPlus size={20} aria-hidden="true" /> Add mark</Dialog.Title>
      </Dialog.Header>
      {#if job}
        <div class="grid gap-4 py-4">
          <p>Records a mark at the current time in the playlist of <strong>{job.name || job.jobId}</strong>. Players and editors can seek to it.</p>
          <div class="grid gap-1.5">
            <span class="inline-flex items-center gap-1">
              <Label for="sink-mark-label">Label (optional)</Label>
              <InfoTip text="A short name for the mark (`--label`). Do not use double quotes or control characters such as line breaks or tabs." />
            </span>
            <Input id="sink-mark-label" bind:value={appState.sinkMarkLabel} placeholder="goal" autocomplete="off" />
          </div>
          <div class="grid gap-1.5 max-w-[14rem]">
            <span class="inline-flex items-center gap-1">
              <Label for="sink-mark-duration">Duration (optional)</Label>
              <InfoTip text="The length of the marked range (`--duration`), e.g. `30s` or `1m30s`.

Default: a single point in time." />
            </span>
            <Input id="sink-mark-duration" bind:value={appState.sinkMarkDuration} placeholder="30s" autocomplete="off" />
          </div>
          {#if appState.sinkMarkError}
            <CliErrorOutput role="alert" text={appState.sinkMarkError} command={commandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={commandText}>
            <code>{commandText}</code>
          </CommandPreview>
        </div>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={cancelSinkMark} disabled={appState.sinkMarkBusy}>Cancel</Button>
        <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.sinkMarkBusy}>Add mark</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
