# Implementation Plan: Debug-Oriented Workflow

## Source Design

Link: `docs/designs/2026-01-27-debug-workflow.md`

## Summary

- Total tasks: 9
- Parallel groups: 3
- Files to create: 6
- Files to modify: 2

## Overview

Implements a two-track debug workflow (hotfix vs thorough) with investigation-first approach, RCA documentation, and auto-chaining behavior.

## Task Breakdown

### Task 001: Create RCA Directory and Template

**Description:** Create the RCA directory structure and template file for root cause analysis documentation.

**Files:**
- Create: `docs/rca/.gitkeep`
- Create: `skills/debug/references/rca-template.md`

**Content Requirements:**
- RCA template with all sections from design:
  - Summary, Symptom, Root Cause, Contributing Factors
  - Fix Approach, Prevention, Timeline

**Verification:**
- [ ] Directory `docs/rca/` exists
- [ ] Template exists at `skills/debug/references/rca-template.md`
- [ ] Template contains all required sections

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Create Follow-ups Directory and Structure

**Description:** Create the follow-ups directory for tracking hotfix follow-up tasks.

**Files:**
- Create: `docs/follow-ups/.gitkeep`

**Content Requirements:**
- Directory ready to accept JSON follow-up task files

**Verification:**
- [ ] Directory `docs/follow-ups/` exists

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 003: Create Triage Questions Reference

**Description:** Create the triage phase prompts and questions for track selection.

**Files:**
- Create: `skills/debug/references/triage-questions.md`

**Content Requirements:**
- Questions from design: symptom, reproduction, impact, affected area
- Track selection criteria (hotfix vs thorough)
- Urgency level definitions (P0, P1, P2)

**Verification:**
- [ ] File exists at `skills/debug/references/triage-questions.md`
- [ ] Contains all 4 triage questions
- [ ] Contains track selection logic

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 004: Create Investigation Checklist Reference

**Description:** Create the systematic investigation guide for the investigate phase.

**Files:**
- Create: `skills/debug/references/investigation-checklist.md`

**Content Requirements:**
- Investigation approach steps from design
- Hotfix time-boxing guidance (15 min)
- Tool recommendations (Grep, Glob, Read, Bash, Task/Explore)
- Escalation criteria

**Verification:**
- [ ] File exists at `skills/debug/references/investigation-checklist.md`
- [ ] Contains investigation steps
- [ ] Contains time-boxing guidance for hotfix

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 005: Extend Workflow State Schema

**Description:** Add debug-specific fields to workflow-state.sh init command and document the extended schema.

**Files:**
- Modify: `~/.claude/scripts/workflow-state.sh` (or document expected behavior)
- Create: `skills/debug/references/state-schema.md`

**Content Requirements:**
- Document extended state fields:
  - `workflowType: "debug"`
  - `track: "hotfix" | "thorough"`
  - `urgency: { level, justification }`
  - `triage: { symptom, reproduction, affectedArea, impact }`
  - `investigation: { startedAt, completedAt, rootCause, findings }`
  - `artifacts: { rca, fixDesign, pr }`
  - `followUp: { rcaRequired, issueUrl }`

**Verification:**
- [ ] Schema documentation exists at `skills/debug/references/state-schema.md`
- [ ] All debug-specific fields documented

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 006: Create Main Debug Skill

**Description:** Create the main debug skill file with full orchestration logic for both tracks.

**Files:**
- Create: `skills/debug/SKILL.md`

**Content Requirements:**
- Overview and triggers
- Command interface (`/debug`, `--hotfix`, `--escalate`)
- Hotfix track phases: triage → investigate → fix → validate → merge
- Thorough track phases: triage → investigate → rca → design → implement → review → synthesize
- Auto-chain behavior (one human checkpoint: merge)
- Track switching (`--switch-thorough`)
- Escalation to `/ideate`
- State management integration
- Follow-up task creation for hotfixes

**Verification:**
- [ ] File exists at `skills/debug/SKILL.md`
- [ ] Contains both hotfix and thorough track logic
- [ ] Contains auto-chain behavior
- [ ] References all helper files in `references/`

**Dependencies:** Tasks 001-005 (references must exist)
**Parallelizable:** No (depends on references)

---

### Task 007: Create Debug Command

**Description:** Create the `/debug` command entry point.

**Files:**
- Create: `commands/debug.md`

**Content Requirements:**
- Frontmatter with description
- Skill reference to `@skills/debug/SKILL.md`
- Argument handling for `--hotfix`, `--escalate`, `--switch-thorough`
- State initialization for debug workflow type
- Link to workflow overview diagram

**Verification:**
- [ ] File exists at `commands/debug.md`
- [ ] Contains frontmatter with description
- [ ] References debug skill
- [ ] Handles all command variants

**Dependencies:** Task 006 (skill must exist)
**Parallelizable:** No (depends on skill)

---

### Task 008: Update Workflow Auto-Resume Rule

