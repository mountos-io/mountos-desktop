#!/bin/sh
# Source (do not execute) from make targets that shell out to cargo:
#   . scripts/ensure-rust.sh && npm run tauri:dev
#
# rustup records the toolchain in the Windows User PATH, or in ~/.cargo/env on
# Unix. Neither reaches a shell that was started before the install, nor any
# shell spawned from such a parent, so cargo reads as missing when it is in
# fact present. Recover it from the known install location, and only offer to
# install rustup when the toolchain is genuinely absent.

_rust_activate() {
  command -v cargo >/dev/null 2>&1 && return 0
  [ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  command -v cargo >/dev/null 2>&1 && return 0
  if [ -x "$HOME/.cargo/bin/cargo" ] || [ -x "$HOME/.cargo/bin/cargo.exe" ]; then
    PATH="$HOME/.cargo/bin:$PATH"
    export PATH
  fi
  command -v cargo >/dev/null 2>&1
}

_rust_install_cmd() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) echo "winget install --id Rustlang.Rustup -e --source winget" ;;
    *) echo "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" ;;
  esac
}

_rust_ensure() {
  _rust_activate && return 0

  # RUST_CHECK_ONLY=1 reports availability without prompting or installing.
  [ "$RUST_CHECK_ONLY" = "1" ] && return 1

  _rust_cmd=$(_rust_install_cmd)

  # RUST_AUTO_INSTALL=1 skips the prompt; a non-interactive shell (CI) never
  # installs silently and fails with the command to run instead.
  if [ "$RUST_AUTO_INSTALL" = "1" ]; then
    _rust_reply=y
  elif [ -r /dev/tty ]; then
    printf 'cargo not found. Install the Rust toolchain now? [y/N] ' >/dev/tty
    read -r _rust_reply </dev/tty
  else
    _rust_reply=n
  fi

  case "$_rust_reply" in
    [yY]*) ;;
    *)
      echo "error: cargo is required. Install with:" >&2
      echo "  $_rust_cmd" >&2
      return 1
      ;;
  esac

  sh -c "$_rust_cmd" || {
    echo "error: install failed. Run manually:" >&2
    echo "  $_rust_cmd" >&2
    return 1
  }

  _rust_activate || {
    echo "error: cargo still not resolvable after install; open a new shell and retry" >&2
    return 1
  }
}

_rust_ensure
