# Design: Dual-Platform Workflow (Claude Code + OpenCode)

**Date**: 2026-01-19
**Feature ID**: opencode-dual-platform
**Status**: Design Complete

## Problem Statement

The Copilot CLI migration (2026-01-06) failed because GitHub Copilot CLI lacks:
- Custom slash commands/skills
- Subagent spawning capabilities

We need a work-compliant alternative that provides feature parity with Claude Code while using Microsoft-approved AI providers (Azure OpenAI or GitHub Models).

**OpenCode** is an open-source AI coding agent that supports:
- Custom commands and skills (with `~/.claude/skills/` compatibility)
- Subagent system with Task tool and `@mention` invocation
- 75+ AI providers including Azure OpenAI and GitHub Models
- MCP server support for Azure DevOps integration

This design maintains both platforms in parallel:
- **Personal projects**: Claude Code with Anthropic API
- **Work projects**: OpenCode with Azure OpenAI/GitHub Models

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
│     Claude Code         │     │       OpenCode          │
│  ~/.claude/             │     │  ~/.config/opencode/    │
│  .claude/skills/        │     │  .opencode/             │
│  Task(), Skill()        │     │  @agent, skill()        │
│  model: "opus"          │     │  model: azure/gpt-4o    │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────┬───────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Shared Components                               │
│  ~/.claude/skills/           (both platforms search this path)  │
│  docs/workflow-state/        (platform-agnostic JSON state)     │
│  ~/.claude/scripts/          (bash scripts work in both)        │
└─────────────────────────────────────────────────────────────────┘
```

## Key Insight: Shared Skill Path

OpenCode natively searches these paths for skills:
1. `.opencode/skills/<name>/SKILL.md` (project-local)
2. **`.claude/skills/<name>/SKILL.md`** (Claude-compatible, project-local)
3. `~/.config/opencode/skills/*/SKILL.md` (global)
4. **`~/.claude/skills/*/SKILL.md`** (Claude-compatible, global)

This means **existing skills work in both platforms** with minimal modification (adding YAML frontmatter).

## Directory Structure

### Shared (Both Platforms)

```
~/.claude/
├── scripts/
│   └── workflow-state.sh      # State management (works in both)
├── skills/                    # SHARED - both platforms read this
│   ├── brainstorming/SKILL.md
│   ├── implementation-planning/SKILL.md
│   ├── delegation/SKILL.md
│   ├── integration/SKILL.md
│   ├── spec-review/SKILL.md
│   ├── quality-review/SKILL.md
│   └── synthesis/SKILL.md
└── rules/                     # Claude Code only (OpenCode uses instructions)
    ├── orchestrator-constraints.md
    └── tdd-typescript.md

~/repos/project/
├── docs/
│   ├── designs/               # Design documents
│   ├── plans/                 # Implementation plans
│   └── workflow-state/        # State files (platform-agnostic)
```

### Claude Code Specific

```
~/.claude/
├── settings.json
└── commands/
    ├── ideate.md
    ├── plan.md
    └── ...

~/repos/project/.claude/
└── settings.json              # Project-specific settings
```

### OpenCode Specific

```
~/.config/opencode/
├── opencode.json              # Global config (providers, keybinds)
├── agents/                    # Global agent definitions
│   ├── orchestrator.md
│   ├── implementer.md
│   ├── reviewer.md
│   └── integrator.md
├── commands/                  # Global commands
│   ├── ideate.md
│   ├── plan.md
│   └── ...
└── auth.json                  # Provider credentials (auto-generated)

~/repos/project/
├── opencode.json              # Project config
└── .opencode/
    ├── agents/                # Project-specific agent overrides
    └── commands/              # Project-specific commands
