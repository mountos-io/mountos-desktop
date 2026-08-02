<script lang="ts">
  import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
  import { cn, type WithElementRef } from "$lib/utils.js";

  type InputType = Exclude<HTMLInputTypeAttribute, "file">;
  type Props = WithElementRef<
    Omit<HTMLInputAttributes, "type"> &
      ({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
  >;

  let {
    ref = $bindable(null), value = $bindable(), type, files = $bindable(),
    class: className, ...restProps
  }: Props = $props();

  // border-input sits close in lightness to the surrounding surface by
  // design (a quiet resting state), fine once a placeholder or value gives
  // the field a visible edge to read, but an empty field with neither has
  // nothing else marking its bounds. border-border (the same token panels
  // and dividers use) is only swapped in for that one case.
  const needsVisibleBorder = $derived(!value && !restProps.placeholder);
</script>

{#if type === "file"}
  <input bind:this={ref} data-slot="input"
    class={cn(
      "selection:bg-primary/20 dark:bg-input/20 selection:text-foreground border-input ring-offset-background placeholder:text-muted-foreground shadow-none flex h-9 min-h-[44px] sm:min-h-0 w-full min-w-0 rounded-sm border bg-transparent px-3 pt-1.5 text-sm font-medium outline-none transition-[border-color] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
      "focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
      "aria-invalid:ring-0 aria-invalid:border-destructive",
      needsVisibleBorder && "border-border",
      className
    )}
    type="file" bind:files bind:value {...restProps} />
{:else}
  <input bind:this={ref} data-slot="input"
    class={cn(
      "border-input bg-background selection:bg-primary/20 dark:bg-input/20 selection:text-foreground ring-offset-background placeholder:text-muted-foreground shadow-none flex h-9 min-h-[44px] sm:min-h-0 w-full min-w-0 rounded-sm border px-3 py-1 text-base outline-none transition-[border-color] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
      "focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
      "aria-invalid:ring-0 aria-invalid:border-destructive",
      needsVisibleBorder && "border-border",
      className
    )}
    {type} bind:value {...restProps} />
{/if}
