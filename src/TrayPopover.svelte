<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { FolderOpen, Maximize2, OctagonX, Unplug } from '@lucide/svelte'
  import { Button } from './lib/components/ui/button'
  import { isAbsolutePath } from './lib/cli'
  import { gatewayTargetSummary, healthTone } from './lib/health'
  import { getSystemState, openTarget, showMainWindow, stopGatewayOnly, unmountTarget } from './lib/tauri'
  import { initThemeSync } from './lib/theme.svelte'
  import type { MountInstance, SystemState } from './lib/types'

  // alwaysOnTop keeps this popover visually above the main window even after
  // it loses focus, so opening the main window must hide this one explicitly
  // rather than relying on the blur-to-hide path in src-tauri/src/lib.rs.
  async function openMainWindow() {
    await showMainWindow()
    await getCurrentWindow().hide()
  }

  let systemState = $state<SystemState>({ platform: 'macos', checkOk: false, issues: [], instances: [], cliPathAlternates: [], terminals: [] })
  let loaded = $state(false)
  let busy = $state(false)

  // Themed in the main window; this popover's own webview persists across
  // show/hide cycles, so it must react to both a system-preference change and
  // a theme change made in the main window's Settings (a cross-window
  // localStorage write, which fires 'storage' here but not in the writer),
  // since initThemeSync() wires up both.
  $effect(() => initThemeSync())

  function canOpen(instance: MountInstance) {
    return isAbsolutePath(instance.mountPath)
  }

  async function refresh() {
    try {
      systemState = await getSystemState()
    } catch {
      // Quick-glance surface; detailed errors are reported in the main window.
    } finally {
      loaded = true
    }
  }

  async function runOpen(instance: MountInstance) {
    try {
      await openTarget(instance.mountPath)
    } catch {
      // Quick-glance surface; detailed errors are reported in the main window.
    }
  }

  async function runUnmount(instance: MountInstance) {
    busy = true
    try {
      await unmountTarget(instance.mountPath)
      await refresh()
    } catch {
      // Quick-glance surface; detailed errors are reported in the main window.
    } finally {
      busy = false
    }
  }

  async function runStopGateway(instance: MountInstance) {
    if (instance.pid == null) return
    busy = true
    try {
      await stopGatewayOnly(instance.pid)
      await refresh()
    } catch {
      // Quick-glance surface; detailed errors are reported in the main window.
    } finally {
      busy = false
    }
  }

  $effect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  })
</script>

<svelte:head>
  <title>mountOS</title>
</svelte:head>

<div class="flex h-screen flex-col border border-border bg-card text-card-foreground">
  <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
    <div class="flex items-center gap-2 font-semibold">
      <img src="/logo.png" alt="" width="18" height="18" />
      <span>mountOS</span>
    </div>
    <Button variant="ghost" size="icon" class="h-7 w-7" title="Open mountOS" aria-label="Open mountOS" onclick={openMainWindow}>
      <Maximize2 size={14} aria-hidden="true" />
    </Button>
  </header>

  <div class="flex-1 overflow-y-auto p-1.5">
    {#if !loaded}
      <p class="text-muted-foreground p-6 text-center">Loading…</p>
    {:else if systemState.instances.length === 0}
      <div class="grid gap-3 p-6 text-center">
        <p class="text-muted-foreground">No active mounts.</p>
        <Button type="button" onclick={openMainWindow} class="justify-self-center">
          <Maximize2 size={14} aria-hidden="true" />
          Open mountOS
        </Button>
      </div>
    {:else}
      {#each systemState.instances as instance (instance.key)}
        <div class="flex items-center gap-2.5 border-b border-border p-2 last:border-0">
          <span class="led {healthTone(instance.health)}" title={instance.health} aria-hidden="true"></span>
          <div class="grid min-w-0 flex-1 gap-0.5">
            <strong class="truncate text-sm">{instance.name || instance.volumeId || 'mountOS volume'} <span class="sr-only">({instance.health})</span></strong>
            <span class="mono-label truncate normal-case tracking-normal">
              {instance.kind === 'gateway' ? gatewayTargetSummary(instance.gatewayEndpoints) : instance.mountPath}
            </span>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="outline" size="icon" class="h-7 w-7" title="Open folder" aria-label="Open folder" disabled={busy || !canOpen(instance)} onclick={() => runOpen(instance)}>
              <FolderOpen size={13} aria-hidden="true" />
            </Button>
            {#if instance.kind === 'gateway'}
              <Button
                variant="destructive"
                size="icon"
                class="h-7 w-7"
                title="Stop gateway"
                aria-label="Stop gateway"
                disabled={busy || instance.pid == null}
                onclick={() => runStopGateway(instance)}
              >
                <OctagonX size={13} aria-hidden="true" />
              </Button>
            {:else}
              <Button variant="destructive" size="icon" class="h-7 w-7" title="Unmount" aria-label="Unmount" disabled={busy} onclick={() => runUnmount(instance)}>
                <Unplug size={13} aria-hidden="true" />
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
