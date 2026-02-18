#!/usr/bin/env bash
# verify-delegation-saga.test.sh — Tests for verify-delegation-saga.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-delegation-saga.sh"
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
STATE_DIR=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
    STATE_DIR="$TMPDIR_ROOT/workflow-state"
    mkdir -p "$STATE_DIR"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper: write events to a JSONL file for a given feature-id
write_events() {
    local feature_id="$1"
    shift
    local file="$STATE_DIR/${feature_id}.events.jsonl"
    for event in "$@"; do
        echo "$event" >> "$file"
    done
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Delegation Saga Tests ==="
echo ""

# --------------------------------------------------
# Test 1: Valid saga — full lifecycle (spawned -> planned x N -> dispatched x N -> disbanded) -> exit 0
# --------------------------------------------------
setup
write_events "valid-saga" \
    '{"streamId":"valid-saga","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":2,"taskCount":2,"dispatchMode":"agent-team"}}' \
    '{"streamId":"valid-saga","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema extension","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"valid-saga","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.task.planned","data":{"taskId":"task-002","title":"API changes","modules":["api"],"blockedBy":["task-001"]}}' \
    '{"streamId":"valid-saga","sequence":4,"timestamp":"2026-02-18T00:00:03.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001"],"model":"opus"}}' \
    '{"streamId":"valid-saga","sequence":5,"timestamp":"2026-02-18T00:00:04.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-2","worktreePath":"/path/wt2","assignedTaskIds":["task-002"],"model":"opus"}}' \
    '{"streamId":"valid-saga","sequence":6,"timestamp":"2026-02-18T00:00:05.000Z","type":"team.disbanded","data":{"reason":"all tasks complete"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id valid-saga --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidSaga_FullLifecycle_ExitsZero"
else
    fail "ValidSaga_FullLifecycle_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: Missing team.spawned before team.task.planned -> exit 1
# --------------------------------------------------
setup
write_events "missing-spawn" \
    '{"streamId":"missing-spawn","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema extension","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"missing-spawn","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id missing-spawn --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingSpawn_BeforePlanned_ExitsOne"
else
    fail "MissingSpawn_BeforePlanned_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the violation
if echo "$OUTPUT" | grep -qi "team.spawned"; then
    pass "MissingSpawn_OutputMentionsViolation"
else
    fail "MissingSpawn_OutputMentionsViolation (output does not mention team.spawned)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: Missing team.task.planned before team.teammate.dispatched -> exit 1
# --------------------------------------------------
setup
write_events "missing-plan" \
    '{"streamId":"missing-plan","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":1,"dispatchMode":"agent-team"}}' \
    '{"streamId":"missing-plan","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id missing-plan --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingPlan_BeforeDispatched_ExitsOne"
else
    fail "MissingPlan_BeforeDispatched_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the violation
if echo "$OUTPUT" | grep -qi "team.task.planned"; then
    pass "MissingPlan_OutputMentionsViolation"
else
    fail "MissingPlan_OutputMentionsViolation (output does not mention team.task.planned)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: Batched team.task.planned events validate correctly -> exit 0
# --------------------------------------------------
setup
write_events "batched-plans" \
    '{"streamId":"batched-plans","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":3,"taskCount":4,"dispatchMode":"agent-team"}}' \
    '{"streamId":"batched-plans","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Types","modules":["types"],"blockedBy":[]}}' \
    '{"streamId":"batched-plans","sequence":3,"timestamp":"2026-02-18T00:00:01.100Z","type":"team.task.planned","data":{"taskId":"task-002","title":"API","modules":["api"],"blockedBy":[]}}' \
    '{"streamId":"batched-plans","sequence":4,"timestamp":"2026-02-18T00:00:01.200Z","type":"team.task.planned","data":{"taskId":"task-003","title":"Tests","modules":["test"],"blockedBy":["task-001"]}}' \
    '{"streamId":"batched-plans","sequence":5,"timestamp":"2026-02-18T00:00:01.300Z","type":"team.task.planned","data":{"taskId":"task-004","title":"Docs","modules":["docs"],"blockedBy":[]}}' \
    '{"streamId":"batched-plans","sequence":6,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001","task-003"],"model":"opus"}}' \
    '{"streamId":"batched-plans","sequence":7,"timestamp":"2026-02-18T00:00:03.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-2","worktreePath":"/path/wt2","assignedTaskIds":["task-002"],"model":"opus"}}' \
    '{"streamId":"batched-plans","sequence":8,"timestamp":"2026-02-18T00:00:04.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-3","worktreePath":"/path/wt3","assignedTaskIds":["task-004"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id batched-plans --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "BatchedPlans_SequentialSequences_ExitsZero"
else
    fail "BatchedPlans_SequentialSequences_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: Empty event stream -> exit 2
# --------------------------------------------------
setup
# Create an empty JSONL file
touch "$STATE_DIR/empty-stream.events.jsonl"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id empty-stream --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "EmptyEventStream_ExitsTwo"
else
    fail "EmptyEventStream_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: No team events at all (only workflow events) -> exit 0
# --------------------------------------------------
setup
write_events "no-team-events" \
    '{"streamId":"no-team-events","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"workflow.started","data":{"featureId":"no-team-events","workflow":"feature"}}' \
    '{"streamId":"no-team-events","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"workflow.transition","data":{"from":"planning","to":"delegating"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id no-team-events --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NoTeamEvents_WorkflowOnly_ExitsZero"
else
    fail "NoTeamEvents_WorkflowOnly_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: Valid partial saga (spawned + planned but no dispatched yet) -> exit 0
# --------------------------------------------------
setup
write_events "partial-saga" \
    '{"streamId":"partial-saga","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":2,"taskCount":2,"dispatchMode":"agent-team"}}' \
    '{"streamId":"partial-saga","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema extension","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"partial-saga","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.task.planned","data":{"taskId":"task-002","title":"API changes","modules":["api"],"blockedBy":[]}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id partial-saga --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "PartialSaga_SpawnedAndPlanned_ExitsZero"
else
    fail "PartialSaga_SpawnedAndPlanned_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: Usage error — missing feature-id -> exit 2
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingFeatureId_ExitsTwo"
else
    fail "UsageError_MissingFeatureId_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: Usage error — event file does not exist -> exit 2
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id nonexistent --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoEventFile_ExitsTwo"
else
    fail "UsageError_NoEventFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: Unplanned task in dispatch — dispatched task-id not in planned events -> exit 1
# --------------------------------------------------
setup
write_events "unplanned-dispatch" \
    '{"streamId":"unplanned-dispatch","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":1,"dispatchMode":"agent-team"}}' \
    '{"streamId":"unplanned-dispatch","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema extension","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"unplanned-dispatch","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001","task-999"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id unplanned-dispatch --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "UnplannedDispatch_TaskNotPlanned_ExitsOne"
else
    fail "UnplannedDispatch_TaskNotPlanned_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the unplanned task
if echo "$OUTPUT" | grep -q "task-999"; then
    pass "UnplannedDispatch_OutputMentionsTaskId"
else
    fail "UnplannedDispatch_OutputMentionsTaskId (output does not mention task-999)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: team.disbanded not last team event -> exit 1
# --------------------------------------------------
setup
write_events "disbanded-not-last" \
    '{"streamId":"disbanded-not-last","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":1,"dispatchMode":"agent-team"}}' \
    '{"streamId":"disbanded-not-last","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"disbanded-not-last","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.disbanded","data":{"reason":"complete"}}' \
    '{"streamId":"disbanded-not-last","sequence":4,"timestamp":"2026-02-18T00:00:03.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-001"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id disbanded-not-last --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DisbandedNotLast_TeamEventAfter_ExitsOne"
else
    fail "DisbandedNotLast_TeamEventAfter_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "team.disbanded"; then
    pass "DisbandedNotLast_OutputMentionsViolation"
else
    fail "DisbandedNotLast_OutputMentionsViolation (output does not mention team.disbanded)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 12: Batched taskIds[] in planned event — dispatched tasks covered -> exit 0
# --------------------------------------------------
setup
write_events "batched-taskids" \
    '{"streamId":"batched-taskids","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":3,"dispatchMode":"agent-team"}}' \
    '{"streamId":"batched-taskids","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskIds":["task-A","task-B","task-C"],"title":"Batched plan","modules":["core"],"blockedBy":[]}}' \
    '{"streamId":"batched-taskids","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-A","task-B","task-C"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id batched-taskids --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "BatchedTaskIds_PlannedArray_ExitsZero"
else
    fail "BatchedTaskIds_PlannedArray_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 13: Batched taskIds[] with unplanned dispatch -> exit 1
# --------------------------------------------------
setup
write_events "batched-taskids-unplanned" \
    '{"streamId":"batched-taskids-unplanned","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":2,"dispatchMode":"agent-team"}}' \
    '{"streamId":"batched-taskids-unplanned","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskIds":["task-A","task-B"],"title":"Batched plan","modules":["core"],"blockedBy":[]}}' \
    '{"streamId":"batched-taskids-unplanned","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","assignedTaskIds":["task-A","task-X"],"model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id batched-taskids-unplanned --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "BatchedTaskIds_UnplannedDispatch_ExitsOne"
else
    fail "BatchedTaskIds_UnplannedDispatch_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "task-X"; then
    pass "BatchedTaskIds_OutputMentionsUnplannedTaskId"
else
    fail "BatchedTaskIds_OutputMentionsUnplannedTaskId (output does not mention task-X)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 14: Missing assignedTaskIds field in dispatch — no crash -> exit 0
# --------------------------------------------------
setup
write_events "missing-assigned" \
    '{"streamId":"missing-assigned","sequence":1,"timestamp":"2026-02-18T00:00:00.000Z","type":"team.spawned","data":{"teamSize":1,"taskCount":1,"dispatchMode":"agent-team"}}' \
    '{"streamId":"missing-assigned","sequence":2,"timestamp":"2026-02-18T00:00:01.000Z","type":"team.task.planned","data":{"taskId":"task-001","title":"Schema extension","modules":["workflow"],"blockedBy":[]}}' \
    '{"streamId":"missing-assigned","sequence":3,"timestamp":"2026-02-18T00:00:02.000Z","type":"team.teammate.dispatched","data":{"teammateName":"worker-1","worktreePath":"/path/wt1","model":"opus"}}'

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --feature-id missing-assigned --state-dir "$STATE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MissingAssignedTaskIds_NoCrash_ExitsZero"
else
    fail "MissingAssignedTaskIds_NoCrash_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
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
