#!/usr/bin/env bash
# validate-plugin.sh — plugin-packaging gate (task 064, DR-24).
#
# This file is a WRAPPER. The gate itself is tools/audit/gates/validate-plugin.mjs, and
# the policy it enforces is .claude-plugin/packaging-policy.json — data, read at
# runtime, not expectations frozen into a shell script.
#
# Why the implementation moved out of bash. The previous version hard-coded the
# expected package shape in `jq` calls, and by 2026-08-07 five of its nine checks
# were wrong ABOUT THE GATE, not about the package: it demanded a `.mcp.json`
# deleted on purpose, a plugin.json `hooks` field removed on purpose, a
# `SessionEnd` hook dropped on purpose, and forbade the `SessionStart` the plugin
# ships on purpose. Every one contradicted a green assertion in
# src/plugin-validation.test.ts. Two statements of one policy with no channel
# between them; the policy document is that channel. The move to node also drops
# the hard `jq` dependency, so this gate can ride CI's zero-dependency prefix.
#
# The wrapper is kept (rather than calling node directly from package.json)
# because this path is the artifact name in tools/audit/gates/guard-inventory.ts's Wave-1
# reachability census and in docs; renaming it would silently drop the guard out
# of that inventory.
#
# Usage: validate-plugin.sh [--repo-root <path>] [--policy <path>] [--json]
#
# Exit codes are the gate's, forwarded verbatim:
#   0 = all checks pass
#   1 = one or more checks fail (or the policy is empty / self-contradictory)
#   2 = usage error, or the policy could not be read (fail closed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/validate-plugin.mjs" "$@"
