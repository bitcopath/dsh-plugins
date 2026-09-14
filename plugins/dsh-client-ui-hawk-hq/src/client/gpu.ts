/**
 * GPU Watchdog settings page: live rocm-smi sample cards (temps, VRAM, util,
 * power draw vs cap) plus the gpu-guardian ladder state and log tail, fed by
 * the host half's SSE stream (one `state` event every 5s).
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GpuSample, GpuStatePayload } from '../wire.ts'
import { API, fmtGiB, fmtUnit } from './util.ts'

type ConnState = 'connecting' | 'live' | 'reconnecting'

/** One labeled meter row with a fill bar (warn/crit thresholds in %). */
function Meter({ label, text, pct }: { label: string; text: string; pct: number | null }): ReactNode {
  const fill = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  const tone = pct === null ? '' : pct >= 95 ? ' hhq-crit' : pct >= 85 ? ' hhq-warn' : ''
  return h('div', null,
    h('div', { className: 'hhq-row' },
      h('span', { className: 'hhq-k' }, label),
      h('span', { className: 'hhq-v' }, text)),
    h('div', { className: 'hhq-bar' },
      h('div', { className: `hhq-bar-fill${tone}`, style: { width: `${fill}%` } })))
}

/** Temperature card: edge / junction / memory, hot tone at the guardian's 85°C rung. */
function TempsCard({ gpu }: { gpu: GpuSample }): ReactNode {
  const hottest = Math.max(gpu.edgeC ?? 0, gpu.junctionC ?? 0, gpu.memoryC ?? 0)
  const hot = hottest >= 85
  return h('div', { className: 'hhq-card' },
    h('div', { className: 'hhq-card-title' }, 'Temperatures'),
    h('div', { className: 'hhq-card-value', style: hot ? { color: 'var(--dsw-alias-state-error-primary, #e5534b)' } : undefined },
      fmtUnit(gpu.junctionC, 1, '°C'),
      h('span', { className: 'hhq-card-sub' }, ' junction')),
    h('div', { className: 'hhq-row' }, h('span', { className: 'hhq-k' }, 'Edge'), h('span', { className: 'hhq-v' }, fmtUnit(gpu.edgeC, 1, '°C'))),
    h('div', { className: 'hhq-row' }, h('span', { className: 'hhq-k' }, 'Memory'), h('span', { className: 'hhq-v' }, fmtUnit(gpu.memoryC, 1, '°C'))))
}

/** The settings.section component for the GPU Watchdog page. */
export function GpuWatchdogPage(): ReactNode {
  const [state, setState] = useState<GpuStatePayload | null>(null)
  const [conn, setConn] = useState<ConnState>('connecting')
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const source = new EventSource(`${API}/gpu/events`)
    source.addEventListener('state', (event) => {
      setState(JSON.parse((event as MessageEvent).data) as GpuStatePayload)
      setConn('live')
    })
    source.onerror = () => setConn('reconnecting')
    return () => source.close()
  }, [])

  // Keep the guardian log pinned to its newest line.
  useEffect(() => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [state?.guardian.lines])

  const gpu = state?.gpu ?? null
  const guardian = state?.guardian ?? null
  const vramPct = gpu?.vramUsedB != null && gpu?.vramTotalB != null && gpu.vramTotalB > 0
    ? (gpu.vramUsedB / gpu.vramTotalB) * 100
    : null
  const powerPct = gpu?.powerW != null && gpu?.powerCapW != null && gpu.powerCapW > 0
    ? (gpu.powerW / gpu.powerCapW) * 100
    : null

  return h('div', { className: 'hhq-page' },
    h('div', { className: 'hhq-headrow' },
      h('h3', null, 'AMD RX 7900 XTX'),
      h('span', { className: `hhq-conn${conn === 'live' ? ' hhq-live' : ''}` },
        conn === 'live' ? 'live' : conn === 'connecting' ? 'connecting…' : 'reconnecting…')),
    state?.gpuError !== undefined
      ? h('p', { className: 'hhq-error', role: 'alert' }, `rocm-smi: ${state.gpuError}`)
      : null,
    gpu === null
      ? h('p', { className: 'hhq-dim' }, state === null ? 'Waiting for the first sample…' : 'No GPU data.')
      : h('div', { className: 'hhq-cards' },
          h('div', { className: 'hhq-card' },
            h('div', { className: 'hhq-card-title' }, 'Model'),
            h('div', { className: 'hhq-card-value', style: gpu.modelName === null ? { fontSize: '14px' } : undefined },
              gpu.modelName === null ? '—' : gpu.modelName),
            h('div', { className: 'hhq-card-sub' }, gpu.modelName === null ? 'none resident' : 'resident')),
          h(TempsCard, { gpu }),
          h('div', { className: 'hhq-card' },
            h('div', { className: 'hhq-card-title' }, 'VRAM'),
            h('div', { className: 'hhq-card-value' }, vramPct === null ? '—' : `${vramPct.toFixed(0)}%`),
            h(Meter, {
              label: `${fmtGiB(gpu.vramUsedB)} / ${fmtGiB(gpu.vramTotalB)}`,
              text: '', pct: vramPct,
            })),
          h('div', { className: 'hhq-card' },
            h('div', { className: 'hhq-card-title' }, 'GPU Utilization'),
            h('div', { className: 'hhq-card-value' }, fmtUnit(gpu.utilPct, 0, '%')),
            h(Meter, { label: 'compute', text: '', pct: gpu.utilPct })),
          h('div', { className: 'hhq-card' },
            h('div', { className: 'hhq-card-title' }, 'Power'),
            h('div', { className: 'hhq-card-value' }, fmtUnit(gpu.powerW, 0, ' W')),
            h(Meter, {
              label: `cap ${fmtUnit(gpu.powerCapW, 0, ' W')}`,
              text: powerPct === null ? '' : `${powerPct.toFixed(0)}%`,
              pct: powerPct,
            }))),
    h('div', { className: 'hhq-panel' },
      h('div', { className: 'hhq-headrow' },
        h('h3', null, 'GPU Guardian'),
        guardian !== null && guardian.rung !== null
          ? h('span', { className: `hhq-badge ${guardian.rung > 0 ? 'hhq-badge-high' : 'hhq-badge-ok'}` }, `rung ${guardian.rung}`)
          : null),
      guardian === null || guardian.unavailable
        ? h('p', { className: 'hhq-dim' }, 'Guardian log not available.')
        : h('pre', { className: 'hhq-log', ref: logRef }, guardian.lines.join('\n'))))
}
