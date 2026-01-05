# Jules Integration Design Document

## 1. Executive Summary

This document describes the integration of Google Jules as an **external autonomous coding agent** in the Claude Code workflow, bundled as a **reusable Claude Code plugin**.

### Mental Model: Senior/Junior Engineer Pairing

```
┌─────────────────────────────────────────────────────────────────┐
│                    YOU (via Claude Code)                         │
│                    = SENIOR ENGINEER                             │
│  Reviews work • Makes architectural decisions • Merges PRs      │
│  Maintains quality standards • Handles critical security code   │
└────────────────────────────┬────────────────────────────────────┘
                             │ Delegates tasks
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    JULES                                         │
│                    = JUNIOR ENGINEER                             │
│  Executes well-defined tasks • Opens PRs for review             │
│  Follows instructions • Asks questions when unclear             │
└─────────────────────────────────────────────────────────────────┘
```

**Key Insight:** Jules is a capable junior engineer, not just a peripheral task runner. You can delegate substantial coding work, but you (via Claude Code) review and approve all changes.

### TDD Consideration

Since all coding follows strict TDD (Red-Green-Refactor), tests are written FIRST. When delegating to Jules:
- **Include test requirements** in the task description
- **Jules writes tests first**, then implementation
- **You review** both tests and implementation in the PR

### Suitable Tasks for Jules (Junior Engineer)
- Feature implementation (with clear spec)
- Bug fixes (with reproduction steps)
- Refactoring tasks (with defined scope)
- Documentation and API docs
- Database migrations
- Configuration scaffolding
- Non-security-critical components

## 2. Architecture

### 2.1 Integration Model

Claude Code (terminal) talks directly to MCP tools. In Phase 1, tools run locally. In Phase 2, tools migrate to ControlPlane.

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE (Terminal)                        │
│                    You = Senior Engineer                         │
│  Direct MCP tool access • PR review • Merge decisions           │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP (stdio/HTTP)
┌────────────────────────────▼────────────────────────────────────┐
│                    JULES PLUGIN (MCP Server)                     │
│  Phase 1: Local TypeScript server                               │
│  Phase 2: ControlPlane-hosted (.NET 10)                         │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS
┌────────────────────────────▼────────────────────────────────────┐
│                    GOOGLE JULES API                              │
│  External autonomous coding agent                                │
│  Creates PRs in your GitHub repos                               │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 ControlPlane Context (Phase 2)

When migrated to ControlPlane, Jules tools join the existing MCP tool ecosystem:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTROLPLANE (Security Boundary)              │
│  MCP Server (.NET 10) • Tool Host • Authorization               │
│  CodeExecutionMcpTools • MetaMcpTools • JulesMcpTools          │
└─────────────────────────────────────────────────────────────────┘
```

**Note:** Jules is NOT a workflow in AgentHost. Claude Code invokes Jules tools directly via MCP.

## 3. Migration Phases

### Phase 1: Local Plugin (MVP)

**Goal:** Prove the delegation pattern works as a reusable Claude Code plugin.

```
Claude Code ──MCP (stdio)──▶ jules-plugin (local) ──HTTPS──▶ Jules API
     │                              │
     │◀──── Tool Results ───────────┘
     │
     └──── gh CLI ──▶ GitHub (PR operations)
```

**Location:** `workflow/jules-plugin`

**Characteristics:**
- Bundled as a Claude Code plugin (reusable, distributable)
- MCP server runs locally via stdio transport
- TypeScript implementation
- Slash commands for common operations
- Claude Code uses `gh` CLI for PR operations

### Phase 2: ControlPlane Integration

**Goal:** Migrate Jules tools to ControlPlane for centralized observability and security.

```
Claude Code ──MCP (HTTP)──▶ ControlPlane ──HTTPS──▶ Jules API
                                │
                                └──▶ Marten (Event Sourcing)
```

**Location:** `agentic-engine/src/Agentic.ControlPlane/McpTools/JulesMcpTools.cs`

**Changes from Phase 1:**
- Tools implemented in C# within ControlPlane
- JWT authentication for tool access
- Events captured in Marten for audit trail
- Session state persisted in PostgreSQL
- Plugin updated to point to ControlPlane HTTP endpoint

## 4. Phase 1 Design (MVP Plugin)

### 4.1 Plugin Structure

```
workflow/jules-plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                  # MCP server configuration
├── commands/
│   ├── delegate.md           # /jules:delegate - Delegate task to Jules
│   ├── status.md             # /jules:status - Check session status
│   └── sessions.md           # /jules:sessions - List active sessions
├── servers/
│   └── jules-mcp/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts      # MCP server entry point
│           ├── jules-client.ts
│           └── tools.ts
└── README.md
```

### 4.2 Plugin Manifest

**.claude-plugin/plugin.json:**
```json
{
  "name": "jules",
  "description": "Delegate coding tasks to Jules autonomous agent",
  "version": "1.0.0",
  "author": {
    "name": "lvlup-sw"
  },
  "repository": "https://github.com/lvlup-sw/jules-plugin",
  "keywords": ["jules", "autonomous-agent", "delegation"]
}
```

### 4.3 MCP Configuration

**.mcp.json:**
```json
{
  "jules": {
    "command": "npx",
    "args": ["tsx", "${CLAUDE_PLUGIN_ROOT}/servers/jules-mcp/src/index.ts"],
    "env": {
      "JULES_API_KEY": "${JULES_API_KEY}"
    }
  }
}
```

### 4.4 Slash Commands

**commands/delegate.md:**
```markdown
---
description: Delegate a coding task to Jules (junior engineer)
---

