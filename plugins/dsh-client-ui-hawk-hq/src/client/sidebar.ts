/**
 * Sidebar GPU widget: an always-visible mini panel registered into the
 * sidebar foot's `sidebar.footer.action` list seat — it renders full-width
 * directly above the Settings row. Fed by the
 * same SSE stream as the GPU Watchdog settings page (one state event / 5s).
 * Wide mode shows junction temp + guardian rung + VRAM/util/power, with the
 * ComfyUI block (loaded models + queue) stacked directly above it; the collapsed
 * 56px rail shrinks to a single heat dot with a tooltip.
 */

import { Component, createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { GpuStatePayload } from '../wire.ts'
import { ComfyBlock } from './comfy.ts'
import { RadioBlock } from './radio.ts'
import { API, fmtUnit } from './util.ts'

/**
 * A per-block error boundary for the sidebar seat.
 *
 * Why this exists: the radio card and the GPU cards share ONE seat occupant, so a
 * throw in either one unmounts the whole panel -- on 2026-09-17 a radio bug took
 * the GPU cards off the sidebar with it. Each block now fails alone: the broken
 * one disappears, the others keep working, and the console names the culprit.
 */
class BlockBoundary extends Component<{ readonly children?: ReactNode; readonly label: string }, { readonly failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.warn(`hawk-hq: ${this.props.label} block failed and was hidden`, error)
  }

  render(): ReactNode {
    return this.state.failed === true ? null : this.props.children
  }
}

/** Owner share of `sidebar.footer.action` (the shell passes column state). */
interface SidebarGpuProps {
  readonly wide: boolean
}

/** Heat tone from junction temperature, aligned with the guardian ladder. */
function heatTone(junc: number | null): string {
  if (junc === null) return ''
  if (junc >= 95) return ' hhq-side-crit'
  if (junc >= 85) return ' hhq-side-warn'
  return ''
}

/** The `sidebar.footer.action` component for the GPU mini panel. */
export function GpuSidebarWidget({ wide }: SidebarGpuProps): ReactNode {
  const [state, setState] = useState<GpuStatePayload | null>(null)

  useEffect(() => {
    const source = new EventSource(`${API}/gpu/events`)
    source.addEventListener('state', (event) => {
      setState(JSON.parse((event as MessageEvent).data) as GpuStatePayload)
    })
    return () => source.close()
  }, [])

  const gpu = state?.gpu ?? null
  const junc = gpu?.junctionC ?? null
  const rung = state?.guardian.rung ?? null
  const tone = heatTone(junc)

  // Collapsed rail: one heat dot; the tooltip carries the numbers.
  if (!wide) {
    return h('span', { className: 'hhq-side-collapsed' },
      h(BlockBoundary, { label: 'radio' }, h(RadioBlock, { wide: false })),
      h('span', {
        className: `hhq-side-dot${tone}`,
        title: junc === null ? 'GPU: no data' : `GPU ${junc.toFixed(0)}°C · rung ${rung ?? '—'}`,
      }))
  }

  if (gpu === null) {
    return h('div', { className: 'hhq-side' },
      h(BlockBoundary, { label: 'radio' }, h(RadioBlock, { wide })),
      h('span', { className: 'hhq-side-dim' },
        state === null ? 'GPU connecting…' : 'GPU —'))
  }

  const vramPct = gpu.vramUsedB != null && gpu.vramTotalB != null && gpu.vramTotalB > 0
    ? (gpu.vramUsedB / gpu.vramTotalB) * 100
    : null
  const tempPct = junc === null ? 0 : Math.min(100, Math.max(0, junc))
  const model = gpu.modelName ?? null

  return h('div', { className: 'hhq-side' },
    // Radio sits ABOVE ComfyUI, which sits above the GPU readout: all three live
    // in this one occupant because separate occupants in this seat lay out side
    // by side instead of stacking.
    h(BlockBoundary, { label: 'radio' }, h(RadioBlock, { wide })),
    // ComfyUI sits ABOVE the GPU readout in the same occupant so the two stack.
    h(ComfyBlock, { comfy: state?.comfy ?? null }),
    h('div', { className: 'hhq-side-head' },
      h('span', { className: 'hhq-side-label' }, 'GPU'),
      h('span', { className: `hhq-side-temp${tone}` }, fmtUnit(junc, 0, '°C')),
      h('span', {
        className: `hhq-side-model${model === null ? ' hhq-side-dim' : ''}`,
        title: model ?? 'no model resident',
      }, model ?? 'idle'),
      rung !== null
        ? h('span', { className: `hhq-badge ${rung > 0 ? 'hhq-badge-high' : 'hhq-badge-ok'}` }, `rung ${rung}`)
        : null),
    h('div', { className: 'hhq-bar' },
      h('div', { className: `hhq-bar-fill${tone}`, style: { width: `${tempPct}%` } })),
    h('div', { className: 'hhq-side-meta' },
      h('span', null, vramPct === null ? '—' : `${vramPct.toFixed(0)}% VRAM`),
      h('span', null, fmtUnit(gpu.utilPct, 0, '% util')),
      h('span', null,
        gpu.powerCapW === null
          ? fmtUnit(gpu.powerW, 0, ' W')
          : `${fmtUnit(gpu.powerW, 0, '')}/${fmtUnit(gpu.powerCapW, 0, ' W')}`)))
}