```

## Concept Mapping

| Concept | Claude Code | OpenCode |
|---------|-------------|----------|
| **Skills location** | `~/.claude/skills/` | `~/.claude/skills/` ✓ (same) |
| **Commands** | `.claude/commands/*.md` | `.opencode/commands/*.md` |
| **Agents** | N/A (use Task tool) | `.opencode/agents/*.md` |
| **Rules/Instructions** | `~/.claude/rules/*.md` | `opencode.json` → `instructions` |
| **Subagent dispatch** | `Task({ subagent_type, prompt })` | `@agent` mention or Task tool |
| **Skill invocation** | `Skill({ skill: "name" })` | `skill({ name: "name" })` |
| **Model selection** | `model: "opus"` | `model: "azure/gpt-4o"` |
| **State scripts** | `~/.claude/scripts/` | `~/.claude/scripts/` ✓ (same) |

## Tool Name Mapping

| Claude Code | OpenCode | Notes |
|-------------|----------|-------|
| `Task()` | Task tool or `@agent` | Subagent invocation |
| `Skill()` | `skill()` | Skill loading |
| `Read` | `read` | File reading |
| `Edit` | `edit` | File editing |
| `Write` | `write` | File creation |
| `Glob` | `glob` | Pattern matching |
| `Grep` | `grep` | Content search |
| `Bash` | `bash` | Command execution |
| `TodoWrite` | `todowrite` | Task tracking |
| `WebSearch` | N/A | Use `webfetch` |
| `WebFetch` | `webfetch` | URL fetching |

## Skill Adaptation

### Minimal Changes Required

Skills need YAML frontmatter for OpenCode. The body content remains largely unchanged.

**Before (Claude Code only):**
```markdown
# Brainstorming Skill

## Overview
Collaborative design exploration...
```

**After (Both platforms):**
```markdown
---
name: brainstorming
description: "Collaborative design exploration for new features and architecture decisions"
---

# Brainstorming Skill

## Overview
Collaborative design exploration...
```

### Tool Reference Abstraction

For skills that dispatch subagents, use conditional syntax or abstract the dispatch:

**Option A: Platform-agnostic prose**
```markdown
### Dispatch Implementer

Invoke the implementer agent with the following context:
- Task ID and title from the plan
- Worktree path for isolated work
- TDD constraints from rules

The implementer should work in the designated worktree and
commit changes when tests pass.
```

**Option B: Platform-specific sections**
```markdown
### Dispatch Implementer

<details>
<summary>Claude Code</summary>

Task({
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "[Implementer prompt]"
})

</details>

<details>
<summary>OpenCode</summary>

@implementer [Implementer prompt]

</details>
```

**Recommendation:** Option A (platform-agnostic prose) is preferred. Both platforms' LLMs can interpret the intent and use their native dispatch mechanisms.

## Agent Definitions (OpenCode)

### orchestrator.md

```markdown
---
name: orchestrator
description: "Workflow coordinator that manages phases, dispatches tasks, and tracks state. Does NOT write implementation code."
mode: primary
tools:
  write: false
  edit: false
---

# Orchestrator Agent

You are a workflow coordinator. Your role is to:
1. Parse and extract task details from plans
2. Dispatch work to @implementer, @reviewer, @integrator agents
3. Manage workflow state via ~/.claude/scripts/workflow-state.sh
4. Track phase completion and transition

## Constraints

You MUST NOT:
- Write implementation code directly
- Fix review findings yourself
- Run integration tests inline
- Work in the main project root

You SHOULD:
- Read plans and extract task details
- Invoke @implementer for coding tasks
- Invoke @reviewer for reviews
- Update state files after each phase
```

### implementer.md

```markdown
---
name: implementer
description: "TDD-focused code implementer that writes failing tests first, then minimum code to pass. Works in git worktrees."
mode: subagent
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

## Worktree Requirement

You MUST work in a git worktree, never in main project root:
```bash
git worktree list
pwd  # Should contain .worktrees/
```

If not in a worktree, STOP and report to orchestrator.
```

### reviewer.md

```markdown
---
name: reviewer
description: "Two-stage code reviewer: spec compliance and TDD verification, then code quality and security."
mode: subagent
tools:
  write: false
  edit: false
---

# Reviewer Agent

You perform two-stage code review on the integrated branch.

## Stage 1: Spec Review

- [ ] All requirements implemented
- [ ] Tests exist for all features
- [ ] Tests written before implementation (TDD)
- [ ] Coverage adequate for new code

## Stage 2: Quality Review

- [ ] SOLID principles followed
- [ ] Guard clauses used (not nested ifs)
- [ ] No security vulnerabilities
- [ ] Error handling appropriate

## Output

Generate review report with:
- Status: PASS / NEEDS_FIXES / BLOCKED
- Issues found (with file:line references)
- Suggested fixes
```

### integrator.md

```markdown
---
name: integrator
description: "Merges feature branches in dependency order, runs combined tests, verifies integration."
mode: subagent
---

# Integrator Agent

You merge worktree branches and verify combined functionality.

## Process

1. Create integration branch from main
2. Merge task branches in dependency order
3. Run tests after each merge
4. Full verification: test, typecheck, lint, build
5. Report results to orchestrator
```

## OpenCode Configuration

### Global Config (~/.config/opencode/opencode.json)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "azure/gpt-4o",
  "small_model": "azure/gpt-4o-mini",
  "provider": {
    "azure": {
      "options": {
        "timeout": 600000
      }
    }
  },
  "default_agent": "orchestrator",
  "instructions": [
    "Follow TDD principles: write failing tests before implementation",
    "Use git worktrees for parallel task execution",
    "Update workflow state after each phase transition"
  ],
  "mcp": {
    "azure-devops": {
      "type": "local",
      "command": ["npx", "@anthropic/azure-devops-mcp"],
      "environment": {
        "AZURE_DEVOPS_ORG_URL": "{env:AZURE_DEVOPS_ORG_URL}",
        "AZURE_DEVOPS_PAT": "{env:AZURE_DEVOPS_PAT}"
      }
    }
  },
  "permission": {
    "edit": "allow",
    "bash": "ask",
    "webfetch": "allow"
  }
}
```

### Project Config (opencode.json)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [
    "This project uses TypeScript with Vitest for testing",
    "Run 'npm run test:run' to execute tests"
  ]
}
```

## Command Definitions (OpenCode)

### ideate.md

```markdown
---
name: ideate
description: "Start collaborative design exploration for a feature"
agent: orchestrator
---

Begin brainstorming session for: $ARGUMENTS

Load and follow the brainstorming skill: skill({ name: "brainstorming" })

After design is saved:
1. Update workflow state with design path
2. Ask user to confirm before continuing to /plan
```

### plan.md

```markdown
---
name: plan
description: "Create TDD implementation plan from design document"
agent: orchestrator
---

Create implementation plan for: $ARGUMENTS

Load and follow the planning skill: skill({ name: "implementation-planning" })

After plan is saved:
1. Update workflow state with plan path
2. Continue to /delegate (or pause if auto-chain disabled)
```

### delegate.md

```markdown
---
name: delegate
description: "Dispatch implementation tasks to subagents"
agent: orchestrator
---

Delegate tasks from plan: $ARGUMENTS

Load and follow the delegation skill: skill({ name: "delegation" })

For each task:
1. Create git worktree
2. Dispatch @implementer with task context
3. Track completion in state file
```

## State Management

Both platforms use the same state management:

```bash
# Works identically in Claude Code and OpenCode (both have bash tool)
~/.claude/scripts/workflow-state.sh init <feature-id>
~/.claude/scripts/workflow-state.sh set <state-file> '.phase = "delegate"'
~/.claude/scripts/workflow-state.sh get <state-file> '.tasks'
~/.claude/scripts/workflow-state.sh summary <state-file>
~/.claude/scripts/workflow-state.sh next-action <state-file>
```

State file schema remains unchanged from the Copilot CLI design.

## Provider Configuration

### Azure OpenAI Setup

```bash
# In WSL/Git Bash
export AZURE_RESOURCE_NAME="your-resource-name"
export AZURE_API_KEY="your-api-key"

# Or use Azure CLI auth
az login
```

Then run `/connect` in OpenCode to configure.

### GitHub Models Setup

```bash
export GITHUB_TOKEN="your-github-token"
```

Configure in opencode.json:
```json
{
  "model": "github/gpt-4o",
  "provider": {
    "github": {}
  }
}
```

## Migration Checklist

### Phase 0: Prerequisites

- [ ] Verify OpenCode has no critical CVEs (`npm audit`, GitHub security advisories)
- [ ] Install OpenCode in WSL: `npm install -g opencode` or `cargo install opencode`
- [ ] Verify Azure OpenAI or GitHub Models access
- [ ] Test basic OpenCode functionality with work credentials

### Phase 1: Shared Infrastructure

- [ ] Add YAML frontmatter to all skills in `~/.claude/skills/`
- [ ] Verify skills load in OpenCode: `/skills` command
- [ ] Test workflow-state.sh works from OpenCode's bash tool

### Phase 2: OpenCode Configuration

- [ ] Create `~/.config/opencode/opencode.json` with Azure/GitHub provider
- [ ] Create agent definitions in `~/.config/opencode/agents/`
- [ ] Create command definitions in `~/.config/opencode/commands/`
- [ ] Configure MCP server for Azure DevOps (if using ADO)

### Phase 3: Skill Adaptation

For each skill, verify it works in OpenCode:
- [ ] brainstorming
- [ ] implementation-planning
- [ ] delegation
- [ ] integration
- [ ] spec-review
- [ ] quality-review
- [ ] synthesis

### Phase 4: Workflow Validation

- [ ] Test `/ideate` → design creation
- [ ] Test `/plan` → task breakdown
- [ ] Test `/delegate` → @implementer dispatch
- [ ] Test `/integrate` → branch merging
- [ ] Test `/review` → two-stage review
- [ ] Test `/synthesize` → PR creation
- [ ] Test state persistence across sessions
- [ ] Test worktree creation and isolation

### Phase 5: Documentation

- [ ] Update README with dual-platform instructions
- [ ] Document platform-specific differences
- [ ] Create quick-start guide for OpenCode setup

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenCode CVE discovered | Medium | High | Pin version, monitor advisories, have rollback plan |
| Subagent depth limitation | Low | High | Test early; fall back to Hybrid approach if needed |
| Azure OpenAI rate limits | Medium | Medium | Implement retry logic, use smaller models for simple tasks |
| Skill incompatibility | Low | Medium | Skills are prose-based; LLMs adapt to platform tools |
| State script incompatibility | Very Low | Low | Pure bash + jq; works in any POSIX shell |

## Open Questions

1. **Subagent nesting depth**: Can an OpenCode agent spawn another agent that spawns another? Need to test orchestrator → implementer pattern.

2. **Parallel subagent execution**: Can OpenCode run multiple @implementer sessions in parallel worktrees? Documentation mentions "parallel work sessions" with keybinds.

3. **Model capability**: Is Azure GPT-4o sufficient for complex TDD tasks, or should we use GPT-4-turbo for orchestration?

4. **Auto-chaining**: OpenCode commands don't explicitly support chaining. May need orchestrator agent to handle phase transitions manually.

## Success Criteria

1. **Workflow parity**: All 7 phases (ideate → synthesize) function in OpenCode
2. **Skill reuse**: Existing skills work with only frontmatter additions
3. **State compatibility**: Same state files work across both platforms
4. **Work compliance**: All AI calls go through Azure/GitHub Models
5. **No regression**: Claude Code workflow continues to work unchanged

## References

- [OpenCode Documentation](https://opencode.ai/docs)
- [OpenCode Agents](https://opencode.ai/docs/agents)
- [OpenCode Skills](https://opencode.ai/docs/skills)
- [OpenCode Providers](https://opencode.ai/docs/providers)
- [Azure OpenAI Setup](https://opencode.ai/docs/providers/azure)
- [Previous Design: Copilot CLI Migration](./2026-01-06-copilot-cli-migration.md)
- [Previous Design: Copilot ADO Port](./2026-01-06-copilot-ado-port.md)
