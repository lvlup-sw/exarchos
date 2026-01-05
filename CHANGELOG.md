# Global Config Changelog

Update sparingly - high signal/impactful changes only.

## 2026-01-04

### PR Feedback Loop & Direct Commits

Added support for human interaction with PRs:

**PR Review Feedback:**
- New `--pr-fixes` flag for `/delegate`
- Fetches PR comments via `gh api`
- Creates fix tasks from review feedback
- Loops back to merge confirmation after fixes

**Direct Commits:**
- Users can commit directly to integration branch
- Workflow syncs (`git pull`) before merge confirmation
- Documented in synthesize command and skill

**Updated flow:**
```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                                 ▲                                     │
                                 └─────────── --pr-fixes ──────────────┘
```

---

### Streamlined Auto-Chain Flow

Reduced confirmation prompts in the workflow pipeline:

**New flow:**
```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)    (auto)     (auto)           ↓
            └──────────── ON BLOCKED ────────────────────────────────────┘
                          ON FAIL → /delegate --fixes (auto)
```

**Changes:**
- `/plan` → `/delegate`: Now auto-invokes (no confirmation)
- `/delegate` → `/review`: Now auto-invokes (no confirmation)
- `/review` → `/synthesize`: Now auto-invokes on PASS (no confirmation)
- `/synthesize` → merge: Added confirmation before merging PR
- `/review`: Now dispatches to subagents (preserves orchestrator context)

**Files modified:**
- `commands/plan.md`, `commands/delegate.md`, `commands/review.md`, `commands/synthesize.md`
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md`
- `skills/implementation-planning/SKILL.md`, `skills/delegation/SKILL.md`

---

### Initial Global Configuration

- **Skills (7)**: brainstorming, implementation-planning, git-worktrees, delegation, spec-review, quality-review, synthesis
- **Commands (6)**: ideate, plan, delegate, review, synthesize, tdd
- **Rules (4)**: tdd-typescript, tdd-csharp, coding-standards-csharp, coding-standards-typescript
- **Plugins (1)**: jules (symlinked from workflow/jules-plugin)
- **Settings**: Global permissions for WebSearch, Jules API, GitHub

### Update Policy

Before updating global config:
1. Test changes locally in a project first
2. Validate with `/review` quality checks
3. Document changes in this file
4. Project-level `.claude/` overrides take precedence
