#!/usr/bin/env bash
# Self-test for tools/audit/gates/lint-envelopes.mjs (#1706 DR-2, task 002).
#
# Drives the REAL wrapper (not a stand-in) against CONTROLLED fixtures, so the
# assertions stay deterministic regardless of the real orchestrate/** tree's
# current violation count (5 known violations at the time this gate was
# wired — task 003 disposes of those separately). The fixtures are placed
# under a temp subdirectory INSIDE src/orchestrate/, the
# only path both the MCP tsconfig's `include` ("src/**/*") and
# eslint.envelopes.config.js's `files` glob cover, and pointed at via the
# wrapper's `--target` testability flag (mirrors check-module-intent.mjs's
# `--src-root`/`--refgraph` seam) so the DEFAULT (no-flags) invocation used by
# `npm run lint:envelopes` / the grep-gates CI step is never itself modified.
#
#   - violating fixture (reused from tools/eslint-rules/__fixtures__, DR-1's own
#     fixture pair) → the wrapper exits 1 (ESLint reports errors).
#   - compliant fixture (same pair)                → the wrapper exits 0.
#   - fail-closed: --config pointed at a missing path → the wrapper exits 2,
#     naming the cause. Confirms the wrapper does not mistake a broken/absent
#     config for "nothing to report" (fail-closed, not fail-open).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root: $REPO_ROOT" >&2; exit 1; }

WRAPPER="tools/audit/gates/lint-envelopes.mjs"
FIXTURES_DIR="tools/eslint-rules/__fixtures__"
SELFTEST_DIR="src/orchestrate/__lint_envelopes_selftest__"

# `mkdir -p` below creates BOTH levels, so removing only the leaf leaves an
# empty src/orchestrate/ behind. That directory is not part of the tree any
# more (it became src/verbs/), and the layer map scans the disk — so the
# leftover reads as an unmapped source directory and reds six assertions in
# tests/architecture/layer-map.test.ts, in a suite that never ran this file.
cleanup() {
  rm -rf "$SELFTEST_DIR"
  rmdir "$(dirname "$SELFTEST_DIR")" 2>/dev/null || true
}
trap cleanup EXIT

pass=0
fail=0
check() { # <description> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then echo "  ok: $1"; pass=$((pass + 1));
  else echo "  FAIL: $1 (expected exit $2, got $3)"; fail=$((fail + 1)); fi
}

if [[ ! -f "$WRAPPER" ]]; then
  echo "FAIL: $WRAPPER not found" >&2
  exit 1
fi

mkdir -p "$SELFTEST_DIR"
cp "$FIXTURES_DIR/handler-throw.violating.ts" "$SELFTEST_DIR/violating.ts"
cp "$FIXTURES_DIR/handler-throw.compliant.ts" "$SELFTEST_DIR/compliant.ts"

# ── violating fixture: the wrapper exits 1 (ESLint reports errors) ──────────
set +e
node "$WRAPPER" --target "$SELFTEST_DIR/violating.ts" >"$SELFTEST_DIR/violating.out" 2>&1
violating_exit=$?
set -e
check "LintEnvelopes_ViolatingFixture_ExitsNonZero" 1 "$violating_exit"
if grep -q 'envelopes/no-handler-throw' "$SELFTEST_DIR/violating.out"; then
  echo "  ok: violating output names the envelopes/no-handler-throw rule"
  pass=$((pass + 1))
else
  echo "  FAIL: violating output does not name the envelopes/no-handler-throw rule"
  cat "$SELFTEST_DIR/violating.out"
  fail=$((fail + 1))
fi

# ── compliant fixture: the wrapper exits 0 ───────────────────────────────────
set +e
node "$WRAPPER" --target "$SELFTEST_DIR/compliant.ts" >"$SELFTEST_DIR/compliant.out" 2>&1
compliant_exit=$?
set -e
check "LintEnvelopes_CompliantFixture_ExitsZero" 0 "$compliant_exit"

# ── fail-closed: a missing --config path exits non-zero, not silently clean ──
set +e
node "$WRAPPER" --config "eslint.envelopes.config.MISSING.js" --target "$SELFTEST_DIR/compliant.ts" \
  >"$SELFTEST_DIR/failclosed.out" 2>&1
failclosed_exit=$?
set -e
if [[ "$failclosed_exit" != "0" ]]; then
  echo "  ok: LintEnvelopes_MissingConfig_FailsClosed (exit $failclosed_exit, non-zero)"
  pass=$((pass + 1))
else
  echo "  FAIL: LintEnvelopes_MissingConfig_FailsClosed (expected non-zero exit, got 0)"
  fail=$((fail + 1))
fi
if grep -qi 'fail-closed' "$SELFTEST_DIR/failclosed.out"; then
  echo "  ok: missing-config output names the fail-closed cause"
  pass=$((pass + 1))
else
  echo "  FAIL: missing-config output did not name a fail-closed cause"
  cat "$SELFTEST_DIR/failclosed.out"
  fail=$((fail + 1))
fi

# ── config isolation: lint:windows (test-root, the FILTERED shared config)
# neither loads the envelopes rule nor is silently converted to a type-aware
# run over the same file the dedicated config targets. Uses `eslint
# --print-config` with NO `--config` flag, so it resolves the DEFAULT
# eslint.config.js exactly as `npm run lint:windows` does. ────────────────────
printed_config="$(npx --no-install eslint --print-config \
  src/orchestrate/composite.ts 2>"$SELFTEST_DIR/printconfig.err")"
if echo "$printed_config" | grep -q 'no-handler-throw'; then
  echo "  FAIL: LintWindows_DoesNotLoadEnvelopesRule (rule leaked into the shared eslint.config.js)"
  fail=$((fail + 1))
else
  echo "  ok: LintWindows_DoesNotLoadEnvelopesRule (shared config stays free of envelopes/no-handler-throw)"
  pass=$((pass + 1))
fi
# parserOptions.project is what makes a run type-aware (and #1721-class
# expensive); the shared config's effective parserOptions must stay empty for
# this file, proving lint:windows was not silently converted to type-aware.
if echo "$printed_config" | grep -A2 '"parserOptions"' | grep -q '"project"'; then
  echo "  FAIL: LintWindows_StaysNonTypeAware (parserOptions.project leaked into the shared config)"
  fail=$((fail + 1))
else
  echo "  ok: LintWindows_StaysNonTypeAware (no parserOptions.project on the shared config for this file)"
  pass=$((pass + 1))
fi

echo "lint-envelopes self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
