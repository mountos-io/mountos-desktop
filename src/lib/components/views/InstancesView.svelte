<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    Copy,
    EllipsisVertical,
    FilePlus,
    FolderOpen,
    Ghost,
    HardDrive,
    History,
    LayoutDashboard,
    Lightbulb,
    OctagonX,
    Plus,
    Recycle,
    Search,
    SquareTerminal,
    Unplug,
    Upload,
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import * as Table from '$lib/components/ui/table'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Input } from '$lib/components/ui/input'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import GatewayLaunchesPanel from '$lib/components/GatewayLaunchesPanel.svelte'
  import InstanceConfigPanel from '$lib/components/InstanceConfigPanel.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import { focusOnMount } from '$lib/actions'
  import { backendBadgeStyle, formatMountedSince, formatUptime, gatewayProtocolsLabel, healthTitle, healthTone, viewModeBadge, volumeKindBadgeStyle } from '$lib/health'
  import type { MountInstance } from '$lib/types'
  import {
    appState,
    canOpen,
    canOpenViewsFor,
    canUploadFrom,
    cloneProfileFor,
    copyConfig,
    copyText,
    computed,
    DEFAULT_POLL_SECONDS,
    gatewayInfoForInstance,
    newProfile,
    openDashboard,
    profileForInstance,
    requestDeletedView,
    requestExternalDeletedView,
    requestExternalVersionView,
    requestUnmount,
    requestUnmountAll,
    requestUploadFromInstance,
    requestVersionView,
    requestStopGatewayOnly,
    runOpen,
    runOpenLostFound,
    saveAsProfile,
    stopGatewayLaunch,
    toggleInstanceConfig,
  } from '$lib/app-state.svelte'

  // Prefers the live read off the mount's own .mountOS/.config
  // (instance.volumeKind): it works for external mounts too, unlike the
  // profile's own cached volumeKind, which only ever populates for
  // profile-backed mounts (see detect_and_persist_volume_kind server-side).
  function volumeKindFor(instance: MountInstance): string | undefined {
    return instance.volumeKind ?? profileForInstance(instance)?.volumeKind
  }

  // Same fallback shape as volumeKindFor: instance.temporaryFork is a
  // best-effort live read off .mountOS/.config (read_instance_config_extras
  // silently falls back to undefined on any read failure -- unmounted
  // mid-poll, .config not written yet, unexpected shape), so relying on it
  // alone means the badge can silently vanish for a mount that IS a
  // temporary fork, right when a user most needs the warning (its data is
  // ephemeral and about to disappear). The profile's own temporaryFork is a
  // persisted, reliable answer for anything profile-backed.
  function isTemporaryFork(instance: MountInstance): boolean {
    return Boolean(instance.temporaryFork ?? profileForInstance(instance)?.temporaryFork)
  }

  // "Open folder" moved to a direct action button, so it's no longer the one
  // unconditional item keeping this menu non-empty -- without this check the
  // dropdown trigger would open onto nothing for an instance with no other
  // applicable item (not openable, no deleted/version view, no gateway).
  function hasMoreActions(instance: MountInstance): boolean {
    return canOpen(instance) || canOpenViewsFor(instance) || canUploadFrom(instance) || Boolean(gatewayInfoForInstance(instance)?.pid)
  }

  // `unmount --all` only ever acts on real kernel mounts -- a standalone
  // gateway-only row has no unmount concept at all (see Stop gateway
  // instead), so its presence alone must not enable this button.
  function hasAnyMount(): boolean {
    return appState.systemState.instances.some((instance) => instance.kind !== 'gateway')
  }
</script>

<div class="corner-brackets relative border border-border/30 m-[22px] mb-0 p-4 outline-hidden" tabindex="-1" use:focusOnMount>
  <div class="tech-grid absolute inset-0 pointer-events-none" aria-hidden="true"></div>
  <div class="relative flex flex-wrap items-center justify-between gap-3">
    <label class="relative flex items-center max-w-sm">
      <Search size={16} aria-hidden="true" class="absolute left-3 text-muted-foreground" />
      <span class="sr-only">Search instances</span>
      <!-- dark:bg-background overrides the Input component's own dark:bg-input/20:
           that low-alpha fill is fine over a plain surface, but here it sits
           directly on top of the tech-grid overlay two levels up, so the grid
           pattern shows straight through and the field stops reading as a box. -->
      <Input bind:value={appState.query} placeholder="Filter mounts" class="pl-9 dark:bg-background" />
    </label>
    <div class="flex flex-wrap items-center gap-2">
      <Badge>{appState.systemState.instances.length} running</Badge>
      <Button variant="destructive" disabled={appState.busy || !hasAnyMount()} onclick={requestUnmountAll}>
        <Unplug size={16} aria-hidden="true" />
        Unmount all
      </Button>
    </div>
  </div>
