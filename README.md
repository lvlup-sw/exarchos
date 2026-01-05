# Claude Code Global Configuration

Shared configuration for Claude Code across all repositories. Provides a consistent development workflow with TDD enforcement, orchestration skills, and the Jules integration plugin.

## Quick Start

```bash
# Clone the repo
git clone <repo-url> ~/Documents/code/claude-config
cd ~/Documents/code/claude-config

# Install (creates symlinks to ~/.claude/)
./scripts/install.sh
```

**That's it.** After installation, all commands work in every project automatically.

## Daily Usage

### Commands Work Everywhere

After running `install.sh` once, the global commands are available in **any directory**:

```bash
cd ~/Documents/code/any-project
claude
> /plan           # Works immediately
> /delegate       # Works immediately
> /review         # Works immediately
```

No per-project setup required.

### New Projects

For new projects, you have two options:

**Option A: Just start working** (recommended)
```bash
cd ~/Documents/code/new-project
claude
> /ideate my new feature
```
Global config is already available.

**Option B: Add project context** (optional)
```bash
./scripts/new-project.sh ~/Documents/code/new-project --typescript
```
This creates a `CLAUDE.md` with project-specific details (test commands, structure).

### Existing Projects with Design Documents

If you already have design documents, use them directly:

```bash
cd ~/Documents/code/existing-project
claude

# Reference your existing design doc
> /plan @docs/designs/my-feature.md

# Or describe what you want
> Create a TDD implementation plan for the feature in docs/designs/auth-system.md
```

The workflow will:
1. Read your existing design document
2. Break it into TDD tasks (`[RED]`, `[GREEN]`, `[REFACTOR]`)
3. Identify parallel-safe task groups
4. Let you `/delegate` to Jules or subagents

**You don't need to modify existing design docs** - just reference them.

### What Requires Setup vs What Doesn't

| Action | Setup Required? |
|--------|-----------------|
| Use `/plan`, `/delegate`, etc. | No - works after install.sh |
| Use in a new project | No - global config available everywhere |
| Use with existing design docs | No - just reference them |
| Add project-specific test commands | Optional - create CLAUDE.md |
| Override global rules for a project | Optional - create .claude/rules/ |

## What's Included

### Skills (7)

Workflow orchestration patterns that Claude Code invokes automatically:

| Skill | Purpose |
|-------|---------|
| `brainstorming` | Collaborative design exploration with trade-offs |
| `implementation-planning` | TDD task decomposition (Iron Law: test first) |
| `git-worktrees` | Parallel development environments |
| `delegation` | Dispatch to Jules (async) or Task tool (sync) |
| `spec-review` | Stage 1: Functional completeness verification |
| `quality-review` | Stage 2: Code quality and SOLID compliance |
| `synthesis` | Branch merge and PR creation |

### Commands (6)

Slash commands for the orchestration workflow:

| Command | Purpose |
|---------|---------|
| `/ideate` | Start design exploration for a feature |
| `/plan` | Create TDD implementation plan |
| `/delegate` | Dispatch tasks to Jules or subagents |
| `/review` | Run two-stage review (spec → quality) |
| `/synthesize` | Merge branches and create PR |
| `/tdd` | TDD workflow reference |

### Rules (4)

Language-specific coding standards applied automatically:

| Rule | Applies To |
|------|-----------|
| `tdd-typescript.md` | `**/*.ts`, `**/*.tsx` |
| `tdd-csharp.md` | `**/*.cs` |
| `coding-standards-typescript.md` | `**/*.ts`, `**/*.tsx` |
| `coding-standards-csharp.md` | `**/*.cs` |

### Plugins (1)

| Plugin | Purpose |
|--------|---------|
| `jules` | MCP integration for Jules autonomous coding agent |

## How It Works

### Configuration Discovery

Claude Code checks locations in priority order:

1. **Project local**: `./.claude/` (highest priority)
2. **Global**: `~/.claude/` (this repo, via symlinks)

Project-local config **overrides** global config for that project.

### Installation Creates These Symlinks

```
~/.claude/skills     -> ~/Documents/code/claude-config/skills
~/.claude/commands   -> ~/Documents/code/claude-config/commands
~/.claude/rules      -> ~/Documents/code/claude-config/rules
~/.claude/plugins/jules -> ~/Documents/code/claude-config/plugins/jules
~/.claude/settings.json -> ~/Documents/code/claude-config/settings.json
```

### New Project Setup

When you run `new-project.sh`, it creates:

```
your-project/
├── CLAUDE.md              # Project context (from template)
└── .claude/
    └── settings.json      # Local permission overrides
```

## Repository Structure

