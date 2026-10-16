import type { Manifest } from './types'

const DEFAULT_BASE = import.meta.env.VITE_ASSETS_BASE ?? '/prepared'

export function assetsBase(): string {
  return DEFAULT_BASE.replace(/\/$/, '')
}

export function assetUrl(relative: string): string {
  const path = relative.replace(/^\//, '')
  return `${assetsBase()}/${path}`
}

export async function loadManifest(): Promise<Manifest> {
  const url = `${assetsBase()}/manifest.json`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to load manifest from ${url} (${res.status})`)
  }
  return (await res.json()) as Manifest
}
