<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: CommandPrimitive.ItemProps = $props();
</script>

<!-- wrap-anywhere: item labels are profile names, mount paths and instance
     labels, which have no guaranteed break opportunity. The label is an
     anonymous flex item here and so cannot take min-w-0 of its own. -->
<CommandPrimitive.Item
  bind:ref
  data-slot="command-item"
  class={cn(
    "aria-selected:bg-accent aria-selected:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground outline-hidden relative flex cursor-default select-none items-center gap-2 wrap-anywhere rounded-sm px-2 py-1.5 text-sm data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    className
  )}
  {...restProps}
/>
