# Design: GA Extensibility — Dual-Channel CLI + Config-Driven Custom Workflows

## Problem Statement

Exarchos currently distributes as a Claude Code MCP plugin — a single-transport, single-client tool. For General Availability, we need to serve AI coding tool users broadly (Cursor, Windsurf, Copilot, etc.) while maintaining first-class Claude Code support. Two capabilities are required:

1. **Dual-channel distribution** — a standalone CLI binary that also serves as an MCP server (`exarchos mcp`), so any client can consume Exarchos via shell execution or MCP protocol
2. **Config-driven custom workflows** — users define their own workflow phases, transitions, and guards in `exarchos.config.ts` using existing HSM primitives, without writing TypeScript plugins or forking the server

The event-sourcing pipeline (event emission, telemetry, hints, auto-correction, trace capture) must work identically regardless of transport channel.

## Design Constraints

- **Skills remain Claude Code-specific** for GA — no AI client abstraction layer
- **No full plugin API** — custom workflows are config-driven, not package-registrable
- **Structured JSON** is the universal response contract — both CLI and MCP return the same `ToolResult` shape
- **Event emission** works in both channels — the EventStore is transport-agnostic

## Chosen Approach: Schema-Driven Core + CLI Polish Layer

### Architecture Overview

The existing `TOOL_REGISTRY` in `registry.ts` becomes the single source of truth for both CLI commands and MCP tools. A CLI generator reads the registry and produces commander subcommands automatically. An optional polish layer adds CLI-specific ergonomics (aliases, formatting hints) without affecting MCP behavior or owning any logic.

```
┌──────────────────────────────────────────┐
│           Tool Registry (Zod)             │
│  actions, schemas, descriptions           │
│  + optional CLI hints (aliases, groups)   │
└──────────────────┬───────────────────────┘
                   │
           ┌───────┴────────┐
           ▼                ▼
    ┌─────────────┐  ┌─────────────┐
    │ CLI Surface  │  │  MCP Tools  │
    │ (generated   │  │ (generated) │
    │  + polish)   │  │             │
    └──────┬──────┘  └──────┬──────┘
           │                │
           ▼                ▼
    ┌──────────────────────────────┐
    │     Shared Handler Layer      │
    │  dispatch(tool, action, args) │
    │  → withTelemetry()            │
    │  → Enriched ToolResult        │
    └──────────────┬───────────────┘
                   ▼
    ┌──────────────────────────────┐
    │       Backend Services        │
    │  EventStore, HSM, Views,      │
    │  Telemetry, Teams, Sync       │
    └──────────────────────────────┘
```

### Key Properties

1. **Single source of truth** — add an action to the registry once, it appears in both CLI and MCP automatically
2. **Zero feature drift** — both surfaces call the same handler through the same telemetry middleware
3. **Schema introspection** — `exarchos schema <tool>.<action>` dumps any action's Zod schema as JSON Schema, enabling agent discovery
4. **Custom workflows register into the same registry** — they get CLI and MCP exposure for free

---

## Technical Design

### 1. Response Contract: `ToolResult`

The existing `ToolResult` interface is already transport-agnostic. It becomes the universal response contract:

```typescript
interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: {
    code: string;
    message: string;
    validTargets?: readonly (string | ValidTransitionTarget)[];
    expectedShape?: Record<string, unknown>;
    suggestedFix?: { tool: string; params: Record<string, unknown> };
  };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
  // Injected by telemetry middleware:
  // _perf?: { ms: number; bytes: number; tokens: number }
  // _eventHints?: { missing: EventHint[]; phase: string; checked: number }
  // _corrections?: Correction[]
}
```

Today, `withTelemetry()` returns `McpToolResult` (the MCP envelope). The refactor extracts enrichment from transport:

- `withTelemetry()` returns `ToolResult` (enriched JSON)
- MCP adapter: `formatResult(toolResult)` wraps it in the MCP envelope (exactly what happens today)
- CLI adapter: `formatForCli(toolResult, options)` produces pretty or JSON stdout

### 2. Shared Handler Layer

Extract from the current `createServer()` wiring into a transport-agnostic dispatch function:

