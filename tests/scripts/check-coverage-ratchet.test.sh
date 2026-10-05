#!/usr/bin/env bash
# Self-test for check-coverage-ratchet.mjs.
#
# Each case uses a fixture summary and a fixture baseline in a temp directory.
# No case reads the real `tools/audit/coverage-baseline.json`.
#
#   - a regression larger than epsilon: exit 1
#   - an identical summary: exit 0
#   - a missing or unparseable summary: exit 2 (fail closed)
#   - a baseline with no run-ids, no spread, or fewer than 3 distinct run-ids:
#     exit 2 (fail closed)
#   - a missing baseline file: exit 2 (fail closed)
#   - `--observe` with a regression or a missing summary: the gate logs the
#     verdict and exits 0
#
# The test also pins two settings in `vitest.config.ts`. Without `json-summary`
# in the coverage reporters, vitest writes no `coverage-summary.json`. Without
# `reportOnFailure: true`, vitest skips the summary when a test fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
GATE="$SCRIPT_DIR/check-coverage-ratchet.mjs"
VITEST_CONFIG="$(cd "$SCRIPT_DIR/../../.." && pwd)/vitest.config.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() { # <description> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then echo "  ok: $1"; pass=$((pass + 1));
  else echo "  FAIL: $1 (expected exit $2, got $3)"; fail=$((fail + 1)); fi
}
grep_cause() { # <description> <needle> <file>
  if grep -qi -- "$2" "$3"; then echo "  ok: $1 names cause '$2'"; pass=$((pass + 1));
  else echo "  FAIL: $1 did not name cause '$2'"; cat "$3" >&2; fail=$((fail + 1)); fi
}

# ── reporter-config prerequisite (vitest.config.ts) ─────────────────────────
if [[ -f "$VITEST_CONFIG" ]]; then
  if grep -q "json-summary" "$VITEST_CONFIG"; then
    echo "  ok: ReporterConfig_JsonSummaryPresent"; pass=$((pass + 1));
  else
    echo "  FAIL: ReporterConfig_JsonSummaryPresent — 'json-summary' missing from vitest.config.ts coverage.reporter";
    fail=$((fail + 1));
  fi
  if grep -q "reportOnFailure:[[:space:]]*true" "$VITEST_CONFIG"; then
    echo "  ok: ReporterConfig_ReportOnFailureTrue"; pass=$((pass + 1));
  else
    echo "  FAIL: ReporterConfig_ReportOnFailureTrue — 'reportOnFailure: true' missing from vitest.config.ts coverage block (summary silently skipped on any red run)";
    fail=$((fail + 1));
  fi
else
  echo "  FAIL: ReporterConfig — vitest.config.ts not found at $VITEST_CONFIG"
  fail=$((fail + 1))
fi

# ── fixtures ─────────────────────────────────────────────────────────────────

BASELINE_GOOD="$TMP/baseline-good.json"
cat > "$BASELINE_GOOD" <<'EOF'
{
  "runIds": ["1111111111", "1111111112", "1111111113"],
  "laneConfig": { "RUN_EVALS": "" },
  "capturedAt": "2026-07-17T00:00:00Z",
  "metrics": {
    "lines": { "pct": 80.0, "spread": 0.05 },
    "statements": { "pct": 79.0, "spread": 0.03 },
    "functions": { "pct": 75.0, "spread": 0.0 },
    "branches": { "pct": 70.0, "spread": 0.12 }
  }
}
EOF

SUMMARY_IDENTICAL="$TMP/summary-identical.json"
cat > "$SUMMARY_IDENTICAL" <<'EOF'
{
  "total": {
    "lines": { "total": 100, "covered": 80, "skipped": 0, "pct": 80.0 },
    "statements": { "total": 100, "covered": 79, "skipped": 0, "pct": 79.0 },
    "functions": { "total": 20, "covered": 15, "skipped": 0, "pct": 75.0 },
    "branches": { "total": 40, "covered": 28, "skipped": 0, "pct": 70.0 }
  }
}
EOF

