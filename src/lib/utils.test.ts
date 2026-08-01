import { describe, expect, it } from 'vitest'
import { formatBytes } from './utils'

describe('formatBytes', () => {
  it('renders sub-1024 values in plain bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('picks the largest binary unit that keeps the value >= 1', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB')
  })

  it('drops the decimal once the value reaches 100+', () => {
    expect(formatBytes(100 * 1024)).toBe('100 KiB')
    expect(formatBytes(6144)).toBe('6.0 KiB')
  })

  it('treats negative or non-finite input as 0 B rather than throwing', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})
