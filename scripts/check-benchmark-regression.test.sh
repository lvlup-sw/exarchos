#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-benchmark-regression.sh"
PASS=0
FAIL=0
TMPDIR_BASE=$(mktemp -d)

cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

assert_exit() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$actual" -eq "$expected" ]]; then
        echo "PASS: $name (exit $actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $name (expected exit $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

# ── Test 1: Usage error (no args) ──
echo "--- Test 1: Usage error ---"
set +e
"$SCRIPT" 2>/dev/null
exit1=$?
set -e
assert_exit "No arguments → exit 2" 2 "$exit1"

# ── Test 2: Pass scenario (no regressions) ──
echo "--- Test 2: Pass scenario ---"
TDIR="$TMPDIR_BASE/test2"
mkdir -p "$TDIR"
cat > "$TDIR/results.json" << 'EOF'
{
  "event-store-query": { "p99_ms": 44.0 },
  "view-materialize": { "p99_ms": 18.0 }
}
EOF
cat > "$TDIR/baselines.json" << 'EOF'
{
  "version": "1.0.0",
  "generated": "2026-02-16",
  "baselines": {
    "event-store-query": { "p50_ms": 12, "p95_ms": 28, "p99_ms": 45.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 },
    "view-materialize": { "p50_ms": 8, "p95_ms": 15, "p99_ms": 20.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 }
  }
}
EOF
set +e
"$SCRIPT" --results "$TDIR/results.json" --baselines "$TDIR/baselines.json" > "$TDIR/output.md" 2>&1
exit2=$?
set -e
assert_exit "No regressions → exit 0" 0 "$exit2"

# ── Test 3: Fail scenario (regression detected) ──
echo "--- Test 3: Regression detected ---"
TDIR="$TMPDIR_BASE/test3"
mkdir -p "$TDIR"
cat > "$TDIR/results.json" << 'EOF'
{
  "event-store-query": { "p99_ms": 62.0 }
}
EOF
cat > "$TDIR/baselines.json" << 'EOF'
{
  "version": "1.0.0",
  "generated": "2026-02-16",
  "baselines": {
    "event-store-query": { "p50_ms": 12, "p95_ms": 28, "p99_ms": 45.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 }
  }
}
EOF
set +e
"$SCRIPT" --results "$TDIR/results.json" --baselines "$TDIR/baselines.json" > "$TDIR/output.md" 2>&1
exit3=$?
set -e
assert_exit "Regression above threshold → exit 1" 1 "$exit3"

# ── Test 4: Custom threshold (15% above with 20% threshold → pass) ──
echo "--- Test 4: Custom threshold ---"
TDIR="$TMPDIR_BASE/test4"
mkdir -p "$TDIR"
cat > "$TDIR/results.json" << 'EOF'
{
  "event-store-query": { "p99_ms": 51.0 }
}
EOF
cat > "$TDIR/baselines.json" << 'EOF'
{
  "version": "1.0.0",
  "generated": "2026-02-16",
  "baselines": {
    "event-store-query": { "p50_ms": 12, "p95_ms": 28, "p99_ms": 45.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 }
  }
}
EOF
set +e
"$SCRIPT" --results "$TDIR/results.json" --baselines "$TDIR/baselines.json" --threshold 20 > "$TDIR/output.md" 2>&1
exit4=$?
set -e
assert_exit "13% regression with 20% threshold → exit 0" 0 "$exit4"

# ── Test 5: Improvement detection ──
echo "--- Test 5: Improvement detection ---"
TDIR="$TMPDIR_BASE/test5"
mkdir -p "$TDIR"
cat > "$TDIR/results.json" << 'EOF'
{
  "event-store-query": { "p99_ms": 25.0 }
}
EOF
cat > "$TDIR/baselines.json" << 'EOF'
{
  "version": "1.0.0",
  "generated": "2026-02-16",
  "baselines": {
    "event-store-query": { "p50_ms": 12, "p95_ms": 28, "p99_ms": 45.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 }
  }
}
EOF
set +e
output=$("$SCRIPT" --results "$TDIR/results.json" --baselines "$TDIR/baselines.json" 2>&1)
exit5=$?
set -e
assert_exit "Improvement → exit 0" 0 "$exit5"
if echo "$output" | grep -qi "improv"; then
    echo "PASS: Output mentions improvement"
    PASS=$((PASS + 1))
else
    echo "FAIL: Output should mention improvement"
    FAIL=$((FAIL + 1))
fi

# ── Test 6: Zero baseline (should skip, not crash) ──
echo "--- Test 6: Zero baseline ---"
TDIR="$TMPDIR_BASE/test6"
mkdir -p "$TDIR"
cat > "$TDIR/results.json" << 'EOF'
{
  "event-store-query": { "p99_ms": 44.0 },
  "new-operation": { "p99_ms": 12.0 }
}
EOF
cat > "$TDIR/baselines.json" << 'EOF'
{
  "version": "1.0.0",
  "generated": "2026-02-16",
  "baselines": {
    "event-store-query": { "p99_ms": 45.0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 },
    "new-operation": { "p99_ms": 0, "measured_at": "2026-02-16T00:00:00Z", "commit": "abc123", "iterations": 100 }
  }
}
EOF
set +e
output=$("$SCRIPT" --results "$TDIR/results.json" --baselines "$TDIR/baselines.json" 2>&1)
exit6=$?
set -e
assert_exit "Zero baseline → exit 0 (skip, not crash)" 0 "$exit6"
if echo "$output" | grep -qi "SKIP"; then
    echo "PASS: Output contains SKIP for zero-baseline metric"
    PASS=$((PASS + 1))
else
    echo "FAIL: Output should contain SKIP for zero-baseline metric"
    FAIL=$((FAIL + 1))
fi

# ── Summary ──
echo ""
echo "==========================="
echo "Results: $PASS passed, $FAIL failed"
echo "==========================="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
