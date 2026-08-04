import type { View } from './app-state.svelte'

// Registry of optional desktop features: domain-specific surfaces that stay
// out of the way until a user turns them on. Each entry is one opt-in slot:
// a stable id, a functional label and one-line description shown in
// Settings, and whether it ships enabled by default. The registry drives the
// Settings toggle list, the sidebar's visibility and label, and the
// breadcrumb title (viewTitle). Adding a feature still needs a View union
// member (app-state.svelte.ts), a navItems entry, and a render branch in
// App.svelte, since those are structural, not data.
//
// This shape is a de facto API for forks that customize the default set, so
// keep it small and obvious rather than growing it ad hoc.
export interface FeatureDefinition {
  id: View
  label: string
  description: string
  defaultEnabled: boolean
}

export const FEATURE_REGISTRY: FeatureDefinition[] = [
  {
    id: 'sink',
    label: 'Media ingest',
    description: 'Ingest a live camera or streaming source into mountOS.',
    defaultEnabled: false,
  },
]

// Resolves the enabled set by layering a user's local overrides over the
// registry defaults: an override wins when present for a given id, the
// registry default applies otherwise. An id present in overrides but no
// longer in the registry (removed feature, or one this build never shipped)
// is silently ignored rather than surfaced.
export function resolveFeatures(overrides: Record<string, boolean> | undefined): Record<string, boolean> {
  const resolved: Record<string, boolean> = {}
  for (const feature of FEATURE_REGISTRY) {
    resolved[feature.id] = overrides?.[feature.id] ?? feature.defaultEnabled
  }
  return resolved
}

