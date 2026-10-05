#!/usr/bin/env bash
# validate-no-legacy.test.sh: assertions that the obsolete v2.8 install
# artifacts stay out of the repo.
#
# Each `NoLegacy_*` test asserts an end state of the live repo, not of a temp
# fixture. The rollup tools/audit/gates/validate-no-legacy.sh runs this file in
# CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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
# src/install.ts and src/install.test.ts are absent
# ============================================================

# The npx-based installer entry point src/install.ts must stay deleted.
assert_file_absent \
  "NoLegacy_InstallTsAbsent" \
  "src/install.ts"

# The test of that installer must stay deleted too.
assert_file_absent \
  "NoLegacy_InstallTestAbsent" \
  "src/install.test.ts"

# A relative `./install` import is a violation only when it is dangling: its
# `.ts` source does not exist, as with the deleted `src/install.ts`. An import
# that resolves to a real module is legal, and `src/verbs/onboard/install.ts`
# is such a module. Thus the guard resolves each hit and fails only on an
# import with no source file.
#
# The match is anchored: `.js`, `.ts` or the closing quote must follow
# `install`. Thus `install-skills`, `install-hooks` and `install-plugin` do not
# match.
RAW_HITS=$(grep -rEn "from ['\"]\.+/install(\.js|\.ts)?['\"]" \
  "$REPO_ROOT/src" "$REPO_ROOT/servers" \
  --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
  2>/dev/null || true)

DANGLING=""
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  importer="${hit%%:*}"
  # The relative specifier after `from`, without its extension. A NodeNext
  # specifier ends in `.js` or has no extension, and the source file ends in `.ts`.
  spec=$(printf '%s\n' "$hit" | sed -E "s/.*from ['\"](\.+\/install)(\.js|\.ts)?['\"].*/\1/")
  # Parse guard: a captured specifier starts with a dot. If sed captures
  # nothing, the line stays unchanged and starts with the importer path. The
  # loop then counts the hit as dangling.
  if [[ "$spec" != .* ]]; then
    DANGLING="${DANGLING}${hit}\n"
    continue
  fi
  resolved=$(cd "$(dirname "$importer")" 2>/dev/null && realpath -m "$spec" 2>/dev/null || true)
  if [[ -z "$resolved" || ( ! -f "${resolved}.ts" && ! -f "${resolved}/index.ts" ) ]]; then
    DANGLING="${DANGLING}${hit}\n"
  fi
done <<< "$RAW_HITS"

if [[ -z "$DANGLING" ]]; then
  pass "NoLegacy_NoImportsFromInstall"
else
  fail "NoLegacy_NoImportsFromInstall" "found live imports of deleted module: $(printf '%b' "$DANGLING")"
fi

# ============================================================
# Deprecation artifacts are archived or deleted
# ============================================================

# NoLegacy_CreateExarchosDesign_Archived: the create-exarchos design doc must be
# in the archive directory of the designs, not in the active directory. The
# archive is part of the mounted docs corpus. On a checkout with no mount, the
# test can check only that the original is absent.
if [[ -d "$REPO_ROOT/docs/designs" || -d "$REPO_ROOT/docs/designs/archive" ]]; then
  assert_file_present \
    "NoLegacy_CreateExarchosDesign_Archived (archived copy exists)" \
    "docs/designs/archive/2026-03-14-create-exarchos.md"
else
  pass "NoLegacy_CreateExarchosDesign_Archived (archived copy exists) — skipped, docs corpus unmounted"
fi
assert_file_absent \
  "NoLegacy_CreateExarchosDesign_Archived (original removed)" \
  "docs/designs/2026-03-14-create-exarchos.md"

# NoLegacy_ExarchosDevDeprecation_Removed: the deprecation tracking doc of
# exarchos-dev must stay deleted.
assert_file_absent \
  "NoLegacy_ExarchosDevDeprecation_Removed" \
  "docs/deprecation/exarchos-dev.md"

# ============================================================
# Distribution-surface docs (README.md, AGENTS.md, CHANGELOG.md) name no
# bundled-MCP companion
# ============================================================
#
# The create-exarchos package bundled serena, context7 and microsoft-learn as
# "optional companions". The package does not exist, so that claim is stale.
# - README.md: must not name serena, context7 or microsoft-learn.
# - AGENTS.md: the same rule. A `.serena/` ignore-path entry is legal.
# - CHANGELOG.md: the [Unreleased] section must hold no companion-install
#   claim. The test does not read the released entries.

# If README.md is absent, `|| true` hides the grep failure and both checks
# below pass on nothing. Thus an absent README.md fails both checks here.
if [[ ! -f "$REPO_ROOT/README.md" ]]; then
  fail "NoLegacy_ReadmeHasNoBundledMcp" "README.md missing — expected file to exist"
  fail "NoLegacy_ReadmeHasNoCreateExarchos" "README.md missing — expected file to exist"
