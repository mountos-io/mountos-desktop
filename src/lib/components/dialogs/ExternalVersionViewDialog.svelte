<script lang="ts">
  import { FolderOpen, History, X } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Select } from '$lib/components/ui/select'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import {
    appState,
    browseExternalVersionDestination,
    browseExternalVersionFile,
    cancelExternalVersionView,
    computed,
    confirmExternalVersionView,
  } from '$lib/app-state.svelte'

  const versionFormatOptions = [
    { value: 'number', label: 'number (v1, v2, ...)' },
    { value: 'date', label: 'date' },
  ]

  const canSubmit = $derived(Boolean(appState.externalVersionPath.trim()) || /^\d+$/.test(appState.externalVersionInode.trim()))
</script>

<Dialog.Root bind:open={() => appState.externalVersionPromptFor !== null, (open) => { if (!open) cancelExternalVersionView() }}>
  <Dialog.Content class="sm:max-w-2xl" aria-describedby={undefined}>
    {#if appState.externalVersionPromptFor}
      <form onsubmit={(event) => { event.preventDefault(); void confirmExternalVersionView() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><History size={20} aria-hidden="true" /> Open file-version view</Dialog.Title>
        </Dialog.Header>
        <div class="grid gap-4 py-4">
          <p class="wrap-anywhere">
            Mounts a read-only timeline of every version of one file from "{appState.externalVersionPromptFor.name || 'this mount'}" at a folder you
            choose. It appears as its own row once ready. This mount has no saved profile, so credentials are re-read from its own live configuration.
          </p>

          <div class="grid gap-1.5">
            <Label>File</Label>
            <div class="flex gap-2">
              <Input value={appState.externalVersionPath} readonly placeholder="Browse to a file..." class="flex-1" />
              {#if appState.externalVersionPath}
                <Button type="button" variant="outline" onclick={() => { appState.externalVersionPath = '' }} disabled={appState.busy} title="Clear, to enter an inode instead" class="shrink-0">
                  <X size={16} aria-hidden="true" />
                </Button>
              {:else}
                <Button type="button" onclick={() => appState.externalVersionPromptFor && browseExternalVersionFile(appState.externalVersionPromptFor)} disabled={appState.busy} title="Choose a file" class="shrink-0">
                  <FolderOpen size={16} aria-hidden="true" />
                  Browse
                </Button>
              {/if}
            </div>
          </div>

          <Checkbox bind:checked={appState.externalVersionFullChain} label="Full chain (also follow this file across past moves)" />

          <details class="text-sm">
            <summary class="cursor-pointer select-none text-muted-foreground">Advanced: enter an inode number instead</summary>
            <div class="grid gap-1.5 pt-2">
              <span class="inline-flex items-center gap-1"><Label for="external-version-inode">Inode number</Label><InfoTip text="**ls -i** shows a file's inode. Bypasses Browse; only a plain by-inode lookup (no multi-key discovery)." /></span>
              <Input id="external-version-inode" bind:value={appState.externalVersionInode} inputmode="numeric" placeholder="12345" disabled={Boolean(appState.externalVersionPath)} />
            </div>
          </details>

          <div class="grid gap-1.5">
            <Label>Destination folder (optional)</Label>
            <div class="flex gap-2">
              <Input value={appState.externalVersionDestination} readonly placeholder="Auto-generated in a temp folder" class="flex-1" />
              <Button type="button" onclick={browseExternalVersionDestination} disabled={appState.busy} title="Choose a folder" class="shrink-0">
                <FolderOpen size={16} aria-hidden="true" />
                Browse
              </Button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div class="grid gap-1.5">
              <Label id="external-version-format-label">Version naming</Label>
              <Select options={versionFormatOptions} bind:value={appState.externalVersionFormat} ariaLabelledby="external-version-format-label" />
            </div>
            <div class="grid gap-1.5">
              <Label for="external-version-idle-timeout">Idle timeout (optional)</Label>
              <Input id="external-version-idle-timeout" bind:value={appState.externalVersionIdleTimeout} placeholder="30m" />
            </div>
          </div>
          {#if computed.externalVersionNeedsSecret}
            <div class="grid gap-1.5">
              <Label for="external-version-secret">Secret access key</Label>
              <Input id="external-version-secret" type="password" bind:value={appState.externalVersionSecretValue} autocomplete="current-password" />
            </div>
          {/if}
          {#if appState.externalVersionError}
            <CliErrorOutput role="alert" text={appState.externalVersionError} command={computed.externalVersionCommandText} />
          {/if}
          <CommandPreview label="COMMAND PREVIEW" text={computed.externalVersionCommandText}>
            <code>{computed.externalVersionCommandText}</code>
          </CommandPreview>
        </div>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelExternalVersionView}>Cancel</Button>
          <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy || !canSubmit}>Open</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