```
claude-config/
├── README.md              # This file
├── CHANGELOG.md           # Update history (sparse)
├── settings.json          # Global permissions
├── CLAUDE.md.template     # Template for new projects
├── skills/                # Orchestration skills
│   ├── brainstorming/
│   ├── implementation-planning/
│   ├── git-worktrees/
│   ├── delegation/
│   │   └── references/
│   ├── spec-review/
│   ├── quality-review/
│   └── synthesis/
├── commands/              # Slash commands
│   ├── ideate.md
│   ├── plan.md
│   ├── delegate.md
│   ├── review.md
│   ├── synthesize.md
│   └── tdd.md
├── rules/                 # Language-specific rules
│   ├── tdd-typescript.md
│   ├── tdd-csharp.md
│   ├── coding-standards-typescript.md
│   └── coding-standards-csharp.md
├── plugins/
│   └── jules/             # Jules MCP plugin
└── scripts/
    ├── install.sh         # One-time global setup
    └── new-project.sh     # Per-project setup
```

## The Orchestration Workflow

```
[Ideate] → [Plan] → [Delegate] → [Implement] → [Spec Review] → [Quality Review] → [Synthesize] → [PR]
               ↓                       ↑               ↑
          [Worktrees]             [Fix Loop]      [Fix Loop]
```

### Phase 1: Ideation (`/ideate`)

Collaborative design exploration:
1. Ask clarifying questions (one at a time)
2. Present 2-3 approaches with trade-offs
3. Document chosen approach in `docs/designs/`

### Phase 2: Planning (`/plan`)

TDD implementation breakdown:
- **Iron Law**: Every task starts with a failing test
- Tasks labeled with `[RED]`, `[GREEN]`, `[REFACTOR]` phases
- Identify parallel-safe task groups

### Phase 3: Delegation (`/delegate`)

Dispatch to implementers:
- **Jules**: Async PRs via `jules_create_task`
- **Task tool**: Sync subagents with `model: "opus"`
- Create git worktrees for parallel execution

### Phase 4: Review (`/review`)

Two-stage review process:
1. **Spec Review**: Functional completeness, TDD compliance
2. **Quality Review**: SOLID, error handling, security

### Phase 5: Synthesis (`/synthesize`)

Final integration:
- Merge worktree branches in dependency order
- Run full test suite
- Create PR with `gh pr create`

## TDD Enforcement

All code changes follow strict Test-Driven Development:

```
1. RED:      Write a failing test FIRST
2. GREEN:    Write MINIMUM code to pass
3. REFACTOR: Clean up while tests stay green
```

**Prohibited:**
- Writing implementation before tests
- Skipping the RED phase
- Adding untested features

## Coding Standards

### Control Flow
- Guard clauses at method entry
- Early returns (no arrow code)
- Extract complex conditionals

### Structure
- One public type per file
- Composition over inheritance (depth ≤ 2)
- Sealed by default

See `rules/coding-standards-{language}.md` for language-specific details.

## Jules Plugin

The Jules plugin enables delegation to Google's Jules autonomous coding agent.

### Setup

1. Get API key from [jules.google/settings](https://jules.google/settings)
2. Add to shell profile:
   ```bash
   echo 'export JULES_API_KEY="your-key"' >> ~/.zshrc
   source ~/.zshrc
   ```
3. Connect repositories via the Jules GitHub App at [jules.google](https://jules.google)

**That's all.** No need to manually start the MCP server - Claude Code launches it automatically when you use Jules tools.

### How Commands Relate

There are two ways to use Jules:

| Command | Level | Description |
|---------|-------|-------------|
| `/delegate` | Global workflow | Uses Jules as part of the orchestration workflow |
| `/jules:delegate` | Plugin direct | Direct access to Jules (bypasses workflow) |

**Use `/delegate`** (the global command) for normal workflow - it integrates with TDD planning, worktrees, and review stages.

**Use `/jules:*`** commands for direct Jules access when you want to bypass the orchestration workflow.

### Available Tools

| Tool | Purpose |
|------|---------|
| `jules_list_sources` | List connected repositories |
| `jules_create_task` | Create a new coding task |
| `jules_check_status` | Check task progress |
| `jules_approve_plan` | Approve execution plan |
| `jules_send_feedback` | Send instructions to Jules |
| `jules_cancel` | Cancel a task |

## Updating Global Config

**Policy**: Update sparingly, for high-signal changes only.

1. Test changes in a project first
2. Edit files in this repo
3. Document in `CHANGELOG.md`
4. Commit and push

Changes take effect immediately (symlinks).

## Project-Specific Overrides

Projects can override global config:

```bash
# Add project-specific rule
echo "---
paths: '**/*.ts'
---
# My project rule
..." > .claude/rules/my-rule.md

# Override permissions
echo '{
  "permissions": {
    "allow": ["Bash(npm run custom-script)"]
  }
}' > .claude/settings.json
```

## Troubleshooting

### Commands not available

Check symlinks exist:
```bash
ls -la ~/.claude/commands
```

Re-run installation if needed:
```bash
./scripts/install.sh
```

### Jules plugin not working

1. Verify API key is set: `echo $JULES_API_KEY`
2. Check plugin symlink: `ls -la ~/.claude/plugins/jules`
3. Reinstall deps: `cd ~/.claude/plugins/jules/servers/jules-mcp && npm install`

### Rules not applying

Rules apply based on file path patterns in frontmatter:
```yaml
---
paths: "**/*.ts"
---
```

Verify your file matches the glob pattern.
