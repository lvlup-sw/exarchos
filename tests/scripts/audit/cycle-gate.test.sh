#!/usr/bin/env bash
# Self-test for the fail-closed paths of cycle-gate.ts.
#
# The `.test.ts` cases of the gate run only in path-filtered CI jobs. This
# script runs in the unfiltered `grep-gates` job. It drives the real CLI and
# sets EXARCHOS_DEPCRUISE_BIN, so it does not need to uninstall
# dependency-cruiser.
#
#   - tool-missing: the binary path does not exist. The gate must exit 2 and
#     name "tool-missing".
#   - unparseable-output: a stub prints text that is not a JSON graph. The gate
#     must exit 2 and name "unparseable-output".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../tools/audit" && pwd)"
GATE="$SCRIPT_DIR/cycle-gate.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A stub binary that exits 0 and writes text that is not JSON to stdout.
cat > "$TMP/garbage-bin.sh" <<'EOF'
#!/usr/bin/env bash
echo "garbage — not a dependency-cruiser JSON graph"
EOF
chmod +x "$TMP/garbage-bin.sh"

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

# ── tool-missing: depcruise binary absent → FAIL CLOSED (exit 2) ─────────────
set +e
EXARCHOS_DEPCRUISE_BIN="$TMP/no-such-depcruise" npx --no-install tsx "$GATE" \
  >/dev/null 2>"$TMP/missing.err"
missing_exit=$?
set -e
check "CycleGate_ToolMissing_FailsClosed" 2 "$missing_exit"
grep_cause "tool-missing" "tool-missing" "$TMP/missing.err"

# ── unparseable-output: depcruise emits garbage → FAIL CLOSED (exit 2) ───────
set +e
EXARCHOS_DEPCRUISE_BIN="$TMP/garbage-bin.sh" npx --no-install tsx "$GATE" \
  >/dev/null 2>"$TMP/garbage.err"
garbage_exit=$?
set -e
check "CycleGate_UnparseableOutput_FailsClosed" 2 "$garbage_exit"
grep_cause "unparseable-output" "unparseable-output" "$TMP/garbage.err"

echo "cycle-gate self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