```typescript
// core/dispatch.ts
export interface DispatchContext {
  stateDir: string;
  eventStore: EventStore;
  enableTelemetry: boolean;
}

export async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const handler = COMPOSITE_HANDLERS[tool];
  if (!handler) {
    return { success: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${tool}` } };
  }

  const baseHandler = async (a: Record<string, unknown>) =>
    handler(a, ctx.stateDir);

  if (ctx.enableTelemetry) {
    const instrumented = withTelemetry(baseHandler, tool, ctx.eventStore);
    return instrumented(args);
  }

  return baseHandler(args);
}
```

### 3. MCP Server Adapter

The MCP server becomes a thin consumer of `dispatch()`. Functionally identical to today, but using the shared layer:

```typescript
// adapters/mcp.ts
export function createMcpServer(ctx: DispatchContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of TOOL_REGISTRY) {
    const inputSchema = buildRegistrationSchema(tool.actions);
    const description = buildToolDescription(tool);

    server.registerTool(
      tool.name,
      { description, inputSchema },
      async (args) => formatResult(await dispatch(tool.name, args, ctx)),
    );
  }

  return server;
}
```

### 4. CLI Generator

The CLI is generated from the same `TOOL_REGISTRY`. Each composite tool becomes a command group, each action becomes a subcommand.

```typescript
// adapters/cli.ts
import { Command } from 'commander';

export function buildCli(ctx: DispatchContext): Command {
  const program = new Command('exarchos')
    .description('Agent governance for AI coding — event-sourced SDLC workflows')
    .version(SERVER_VERSION);

  for (const tool of TOOL_REGISTRY) {
    const toolCmd = program
      .command(tool.cli?.alias ?? stripPrefix(tool.name))
      .description(tool.description);

    for (const action of tool.actions) {
      const actionCmd = toolCmd
        .command(action.cli?.alias ?? action.name)
        .description(action.description);

      // Generate flags from Zod schema
      addFlagsFromSchema(actionCmd, action.schema, action.cli?.flags);

      actionCmd.action(async (opts) => {
        const args = { action: action.name, ...coerceFlags(opts, action.schema) };
        const result = await dispatch(tool.name, args, ctx);

        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          prettyPrint(result, action.cli?.format);
        }
      });
    }
  }

  // Schema introspection command
  program
    .command('schema <tool.action>')
    .description('Inspect the JSON Schema for any action')
    .action((ref) => {
      const schema = resolveSchemaRef(ref);
      process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
    });

  // MCP server mode
  program
    .command('mcp')
    .description('Start Exarchos as an MCP server (stdio)')
    .action(async () => {
      const server = createMcpServer(ctx);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    });

  return program;
}
```

### 5. Registry CLI Hints

Extend `ToolAction` with optional CLI metadata. The MCP surface ignores these fields entirely.

```typescript
interface ToolAction {
  name: string;
  description: string;
  schema: ZodSchema;
  phases: string[];
  roles: string[];

  // Optional CLI ergonomics — ignored by MCP
  cli?: {
    alias?: string;           // Short name: "ls" for "list"
    group?: string;           // Help grouping: "Inspection", "Lifecycle"
    examples?: string[];      // Shown in --help
    flags?: Record<string, {
      alias?: string;         // Short flag: "-f" for "--feature-id"
      description?: string;   // CLI-specific (shorter) description
    }>;
    format?: 'table' | 'json' | 'tree';  // Default human output format
  };
}

interface CompositeTool {
  name: string;
  description: string;
  actions: readonly ToolAction[];

