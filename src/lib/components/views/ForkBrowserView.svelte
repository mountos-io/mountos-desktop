<script lang="ts">
  import { ChevronLeft, ChevronRight, GitBranch, Plus, RefreshCw, RotateCcw, Trash2 } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { focusOnMount } from '$lib/actions'
  import {
    appState,
    buildForkListArgv,
    computed,
    drillIntoFork,
    exitProfileSubView,
    requestForkCreate,
    requestForkDelete,
    requestForkRestore,
    runForkList,
  } from '$lib/app-state.svelte'

  const profile = $derived(computed.selectedProfile!)
  const backTarget = $derived(computed.forkBreadcrumbTrail.length > 1 ? computed.forkBreadcrumbTrail[computed.forkBreadcrumbTrail.length - 2].fid : null)

  // Only auto-fetch when no secret prompt is needed. A profile requiring
  // one would otherwise fire this the instant the view opens, before the
  // user has typed anything, and fail with "secret required" on an empty
  // field. When a secret is needed, the user types it and presses Refresh.
  const needsSecret = $derived(profile.secretRef === 'prompt' || !appState.vaultStatus[profile.id])

  $effect(() => {
    if (!needsSecret && profile.accessKeyId && appState.forks.length === 0) void runForkList()
  })
</script>

<section class="surface corner-brackets m-[22px] p-4 grid gap-4 outline-hidden" tabindex="-1" use:focusOnMount>
  <div class="flex items-center justify-between gap-4">
    <button type="button" class="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onclick={exitProfileSubView}>
      <ChevronLeft size={16} aria-hidden="true" /> Back to profile
    </button>
    <div class="flex items-center gap-2">
      <Button type="button" size="icon" variant="ghost" onclick={runForkList} disabled={appState.forkBusy || !profile.accessKeyId} title="Refresh fork list" aria-label="Refresh fork list">
        <RefreshCw size={15} aria-hidden="true" />
      </Button>
      <Button type="button" size="sm" onclick={() => requestForkCreate(profile)}>
        <Plus size={15} aria-hidden="true" />
        New fork
      </Button>
    </div>
  </div>

  <h3 class="flex items-center gap-2"><GitBranch size={19} aria-hidden="true" /> {profile.name}: forks</h3>

  {#if needsSecret}
    <div class="grid gap-1.5 max-w-sm">
      <Label for="fork-list-secret">Secret access key</Label>
      <Input id="fork-list-secret" type="password" bind:value={appState.forkListSecretValue} autocomplete="current-password" />
    </div>
  {/if}

  <CommandPreview label="COMMAND PREVIEW" text={`mountos ${buildForkListArgv(profile).join(' ')}`}>
    <code>{`mountos ${buildForkListArgv(profile).join(' ')}`}</code>
  </CommandPreview>

  {#if appState.forkError}
    <p class="text-destructive text-sm" role="alert">{appState.forkError}</p>
  {/if}

  <div class="grid gap-2">
    {#if computed.forkBreadcrumbTrail.length > 0}
      <button type="button" class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground w-fit" onclick={() => drillIntoFork(backTarget)}>
        <ChevronLeft size={15} aria-hidden="true" /> Back
      </button>
    {/if}
    {#if appState.forkBusy && appState.forks.length === 0}
      <p class="text-muted-foreground text-sm">Loading forks...</p>
    {:else if needsSecret && appState.forks.length === 0}
      <div class="tech-grid px-7 py-10 text-center">
        <p>Enter the secret access key above, then Refresh to load forks.</p>
      </div>
    {:else if computed.forkChildren.length === 0}
      <div class="tech-grid px-7 py-10 text-center">
        <p>{computed.currentFork ? 'No child forks.' : 'No forks yet.'}</p>
      </div>
    {:else}
      {#each computed.forkChildren as fork (fork.fid)}
        <div class="flex items-center justify-between gap-2 border border-transparent p-2 hover:bg-accent/50">
          <button type="button" class="flex flex-1 min-w-0 items-center gap-2 text-left" onclick={() => drillIntoFork(fork.fid)}>
            <strong class="truncate">{fork.name || 'main'}</strong>
            {#if fork.inactive}<Badge variant="warning">Deleted</Badge>{/if}
            {#if fork.isTemporary}<Badge>Sandbox</Badge>{/if}
            <span class="flex items-center gap-1 text-muted-foreground text-sm ml-auto">
              {#if fork.childrenCount}{fork.childrenCount} {fork.childrenCount === 1 ? 'child' : 'children'}{/if}
              <ChevronRight size={15} aria-hidden="true" />
            </span>
          </button>
          <div class="flex items-center gap-1 shrink-0">
            {#if fork.inactive}
              <Button type="button" size="icon" variant="outline" title="Restore fork" aria-label="Restore fork" onclick={() => requestForkRestore(fork)}>
                <RotateCcw size={15} aria-hidden="true" />
              </Button>
            {:else}
              <Button type="button" size="icon" variant="destructive" title="Delete fork" aria-label="Delete fork" onclick={() => requestForkDelete(fork)}>
                <Trash2 size={15} aria-hidden="true" />
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</section>
