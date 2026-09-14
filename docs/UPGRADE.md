# Upgrading the harness without losing the features

`npm i -g @deepseek-ai/dsh@<version>` replaces the whole package directory. Anything we
planted inside it goes away in the same instant, and nothing tells you: a wiped seat means
the version badge **disappears**, not that it shows something wrong.

This is the procedure we run after every upgrade, and why each step exists.

## What an upgrade breaks, in order

| # | What | Why it dies | What puts it back |
|---|---|---|---|
| 1 | `sidebar.version` seat in the installed `dsh-client-ui-sidebar` bundle | the install replaces `lib/client.js` | `plugins/dsh-client-ui-hawk-hq/scripts/patch_sidebar_seat.py` (and the unit's `ExecStartPre`, which self-heals it on every boot) |
| 2 | the baked harness version in the browser half (`src/client/dsh-build.ts`) | it is generated from the *previous* install path/version | the plugin's `apply-dsh-ui-fixes.sh` regenerates it |
| 3 | the built plugin bundle (`lib/`) | not deleted by an upgrade, but stale relative to (2) | `pnpm build` (tsdown) — the apply script runs it |
| 4 | CSS overrides whose targets upstream renamed | upstream has no stable hook for those rules (e.g. the user-bubble width cap, the sidebar-head spacing) | nothing automatic: re-point the selectors in `src/client/css.ts`. `procedures/verify.sh` fails loudly so you find out from a check, not from squinting at the UI |
| 5 | slot registrations (`sidebar.footer.action`, `settings.section`, `conversation.input.left`, `sidebar.version`) | an upstream slot rename silences the occupant with **no error anywhere** | re-register against the new seat name; `verify.sh` checks all six ids by name |
| 6 | client-serving shape | 0.1.5 began serving all client code as one combo bundle; the old per-plugin path 404s | nothing to do — but any tooling that greps `/plugins/<pkg>/client.js` must follow the combo link instead (both our scripts do) |

## The procedure

```bash
# 1. upgrade + re-apply our patches + verify (no restart)
~/dsh-plugins/procedures/upgrade.sh 0.1.5-rc.1

# 2. restart the web unit yourself when convenient, then refresh the browser
#    (a plain refresh can serve the previous build — use a hard reload)
systemctl --user restart dsh-web

# 3. prove it
~/dsh-plugins/procedures/verify.sh
```

The restart is **off by default on purpose**: the web service is the page you are talking
through, so restarting it ends the session that is running the upgrade. Pass `--restart` only
when you mean it, or run it from a terminal you do not mind losing.

## What `upgrade.sh` refuses to do

- It refuses to continue when the installed version does not read back as the version you
  asked for — a pin that lags reality is worse than no pin.
- It does not touch the profile or the settings file.
- It does not guess: if `apply-dsh-ui-fixes.sh` is missing, it stops before installing.

## Rollback

```bash
npm i -g @deepseek-ai/dsh@<previous-version>
~/dsh-plugins/plugins/dsh-client-ui-hawk-hq/scripts/apply-dsh-ui-fixes.sh
systemctl --user restart dsh-web
```

The seat patch's pristine copy (`client.js.bak-pre-version-seat`) belongs to the version it
was taken from, so do not restore a backup across an upgrade — re-apply the patch instead and
let it make a fresh backup.

## After the upgrade

1. Run `procedures/verify.sh` and read its output — not an assurance, the actual checks.
2. Open the UI once and look at the four surfaces that live in the shell: the badge, the
   composer Skills button, the sidebar GPU panel, and Settings → the three extra pages.
3. Write down what broke. A short log of version → what died → what you had to re-port is the
   most valuable file in a setup like this, because the next upgrade repeats the pattern.
4. If the CSS checks failed, re-point them now while the diff is small.
