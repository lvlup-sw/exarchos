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
# Task 3.4: Strip bundled-MCP companion references from
# distribution-surface docs (README.md, AGENTS.md, CHANGELOG.md)
# ============================================================
#
# Historically, create-exarchos bundled serena/context7/microsoft-learn as
# "optional companions." That package is gone (task 3.2), so the marketing
# claim is stale. These assertions gate top-level docs:
# - README.md: must not name serena / context7 / microsoft-learn at all
#   (they should be fully removed from distribution surface). `graphite` is
#   permitted only as external-tool context, NOT as a bundled companion.
# - AGENTS.md: same rule as README (path-like `.serena/` ignore-list entries
#   are tolerated — see guard below).
# - CHANGELOG.md: unreleased section must not contain companion-install
#   claims. Historical release entries are preserved verbatim (they describe
#   what actually shipped) — we only lint the [Unreleased] section.

# NoLegacy_ReadmeHasNoBundledMcp — README must not advertise the three
# companion MCP servers (serena, context7, microsoft-learn) anywhere.
# Rationale for the zero-tolerance scoping: the fallback rule in the task
# brief. `graphite` is matched separately below with a softer rule.
README_BUNDLED_HITS=$(grep -inE "serena|context7|microsoft-learn|microsoft learn" \
  "$REPO_ROOT/README.md" 2>/dev/null || true)
if [[ -z "$README_BUNDLED_HITS" ]]; then
  pass "NoLegacy_ReadmeHasNoBundledMcp"
else
  fail "NoLegacy_ReadmeHasNoBundledMcp" \
    "README.md mentions removed bundled-MCP companions: $README_BUNDLED_HITS"
fi

# NoLegacy_ReadmeHasNoCreateExarchos — `create-exarchos` was the bundling
# vehicle (task 3.2 deleted it). Any mention in README is stale.
README_CE_HITS=$(grep -inE "create-exarchos" "$REPO_ROOT/README.md" 2>/dev/null || true)
if [[ -z "$README_CE_HITS" ]]; then
  pass "NoLegacy_ReadmeHasNoCreateExarchos"
else
  fail "NoLegacy_ReadmeHasNoCreateExarchos" \
    "README.md references deleted create-exarchos package: $README_CE_HITS"
fi

# NoLegacy_AgentsMdHasNoBundledMcp — AGENTS.md may mention `.serena/` as an
# ignore-path entry (directory name, not a product claim). Strip that line
# before matching so a legitimate scan-config entry doesn't trip the gate.
if [[ -f "$REPO_ROOT/AGENTS.md" ]]; then
  AGENTS_BUNDLED_HITS=$(grep -inE "serena|context7|microsoft-learn|microsoft learn" \
    "$REPO_ROOT/AGENTS.md" 2>/dev/null \
    | grep -vE "\.serena/" \
    || true)
  if [[ -z "$AGENTS_BUNDLED_HITS" ]]; then
    pass "NoLegacy_AgentsMdHasNoBundledMcp"
  else
    fail "NoLegacy_AgentsMdHasNoBundledMcp" \
      "AGENTS.md mentions removed bundled-MCP companions: $AGENTS_BUNDLED_HITS"
  fi
else
  pass "NoLegacy_AgentsMdHasNoBundledMcp (file absent — vacuous pass)"
fi

# NoLegacy_ChangelogHasNoCompanionClaims — lint ONLY the [Unreleased] section
# of CHANGELOG.md. Historical release entries are frozen record of what
# shipped (including `Remove Graphite integration (#933)` — historically
# accurate) and must not be rewritten.
if [[ -f "$REPO_ROOT/CHANGELOG.md" ]]; then
  # Extract the [Unreleased] section: from `## [Unreleased]` to the next `## [`
  UNRELEASED=$(awk '
    /^## \[Unreleased\]/ { capturing = 1; next }
    /^## \[/ && capturing { exit }
    capturing { print }
  ' "$REPO_ROOT/CHANGELOG.md")
  # Look for "install companion", "bundled MCP", "installs X alongside" where
  # X is one of the four companion tools.
  CHANGELOG_HITS=$(echo "$UNRELEASED" | grep -inE \
    "install(s|ing)? (companion|alongside|bundled)|bundled.mcp|optional companion|companion.mcp" \
    || true)
  if [[ -z "$CHANGELOG_HITS" ]]; then
    pass "NoLegacy_ChangelogHasNoCompanionClaims"
  else
    fail "NoLegacy_ChangelogHasNoCompanionClaims" \
      "CHANGELOG.md [Unreleased] contains companion-install claim: $CHANGELOG_HITS"
  fi
else
  fail "NoLegacy_ChangelogHasNoCompanionClaims" \
    "CHANGELOG.md missing — expected file to exist"
fi

# ============================================================
# Task 3.8: Delete dead servers/exarchos-mcp/src/cli.ts + orphans
# ============================================================

# NoLegacy_DeadCliFileAbsent — the MCP server's stdin-JSON cli.ts entry point
# was never wired to the shipping binary (hooks invoke the unified `exarchos`
# binary bundled from src/index.ts). It must be deleted.
assert_file_absent \
  "NoLegacy_DeadCliFileAbsent" \
  "servers/exarchos-mcp/src/cli.ts"

# NoLegacy_DeadCliTestAbsent — the co-located test for the deleted cli.ts
# must be removed alongside its subject.
assert_file_absent \
  "NoLegacy_DeadCliTestAbsent" \
  "servers/exarchos-mcp/src/cli.test.ts"

# NoLegacy_OrphanedCliCommandsAbsent — handler modules in cli-commands/ that
# were ONLY consumed by the deleted cli.ts (subagent-stop, eval-run,
# eval-capture, eval-compare, eval-calibrate, quality-check) must be deleted.
# Live handlers (pre-compact, session-start, session-end, guard, gates,
# subagent-context, assemble-context, version) stay — they are consumed by
# adapters/hooks.ts or adapters/cli.ts.
for orphan in subagent-stop eval-run eval-capture eval-compare eval-calibrate quality-check; do
  assert_file_absent \
    "NoLegacy_OrphanedCliCommandsAbsent ($orphan.ts)" \
    "servers/exarchos-mcp/src/cli-commands/$orphan.ts"
  assert_file_absent \
    "NoLegacy_OrphanedCliCommandsAbsent ($orphan.test.ts)" \
    "servers/exarchos-mcp/src/cli-commands/$orphan.test.ts"
done

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
