#!/usr/bin/env bash
# get-exarchos.test.sh — Tests for scripts/get-exarchos.sh
#
# Shell-native test harness (mirrors validate-rm.test.sh style).
# Exercises the 7 behaviors in task 2.5:
#
#   1. Dry-run prints install plan and exits 0
#   2. Platform detection: Linux x64 → selects exarchos-linux-x64
#   3. Platform detection: Darwin arm64 → selects exarchos-darwin-arm64
#   4. Checksum mismatch refuses install (exit non-zero, no binary copied)
#   5. PATH append writes exarchos marker block into empty .bashrc
#   6. --version v2.9.0-rc1 pins the tag in the download URL
#   7. --github-actions writes install dir to $GITHUB_PATH
#
# Adversarial posture (per task guidance):
#   - Checksum happy path uses a real tempfile binary + real sha512 sidecar,
#     not a mocked validator.
#   - GitHub API "latest" resolution is overridden via EXARCHOS_LATEST_VERSION
#     env var so tests are hermetic (no network).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/get-exarchos.sh"
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
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
FAKE_BIN=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
    TEST_HOME="$TMPDIR_ROOT/home"
    TEST_INSTALL="$TMPDIR_ROOT/install"
    FAKE_BIN="$TMPDIR_ROOT/fakebin"
    mkdir -p "$TEST_HOME" "$TEST_INSTALL" "$FAKE_BIN"
}

teardown() {
    if [[ -n "${TMPDIR_ROOT:-}" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Build a mock `uname` shim and put it first on PATH so the script
# under test observes the OS/arch we want.
#
# Usage: mock_uname <OS> <ARCH>
mock_uname() {
    local os="$1"
    local arch="$2"
    cat > "$FAKE_BIN/uname" <<EOF
#!/usr/bin/env bash
case "\$1" in
    -s) echo "$os" ;;
    -m) echo "$arch" ;;
    *)  echo "$os" ;;
esac
EOF
    chmod +x "$FAKE_BIN/uname"
}

# Build a mock `curl` shim that serves fixture files from a staging dir
# keyed off URL fragments. Supports -o <out> and -fsSL style flags.
#
# Usage: mock_curl <fixture-dir>
#   fixture-dir must contain files named after the final URL segment.
mock_curl() {
    local fixtures="$1"
    cat > "$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
# Minimal curl shim: serves \$fixtures/<basename of URL> for any GET.
# Honors -o <file> (write to file) and otherwise prints to stdout.
OUT=""
URL=""
while [[ \$# -gt 0 ]]; do
    case "\$1" in
        -o) OUT="\$2"; shift 2 ;;
        -fsSL|-fsS|-fL|-s|-S|-L|-f) shift ;;
        --*) shift ;;
        http*) URL="\$1"; shift ;;
        *) shift ;;
    esac
done
if [[ -z "\$URL" ]]; then
    echo "mock curl: no URL provided" >&2
    exit 22
