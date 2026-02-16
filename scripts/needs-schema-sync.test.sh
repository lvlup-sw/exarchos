#!/usr/bin/env bash
# needs-schema-sync.test.sh — Tests for needs-schema-sync.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/needs-schema-sync.sh"
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# ============================================================
# TEST FIXTURES
# ============================================================

TMPDIR_ROOT=""
MOCK_BIN=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"

    # Create a real git repo
    REPO_DIR="$TMPDIR_ROOT/repo"
    mkdir -p "$REPO_DIR"
    git -C "$REPO_DIR" init -b main --quiet
    git -C "$REPO_DIR" config user.email "test@test.com"
    git -C "$REPO_DIR" config user.name "Test"
    echo "init" > "$REPO_DIR/README.md"
    git -C "$REPO_DIR" add README.md
    git -C "$REPO_DIR" commit -m "init" --quiet

    # Create mock bin
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Needs Schema Sync Tests ==="
echo ""

# --------------------------------------------------
# Test 1: NoAPIFiles_ExitsZero
# --------------------------------------------------
setup
# Add a non-API file change
echo "console.log('hello');" > "$REPO_DIR/index.ts"
git -C "$REPO_DIR" add index.ts
git -C "$REPO_DIR" commit -m "add index" --quiet
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NoAPIFiles_ExitsZero"
else
    fail "NoAPIFiles_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: EndpointsFile_ExitsOne
# --------------------------------------------------
setup
# Create an API endpoint file
mkdir -p "$REPO_DIR/src/api"
echo "public class UserEndpoints {}" > "$REPO_DIR/src/api/UserEndpoints.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add endpoint" --quiet
# Now diff against the initial commit
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EndpointsFile_ExitsOne"
else
    fail "EndpointsFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ModelsFile_ExitsOne
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/Models"
echo "public class User {}" > "$REPO_DIR/Models/User.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add model" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ModelsFile_ExitsOne"
else
    fail "ModelsFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: DtosFile_ExitsOne
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/Dtos"
echo "public class UserDto {}" > "$REPO_DIR/Dtos/UserDto.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add dto" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DtosFile_ExitsOne"
else
    fail "DtosFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: RequestsFile_ExitsOne
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/Requests"
echo "public class CreateUserRequest {}" > "$REPO_DIR/Requests/CreateUserRequest.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add request" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "RequestsFile_ExitsOne"
else
    fail "RequestsFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: ResponsesFile_ExitsOne
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/Responses"
echo "public class UserResponse {}" > "$REPO_DIR/Responses/UserResponse.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add response" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ResponsesFile_ExitsOne"
else
    fail "ResponsesFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_NoArgs_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoArgs_ExitsTwo"
else
    fail "UsageError_NoArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: DiffFile_UsesProvidedDiff
# --------------------------------------------------
setup
# Create a diff file with an Endpoints.cs change
cat > "$TMPDIR_ROOT/test.diff" << 'EOF'
diff --git a/src/api/UserEndpoints.cs b/src/api/UserEndpoints.cs
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/api/UserEndpoints.cs
@@ -0,0 +1,5 @@
+public class UserEndpoints
+{
+    // endpoints
+}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --diff-file "$TMPDIR_ROOT/test.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DiffFile_UsesProvidedDiff_ExitsOne"
else
    fail "DiffFile_UsesProvidedDiff_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: StructuredOutput_ListsModifiedFiles
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/src/api"
echo "public class UserEndpoints {}" > "$REPO_DIR/src/api/UserEndpoints.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add endpoint" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "UserEndpoints.cs"; then
    pass "StructuredOutput_ListsModifiedFiles"
else
    fail "StructuredOutput_ListsModifiedFiles (expected file listing in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: Idempotent_RunTwice_SameResult
# --------------------------------------------------
setup
mkdir -p "$REPO_DIR/src/api"
echo "public class UserEndpoints {}" > "$REPO_DIR/src/api/UserEndpoints.cs"
git -C "$REPO_DIR" add .
git -C "$REPO_DIR" commit -m "add endpoint" --quiet
INITIAL_COMMIT="$(git -C "$REPO_DIR" rev-list --max-parents=0 HEAD)"
OUTPUT1="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT1=$? || EXIT1=$?
OUTPUT2="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --base-branch "$INITIAL_COMMIT" 2>&1)" && EXIT2=$? || EXIT2=$?
if [[ "$EXIT1" -eq "$EXIT2" && "$OUTPUT1" == "$OUTPUT2" ]]; then
    pass "Idempotent_RunTwice_SameResult"
else
    fail "Idempotent_RunTwice_SameResult (run1 exit=$EXIT1 vs run2 exit=$EXIT2)"
fi
teardown

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
