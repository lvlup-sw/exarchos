# Design: Dual-Platform Workflow (Claude Code + Copilot CLI)

## Problem Statement

We need to maintain two parallel AI-assisted development workflows:

1. **Personal projects**: Continue using Claude Code with existing `.claude/` configuration
2. **Work (Microsoft internal)**: Use GitHub Copilot CLI to avoid sending tokens to Anthropic

Both workflows should provide the same productivity patterns:
- `/ideate` → `/plan` → `/delegate` → `/integrate` → `/review` → `/synthesize`
- TDD enforcement
- Orchestrator/implementer separation
- State persistence for context recovery
- Automated phase chaining

The challenge is maintaining both systems without duplication of effort.

## Chosen Approach

**Full Native Migration** for Copilot CLI while preserving Claude Code setup.

- Copilot configuration lives in `.github/` and `~/.copilot/`
- Claude Code configuration stays in `.claude/` and `~/.claude/`
- Shared components (state management, scripts) live in a portable location
- Each platform gets native skill/agent definitions optimized for its tools

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Workflow Logic (Shared)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  ideate  │→ │   plan   │→ │ delegate │→ │integrate │→ ...    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│     Claude Code         │     │    Copilot CLI          │
│  ~/.claude/             │     │  ~/.copilot/            │
│  .claude/skills/        │     │  .github/skills/        │
│  Task(), Skill()        │     │  /agent, /delegate      │
│  model: "opus"          │     │  model: "claude-sonnet" │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────┬───────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Shared State Management                         │
│  docs/workflow-state/*.state.json                                │
│  workflow-state.sh (portable script)                             │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

### Personal (Claude Code) - Existing

```
~/.claude/
├── scripts/
│   └── workflow-state.sh      # State management (SHARED)
├── rules/
│   ├── orchestrator-constraints.md
│   ├── tdd-typescript.md
│   └── coding-standards-*.md
├── skills -> ~/repos/lvlup-claude/skills/  # Symlink
└── settings.json

~/repos/project/.claude/
├── skills/
│   ├── brainstorming/SKILL.md
│   ├── implementation-planning/SKILL.md
│   ├── delegation/SKILL.md
│   ├── integration/SKILL.md
│   ├── spec-review/SKILL.md
│   ├── quality-review/SKILL.md
│   └── synthesis/SKILL.md
└── commands/
    ├── ideate.md
    ├── plan.md
    └── ...
```

### Work (Copilot CLI) - New

```
~/.copilot/
├── scripts/
│   └── workflow-state.sh      # Symlink to shared script
├── agents/
│   ├── orchestrator.agent.md  # Coordinator (no direct implementation)
│   ├── implementer.agent.md   # TDD-focused code writer
│   ├── reviewer.agent.md      # Spec + quality checks
│   └── integrator.agent.md    # Branch merging
├── mcp-config.json
└── config.json

~/repos/work-project/.github/
├── skills/
│   ├── brainstorming/SKILL.md
│   ├── implementation-planning/SKILL.md
│   ├── delegation/SKILL.md
│   ├── integration/SKILL.md
│   ├── spec-review/SKILL.md
│   ├── quality-review/SKILL.md
│   └── synthesis/SKILL.md
├── agents/
│   └── (repo-specific overrides)
└── copilot-instructions.md    # Repo-wide rules
```

### Shared Components

```
~/repos/lvlup-claude/
├── scripts/
│   └── workflow-state.sh      # Source of truth (both platforms symlink)
├── docs/
│   └── workflow-state/        # State files (platform-agnostic JSON)
└── shared/
    ├── tdd-principles.md      # Platform-agnostic TDD rules
    ├── coding-standards/      # Language-specific standards
    └── pr-guidelines.md       # PR description format
```

## Concept Mapping

| Concept | Claude Code | Copilot CLI |
|---------|-------------|-------------|
| **Skills location** | `.claude/skills/` | `.github/skills/` |
| **Global skills** | `~/.claude/skills/` | `~/.copilot/` (no global skills) |
| **Custom agents** | N/A (use Task tool) | `.github/agents/*.agent.md` |
| **Global agents** | N/A | `~/.copilot/agents/*.agent.md` |
| **Rules** | `~/.claude/rules/*.md` | `.github/copilot-instructions.md` |
| **State scripts** | `~/.claude/scripts/` | `~/.copilot/scripts/` |
| **Subagent dispatch** | `Task({ subagent_type, model, prompt })` | `/agent <name>` or auto-infer |
| **Skill invocation** | `Skill({ skill: "name" })` | Auto-triggered or explicit prompt |
| **Background tasks** | `Task({ run_in_background: true })` | `/delegate` to coding agent |
| **Model selection** | `model: "opus"` | `/model` or agent default |

## Tool Name Mapping

| Claude Code Tool | Copilot CLI Equivalent | Notes |
|------------------|------------------------|-------|
| `Task()` | `/agent` or `agent` tool | Custom agent invocation |
| `Skill()` | Auto-triggered skills | Skills load based on context |
| `Read` | `read` | File reading |
| `Edit` | `edit` | File editing |
| `Write` | `edit` | Copilot uses edit for writes |
| `Glob` | `search` | File pattern matching |
| `Grep` | `search` | Content search |
| `Bash` | `execute` / `shell` | Command execution |
| `TodoWrite` | `todo` | Task tracking |
| `WebSearch` | `web` | Web search |
| `WebFetch` | `web` | URL fetching |

## Skill Conversion Guide

### SKILL.md Format Changes

**Claude Code format** (current):
```markdown
# Skill Name

## Overview
Description of what the skill does.

## Triggers
When to activate this skill.

## Process
Step-by-step instructions...
```

**Copilot CLI format** (required):
```markdown
---
name: skill-name
description: "Brief description of what the skill does and when to use it (max 1024 chars)"
---

# Skill Name

## Overview
Description of what the skill does.

## Triggers
When to activate this skill.

## Process
Step-by-step instructions...
```

### Tool Reference Changes

**Claude Code** (in skill body):
```markdown
### Dispatch Implementer
\`\`\`typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task 001",
  prompt: "[Full implementer prompt]"
})
\`\`\`
```

**Copilot CLI** (in skill body):
```markdown
### Dispatch Implementer

Invoke the implementer agent:
\`\`\`
/agent implementer

Implement task 001 following TDD principles.
[Full task context here]
\`\`\`

Or use `/delegate` for async PR creation:
\`\`\`
/delegate Implement task 001: [description]
\`\`\`
```

### State Management (Unchanged)

Both platforms use the same state management:
```bash
# Initialize workflow
~/.copilot/scripts/workflow-state.sh init <feature-id>

# Update state
~/.copilot/scripts/workflow-state.sh set <state-file> '.phase = "delegate"'

# Read state
~/.copilot/scripts/workflow-state.sh get <state-file> '.tasks'
```

## Agent Definitions (Copilot CLI)

### orchestrator.agent.md

```markdown
---
name: orchestrator
description: "Workflow coordinator that manages phases, dispatches tasks, and tracks state. Does NOT write implementation code directly."
tools: ["read", "search", "todo", "agent"]
infer: false
---

# Orchestrator Agent

You are a workflow coordinator. Your role is to:
1. Parse and extract task details from plans
2. Dispatch work to implementer/reviewer agents
3. Manage workflow state files
4. Chain phases automatically

## Constraints

You MUST NOT:
- Write implementation code directly
- Fix review findings yourself
- Run integration tests inline
- Work in the main project root

You SHOULD:
- Read plans and extract task details
- Invoke `/agent implementer` for coding tasks
- Invoke `/agent reviewer` for reviews
- Update state via `workflow-state.sh`
- Chain to next phase on completion

## State Management

Use the workflow-state.sh script:
\`\`\`bash
~/.copilot/scripts/workflow-state.sh set <state-file> '<jq-expression>'
\`\`\`

## Phase Chaining

After each phase completes, automatically continue:
- plan complete → invoke implementer agents
- delegate complete → invoke integrator agent
- integrate complete → invoke reviewer agent
- review complete → create PR
```

### implementer.agent.md

```markdown
---
name: implementer
description: "TDD-focused code implementer that writes failing tests first, then minimum code to pass. Works in git worktrees."
tools: ["read", "edit", "search", "execute"]
infer: false
---

# Implementer Agent

You implement features following strict TDD (Red-Green-Refactor).

## The Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Process

1. **RED**: Write a failing test
   - Run tests, verify failure
   - Failure must be for the RIGHT reason

2. **GREEN**: Write minimum code to pass
   - Only what the test requires
   - No extra features

3. **REFACTOR**: Clean up (if needed)
   - Tests must stay green
   - Apply SOLID principles

## Worktree Requirement

You MUST work in a git worktree, never in main project root:
\`\`\`bash
# Verify you're in a worktree
git worktree list
pwd  # Should contain .worktrees/
\`\`\`

If not in a worktree, STOP and report to orchestrator.

## Completion

When done:
1. All tests pass
2. Commit changes with descriptive message
3. Report completion to orchestrator
```

### reviewer.agent.md

```markdown
---
name: reviewer
description: "Two-stage code reviewer: first checks spec compliance and TDD, then assesses code quality and security."
tools: ["read", "search", "execute"]
infer: false
---

# Reviewer Agent

You perform two-stage code review on the integrated branch.

## Stage 1: Spec Review

Verify:
- [ ] All requirements implemented
- [ ] Tests exist for all features
- [ ] Tests written before implementation (TDD)
- [ ] Test naming: `Method_Scenario_Outcome`
- [ ] Coverage >80% for new code

## Stage 2: Quality Review

Verify:
- [ ] SOLID principles followed
- [ ] Guard clauses used (not nested ifs)
- [ ] No security vulnerabilities
- [ ] Error handling appropriate
- [ ] No over-engineering

## Priority Levels

| Priority | Action |
|----------|--------|
| HIGH | Must fix before merge |
| MEDIUM | Should fix, may defer |
| LOW | Nice to have |

## Output

Generate review report with:
- Status: PASS / NEEDS_FIXES / BLOCKED
- Issues found (with file:line references)
- Suggested fixes

If NEEDS_FIXES, orchestrator will dispatch fixers.
```

### integrator.agent.md

```markdown
---
name: integrator
description: "Merges feature branches in dependency order, runs combined tests, and verifies integration before review."
tools: ["read", "search", "execute"]
infer: false
---

# Integrator Agent

You merge worktree branches and verify combined functionality.

## Process

1. **Create integration branch**
   \`\`\`bash
   git checkout main && git pull
   git checkout -b feature/integration-<name>
   \`\`\`

2. **Merge branches** (dependency order)
   \`\`\`bash
   git merge --no-ff feature/<task-branch> -m "Merge feature/<task>"
   npm run test:run  # After each merge
   \`\`\`

3. **Full verification**
   \`\`\`bash
   npm run test:run
   npm run typecheck
   npm run lint
   npm run build
   \`\`\`

4. **Report results**
   - PASS: All verification passed
   - FAIL: Which merge/test failed

## On Failure

Report to orchestrator with:
- Which branch caused failure
- Which tests failed
- Suggested fix approach
```

## Shared Components

### workflow-state.sh

The state management script is platform-agnostic (pure bash + jq):

```bash
#!/bin/bash
# Works on both Claude Code and Copilot CLI
# Location: symlinked to both ~/.claude/scripts/ and ~/.copilot/scripts/

case "$1" in
  init)   # Create new state file
  get)    # Read state value
  set)    # Update state value
  list)   # List active workflows
  summary) # Display workflow summary
  next-action) # Determine next auto-action
esac
```

### State File Schema

```json
{
  "feature": "feature-name",
  "phase": "ideate|plan|delegate|integrate|review|synthesize|completed",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "artifacts": {
    "design": "docs/designs/YYYY-MM-DD-feature.md",
    "plan": "docs/plans/YYYY-MM-DD-feature.md",
    "pr": "https://github.com/org/repo/pull/42"
  },
  "tasks": [
    {
      "id": "001",
      "title": "Task description",
      "status": "pending|in_progress|complete",
      "branch": "feature/001-name",
      "worktree": ".worktrees/001-name"
    }
  ],
  "integration": {
    "branch": "feature/integration-name",
    "status": "pending|in_progress|passed|failed",
    "mergedBranches": ["feature/001-name"]
  },
  "reviews": {
    "spec": { "status": "pass|fail", "issues": [] },
    "quality": { "status": "approved|needs_fixes", "issues": [] }
  }
}
```

## Migration Checklist

### Phase 0: Windows Installation Script

- [ ] Create `install-copilot-workflow.ps1` PowerShell script
- [ ] Port `workflow-state.sh` to `workflow-state.ps1` (or create Git Bash wrapper)
- [ ] Add jq installation/detection logic
- [ ] Add validation checks (Copilot CLI, jq, agents)
- [ ] Test on fresh Windows machine

### Phase 1: Setup Infrastructure

- [ ] Create `~/.copilot/` directory structure
- [ ] Install `workflow-state.ps1` to `~/.copilot/scripts/`
- [ ] Create global agents in `~/.copilot/agents/`
- [ ] Configure `~/.copilot/config.json`

### Phase 2: Convert Skills

For each skill in `.claude/skills/`:

- [ ] Add YAML frontmatter (`name`, `description`)
- [ ] Replace `Task()` references with `/agent` or `/delegate`
- [ ] Replace `Skill()` references with skill triggers
- [ ] Update tool names (Bash → execute, etc.)
- [ ] Test skill activation

Skills to convert:
- [ ] brainstorming
- [ ] implementation-planning
- [ ] delegation
- [ ] integration
- [ ] spec-review
- [ ] quality-review
- [ ] synthesis

### Phase 3: Convert Rules

- [ ] Create `.github/copilot-instructions.md` with:
  - [ ] Orchestrator constraints
  - [ ] TDD requirements
  - [ ] Coding standards
  - [ ] PR guidelines

### Phase 4: Test Workflow

- [ ] Test `/ideate` → design creation
- [ ] Test `/plan` → task breakdown
- [ ] Test `/delegate` → implementer dispatch
- [ ] Test `/integrate` → branch merging
- [ ] Test `/review` → two-stage review
- [ ] Test `/synthesize` → PR creation
- [ ] Test auto-chaining between phases
- [ ] Test state persistence across sessions

### Phase 5: Documentation

- [ ] Update README with dual-platform instructions
- [ ] Document platform-specific differences
- [ ] Create quick-start guides for each platform

## Open Questions

1. **Copilot `/delegate` vs custom agents**: The `/delegate` command creates PRs via Copilot coding agent. Should we use this for async work, or keep everything in custom agents for consistency?

2. **Skill auto-triggering**: Copilot auto-triggers skills based on prompts. Do we need explicit `/skill` commands, or rely on description matching?

3. **Model selection**: Copilot defaults to Claude Sonnet 4.5. Is this sufficient for complex TDD tasks, or should we specify a different model?

4. **Parallel execution**: Copilot CLI's subagent model differs from Claude Code's Task tool. Need to verify parallel worktree execution patterns.

## Windows Installation Script

A PowerShell installation script is required for Windows/Copilot CLI setup. This script must:

### Requirements

1. **Create directory structure**
   ```
   $env:USERPROFILE\.copilot\
   ├── scripts\
   ├── agents\
   └── config.json
   ```

2. **Install workflow-state script**
   - Port `workflow-state.sh` to PowerShell (`workflow-state.ps1`)
   - Or install Git Bash/WSL and symlink the bash version
   - Ensure `jq` is available (via winget, scoop, or bundled)

3. **Copy/install agents**
   - Copy `.agent.md` files to `~\.copilot\agents\`
   - Set appropriate file permissions

4. **Configure Copilot CLI**
   - Create `config.json` with default settings
   - Set up MCP server configuration if needed

5. **Validate installation**
   - Check Copilot CLI is installed (`copilot --version`)
   - Verify agent files are readable
   - Test `workflow-state` script execution
   - Confirm `jq` is available

### Script Interface

```powershell
# install-copilot-workflow.ps1

param(
    [string]$SourceRepo = ".",           # Path to lvlup-claude repo
    [switch]$UseBashScript,              # Use bash version via Git Bash
    [switch]$Force,                      # Overwrite existing files
    [switch]$SkipValidation              # Skip post-install validation
)

# Usage:
# .\install-copilot-workflow.ps1 -SourceRepo "C:\repos\lvlup-claude"
# .\install-copilot-workflow.ps1 -UseBashScript  # Requires Git Bash
```

### Platform Considerations

| Concern | Solution |
|---------|----------|
| Path separators | Use `[IO.Path]::Combine()` or PowerShell paths |
| Line endings | Ensure LF for bash scripts, CRLF okay for PS1 |
| jq availability | Install via winget/scoop or bundle jq.exe |
| Symlinks | Use junctions or copy (symlinks need admin on Windows) |
| Git Bash | Optional dependency for bash script compatibility |

### Workflow State on Windows

Two options:

**Option A: Native PowerShell** (recommended for pure Windows)
- Port `workflow-state.sh` to `workflow-state.ps1`
- Same interface, PowerShell implementation
- No external dependencies beyond jq

**Option B: Git Bash wrapper** (for consistency)
- Wrapper script calls bash version via Git Bash
- `workflow-state.cmd` that invokes `bash workflow-state.sh`
- Requires Git for Windows installed

## Testing Strategy

Create a test repository with:
1. Simple feature to implement (e.g., "add user validation")
2. Run full workflow on both platforms
3. Compare: time to completion, code quality, state consistency
4. Document any behavioral differences

## References

- [GitHub Copilot Agent Skills](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
- [Custom Agents Configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Creating Custom Agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents)
- [Using Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli)
