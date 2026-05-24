# INV-5d: Action Discriminator Pattern (Composite Tools)

Exarchos exposes **4 visible composite tools**, each accepting an `action` discriminator:

- `exarchos_workflow({ action: "init" | "get" | "set" | "cancel" | "cleanup" | "reconcile" | "rehydrate" | "checkpoint" | "describe" })`
- `exarchos_event({ action: "append" | "query" | "batch_append" | "describe" })`
- `exarchos_orchestrate({ action: ... })`
- `exarchos_view({ action: "pipeline" | "tasks" | "workflow_status" | ... | "describe" })`

This is a deliberate *namespace-collapse* response to the tool-proliferation failure mode Anthropic flagged in *Writing effective tools for agents*. The agent sees ~4 namespaces; the dispatch core handles ~30+ logical operations.

## Why the pattern matters

1. **Visible tool count stays under the 10–15 threshold** that the AgentPatterns research identifies as the selection-accuracy cliff. Anthropic's *Code execution with MCP* (2025-11-04) shows that loading 50+ tool definitions upfront is 85% wasted token spend (77K → 8.7K with deferred loading).
2. **The `action` field is the real verb.** The composite tool is a grouper; the action is the operation. This mirrors REST URI design (resource-as-tool, operation-as-action) and HTTP method semantics.
3. **`describe` action is the discoverability mechanism.** `exarchos_workflow({ action: "describe", actions: ["init", "set"] })` returns schemas inline. This is how agents progressively discover the namespace without paying the upfront token cost of all 30+ schemas.
4. **Annotations apply per-action, not per-tool** ([#1268](https://github.com/lvlup-sw/exarchos/issues/1268) — "tool annotations table on CompositeAction"). `exarchos_event({action: "append"})` is destructive; `exarchos_event({action: "query"})` is read-only. The annotations table lets a single composite tool carry different safety hints per action.

## Acceptance questions

1. Do new operations land as actions on existing composite tools (workflow / event / orchestrate / view) when the namespace fits, or do they require a new top-level tool with explicit justification?
2. Are action schemas discriminated unions in Zod, not a permissive `Record<string, unknown>` — so the schema validates `action: "init"` parameters distinctly from `action: "set"` parameters?
3. Does each action carry its own `outputSchema` (post-#1266), `annotations` (post-#1268), and `describe` entry? None of these should be tool-level when actions diverge.
4. Does the tool-level description enumerate the action set briefly, with per-action descriptions surfaced through `describe`? This keeps the upfront `tools/list` payload small while preserving full discoverability.
5. Does naming follow the convention: `tool_name` is the namespace (`exarchos_workflow`); `action` is the verb (`init`, `set`, `cancel`)? Tool names follow `verb_noun` only when the namespace is small enough that an action discriminator would be over-engineering (e.g., `exarchos_sync` is a hidden single-purpose tool).

## Repo-grounded checks

- New operations land as actions on existing composite tools, not as new top-level tools. New top-level tools require explicit design justification (e.g., distinct lifecycle, distinct security posture).
- `format.ts:42-46` carries `tool?: string` and `action?: string` on `ToolResult.error` — confirming `(tool, action)` is the canonical dispatch identity.
- Composite tool `describe` action accepts an `actions: string[]` parameter so agents can pull schemas for just the actions they need.
- Per-action annotations live on `CompositeAction` (post-#1268), not on the composite tool itself.

## Pre-#1268 vs post-#1268 (annotations)

Pre-#1268: composite tools carry no annotations. Acceptable interim because Exarchos's actions span destructive (`event.append`) and read-only (`event.query`) inside the same namespace, so a tool-level annotation would be wrong.

Post-#1268: every action declares its annotations table:

| Annotation | When to set | Example |
|---|---|---|
| `destructiveHint: true` | Action mutates persistent state | `event.append`, `workflow.cancel` |
| `readOnlyHint: true` | Action only reads | `event.query`, `workflow.get`, `view.pipeline` |
| `idempotentHint: true` | Repeated calls produce the same result | `event.append` (with `idempotencyKey`), `workflow.checkpoint` |
| `openWorldHint: true` | Action interacts with external systems | network calls, file system writes outside `.exarchos/` |

## External grounding

- Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11) — namespacing, intent-shaped tools, token efficiency. "Namespacing tools (grouping related tools under common prefixes) can help delineate boundaries with lots of tools."
- Anthropic, [*Code execution with MCP*](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04) — deferred loading is the *runtime* response to tool proliferation; the action-discriminator pattern is the *design-time* complement. "Tool count directly affects agent performance — Anthropic names bloated tool sets as a top failure mode."
- AgentPatterns [*MCP Server Design*](https://agentpatterns.ai/tool-engineering/mcp-server-design/) — tool list <15; if you have more operations, the pattern says "tool" should map to a namespace, not an endpoint.
- WebMCP [*Tool Design*](https://docs.mcp-b.ai/explanation/design/tool-design) — "Avoid similar tools with subtle differences. Two tools named `search_products` and `search_products_with_filters` that differ only in whether a `category` parameter is optional are a trap. Combine them into a single tool with optional parameters." The action discriminator is the structural answer.
- Milestone-16 alignment design `§2.5` — annotations are registered against `CompositeAction`, confirming the (tool, action) pair is the canonical dispatch identity.

## Severity guide

- **HIGH:** new top-level tool that should have been an action on an existing composite (e.g., `exarchos_event_append` instead of `exarchos_event({action: "append"})`); permissive `Record<string, unknown>` action schema where a discriminated union was possible.
- **MEDIUM:** action without a `describe` entry; tool-level annotation set when actions diverge in destructiveness; missing `outputSchema` registration post-#1266.
- **LOW:** action description redundant with the composite tool's description; minor schema-vs-runtime drift.

## Worked example

**Violation (HIGH):** New top-level tool that fits an existing composite:

```ts
// registry.ts — DON'T
server.tool('exarchos_workflow_archive', 'Archive a completed workflow', {
  featureId: z.string(),
});
```

This adds a fifth visible tool. The agent now picks between `exarchos_workflow` (8 actions) and `exarchos_workflow_archive` (1 action) — exactly the choice paralysis the action-discriminator pattern was designed to prevent.

**Fix:** Land as an action on `exarchos_workflow`:

```ts
// registry.ts — DO
// In the workflow tool's discriminated-union schema:
const archiveAction = z.object({
  action: z.literal('archive'),
  featureId: z.string().min(1).regex(/^[a-z0-9-]+$/),
});

// And in the action handler dispatch table:
case 'archive': return handleArchive(args, ctx);
```

The visible tool count stays at 4. `exarchos_workflow({ action: "describe", actions: ["archive"] })` surfaces the schema for agents that need it.

**Violation (MEDIUM):** Tool-level annotation that's wrong for some actions:

```ts
// registry.ts — DON'T
server.registerTool('exarchos_event', { destructiveHint: true }, ...);
```

This tags `exarchos_event` as destructive — true for `append` and `batch_append`, false for `query` and `describe`. A safety-conscious client (or the host UI) would gate the read-only `query` action behind a destructive-action prompt, breaking the UX for agents.

**Fix (post-#1268):** Per-action annotations:

```ts
// registry.ts — DO
const ANNOTATIONS = {
  append: { destructiveHint: true, idempotentHint: true },
  batch_append: { destructiveHint: true, idempotentHint: true },
  query: { readOnlyHint: true },
  describe: { readOnlyHint: true },
};
```

## See also

- Deterministic checks for INV-5d → [deterministic-checks.md](deterministic-checks.md#inv-5d-action-discriminator)
- [INV-5b](INV-5b-output-contract.md) — `outputSchema` registration post-#1266 is per-action, not per-tool.
- [INV-5a](INV-5a-input-ergonomics.md) — composite tool descriptions enumerate the action set; per-action descriptions go through `describe`.
