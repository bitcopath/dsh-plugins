#!/usr/bin/env python3
"""Grow the `sidebar.version` seat in the installed ui-sidebar client bundle.

Why this file exists
--------------------
The DSH sidebar shell declares its holes explicitly — `sidebar.brand.mark`,
`sidebar.brand.name`, `sidebar.workspaces`, `sidebar.settings`,
`sidebar.footer.action` — and there is no seat between the brand row and the
New Session button, which is where the running harness version
always visible (2026-09-13). Upstream offers no way for an out-of-tree plugin
to add a row there, so this patch adds the missing declaration plus one
rendered row. The occupant itself lives in the local `dsh-client-ui-hawk-hq`
plugin; the harness stays upstream with exactly one line of ours in it.

Contract
--------
* Idempotent — exits 0 when the seat is already present.
* Fails loudly — exits 1 and leaves the bundle untouched when an anchor moved,
  so a harness upgrade can never be silently half-patched.
* Verifies — `node --check` parses the patched file, and the previous file is
  restored if it does not.
* Reversible — `--revert` puts the pristine backup back.

Usage
-----
    patch_sidebar_seat.py [BUNDLE_PATH] [--revert]

BUNDLE_PATH defaults to the bundle of the `dsh` install found on PATH.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

MARKER = '"sidebar.version"'
BACKUP_SUFFIX = '.bak-pre-version-seat'

# Anchors (whitespace-agnostic, but indentation-structure-exact).
DECLARATION = re.compile(
    r'^(?P<i>[ \t]*)"sidebar\.brand\.name": \{\n'
    r'(?P=i)\tkind: "single",\n'
    r'(?P=i)\tscope: "root"\n'
    r'(?P=i)\},\n',
    re.M,
)
RENDER = re.compile(
    r'^(?P<i>[ \t]*)\(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Tooltip, \{\n'
    r'(?P=i)\tlabel: t\("session\.new\.label"\),\n'
    r'(?P=i)\tdelayMs: 500,\n'
    r'(?P=i)\tdisabled: wide,\n',
    re.M,
)


def fail(message: str) -> None:
    """Report and exit non-zero without touching the file."""
    print(f'patch-sidebar-seat: ERROR: {message}', file=sys.stderr)
    sys.exit(1)


def default_bundle() -> str:
    """Resolve the ui-sidebar client bundle of the `dsh` install on PATH."""
    dsh = shutil.which('dsh')
    if dsh is None:
        fail('`dsh` is not on PATH — pass the bundle path explicitly')
    entry = os.path.realpath(dsh)  # …/@deepseek-ai/dsh/lib/bin.js
    root = os.path.dirname(os.path.dirname(entry))  # …/@deepseek-ai/dsh
    bundle = os.path.join(
        root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js'
    )
    if not os.path.isfile(bundle):
        fail(f'ui-sidebar bundle not found at {bundle}')
    return bundle


def parses(path: str) -> bool:
    """True when node accepts the file's syntax."""
    return subprocess.run(
        ['node', '--check', path], capture_output=True, text=True
    ).returncode == 0


def add_declaration(text: str) -> tuple[str, int]:
    """Declare `sidebar.version` right after `sidebar.brand.name`."""
    def replace(match: re.Match[str]) -> str:
        indent = match.group('i')
        added = (
            f'{indent}"sidebar.version": {{\n'
            f'{indent}\tkind: "single",\n'
            f'{indent}\tscope: "root"\n'
            f'{indent}}},\n'
        )
        return match.group(0) + added

    return DECLARATION.subn(replace, text)


def add_row(text: str) -> tuple[str, int]:
    """Render the seat's row between the brand row and New Session."""
    def replace(match: re.Match[str]) -> str:
        indent = match.group('i')
        added = (
            f'{indent}wide && (0, react_jsx_runtime.jsx)("div", {{\n'
            f'{indent}\tchildren: renderSlot("sidebar.version", {{ wide }})\n'
            f'{indent}}}),\n'
        )
        return added + match.group(0)

    return RENDER.subn(replace, text)


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith('--')]
    flags = {a for a in argv[1:] if a.startswith('--')}
    bundle = args[0] if args else default_bundle()

    if not os.path.isfile(bundle):
        fail(f'no such bundle: {bundle}')

    with open(bundle, encoding='utf-8') as handle:
        original = handle.read()

    if '--revert' in flags:
        backup = bundle + BACKUP_SUFFIX
        if not os.path.isfile(backup):
            fail(f'no backup to restore at {backup}')
        shutil.copyfile(backup, bundle)
        print(f'patch-sidebar-seat: reverted {bundle} from {backup}')
        return 0

    if MARKER in original:
        print(f'patch-sidebar-seat: already patched — {bundle}')
        return 0

    patched, declarations = add_declaration(original)
    if declarations != 1:
        fail(f'expected 1 sidebar.brand.name declaration anchor, found {declarations}')

    patched, rows = add_row(patched)
    if rows != 1:
        fail(f'expected 1 New Session anchor, found {rows}')

    if patched.count(MARKER) != 2:
        fail(f'expected the marker twice after patching, found {patched.count(MARKER)}')

    # Write to a sibling temp file, prove it parses, then swap it in. The temp
    # name must keep a .js extension: `node --check` refuses unknown extensions.
    handle, staged = tempfile.mkstemp(
        dir=os.path.dirname(bundle), prefix='.client.tmp-', suffix='.js'
    )
    os.close(handle)
    with open(staged, 'w', encoding='utf-8') as out:
        out.write(patched)
    if not parses(staged):
        os.unlink(staged)
        fail('patched bundle does not parse — bundle left untouched')

    backup = bundle + BACKUP_SUFFIX
    shutil.copyfile(bundle, backup)
    shutil.move(staged, bundle)
    if not parses(bundle):
        shutil.copyfile(backup, bundle)
        fail('bundle failed to parse after swap — restored from backup')

    print(f'patch-sidebar-seat: patched {bundle}')
    print(f'patch-sidebar-seat: pristine copy kept at {backup}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
