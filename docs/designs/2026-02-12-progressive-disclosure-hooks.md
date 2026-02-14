# Design: Progressive Disclosure & Hook-Driven Lifecycle for Exarchos MCP

## Problem Statement

The Exarchos MCP server registers 27 tools at startup, all surfaced to the LLM simultaneously. This creates three compounding costs:

1. **Token overhead** — Each loaded tool schema consumes ~300 tokens. A typical workflow phase loads 8-10 tools = ~3,000 tokens per turn, competing with the orchestrator's context window for actual work.
2. **Context exhaustion & compaction** — As the context window fills with tool schemas, state data, and coordination artifacts, Claude triggers auto-compaction — a lossy summarization that destroys workflow context. The current mitigation (`/checkpoint → /clear → /resume`) works but requires manual intervention.
3. **Prompt drift** — 286 hardcoded tool name references across 56 files (commands, skills, rules, docs) must be manually kept in sync with the MCP server's tool registration. Any rename requires coordinated updates across the entire prompt layer.

These are interconnected: reducing tool count shrinks per-turn token cost, which delays context exhaustion, which reduces reliance on the checkpoint cycle, which reduces the blast radius of prompt drift.

### Alignment with Design Vision

The ADR identifies "context window pressure" as Problem #2 motivating the Exarchos design. The optimization audit (`docs/prompts/optimize.md`) explicitly targets token economy: "Every byte in a tool response consumes agent context window." This design addresses both by reducing the tool surface area and eliminating compaction as a recovery mechanism.

---

## Chosen Approach

A hybrid of two strategies:

1. **Phase-grouped composite tools** — Collapse 27 tools into 5 composite endpoints with `action` discriminators, organized by workflow phase. Eliminates 6 tools entirely by migrating their logic to hooks.
2. **Hook-driven lifecycle** — Use Claude Code hooks for all reactive/passive behaviors: checkpoint automation, context restoration, phase guardrails, quality gates, and subagent guidance.
3. **Tool registry** — Single source of truth for tool names, schemas, phase mappings, and prompt fragments. Consumed by the MCP server at build time and by hooks at runtime.

---

## Technical Design

### 1. Composite Tool Architecture

#### Tool Surface: 27 → 5

| Composite Tool | Actions | Phase Affinity |
|---|---|---|
| `exarchos_workflow` | `init`, `get`, `set`, `cancel` | All phases (core) |
| `exarchos_event` | `append`, `query` | Coordination phases |
| `exarchos_orchestrate` | `team_spawn`, `team_message`, `team_broadcast`, `team_shutdown`, `team_status`, `task_claim`, `task_complete`, `task_fail` | Delegation only |
| `exarchos_view` | `pipeline`, `tasks`, `workflow_status`, `team_status`, `stack_status`, `stack_place` | Read queries |
| `exarchos_sync` | `now` (+ future remote actions) | Sync operations |

#### Eliminated Tools (Migrated to Hooks)

| Former Tool | Replacement | Rationale |
|---|---|---|
| `workflow_checkpoint` | `PreCompact` hook | Reactive to context pressure, not imperative |
| `workflow_summary` | `SessionStart` hook | Read-only context injection on resume |
| `workflow_next_action` | `SessionStart` hook | Deterministic phase→action mapping |
| `workflow_list` | `SessionStart` hook | Discovery only needed at session start |
| `workflow_reconcile` | `SessionStart` hook | Verification only needed on resume |
| `workflow_transitions` | Static documentation | Debugging/exploration aid, not runtime tool |

#### Schema Design

Each composite tool uses a Zod discriminated union on `action`:

```typescript
// exarchos_workflow schema
z.discriminatedUnion('action', [
  z.object({
    action: z.literal('init'),
    featureId: z.string().min(1).regex(/^[a-z0-9-]+$/),
    workflowType: z.enum(['feature', 'debug', 'refactor']),
  }),
  z.object({
    action: z.literal('get'),
    featureId: z.string().min(1),
    query: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('set'),
    featureId: z.string().min(1),
    updates: z.record(z.unknown()).optional(),
    phase: z.string().optional(),
  }),
  z.object({
    action: z.literal('cancel'),
    featureId: z.string().min(1),
    dryRun: z.boolean().optional(),
  }),
])
```

The composite handler routes to existing handler functions — no business logic changes:

```typescript
async function handleWorkflow(args: WorkflowArgs, stateDir: string): Promise<ToolResult> {
  switch (args.action) {
    case 'init': return handleInit(args, stateDir);
    case 'get': return handleGet(args, stateDir);
    case 'set': return handleSet(args, stateDir);
    case 'cancel': return handleCancel(args, stateDir);
  }
}
```

#### Token Impact Estimate

