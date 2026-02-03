# Design: Refactor-Oriented Workflow

## Problem Statement

The existing development workflows are optimized for specific scenarios:

- **`/ideate`** — Greenfield features requiring design exploration
- **`/debug`** — Bug fixing with investigation-first approach

Neither fits refactoring well:

1. **`/ideate` is too heavy** — Full design docs for "extract this class" is wasteful ceremony
2. **`/debug` assumes broken behavior** — Refactoring starts with working code
3. **No documentation update step** — Refactors change existing architecture but neither workflow updates existing docs

Refactoring needs an exploration-driven workflow that's lighter than `/ideate`, preserves working code guarantees, and ensures documentation stays current.

## Chosen Approach

**Two-Track Model** — Explicit tracks for polish (small, fast) vs overhaul (large, delegated), with shared exploration and documentation update phases.

### Design Principles

1. **Exploration before commitment** — Understand scope before planning
2. **Right-sized ceremony** — Polish is fast; overhaul is rigorous
3. **Brief over design doc** — Capture intent in state, not separate documents
4. **Update existing docs** — Refactors modify architecture, docs must follow
5. **Leverage existing infrastructure** — Worktrees, delegation, review phases

## Technical Design

### Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              /refactor                                       │
│                                  │                                           │
│                            ┌─────┴─────┐                                     │
│                            │  Explore  │                                     │
│                            └─────┬─────┘                                     │
│                                  │                                           │
│                   ┌──────────────┼──────────────┐                            │
│                   │                             │                            │
│              --polish                       (default)                        │
│                   │                             │                            │
│                   ▼                             ▼                            │
│          ┌──────────────┐              ┌──────────────┐                      │
│          │    Polish    │              │   Overhaul   │                      │
│          │    Track     │              │    Track     │                      │
│          └──────────────┘              └──────────────┘                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Polish Track

**Purpose:** Fast path for small, contained refactors. Single session, minimal ceremony.

**Phases:**
```text
Explore → Brief → Implement → Validate → Update Docs → Complete
   │         │         │           │            │
   │         │         │           │            └─ Update affected documentation
   │         │         │           └─ Run tests, verify goals met
   │         │         └─ Direct implementation (no worktree)
   │         └─ Capture goals and approach in state
   └─ Quick scope assessment, confirm polish-appropriate
```

**Characteristics:**
- No worktree isolation (speed over safety)
- No delegation (orchestrator guides implementation)
- Validation: existing tests pass + goals verified
- Scope limit: ≤5 files, single concern

**State Phases:** `explore` → `brief` → `implement` → `validate` → `update-docs` → `completed`

### Overhaul Track

**Purpose:** Rigorous path for architectural changes, migrations, and multi-file restructuring.

**Phases:**
```text
Explore → Brief → Plan → Delegate → Integrate → Review → Update Docs → Synthesize
   │         │       │        │          │          │           │            │
   │         │       │        │          │          │           │            └─ PR creation
   │         │       │        │          │          │           └─ Update architecture docs
   │         │       │        │          │          └─ Quality review (emphasized)
   │         │       │        │          └─ Merge worktrees, run tests
   │         │       │        └─ TDD implementation in worktrees
   │         │       └─ Extract tasks from brief
   │         └─ Detailed goals, approach, affected areas
   └─ Thorough scope assessment, identify affected systems
```

**Characteristics:**
- Worktree isolation for all implementation
- Full delegation model
- Quality review emphasized (refactors are high regression risk)
- No scope limit

**State Phases:** `explore` → `brief` → `plan` → `delegate` → `integrate` → `review` → `update-docs` → `synthesize` → `completed`

### Phase Definitions

#### Explore Phase

**Goal:** Understand current state and refactor scope before committing.

**Activities:**
1. Read affected code to understand current structure
2. Identify all files/modules that will change
3. Assess test coverage of affected areas
4. Identify documentation that will need updates
5. Determine if polish or overhaul is appropriate

