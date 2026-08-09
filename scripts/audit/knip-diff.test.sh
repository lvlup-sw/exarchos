#!/usr/bin/env bash
# Self-test for knip-diff.ts (task 012, DR-6/DR-8).
#
# DR-8 requires every gate's FAIL-CLOSED paths to be proven in an UNFILTERED CI
# host. The gate's own `.test.ts` cases run in the path-filtered `test-root`
# job (its filter excludes `scripts/**`), so a scripts-only PR skips them. This
# `.test.sh` re-asserts the two DR-8 fail-closed conditions in the UNFILTERED
# `grep-gates` job (task 015), driving the REAL CLI (`defaultRunKnip`) via its
# EXARCHOS_KNIP_BIN testability seam — no need to uninstall knip:
#
#   - tool-missing       — the knip binary path is absent: spawn fails →
#                          found:false → the gate FAILS CLOSED (exit 2) naming
#                          "tool-missing".
#   - unparseable-output — knip (stubbed) emits garbage instead of JSON: the
#                          gate FAILS CLOSED (exit 2) naming "unparseable-output".
#   - vacuous-exemption  — knip (stubbed) emits a well-formed but EMPTY report,
#                          i.e. it resolved nothing. Both the gate reading and the
#                          inverted denominator reading come back empty, so the
#                          `@proof` exemption cannot be shown to match anything.
#                          The gate FAILS CLOSED (exit 2) rather than printing
#                          "0 findings, OK" — the DR-24 non-empty-denominator
#                          requirement, proven end-to-end through the real CLI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/knip-diff.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A stub "binary" that exits 0 but writes non-JSON garbage to stdout.
cat > "$TMP/garbage-bin.sh" <<'EOF'
#!/usr/bin/env bash
echo "garbage — not a knip JSON report"
EOF
chmod +x "$TMP/garbage-bin.sh"

# A stub that emits a VALID but empty report — a knip that resolved no files.
cat > "$TMP/empty-bin.sh" <<'EOF'
#!/usr/bin/env bash
echo '{"issues":[]}'
EOF
chmod +x "$TMP/empty-bin.sh"

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

# ── tool-missing: knip binary absent → FAIL CLOSED (exit 2) ──────────────────
set +e
EXARCHOS_KNIP_BIN="$TMP/no-such-knip" npx --no-install tsx "$GATE" \
  >/dev/null 2>"$TMP/missing.err"
missing_exit=$?
set -e
check "KnipDiff_ToolMissing_FailsClosed" 2 "$missing_exit"
grep_cause "tool-missing" "tool-missing" "$TMP/missing.err"

# ── unparseable-output: knip emits garbage → FAIL CLOSED (exit 2) ────────────
set +e
EXARCHOS_KNIP_BIN="$TMP/garbage-bin.sh" npx --no-install tsx "$GATE" \
  >/dev/null 2>"$TMP/garbage.err"
garbage_exit=$?
set -e
check "KnipDiff_UnparseableOutput_FailsClosed" 2 "$garbage_exit"
grep_cause "unparseable-output" "unparseable-output" "$TMP/garbage.err"

# ── vacuous-exemption: knip resolved nothing → FAIL CLOSED (exit 2), NOT "OK" ─
set +e
EXARCHOS_KNIP_BIN="$TMP/empty-bin.sh" npx --no-install tsx "$GATE" \
  >"$TMP/empty.out" 2>"$TMP/empty.err"
empty_exit=$?
set -e
check "KnipDiff_ZeroResolvedFiles_FailsClosedNotClean" 2 "$empty_exit"
grep_cause "vacuous-exemption" "vacuous-exemption" "$TMP/empty.err"
if grep -q "OK:" "$TMP/empty.out"; then
  echo "  FAIL: gate reported OK on a knip run that resolved nothing"; fail=$((fail + 1));
else
  echo "  ok: KnipDiff_ZeroResolvedFiles_DoesNotReportClean"; pass=$((pass + 1));
fi

echo "knip-diff self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
