#!/usr/bin/env bash
# Self-test for check-type-debt.mjs (task 002, DR-9/DR-10).
#
# This is the ONLY test suite for the gate (no companion `.test.ts`), so it
# has to prove every direction itself: the two FAIL directions, the PASS
# direction, every FAIL-CLOSED provenance path (DR-8/DR-10 — every failure
# names the artifact + reason, never a silent pass), and the exclusion proof.
#
#   - over-budget           — a file's actual cast count exceeds its
#                              baselined budget → FAIL (exit 1).
#   - unbaselined-debt       — a file has casts but no baseline entry → FAIL
#                              (exit 1).
#   - fresh-baseline PASSES  — `--update` on a tree, then checking that SAME
#                              tree against the baseline it just produced →
#                              clean (exit 0). Uses the real repo tree
#                              (whatever it is at test-run time) rather than
#                              the checked-in baseline, so this assertion is
#                              immune to cast-count drift from other in-
#                              flight tasks landing between baseline
#                              generation (this task) and gate wiring (task
#                              007 re-runs `--update` per the spec).
#   - missing baseline       — FAIL CLOSED (exit 2), names the artifact.
#   - unparseable baseline   — FAIL CLOSED (exit 2), names the artifact.
#   - provenance-less        — a baseline with no `censusHash` at all → FAIL
#     baseline                CLOSED (exit 2).
#   - census-hash mismatch   — a baseline generated under a DIFFERENT census
#                              definition → FAIL CLOSED (exit 2).
#   - exclusion proof        — seeded `.d.ts` / `__shims__` / `.bench.ts` /
#                              `evals` files carrying casts are NOT counted:
#                              a tree containing only such files produces an
#                              EMPTY baseline and passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/check-type-debt.mjs"
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

# ── fresh-baseline PASSES: --update the real repo tree, then check it ───────
node "$GATE" --update --baseline "$TMP/fresh-baseline.json" >"$TMP/update.out" 2>&1
set +e
node "$GATE" --baseline "$TMP/fresh-baseline.json" >"$TMP/fresh.out" 2>"$TMP/fresh.err"
fresh_exit=$?
set -e
check "TypeDebt_FreshBaselineOnCurrentTree_Passes" 0 "$fresh_exit"
grep_cause "fresh-baseline" "OK" "$TMP/fresh.out"

# ── over-budget: actual exceeds a recorded budget → FAIL (exit 1) ───────────
mkdir -p "$TMP/over-budget/src"
cat > "$TMP/over-budget/src/foo.ts" <<'EOF'
export const a = 1 as unknown as string;
EOF
node "$GATE" --repo-root "$TMP/over-budget" --update --baseline "$TMP/over-budget/baseline.json" \
  >"$TMP/over-budget/update.out"
# Introduce a second cast WITHOUT re-baselining — actual(2) > budget(1).
cat >> "$TMP/over-budget/src/foo.ts" <<'EOF'
export const b = 2 as unknown as string;
EOF
set +e
node "$GATE" --repo-root "$TMP/over-budget" --baseline "$TMP/over-budget/baseline.json" \
  >"$TMP/over-budget/check.out" 2>"$TMP/over-budget/check.err"
overbudget_exit=$?
set -e
check "TypeDebt_ActualExceedsBudget_Fails" 1 "$overbudget_exit"
grep_cause "over-budget" "over-budget" "$TMP/over-budget/check.err"
grep_cause "over-budget" "src/foo.ts" "$TMP/over-budget/check.err"

# ── unbaselined-debt: a file has casts but no baseline entry → FAIL ─────────
mkdir -p "$TMP/unbaselined/src"
cat > "$TMP/unbaselined/src/keep.ts" <<'EOF'
export const noop = 0;
EOF
node "$GATE" --repo-root "$TMP/unbaselined" --update --baseline "$TMP/unbaselined/baseline.json" \
  >"$TMP/unbaselined/update.out"
cat > "$TMP/unbaselined/src/newdebt.ts" <<'EOF'
export const z = 3 as unknown as string;
EOF
set +e
node "$GATE" --repo-root "$TMP/unbaselined" --baseline "$TMP/unbaselined/baseline.json" \
  >"$TMP/unbaselined/check.out" 2>"$TMP/unbaselined/check.err"
unbaselined_exit=$?
set -e
check "TypeDebt_NewFileWithCastsAbsentFromBaseline_Fails" 1 "$unbaselined_exit"
grep_cause "unbaselined-debt" "unbaselined" "$TMP/unbaselined/check.err"
grep_cause "unbaselined-debt" "src/newdebt.ts" "$TMP/unbaselined/check.err"

# ── missing baseline → FAIL CLOSED (exit 2) ─────────────────────────────────
mkdir -p "$TMP/missing/src"
set +e
node "$GATE" --repo-root "$TMP/missing" --baseline "$TMP/missing/does-not-exist.json" \
  >/dev/null 2>"$TMP/missing.err"
missing_exit=$?
set -e
check "TypeDebt_MissingBaseline_FailsClosed" 2 "$missing_exit"
grep_cause "missing-baseline" "missing baseline" "$TMP/missing.err"
grep_cause "missing-baseline" "does-not-exist.json" "$TMP/missing.err"

