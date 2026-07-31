<script lang="ts" module>
  let _counter = 0

  export type InlineSegment = { kind: 'text' | 'bold' | 'code'; value: string }
  export type Block = { kind: 'list'; items: InlineSegment[][] } | { kind: 'para'; lines: InlineSegment[][] }

  // Inline markdown: **bold** and `code` spans, in whichever order they
  // appear. Kept minimal (no links/italics) -- this is tooltip copy, not a
  // document. Exported (alongside parseBlocks) so the parser is unit-
  // testable without mounting the component.
  export function parseInline(line: string): InlineSegment[] {
    const out: InlineSegment[] = []
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) out.push({ kind: 'text', value: line.slice(last, m.index) })
      out.push(m[1] !== undefined ? { kind: 'bold', value: m[1] } : { kind: 'code', value: m[2] })
      last = m.index + m[0].length
    }
    if (last < line.length) out.push({ kind: 'text', value: line.slice(last) })
    return out
  }

  // Blank-line-separated blocks (paragraphs), each either a bullet list --
  // every non-empty line starts with the existing "• " convention already
  // used across every InfoTip call site -- or a plain paragraph, whose own
  // single newlines become soft line breaks (not a new paragraph).
  export function parseBlocks(text: string): Block[] {
    const blocks: Block[] = []
    for (const raw of text.split(/\n{2,}/)) {
      const lines = raw.split('\n').filter((l) => l.length > 0)
      if (lines.length === 0) continue
      if (lines.every((l) => l.trimStart().startsWith('• '))) {
        blocks.push({ kind: 'list', items: lines.map((l) => parseInline(l.trimStart().slice(2))) })
      } else {
        blocks.push({ kind: 'para', lines: lines.map(parseInline) })
      }
    }
    return blocks
  }
</script>

<script lang="ts">
  import Lightbulb from '@lucide/svelte/icons/lightbulb'

  let { text, width = 400 }: { text: string; width?: number } = $props()

  let show = $state(false)
  let pos = $state({ left: '0px', top: '0px', transform: 'translate(-50%, -100%)' })
  let el: HTMLButtonElement | undefined = $state()
  const tipId = `infotip-${++_counter}`

  const blocks = $derived(parseBlocks(text))

  function open(e: PointerEvent | FocusEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const vw = window.innerWidth
    const pad = 12
    const pw = Math.min(width, vw - pad * 2)
    let left = r.left + r.width / 2
    let top = r.top - 8
    let transform = 'translate(-50%, -100%)'
    if (left - pw / 2 < pad) left = pad + pw / 2
    else if (left + pw / 2 > vw - pad) left = vw - pad - pw / 2
    if (top - 160 < pad) { top = r.bottom + 8; transform = 'translate(-50%, 0)' }
    pos = { left: `${left}px`, top: `${top}px`, transform }
    show = true
  }

  function close() { show = false }

  // Dismiss on Escape, scroll, or resize; WCAG 1.4.13 (Content on Hover or Focus).
  $effect(() => {
    if (!show) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onScrollOrResize = () => close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  })

  // Portal the tooltip to document.body so `position: fixed` resolves to the
  // viewport even when an ancestor has a transform (e.g. Dialog content).
  function portal(node: HTMLElement) {
    document.body.appendChild(node)
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node)
      },
    }
  }
</script>

<button
  type="button"
  bind:this={el}
  class="inline-flex cursor-help bg-transparent border-none px-1 py-2.5 pointer-coarse:p-2 pointer-coarse:-m-2 items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
  aria-label="More info"
  aria-describedby={show ? tipId : undefined}
  onpointerenter={open}
  onpointerleave={close}
  onfocus={open}
  onblur={close}
>
  <Lightbulb class="size-3.5 text-warning" aria-hidden="true" />
  <span class="sr-only">More info</span>
</button>

{#if show}
  <div
    use:portal
    id={tipId}
    role="tooltip"
    class="fixed z-50 pointer-events-none rounded-sm border border-border bg-card px-3.5 py-3"
    style:left={pos.left}
    style:top={pos.top}
    style:transform={pos.transform}
    style:max-width="min({width}px, calc(100vw - 1.5rem))"
  >
    <div class="grid gap-2 text-base leading-relaxed text-foreground">
      {#each blocks as block}
        {#if block.kind === 'list'}
          <ul class="grid gap-1 pl-4 list-disc marker:text-muted-foreground">
            {#each block.items as line}
              <li>{#each line as seg}{#if seg.kind === 'bold'}<strong class="font-semibold text-foreground">{seg.value}</strong>{:else if seg.kind === 'code'}<code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]">{seg.value}</code>{:else}{seg.value}{/if}{/each}</li>
            {/each}
          </ul>
        {:else}
          <p>
            {#each block.lines as line, i}
              {#if i > 0}<br />{/if}
              {#each line as seg}{#if seg.kind === 'bold'}<strong class="font-semibold text-foreground">{seg.value}</strong>{:else if seg.kind === 'code'}<code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]">{seg.value}</code>{:else}{seg.value}{/if}{/each}
            {/each}
          </p>
        {/if}
      {/each}
    </div>
  </div>
{/if}