# The `lines` metric drops by 10 points. Its epsilon is the 0.1-point floor.
SUMMARY_REGRESSED="$TMP/summary-regressed.json"
cat > "$SUMMARY_REGRESSED" <<'EOF'
{
  "total": {
    "lines": { "total": 100, "covered": 70, "skipped": 0, "pct": 70.0 },
    "statements": { "total": 100, "covered": 79, "skipped": 0, "pct": 79.0 },
    "functions": { "total": 20, "covered": 15, "skipped": 0, "pct": 75.0 },
    "branches": { "total": 40, "covered": 28, "skipped": 0, "pct": 70.0 }
  }
}
EOF

SUMMARY_GARBAGE="$TMP/summary-garbage.json"
echo 'not valid json {' > "$SUMMARY_GARBAGE"

BASELINE_NO_RUNIDS="$TMP/baseline-no-runids.json"
cat > "$BASELINE_NO_RUNIDS" <<'EOF'
{
  "metrics": {
    "lines": { "pct": 80.0, "spread": 0.05 },
    "statements": { "pct": 79.0, "spread": 0.03 },
    "functions": { "pct": 75.0, "spread": 0.0 },
    "branches": { "pct": 70.0, "spread": 0.12 }
  }
}
EOF

# Three distinct run-ids satisfy the provenance floor. Only the missing `spread`
# of `lines` can make the gate fail closed.
BASELINE_NO_VARIANCE="$TMP/baseline-no-variance.json"
cat > "$BASELINE_NO_VARIANCE" <<'EOF'
{
  "runIds": ["1111111111", "1111111112", "1111111113"],
  "metrics": {
    "lines": { "pct": 80.0 },
    "statements": { "pct": 79.0, "spread": 0.03 },
    "functions": { "pct": 75.0, "spread": 0.0 },
    "branches": { "pct": 70.0, "spread": 0.12 }
  }
}
EOF

# Provenance floor: three entries hold only two distinct run-ids. The gate must
# fail closed, although each metric and each spread is well-formed.
BASELINE_TOO_FEW_RUNS="$TMP/baseline-too-few-runs.json"
cat > "$BASELINE_TOO_FEW_RUNS" <<'EOF'
{
  "runIds": ["1111111111", "1111111111", "1111111112"],
  "metrics": {
    "lines": { "pct": 80.0, "spread": 0.05 },
    "statements": { "pct": 79.0, "spread": 0.03 },
    "functions": { "pct": 75.0, "spread": 0.0 },
    "branches": { "pct": 70.0, "spread": 0.12 }
  }
}
EOF

MISSING_SUMMARY="$TMP/does-not-exist-summary.json"
MISSING_BASELINE="$TMP/does-not-exist-baseline.json"

# ── direction 1: synthetic regression beyond epsilon → FAILS (exit 1) ───────
set +e
node "$GATE" --summary "$SUMMARY_REGRESSED" --baseline "$BASELINE_GOOD" \
  >"$TMP/regressed.out" 2>"$TMP/regressed.err"
regressed_exit=$?
set -e
check "Regression_BeyondEpsilon_Fails" 1 "$regressed_exit"
grep_cause "regression" "regress" "$TMP/regressed.err"
grep_cause "regression" "lines" "$TMP/regressed.err"

# ── direction 2: identical summary → PASSES (exit 0) ────────────────────────
set +e
node "$GATE" --summary "$SUMMARY_IDENTICAL" --baseline "$BASELINE_GOOD" \
  >"$TMP/identical.out" 2>"$TMP/identical.err"
identical_exit=$?
set -e
check "IdenticalSummary_Passes" 0 "$identical_exit"
grep_cause "identical-pass" "PASS" "$TMP/identical.out"

