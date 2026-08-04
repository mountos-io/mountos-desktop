<script lang="ts">
  import { cn } from '$lib/utils.js'
  import { Popover, PopoverTrigger, PopoverContent } from '$lib/components/ui/popover'
  import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from '$lib/components/ui/command'
  import { Button } from '$lib/components/ui/button'
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down'
  import Check from '@lucide/svelte/icons/check'

  // Mirrors mountos-admin-client's src/lib/components/shared/Combobox.svelte
  // field-for-field, kept in sync deliberately (same searchable-dropdown
  // need, same bits-ui Command/Popover primitives available in both apps),
  // update both together.
  let {
    options, value = $bindable(''), placeholder = 'Select...',
    emptyText = 'No results found.', disabled = false,
    class: className, 'aria-labelledby': ariaLabelledby, 'aria-label': ariaLabel,
  }: {
    options: readonly { value: string; label: string }[]
    value?: string
    placeholder?: string
    emptyText?: string
    disabled?: boolean
    class?: string
    'aria-labelledby'?: string
    'aria-label'?: string
  } = $props()

  let open = $state(false)
  let searchQuery = $state('')
  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '')
  const listId = `combobox-list-${Math.random().toString(36).slice(2, 9)}`

  $effect(() => {
    if (open) searchQuery = ''
  })
</script>

<Popover bind:open>
  <PopoverTrigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={ariaLabelledby}
        aria-label={ariaLabel}
        {disabled}
        class={cn('w-full justify-between font-normal', !value && 'text-muted-foreground', className)}
      >
        <!-- Labels here are profile names and mount paths. The Button base is
             whitespace-nowrap, so the answer is truncation, not wrapping, and
             an anonymous text node cannot be truncated: it needs its own
             element (same shape the Select trigger already uses). -->
        <span class="truncate">{selectedLabel || placeholder}</span>
        <ChevronsUpDown class="ml-auto h-4 w-4 shrink-0 opacity-50" />
      </Button>
    {/snippet}
  </PopoverTrigger>
  <PopoverContent class="w-[--bits-popover-anchor-width] p-0">
    <Command>
      <CommandInput placeholder="Search..." aria-label="Search options" aria-controls={listId} bind:value={searchQuery} />
      <CommandList id={listId} aria-live="polite">
        <CommandEmpty>{emptyText}</CommandEmpty>
        {#each options as opt (opt.value)}
          <CommandItem value={opt.label} onSelect={() => { value = opt.value; open = false }}>
            <Check class={cn('h-4 w-4', value === opt.value ? 'opacity-100' : 'opacity-0')} />
            {opt.label}
          </CommandItem>
        {/each}
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
