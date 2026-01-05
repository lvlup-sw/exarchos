# Global Config Changelog

Update sparingly - high signal/impactful changes only.

## 2026-01-04

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
