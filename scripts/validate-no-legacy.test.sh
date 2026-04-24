#!/usr/bin/env bash
# validate-no-legacy.test.sh — Assertions that obsolete v2.8 install artifacts
# have been removed or archived per docs/plans/2026-04-21-install-rewrite.md.
#
# Each test is prefixed `NoLegacy_*` and asserts a post-rewrite end-state against
# the live repo (not a temp fixture). Tasks 3.1–3.8 append additional
# NoLegacy_* assertions to this file; task 3.11 promotes the harness into a
# CI-gated rollup via scripts/validate-no-legacy.sh.
#
# Task 3.1 phase progression: RED (three assertions added, failing) → GREEN
# (files deleted, assertions pass) → REFACTOR (orphan doc/comment references
# pruned, assertions still green).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0

pass() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "FAIL: $1 — $2"
  FAIL=$((FAIL + 1))
}

assert_file_absent() {
  local name="$1"
  local path="$2"
  if [[ ! -e "$REPO_ROOT/$path" ]]; then
    pass "$name"
  else
    fail "$name" "expected path to be absent: $path"
  fi
}

assert_file_present() {
  local name="$1"
  local path="$2"
  if [[ -f "$REPO_ROOT/$path" ]]; then
    pass "$name"
  else
    fail "$name" "expected file to exist: $path"
  fi
}

echo "## validate-no-legacy.sh Tests"
echo

# ============================================================
# Task 3.1: Delete src/install.ts + src/install.test.ts
# ============================================================

# src/install.ts was the npx-based installer entry point; replaced by the
# binary install path (PR1) + plugin rewrite (PR2).
assert_file_absent \
  "NoLegacy_InstallTsAbsent" \
  "src/install.ts"

# src/install.test.ts covered the deleted installer; delete with its subject.
assert_file_absent \
  "NoLegacy_InstallTestAbsent" \
  "src/install.test.ts"

# Any live code importing './install' (.js or .ts) is a loose reference to the
# deleted module. Scan src/ and servers/ — skip the matching sibling modules
# install-skills and install-hooks, which are unrelated and surviving.
HITS=$(grep -rEn "from ['\"]\.+/install(\.js|\.ts)?['\"]" \
  "$REPO_ROOT/src" "$REPO_ROOT/servers" \
  --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
  2>/dev/null || true)
# Exclude legitimate siblings: install-skills, install-hooks, install-plugin
FILTERED=$(echo "$HITS" | grep -vE "install-skills|install-hooks|install-plugin" || true)
if [[ -z "$FILTERED" ]]; then
  pass "NoLegacy_NoImportsFromInstall"
else
  fail "NoLegacy_NoImportsFromInstall" "found live imports of deleted module: $FILTERED"
fi

# ============================================================
# Task 3.3: Archive deprecation artifacts
# ============================================================

# NoLegacy_CreateExarchosDesign_Archived — create-exarchos design doc must live
# in docs/designs/archive/ (not the active designs directory).
assert_file_present \
  "NoLegacy_CreateExarchosDesign_Archived (archived copy exists)" \
  "docs/designs/archive/2026-03-14-create-exarchos.md"
assert_file_absent \
  "NoLegacy_CreateExarchosDesign_Archived (original removed)" \
  "docs/designs/2026-03-14-create-exarchos.md"

# NoLegacy_ExarchosDevDeprecation_Removed — the exarchos-dev deprecation
# tracking doc must be deleted; the package it tracks is being removed outright
# and its deprecation story is no longer relevant.
assert_file_absent \
  "NoLegacy_ExarchosDevDeprecation_Removed" \
  "docs/deprecation/exarchos-dev.md"

# ============================================================
# Summary
# ============================================================
echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
