#!/usr/bin/env bash
# npm-ci-retry.test.sh — assertions for scripts/npm-ci-retry.sh.
#
# Exercises the success, retry-then-success, exhaust-all-attempts, and
# stall-killed-then-recover paths using a fake `npm` on PATH — no real network
# or `npm install`. Run directly: `bash scripts/npm-ci-retry.test.sh`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/npm-ci-retry.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# Write a fake `npm` into $1 whose behaviour is driven by $FAKE_MODE at call
# time, counting invocations into $FAKE_COUNT_FILE.
make_fake_npm() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/npm" <<'FAKE'
#!/usr/bin/env bash
count=0
[ -f "$FAKE_COUNT_FILE" ] && count="$(cat "$FAKE_COUNT_FILE")"
count=$((count + 1))
echo "$count" > "$FAKE_COUNT_FILE"
# Surface the env the wrapper handed us so tests can assert install-time policy
# (e.g. the Playwright browser-download skip). Captured in OUT.
echo "ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-<unset>}"
case "$FAKE_MODE" in
  succeed)            exit 0 ;;
  fail)               exit 1 ;;
  fail-then-succeed)  [ "$count" -ge 2 ] && exit 0 || exit 1 ;;
  stall-then-succeed) # 1st call ignores SIGTERM and hangs (must be SIGKILLed
                      # by `timeout -k`); later calls succeed.
                      if [ "$count" -ge 2 ]; then exit 0; fi
                      trap '' TERM; sleep 30 ;;
  *) echo "unknown FAKE_MODE: $FAKE_MODE" >&2; exit 99 ;;
esac
FAKE
  chmod +x "$dir/npm"
}

# run_sut <mode> <attempts> <timeout_s>
# Sets globals: OUT (combined stdout+stderr), RC (exit code), CALLS (npm count).
# An outer `timeout 30` guards against a regression that lets the SUT hang.
run_sut() {
  local mode="$1" att="$2" to="$3"
  local tmp cnt
  tmp="$(mktemp -d)"
  cnt="$tmp/count"
  : > "$cnt"
  make_fake_npm "$tmp"
  OUT="$(PATH="$tmp:$PATH" FAKE_MODE="$mode" FAKE_COUNT_FILE="$cnt" \
        NPM_CI_ATTEMPTS="$att" NPM_CI_TIMEOUT_SECONDS="$to" \
        NPM_CI_KILL_AFTER_SECONDS=1 NPM_CI_RETRY_SLEEP_SECONDS=0 \
        timeout 30 bash "$SUT" ci 2>&1)"
  RC=$?
  CALLS="$(cat "$cnt" 2>/dev/null || echo 0)"
  rm -rf "$tmp"
}

# ── Test 1: succeeds on the first attempt ───────────────────────────────────
run_sut succeed 3 5
if [ "$RC" -eq 0 ] && [ "$CALLS" -eq 1 ]; then
  pass "first-attempt success → exit 0, one npm ci call"
else
  fail "first-attempt success" "rc=$RC calls=$CALLS"
fi

# ── Test 2: fails once, then succeeds (retry path) ──────────────────────────
run_sut fail-then-succeed 3 5
if [ "$RC" -eq 0 ] && [ "$CALLS" -eq 2 ]; then
  pass "retry-then-success → exit 0 after two calls"
else
  fail "retry-then-success" "rc=$RC calls=$CALLS"
fi

# ── Test 3: exhausts all attempts → exit 1, no trailing sleep/log ───────────
run_sut fail 2 5
retry_lines="$(printf '%s\n' "$OUT" | grep -c 'retrying in' || true)"
if [ "$RC" -eq 1 ] && [ "$CALLS" -eq 2 ]; then
  pass "all-attempts-fail → exit 1 after exactly N calls"
else
  fail "all-attempts-fail exit" "rc=$RC calls=$CALLS"
fi
# attempts=2 ⇒ exactly one inter-attempt retry message (none after the last).
if [ "$retry_lines" -eq 1 ]; then
  pass "no sleep/retry after the final attempt (N-1 retry messages)"
else
  fail "no sleep after final attempt" "expected 1 'retrying' line, got $retry_lines"
fi

# ── Test 4: SIGTERM-ignoring stall is SIGKILLed, then recovers ──────────────
# Without `timeout -k`, the trap-TERM `sleep 30` would hang the attempt; the
# outer `timeout 30` in run_sut would then trip and RC would be 124.
run_sut stall-then-succeed 3 1
if [ "$RC" -eq 0 ] && [ "$CALLS" -ge 2 ]; then
  pass "stalled (SIGTERM-ignoring) attempt is killed and retried to success"
else
  fail "stall kill-after recovery" "rc=$RC calls=$CALLS (124 ⇒ SUT hung — kill-after not applied)"
fi

# ── Test 5: defaults PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ─────────────────────
# promptfoo's optional @playwright/browser-chromium postinstall downloads a
# ~150MB Chromium from the Playwright CDN — uncached, unprobed, and the cause
# of the 300s npm-ci wedge on cold runners. The wrapper must skip it by default
# (no CI job drives a browser). See RCA docs/rca/2026-05-31-npm-ci-playwright-browser-wedge.md.
run_sut succeed 1 5
if printf '%s\n' "$OUT" | grep -q 'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1'; then
  pass "wrapper defaults PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
else
  fail "default browser-download skip" "got: $(printf '%s\n' "$OUT" | grep 'ENV PLAYWRIGHT' || echo none)"
fi

# ── Test 6: a caller-set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is respected ───────
# The default is an override-able floor: a job that genuinely needs browsers
# sets =0 and the wrapper must not clobber it.
tmp6="$(mktemp -d)"; : > "$tmp6/count"; make_fake_npm "$tmp6"
OUT6="$(PATH="$tmp6:$PATH" FAKE_MODE=succeed FAKE_COUNT_FILE="$tmp6/count" \
       NPM_CI_ATTEMPTS=1 NPM_CI_TIMEOUT_SECONDS=5 NPM_CI_KILL_AFTER_SECONDS=1 \
       NPM_CI_RETRY_SLEEP_SECONDS=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
       timeout 30 bash "$SUT" ci 2>&1)"
rm -rf "$tmp6"
if printf '%s\n' "$OUT6" | grep -q 'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0'; then
  pass "caller-set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 is respected (not overridden)"
else
  fail "opt-out respected" "got: $(printf '%s\n' "$OUT6" | grep 'ENV PLAYWRIGHT' || echo none)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Test Summary ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Tests failed!"
  exit 1
fi
echo "All tests passed!"
exit 0