fi
# Echo URL to a log so tests can inspect which URL was requested.
echo "\$URL" >> "$fixtures/.requested_urls"
BASENAME="\${URL##*/}"
SRC="$fixtures/\$BASENAME"
if [[ ! -f "\$SRC" ]]; then
    # Fall back: if URL is the GitHub releases API endpoint, serve latest.json
    case "\$URL" in
        *api.github.com/repos/*/releases/latest*)
            SRC="$fixtures/latest.json"
            ;;
    esac
fi
if [[ ! -f "\$SRC" ]]; then
    echo "mock curl: no fixture for \$URL (looked for \$SRC)" >&2
    exit 22
fi
if [[ -n "\$OUT" ]]; then
    cp "\$SRC" "\$OUT"
else
    cat "\$SRC"
fi
EOF
    chmod +x "$FAKE_BIN/curl"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== get-exarchos.sh Tests ==="
echo ""

# --------------------------------------------------
# Test 1: GetExarchos_DryRun_PrintsInstallPlan
# --------------------------------------------------
setup
OUTPUT="$(
    HOME="$TEST_HOME" \
    EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
    EXARCHOS_LATEST_VERSION="v2.9.0" \
    bash "$SCRIPT_UNDER_TEST" --dry-run 2>&1
)" && EXIT_CODE=$? || EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    pass "GetExarchos_DryRun_ExitsZero"
else
    fail "GetExarchos_DryRun_ExitsZero (exit=$EXIT_CODE)"
    echo "  Output: $OUTPUT"
fi

# Plan should mention platform, URL, and install dir
if echo "$OUTPUT" | grep -qi "platform" && \
   echo "$OUTPUT" | grep -q "http" && \
   echo "$OUTPUT" | grep -q "$TEST_INSTALL"; then
    pass "GetExarchos_DryRun_PrintsInstallPlan"
else
    fail "GetExarchos_DryRun_PrintsInstallPlan (missing expected fields)"
    echo "  Output: $OUTPUT"
fi

# Dry-run MUST NOT create the install directory's binary
if [[ ! -f "$TEST_INSTALL/exarchos" ]]; then
    pass "GetExarchos_DryRun_DoesNotInstallBinary"
else
    fail "GetExarchos_DryRun_DoesNotInstallBinary (binary was created)"
fi
teardown

# --------------------------------------------------
# Test 2: GetExarchos_PlatformDetection_Linux_x64
# --------------------------------------------------
setup
mock_uname "Linux" "x86_64"
OUTPUT="$(
    HOME="$TEST_HOME" \
    EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
    EXARCHOS_LATEST_VERSION="v2.9.0" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT_UNDER_TEST" --dry-run 2>&1
)" && EXIT_CODE=$? || EXIT_CODE=$?

if echo "$OUTPUT" | grep -q "exarchos-linux-x64"; then
    pass "GetExarchos_PlatformDetection_Linux_x64"
else
    fail "GetExarchos_PlatformDetection_Linux_x64 (did not select exarchos-linux-x64)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: GetExarchos_PlatformDetection_Darwin_arm64
# --------------------------------------------------
setup
mock_uname "Darwin" "arm64"
OUTPUT="$(
    HOME="$TEST_HOME" \
    EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
    EXARCHOS_LATEST_VERSION="v2.9.0" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT_UNDER_TEST" --dry-run 2>&1
)" && EXIT_CODE=$? || EXIT_CODE=$?

if echo "$OUTPUT" | grep -q "exarchos-darwin-arm64"; then
    pass "GetExarchos_PlatformDetection_Darwin_arm64"
else
    fail "GetExarchos_PlatformDetection_Darwin_arm64 (did not select exarchos-darwin-arm64)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: GetExarchos_ChecksumMismatch_RefusesInstall
# --------------------------------------------------
#
# Adversarial: we drop a REAL fake binary into a fixture dir, generate a
# REAL sha512 for DIFFERENT content, and confirm the script refuses.
setup
FIXTURES="$TMPDIR_ROOT/fixtures"
mkdir -p "$FIXTURES"
# Write a fake binary
echo "fake-binary-content" > "$FIXTURES/exarchos-linux-x64"
# Generate the sha512 for DIFFERENT content so the verification fails
echo "tampered-different-content" | sha512sum | awk '{print $1}' > "$FIXTURES/exarchos-linux-x64.sha512"

mock_uname "Linux" "x86_64"
mock_curl "$FIXTURES"

OUTPUT="$(
    HOME="$TEST_HOME" \
    EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
    EXARCHOS_LATEST_VERSION="v2.9.0" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT_UNDER_TEST" 2>&1
)" && EXIT_CODE=$? || EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
    pass "GetExarchos_ChecksumMismatch_ExitsNonZero"
else
    fail "GetExarchos_ChecksumMismatch_ExitsNonZero (expected non-zero, got 0)"
    echo "  Output: $OUTPUT"
fi

if [[ ! -f "$TEST_INSTALL/exarchos" ]]; then
    pass "GetExarchos_ChecksumMismatch_NoBinaryInstalled"
else
    fail "GetExarchos_ChecksumMismatch_NoBinaryInstalled (binary was installed despite bad checksum)"
fi

if echo "$OUTPUT" | grep -qi "checksum\|sha512\|verif"; then
    pass "GetExarchos_ChecksumMismatch_MentionsChecksumFailure"
else
    fail "GetExarchos_ChecksumMismatch_MentionsChecksumFailure (no checksum-related error message)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4b: Happy path — correct checksum → install succeeds
# --------------------------------------------------
#
# Adversarial posture: real tempfile + real sha512, no mocked validator.
setup
FIXTURES="$TMPDIR_ROOT/fixtures"
mkdir -p "$FIXTURES"
# Create a dummy binary payload
printf '#!/bin/sh\necho "exarchos dummy v2.9.0"\n' > "$FIXTURES/exarchos-linux-x64"
# Generate a REAL matching sha512 (raw hex, no filename suffix)
sha512sum "$FIXTURES/exarchos-linux-x64" | awk '{print $1}' > "$FIXTURES/exarchos-linux-x64.sha512"

mock_uname "Linux" "x86_64"
mock_curl "$FIXTURES"

OUTPUT="$(
    HOME="$TEST_HOME" \
    EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
    EXARCHOS_LATEST_VERSION="v2.9.0" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT_UNDER_TEST" 2>&1
)" && EXIT_CODE=$? || EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    pass "GetExarchos_HappyPath_InstallSucceeds"
else
    fail "GetExarchos_HappyPath_InstallSucceeds (exit=$EXIT_CODE)"
    echo "  Output: $OUTPUT"
fi

if [[ -x "$TEST_INSTALL/exarchos" ]]; then
    pass "GetExarchos_HappyPath_BinaryInstalledExecutable"
else
    fail "GetExarchos_HappyPath_BinaryInstalledExecutable (binary missing or not executable)"
fi
teardown

# --------------------------------------------------
# Test 5: GetExarchos_PathAppend_Bashrc
# --------------------------------------------------
setup
FIXTURES="$TMPDIR_ROOT/fixtures"
mkdir -p "$FIXTURES"
printf '#!/bin/sh\necho exarchos\n' > "$FIXTURES/exarchos-linux-x64"
sha512sum "$FIXTURES/exarchos-linux-x64" | awk '{print $1}' > "$FIXTURES/exarchos-linux-x64.sha512"
# Ensure empty bashrc exists
touch "$TEST_HOME/.bashrc"

mock_uname "Linux" "x86_64"
mock_curl "$FIXTURES"

HOME="$TEST_HOME" \
EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
EXARCHOS_LATEST_VERSION="v2.9.0" \
PATH="$FAKE_BIN:$PATH" \
bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1 && INSTALL_EXIT=$? || INSTALL_EXIT=$?

if grep -q ">>> exarchos >>>" "$TEST_HOME/.bashrc" && \
   grep -q "<<< exarchos <<<" "$TEST_HOME/.bashrc" && \
   grep -q "$TEST_INSTALL" "$TEST_HOME/.bashrc"; then
    pass "GetExarchos_PathAppend_Bashrc"
else
    fail "GetExarchos_PathAppend_Bashrc (marker block missing or install dir not referenced)"
    echo "  .bashrc content:"
    cat "$TEST_HOME/.bashrc" | sed 's/^/    /'
fi

# Idempotence: second invocation MUST NOT duplicate the block
HOME="$TEST_HOME" \
EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
EXARCHOS_LATEST_VERSION="v2.9.0" \
PATH="$FAKE_BIN:$PATH" \
bash "$SCRIPT_UNDER_TEST" >/dev/null 2>&1 || true

MARKER_COUNT=$(grep -c ">>> exarchos >>>" "$TEST_HOME/.bashrc" || true)
if [[ "$MARKER_COUNT" -eq 1 ]]; then
    pass "GetExarchos_PathAppend_Idempotent"
else
    fail "GetExarchos_PathAppend_Idempotent (marker count=$MARKER_COUNT, expected 1)"
fi
teardown

# --------------------------------------------------
# Test 6: GetExarchos_VersionFlag_PinsRelease
# --------------------------------------------------
setup
FIXTURES="$TMPDIR_ROOT/fixtures"
mkdir -p "$FIXTURES"
printf '#!/bin/sh\necho exarchos\n' > "$FIXTURES/exarchos-linux-x64"
sha512sum "$FIXTURES/exarchos-linux-x64" | awk '{print $1}' > "$FIXTURES/exarchos-linux-x64.sha512"
# Reset URL log
: > "$FIXTURES/.requested_urls"

mock_uname "Linux" "x86_64"
mock_curl "$FIXTURES"

HOME="$TEST_HOME" \
EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
PATH="$FAKE_BIN:$PATH" \
bash "$SCRIPT_UNDER_TEST" --version v2.9.0-rc1 >/dev/null 2>&1 || true

if grep -q "download/v2.9.0-rc1/" "$FIXTURES/.requested_urls"; then
    pass "GetExarchos_VersionFlag_PinsRelease"
else
    fail "GetExarchos_VersionFlag_PinsRelease (no request to download/v2.9.0-rc1/ path)"
    echo "  Requested URLs:"
    cat "$FIXTURES/.requested_urls" | sed 's/^/    /'
fi

# Version flag MUST NOT hit the latest-release API
if grep -q "api.github.com" "$FIXTURES/.requested_urls"; then
    fail "GetExarchos_VersionFlag_SkipsLatestApi (unexpectedly hit GitHub API)"
else
    pass "GetExarchos_VersionFlag_SkipsLatestApi"
fi
teardown

# --------------------------------------------------
# Test 7: GetExarchos_GithubActionsMode_WritesGithubPath
# --------------------------------------------------
setup
FIXTURES="$TMPDIR_ROOT/fixtures"
mkdir -p "$FIXTURES"
printf '#!/bin/sh\necho exarchos\n' > "$FIXTURES/exarchos-linux-x64"
sha512sum "$FIXTURES/exarchos-linux-x64" | awk '{print $1}' > "$FIXTURES/exarchos-linux-x64.sha512"

GH_PATH_FILE="$TMPDIR_ROOT/github_path"
: > "$GH_PATH_FILE"

mock_uname "Linux" "x86_64"
mock_curl "$FIXTURES"

HOME="$TEST_HOME" \
EXARCHOS_INSTALL_DIR="$TEST_INSTALL" \
EXARCHOS_LATEST_VERSION="v2.9.0" \
GITHUB_PATH="$GH_PATH_FILE" \
PATH="$FAKE_BIN:$PATH" \
bash "$SCRIPT_UNDER_TEST" --github-actions >/dev/null 2>&1 && GH_EXIT=$? || GH_EXIT=$?

if [[ $GH_EXIT -eq 0 ]]; then
    pass "GetExarchos_GithubActionsMode_ExitsZero"
else
    fail "GetExarchos_GithubActionsMode_ExitsZero (exit=$GH_EXIT)"
fi

if grep -q "$TEST_INSTALL" "$GH_PATH_FILE"; then
    pass "GetExarchos_GithubActionsMode_WritesGithubPath"
else
    fail "GetExarchos_GithubActionsMode_WritesGithubPath (install dir not found in \$GITHUB_PATH file)"
    echo "  GITHUB_PATH file contents:"
    cat "$GH_PATH_FILE" | sed 's/^/    /'
fi

# GitHub Actions mode MUST NOT mutate user rc files
if [[ ! -s "$TEST_HOME/.bashrc" ]] 2>/dev/null && \
   [[ ! -s "$TEST_HOME/.zshrc" ]] 2>/dev/null; then
    pass "GetExarchos_GithubActionsMode_DoesNotTouchRcFiles"
else
    # Either file may not exist; only fail if any contains the exarchos marker
    RC_TOUCHED=0
    for rc in "$TEST_HOME/.bashrc" "$TEST_HOME/.zshrc"; do
        if [[ -f "$rc" ]] && grep -q ">>> exarchos >>>" "$rc"; then
            RC_TOUCHED=1
        fi
    done
    if [[ $RC_TOUCHED -eq 0 ]]; then
        pass "GetExarchos_GithubActionsMode_DoesNotTouchRcFiles"
    else
        fail "GetExarchos_GithubActionsMode_DoesNotTouchRcFiles (rc file was modified)"
    fi
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
