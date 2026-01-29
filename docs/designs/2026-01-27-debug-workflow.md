# Design: Debug-Oriented Workflow

## Problem Statement

The existing development workflow (`/ideate` → `/plan` → `/delegate` → `/integrate` → `/review` → `/synthesize`) is optimized for greenfield feature development where design exploration is valuable. For debugging and regression fixes, this workflow is ill-suited:

1. **Front-loaded design is wasteful** — Design iterations before investigation make no sense when you have a concrete bug to find
2. **Full review cycle is overkill** — Spec + quality review for a bug fix adds ceremony without proportional value
3. **No urgency differentiation** — Production-down scenarios need a faster path than "annoying bug" scenarios

Debugging requires an investigation-first approach: understand the problem deeply, then design the fix based on what you learned.

## Chosen Approach

**Two-Track Model** — Explicit separate paths for hotfix vs thorough debugging, with shared infrastructure.

### Design Principles

1. **Investigation before design** — Understand root cause before proposing solutions
2. **Urgency-appropriate ceremony** — Hotfix is genuinely fast; thorough is rigorous but lighter than feature workflow
3. **Always capture RCA** — Even hotfixes record minimal RCA; knowledge is never lost
4. **Leverage existing infrastructure** — Use `workflow-state.sh`, skills pattern, worktrees where appropriate
5. **Clear escalation path** — Manual handoff to `/ideate` when architectural changes needed

## Technical Design

### Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           /debug                                         │
│                              │                                           │
│                         ┌────┴────┐                                      │
│                         │ Triage  │                                      │
│                         └────┬────┘                                      │
│                              │                                           │
│              ┌───────────────┼───────────────┐                           │
│              │               │               │                           │
│         --hotfix          (default)      --escalate                      │
│              │               │               │                           │
│              ▼               ▼               ▼                           │
│     ┌────────────┐   ┌─────────────┐   ┌──────────┐                      │
│     │  Hotfix    │   │  Thorough   │   │ /ideate  │                      │
│     │  Track     │   │  Track      │   │ handoff  │                      │
│     └────────────┘   └─────────────┘   └──────────┘                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hotfix Track

**Purpose:** Fix production issues or critical regressions ASAP. Confirm root cause through minimal fix.

**Phases:**
```text
Triage → Investigate → Fix → Smoke Test → Merge
  │          │          │         │          │
  │          │          │         │          └─ Direct merge or fast PR
  │          │          │         └─ Run affected tests only
  │          │          └─ Minimal fix, no worktree (in-place)
  │          └─ Time-boxed (15 min), focused on finding cause
  └─ Capture symptom, affected area, urgency justification
```

**Characteristics:**
- No RCA document (minimal RCA captured in state file)
- No worktree isolation (speed over safety)
- Smoke test only (not full test suite)
- Auto-creates follow-up task for proper RCA if shipped
- Validation: Affected tests pass + manual verification

**State Phases:** `triage` → `investigate` → `fix` → `validate` → `completed`

### Thorough Track

**Purpose:** Fix non-critical bugs and regressions with proper rigor. Capture institutional knowledge.

**Phases:**
```text
Triage → Investigate → RCA Doc → Fix Design → Implement → Spec Review → Synthesize
  │          │            │           │            │            │            │
  │          │            │           │            │            │            └─ PR creation
  │          │            │           │            │            └─ Verify fix matches RCA
  │          │            │           │            └─ TDD in worktree
  │          │            │           └─ Brief solution approach (not full design)
  │          │            └─ Full root cause analysis saved to docs/rca/
  │          └─ Systematic investigation, no time limit
  └─ Full context: symptom, reproduction, affected systems
```

**Characteristics:**
- Full RCA document in `docs/rca/YYYY-MM-DD-<issue>.md`
- Worktree isolation for implementation
- Spec review only (no quality review)
- Validation: Full test suite + spec compliance

**State Phases:** `triage` → `investigate` → `rca` → `design` → `implement` → `review` → `synthesize` → `completed`

### Phase Definitions

