import { describe, expect, it } from 'vitest'
import {
  buildDeletedArgv,
  buildDownloadCancelArgv,
  buildExternalSourceUri,
  buildDownloadListArgv,
  buildDownloadPruneArgv,
  buildDownloadResumeArgv,
  buildDownloadRetryFailedArgv,
  buildDownloadStartArgv,
  buildForkCreateArgv,
  buildForkDeleteArgv,
  buildForkListArgv,
  buildForkRestoreArgv,
  buildGatewayArgv,
  buildMountArgv,
  buildSinkCancelArgv,
  buildSinkFinishArgv,
  buildSinkListArgv,
  buildSinkPruneArgv,
  buildSinkResumeArgv,
  buildSinkStartArgv,
  buildSinkStatusArgv,
  buildSnapshotArgv,
  buildUploadCancelArgv,
  buildUploadListArgv,
  buildUploadPruneArgv,
  buildUploadResumeArgv,
  buildUploadRetryFailedArgv,
  buildUploadStartArgv,
  buildVersionArgv,
  classifyMountError,
  isAbsolutePath,
  isValidFolderName,
  looksLikeSourceUri,
  parseArgvInput,
  validateExternalSourceFields,
  validateExtraArgs,
  validateGlobPattern,
  validateMountPathForBackend,
  validateUploadPositional,
} from './cli'
import type { DownloadStartParams, SinkStartParams, UploadStartParams } from './cli'
import type { MountProfile } from './types'

const profile: MountProfile = {
  id: 'p1',
  schemaVersion: 1,
  kind: 'mount',
  name: 'Demo',
  volume: 'vol-1',
  fork: 'main',
  mountPath: '/Volumes/MountOS/Demo',
  discoveryUrl: 'https://hub.example.com',
  accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
  secretRef: 'vault',
  backend: 'nfs',
  readOnly: true,
  autoRemount: false,
  temporaryFork: false,
  extraArgs: ['--cache-size', '10G'],
  createdAt: '2026-07-10T00:00:00Z',
  updatedAt: '2026-07-10T00:00:00Z',
}