**Description:** Extend the workflow-auto-resume rule to handle debug workflow phases.

**Files:**
- Modify: `rules/workflow-auto-resume.md`

**Content Requirements:**
- Add debug phase handling in "Determine Next Action" table:
  - `AUTO:debug-investigate` - continue investigation
  - `AUTO:debug-rca` - continue RCA documentation
  - `AUTO:debug-fix` - continue fix implementation
  - `AUTO:debug-validate` - continue validation
- Handle hotfix vs thorough track differences
- Maintain single human checkpoint (merge)

**Verification:**
- [ ] Debug phases added to next-action table
- [ ] Both tracks handled correctly
- [ ] Human checkpoint preserved

**Dependencies:** Task 006 (need to know exact phases)
**Parallelizable:** No (depends on skill)

---

### Task 009: Update Workflow State Script for Debug

**Description:** Extend workflow-state.sh to handle debug workflow type and phases.

**Files:**
- Modify: `~/.claude/scripts/workflow-state.sh`

**Content Requirements:**
- `cmd_init` option for debug workflow type
- `cmd_next_action` handling for debug phases:
  - `triage` → auto-continue to investigate
  - `investigate` (hotfix, found) → auto-continue to fix
  - `investigate` (hotfix, not found) → prompt switch to thorough
  - `investigate` (thorough) → auto-continue to rca
  - `rca` → auto-continue to design
  - `design` → auto-continue to implement
  - `implement` → auto-continue to validate
  - `validate` (hotfix) → human checkpoint (merge)
  - `validate` (thorough) → auto-continue to review
  - `review` → auto-continue to synthesize
  - `synthesize` → human checkpoint (merge)
- `cmd_summary` output for debug-specific fields

**Verification:**
- [ ] Debug workflow type supported in init
- [ ] All debug phases handled in next-action
- [ ] Summary includes debug-specific context

**Dependencies:** Task 005 (schema must be defined)
**Parallelizable:** No (depends on schema)

---

## Parallelization Strategy

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         PARALLEL GROUP 1                                  │
│                       (All Independent)                                   │
├────────────┬────────────┬────────────┬────────────┬────────────────────────┤
│  Task 001  │  Task 002  │  Task 003  │  Task 004  │      Task 005          │
│  RCA dir   │  Follow-up │  Triage Q  │  Invest.   │   State schema doc     │
│  +template │  dir       │  reference │  checklist │                        │
└────────────┴────────────┴────────────┴────────────┴────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         SEQUENTIAL GROUP 2                                │
│                    (Depends on Group 1)                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                           Task 006                                        │
│                      Main Debug Skill                                     │
│                    skills/debug/SKILL.md                                  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         PARALLEL GROUP 3                                  │
│                    (Depends on Task 006)                                  │
├──────────────────────┬──────────────────────┬────────────────────────────┤
│      Task 007        │      Task 008        │        Task 009            │
│   /debug command     │   Auto-resume rule   │   workflow-state.sh        │
└──────────────────────┴──────────────────────┴────────────────────────────┘
```

## File Structure After Implementation

```
commands/
├── debug.md                    # Task 007 (NEW)
└── ... (existing)

docs/
├── rca/                        # Task 001 (NEW)
│   └── .gitkeep
├── follow-ups/                 # Task 002 (NEW)
│   └── .gitkeep
└── ... (existing)

rules/
├── workflow-auto-resume.md     # Task 008 (MODIFIED)
└── ... (existing)

skills/
├── debug/                      # NEW
│   ├── SKILL.md               # Task 006
│   └── references/
│       ├── rca-template.md    # Task 001
│       ├── triage-questions.md    # Task 003
│       ├── investigation-checklist.md  # Task 004
│       └── state-schema.md    # Task 005
└── ... (existing)

~/.claude/scripts/
└── workflow-state.sh          # Task 009 (MODIFIED)
```

## Completion Checklist

- [ ] Task 001: RCA directory and template created
- [ ] Task 002: Follow-ups directory created
- [ ] Task 003: Triage questions reference created
- [ ] Task 004: Investigation checklist reference created
- [ ] Task 005: State schema documentation created
- [ ] Task 006: Main debug skill created with full orchestration
- [ ] Task 007: Debug command created with argument handling
- [ ] Task 008: Auto-resume rule extended for debug phases
- [ ] Task 009: Workflow state script extended for debug workflow

## Notes

**On TDD:** This implementation involves markdown configuration files and shell scripts, not TypeScript application code. Traditional TDD does not apply. Verification is structural (files exist, contain required sections) and functional (workflow operates correctly when invoked).

**On Escalation Path:** If during implementation it becomes clear the design needs architectural changes, use `/debug --escalate` to hand off to the feature workflow (`/ideate`).

**On Human Checkpoints:** The debug workflow has ONE human checkpoint (merge confirmation), compared to the feature workflow's two (design confirmation + merge confirmation). This is intentional for faster iteration.
