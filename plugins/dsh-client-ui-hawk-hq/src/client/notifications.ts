/**
 * Notifications settings page: Hawk's inbox (~/.dsh/notifications.jsonl),
 * newest first, with live appends over the host half's SSE stream. Urgency
 * drives the badge tone; timestamps render relative in the header and
 * absolute on the row.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { NotificationItem, NotificationsPayload } from '../wire.ts'
import { API, fmtClock, timeAgo } from './util.ts'

/** Badge class for one urgency value. */
function urgencyClass(urgency: string): string {
  const known = ['high', 'medium', 'low', 'info']
  return `hhq-badge hhq-badge-${known.includes(urgency) ? urgency : 'info'}`
}

/** Load the inbox tail from the host half. */
async function loadInbox(): Promise<readonly NotificationItem[]> {
  const response = await fetch(`${API}/notifications`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`inbox request failed with status ${response.status}`)
  const body = await response.json() as NotificationsPayload
  return body.notifications
}

/** The settings.section component for the Notifications page. */
export function NotificationsPage(): ReactNode {
  const [items, setItems] = useState<readonly NotificationItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let dead = false
    const refresh = (): void => {
      loadInbox().then(
        (rows) => { if (!dead) { setItems(rows); setError(null) } },
        (loadError: unknown) => { if (!dead) setError(String(loadError)) },
      )
    }
    refresh()
    const source = new EventSource(`${API}/notifications/events`)
    source.addEventListener('notification', (event) => {
      const row = JSON.parse((event as MessageEvent).data) as NotificationItem
      setLive(true)
      setItems(prev => [row, ...(prev ?? [])].slice(0, 300))
    })
    source.addEventListener('reset', refresh)
    source.onerror = () => setLive(false)
    return () => {
      dead = true
      source.close()
    }
  }, [])

  return h('div', { className: 'hhq-page' },
    h('div', { className: 'hhq-headrow' },
      h('h3', null, items === null ? 'Inbox' : `Inbox — ${items.length}`),
      h('span', { className: `hhq-conn${live ? ' hhq-live' : ''}` }, live ? 'live' : 'connecting…')),
    error !== null ? h('p', { className: 'hhq-error', role: 'alert' }, error) : null,
    items === null
      ? h('p', { className: 'hhq-dim' }, 'Loading…')
      : items.length === 0
        ? h('p', { className: 'hhq-dim' }, 'No notifications yet.')
        : h('ul', { className: 'hhq-list' },
            items.map((item, index) =>
              h('li', { className: 'hhq-item', key: `${item.ts ?? 'x'}-${index}` },
                h('div', { className: 'hhq-item-head' },
                  h('span', { className: urgencyClass(item.urgency) }, item.urgency),
                  h('span', { className: 'hhq-dim' }, timeAgo(item.ts)),
                  h('span', { className: 'hhq-item-ts' }, fmtClock(item.ts))),
                h('div', { className: 'hhq-item-msg' }, item.message)))))
}
