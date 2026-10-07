export type SparkReading = {
  totalGb: number
  freeGb: number
  load1: number
  // False when the host has no nvidia-smi; the line then leaves the GPU out.
  hasGpu: boolean
  // GPU processes' memory; null when nvidia-smi gave a row that is not a number (N/A, an error line).
  gpuGb: number | null
  // When the numbers were read, in ms since the epoch.
  at: number
  // Set when the last attempt failed; the numbers are then the last good ones (or zero before any).
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'spark-band': { reading: SparkReading | null }
  }
}
