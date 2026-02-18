#!/usr/bin/env bash
# validate-companion.sh — Validate companion plugin directory structure
#
# Checks:
#   1. companion/.claude-plugin/plugin.json exists and valid JSON with required fields (name, version, mcpServers)
#   2. companion/.mcp.json exists and valid JSON
#   3. companion/settings.json exists and valid JSON with enabledPlugins
#
# Usage: validate-companion.sh --repo-root <path>
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks fail
#   2 = usage error

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT="."

usage() {
  cat << 'USAGE'
Usage: validate-companion.sh --repo-root <path>

Validates the Exarchos companion plugin directory structure.

Options:
  --repo-root <path>   Path to the repository root (default: .)
  --help               Show this help message

Exit codes:
  0  All checks pass
  1  One or more checks fail
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --repo-root requires a path argument" >&2
        exit 2
      fi
      REPO_ROOT="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "Error: Repository root not found: $REPO_ROOT" >&2
  exit 2
fi

# ============================================================
# DEPENDENCY CHECK
# ============================================================

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed" >&2
  exit 2
fi

# ============================================================
# VALIDATION
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
TOTAL=0
RESULTS=()

check() {
  local description="$1"
  local passed="$2"
  TOTAL=$((TOTAL + 1))
  if [[ "$passed" == "true" ]]; then
    RESULTS+=("- **PASS**: $description")
    CHECK_PASS=$((CHECK_PASS + 1))
  else
    RESULTS+=("- **FAIL**: $description")
    CHECK_FAIL=$((CHECK_FAIL + 1))
  fi
}

# --- Check 1: companion/.claude-plugin/plugin.json exists and valid JSON with required fields ---
PLUGIN_JSON="$REPO_ROOT/companion/.claude-plugin/plugin.json"
if [[ -f "$PLUGIN_JSON" ]] && jq empty "$PLUGIN_JSON" 2>/dev/null; then
  REQUIRED_FIELDS=("name" "version" "mcpServers")
  ALL_FIELDS_PRESENT=true
  MISSING_FIELDS=()
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! jq -e ".$field" "$PLUGIN_JSON" >/dev/null 2>&1; then
      ALL_FIELDS_PRESENT=false
      MISSING_FIELDS+=("$field")
    fi
  done
  if [[ "$ALL_FIELDS_PRESENT" == "true" ]]; then
    check "companion/.claude-plugin/plugin.json exists and valid" "true"
  else
    check "companion/.claude-plugin/plugin.json missing fields: ${MISSING_FIELDS[*]}" "false"
  fi
else
  check "companion/.claude-plugin/plugin.json exists and valid" "false"
fi

# --- Check 2: companion/.mcp.json exists and valid JSON ---
MCP_FILE="$REPO_ROOT/companion/.mcp.json"
if [[ -f "$MCP_FILE" ]] && jq empty "$MCP_FILE" 2>/dev/null; then
  check "companion/.mcp.json exists and valid JSON" "true"
else
  check "companion/.mcp.json exists and valid JSON" "false"
fi

# --- Check 3: companion/settings.json exists and valid JSON with enabledPlugins ---
SETTINGS_FILE="$REPO_ROOT/companion/settings.json"
if [[ -f "$SETTINGS_FILE" ]] && jq empty "$SETTINGS_FILE" 2>/dev/null; then
  if jq -e '.enabledPlugins' "$SETTINGS_FILE" >/dev/null 2>&1; then
    check "companion/settings.json exists and has enabledPlugins" "true"
  else
    check "companion/settings.json missing enabledPlugins field" "false"
  fi
else
  check "companion/settings.json exists and valid JSON" "false"
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Companion Validation Report"
echo ""

for result in "${RESULTS[@]}"; do
  echo "$result"
done

echo ""
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
  echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
  exit 0
else
  echo "**Result: FAIL** ($CHECK_PASS/$TOTAL checks passed)"
  exit 1
fi
