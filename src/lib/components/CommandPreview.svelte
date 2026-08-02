<script lang="ts">
  import { Copy } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { copyText } from '$lib/app-state.svelte'
  import { cn } from '$lib/utils'
  import type { Snippet } from 'svelte'

  let {
    label,
    text,
    class: className,
    children,
  }: {
    label?: string
    // The exact string shown in `children`, passed separately since children
    // is markup (a <code>/<pre> snippet), not a value this component can
    // read back out to put on the clipboard.
    text?: string
    class?: string
    children: Snippet
  } = $props()
</script>

<div class={cn('relative grid gap-2 overflow-auto border border-border bg-muted p-3', className)}>
  {#if label}
    <div class="flex items-center justify-between gap-2">
      <p class="mono-label">{label}</p>
      {#if text}
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" title="Copy" aria-label="Copy" onclick={() => copyText(text, 'Copied')}>
          <Copy size={14} aria-hidden="true" />
        </Button>
      {/if}
    </div>
  {:else if text}
    <!-- No label to share a header row with, so float the button instead of
         giving it a row of its own (that row would otherwise be empty
         except for the button). -->
    <Button
      variant="ghost"
      size="icon"
      class="absolute right-1.5 top-1.5 z-10 h-7 w-7 bg-muted"
      title="Copy"
      aria-label="Copy"
      onclick={() => copyText(text, 'Copied')}
    >
      <Copy size={14} aria-hidden="true" />
    </Button>
  {/if}
  {@render children()}
</div>