</div>

<section class="surface m-[22px] mt-4 p-4">
  <h3 class="mb-6">Running instances</h3>
  {#if appState.loaded && computed.filteredInstances.length === 0}
    <div class="tech-grid grid justify-items-center gap-2 p-7 text-center">
      <Unplug size={28} aria-hidden="true" />
      <strong>No instances</strong>
      <p>Mount a saved profile, or mount from the CLI. Active mounts appear here after refresh.</p>
      <div class="flex flex-wrap justify-center gap-2">
        <Button variant="primary" type="button" class="cyberpunk-skewed-sm" onclick={() => newProfile()}>
          <Plus size={17} aria-hidden="true" />
          New profile
        </Button>
        <Button variant="outline" type="button" onclick={() => (appState.view = 'profiles')}>
          <HardDrive size={17} aria-hidden="true" />
          Go to Profiles
        </Button>
      </div>
    </div>
  {:else}
  <Table.Root containerLabel="Running instances">
    <Table.Header>
      <Table.Row>
        <Table.Head class="th-cyber w-8"></Table.Head>
        <Table.Head class="th-cyber">Name</Table.Head>
        <Table.Head class="th-cyber">Target</Table.Head>
        <Table.Head class="th-cyber">Backend</Table.Head>
        <Table.Head class="th-cyber w-40">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if !appState.loaded}
        {#each { length: 3 } as _placeholder}
          <Table.Row aria-hidden="true">
            <Table.Cell><Skeleton class="h-5 w-5" /></Table.Cell>
            <Table.Cell><Skeleton class="h-5 w-32" /></Table.Cell>
            <Table.Cell><Skeleton class="h-5 w-64" /></Table.Cell>
            <Table.Cell><Skeleton class="h-5 w-20" /></Table.Cell>
            <Table.Cell><Skeleton class="h-5 w-20" /></Table.Cell>
          </Table.Row>
        {/each}
      {:else}
        {#each computed.filteredInstances as instance (instance.key)}
          <Table.Row>
            <Table.Cell class="text-muted-foreground">
              {#if canOpen(instance)}
                <button
                  type="button"
                  class="inline-flex items-center justify-center p-2 -m-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  title={instance.key in appState.expandedConfig ? 'Hide Configuration' : 'Show Configuration'}
                  aria-label={instance.key in appState.expandedConfig ? 'Hide Configuration' : 'Show Configuration'}
                  aria-expanded={instance.key in appState.expandedConfig}
                  disabled={appState.busy}
                  onclick={() => toggleInstanceConfig(instance)}
                >
                  {#if instance.key in appState.expandedConfig}<ChevronDown size={16} aria-hidden="true" />{:else}<ChevronRight size={16} aria-hidden="true" />{/if}
                </button>
              {/if}
            </Table.Cell>
            <Table.Cell
              class={canOpen(instance) ? 'cursor-pointer' : ''}
              onclick={() => canOpen(instance) && toggleInstanceConfig(instance)}
            >
              <span class="flex flex-wrap items-center gap-2">
                <!-- title for pointer users; the sr-only text is what makes
                     this readable at all without colour vision or a mouse,
                     since the dot alone carries the state (WCAG 1.4.1). -->
                <span class="led {healthTone(instance.health)}" title={healthTitle(instance.health)}></span>
                <span class="sr-only">{healthTitle(instance.health)}</span>
                <!-- No "External" badge: the Actions column already says it.
                     An external mount is exactly one offering "Save as
                     profile" rather than "Clone profile", so the badge only
                     restated the row next to it. -->
                <strong>{instance.name || instance.volumeId || 'mountOS volume'}</strong>
                {#if viewModeBadge(instance.viewMode)}
                  <Badge>{viewModeBadge(instance.viewMode)}</Badge>
                {:else if instance.viewMode === 'r'}
                  <!-- Only for a plain read-only regular mount: a satellite
                       view (Deleted/Version/Snapshot, above) is inherently
                       read-only already, so it gets its own distinct badge
                       instead of this one too. -->
                  <Badge variant="secondary">Read only</Badge>
                {/if}
                {#if volumeKindFor(instance)}
                  <Badge variant="secondary" style={volumeKindBadgeStyle(volumeKindFor(instance))} title="Volume kind, detected from the mount itself" tabindex={0}>
                    {volumeKindFor(instance) === 'iceberg' ? 'Iceberg' : 'General'}
                  </Badge>
                {/if}
                {#if isTemporaryFork(instance)}
                  <Badge variant="warning" title="This mount is a sandbox: writes stay on this device and disappear when it's deleted" tabindex={0}>Sandbox</Badge>
                {/if}
                {#if gatewayInfoForInstance(instance)}
                  <Badge title="This mount also has an S3/HDFS gateway running, launched from this app" tabindex={0}>Gateway</Badge>
                {/if}
                {#if (appState.settings.pollSeconds ?? DEFAULT_POLL_SECONDS) === 0}
                  <!-- Polling off: nothing re-renders this row again until a manual
                       refresh, so a relative "Up Xh Ym" would silently freeze and
                       read as live when it isn't. An absolute time stays correct
                       regardless of how long it sits unrefreshed. -->
                  {#if formatMountedSince(instance.mountTime)}
                    <Badge variant="secondary" title="Auto-refresh is off -- hit Refresh to update" tabindex={0}>Since {formatMountedSince(instance.mountTime)}</Badge>
                  {/if}
                {:else if formatUptime(instance.mountTime)}
                  <Badge variant="secondary" title={`Mounted at ${formatMountedSince(instance.mountTime)}`} tabindex={0}>Up {formatUptime(instance.mountTime)}</Badge>
                {/if}
              </span>
            </Table.Cell>
            <Table.Cell>
              {#if instance.kind !== 'gateway'}
                <div class="flex items-center gap-2">
                  <code>{instance.mountPath}</code>
                  <Button variant="ghost" size="icon" title="Copy target" aria-label="Copy target" onclick={() => copyText(instance.mountPath, 'Target copied')}>
                    <Copy size={16} aria-hidden="true" />
                  </Button>
                </div>
              {/if}
              <!-- A "gateway" row has only endpoints; a "mount" row that also
                   runs a --gateway-attached embedded gateway (same process,
                   folded onto this entry server-side by pid) lists them below
                   the mount path -- badged per protocol so a reader doesn't
                   have to guess which URL is s3 vs. hdfs. S3's bucket name IS
                   the fork ("auto" also works) -- HDFS has no such concept
                   (always resolves to the bound fork), hence the hint on s3
                   only. -->
              {#if instance.gatewayEndpoints?.length}
                <div class={instance.kind === 'gateway' ? 'flex flex-col gap-1' : 'mt-1 flex flex-col gap-1'}>
                  {#each instance.gatewayEndpoints as endpoint (endpoint.protocol)}
                    <div class="flex items-center gap-2">
                      <Badge variant="secondary" class="uppercase">{endpoint.protocol}</Badge>
                      <code class="text-xs">{endpoint.url}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Copy {endpoint.protocol} URL"
                        aria-label="Copy {endpoint.protocol} URL"
                        onclick={() => copyText(endpoint.url, `${endpoint.protocol.toUpperCase()} URL copied`)}
                      >
                        <Copy size={16} aria-hidden="true" />
                      </Button>
                      {#if endpoint.protocol === 's3'}
                        <InfoTip
                          text="This gateway serves one bucket: use **auto**, or the fork's own name (e.g. 'main'). Any other bucket name is rejected."
                        />
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell>
              {#if instance.kind === 'gateway'}
                <Badge variant="secondary">{gatewayProtocolsLabel(instance.gatewayEndpoints)}</Badge>
              {:else}
                <Badge variant="secondary" style={backendBadgeStyle(instance.backend)}>{instance.backend ?? 'unknown'}</Badge>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <div class="flex flex-nowrap items-center gap-2">
                <Button variant="outline" size="icon" title="Open folder" aria-label="Open folder" disabled={appState.busy || !canOpen(instance)} onclick={() => runOpen(instance)}>
                  <FolderOpen size={16} aria-hidden="true" />
                </Button>
                {#if instance.kind === 'gateway'}
                  <Button
                    variant="destructive"
                    size="icon"
                    title="Stop gateway"
                    aria-label="Stop gateway"
                    disabled={appState.busy || instance.pid == null}
                    onclick={() => requestStopGatewayOnly(instance)}
                  >
                    <OctagonX size={16} aria-hidden="true" />
                  </Button>
                {:else}
                  <Button variant="destructive" size="icon" title="Unmount" aria-label="Unmount" disabled={appState.busy} onclick={() => requestUnmount(instance)}>
                    <Unplug size={16} aria-hidden="true" />
                  </Button>
                {/if}
                {#if hasMoreActions(instance)}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                      <Button {...props} variant="outline" size="icon" title="More actions" aria-label="More actions" disabled={appState.busy}>
                        <EllipsisVertical size={16} aria-hidden="true" />
                      </Button>
                    {/snippet}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={6}
                      class="z-50 min-w-[200px] border border-border bg-popover p-1 text-popover-foreground"
                    >
                      {#if canOpen(instance)}
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => openDashboard(instance, false)}
                        >
                          <SquareTerminal size={16} aria-hidden="true" /> Launch TUI dashboard
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => openDashboard(instance, true)}
                        >
                          <LayoutDashboard size={16} aria-hidden="true" /> Launch GUI dashboard
                        </DropdownMenu.Item>
                      {/if}
                      <!-- Suppressed entirely on a satellite Deleted/Version/
                           Snapshot row: cloning one would silently produce a
                           profile that mounts the wrong thing (a regular
                           `mount`, not the view command) at that path. -->
                      {#if canOpen(instance) && !viewModeBadge(instance.viewMode)}
                        {#if instance.external}
                          <DropdownMenu.Item
                            class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                            disabled={appState.busy}
                            onSelect={() => saveAsProfile(instance)}
                          >
                            <FilePlus size={16} aria-hidden="true" /> Save as profile
                          </DropdownMenu.Item>
                        {:else if instance.profileId}
                          <DropdownMenu.Item
                            class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                            disabled={appState.busy}
                            onSelect={() => cloneProfileFor(instance)}
                          >
                            <Copy size={16} aria-hidden="true" /> Clone profile
                          </DropdownMenu.Item>
                        {/if}
                      {/if}
                      {#if canUploadFrom(instance)}
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => requestUploadFromInstance(instance)}
                        >
                          <Upload size={16} aria-hidden="true" /> Upload to this volume
                        </DropdownMenu.Item>
                      {/if}
                      <!-- .lost+found is a real directory inside the volume's
                           own namespace, so it doesn't exist under a
                           satellite Deleted/Version/Snapshot view -- same
                           gate as Save-as-profile/Clone-profile above. -->
                      {#if canOpen(instance) && !viewModeBadge(instance.viewMode)}
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center justify-between gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => runOpenLostFound(instance)}
                        >
                          <span class="flex items-center gap-2"><Ghost size={16} aria-hidden="true" /> Open zombie files</span>
                          <span title="Files that lost their name or folder -- the .lost+found directory">
                            <Lightbulb size={14} aria-hidden="true" class="text-muted-foreground" />
                          </span>
                        </DropdownMenu.Item>
                      {/if}
                      {#if canOpenViewsFor(instance)}
                        <DropdownMenu.Separator class="my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => {
                            const profile = profileForInstance(instance)
                            if (profile) requestDeletedView(profile)
                            else void requestExternalDeletedView(instance)
                          }}
                        >
                          <Recycle size={16} aria-hidden="true" /> Open deleted-files view
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm outline-none data-highlighted:bg-accent"
                          disabled={appState.busy}
                          onSelect={() => {
                            const profile = profileForInstance(instance)
                            if (profile) requestVersionView(profile)
                            else void requestExternalVersionView(instance)
                          }}
                        >
                          <History size={16} aria-hidden="true" /> Open file-version view
                        </DropdownMenu.Item>
                      {/if}
                      {#if gatewayInfoForInstance(instance)?.pid}
                        <DropdownMenu.Separator class="my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-destructive outline-none dropdown-item-destructive"
                          disabled={appState.busy}
                          onSelect={() => stopGatewayLaunch(gatewayInfoForInstance(instance)?.id ?? '')}
                        >
                          <OctagonX size={16} aria-hidden="true" /> Stop gateway
                        </DropdownMenu.Item>
                      {/if}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {/if}
              </div>
            </Table.Cell>
          </Table.Row>
          {#if instance.key in appState.expandedConfig}
            <Table.Row>
              <Table.Cell colspan={5}>
                <InstanceConfigPanel raw={appState.expandedConfig[instance.key]} onCopy={() => copyConfig(instance.key)} />
              </Table.Cell>
            </Table.Row>
          {/if}
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
  {/if}
</section>
<GatewayLaunchesPanel />
