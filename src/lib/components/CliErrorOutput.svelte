<script lang="ts">
  import { AlertTriangle, Copy } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'
  import { notify } from '$lib/app-state.svelte'

  let {
    text,
    command,
    role,
    class: className,
  }: { text: string; command?: string; role?: string; class?: string } = $props()

  async function copyText() {
    const payload = command ? `$ ${command}\n${text}` : text
    try {
      await navigator.clipboard.writeText(payload)
      notify('Error output copied')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to copy', 'error')
    }
  }
</script>

<!-- Unlike Callout (a short one-line prose warning), this holds the CLI's
     raw stdout+stderr transcript: unknown length, unknown shape. We don't
     guess which line matters, so it's a scrollable monospace box that folds
     long lines instead of a single-line banner that would overflow or hide
     the actual reason inside a truncated guess. The height cap plus scroll
     is what keeps a long transcript from dominating its panel; the copy
     button always takes the full text regardless of what is scrolled into
     view. -->
<div class={cn('grid gap-1.5 border border-warning/45 p-2.5 text-warning', className)} {role}>
  <div class="flex items-center justify-between gap-2">
    <AlertTriangle size={15} aria-hidden="true" class="shrink-0" />
    <Button type="button" variant="outline" size="icon" class="text-warning shrink-0" title="Copy error output" aria-label="Copy error output" onclick={copyText}>
      <Copy size={16} aria-hidden="true" />
    </Button>
  </div>
  <pre class="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
</div>
