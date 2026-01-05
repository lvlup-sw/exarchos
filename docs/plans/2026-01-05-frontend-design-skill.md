# Implementation Plan: Frontend Design Skill

## Source Design

Link: `docs/designs/2026-01-05-frontend-design-skill.md`

## Summary

- Total tasks: 3
- Parallel groups: 1 (all tasks parallelizable)
- Files to create: 2
- Files to modify: 1

## Task Breakdown

### Task 001: Create Main Skill File

**Description:** Create `skills/frontend-design/SKILL.md` with the complete instruction set.

**Files:**
- Create: `skills/frontend-design/SKILL.md`

**Content Requirements:**
- Overview section
- Triggers section (workflow context activation)
- Core directive with `<frontend_aesthetics>` tag
- Typography requirements with banned/recommended fonts
- Color & theme requirements with CSS variable patterns
- Motion & animation requirements with stagger patterns
- Spatial composition requirements
- Background & atmosphere requirements
- Anti-patterns checklist (8 items)
- Execution standards
- Example aesthetic directions table
- Workflow integration section
- Completion criteria

**Verification:**
- [ ] File exists at `skills/frontend-design/SKILL.md`
- [ ] Contains all required sections from design
- [ ] Follows existing skill format (see `skills/brainstorming/SKILL.md`)

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Create Delegatable Prompt

**Description:** Create `skills/frontend-design/prompts/aesthetics.md` - a standalone prompt for injection into delegation tasks.

**Files:**
- Create: `skills/frontend-design/prompts/aesthetics.md`

**Content Requirements:**
- Condensed version of skill (suitable for subagent context)
- "Before Coding" checklist
- Typography quick reference
- Color quick reference
- Motion quick reference
- Layout quick reference
- Background quick reference
- "Verify Before Submitting" checklist

**Verification:**
- [ ] File exists at `skills/frontend-design/prompts/aesthetics.md`
- [ ] Contains all essential guidance in condensed form
- [ ] Suitable for injection into delegation prompts

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 003: Extend Quality Review Skill

**Description:** Add frontend aesthetics section to `skills/quality-review/SKILL.md`.

**Files:**
- Modify: `skills/quality-review/SKILL.md`

**Changes:**
Add new section "### 7. Frontend Aesthetics (if applicable)" after section 6 (Security Basics) with:
- Distinctive typography check
- Intentional color palette check
- Purposeful motion check
- Atmospheric backgrounds check
- Overall distinctiveness check

**Verification:**
- [ ] Section 7 exists in quality-review SKILL.md
- [ ] Contains all 5 frontend aesthetics checks
- [ ] Marked as "(if applicable)" to avoid false positives on non-frontend work

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    PARALLEL GROUP 1                         │
│                  (All Independent)                          │
├─────────────────┬─────────────────┬─────────────────────────┤
│   Task 001      │   Task 002      │      Task 003           │
│   SKILL.md      │   aesthetics.md │   quality-review ext    │
│   (create)      │   (create)      │   (modify)              │
└─────────────────┴─────────────────┴─────────────────────────┘
```

All three tasks can execute simultaneously in separate worktrees or by a single implementer.

## File Structure After Implementation

```
skills/
├── frontend-design/           # NEW
│   ├── SKILL.md              # Task 001
│   └── prompts/
│       └── aesthetics.md     # Task 002
├── quality-review/
│   └── SKILL.md              # Task 003 (modified)
└── ... (existing skills)
```

## Completion Checklist

- [ ] Task 001: Main skill file created with complete instruction set
- [ ] Task 002: Delegatable prompt created for subagent injection
- [ ] Task 003: Quality review extended with frontend aesthetics checks
- [ ] All files follow existing conventions
- [ ] Skill integrates with workflow (ideate → plan → delegate → review)

## Notes

**On TDD:** This implementation involves markdown configuration files, not application code. Traditional TDD does not apply. Verification is structural (files exist, contain required sections) and functional (skill works when invoked in actual frontend sessions).

**On Workflow Integration:** The skill activates via workflow context - when a design document specifies frontend work, the delegation phase automatically includes the aesthetics prompt. No explicit `/frontend` command needed.
