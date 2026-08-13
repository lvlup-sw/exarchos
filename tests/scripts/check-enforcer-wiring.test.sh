#!/usr/bin/env bash
# Self-test for check-enforcer-wiring.mjs (task 011, DR-5/DR-8).
#
# DR-8 requires every gate's FAIL-CLOSED paths to be proven in an UNFILTERED CI
# host. The gate's own `.test.ts` cases run in the path-filtered `test-root`
# job (its filter excludes `scripts/**`), so a scripts-only PR skips them. This
# `.test.sh` re-asserts the two DR-8 fail-closed conditions in the UNFILTERED
# `grep-gates` job (task 015):
#
#   - tool-missing       — the manifest (the gate's essential input) is absent:
#                          the gate must FAIL (exit 1) with a cause-naming
#                          diagnostic, not silently pass on missing evidence.
#   - unparseable-output — the manifest is present but not valid JSON: the gate
#                          must FAIL (exit 1) naming the parse failure.
#
# check-enforcer-wiring is a pure-analysis gate (no external binary); its
# "tool" is the manifest / package.json inputs, so tool-missing ≙ input-missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
GATE="$SCRIPT_DIR/check-enforcer-wiring.mjs"
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
  else echo "  FAIL: $1 did not name cause '$2'"; cat "$3"; fail=$((fail + 1)); fi
}

# ── tool-missing: manifest absent → FAIL CLOSED (exit 1), cause-named ────────
set +e
node "$GATE" --manifest "$TMP/does-not-exist.json" >/dev/null 2>"$TMP/missing.err"
missing_exit=$?
set -e
check "EnforcerWiring_ManifestMissing_FailsClosed" 1 "$missing_exit"
grep_cause "manifest-missing" "cannot read/parse manifest" "$TMP/missing.err"
grep_cause "manifest-missing" "ENOENT" "$TMP/missing.err"

# ── unparseable-output: manifest is garbage → FAIL CLOSED (exit 1) ───────────
printf 'this is not json {{{\n' > "$TMP/garbage-manifest.json"
set +e
node "$GATE" --manifest "$TMP/garbage-manifest.json" >/dev/null 2>"$TMP/garbage.err"
garbage_exit=$?
set -e
check "EnforcerWiring_ManifestUnparseable_FailsClosed" 1 "$garbage_exit"
grep_cause "manifest-unparseable" "cannot read/parse manifest" "$TMP/garbage.err"
grep_cause "manifest-unparseable" "is not valid JSON" "$TMP/garbage.err"

echo "check-enforcer-wiring self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
