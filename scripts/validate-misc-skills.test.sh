#!/usr/bin/env bash
# validate-misc-skills.test.sh — Verifies brainstorming, workflow-state, and dotnet-standards SKILL.md files
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

assert_contains() {
  local skill_file="$1"
  local label="$2"
  local pattern="$3"
  if grep -q "$pattern" "$skill_file"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label — expected to find: $pattern"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Misc Skills SKILL.md Validation ==="
echo ""

# Brainstorming skill
BRAINSTORM_FILE="$SCRIPT_DIR/../skills/brainstorming/SKILL.md"
echo "--- Brainstorming ---"
assert_contains \
  "$BRAINSTORM_FILE" \
  "Brainstorming_ReferencesScript_VerifyIdeateArtifacts" \
  "verify-ideate-artifacts.sh"

assert_contains \
  "$BRAINSTORM_FILE" \
  "Brainstorming_Exit0_Documented" \
  "exit 0"

assert_contains \
  "$BRAINSTORM_FILE" \
  "Brainstorming_Exit1_Documented" \
  "exit 1"

# Workflow-state skill
WORKFLOW_STATE_FILE="$SCRIPT_DIR/../skills/workflow-state/SKILL.md"
echo "--- Workflow State ---"
assert_contains \
  "$WORKFLOW_STATE_FILE" \
  "WorkflowState_ReferencesScript_ReconcileState" \
  "reconcile-state.sh"

assert_contains \
  "$WORKFLOW_STATE_FILE" \
  "WorkflowState_Exit0_Documented" \
  "exit 0"

assert_contains \
  "$WORKFLOW_STATE_FILE" \
  "WorkflowState_Exit1_Documented" \
  "exit 1"

# Dotnet-standards skill
DOTNET_FILE="$SCRIPT_DIR/../skills/dotnet-standards/SKILL.md"
echo "--- Dotnet Standards ---"
assert_contains \
  "$DOTNET_FILE" \
  "DotnetStandards_ReferencesScript_ValidateDotnetStandards" \
  "validate-dotnet-standards.sh"

assert_contains \
  "$DOTNET_FILE" \
  "DotnetStandards_Exit0_Documented" \
  "exit 0"

assert_contains \
  "$DOTNET_FILE" \
  "DotnetStandards_Exit1_Documented" \
  "exit 1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
