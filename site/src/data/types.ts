export type CellFeatures = {
  luminance: number
  saturation: number
  hue: number
  contrast: number
  edgeDensity: number
}

export type ManifestItem = {
  id: string
  sourceId: string
  cellIndex: number
  sourceFile: string
  crop: [number, number, number, number]
  asset: string
  features: CellFeatures
  excluded?: boolean
}

export type Manifest = {
  datasetVersion: number
  cellSize: number
  sourceCount: number
  cellCount: number
  excludedCount: number
  items: ManifestItem[]
  failures?: { path: string; error: string }[]
}

export type FeatureKey = keyof CellFeatures