else
  # NoLegacy_ReadmeHasNoBundledMcp: README.md must not name the three
  # companion MCP servers (serena, context7, microsoft-learn).
  README_BUNDLED_HITS=$(grep -inE "serena|context7|microsoft-learn|microsoft learn" \
    "$REPO_ROOT/README.md" 2>/dev/null || true)
  if [[ -z "$README_BUNDLED_HITS" ]]; then
    pass "NoLegacy_ReadmeHasNoBundledMcp"
  else
    fail "NoLegacy_ReadmeHasNoBundledMcp" \
      "README.md mentions removed bundled-MCP companions: $README_BUNDLED_HITS"
  fi

  # NoLegacy_ReadmeHasNoCreateExarchos: the `create-exarchos` package does not
  # exist, so each mention in README.md is stale.
  README_CE_HITS=$(grep -inE "create-exarchos" "$REPO_ROOT/README.md" 2>/dev/null || true)
  if [[ -z "$README_CE_HITS" ]]; then
    pass "NoLegacy_ReadmeHasNoCreateExarchos"
  else
    fail "NoLegacy_ReadmeHasNoCreateExarchos" \
      "README.md references deleted create-exarchos package: $README_CE_HITS"
  fi
fi

# NoLegacy_AgentsMdHasNoBundledMcp: AGENTS.md can name `.serena/` as an
# ignore-path entry, which is a directory name and not a product claim. The
# test drops each line with `.serena/` from the hits.
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

