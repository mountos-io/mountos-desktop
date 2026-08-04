<script lang="ts">
  import { OctagonX } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { appState, cancelStopGatewayPrompt, confirmStopGatewayPrompt } from '$lib/app-state.svelte'
</script>

<Dialog.Root bind:open={() => appState.stopGatewayPromptFor !== null, (open) => { if (!open) cancelStopGatewayPrompt() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.stopGatewayPromptFor}
      <form onsubmit={(event) => { event.preventDefault(); void confirmStopGatewayPrompt() }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2">
            <OctagonX size={20} aria-hidden="true" />
            Stop gateway
          </Dialog.Title>
        </Dialog.Header>
        <p class="py-4 wrap-anywhere">
          Stop "{appState.stopGatewayPromptFor.name || 'this gateway'}"? Anything currently reading or writing through
          {appState.stopGatewayPromptFor.gatewayEndpoints?.length === 1 ? 'its endpoint' : 'its endpoints'} will get a connection error.
        </p>
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancelStopGatewayPrompt}>Cancel</Button>
          <Button type="submit" variant="destructive-solid" class="cyberpunk-skewed-sm" disabled={appState.busy}>Stop gateway</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
