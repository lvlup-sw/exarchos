#!/usr/bin/env bash
#
# extract-task.sh - Extract single task from implementation plan
#
# Usage: extract-task.sh <plan-path> <task-id>
#
# Output: Just the task section from the plan, not the full document.
#         This reduces context by ~90% when delegating tasks.
#
# Examples:
#   extract-task.sh docs/plans/2026-01-05-auth.md 001
#   extract-task.sh docs/plans/2026-01-05-auth.md A1
#

set -euo pipefail

PLAN="${1:-}"
TASK_ID="${2:-}"

if [ -z "$PLAN" ] || [ -z "$TASK_ID" ]; then
    echo "Usage: extract-task.sh <plan-path> <task-id>" >&2
    exit 2
fi

if [ ! -f "$PLAN" ]; then
    echo "ERROR: Plan file not found: $PLAN" >&2
    exit 1
fi

# Extract task section using awk
# Matches: ### Task 001, ### Task A1, ### Task 1:, etc.
# Stops at next task header or major section header

awk -v task_id="$TASK_ID" '
    BEGIN {
        found = 0
        # Build pattern to match task header
        # Handles: "### Task 001:", "### Task A1:", "## Task 1", etc.
        pattern = "^##+ *Task *" task_id "([: ]|$)"
    }

    # Start capturing when we find the task
    $0 ~ pattern {
        found = 1
        print
        next
    }

    # Stop at next task or major section
    found && /^##+ *(Task [0-9A-Za-z]+|[A-Z])/ {
        exit
    }

    # Print while capturing
    found {
        print
    }
' "$PLAN"

# Check if we found anything
if ! grep -qE "^##+ *Task *$TASK_ID([: ]|$)" "$PLAN"; then
    echo "WARNING: Task $TASK_ID not found in $PLAN" >&2
    echo "" >&2
    echo "Available tasks:" >&2
    grep -E "^##+ *Task " "$PLAN" | head -20 >&2
    exit 1
fi
