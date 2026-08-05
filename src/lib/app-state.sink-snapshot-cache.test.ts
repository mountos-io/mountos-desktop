import { describe, expect, it } from 'vitest'
import { sinkDisplaySnapshot, withSinkSnapshotCached } from './app-state.svelte'
import type { SinkSnapshot } from './types'

function snapshot(overrides: Partial<SinkSnapshot> = {}): SinkSnapshot {
  return {
    state: 'running',
    lagSegments: 0,
    lagSeconds: 0,
    walBytes: 0,
    walSegments: 0,
    discontinuities: 0,
    segmentsFetched: 0,
    segmentsCommitted: 0,
    bytesCommitted: 0,
    fileSize: 0,
    bitrateObserved: 0,
    fetchErrors: 0,
    commitRetries: 0,
    fileCount: 0,
    currentPath: '',
    ...overrides,
  }
}

describe('withSinkSnapshotCached', () => {
  it('stores a live snapshot under its job id', () => {
    const live = snapshot({ fileSize: 100 })
    const cache = withSinkSnapshotCached({}, 'job-1', live)
    expect(cache['job-1']).toBe(live)
  })

  it('leaves the cache untouched when there is no job id', () => {
    const cache = withSinkSnapshotCached({}, null, snapshot())
    expect(cache).toEqual({})
  })

  it('leaves the cache untouched when there is no live snapshot', () => {
    const cache = withSinkSnapshotCached({}, 'job-1', undefined)
    expect(cache).toEqual({})
  })

  it('does not replace the cached entry with an identical reference', () => {
    const live = snapshot({ fileSize: 100 })
    const first = withSinkSnapshotCached({}, 'job-1', live)
    const second = withSinkSnapshotCached(first, 'job-1', live)
    expect(second).toBe(first)
  })

  it('overwrites the cached entry for the same job with a newer snapshot', () => {
    const first = withSinkSnapshotCached({}, 'job-1', snapshot({ fileSize: 100 }))
    const second = withSinkSnapshotCached(first, 'job-1', snapshot({ fileSize: 200 }))
    expect(second['job-1'].fileSize).toBe(200)
  })

  it('keeps separate entries per job id', () => {
    let cache = withSinkSnapshotCached({}, 'job-1', snapshot({ fileSize: 100 }))
    cache = withSinkSnapshotCached(cache, 'job-2', snapshot({ fileSize: 200 }))
    expect(cache['job-1'].fileSize).toBe(100)
    expect(cache['job-2'].fileSize).toBe(200)
  })
})

describe('sinkDisplaySnapshot', () => {
  it('prefers the live snapshot when one is present', () => {
    const cache = { 'job-1': snapshot({ fileSize: 100 }) }
    const live = snapshot({ fileSize: 200 })
    expect(sinkDisplaySnapshot(cache, 'job-1', live, true)).toBe(live)
  })

  it('falls back to the cached snapshot for the same job when live is undefined and the job is still running', () => {
    const cached = snapshot({ fileSize: 100 })
    const cache = { 'job-1': cached }
    expect(sinkDisplaySnapshot(cache, 'job-1', undefined, true)).toBe(cached)
  })

  it('returns undefined for a job that has never had a snapshot', () => {
    expect(sinkDisplaySnapshot({}, 'job-1', undefined, true)).toBeUndefined()
  })

  it('returns undefined when there is no selected job id', () => {
    const cache = { 'job-1': snapshot() }
    expect(sinkDisplaySnapshot(cache, null, undefined, true)).toBeUndefined()
  })

  it('does not leak a different job\'s cached snapshot', () => {
    const cache = { 'job-1': snapshot({ fileSize: 100 }) }
    expect(sinkDisplaySnapshot(cache, 'job-2', undefined, true)).toBeUndefined()
  })

  // A job that has genuinely stopped (SIGKILL, no CachedCounts to resolve
  // to) reports live=undefined permanently, not just for one poll tick.
  // Falling back to a once-live cached snapshot here would freeze the pane
  // on stale numbers forever with no staleness marker.
  it('does not fall back to the cache once the job is no longer running', () => {
    const cache = { 'job-1': snapshot({ fileSize: 100 }) }
    expect(sinkDisplaySnapshot(cache, 'job-1', undefined, false)).toBeUndefined()
  })

  it('still prefers a fresh live snapshot even when the job has stopped', () => {
    const cache = { 'job-1': snapshot({ fileSize: 100 }) }
    const live = snapshot({ fileSize: 300 })
    expect(sinkDisplaySnapshot(cache, 'job-1', live, false)).toBe(live)
  })
})
