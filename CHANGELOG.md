# Global Config Changelog

Update sparingly - high signal/impactful changes only.

## 2026-02-09

### Removed Jules MCP Integration

Jules (Google's autonomous coding agent) integration has been removed. It was never used in production and is superseded by the Task tool subagent pattern.

**Removed:**
- `plugins/jules/` — entire MCP server and plugin directory
- `julesSessions` field from workflow state schema and initial state
- `julesSessionId` and `jules` assignee from JSON schema
- Jules permissions, labels, and auto-triage scope detection
- Jules references from delegation skill, delegate command, and documentation

## 2026-01-06

### Workflow Phase Restructuring

Added explicit integration phase and orchestrator constraints:

**New `/integrate` Phase:**
- Merges worktree branches in dependency order
- Runs combined test suite after each merge
- Reports pass/fail with specific failure details
- Auto-chains to `/review` on success, `/delegate --fixes` on failure

**Orchestrator Constraints:**
- Orchestrator no longer writes implementation code
- All fixes delegated to subagents (fixer prompt template)
- Worktree enforcement prevents accidental main project modifications

**Review Updates:**
- Reviews now assess integrated diff (not per-worktree fragments)
- Full picture of combined code quality

**Synthesis Simplification:**
- Merge/test logic moved to `/integrate`
- `/synthesize` now just creates PR from integration branch

**Updated flow:**
```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)      (auto)      (auto)     (auto)           ↑
          HUMAN                                                                    HUMAN
                                   ↑                        │
                                   └──── --fixes ───────────┘
```

**Files added:**
- `rules/orchestrator-constraints.md`
- `skills/integration/SKILL.md`
- `skills/integration/references/integrator-prompt.md`
- `skills/delegation/references/fixer-prompt.md`
- 14 test scripts

**Files modified:**
- `skills/delegation/SKILL.md` (worktree enforcement + fix mode)
- `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md` (integrated diff)
- `skills/synthesis/SKILL.md` (simplified)
- `docs/schemas/workflow-state.schema.json` (integration object)

---

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
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
                                            ▲                                       │
                                            └─────────── --pr-fixes ────────────────┘
```

---

### Streamlined Auto-Chain Flow

Reduced confirmation prompts in the workflow pipeline:

**New flow:**
```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
            ↑           (auto)   (auto)      (auto)      (auto)     (auto)           ↓
            └──────────── ON BLOCKED ──────────────────────────────────────────────────┘
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
