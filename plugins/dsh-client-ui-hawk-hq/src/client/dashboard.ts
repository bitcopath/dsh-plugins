/**
 * HQ Dashboard settings page: api_endpoint_stats from the dsh-hq stats
 * database — one stat card per provider (balance, token volume, last
 * updated) plus a 14-day daily-volume stacked bar view, hand-rolled SVG
 * (no chart library). Read-only: the host half only SELECTs; nothing here
 * ever calls a paid API.
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DailySpend, ProviderStat, QuotaStat, StatsPayload } from '../wire.ts'
import { API, fmtBalance, fmtTokens, timeAgo } from './util.ts'

const CHART_W = 560
const CHART_H = 140
const BAR_PAD = 2

/** onWatch provider id → the api_endpoint_stats card it annotates. */
const QUOTA_CARD: Record<string, string> = {
  grok: 'grok-proxy',
  kimi: 'kimi-proxy',
  deepseek: 'deepseek',
}

/**
 * Providers deliberately NOT rendered on this page — a DISPLAY filter, not a
 * data one: the collector keeps writing those rows to stats.db, so removing a
 * name from this set brings the card straight back with its history intact.
 *
 * Empty by default. Add your own ids to hide a card without losing its data,
 * e.g. self-hosted proxies whose quota you track elsewhere, or a provider whose
 * billing endpoint only ever answers with a rate limit.
 */
const HIDDEN_PROVIDERS = new Set<string>([])

/**
 * Direct cloud-provider id → billing/usage portal (open to top up / check
 * balance). Only true cloud providers: self-hosted proxies (grok-proxy,
 * kimi-proxy) and a local model route (local-qwen) stay unlinked.
 */
const PROVIDER_LINK: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/usage',
  fal: 'https://fal.ai/dashboard/billing',
  moonshotai: 'https://platform.kimi.ai/console',
  xai: 'https://console.x.ai/',
  zai: 'https://z.ai/manage-apikey/billing',
}

