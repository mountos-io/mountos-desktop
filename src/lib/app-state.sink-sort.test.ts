import { describe, expect, it } from 'vitest'
import { sinkStateRank, sortSinkJobs } from './app-state.svelte'
import type { SinkJob } from './types'

function job(overrides: Partial<SinkJob>): SinkJob {
  return {
    jobId: 'job',
    name: 'sink-job',
    state: 'resumable',
    source: 'https://example.com/live.m3u8',
    sinkTemplate: '/feed.mp4',
    fork: 'main',
    ...overrides,
  }
}

describe('sinkStateRank', () => {
  it('ranks running first, halted/resumable second, completed/finished last', () => {
    expect(sinkStateRank(job({ state: 'running' }))).toBe(0)
    expect(sinkStateRank(job({ state: 'halted' }))).toBe(1)
    expect(sinkStateRank(job({ state: 'resumable' }))).toBe(1)
    expect(sinkStateRank(job({ state: 'completed' }))).toBe(2)
    // `sink finish`'s own terminal state, same rank as 'completed'.
    expect(sinkStateRank(job({ state: 'finished' }))).toBe(2)
  })
})

describe('sortSinkJobs', () => {
  it('sorts by state rank regardless of input order', () => {
    const completed = job({ jobId: 'c', state: 'completed', createdAt: 300 })
    const running = job({ jobId: 'r', state: 'running', createdAt: 100 })
    const halted = job({ jobId: 'h', state: 'halted', createdAt: 200 })
    const sorted = sortSinkJobs([completed, halted, running])
    expect(sorted.map((j) => j.jobId)).toEqual(['r', 'h', 'c'])
  })

  it('sorts newest-first (by createdAt) within the same state group', () => {
    const older = job({ jobId: 'older', state: 'running', createdAt: 100 })
    const newer = job({ jobId: 'newer', state: 'running', createdAt: 200 })
    const sorted = sortSinkJobs([older, newer])
    expect(sorted.map((j) => j.jobId)).toEqual(['newer', 'older'])
  })

  it('never lets an old completed job rank ahead of a newer running one', () => {
    // Regression case: `sink list` has no stable order of its own
    // (ListJobDirs), so a job created recently but already "completed" must
    // not push a genuinely running job (created long ago, still in
    // progress) out of a capped view.
    const oldRunning = job({ jobId: 'old-running', state: 'running', createdAt: 1 })
    const newCompleted = job({ jobId: 'new-completed', state: 'completed', createdAt: 1000 })
    const sorted = sortSinkJobs([newCompleted, oldRunning])
    expect(sorted.map((j) => j.jobId)).toEqual(['old-running', 'new-completed'])
  })

  it('treats a missing createdAt as oldest, not crashing or sorting first', () => {
    const withCreatedAt = job({ jobId: 'with', state: 'running', createdAt: 50 })
    const withoutCreatedAt = job({ jobId: 'without', state: 'running' })
    const sorted = sortSinkJobs([withoutCreatedAt, withCreatedAt])
    expect(sorted.map((j) => j.jobId)).toEqual(['with', 'without'])
  })

  it('does not mutate the input array', () => {
    const a = job({ jobId: 'a', state: 'completed', createdAt: 1 })
    const b = job({ jobId: 'b', state: 'running', createdAt: 2 })
    const input = [a, b]
    sortSinkJobs(input)
    expect(input).toEqual([a, b])
  })
})