  // Optional CLI ergonomics
  cli?: {
    alias?: string;           // Short name: "wf" for "workflow"
    group?: string;           // Top-level help grouping
  };
}
```

### 6. CLI Pretty Printer

The pretty printer reads `ToolResult` metadata fields and formats them for human consumption:

```typescript
// adapters/cli-format.ts
export function prettyPrint(result: ToolResult, format?: 'table' | 'json' | 'tree'): void {
  if (!result.success) {
    printError(result.error);
    return;
  }

  // Main data
  const fmt = format ?? inferFormat(result.data);
  switch (fmt) {
    case 'table': printTable(result.data); break;
    case 'tree':  printTree(result.data); break;
    default:      printJson(result.data); break;
  }

  // Warnings
  if (result.warnings?.length) {
    for (const w of result.warnings) {
      stderr.write(`  ! ${w}\n`);
    }
  }

  // _perf footer
  const perf = (result as Record<string, unknown>)._perf as PerfMetrics | undefined;
  if (perf) {
    stderr.write(`  ${perf.ms}ms | ${perf.bytes}B | ~${perf.tokens} tokens\n`);
  }

  // _eventHints advisory
  const hints = (result as Record<string, unknown>)._eventHints as EventHintsPayload | undefined;
  if (hints?.missing.length) {
    stderr.write(`\n  Missing events for phase "${hints.phase}":\n`);
    for (const h of hints.missing) {
      stderr.write(`    - ${h.eventType}: ${h.description}\n`);
    }
  }

  // _meta checkpoint advisory
  const meta = result._meta as { checkpointAdvised?: boolean } | undefined;
  if (meta?.checkpointAdvised) {
    stderr.write(`  Checkpoint advised — run: exarchos workflow checkpoint\n`);
  }

  // _corrections notice
  const corrections = (result as Record<string, unknown>)._corrections as Correction[] | undefined;
  if (corrections?.length) {
    for (const c of corrections) {
      stderr.write(`  Auto-corrected: ${c.field} ${c.from} -> ${c.to}\n`);
    }
  }
}
```

### 7. Zod-to-CLI Flag Generation

Automatically generates commander flags from Zod schemas:

```typescript
// adapters/schema-to-flags.ts
export function addFlagsFromSchema(
  cmd: Command,
  schema: ZodSchema,
  overrides?: Record<string, { alias?: string; description?: string }>,
): void {
  const shape = unwrapShape(schema);

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const override = overrides?.[key];
    const flag = toKebab(key);
    const alias = override?.alias;
    const desc = override?.description ?? extractDescription(fieldSchema);
    const required = isRequired(schema, key);

    const flagStr = alias ? `-${alias}, --${flag}` : `--${flag}`;

    if (isBoolean(fieldSchema)) {
      cmd.option(flagStr, desc);
    } else if (isEnum(fieldSchema)) {
      const values = getEnumValues(fieldSchema);
      cmd.option(`${flagStr} <value>`, `${desc} (${values.join('|')})`);
    } else if (isArray(fieldSchema)) {
      cmd.option(`${flagStr} <values...>`, desc);
    } else {
      cmd.option(`${flagStr} <value>`, desc);
    }

    if (required && key !== 'action') {
      cmd.requiredOption(flagStr, desc);
    }
  }

  // Always add --json flag
  cmd.option('--json', 'Output raw JSON');
}
```

### 8. Schema Introspection

Any agent (Cursor, Copilot, etc.) can discover available actions and their parameters:

```bash
# List all tools and actions
$ exarchos schema
exarchos_workflow: Workflow lifecycle management
  init        Initialize a new workflow
  get         Read workflow state
  set         Update workflow state or transition phase
  cancel      Cancel a workflow with saga compensation
  cleanup     Resolve a merged workflow to completed
  reconcile   Rebuild workflow state from event store

exarchos_event: Event store operations
  append      Append an event to a stream
  query       Query events with filtering
  ...

# Inspect specific action schema
$ exarchos schema workflow.init
{
  "type": "object",
  "required": ["featureId", "workflowType"],
  "properties": {
    "featureId": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$",
      "minLength": 1
    },
    "workflowType": {
      "enum": ["feature", "debug", "refactor"]
    }
  }
}

# With custom workflows registered, the enum expands:
$ exarchos schema workflow.init
{
  ...
  "properties": {
    "workflowType": {
      "enum": ["feature", "debug", "refactor", "frontend-feature", "data-pipeline"]
    }
  }
}
```

---

## Config-Driven Custom Workflows

### Configuration File

Users define custom workflows in `exarchos.config.ts` at their project root. The config uses existing HSM primitives — phases, transitions, and guards — without requiring new abstractions.

```typescript
// exarchos.config.ts
import { defineConfig } from 'exarchos';