# ── unparseable baseline → FAIL CLOSED (exit 2) ─────────────────────────────
mkdir -p "$TMP/garbage/src"
printf 'this is not json {{{\n' > "$TMP/garbage/baseline.json"
set +e
node "$GATE" --repo-root "$TMP/garbage" --baseline "$TMP/garbage/baseline.json" \
  >/dev/null 2>"$TMP/garbage.err"
garbage_exit=$?
set -e
check "TypeDebt_UnparseableBaseline_FailsClosed" 2 "$garbage_exit"
grep_cause "unparseable-baseline" "unparseable baseline" "$TMP/garbage.err"
grep_cause "unparseable-baseline" "baseline.json" "$TMP/garbage.err"

# ── provenance-less baseline (no censusHash at all) → FAIL CLOSED (exit 2) ──
mkdir -p "$TMP/provenanceless/src"
printf '{ "files": {} }\n' > "$TMP/provenanceless/baseline.json"
set +e
node "$GATE" --repo-root "$TMP/provenanceless" --baseline "$TMP/provenanceless/baseline.json" \
  >/dev/null 2>"$TMP/provenanceless.err"
provenanceless_exit=$?
set -e
check "TypeDebt_ProvenancelessBaseline_FailsClosed" 2 "$provenanceless_exit"
grep_cause "provenance-less" "provenance-less" "$TMP/provenanceless.err"

# ── census-hash mismatch → FAIL CLOSED (exit 2) ─────────────────────────────
mkdir -p "$TMP/mismatch/src"
cat > "$TMP/mismatch/baseline.json" <<'EOF'
{
  "version": 1,
  "instrument": "scripts/check-type-debt.mjs",
  "censusHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "generatedAt": "2020-01-01T00:00:00.000Z",
  "generatedVia": "hand-forged for the self-test — a baseline from a DIFFERENT census",
  "files": {}
}
EOF
set +e
node "$GATE" --repo-root "$TMP/mismatch" --baseline "$TMP/mismatch/baseline.json" \
  >/dev/null 2>"$TMP/mismatch.err"
mismatch_exit=$?
set -e
check "TypeDebt_CensusHashMismatch_FailsClosed" 2 "$mismatch_exit"
grep_cause "hash-mismatch" "census-hash mismatch" "$TMP/mismatch.err"
grep_cause "hash-mismatch" "baseline.json" "$TMP/mismatch.err"

# ── unavailable census root (exists but not a directory) → FAIL CLOSED (2) ──
# A configured census root that is PRESENT but unreadable (here `src` is a
# regular file, not a directory) must fail closed, not be silently treated as
# empty — otherwise an I/O fault / path drift would drop an entire source tree
# from enforcement. (A genuinely-absent root — ENOENT — stays tolerated: every
# fixture above lacks `servers/exarchos-mcp/src` and still runs.)
mkdir -p "$TMP/badroot"
printf 'not a directory\n' > "$TMP/badroot/src"
cat > "$TMP/badroot/baseline.json" <<'EOF'
{ "version": 1, "censusHash": "deadbeef", "files": {} }
EOF
set +e
node "$GATE" --repo-root "$TMP/badroot" --baseline "$TMP/badroot/baseline.json" \
  >/dev/null 2>"$TMP/badroot.err"
badroot_exit=$?
set -e
check "TypeDebt_CensusRootNotADirectory_FailsClosed" 2 "$badroot_exit"
grep_cause "badroot" "not a directory" "$TMP/badroot.err"

# ── exclusion proof: seeded .d.ts/__shims__/.bench.ts/evals casts NOT counted ──
mkdir -p "$TMP/excluded/src/__tests__" "$TMP/excluded/src/__shims__" \
  "$TMP/excluded/servers/exarchos-mcp/src/evals"
cat > "$TMP/excluded/src/types.d.ts" <<'EOF'
export const x = 1 as unknown as string;
EOF
cat > "$TMP/excluded/src/foo.bench.ts" <<'EOF'
export const x = 1 as unknown as string;
EOF
cat > "$TMP/excluded/src/__tests__/helper.test.ts" <<'EOF'
export const x = 1 as unknown as string;
EOF
cat > "$TMP/excluded/src/__shims__/shim.ts" <<'EOF'
export const x = 1 as unknown as string;
EOF
cat > "$TMP/excluded/servers/exarchos-mcp/src/evals/harness.ts" <<'EOF'
export const x = 1 as unknown as string;
EOF
# Every seeded file carries a cast, but every one is excluded by the census —
# a fresh --update over this tree must therefore capture ZERO files.
node "$GATE" --repo-root "$TMP/excluded" --update --baseline "$TMP/excluded/baseline.json" \
  >"$TMP/excluded/update.out"
if grep -Eq '"files":[[:space:]]*\{\}' "$TMP/excluded/baseline.json"; then
  echo "  ok: TypeDebt_ExcludedFilesWithCasts_NotCounted baseline captured zero files"
  pass=$((pass + 1))
else
  echo "  FAIL: TypeDebt_ExcludedFilesWithCasts_NotCounted expected an empty files map"
  cat "$TMP/excluded/baseline.json"
  fail=$((fail + 1))
fi
set +e
node "$GATE" --repo-root "$TMP/excluded" --baseline "$TMP/excluded/baseline.json" \
  >"$TMP/excluded/check.out" 2>"$TMP/excluded/check.err"
excluded_exit=$?
set -e
check "TypeDebt_ExcludedFilesWithCasts_TreePasses" 0 "$excluded_exit"

echo "check-type-debt self-test: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
