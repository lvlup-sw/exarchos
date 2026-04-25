#!/usr/bin/env bash
# validate-no-legacy.sh — CI-gated rollup runner for the v2.9 install rewrite.
#
# This is the single entry point CI invokes to confirm that obsolete v2.8
# install artifacts remain purged from the repo AND that no unreachable
# modules/dependencies have accreted in the TypeScript surface. It wraps
# two deterministic checks:
#
#   1. scripts/validate-no-legacy.test.sh — the NoLegacy_* shell assertion
#      suite (accretes across tasks 3.1–3.8 and 3.11). Grep/find-based;
#      runs in <1s against the live repo (not a temp fixture).
#
#   2. `knip` — a dead-code sweep that detects unused files and
#      dependencies against the entry-point allowlist in knip.json.
#
# Exit codes:
#   0 — all NoLegacy_* assertions pass AND knip reports clean.
#   1 — one or more assertions failed, or knip flagged issues.
#
# CI wiring: .github/workflows/ci.yml job `validate-no-legacy` calls this
# script directly. Locally, run with `bash scripts/validate-no-legacy.sh`.
#
# ─────────────────────────────────────────────────────────────────────────
# Entry-point allowlist policy (task 3.11 authoritative statement)
# ─────────────────────────────────────────────────────────────────────────
# The knip.json config declares TWO workspaces — root (".") and
# servers/exarchos-mcp — each with its own `entry` array. An entry must
# satisfy ONE of:
#
#   (a) true binary / CLI script (e.g. src/skills-guard.ts, invoked via
#       `node dist/skills-guard.js` by package.json#scripts),
#   (b) workspace entry point registered in package.json#main or #bin
#       (knip auto-discovers these — no explicit entry needed),
#   (c) vitest test suite — `**/*.test.ts` and `**/*.bench.ts` are
#       whitelisted en masse because vitest discovers them by filename
#       convention, not by import.
#
# When adding a new entry:
#   1. Grep the repo first. If nothing imports the file AND it has no
#      side-effect entry point, DELETE it instead of adding to `entry`.
#   2. Prefer auto-discovery via package.json#bin over explicit listing.
#   3. Never `**/*.ts` your way out of a finding — the resulting config
#      catches nothing.
#
# `ignore` entries are reserved for non-TS files and build artifacts:
# `.claude/**`, `dist/**`, etc. are auto-ignored by knip (gitignored +
# convention). Only list a path in `ignore` if knip is specifically
# reporting it AND it is a legitimate non-source file. Do not add
# unreachable TypeScript modules here — delete them.
#
# `ignoreDependencies` is last resort. Each entry should have a tracking
# issue for the rationale (e.g. root-level tsx is redundant with the
# MCP server's own tsx devDep — cleanup deferred).
#
# Scope: this rollup uses `--include files,dependencies`. The
# exports/types checks are deferred; the repo has ~40 flagged exports,
# many of them public API hooks (MCP tool-registration functions,
# forward-compat zod schemas) that require case-by-case review outside
# the install-rewrite feature.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== validate-no-legacy: NoLegacy_* shell assertions ==="
# Delegate the dead-code sweep to *this* rollup so the harness doesn't
# run knip a second time (it's the slowest step in the suite — about 8s
# on a warm cache). The harness honours NOLEGACY_SKIP_KNIP_RUN=1 by
# emitting a "delegated" pass for `NoLegacy_DeadCodeSweep`.
NOLEGACY_SKIP_KNIP_RUN=1 bash "$SCRIPT_DIR/validate-no-legacy.test.sh"

echo
echo "=== validate-no-legacy: knip dead-code sweep ==="
cd "$REPO_ROOT"

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
