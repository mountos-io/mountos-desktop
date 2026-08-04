<script lang="ts">
  import { ChevronLeft, FolderOpen, Network } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    browseGatewayCert,
    browseGatewayKey,
    buildGatewayArgv,
    confirmGatewayView,
    computed,
    exitProfileSubView,
  } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile!)

  const gatewayCommandText = $derived(
    `mountos ${buildGatewayArgv(profile, {
      protocols: computed.gatewayProtocols,
      port: appState.gatewayPort,
      gatewayOnly: appState.gatewayOnly,
      noLoopback: appState.gatewayNoLoopback,
      certPath: appState.gatewayCertPath,
      keyPath: appState.gatewayKeyPath,
    }).join(' ')}`,
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

  <h3 class="flex items-center gap-2 wrap-anywhere"><Network size={19} aria-hidden="true" /> {profile.name}: gateway</h3>

  <form class="grid gap-4" onsubmit={(event) => { event.preventDefault(); void confirmGatewayView() }}>
    <p class="max-w-[70ch] wrap-anywhere">
      Exposes "{profile.volume || profile.name}" over S3/HDFS.
      {appState.gatewayOnly ? 'Runs without a FUSE mount.' : `Combines with this profile's own mount at ${profile.mountPath}.`}
    </p>
    <div class="flex flex-wrap gap-4">
      <Checkbox bind:checked={appState.gatewayS3} label="S3" />
      <Checkbox bind:checked={appState.gatewayHdfs} label="HDFS" />
    </div>
    <div class="grid gap-1.5">
      <Label for="gateway-port">Port (optional)</Label>
      <Input id="gateway-port" bind:value={appState.gatewayPort} placeholder="0 (auto)" />
    </div>
    <div class="flex flex-wrap gap-4">
      <Checkbox bind:checked={appState.gatewayOnly} label="Gateway only (no FUSE mount)" />
      <Checkbox bind:checked={appState.gatewayNoLoopback} label="Bind on all interfaces (requires TLS)" />
    </div>
    {#if appState.gatewayNoLoopback}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label>TLS certificate</Label>
          <div class="flex gap-2">
            <Input value={appState.gatewayCertPath} readonly placeholder="Choose a file" class="flex-1" />
            <Button type="button" onclick={browseGatewayCert} disabled={appState.busy} class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" /> Browse
            </Button>
          </div>
        </div>
        <div class="grid gap-1.5">
          <Label>TLS key</Label>
          <div class="flex gap-2">
            <Input value={appState.gatewayKeyPath} readonly placeholder="Choose a file" class="flex-1" />
            <Button type="button" onclick={browseGatewayKey} disabled={appState.busy} class="shrink-0">
              <FolderOpen size={16} aria-hidden="true" /> Browse
            </Button>
          </div>
        </div>
      </div>
    {/if}
    {#if profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id]}
      <div class="grid gap-1.5">
        <Label for="gateway-secret">Secret access key</Label>
        <Input id="gateway-secret" type="password" bind:value={appState.gatewaySecretValue} autocomplete="current-password" />
      </div>
    {/if}
    {#if appState.gatewayError}
      <CliErrorOutput role="alert" text={appState.gatewayError} command={gatewayCommandText} />
    {/if}
    <CommandPreview label="COMMAND PREVIEW" text={gatewayCommandText}>
      <code>{gatewayCommandText}</code>
    </CommandPreview>
    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={exitProfileSubView}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        class="cyberpunk-skewed-sm"
        disabled={appState.busy || computed.gatewayProtocols.length === 0 || (appState.gatewayNoLoopback && (!appState.gatewayCertPath.trim() || !appState.gatewayKeyPath.trim()))}
      >
        Launch
      </Button>
    </div>
  </form>
</section>
