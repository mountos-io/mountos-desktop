<script lang="ts" module>
  import { type VariantProps, tv } from "tailwind-variants";

  export const badgeVariants = tv({
    base: "focus-visible:border-ring focus-visible:ring-ring/50 inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-sm border px-2 py-0.5 text-base font-medium transition-colors focus-visible:ring-[2px] [&>svg]:pointer-events-none [&>svg]:size-3.5",
    variants: {
      // primary/success/warning's resting bg-*/N tint computed under 4.5:1 in
      // light mode (verified: 4.20/3.98/text stays passing only because
      // warning's own hue has more headroom, but primary and success both
      // measurably fail AA against their own tint). destructive already
      // avoided this (bg-transparent at rest, tinted only on :hover); the fix
      // here is bringing the other three in line with that instead of a
      // divergent pattern per variant.
      variant: {
        default: "bg-transparent text-foreground border-border [a&]:hover:bg-accent/20",
        primary: "bg-transparent text-primary border-primary/30 [a&]:hover:bg-primary/10",
        secondary: "bg-transparent text-muted-foreground border-border [a&]:hover:bg-muted",
        destructive: "bg-transparent text-destructive border-destructive [a&]:hover:bg-destructive/10",
        outline: "text-foreground border-border [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        success: "bg-transparent text-success border-success/30 [a&]:hover:bg-success/10",
        warning: "bg-transparent text-warning border-warning/30 [a&]:hover:bg-warning/10",
      },
    },
    defaultVariants: { variant: "default" },
  });

  export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
</script>

<script lang="ts">
  import type { HTMLAnchorAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "$lib/utils.js";

  let {
    ref = $bindable(null), href, class: className, variant = "default", children, ...restProps
  }: WithElementRef<HTMLAnchorAttributes> & { variant?: BadgeVariant } = $props();
</script>

<svelte:element this={href ? "a" : "span"} bind:this={ref} data-slot="badge" {href}
  class={cn(badgeVariants({ variant }), className)} {...restProps}>
  {@render children?.()}
</svelte:element>
