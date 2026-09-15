/**
 * Sidebar ComfyUI panel: sits in `sidebar.footer.action` directly ABOVE the GPU
 * mini panel, inside the same seat occupant so the two stack instead of laying
 * out side by side.
 *
 * Two rules shape it:
 *   1. It is INVISIBLE unless ComfyUI is up AND something is resident or a
 *      prompt is executing — an idle engine shows nothing at all, so the
 *      sidebar gains no permanent furniture.
 *   2. It names what is loaded, which the GPU number alone cannot: the host
 *      half parses ComfyUI's own log ("Requested to load <class>") and maps the
 *      loader classes to friendly names + kinds (video / image / audio / text
 *      encoder / VAE).
 *
 * It holds no connection of its own: the payload arrives as a prop from the GPU
 * widget, which owns the single SSE stream this whole seat is fed by.
 */

import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import type { ComfyStatePayload } from '../wire.ts'
import { fmtGiB } from './util.ts'

/** The ComfyUI slice of the GPU state payload, or null when the host has none. */
interface ComfyBlockProps {
  readonly comfy: ComfyStatePayload | null
}

/** Kind → chip tone, so a video model reads differently from a text encoder. */
function kindClass(kind: string): string {
  switch (kind) {
    case 'video': return ' hhq-chip-video'
    case 'image': return ' hhq-chip-image'
    case 'audio': return ' hhq-chip-audio'
    case 'text': return ' hhq-chip-text'
    case 'vae': return ' hhq-chip-vae'
    default: return ''
  }
}

/** True when the panel has something worth showing. */
function isActive(comfy: ComfyStatePayload | null): boolean {
  return comfy !== null && comfy.up && (comfy.running || comfy.models.length > 0)
}

/**
 * The ComfyUI block, rendered ABOVE the GPU widget's own content inside a single
 * `sidebar.footer.action` occupant. Two separate occupants in that seat lay out
 * side by side — they have to be stacked, ComfyUI on top, and one component with
 * two block children guarantees that regardless of how the shell arranges the
 * seat. Renders nothing when ComfyUI has nothing resident and no prompt running,
 * so the sidebar is unchanged when the engine is idle.
 */
export function ComfyBlock({ comfy }: ComfyBlockProps): ReactNode {
  // The whole point: no ComfyUI, no panel.
  if (!isActive(comfy) || comfy === null) return null

  const label = comfy.running
    ? `running${comfy.pending > 0 ? ` +${comfy.pending}` : ''}`
    : 'loaded'

  return h('div', { className: 'hhq-side hhq-comfy' },
    h('div', { className: 'hhq-side-head' },
      h('span', { className: 'hhq-side-label' }, 'ComfyUI'),
      h('span', { className: 'hhq-side-dim' }, comfy.version === null ? '' : `v${comfy.version}`),
      h('span', { className: `hhq-badge ${comfy.running ? 'hhq-badge-ok' : ''}` },
        comfy.progress !== null ? `${label} ${comfy.progress}` : label)),
    comfy.models.length > 0
      ? h('div', { className: 'hhq-comfy-models' },
          comfy.models.map(model => h('span', {
            key: model.cls,
            className: `hhq-comfy-chip${kindClass(model.kind)}`,
            title: model.cls,
          }, model.label)))
      : null,
    h('div', { className: 'hhq-side-meta' },
      h('span', null,
        comfy.vramUsedB === null || comfy.vramTotalB === null
          ? '—'
          : `${fmtGiB(comfy.vramUsedB)} / ${fmtGiB(comfy.vramTotalB)}`),
      comfy.workflow.length > 0
        ? h('span', { className: 'hhq-comfy-wf', title: comfy.workflow.join(', ') }, comfy.workflow[0])
        : null))
}
