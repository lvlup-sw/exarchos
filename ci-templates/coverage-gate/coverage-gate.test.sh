#!/usr/bin/env bash
#
# coverage-gate.test.sh - Tests for coverage gate script
#
# Run with: ./coverage-gate.test.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/coverage-gate.sh"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Test helper functions
assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="${3:-}"

  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" == "$actual" ]]; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo "  PASS: $message"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "  FAIL: $message"
    echo "    Expected: $expected"
    echo "    Actual:   $actual"
    return 1
  fi
}

assert_exit_code() {
  local expected="$1"
  shift
  local message="${*: -1}"
  local cmd="${*:1:$#-1}"

  TESTS_RUN=$((TESTS_RUN + 1))
  set +e
  eval "$cmd" > /dev/null 2>&1
  local actual=$?
  set -e

  if [[ "$expected" == "$actual" ]]; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo "  PASS: $message"
    return 0
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "  FAIL: $message"
    echo "    Expected exit code: $expected"
    echo "    Actual exit code:   $actual"
    return 1
  fi
}

# ============================================================================
# Test: parse_line_coverage
# ============================================================================
echo ""
echo "Testing: parse_line_coverage"
echo "----------------------------"

test_parse_line_coverage_extracts_percentage() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local result
  result=$(parse_line_coverage "$fixture")
  assert_equals "85.20" "$result" "parse_line_coverage extracts line-rate as percentage"
}

test_parse_line_coverage_handles_100_percent() {
  # Create temp file with 100% coverage
  local temp_file
  temp_file=$(mktemp)
  cat > "$temp_file" << 'EOF'
<?xml version="1.0"?>
<coverage line-rate="1.0" branch-rate="1.0"/>
EOF
  local result
  result=$(parse_line_coverage "$temp_file")
  rm "$temp_file"
  assert_equals "100.00" "$result" "parse_line_coverage handles 100% coverage"
}

test_parse_line_coverage_handles_zero_percent() {
  local temp_file
  temp_file=$(mktemp)
  cat > "$temp_file" << 'EOF'
<?xml version="1.0"?>
<coverage line-rate="0" branch-rate="0"/>
EOF
  local result
  result=$(parse_line_coverage "$temp_file")
  rm "$temp_file"
  assert_equals "0.00" "$result" "parse_line_coverage handles 0% coverage"
}

# ============================================================================
# Test: parse_branch_coverage
# ============================================================================
echo ""
echo "Testing: parse_branch_coverage"
echo "-------------------------------"

test_parse_branch_coverage_extracts_percentage() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local result
  result=$(parse_branch_coverage "$fixture")
  assert_equals "78.20" "$result" "parse_branch_coverage extracts branch-rate as percentage"
}

# ============================================================================
# Test: check_threshold
# ============================================================================
echo ""
echo "Testing: check_threshold"
echo "------------------------"

test_check_threshold_passes_when_above() {
  assert_exit_code 0 "check_threshold 85.20 80" "check_threshold passes when coverage (85.20) >= threshold (80)"
}

test_check_threshold_fails_when_below() {
  assert_exit_code 1 "check_threshold 75.50 80" "check_threshold fails when coverage (75.50) < threshold (80)"
}

test_check_threshold_passes_when_equal() {
  assert_exit_code 0 "check_threshold 80.00 80" "check_threshold passes when coverage equals threshold"
}

# ============================================================================
# Test: get_coverage_badge_color
# ============================================================================
echo ""
echo "Testing: get_coverage_badge_color"
echo "----------------------------------"

test_badge_color_green_when_passing() {
  local result
  result=$(get_coverage_badge_color 85.20 80)
  assert_equals "brightgreen" "$result" "get_coverage_badge_color returns brightgreen when passing"
}

test_badge_color_red_when_failing() {
  local result
  result=$(get_coverage_badge_color 75.50 80)
  assert_equals "red" "$result" "get_coverage_badge_color returns red when failing"
}

test_badge_color_yellow_when_close() {
  local result
  result=$(get_coverage_badge_color 82.00 80)
  assert_equals "yellow" "$result" "get_coverage_badge_color returns yellow when within 5% of threshold"
}

