<script lang="ts">
  import {
    AlertTriangle,
    Camera,
    Copy,
    FileDown,
    FilePlus,
    FolderOpen,
    GitBranch,
    HardDrive,
    History,
    KeyRound,
    Network,
    Plus,
    Power,
    Recycle,
    Save,
    Search,
    Trash2,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Select } from '$lib/components/ui/select'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Badge } from '$lib/components/ui/badge'
  import Callout from '$lib/components/Callout.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import ForkBrowserView from '$lib/components/views/ForkBrowserView.svelte'
  import SnapshotView from '$lib/components/views/SnapshotView.svelte'
  import DeletedView from '$lib/components/views/DeletedView.svelte'
  import VersionView from '$lib/components/views/VersionView.svelte'
  import GatewayView from '$lib/components/views/GatewayView.svelte'
  import { focusOnMount } from '$lib/actions'
  import { FSKIT_MOUNT_PREFIX } from '$lib/cli'
  import { volumeKindBadgeStyle } from '$lib/health'
  import type { Backend } from '$lib/types'
  import {
    ACCESS_KEY_ID_LENGTH,
    appState,
    browseMountPath,
    buildMountArgv,
    computed,
    duplicateSelected,
    enterForkBrowser,
    exportSelected,
    forgetSecret,
    hasRunningInstance,
    newProfile,
    patchProfile,
    persistSelected,
    requestDeletedView,
    requestGatewayView,
    requestSnapshotView,
    requestVersionView,
    runMount,
    selectProfile,
    setAccessKeyId,
    setExtraArgs,
    toggleMountHelp,
  } from '$lib/app-state.svelte'

  const secretRefOptions = $derived([
    { value: 'prompt', label: 'Prompt on mount' },
    { value: 'vault', label: 'Vault' },
  ])

  // Only offered while unset: once a real mount detects the volume kind,
  // require_stable_identity (src-tauri/src/lib.rs) locks it server-side and
  // this profile switches to the read-only Badge instead of this Select.
  const volumeKindOptions = [
    { value: '', label: 'Auto-detect on first mount' },
    { value: 'general', label: 'General' },
    { value: 'iceberg', label: 'Iceberg' },
  ]
</script>

