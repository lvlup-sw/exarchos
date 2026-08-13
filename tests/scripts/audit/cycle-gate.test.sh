#!/usr/bin/env bash
# Self-test for cycle-gate.ts (task 010, DR-4/DR-8).
#
# DR-8 requires every gate's FAIL-CLOSED paths to be proven in an UNFILTERED CI
# host. The gate's own `.test.ts` cases run in the path-filtered `test-root`
# job (its filter excludes `scripts/**`), so a scripts-only PR skips them. This
# `.test.sh` re-asserts the two DR-8 fail-closed conditions in the UNFILTERED
# `grep-gates` job (task 015), driving the REAL CLI (`defaultRunDepcruise`) via
# its EXARCHOS_DEPCRUISE_BIN testability seam — no need to uninstall depcruise:
#
#   - tool-missing       — the dependency-cruiser binary path is absent: spawn
#                          fails → found:false → the gate FAILS CLOSED (exit 2)
#                          naming "tool-missing".
#   - unparseable-output — depcruise (stubbed) emits garbage instead of a JSON
#                          graph: the gate FAILS CLOSED (exit 2) naming
#                          "unparseable-output".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/audit" && pwd)"
GATE="$SCRIPT_DIR/cycle-gate.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A stub "binary" that exits 0 but writes non-JSON garbage to stdout.
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
