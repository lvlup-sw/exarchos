#!/usr/bin/env bash
#
# workflow-state.sh - Workflow state management utilities
#
# Commands:
#   init <feature-id>     Create new state file
#   list                  List all active workflows
#   get <state-file> [jq-query]  Read state (optionally with jq query)
#   set <state-file> <jq-filter> Update state using jq filter
#   summary <state-file>  Output minimal summary for context restoration
#   reconcile <state-file> Verify state matches reality
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$REPO_ROOT/docs/workflow-state"

usage() {
    echo "Usage: workflow-state.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  init <feature-id>              Create new state file"
    echo "  list                           List all active workflows"
    echo "  get <state-file> [jq-query]    Read state (optionally with jq)"
    echo "  set <state-file> <jq-filter>   Update state using jq filter"
    echo "  summary <state-file>           Output minimal summary"
    echo "  reconcile <state-file>         Verify state matches reality"
    exit 1
}

# Initialize a new workflow state file
cmd_init() {
    local feature_id="$1"
    local state_file="$STATE_DIR/${feature_id}.state.json"
    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [ -f "$state_file" ]; then
        echo "ERROR: State file already exists: $state_file" >&2
        exit 1
    fi

    cat > "$state_file" << EOF
{
  "version": "1.0",
  "featureId": "$feature_id",
  "createdAt": "$now",
  "updatedAt": "$now",
  "phase": "ideate",
  "artifacts": {
    "design": null,
    "plan": null,
    "pr": null
  },
  "tasks": [],
  "worktrees": {},
  "julesSessions": {},
  "reviews": {},
  "synthesis": {
    "integrationBranch": null,
    "mergeOrder": [],
    "mergedBranches": [],
    "prUrl": null,
    "prFeedback": []
  }
}
EOF

    echo "Created: $state_file"
}

# List all active (non-completed) workflows
cmd_list() {
    echo "Active Workflows:"
    echo ""

    for f in "$STATE_DIR"/*.state.json; do
        [ -f "$f" ] || continue
        local feature=$(jq -r '.featureId' "$f")
        local phase=$(jq -r '.phase' "$f")
        local updated=$(jq -r '.updatedAt' "$f")

        if [ "$phase" != "completed" ]; then
            printf "  %-30s %-12s %s\n" "$feature" "[$phase]" "$updated"
        fi
    done
}

# Get state or specific field
cmd_get() {
    local state_file="$1"
    local query="${2:-.}"

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    jq "$query" "$state_file"
}

# Update state using jq filter
cmd_set() {
    local state_file="$1"
    local filter="$2"
    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    # Update with new value and timestamp
    local tmp=$(mktemp)
    jq "$filter | .updatedAt = \"$now\"" "$state_file" > "$tmp"
    mv "$tmp" "$state_file"

    echo "Updated: $state_file"
}

# Output minimal summary for context restoration
cmd_summary() {
    local state_file="$1"

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    local feature=$(jq -r '.featureId' "$state_file")
    local phase=$(jq -r '.phase' "$state_file")
    local updated=$(jq -r '.updatedAt' "$state_file")
    local design=$(jq -r '.artifacts.design // "not created"' "$state_file")
    local plan=$(jq -r '.artifacts.plan // "not created"' "$state_file")
    local pr=$(jq -r '.artifacts.pr // "not created"' "$state_file")
    local total_tasks=$(jq '.tasks | length' "$state_file")
    local complete_tasks=$(jq '[.tasks[] | select(.status == "complete")] | length' "$state_file")

    echo "## Workflow Context Restored"
    echo ""
    echo "**Feature:** $feature"
    echo "**Phase:** $phase"
    echo "**Last Updated:** $updated"
    echo ""
    echo "### Artifacts"
    echo "- Design: \`$design\`"
    echo "- Plan: \`$plan\`"
    echo "- PR: $pr"
    echo ""
    echo "### Task Progress"
    echo "- Completed: $complete_tasks / $total_tasks"
    echo ""

    # List incomplete tasks
    local pending=$(jq -r '.tasks[] | select(.status != "complete") | "- [\(.status)] \(.id): \(.title)"' "$state_file")
    if [ -n "$pending" ]; then
        echo "### Pending Tasks"
        echo "$pending"
        echo ""
    fi

    # List active worktrees
    local worktrees=$(jq -r '.worktrees | to_entries[] | select(.value.status == "active") | "- \(.key) (\(.value.branch))"' "$state_file")
    if [ -n "$worktrees" ]; then
        echo "### Active Worktrees"
        echo "$worktrees"
        echo ""
    fi

    # Suggest next action
    echo "### Next Action"
    case "$phase" in
        ideate)
            echo "Continue design exploration or run \`/plan\`"
            ;;
        plan)
            echo "Run \`/delegate $plan\`"
            ;;
        delegate)
            if [ "$complete_tasks" -eq "$total_tasks" ]; then
                echo "All tasks complete. Run \`/review $plan\`"
            else
                echo "Monitor task completion, then run \`/review\`"
            fi
            ;;
        review)
            echo "Address review issues or run \`/synthesize\`"
            ;;
        synthesize)
            if [ "$pr" != "not created" ]; then
                echo "PR created. Merge or address feedback with \`/delegate --pr-fixes $pr\`"
            else
                echo "Run \`/synthesize\` to create PR"
            fi
            ;;
        *)
            echo "Check state file for details"
            ;;
    esac
}

# Reconcile state with reality (git worktrees, Jules sessions)
cmd_reconcile() {
    local state_file="$1"

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    echo "Reconciling state with reality..."
    echo ""

    # Check worktrees
    echo "## Git Worktrees"
    local state_worktrees=$(jq -r '.worktrees | keys[]' "$state_file" 2>/dev/null || true)
    local actual_worktrees=$(git worktree list --porcelain 2>/dev/null | grep "^worktree " | cut -d' ' -f2 || true)

    for wt in $state_worktrees; do
        if echo "$actual_worktrees" | grep -q "$wt"; then
            echo "  [OK] $wt exists"
        else
            echo "  [MISSING] $wt not found"
        fi
    done

    # Check branches
    echo ""
    echo "## Git Branches"
    local branches=$(jq -r '.tasks[].branch // empty' "$state_file")
    for branch in $branches; do
        if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
            echo "  [OK] $branch exists"
        else
            echo "  [MISSING] $branch not found"
        fi
    done

    echo ""
    echo "Reconciliation complete."
}

# Main dispatcher
case "${1:-}" in
    init)
        [ -n "${2:-}" ] || usage
        cmd_init "$2"
        ;;
    list)
        cmd_list
        ;;
    get)
        [ -n "${2:-}" ] || usage
        cmd_get "$2" "${3:-.}"
        ;;
    set)
        [ -n "${2:-}" ] && [ -n "${3:-}" ] || usage
        cmd_set "$2" "$3"
        ;;
    summary)
        [ -n "${2:-}" ] || usage
        cmd_summary "$2"
        ;;
    reconcile)
        [ -n "${2:-}" ] || usage
        cmd_reconcile "$2"
        ;;
    *)
        usage
        ;;
esac
