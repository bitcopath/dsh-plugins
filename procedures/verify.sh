#!/usr/bin/env bash
# verify.sh — prove, in one command, that every part of this setup is still in
# place. Run it after any upgrade, patch change or restart.
#
# It checks what is actually SERVED (not what exists on disk in theory), because
# "the file is patched but the browser never receives it" is the failure mode we
# hit: the badge disappears and nothing anywhere says why.
#
# Environment overrides:
#   DSH_WEB_URL   default http://127.0.0.1:3081
#   DSH_SERVICE   systemd user unit   (default dsh-web)
#   DSH_PROFILE   harness profile dir (default $HOME/.dsh/profiles/web)
#
# Exit status: 0 when everything passed, otherwise the number of failures.
set -uo pipefail

WEB="${DSH_WEB_URL:-http://127.0.0.1:3081}"
SERVICE="${DSH_SERVICE:-dsh-web}"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$ROOT/plugins/dsh-client-ui-hawk-hq"
FAILOVER="$ROOT/plugins/dsh-llm-hawk-failover"
fails=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }
info() { printf '  ----  %s\n' "$*"; }
head2() { printf '\n%s\n' "$*"; }

# ── 1. the install itself ────────────────────────────────────────────────────
head2 "install"
DSH_ROOT=""
DSH_BIN="$(command -v dsh || true)"
if [ -z "$DSH_BIN" ]; then
  fail "no 'dsh' on PATH"
else
  DSH_ROOT="$(dirname "$(dirname "$(readlink -f "$DSH_BIN")")")"
  installed="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DSH_ROOT/package.json" 2>/dev/null)"
  if [ -z "$installed" ]; then
    fail "cannot read the installed version at $DSH_ROOT/package.json"
  else
    pass "harness install $installed at $DSH_ROOT"
    if [ -f "$ROOT/harness.json" ]; then
      pinned="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$ROOT/harness.json" 2>/dev/null)"
      if [ "$installed" = "$pinned" ]; then
        pass "installed version $installed matches the pin"
      else
        fail "pin says $pinned but $installed is installed — update harness.json"
      fi
    else
      info "no harness.json pin in this checkout — skipped the pin check"
    fi
  fi
fi

# ── 2. the service, when this machine runs one ───────────────────────────────
head2 "service"
if systemctl --user show -p LoadState --value "$SERVICE" 2>/dev/null | grep -q .; then
  if systemctl --user is-active --quiet "$SERVICE"; then
    pass "$SERVICE active (PID $(systemctl --user show -p MainPID --value "$SERVICE"))"
  else
    fail "$SERVICE is not active"
  fi
  if systemctl --user show -p ExecStartPre --value "$SERVICE" 2>/dev/null | grep -q patch_sidebar_seat.py; then
    pass "self-healing seat patch is wired as ExecStartPre"
  else
    info "ExecStartPre does not run patch_sidebar_seat.py — an upgrade would wipe the seat unnoticed (apply it by hand or wire it up)"
  fi
else
  info "no systemd user unit named $SERVICE on this machine — skipped the service checks"
fi

# ── 3. what the server actually serves ───────────────────────────────────────
head2 "served bundles ($WEB)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
touch "$TMP/cookies"

# Recent harnesses add launch-token auth: each boot prints
# "dsh web: http://127.0.0.1:3081/?token=<random>" to the journal, and a GET to
# that URL mints a signed session cookie. Pull the current token from the
# journal and do the same exchange here. (The cookie secret is persisted in the
# profile, so a minted cookie survives restarts; the token does not.)
TOKEN="$(journalctl --user -u "$SERVICE" --no-pager 2>/dev/null | grep -oP 'dsh web: http\S*[?&]token=\K\S+' | tail -1)"
if [ -n "$TOKEN" ]; then
  curl -fsS -c "$TMP/cookies" -o /dev/null --max-time 4 "$WEB/?token=$TOKEN" 2>/dev/null || true
fi

