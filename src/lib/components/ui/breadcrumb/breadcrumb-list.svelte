<script lang="ts">
  import type { HTMLOlAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLOlAttributes> = $props();
</script>

<!-- wrap-anywhere, not break-words: crumbs carry profile and fork names, and
     each crumb is a flex item, where overflow-wrap:break-word leaves the
     min-content width intact so the item never shrinks in the first place. -->
<ol
  bind:this={ref}
  data-slot="breadcrumb-list"
  class={cn(
    "text-muted-foreground flex flex-wrap items-center gap-1.5 wrap-anywhere text-sm sm:gap-2.5",
    className
  )}
  {...restProps}
>
  {@render children?.()}
</ol>
