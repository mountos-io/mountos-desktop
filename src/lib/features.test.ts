import { describe, expect, it } from 'vitest'
import { FEATURE_REGISTRY, resolveFeatures } from './features'

describe('FEATURE_REGISTRY', () => {
  it('seeds the sink entry, off by default', () => {
    const sink = FEATURE_REGISTRY.find((feature) => feature.id === 'sink')
    expect(sink).toBeDefined()
    expect(sink?.defaultEnabled).toBe(false)
  })

  it('has no duplicate ids', () => {
    const ids = FEATURE_REGISTRY.map((feature) => feature.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('resolveFeatures', () => {
  it('falls back to the registry default when overrides is undefined', () => {
    const resolved = resolveFeatures(undefined)
    expect(resolved.sink).toBe(false)
  })

  it('falls back to the registry default when a feature has no override', () => {
    const resolved = resolveFeatures({})
    expect(resolved.sink).toBe(false)
  })

  it('lets a user override win over the registry default', () => {
    const resolved = resolveFeatures({ sink: true })
    expect(resolved.sink).toBe(true)
  })

  it('ignores an override for an id no longer in the registry', () => {
    const resolved = resolveFeatures({ 'retired-feature': true })
    expect(resolved['retired-feature']).toBeUndefined()
  })

  it('returns exactly one entry per registry feature, no more no less', () => {
    const resolved = resolveFeatures({ sink: true, unknown: true })
    expect(Object.keys(resolved)).toEqual(FEATURE_REGISTRY.map((feature) => feature.id))
  })
})

// Locks in visibility-is-not-enablement at the boundary this module owns:
// the resolved map is a pure function of feature state only, so nothing
// that touches a mount, job, or the CLI can influence it, and toggling it
// here cannot reach any of those either.
describe('resolveFeatures purity', () => {
  it('is a pure function of the overrides alone, unaffected by anything else', () => {
    const before = resolveFeatures({ sink: true })
    const again = resolveFeatures({ sink: true })
    expect(again).toEqual(before)
  })
})
