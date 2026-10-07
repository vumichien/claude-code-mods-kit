// Pure helpers for spark-band: parse the probe's output and say it in one line.

import type { SparkReading } from '../types'

// Read-only: memory totals, the 1-minute load, and the memory each GPU process holds (MiB).
// A host without nvidia-smi answers `no-gpu` instead of failing the whole probe.
export const PROBE =
  "free -g | awk 'NR==2{print $2, $7}'; cut -d' ' -f1 /proc/loadavg; " +
  'if command -v nvidia-smi >/dev/null 2>&1; then ' +
  'nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits; else echo no-gpu; fi'

export function parseProbe(stdout: string, at: number): SparkReading {
  const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const [totalGb = NaN, freeGb = NaN] = (lines[0] ?? '').split(/\s+/).map(Number)
  const load1 = Number(lines[1])
  if (![totalGb, freeGb, load1].every(Number.isFinite)) throw new Error('unexpected probe output')
  const gpuRows = lines.slice(2)
  if (gpuRows.length === 1 && gpuRows[0] === 'no-gpu') return { totalGb, freeGb, load1, hasGpu: false, gpuGb: null, at, error: null }
  // No rows means no GPU processes (0); a row that is not a number means the total is unknown, not 0.
  const gpuMib = gpuRows.map(Number)
  const gpuGb = gpuMib.every(Number.isFinite) ? Math.round(gpuMib.reduce((a, b) => a + b, 0) / 1024) : null
  return { totalGb, freeGb, load1, hasGpu: true, gpuGb, at, error: null }
}

export function describe(reading: SparkReading | null, now: number, host: string): string {
  if (reading === null) return `${host} ▸ no reading yet`
  if (reading.at === 0) return `${host} unreachable (${reading.error})`
  const age = Math.max(0, Math.round((now - reading.at) / 1000))
  const gpu = reading.hasGpu ? ` · GPU processes ${reading.gpuGb ?? '?'} GB` : ''
  const line = `${host} ▸ ${reading.freeGb} of ${reading.totalGb} GB free${gpu} · load ${reading.load1.toFixed(1)} · ${age} s ago`
  return reading.error === null ? line : `${line} · ${host} unreachable now`
}
