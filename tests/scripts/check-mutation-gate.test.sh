#!/usr/bin/env bash
# Self-test for check-mutation-gate.mjs.
#
# The test builds a git fixture repo in a temp directory. It uses no network and
# does not run Stryker. The `mutation:` entry in the fixture `.exarchos.yml`
# runs fixture-runner.mjs, which prints a chosen Stryker report fixture. The
# gate calls the real handler through its real bun bridge, and the handler
# parses that report.
#
# Requires a real `bun` on PATH (the same tool test-mcp already sets up via
# `oven-sh/setup-bun@v2`). Without `bun`, the script exits 1 before the first
# case. Cases 1, 2 and 7 to 10 run the handler under `bun`.
#
# Cases:
#   1. NoCoverage over budget in the diff     → fails            exit 1
#   2. All mutants killed (positive control)  → passes           exit 0
#   3. Empty `src/**` diff (base == head)     → logged SKIP      exit 0
#   4. Event other than `pull_request`        → logged SKIP      exit 0
#   5. Git failure (root is not a git repo)   → fails closed     exit 2
#   6. Missing tool (bad `--bun-bin`)         → fails closed     exit 2
#   7. Malformed report (degraded result)     → fails            exit 1
#   8. Malformed report with `--observe`      → does not block   exit 0
#   9. NoCoverage failure with `--observe`    → does not block   exit 0
#  10. No `.exarchos.yml` (no toolchain)      → fails            exit 1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
GATE="$SCRIPT_DIR/check-mutation-gate.mjs"
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

if ! command -v bun >/dev/null 2>&1; then
  echo "check-mutation-gate.test.sh: FAIL — 'bun' is required on PATH to drive this self-test" \
    "(the gate's invocation seam), but was not found. Every scenario below except the deliberately" \
    "broken --bun-bin case needs it." >&2
  exit 1
fi

# ── fixture repo (no network; local git only) ───────────────────────────────

FIXTURE="$TMP/fixture-repo"
mkdir -p "$FIXTURE/src"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email test@example.com
git -C "$FIXTURE" config user.name "check-mutation-gate self-test"
echo "export const x = 1;" > "$FIXTURE/src/fake.ts"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -q -m base
BASE_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

echo "export const y = 2;" >> "$FIXTURE/src/fake.ts"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -q -m change
HEAD_SHA="$(git -C "$FIXTURE" rev-parse HEAD)"

# The fixture mutation runner prints the report file that argv[2] names. It
# ignores every other argument.
FIXTURE_RUNNER="$TMP/fixture-runner.mjs"
cat > "$FIXTURE_RUNNER" <<'EOF'
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.argv[2], 'utf-8'));
EOF

REPORT_NOCOVERAGE="$TMP/report-nocoverage.json"
cat > "$REPORT_NOCOVERAGE" <<'EOF'
{"schemaVersion":"1.0","files":{"src/fake.ts":{"language":"typescript","mutants":[
 {"id":"1","mutatorName":"m","status":"NoCoverage","location":{"start":{"line":1,"column":1},"end":{"line":1,"column":2}}},
 {"id":"2","mutatorName":"m","status":"Killed","location":{"start":{"line":2,"column":1},"end":{"line":2,"column":2}}}
]}}}
EOF

REPORT_ALLCOVERED="$TMP/report-allcovered.json"
cat > "$REPORT_ALLCOVERED" <<'EOF'
{"schemaVersion":"1.0","files":{"src/fake.ts":{"language":"typescript","mutants":[
 {"id":"1","mutatorName":"m","status":"Killed","location":{"start":{"line":1,"column":1},"end":{"line":1,"column":2}}},
 {"id":"2","mutatorName":"m","status":"Killed","location":{"start":{"line":2,"column":1},"end":{"line":2,"column":2}}}
]}}}
EOF

REPORT_GARBAGE="$TMP/report-garbage.json"
echo 'not valid json {' > "$REPORT_GARBAGE"

set_mutation_entry() { # <report-fixture-path>
  cat > "$FIXTURE/.exarchos.yml" <<EOF
mutation: node $FIXTURE_RUNNER $1
EOF
}

# ── direction 1: fabricated NoCoverage-exceeding diff → FAILS (exit 1) ──────
set_mutation_entry "$REPORT_NOCOVERAGE"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/nocoverage.out" 2>"$TMP/nocoverage.err"
nocoverage_exit=$?
set -e
check "NoCoverageExceedsBudget_Fails" 1 "$nocoverage_exit"
grep_cause "nocoverage-fail" "noCoverage" "$TMP/nocoverage.err"
grep_cause "nocoverage-fail" "fake.ts" "$TMP/nocoverage.err"

