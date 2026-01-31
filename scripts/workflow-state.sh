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
#   next-action <state-file> Determine next auto-continue action
#

set -euo pipefail

# Auto-detect repo root - works from any directory within a git repo
# Priority: 1) Git root of current directory, 2) Current directory
# Note: We intentionally use current directory's git root, not script location,
# because state files belong to the project being worked on, not lvlup-claude.
if git rev-parse --show-toplevel &>/dev/null; then
    REPO_ROOT="$(git rev-parse --show-toplevel)"
else
    REPO_ROOT="$(pwd)"
fi

STATE_DIR="$REPO_ROOT/docs/workflow-state"

# Resolve state file paths - handle both relative and absolute paths
resolve_state_file() {
    local input="$1"
    if [[ "$input" == /* ]]; then
        # Absolute path - use as-is
        echo "$input"
    elif [[ "$input" == docs/workflow-state/* ]]; then
        # Relative from repo root
        echo "$REPO_ROOT/$input"
    elif [[ "$input" == *.state.json ]]; then
        # Just filename - prepend STATE_DIR
        echo "$STATE_DIR/$input"
    else
        # Assume relative from repo root
        echo "$REPO_ROOT/$input"
    fi
}

usage() {
    echo "Usage: workflow-state.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  init <feature-id> [--debug]    Create new state file (--debug for debug workflow)"
    echo "  list                           List all active workflows"
    echo "  get <state-file> [jq-query]    Read state (optionally with jq)"
    echo "  set <state-file> <jq-filter>   Update state using jq filter"
    echo "  summary <state-file>           Output minimal summary"
    echo "  reconcile <state-file>         Verify state matches reality"
    echo "  next-action <state-file>       Determine next auto-continue action"
    exit 1
}

# Initialize a new workflow state file
# Usage: init <feature-id> [--debug]
cmd_init() {
    local feature_id="$1"
    local workflow_type="${2:-feature}"
    local state_file="$STATE_DIR/${feature_id}.state.json"
    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Check for --debug flag
    if [ "$workflow_type" = "--debug" ]; then
        workflow_type="debug"
    fi

    if [ -f "$state_file" ]; then
        echo "ERROR: State file already exists: $state_file" >&2
        exit 1
    fi

    # Ensure state directory exists
    mkdir -p "$STATE_DIR"

    if [ "$workflow_type" = "debug" ]; then
        # Debug workflow state
        cat > "$state_file" << EOF
{
  "version": "1.0",
  "featureId": "$feature_id",
  "workflowType": "debug",
  "createdAt": "$now",
  "updatedAt": "$now",
  "track": null,
  "phase": "triage",
  "urgency": {
    "level": null,
    "justification": null
  },
  "triage": {
    "symptom": null,
    "reproduction": null,
    "affectedArea": null,
    "impact": null
  },
  "investigation": {
    "startedAt": null,
    "completedAt": null,
    "rootCause": null,
    "findings": []
  },
  "artifacts": {
    "rca": null,
    "fixDesign": null,
    "pr": null
  },
  "followUp": {
    "rcaRequired": false,
    "issueUrl": null
  },
  "tasks": [],
  "worktrees": {},
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
    else
        # Feature workflow state (default)
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
    fi

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
    local state_file
    state_file="$(resolve_state_file "$1")"
    local query="${2:-.}"

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    jq "$query" "$state_file"
}

# Update state using jq filter
cmd_set() {
    local state_file
    state_file="$(resolve_state_file "$1")"
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
    local state_file
    state_file="$(resolve_state_file "$1")"

    if [ ! -f "$state_file" ]; then
        echo "ERROR: State file not found: $state_file" >&2
        exit 1
    fi

    local feature
    local phase
    local updated
    local workflow_type
    local pr
    local total_tasks
    local complete_tasks
    feature=$(jq -r '.featureId' "$state_file")
    phase=$(jq -r '.phase' "$state_file")
    updated=$(jq -r '.updatedAt' "$state_file")
    workflow_type=$(jq -r '.workflowType // "feature"' "$state_file")
    pr=$(jq -r '.artifacts.pr // .synthesis.prUrl // "not created"' "$state_file")
    total_tasks=$(jq '.tasks | length' "$state_file")
    complete_tasks=$(jq '[.tasks[] | select(.status == "complete")] | length' "$state_file")

    echo "## Workflow Context Restored"
    echo ""
    echo "**Feature:** $feature"
    echo "**Phase:** $phase"
    echo "**Last Updated:** $updated"

    # Debug-specific context
    if [ "$workflow_type" = "debug" ]; then
        local track=$(jq -r '.track // "not selected"' "$state_file")
        local urgency=$(jq -r '.urgency.level // "not set"' "$state_file")
        local symptom=$(jq -r '.triage.symptom // "not captured"' "$state_file")
        local root_cause=$(jq -r '.investigation.rootCause // "not found"' "$state_file")
        local rca=$(jq -r '.artifacts.rca // "not created"' "$state_file")

        echo "**Type:** Debug ($track track)"
        echo "**Urgency:** $urgency"
        echo ""
        echo "### Debug Context"
        echo "- Symptom: $symptom"
        echo "- Root Cause: $root_cause"
        echo "- RCA: \`$rca\`"
        echo "- PR: $pr"
    else
        local design=$(jq -r '.artifacts.design // "not created"' "$state_file")
        local plan=$(jq -r '.artifacts.plan // "not created"' "$state_file")

        echo ""
        echo "### Artifacts"
        echo "- Design: \`$design\`"
        echo "- Plan: \`$plan\`"
        echo "- PR: $pr"
    fi

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

    # Debug investigation findings
    if [ "$workflow_type" = "debug" ]; then
        local findings
        findings=$(jq -r '.investigation.findings // [] | .[]' "$state_file" | head -5)
        if [ -n "$findings" ]; then
            echo "### Investigation Findings"
            echo "$findings" | while read -r finding; do
                echo "- $finding"
            done
            echo ""
        fi
    fi

    # Suggest next action
    echo "### Next Action"

    if [ "$workflow_type" = "debug" ]; then
        local track=$(jq -r '.track // ""' "$state_file")
        case "$phase" in
            triage)
                echo "Complete triage and select track (hotfix/thorough)"
                ;;
            investigate)
                if [ "$track" = "hotfix" ]; then
                    echo "Find root cause (15 min limit) or switch to thorough track"
                else
                    echo "Continue systematic investigation"
                fi
                ;;
            rca)
                echo "Complete RCA documentation in docs/rca/"
                ;;
            design)
                echo "Document fix approach"
                ;;
            implement)
                echo "Apply fix (TDD for thorough track)"
                ;;
            validate)
                if [ "$track" = "hotfix" ]; then
                    echo "Run smoke tests and verify fix"
                else
                    echo "Run full test suite before spec review"
                fi
                ;;
            review)
                echo "Complete spec review"
                ;;
            synthesize)
                if [ "$pr" != "not created" ]; then
                    echo "PR created. Confirm merge or request changes."
                else
                    echo "Create PR for fix"
                fi
                ;;
            completed)
                echo "Workflow complete"
                ;;
            *)
                echo "Check state file for details"
                ;;
        esac
    else
        local plan=$(jq -r '.artifacts.plan // "not created"' "$state_file")
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
    fi
}

# Reconcile state with reality (git worktrees, Jules sessions)
cmd_reconcile() {
    local state_file
    state_file="$(resolve_state_file "$1")"

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

# Determine next auto-continue action based on current state
cmd_next_action() {
    local state_file
    state_file="$(resolve_state_file "$1")"

    if [ ! -f "$state_file" ]; then
        echo "ERROR:state-not-found"
        exit 1
    fi

    local phase=$(jq -r '.phase' "$state_file")
    local workflow_type=$(jq -r '.workflowType // "feature"' "$state_file")
    local pr=$(jq -r '.synthesis.prUrl // .artifacts.pr // ""' "$state_file")
    local total_tasks=$(jq '.tasks | length' "$state_file")
    local complete_tasks=$(jq '[.tasks[] | select(.status == "complete")] | length' "$state_file")

    # Handle debug workflows
    if [ "$workflow_type" = "debug" ]; then
        local track=$(jq -r '.track // ""' "$state_file")
        local root_cause=$(jq -r '.investigation.rootCause // ""' "$state_file")

        case "$phase" in
            triage)
                # Auto-continue to investigate after triage
                if [ -n "$track" ] && [ "$track" != "null" ]; then
                    echo "AUTO:debug-investigate"
                else
                    echo "WAIT:incomplete:track-not-selected"
                fi
                ;;
            investigate)
                if [ -n "$root_cause" ] && [ "$root_cause" != "null" ]; then
                    # Root cause found
                    if [ "$track" = "hotfix" ]; then
                        echo "AUTO:debug-implement"
                    else
                        echo "AUTO:debug-rca"
                    fi
                else
                    echo "WAIT:in-progress:investigating"
                fi
                ;;
            rca)
                local rca=$(jq -r '.artifacts.rca // ""' "$state_file")
                if [ -n "$rca" ] && [ "$rca" != "null" ]; then
                    echo "AUTO:debug-design"
                else
                    echo "WAIT:in-progress:documenting-rca"
                fi
                ;;
            design)
                local fix_design=$(jq -r '.artifacts.fixDesign // ""' "$state_file")
                if [ -n "$fix_design" ] && [ "$fix_design" != "null" ]; then
                    echo "AUTO:debug-implement"
                else
                    echo "WAIT:in-progress:designing-fix"
                fi
                ;;
            implement)
                # Check if implementation is complete
                # Auto-advance if: all tasks complete OR no tasks (direct implementation)
                local fix_design
                fix_design=$(jq -r '.artifacts.fixDesign // ""' "$state_file")
                if [ "$total_tasks" -eq 0 ] && [ -n "$fix_design" ] && [ "$fix_design" != "null" ]; then
                    # No tasks but fix design exists - direct implementation, auto-advance
                    echo "AUTO:debug-validate"
                elif [ "$total_tasks" -gt 0 ] && [ "$complete_tasks" -eq "$total_tasks" ]; then
                    # All tasks complete
                    echo "AUTO:debug-validate"
                else
                    echo "WAIT:in-progress:implementing"
                fi
                ;;
            validate)
                if [ "$track" = "hotfix" ]; then
                    # Hotfix: human checkpoint for merge
                    echo "WAIT:human-checkpoint:hotfix-merge"
                else
                    echo "AUTO:debug-review"
                fi
                ;;
            review)
                # After review, go to synthesize
                echo "AUTO:debug-synthesize"
                ;;
            synthesize)
                if [ -n "$pr" ] && [ "$pr" != "null" ] && [ "$pr" != "" ]; then
                    echo "WAIT:human-checkpoint:merge-confirmation"
                else
                    echo "WAIT:incomplete:pr-not-created"
                fi
                ;;
            completed)
                echo "DONE"
                ;;
            blocked)
                echo "WAIT:blocked:requires-escalation"
                ;;
            *)
                echo "UNKNOWN:debug-$phase"
                ;;
        esac
        return
    fi

    # Handle feature workflows (original logic)
    local plan=$(jq -r '.artifacts.plan // ""' "$state_file")

    # Check review status
    local spec_pending=$(jq '[.tasks[] | select(.reviewStatus.specReview == null or .reviewStatus.specReview == "pending")] | length' "$state_file")
    local spec_failed=$(jq '[.tasks[] | select(.reviewStatus.specReview == "fail")] | length' "$state_file")
    local quality_pending=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == null or .reviewStatus.qualityReview == "pending")] | length' "$state_file")
    local quality_failed=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == "needs_fixes" or .reviewStatus.qualityReview == "blocked")] | length' "$state_file")

    case "$phase" in
        ideate)
            # Human checkpoint - design confirmation
            echo "WAIT:human-checkpoint:design-confirmation"
            ;;
        plan)
            if [ -n "$plan" ] && [ "$plan" != "null" ]; then
                # Plan saved, auto-continue to delegate
                echo "AUTO:delegate:$plan"
            else
                echo "WAIT:incomplete:plan-not-saved"
            fi
            ;;
        delegate)
            if [ "$total_tasks" -eq 0 ]; then
                echo "WAIT:incomplete:no-tasks-defined"
            elif [ "$complete_tasks" -eq "$total_tasks" ]; then
                # All tasks complete, auto-continue to review
                echo "AUTO:review:$plan"
            else
                echo "WAIT:in-progress:tasks-$complete_tasks-of-$total_tasks"
            fi
            ;;
        review)
            if [ "$spec_failed" -gt 0 ] || [ "$quality_failed" -gt 0 ]; then
                # Review failed, auto-continue to fixes
                echo "AUTO:delegate:--fixes $plan"
            elif [ "$spec_pending" -gt 0 ] || [ "$quality_pending" -gt 0 ]; then
                # Reviews still pending
                echo "WAIT:in-progress:reviews-pending"
            else
                # All reviews passed, auto-continue to synthesize
                local feature=$(jq -r '.featureId' "$state_file")
                echo "AUTO:synthesize:$feature"
            fi
            ;;
        synthesize)
            if [ -n "$pr" ] && [ "$pr" != "null" ] && [ "$pr" != "" ]; then
                # PR created - human checkpoint for merge confirmation
                echo "WAIT:human-checkpoint:merge-confirmation"
            else
                echo "WAIT:incomplete:pr-not-created"
            fi
            ;;
        completed)
            echo "DONE"
            ;;
        blocked)
            echo "WAIT:blocked:requires-redesign"
            ;;
        *)
            echo "UNKNOWN:$phase"
            ;;
    esac
}

# Main dispatcher
case "${1:-}" in
    init)
        [ -n "${2:-}" ] || usage
        cmd_init "$2" "${3:-}"
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
    next-action)
        [ -n "${2:-}" ] || usage
        cmd_next_action "$2"
        ;;
    *)
        usage
        ;;
esac