export default defineConfig({
  workflows: {
    'frontend-feature': {
      extends: 'feature',
      phases: ['design', 'component', 'integration', 'visual-qa', 'ship'],
      transitions: [
        { from: 'design', to: 'component', guard: 'design-approved' },
        { from: 'component', to: 'integration', guard: 'storybook-passing' },
        { from: 'integration', to: 'visual-qa', guard: 'e2e-passing' },
        { from: 'visual-qa', to: 'ship', guard: 'visual-regression-clean' },
      ],
      gates: ['build', 'test', 'lint', 'visual-regression'],
    },

    'data-pipeline': {
      phases: ['explore', 'schema', 'transform', 'validate', 'deploy'],
      transitions: [
        { from: 'explore', to: 'schema' },
        { from: 'schema', to: 'transform', guard: 'schema-approved' },
        { from: 'transform', to: 'validate', guard: 'tests-passing' },
        { from: 'validate', to: 'deploy', guard: 'data-quality-check' },
      ],
      gates: ['test', 'data-quality'],
    },
  },

  // Custom guards reference shell commands
  guards: {
    'visual-regression-clean': {
      command: 'npx percy exec -- npx cypress run --spec "cypress/visual/**"',
      timeout: 120,
    },
    'data-quality-check': {
      command: './scripts/check-data-quality.sh',
      timeout: 60,
    },
  },
});
```

### Config Loading

The config file is loaded at startup by both the CLI and MCP server. Custom workflow types register into the existing HSM and schema system:

```typescript
// config/loader.ts
export interface ExarchosConfig {
  workflows?: Record<string, WorkflowDefinition>;
  guards?: Record<string, GuardDefinition>;
}

export interface WorkflowDefinition {
  extends?: 'feature' | 'debug' | 'refactor';
  phases: string[];
  transitions: TransitionDefinition[];
  gates?: string[];
}

export interface TransitionDefinition {
  from: string;
  to: string;
  guard?: string;
}

export interface GuardDefinition {
  command: string;
  timeout?: number;
}

export async function loadConfig(projectRoot: string): Promise<ExarchosConfig> {
  const configPath = resolve(projectRoot, 'exarchos.config.ts');
  if (!existsSync(configPath)) return {};

  // Use jiti or tsx for TypeScript config loading
  const config = await importConfig(configPath);
  validateConfig(config);
  return config;
}
```

### Registration into HSM

Custom workflows extend the `WorkflowType` enum and register their phase graphs into the state machine:

```typescript
// config/register.ts
export function registerCustomWorkflows(
  config: ExarchosConfig,
  registry: typeof TOOL_REGISTRY,
): void {
  if (!config.workflows) return;

  for (const [name, definition] of Object.entries(config.workflows)) {
    // Register phase graph into HSM
    registerWorkflowType(name, {
      phases: definition.phases,
      transitions: buildTransitionMap(definition.transitions),
      guards: definition.guards ?? [],
      extends: definition.extends,
    });

    // Extend the WorkflowType Zod enum to include the new type
    extendWorkflowTypeEnum(name);
  }

  // Register custom guards
  if (config.guards) {
    for (const [name, guard] of Object.entries(config.guards)) {
      registerGuard(name, guard);
    }
  }
}
```

### Custom Workflow Experience

Once registered, custom workflows work identically to built-in ones:

```bash
# CLI
$ exarchos workflow init -f header-redesign -t frontend-feature
{"success": true, "data": {"featureId": "header-redesign", "phase": "design", "workflowType": "frontend-feature"}}

# Schema shows the custom type
$ exarchos schema workflow.init | jq '.properties.workflowType'
{"enum": ["feature", "debug", "refactor", "frontend-feature", "data-pipeline"]}

# Phase transitions use custom guards
$ exarchos workflow set -f header-redesign --phase component
{"success": false, "error": {"code": "GUARD_FAILED", "message": "Guard 'design-approved' not satisfied"}}

