<script lang="ts">
  import ScrollText from '@lucide/svelte/icons/scroll-text'
  import Search from '@lucide/svelte/icons/search'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Badge } from '$lib/components/ui/badge'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import { cn } from '$lib/utils'
  import { appState, hideLicenses, setLicensesKind } from '$lib/app-state.svelte'
  import { openExternalUrl } from '$lib/tauri'
  import { showErrorToast } from '$lib/toast.svelte'
  import type { LicenseGroup } from '$lib/types'

  interface LicenseRow {
    key: string
    pkgName: string
    pkgVersion: string
    repository: string | null
    license: LicenseGroup
  }

  let query = $state('')
  let selectedKey = $state('')

  const active = $derived(appState.licensesData[appState.licensesKind])

  const rows = $derived.by(() => {
    const licenses = active?.licenses ?? []
    const result: LicenseRow[] = []
    licenses.forEach((license, groupIndex) => {
      license.packages.forEach((pkg, pkgIndex) => {
        result.push({
          key: `${groupIndex}-${pkgIndex}`,
          pkgName: pkg.name,
          pkgVersion: pkg.version,
          repository: pkg.repository,
          license,
        })
      })
    })
    result.sort((a, b) => a.pkgName.localeCompare(b.pkgName) || a.pkgVersion.localeCompare(b.pkgVersion))
    return result
  })

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (row) =>
        row.pkgName.toLowerCase().includes(q) ||
        row.license.id.toLowerCase().includes(q) ||
        row.license.name.toLowerCase().includes(q),
    )
  })

  const selected = $derived(filtered.find((row) => row.key === selectedKey) ?? filtered[0])

  $effect(() => {
    if (!filtered.some((row) => row.key === selectedKey)) {
      selectedKey = filtered[0]?.key ?? ''
    }
  })

  async function openRepository(url: string) {
    try {
      await openExternalUrl(url)
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Failed to open link')
    }
  }
</script>

<Dialog.Root bind:open={() => appState.licensesOpen, (open) => { if (!open) hideLicenses() }}>
  <Dialog.Content class="sm:max-w-5xl" aria-describedby={undefined}>
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2"><ScrollText size={20} aria-hidden="true" /> Third Party Licenses</Dialog.Title>
    </Dialog.Header>

    <div class="grid gap-3">
      <div class="flex items-center gap-2">
        <Button type="button" size="sm" variant={appState.licensesKind === 'rust' ? 'primary' : 'outline'} aria-pressed={appState.licensesKind === 'rust'} onclick={() => setLicensesKind('rust')}>Rust</Button>
        <Button type="button" size="sm" variant={appState.licensesKind === 'js' ? 'primary' : 'outline'} aria-pressed={appState.licensesKind === 'js'} onclick={() => setLicensesKind('js')}>JavaScript</Button>
      </div>
      <div class="relative">
        <Search size={15} aria-hidden="true" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <span class="sr-only">Search licenses</span>
        <Input bind:value={query} placeholder="Search by package or license" class="pl-8" />
      </div>

      {#if appState.licensesLoading}
        <div class="grid grid-cols-[minmax(0,220px)_1fr] gap-3 h-[55vh]" role="status" aria-busy="true" aria-label="Loading licenses">
          <div class="grid gap-1 content-start overflow-auto border border-border p-1">
            {#each { length: 8 } as _, i (i)}
              <div class="grid gap-1.5 px-2 py-1.5">
                <Skeleton class="h-3.5 w-24" />
                <Skeleton class="h-3 w-16" />
              </div>
            {/each}
          </div>
          <div class="grid gap-3 content-start overflow-auto border border-border p-3">
            <div class="flex items-center gap-2">
              <Skeleton class="h-4 w-40" />
              <Skeleton class="h-4 w-14" />
            </div>
            <div class="grid gap-2">
              {#each { length: 10 } as _, i (i)}
                <Skeleton class="h-3 {i % 3 === 2 ? 'w-2/3' : 'w-full'}" />
              {/each}
            </div>
          </div>
        </div>
      {:else if appState.licensesError}
        <p class="text-base text-destructive">{appState.licensesError}</p>
      {:else if filtered.length === 0}
        <p class="text-base text-muted-foreground wrap-anywhere">{rows.length ? `No packages match "${query}".` : 'No license data available.'}</p>
      {:else}
        <div class="grid grid-cols-[minmax(0,220px)_1fr] gap-3 h-[55vh]">
          <div class="grid gap-1 content-start overflow-auto border border-border p-1">
            {#each filtered as row (row.key)}
              <button
                type="button"
                class={cn(
                  'grid gap-0.5 border border-transparent px-2 py-1.5 text-left text-base hover:bg-accent',
                  selected?.key === row.key && 'border-border bg-accent',
                )}
                aria-pressed={selected?.key === row.key}
                onclick={() => (selectedKey = row.key)}
              >
                <span class="truncate font-medium">{row.pkgName}</span>
                <span class="flex items-center gap-1 text-muted-foreground">
                  <Badge variant="outline">{row.license.id}</Badge>
                  <Badge variant="outline">{row.pkgVersion}</Badge>
                </span>
              </button>
            {/each}
          </div>
          <div class="grid gap-2 content-start overflow-auto border border-border p-3">
            {#if selected}
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="text-base font-medium">{selected.pkgName}</span>
                  <Badge variant="outline">{selected.pkgVersion}</Badge>
                  <Badge variant="outline">{selected.license.id}</Badge>
                </div>
                {#if selected.repository}
                  <a
                    href={selected.repository}
                    class="min-w-0 break-words text-base text-muted-foreground hover:underline"
                    onclick={(event) => {
                      event.preventDefault()
                      void openRepository(selected.repository!)
                    }}
                  >{selected.repository}</a>
                {/if}
              </div>
              <pre class="m-0 whitespace-pre-wrap break-words border border-border bg-muted p-2 text-base"><code>{selected.license.text}</code></pre>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={hideLicenses}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
