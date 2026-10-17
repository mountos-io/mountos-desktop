# mountOS Desktop

Open-source desktop app for [mountOS](https://mountos.io), a cross-platform, forkable, time-traveling distributed filesystem over object storage. Manage mounted volumes and connection profiles, run background uploads and downloads with live progress, ingest live HLS streams, browse forks, snapshots, and versions, and recover deleted files, on macOS and Windows.

Built with Tauri 2, Svelte 5, and TypeScript.

## Development

Install dependencies and start the desktop application:

```sh
make install
make desktop-dev
```

Run the local verification suite:

```sh
make verify
```

Build the packaged desktop application:

```sh
make desktop-build
```

List every available command with `make help`.

## Packaging and signing

`make bundle` builds the distributable bundles for the current platform. macOS produces a universal `.app` + `.dmg` (Apple Silicon and Intel in one binary). Windows has no universal format, so both `x86_64` and `aarch64` NSIS installers are built, and `sign-windows` signs every installer it finds. The rule installs the required Rust targets automatically (the Windows arm64 build additionally needs the MSVC arm64 build tools). Signing and notarization read credentials from the environment, never from files in this repo.

### macOS

Export the signing identity before bundling so Tauri signs the `.app` and `.dmg` during the build, then notarize.

```sh
make release-macos
```

| Variable | Used by | Meaning |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | bundle, `sign-macos` | Developer ID Application identity name |
| `APPLE_ID` | `notarize-macos` | Apple ID email for notarytool |
| `APPLE_PASSWORD` | `notarize-macos` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | `notarize-macos` | Apple Developer team identifier |

`make sign-macos` re-signs an already-built `.app` in place. After a re-sign, rebuild the `.dmg` or it ships the previously signed copy.

### Windows

Run from a POSIX shell (Git Bash or CI). `signtool` comes from the Windows SDK. The EV code-signing certificate must already be imported into the Windows certificate store; signing references it by thumbprint, so no password appears on any command line. The private key stays on the EV hardware token (Certum card), and the token client (proCertum CardManager) shows its PIN dialog at signing time, so the card must be plugged in and the run attended unless the client's PIN caching is enabled.

```sh
make release-windows
```

| Variable | Used by | Meaning |
|---|---|---|
| `WINDOWS_CERT_THUMBPRINT` | `sign-windows` | SHA1 thumbprint of the store-imported certificate |
| `TIMESTAMP_URL` | `sign-windows` | Required. Your CA's RFC 3161 timestamp server (Certum `http://time.certum.pl`, DigiCert `http://timestamp.digicert.com`) |
