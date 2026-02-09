# Debug Workflow Skill

## Overview

Investigation-first workflow for debugging and regression fixes. Provides two tracks based on urgency: hotfix (fast, minimal ceremony) and thorough (rigorous, full RCA documentation).

## Triggers

Activate this skill when:
- User runs `/debug` command
- User reports a bug or regression
- User needs to investigate an error
- User says "fix this bug" or similar

## Workflow Overview

```
                              /debug
                                 │
                            ┌────┴────┐
                            │ Triage  │
                            └────┬────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                 │
          --hotfix            (default)       --escalate
               │                 │                 │
               ▼                 ▼                 ▼
      ┌────────────────┐  ┌─────────────┐   ┌──────────┐
      │  Hotfix Track  │  │   Thorough  │   │ /ideate  │
      │                │  │    Track    │   │ handoff  │
      └────────────────┘  └─────────────┘   └──────────┘
```

## Command Interface

### Start Debug Workflow

```bash
# Default: thorough track
/debug "Description of the bug"

# Fast path: hotfix track
/debug --hotfix "Production is down - users can't login"

# Escalate to feature workflow
/debug --escalate "This needs architectural changes"
```

### Mid-Workflow Commands

```bash
# Switch from hotfix to thorough (during investigation)
/debug --switch-thorough

# Escalate to /ideate (manual handoff)
/debug --escalate "Reason for escalation"

# Resume after context compaction
/resume  # (existing command works)
```

## Track Comparison

| Aspect | Hotfix | Thorough |
|--------|--------|----------|
| Urgency | P0 (production down) | P1/P2 (normal priority) |
| Investigation | 15 min time-boxed | No time limit |
| RCA Document | No (minimal in state) | Yes (full docs/rca/) |
| Worktree | No (in-place fix) | Yes (isolated) |
| Review | Smoke test only | Spec review |
| Human Checkpoints | 1 (merge) | 1 (merge) |

## Hotfix Track

### Purpose

Fix production issues or critical regressions ASAP. Speed over ceremony.

### Phases

```
Triage → Investigate → Implement → Validate → Completed
  │          │            │           │           │
  │          │            │           │           └─ Human checkpoint: merge
  │          │            │           └─ Smoke tests only
  │          │            └─ Minimal fix, no worktree
  │          └─ 15 min max, focused on root cause
  └─ Capture symptom, select track
```

### Phase Details

#### 1. Triage Phase

Use `@skills/debug/references/triage-questions.md` to gather:
- Symptom description
- Reproduction steps
- Urgency justification
- Affected area

Update state using `mcp__exarchos__exarchos_workflow_set`:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "triage": {
      "symptom": "<symptom>",
      "reproduction": "<steps>",
      "affectedArea": "<area>",
      "impact": "<impact>"
    },
    "urgency": {
      "level": "P0",
      "justification": "<why P0>"
    },
    "track": "hotfix"
  }
  phase: "investigate"
```

#### 2. Investigate Phase (15 min max)

Use `@skills/debug/references/investigation-checklist.md`.

**MCP-Assisted Investigation:**
- **Locate function:** `serena__find_symbol` to find the failing code quickly
- **Trace call chain:** `serena__find_referencing_symbols` for callers
- **Module structure:** `serena__get_symbols_overview` around the bug area
- **Regex search:** `serena__search_for_pattern` when symbol name is unknown
- **Framework behavior:** `context7__query-docs` to verify expected library behavior
- **Microsoft docs:** `microsoft-learn__microsoft_docs_search` for official Microsoft product/framework/tool documentation

**Time-boxed to 15 minutes.** At 15 min checkpoint:
- Root cause found -> Continue to implement
- Root cause NOT found -> Switch to thorough track

Record findings using `mcp__exarchos__exarchos_workflow_set`:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "investigation.findings": ["<finding>"] }
```

When root cause found:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "investigation.rootCause": "<root cause>",
    "investigation.completedAt": "<ISO8601>"
  }
  phase: "implement"
