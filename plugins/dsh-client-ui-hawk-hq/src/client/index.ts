/**
 * hawk-hq browser half: three `settings.section` pages in Web Settings —
 * GPU Watchdog, Notifications, HQ Dashboard (spend + tokens + top-ups) — the always-visible GPU mini panel
 * in the sidebar foot (`sidebar.footer.action`), the DSH version badge in the
 * sidebar head (`sidebar.version`, whose seat an out-of-tree patch grows), and
 * the composer skills dropdown (`conversation.input.left`), each backed by the
 * host half's HTTP/SSE routes. Hand-rolled React (platform table) + one injected
 * stylesheet; zero runtime dependencies.
 */

import { injectCss } from './css.ts'
import { GpuWatchdogPage } from './gpu.ts'
import { NotificationsPage } from './notifications.ts'
import { DashboardPage } from './dashboard.ts'
import { GpuSidebarWidget } from './sidebar.ts'
import { DshVersionBadge } from './version.ts'
import { ComposerSkills } from './skills.ts'

/** Services required by the settings-section registrations. */
export const inject = ['slots']

/** The minimal client Context face this plugin uses. */
interface ClientContext {
  readonly slots: {
    inject(key: string, callback: () => unknown): void
    register(
      options: {
        name: string
        id?: string
        order?: number
        label?: () => string
      },
      component: unknown,
    ): unknown
  }
}

// Styles land at factory execution, before any page renders.
injectCss()

/** Contribute the three Hawk HQ pages to the settings shell. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hawk-gpu-watchdog',
    order: 50,
    label: () => 'GPU Watchdog',
  }, GpuWatchdogPage))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hawk-notifications',
    order: 51,
    label: () => 'Notifications',
  }, NotificationsPage))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hawk-dashboard',
    order: 52,
    label: () => 'HQ Dashboard',
  }, DashboardPage))
  // Always-visible GPU mini panel in the sidebar foot, above the Settings row
  // (declaration-aware inject: activates once ui-sidebar declares the seat).
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hawk-gpu-sidebar',
    order: 10,
  }, GpuSidebarWidget))

  // DSH version badge in the sidebar head, between the brand row and New
  // Session. The seat itself is grown by the out-of-tree sidebar patch
  // (scripts/apply-dsh-ui-fixes.sh) because upstream declares no seat there;
  // declaration-aware inject keeps this inert without it, so warn once when the
  // seat never shows up — a harness upgrade that wiped the patch must be
  // noticed, not guessed at.
  let versionSeat = false
  ctx.slots.inject('sidebar.version', () => {
    versionSeat = true
    return ctx.slots.register({
      name: 'sidebar.version',
      id: 'hawk-dsh-version',
      order: 10,
    }, DshVersionBadge)
  })
  window.setTimeout(() => {
    if (!versionSeat) {
      console.warn(
        'hawk-hq: sidebar.version seat missing — run ~/dsh-hq/plugins/dsh-client-ui-hawk-hq/'
        + 'scripts/apply-dsh-ui-fixes.sh (a harness upgrade wipes the sidebar seat patch)',
      )
    }
  }, 5000)

  // Composer skills dropdown. A 2026-09-07 hand patch lived inside the
  // conversation bundle and the 0.1.5 upgrade wiped it; 0.1.5 declares this
  // session-scope seat and publishes the input face (`setDraft`) to its
  // occupants, so the feature lives here now and survives upgrades. Order 20
  // keeps it after any earlier left-cluster control.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'hawk-composer-skills',
    order: 20,
  }, ComposerSkills))
}
