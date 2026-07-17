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
# Rule 4 — dynamic-bin spawn: a resolved command variable, not a literal.
cat > "$TMP/dirty/src/dynspawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(bin: string, args: string[]) { return execFileSync(bin, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/dirty" >/dev/null 2>&1
dirty_exit=$?
set -e
check "dirty fixture is rejected" 1 "$dirty_exit"

# ── Rule 4 in isolation: variable-bin spawn alone must be rejected ──────────
mkdir -p "$TMP/r4/src"
cat > "$TMP/r4/src/probe.ts" <<'EOF'
import { spawnSync } from 'node:child_process';
export function run(cmd: string, args: string[]) { return spawnSync(cmd, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4" >/dev/null 2>&1
r4_exit=$?
set -e
check "rule 4: variable-bin spawnSync is rejected" 1 "$r4_exit"

# The spawn helper itself (utils/process.ts) is exempt — it IS the sanctioned
# home for raw, variable-bin execFile/spawn.
mkdir -p "$TMP/r4helper/src/utils"
cat > "$TMP/r4helper/src/utils/process.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function runCommandSync(command: string, args: string[]) { return execFileSync(command, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4helper" >/dev/null 2>&1
r4helper_exit=$?
set -e
check "rule 4: utils/process.ts helper is exempt" 0 "$r4helper_exit"

# Benchmarks are dev-only and spawn the running node (process.execPath) — exempt.
mkdir -p "$TMP/r4bench/src/bench"
cat > "$TMP/r4bench/src/bench/cli.bench.ts" <<'EOF'
import { spawn } from 'node:child_process';
export function run() { return spawn(process.execPath, ['x']); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4bench" >/dev/null 2>&1
r4bench_exit=$?
set -e
check "rule 4: .bench.ts is exempt" 0 "$r4bench_exit"

# ── Clean fixture: each anti-pattern in its fixed form ──────────────────────
mkdir -p "$TMP/clean/src"
cat > "$TMP/clean/src/spawn.ts" <<'EOF'
import { runCommandSync } from './utils/process.js';
export function run() { return runCommandSync('npm', ['run', 'test']); }
export function runDynamic(bin: string, args: string[]) { return runCommandSync(bin, args); }
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

# ── CI-tooling exemption (task 015): the fail-closed audit gates under
# scripts/audit (knip-diff.ts / cycle-gate.ts) call raw `spawnSync(binPath, …)`
# with a VARIABLE bin — rule 4's shape. They are CI-only tooling that degrades
# to fail-closed on a spawn error, so rule 4 (whose scope is "Production files
# only") is exempted for scripts/. The real scripts/audit tree must therefore
# scan CLEAN. Reverting the exemption reds this case (proving its teeth): the
# two audit gates would then trip rule 4.
set +e
node "$GATE" --src-root "$SCRIPT_DIR/audit" >/dev/null 2>&1
tooling_exit=$?
set -e
check "scripts/audit CI tooling is exempt from rule 4" 0 "$tooling_exit"

echo "check-windows-portability self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