```

#### 3. Implement Phase

Apply minimal fix directly (no worktree):
- Change only what's necessary
- No new features or refactoring
- Record fix approach in state

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "artifacts.fixDesign": "<brief fix description>" }
  phase: "validate"
```

#### 4. Validate Phase

Run affected tests only:
```bash
npm run test:run -- <affected-test-files>
```

If tests pass:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "followUp.rcaRequired": true }
  phase: "completed"
```

Create follow-up task for proper RCA:
```bash
cat > docs/follow-ups/$(date +%Y-%m-%d)-<issue-slug>.json << EOF
{
  "type": "follow-up",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "hotfix:<state-file>",
  "task": "Create proper RCA for hotfix: <issue-slug>",
  "context": {
    "symptom": "<symptom>",
    "quickFix": "<fix description>",
    "affectedFiles": ["<files>"]
  }
}
EOF
```

**Human checkpoint:** Confirm merge.

## Thorough Track

### Purpose

Fix bugs with proper rigor. Capture institutional knowledge through RCA.

### Phases

```
Triage → Investigate → RCA → Design → Implement → Review → Synthesize → Completed
  │          │          │       │         │          │          │           │
  │          │          │       │         │          │          │           └─ Merge
  │          │          │       │         │          │          └─ Create PR
  │          │          │       │         │          └─ Spec review only
  │          │          │       │         └─ TDD in worktree
  │          │          │       └─ Brief fix approach
  │          │          └─ Full RCA document
  │          └─ Systematic investigation
  └─ Capture symptom, select track
```

### Phase Details

#### 1. Triage Phase

Same as hotfix, but set track to "thorough":

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "track": "thorough" }
  phase: "investigate"
```

#### 2. Investigate Phase

Use `@skills/debug/references/investigation-checklist.md`.

**MCP-Assisted Investigation:**
- **Locate function:** `serena__find_symbol` to find the failing code quickly
- **Trace call chain:** `serena__find_referencing_symbols` for callers
- **Module structure:** `serena__get_symbols_overview` around the bug area
- **Regex search:** `serena__search_for_pattern` when symbol name is unknown
- **Framework behavior:** `context7__query-docs` to verify expected library behavior
- **Microsoft docs:** `microsoft-learn__microsoft_docs_search` for official Microsoft product/framework/tool documentation

No time limit. Be thorough:
- Use Task tool with Explore agent for complex investigation
- Document all findings
- Understand the full picture before proposing fix

#### 3. RCA Phase

Create RCA document using `@skills/debug/references/rca-template.md`.

Save to: `docs/rca/YYYY-MM-DD-<issue-slug>.md`

Update state:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "artifacts.rca": "docs/rca/YYYY-MM-DD-<issue-slug>.md" }
  phase: "design"
```

#### 4. Design Phase

Brief fix approach (NOT a full design document).

2-3 paragraphs max in state file:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "artifacts.fixDesign": "<fix approach description>" }
  phase: "implement"
```

#### 5. Implement Phase

Create worktree and implement with TDD:

```bash
# Create worktree
git branch feature/debug-<issue-slug> main
git worktree add .worktrees/debug-<issue-slug> feature/debug-<issue-slug>
cd .worktrees/debug-<issue-slug> && npm install

# TDD: Write failing test first, then implement
```

Update state:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "worktrees.\".worktrees/debug-<issue-slug>\"": {
      "branch": "feature/debug-<issue-slug>",
      "status": "active"
    }
  }
  phase: "review"
```

#### 6. Review Phase

Spec review only (not quality review - this is a fix, not new feature):

Verify:
- [ ] Fix matches RCA root cause
- [ ] Fix matches design approach
- [ ] Tests cover the bug scenario
- [ ] No regressions

Update state:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  phase: "synthesize"
```

#### 7. Synthesize Phase

Create PR via Graphite MCP:

