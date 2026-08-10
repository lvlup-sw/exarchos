#!/usr/bin/env bash
# Self-test for check-windows-portability.mjs (#1623).
#   - A dirty fixture (one of each anti-pattern) must FAIL (exit 1).
#   - A clean fixture must PASS (exit 0).
#   - The real repo must PASS (exit 0) — guards against the gate going stale.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/check-windows-portability.mjs"
TMP="$(mktemp -d)"
# The scan-root cases plant a probe inside the real tree, each in its own
# `mktemp -d` directory recorded here. The trap removes exactly those, so a case
# that exits early never leaves the repo dirty and never deletes a path it did
# not create — a fixed probe name would be shared by two concurrent runs.
PROBE_DIRS=()
cleanup() {
  rm -rf "$TMP"
  for dir in "${PROBE_DIRS[@]}"; do
    [[ -n "$dir" ]] && rm -rf "$dir"
  done
}
trap cleanup EXIT

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

# ── Rule 1 kill fixtures: the forms that used to fall through BOTH rules ────
#
# `SPAWN_RE` matched only `execFile(Sync)('npm'|'npx'|…)` and `DYNAMIC_SPAWN_RE`
# requires an IDENTIFIER first argument, so a literal `spawnSync('npx', …)` was
# too general for one rule and too specific for the other — and the live
# instance of it in `scripts/lint-envelopes.mjs` shipped, failing on every
# Windows host post-CVE-2024-27980. Each case below is rejected only because
# rule 1 now covers spawn(Sync) as well as execFile(Sync).
mkdir -p "$TMP/r1spawn/src"
cat > "$TMP/r1spawn/src/literal-spawn.ts" <<'EOF'
import { spawnSync } from 'node:child_process';
export function lint(config: string) {
  return spawnSync('npx', ['--no-install', 'eslint', '--config', config]);
}
EOF
set +e
node "$GATE" --src-root "$TMP/r1spawn" >/dev/null 2>&1
r1spawn_exit=$?
set -e
check "rule 1: literal spawnSync('npx', …) is rejected" 1 "$r1spawn_exit"

# Windows resolves shim names case-insensitively, so `'NPM'` launches the same
# `npm.cmd` that `'npm'` does. The pattern carried only `g`, which let the
# SPELLING decide whether the rule applied — a violation that behaves identically
# at runtime and reads clean to the gate.
mkdir -p "$TMP/r1case/src"
cat > "$TMP/r1case/src/mixed-case-spawn.ts" <<'EOF'
import { spawnSync } from 'node:child_process';
export function install() { return spawnSync('NPM', ['ci']); }
export function exec() { return spawnSync('Npx', ['--no-install', 'tsc']); }
EOF
set +e
node "$GATE" --src-root "$TMP/r1case" >/dev/null 2>&1
r1case_exit=$?
set -e
check "rule 1: mixed-case shim spawnSync('NPM', …) is rejected" 1 "$r1case_exit"

# ── Argument handling: an unknown flag must not be silently ignored ─────────
#
# A misspelled `--src-roots` left the root list empty, so the gate fell back to
# its DEFAULT roots and reported success about a tree the caller never named.
set +e
node "$GATE" --src-roots "$TMP/dirty" >/dev/null 2>&1
badflag_exit=$?
set -e
check "unrecognised argument is a usage error, not a default-roots scan" 2 "$badflag_exit"

# The shim VOCABULARY is read from `utils/process.ts`'s WINDOWS_CMD_SHIMS rather
# than transcribed here. The retired hard-coded five (npm/npx/pnpm/yarn/corepack)
# had already drifted from the helper's seven, so `bun` was a shim the runtime
# handled and the gate ignored. This case is green ONLY if the derivation works.
mkdir -p "$TMP/r1bun/src"
cat > "$TMP/r1bun/src/bun-spawn.ts" <<'EOF'
import { spawnSync } from 'node:child_process';
export function build(outDir: string) {
  return spawnSync('bun', ['run', 'scripts/build-binary.ts', '--outdir', outDir]);
}
EOF
set +e
node "$GATE" --src-root "$TMP/r1bun" >/dev/null 2>&1
r1bun_exit=$?
set -e
check "rule 1: shim list is derived (a bare 'bun' spawn is rejected)" 1 "$r1bun_exit"

