<script lang="ts">
  import { ChevronLeft, FolderOpen, History, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Select } from '$lib/components/ui/select'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseVersionDestination,
    browseVersionFile,
    buildVersionArgv,
    confirmVersionView,
    computed,
    exitProfileSubView,
    mountAndBrowseVersionFile,
    primaryInstanceForProfile,
  } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile!)

  const versionFormatOptions = [
    { value: 'number', label: 'number (v1, v2, ...)' },
    { value: 'date', label: 'date' },
  ]

  const mountedInstance = $derived(primaryInstanceForProfile(profile.id))
  const selector = $derived(appState.versionPath.trim() ? { path: appState.versionPath.trim() } : { inode: appState.versionInode.trim() })
  const canSubmit = $derived(Boolean(appState.versionPath.trim()) || /^\d+$/.test(appState.versionInode.trim()))
  const commandText = $derived(
    `mountos ${buildVersionArgv(profile, appState.versionDestination || '<destination>', selector, appState.versionFormat, appState.versionIdleTimeout, appState.versionFullChain).join(' ')}`,
  )
</script>

<section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
  <button
    type="button"
    class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    onclick={exitProfileSubView}
  >
    <ChevronLeft size={16} aria-hidden="true" /> Back to profile
  </button>

  <h3 class="flex items-center gap-2 wrap-anywhere"><History size={19} aria-hidden="true" /> {profile.name}: file versions</h3>

  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmVersionView() }}>
    <p class="max-w-[70ch] wrap-anywhere">Mounts a read-only timeline of every version of one file from this profile's volume ("{profile.volume || profile.name}") at a folder you choose. It appears as its own row once ready.</p>

    <div class="grid gap-1.5">
      <Label>File</Label>
      <div class="flex gap-2">
        <Input value={appState.versionPath} readonly placeholder="Browse to a file..." class="flex-1" />
        {#if appState.versionPath}
          <Button type="button" variant="outline" onclick={() => { appState.versionPath = '' }} disabled={appState.busy} title="Clear, to enter an inode instead" class="shrink-0">
            <X size={16} aria-hidden="true" />
          </Button>
        {:else if mountedInstance}
          <Button type="button" onclick={() => browseVersionFile(profile)} disabled={appState.busy} title="Choose a file" class="shrink-0">
            <FolderOpen size={16} aria-hidden="true" />
            Browse
          </Button>
        {:else}
          <Button type="button" onclick={() => mountAndBrowseVersionFile(profile)} disabled={appState.busy} title="Mount this profile, then choose a file" class="shrink-0">
            <FolderOpen size={16} aria-hidden="true" />
            Mount &amp; Browse
          </Button>
        {/if}
      </div>
    </div>

    <Checkbox bind:checked={appState.versionFullChain} label="Full chain (also follow this file across past moves)" />

    <details class="text-sm">
      <summary class="cursor-pointer select-none text-muted-foreground">Advanced: enter an inode number instead</summary>
      <div class="grid gap-1.5 pt-2">
        <span class="inline-flex items-center gap-1"><Label for="version-inode">Inode number</Label><InfoTip text="**ls -i** shows a file's inode number. This skips Browse. mountOS looks up the file by inode number only." /></span>
        <Input id="version-inode" bind:value={appState.versionInode} inputmode="numeric" placeholder="12345" disabled={Boolean(appState.versionPath)} />
      </div>
    </details>

    <div class="grid gap-1.5">
      <Label>Destination folder (optional)</Label>
      <div class="flex gap-2">
        <Input value={appState.versionDestination} readonly placeholder="Auto-generated in a temp folder" class="flex-1" />
        <Button type="button" onclick={browseVersionDestination} disabled={appState.busy} title="Choose a folder" class="shrink-0">
          <FolderOpen size={16} aria-hidden="true" />
          Browse
        </Button>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <div class="grid gap-1.5">
        <Label id="version-format-label">Version naming</Label>
        <Select options={versionFormatOptions} bind:value={appState.versionFormat} ariaLabelledby="version-format-label" />
      </div>
      <div class="grid gap-1.5">
        <Label for="version-idle-timeout">Idle timeout (optional)</Label>
        <Input id="version-idle-timeout" bind:value={appState.versionIdleTimeout} placeholder="30m" />
      </div>
    </div>
    {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
      <div class="grid gap-1.5">
        <Label for="version-secret">Secret access key</Label>
        <Input id="version-secret" type="password" bind:value={appState.versionSecretValue} autocomplete="current-password" />
      </div>
    {/if}
    {#if appState.versionError}
      <CliErrorOutput role="alert" text={appState.versionError} command={commandText} />
    {/if}
    <CommandPreview label="COMMAND PREVIEW" text={commandText}>
      <code>{commandText}</code>
    </CommandPreview>
    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={exitProfileSubView}>Cancel</Button>
      <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy || !canSubmit}>Open</Button>
    </div>
  </form>
</section>