```
# Stage and create branch with fix commit
mcp__graphite__run_gt_cmd({ args: ["create", "--all", "-m", "fix: <issue summary>"], cwd: "<repo-root>" })

# Submit to create the PR
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive"], cwd: "<repo-root>" })
```

Then update the PR description using GitHub MCP:
```
mcp__plugin_github_github__update_pull_request({
  owner, repo, pullNumber,
  body: "## Summary\n[Brief description]\n\n## Root Cause Analysis\nSee: docs/rca/YYYY-MM-DD-<issue-slug>.md\n\n## Changes\n- [change 1]\n\n## Test Plan\n- [test approach]"
})
```

**Human checkpoint:** Confirm merge.

## Track Switching

### Hotfix -> Thorough

If during hotfix investigation root cause is not found in 15 minutes:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "track": "thorough",
    "investigation.findings": ["Switched to thorough track: root cause not found in 15 min"]
  }
```

Continue investigation without time constraint.

### Thorough -> Escalate

If fix requires architectural changes:

```
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "investigation.findings": ["Escalated: requires architectural changes"] }
  phase: "blocked"
```

Output to user:
> This issue requires architectural changes that exceed bug fix scope.
> Recommend running `/ideate` to design the solution properly.
>
> Context preserved in: `<state-file>`

## Auto-Chain Behavior

Both tracks have ONE human checkpoint: merge confirmation.

**Hotfix auto-chain:**
```
triage → investigate → implement → validate → [HUMAN: merge]
         (auto)        (auto)       (auto)
```

**Thorough auto-chain:**
```
triage → investigate → rca → design → implement → review → synthesize → [HUMAN: merge]
         (auto)        (auto) (auto)   (auto)      (auto)   (auto)
```

## State Management

Initialize debug workflow using `mcp__exarchos__exarchos_workflow_init`:

```
Use mcp__exarchos__exarchos_workflow_init with featureId `debug-<issue-slug>` and workflowType `debug`.
```

See `@skills/debug/references/state-schema.md` for full schema.

## Integration Points

### With /resume

Debug workflows resume like feature workflows:
```bash
/resume docs/workflow-state/debug-<issue-slug>.state.json
```

### With Existing Skills

- Uses spec-review skill for thorough track review phase
- Uses synthesis skill for PR creation
- Uses git-worktrees skill for thorough track implementation

### With MCP Workflow State Tools

Extended to support:
- `workflowType: "debug"` field
- Debug-specific phases in `mcp__exarchos__exarchos_workflow_next_action` response
- Debug context in `mcp__exarchos__exarchos_workflow_summary` output

## Completion Criteria

### Hotfix Complete

- [ ] Root cause identified (even if briefly)
- [ ] Minimal fix applied
- [ ] Affected tests pass
- [ ] Follow-up RCA task created
- [ ] Changes merged

### Thorough Complete

- [ ] Full RCA documented in docs/rca/
- [ ] Fix matches RCA findings
- [ ] TDD implementation with tests
- [ ] Spec review passed
- [ ] PR merged

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Start coding before understanding bug | Investigate first, always |
| Skip RCA on thorough track | Document for future learning |
| Exceed 15 min on hotfix investigation | Switch to thorough track |
| Add features during bug fix | Scope creep - only fix the bug |
| Skip tests because "it's just a fix" | Fixes need tests to prevent regression |

## Exarchos Integration

When Exarchos MCP tools are available, emit events throughout the debug workflow:

1. **At workflow start (triage):** `exarchos_event_append` → `workflow.started` with workflowType "debug", urgency
2. **On track selection:** `exarchos_event_append` → `phase.transitioned` with selected track (hotfix/thorough)
3. **On each phase transition:** `exarchos_event_append` → `phase.transitioned` from→to
4. **Thorough track stacking:** Handled by `/synthesize` (Graphite stack submission)
5. **Hotfix track commit:** Single `gt create --all -m "fix: <description>"` — no multi-branch stacking needed
6. **On complete:** `exarchos_event_append` → `phase.transitioned` to "completed"