| Metric | Before | After |
|---|---|---|
| Deferred tool list entries | 27 | 5 |
| Typical tools loaded per phase | 8-10 | 2-3 |
| Tokens per loaded tool (avg) | ~300 | ~600 (larger composite schemas) |
| Per-phase token cost | ~2,700 | ~1,500 |
| **Net reduction** | — | **~44% per phase** |

The deferred list shrinks from 27 entries (~2,000 tokens) to 5 entries (~400 tokens), saving ~1,600 tokens on every turn regardless of loaded tools.

---

### 2. Hook Architecture

#### 2.1 Never-Compact: Automated Checkpoint Cycle

The core innovation: replace compaction with a deterministic checkpoint→stop→resume cycle that preserves full context fidelity.

```
Context window fills → auto-compaction triggered
  │
  ▼
PreCompact(auto) hook fires
  │
  ▼
Hook script (Node.js CLI):
  ├─ Reads active workflow state from disk
  ├─ Computes resume context (summary + next_action)
  ├─ Writes .checkpoint.json alongside state file
  └─ Returns { "continue": false, "stopReason": "..." }
  │
  ▼
Claude STOPS — compaction never executes
  │
  ▼
User starts new session (or wrapper auto-restarts)
  │
  ▼
SessionStart(startup) hook fires
  │
  ▼
Hook script (Node.js CLI):
  ├─ Scans for .checkpoint.json files
  ├─ If found: reads checkpoint, outputs resume context to stdout
  ├─ Context injected into Claude's prompt
  └─ Includes AUTO:<next-action> directive
  │
  ▼
Claude auto-continues from checkpoint (zero MCP tool calls)
```

**Why `continue: false`?** This is a universal JSON output field documented in the hooks reference: "If false, Claude stops processing entirely after the hook runs. Takes precedence over any event-specific decision fields." Since PreCompact cannot block compaction via exit code 2, `continue: false` is the mechanism to halt Claude before the compaction step executes.

**Checkpoint file format:**

```json
{
  "featureId": "progressive-disclosure-hooks",
  "timestamp": "2026-02-12T15:30:00Z",
  "phase": "delegate",
  "summary": "3/5 tasks complete. T1, T3, T4 done. T2, T5 in progress.",
  "nextAction": "AUTO:delegate",
  "tasks": [
    { "id": "T1", "status": "completed", "title": "..." },
    { "id": "T2", "status": "in_progress", "title": "...", "assignee": "..." }
  ],
  "artifacts": { "design": "docs/designs/...", "plan": "docs/plans/..." },
  "stateFile": "~/.claude/workflow-state/progressive-disclosure-hooks.state.json"
}
```

**SessionStart context injection** (stdout from hook):

```
Resuming workflow: progressive-disclosure-hooks
Phase: delegate (3/5 tasks complete)

Completed: T1 (Auth middleware), T3 (DB schema), T4 (API routes)
In progress: T2 (Frontend forms — assigned to teammate-2), T5 (Integration tests — assigned to teammate-3)

Design: docs/designs/2026-02-12-progressive-disclosure-hooks.md
Plan: docs/plans/2026-02-12-progressive-disclosure-hooks.plan.md

Next action: AUTO:delegate
Continue dispatching remaining tasks.
```

This replaces the current 3-tool-call resume sequence (`workflow_list` → `workflow_summary` → `workflow_next_action`) with zero tool calls.

#### 2.2 Phase Guardrails

A `PreToolUse` hook that enforces workflow phase constraints deterministically — not via prompt instructions that the LLM might ignore.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__exarchos__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/plugins/exarchos/servers/exarchos-mcp/dist/cli.js guard"
          }
        ]
      }
    ]
  }
}
```

The guard script:
1. Reads `tool_name` and `tool_input.action` from stdin JSON
2. Reads current phase from the active workflow state file
3. Consults the tool registry's phase mapping
4. Returns `permissionDecision: "deny"` with reason if the action is invalid for the current phase

**Phase → valid actions mapping** (from registry):

| Phase | Valid Tools/Actions |
|---|---|
| `ideate` | `workflow:init`, `workflow:get`, `workflow:set`, `event:append` |
| `plan` | `workflow:get`, `workflow:set`, `event:append` |
| `delegate` | All `orchestrate:*`, `workflow:get`, `workflow:set`, `event:*`, `view:*` |
| `review` | `view:*`, `workflow:get`, `workflow:set`, `event:*` |
| `synthesize` | `view:stack_*`, `workflow:get`, `workflow:set`, `event:*` |

#### 2.3 Quality Gates

Deterministic enforcement at task/teammate lifecycle boundaries, aligned with the ADR's layered gate model (Section 11).

**TaskCompleted hook:**

```json
{
  "hooks": {
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/plugins/exarchos/servers/exarchos-mcp/dist/cli.js task-gate"
          }
        ]
      }
    ]
  }
}
```

The gate script reads the task subject/description from stdin and runs configurable checks:
- Verify test suite passes (`npm run test:run`)
- Verify TypeScript compiles (`npm run typecheck`)
- Verify no uncommitted changes in worktree

Exit code 2 blocks task completion with feedback; exit 0 allows it.

**TeammateIdle hook:** Same pattern — runs a verification script before a teammate can go idle. Ensures the teammate's assigned tasks have passing tests and clean worktrees.

#### 2.4 Subagent Guidance

A `SubagentStart` hook injects phase-specific tool guidance from the registry, so subagents receive only the tools relevant to their role.

```json
{
  "hooks": {
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/plugins/exarchos/servers/exarchos-mcp/dist/cli.js subagent-context"
          }
        ]
      }
    ]
  }
}
```

The script reads the current phase from workflow state and outputs phase-specific guidance to stdout as `additionalContext`. For example, during delegation, a subagent receives:

```
Your available Exarchos tools:
- exarchos_orchestrate: task_claim, task_complete, task_fail
- exarchos_event: append

