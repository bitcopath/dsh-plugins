/**
 * Wire contract for the hawk-hq plugin API. The host half produces it; the
 * browser half consumes it over the plugin's HTTP/SSE routes. Keep this file
 * type-only: both halves import it and it must never carry runtime code into
 * a bundle.
 */

/** One parsed rocm-smi sample for the single AMD card (card0). */
export interface GpuSample {
  /** Edge temperature, °C. */
  readonly edgeC: number | null
  /** Junction temperature, °C. */
  readonly junctionC: number | null
  /** Memory temperature, °C. */
  readonly memoryC: number | null
  /** Average graphics package power draw, W. */
  readonly powerW: number | null
  /** Current power cap (max package power), W. */
  readonly powerCapW: number | null
  /** GPU utilization, %. */
  readonly utilPct: number | null
  /** VRAM in use, bytes. */
  readonly vramUsedB: number | null
  /** VRAM total, bytes. */
  readonly vramTotalB: number | null
  /** Best-effort label of the workload resident on the GPU (e.g. Qwen3.8-27B,
   *  ComfyUI), derived from the process table; null when none is detected. */
  readonly modelName: string | null
}

/** Tail view of the gpu-guardian ladder log. */
export interface GuardianState {
  /** Last ladder rung seen in the log (rung=N), null when never logged. */
  readonly rung: number | null
  /** Last ~50 log lines, oldest first. */
  readonly lines: readonly string[]
  /** True when the log file could not be read. */
  readonly unavailable: boolean
}

/** One model ComfyUI currently holds in VRAM. */
export interface ComfyModel {
  /** Friendly name shown in the panel (e.g. `MiniMax H3`). */
  readonly label: string
  /** The loader class ComfyUI logged (e.g. `MiniMaxH3`), kept for the tooltip. */
  readonly cls: string
  /** What the model makes, for the chip colour. */
  readonly kind: 'video' | 'image' | 'audio' | 'text' | 'vae' | 'other'
}

/**
 * Live ComfyUI view for the sidebar panel: rendered only while ComfyUI is up
 * AND something is genuinely resident, so the panel is simply absent when the
 * engine is idle. `models` is empty when nothing is in VRAM, even if the log
 * still carries older "Requested to load" lines.
 */
export interface ComfyStatePayload {
  /** ComfyUI answered on its HTTP port. */
  readonly up: boolean
  readonly version: string | null
  /** Models resident in GPU memory right now, oldest first. */
  readonly models: readonly ComfyModel[]
  /** A prompt is executing. */
  readonly running: boolean
  /** Prompts waiting behind it. */
  readonly pending: number
  /** Sampling progress of the running prompt, e.g. `4/8`. */
  readonly progress: string | null
  /** Node classes of the running prompt, for the "what is it doing" line. */
  readonly workflow: readonly string[]
  /** VRAM held on the discrete card as ComfyUI sees it, bytes. */
  readonly vramUsedB: number | null
  readonly vramTotalB: number | null
  /** Present when the read failed while ComfyUI was expected up. */
  readonly error?: string
}

/** GET /plugin/hawk-hq/gpu and SSE `state` event payload. */
export interface GpuStatePayload {
  readonly gpu: GpuSample | null
  /** Present when the rocm-smi read failed. */
  readonly gpuError?: string
  readonly guardian: GuardianState
  /** ComfyUI's own view of the card, for the sidebar panel. */
  readonly comfy?: ComfyStatePayload | null
  /** ISO timestamp of this sample. */
  readonly at: string
}

/** One parsed line of ~/.dsh/notifications.jsonl. */
export interface NotificationItem {
  /** Timestamp (`at` or `ts` field), null when absent. */
  readonly ts: string | null
  readonly message: string
  readonly urgency: string
  /** The raw parsed object, for forward-compatible fields. */
  readonly raw: Record<string, unknown>
}

/** GET /plugin/hawk-hq/notifications response value (newest first). */
export interface NotificationsPayload {
  readonly notifications: readonly NotificationItem[]
}

/** Latest api_endpoint_stats row for one provider. */
export interface ProviderStat {
  readonly provider: string
  readonly balanceUsd: number | null
  /** ISO currency code for balanceUsd, e.g. 'USD' or 'CNY'; null when n/a. */
  readonly balanceCurrency: string | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly period: string | null
  readonly note: string | null
  readonly recordedAt: string
  /** grok-proxy only: today's summed totalCostUsd. */
  readonly costUsd: number | null
}

/** Latest provider_quota row for one subscription quota card (from onWatch). */
export interface QuotaStat {
  /** onWatch provider id: grok | kimi | deepseek. */
  readonly provider: string
  readonly quotaName: string
  readonly displayName: string | null
  /** Percent of the quota consumed (0-100), null for balance rows. */
  readonly utilization: number | null
  readonly balanceUsd: number | null
  /** ISO timestamp when the quota window resets, null when not applicable. */
  readonly resetsAt: string | null
  /** onWatch status: healthy | warning | danger | critical. */
  readonly status: string | null
  readonly recordedAt: string
}

/**
 * One day's money movement for one provider, derived from the balance series
 * (there is no usage API for the balance-only providers). `spendUsd` sums the
 * balance drops across the day; `topUpUsd` sums the rises, so a top-up can never
 * be mistaken for negative spending.
 */
export interface DailySpend {
  /** YYYY-MM-DD. */
  readonly day: string
  /** Provider id as stored in api_endpoint_stats. */
  readonly provider: string
  /** Estimated spend for the day, in USD. */
  readonly spendUsd: number
  /** Credit added that day, in USD (a top-up, not spend). */
  readonly topUpUsd: number
  /** Balance samples the estimate rests on; fewer means a coarser estimate. */
  readonly samples: number
  /**
   * Samples dropped as implausible on this day (a step above the sanity
   * threshold) — reported rather than silently ignored.
   */
  readonly ignoredSamples: number
}

/** One day's summed token volume across all providers. */
export interface DailyVolume {
  /** YYYY-MM-DD. */
  readonly day: string
  readonly tokensIn: number
  readonly tokensOut: number
}

/** GET /plugin/hawk-hq/stats response value. */
export interface StatsPayload {
  readonly providers: readonly ProviderStat[]
  readonly quotas: readonly QuotaStat[]
  readonly daily: readonly DailyVolume[]
  /** Per-provider, per-day spend and top-ups over the last 30 days. */
  readonly dailySpend: readonly DailySpend[]
}

/** GET /plugin/hawk-hq/version — the data behind the sidebar version badge. */
export interface VersionPayload {
  /** Version of the harness install serving this page; null when unresolved. */
  readonly current: string | null
  /** Absolute path of that install (diagnostics). */
  readonly installPath: string | null
  /** What `npm i -g @deepseek-ai/dsh` would install today (dist-tag `latest`); null while unknown. */
  readonly latest: string | null
  /** Every published dist-tag for the package (latest/next/alpha). */
  readonly distTags: Readonly<Record<string, string>>
  /** True when `latest` is strictly newer than `current`. */
  readonly updateAvailable: boolean
  /** ISO timestamp of the registry answer this payload carries. */
  readonly checkedAt: string
  /** True while the first registry answer is still in flight (nothing cached yet). */
  readonly pending?: boolean
  /** True when this payload is served past its TTL while a refresh runs. */
  readonly stale?: boolean
  /** Why the registry could not be read; `latest` then carries the last known value. */
  readonly error?: string
}

/** Uniform plugin-route error body. */
export interface ErrorResponse {
  readonly error: { readonly code: string; readonly message: string }
}
