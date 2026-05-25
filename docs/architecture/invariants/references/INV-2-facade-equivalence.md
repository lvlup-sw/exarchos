# INV-2: Facade Equivalence Over a Shared Dispatch Core

CLI and MCP are both **facades over a single functional dispatch core** (`servers/exarchos-mcp/src/core/dispatch.ts`). For any verb, the same `DispatchContext` + same arguments must produce the same `ToolResult`. Adapters (`adapters/cli.ts`, `adapters/mcp.ts`) carry **zero behavior** — only presentation: argv parsing, exit codes, stdio framing, error rendering, output carrier translation.

The byte-equivalence parity tests in `parity.test.ts` (and `views/parity.test.ts`, `workflow/parity.test.ts`, `event-store/parity.test.ts`) are the **witness**, not the invariant. The invariant is the architectural separation; the tests confirm it.

## Acceptance questions

1. Does the new verb route through `core/dispatch.ts` as a typed handler, with both `adapters/cli.ts` and `adapters/mcp.ts` as thin wrappers?
2. Is there zero behavior in either adapter beyond format conversion? (No CLI-only event emission, no MCP-only side effects.)
3. Does the parity harness in `__tests__/parity-harness.ts` cover the new verb with at least one fixture covering the bug-cluster shapes (e.g., empty state vs duplicated events vs no-handoff invocations)?
4. Does the verb's `ToolResult` shape match the canonical envelope (`success` / `data` / `error` / `_meta` / `_perf` / `next_actions` and the v2.10 additions — see [INV-5b](INV-5b-output-contract.md))?

## Pre-#1266 vs post-#1266 (dual-state framing)

Epic [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) was substantially reworked on 2026-05-07 in `docs/designs/2026-05-07-milestone-16-mcp-alignment.md`. The reframe affects INV-2 in two ways:

1. **The invariant is unchanged.** §2.2 of the design states: "CLI and MCP route through the same dispatch core today. This design preserves that." The shared-core architecture is preserved across the v2.10/v2.11 migration.
2. **The implementation surface gets a new declarative artifact.** Post-[#1266](https://github.com/lvlup-sw/exarchos/issues/1266), every action will register a Zod `outputSchema` in `registry.ts`. The MCP adapter binds it via `server.registerTool()`'s third argument; the CLI adapter's `--format json` mode literal-encodes the same envelope. The schema is no longer implicit in whatever `formatResult` returned — it is explicit, one-per-action, and shared between both carriers.

| State | Parity dimension | Enforcement |
|---|---|---|
| Pre-#1266 | Byte-equivalence of `ToolResult` JSON | `parity.test.ts` + `__tests__/parity-harness.ts` |
| Post-#1266 | Byte-equivalence + schema-equivalence (registered `outputSchema` validates both carriers) | Same test + new schema-validation assertion |

**Carrier-translation discipline:** The `formatResult()` boundary becomes the *only* place CLI and MCP carriers diverge. Anything else that diverges between adapters is a violation. Pre-#1266 this is enforced by the parity test alone; post-#1266 by both the test and the registered schema.

## Cross-invariant note: TaskStore-as-projection

The `TaskStore-as-projection` decision in milestone-16 §2.1 is an example of [INV-1](INV-1-event-sourcing.md) *driving* an INV-2 implementation choice. The SDK ships an `InMemoryTaskStore` that would let the MCP adapter "just work" — but using it would create a second source of truth invisible to the CLI adapter, breaking facade equivalence in a way the parity tests would not catch (state, not output).

Flag any "convenient adapter-local state" as a candidate for this anti-pattern. The skill should examine: does the adapter hold a `Map`, `Set`, `Cache`, or any field that survives across calls? If yes, is that state replicated identically in the other adapter? If no, you have a hidden parity violation.

## External grounding

- Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11) — namespace per service; tools should map to user intents, not API endpoints; treat schema violations as contract failures.
- AgentPatterns [*MCP Server Design*](https://agentpatterns.ai/tool-engineering/mcp-server-design/) — symmetric error channels (protocol vs tool-execution); `isError: true` payloads carry actionable context.
- [MCP spec lifecycle (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) — capability negotiation is a mandatory init handshake; both sides must respect negotiated capabilities for the session.
- MCP spec *2025-11-25 §CallToolResult* — `structuredContent` sibling to `content` is the spec-native carrier for validated JSON; #1266 migration is alignment, not invention.
- `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` §2.2 — explicit confirmation that the shared-dispatch-core invariant is preserved across the spec-alignment migration.

## Severity guide

- **HIGH:** behavior diverges (one adapter emits an event the other doesn't); adapter-local mutable state that would not survive a swap; new verb that bypasses `core/dispatch.ts`; CLI-only side effect (e.g., printing outside the rendered envelope).
- **MEDIUM:** shape diverges in non-load-bearing fields; schema not registered post-#1266; missing parity-harness fixture for a new verb.
- **LOW:** cosmetic differences (whitespace, key order); per-adapter performance optimization that doesn't change observable output.

## Worked example

**Violation (HIGH):** A new verb is added with a CLI-only print:

```ts
// adapters/cli.ts — DON'T
export async function runWorkflowGet(featureId: string) {
  const result = await dispatch({ verb: 'workflow.get', args: { featureId } });
  console.log(`Loaded workflow ${featureId}`); // ← CLI-only side effect
  return result;
}
```

The `console.log` doesn't affect `ToolResult` (so byte-equivalence holds), but it changes observable behavior (so facade equivalence breaks). An agent using the CLI sees the banner; an agent using MCP doesn't.

**Fix:** Move the message into `_meta.notes` or remove it. Agent-facing surfaces are JSON-only; human-facing display is the CLI's job at the renderer boundary, not inside dispatch.

**Violation (HIGH):** Adapter-local cache:

```ts
// adapters/mcp.ts — DON'T
const featureCache = new Map<string, FeatureState>();

export async function handleWorkflowGet(args: { featureId: string }) {
  if (featureCache.has(args.featureId)) {
    return featureCache.get(args.featureId)!;
  }
  const result = await dispatch({ verb: 'workflow.get', args });
  featureCache.set(args.featureId, result.data);
  return result;
}
```

The MCP adapter now holds state the CLI adapter doesn't. After a `workflow.set` writes new state, the MCP adapter returns stale data; the CLI returns fresh. Parity tests pass (each invocation returns equivalent `ToolResult` for the *same input* — but the cache changes the input space).

**Fix:** Move caching into the dispatch core (where both adapters benefit) or into a projection (where it's event-sourced). See [INV-1](INV-1-event-sourcing.md) "stores-as-projections rule".

## See also

- Deterministic checks for INV-2 → [deterministic-checks.md](deterministic-checks.md#inv-2-facade-equivalence)
- [INV-1](INV-1-event-sourcing.md) — stores-as-projections rule (cross-invariant constraint)
- [INV-5b](INV-5b-output-contract.md) — the canonical `ToolResult` envelope shape