Do NOT call: exarchos_workflow (orchestrator only), exarchos_view (read-only, not needed for implementation)
```

This reduces tool confusion and avoids subagents loading unnecessary schemas via ToolSearch.

---

### 3. Tool Registry

A single TypeScript module that serves as the source of truth for all tool metadata.

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/registry.ts`

```typescript
export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly phases: ReadonlySet<string>;  // Valid workflow phases
  readonly roles: ReadonlySet<string>;   // 'lead' | 'teammate' | 'any'
}

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
}

export const TOOL_REGISTRY: readonly CompositeTool[] = [
  {
    name: 'exarchos_workflow',
    description: 'Workflow state management — init, query, update, cancel',
    actions: [
      {
        name: 'init',
        description: 'Initialize a new workflow state file',
        schema: initSchema,
        phases: new Set(['ideate']),
        roles: new Set(['lead']),
      },
      // ...
    ],
  },
  // ...
];
```

**Consumers:**

| Consumer | How It Uses the Registry |
|---|---|
| MCP server (`index.ts`) | Imports `TOOL_REGISTRY`, registers composite tools with generated schemas |
| CLI hooks (`cli.ts`) | Imports `TOOL_REGISTRY` for phase guardrails, subagent guidance |
| Build script (`scripts/generate-docs.ts`) | Generates `rules/mcp-tool-guidance.md` from registry metadata |
| Phase guard hook | Reads `action.phases` to validate tool calls against current workflow phase |
| Subagent guidance hook | Reads `action.roles` and `action.phases` to generate context-appropriate tool lists |

**Generated artifacts:**

The build script produces:
- `rules/mcp-tool-guidance.md` — Updated tool reference table (replaces 286 hardcoded references with a single generated file)
- `skills/*/references/tool-manifest.md` — Per-skill tool guidance fragments (optional, for skills that need inline tool instructions)

**Migration path for existing references:**

Skills and commands transition from hardcoded tool names:
```markdown
<!-- Before -->
Call `mcp__exarchos__exarchos_workflow_set` with phase: "delegate"

<!-- After -->
Call `exarchos_workflow` with action: "set", phase: "delegate"
```

The naming convention `exarchos_<composite>` with `action: "<verb>"` maps intuitively from the old `exarchos_<composite>_<verb>` pattern, minimizing cognitive overhead during migration.

---

### 4. CLI Entry Point

All hooks share a single CLI entry point in the MCP server package, avoiding shell script maintenance and reusing existing TypeScript logic.

**Location:** `plugins/exarchos/servers/exarchos-mcp/src/cli.ts`

```typescript
#!/usr/bin/env node
import { TOOL_REGISTRY } from './registry.js';
import { readStateFile, findActiveWorkflows } from './workflow/state-store.js';
import { buildCheckpointMeta } from './workflow/checkpoint.js';
import { computeNextAction } from './workflow/next-action.js';

const command = process.argv[2];

switch (command) {
  case 'pre-compact':
    // Read active workflows, create checkpoint files, output continue:false
    break;
  case 'session-start':
    // Check for checkpoint files, output resume context to stdout
    break;
  case 'guard':
    // Read stdin, validate tool+action against phase, output decision
    break;
  case 'task-gate':
    // Read stdin, run quality checks, exit 0 or 2
    break;
  case 'subagent-context':
    // Read phase, output phase-specific tool guidance to stdout
    break;
}
```

**Build integration:** The CLI is compiled alongside the MCP server (`tsc` outputs to `dist/cli.js`). Hooks reference `dist/cli.js` via `$CLAUDE_PROJECT_DIR`.

**Shared logic advantages:**
- Next-action computation (`computeNextAction`) reused from `workflow/next-action.ts` — no duplication
- State file parsing reused from `workflow/state-store.ts` — same validation
- Phase mappings read from `TOOL_REGISTRY` — single source of truth
- Checkpoint creation reused from `workflow/checkpoint.ts` — same format