describe('cli helpers', () => {
  it('builds managed mount argv without the secret value', () => {
    expect(buildMountArgv(profile)).toEqual([
      'mount',
      '/Volumes/MountOS/Demo',
      '--discovery-url',
      'https://hub.example.com',
      '--volname',
      'vol-1',
      '--fork-name',
      'main',
      '-a',
      'ABCDEFGHIJKLMNOPQRST',
      '-s',
      '--read-only',
      '--nfs',
      '--cache-size',
      '10G',
    ])
  })

  it('does not add secret flags when access key id is empty', () => {
    const argv = buildMountArgv({ ...profile, accessKeyId: '' })
    expect(argv).not.toContain('-a')
    expect(argv).not.toContain('-s')
  })

  it('adds --disk-cache-dir and --disk-cache-size when set, for mount and satellite views alike', () => {
    const cached = { ...profile, cacheDir: '/tmp/mountos cache', cacheSize: '100G' }
    expect(buildMountArgv(cached)).toEqual(
      expect.arrayContaining(['--disk-cache-dir', '/tmp/mountos cache', '--disk-cache-size', '100G']),
    )
    expect(buildDeletedArgv(cached, '/tmp/deleted-view')).toEqual(
      expect.arrayContaining(['--disk-cache-dir', '/tmp/mountos cache', '--disk-cache-size', '100G']),
    )
  })

  it('adds --temporary-fork when enabled', () => {
    expect(buildMountArgv({ ...profile, temporaryFork: true })).toContain('--temporary-fork')
    expect(buildMountArgv({ ...profile, temporaryFork: false })).not.toContain('--temporary-fork')
  })

  it('carries --temporary-fork through the mount+gateway combo (sandbox composes with gateway)', () => {
    const argv = buildGatewayArgv(
      { ...profile, temporaryFork: true },
      { protocols: ['s3'], gatewayOnly: false, noLoopback: false },
    )
    expect(argv).toContain('--temporary-fork')
    expect(argv).toContain('--gateway')
  })

  it('carries --temporary-fork through gateway-only too, not just the mount+gateway combo', () => {
    const argv = buildGatewayArgv(
      { ...profile, temporaryFork: true },
      { protocols: ['hdfs'], gatewayOnly: true, noLoopback: false },
    )
    expect(argv[0]).toBe('gateway')
    expect(argv).toContain('--temporary-fork')
  })

  it('omits --temporary-fork from gateway argv when the profile has sandbox off', () => {
    const combo = buildGatewayArgv(
      { ...profile, temporaryFork: false },
      { protocols: ['s3'], gatewayOnly: false, noLoopback: false },
    )
    const gatewayOnly = buildGatewayArgv(
      { ...profile, temporaryFork: false },
      { protocols: ['s3'], gatewayOnly: true, noLoopback: false },
    )
    expect(combo).not.toContain('--temporary-fork')
    expect(gatewayOnly).not.toContain('--temporary-fork')
  })

  it('rejects managed extra args and duplicate positionals', () => {
    expect(validateExtraArgs(['--smb', '--secret-access-key=x', '-sa', '/tmp/mount'])).toEqual([
      '--smb',
      '--secret-access-key=x',
      '-sa',
      '/tmp/mount',
    ])
  })

  it('allows separate values for unmanaged flags', () => {
    expect(validateExtraArgs(['--attr-cache', '2.0', '--debug'])).toEqual([])
  })

  it('rejects --destination as a managed flag, matching --mount', () => {
    expect(validateExtraArgs(['--destination', '/tmp/other'])).toEqual(['--destination', '/tmp/other'])
  })

  it('rejects --disk-cache-size as a managed flag now that MountProfile.cacheSize covers it', () => {
    expect(validateExtraArgs(['--disk-cache-size', '10G'])).toEqual(['--disk-cache-size', '10G'])
  })

  it('validates FSKit mount path prefix', () => {
    expect(validateMountPathForBackend('fskit', '/Volumes/MountOS/Team')).toBeNull()
    expect(validateMountPathForBackend('fskit', '/Volumes/MountOS/Team/')).toBeNull()
    expect(validateMountPathForBackend('fskit', '/Volumes/MountOS/')).not.toBeNull()
    expect(validateMountPathForBackend('fskit', '/Volumes/MountOS')).not.toBeNull()
    expect(validateMountPathForBackend('fskit', '/tmp/Team')).not.toBeNull()
    expect(validateMountPathForBackend('fskit', '')).not.toBeNull()
    // A ".." component must not lexically escape the jail even though the
    // path doesn't exist yet and the prefix bytes match.
    expect(
      validateMountPathForBackend('fskit', '/Volumes/MountOS/x/../../../../../etc/cron.d/evil'),
    ).not.toBeNull()
    expect(validateMountPathForBackend('nfs', '/tmp/anything')).toBeNull()
    expect(validateMountPathForBackend('nfs', '')).toBeNull()
  })

  it('recognizes Unix and Windows absolute paths', () => {
    expect(isAbsolutePath('/Volumes/MountOS/Team')).toBe(true)
    expect(isAbsolutePath('C:\\Mounts\\Team')).toBe(true)
    expect(isAbsolutePath('C:/Mounts/Team')).toBe(true)
    expect(isAbsolutePath('C:')).toBe(true)
    expect(isAbsolutePath('C:\\')).toBe(true)
    expect(isAbsolutePath('relative/path')).toBe(false)
    expect(isAbsolutePath('C:foo')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })

  it('rejects a non-empty mount path that is not absolute', () => {
    expect(validateMountPathForBackend('nfs', 'relative/path')).not.toBeNull()
    expect(validateMountPathForBackend('nfs', 'not-a-path')).not.toBeNull()
    expect(validateMountPathForBackend('nfs', 'C:\\Mounts\\Team')).toBeNull()
  })

  it('validates short flag clusters', () => {
    // A managed short flag anywhere before the '-o' value-absorbing point
    // is caught, regardless of position in the cluster.
    expect(validateExtraArgs(['-am'])).toEqual(['-am'])
    expect(validateExtraArgs(['-ma'])).toEqual(['-ma'])
    // '-o' takes a fused value (mirrors real short-opt parsing: once a
    // value-taking flag is hit in a cluster, the rest of the token is its
    // value, not further flags): bare '-o' and '-o<value>' are both
    // accepted even when the value text collides with a managed letter.
    expect(validateExtraArgs(['-o'])).toEqual([])
    expect(validateExtraArgs(['-oallow_other'])).toEqual([])
    expect(validateExtraArgs(['-oa'])).toEqual([])
    // Bare "--" (positional separator) is rejected like any other
    // non-managed-but-suspicious positional.
    expect(validateExtraArgs(['--'])).toEqual(['--'])
  })

  it('preserves quoted and escaped extra-argument values', () => {
    expect(parseArgvInput('--disk-cache-size 10G --mount-opts "allow_other,volname=Team Files"')).toEqual([
      '--disk-cache-size',
      '10G',
      '--mount-opts',
      'allow_other,volname=Team Files',
    ])
  })

  it('classifies pinned error strings', () => {
    expect(classifyMountError('authentication failed - invalid access key or secret')).toBe('auth')
    expect(classifyMountError('mount point /x is not empty')).toBe('mountpoint')
    expect(classifyMountError('did not become ready within 30s')).toBe('indeterminate')
  })

  it('builds snapshot argv with a positional destination and a fused timestamp flag', () => {
    const argv = buildSnapshotArgv(profile, '/tmp/snap-view', '-1d')
    expect(argv[0]).toBe('snapshot')
    expect(argv[1]).toBe('/tmp/snap-view')
    expect(argv).toContain('--timestamp=-1d')
    expect(argv).not.toContain('-m')
    expect(argv).not.toContain('--destination')
  })

  it('builds deleted argv with a positional destination and omits optional flags when blank', () => {
    const bare = buildDeletedArgv(profile, '/tmp/deleted-view')
    expect(bare[0]).toBe('deleted')
    expect(bare[1]).toBe('/tmp/deleted-view')
    expect(bare).not.toContain('-m')
    expect(bare).not.toContain('--destination')
    expect(bare.some((arg) => arg.startsWith('--from'))).toBe(false)

    const full = buildDeletedArgv(profile, '/tmp/deleted-view', '30d', '1h')
    expect(full).toContain('--from=30d')
    expect(full).toContain('--idle-timeout=1h')

    // Go's DurationVar doesn't trim, so whitespace must be stripped here.
    const padded = buildDeletedArgv(profile, '/tmp/deleted-view', '  30d  ', '  1h  ')
    expect(padded).toContain('--from=30d')
    expect(padded).toContain('--idle-timeout=1h')
  })

  it('builds version argv with a positional destination, -i, and omits the default format', () => {
    const argv = buildVersionArgv(profile, '/tmp/version-view', { inode: '9007199254740993' })
    expect(argv[0]).toBe('version')
    expect(argv[1]).toBe('/tmp/version-view')
    expect(argv).not.toContain('--destination')
    expect(argv).toEqual(expect.arrayContaining(['-i', '9007199254740993']))
    expect(argv.some((arg) => arg.startsWith('--version-format'))).toBe(false)
    expect(argv).not.toContain('--full-chain')
    expect(argv).not.toContain('--path')

    const dated = buildVersionArgv(profile, '/tmp/version-view', { inode: '1' }, 'date', '5m')
    expect(dated).toContain('--version-format=date')
    expect(dated).toContain('--idle-timeout=5m')

    // cmd_version.go checks `format != "number" && format != "date"` with no
    // trimming, so a padded value must be trimmed here to pass that check.
    const padded = buildVersionArgv(profile, '/tmp/version-view', { inode: '1' }, '  date  ', '  5m  ')
    expect(padded).toContain('--version-format=date')
    expect(padded).toContain('--idle-timeout=5m')
  })

  it('builds satellite --volname values that are shell-safe (no spaces or parens)', () => {
    // A previewed command is sometimes copied straight into a terminal, so
    // the value can't rely on shell quoting the caller may not add. Mirrors
    // Rust's satellite_volname format exactly: "<volume>-<abbrev>-<4 digits>".
    const cases: [string[], RegExp][] = [
      [buildSnapshotArgv(profile, '/tmp/snap-view', '-1d'), /^vol-1-snap-\d{4}$/],
      [buildDeletedArgv(profile, '/tmp/deleted-view'), /^vol-1-del-\d{4}$/],
      [buildVersionArgv(profile, '/tmp/version-view', { inode: '1' }), /^vol-1-ver-\d{4}$/],
    ]
    for (const [argv, shape] of cases) {
      const volname = argv[argv.indexOf('--volname') + 1]
      expect(volname).toMatch(shape)
      expect(volname).not.toMatch(/[\s()]/)
    }
  })

  it('builds version argv with --path and --full-chain for the browse-picked selector', () => {
    const argv = buildVersionArgv(profile, '/tmp/version-view', { path: '/Volumes/data/report.txt' }, 'number', undefined, true)
    expect(argv).toEqual(expect.arrayContaining(['--path', '/Volumes/data/report.txt']))
    expect(argv).not.toContain('-i')
    expect(argv).toContain('--full-chain')
  })

  it('never emits --type or a volume flag for fork commands', () => {
    const list = buildForkListArgv(profile)
    const create = buildForkCreateArgv(profile, 'child', 'main', '1d')
    const del = buildForkDeleteArgv(profile, 'child', true)
    const restore = buildForkRestoreArgv(profile, 'child')
    for (const argv of [list, create, del, restore]) {
      expect(argv.some((arg) => arg.startsWith('--type'))).toBe(false)
      expect(argv).not.toContain('--volname')
      expect(argv).not.toContain('-m')
    }
    expect(create).toContain('--parent=main')
    expect(create).toContain('--as-of=1d')
    expect(del).toContain('--force')

    // time.Parse/time.ParseInLocation don't trim, so whitespace must be
    // stripped before it reaches argv.
    const padded = buildForkCreateArgv(profile, 'child', '  main  ', '  1d  ')
    expect(padded).toContain('--parent=main')
    expect(padded).toContain('--as-of=1d')
  })

  it('validates folder names', () => {
    expect(isValidFolderName('Team')).toBe(true)
    expect(isValidFolderName('Team Files')).toBe(true)
    expect(isValidFolderName('')).toBe(false)
    expect(isValidFolderName('.')).toBe(false)
    expect(isValidFolderName('..')).toBe(false)
    expect(isValidFolderName('Team/Files')).toBe(false)
    expect(isValidFolderName('Team\\Files')).toBe(false)
    expect(isValidFolderName('Team\0Files')).toBe(false)
  })

  const uploadParams = (): UploadStartParams => ({
    once: false,
    overwrite: false,
    dryRun: false,
    restart: false,
    include: [],
    exclude: [],
    followSymlinks: false,
    createSourceDirectory: false,
  })

  it('builds upload start argv with source/dest as bare positionals after "--" and no flags by default', () => {
    const argv = buildUploadStartArgv(profile, '/local/photos', '/remote/photos', uploadParams())
    expect(argv[0]).toEqual('upload')
    // Flags first, then a literal "--", then exactly the two positionals.
    // This is what makes an arbitrary (even flag-shaped) source/dest value
    // safe: pflag stops scanning for flags at "--".
    const dashdash = argv.indexOf('--')
    expect(dashdash).toBeGreaterThan(-1)
    expect(argv.slice(dashdash + 1)).toEqual(['/local/photos', '/remote/photos'])
    expect(argv).toEqual(expect.arrayContaining(['--discovery-url', 'https://hub.example.com']))
    // Fork is always derived from the profile now (fixture has 'main'),
    // never a form field.
    expect(argv).toEqual(expect.arrayContaining(['--fork', 'main']))
    expect(argv).not.toContain('--once')
    expect(argv).not.toContain('--overwrite')
    expect(argv).not.toContain('--dry-run')
    expect(argv).not.toContain('--restart')
  })

  it('builds upload start argv with every flag set', () => {
    const params: UploadStartParams = {
      once: true,
      overwrite: true,
      dryRun: true,
      rescanInterval: ' 1m ',
      restart: true,
      bwlimit: 50,
      include: ['*.jpg', '  '],
      exclude: ['*.tmp'],
      followSymlinks: true,
      createSourceDirectory: true,
    }
    const argv = buildUploadStartArgv(profile, '/src', '/dst', params)
    expect(argv).toEqual(
      expect.arrayContaining([
        '--fork', 'main',
        '--once',
        '--overwrite',
        '--dry-run',
        '--rescan-interval', '1m',
        '--restart',
        '--bwlimit', '50',
        '--include', '*.jpg',
        '--exclude', '*.tmp',
        '--follow-symlinks',
        '--create-source-directory',
      ]),
    )
    // A blank include/exclude entry must never reach argv as a bare flag.
    expect(argv.filter((arg) => arg === '--include')).toHaveLength(1)
    expect(argv.slice(-2)).toEqual(['/src', '/dst'])
  })

  it('validates positionals and glob patterns', () => {
    expect(validateUploadPositional('/local/photos', 'Source')).toBeNull()
    expect(validateUploadPositional('-rf', 'Source')).toMatch(/must not start with/)
    expect(validateUploadPositional('a\0b', 'Source')).toMatch(/NUL/)
    expect(validateGlobPattern('*.jpg')).toBeNull()
    expect(validateGlobPattern('  ')).toMatch(/empty/)
    expect(validateGlobPattern('a\x01b')).toMatch(/control/)
  })

  it('omits --bwlimit when zero', () => {
    const argv = buildUploadStartArgv(profile, '/src', '/dst', { ...uploadParams(), bwlimit: 0 })
    expect(argv).not.toContain('--bwlimit')
  })

  it('emits source-provider fields for a URI source when set, trimmed', () => {
    const params: UploadStartParams = {
      ...uploadParams(),
      sourceProvider: 's3compatible',
      sourceEndpoint: ' https://example.com ',
      sourceRegion: 'us-east-1',
      sourceAccount: 'myaccount',
      sourceAccessKeyId: 'AKIA1234567890ABCDEF',
    }
    const argv = buildUploadStartArgv(profile, 's3://bucket/prefix', '/dst', params)
    expect(argv).toEqual(
      expect.arrayContaining([
        '--source-provider', 's3compatible',
        '--source-endpoint', 'https://example.com',
        '--source-region', 'us-east-1',
        '--source-account', 'myaccount',
        '--source-access-key-id', 'AKIA1234567890ABCDEF',
      ]),
    )
  })

  it('omits every source field for a folder source', () => {
    const argv = buildUploadStartArgv(profile, '/src', '/dst', uploadParams())
    for (const flag of [
      '--source-provider',
      '--source-endpoint',
      '--source-region',
      '--source-account',
      '--source-access-key-id',
      '--source-temporary-secret-file',
    ]) {
      expect(argv).not.toContain(flag)
    }
  })

  it('emits --source-temporary-secret-file, never --source-secret-file, when a secret path is given', () => {
    const argv = buildUploadStartArgv(profile, 's3://bucket/prefix', '/dst', uploadParams(), '/tmp/source-secret-abc.tmp')
    expect(argv).toEqual(expect.arrayContaining(['--source-temporary-secret-file', '/tmp/source-secret-abc.tmp']))
    expect(argv).not.toContain('--source-secret-file')
  })

  it('detects a URI source the same way the CLI does (looksLikeSourceUri)', () => {
    expect(looksLikeSourceUri('s3://bucket/prefix')).toBe(true)
    expect(looksLikeSourceUri('azblob://container/path')).toBe(true)
    expect(looksLikeSourceUri('/local/absolute/path')).toBe(false)
    expect(looksLikeSourceUri('relative/path')).toBe(false)
    expect(looksLikeSourceUri('C:\\windows\\path')).toBe(false)
  })

  it('builds an external source URI from structured fields, mapping scheme by provider', () => {
    expect(buildExternalSourceUri('s3', 'my-bucket', 'photos/2026')).toBe('s3://my-bucket/photos/2026')
    expect(buildExternalSourceUri('s3compatible', 'my-bucket', '')).toBe('s3://my-bucket')
    expect(buildExternalSourceUri('azure', 'my-container', 'a/b')).toBe('az://my-container/a/b')
    // gcs resolves to s3compatible (resolveWireProvider) and so gets s3://,
    // never gs:// -- see buildExternalSourceUri's own doc comment.
    expect(buildExternalSourceUri('gcs', 'my-bucket', '')).toBe('s3://my-bucket')
  })

  it('trims slashes and returns null for a blank bucket when building an external source URI', () => {
    expect(buildExternalSourceUri('s3', '  /my-bucket/  ', '/photos/')).toBe('s3://my-bucket/photos')
    expect(buildExternalSourceUri('s3', '', 'photos')).toBeNull()
    expect(buildExternalSourceUri('s3', '   ', 'photos')).toBeNull()
  })

  it('validates external source fields against each provider\'s real requirements', () => {
    expect(validateExternalSourceFields('s3', 'bucket', '', '', 'AKIA...')).toBeNull()
    expect(validateExternalSourceFields('s3', '', '', '', 'AKIA...')).toMatch(/bucket/i)
    expect(validateExternalSourceFields('s3compatible', 'bucket', '', '', 'AKIA...')).toMatch(/endpoint/i)
    expect(validateExternalSourceFields('s3compatible', 'bucket', 'https://x', '', 'AKIA...')).toBeNull()
    expect(validateExternalSourceFields('azure', 'container', '', '', '')).toMatch(/account/i)
    expect(validateExternalSourceFields('azure', 'container', '', 'myaccount', '')).toBeNull()
    expect(validateExternalSourceFields('s3', 'bucket', '', '', '')).toMatch(/access key/i)
    // gcs authenticates via GCS's S3-compatible HMAC access key/secret, not
    // a service-account JSON key, so the access key id is required too.
    expect(validateExternalSourceFields('gcs', 'bucket', '', '', '')).toMatch(/access key/i)
    expect(validateExternalSourceFields('gcs', 'bucket', '', '', 'GOOG...')).toBeNull()
  })

  it('rejects a blank provider instead of silently defaulting to s3', () => {
    expect(validateExternalSourceFields('', 'bucket', '', '', 'AKIA...')).toMatch(/provider/i)
    expect(validateExternalSourceFields('  ', 'bucket', '', '', 'AKIA...')).toMatch(/provider/i)
  })

  it('gives upload resume a smaller flag surface than start', () => {
    const argv = buildUploadResumeArgv(profile, 'abcdef1234567890', true, ' 45s ')
    expect(argv.slice(0, 3)).toEqual(['upload', 'resume', 'abcdef1234567890'])
    expect(argv).toContain('--once')
    expect(argv).toEqual(expect.arrayContaining(['--rescan-interval', '45s']))
    expect(argv).not.toContain('--overwrite')
    expect(argv).not.toContain('--bwlimit')
    expect(argv).not.toContain('--dry-run')
  })

  it('carries no credentials or discovery-url for the local-only upload commands', () => {
    expect(buildUploadListArgv()).toEqual(['list', '--kind', 'upload', '--json'])
    expect(buildUploadCancelArgv('job123')).toEqual(['upload', 'cancel', 'job123'])
    expect(buildUploadRetryFailedArgv('job123')).toEqual(['upload', 'retry-failed', 'job123'])
    expect(buildUploadPruneArgv(0)).toEqual(['upload', 'prune'])
    expect(buildUploadPruneArgv(5)).toEqual(['upload', 'prune', '--keep', '5'])
  })

  const downloadParams = (): DownloadStartParams => ({
    ifExists: 'skip',
    depth: 1,
    dryRun: false,
    restart: false,
    includeGlobs: [],
    excludeGlobs: [],
    followSymlinks: false,
    createSourceDirectory: false,
  })

  it('builds download start argv (profile mode) with source/dest as bare positionals after "--" and no flags by default', () => {
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', '/local/backups/photos', downloadParams())
    expect(argv[0]).toEqual('download')
    const dashdash = argv.indexOf('--')
    expect(dashdash).toBeGreaterThan(-1)
    expect(argv.slice(dashdash + 1)).toEqual(['photos', '/local/backups/photos'])
    expect(argv).toEqual(expect.arrayContaining(['--discovery-url', 'https://hub.example.com']))
    expect(argv).toEqual(expect.arrayContaining(['--fork', 'main']))
    expect(argv).toContain('-a')
    expect(argv).toContain('-s')
    // Defaults matching the server's own default are omitted entirely.
    expect(argv).not.toContain('--if-exists')
    expect(argv).not.toContain('--depth')
    expect(argv).not.toContain('--as-of')
    expect(argv).not.toContain('--dry-run')
    expect(argv).not.toContain('--restart')
  })

  it('builds download start argv (instance mode) with no connection flags at all', () => {
    // Mode A: no --discovery-url/--fork/--as-of/-a/-s, even when a
    // populated profile is passed by mistake, sourceKind gates this, not
    // profile emptiness.
    const argv = buildDownloadStartArgv(
      profile,
      'instance',
      '/Volumes/myvol/photos',
      '/local/backups/photos',
      { ...downloadParams(), asOf: '1d' },
    )
    expect(argv).not.toContain('--discovery-url')
    expect(argv).not.toContain('--fork')
    expect(argv.some((arg) => arg.startsWith('--as-of'))).toBe(false)
    expect(argv).not.toContain('-a')
    expect(argv).not.toContain('-s')
    const dashdash = argv.indexOf('--')
    expect(argv.slice(dashdash + 1)).toEqual(['/Volumes/myvol/photos', '/local/backups/photos'])
  })

  it('throws when profile mode is requested without a profile', () => {
    expect(() => buildDownloadStartArgv(null, 'profile', 'photos', '/dst', downloadParams())).toThrow()
  })

  it('builds download start argv with every flag set', () => {
    const params: DownloadStartParams = {
      ifExists: 'overwrite',
      depth: 0,
      asOf: ' 1d ',
      dryRun: true,
      restart: true,
      bwlimitMbps: 50,
      includeGlobs: ['*.jpg', '  '],
      excludeGlobs: ['*.tmp'],
      followSymlinks: true,
      createSourceDirectory: true,
    }
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', '/dst', params)
    expect(argv).toEqual(
      expect.arrayContaining([
        '--if-exists', 'overwrite',
        '--depth', '0',
        '--as-of=1d',
        '--dry-run',
        '--restart',
        '--bwlimit', '50',
        '--include', '*.jpg',
        '--exclude', '*.tmp',
        '--follow-symlinks',
        '--create-source-directory',
      ]),
    )
    expect(argv.filter((arg) => arg === '--include')).toHaveLength(1)
    expect(argv.slice(-2)).toEqual(['photos', '/dst'])
  })

  it('omits --bwlimit when zero', () => {
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', '/dst', { ...downloadParams(), bwlimitMbps: 0 })
    expect(argv).not.toContain('--bwlimit')
  })

  it('emits dest-provider fields for a URI dest when set, trimmed', () => {
    const params: DownloadStartParams = {
      ...downloadParams(),
      destProvider: 's3compatible',
      destEndpoint: ' https://example.com ',
      destRegion: 'us-east-1',
      destAccount: 'myaccount',
      destAccessKeyId: 'AKIA1234567890ABCDEF',
    }
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', 's3://bucket/prefix', params)
    expect(argv).toEqual(
      expect.arrayContaining([
        '--dest-provider', 's3compatible',
        '--dest-endpoint', 'https://example.com',
        '--dest-region', 'us-east-1',
        '--dest-account', 'myaccount',
        '--dest-access-key-id', 'AKIA1234567890ABCDEF',
      ]),
    )
  })

  it('omits every dest field for a local dest', () => {
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', '/dst', downloadParams())
    for (const flag of [
      '--dest-provider',
      '--dest-endpoint',
      '--dest-region',
      '--dest-account',
      '--dest-access-key-id',
      '--dest-temporary-secret-file',
    ]) {
      expect(argv).not.toContain(flag)
    }
  })

  it('emits --dest-temporary-secret-file, never --dest-secret-file, when a secret path is given', () => {
    const argv = buildDownloadStartArgv(profile, 'profile', 'photos', 's3://bucket/prefix', downloadParams(), '/tmp/dest-secret-abc.tmp')
    expect(argv).toEqual(expect.arrayContaining(['--dest-temporary-secret-file', '/tmp/dest-secret-abc.tmp']))
    expect(argv).not.toContain('--dest-secret-file')
  })

  it('gives download resume a smaller flag surface than start, with no once/rescan-interval at all', () => {
    const argv = buildDownloadResumeArgv(profile, 'abcdef1234567890')
    expect(argv.slice(0, 3)).toEqual(['download', 'resume', 'abcdef1234567890'])
    expect(argv).toEqual(expect.arrayContaining(['--discovery-url', 'https://hub.example.com']))
    expect(argv).toContain('-a')
    expect(argv).toContain('-s')
    expect(argv).not.toContain('--once')
    expect(argv).not.toContain('--rescan-interval')
    expect(argv).not.toContain('--dry-run')
  })

  it('carries no credentials for a mounted-source download resume', () => {
    const mountedProfile: MountProfile = { ...profile, discoveryUrl: '', accessKeyId: '' }
    expect(buildDownloadResumeArgv(mountedProfile, 'abcdef1234567890')).toEqual([
      'download',
      'resume',
      'abcdef1234567890',
    ])
  })

  it('carries no credentials or discovery-url for the local-only download commands', () => {
    expect(buildDownloadListArgv()).toEqual(['list', '--kind', 'download', '--json'])
    expect(buildDownloadCancelArgv('job123')).toEqual(['download', 'cancel', 'job123'])
    expect(buildDownloadRetryFailedArgv('job123')).toEqual(['download', 'retry-failed', 'job123'])
    expect(buildDownloadPruneArgv(0)).toEqual(['download', 'prune'])
    expect(buildDownloadPruneArgv(5)).toEqual(['download', 'prune', '--keep', '5'])
  })

  const sinkParams = (): SinkStartParams => ({})

  // Fixture argv shared with src-tauri/src/lib.rs's identically-named Rust
  // test (build_sink_start_argv_emits_source_and_dest_as_bare_positionals_
  // after_dashdash): both assert this EXACT array for the SAME inputs, so
  // a flag spelling/order change that isn't mirrored in the other builder
  // fails one of the two suites. The preview argv (this file) and the argv
  // that actually runs (lib.rs) must never drift apart.
  it('builds sink start argv matching the Rust build_sink_start_argv fixture exactly', () => {
    const argv = buildSinkStartArgv(
      profile,
      'https://example.com/live/stream.m3u8',
      '/recordings/feed.mp4',
      sinkParams(),
    )
    expect(argv).toEqual([
      'sink',
      '--discovery-url', 'https://hub.example.com',
      '--fork', 'main',
      '-a', 'ABCDEFGHIJKLMNOPQRST',
      '-s',
      '--',
      'https://example.com/live/stream.m3u8',
      '/recordings/feed.mp4',
    ])
  })

  it('builds sink start argv with every advanced flag set, and none of upload/download\'s flag surface', () => {
    const params: SinkStartParams = { variant: ' 1080p ', maxLatency: ' 45s ', walMax: ' 512M ' }
    const argv = buildSinkStartArgv(profile, 'https://example.com/live.m3u8', '/feed.mp4', params)
    expect(argv).toEqual(expect.arrayContaining(['--variant', '1080p', '--max-latency', '45s', '--wal-max', '512M']))
    expect(argv).not.toContain('--once')
    expect(argv).not.toContain('--overwrite')
    expect(argv).not.toContain('--dry-run')
    expect(argv).not.toContain('--bwlimit')
    expect(argv).not.toContain('--include')
    expect(argv).not.toContain('--follow-symlinks')
    expect(argv).not.toContain('--create-source-directory')
    expect(argv).not.toContain('--config')
  })

  it('omits unset sink advanced flags', () => {
    const argv = buildSinkStartArgv(profile, 'https://example.com/live.m3u8', '/feed.mp4', sinkParams())
    expect(argv).not.toContain('--variant')
    expect(argv).not.toContain('--max-latency')
    expect(argv).not.toContain('--wal-max')
  })

  it('gives sink resume no flags of its own, matching the Rust build_sink_resume_argv fixture', () => {
    expect(buildSinkResumeArgv(profile, 'abcdef1234567890')).toEqual([
      'sink',
      'resume',
      'abcdef1234567890',
      '--discovery-url', 'https://hub.example.com',
      '-a', 'ABCDEFGHIJKLMNOPQRST',
      '-s',
    ])
  })

  it('carries no credentials for the local-only sink list/cancel/finish/status commands, and sink list is its own subcommand', () => {
    expect(buildSinkListArgv()).toEqual(['sink', 'list', '--json'])
    expect(buildSinkCancelArgv('job123')).toEqual(['sink', 'cancel', 'job123'])
    expect(buildSinkFinishArgv('job123')).toEqual(['sink', 'finish', 'job123'])
    expect(buildSinkStatusArgv('job123')).toEqual(['sink', 'status', '--job', 'job123', '--json'])
  })

  it('builds sink prune argv, keep omitted at 0', () => {
    expect(buildSinkPruneArgv(0)).toEqual(['sink', 'prune'])
    expect(buildSinkPruneArgv(5)).toEqual(['sink', 'prune', '--keep', '5'])
  })
})
