#!/usr/bin/env bash
# Self-test for check-module-intent.mjs (task 013, DR-7/DR-8).
#
# DR-8 requires every gate's FAIL-CLOSED paths to be proven in an UNFILTERED CI
# host. The gate's own `.test.ts` cases run in the path-filtered `test-root`
# job (its filter excludes `scripts/**`), so a scripts-only PR skips them. This
# `.test.sh` re-asserts the two DR-8 fail-closed conditions in the UNFILTERED
# `grep-gates` job (task 015), driving the real CLI via its `--refgraph`
# testability seam:
#
#   - tool-missing       — the reachability detector (refgraph) is absent:
#                          `node <missing>` exits non-zero → the gate FAILS
#                          CLOSED (exit 2) naming a fail-closed scan error.
#   - unparseable-output — the detector emits garbage (no "ALL DEAD-IN-PROD"
#                          section): the gate FAILS CLOSED (exit 2) naming the
#                          missing section, not passing on partial evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/check-module-intent.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A real, existing src-root (content irrelevant — the detector is stubbed/absent,
# so the scan fails before any module is read). statSync only needs a directory.
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