# View works the same
$ exarchos view workflow-status -w header-redesign
{"success": true, "data": {"phase": "design", "workflowType": "frontend-feature", ...}}
```

Via MCP, any client sees the same behavior — custom workflow types appear in the `workflowType` enum, transitions enforce custom guards, events are emitted to the same store.

### `defineConfig` Helper

Provides typed configuration with IntelliSense:

```typescript
// config/define.ts
export function defineConfig(config: ExarchosConfig): ExarchosConfig {
  return config;
}
```

This is a pass-through function that exists solely for TypeScript type inference in the config file, following the Vite/Vitest `defineConfig` pattern.

---

## CLI Command Surface

### Generated from Registry

Every tool and action in `TOOL_REGISTRY` automatically becomes a CLI command:

```
exarchos <tool> <action> [flags]
```

The five composite tools map to five command groups:

| Tool | CLI Group | Example |
|------|-----------|---------|
| `exarchos_workflow` | `exarchos workflow` | `exarchos workflow init -f my-feature -t feature` |
| `exarchos_event` | `exarchos event` | `exarchos event append -f my-feature --type task.completed` |
| `exarchos_orchestrate` | `exarchos orchestrate` | `exarchos orchestrate run-script --script check-tests` |
| `exarchos_view` | `exarchos view` | `exarchos view pipeline --limit 10` |
| `exarchos_sync` | `exarchos sync` | `exarchos sync push -f my-feature` |

### Built-in Commands (not from registry)

| Command | Description |
|---------|-------------|
| `exarchos mcp` | Start Exarchos as an MCP server (stdio) |
| `exarchos schema [ref]` | Inspect action schemas (list all or detail one) |
| `exarchos init` | Initialize Exarchos in a project (creates `exarchos.config.ts`) |
| `exarchos version` | Version and build info |

### Polish Layer Examples

Incrementally added via `cli?` hints in the registry:

```typescript
// registry.ts — example polish hints
{
  name: 'exarchos_workflow',
  description: 'Workflow lifecycle management',
  cli: { alias: 'wf' },
  actions: [
    {
      name: 'init',
      description: 'Initialize a new workflow',
      schema: initSchema,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      cli: {
        examples: [
          'exarchos wf init -f my-feature -t feature',
          'exarchos wf init -f bugfix-123 -t debug',
        ],
        flags: {
          featureId: { alias: 'f', description: 'Workflow identifier' },
          workflowType: { alias: 't', description: 'Workflow type' },
        },
        format: 'json',
      },
    },
    {
      name: 'get',
      description: 'Read workflow state',
      schema: getSchema,
      phases: ALL_PHASES,
      roles: ROLE_ANY,
      cli: {
        alias: 'status',
        flags: { featureId: { alias: 'f' } },
        format: 'tree',
      },
    },
  ],
}
```

Results in:

```bash
$ exarchos wf init -f my-feature -t feature    # short form
$ exarchos workflow init --feature-id my-feature --workflow-type feature  # long form
$ exarchos wf status -f my-feature             # alias for 'get'
```

---

## Telemetry and Event Flow

### Transport-Independent Pipeline

The telemetry middleware operates identically in both channels. Events are emitted by the handler layer before the response reaches any transport adapter:

```
CLI args / MCP tool call
         │
         ▼
┌─────────────────────────────────────────┐
│           dispatch(tool, args, ctx)       │
│                                           │
│  1. Validate args against Zod schema      │
│  2. Auto-correction (if applicable)       │
│  3. Emit tool.invoked event               │
│  4. Call handler(args, stateDir)           │
│     └─ Handler emits domain events:       │
│        workflow.transition, task.completed,│
│        review.started, etc.               │
│  5. Emit tool.completed event             │
│  6. Inject _perf into ToolResult          │
│  7. Inject _eventHints into ToolResult    │
│  8. Inject _corrections into ToolResult   │
│  9. Write trace                           │
│  10. Return enriched ToolResult           │
└─────────────────┬───────────────────────┘
                  │
          ┌───────┴────────┐
          ▼                ▼
   ┌────────────┐   ┌────────────┐
   │ CLI Output  │   │ MCP Output │
   │             │   │            │
   │ --json:     │   │ formatResult()
   │  raw JSON   │   │ → MCP envelope
   │             │   │            │
   │ default:    │   │ (unchanged │
   │  pretty fmt │   │  from today)
   │  + metadata │   │            │
   │  as footer  │   │            │
   └─────────────┘   └────────────┘
