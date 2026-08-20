<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "$lib/utils.js";
  import { Eye, EyeOff } from "@lucide/svelte";

  type Props = WithElementRef<Omit<HTMLInputAttributes, "type">>;

  let {
    ref = $bindable(null), value = $bindable(),
    class: className, ...restProps
  }: Props = $props();

  let visible = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  // Revealing a secret is a deliberate, momentary check, not a standing
  // state: auto-hide it so it doesn't sit in plaintext on screen after the
  // user looks away. A manual click while visible hides it immediately and
  // cancels the pending auto-hide.
  const REVEAL_DURATION_MS = 4000;

  function toggleVisible() {
    clearTimeout(hideTimer);
    if (visible) {
      visible = false;
      return;
    }
    visible = true;
    hideTimer = setTimeout(() => (visible = false), REVEAL_DURATION_MS);
  }

  $effect(() => () => clearTimeout(hideTimer));
</script>

<div class="relative">
  <input bind:this={ref} data-slot="input"
    class={cn(
      "border-input bg-background selection:bg-primary/20 dark:bg-input/20 selection:text-foreground ring-offset-background placeholder:text-muted-foreground shadow-none flex h-9 w-full min-w-0 rounded-sm border px-3 py-1 pr-9 text-base outline-none transition-[border-color] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
      "focus-visible:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
      "aria-invalid:ring-0 aria-invalid:border-destructive",
      className
    )}
    type={visible ? "text" : "password"} bind:value {...restProps} />
  <button type="button"
    class="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 cursor-pointer transition-colors"
    aria-label={visible ? 'Hide password' : 'Show password'}
    onclick={toggleVisible}>
    {#if visible}
      <EyeOff class="size-4" />
    {:else}
      <Eye class="size-4" />
    {/if}
  </button>
</div>
