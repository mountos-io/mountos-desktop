#!/bin/sh
# Read-only prerequisite report for the desktop build. Installs nothing and
# changes nothing; exits non-zero when a required tool is missing.

cd "$(dirname "$0")/.." || exit 1

status=0
row() { printf '  %-14s %s\n' "$1" "$2"; }
miss() { printf '  %-14s MISSING - %s\n' "$1" "$2"; status=1; }

echo "mountOS Desktop prerequisites:"
echo

if command -v node >/dev/null 2>&1; then row node "$(node --version)"; else miss node "install Node.js"; fi
if command -v npm >/dev/null 2>&1; then row npm "$(npm --version)"; else miss npm "ships with Node.js"; fi

# Report cargo as the build sees it, then recover it the same way the build
# does, so a toolchain that is installed but off PATH reads as present.
cargo_on_path=yes
command -v cargo >/dev/null 2>&1 || cargo_on_path=no
RUST_CHECK_ONLY=1
. scripts/ensure-rust.sh
unset RUST_CHECK_ONLY

if command -v cargo >/dev/null 2>&1; then
  suffix=""
  [ "$cargo_on_path" = no ] && suffix=" (off PATH; recovered from ~/.cargo/bin)"
  row cargo "$(cargo --version | cut -d' ' -f2)$suffix"
  row rustc "$(rustc --version | cut -d' ' -f2)"
  if command -v rustup >/dev/null 2>&1; then
    row rustup "$(rustup --version 2>/dev/null | head -1 | cut -d' ' -f2)"
    row targets "$(rustup target list --installed 2>/dev/null | tr '\n' ' ')"
  else
    miss rustup "toolchain not managed by rustup; target adds will fail"
  fi
else
  miss cargo "run any build target and accept the install prompt"
fi

if [ ! -d node_modules ]; then
  miss node_modules "run make install"
elif [ package-lock.json -nt node_modules ]; then
  row node_modules "stale - lockfile is newer (run make install)"
else
  row node_modules "present"
fi

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    # Take the target arch from rustc, never from uname: an emulated Git Bash
    # reports x86_64 on an arm64 host, which would probe the wrong linker.
    case "$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}')" in
      aarch64-*) arch=arm64 ;;
      x86_64-*) arch=x64 ;;
      i686-*) arch=x86 ;;
      *) arch="" ;;
    esac

    msvc=""
    if [ -n "$arch" ]; then
      for lk in "/c/Program Files/Microsoft Visual Studio"/*/*/VC/Tools/MSVC/*/bin/"Host$arch"/"$arch"/link.exe; do
        [ -e "$lk" ] && msvc=$lk
      done
      # A cross linker emitting the host arch still links, just not natively.
      for lk in "/c/Program Files/Microsoft Visual Studio"/*/*/VC/Tools/MSVC/*/bin/Host*/"$arch"/link.exe; do
        [ -z "$msvc" ] && [ -e "$lk" ] && msvc=$lk
      done
    fi

    # .../MSVC/<version>/bin/Host<host>/<target>/link.exe
    if [ -n "$msvc" ]; then
      row "msvc linker" "$(echo "$msvc" | awk -F/ '{print $(NF-4)" ("$(NF-2)" -> "$(NF-1)")"}')"
    elif [ -z "$arch" ]; then
      miss "msvc linker" "target arch unknown until cargo is installed"
    else
      miss "msvc linker" "no link.exe emitting $arch; add the MSVC C++ workload for $arch"
    fi

    wv=$(reg query 'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' //v pv 2>/dev/null | awk '/pv/ {print $NF}')
    if [ -n "$wv" ]; then row webview2 "$wv"; else miss webview2 "install the WebView2 Evergreen Runtime"; fi
    ;;
esac

echo
[ "$status" = 0 ] && echo "  all prerequisites satisfied" || echo "  some prerequisites are missing (see above)"
exit "$status"
