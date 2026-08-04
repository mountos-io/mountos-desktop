<script lang="ts">
  import Lightbulb from '@lucide/svelte/icons/lightbulb'
  import Settings from '@lucide/svelte/icons/settings'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Separator } from '$lib/components/ui/separator'
  import CommandPreview from '$lib/components/CommandPreview.svelte'
  import { appState, goToSettingsSection, hideTips } from '$lib/app-state.svelte'
  import type { SettingsTab } from '$lib/app-state.svelte'
  import { TIPS } from '$lib/tips'

  function openSettingsSection(tab: SettingsTab) {
    hideTips()
    void goToSettingsSection(tab)
  }
</script>

<Dialog.Root bind:open={() => appState.tipsOpen, (open) => { if (!open) hideTips() }}>
  <Dialog.Content class="sm:max-w-2xl" aria-describedby={undefined}>
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2"><Lightbulb size={20} aria-hidden="true" class="text-warning" /> Tips</Dialog.Title>
    </Dialog.Header>
    <div class="grid gap-4 py-4">
      {#each TIPS as tip, index (tip.title)}
        {#if index > 0}<Separator />{/if}
        <div class="grid gap-1.5">
          <strong>{tip.title}</strong>
          <p class="text-sm text-muted-foreground">{tip.body}</p>
          {#if tip.command}
            <CommandPreview text={tip.command}><code>{tip.command}</code></CommandPreview>
          {:else if tip.settingsTab}
            <Button type="button" size="sm" variant="outline" class="w-fit" onclick={() => openSettingsSection(tip.settingsTab!)}>
              <Settings size={14} aria-hidden="true" />
              Open Settings
            </Button>
          {/if}
        </div>
      {/each}
    </div>
    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={hideTips}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
