#!/usr/bin/env bash
# Self-test for the fail-closed paths of check-enforcer-wiring.mjs.
#
# The `.test.ts` cases of the gate run only in a path-filtered CI job. This
# script runs in the unfiltered `grep-gates` job.
#
#   - tool-missing: the manifest file does not exist. The gate must exit 1 and
#     name the cause.
#   - unparseable-output: the manifest is not valid JSON. The gate must exit 1
#     and name the parse failure.
#
# The gate runs no external binary. Its input is the manifest, so a missing
# manifest is the tool-missing case.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
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
