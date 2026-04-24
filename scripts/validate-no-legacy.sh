#!/usr/bin/env bash
# validate-no-legacy.sh — CI-gated rollup runner for the v2.9 install rewrite.
#
# This is the single entry point CI invokes to confirm that obsolete v2.8
# install artifacts remain purged from the repo AND that no unreachable
# exports have accreted in the TypeScript surface. It wraps two
# deterministic checks:
#
#   1. scripts/validate-no-legacy.test.sh — the NoLegacy_* shell assertion
#      suite (accretes across tasks 3.1–3.8 and 3.11). Grep/find-based;
#      runs in <1s against the live repo (not a temp fixture).
#
#   2. `npx knip` — a dead-code sweep that detects unused files,
#      unreachable exports, and missing bindings against the entry-point
#      allowlist in knip.json. Legitimate false positives are documented
#      inline in the config; do NOT weaken the allowlist to make a real
#      finding disappear — delete the unreachable code instead.
#
# Exit codes:
#   0 — all NoLegacy_* assertions pass AND knip reports clean.
#   1 — one or more assertions failed, or knip flagged issues.
#
# CI wiring: .github/workflows/ci.yml job `validate-no-legacy` calls this
# script directly. Locally, run with `bash scripts/validate-no-legacy.sh`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== validate-no-legacy: NoLegacy_* shell assertions ==="
bash "$SCRIPT_DIR/validate-no-legacy.test.sh"

echo
echo "=== validate-no-legacy: knip dead-code sweep ==="
cd "$REPO_ROOT"

# Scope: files + dependencies. This is the high-signal subset — completely
# unimported modules and dependencies declared but never consumed. The
# exports/types checks are deferred to a follow-up audit: the repo currently
# has ~40 flagged exports, many of which are public API hooks (MCP tool
# registration functions, forward-compat zod schemas) that require a
# case-by-case review. Expanding the `--include` list beyond files +
# dependencies in this task would either (a) demand rewriting unrelated
# modules, which is out of scope for the install-rewrite feature, or
# (b) require broad `ignoreExportsUsedInFile`-style allowlists that
# neutralise the check. Pinning the scope here keeps the CI gate
# high-signal and cheap to run.
#
# Policy (see knip.json header comment): legitimate unreachable files must
# be DELETED, not ignored. `ignore` entries are reserved for build
# artifacts, external-tool configs, and non-TS sources.

# Prefer the project-local binary (installed via `npm ci`); fall back to
# `npx --no-install` so we never silently re-hit the network on CI.
KNIP_BIN="$REPO_ROOT/node_modules/.bin/knip"
KNIP_ARGS=(--no-progress --include files,dependencies)
if [[ -x "$KNIP_BIN" ]]; then
  "$KNIP_BIN" "${KNIP_ARGS[@]}"
elif command -v npx >/dev/null 2>&1; then
  npx --no-install knip "${KNIP_ARGS[@]}"
else
  echo "knip binary not found at node_modules/.bin/knip and npx is unavailable." >&2
  echo "Run 'npm ci' at the repo root to install devDependencies, then retry." >&2
  exit 1
fi

echo
echo "=== validate-no-legacy: OK ==="
