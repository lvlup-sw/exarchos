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
# Scope: this rollup uses `--include files,dependencies,exports,types`
# (task 012 widened it to add exports+types). Findings are diffed against
# scripts/audit/knip-allowlist.json by scripts/audit/knip-diff.ts, which fails
# CLOSED on an unallowlisted violation, an expired allowlist entry, a missing
# knip binary, or unparseable knip output (DR-6/DR-8). The pre-existing dead
# exports/types (forward-compat schemas, event-contract types, a codegen-emitted
# symbol) are captured in that allowlist with owner + expiry + rationale, so the
# ratchet blocks NEW accretion while the existing debt stays owned and time-boxed.

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
echo "=== validate-no-legacy: knip dead-code sweep (allowlist-gated) ==="
cd "$REPO_ROOT"

# The sweep runs through the DR-6/DR-8 allowlist-diff wrapper
# (scripts/audit/knip-diff.ts): it invokes knip with the EXPANDED include
# below, diffs the findings against scripts/audit/knip-allowlist.json, and
# fails CLOSED on an unallowlisted violation, an expired allowlist entry, a
# missing knip binary, or unparseable knip output.
KNIP_INCLUDE="files,dependencies,exports,types"
KNIP_DIFF="$SCRIPT_DIR/audit/knip-diff.ts"

# Prefer the project-local tsx (installed via `npm ci`); fall back to
# `npx --no-install` so we never silently re-hit the network on CI.
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
