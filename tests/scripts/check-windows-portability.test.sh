#!/usr/bin/env bash
# Self-test for check-windows-portability.mjs.
#   - A dirty fixture with one violation of each rule must fail (exit 1).
#   - A clean fixture must pass (exit 0).
#   - The real repo must pass (exit 0).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GATE="$SCRIPT_DIR/check-windows-portability.mjs"
TMP="$(mktemp -d)"
# The scan-root cases put each probe in its own `mktemp -d` directory inside the
# real tree and record the directory here. The EXIT trap removes only those
# directories. A fixed probe name can collide between two concurrent runs.
PROBE_DIRS=()
cleanup() {
  rm -rf "$TMP"
  # Under `set -u`, an empty array is an unbound expansion, so the loop uses
  # `${PROBE_DIRS[@]+…}`. This function runs from the EXIT trap, and its status
  # becomes the status of the script. With `return 0`, a false last test cannot
  # give exit 1 after each case passed.
  for dir in ${PROBE_DIRS[@]+"${PROBE_DIRS[@]}"}; do
    if [[ -n "$dir" ]]; then rm -rf "$dir"; fi
  done
  return 0
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

# ── Rule 1 kill fixtures: a literal shim name in spawn(Sync) ────────────────
#
# Rule 1 must match spawn(Sync) and execFile(Sync). Rule 4 (`DYNAMIC_SPAWN_RE`)
# requires an IDENTIFIER first argument, so a literal `spawnSync('npx', …)` was
# never a match for rule 4. Only rule 1 can reject the two cases below.
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

# Windows resolves shim names without regard to case, so `'NPM'` launches the
# same `npm.cmd` as `'npm'`. Rule 1 must ignore case too.
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
# A misspelled `--src-roots` must exit 2. A fallback to the default roots
# reports on a tree that the caller did not name.
set +e
node "$GATE" --src-roots "$TMP/dirty" >/dev/null 2>&1
badflag_exit=$?
set -e
check "unrecognised argument is a usage error, not a default-roots scan" 2 "$badflag_exit"

# The gate reads the shim names from WINDOWS_CMD_SHIMS in `utils/process.ts`.
# `bun` is in that set, so the gate rejects this case only when it derives the
# names from the helper.
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

# The derivation fails closed. A gate with an empty shim list reports "clean"
# because it checks nothing. A missing helper, a helper with no
# WINDOWS_CMD_SHIMS, and an empty set must each exit 2.
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
# Control: this root is clean with the real helper. An exit 2 below then comes
# from the derivation, not from a missing root or a violation.
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

# The spawn helper (utils/process.ts) is exempt. It holds the raw execFile and
# spawn calls with a variable bin by design.
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

# The async test-side helper (tools/test-helpers/spawn.ts) is exempt for the
# same reason. The exemption is by file, so the gate still flags a sibling
# module with the same call.
mkdir -p "$TMP/r4testhelper/tools/test-helpers"
cat > "$TMP/r4testhelper/tools/test-helpers/spawn.ts" <<'EOF'
import { spawn } from 'node:child_process';
export function spawnAsync(command: string, args: string[]) { return spawn(command, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4testhelper" >/dev/null 2>&1
r4testhelper_exit=$?
set -e
check "rule 4: test-helpers/spawn.ts helper is exempt" 0 "$r4testhelper_exit"

mkdir -p "$TMP/r4testsibling/tools/test-helpers"
cat > "$TMP/r4testsibling/tools/test-helpers/other.ts" <<'EOF'
import { spawn } from 'node:child_process';
export function run(command: string, args: string[]) { return spawn(command, args); }
EOF
set +e
node "$GATE" --src-root "$TMP/r4testsibling" >/dev/null 2>&1
r4testsibling_exit=$?
set -e
check "rule 4: a sibling of the test-side helper is not exempt" 1 "$r4testsibling_exit"

# `process.execPath` is the absolute path of the running interpreter, so it
# never resolves to a `.cmd` shim. Rule 4 must not flag it in production source.
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

# A `.bench.ts` file is dev-only, so rule 4 skips it.
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

# ── CI-tooling exemption ────────────────────────────────────────────────────
# The audit gates under tools/audit (knip-diff.ts, cycle-gate.ts) call a raw
# `spawnSync` with a variable bin, which is the shape of rule 4. They run only
# in CI and fail closed on a spawn error, so rule 4 skips tools/audit/. The
# live tools/audit tree must scan clean. Without the exemption, those gates
# trip rule 4 and this case fails.
set +e
node "$GATE" --src-root "$(cd "$SCRIPT_DIR/.." && pwd)" >/dev/null 2>&1
tooling_exit=$?
set -e
check "tools/audit CI tooling is exempt from rule 4" 0 "$tooling_exit"

# ── Nested CI-tooling exemption ─────────────────────────────────────────────
# A build-tool directory at `servers/<name>/scripts/` is also exempt from rule
# 4. CI_TOOLING_RE matches three roots: `scripts/`, `tools/audit/` and
# `servers/<name>/scripts/`.
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

# `tools/audit/` under a fixture root must be exempt from rule 4, as the live
# tree is.
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

# Harness files under `tests/` are not shipped runtime. Rule 4 applies to
# production files only and must not flag them.
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

# ── Negative case: a shipped `scripts/` directory ───────────────────────────
# `servers/<name>/src/scripts/` is not a CI-tooling root, so rule 4 must check
# it. A match on "`scripts/` at any depth" lets a production dynamic-bin spawn
# bypass rule 4 by directory name alone.
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

# ── Negative case: `servers/` below `src/` ──────────────────────────────────
# CI_TOOLING_RE has a hard `^` anchor, so it matches `servers/<name>/scripts/`
# only at the start of the path. Here `servers/` sits below `src/`. A
# `(?:^|[/\\])` boundary matches at any depth and exempts this shipped path.
# Rule 4 must check it.
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

# A shipped path with `tools/audit/` below `src/` is not exempt. The `^`
# anchor of CI_TOOLING_RE makes rule 4 check it.
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

# ── Scan-root coverage ──────────────────────────────────────────────────────
#
# The default roots must include repo-root `src/` and `tools/audit/`. A declared
# root proves nothing, so each case plants a violation in one tree and observes
# that the gate reports it.
# Each probe sits in its own `mktemp -d` directory inside the scan root, and the
# case removes only that directory. A fixed file name in the real tree can
# overwrite, and then delete, a file of a concurrent run or a later source file.
for subtree in src tools/audit; do
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
  # Build the array again without this entry. `${arr[@]/x}` replaces a
  # substring, so it leaves an empty element and removes none.
  remaining=()
  for d in ${PROBE_DIRS[@]+"${PROBE_DIRS[@]}"}; do
    if [[ "$d" != "$probe_dir" ]]; then remaining+=("$d"); fi
  done
  PROBE_DIRS=(${remaining[@]+"${remaining[@]}"})
  check "default roots include repo-root $subtree/ (planted violation is seen)" 1 "$probe_exit"
done

# Without the probes, the real tree is clean. Thus the cases above measured the
# probe, not a violation that was already there.
set +e
node "$GATE" >/dev/null 2>&1
after_probe_exit=$?
set -e
check "real repo is clean after the scan-root probes are removed" 0 "$after_probe_exit"

echo "check-windows-portability self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
