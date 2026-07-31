<script lang="ts">
  import { RefreshCw } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, buildUploadResumeArgv, cancelUploadResume, confirmUploadResume } from '$lib/app-state.svelte'
  import type { MountProfile } from '$lib/types'

  const job = $derived(appState.uploadResumePromptFor)

  // Resume works from discoveryUrl/accessKeyId alone -- see resumeUpload's
  // own comment -- not a saved profile, so this synthetic object exists
  // purely to feed the shared argv builder/command preview the same way
  // start/browse's own synthetic profiles do for their no-profile sources.
  const resumeProfile = $derived({
    id: 'resume',
    schemaVersion: 1,
    kind: 'mount',
    name: '',
    volume: '',
    fork: '',
    mountPath: '',
    discoveryUrl: appState.uploadResumeDiscoveryUrl.trim(),
    accessKeyId: appState.uploadResumeAccessKeyId.trim(),
    secretRef: 'prompt',
    backend: 'auto',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
  } satisfies MountProfile)

  const commandText = $derived(
    job
      ? `mountos ${buildUploadResumeArgv(resumeProfile, job.jobId, appState.uploadResumeOnce, appState.uploadResumeRescanInterval || undefined).join(' ')}`
      : '',
  )
</script>

<Dialog.Root bind:open={() => appState.uploadResumePromptFor !== null, (open) => { if (!open) cancelUploadResume() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if job}
      <form onsubmit={(event) => { event.preventDefault(); void confirmUploadResume() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><RefreshCw size={20} aria-hidden="true" /> Resume upload</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p>Resumes job "{job.jobId}" ({job.sourcePath ?? 'source profile'} -&gt; {job.destPath}).</p>
          <div class="grid gap-1.5">
            <Label for="upload-resume-discovery-url">Discovery URL</Label>
            <Input id="upload-resume-discovery-url" bind:value={appState.uploadResumeDiscoveryUrl} placeholder="https://discovery.example.com" />
          </div>
          <div class="grid gap-1.5">
            <Label for="upload-resume-access-key">Access key ID</Label>
            <Input id="upload-resume-access-key" bind:value={appState.uploadResumeAccessKeyId} />
          </div>
          <div class="flex flex-wrap gap-4">
            <Checkbox bind:checked={appState.uploadResumeOnce} label="Settle and exit (--once)" />
          </div>
          <div class="grid gap-1.5">
            <Label for="upload-resume-rescan-interval">Rescan interval (optional)</Label>
            <Input id="upload-resume-rescan-interval" bind:value={appState.uploadResumeRescanInterval} placeholder="30s" />
          </div>
          <div class="grid gap-1.5">
            <Label for="upload-resume-secret">Secret access key (optional)</Label>
            <Input id="upload-resume-secret" type="password" bind:value={appState.uploadResumeSecretValue} autocomplete="current-password" />
            <small class="text-muted-foreground text-sm">Leave blank to reuse a saved profile's cached secret for this access key ID, if one exists.</small>
          </div>
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