if curl -fsS -b "$TMP/cookies" -o "$TMP/index.html" --max-time 4 "$WEB/" 2>/dev/null; then
  # 0.1.5+ serves all client code as ONE combo bundle
  # (/plugins/??a/client.js,b/client.js&rev=<hash>); the old per-plugin paths
  # 404. The combo is what the browser executes, so grep the combo.
  COMBO="$(grep -oP 'href="\K/plugins/\?\?[^"]+' "$TMP/index.html" | head -1 | sed 's/&amp;/\&/g')"
  if [ -z "$COMBO" ]; then
    # Older harnesses: fall back to the per-plugin bundles.
    info "served index has no client combo link — trying the per-plugin paths"
    SERVE_PREFIX="$WEB/plugins"
  else
    SERVE_PREFIX=""
    if curl -fsS -b "$TMP/cookies" --max-time 30 "$WEB$COMBO" -o "$TMP/combo.js" 2>/dev/null; then
      BUNDLES="$TMP/combo.js"
    else
      fail "client combo bundle not fetchable ($COMBO)"
      BUNDLES=""
    fi
  fi
  if [ -z "$COMBO" ]; then
    : >"$TMP/combo.js"
    for path in "dsh-client-ui-hawk-hq/client.js" "@deepseek-ai/dsh-client-ui-sidebar/client.js"; do
      curl -fsS -b "$TMP/cookies" --max-time 15 "$SERVE_PREFIX/$path" >>"$TMP/combo.js" 2>/dev/null || true
    done
    BUNDLES="$TMP/combo.js"
  fi

  if [ -n "${BUNDLES:-}" ] && [ -s "$BUNDLES" ]; then
    seat="$(grep -c '"sidebar.version"' "$BUNDLES" 2>/dev/null || true)"
    [ "${seat:-0}" -ge 1 ] \
      && pass "sidebar.version seat present in the served client bundle ($seat hits)" \
      || fail "the served client bundle has no sidebar.version seat — run procedures/upgrade.sh (or the plugin's apply-dsh-ui-fixes.sh)"

    badge="$(grep -c 'hhq-ver' "$BUNDLES" 2>/dev/null || true)"
    [ "${badge:-0}" -ge 1 ] \
      && pass "version badge present in the served client bundle ($badge hits)" \
      || fail "the served client bundle has no badge — rebuild the plugin"

    # The settings pages and the sidebar panel are slot occupants. A slot rename
    # upstream silences one of them with no error anywhere, so every
    # registration is checked by its id.
    for pair in "hawk-gpu-watchdog:Settings → GPU Watchdog" \
                "hawk-notifications:Settings → Notifications" \
                "hawk-dashboard:Settings → HQ Dashboard" \
                "hawk-gpu-sidebar:sidebar foot GPU panel" \
                "hawk-composer-skills:composer skills dropdown"; do
      id="${pair%%:*}"; label="${pair#*:}"
      if grep -q "$id" "$BUNDLES" 2>/dev/null; then
        pass "$label registered"
      else
        fail "$label ($id) is NOT in the served client bundle"
      fi
    done

    # The CSS overrides are class-hash based on purpose: upstream offers no
    # stable hook for these rules, and only a class-level max-width can beat its
    # hard-coded value. 0.1.5 renamed that prefix (gdEzaW_ → Sixlwa_), which
    # silently killed one override — so these checks exist to make the next
    # rename loud instead.
    head_target="$(grep -c 'hHd-Xa_logoRow' "$BUNDLES" 2>/dev/null || true)"
    [ "${head_target:-0}" -ge 1 ] \
      && pass "sidebar-head spacing target (hHd-Xa_logoRow) still exists upstream" \
      || fail "the sidebar-head spacing target is gone — re-point .hHd-Xa_logoRow in src/client/css.ts"

    bubble="$(grep -c 'Sixlwa_userStack' "$BUNDLES" 2>/dev/null || true)"
    [ "${bubble:-0}" -ge 1 ] \
      && pass "user-bubble override target (Sixlwa_userStack) still exists upstream" \
      || fail "the user-bubble override target is gone — re-point it in src/client/css.ts"
  fi
else
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/cookies" --max-time 4 "$WEB/" 2>/dev/null || true)"
  if [ "$code" = "401" ]; then
    fail "server answers but rejects us (401 launch-token auth) — the journal token exchange failed; open the '?token=' URL from 'journalctl --user -u $SERVICE' in the browser"
  else
    fail "harness web server not reachable at $WEB"
  fi
fi

# ── 4. the version endpoint (host half) ──────────────────────────────────────
head2 "version route"
route="$(curl -fsS -b "$TMP/cookies" --max-time 6 "$WEB/plugin/hawk-hq/version" 2>/dev/null || true)"
if [ -n "$route" ]; then
  printf '%s' "$route" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(f"  ----  host route says current={d.get(\"current\")} latest={d.get(\"latest\")} updateAvailable={d.get(\"updateAvailable\")}")
if d.get("error"): print(f"  ----  registry check error: {d[\"error\"]}")
' 2>/dev/null
  pass "host route /plugin/hawk-hq/version is live"
else
  info "host route not live yet — it appears on the next harness boot; the badge reads the npm registry from the browser until then"
fi

# ── 5. no hand patch left inside the installed package ───────────────────────
head2 "in-package patches"
if [ -n "$DSH_ROOT" ]; then
  conversation="$DSH_ROOT/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"
  if [ -f "$conversation" ] && grep -q 'dsh.composer.skills' "$conversation"; then
    info "a hand-patched composer skills block is present inside the conversation bundle"
    info "that is unexpected: the feature ships as a plugin occupant now — check who patched the bundle"
  else
    pass "no hand patch inside the conversation bundle (the composer skills live in the plugin)"
  fi
  if [ -f "$DSH_ROOT/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js.bak-pre-version-seat" ]; then
    info "sidebar seat patch backup present (client.js.bak-pre-version-seat) — pristine copy, harmless"
  fi
fi

# ── 6. plugin and profile wiring ─────────────────────────────────────────────
head2 "plugin wiring"
for dir in "$PLUGIN:dsh-client-ui-hawk-hq" "$FAILOVER:dsh-llm-hawk-failover"; do
  path="${dir%%:*}"; name="${dir#*:}"
  if [ -e "$path/package.json" ]; then
    if [ -d "$path/lib" ]; then
      pass "$name present and built at $path"
    else
      info "$name present at $path but NOT built — run: (cd $path && pnpm install && pnpm build)"
    fi
  else
    fail "$name missing at $path"
  fi
  if [ -f "$PROFILE/package.json" ]; then
    if grep -q "\"$name\"" "$PROFILE/package.json" 2>/dev/null; then
      pass "$name is linked in $PROFILE"
    else
      fail "$name is not linked in $PROFILE/package.json"
    fi
  fi
done
[ -f "$PROFILE/package.json" ] || info "no profile package.json at $PROFILE — skipped the link checks"

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf '\033[32mall harness checks passed\033[0m\n'
else
  printf '\033[31m%d check(s) failed\033[0m\n' "$fails"
fi
exit "$fails"
