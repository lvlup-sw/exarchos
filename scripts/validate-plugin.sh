#!/usr/bin/env bash
# validate-plugin.sh — Validate core plugin directory structure
#
# Checks:
#   1. .claude-plugin/plugin.json exists and valid JSON with required fields
#   2. Referenced directories exist: commands/, skills/
#   3. Referenced files exist: hooks/hooks.json, .mcp.json
#   4. .mcp.json is valid JSON containing exarchos and graphite server entries
#   5. hooks/hooks.json contains all 6 hook types
#   6. No {{CLI_PATH}} references in hooks (should use ${CLAUDE_PLUGIN_ROOT})
#
# Usage: validate-plugin.sh --repo-root <path>
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
Usage: validate-plugin.sh --repo-root <path>

Validates the core Exarchos plugin directory structure.

Options:
  --repo-root <path>   Path to the plugin repository root (default: .)
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

# --- Check 1: .claude-plugin/plugin.json exists and valid JSON with required fields ---
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
if [[ -f "$PLUGIN_JSON" ]] && jq empty "$PLUGIN_JSON" 2>/dev/null; then
  # Verify required fields
  REQUIRED_FIELDS=("name" "version" "commands" "skills" "hooks" "mcpServers")
  ALL_FIELDS_PRESENT=true
  MISSING_FIELDS=()
  for field in "${REQUIRED_FIELDS[@]}"; do
    if ! jq -e ".$field" "$PLUGIN_JSON" >/dev/null 2>&1; then
      ALL_FIELDS_PRESENT=false
      MISSING_FIELDS+=("$field")
    fi
  done
  if [[ "$ALL_FIELDS_PRESENT" == "true" ]]; then
    check ".claude-plugin/plugin.json exists and valid" "true"
  else
    check ".claude-plugin/plugin.json missing fields: ${MISSING_FIELDS[*]}" "false"
  fi
else
  check ".claude-plugin/plugin.json exists and valid" "false"
fi

# --- Check 2: Referenced directories exist ---
COMMANDS_DIR="$REPO_ROOT/commands"
SKILLS_DIR="$REPO_ROOT/skills"
if [[ -d "$COMMANDS_DIR" ]]; then
  check "commands/ directory exists" "true"
else
  check "commands/ directory exists" "false"
fi

if [[ -d "$SKILLS_DIR" ]]; then
  check "skills/ directory exists" "true"
else
  check "skills/ directory exists" "false"
fi

# --- Check 3: Referenced files exist ---
HOOKS_FILE="$REPO_ROOT/hooks/hooks.json"
MCP_FILE="$REPO_ROOT/.mcp.json"

if [[ -f "$HOOKS_FILE" ]]; then
  check "hooks/hooks.json exists" "true"
else
  check "hooks/hooks.json exists" "false"
fi

if [[ -f "$MCP_FILE" ]]; then
  check ".mcp.json exists" "true"
else
  check ".mcp.json exists" "false"
fi

# --- Check 4: .mcp.json is valid JSON with exarchos and graphite entries ---
if [[ -f "$MCP_FILE" ]] && jq empty "$MCP_FILE" 2>/dev/null; then
  HAS_EXARCHOS=$(jq -e '.exarchos' "$MCP_FILE" >/dev/null 2>&1 && echo "true" || echo "false")
  HAS_GRAPHITE=$(jq -e '.graphite' "$MCP_FILE" >/dev/null 2>&1 && echo "true" || echo "false")
  if [[ "$HAS_EXARCHOS" == "true" && "$HAS_GRAPHITE" == "true" ]]; then
    check ".mcp.json contains exarchos and graphite entries" "true"
  else
    MISSING_SERVERS=()
    [[ "$HAS_EXARCHOS" == "false" ]] && MISSING_SERVERS+=("exarchos")
    [[ "$HAS_GRAPHITE" == "false" ]] && MISSING_SERVERS+=("graphite")
    check ".mcp.json missing server entries: ${MISSING_SERVERS[*]}" "false"
  fi
else
  check ".mcp.json valid JSON with required entries" "false"
fi

# --- Check 5: hooks/hooks.json contains all 6 hook types ---
REQUIRED_HOOKS=("PreCompact" "SessionStart" "PreToolUse" "TaskCompleted" "TeammateIdle" "SubagentStart")
if [[ -f "$HOOKS_FILE" ]] && jq empty "$HOOKS_FILE" 2>/dev/null; then
  ALL_HOOKS_PRESENT=true
  MISSING_HOOKS=()
  for hook in "${REQUIRED_HOOKS[@]}"; do
    if ! jq -e ".hooks.$hook" "$HOOKS_FILE" >/dev/null 2>&1; then
      ALL_HOOKS_PRESENT=false
      MISSING_HOOKS+=("$hook")
    fi
  done
  if [[ "$ALL_HOOKS_PRESENT" == "true" ]]; then
    check "hooks/hooks.json contains all 6 hook types" "true"
  else
    check "hooks/hooks.json missing hook types: ${MISSING_HOOKS[*]}" "false"
  fi
else
  check "hooks/hooks.json valid JSON with all hook types" "false"
fi

# --- Check 6: No {{CLI_PATH}} references in hooks ---
if [[ -f "$HOOKS_FILE" ]]; then
  if grep -q '{{CLI_PATH}}' "$HOOKS_FILE" 2>/dev/null; then
    check "No {{CLI_PATH}} references in hooks (should use \${CLAUDE_PLUGIN_ROOT})" "false"
  else
    check "No {{CLI_PATH}} references in hooks" "true"
  fi
else
  check "No {{CLI_PATH}} references in hooks (hooks file missing)" "false"
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Plugin Validation Report"
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
