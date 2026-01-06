# Jules Plugin for Claude Code

Delegate coding tasks to [Google Jules](https://jules.google), an autonomous coding agent.

## Mental Model: Senior/Junior Engineer Pairing

```
┌─────────────────────────────────────────────────────────────────┐
│                    YOU (via Claude Code)                         │
│                    = SENIOR ENGINEER                             │
│  Reviews work · Makes architectural decisions · Merges PRs      │
└────────────────────────────┬────────────────────────────────────┘
                             │ Delegates tasks
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    JULES                                         │
│                    = JUNIOR ENGINEER                             │
│  Executes well-defined tasks · Opens PRs for review             │
└─────────────────────────────────────────────────────────────────┘
```

Jules is a capable junior engineer, not just a peripheral task runner. You can delegate substantial coding work, but you (via Claude Code) review and approve all changes.

## Installation

### Prerequisites

1. **Jules Account**: Sign up at [jules.google](https://jules.google)
2. **API Key**: Generate at [jules.google/settings](https://jules.google/settings)
3. **Connected Repositories**: Install the Jules GitHub App on your repos

### Setup

1. **Get API key** from [jules.google/settings](https://jules.google/settings)

2. **Add to shell profile** (~/.zshrc or ~/.bashrc):
   ```bash
   echo 'export JULES_API_KEY="your-api-key"' >> ~/.zshrc
   source ~/.zshrc
   ```

3. **Connect repositories** via the Jules GitHub App at [jules.google](https://jules.google)

**That's all.** The MCP server launches automatically when Claude Code uses Jules tools - no manual startup required.

### How It Works

When you use a Jules tool, Claude Code:
1. Reads `.mcp.json` to find the server config
2. Launches the MCP server via `npx tsx`
3. Communicates with Jules API using your `JULES_API_KEY`
4. Returns results to your conversation

## Usage

### Global vs Plugin Commands

If you're using the global lvlup-claude, prefer the **global workflow commands**:

| Command | Description |
|---------|-------------|
| `/delegate` | Full workflow: TDD planning → Jules/subagents → review |
| `/review` | Two-stage review of completed work |
| `/synthesize` | Merge and create PR |

The global `/delegate` command uses Jules under the hood but integrates with TDD enforcement, git worktrees, and the review workflow.

### Plugin-Direct Commands

For direct Jules access (bypassing the workflow):

| Command | Description |
|---------|-------------|
| `/jules:delegate <task>` | Delegate a coding task to Jules |
| `/jules:status <session-id>` | Check the status of a Jules session |
| `/jules:sessions` | List connected repositories |

### MCP Tools

The plugin provides 6 MCP tools accessible via Claude Code:

| Tool | Description |
|------|-------------|
| `jules_list_sources` | List repositories connected to Jules |
| `jules_create_task` | Create a new task session |
| `jules_check_status` | Check session status and get PR URL |
| `jules_approve_plan` | Approve a pending execution plan |
| `jules_send_feedback` | Send feedback to a session |
| `jules_cancel` | Cancel/delete a session |

### Example Workflow

```bash
# 1. List connected repositories
/jules:sessions

# 2. Delegate a task
/jules:delegate Add user profile feature with TDD

# 3. Check status (returns session ID)
/jules:status abc123

# 4. When status is AWAITING_PLAN_APPROVAL, review and approve
# (Use jules_approve_plan tool)

# 5. When completed, review the PR
# (PR URL provided in status response)
```

## Session States

| State | Description | Next Action |
|-------|-------------|-------------|
| `QUEUED` | Task waiting to be processed | Wait |
| `PLANNING` | Jules creating execution plan | Wait |
| `AWAITING_PLAN_APPROVAL` | Plan ready for review | Approve or provide feedback |
| `IN_PROGRESS` | Jules implementing the task | Wait |
| `COMPLETED` | Task done, PR created | Review PR |
| `FAILED` | Task failed | Check error, retry |

## Suitable Tasks for Jules

Jules excels at well-defined tasks:

- Feature implementation (with clear spec)
- Bug fixes (with reproduction steps)
- Refactoring tasks (with defined scope)
- Documentation and API docs
- Database migrations
- Configuration scaffolding
- Non-security-critical components

## TDD Workflow

Since all coding follows strict TDD (Red-Green-Refactor):

1. **Include test requirements** in the task description
2. **Jules writes tests first**, then implementation
3. **You review** both tests and implementation in the PR

## Development

### Build

```bash
cd servers/jules-mcp
npm install
npm run build
```

### Test

```bash
npm test           # Watch mode
npm run test:run   # Single run
npm run test:coverage  # With coverage
```

### Type Check

```bash
npm run typecheck
```

## Plugin Structure

```
jules-plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                  # MCP server configuration
├── commands/
│   ├── delegate.md           # /jules:delegate
│   ├── status.md             # /jules:status
│   └── sessions.md           # /jules:sessions
├── servers/
│   └── jules-mcp/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── types.ts
│           ├── jules-client.ts
│           ├── tools.ts
│           └── index.ts
└── README.md
```

## API Reference

### Jules API

- Base URL: `https://jules.google/v1alpha/`
- Auth: `X-Goog-Api-Key` header
- Docs: [jules.google/docs/api/reference](https://jules.google/docs/api/reference)

## License

MIT
