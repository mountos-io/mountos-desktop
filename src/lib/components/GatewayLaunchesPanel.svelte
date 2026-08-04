<script lang="ts">
  import { OctagonX } from '@lucide/svelte'
  import * as Table from '$lib/components/ui/table'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { appState, stopGatewayLaunch } from '$lib/app-state.svelte'

  const gatewayOnlyLaunches = $derived(appState.gatewayLaunches.filter((launch) => !launch.mountPath))
</script>

<!-- Gateway-only launches have no FUSE mount, so they never appear in
     `mountos list --json` and get no row in the instances table. This is
     their only visible surface in the app. -->
{#if gatewayOnlyLaunches.length}
  <section class="surface m-[22px] p-4">
    <div class="flex items-start justify-between gap-4 mb-3.5">
      <h3>Gateway launches</h3>
      <Badge>{gatewayOnlyLaunches.length} running</Badge>
    </div>
    <Table.Root containerLabel="Gateway launches">
      <Table.Header>
        <Table.Row>
          <Table.Head class="th-cyber">Profile</Table.Head>
          <Table.Head class="th-cyber">Protocols</Table.Head>
          <Table.Head class="th-cyber">Endpoints</Table.Head>
          <Table.Head class="th-cyber">Actions</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each gatewayOnlyLaunches as launch (launch.id)}
          <Table.Row>
            <Table.Cell><strong class="wrap-anywhere">{launch.profileName}</strong></Table.Cell>
            <Table.Cell>
              {#each launch.protocols as protocol}
                <Badge variant="secondary">{protocol}</Badge>
              {/each}
            </Table.Cell>
            <Table.Cell>
              {#if launch.endpoints.length}
                {#each launch.endpoints as endpoint}
                  <div><code class="wrap-anywhere">{endpoint.protocol}: {endpoint.url}</code></div>
                {/each}
              {:else}
                <span class="mono-label">unknown (no descriptor found)</span>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <Button
                variant="destructive"
                size="icon"
                title="Stop gateway"
                aria-label="Stop gateway"
                disabled={appState.busy || !launch.pid}
                onclick={() => stopGatewayLaunch(launch.id)}
              >
                <OctagonX size={16} aria-hidden="true" />
              </Button>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </section>
{/if}
