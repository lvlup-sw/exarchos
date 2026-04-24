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
# Task 3.7: Audit scripts/sync-marketplace.sh for dual-plugin references
# ============================================================
#
# sync-marketplace.sh was audited in the v2.9 install rewrite. Disposition:
# KEEP — the script is general single-plugin marketplace syncing against
# $HOME/.claude/plugins/marketplaces/lvlup-sw, invoked by /release and
# `/release --check`. It filters specifically on `name=="exarchos"` in the
# marketplace manifest and never referenced `create-exarchos` or any
# dual-plugin model (verified at audit time).
#
# The invariant going forward: the script must either
#   (a) not exist, or
#   (b) exist with zero references to `create-exarchos` or `dual-plugin`.
SYNC_MKT_PATH="$REPO_ROOT/scripts/sync-marketplace.sh"
if [[ ! -e "$SYNC_MKT_PATH" ]]; then
  pass "NoLegacy_SyncMarketplaceAbsentOrUpdated (script absent)"
else
  SYNC_MKT_HITS=$(grep -inE "create-exarchos|dual.?plugin" "$SYNC_MKT_PATH" 2>/dev/null || true)
  if [[ -z "$SYNC_MKT_HITS" ]]; then
    pass "NoLegacy_SyncMarketplaceAbsentOrUpdated (no dual-plugin refs)"
  else
    fail "NoLegacy_SyncMarketplaceAbsentOrUpdated" \
      "scripts/sync-marketplace.sh references deleted dual-plugin model: $SYNC_MKT_HITS"
  fi
fi

# ============================================================
# Task 3.6: Remove dist/exarchos.js JS bundle emission
# ============================================================
#
# After PR2 rewired plugin.json and hooks.json to invoke the bare `exarchos`
# PATH-resolved binary, the legacy `dist/exarchos.js` JS bundle is no longer
# consumed by anything. Task 3.6 deletes its emission from the build
# pipeline. These assertions pin that end-state so the dead path cannot
# return.

# NoLegacy_BuildBundleScriptAbsent — `scripts/build-bundle.ts` was the sole
# emitter of `dist/exarchos.js`. Delete the script entirely; the build now
# calls `scripts/build-binary.ts` for compile-to-executable output.
assert_file_absent \
  "NoLegacy_BuildBundleScriptAbsent" \
  "scripts/build-bundle.ts"

# NoLegacy_BuildBundleTestAbsent — the co-located test for the deleted
# `build-bundle.ts` (task 1.3 guard against legacy platform-variant wiring)
# must be removed alongside its subject.
assert_file_absent \
  "NoLegacy_BuildBundleTestAbsent" \
  "scripts/build-bundle.test.ts"

# NoLegacy_BuildScriptDoesNotRunBuildBundle — root `package.json` must not
# invoke `build-bundle` from the top-level `build` script or declare a
# `build:bundle` alias. The post-rewrite build chain is
# `tsc && npm run build:binary && npm run build:skills`.
if [[ -f "$REPO_ROOT/package.json" ]]; then
  BUILD_BUNDLE_HITS=$(grep -nE '"build":[^,]*build-bundle|"build":[^,]*build:bundle|"build:bundle"' \
    "$REPO_ROOT/package.json" 2>/dev/null || true)
  if [[ -z "$BUILD_BUNDLE_HITS" ]]; then
    pass "NoLegacy_BuildScriptDoesNotRunBuildBundle"
  else
    fail "NoLegacy_BuildScriptDoesNotRunBuildBundle" \
      "package.json still wires build-bundle into the build pipeline: $BUILD_BUNDLE_HITS"
  fi
else
  fail "NoLegacy_BuildScriptDoesNotRunBuildBundle" \
    "package.json missing — expected file to exist"
fi

# NoLegacy_PackageJsonFilesHasNoJsBundle — the `files` array (npm publish
# whitelist) must not list `dist/exarchos.js`. The JS bundle is no longer
# emitted; shipping a stale path would confuse consumers at pack time.
if [[ -f "$REPO_ROOT/package.json" ]]; then
  FILES_JS_BUNDLE_HITS=$(grep -nE '"dist/exarchos\.js"' \
    "$REPO_ROOT/package.json" 2>/dev/null || true)
  if [[ -z "$FILES_JS_BUNDLE_HITS" ]]; then
    pass "NoLegacy_PackageJsonFilesHasNoJsBundle"
  else
    fail "NoLegacy_PackageJsonFilesHasNoJsBundle" \
      "package.json 'files' array still lists dist/exarchos.js: $FILES_JS_BUNDLE_HITS"
  fi
