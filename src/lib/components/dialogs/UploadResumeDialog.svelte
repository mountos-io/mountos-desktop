<script lang="ts">
  import { RefreshCw } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildUploadResumeArgv, cancelUploadResume, computed, confirmUploadResume } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile)
  const job = $derived(appState.uploadResumePromptFor)

  const commandText = $derived(
    job && profile
      ? `mountos ${buildUploadResumeArgv(profile, job.jobId, appState.uploadResumeOnce, appState.uploadResumeRescanInterval || undefined).join(' ')}`
      : '',
  )
</script>

<Dialog.Root bind:open={() => appState.uploadResumePromptFor !== null, (open) => { if (!open) cancelUploadResume() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if job && profile}
      <form onsubmit={(event) => { event.preventDefault(); void confirmUploadResume() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><RefreshCw size={20} aria-hidden="true" /> Resume upload</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p>Resumes job "{job.jobId}" ({job.sourcePath ?? 'source profile'} -&gt; {job.destPath}).</p>
          <div class="flex flex-wrap gap-4">
            <Checkbox bind:checked={appState.uploadResumeOnce} label="Settle and exit (--once)" />
          </div>
          <div class="grid gap-1.5">
            <Label for="upload-resume-rescan-interval">Rescan interval (optional)</Label>
            <Input id="upload-resume-rescan-interval" bind:value={appState.uploadResumeRescanInterval} placeholder="30s" />
          </div>
          {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
            <div class="grid gap-1.5">
              <Label for="upload-resume-secret">Secret access key</Label>
              <Input id="upload-resume-secret" type="password" bind:value={appState.uploadResumeSecretValue} autocomplete="current-password" />
            </div>
          {/if}
          {#if appState.uploadResumeError}
            <CliErrorOutput role="alert" text={appState.uploadResumeError} command={commandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={commandText}>
            <code>{commandText}</code>
          </CommandPreview>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelUploadResume}>Cancel</Button>
          <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.uploadsBusy}>Resume</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