# ============================================================================
# Test: parse_package_coverage
# ============================================================================
echo ""
echo "Testing: parse_package_coverage"
echo "--------------------------------"

test_parse_package_coverage_extracts_all_packages() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local result
  result=$(parse_package_coverage "$fixture" | wc -l)
  assert_equals "3" "$result" "parse_package_coverage extracts 3 packages from fixture"
}

test_parse_package_coverage_format() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local first_line
  first_line=$(parse_package_coverage "$fixture" | head -1)
  # Expected format: "PackageName|line_coverage"
  [[ "$first_line" =~ ^Agentic\.Core\|92\.10$ ]] && \
    assert_equals "0" "0" "parse_package_coverage outputs correct format" || \
    assert_equals "Agentic.Core|92.10" "$first_line" "parse_package_coverage outputs correct format"
}

# ============================================================================
# Test: generate_pr_comment
# ============================================================================
echo ""
echo "Testing: generate_pr_comment"
echo "----------------------------"

test_generate_pr_comment_creates_markdown() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local output_dir
  output_dir=$(mktemp -d)

  generate_pr_comment "$fixture" 80 "$output_dir"

  if [[ -f "$output_dir/pr-comment.md" ]]; then
    assert_equals "0" "0" "generate_pr_comment creates pr-comment.md file"
  else
    assert_equals "file exists" "file missing" "generate_pr_comment creates pr-comment.md file"
  fi

  rm -rf "$output_dir"
}

test_generate_pr_comment_includes_badge() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local output_dir
  output_dir=$(mktemp -d)

  generate_pr_comment "$fixture" 80 "$output_dir"

  if grep -q "shields.io/badge/coverage" "$output_dir/pr-comment.md"; then
    assert_equals "0" "0" "generate_pr_comment includes coverage badge"
  else
    assert_equals "badge present" "badge missing" "generate_pr_comment includes coverage badge"
  fi

  rm -rf "$output_dir"
}

test_generate_pr_comment_includes_per_project_breakdown() {
  local fixture="$SCRIPT_DIR/fixtures/sample-coverage.xml"
  local output_dir
  output_dir=$(mktemp -d)

  generate_pr_comment "$fixture" 80 "$output_dir"

  if grep -q "Agentic.Core" "$output_dir/pr-comment.md" && \
     grep -q "Agentic.Workflow" "$output_dir/pr-comment.md"; then
    assert_equals "0" "0" "generate_pr_comment includes per-project breakdown"
  else
    assert_equals "projects present" "projects missing" "generate_pr_comment includes per-project breakdown"
  fi

  rm -rf "$output_dir"
}

# ============================================================================
# Run all tests
# ============================================================================

run_tests() {
  echo ""
  echo "========================================"
  echo "Coverage Gate Test Suite"
  echo "========================================"

  # Parse coverage tests
  test_parse_line_coverage_extracts_percentage || true
  test_parse_line_coverage_handles_100_percent || true
  test_parse_line_coverage_handles_zero_percent || true
  test_parse_branch_coverage_extracts_percentage || true

  # Threshold tests
  test_check_threshold_passes_when_above || true
  test_check_threshold_fails_when_below || true
  test_check_threshold_passes_when_equal || true

  # Badge color tests
  test_badge_color_green_when_passing || true
  test_badge_color_red_when_failing || true
  test_badge_color_yellow_when_close || true

  # Package coverage tests
  test_parse_package_coverage_extracts_all_packages || true
  test_parse_package_coverage_format || true

  # PR comment tests
  test_generate_pr_comment_creates_markdown || true
  test_generate_pr_comment_includes_badge || true
  test_generate_pr_comment_includes_per_project_breakdown || true

  echo ""
  echo "========================================"
  echo "Results: $TESTS_PASSED/$TESTS_RUN passed, $TESTS_FAILED failed"
  echo "========================================"

  if [[ $TESTS_FAILED -gt 0 ]]; then
    exit 1
  fi
}

run_tests