#### Triage Phase

**Goal:** Capture context and determine track.

**Inputs:**
- Bug description or symptom
- Reproduction steps (if known)
- Affected area (if known)

**Outputs:**
- Track selection (hotfix vs thorough)
- Initial context in state file
- Urgency justification (for hotfix)

**Questions to answer:**
1. What is the symptom?
2. Can it be reproduced?
3. What is the impact/urgency?
4. What area of code is likely affected?

#### Investigate Phase

**Goal:** Find the root cause through systematic exploration.

**Approach:**
1. Reproduce the issue (if not already)
2. Identify entry point (error message, failing test, user report)
3. Trace execution path
4. Narrow down to specific code location
5. Understand why the bug occurs

**Hotfix constraint:** Time-boxed to 15 minutes. If root cause not found, escalate or switch to thorough track.

**Thorough approach:** No time limit. Use Task tool with Explore agent for complex investigations. Document findings as you go.

**Tools:**
- Grep/Glob for code search
- Read for file inspection
- Bash for running tests, checking logs
- Task (Explore) for complex codebase navigation

#### RCA Doc Phase (Thorough Only)

**Goal:** Document root cause analysis for institutional knowledge.

**Location:** `docs/rca/YYYY-MM-DD-<issue-slug>.md`

**Template:**
```markdown
# RCA: [Issue Title]

## Summary
[1-2 sentences: What broke and why]

## Symptom
[How the bug manifested - error messages, behavior, user reports]

## Root Cause
[Technical explanation of why this happened]

## Contributing Factors
[What conditions allowed this bug to exist/ship]

## Fix Approach
[High-level approach to fixing - not full implementation details]

## Prevention
[How to prevent similar issues in future]

## Timeline
- Reported: [date]
- Investigated: [date]
- Fixed: [date]
```

#### Fix Design Phase (Thorough Only)

**Goal:** Brief solution approach based on RCA findings.

**Not a full design document.** This is 2-3 paragraphs max describing:
- What changes are needed
- Which files will be modified
- Any edge cases to handle

Captured in state file under `artifacts.fixDesign`, not a separate document.

#### Implement Phase

**Goal:** Apply the fix with appropriate rigor.

**Hotfix:**
- Direct edits in main branch
- Minimal change to fix the issue
- No new tests required (existing tests should catch regression)

**Thorough:**
- Worktree isolation
- TDD approach (write failing test first, then fix)
- Full implementation per fix design

#### Validate Phase

**Goal:** Verify the fix works.

**Hotfix (Smoke Test):**
```bash
# Run only affected test files
npm run test:run -- <affected-test-files>

# Manual verification of fix
# (described in state file)
```

**Thorough (Spec Review):**
- Verify fix matches RCA
- Verify fix matches fix design
- Run full test suite
- No quality review (fixing existing code, not writing new features)

### State Schema Extension

Add debug-specific fields to workflow state:

```json
{
  "version": "1.0",
  "featureId": "debug-<issue-slug>",
  "workflowType": "debug",
  "track": "hotfix | thorough",
  "phase": "triage | investigate | rca | design | implement | validate | review | synthesize | completed",
  "urgency": {
    "level": "P0 | P1 | P2",
    "justification": "string"
  },
  "triage": {
    "symptom": "string",
    "reproduction": "string | null",
    "affectedArea": "string",
    "impact": "string"
  },
  "investigation": {
    "startedAt": "ISO8601",
    "completedAt": "ISO8601 | null",
    "rootCause": "string | null",
    "findings": ["string"]
  },
  "artifacts": {
    "rca": "docs/rca/YYYY-MM-DD-<issue>.md | null",
    "fixDesign": "string | null",
    "pr": "string | null"
  },
  "followUp": {
    "rcaRequired": "boolean",
    "issueUrl": "string | null"
  }
}
```

### Command Interface

#### Entry Point

```bash
# Start thorough debug workflow (default)
/debug "Description of the bug"

# Start hotfix workflow
/debug --hotfix "Production is down - users can't login"

# Escalate to feature workflow
/debug --escalate "This needs architectural changes"
```

