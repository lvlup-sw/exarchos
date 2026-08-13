#!/usr/bin/env bash
# Self-test for the eslint.config.js Windows-portability rules (#1623).
#
# `npm run lint:windows` only proves the config RUNS clean on the (clean) tree —
# a silently-broken selector would pass that too. This confirms each rule still
# FIRES on its anti-pattern and stays quiet on the fixed form, using a temp
# fixture under the config's `files` glob (cleaned up on exit).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root: $ROOT" >&2; exit 1; }
FX="src/__eslint_selftest__.ts"
trap 'rm -f "$FX"' EXIT
fail=0

cat > "$FX" <<'EOF'
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
export const a = execFileSync('npm', ['run', 'test']);
export const b = path.dirname(new URL(import.meta.url).pathname);
EOF
errs="$(npx eslint "$FX" 2>&1 | grep -c 'no-restricted-syntax' || true)"
if [ "$errs" -eq 2 ]; then echo "  ok: both anti-patterns flagged (2)"; else echo "  FAIL: expected 2 flags, got $errs"; fail=1; fi

cat > "$FX" <<'EOF'
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../utils/process.js';
import * as path from 'node:path';
export const a = execFileSync(resolveExecutable('npm'), ['run', 'test']);
export const b = path.dirname(fileURLToPath(import.meta.url));
EOF
if npx eslint "$FX" >/dev/null 2>&1; then echo "  ok: fixed form is clean"; else echo "  FAIL: fixed form unexpectedly flagged"; fail=1; fi

echo "eslint-windows self-test: $([ "$fail" -eq 0 ] && echo PASS || echo FAIL)"
[ "$fail" -eq 0 ]
