<script lang="ts" module>
  import { cn, type WithElementRef } from "$lib/utils.js";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import { type VariantProps, tv } from "tailwind-variants";

  export const buttonVariants = tv({
    base: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium outline-none transition-[color,background-color,border-color,transform,opacity] focus-visible:ring-[2px] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    variants: {
      variant: {
        default: "bg-transparent text-foreground border border-foreground/75 hover:bg-accent hover:border-foreground active:bg-primary/10 active:border-primary/30 active:scale-[0.98] transition-[color,background-color,border-color,transform,opacity] duration-150",
        primary: "bg-primary text-primary-foreground border border-primary hover:bg-primary/90 active:bg-primary/80 active:scale-[0.98] shadow-none",
        destructive: "bg-transparent border border-destructive text-destructive hover:bg-destructive/10 active:bg-destructive/20 active:scale-[0.98]",
        // Filled destructive: the corner-bracket clip-path (cyberpunk-skewed-sm)
        // needs an opaque background to read correctly, unlike the outline
        // `destructive` variant above, use this pairing on confirm buttons
        // in destructive-action dialogs (Delete/Unmount), not bordered ones.
        "destructive-solid": "bg-destructive text-destructive-foreground border border-destructive hover:bg-destructive/90 active:bg-destructive/80 active:scale-[0.98]",
        outline: "bg-transparent border border-foreground/75 hover:bg-accent hover:border-foreground hover:text-accent-foreground active:bg-primary/10 active:border-primary/30 active:scale-[0.98]",
        secondary: "bg-transparent text-foreground border border-foreground/75 hover:bg-accent/50 active:bg-primary/10 active:border-primary/30 active:scale-[0.98]",
        ghost: "border-transparent hover:bg-accent hover:text-accent-foreground active:bg-primary/10 active:scale-[0.98]",
        link: "text-primary underline-offset-4 hover:underline border-transparent active:opacity-70 active:scale-[0.98]",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 rounded-sm px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-sm px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  });

  export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
  export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
  export type ButtonProps = WithElementRef<HTMLButtonAttributes> & WithElementRef<HTMLAnchorAttributes> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  };
</script>

<script lang="ts">
  let {
    class: className, variant = "default", size = "default",
    ref = $bindable(null), href = undefined, type = "button", disabled, children, ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a bind:this={ref} data-slot="button" class={cn(buttonVariants({ variant, size }), className)}
    href={disabled ? undefined : href} aria-disabled={disabled}
    tabindex={disabled ? -1 : undefined} {...restProps}>
    {@render children?.()}
  </a>
{:else}
  <button bind:this={ref} data-slot="button" class={cn(buttonVariants({ variant, size }), className)}
    {type} {disabled} {...restProps}>
    {@render children?.()}
  </button>
{/if}
