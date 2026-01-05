#!/usr/bin/env bash
# Test script for cd-azure.yml workflow validation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_FILE="$SCRIPT_DIR/cd-azure.yml"

# Test: Workflow file exists
test_workflow_exists() {
  if [[ ! -f "$WORKFLOW_FILE" ]]; then
    echo "FAIL: cd-azure.yml does not exist"
    return 1
  fi
  echo "PASS: cd-azure.yml exists"
}

# Test: YAML is valid (requires yq)
test_yaml_valid() {
  if command -v yq &>/dev/null; then
    if ! yq '.' "$WORKFLOW_FILE" > /dev/null 2>&1; then
      echo "FAIL: Invalid YAML syntax"
      return 1
    fi
    echo "PASS: Valid YAML syntax"
  else
    echo "SKIP: yq not installed"
  fi
}

# Test: Required fields exist
test_required_fields() {
  local errors=0

  # Check for name field
  if ! grep -q '^name:' "$WORKFLOW_FILE"; then
    echo "FAIL: Missing 'name' field"
    ((errors++))
  fi

  # Check for on: push trigger
  if ! grep -q 'push:' "$WORKFLOW_FILE"; then
    echo "FAIL: Missing push trigger"
    ((errors++))
  fi

  # Check for jobs
  if ! grep -q '^jobs:' "$WORKFLOW_FILE"; then
    echo "FAIL: Missing 'jobs' section"
    ((errors++))
  fi

  # Check for Blacksmith runner
  if ! grep -q 'blacksmith' "$WORKFLOW_FILE"; then
    echo "FAIL: Missing Blacksmith runner"
    ((errors++))
  fi

  # Check for OIDC login
  if ! grep -q 'azure/login' "$WORKFLOW_FILE"; then
    echo "FAIL: Missing Azure login action"
    ((errors++))
  fi

  if [[ $errors -gt 0 ]]; then
    return 1
  fi
  echo "PASS: All required fields present"
}

# Run tests
main() {
  local failures=0

  test_workflow_exists || ((failures++))
  test_yaml_valid || ((failures++))
  test_required_fields || ((failures++))

  if [[ $failures -gt 0 ]]; then
    echo ""
    echo "RESULT: $failures test(s) failed"
    exit 1
  fi

  echo ""
  echo "RESULT: All tests passed"
  exit 0
}

main