# Delegate Task to Jules

Use the jules_create_task MCP tool to delegate "$ARGUMENTS" to Jules.

Remember:
- Jules is a junior engineer - provide clear, detailed requirements
- Include test requirements (TDD: tests first)
- Specify the target branch
- Review the plan before approving
```

### 4.5 Jules API Client

```typescript
// servers/jules-mcp/src/jules-client.ts
interface JulesClient {
  listSources(): Promise<Source[]>;
  createSession(params: CreateSessionParams): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  approvePlan(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

interface CreateSessionParams {
  prompt: string;
  sourceContext: {
    source: string;      // "sources/owner/repo"
    branch?: string;     // default: "main"
  };
  title?: string;
  requirePlanApproval?: boolean;  // default: true
  automationMode?: "AUTO_CREATE_PR" | "MANUAL";
}

type SessionState =
  | "QUEUED"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "AWAITING_USER_FEEDBACK"
  | "IN_PROGRESS"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED";
```

### 4.6 MCP Tool Definitions

**6 tools for MVP:**

| Tool | Description | Returns |
|------|-------------|---------|
| `jules_list_sources` | List repos connected to Jules | `Source[]` |
| `jules_create_task` | Create session, return ID | `{sessionId, state}` |
| `jules_check_status` | Get session state + PR URL | `{state, prUrl?, plan?}` |
| `jules_approve_plan` | Approve pending plan | `{success}` |
| `jules_send_feedback` | Send message to session | `{success}` |
| `jules_cancel` | Delete/cancel session | `{success}` |

### 4.7 Senior/Junior Workflow Example

**Scenario:** User wants to add a user profile feature.

```
┌─────────────────────────────────────────────────────────────────┐
│ YOU via CLAUDE CODE (Senior)        │ JULES (Junior)            │
├─────────────────────────────────────┼───────────────────────────┤
│ 1. Design profile data model        │                           │
│ 2. Delegate implementation to Jules │                           │
│    "Implement UserProfile entity    │ 3. Write tests first      │
│     with these specs... TDD please" │ 4. Implement UserProfile  │
│                                     │ 5. Add migration          │
│                                     │ 6. Create DTO             │
│                                     │ 7. Open PR                │
│ 8. Review Jules' PR                 │                           │
│    - Check test coverage            │                           │
│    - Review implementation          │                           │
│    - Request changes if needed      │                           │
│ 9. Merge when satisfied             │                           │
└─────────────────────────────────────┴───────────────────────────┘
```

**Key Point:** Jules can handle substantial tasks (full feature implementation) when given clear requirements. You review and approve.

### 4.8 Installation & Testing

```bash
# During development, test plugin directly
claude --plugin-dir ./workflow/jules-plugin

# Verify MCP server loads
/mcp  # Should show "jules" server

# Test slash commands
/jules:delegate "Add user profile feature with TDD"
/jules:status session-123
/jules:sessions
```

## 5. Phase 2 Design (ControlPlane Integration)

### 5.1 Tool Migration to C#

```csharp
// Agentic.ControlPlane/McpTools/JulesMcpTools.cs

[McpServer("jules")]
public class JulesMcpTools : IMcpToolProvider
{
    private readonly IJulesClient _julesClient;
    private readonly ILogger<JulesMcpTools> _logger;

    [McpTool("jules_create_task")]
    [Description("Delegate a task to Jules autonomous agent")]
    public async Task<Changeset> CreateTaskAsync(
        [Description("GitHub repo (owner/name)")] string repo,
        [Description("Task description")] string task,
        [Description("Branch to work on")] string? branch = "main",
        [Description("Additional context")] string? context = null,
        CancellationToken ct = default)
    {
        var session = await _julesClient.CreateSessionAsync(new CreateSessionParams
        {
            Prompt = BuildPrompt(task, context),
            SourceContext = new SourceContext
            {
                Source = $"sources/{repo}",
                Branch = branch
            },
            RequirePlanApproval = true,
            AutomationMode = AutomationMode.AutoCreatePr
        }, ct);

        _logger.LogInformation(
            "Created Jules session {SessionId} for repo {Repo}",
            session.Name, repo);

        return Changeset.FromJson(new
        {
            sessionId = session.Name,
            state = session.State.ToString(),
            message = "Task delegated to Jules. Use jules_check_status to monitor."
        });
    }

    // Additional tools...
}
```

### 5.2 Session State Persistence

```csharp
// Track Jules sessions in PostgreSQL via Marten

public record JulesSessionProjection
{
    public string SessionId { get; init; }
    public string WorkflowId { get; init; }
    public string Repo { get; init; }
    public string Task { get; init; }
    public SessionState State { get; init; }
    public string? PrUrl { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset LastChecked { get; init; }
}

// Event for audit trail
public record JulesSessionCreated(
    string SessionId,
    string WorkflowId,
    string Repo,
    string Task,
    DateTimeOffset Timestamp) : IWorkflowEvent;
```

## 6. Implementation Steps

### Phase 1: MVP Plugin (Local)

| Step | Description | Deliverables |
|------|-------------|--------------|
| 1.1 | Plugin scaffolding | `workflow/jules-plugin/` structure |
| 1.2 | Plugin manifest | `.claude-plugin/plugin.json` |
| 1.3 | MCP configuration | `.mcp.json` |
| 1.4 | Slash commands | `commands/delegate.md`, `status.md`, `sessions.md` |
| 1.5 | Jules API client | `servers/jules-mcp/src/jules-client.ts` |
| 1.6 | MCP server | `servers/jules-mcp/src/index.ts` with tools |
| 1.7 | Tool implementations | 6 tools in `tools.ts` |
| 1.8 | Testing | `claude --plugin-dir ./workflow/jules-plugin` |

### Phase 2: ControlPlane (Future)

| Step | Description | Deliverables |
|------|-------------|--------------|
| 2.1 | Port client to C# | `IJulesClient` + implementation |
| 2.2 | Implement MCP tools | `JulesMcpTools.cs` |
| 2.3 | Add Marten events | Session tracking events |
| 2.4 | Update plugin | Point `.mcp.json` to ControlPlane HTTP endpoint |

## 7. Considerations

### 7.1 Security Boundaries

- **Phase 1:** Jules API key in environment, Claude Code controls access
- **Phase 2:** JWT token validation in ControlPlane, audit logging via Marten

### 7.2 Error Handling

| Error | Phase 1 | Phase 2 |
|-------|---------|---------|
| API rate limit | Return error message | Backoff + retry with events |
| Session timeout | Return timeout status | Emit timeout event |
| Plan rejection | Return to user | Log rejection event |
| PR conflicts | Report in status | Trigger rebase via Jules |

### 7.3 Observability

| Aspect | Phase 1 | Phase 2 |
|--------|---------|---------|
| Logging | Console output | Structured logging |
| Audit | None | Marten event stream |

## 8. Files to Create/Modify

### Phase 1 (MVP Plugin)

**Create:**
- `workflow/jules-plugin/.claude-plugin/plugin.json`
- `workflow/jules-plugin/.mcp.json`
- `workflow/jules-plugin/commands/delegate.md`
- `workflow/jules-plugin/commands/status.md`
- `workflow/jules-plugin/commands/sessions.md`
- `workflow/jules-plugin/servers/jules-mcp/package.json`
- `workflow/jules-plugin/servers/jules-mcp/tsconfig.json`
- `workflow/jules-plugin/servers/jules-mcp/src/index.ts`
- `workflow/jules-plugin/servers/jules-mcp/src/jules-client.ts`
- `workflow/jules-plugin/servers/jules-mcp/src/tools.ts`
- `workflow/jules-plugin/README.md`

### Phase 2 (Future)

**Create:**
- `agentic-engine/src/Agentic.ControlPlane/Clients/JulesClient.cs`
- `agentic-engine/src/Agentic.ControlPlane/Clients/IJulesClient.cs`
- `agentic-engine/src/Agentic.ControlPlane/McpTools/JulesMcpTools.cs`

**Modify:**
- `agentic-engine/src/Agentic.ControlPlane/Program.cs` (register services)
- `workflow/jules-plugin/.mcp.json` (point to ControlPlane HTTP)

## 9. Success Criteria

### Phase 1
- [ ] Plugin loads correctly with `claude --plugin-dir`
- [ ] `/jules:delegate` command works
- [ ] MCP tools accessible via `/mcp`
- [ ] Claude can delegate a coding task to Jules
- [ ] Claude can monitor Jules session status
- [ ] Claude can review and approve Jules' plan
- [ ] Claude can review the resulting PR via `gh`
- [ ] Claude can merge the PR

### Phase 2
- [ ] Jules tools accessible via ControlPlane MCP server (HTTP)
- [ ] Session events captured in Marten
- [ ] Plugin updated to use ControlPlane endpoint

## 10. References

- **TDD Workflow:** `agentic-engine/docs/prompts/tdd-workflow.mdc`
- **System Architecture:** `agentic-engine/docs/adrs/system-architecture.md`
- **Jules API Docs:** `https://jules.google/docs/api/reference/`
- **Claude Code Plugins:** `https://code.claude.com/docs/en/plugins.md`
- **MCP Protocol:** `https://modelcontextprotocol.io/`
