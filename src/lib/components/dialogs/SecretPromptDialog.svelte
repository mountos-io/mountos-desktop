<script lang="ts">
  import { KeyRound } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import CliErrorOutput from '$lib/components/CliErrorOutput.svelte'
  import { appState, cancelSecret, computed, doMount } from '$lib/app-state.svelte'
</script>

<Dialog.Root bind:open={() => appState.secretPromptFor !== null, (open) => { if (!open) cancelSecret() }}>
  <Dialog.Content class="sm:max-w-md" aria-describedby={undefined}>
    {#if appState.secretPromptFor}
      <form onsubmit={(event) => {
        event.preventDefault()
        if (appState.secretPromptResume) void appState.secretPromptResume(computed.trimmedSecret)
        else void doMount(appState.secretPromptFor!, computed.trimmedSecret)
      }}>
        <Dialog.Header>
          <Dialog.Title class="flex items-center gap-2"><KeyRound size={20} aria-hidden="true" /> Enter secret access key</Dialog.Title>
        </Dialog.Header>
        <!-- No prose here on purpose: how the secret reaches the CLI (stdin, never
             argv or env) is implementation the operator cannot act on, and this
             dialog appears on every prompted mount. The checkbox below is the only
             decision, and it states what happens to the value. -->
        <div class="grid gap-1.5 py-4">
          <span class="sr-only" id="secret-value-label">Secret access key</span>
          <!-- svelte-ignore a11y_autofocus -->
          <Input
            type="password"
            bind:value={appState.secretValue}
            autocomplete="current-password"
            autofocus
            aria-labelledby="secret-value-label"
            aria-invalid={Boolean(appState.secretValue) && Boolean(computed.secretLengthError)}
            aria-describedby="secret-length-hint"
          />
          <!-- Only once they have typed: the length rule is not news on an empty
               field, but a disabled Mount with no stated reason is. Always
               rendered (block + min-h reserves its line, min-height is a
               no-op on the default inline display) rather than conditionally
               mounted. Toggling this in and out of the DOM on the first
               keystroke was resizing the whole dialog under the user's cursor.
               aria-describedby links it to the input unconditionally (harmless
               empty otherwise) so aria-invalid has a stated reason attached,
               not just a bare "invalid" with nothing read out. -->
          <small id="secret-length-hint" class="block text-destructive text-sm min-h-6">
            {appState.secretValue && computed.secretLengthError ? computed.secretLengthError : ''}
          </small>
        </div>
        <Checkbox bind:checked={appState.savePromptedSecret} label="Store in OS vault for this profile" />
        {#if appState.secretError}
          <CliErrorOutput role="alert" text={appState.secretError} command={appState.commandText} />
        {/if}
        <Dialog.Footer class="mt-4">
          <Button type="button" variant="outline" onclick={cancelSecret}>Cancel</Button>
          <Button type="submit" variant="primary" class="cyberpunk-skewed-sm" disabled={appState.busy || !appState.secretValue}>Mount</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