# ── direction 2: all-covered diff (kill-probe positive control) → PASSES ───
set_mutation_entry "$REPORT_ALLCOVERED"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/allcovered.out" 2>"$TMP/allcovered.err"
allcovered_exit=$?
set -e
check "AllCoveredDiff_Passes" 0 "$allcovered_exit"
grep_cause "all-covered-pass" "PASS" "$TMP/allcovered.out"

# ── direction 3: empty server-scoped diff (base==head) → logged SKIP ───────
set +e
node "$GATE" --event-name pull_request --base "$HEAD_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/emptydiff.out" 2>"$TMP/emptydiff.err"
emptydiff_exit=$?
set -e
check "EmptyServerDiff_SkipExitsZero" 0 "$emptydiff_exit"
grep_cause "empty-diff-skip" "SKIP" "$TMP/emptydiff.out"

# ── direction 4: non-pull_request event → logged SKIP ──────────────────────
set +e
node "$GATE" --event-name push --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/nonpr.out" 2>"$TMP/nonpr.err"
nonpr_exit=$?
set -e
check "NonPrEvent_SkipExitsZero" 0 "$nonpr_exit"
grep_cause "non-pr-skip" "SKIP" "$TMP/nonpr.out"

# ── direction 5: git failure (unresolvable + unfetchable base) → FAIL CLOSED
NOT_A_GIT_REPO="$TMP/not-a-git-repo"
mkdir -p "$NOT_A_GIT_REPO"
set +e
node "$GATE" --event-name pull_request --base "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" --head HEAD \
  --repo-root "$NOT_A_GIT_REPO" \
  >"$TMP/gitfail.out" 2>"$TMP/gitfail.err"
gitfail_exit=$?
set -e
check "GitFailure_FailsClosed" 2 "$gitfail_exit"
grep_cause "git-failure" "FAIL CLOSED" "$TMP/gitfail.err"

# ── direction 6: missing tooling (bogus --bun-bin) → FAIL CLOSED ───────────
set_mutation_entry "$REPORT_ALLCOVERED"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  --bun-bin "$TMP/no-such-bun-binary" \
  >"$TMP/missingtool.out" 2>"$TMP/missingtool.err"
missingtool_exit=$?
set -e
check "MissingTooling_FailsClosed" 2 "$missingtool_exit"
grep_cause "missing-tooling" "FAIL CLOSED" "$TMP/missingtool.err"
grep_cause "missing-tooling" "bun" "$TMP/missingtool.err"

# ── direction 7: degraded carrier (malformed report) → FAILS (blocking) ────
set_mutation_entry "$REPORT_GARBAGE"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/degrade.out" 2>"$TMP/degrade.err"
degrade_exit=$?
set -e
check "DegradedCarrier_FailsBlocking" 1 "$degrade_exit"
grep_cause "degrade-fail" "degraded" "$TMP/degrade.err"

# ── direction 8: degraded carrier + --observe → never blocks ───────────────
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" --observe \
  >"$TMP/degrade-observe.out" 2>"$TMP/degrade-observe.err"
degrade_observe_exit=$?
set -e
check "DegradedCarrier_ObserveNeverBlocks" 0 "$degrade_observe_exit"
grep_cause "degrade-observe" "OBSERVE" "$TMP/degrade-observe.out"

# ── direction 9: NoCoverage failure + --observe → never blocks ─────────────
set_mutation_entry "$REPORT_NOCOVERAGE"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" --observe \
  >"$TMP/nocoverage-observe.out" 2>"$TMP/nocoverage-observe.err"
nocoverage_observe_exit=$?
set -e
check "NoCoverageFailure_ObserveNeverBlocks" 0 "$nocoverage_observe_exit"
grep_cause "nocoverage-observe" "OBSERVE" "$TMP/nocoverage-observe.out"

# ── bonus direction 10: no resolvable toolchain (no .exarchos.yml) → FAILS ──
rm -f "$FIXTURE/.exarchos.yml"
set +e
node "$GATE" --event-name pull_request --base "$BASE_SHA" --head "$HEAD_SHA" --repo-root "$FIXTURE" \
  >"$TMP/notoolchain.out" 2>"$TMP/notoolchain.err"
notoolchain_exit=$?
set -e
check "NoResolvableToolchain_Fails" 1 "$notoolchain_exit"
grep_cause "no-toolchain-fail" "skipped" "$TMP/notoolchain.err"

echo ""
echo "check-mutation-gate self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
