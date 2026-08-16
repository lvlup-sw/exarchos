#!/usr/bin/env bash
# Self-test for check-windows-portability.mjs (#1623).
#   - A dirty fixture (one of each anti-pattern) must FAIL (exit 1).
#   - A clean fixture must PASS (exit 0).
#   - The real repo must PASS (exit 0) — guards against the gate going stale.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
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

# ── CI-tooling exemption: the fail-closed audit gates under tools/audit
# (knip-diff.ts / cycle-gate.ts) call raw `spawnSync(binPath, …)` with a
# VARIABLE bin — rule 4's shape. They are CI-only tooling that degrades to
# fail-closed on a spawn error, so rule 4 (whose scope is "Production files
# only") is exempted for tools/audit/. The live tools/audit tree must
# therefore scan CLEAN. Reverting the exemption reds this case (proving its
# teeth): those audit gates would then trip rule 4.
set +e
node "$GATE" --src-root "$(cd "$SCRIPT_DIR/.." && pwd)" >/dev/null 2>&1
tooling_exit=$?
set -e
check "tools/audit CI tooling is exempt from rule 4" 0 "$tooling_exit"

# ── Nested CI-tooling exemption: a build-tool dir nested below repo-root,
# e.g. `servers/*/scripts/` (stryker-adapter, CI-only/Linux-only, fail-closed
# on spawn error), must ALSO be exempt from rule 4 — CI_TOOLING_RE matches
# the known roots (repo-root `scripts/`, `tools/audit/`, and
# `servers/<name>/scripts/`).
mkdir -p "$TMP/nested/servers/fake-mcp/scripts"
cat > "$TMP/nested/servers/fake-mcp/scripts/adapter.mjs" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(binPath, args) { return execFileSync(binPath, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/nested" >/dev/null 2>&1
nested_tooling_exit=$?
set -e
check "nested servers/*/scripts/ CI tooling is exempt from rule 4" 0 "$nested_tooling_exit"

# Post-fold audit root: `tools/audit/` under a synthetic repo must be exempt
# from rule 4 the same way the live tree is.
mkdir -p "$TMP/fold/tools/audit"
cat > "$TMP/fold/tools/audit/adapter.mjs" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(binPath, args) { return execFileSync(binPath, args); }
export function measure() { return execFileSync('npx', ['tsx', 'x.ts']); }
EOF
set +e
node "$GATE" --src-root "$TMP/fold" >/dev/null 2>&1
fold_tooling_exit=$?
set -e
check "tools/audit/ CI tooling is exempt from rule 4" 0 "$fold_tooling_exit"

# Test-tree harnesses (helpers / evals / benchmark runners) are not shipped
# runtime — rule 4 is production-only and must not flag them.
mkdir -p "$TMP/testharness/tests/helpers"
cat > "$TMP/testharness/tests/helpers/cli-runner.ts" <<'EOF'
import { spawnSync } from 'node:child_process';
export function run(cmd: string, args: string[]) { return spawnSync(cmd, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/testharness" >/dev/null 2>&1
testharness_exit=$?
set -e
check "tests/ harness files are exempt from rule 4" 0 "$testharness_exit"

# ── Negative case (#1719 finding 14): a SHIPPED runtime `scripts/` dir — here
# `servers/*/src/scripts/` — is NOT a CI-tooling root and must stay CHECKED, so
# a production dynamic-bin spawn can never bypass rule 4 on directory name
# alone. The blanket "`scripts/` at any depth" match would have wrongly exempted
# it; the tightened CI_TOOLING_RE must red this.
mkdir -p "$TMP/runtime/servers/fake-mcp/src/scripts"
cat > "$TMP/runtime/servers/fake-mcp/src/scripts/dynspawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(bin: string, args: string[]) { return execFileSync(bin, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/runtime" >/dev/null 2>&1
runtime_scripts_exit=$?
set -e
check "runtime servers/*/src/scripts/ is NOT exempt (rule 4 still checks it)" 1 "$runtime_scripts_exit"

# ── Negative case (CodeRabbit round 2, #1719 finding A): the PRE-round-2
# CI_TOOLING_RE used a `(?:^|[/\\])` boundary on the `servers/…` alternative,
# so it matched at ANY depth — e.g. `src/servers/foo/scripts/…` — not just at
# the scan root. That is a DIFFERENT shape from the `servers/*/src/scripts/`
# case above (which the pre-round-2 regex already rejected, since it requires
# exactly ONE segment between `servers/` and `scripts/`): here `servers/` is
# nested BELOW `src/`, one path segment further out. A shipped runtime path
# like this must stay CHECKED; the round-2 hard `^`-anchor on CI_TOOLING_RE
# must red this.
mkdir -p "$TMP/shipped/src/servers/fake-mcp/scripts"
cat > "$TMP/shipped/src/servers/fake-mcp/scripts/dynspawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(bin: string, args: string[]) { return execFileSync(bin, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/shipped" >/dev/null 2>&1
shipped_scripts_exit=$?
set -e
check "shipped src/servers/*/scripts/ is NOT exempt (rule 4 still checks it)" 1 "$shipped_scripts_exit"

# A shipped runtime path that merely contains `tools/audit/` below `src/`
# must stay CHECKED — the hard `^` anchor on CI_TOOLING_RE must red this.
mkdir -p "$TMP/shipped-audit/src/tools/audit"
cat > "$TMP/shipped-audit/src/tools/audit/dynspawn.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(bin: string, args: string[]) { return execFileSync(bin, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/shipped-audit" >/dev/null 2>&1
shipped_audit_exit=$?
set -e
check "shipped src/tools/audit/ is NOT exempt (rule 4 still checks it)" 1 "$shipped_audit_exit"

echo "check-windows-portability self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