# ── direction 3: missing/unparseable summary → FAILS CLOSED (exit 2) ───────
set +e
node "$GATE" --summary "$MISSING_SUMMARY" --baseline "$BASELINE_GOOD" \
  >/dev/null 2>"$TMP/missing-summary.err"
missing_summary_exit=$?
set -e
check "SummaryMissing_FailsClosed" 2 "$missing_summary_exit"
grep_cause "summary-missing" "fail closed\|FAIL CLOSED" "$TMP/missing-summary.err"
grep_cause "summary-missing" "not found" "$TMP/missing-summary.err"

set +e
node "$GATE" --summary "$SUMMARY_GARBAGE" --baseline "$BASELINE_GOOD" \
  >/dev/null 2>"$TMP/garbage-summary.err"
garbage_summary_exit=$?
set -e
check "SummaryUnparseable_FailsClosed" 2 "$garbage_summary_exit"
grep_cause "summary-unparseable" "unparseable" "$TMP/garbage-summary.err"

# ── direction 4: provenance-less baseline → FAILS CLOSED (exit 2) ──────────
set +e
node "$GATE" --summary "$SUMMARY_IDENTICAL" --baseline "$BASELINE_NO_RUNIDS" \
  >/dev/null 2>"$TMP/no-runids.err"
no_runids_exit=$?
set -e
check "BaselineMissingRunIds_FailsClosed" 2 "$no_runids_exit"
grep_cause "no-run-ids" "run-ids" "$TMP/no-runids.err"

set +e
node "$GATE" --summary "$SUMMARY_IDENTICAL" --baseline "$BASELINE_NO_VARIANCE" \
  >/dev/null 2>"$TMP/no-variance.err"
no_variance_exit=$?
set -e
check "BaselineMissingVariance_FailsClosed" 2 "$no_variance_exit"
grep_cause "no-variance" "variance" "$TMP/no-variance.err"

# ── direction 4b: fewer than 3 DISTINCT run-ids → FAILS CLOSED (exit 2) ─────
set +e
node "$GATE" --summary "$SUMMARY_IDENTICAL" --baseline "$BASELINE_TOO_FEW_RUNS" \
  >/dev/null 2>"$TMP/too-few-runs.err"
too_few_runs_exit=$?
set -e
check "BaselineTooFewDistinctRuns_FailsClosed" 2 "$too_few_runs_exit"
grep_cause "too-few-runs" "distinct run-id" "$TMP/too-few-runs.err"

# ── direction 5: missing baseline file → FAILS CLOSED (exit 2) ──────────────
set +e
node "$GATE" --summary "$SUMMARY_IDENTICAL" --baseline "$MISSING_BASELINE" \
  >/dev/null 2>"$TMP/missing-baseline.err"
missing_baseline_exit=$?
set -e
check "BaselineFileMissing_FailsClosed" 2 "$missing_baseline_exit"
grep_cause "baseline-missing" "not found" "$TMP/missing-baseline.err"

# ── --observe: a regression and a fail-closed condition each exit 0 ─────────
set +e
node "$GATE" --summary "$SUMMARY_REGRESSED" --baseline "$BASELINE_GOOD" --observe \
  >"$TMP/observe-regressed.out" 2>"$TMP/observe-regressed.err"
observe_regressed_exit=$?
set -e
check "Observe_RegressionNeverBlocks" 0 "$observe_regressed_exit"
grep_cause "observe-regression" "OBSERVE" "$TMP/observe-regressed.out"

set +e
node "$GATE" --summary "$MISSING_SUMMARY" --baseline "$BASELINE_GOOD" --observe \
  >"$TMP/observe-missing.out" 2>"$TMP/observe-missing.err"
observe_missing_exit=$?
set -e
check "Observe_FailClosedNeverBlocks" 0 "$observe_missing_exit"
grep_cause "observe-fail-closed" "OBSERVE" "$TMP/observe-missing.out"

echo ""
echo "check-coverage-ratchet self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
