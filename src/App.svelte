<script lang="ts">
  import { Command, HardDrive, MonitorDot, PanelLeft, Plus, RefreshCw, Settings, Upload } from '@lucide/svelte'
  import Toaster from '$lib/components/Toaster.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import { cn, modKeyPressed } from '$lib/utils'
  import { initThemeSync } from '$lib/theme.svelte'
  import InstancesView from '$lib/components/views/InstancesView.svelte'
  import ProfilesView from '$lib/components/views/ProfilesView.svelte'
  import UploadsView from '$lib/components/views/UploadsView.svelte'
  import SettingsView from '$lib/components/views/SettingsView.svelte'
  import SecretPromptDialog from '$lib/components/dialogs/SecretPromptDialog.svelte'
  import DeleteProfileDialog from '$lib/components/dialogs/DeleteProfileDialog.svelte'
  import UnmountDialog from '$lib/components/dialogs/UnmountDialog.svelte'
  import StopGatewayDialog from '$lib/components/dialogs/StopGatewayDialog.svelte'
  import ExternalDeletedViewDialog from '$lib/components/dialogs/ExternalDeletedViewDialog.svelte'
  import ExternalVersionViewDialog from '$lib/components/dialogs/ExternalVersionViewDialog.svelte'
  import ForkCreateDialog from '$lib/components/dialogs/ForkCreateDialog.svelte'
  import ForkDeleteDialog from '$lib/components/dialogs/ForkDeleteDialog.svelte'
  import ForkRestoreDialog from '$lib/components/dialogs/ForkRestoreDialog.svelte'
  import UploadResumeDialog from '$lib/components/dialogs/UploadResumeDialog.svelte'
  import UploadPruneDialog from '$lib/components/dialogs/UploadPruneDialog.svelte'
  import TipsDialog from '$lib/components/dialogs/TipsDialog.svelte'
  import ThirdPartyLicensesDialog from '$lib/components/dialogs/ThirdPartyLicensesDialog.svelte'
  import CommandPalette from '$lib/components/CommandPalette.svelte'
  import {
    appState,
    computed,
    DEFAULT_POLL_SECONDS,
    drillIntoFork,
    exitProfileSubView,
    exitUploadCreate,
    HIDDEN_POLL_MS,
    loadSettings,
    newProfile,
    pollSystem,
    refresh,
    runUploadList,
    toggleSidebar,
    viewTitle,
    type View,
  } from '$lib/app-state.svelte'

  const navItems: Array<{ id: View; label: string; icon: typeof MonitorDot }> = [
    { id: 'instances', label: 'Instances', icon: MonitorDot },
    { id: 'profiles', label: 'Profiles', icon: HardDrive },
    { id: 'uploads', label: 'Uploads', icon: Upload },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  let commandPaletteOpen = $state(false)
  let viewScroller: HTMLDivElement | undefined = $state()

  // Caps the sidebar badge at "99+" -- an uncapped 3+ digit count would
  // stretch the pill wide enough to crowd the icon next to it.
  function badgeCount(n: number): string {
    return n > 99 ? '99+' : String(n)
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const modPressed = modKeyPressed(event, appState.systemState.platform)
    if (modPressed && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      commandPaletteOpen = true
      return
    }
    // Unlike Cmd+K, guarded against firing while typing -- a bare "," is a
    // real character in plenty of fields (extra args, discovery URLs).
    const target = event.target as HTMLElement
    const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    if (modPressed && !event.shiftKey && event.key === ',' && !inInput) {
      event.preventDefault()
      appState.view = 'settings'
      return
    }
    if (modPressed && !event.shiftKey && event.key.toLowerCase() === 'b' && !inInput) {
      event.preventDefault()
      toggleSidebar()
      return
    }
    if (modPressed && !event.shiftKey && event.key.toLowerCase() === 'r' && !inInput) {
      event.preventDefault()
      void refresh()
      return
    }
    if (modPressed && !event.shiftKey && event.key.toLowerCase() === 'n' && !inInput) {
      event.preventDefault()
      newProfile()
    }
  }

  // Every crumb but the last is clickable; the last is the current page.
  // Only the Profiles view ever grows past one crumb (a selected profile,
  // then however many levels deep a fork drill-down goes).
  type Crumb = { label: string; onclick?: () => void }
  const subViewLabels = { forks: 'Forks', snapshot: 'Snapshot view', deleted: 'Deleted files', version: 'File versions', gateway: 'Gateway' } as const

  const breadcrumbs = $derived.by((): Crumb[] => {
    const rootAction = appState.view === 'uploads' ? exitUploadCreate : exitProfileSubView
    const crumbs: Array<Crumb & { onclick?: () => void }> = [{ label: viewTitle(appState.view), onclick: rootAction }]
    if (appState.view === 'profiles' && computed.selectedProfile) {
      crumbs.push({ label: computed.selectedProfile.name, onclick: exitProfileSubView })
      if (appState.profileSubView === 'forks') {
        crumbs.push({ label: subViewLabels.forks, onclick: () => drillIntoFork(null) })
        for (const fork of computed.forkBreadcrumbTrail) {
          crumbs.push({ label: fork.name || `Fork #${fork.fid}`, onclick: () => drillIntoFork(fork.fid) })
        }
      } else if (appState.profileSubView !== 'editor') {
        crumbs.push({ label: subViewLabels[appState.profileSubView], onclick: exitProfileSubView })
      }
    } else if (appState.view === 'uploads' && appState.uploadSubView === 'create') {
      crumbs.push({ label: 'New upload', onclick: exitUploadCreate })
    }
    // Every crumb but the last is clickable; the last is the current page.
    return crumbs.map((crumb, index) => (index === crumbs.length - 1 ? { label: crumb.label } : crumb))
  })

  $effect(() => initThemeSync())

  $effect(() => {
    appState.view
    if (viewScroller) viewScroller.scrollTop = 0
  })

  $effect(() => {
    void loadSettings()
    void refresh(false)
    // One-shot, not a poll loop: gives the sidebar's running-upload badge a
    // real count from launch, without adding a background CLI shell-out
    // most sessions (that never touch Uploads) would pay for nothing.
    void runUploadList()
  })

  $effect(() => {
    // Read inside the effect so changing the setting reschedules immediately
    // rather than waiting for a restart. 0 means "Off" -- no timer at all,
    // the Refresh button covers manual updates.
    const pollSeconds = appState.settings.pollSeconds ?? DEFAULT_POLL_SECONDS
    if (pollSeconds === 0) return
    const visibleMs = pollSeconds * 1000
    // A hidden window always backs off, but never polls more often than the
    // user asked for: someone who picked 60s does not want 30s in the
    // background.
    const hiddenMs = Math.max(HIDDEN_POLL_MS, visibleMs)
    let timer: ReturnType<typeof setInterval> | undefined
    const schedule = () => {
      clearInterval(timer)
      timer = setInterval(() => {
        void pollSystem()
      }, document.hidden ? hiddenMs : visibleMs)
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  })
</script>

<svelte:head>
  <title>mountOS Desktop</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<Toaster />
<CommandPalette bind:open={commandPaletteOpen} />

<div
  class="grid h-full bg-background text-foreground transition-[grid-template-columns] duration-200 ease-out"
  style:grid-template-columns={appState.sidebarCollapsed ? '4.5rem minmax(0,1fr)' : '14.5rem minmax(0,1fr)'}
>
  <aside class="flex min-h-full flex-col overflow-hidden border-r border-border bg-card">
    <div class="relative flex items-center gap-3 px-4 pb-4.5 pt-7.5 -top-[5px]" class:justify-center={appState.sidebarCollapsed} class:px-0={appState.sidebarCollapsed} data-tauri-drag-region="deep">
      <img class="shrink-0" src="/logo.png" alt="" width="36" height="36" />
      {#if !appState.sidebarCollapsed}<h1 class="text-xl font-semibold">mountOS</h1>{/if}
    </div>

    <nav aria-label="Primary" class="grid gap-1 px-2">
      {#each navItems as item}
        <button
          class={cn(
            'flex items-center gap-2.5 border border-transparent px-3 py-2 text-left text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            appState.sidebarCollapsed && 'justify-center px-0',
            appState.view === item.id && 'bg-accent text-foreground',
          )}
          type="button"
          title={appState.sidebarCollapsed ? item.label : undefined}
          aria-current={appState.view === item.id ? 'page' : undefined}
          onclick={() => (appState.view = item.id)}
        >
          <span class="relative shrink-0">
            <item.icon size={18} aria-hidden="true" />
            {#if item.id === 'uploads' && computed.uploadRunningCount > 0}
              <span
                class="absolute -right-2.5 -top-2.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-base font-medium leading-none text-primary-foreground"
                title="{computed.uploadRunningCount} upload job{computed.uploadRunningCount === 1 ? '' : 's'} running"
              >
                {badgeCount(computed.uploadRunningCount)}
              </span>
            {/if}
          </span>
          {#if !appState.sidebarCollapsed}<span>{item.label}</span>{/if}
        </button>
      {/each}
    </nav>

    <button
      class={cn(
        'mt-auto flex items-center gap-2.5 border-t border-border px-4 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        appState.sidebarCollapsed && 'justify-center px-0',
      )}
      type="button"
      title="mountOS CLI status, see Settings for details"
      onclick={() => (appState.view = 'settings')}
    >
      <span class="led" class:warning={!appState.systemState.checkOk}></span>
      {#if !appState.sidebarCollapsed}<span>{appState.systemState.checkOk ? 'CLI ready' : 'CLI issue'}</span>{/if}
    </button>
  </aside>

  <main class="flex min-h-0 min-w-0 flex-col overflow-hidden" aria-busy={appState.busy}>
    <header class="flex items-center justify-between gap-4 border-b border-border px-4 py-3" data-tauri-drag-region="deep">
      <div class="flex items-center gap-3">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={!appState.sidebarCollapsed}
          onclick={toggleSidebar}
        >
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        <Breadcrumb.Root>
          <Breadcrumb.List class="flex-nowrap gap-1.5">
            {#each breadcrumbs as crumb, index (index)}
              {#if index > 0}
                <Breadcrumb.Separator />
              {/if}
              <Breadcrumb.Item>
                {#if crumb.onclick}
                  <button type="button" class="text-lg text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onclick={crumb.onclick}>{crumb.label}</button>
                {:else}
                  <Breadcrumb.Page class="text-lg font-semibold">{crumb.label}</Breadcrumb.Page>
                {/if}
              </Breadcrumb.Item>
            {/each}
          </Breadcrumb.List>
        </Breadcrumb.Root>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-9 w-72 shrink-0 items-center justify-between gap-2 whitespace-nowrap border border-input bg-background px-3 text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          title="Open command palette"
          aria-label="Open command palette"
          onclick={() => (commandPaletteOpen = true)}
        >
          <span class="flex items-center gap-2 text-sm">
            <Command size={15} aria-hidden="true" class="shrink-0" />
            Search or jump to...
          </span>
          <kbd class="font-mono text-sm shrink-0">⌘K</kbd>
        </button>
        <Button variant="ghost" size="icon" title="Refresh" aria-label="Refresh" onclick={() => refresh()} disabled={appState.busy}>
          <span class={cn(appState.busy && 'animate-spin')}><RefreshCw size={17} aria-hidden="true" /></span>
        </Button>
        <Button variant="primary" class="cyberpunk-skewed-sm" onclick={() => newProfile()} disabled={appState.busy}>
          <Plus size={17} aria-hidden="true" />
          Profile
        </Button>
      </div>
    </header>

    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div bind:this={viewScroller} class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {#if appState.view === 'instances'}
          <InstancesView />
        {:else if appState.view === 'profiles'}
          <ProfilesView />
        {:else if appState.view === 'uploads'}
          <UploadsView />
        {:else}
          <SettingsView />
        {/if}
      </div>
    </div>
  </main>
</div>

<SecretPromptDialog />
<DeleteProfileDialog />
<UnmountDialog />
<StopGatewayDialog />
<ExternalDeletedViewDialog />
<ExternalVersionViewDialog />
<ForkCreateDialog />
<ForkDeleteDialog />
<ForkRestoreDialog />
<UploadResumeDialog />
<UploadPruneDialog />
<TipsDialog />
<ThirdPartyLicensesDialog />
