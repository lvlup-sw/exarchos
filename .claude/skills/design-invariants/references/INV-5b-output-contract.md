# INV-5b: Spec-Aligned Output Contract

Every successful `ToolResult` carries machine-actionable affordance hints. The output contract is the single most-likely-to-drift dimension because it is easy to add a new MCP tool that returns `{ ok: true }` and ship; the omission only surfaces when an agent gets stuck mid-workflow.

The invariant: **Use spec primitives where they exist; extend Exarchos-specific shapes alongside them, not against them.**

## Pre-#1266 vs post-#1266 (dual-state framing)

Epic [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) was substantially reworked on 2026-05-07 in `docs/designs/2026-05-07-milestone-16-mcp-alignment.md`. The original framing — HATEOAS envelope as JSON-stringified text — was a v3.0 differentiator before the MCP 2025-11-25 spec landed `outputSchema` / `structuredContent` / Tasks (SEP-1686) / Roots / Elicitation / Resources. The milestone-16 alignment design retargets onto those primitives.

| What | Pre-#1088-redesign framing (deprecated) | Post-#1088-redesign framing (this invariant) | Issue |
|---|---|---|---|
| Carrier | HATEOAS envelope as JSON-in-text in `content[0].text` | `structuredContent` (spec-native) with registered `outputSchema` per action | [#1266](https://github.com/lvlup-sw/exarchos/issues/1266) |
| `next_actions` | Custom `next_actions` field in envelope | Same field, but exposed via the registered `outputSchema` so clients validate it natively | [#1267](https://github.com/lvlup-sw/exarchos/issues/1267) |
| Tool annotations | None | Per-action annotations table on `CompositeAction` | [#1268](https://github.com/lvlup-sw/exarchos/issues/1268) |
| Long-running ops | NDJSON streaming wire protocol | MCP Tasks (SEP-1686) with `tasks/get` / `tasks/result` / `tasks/cancel`; NDJSON survives only as a CLI render format | [#1273](https://github.com/lvlup-sw/exarchos/issues/1273) |
| Schema | Implicit in `formatResult` | Declarative — one Zod `outputSchema` per action in `registry.ts` | [#1266](https://github.com/lvlup-sw/exarchos/issues/1266) |
| Recovery on `INVALID_INPUT` | Return error with text | Elicitation form mode, capability-gated | [#1274](https://github.com/lvlup-sw/exarchos/issues/1274) |
| Reference content (docs, playbooks, invariants) | Tools that return strings | MCP Resources with subscriptions | [#1275](https://github.com/lvlup-sw/exarchos/issues/1275) |

Three Exarchos-shaped extensions remain genuinely outside the spec and continue to ride alongside spec primitives:

- `_eventHints` — event-source acknowledgement (which events the verb may emit).
- `_cacheHints` — Anthropic cache-control hints.
- `next_actions` derived from HSM topology (the *content* is Exarchos-specific; the *carrier* is spec-aligned).

## Acceptance questions

1. Does every successful `ToolResult` carry `next_actions[]` derived from the HSM (when one applies)?
2. Does every error response carry `validTargets`, `expectedShape`, `suggestedFix` so the agent can self-correct without re-prompting the human?
3. Does every composite tool expose a `describe` action returning schemas + emission catalogs + topology?
4. Does `_meta` carry control-plane hints (`checkpointAdvised`, `degraded`, `fallbackSource`); does `_perf` carry `{ms, bytes, tokens}`?
5. Is the JSON shape stable — no breaking field renames without an envelope version bump?
6. Does the envelope stay machine-only — no banners, ASCII tables, or color codes leaking in (presentation belongs in the CLI adapter)?

**Post-#1266 add:**

7. Does every new action register an `outputSchema` in `registry.ts` and bind it via `server.registerTool()`'s third argument?
8. Does the response use `structuredContent` carrier, not `content[0].text` JSON-in-text?

**Post-#1268 add:**

9. Does every new action declare its annotations table (`destructiveHint` / `readOnlyHint` / `idempotentHint` / `openWorldHint`)?

**Post-#1273 add:**

10. Do long-running ops follow the Tasks (SEP-1686) shape? NDJSON is reserved for CLI rendering only.

**Post-#1274 add:**

11. Does `INVALID_INPUT` recovery use Elicitation form mode (capability-gated) when supported?

**Post-#1275 add:**

12. Is static reference content exposed as MCP Resources, not tools that return strings?

## Repo-grounded checks (current state)

- `format.ts:32-47` — `ToolResult.error` already carries `validTargets`, `expectedShape`, `suggestedFix`, `unmetGates`, `gate`, `operationsSince`, `threshold`, `tool`, `action`. New error paths must populate these where applicable.
- `format.ts:48-53` — `ToolResult` already carries `_meta`, `_perf`, `_eventHints`, `_corrections`. New verbs must emit these.
- `next-actions-from-result.ts` — `nextActionsFromResult()` is the single source of truth for HSM-derived next_actions; new verbs route through it at the envelope-wrap boundary.
- `format.ts` `wrap()` accepts a typed `nextActions` argument; `wrapWithPassthrough()` threads `warnings` and `_corrections`; `applyCacheHints()` adds Anthropic-native cache-boundary hints.

## External grounding

- MCP spec *2025-11-25 §CallToolResult* — `structuredContent`, `outputSchema`, tool annotations.
- MCP spec *2025-11-25 SEP-1686* — Tasks for long-running operations with `input_required`.
- Anthropic, [*Code execution with MCP*](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04) — deferred loading + `search_tools` cuts 150k → 2k tokens (98.7%); the action-discriminator pattern ([INV-5d](INV-5d-action-discriminator.md)) is the structural complement.
- Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) — pagination, range selection, filtering, sensible defaults; truncation paired with steering instructions.
- AgentPatterns [*MCP Server Design*](https://agentpatterns.ai/tool-engineering/mcp-server-design/) — symmetric error channels: protocol vs tool-execution; `isError: true` payloads carry actionable context.
- Kumar, [*MCP Architecture, Tradeoffs, and Production Realities*](https://ranjankumar.in/model-context-protocol-mcp-architecture-tradeoffs-and-production-realities) — capability manifest as cached, versioned record; structured error taxonomy (success | partial | failure | denied | schema-fail | timeout).
- `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` — full design rationale for the dual-state framing.

## Severity guide

- **HIGH:** successful response without `next_actions` on a verb that has them; error without `validTargets` / `suggestedFix` on a transition guard failure; CLI banner / ASCII table / color codes leaking into the JSON envelope.
- **MEDIUM:** missing `_meta.checkpointAdvised` after a cadence-trigger; tool description under 3 sentences for a non-trivial tool (overlaps INV-5a); action without a `describe` entry; long-running op using NDJSON instead of Tasks post-v2.11.0; field renamed without an envelope version bump.
- **LOW:** descriptive `_perf` units could be sharper; minor schema-vs-runtime drift in tool descriptions.

## Worked example

**Violation (HIGH):** New verb returns a bare success:

```ts
// orchestrate/handle-foo.ts — DON'T
export async function handleFoo(args: { featureId: string }): Promise<ToolResult> {
  await doFoo(args.featureId);
  return { success: true, data: { ok: true } };
}
```

No `next_actions`, no `_meta`, no `_perf`. The agent has no idea what to do next; the host can't surface progress.

**Fix:** Wire through `wrap()` so envelope additions happen at the boundary:

```ts
// orchestrate/handle-foo.ts — DO
export async function handleFoo(
  args: { featureId: string },
  ctx: DispatchContext,
): Promise<ToolResult> {
  const start = performance.now();
  await doFoo(args.featureId);
  const state = await readState(ctx, args.featureId);
  return wrap({
    success: true,
    data: state,
    nextActions: nextActionsFromResult({ data: state }),
    perf: { ms: performance.now() - start, bytes: 0, tokens: 0 },
  });
}
```

The wrap helper handles `next_actions`, `_perf`, and `_meta.checkpointAdvised` consistently across all handlers.

## See also

- [INV-2](INV-2-facade-equivalence.md) — schema-equivalence parity post-#1266.
- [INV-5a](INV-5a-input-ergonomics.md) — input side of the same agent-first discipline.
- [INV-5d](INV-5d-action-discriminator.md) — annotations table on `CompositeAction` post-#1268.
- [deterministic-checks.md](deterministic-checks.md) — no INV-5b deterministic checks (reasoning-driven; output-contract drift surfaces at the wrap boundary).