else
  fail "NoLegacy_PackageJsonFilesHasNoJsBundle" \
    "package.json missing — expected file to exist"
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
# Task 3.11: Rollup runner + knip dead-code sweep + CI wiring
# ============================================================
#
# Task 3.11 promotes the NoLegacy_* assertion suite into a CI-gated rollup
# runner (scripts/validate-no-legacy.sh) that also invokes `knip` for
# unreachable-export detection, and wires a `validate-no-legacy` job into
# .github/workflows/ci.yml. These assertions pin that end-state.

# NoLegacy_RollupScriptExists — the rollup runner must exist and be
# executable. `validate-no-legacy.sh` is the single entry point CI calls;
# it wraps this assertion suite plus the knip sweep.
ROLLUP_PATH="$REPO_ROOT/scripts/validate-no-legacy.sh"
if [[ -f "$ROLLUP_PATH" && -x "$ROLLUP_PATH" ]]; then
  pass "NoLegacy_RollupScriptExists"
else
  if [[ ! -f "$ROLLUP_PATH" ]]; then
    fail "NoLegacy_RollupScriptExists" "rollup script missing: scripts/validate-no-legacy.sh"
  else
    fail "NoLegacy_RollupScriptExists" "rollup script exists but is not executable: scripts/validate-no-legacy.sh"
  fi
fi

# NoLegacy_CIWorkflowHasValidateJob — .github/workflows/ci.yml must declare
# a `validate-no-legacy` job so the rollup runs on every PR. Match is
# loose-but-safe: a top-level job ID under `jobs:` whose key is
# `validate-no-legacy`.
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"
if [[ -f "$CI_YML" ]]; then
  # Job keys in our workflow are indented 2 spaces under `jobs:`.
  if grep -qE "^  validate-no-legacy:" "$CI_YML"; then
    pass "NoLegacy_CIWorkflowHasValidateJob"
  else
    fail "NoLegacy_CIWorkflowHasValidateJob" \
      ".github/workflows/ci.yml missing a 'validate-no-legacy' job"
  fi
else
  fail "NoLegacy_CIWorkflowHasValidateJob" ".github/workflows/ci.yml missing"
fi

# NoLegacy_KnipConfigExists — a knip config must exist at the repo root so
# the dead-code sweep is reproducible and its entry-point allowlist is
# auditable. Accept any of the supported locations.
KNIP_JSON="$REPO_ROOT/knip.json"
KNIP_JSONC="$REPO_ROOT/knip.jsonc"
KNIP_TS="$REPO_ROOT/knip.ts"
KNIP_IN_PKG=""
if [[ -f "$REPO_ROOT/package.json" ]]; then
  # Only treat as a knip config if the value is a `{` — a bare
  # `"knip": "^6.x"` in devDependencies is a version string, not a config.
  KNIP_IN_PKG=$(grep -E '"knip"[[:space:]]*:[[:space:]]*\{' "$REPO_ROOT/package.json" 2>/dev/null || true)
fi
if [[ -f "$KNIP_JSON" || -f "$KNIP_JSONC" || -f "$KNIP_TS" || -n "$KNIP_IN_PKG" ]]; then
  # Sanity: if knip.json is used, assert it lists at least the two key
  # entry modules so the allowlist is not empty/degenerate.
  if [[ -f "$KNIP_JSON" ]]; then
    MISSING=""
    for needed in "servers/exarchos-mcp/src/index.ts" "src/build-skills.ts" "src/install-skills.ts"; do
      if ! grep -qF "$needed" "$KNIP_JSON"; then
        MISSING="$MISSING $needed"
      fi
    done
    if [[ -z "$MISSING" ]]; then
      pass "NoLegacy_KnipConfigExists"
    else
      fail "NoLegacy_KnipConfigExists" \
        "knip.json missing required entry-point allowlist entries:$MISSING"
    fi
  else
    pass "NoLegacy_KnipConfigExists (non-JSON config)"
  fi
else
  fail "NoLegacy_KnipConfigExists" \
    "no knip config at knip.json / knip.jsonc / knip.ts / package.json#knip"
fi

# NoLegacy_DeadCodeSweep — run knip (when available) and assert it exits
# clean. If the knip binary is not installed, the assertion conditionally
# skips — CI always has the binary after `npm ci`, so this only yields on
# bare-metal runs without the devDep.
KNIP_BIN="$REPO_ROOT/node_modules/.bin/knip"
if [[ -x "$KNIP_BIN" ]]; then
  set +e
  KNIP_OUT=$("$KNIP_BIN" --no-progress 2>&1)
  KNIP_RC=$?
  set -e
  if [[ "$KNIP_RC" -eq 0 ]]; then
    pass "NoLegacy_DeadCodeSweep"
  else
    fail "NoLegacy_DeadCodeSweep" "knip reported issues (rc=$KNIP_RC); see full output above"
    echo "$KNIP_OUT" | sed 's/^/  knip: /' >&2
  fi
else
  pass "NoLegacy_DeadCodeSweep (knip binary absent — skipped)"
fi

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