---

### 5. Hook Configuration

All hooks are defined in the Exarchos plugin's `hooks/hooks.json`, scoped to when the plugin is enabled:

```json
{
  "description": "Exarchos progressive disclosure and lifecycle hooks",
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" pre-compact",
            "timeout": 30,
            "statusMessage": "Saving workflow checkpoint..."
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" session-start",
            "timeout": 10,
            "statusMessage": "Checking for active workflows..."
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__exarchos__.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" guard",
            "timeout": 5
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" task-gate",
            "timeout": 120,
            "statusMessage": "Running quality gates..."
          }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" teammate-gate",
            "timeout": 120,
            "statusMessage": "Verifying teammate work..."
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js\" subagent-context",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

---

## Integration Points

### Installer Changes

The installer (`src/install.ts`) must:
- Register the plugin's `hooks/hooks.json` (may already be handled by plugin registration)
- Ensure the MCP server's `dist/cli.js` is built and accessible
- Remove the `workflow-auto-resume.md` rule (replaced by `SessionStart` hook)

### Skill/Command Migration

All 56 files with hardcoded tool names must be updated:
- Replace `mcp__exarchos__exarchos_<tool>_<action>` with `mcp__exarchos__exarchos_<tool>` + `action: "<action>"`
- The generated `rules/mcp-tool-guidance.md` replaces the current hand-maintained version
- Skills that reference specific tools should reference the registry's phase descriptions instead

### MCP Server Changes

- New file: `src/registry.ts` (tool registry)
- New file: `src/cli.ts` (hook CLI entry point)
- Modified: `src/index.ts` (register composites from registry instead of individual tools)
- Modified: Each module's `tools.ts` (handlers remain, registration moves to registry)
- Removed tools: `workflow_checkpoint`, `workflow_summary`, `workflow_next_action`, `workflow_list`, `workflow_reconcile`, `workflow_transitions`
- New build output: `dist/cli.js`

### Existing Patterns Preserved

- **ToolResult interface** — All handlers continue returning `ToolResult`; the composite wrapper is thin routing
- **CAS versioning** — `_version` field and retry loop unchanged in `handleSet`
- **Event emission** — State-first, event-after pattern unchanged
- **Fast-path optimization** — `handleGet` fast path for scalar queries preserved inside the composite
- **Checkpoint advisory** — `_meta.checkpointAdvised` still returned; now also consumed by `PreCompact` hook

---

## Testing Strategy

### Unit Tests (MCP Server)

- **Registry tests** — Validate all actions have schemas, phase mappings, and role assignments
- **Composite routing** — Each composite handler routes to correct underlying handler
- **CLI command tests** — Each CLI command produces correct output for given inputs
- **Phase guard logic** — Validate allow/deny decisions for every phase × action combination

### Integration Tests (Hooks)

- **PreCompact → checkpoint** — Simulate auto-compaction trigger, verify checkpoint file created, verify `continue: false` output
- **SessionStart → resume** — Create checkpoint file, run session-start hook, verify context output matches expected format
- **Phase guardrail** — Simulate tool calls at each phase, verify correct allow/deny decisions
- **TaskCompleted gate** — Simulate task completion with passing/failing tests, verify exit codes
- **Subagent guidance** — Verify phase-specific tool lists are injected correctly

### Migration Tests

- **Schema compatibility** — Verify composite schemas accept all parameter combinations the old individual schemas accepted
- **Reference audit** — Build script that scans for any remaining hardcoded old-style tool names

---

## Open Questions

1. **Auto-restart automation** — The `PreCompact` hook stops Claude, but restarting requires user action (or a wrapper). A thin shell wrapper that detects exit-with-checkpoint and spawns `claude --resume` would close this gap. Defer to implementation phase.

2. **Manual compaction** — Should `PreCompact(manual)` (user runs `/compact`) also trigger checkpoint+stop, or only `PreCompact(auto)`? Recommend: also checkpoint on manual, since the user may be compacting due to context pressure.

3. **Multi-workflow sessions** — The checkpoint flow assumes a single active workflow. If multiple workflows are active, the hook must checkpoint all of them. The `findActiveWorkflows()` function already handles this.

4. **Hook timeout budget** — The `task-gate` hook runs tests (up to 120s). If tests are slow, this blocks task completion. Consider an async variant that reports results on the next turn instead of blocking.

5. **`continue: false` on PreCompact** — Need to verify empirically that `continue: false` in the PreCompact hook's JSON output actually prevents compaction from executing. If it doesn't, the fallback is `PreCompact` saves checkpoint + `SessionStart(compact)` restores context (compaction happens but context is fully restored from checkpoint, not from lossy summary).
