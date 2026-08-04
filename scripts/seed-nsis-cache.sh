#!/bin/sh
# Seed Tauri's NSIS toolchain cache so `make bundle` does not have to download it.
#
# Why this exists: tauri-bundler fetches NSIS and its nsis_tauri_utils plugin on
# first use, and its HTTP client times out (`failed to bundle project: timeout:
# global`) on networks where curl pulls the same URLs in seconds. Worse, it
# validates the cache against a fixed file list and DELETES the whole directory
# when anything is missing, so a partial cache re-downloads on every run and the
# failure never changes shape.
#
# The URLs and SHA-1s below are the ones compiled into the CLI, so what this
# places is byte-identical to what the bundler would have fetched itself. If the
# Tauri CLI is upgraded and the expected files change, read the current values
# out of the binary:
#
#   rg -a -o "https://github.com/tauri-apps/[A-Za-z0-9/_.-]*" \
#     node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node
#
# and the required file list from crates/tauri-bundler/src/bundle/windows/nsis
# in the tauri repo at the matching tag.
set -e

NSIS_URL="https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
NSIS_SHA1="EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D"
PLUGIN_URL="https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
PLUGIN_SHA1="75197FEE3C6A814FE035788D1C34EAD39349B860"

cache_root="${LOCALAPPDATA:-$HOME/AppData/Local}/tauri"
nsis_dir="$cache_root/NSIS"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sha1_of() { sha1sum "$1" | cut -d' ' -f1 | tr 'a-f' 'A-F'; }

echo "Downloading NSIS toolchain..."
curl -sSL --retry 3 --retry-delay 2 -o "$tmp/nsis.zip" "$NSIS_URL"
got=$(sha1_of "$tmp/nsis.zip")
[ "$got" = "$NSIS_SHA1" ] || { echo "error: NSIS sha1 mismatch (got $got, want $NSIS_SHA1)" >&2; exit 1; }

echo "Downloading nsis_tauri_utils plugin..."
curl -sSL --retry 3 --retry-delay 2 -o "$tmp/nsis_tauri_utils.dll" "$PLUGIN_URL"
got=$(sha1_of "$tmp/nsis_tauri_utils.dll")
[ "$got" = "$PLUGIN_SHA1" ] || { echo "error: plugin sha1 mismatch (got $got, want $PLUGIN_SHA1)" >&2; exit 1; }

echo "Installing into $nsis_dir"
rm -rf "$nsis_dir"
mkdir -p "$cache_root"
unzip -q -o "$tmp/nsis.zip" -d "$cache_root"
mv "$cache_root/nsis-3.11" "$nsis_dir"

# The plugin belongs in Plugins/x86-unicode/additional/, NOT one level up in
# x86-unicode/. Getting that wrong leaves the cache "incomplete" and the
# bundler silently wipes and re-downloads it.
mkdir -p "$nsis_dir/Plugins/x86-unicode/additional"
cp "$tmp/nsis_tauri_utils.dll" "$nsis_dir/Plugins/x86-unicode/additional/"

status=0
for f in makensis.exe Bin/makensis.exe Stubs/lzma-x86-unicode \
         Stubs/lzma_solid-x86-unicode \
         Plugins/x86-unicode/additional/nsis_tauri_utils.dll \
         Include/MUI2.nsh Include/FileFunc.nsh Include/x64.nsh \
         Include/nsDialogs.nsh Include/WinMessages.nsh \
         Include/Win/COM.nsh Include/Win/Propkey.nsh \
         Include/Win/RestartManager.nsh; do
  [ -e "$nsis_dir/$f" ] || { echo "missing after seed: $f" >&2; status=1; }
done
[ "$status" = 0 ] || exit 1

echo "NSIS cache seeded and verified (13/13 required files)."
