<script lang="ts">
  import { Bot, Download, FileArchive, HardDrive, Info, Lightbulb, Mail, MonitorDot, Palette, PanelLeft, Plus, Radio, RefreshCw, ScrollText, Settings, TerminalSquare, Unplug, Upload } from '@lucide/svelte'
  import * as Command from '$lib/components/ui/command'
  import {
    appState,
    computed,
    createBundle,
    enterDownloadCreate,
    enterUploadCreate,
    goToSettingsSection,
    newProfile,
    refresh,
    requestUnmountAll,
    selectProfile,
    showLicenses,
    showTips,
    toggleSidebar,
  } from '$lib/app-state.svelte'
  import type { View } from '$lib/app-state.svelte'
  import { FEATURE_REGISTRY } from '$lib/features'
  import { isMacPlatform } from '$lib/utils'

  let { open = $bindable(false) }: { open?: boolean } = $props()

  const navItems: Array<{ id: View; label: string; icon: typeof MonitorDot }> = [
    { id: 'instances', label: 'Instances', icon: MonitorDot },
    { id: 'profiles', label: 'Profiles', icon: HardDrive },
    { id: 'uploads', label: 'Uploads', icon: Upload },
    { id: 'downloads', label: 'Downloads', icon: Download },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  const sinkFeatureLabel = FEATURE_REGISTRY.find((feature) => feature.id === 'sink')?.label ?? 'Media ingest'

  function openSink() {
    if (computed.resolvedFeatures.sink) appState.view = 'sink'
    else void goToSettingsSection('features')
  }

  const mac = $derived(isMacPlatform(appState.systemState.platform))
  const settingsShortcut = $derived(mac ? '⌘,' : 'Ctrl+,')
  const sidebarShortcut = $derived(mac ? '⌘B' : 'Ctrl+B')
  const refreshShortcut = $derived(mac ? '⌘R' : 'Ctrl+R')
  const newProfileShortcut = $derived(mac ? '⌘N' : 'Ctrl+N')

  function run(action: () => void) {
    open = false
    action()
  }
</script>

<Command.CommandDialog bind:open>
  <Command.CommandInput placeholder="Type a command or search..." />
  <Command.CommandList>
    <Command.CommandEmpty>No results found.</Command.CommandEmpty>

    <Command.CommandGroup heading="Navigation">
      {#each navItems as item (item.id)}
        <Command.CommandItem value={item.label} onSelect={() => run(() => (appState.view = item.id))}>
          <item.icon class="mr-2 h-4 w-4" />
          {item.label}
          {#if item.id === 'settings'}
            <Command.CommandShortcut>{settingsShortcut}</Command.CommandShortcut>
          {/if}
        </Command.CommandItem>
      {/each}
      <!-- Sink stays out of navItems: it's opt-in and hidden from the sidebar
           until enabled, so this entry routes to the feature toggle instead
           of a blank/missing view when it's off. -->
      <Command.CommandItem value={sinkFeatureLabel} keywords={['sink', 'media', 'ingest', 'camera', 'stream']} onSelect={() => run(openSink)}>
        <Radio class="mr-2 h-4 w-4" />
        {sinkFeatureLabel}
      </Command.CommandItem>
    </Command.CommandGroup>

    <Command.CommandSeparator />

    <Command.CommandGroup heading="Settings">
      <Command.CommandItem value="Appearance" keywords={['theme', 'skin', 'dark', 'light', 'colors']} onSelect={() => run(() => goToSettingsSection('appearance', 'settings-appearance'))}>
        <Palette class="mr-2 h-4 w-4" />
        Appearance
      </Command.CommandItem>
      <Command.CommandItem value="Terminal" keywords={['dashboard', 'shell']} onSelect={() => run(() => goToSettingsSection('monitoring', 'settings-terminal'))}>
        <TerminalSquare class="mr-2 h-4 w-4" />
        Terminal
      </Command.CommandItem>
      <Command.CommandItem value="MCP for AI agents" keywords={['mcp', 'model context protocol', 'ai agent', 'claude', 'codex', 'gemini']} onSelect={() => run(() => goToSettingsSection('mcp', 'settings-mcp'))}>
        <Bot class="mr-2 h-4 w-4" />
        MCP for AI agents
      </Command.CommandItem>
      <Command.CommandItem value="About mountOS" keywords={['version', 'platform', 'cli', 'support', 'licenses']} onSelect={() => run(() => goToSettingsSection('about', 'settings-about'))}>
        <Info class="mr-2 h-4 w-4" />
        About mountOS
      </Command.CommandItem>
      <Command.CommandItem value="Support" keywords={['help', 'contact', 'email', 'mailto']} onSelect={() => run(() => goToSettingsSection('about', 'settings-about'))}>
        <Mail class="mr-2 h-4 w-4" />
        Support
      </Command.CommandItem>
    </Command.CommandGroup>

    <Command.CommandSeparator />

    <Command.CommandGroup heading="Actions">
      <Command.CommandItem value="Toggle sidebar" onSelect={() => run(toggleSidebar)}>
        <PanelLeft class="mr-2 h-4 w-4" />
        Toggle sidebar
        <Command.CommandShortcut>{sidebarShortcut}</Command.CommandShortcut>
      </Command.CommandItem>
      <Command.CommandItem value="Refresh running instances" onSelect={() => run(() => refresh())}>
        <RefreshCw class="mr-2 h-4 w-4" />
        Refresh running instances
        <Command.CommandShortcut>{refreshShortcut}</Command.CommandShortcut>
      </Command.CommandItem>
      <Command.CommandItem value="New profile" onSelect={() => run(() => newProfile())}>
        <Plus class="mr-2 h-4 w-4" />
        New profile
        <Command.CommandShortcut>{newProfileShortcut}</Command.CommandShortcut>
      </Command.CommandItem>
      <Command.CommandItem value="New upload" onSelect={() => run(() => { appState.view = 'uploads'; enterUploadCreate() })}>
        <Upload class="mr-2 h-4 w-4" />
        New upload
      </Command.CommandItem>
      <Command.CommandItem value="New download" onSelect={() => run(() => { appState.view = 'downloads'; enterDownloadCreate() })}>
        <Download class="mr-2 h-4 w-4" />
        New download
      </Command.CommandItem>
      <Command.CommandItem
        value="Unmount all"
        disabled={appState.systemState.instances.length === 0}
        onSelect={() => run(requestUnmountAll)}
      >
        <Unplug class="mr-2 h-4 w-4" />
        Unmount all
      </Command.CommandItem>
      <Command.CommandItem
        value="Create diagnostics bundle"
        onSelect={() => run(async () => {
          await createBundle()
          await goToSettingsSection('diagnostics', 'settings-diagnostics-bundle')
        })}
      >
        <FileArchive class="mr-2 h-4 w-4" />
        Create diagnostics bundle
      </Command.CommandItem>
      <Command.CommandItem value="Tips" onSelect={() => run(showTips)}>
        <Lightbulb class="mr-2 h-4 w-4" />
        Tips
      </Command.CommandItem>
      <Command.CommandItem value="Third party licenses" keywords={['oss', 'open source', 'notices']} onSelect={() => run(showLicenses)}>
        <ScrollText class="mr-2 h-4 w-4" />
        Third party licenses
      </Command.CommandItem>
    </Command.CommandGroup>

    {#if appState.profiles.length > 0}
      <Command.CommandSeparator />
      <Command.CommandGroup heading="Profiles">
        {#each appState.profiles as profile (profile.id)}
          <Command.CommandItem
            value="profile {profile.name}"
            onSelect={() => run(() => { selectProfile(profile); appState.view = 'profiles' })}
          >
            <HardDrive class="mr-2 h-4 w-4" />
            {profile.name}
          </Command.CommandItem>
        {/each}
      </Command.CommandGroup>
    {/if}
  </Command.CommandList>
</Command.CommandDialog>