#### Mid-Workflow Commands

```bash
# Switch from hotfix to thorough (during investigation)
/debug --switch-thorough

# Escalate to /ideate (manual handoff)
/debug --escalate "Reason for escalation"

# Resume after context compaction
/resume  # (existing command works)
```

### Auto-Chain Behavior

**Hotfix Track:**
```text
triage → investigate → fix → validate → [merge]
         (auto)        (auto)  (auto)     (human checkpoint)
```

**Thorough Track:**
```text
triage → investigate → rca → design → implement → review → synthesize → [merge]
         (auto)        (auto) (auto)   (auto)      (auto)   (auto)       (human)
```

Both tracks have ONE human checkpoint: merge confirmation.

### Hotfix Follow-Up Task

When a hotfix is merged, auto-create a follow-up task:

```json
{
  "type": "follow-up",
  "created": "ISO8601",
  "source": "hotfix:<state-file>",
  "task": "Create proper RCA for hotfix: <issue-slug>",
  "context": {
    "symptom": "...",
    "quickFix": "...",
    "affectedFiles": ["..."]
  }
}
```

This ensures hotfixes don't become knowledge black holes.

## Integration Points

### New Skills

| Skill | Purpose |
|-------|---------|
| `skills/debug/SKILL.md` | Main debug workflow orchestration |
| `skills/debug/references/triage-questions.md` | Triage phase prompts |
| `skills/debug/references/rca-template.md` | RCA document template |
| `skills/debug/references/investigation-checklist.md` | Systematic investigation guide |

### Modified Components

| Component | Change |
|-----------|--------|
| `workflow-state.sh` | Add `workflowType` field support |
| `rules/workflow-auto-resume.md` | Handle debug workflow phases |
| Command definitions | Add `/debug` command |

### New Directories

```text
docs/rca/                    # RCA documents
skills/debug/                # Debug skill
skills/debug/references/     # Templates and guides
```

## Testing Strategy

### Unit Testing

1. **State transitions** — Verify debug phases flow correctly
2. **Track selection** — Triage correctly routes to hotfix vs thorough
3. **RCA template** — Document generation works

### Integration Testing

1. **Hotfix end-to-end** — Symptom → fix → merge in minimal steps
2. **Thorough end-to-end** — Full workflow with RCA capture
3. **Escalation** — Handoff to `/ideate` preserves context
4. **Follow-up creation** — Hotfix creates follow-up task

### Manual Verification

1. **Context consumption** — Hotfix uses minimal context
2. **RCA quality** — Thorough track produces useful documentation
3. **Time-to-fix** — Hotfix is measurably faster than thorough

## Open Questions

1. **Hotfix time limit** — Is 15 minutes right for investigation? Could be configurable.
   - Recommendation: Start with 15 min, adjust based on experience

2. **Follow-up task location** — Where to store follow-up tasks from hotfixes?
   - Recommendation: `docs/follow-ups/` directory with simple JSON files

3. **RCA review** — Should RCA documents be reviewed before merge?
   - Recommendation: No - they're institutional knowledge, not gatekeeping

4. **Parallel hotfixes** — Can multiple hotfixes run simultaneously?
   - Recommendation: Yes, but warn about potential conflicts

## Implementation Order

1. **Phase 1: State schema** — Add debug-specific fields to workflow-state.sh
2. **Phase 2: Debug skill** — Create skills/debug/SKILL.md with core orchestration
3. **Phase 3: Triage phase** — Questions and track selection logic
4. **Phase 4: Investigation phase** — Systematic investigation helpers
5. **Phase 5: RCA phase** — Template and document generation
6. **Phase 6: Hotfix track** — Minimal fix → smoke test → merge path
7. **Phase 7: Thorough track** — Full flow with spec review integration
8. **Phase 8: Follow-up system** — Auto-create tasks from hotfixes
9. **Phase 9: Auto-resume** — Update workflow-auto-resume.md for debug phases