# The derivation FAILS CLOSED. A gate that silently policed an empty shim
# vocabulary would report "clean" for the same reason the retired scan roots
# did — because it looked at nothing. Both unreadable cases must exit 2, not 0.
mkdir -p "$TMP/failclosed/src"
cat > "$TMP/failclosed/src/inert.ts" <<'EOF'
export const answer = 42;
EOF
cat > "$TMP/no-shims.ts" <<'EOF'
export function needsWindowsShell() { return false; }
EOF
cat > "$TMP/empty-shims.ts" <<'EOF'
const WINDOWS_CMD_SHIMS = new Set([]);
export { WINDOWS_CMD_SHIMS };
EOF
set +e
# Control: this root is clean under the REAL helper, so a 2 below is the
# derivation refusing to run — not a missing root or a planted violation.
node "$GATE" --src-root "$TMP/failclosed" >/dev/null 2>&1
failclosed_control_exit=$?
node "$GATE" --src-root "$TMP/failclosed" --spawn-helper "$TMP/does-not-exist.ts" >/dev/null 2>&1
missing_helper_exit=$?
node "$GATE" --src-root "$TMP/failclosed" --spawn-helper "$TMP/no-shims.ts" >/dev/null 2>&1
no_decl_exit=$?
node "$GATE" --src-root "$TMP/failclosed" --spawn-helper "$TMP/empty-shims.ts" >/dev/null 2>&1
empty_decl_exit=$?
set -e
check "fail-closed control root passes under the real helper" 0 "$failclosed_control_exit"
check "shim derivation fails closed on a missing helper" 2 "$missing_helper_exit"
check "shim derivation fails closed on a helper with no WINDOWS_CMD_SHIMS" 2 "$no_decl_exit"
check "shim derivation fails closed on an empty WINDOWS_CMD_SHIMS" 2 "$empty_decl_exit"

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

# `process.execPath` is an absolute path to the running interpreter, so it can
# never resolve to a `.cmd` shim — rule 4 must not fire on it, in production
# source, or the gate would red the very form it steers callers towards.
mkdir -p "$TMP/r4self/src"
cat > "$TMP/r4self/src/reinvoke.ts" <<'EOF'
import { execFileSync } from 'node:child_process';
export function run(script: string) { return execFileSync(process.execPath, [script]); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4self" >/dev/null 2>&1
r4self_exit=$?
set -e
check "rule 4: process.execPath re-invocation is not a dynamic bin" 0 "$r4self_exit"

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

# ── Nested CI-tooling exemption (#1719, wave-S task 012): a build-tool dir
# nested below repo-root, e.g. `servers/*/scripts/` (the DR-7 stryker-adapter,
# CI-only/Linux-only, fail-closed on spawn error), must ALSO be exempt from
# rule 4 — CI_TOOLING_RE matches the KNOWN roots (repo-root `scripts/` and
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

# ── Scan-root coverage (task 081, DR-8) ────────────────────────────────────
#
# The default root used to be `servers/exarchos-mcp` alone, so repo-root
# `scripts/` and repo-root `src/` — both of which run on a developer's machine
# and emit to a `dist/` — were never opened. The gate was green about trees it
# had not read, which is how a literal `spawnSync('npx', …)` sat in
# `scripts/lint-envelopes.mjs` unseen. Assert the default roots by OBSERVING the
# gate report a violation planted in each, then removing it again: a scan root
# that is merely declared is not a scan root.
# Each probe lives in its own `mktemp -d` directory INSIDE the scan root, and
# only that directory is removed. Writing a fixed filename into the real tree
# means a second concurrent run — or a future source file that happens to carry
# the name — is overwritten and then deleted by the EXIT trap.
for subtree in scripts src; do
  probe_dir="$(mktemp -d "$REPO_ROOT/$subtree/portability_probe_XXXXXX")"
  PROBE_DIRS+=("$probe_dir")
  cat > "$probe_dir/probe.mjs" <<'EOF'
import * as path from 'node:path';
export const here = path.dirname(new URL(import.meta.url).pathname);
EOF
  set +e
  node "$GATE" >/dev/null 2>&1
  probe_exit=$?
  set -e
  rm -rf "$probe_dir"
  PROBE_DIRS=("${PROBE_DIRS[@]/$probe_dir}")
  check "default roots include repo-root $subtree/ (planted violation is seen)" 1 "$probe_exit"
done

# And with the probes removed the real tree is clean again — so the cases above
# measured the probe, not a pre-existing violation.
set +e
node "$GATE" >/dev/null 2>&1
after_probe_exit=$?
set -e
check "real repo is clean after the scan-root probes are removed" 0 "$after_probe_exit"

echo "check-windows-portability self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
