#!/usr/bin/env bash
# Self-test for tools/audit/gates/lint-envelopes.mjs.
#
# The test runs the real wrapper on fixtures, so the result does not depend on
# the violation count of the real tree. The fixtures are copied to a temp
# directory inside src/verbs/, the only tree that both tsconfig.json's `include` and
# eslint.envelopes.config.js's `files` glob cover, and pointed at via the
# `--target` flag of the wrapper. The default invocation stays unchanged.
#
#   - violating fixture: the wrapper exits 1 and names the rule.
#   - compliant fixture: the wrapper exits 0.
#   - a `--config` path that does not exist: the wrapper exits non-zero and
#     names the fail-closed cause.
#   - the shared eslint.config.js does not load the envelope rule and sets no
#     `parserOptions.project` for a file under src/verbs/.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root: $REPO_ROOT" >&2; exit 1; }

WRAPPER="tools/audit/gates/lint-envelopes.mjs"
FIXTURES_DIR="tools/eslint-rules/__fixtures__"
SELFTEST_DIR="src/verbs/__lint_envelopes_selftest__"

# Remove only the fixture directory. Its parent `src/verbs/` is source, not a
# leftover of this self-test.
cleanup() {
  rm -rf "$SELFTEST_DIR"
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

# Config isolation: the shared eslint.config.js does not load the envelope rule, and it does not
# run type-aware over the file that the dedicated config targets. `eslint --print-config` with no
# `--config` flag resolves the default eslint.config.js, as the comment gate does.
printed_config="$(npx --no-install eslint --print-config \
  src/verbs/composite.ts 2>"$SELFTEST_DIR/printconfig.err")"
if echo "$printed_config" | grep -q 'no-handler-throw'; then
  echo "  FAIL: LintWindows_DoesNotLoadEnvelopesRule (rule leaked into the shared eslint.config.js)"
  fail=$((fail + 1))
else
  echo "  ok: LintWindows_DoesNotLoadEnvelopesRule (shared config stays free of envelopes/no-handler-throw)"
  pass=$((pass + 1))
fi
# `parserOptions.project` makes a run type-aware and slow. The shared configuration must keep
# empty parserOptions for this file. That proves it stays a fast, syntax-only run.
if echo "$printed_config" | grep -A2 '"parserOptions"' | grep -q '"project"'; then
  echo "  FAIL: LintWindows_StaysNonTypeAware (parserOptions.project leaked into the shared config)"
  fail=$((fail + 1))
else
  echo "  ok: LintWindows_StaysNonTypeAware (no parserOptions.project on the shared config for this file)"
  pass=$((pass + 1))
fi

echo "lint-envelopes self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