```

### Event Emission Examples

```bash
# CLI — full event-sourcing, same as MCP
$ exarchos workflow set -f my-feature --phase plan
# Events emitted:
#   tool.invoked → telemetry stream
#   workflow.transition {from: "ideate", to: "plan"} → my-feature stream
#   tool.completed {ms: 15, bytes: 200, tokens: 50} → telemetry stream

# Pretty output:
# Phase transitioned
#   Feature: my-feature
#   Phase:   ideate -> plan
#
#   15ms | 200B | ~50 tokens
```

```bash
# CLI with --json — identical to MCP response body
$ exarchos workflow set -f my-feature --phase plan --json
{
  "success": true,
  "data": {"featureId": "my-feature", "phase": "plan", "workflowType": "feature"},
  "_meta": {"checkpointAdvised": false},
  "_perf": {"ms": 15, "bytes": 200, "tokens": 50}
}
```

### Event Hints in CLI

```bash
$ exarchos event append -f my-feature --type task.completed --data '{"taskId": "t1"}'

# Pretty output:
# Event appended (seq: 42)
#
#   Missing events for phase "review":
#     - review.started: Start the review process
#     - review.finding: Record a review finding
#
#   12ms | 180B | ~45 tokens
```

### Auto-Correction in CLI

```bash
$ exarchos view pipeline --limit -5

# Pretty output:
#   Auto-corrected: limit -5 -> 5 (must be positive)
#
# Pipeline (5 workflows)
# ...
```

---

## Distribution

### Package Structure

```
exarchos/
├── servers/exarchos-mcp/
│   └── src/
│       ├── core/
│       │   ├── dispatch.ts          # Shared handler dispatch
│       │   └── registry.ts          # Tool registry (moved, extended with cli hints)
│       ├── adapters/
│       │   ├── mcp.ts               # MCP server adapter
│       │   ├── cli.ts               # CLI generator from registry
│       │   ├── cli-format.ts        # Pretty printer
│       │   └── schema-to-flags.ts   # Zod → commander flag generation
│       ├── config/
│       │   ├── loader.ts            # exarchos.config.ts loading
│       │   ├── register.ts          # Custom workflow registration
│       │   └── define.ts            # defineConfig() helper
│       ├── workflow/                # (unchanged)
│       ├── views/                   # (unchanged)
│       ├── telemetry/               # (unchanged)
│       ├── event-store/             # (unchanged)
│       └── index.ts                 # Entry point: CLI or MCP based on args
```

### Entry Point

```typescript
// index.ts
const args = process.argv.slice(2);

