import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Only "macos"/"windows" ever ship (see tauri.conf.json's bundle.targets:
// app/dmg/nsis, no linux target), Rust-sourced (SystemState.platform), not
// navigator sniffing, since this app already has an authoritative answer.
export function isMacPlatform(platform: string): boolean {
  return platform !== 'windows'
}

// event.metaKey is the Cmd key on macOS but the Windows/Super key elsewhere,
// which OS-level shortcuts already claim, Windows/Linux users need ctrlKey
// for an app shortcut to actually reach them.
export function modKeyPressed(event: KeyboardEvent, platform: string): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey
}

// Binary units (KiB/MiB/...), not decimal (KB/MB/...), matches the rest of
// mountOS's byte-size vocabulary (block size, buffer budgets, disk cache).
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[exponent]}`
}

export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;

export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
