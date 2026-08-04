<script lang="ts">
  import { getVersion } from '@tauri-apps/api/app'
  import { checkForUpdate, type UpdateState } from '$lib/updates'
  import { openExternalUrl } from '$lib/tauri'
  import {
    Activity,
    Bot,
    ChevronDown,
    ChevronUp,
    Database,
    FileArchive,
    FolderOpen,
    Info,
    Mail,
    Monitor,
    Moon,
    Palette,
    RefreshCw,
    ScrollText,
    ShieldAlert,
    ShieldCheck,
    Sun,
    ToggleRight,
    TriangleAlert,
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Select } from '$lib/components/ui/select'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Badge } from '$lib/components/ui/badge'
  import Callout from '$lib/components/Callout.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import InfoTip from '$lib/components/shared/InfoTip.svelte'
  import { focusOnMount } from '$lib/actions'
  import { themeState, setTheme, setSkin, setFontSize, setGrayscale, setBrightness } from '$lib/theme.svelte'
  import type { Theme, FontSize } from '$lib/theme.svelte'
  import { presetsForMode, defaultSkin } from '$lib/themes'
  import type { Backend } from '$lib/types'
  import { FEATURE_REGISTRY } from '$lib/features'
  import type { SettingsTab } from '$lib/app-state.svelte'
  import {
    appState,
    browseDefaultCacheDir,
    changeAllowForkForceDelete,
    changeAllowUnmountForce,
    changeDefaultBackend,
    changeDefaultCacheDir,
    changeDefaultCacheSize,
    changeDefaultDiscoveryUrl,
    changePollSeconds,
    changeTerminal,
    checkMcpStatus,
    clearCliPathOverride,
    computed,
    createBundle,
    DEFAULT_POLL_SECONDS,
    installMcp,
    openBundle,
    pickCliPathOverride,
    POLL_CHOICES,
    refresh,
    setFeatureEnabled,
    setSkipUnmountConfirm,
    showLicenses,
    toggleDefaultCacheSizeAuto,
    uninstallMcp,
    verifyCliBinary,
  } from '$lib/app-state.svelte'

  const themeOptions: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ]

  const fontSizeOptions: Array<{ value: FontSize; label: string }> = [
    { value: 'standard', label: 'Standard' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
    { value: 'extra-large', label: 'Extra Large' },
    { value: 'jumbo', label: 'Jumbo' },
  ]

  const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sun }> = [
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'mounting', label: 'Mounting defaults', icon: Database },
    { id: 'monitoring', label: 'Monitoring & dashboard', icon: Activity },
    { id: 'actions', label: 'Actions', icon: ShieldAlert },
    { id: 'features', label: 'Optional features', icon: ToggleRight },
    { id: 'mcp', label: 'MCP for AI agents', icon: Bot },
    { id: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck },
    { id: 'about', label: 'About mountOS', icon: Info },
  ]

  // Shared with the command palette / Tips dialog (appState.settingsTab), not
  // local state, so "jump to a Settings section" can select the right tab
  // from outside this component.
  const activeTab = $derived(appState.settingsTab)

  // Icon-rail collapse tracks this panel's own measured width, not the window's,
  // so it folds correctly whether the primary app sidebar is expanded or collapsed.
  let navWidth = $state(0)
  const navCollapsed = $derived(navWidth > 0 && navWidth < 640)

  function focusTab(tab: SettingsTab) {
    appState.settingsTab = tab
  }

  function handleTabKeydown(event: KeyboardEvent, index: number) {
    const lastIndex = SETTINGS_TABS.length - 1
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1
    else if (event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = lastIndex
    if (nextIndex === undefined) return
    event.preventDefault()
    focusTab(SETTINGS_TABS[nextIndex].id)
    const nextButton = document.getElementById(`settings-tab-${SETTINGS_TABS[nextIndex].id}`)
    nextButton?.focus()
  }

  // Discoverability for the panel's own auto-hide scrollbar (see .overflow-y-auto
  // in app.css, transparent until hover): an edge fade + chevron hints that there
  // is more content before the user has to hover the track to find out.
  let scrollEl = $state<HTMLDivElement | undefined>()
  let canScrollUp = $state(false)
  let canScrollDown = $state(false)

  function updateScrollHints() {
    if (!scrollEl) return
    canScrollUp = scrollEl.scrollTop > 4
    canScrollDown = scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 4
  }

  function scrollPanel(direction: -1 | 1) {
    scrollEl?.scrollBy({ top: direction * 240, behavior: 'smooth' })
  }

  $effect(() => {
    activeTab
    if (!scrollEl) return
    scrollEl.scrollTop = 0
    updateScrollHints()
  })

  $effect(() => {
    if (!scrollEl) return
    const observer = new ResizeObserver(() => updateScrollHints())
    observer.observe(scrollEl)
    return () => observer.disconnect()
  })

  let cliPathValidating = $state(false)

  async function browseCliPathOverride() {
    cliPathValidating = true
    try {
      await pickCliPathOverride()
    } finally {
      cliPathValidating = false
    }
  }

  const backendOptions = $derived(computed.backends.map((backend) => ({ value: backend, label: backend })))
  const terminalOptions = $derived([
    { value: '', label: 'System default' },
    ...appState.systemState.terminals.map((option) => ({ value: option.id, label: option.label })),
  ])
  const pollOptions = $derived(
    POLL_CHOICES.map((seconds) => ({
      value: String(seconds),
      label: seconds === 0 ? 'Off' : `${seconds}s${seconds === DEFAULT_POLL_SECONDS ? ' (default)' : ''}`,
    })),
  )

  // Filtered by the live resolved mode (not just an explicit Light/Dark
  // pick) so the picker still works under "System", and stays correct if
  // the OS appearance flips while this view is open.
  const skinPresets = $derived(presetsForMode(themeState.resolvedMode))
  const defaultSkinName = $derived(defaultSkin(themeState.resolvedMode))

  const cacheSizeAuto = $derived(!appState.settings.defaultCacheSize)

  // Update availability. Additive and non-fatal: an unreachable distribution host or an
  // air-gapped machine shows no row rather than an error.
  let appVersion = $state('')
  let update = $state<UpdateState | null>(null)

  $effect(() => {
    let cancelled = false
    void (async () => {
      try {
        const v = await getVersion()
        if (cancelled) return
        appVersion = v
        const state = await checkForUpdate(v)
        if (!cancelled) update = state
      } catch {
        /* no row */
      }
    })()
    return () => { cancelled = true }
  })
</script>

<section
  class="corner-brackets surface m-[22px] flex min-h-0 flex-1 outline-hidden"
  tabindex="-1"
  use:focusOnMount
  bind:clientWidth={navWidth}
>
  <div
    aria-label="Settings categories"
    aria-orientation="vertical"
    role="tablist"
    class="settings-nav flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2"
    class:w-[3.25rem]={navCollapsed}
    class:w-52={!navCollapsed}
  >
    {#each SETTINGS_TABS as tab, index (tab.id)}
      <button
        type="button"
        id={`settings-tab-${tab.id}`}
        role="tab"
        aria-selected={activeTab === tab.id}
        aria-controls="settings-panel"
        tabindex={activeTab === tab.id ? 0 : -1}
        title={navCollapsed ? tab.label : undefined}
        class="settings-tab-button flex items-center gap-2.5 border border-transparent px-3 py-2 text-left text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        class:justify-center={navCollapsed}
        class:px-0={navCollapsed}
        class:bg-accent={activeTab === tab.id}
        class:text-foreground={activeTab === tab.id}
        onclick={() => focusTab(tab.id)}
        onkeydown={(event) => handleTabKeydown(event, index)}
      >
        <tab.icon size={17} aria-hidden="true" class="shrink-0" />
        {#if !navCollapsed}<span>{tab.label}</span>{/if}
      </button>
    {/each}
  </div>

  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="settings-scroll-fade settings-scroll-fade-top" class:visible={canScrollUp}></div>
    {#if canScrollUp}
      <button type="button" class="settings-scroll-chevron settings-scroll-chevron-top" tabindex="-1" aria-hidden="true" onclick={() => scrollPanel(-1)}>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
    {/if}

    <div
      bind:this={scrollEl}
      id="settings-panel"
      role="tabpanel"
      aria-labelledby={`settings-tab-${activeTab}`}
      class="settings-scroll min-h-0 min-w-0 flex-1 overflow-y-auto p-4 grid grid-cols-[minmax(0,1fr)] gap-5 content-start"
      onscroll={updateScrollHints}
    >
      {#if activeTab === 'appearance'}
  <div class="grid gap-3" id="settings-appearance">
    <h3>Appearance</h3>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong>Theme</strong><InfoTip text="Follows the system appearance until you pick Light or Dark." /></span>
      <div class="flex gap-1.5" role="group" aria-label="Theme">
        {#each themeOptions as option (option.value)}
          <Button type="button" size="sm" variant={themeState.theme === option.value ? 'primary' : 'outline'} aria-pressed={themeState.theme === option.value} onclick={() => setTheme(option.value)}>
            <option.icon size={15} aria-hidden="true" />
            {option.label}
          </Button>
        {/each}
      </div>
    </div>
    <div class="grid gap-1.5">
      <span class="inline-flex items-center gap-1"><strong>Skin</strong><InfoTip text="Named color palette for the current mode." /></span>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Skin">
        {#each skinPresets as preset (preset.name)}
          {@const isDefault = preset.name === defaultSkinName}
          {@const active = isDefault ? !themeState.skin || themeState.skin === defaultSkinName : themeState.skin === preset.name}
          <button
            type="button"
            class="skin-swatch {active ? 'ring-2 ring-primary' : ''}"
            style="--sw-bg: {preset.colors.background}; --sw-fg: {preset.colors.primary};"
            onclick={() => setSkin(isDefault ? '' : preset.name)}
            aria-pressed={active}
            title={isDefault ? 'mountOS (default)' : preset.name}
          >
            <span class="sw-dot"></span>
            <span class="sw-label">{isDefault ? 'mountOS' : preset.name.replace(/ (Light|Dark)$/, '')}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="grid gap-1.5">
      <span class="inline-flex items-center gap-1"><strong>Font size</strong><InfoTip text="Scales all text in the app." /></span>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Font size">
        {#each fontSizeOptions as option (option.value)}
          <Button type="button" size="sm" variant={themeState.fontSize === option.value ? 'primary' : 'outline'} aria-pressed={themeState.fontSize === option.value} onclick={() => setFontSize(option.value)}>
            {option.label}
          </Button>
        {/each}
      </div>
    </div>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-grayscale-label">Grayscale</strong><InfoTip text="Reduces color for low-light comfort." /></span>
      <Checkbox checked={themeState.grayscale} onchange={(e) => setGrayscale(e.currentTarget.checked)} aria-labelledby="settings-grayscale-label" />
    </div>
    <div class="grid gap-1.5">
      <div class="flex items-center justify-between gap-4">
        <span class="inline-flex items-center gap-1"><strong>Brightness</strong><InfoTip text="Dims or brightens the whole app." /></span>
        <div class="flex items-center gap-2">
          <span class="mono-label">{themeState.brightness}%</span>
          <!-- Next to the percentage, not sharing the slider's own row: that
               row is the only element there, so Reset mounting/unmounting no
               longer changes the slider's width. It used to sit alongside
               the slider in a flex row, visibly shrinking (and un-shrinking)
               the track and jumping the thumb under the cursor mid-drag. -->
          {#if themeState.brightness !== 100}
            <Button type="button" size="sm" variant="ghost" onclick={() => setBrightness(100)}>Reset</Button>
          {/if}
        </div>
      </div>
      <input
        type="range"
        min="50"
        max="150"
        step="5"
        value={themeState.brightness}
        oninput={(e) => setBrightness(Number(e.currentTarget.value))}
        aria-label="Brightness"
        class="w-full accent-primary"
      />
    </div>
  </div>
      {:else if activeTab === 'mounting'}
  <div class="grid gap-3">
    <h3>Mounting defaults</h3>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-default-backend-label">Default backend</strong><InfoTip text="Used for new profiles; Auto follows the CLI's platform order." /></span>
      <Select
        options={backendOptions}
        value={appState.settings.defaultBackend}
        onchange={(value) => changeDefaultBackend(value as Backend)}
        ariaLabelledby="settings-default-backend-label"
        class="w-48"
      />
    </div>
    <div class="grid gap-1.5">
      <span class="inline-flex items-center gap-1"><strong id="settings-default-discovery-url-label">Default discovery URL</strong><InfoTip text="Seeds new profiles only; existing ones stay unchanged." /></span>
      <Input
        type="text"
        placeholder="https://hub.example.com"
        value={appState.settings.defaultDiscoveryUrl ?? ''}
        onchange={(e) => changeDefaultDiscoveryUrl(e.currentTarget.value)}
        aria-labelledby="settings-default-discovery-url-label"
      />
    </div>
    <div class="grid gap-1.5">
      <span class="inline-flex items-center gap-1"><strong id="settings-default-cache-dir-label">Default disk cache directory</strong><InfoTip text="Seeds new profiles only. Blank uses the CLI's own ~/.mountOS/cache. Shared across every volume and fork is safe, mountos already isolates each one under its own subfolder." /></span>
      <div class="flex gap-2">
        <Input
          type="text"
          placeholder="~/.mountOS/cache"
          value={appState.settings.defaultCacheDir ?? ''}
          onchange={(e) => changeDefaultCacheDir(e.currentTarget.value)}
          aria-labelledby="settings-default-cache-dir-label"
          class="flex-1"
        />
        <Button type="button" onclick={browseDefaultCacheDir} title="Choose a folder" class="shrink-0">
          <FolderOpen size={16} aria-hidden="true" />
          Browse
        </Button>
      </div>
    </div>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-default-cache-size-label">Default disk cache size</strong><InfoTip text="Seeds new profiles only. Accepts MiB/GiB/TiB, e.g. 100G." /></span>
      <div class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1">
          <Checkbox checked={cacheSizeAuto} onchange={(e) => toggleDefaultCacheSizeAuto(e.currentTarget.checked)} label="Auto" />
          <InfoTip text="Adjusted between 10-100GB based on free disk." />
        </span>
        <Input
          type="text"
          placeholder="100G"
          value={appState.settings.defaultCacheSize ?? ''}
          onchange={(e) => changeDefaultCacheSize(e.currentTarget.value)}
          disabled={cacheSizeAuto}
          aria-labelledby="settings-default-cache-size-label"
          class="w-24"
        />
      </div>
    </div>
  </div>
      {:else if activeTab === 'monitoring'}
  <div class="grid gap-3">
    <h3>Monitoring &amp; dashboard</h3>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-refresh-interval-label">Refresh interval</strong><InfoTip text="How often mounts refresh. Off disables auto-refresh; use the Refresh button instead." /></span>
      <Select
        options={pollOptions}
        value={String(appState.settings.pollSeconds ?? DEFAULT_POLL_SECONDS)}
        onchange={(value) => changePollSeconds(Number(value))}
        ariaLabelledby="settings-refresh-interval-label"
        class="w-48"
      />
    </div>
    <div class="flex items-center justify-between gap-4" id="settings-terminal">
      <span class="inline-flex items-center gap-1"><strong id="settings-terminal-label">Terminal</strong><InfoTip text="Where the dashboard opens. Falls back to the system default if uninstalled." /></span>
      <Select
        options={terminalOptions}
        value={appState.settings.terminal ?? ''}
        onchange={(value) => changeTerminal(value)}
        ariaLabelledby="settings-terminal-label"
        class="w-48"
      />
    </div>
  </div>
      {:else if activeTab === 'actions'}
  <div class="grid gap-3">
    <h3>Actions</h3>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1">
        <strong id="settings-skip-unmount-confirm-label">Skip unmount confirmation</strong>
        <InfoTip text="Skips the confirmation dialog on Unmount and Unmount all." />
        <Badge variant="warning"><TriangleAlert size={12} aria-hidden="true" />Not recommended</Badge>
      </span>
      <Checkbox
        checked={appState.skipUnmountConfirm}
        onchange={(e) => setSkipUnmountConfirm(e.currentTarget.checked)}
        aria-labelledby="settings-skip-unmount-confirm-label"
      />
    </div>
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-allow-force-fork-delete-label">Allow force fork delete</strong><InfoTip text="Adds --force to fork delete, removing the whole subtree from the shared volume." /></span>
      <Checkbox
        checked={appState.settings.allowForkForceDelete}
        onchange={(e) => changeAllowForkForceDelete(e.currentTarget.checked)}
        aria-labelledby="settings-allow-force-fork-delete-label"
      />
    </div>
    {#if appState.settings.allowForkForceDelete}
      <Callout>--force fork delete acts on the shared volume, not just this profile, and also removes the fork's entire subtree. Deleting a fork is recoverable only within its grace period.</Callout>
    {/if}
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong id="settings-allow-force-unmount-label">Allow force unmount</strong><InfoTip text="Adds a Force option to the unmount prompt, for unmounting a mount an app or terminal is still using." /></span>
      <Checkbox
        checked={appState.settings.allowUnmountForce}
        onchange={(e) => changeAllowUnmountForce(e.currentTarget.checked)}
        aria-labelledby="settings-allow-force-unmount-label"
      />
    </div>
    {#if appState.settings.allowUnmountForce}
      <Callout>Forcing disconnects whatever is still using the mount. Apps reading or writing files there will get an error and lose unsaved work. Without it, a mount that is in use stays mounted and keeps working.</Callout>
    {/if}
  </div>
      {:else if activeTab === 'features'}
  <div class="grid gap-3" id="settings-optional-features">
    <h3>Optional features</h3>
    {#each FEATURE_REGISTRY as feature (feature.id)}
      <div class="flex items-center justify-between gap-4">
        <span class="grid gap-0.5">
          <strong id={`settings-feature-${feature.id}-label`}>{feature.label}</strong>
          <span class="text-sm text-muted-foreground">{feature.description}</span>
        </span>
        <Checkbox
          checked={computed.resolvedFeatures[feature.id] ?? feature.defaultEnabled}
          onchange={(e) => setFeatureEnabled(feature.id, e.currentTarget.checked)}
          aria-labelledby={`settings-feature-${feature.id}-label`}
        />
      </div>
    {/each}
  </div>
      {:else if activeTab === 'about'}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-3" id="settings-about">
    <h3>About mountOS</h3>
  <div class="flex items-center justify-between gap-4">
    <span><strong>Platform</strong></span>
    <span class="mono-label">{appState.systemState.platform}</span>
  </div>
  <div class="flex items-center justify-between gap-4">
    <span><strong>CLI version</strong></span>
    <span class="mono-label">{appState.systemState.cliVersion ?? 'unavailable'}</span>
  </div>
  <div class="flex items-center justify-between gap-4">
    <span><strong>Desktop version</strong></span>
    <span class="mono-label">{appVersion || 'unavailable'}</span>
  </div>
  {#if update?.available}
    <!-- Desktop ships inside the platform installer, so what is newer is the INSTALLER,
         which also carries the CLI and (on macOS) the FSKit extension. Saying "a newer
         installer" rather than "Desktop is outdated" is the accurate claim. -->
    <div class="flex items-center justify-between gap-4">
      <span><strong>Update available</strong></span>
      <span class="flex items-center gap-2">
        <span class="mono-label">{update.available}</span>
        {#if update.downloadUrl}
          <button type="button" class="link-button" onclick={() => openExternalUrl(update!.downloadUrl!)}>Download installer</button>
        {/if}
      </span>
    </div>
  {/if}
  <div class="flex min-w-0 items-center justify-between gap-4">
    <span class="shrink-0"><strong>CLI path</strong></span>
    {#if appState.systemState.cliPath}
      <code class="min-w-0 wrap-anywhere text-right">{appState.systemState.cliPath}</code>
    {:else}
      <span class="flex min-w-0 items-center gap-1.5 text-warning">
        <TriangleAlert size={14} aria-hidden="true" class="shrink-0" />
        Not found on PATH, pin it below
      </span>
    {/if}
  </div>

  {#if appState.systemState.cliPath}
    <div class="flex items-center justify-between gap-4">
      <span class="inline-flex items-center gap-1"><strong>Signature</strong><InfoTip text="Checks the binary's actual code-signing signature, not just whether --version prints mountos (which a spoofed binary could fake too)." /></span>
      <span class="flex items-center gap-2">
        {#if appState.cliSignatureStatus}
          <Badge variant={appState.cliSignatureStatus.verified ? 'success' : 'warning'}>
            {appState.cliSignatureStatus.verified ? 'Verified' : 'Not verified'}
          </Badge>
        {/if}
        <Button type="button" size="sm" variant="outline" onclick={verifyCliBinary} disabled={appState.cliSignatureChecking}>
          <ShieldCheck size={14} aria-hidden="true" />
          {appState.cliSignatureChecking ? 'Verifying…' : appState.cliSignatureStatus ? 'Re-verify' : 'Verify'}
        </Button>
      </span>
    </div>
    {#if appState.cliSignatureStatus}
      <p class="text-sm text-muted-foreground">{appState.cliSignatureStatus.detail}</p>
    {/if}
  {/if}

  {#if appState.systemState.cliPathAlternates.length}
    <Callout>
      {appState.systemState.cliPathAlternates.length} other mountos {appState.systemState.cliPathAlternates.length === 1 ? 'binary was' : 'binaries were'} found on PATH and ignored:
      {appState.systemState.cliPathAlternates.join(', ')}. Pin the one you want below to stop relying on PATH order.
    </Callout>
  {/if}

  <div class="grid grid-cols-[minmax(0,1fr)] gap-1.5">
    <span class="inline-flex items-center gap-1"><strong id="settings-cli-path-override-label">Pin CLI path</strong><InfoTip text="Pick the mountos binary from disk." /></span>
    <div class="flex min-w-0 items-start gap-2">
      <code class="min-w-0 flex-1 wrap-anywhere" aria-labelledby="settings-cli-path-override-label">{appState.settings.cliPathOverride ?? 'Using PATH lookup'}</code>
      {#if appState.settings.cliPathOverride}
        <Button type="button" variant="outline" onclick={clearCliPathOverride} class="shrink-0">Clear</Button>
      {/if}
      <Button type="button" onclick={browseCliPathOverride} disabled={cliPathValidating} class="shrink-0">
        <FolderOpen size={16} aria-hidden="true" />
        {cliPathValidating ? 'Validating…' : 'Browse'}
      </Button>
    </div>
  </div>
  <div class="flex items-center justify-between gap-4">
    <span><strong>Third party licenses</strong></span>
    <Button type="button" variant="outline" onclick={showLicenses}>
      <ScrollText size={16} aria-hidden="true" />
      View
    </Button>
  </div>
  <div class="flex items-center justify-between gap-4">
    <span><strong>Support</strong></span>
    <Button type="button" variant="outline" href="mailto:support@mountos.io">
      <Mail size={16} aria-hidden="true" />
      support@mountos.io
    </Button>
  </div>
  </div>
      {:else if activeTab === 'mcp'}
  <div class="grid gap-3" id="settings-mcp">
  <div class="flex items-start justify-between gap-4">
    <h3 class="flex items-center gap-2"><Bot size={19} aria-hidden="true" /> MCP for AI agents</h3>
    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" onclick={checkMcpStatus} disabled={appState.busy}>
        <RefreshCw size={16} aria-hidden="true" />
        Check status
      </Button>
      <Button type="button" onclick={installMcp} disabled={appState.busy}>Install</Button>
      <Button type="button" variant="destructive" onclick={uninstallMcp} disabled={appState.busy}>Uninstall</Button>
    </div>
  </div>
  <p>Registers this mountos binary as a read-only Model Context Protocol server for Claude Desktop, Claude Code, Codex and Gemini, so an AI agent can inspect mounts, stats and diagnostics without file access.</p>
  {#if appState.mcpStatusText}
    <CommandPreview label="MCP STATUS" text={appState.mcpStatusText}>
      <pre class="m-0 whitespace-pre-wrap break-words"><code>{appState.mcpStatusText}</code></pre>
    </CommandPreview>
  {/if}
  </div>
      {:else if activeTab === 'diagnostics'}
  <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
  <div class="flex items-start justify-between gap-4">
    <h3 class="flex items-center gap-2"><ShieldCheck size={19} aria-hidden="true" /> Diagnostics</h3>
    <div class="flex flex-wrap items-center gap-2">
      <Badge variant={appState.systemState.checkOk ? 'success' : 'warning'}>{appState.systemState.checkOk ? 'Ready' : 'Needs attention'}</Badge>
      <Button type="button" onclick={() => refresh()} disabled={appState.busy} title="Re-run mountos check --json">
        <RefreshCw size={16} aria-hidden="true" />
        Run check
      </Button>
    </div>
  </div>

  <!-- Setup problems are the actionable half of the readiness check, so they
       stay on screen. The rest of the old Health page was a dump of what the
       bundle already contains. -->
  {#if appState.systemState.issues.length}
    <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
      {#each appState.systemState.issues as issue}
        <article class="flex min-w-0 items-start gap-3">
          <TriangleAlert size={18} class={issue.severity === 'error' ? 'text-destructive' : issue.severity === 'warning' ? 'text-warning' : 'text-muted-foreground'} aria-hidden="true" />
          <!-- Titles, details and fix commands come from `mountos check` and
               routinely name paths. wrap-anywhere is inherited by all three,
               and it also shrinks this flex item's min-content width so the
               article can hold them. -->
          <div class="min-w-0 wrap-anywhere">
            <strong>{issue.title}</strong>
            {#if issue.detail}<p>{issue.detail}</p>{/if}
            {#if issue.fixCommand}<code>{issue.fixCommand}</code>{/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <div class="flex items-center justify-between gap-4" id="settings-diagnostics-bundle">
    <span class="inline-flex items-center gap-1"><strong>Diagnostics bundle</strong><InfoTip text="Writes a JSON file with CLI info, check/list output, and saved profiles." /></span>
    <Button type="button" onclick={createBundle} disabled={appState.busy}>
      <FileArchive size={16} aria-hidden="true" />
      Create
    </Button>
  </div>
  {#if appState.diagnosticsBundle}
    <div class="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <span class="mono-label">BUNDLE</span>
      <div class="flex min-w-0 items-center justify-between gap-2.5">
        <code class="min-w-0 break-all">{appState.diagnosticsBundle.path}</code>
        <Button type="button" onclick={openBundle} disabled={appState.busy} class="shrink-0">
          <FolderOpen size={16} aria-hidden="true" />
          Open
        </Button>
      </div>
    </div>
  {/if}
  </div>
      {/if}
    </div>

    <div class="settings-scroll-fade settings-scroll-fade-bottom" class:visible={canScrollDown}></div>
    {#if canScrollDown}
      <button type="button" class="settings-scroll-chevron settings-scroll-chevron-bottom" tabindex="-1" aria-hidden="true" onclick={() => scrollPanel(1)}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    {/if}
  </div>
</section>

<style>
  .skin-swatch {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--sw-bg);
    cursor: pointer;
    transition: transform 0.15s;
  }

  .skin-swatch:hover {
    transform: scale(1.05);
  }

  .skin-swatch:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .sw-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--sw-fg);
    border: 1px solid color-mix(in oklch, var(--sw-fg) 60%, transparent);
  }

  .sw-label {
    font-size: 1rem;
    font-weight: 500;
    color: var(--sw-fg);
    white-space: nowrap;
  }

  /* Discoverability hint for .overflow-y-auto's own auto-hide scrollbar
     (transparent thumb until hover, see app.css): a soft edge fade plus a
     click-to-scroll chevron, shown only while there is more content past
     that edge. Native wheel/trackpad/keyboard scrolling is unaffected. */
  .settings-scroll-fade {
    position: absolute;
    left: 0;
    right: 0;
    height: 28px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease-out;
    z-index: 1;
  }

  .settings-scroll-fade-top {
    top: 0;
    background: linear-gradient(to bottom, var(--card), transparent);
  }

  .settings-scroll-fade-bottom {
    bottom: 0;
    background: linear-gradient(to top, var(--card), transparent);
  }

  .settings-scroll-fade.visible {
    opacity: 1;
  }

  .settings-scroll-chevron {
    position: absolute;
    left: 50%;
    z-index: 2;
    display: flex;
    width: 28px;
    height: 16px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transform: translateX(-50%);
    transition: color 0.15s ease-out;
  }

  .settings-scroll-chevron:hover {
    color: var(--foreground);
  }

  .settings-scroll-chevron-top {
    top: 2px;
  }

  .settings-scroll-chevron-bottom {
    bottom: 2px;
  }
</style>
