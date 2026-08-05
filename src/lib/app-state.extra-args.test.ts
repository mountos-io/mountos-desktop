import { describe, expect, it, beforeEach } from 'vitest'
import { appState, commitExtraArgs, setExtraArgs } from './app-state.svelte'
import type { MountProfile } from './types'

function profile(overrides: Partial<MountProfile> = {}): MountProfile {
  return {
    id: 'p1',
    schemaVersion: 1,
    kind: 'mount',
    name: 'test',
    volume: '',
    fork: '',
    mountPath: '',
    discoveryUrl: '',
    accessKeyId: '',
    secretRef: 'prompt',
    backend: 'macfuse',
    readOnly: false,
    autoRemount: false,
    temporaryFork: false,
    extraArgs: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

// setExtraArgs/commitExtraArgs are the live-typing path behind the "Advanced
// options" field (ProfilesView). Regression coverage for the false-positive
// "Rejected managed flags" flash reported while a flag is still being typed.
describe('setExtraArgs', () => {
  beforeEach(() => {
    appState.profiles = [profile()]
    appState.selectedProfileId = 'p1'
    appState.extraArgsInput = ''
    appState.extraArgsError = ''
    appState.rejectedArgs = []
  })

  it('does not flag a bare "--" while it is still the in-progress token', () => {
    setExtraArgs('--')
    expect(appState.rejectedArgs).toEqual([])
  })

  it('does not flag a managed flag name mid-word, e.g. "--vol" on the way to "--volname"', () => {
    setExtraArgs('--vol')
    expect(appState.rejectedArgs).toEqual([])
  })

  it('flags a managed flag once a trailing space commits it', () => {
    setExtraArgs('--volname ')
    expect(appState.rejectedArgs).toEqual(['--volname'])
  })

  it('flags an already-committed managed flag even while the next token is still in progress', () => {
    setExtraArgs('--volname x')
    expect(appState.rejectedArgs).toEqual(['--volname'])
  })

  it('does not flag an unmanaged flag while its value is still being typed', () => {
    setExtraArgs('--attr-cache 2')
    expect(appState.rejectedArgs).toEqual([])
  })

  it('still parses the in-progress token into the profile so the command preview stays accurate', () => {
    setExtraArgs('--attr-cache 2')
    expect(appState.profiles[0].extraArgs).toEqual(['--attr-cache', '2'])
  })

  it('surfaces a parse error (unterminated quote) without throwing', () => {
    expect(() => setExtraArgs('"unterminated')).not.toThrow()
    expect(appState.extraArgsError).toMatch(/quote/i)
  })

  it('clears a prior parse error once the input becomes valid again', () => {
    setExtraArgs('"unterminated')
    expect(appState.extraArgsError).not.toBe('')
    setExtraArgs('"unterminated"')
    expect(appState.extraArgsError).toBe('')
  })
})

describe('commitExtraArgs', () => {
  beforeEach(() => {
    appState.profiles = [profile()]
    appState.selectedProfileId = 'p1'
    appState.extraArgsInput = ''
    appState.extraArgsError = ''
    appState.rejectedArgs = []
  })

  it('validates a fully-typed managed flag left with no trailing space, e.g. on blur', () => {
    setExtraArgs('--volname')
    expect(appState.rejectedArgs).toEqual([])
    commitExtraArgs()
    expect(appState.rejectedArgs).toEqual(['--volname'])
  })

  it('leaves rejectedArgs empty when the committed input has no managed flags', () => {
    setExtraArgs('--attr-cache')
    commitExtraArgs()
    expect(appState.rejectedArgs).toEqual([])
  })

  it('is a no-op when there is no selected profile', () => {
    appState.selectedProfileId = null
    appState.profiles = []
    appState.rejectedArgs = ['stale']
    commitExtraArgs()
    expect(appState.rejectedArgs).toEqual(['stale'])
  })
})