/** Human countdown to a quota reset ("1h 30m", "5d 11h"); empty when past/absent. */
function resetIn(resetsAt: string | null): string {
  if (resetsAt === null) return ''
  const seconds = Math.round((new Date(resetsAt).getTime() - Date.now()) / 1000)
  if (seconds <= 0) return 'resetting…'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** One subscription quota line under a provider card (source: onWatch). */
function QuotaRow({ quota }: { quota: QuotaStat }): ReactNode {
  if (quota.quotaName === 'balance') return null // balance cards already show USD
  const tone = quota.status === 'healthy' || quota.status === null
    ? '' : quota.status === 'warning' ? ' hhq-quota-warn' : ' hhq-quota-crit'
  const reset = resetIn(quota.resetsAt)
  return h('div', { className: 'hhq-row' },
    h('span', { className: 'hhq-k' }, quota.displayName ?? quota.quotaName),
    h('span', { className: `hhq-v${tone}` },
      quota.utilization === null ? '—' : `${Math.round(quota.utilization)}% used`,
      reset !== '' ? ` · resets ${reset}` : ''))
}

/** Load the stats payload from the host half. */
async function loadStats(): Promise<StatsPayload> {
  const response = await fetch(`${API}/stats`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`stats request failed with status ${response.status}`)
  return await response.json() as StatsPayload
}

/** External-link icon (rounded box + ↗ arrow), stroke inherits currentColor. */
function ExternalLinkIcon(): ReactNode {
  return h('svg', {
    className: 'hhq-link-svg', viewBox: '0 0 24 24', width: 12, height: 12,
    fill: 'none', stroke: 'currentColor', strokeWidth: 2.2,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
  },
    h('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
    h('polyline', { points: '15 3 21 3 21 9' }),
    h('line', { x1: 10, y1: 14, x2: 21, y2: 3 }))
}

/** One provider card: balance (when the provider reports one), tokens, freshness. */
function ProviderCard({ stat, quotas }: { stat: ProviderStat; quotas: readonly QuotaStat[] }): ReactNode {
  const link = PROVIDER_LINK[stat.provider]
  return h('div', { className: 'hhq-card' },
    h('div', { className: 'hhq-card-title' },
      h('span', { className: 'hhq-card-label' }, stat.provider),
      link !== undefined
        ? h('a', { className: 'hhq-card-link', href: link, target: '_blank', rel: 'noreferrer noopener', 'aria-label': `Open ${stat.provider} billing page` },
            h(ExternalLinkIcon, null))
        : null),
    stat.balanceUsd !== null
      ? h('div', { className: 'hhq-card-value' }, fmtBalance(stat.balanceUsd, stat.balanceCurrency))
      : h('div', { className: 'hhq-card-value' }, fmtTokens((stat.tokensIn ?? 0) + (stat.tokensOut ?? 0)),
          h('span', { className: 'hhq-card-sub' }, ' tokens')),
    h('div', { className: 'hhq-row' },
      h('span', { className: 'hhq-k' }, 'in / out'),
      h('span', { className: 'hhq-v' }, `${fmtTokens(stat.tokensIn)} / ${fmtTokens(stat.tokensOut)}`)),
    stat.costUsd !== null
      ? h('div', { className: 'hhq-row' },
          h('span', { className: 'hhq-k' }, 'cost today'),
          h('span', { className: 'hhq-v' }, `$${stat.costUsd.toFixed(4)}`))
      : null,
    quotas.map(q => h(QuotaRow, { quota: q, key: `${q.provider}/${q.quotaName}` })),
    stat.period !== null
      ? h('div', { className: 'hhq-row' }, h('span', { className: 'hhq-k' }, 'period'), h('span', { className: 'hhq-v' }, stat.period))
      : null,
    stat.note !== null
      ? h('div', { className: 'hhq-card-sub' }, stat.note)
      : null,
    h('div', { className: 'hhq-card-sub' }, `updated ${timeAgo(stat.recordedAt)}`))
}

/** Stacked daily-volume bars: input tokens (bottom) + output tokens (top). */
function DailyChart({ daily }: { daily: StatsPayload['daily'] }): ReactNode {
  if (daily.length === 0) return h('p', { className: 'hhq-dim' }, 'No samples in the last 14 days.')
  const max = Math.max(1, ...daily.map(row => row.tokensIn + row.tokensOut))
  const slot = CHART_W / daily.length
  const barW = Math.max(2, slot - BAR_PAD * 2)
  const scale = (value: number): number => (value / max) * (CHART_H - 14)
  return h('svg', {
    className: 'hhq-chart', viewBox: `0 0 ${CHART_W} ${CHART_H}`,
    role: 'img', 'aria-label': 'Daily token volume, last 14 days',
  },
    daily.map((row, index) => {
      const inH = scale(row.tokensIn)
      const outH = scale(row.tokensOut)
      const x = index * slot + BAR_PAD
      const label = `${row.day}: in ${row.tokensIn}, out ${row.tokensOut}`
      return h('g', { key: row.day },
        h('title', null, label),
        h('rect', {
          x, y: CHART_H - 12 - inH, width: barW, height: inH, rx: 1,
          fill: '#4f8ef7',
        }),
        h('rect', {
          x, y: CHART_H - 12 - inH - outH, width: barW, height: outH, rx: 1,
          fill: '#7cc47f',
        }),
        daily.length <= 14 || index % 2 === 0
          ? h('text', {
              x: x + barW / 2, y: CHART_H - 2, 'text-anchor': 'middle',
              'font-size': 8, fill: 'var(--dsw-alias-label-tertiary, #8a8f9e)',
            }, row.day.slice(5))
          : null)
    }))
}

/** One day of aggregated money movement. */
interface SpendDay {
  readonly day: string
  readonly spend: number
  readonly topUp: number
}

/** USD with enough precision to stay useful when the number is small. */
function fmtUsdShort(value: number): string {
  if (value <= 0) return '$0'
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/**
 * Sum the per-provider spend/top-up rows into per-day totals, oldest first,
 * keeping the last `days` days. Top-ups stay a separate number on purpose: they
 * are money in, and folding them into spend would hide a big day's real cost.
 */
function spendSeries(rows: readonly DailySpend[], days: number): SpendDay[] {
  const byDay = new Map<string, { spend: number; topUp: number }>()
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? { spend: 0, topUp: 0 }
    bucket.spend += row.spendUsd
    bucket.topUp += row.topUpUsd
    byDay.set(row.day, bucket)
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .slice(-days)
    .map(([day, value]) => ({ day, spend: value.spend, topUp: value.topUp }))
}

/** Today's spend from an aggregated series (days are UTC, matching the DB). */
function todaySpend(days: readonly SpendDay[]): number {
  const today = new Date().toISOString().slice(0, 10)
  return days.find(entry => entry.day === today)?.spend ?? 0
}

/**
 * Daily spend bars, with a small green marker at the top of any day that saw a
 * top-up. Deliberately not stacked: spend and top-ups run in opposite
 * directions, and a stacked bar would read as a sum.
 */
function SpendChart({ days }: { days: readonly SpendDay[] }): ReactNode {
  if (days.length === 0) return h('p', { className: 'hhq-dim' }, 'No balance samples in the last 14 days.')
  const max = Math.max(0.0001, ...days.map(entry => entry.spend))
  const slot = CHART_W / days.length
  const barW = Math.max(2, slot - BAR_PAD * 2)
  const scale = (value: number): number => (value / max) * (CHART_H - 16)
  return h('svg', {
    className: 'hhq-chart', viewBox: `0 0 ${CHART_W} ${CHART_H}`,
    role: 'img', 'aria-label': 'Daily spend, last 14 days',
  },
    days.map((entry, index) => {
      const height = scale(entry.spend)
      const x = index * slot + BAR_PAD
      return h('g', { key: entry.day },
        h('title', null, `${entry.day}: spent ${fmtUsdShort(entry.spend)}${entry.topUp > 0 ? `, topped up ${fmtUsdShort(entry.topUp)}` : ''}`),
        h('rect', { x, y: CHART_H - 12 - height, width: barW, height, rx: 1, fill: '#e5534b' }),
        entry.topUp > 0
          ? h('rect', { x, y: 2, width: barW, height: 4, rx: 1, fill: '#7cc47f' })
          : null,
        h('text', {
          x: x + barW / 2, y: CHART_H - 2, 'text-anchor': 'middle',
          'font-size': 8, fill: 'var(--dsw-alias-label-tertiary, #8a8f9e)',
        }, entry.day.slice(5)))
    }))
}

/** The settings.section component for the HQ Dashboard page. */
export function DashboardPage(): ReactNode {
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    loadStats().then(
      (body) => { setStats(body); setError(null) },
      (loadError: unknown) => setError(String(loadError)),
    )
  }, [])

  // Stats rows land every 10min; a 60s poll is plenty and keeps this page SSE-free.
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60000)
    return () => clearInterval(interval)
  }, [refresh])

  const spendDays = spendSeries(stats?.dailySpend ?? [], 14)
  const topUpTotal = spendDays.reduce((sum, entry) => sum + entry.topUp, 0)
  const today = new Date().toISOString().slice(0, 10)
  const todaySamples = (stats?.dailySpend ?? [])
    .filter(row => row.day === today)
    .reduce((max, row) => Math.max(max, row.samples), 0)
  const ignoredInWindow = (stats?.dailySpend ?? [])
    .filter(row => spendDays.some(entry => entry.day === row.day))
    .reduce((sum, row) => sum + row.ignoredSamples, 0)

  return h('div', { className: 'hhq-page' },
    h('div', { className: 'hhq-headrow' },
      h('h3', null, 'API Endpoints'),
      h('button', { type: 'button', className: 'hhq-btn', onClick: refresh }, 'Refresh')),
    error !== null ? h('p', { className: 'hhq-error', role: 'alert' }, error) : null,
    stats === null
      ? h('p', { className: 'hhq-dim' }, 'Loading…')
      : h('div', { className: 'hhq-cards' },
          stats.providers
            .filter(stat => !HIDDEN_PROVIDERS.has(stat.provider))
            .map(stat => h(ProviderCard, {
              stat,
              key: stat.provider,
              quotas: stats.quotas.filter(q => QUOTA_CARD[q.provider] === stat.provider),
            }))),
    stats !== null && stats.dailySpend === undefined
      ? h('div', { className: 'hhq-panel' },
          h('h3', null, 'Spend — last 14 days'),
          h('p', { className: 'hhq-dim' },
            'The host half does not serve spend data yet: this plugin update changed the host half too, ',
            'and that half only reloads on a dsh-web restart (systemctl --user restart dsh-web). ',
            'Until then the panel is empty on purpose rather than showing a fake zero.'))
      : null,
    stats !== null && stats.dailySpend !== undefined
      ? h('div', { className: 'hhq-panel' },
          h('div', { className: 'hhq-headrow' },
            h('h3', null, 'Spend — last 14 days'),
            h('span', { className: 'hhq-dim' }, `today ${fmtUsdShort(todaySpend(spendDays))}`),
            h('span', { className: 'hhq-badge', style: { background: 'rgba(229,83,75,.16)', color: '#f08080' } }, 'spend'),
            topUpTotal > 0
              ? h('span', { className: 'hhq-badge', style: { background: 'rgba(124,196,127,.18)', color: '#7cc47f' } }, `top-ups ${fmtUsdShort(topUpTotal)}`)
              : null),
          h(SpendChart, { days: spendDays }),
          h('p', { className: 'hhq-dim' },
            'Estimated from balance drops; top-ups are counted separately, so one can never read as negative spend. ',
            'Resolution is the 10-minute collector, a drop spanning midnight lands on the later day, and days the ',
            `rig was off are coarser — today: ${todaySamples} sample${todaySamples === 1 ? '' : 's'}. Green marks a top-up.`,
            ignoredInWindow > 0
              ? ` ${ignoredInWindow} sample${ignoredInWindow === 1 ? '' : 's'} in this window ignored as implausible (a step above $200 in 10 minutes — what the 2026-09-08 xAI unit bug wrote).`
              : ''))
      : null,
    stats !== null
      ? h('div', { className: 'hhq-panel' },
          h('div', { className: 'hhq-headrow' },
            h('h3', null, 'Daily token volume — 14 days'),
            h('span', { className: 'hhq-dim' }, 'in', ' '),
            h('span', { className: 'hhq-badge', style: { background: 'rgba(79,142,247,.2)', color: '#7fade0' } }, 'input'),
            h('span', { className: 'hhq-badge', style: { background: 'rgba(124,196,127,.18)', color: '#7cc47f' } }, 'output')),
          h(DailyChart, { daily: stats.daily }),
          h('p', { className: 'hhq-dim' },
            'Token counts come from the grok-proxy, kimi-proxy and local-qwen logs only — ',
            'cloud providers (deepseek, fal, moonshotai, xai, zai) report a balance, not tokens, ',
            'so a DeepSeek-only day is zero here and its cost is in the spend panel above.'))
      : null)
}
