export type CellFeatures = {
  luminance: number
  saturation: number
  hue: number
  contrast: number
  edgeDensity: number
}

export type ManifestItem = {
  /** Content hash; the cell file is `cells/<id>.webp` (or `cells-<px>/` for a smaller size). */
  id: string
  /** Position in the manifest, which is also the picture's slot in the preview file. */
  index: number
  features: CellFeatures
}

export type Manifest = {
  version: number
  cellSize: number
  /** Published cell sizes in px, largest first; `cellSize` is always one of them. */
  sizes: number[]
  items: ManifestItem[]
  /** One ThumbHash per item, `stride` bytes each, in manifest order. */
  thumbs: { url: string; stride: number } | null
}

export type FeatureKey = keyof CellFeatures
