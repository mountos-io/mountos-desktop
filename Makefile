.DEFAULT_GOAL := help

MOUNTOS ?= ../mountos-servers/bin/mountos

# Packaging & signing. macOS releases are universal binaries; Windows has no
# universal format, so both architectures are built and signed separately.
APP_NAME := mountOS Desktop
MAC_TARGET := universal-apple-darwin
MAC_BUNDLE_DIR := src-tauri/target/$(MAC_TARGET)/release/bundle
MAC_APP := $(MAC_BUNDLE_DIR)/macos/$(APP_NAME).app
WIN_TARGETS := x86_64-pc-windows-msvc aarch64-pc-windows-msvc

# signtool ships with the Windows SDK and is not on PATH in a stock shell, so
# fall back to the newest SDK build that has it rather than failing with
# "command not found". Override with SIGNTOOL=/path/to/signtool.exe.
SIGNTOOL ?= $(shell command -v signtool 2>/dev/null || ls -1 "/c/Program Files (x86)/Windows Kits/10/bin"/*/x64/signtool.exe 2>/dev/null | sort | tail -1)

# PATH edits do not survive between recipes, so every recipe invoking cargo,
# rustup or tauri sources the guard itself rather than depending on a target.
RUST := . scripts/ensure-rust.sh &&

.PHONY: help doctor install dev desktop-dev check test test-rust lint format build desktop-build cli-smoke verify clean \
	bundle sign-macos notarize-macos sign-windows release-macos release-windows \
	bump-patch bump-minor bump-major set-version licenses

help: ## List every available make command
	@awk 'BEGIN {FS = ":.*## "; printf "mountOS Desktop commands:\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

doctor: ## Report which build prerequisites are present, installing nothing
	@scripts/doctor.sh

# Real target, not phony: deps reinstall only when the lockfile outruns the
# tree, which is what lets every consumer depend on it for free.
node_modules: package-lock.json package.json
	npm ci
	@touch node_modules

install: ## Install JavaScript dependencies from the lockfile
	npm ci
	@touch node_modules

dev: node_modules ## Start the browser UI development server
	npm run dev

desktop-dev: node_modules ## Start the Tauri desktop application in development mode
	@$(RUST) npm run tauri:dev

check: node_modules ## Run Svelte and TypeScript static checks
	npm run check

test: node_modules ## Run TypeScript unit tests
	npm test

test-rust: ## Run Rust unit and documentation tests
	@$(RUST) cargo test --manifest-path src-tauri/Cargo.toml

lint: ## Run strict Rust Clippy checks
	@$(RUST) cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

format: ## Format Rust source files
	@$(RUST) cargo fmt --manifest-path src-tauri/Cargo.toml

build: node_modules ## Build the production web assets
	npm run build

desktop-build: node_modules ## Build the packaged desktop application
	@$(RUST) npm run tauri:build

# Runs the real `npm run build` frontend step (same minified dist/ a release
# ships), but compiles the Tauri shell in the debug Cargo profile so the
# WebKit Web Inspector stays available (Cmd+Option+I / right-click > Inspect
# Element). Use this to reproduce a bug that only shows up against the
# production frontend bundle, e.g. a class dropped by CSS purging/minification
# that unminified `desktop-dev` assets never exercise.
desktop-build-debug: node_modules ## Build a debug binary against production (minified) frontend assets, for reproducing prod-only bugs with devtools
	@$(RUST) npm run tauri:build -- --debug --no-bundle
	@echo "Binary: src-tauri/target/debug/mountos-desktop"

cli-smoke: ## Verify the configured mountos CLI public read commands
	$(MOUNTOS) --version
	$(MOUNTOS) check --json >/dev/null
	$(MOUNTOS) list --json >/dev/null

verify: check test test-rust lint build ## Run all local verification except packaging

# With APPLE_SIGNING_IDENTITY exported, Tauri signs the .app and .dmg during
# bundling, so release-macos only needs notarization afterwards. sign-macos is
# the standalone fallback for re-signing an unsigned .app (the .dmg must be
# rebuilt after a re-sign or it ships the unsigned copy).
bundle: node_modules ## Build distributable bundles (macOS universal app+dmg, Windows x64+arm64 nsis)
ifeq ($(OS),Windows_NT)
	@$(RUST) rustup target add $(WIN_TARGETS)
	@$(RUST) for target in $(WIN_TARGETS); do \
		npm run tauri:build -- --target $$target --bundles nsis || exit 1; \
	done
else
	@$(RUST) rustup target add x86_64-apple-darwin aarch64-apple-darwin
	@$(RUST) npm run tauri:build -- --target $(MAC_TARGET) --bundles app,dmg
endif

sign-macos: ## Codesign the built .app (env: APPLE_SIGNING_IDENTITY)
	@test -n "$(APPLE_SIGNING_IDENTITY)" || { echo "error: APPLE_SIGNING_IDENTITY is required (Developer ID Application identity)"; exit 1; }
	codesign --force --options runtime --timestamp --sign "$(APPLE_SIGNING_IDENTITY)" "$(MAC_APP)"
	codesign --verify --deep --strict "$(MAC_APP)"

notarize-macos: ## Notarize + staple the .dmg (env: APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
	@test -n "$(APPLE_ID)" || { echo "error: APPLE_ID is required"; exit 1; }
	@test -n "$(APPLE_PASSWORD)" || { echo "error: APPLE_PASSWORD (app-specific password) is required"; exit 1; }
	@test -n "$(APPLE_TEAM_ID)" || { echo "error: APPLE_TEAM_ID is required"; exit 1; }
	@dmg=$$(ls "$(MAC_BUNDLE_DIR)/dmg"/*.dmg 2>/dev/null | head -1); \
	test -n "$$dmg" || { echo "error: no .dmg under $(MAC_BUNDLE_DIR)/dmg; run make bundle first"; exit 1; }; \
	xcrun notarytool submit "$$dmg" --apple-id "$(APPLE_ID)" --password "$(APPLE_PASSWORD)" --team-id "$(APPLE_TEAM_ID)" --wait; \
	xcrun stapler staple "$$dmg"

# Run from a POSIX shell (Git Bash or CI); signtool comes from the Windows SDK.
# Signs with the certificate already imported into the Windows cert store, so
# no password ever appears on a command line.
# MSYS_NO_PATHCONV=1: Git Bash rewrites arguments that look like absolute paths,
# turning /fd into C:/Program Files/Git/fd. signtool then reports "No file digest
# algorithm specified" even though the flag is right there in the command.
sign-windows: ## signtool-sign every built NSIS installer, both arches (env: WINDOWS_CERT_THUMBPRINT TIMESTAMP_URL)
	@test -n "$(WINDOWS_CERT_THUMBPRINT)" || { echo "error: WINDOWS_CERT_THUMBPRINT (SHA1 thumbprint of the store-imported cert) is required"; exit 1; }
	@test -n "$(TIMESTAMP_URL)" || { echo "error: TIMESTAMP_URL is required (your CA's RFC 3161 server, e.g. http://time.certum.pl or http://timestamp.digicert.com)"; exit 1; }
	@test -n "$(SIGNTOOL)" || { echo "error: signtool.exe not found. Install the Windows SDK, or pass SIGNTOOL=/path/to/signtool.exe"; exit 1; }
	@found=0; \
	for target in $(WIN_TARGETS); do \
		for exe in src-tauri/target/$$target/release/bundle/nsis/*.exe; do \
			[ -e "$$exe" ] || continue; \
			found=1; \
			MSYS_NO_PATHCONV=1 "$(SIGNTOOL)" sign /fd SHA256 /td SHA256 /tr "$(TIMESTAMP_URL)" /sha1 "$(WINDOWS_CERT_THUMBPRINT)" "$$exe" || exit 1; \
			MSYS_NO_PATHCONV=1 "$(SIGNTOOL)" verify /pa "$$exe" || exit 1; \
		done; \
	done; \
	test "$$found" = "1" || { echo "error: no installer under src-tauri/target/<arch>/release/bundle/nsis; run make bundle first"; exit 1; }

release-macos: bundle notarize-macos ## Bundle (signed via env) then notarize for macOS
release-windows: bundle sign-windows ## Bundle then signtool-sign for Windows

clean: ## Remove generated frontend and Rust build artifacts
	rm -rf dist src-tauri/target

bump-patch: ## Bump package.json + tauri.conf.json patch version (default routine bump)
	@scripts/bump-version.sh patch

bump-minor: ## Bump package.json + tauri.conf.json minor version
	@scripts/bump-version.sh minor

bump-major: ## Bump package.json + tauri.conf.json major version
	@scripts/bump-version.sh major

set-version: ## Force an exact version, e.g. make set-version VERSION=1.0.0
	@test -n "$(VERSION)" || { echo "error: VERSION is required, e.g. make set-version VERSION=1.0.0"; exit 1; }
	@scripts/bump-version.sh set "$(VERSION)"

licenses: ## Regenerate LICENSES/{rust,js}.json regardless of whether the lockfiles changed
	@scripts/generate-licenses.sh --force
