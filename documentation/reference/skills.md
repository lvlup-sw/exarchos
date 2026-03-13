# Skills

Skills are structured Markdown documents that provide domain knowledge and behavioral guidance to the agent. Each skill covers a specific workflow concern across all workflow phases.

## Skill anatomy

Each skill lives in `skills/<name>/` with two components:

```text
skills/
  brainstorming/
    SKILL.md          # Main skill document with frontmatter
    references/       # Supporting documents, templates, checklists
      approach-template.md
      constraints.md
```

### Frontmatter

`SKILL.md` uses YAML frontmatter with these fields:

```yaml
---
name: brainstorming                    # kebab-case identifier
description: "Collaborative design..." # <= 1,024 characters
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos                 # Required if skill uses Exarchos MCP tools
  category: workflow                   # workflow | utility
  phase-affinity: ideate               # Phase(s) where this skill activates
---
```

Skills that invoke Exarchos MCP tools must include `metadata.mcp-server: exarchos` in their frontmatter. Utility or standards skills without MCP dependency are exempt.

## Production skills

| Skill | Description | Phase Affinity |
|-------|-------------|----------------|
| `brainstorming` | Design exploration, approach selection | ideate |
| `cleanup` | Post-merge workflow resolution | completed |
| `debug` | Bug investigation and fix (hotfix/thorough tracks) | triage, debug-review |
| `delegation` | Task dispatch to agent teammates in worktrees | delegate |
| `git-worktrees` | Worktree management for parallel work | delegate |
| `implementation-planning` | TDD-based task planning from design docs | plan |
| `quality-review` | Stage 2 code quality review | review |
| `refactor` | Code improvement (polish/overhaul tracks) | explore, synthesize |
| `shepherd` | PR shepherding through CI and reviews | synthesize |
| `spec-review` | Stage 1 spec compliance review | review |
| `synthesis` | PR creation from feature branch | synthesize |
| `workflow-state` | Checkpoint and resume workflow state | any phase |

## Skill resolution

Commands reference skills via `skills/<name>/SKILL.md`. The agent loads the skill document and its references to get process details, templates, and checklists for the current workflow phase.

Skills invoke orchestrate actions through the MCP server as native TypeScript handlers:

```typescript
exarchos_orchestrate({ action: "check_tdd_compliance" })
```