**Outputs:**
- Scope assessment (files, modules, concerns)
- Test coverage gaps (if any)
- Documentation targets
- Track recommendation (can override with flag)

**Track Selection Guidance:**

| Indicator | Polish | Overhaul |
|-----------|--------|----------|
| Files affected | ≤5 | >5 |
| Concerns | Single | Multiple |
| Cross-module | No | Yes |
| Test gaps | None | Some |
| Doc updates | Minor | Architectural |

#### Brief Phase

**Goal:** Capture refactor intent and approach without full design ceremony.

**Captured in state file (not separate document):**

```json
{
  "brief": {
    "problem": "What's wrong with current code",
    "goals": ["Specific goal 1", "Specific goal 2"],
    "approach": "High-level approach description",
    "affectedAreas": ["module/path1", "module/path2"],
    "outOfScope": ["What we're NOT changing"],
    "successCriteria": ["How we know we're done"],
    "docsToUpdate": ["docs/path1.md", "docs/path2.md"]
  }
}
```

**Polish brief:** 2-3 sentences per field
**Overhaul brief:** Paragraph per field, more detail on approach

#### Plan Phase (Overhaul Only)

**Goal:** Extract implementation tasks from brief.

Reuses existing `/plan` skill with refactor-specific prompt:
- Tasks focus on incremental, testable changes
- Each task should leave code in working state
- Dependency order matters more for refactors

#### Implement Phase (Polish Only)

**Goal:** Direct implementation guided by orchestrator.

**Constraints:**
- Must follow TDD (write/update test first if changing behavior)
- Commit after each logical change
- Stop if scope expands beyond brief

**Orchestrator role:** Guide implementation, but can write code directly (exception to orchestrator constraints for polish track).

#### Validate Phase

**Goal:** Verify refactor goals are met.

**Validation checklist:**
1. All existing tests pass
2. Each goal in brief is addressed
3. No new lint/type errors introduced
4. Code quality improved (subjective check against brief)

#### Update Docs Phase

**Goal:** Ensure documentation reflects new architecture.

**Required updates:**
- Architecture docs if structure changed
- API docs if interfaces changed
- README if setup/usage changed
- Inline comments if complex logic moved

**Documentation update is NOT optional.** If `docsToUpdate` is empty, phase verifies no docs need updating.

### State Schema Extension

Add refactor-specific fields to workflow state:

```json
{
  "version": "1.0",
  "featureId": "refactor-<slug>",
  "workflowType": "refactor",
  "track": "polish | overhaul",
  "phase": "explore | brief | plan | delegate | integrate | review | update-docs | synthesize | completed",
  "explore": {
    "startedAt": "ISO8601",
    "completedAt": "ISO8601 | null",
    "scopeAssessment": {
      "filesAffected": ["string"],
      "modulesAffected": ["string"],
      "testCoverage": "good | gaps | none",
      "recommendedTrack": "polish | overhaul"
    }
  },
  "brief": {
    "problem": "string",
    "goals": ["string"],
    "approach": "string",
    "affectedAreas": ["string"],
    "outOfScope": ["string"],
    "successCriteria": ["string"],
    "docsToUpdate": ["string"]
  },
  "artifacts": {
    "plan": "string | null",
    "pr": "string | null",
    "updatedDocs": ["string"]
  },
  "validation": {
    "testsPass": "boolean",
    "goalsVerified": ["string"],
    "docsUpdated": "boolean"
  }
}
```

### Command Interface

#### Entry Point

```bash
# Start overhaul refactor (default)
/refactor "Description of what needs refactoring"

# Start polish refactor (fast path)
/refactor --polish "Small contained refactor description"

# Explore first, then decide track
/refactor --explore-only "Unsure of scope, explore first"
```

#### Mid-Workflow Commands

```bash
# Switch from polish to overhaul (during explore/brief)
/refactor --switch-overhaul

# Resume after context compaction
/resume
```

