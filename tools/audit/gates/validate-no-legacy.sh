#!/usr/bin/env bash
# validate-no-legacy.sh: the CI rollup runner for the install rewrite.
#
# It confirms that the obsolete v2.8 install artifacts stay out of the repo, and
# that no unreachable modules or dependencies collect in the TypeScript surface.
# It runs two checks:
#
#   1. tests/scripts/validate-no-legacy.test.sh, the NoLegacy_* shell assertions
#      against the live repo.
#   2. A knip dead-code sweep through tools/audit/knip-diff.ts.
#
# It exits 0 when both checks pass. A failed check passes its own non-zero exit
# code through `set -e`. The CI job `validate-no-legacy` calls this script.
#
# Entry-point policy for knip.json. An `entry` must be one of these:
#   (a) a binary or CLI script that package.json#scripts invokes.
#   (b) a workspace entry point in package.json#main or #bin. knip finds these.
#   (c) a vitest suite. vitest finds `**/*.test.ts` and `**/*.bench.ts` by name.
#   (d) a fixture that a test spawns by path. Its `project` glob must name its extension.
# Before you add an entry, search the repo. If nothing imports the file and it has
# no side-effect entry point, delete the file. Never add `**/*.ts` to clear a finding.
# Add a path to `ignore` only for a non-source file that knip reports.
# Use `ignoreDependencies` only as a last resort, with a tracking issue.
#
# The knip.json `tags: ["-proof"]` entry exempts compile-time proof aliases. Tag a
# new proof alias with `@proof` in its JSDoc. Use knip-allowlist.json for a one-off
# consumer that knip cannot see, such as a CLI that a subprocess runs.
#
# The sweep uses `--include files,dependencies,exports,types`. knip-diff.ts diffs
# the findings against tools/audit/knip-allowlist.json, and it fails closed on an
# unallowlisted finding, an expired entry, a missing knip binary, or unparseable
# output. It also fails closed (exit 2, `vacuous-exemption`) when the inverted
# reading `--tags +proof` finds no exempted symbol.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== validate-no-legacy: NoLegacy_* shell assertions ==="
# The rollup runs knip itself, so the harness skips its own knip run. With
# NOLEGACY_SKIP_KNIP_RUN=1, the harness gives a "delegated" pass for
# `NoLegacy_DeadCodeSweep`.
NOLEGACY_SKIP_KNIP_RUN=1 bash "$REPO_ROOT/tests/scripts/validate-no-legacy.test.sh"

echo
echo "=== validate-no-legacy: knip dead-code sweep (allowlist-gated) ==="
cd "$REPO_ROOT"

# The allowlist-diff wrapper tools/audit/knip-diff.ts runs knip with the include
# list below.
KNIP_INCLUDE="files,dependencies,exports,types"
KNIP_DIFF="$SCRIPT_DIR/../knip-diff.ts"

# Use the project-local tsx from `npm ci`. The fallback is `npx --no-install`,
# so the script never downloads tsx.
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
if [[ -x "$TSX_BIN" ]]; then
  "$TSX_BIN" "$KNIP_DIFF" --include "$KNIP_INCLUDE"
elif command -v npx >/dev/null 2>&1; then
  npx --no-install tsx "$KNIP_DIFF" --include "$KNIP_INCLUDE"
else
  echo "tsx binary not found at node_modules/.bin/tsx and npx is unavailable." >&2
  echo "Run 'npm ci' at the repo root to install devDependencies, then retry." >&2
  exit 1
fi

echo
echo "=== validate-no-legacy: OK ==="
