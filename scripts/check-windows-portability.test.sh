#!/usr/bin/env bash
# Self-test for check-windows-portability.mjs (#1623).
#   - A dirty fixture (one of each anti-pattern) must FAIL (exit 1).
#   - A clean fixture must PASS (exit 0).
#   - The real repo must PASS (exit 0) — guards against the gate going stale.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/check-windows-portability.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() { # <description> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then echo "  ok: $1"; pass=$((pass + 1));
  else echo "  FAIL: $1 (expected exit $2, got $3)"; fail=$((fail + 1)); fi
}

# ── Dirty fixture: one violation of each kind ───────────────────────────────
mkdir -p "$TMP/dirty/src"
cat > "$TMP/dirty/src/spawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run() { return execFileSync('npm', ['run', 'test']); }
EOF
cat > "$TMP/dirty/src/url.ts" <<'EOF'
import * as path from 'node:path';
export const here = path.dirname(new URL(import.meta.url).pathname);
EOF
cat > "$TMP/dirty/src/leak.test.ts" <<'EOF'
import { rm } from 'node:fs/promises';
import { EventStore } from './store.js';
const store = new EventStore('/tmp/x');
await store.append('s', { type: 't' });
await rm('/tmp/x', { recursive: true, force: true });
EOF
set +e
node "$GATE" --src-root "$TMP/dirty" >/dev/null 2>&1
dirty_exit=$?
set -e
check "dirty fixture is rejected" 1 "$dirty_exit"

# ── Clean fixture: each anti-pattern in its fixed form ──────────────────────
mkdir -p "$TMP/clean/src"
cat > "$TMP/clean/src/spawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
import { resolveExecutable } from './process.js';
export function run() { return execFileSync(resolveExecutable('npm'), ['run', 'test']); }
EOF
cat > "$TMP/clean/src/url.ts" <<'EOF'
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
export const here = path.dirname(fileURLToPath(import.meta.url));
EOF
cat > "$TMP/clean/src/ok.test.ts" <<'EOF'
import { EventStore } from './store.js';
import { rmrfAsync } from './test-helpers/temp-dir.js';
const store = new EventStore('/tmp/x');
await store.append('s', { type: 't' });
await rmrfAsync('/tmp/x');
EOF
set +e
node "$GATE" --src-root "$TMP/clean" >/dev/null 2>&1
clean_exit=$?
set -e
check "clean fixture passes" 0 "$clean_exit"

# ── The real repo must be clean ─────────────────────────────────────────────
set +e
node "$GATE" >/dev/null 2>&1
repo_exit=$?
set -e
check "real repo is clean" 0 "$repo_exit"

echo "check-windows-portability self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
