#!/usr/bin/env bash
# validate-plugin.sh: plugin-packaging gate.
#
# This file is a wrapper. The gate is tools/audit/gates/validate-plugin.mjs, and the
# policy that it enforces is .claude-plugin/packaging-policy.json, read at runtime.
#
# The wrapper stays because the guard inventory and the docs name this path as the
# artifact. A rename drops the guard out of that inventory.
#
# Usage: validate-plugin.sh [--repo-root <path>] [--policy <path>] [--json]
#
# Exit codes are the gate's, forwarded verbatim:
#   0 = all checks pass
#   1 = one or more checks fail (or the policy is empty / self-contradictory)
#   2 = usage error, or an unreadable policy (fail closed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/validate-plugin.mjs" "$@"