### Auto-Chain Behavior

**Polish Track:**
```text
explore → brief → implement → validate → update-docs → [complete]
          (auto)   (auto)      (auto)      (auto)        (human checkpoint)
```

**Overhaul Track:**
```text
explore → brief → plan → delegate → integrate → review → update-docs → synthesize → [merge]
          (auto)  (auto)  (auto)     (auto)      (auto)    (auto)        (auto)       (human)
```

Both tracks have ONE human checkpoint: completion/merge confirmation.

### Polish Track Orchestrator Exception

For polish track ONLY, the orchestrator may write implementation code directly. This is an explicit exception to the orchestrator constraints rule.

**Rationale:** Polish refactors are small enough that delegation overhead exceeds benefit. The orchestrator can complete a 3-file rename faster than setting up worktrees and dispatching subagents.

**Guardrails:**
- Only during `implement` phase of polish track
- Must stay within scope defined in brief
- If scope expands, switch to overhaul track

## Integration Points

### New Skills

| Skill | Purpose |
|-------|---------|
| `skills/refactor/SKILL.md` | Main refactor workflow orchestration |
| `skills/refactor/references/explore-checklist.md` | Exploration phase guide |
| `skills/refactor/references/brief-template.md` | Brief structure reference |
| `skills/refactor/references/doc-update-checklist.md` | Documentation update guide |

### Modified Components

| Component | Change |
|-----------|--------|
| `workflow-state.sh` | Add `workflowType: refactor` support |
| `rules/workflow-auto-resume.md` | Handle refactor workflow phases |
| `rules/orchestrator-constraints.md` | Add polish track exception |
| Command definitions | Add `/refactor` command |

### Reused Components

| Component | Usage |
|-----------|-------|
| `/plan` skill | Overhaul track task extraction |
| `/delegate` skill | Overhaul track implementation |
| `/integrate` skill | Overhaul track merge and test |
| `/review` skill | Overhaul track quality review |
| `/synthesize` skill | Overhaul track PR creation |

## Testing Strategy

### Unit Testing

1. **State transitions** — Verify refactor phases flow correctly for both tracks
2. **Track selection** — Exploration correctly recommends polish vs overhaul
3. **Brief validation** — Required fields enforced

### Integration Testing

1. **Polish end-to-end** — Small refactor completes in single session
2. **Overhaul end-to-end** — Large refactor uses full delegation
3. **Track switch** — Can escalate from polish to overhaul mid-workflow
4. **Doc updates** — Verify documentation is actually updated

### Manual Verification

1. **Context consumption** — Polish uses minimal context
2. **Goal verification** — Success criteria actually validated
3. **Doc quality** — Updated docs are accurate and useful

## Open Questions

1. **Polish scope limit** — Is ≤5 files the right threshold?
   - Recommendation: Start with 5, adjust based on experience

2. **Behavior change documentation** — If refactor intentionally changes behavior, where to document?
   - Recommendation: In the PR description and affected docs, not a separate artifact

3. **Test coverage gaps** — Should refactor require closing test gaps before proceeding?
   - Recommendation: Flag gaps in brief, but don't block (that's a separate task)

4. **Partial completion** — If overhaul is interrupted, how to resume?
   - Recommendation: Same as feature workflow — state file tracks progress

## Implementation Order

1. **Phase 1: State schema** — Add refactor-specific fields to workflow-state.sh
2. **Phase 2: Refactor skill** — Create skills/refactor/SKILL.md with core orchestration
3. **Phase 3: Explore phase** — Scope assessment and track recommendation
4. **Phase 4: Brief phase** — Goal and approach capture
5. **Phase 5: Polish track** — Direct implementation path
6. **Phase 6: Overhaul track** — Integration with existing delegation infrastructure
7. **Phase 7: Update docs phase** — Documentation update enforcement
8. **Phase 8: Auto-resume** — Update workflow-auto-resume.md for refactor phases