{#if computed.selectedProfile && appState.profileSubView !== 'editor'}
  {#if appState.profileSubView === 'forks'}
    <ForkBrowserView />
  {:else if appState.profileSubView === 'snapshot'}
    <SnapshotView />
  {:else if appState.profileSubView === 'deleted'}
    <DeletedView />
  {:else if appState.profileSubView === 'version'}
    <VersionView />
  {:else if appState.profileSubView === 'gateway'}
    <GatewayView />
  {/if}
{:else}
<section class="grid grid-cols-[240px_minmax(0,1fr)] gap-4 m-[22px] outline-hidden" tabindex="-1" use:focusOnMount>
  <div class="surface p-4">
    <h3 class="mb-4">Saved Profiles</h3>
    <label class="relative flex items-center mb-3">
      <Search size={15} aria-hidden="true" class="absolute left-2.5 text-muted-foreground" />
      <span class="sr-only">Search profile names</span>
      <Input bind:value={appState.profileQuery} placeholder="Search profiles" class="pl-8" />
    </label>
    <div class="grid gap-1.5">
      {#each computed.filteredProfiles as profile (profile.id)}
        <button
          class:bg-accent={appState.selectedProfileId === profile.id}
          class="flex min-w-0 items-center gap-2.5 border border-transparent p-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          title={profile.mountPath || 'No target selected'}
          onclick={() => selectProfile(profile)}
        >
          <HardDrive size={17} aria-hidden="true" class="shrink-0" />
          <strong class="min-w-0 truncate">{profile.name}</strong>
        </button>
      {:else}
        <div class="tech-grid p-7 text-center">
          <p>{appState.profiles.length === 0 ? 'No saved profiles yet.' : `No profiles match "${appState.profileQuery}".`}</p>
        </div>
      {/each}
    </div>
  </div>

  {#if computed.selectedProfile}
    {@const selectedProfile = computed.selectedProfile}
    <form class="surface corner-brackets p-4 grid gap-4" onsubmit={(event) => { event.preventDefault(); void persistSelected() }}>
      <div class="flex items-start justify-end gap-4">
        <div class="relative flex flex-wrap items-center gap-2 border border-border/30 p-2 ml-auto">
          <div class="tech-grid absolute inset-0 pointer-events-none" aria-hidden="true"></div>
          <Button variant="outline" size="icon" class="relative" title="Duplicate profile" aria-label="Duplicate profile" disabled={appState.busy} onclick={duplicateSelected}>
            <Copy size={16} aria-hidden="true" />
          </Button>
          <Button variant="outline" size="icon" class="relative" title="Export profile (no secret)" aria-label="Export profile" disabled={appState.busy} onclick={exportSelected}>
            <FileDown size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="destructive"
            size="icon"
            class="relative"
            title={hasRunningInstance(selectedProfile.id) ? 'Unmount this profile before deleting it' : 'Delete profile'}
            aria-label="Delete profile"
            disabled={appState.busy || hasRunningInstance(selectedProfile.id)}
            onclick={() => (appState.deletePromptFor = selectedProfile)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
          <div class="relative h-6 w-px bg-border/60" aria-hidden="true"></div>
          <Button type="button" class="relative" disabled={appState.busy || !!appState.extraArgsError || appState.rejectedArgs.length > 0 || !!computed.mountPathError || !!computed.accessKeyError || !!computed.volumeNameError} onclick={() => runMount(selectedProfile)}>
            <Power size={16} aria-hidden="true" />
            Mount
          </Button>
          {#if selectedProfile.volumeKind !== 'iceberg'}
            <Button type="button" class="relative" title="Open a read-only, point-in-time view of this volume" disabled={appState.busy} onclick={() => requestSnapshotView(selectedProfile)}>
              <Camera size={16} aria-hidden="true" />
              Snapshot
            </Button>
            <Button type="button" class="relative" title="Open a read-only view of this volume's deleted files" disabled={appState.busy} onclick={() => requestDeletedView(selectedProfile)}>
              <Recycle size={16} aria-hidden="true" />
              Deleted files
            </Button>
            <Button type="button" class="relative" title="Open a read-only view of one file's version history" disabled={appState.busy} onclick={() => requestVersionView(selectedProfile)}>
              <History size={16} aria-hidden="true" />
              Versions
            </Button>
            <Button type="button" class="relative" title="Launch an S3/HDFS gateway for this volume" disabled={appState.busy} onclick={() => requestGatewayView(selectedProfile)}>
              <Network size={16} aria-hidden="true" />
              Gateway
            </Button>
            <Button type="button" class="relative" title="Browse and manage this volume's forks" disabled={appState.busy} onclick={() => enterForkBrowser(selectedProfile)}>
              <GitBranch size={16} aria-hidden="true" />
              Forks
            </Button>
          {/if}
          <Button variant="primary" type="submit" class="relative cyberpunk-skewed-sm" disabled={appState.busy || !!appState.extraArgsError || appState.rejectedArgs.length > 0 || !!computed.mountPathError || !!computed.accessKeyError || !!computed.volumeNameError}>
            <Save size={16} aria-hidden="true" />
            Save
          </Button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="profile-name">Name</Label>
          <Input id="profile-name" value={selectedProfile.name} oninput={(e) => patchProfile({ name: e.currentTarget.value })} />
        </div>
        <div class="grid gap-1.5">
          <Label id="profile-backend-label">Backend</Label>
          <Select
            options={computed.backends.map((backend) => ({ value: backend, label: backend }))}
            value={selectedProfile.backend}
            ariaLabelledby="profile-backend-label"
            onchange={(value) => patchProfile({ backend: value as Backend })}
          />
        </div>
        <div class="grid gap-1.5">
          {#if appState.selectedProfileSnapshotVolumeKind}
            <!-- Read-only once actually saved: require_stable_identity
                 (src-tauri/src/lib.rs) then rejects changing it server-side.
                 Checked against the last-loaded/saved snapshot, not the live
                 draft -- picking a value in the Select below is not yet
                 saved, and must not switch to this locked state before Save
                 is pressed. -->
            <Label id="profile-volume-kind-label">Volume kind</Label>
            <Badge variant="secondary" style={volumeKindBadgeStyle(appState.selectedProfileSnapshotVolumeKind)} title="Detected from the mount itself; locks accessKeyId/discoveryUrl/volume">
              {appState.selectedProfileSnapshotVolumeKind === 'iceberg' ? 'Iceberg' : 'General'}
            </Badge>
          {:else}
            <Label id="profile-volume-kind-label">Volume kind</Label>
            <Select
              options={volumeKindOptions}
              value={selectedProfile.volumeKind ?? ''}
              onchange={(value) => patchProfile({ volumeKind: (value || undefined) as 'general' | 'iceberg' | undefined })}
              ariaLabelledby="profile-volume-kind-label"
            />
          {/if}
        </div>
        <div class="grid gap-1.5">
          <Label for="profile-discovery-url">Discovery URL</Label>
          <Input
            id="profile-discovery-url"
            value={selectedProfile.discoveryUrl}
            disabled={Boolean(appState.selectedProfileSnapshotVolumeKind)}
            oninput={(e) => patchProfile({ discoveryUrl: e.currentTarget.value })}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="profile-access-key">Access key ID</Label>
          <Input
            id="profile-access-key"
            value={selectedProfile.accessKeyId}
            maxlength={ACCESS_KEY_ID_LENGTH}
            disabled={Boolean(appState.selectedProfileSnapshotVolumeKind)}
            oninput={(e) => setAccessKeyId(e.currentTarget.value)}
          />
          {#if computed.accessKeyError}
            <small class="text-destructive text-sm">{computed.accessKeyError}</small>
          {/if}
        </div>
        <div class="grid gap-1.5">
          <span class="inline-flex items-center gap-1">
            <Label for="profile-volume">Volume name</Label>
            {#if selectedProfile.backend === 'fskit'}
              <InfoTip text="Used as the mount point's folder name under {FSKIT_MOUNT_PREFIX}" />
            {/if}
          </span>
          <Input
            id="profile-volume"
            value={selectedProfile.volume}
            disabled={Boolean(appState.selectedProfileSnapshotVolumeKind)}
            oninput={(e) => patchProfile({ volume: e.currentTarget.value })}
          />
          {#if computed.volumeNameError}
            <small class="text-destructive text-sm">{computed.volumeNameError}</small>
          {/if}
        </div>
        <div class="grid gap-1.5">
          <Label for="profile-fork">Fork</Label>
          <Input id="profile-fork" value={selectedProfile.fork} oninput={(e) => patchProfile({ fork: e.currentTarget.value })} />
        </div>
        <div class="grid gap-1.5">
          <Label for="mount-path">Mount path</Label>
          <div class="flex gap-2">
            <Input
              id="mount-path"
              value={selectedProfile.mountPath}
              placeholder={selectedProfile.backend === 'fskit' ? '/Volumes/MountOS/<name>' : undefined}
              oninput={(e) => patchProfile({ mountPath: e.currentTarget.value })}
              class="flex-1"
            />
            <Button type="button" onclick={browseMountPath} disabled={appState.busy} title="Choose a folder" class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" />
              Browse
            </Button>
          </div>
        </div>
        <div class="grid gap-1.5">
          <Label id="profile-secret-ref-label">Secret</Label>
          <Select
            options={secretRefOptions}
            value={selectedProfile.secretRef}
            ariaLabelledby="profile-secret-ref-label"
            onchange={(value) => patchProfile({ secretRef: value as 'vault' | 'prompt' })}
          />
          {#if !selectedProfile.accessKeyId}
            <small class="text-muted-foreground text-sm">Vault storage needs an access key ID first.</small>
          {/if}
        </div>
      </div>

      {#if computed.mountPathError}
        <Callout>{computed.mountPathError}</Callout>
      {/if}

      <div class="flex items-center justify-between gap-4">
        <Badge variant={appState.vaultStatus[selectedProfile.id] ? 'success' : 'warning'}>
          <KeyRound size={14} aria-hidden="true" />
          {appState.vaultStatus[selectedProfile.id] ? 'Secret stored' : 'No vaulted secret'}
        </Badge>
        <Button variant="destructive" disabled={!appState.vaultStatus[selectedProfile.id] || appState.busy} onclick={() => forgetSecret(selectedProfile.id)}>
          <Trash2 size={16} aria-hidden="true" />
          Forget secret
        </Button>
      </div>

      <div class="flex flex-wrap gap-4">
        <Checkbox checked={selectedProfile.readOnly} onchange={(e) => patchProfile({ readOnly: e.currentTarget.checked })} label="Read only" />
        <span class="inline-flex items-center gap-1">
          <Checkbox
            checked={selectedProfile.temporaryFork}
            onchange={(e) => patchProfile({ temporaryFork: e.currentTarget.checked })}
            label="Sandbox"
          />
          <InfoTip
            text="For trying something out, not for anything you need to keep. Everything you see is a read-only snapshot of the volume, so nothing you inherited is ever at risk. **Only what you create or edit inside this sandbox is at risk**: that data lives on this device alone, is never backed up, and disappears the moment you unmount. If your disk runs low on space, those writes can fail and that data is gone for good. The volume itself is never touched."
          />
        </span>
      </div>

      <div class="grid gap-1.5">
        <div class="flex items-center justify-between gap-3">
          <Label for="advanced-options">Advanced options</Label>
          <Button type="button" variant="ghost" size="sm" onclick={toggleMountHelp} disabled={appState.busy} aria-expanded={appState.mountHelpVisible}>
            {appState.mountHelpVisible ? 'Hide help' : 'mountos mount -h'}
          </Button>
        </div>
        <Textarea
          id="advanced-options"
          value={appState.extraArgsInput}
          oninput={(e) => setExtraArgs(e.currentTarget.value)}
          placeholder="Flags mountos mount accepts but this form doesn't manage, e.g. --attr-cache 2.0"
        />
      </div>

      {#if appState.mountHelpVisible}
        <CommandPreview label="MOUNTOS MOUNT -H" text={appState.mountHelpText}>
          <pre class="m-0 whitespace-pre-wrap break-words"><code>{appState.mountHelpText}</code></pre>
        </CommandPreview>
      {/if}

      {#if appState.extraArgsError}
        <Callout>{appState.extraArgsError}</Callout>
      {/if}

      {#if appState.rejectedArgs.length}
        <Callout>Rejected managed flags: {appState.rejectedArgs.join(', ')}</Callout>
      {/if}

      <CommandPreview label="COMMAND PREVIEW" text={appState.commandText || `mountos ${buildMountArgv(selectedProfile).join(' ')}`}>
        <code>{appState.commandText || `mountos ${buildMountArgv(selectedProfile).join(' ')}`}</code>
      </CommandPreview>
    </form>
  {:else}
    <div class="surface tech-grid grid justify-items-center gap-2 p-7 text-center">
      <FilePlus size={28} aria-hidden="true" />
      <strong>No profile selected</strong>
      <p>Save a profile to mount a mountOS volume in one click, with credentials in the OS vault and the exact CLI command shown before every action.</p>
      <Button variant="primary" type="button" class="cyberpunk-skewed-sm" onclick={() => newProfile()}>
        <Plus size={17} aria-hidden="true" />
        New profile
      </Button>
    </div>
  {/if}
</section>
{/if}
