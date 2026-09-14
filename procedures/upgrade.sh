#!/usr/bin/env bash
# upgrade.sh — move a harness install to another version and put our patches back,
# in one command.
#
#   procedures/upgrade.sh 0.1.5-rc.1            install, re-apply patches, verify
#   procedures/upgrade.sh 0.1.5-rc.1 --restart  the same, then restart the web unit
#
# Environment overrides:
#   DSH_PLUGIN_DIR  the UI plugin dir   (default: <repo>/plugins/dsh-client-ui-hawk-hq)
#   DSH_SERVICE     systemd user unit to restart on --restart (default: dsh-web)
#
# Why this exists: `npm i -g @deepseek-ai/dsh@…` replaces the whole package
# directory, which wipes the seat patch planted inside the installed
# ui-sidebar bundle. Undoing that has to happen in the same breath as the
# install — otherwise the version badge is simply gone and nothing says why.
#
# The restart is OFF by default: that service serves the page you are talking
# through, so restarting it ends the session running this upgrade.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PLUGIN="${DSH_PLUGIN_DIR:-$ROOT/plugins/dsh-client-ui-hawk-hq}"
SERVICE="${DSH_SERVICE:-dsh-web}"
PIN="$ROOT/harness.json"

die() { printf 'upgrade: ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: upgrade.sh <version> [--restart]   e.g. upgrade.sh 0.1.5-rc.1"
[ -x "$PLUGIN/scripts/apply-dsh-ui-fixes.sh" ] || die "patch script missing: $PLUGIN/scripts/apply-dsh-ui-fixes.sh"

RESTART=no
[ "${2:-}" = "--restart" ] && RESTART=yes

previous="(no pin)"
if [ -f "$PIN" ]; then
  previous="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$PIN")"
  [ "$previous" = "$VERSION" ] && say "already pinned at $VERSION — reinstalling it deliberately"
fi

# 1. the install
say "installing @deepseek-ai/dsh@$VERSION (was $previous)"
npm i -g "@deepseek-ai/dsh@$VERSION"

DSH_BIN="$(command -v dsh || true)"
[ -n "$DSH_BIN" ] || die "no 'dsh' on PATH after the install"
DSH_ROOT="$(dirname "$(dirname "$(readlink -f "$DSH_BIN")")")"
now="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DSH_ROOT/package.json")"
[ "$now" = "$VERSION" ] || die "installed version reads $now, expected $VERSION — stopping before touching anything else"
say "installed: $now at $DSH_ROOT"

# 2. our patches back on (seat patch + rebuilt plugin + restamped badge version)
say "re-applying the out-of-tree UI patches"
"$PLUGIN/scripts/apply-dsh-ui-fixes.sh"

# 3. move the pin, when this checkout keeps one
if [ -f "$PIN" ]; then
  say "updating the pin in harness.json"
  python3 - "$PIN" "$VERSION" <<'PY'
import json, sys, datetime
path, version = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as handle:
    pin = json.load(handle)
pin['version'] = version
pin['pinnedAt'] = datetime.date.today().isoformat()
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(pin, handle, indent=2, ensure_ascii=False)
    handle.write('\n')
print(f"   pin now: {pin['package']}@{pin['version']} ({pin['pinnedAt']})")
PY
else
  say "no harness.json pin in this checkout — skipping the pin update"
fi

# 4. the restart (explicit only)
if [ "$RESTART" = yes ]; then
  say "restarting $SERVICE (the browser UI drops for a few seconds)"
  systemctl --user restart "$SERVICE"
  sleep 3
else
  say "NOT restarting. Finish with:"
  printf '   systemctl --user restart %s\n' "$SERVICE"
fi

# 5. proof
say "verifying"
"$HERE/verify.sh" || true

cat <<EOF

Next steps
  1. write down what this upgrade cost you (what broke, what had to be re-ported) — docs/UPGRADE.md
  2. hard-reload the browser; client bundles are served from disk, so a plain reload may still
     render the previous build
  3. if procedures/verify.sh reported CSS failures, re-point the selectors in
     plugins/dsh-client-ui-hawk-hq/src/client/css.ts now, while the diff is small

Rollback
  npm i -g @deepseek-ai/dsh@$previous && $PLUGIN/scripts/apply-dsh-ui-fixes.sh && systemctl --user restart $SERVICE
EOF
