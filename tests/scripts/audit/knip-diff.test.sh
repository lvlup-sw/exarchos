#!/usr/bin/env bash
# Self-test for the fail-closed paths of knip-diff.ts.
#
# The `.test.ts` cases of the gate run only in a path-filtered CI job. This
# script runs in the unfiltered `grep-gates` job. It drives the real CLI and
# sets EXARCHOS_KNIP_BIN, so it does not uninstall knip.
#
#   - tool-missing: the binary path does not exist. The gate must exit 2 and
#     name "tool-missing".
#   - unparseable-output: a stub prints text that is not JSON. The gate must
#     exit 2 and name "unparseable-output".
#   - vacuous-exemption: a stub prints a valid report with no issues. The
#     inverted reading then finds no symbol that the `@proof` exemption matches.
#     The gate must exit 2 and name "vacuous-exemption". It must not print "OK:".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../tools/audit" && pwd)"
GATE="$SCRIPT_DIR/knip-diff.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A stub binary that exits 0 and writes text that is not JSON to stdout.
cat > "$TMP/garbage-bin.sh" <<'EOF'
#!/usr/bin/env bash
echo "garbage — not a knip JSON report"
EOF
chmod +x "$TMP/garbage-bin.sh"

# A stub that prints a valid report with no issues, as when knip resolves no files.
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
