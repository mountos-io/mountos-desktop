<script lang="ts">
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import ConfigSection from './ConfigSection.svelte'

  let { data, title }: { data: Record<string, unknown>; title?: string } = $props()

  // "accessId" -> "access Id" -> "access id" -> "Access id": split on the
  // lower-to-upper boundary, lowercase every token, then capitalize only the
  // label's own first character (not each token).
  function humanizeKey(key: string): string {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
  }

  function formatPrimitive(value: unknown): string {
    if (value === null || value === undefined || value === '') return 'N/A'
    return String(value)
  }

  const entries = $derived(Object.entries(data))
  const primitives = $derived(entries.filter(([, value]) => value === null || typeof value !== 'object'))
  const arrays = $derived(entries.filter(([, value]) => Array.isArray(value)))
  const nested = $derived(entries.filter(([, value]) => value !== null && typeof value === 'object' && !Array.isArray(value)))
</script>

<div class="grid gap-2.5">
  <!-- Only ever set on a recursive (nested-object) call, never the root,
       since the border+top-padding is what makes a nested category read as a new
       section instead of just another row trailing the parent's own list. -->
  {#if title}
    <p class="mono-label border-t border-border/40 pt-2.5">
      <span class="text-primary">⌜</span> {title} <span class="text-primary">⌟</span>
    </p>
  {/if}

  {#if primitives.length}
    <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
      {#each primitives as [key, value] (key)}
        <dt class="font-mono text-xs text-muted-foreground">{humanizeKey(key)}</dt>
        <dd class="m-0 break-words font-mono text-xs">{formatPrimitive(value)}</dd>
      {/each}
    </dl>
  {/if}

  {#each arrays as [key, value] (key)}
    <div class="grid gap-1">
      <span class="font-mono text-xs text-muted-foreground">{humanizeKey(key)}</span>
      <CommandPreview text={(value as unknown[]).join(', ')}><code>{(value as unknown[]).join(', ')}</code></CommandPreview>
    </div>
  {/each}

  {#each nested as [key, value] (key)}
    <ConfigSection data={value as Record<string, unknown>} title={humanizeKey(key)} />
  {/each}
</div>
