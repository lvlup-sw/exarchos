# Skill Path Resolution

When commands or instructions reference skills using the `@skills/` prefix, resolve these paths to the user's global Claude skills directory.

## Path Resolution

| Reference | Resolves To |
|-----------|-------------|
| `@skills/` | `~/.claude/skills/` |
| `@skills/brainstorming/SKILL.md` | `~/.claude/skills/brainstorming/SKILL.md` |
| `@skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |

## Implementation

When you encounter a skill reference like `@skills/brainstorming/SKILL.md`:

1. **Read the skill file** from `~/.claude/skills/brainstorming/SKILL.md`
2. **Follow the skill's instructions** as documented in the SKILL.md file
3. **Use skill-specific templates** from the skill's directory if available

## Available Skills

Skills are located in `~/.claude/skills/` and include:

- `brainstorming/` - Design exploration and ideation
- `implementation-planning/` - TDD implementation planning
- `delegation/` - Task delegation to subagents
- `integration/` - Branch integration and testing
- `quality-review/` - Two-stage code review
- `synthesis/` - PR creation and merge
- `git-worktrees/` - Git worktree management
- `workflow-state/` - Workflow state persistence

## Example

When a command says:

```markdown
Follow the brainstorming skill: `@skills/brainstorming/SKILL.md`
```

You must:

1. Read `~/.claude/skills/brainstorming/SKILL.md`
2. Follow all instructions in that file
3. Use templates and patterns defined there

## Failure Mode

If a skill file is not found at the resolved path:

1. Report the missing skill file to the user
2. Fall back to inline instructions in the command if available
3. Ask the user for guidance if neither is available
