#!/usr/bin/env bash
# Self-test for the fail-closed paths of check-module-intent.mjs.
#
# The `.test.ts` cases of the gate run only in path-filtered CI jobs. This
# script runs in the unfiltered `grep-gates` job. It drives the real CLI
# through the `--refgraph` flag.
#
#   - tool-missing: the reachability detector file does not exist. The gate
#     must exit 2 and name a fail-closed scan error.
#   - unparseable-output: a stub detector prints no "ALL DEAD-IN-PROD" section.
#     The gate must exit 2 and name the missing section.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
GATE="$SCRIPT_DIR/check-module-intent.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The gate requires `--src-root` to be a directory. The directory stays empty,
# because the scan fails before the gate reads a module.
mkdir -p "$TMP/src"

pass=0
fail=0
check() { # <description> <expected-exit> <actual-exit>
  if [[ "$2" == "$3" ]]; then echo "  ok: $1"; pass=$((pass + 1));
  else echo "  FAIL: $1 (expected exit $2, got $3)"; fail=$((fail + 1)); fi
}
grep_cause() { # <description> <needle> <file>
  if grep -qi -- "$2" "$3"; then echo "  ok: $1 names cause '$2'"; pass=$((pass + 1));
  else echo "  FAIL: $1 did not name cause '$2'"; cat "$3"; fail=$((fail + 1)); fi
}

# ── tool-missing: reachability detector absent → FAIL CLOSED (exit 2) ────────
set +e
node "$GATE" --src-root "$TMP/src" --refgraph "$TMP/no-such-refgraph.mjs" \
  >/dev/null 2>"$TMP/missing.err"
missing_exit=$?
set -e
check "ModuleIntent_RefgraphMissing_FailsClosed" 2 "$missing_exit"
grep_cause "refgraph-missing" "fail-closed" "$TMP/missing.err"
grep_cause "refgraph-missing" "reachability" "$TMP/missing.err"

# ── unparseable-output: detector emits garbage → FAIL CLOSED (exit 2) ────────
cat > "$TMP/garbage-refgraph.mjs" <<'EOF'
// A refgraph stub that exits 0 but emits output with no "ALL DEAD-IN-PROD"
// section — the detector-contract-changed / unparseable case.
console.log('total garbage — not a dead-in-prod reachability report');
EOF
set +e
node "$GATE" --src-root "$TMP/src" --refgraph "$TMP/garbage-refgraph.mjs" \
  >/dev/null 2>"$TMP/garbage.err"
garbage_exit=$?
set -e
check "ModuleIntent_RefgraphUnparseable_FailsClosed" 2 "$garbage_exit"
grep_cause "refgraph-unparseable" "fail-closed" "$TMP/garbage.err"
grep_cause "refgraph-unparseable" "could not locate" "$TMP/garbage.err"

echo "check-module-intent self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
