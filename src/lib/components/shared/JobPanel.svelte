<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Search, X } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { appState, closeJobPanelFloating } from '$lib/app-state.svelte'
  import { cn } from '$lib/utils'

  // Shared collapse/expand/floating-quick-select chrome around a job-list
  // panel (Uploads/Downloads/Sink/Profiles today, any future job-list view
  // tomorrow). Callers keep owning their own header buttons, list rows, and
  // filtering -- this component only renders that content (passed as
  // `children`, re-rendered once inline and once inside the floating
  // overlay) and reacts to appState.jobPanelCollapsed/jobPanelFloatingId,
  // which App.svelte's header chip also reads/writes generically by panel
  // id, with no per-view knowledge of what's inside.
  //
  // `children` receives (query, floating): floating is true only for the
  // overlay render, so callers can skip inline-only chrome that makes no
  // sense there -- the panel is already collapsed by the time the overlay
  // can open, so a "collapse panel" button would be a visible no-op, and a
  // "New X" button meant to fill a 280px column would stretch across the
  // overlay's much wider body.
  //
  // The overlay itself rides on ui/dialog (bits-ui's Dialog.Root/Content),
  // same primitive every other dialog in this app uses, rather than a
  // hand-rolled backdrop + keydown listener: focus trap, Escape, outside
  // click, and body-portaling all come from that primitive for free instead
  // of being reimplemented here. Only position/size are overridden, via
  // inline style so they win regardless of the primitive's own base classes.
  let {
    id,
    searchPlaceholder = 'Search...',
    children,
  }: {
    id: string
    searchPlaceholder?: string
    children: Snippet<[string, boolean]>
  } = $props()

  const collapsed = $derived(appState.jobPanelCollapsed[id] ?? false)
  const floating = $derived(appState.jobPanelFloatingId === id)
  // Which grid column this panel occupies in its view's 2-column grid.
  // Explicit grid-column, not `order`: the detail pane only renders when a
  // job is selected, and `order` only affects placement sequence relative to
  // OTHER items present -- with the detail pane absent, an order-only panel
  // would just fall into whichever track auto-placement fills first,
  // ignoring side. Explicit placement pins it correctly either way. The
  // detail pane (owned by the view, not this component) takes the opposite
  // column -- see each view's own detail pane wrapper and grid-template-columns.
  const side = $derived(appState.jobPanelSide[id] ?? 'left')

  let searchQuery = $state('')
  let searchInput: HTMLInputElement | undefined = $state()

  $effect(() => {
    appState.jobPanelMounted[id] = true
    return () => {
      delete appState.jobPanelMounted[id]
      // The panel's own markup (list, selection handlers) lives in `children`,
      // owned by whichever view mounted us -- once that's gone (navigated to
      // a create/resume/sub-view form), a still-open floating overlay for
      // this id would have nothing to render.
      if (appState.jobPanelFloatingId === id) closeJobPanelFloating()
    }
  })

  $effect(() => {
    if (floating) {
      searchQuery = ''
      searchInput?.focus()
    }
  })

</script>

<!-- Always mounted, even while collapsed: the surrounding grid section's
     column track animates 280px/240px -> 0px (see each view's
     grid-template-columns), and this item stretches to fill that track by
     default, so overflow-hidden clips it smoothly in sync with the track
     shrinking, instead of the content just vanishing the instant collapsed
     flips true while an empty track animates shut on its own. inert (not
     just visual hiding) keeps a 0-width panel out of both the tab order and
     the accessibility tree while collapsed.

     Collapsing relies on the ancestor grid track shrinking to 0px, but the
     section's own content (job rows, a `w-full` "New X" button, none of it
     `min-w-0`) never actually gets a zero-width box of its own to size
     against -- it only renders inside whatever the grid hands this item, and
     a single overflow-hidden layer clipping a nonzero-height/zero-width box
     against content with real intrinsic minimums is exactly the kind of
     combination that leaks a rendering sliver in WebView engines. Forcing
     width/padding/border to 0 directly on this box, not just via the track,
     removes that ambiguity instead of trusting the clip alone. -->
<section
  class={cn('surface min-w-0 overflow-hidden', collapsed ? 'w-0 border-0 p-0' : 'p-4')}
  style:grid-column={side === 'left' ? '1' : '2'}
  style:grid-row="1"
  inert={collapsed}
  aria-hidden={collapsed}
>
  {@render children('', false)}
</section>

<Dialog.Root open={floating} onOpenChange={(next) => { if (!next) closeJobPanelFloating() }}>
  <Dialog.Content
    class="top-[calc(var(--header-h)_+_1px)] left-[20vw] w-[60vw] min-w-[60vw] max-w-none sm:max-w-none max-h-[min(60vh,calc(100vh_-_var(--header-h)_-_1px_-_1rem))] translate-x-0 translate-y-0 flex flex-col gap-0 overflow-hidden p-0 sm:p-0"
    showCloseButton={false}
  >
    <Dialog.Title class="sr-only">{searchPlaceholder}</Dialog.Title>
    <Dialog.Description class="sr-only">Search and select, Escape or click outside to close.</Dialog.Description>
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 text-muted-foreground">
      <Search size={15} aria-hidden="true" />
      <input
        type="text"
        bind:value={searchQuery}
        bind:this={searchInput}
        placeholder={searchPlaceholder}
        autocomplete="off"
        class="flex-1 border-none bg-transparent text-base text-foreground outline-none"
      />
      <Button type="button" size="icon" variant="ghost" class="h-7 w-7 shrink-0" onclick={closeJobPanelFloating} title="Close" aria-label="Close">
        <X size={15} aria-hidden="true" />
      </Button>
    </div>
    <div class="min-h-0 overflow-auto p-4">
      {@render children(searchQuery, true)}
    </div>
  </Dialog.Content>
</Dialog.Root>