if (args[0] === 'mcp' || !process.stdin.isTTY) {
  // MCP server mode (stdio)
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // CLI mode
  const program = buildCli(ctx);
  await program.parseAsync(process.argv);
}
```

### Installation Paths

| Channel | Command | Audience |
|---------|---------|----------|
| **Claude Code marketplace** | Install from marketplace | Claude Code users (first-class experience with skills, hooks, commands) |
| **npm global** | `npm install -g exarchos` | Any developer (CLI + MCP mode) |
| **npx** | `npx exarchos <command>` | Quick try / CI usage |
| **MCP config** | `{ "command": "exarchos", "args": ["mcp"] }` | Cursor, Windsurf, any MCP client |

### MCP Client Configuration

Any MCP-capable client can use Exarchos by adding to their MCP config:

```json
{
  "exarchos": {
    "type": "stdio",
    "command": "exarchos",
    "args": ["mcp"]
  }
}
```

For Claude Code users, the marketplace plugin handles this automatically and also provides skills, hooks, and commands.

---

## Migration Plan

### What Changes

| Component | Current | After |
|-----------|---------|-------|
| `withTelemetry()` return type | `McpToolResult` | `ToolResult` (MCP adapter wraps) |
| Tool registration | `createServer()` directly | `dispatch()` shared layer + adapters |
| `ToolAction` interface | No CLI metadata | Optional `cli?` field |
| `CompositeTool` interface | No CLI metadata | Optional `cli?` field |
| Entry point | MCP-only (`main()`) | CLI by default, `exarchos mcp` for MCP mode |
| `WorkflowType` enum | Hardcoded 3 types | Extensible via config |

### What Doesn't Change

- **EventStore** — untouched
- **Handler functions** (handleWorkflow, handleEvent, etc.) — untouched
- **Event schemas and types** — untouched
- **Views and projections** — untouched
- **Telemetry logic** (auto-correction, hints, perf tracking) — same logic, just returns `ToolResult` instead of `McpToolResult`
- **HSM state machine** — extended with registration, not rewritten
- **Trace capture** — untouched
- **Claude Code plugin** — skills, hooks, commands remain the same

### Implementation Phases

**Phase 1: Handler Extraction**
- Extract `dispatch()` from `createServer()`
- Refactor `withTelemetry()` to return `ToolResult`
- Create MCP adapter that wraps `dispatch()` with `formatResult()`
- Verify all existing tests pass (behavior-preserving refactor)

**Phase 2: CLI Generator**
- Implement `addFlagsFromSchema()` (Zod → commander flags)
- Implement `buildCli()` from `TOOL_REGISTRY`
- Implement `prettyPrint()` for human output
- Implement `exarchos schema` introspection
- Implement `exarchos mcp` mode
- Add CLI-specific tests

**Phase 3: Config-Driven Workflows**
- Implement `loadConfig()` and `defineConfig()`
- Implement `registerCustomWorkflows()` with HSM extension
- Extend `WorkflowType` Zod schema to be dynamically extensible
- Implement custom guard execution
- Add config validation and error reporting
- Add config workflow tests

**Phase 4: Polish Layer**
- Add `cli?` hints to registry for the most common actions
- Add aliases (`wf`, `ev`, `orch`, `vw`)
- Add flag aliases (`-f`, `-t`, etc.)
- Add examples to `--help`
- Refine pretty printer formatting

---

## Testing Strategy

### Handler Layer Tests
- Existing handler tests continue to pass unchanged
- New `dispatch()` tests verify tool routing, error handling, and telemetry integration

### CLI Tests
- Flag generation from Zod schemas (unit tests against known schemas)
- CLI command execution → verify `dispatch()` is called with correct args
- Pretty printer output formatting (snapshot tests)
- `--json` mode produces valid JSON matching `ToolResult` shape
- Schema introspection output matches Zod-to-JSON-Schema conversion

### Config Tests
- Config loading from TypeScript files
- Custom workflow registration into HSM
- Extended `WorkflowType` enum includes custom types
- Custom guard execution (success and failure paths)
- Config validation error messages
- Custom workflow lifecycle (init → transitions → complete)

### Integration Tests
- CLI invocation produces events in EventStore (same events as MCP)
- MCP invocation continues to work identically
- Custom workflow via CLI emits same events as built-in workflows
- Schema introspection reflects custom workflow types

---

## Open Questions

1. **Config file format** — `exarchos.config.ts` requires a TypeScript loader (jiti, tsx, or bundling). Should we also support `exarchos.config.json` for simpler setups?

2. **Guard execution model** — Custom guards run shell commands. Should they also support JavaScript/TypeScript functions for in-process guards?

3. **CLI dependency** — Commander.js is the obvious choice, but adds a dependency. Alternatives: hand-rolled arg parsing (lighter), oclif (heavier but more structured), or citty (modern, minimal).

4. **Workflow inheritance** — `extends: 'feature'` implies inheriting the parent's guards, events, and phase graph as defaults. What's the merge strategy when the child overrides a subset of phases?

5. **Config hot-reload** — Should the MCP server watch `exarchos.config.ts` for changes, or require restart? Hot-reload is convenient but adds complexity.

---

## Success Criteria

1. A Cursor user adds `{"command": "exarchos", "args": ["mcp"]}` to their MCP config and gets the full workflow/event/view API surface
2. A developer runs `exarchos workflow init -f my-feature -t feature` from any terminal and events are emitted to the same store that Claude Code reads
3. A team defines `exarchos.config.ts` with a custom `frontend-feature` workflow and it appears in both CLI and MCP automatically
4. `exarchos schema workflow.init` returns JSON Schema that any agent can use for tool discovery
5. All existing Claude Code functionality (skills, hooks, commands) continues unchanged
