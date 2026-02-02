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
    echo "  init <feature-id> [--debug|--refactor]  Create new state file"
    echo "  list                                     List all active workflows"
    echo "  get <state-file> [jq-query]              Read state (optionally with jq)"
    echo "  set <state-file> <jq-filter>             Update state using jq filter"
    echo "  summary <state-file>                     Output minimal summary"
    echo "  reconcile <state-file>                   Verify state matches reality"
    echo "  next-action <state-file>                 Determine next auto-continue action"
    exit 1
}

# Initialize a new workflow state file
# Usage: init <feature-id> [--debug|--refactor]
cmd_init() {
    local feature_id="$1"
    local workflow_type="${2:-feature}"
    local state_file="$STATE_DIR/${feature_id}.state.json"
    local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Check for --debug or --refactor flag
    if [ "$workflow_type" = "--debug" ]; then
        workflow_type="debug"
    elif [ "$workflow_type" = "--refactor" ]; then
        workflow_type="refactor"
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
    elif [ "$workflow_type" = "refactor" ]; then
        # Refactor workflow state
        cat > "$state_file" << EOF
{
  "version": "1.0",
  "featureId": "$feature_id",
  "workflowType": "refactor",
  "createdAt": "$now",
  "updatedAt": "$now",
  "track": null,
  "phase": "explore",
  "explore": {
    "startedAt": null,
    "completedAt": null,
    "scopeAssessment": {
      "filesAffected": [],
      "modulesAffected": [],
      "testCoverage": null,
      "recommendedTrack": null
    }
  },
  "brief": {
    "problem": null,
    "goals": [],
    "approach": null,
    "affectedAreas": [],
    "outOfScope": [],
    "successCriteria": [],
    "docsToUpdate": []
  },
  "artifacts": {
    "plan": null,
    "pr": null,
    "updatedDocs": []
  },
  "validation": {
    "testsPass": null,
    "goalsVerified": [],
    "docsUpdated": null
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
    elif [ "$workflow_type" = "refactor" ]; then
        local track=$(jq -r '.track // "not selected"' "$state_file")
        local problem=$(jq -r '.brief.problem // "not captured"' "$state_file")
        local goals_count=$(jq '.brief.goals | length' "$state_file")
        local verified_count=$(jq '.validation.goalsVerified | length' "$state_file")
        local tests_pass=$(jq -r '.validation.testsPass // "not run"' "$state_file")
        local plan=$(jq -r '.artifacts.plan // "not created"' "$state_file")

        echo "**Type:** Refactor ($track track)"
        echo ""
        echo "### Refactor Context"
        echo "- Problem: $problem"
        echo "- Goals: $goals_count defined, $verified_count verified"
        echo "- Tests: $tests_pass"
        echo "- Plan: \`$plan\`"
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

    # Refactor scope assessment
    if [ "$workflow_type" = "refactor" ]; then
        local files_count=$(jq '.explore.scopeAssessment.filesAffected | length' "$state_file")
        local modules_count=$(jq '.explore.scopeAssessment.modulesAffected | length' "$state_file")
        local recommended_track=$(jq -r '.explore.scopeAssessment.recommendedTrack // "not assessed"' "$state_file")
        if [ "$files_count" -gt 0 ] || [ "$modules_count" -gt 0 ]; then
            echo "### Scope Assessment"
            echo "- Files affected: $files_count"
            echo "- Modules affected: $modules_count"
            echo "- Recommended track: $recommended_track"
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
    elif [ "$workflow_type" = "refactor" ]; then
        local track=$(jq -r '.track // ""' "$state_file")
        case "$phase" in
            explore)
                echo "Assess scope and select track (polish/overhaul)"
                ;;
            brief)
                echo "Capture refactor intent and goals"
                ;;
            plan)
                echo "Create implementation plan"
                ;;
            delegate)
                if [ "$complete_tasks" -eq "$total_tasks" ] && [ "$total_tasks" -gt 0 ]; then
                    echo "All tasks complete. Run validation."
                else
                    echo "Monitor task completion"
                fi
                ;;
            validate)
                echo "Verify all goals met and tests pass"
                ;;
            review)
                echo "Complete spec review"
                ;;
            synthesize)
                if [ "$pr" != "not created" ]; then
                    echo "PR created. Confirm merge or request changes."
                else
                    echo "Create PR for refactor"
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
                echo "Continue design exploration (auto-chains to /plan when design saved)"
                ;;
            plan)
                echo "Continue planning (auto-chains to plan-review when plan saved)"
                ;;
            plan-review)
                echo "Review plan-design delta and approve to continue to /delegate"
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

    # Handle refactor workflows
    if [ "$workflow_type" = "refactor" ]; then
        local track=$(jq -r '.track // ""' "$state_file")
        local brief_problem=$(jq -r '.brief.problem // ""' "$state_file")
        local brief_goals_count=$(jq '.brief.goals | length' "$state_file")
        local plan=$(jq -r '.artifacts.plan // ""' "$state_file")
        local tests_pass=$(jq -r 'if .validation.testsPass == null then "" else (.validation.testsPass | tostring) end' "$state_file")
        local docs_updated=$(jq -r 'if .validation.docsUpdated == null then "" else (.validation.docsUpdated | tostring) end' "$state_file")
        local goals_verified_count=$(jq '.validation.goalsVerified | length' "$state_file")

        # Check review status for overhaul track
        local spec_pending=$(jq '[.tasks[] | select(.reviewStatus.specReview == null or .reviewStatus.specReview == "pending")] | length' "$state_file")
        local spec_failed=$(jq '[.tasks[] | select(.reviewStatus.specReview == "fail")] | length' "$state_file")
        local quality_pending=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == null or .reviewStatus.qualityReview == "pending")] | length' "$state_file")
        local quality_failed=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == "needs_fixes" or .reviewStatus.qualityReview == "blocked")] | length' "$state_file")

        case "$phase" in
            explore)
                # Auto-continue to brief after track is selected
                if [ -n "$track" ] && [ "$track" != "null" ]; then
                    echo "AUTO:refactor-brief"
                else
                    echo "WAIT:incomplete:track-not-selected"
                fi
                ;;
            brief)
                # Check if brief is captured (has problem and goals)
                if [ -n "$brief_problem" ] && [ "$brief_problem" != "null" ] && [ "$brief_goals_count" -gt 0 ]; then
                    if [ "$track" = "polish" ]; then
                        echo "AUTO:refactor-implement"
                    elif [ "$track" = "overhaul" ]; then
                        echo "AUTO:refactor-plan"
                    else
                        echo "WAIT:incomplete:track-not-selected"
                    fi
                else
                    echo "WAIT:in-progress:capturing-brief"
                fi
                ;;
            implement)
                # Polish track only - check if implementation conditions met
                if [ "$track" = "polish" ]; then
                    # Check if goals are being verified (implementation complete)
                    if [ "$goals_verified_count" -gt 0 ] || [ "$tests_pass" = "true" ]; then
                        echo "AUTO:refactor-validate"
                    else
                        echo "WAIT:in-progress:implementing"
                    fi
                else
                    # Overhaul track shouldn't hit implement phase directly
                    echo "WAIT:in-progress:implementing"
                fi
                ;;
            validate)
                # Polish track validation
                if [ "$tests_pass" = "true" ]; then
                    echo "AUTO:refactor-update-docs"
                elif [ "$tests_pass" = "false" ]; then
                    echo "WAIT:blocked:tests-failing"
                else
                    echo "WAIT:in-progress:validating"
                fi
                ;;
            plan)
                # Overhaul track planning
                if [ -n "$plan" ] && [ "$plan" != "null" ]; then
                    echo "AUTO:refactor-delegate"
                else
                    echo "WAIT:in-progress:planning"
                fi
                ;;
            delegate)
                # Overhaul track delegation
                if [ "$total_tasks" -eq 0 ]; then
                    echo "WAIT:incomplete:no-tasks-defined"
                elif [ "$complete_tasks" -eq "$total_tasks" ]; then
                    echo "AUTO:refactor-integrate"
                else
                    echo "WAIT:in-progress:tasks-$complete_tasks-of-$total_tasks"
                fi
                ;;
            integrate)
                # Overhaul track integration
                # Check integration status from state
                local integration_passed=$(jq -r 'if .synthesis.integrationPassed == null then "" else (.synthesis.integrationPassed | tostring) end' "$state_file")
                if [ "$integration_passed" = "true" ]; then
                    echo "AUTO:refactor-review"
                elif [ "$integration_passed" = "false" ]; then
                    echo "AUTO:delegate:--fixes $plan"
                else
                    echo "WAIT:in-progress:integrating"
                fi
                ;;
            review)
                # Overhaul track review
                if [ "$spec_failed" -gt 0 ] || [ "$quality_failed" -gt 0 ]; then
                    echo "AUTO:delegate:--fixes $plan"
                elif [ "$spec_pending" -gt 0 ] || [ "$quality_pending" -gt 0 ]; then
                    echo "WAIT:in-progress:reviews-pending"
                else
                    echo "AUTO:refactor-update-docs"
                fi
                ;;
            update-docs)
                # Documentation update phase
                if [ "$docs_updated" = "true" ]; then
                    if [ "$track" = "polish" ]; then
                        # Polish track: human checkpoint for completion
                        echo "WAIT:human-checkpoint:completion"
                    else
                        # Overhaul track: auto-continue to synthesize
                        echo "AUTO:refactor-synthesize"
                    fi
                else
                    echo "WAIT:in-progress:updating-docs"
                fi
                ;;
            synthesize)
                # Overhaul track PR creation
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
                echo "WAIT:blocked:requires-attention"
                ;;
            *)
                echo "UNKNOWN:refactor-$phase"
                ;;
        esac
        return
    fi

    # Handle feature workflows (original logic)
    local plan=$(jq -r '.artifacts.plan // ""' "$state_file")
    local design=$(jq -r '.artifacts.design // ""' "$state_file")

    # Check review status
    local spec_pending=$(jq '[.tasks[] | select(.reviewStatus.specReview == null or .reviewStatus.specReview == "pending")] | length' "$state_file")
    local spec_failed=$(jq '[.tasks[] | select(.reviewStatus.specReview == "fail")] | length' "$state_file")
    local quality_pending=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == null or .reviewStatus.qualityReview == "pending")] | length' "$state_file")
    local quality_failed=$(jq '[.tasks[] | select(.reviewStatus.qualityReview == "needs_fixes" or .reviewStatus.qualityReview == "blocked")] | length' "$state_file")

    case "$phase" in
        ideate)
            # Auto-continue to plan after design is saved
            if [ -n "$design" ] && [ "$design" != "null" ]; then
                echo "AUTO:plan:$design"
            else
                echo "WAIT:incomplete:design-not-saved"
            fi
            ;;
        plan)
            if [ -n "$plan" ] && [ "$plan" != "null" ]; then
                # Plan saved, auto-continue to plan-review
                echo "AUTO:plan-review:$plan"
            else
                echo "WAIT:incomplete:plan-not-saved"
            fi
            ;;
        plan-review)
            # Human checkpoint - plan approval
            if [ -n "$plan" ] && [ "$plan" != "null" ]; then
                echo "WAIT:human-checkpoint:plan-approval"
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