# NoLegacy_ChangelogHasNoCompanionClaims: the test reads only the [Unreleased]
# section of CHANGELOG.md. The released entries record what shipped, and they
# must stay as they are.
if [[ -f "$REPO_ROOT/CHANGELOG.md" ]]; then
  # Extract the [Unreleased] section: from `## [Unreleased]` to the next `## [`
  UNRELEASED=$(awk '
    /^## \[Unreleased\]/ { capturing = 1; next }
    /^## \[/ && capturing { exit }
    capturing { print }
  ' "$REPO_ROOT/CHANGELOG.md")
  # Look for a companion-install claim, such as "install companion",
  # "bundled MCP" or "optional companion".
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
# tools/release/sync-marketplace.sh holds no dual-plugin reference
# ============================================================
#
# The script must either
#   (a) not exist, or
#   (b) exist with zero references to `create-exarchos` or `dual-plugin`.
SYNC_MKT_PATH="$REPO_ROOT/tools/release/sync-marketplace.sh"
if [[ ! -e "$SYNC_MKT_PATH" ]]; then
  pass "NoLegacy_SyncMarketplaceAbsentOrUpdated (script absent)"
else
  SYNC_MKT_HITS=$(grep -inE "create-exarchos|dual.?plugin" "$SYNC_MKT_PATH" 2>/dev/null || true)
  if [[ -z "$SYNC_MKT_HITS" ]]; then
    pass "NoLegacy_SyncMarketplaceAbsentOrUpdated (no dual-plugin refs)"
  else
    fail "NoLegacy_SyncMarketplaceAbsentOrUpdated" \
      "tools/release/sync-marketplace.sh references deleted dual-plugin model: $SYNC_MKT_HITS"
  fi
fi

# ============================================================
# The build emits no dist/exarchos.js JS bundle
# ============================================================
#
# plugin.json and hooks.json invoke the bare `exarchos` binary from PATH, so
# nothing consumes a `dist/exarchos.js` bundle. These assertions keep the
# emission of that bundle out of the build pipeline.

# NoLegacy_BuildBundleScriptAbsent: `scripts/build-bundle.ts`, the only emitter
# of `dist/exarchos.js`, must stay deleted. The build calls
# `tools/release/build-binary.ts`.
assert_file_absent \
  "NoLegacy_BuildBundleScriptAbsent" \
  "scripts/build-bundle.ts"

# NoLegacy_BuildBundleTestAbsent: the test of `build-bundle.ts` must stay
# deleted with its subject.
assert_file_absent \
  "NoLegacy_BuildBundleTestAbsent" \
  "scripts/build-bundle.test.ts"

# The script suites are in tests/scripts/, so the test can only come back
# there. The guard forbids the file at both paths, not at one location.
assert_file_absent \
  "NoLegacy_BuildBundleTestAbsentFromTestTree" \
  "tests/scripts/build-bundle.test.ts"

# NoLegacy_BuildScriptDoesNotRunBuildBundle: the root `package.json` must not
# call `build-bundle` from the `build` script, and must not declare a
# `build:bundle` script.
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

# NoLegacy_PackageJsonFilesHasNoJsBundle: `package.json` must not list
# `dist/exarchos.js`. The build does not emit that file.
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
# The dead src/cli.ts and its orphans are absent
# ============================================================

# NoLegacy_DeadCliFileAbsent: the stdin-JSON entry point `src/cli.ts` must stay
# deleted.
assert_file_absent \
  "NoLegacy_DeadCliFileAbsent" \
  "src/cli.ts"

# NoLegacy_DeadCliTestAbsent: the test of `cli.ts` must stay deleted too.
assert_file_absent \
  "NoLegacy_DeadCliTestAbsent" \
  "src/cli.test.ts"

# NoLegacy_OrphanedCliCommandsAbsent: the handler modules in cli-commands/ that
# only `cli.ts` consumed must stay deleted, with their tests.
for orphan in eval-run eval-capture eval-compare eval-calibrate quality-check; do
  assert_file_absent \
    "NoLegacy_OrphanedCliCommandsAbsent ($orphan.ts)" \
    "src/cli-commands/$orphan.ts"
  assert_file_absent \
    "NoLegacy_OrphanedCliCommandsAbsent ($orphan.test.ts)" \
    "src/cli-commands/$orphan.test.ts"
done

# ============================================================
# Rollup runner, knip dead-code sweep and CI wiring
# ============================================================
#
# The rollup runner tools/audit/gates/validate-no-legacy.sh runs this suite and
# a `knip` sweep. The `validate-no-legacy` job in .github/workflows/ci.yml runs
# the rollup. These assertions pin that the runner, the job and the knip
# config exist.

# NoLegacy_RollupScriptExists: the rollup runner must exist and be executable.
ROLLUP_PATH="$REPO_ROOT/tools/audit/gates/validate-no-legacy.sh"
if [[ -f "$ROLLUP_PATH" && -x "$ROLLUP_PATH" ]]; then
  pass "NoLegacy_RollupScriptExists"
else
  if [[ ! -f "$ROLLUP_PATH" ]]; then
    fail "NoLegacy_RollupScriptExists" "rollup script missing: tools/audit/gates/validate-no-legacy.sh"
  else
    fail "NoLegacy_RollupScriptExists" "rollup script exists but is not executable: tools/audit/gates/validate-no-legacy.sh"
  fi
fi

# NoLegacy_CIWorkflowHasValidateJob: .github/workflows/ci.yml must declare a
# `validate-no-legacy` job. The match is a job key under `jobs:`.
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"
if [[ -f "$CI_YML" ]]; then
  # A job key has an indent of 2 spaces under `jobs:`.
  if grep -qE "^  validate-no-legacy:" "$CI_YML"; then
    pass "NoLegacy_CIWorkflowHasValidateJob"
  else
    fail "NoLegacy_CIWorkflowHasValidateJob" \
      ".github/workflows/ci.yml missing a 'validate-no-legacy' job"
  fi
else
  fail "NoLegacy_CIWorkflowHasValidateJob" ".github/workflows/ci.yml missing"
fi

# NoLegacy_KnipConfigExists: a knip config must exist at the repo root, in one
# of the supported locations.
KNIP_JSON="$REPO_ROOT/knip.json"
KNIP_JSONC="$REPO_ROOT/knip.jsonc"
KNIP_TS="$REPO_ROOT/knip.ts"
KNIP_IN_PKG=""
if [[ -f "$REPO_ROOT/package.json" ]]; then
  # The value must start with `{`. A bare `"knip": "^6.x"` in devDependencies
  # is a version string, not a config.
  KNIP_IN_PKG=$(grep -E '"knip"[[:space:]]*:[[:space:]]*\{' "$REPO_ROOT/package.json" 2>/dev/null || true)
fi
if [[ -f "$KNIP_JSON" || -f "$KNIP_JSONC" || -f "$KNIP_TS" || -n "$KNIP_IN_PKG" ]]; then
  # When knip.json is the config, it must name the key entry modules, so the
  # entry list is not empty:
  #   - MCP server entry: "src/index.ts"
  #   - build-skills: "src/install/build-skills.ts"
  #   - install-skills: "src/install/install-skills.ts"
  if [[ -f "$KNIP_JSON" ]]; then
    MISSING=""
    # MCP server index, with or without quotes.
    if ! grep -qF "src/index.ts" "$KNIP_JSON" \
      && ! grep -qF '"src/index.ts"' "$KNIP_JSON"; then
      MISSING="$MISSING src/index.ts"
    fi
    if ! grep -qF "src/install/build-skills.ts" "$KNIP_JSON"; then
      MISSING="$MISSING src/install/build-skills.ts"
    fi
    if ! grep -qF "src/install/install-skills.ts" "$KNIP_JSON"; then
      MISSING="$MISSING src/install/install-skills.ts"
    fi
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

# NoLegacy_DeadCodeSweep: run knip and assert that it exits clean. If the knip
# binary is not installed, the assertion passes as skipped. CI has the binary
# after `npm ci`.
#
# The rollup runner tools/audit/gates/validate-no-legacy.sh runs knip itself and
# sets NOLEGACY_SKIP_KNIP_RUN=1. Then this assertion passes as delegated, so
# knip does not run two times.
KNIP_BIN="$REPO_ROOT/node_modules/.bin/knip"
if [[ -n "${NOLEGACY_SKIP_KNIP_RUN:-}" ]]; then
  pass "NoLegacy_DeadCodeSweep (skipped — delegated to tools/audit/gates/validate-no-legacy.sh)"
elif [[ -x "$KNIP_BIN" ]]; then
  # This direct run covers files and dependencies only. The rollup also
  # includes exports and types.
  set +e
  KNIP_OUT=$("$KNIP_BIN" --no-progress --include files,dependencies 2>&1)
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
