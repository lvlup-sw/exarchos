# Wave 0 — Agent Output Contract carrier swap

**Status:** design (pending plan-review)
**Date:** 2026-05-13
**Scope:** v2.10.0-preview.3 Wave 0 — the 4-issue carrier swap cluster.
**Composes with:** #1287 (carrier swap), #1288 (next_actions in outputSchema), #1289 (annotations), #1277 (JSON Schema 2020-12).
**Replaces in v2.10.0:** none — closes the carrier-swap sub-cluster under epic #1088.
**Out of scope:** #1290 (Roots), #1291 (dispatch-boundary operationId), #1292 (SDK pin) — deferred to preview.4 per epic #1354.
**Supporting:** [milestone-16 design §4.1, §4.2](2026-05-07-milestone-16-mcp-alignment.md); [Windows dogfood remediation](../research/2026-05-13-windows-dogfood-remediation.md) for downstream waves that compose on this surface.

## TL;DR

The MCP envelope today is JSON-stringified into `content[0].text`. The 2025-11-25 spec carries a sibling `structuredContent` field for the validated payload and a per-tool `outputSchema` to describe its shape. Wave 0 swaps the carrier (text-only → text + structuredContent), declares a per-action `outputSchema` plus typed `ActionAnnotations`, and conforms emitted JSON Schemas to draft 2020-12.

Two non-obvious design commitments lock in the wire contract before the dogfood waves (#1359/#1360/#1364) layer their envelope additions on top:

1. **Per-action schema, LCD on the wire** — each `ToolAction.outputSchema` declares the full per-action envelope; the MCP-registered `outputSchema` per composite tool is a lowest-common-denominator envelope; the per-call adapter validates `structuredContent` against the per-action schema using the dispatched action label. Rich per-action contracts surface via `describe`. This avoids adding a wire-level `action` discriminator on output.
2. **CLI emits the full envelope on stdout under `--format json`** — today `prettyPrint()` writes only `result.data` to stdout and sidebars `warnings`/`_perf`/`_eventHints` to stderr. Post-swap, `--format json` writes the envelope as a single JSON document on stdout, byte-equal to MCP `structuredContent` modulo timestamps. CLI is pre-1.0; breaking is acceptable now.

The carrier swap itself is a one-boundary refactor at `format.ts:formatResult`. The discipline cost is on the schema side — declaring envelopes for every action in the 4 visible composite tools, with annotations colocated.

## 1. Context

### 1.1 What already exists

- `Envelope<T>` is defined and used (`format.ts:75`). `wrap()` accepts typed `nextActions`. `wrapError()` produces a typed `ErrorEnvelope`. `applyCacheHints()` adds runtime-conditional `_cacheHints`. The envelope shape is stable from DR-7/DR-8 (T036–T041) and the v2.10.0-preview.2 Marten primitives (DR-4, DR-11).
- `ToolAction.outputSchema?: z.ZodTypeAny` exists as an **optional** field (`registry.ts:68`), populated for three actions (`workflow.set`, `workflow.transition`, `workflow.update`). The existing declarations use a passthrough envelope with `data: z.unknown()` and typed `_meta.*` slots — the LCD shape this design generalizes.
- `formatResult()` (`format.ts:409`) returns `{ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success }`. No `structuredContent`, no per-tool `outputSchema` passed to `server.registerTool()` (`adapters/mcp.ts:78`).
- CLI `prettyPrint()` (`adapters/cli-format.ts:128`) writes `data` to stdout, sidebars `warnings`/`_perf`/`_eventHints` to stderr.
- `zodToJsonSchema()` is called at 10 sites across 4 files (`describe/handler.ts` ×6, `projections/rehydration/fingerprint.ts` ×2, `runbooks/handler.ts` ×1, `adapters/schema-introspection.ts` ×1) with no `target` argument — default Draft 7.

### 1.2 The four-issue gap

- **#1287** — `formatResult` does not emit `structuredContent`; no per-tool `outputSchema` is registered.
- **#1288** — `next_actions` exist on the envelope but are not typed in any registered schema; clients receive untyped JSON.
- **#1289** — no tool advertises spec annotations (`destructiveHint`/`readOnlyHint`/`idempotentHint`/`openWorldHint`); HSM-guard reasoning that depends on action safety lives in handler prose, not metadata.
- **#1277** — emitted JSON Schemas are Draft 7; the spec defaults to 2020-12.

The four are mutually reinforcing. Landing them separately would leave the wire half-finished for one preview cycle. This design treats them as one delivery.

## 2. Design

### 2.1 Per-action `outputSchema` (Approach C)

Tighten `ToolAction.outputSchema` from optional to required. Each action declares its envelope:

```ts
const EnvelopeSchema = <D extends z.ZodTypeAny>(dataSchema: D) =>
  z.discriminatedUnion('success', [
    z.object({
      success: z.literal(true),
      data: dataSchema,
      next_actions: z.array(NextActionSchema),
      _meta: z.record(z.unknown()).optional(),
      _perf: PerfMetricsSchema,
      _eventHints: EventHintsSchema.optional(),
      _cacheHints: CacheHintsSchema.optional(),
      warnings: z.array(z.string()).optional(),
      _corrections: CorrectionsSchema.optional(),
    }),
    ErrorEnvelopeSchema,  // success: false branch (already exists as a shape; lifted to Zod)
  ]);

// In registry.ts:
const workflowGetAction: ToolAction = {
  name: 'get',
  // ...
  outputSchema: EnvelopeSchema(WorkflowGetDataSchema),
};
```

`EnvelopeSchema` is the new shared factory. It enforces the envelope shape (DIM-1, single source) and accepts a per-action `dataSchema` for the success branch. Error branch is fixed across actions — it's the same `ErrorEnvelopeSchema` lifted from the existing `ErrorEnvelope` interface and `wrapError()` shape.

The per-action data schemas (`WorkflowGetDataSchema`, etc.) are added incrementally as a sibling to the input schema. Where a precise data shape is not yet captured, the action declares `EnvelopeSchema(z.unknown())` and a follow-up issue tightens it.

### 2.2 Per-tool MCP registration

`server.registerTool()` accepts one `outputSchema` per composite tool. Per-tool registration uses an LCD envelope shape — the same `EnvelopeSchema(z.unknown())` for every composite tool — so `tools/list` advertises a uniform contract:

```ts
// adapters/mcp.ts
const LCD_OUTPUT_SCHEMA = EnvelopeSchema(z.unknown());

server.registerTool(
  tool.name,
  { description, inputSchema, outputSchema: LCD_OUTPUT_SCHEMA },
  mcpHandler,
);
```

Per-call: after `dispatch()` returns a `ToolResult`, the adapter locates the action by name, retrieves its declared `outputSchema`, and validates the result before serialization. Validation failures surface as a structured `INTERNAL_ERROR` envelope with `_meta.outputSchemaViolation` carrying the Zod issue path. The wire shape stays well-typed at the LCD level; per-action contracts live in `describe` and are enforced server-side.

### 2.3 Carrier surface — `toMcpResult` / `toCliResult`

Split `formatResult()` along the adapter boundary:

```ts
// format.ts — envelope construction (shared)
export function toEnvelope(result: ToolResult): Envelope<unknown> | ErrorEnvelope {
  // Map ToolResult → Envelope. Reuses wrap() / wrapError() internally.
}

// adapters/mcp.ts
export function toMcpResult(env: Envelope<unknown> | ErrorEnvelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    structuredContent: env,
    isError: !env.success,
  };
}

// adapters/cli-format.ts
export function toCliResult(env: Envelope<unknown> | ErrorEnvelope, format: 'table' | 'json' | 'tree'): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    return;
  }
  // table/tree fall through to the existing prettyPrint path (unchanged).
}
```

The text-content block stays on MCP for backward compatibility (spec SHOULD; INV-2 compat hook). CLI `--format json` literal-encodes the envelope to stdout — a wire-contract change for CLI consumers, addressed in §6 below.

### 2.4 `ActionAnnotations` table

Add an `annotations` field on `ToolAction`:

```ts
export type ActionAnnotations = {
  // Server-trusted. Consumed by HSM guards, next_actions, and dispatch-time
  // validation. Never serialized to the wire.
  safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';

  // Spec-untrusted client UI hints. Populate tools/list.annotations per spec.
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};
```

All four `*Hint` flags are populated to `tools/list` annotations at registration. `safety` is consumed by HSM-guard code paths and by `computeNextActions` — refactored from in-handler prose to a single read from this metadata table. Missing `annotations` fails registration (DIM-3).

Per-action defaults follow the milestone-16 §4.2 table: read-only for `workflow.get`/`event.query`/`view.*`; remote-mutation for `workflow.set` (non-terminal); compensable for terminal-phase or cancel; local-mutation for `event.append` and `orchestrate.delegate`. Every action enumerates explicitly — no defaulting.

### 2.5 `next_actions` in the registered schema

`NextActionSchema` is a Zod schema co-located with the envelope factory. Its shape derives from the `NextAction` interface at `next-action.ts` and is shared by every action's envelope. Round-trip is enforced at startup: a registry-level test validates `computeNextActions(state, hsm)` output against `NextActionSchema` for every workflow type (feature, oneshot, debug, refactor, hotfix, discovery).

### 2.6 JSON Schema 2020-12 conformance (#1277)

Add a small wrapper around `zodToJsonSchema()` that fixes `target: 'jsonSchema2020'`:

```ts
// adapters/json-schema.ts
import { zodToJsonSchema as zts } from 'zod-to-json-schema';
export function zodToJsonSchema(schema: z.ZodTypeAny, opts?: Record<string, unknown>) {
  return zts(schema, { target: 'jsonSchema2020', ...opts });
}
```

Replace all 10 call sites with this import. The wrapper centralizes the conformance bar so future contributors cannot accidentally re-introduce Draft 7. Snapshot tests assert the emitted `$schema` URL is `https://json-schema.org/draft/2020-12/schema` for each composite tool.

## 3. Wire surface — before / after

**Before (MCP `tools/call` response):**

```json
{
  "content": [{ "type": "text", "text": "{\"success\":true,\"data\":{...},\"next_actions\":[...],\"_meta\":{...},\"_perf\":{...}}" }],
  "isError": false
}
```

**After (MCP `tools/call` response):**

```json
{
  "content": [{ "type": "text", "text": "{\"success\":true,\"data\":{...},\"next_actions\":[...],\"_meta\":{...},\"_perf\":{...}}" }],
  "structuredContent": {
    "success": true,
    "data": { /* ... */ },
    "next_actions": [ /* ... */ ],
    "_meta": { /* ... */ },
    "_perf": { "ms": 12, "bytes": 1240, "tokens": 310 }
  },
  "isError": false
}
```

**Before (CLI `--format json` stdout):**

```
{ "phase": "ideate", "workflowType": "feature" }
```

Plus stderr lines for `_perf`, `_eventHints`, warnings.

**After (CLI `--format json` stdout):**

```json
{
  "success": true,
  "data": { "phase": "ideate", "workflowType": "feature" },
  "next_actions": [ /* ... */ ],
  "_meta": { /* ... */ },
  "_perf": { /* ... */ }
}
```

Stderr no longer carries `_perf` / `_eventHints` / `warnings` under `--format json` — they ride inside the envelope on stdout. Table/tree modes are unchanged.

## 4. Invariant audit (INV-1..INV-5d)

- **INV-1 Event-sourcing integrity.** Pure output-shape change. No new event types, no read or write of events, no state mutation. Existing event-sourcing properties hold.
- **INV-2 Facade equivalence.** Both surfaces emit the same `Envelope<T>` byte-for-byte modulo timestamps and IDs. CLI `--format json` and MCP `structuredContent` share envelope construction (`toEnvelope` in `format.ts`); only the carrier serialization differs. This invariant is the primary motivation for the CLI breaking change in §2.3 — keeping today's CLI shape would violate INV-2.
- **INV-3 Basileus-forward.** `structuredContent` is JSON-RPC native. Remote MCP servers (basileus) carry the same envelope identically with no special-casing. The per-action validation step is server-local and does not depend on transport.
- **INV-4 Platform-agnosticity.** No platform-specific paths. CLI and MCP adapters route through shared `toEnvelope` / `EnvelopeSchema`. No `process.platform` branching.
- **INV-5a Input ergonomics.** Unaffected — input boundary is unchanged.
- **INV-5b Output contract.** This is the primary delivery against INV-5b. Every action declares a typed envelope; `next_actions` are typed and validated; `_meta` typed slots are documented; error envelope shape is canonical and validated. The "do NOT use for" guidance referenced by INV-5a applies to descriptions, which are unchanged by this work.
- **INV-5c Aspire verbs.** Unaffected — verb taxonomy is unchanged.
- **INV-5d Action discriminator.** Preserved on input. **Not extended to output** — that would force a wire shape change with cascading test churn. Per-action specificity surfaces through `describe` instead.

## 5. Quality audit (axiom DIM-1..DIM-8)

- **DIM-1 Topology.** Single source per concern. The action metadata table on `ToolAction` is the single source for `outputSchema`, `annotations`, and `safety`. Envelope construction is single-source in `format.ts:toEnvelope`. Adapter formatting is per-adapter (`toMcpResult`, `toCliResult`). No back-channel for safety or schema-derived state.
- **DIM-2 Observability.** Schema-validation failures emit a structured `INTERNAL_ERROR` envelope with `_meta.outputSchemaViolation` containing the Zod issue path. Registration failures (missing `outputSchema` or `annotations`) throw at startup with the action name in the message. No silent catches.
- **DIM-3 Contracts.** `outputSchema` is validated at registration (typed Zod) and at every call (against the dispatched action's schema). Spec annotations are populated to `tools/list`. Schema drift across action ↔ handler ↔ describe is caught at startup. JSON Schema draft conformance is enforced by the shared `zodToJsonSchema` wrapper.
- **DIM-4 Test fidelity.** Wire-level test: `tools/call` response carries both `content[0].text` and `structuredContent`; `structuredContent` validates against the LCD-registered `outputSchema` and against the per-action schema. CLI parity test: `--format json` stdout byte-equal to `structuredContent` modulo timestamps. Annotation test: `tools/list` annotations field per action matches the declared table.
- **DIM-5 Hygiene.** The `formatResult()` symbol is removed once both adapters consume `toMcpResult` / `toCliResult`. The three preview.2 `WorkflowSet/Transition/UpdateOutputSchema` declarations consolidate into the new `EnvelopeSchema(dataSchema)` factory; the standalone constants are removed once all actions migrate. No commented-out code.
- **DIM-6 Architecture.** Adapter boundary preserved. Dispatch core does not import from `adapters/`. Carrier mapping moves to adapters; envelope construction stays in `format.ts`. `EnvelopeSchema` lives next to `format.ts` so envelope shape and its schema are co-located.
- **DIM-7 Resilience.** Per-call Zod validation is O(schema size) — bounded, sub-millisecond on every action measured. Validation failures route to the error envelope path; the server never throws an uncaught exception to the SDK transport layer. No retention concern (no new persistent state).
- **DIM-8 Prose quality.** Action descriptions, schema `describe()` strings, and the `_meta.outputSchemaViolation` message follow the project's direct technical voice. No AI-vocabulary clusters in new strings.

## 6. Backward compatibility

**MCP clients.**
- Old clients reading `content[0].text` get the JSON-stringified envelope, unchanged.
- New clients reading `structuredContent` get the same envelope as a JSON object plus typed validation against the registered `outputSchema`.
- No breaking change for MCP consumers.

**CLI consumers.**
- Today: `exarchos wf get -f foo --format json` writes `{ "phase": "ideate", ... }` (the `data` payload) to stdout. Warnings and `_perf` sidebar to stderr.
- Post-swap: same command writes the full envelope to stdout. Consumers parsing the response must read `.data` rather than the top-level object.
- This is a wire-contract break. INV-2 (facade equivalence) requires it; without it, MCP and CLI emit different shapes and the dogfood waves' envelope additions diverge.
- Mitigation: the new envelope shape ships as the default; `EXARCHOS_CLI_ENVELOPE=0` opts back into today's behavior for one preview cycle so external consumers (if any) can migrate before v2.10.0 GA. The opt-out flag is dropped in v2.11.0.

The opt-out flag is the **only** backward-compat hook in this design. It exists because CLI consumers are out of band from MCP capability negotiation — there's no handshake to declare "I read envelopes." The MCP side has no flag; `structuredContent` is purely additive next to `content`.

## 7. Test plan

Per-tool integration tests (one per visible composite tool):

1. `tools/list` includes `outputSchema` and `annotations` per tool.
2. `tools/call` response carries `content[0].text` and `structuredContent`; `structuredContent` validates against the registered LCD schema.
3. For each action: dispatch returns an envelope that validates against the per-action `outputSchema`.
4. Error path: dispatch failure produces a `success: false` envelope with `error.code` set; validates against the error branch of `EnvelopeSchema`.

CLI parity tests:

5. `exarchos <tool> <action> --format json` stdout equals MCP `structuredContent` byte-for-byte modulo timestamps and IDs (string-replace masking).
6. `--format table` and `--format tree` paths emit the same `data` content as today (no regression).
7. `EXARCHOS_CLI_ENVELOPE=0` keeps today's behavior for one preview cycle.

Schema conformance tests (replaces ad-hoc draft tracking):

8. Snapshot per composite tool of the emitted JSON Schema; assert `$schema: https://json-schema.org/draft/2020-12/schema`.
9. Snapshot per composite tool of `tools/list.annotations`; assert against the milestone-16 §4.2 table.

Round-trip:

10. `computeNextActions(state, hsm)` output validates against `NextActionSchema` for every workflow type.
11. `wrapError(<each error class>)` output validates against the error branch of `EnvelopeSchema`.

## 8. Sequencing within Wave 0

1. **#1277 first.** Centralize `zodToJsonSchema` through the new `adapters/json-schema.ts` wrapper. Pure-function change, lowest blast radius. Sets the conformance bar for everything #1287 emits.
2. **#1287 + #1289 lockstep.** `outputSchema` and `annotations` are both registration-time fields on `ToolAction`. Adding them in one PR avoids two passes through the same 99-action registration table. Carrier swap in `formatResult` ships in the same PR.
3. **#1288 alongside or immediately after.** `NextActionSchema` is a small addition; it's co-located with `EnvelopeSchema`. Land in the same PR as #1287/#1289 unless it pushes the diff past review-tolerance — then a same-day follow-up.

Hard order: #1277 → (#1287 + #1289 + #1288). No reverse dependency.

## 9. Carrier-wave interaction with dogfood waves

The dogfood waves (#1359/#1360/#1364) introduce new envelope fields. After Wave 0 lands they must declare each new field on the relevant action's `outputSchema`:

- **#1359** — `projectionAsOf` and `_meta.projectionLag` on `workflow.rehydrate` and `view.pipeline`. Each extends its action's `dataSchema` and `_meta` typed-slot definition.
- **#1360** — structured `RESERVED_FIELD` error payload (`rejectedPath`, `rule`, `alternateWritePath`). Extends the error branch of `EnvelopeSchema` — this is a shared add, applies to every action.
- **#1364** — `actionErrors` / `actionErrorBreakdown` on `view.telemetry`. Extends that action's `dataSchema`.

The interaction is mechanical: every envelope-shape change goes through a schema declaration. Wave 0 makes that declaration possible. Pre-Wave-0, those fields would be untyped additions to `data`.

## 10. Open risks

- **MCP SDK `outputSchema` argument shape.** Verify `registerTool(name, { ..., outputSchema })` accepts a Zod schema directly or requires JSON Schema. If JSON Schema is required, the wrapper converts via the new `zodToJsonSchema` helper at registration — same surface, one extra step. Verified against `@modelcontextprotocol/sdk@1.29.0` (the pinned version after the PR-C migration; the original draft cited 1.26.x before the rebase).
- **Per-call validation overhead.** Sub-millisecond on every action measured locally; not a real risk but worth a benchmark assertion in the integration suite. If validation cost becomes load-bearing, move it to dev-mode-only with a `EXARCHOS_OUTPUT_VALIDATE=strict|warn|off` knob.
- **CLI breaking change reception.** The opt-out flag covers one preview cycle. If external CLI consumers exist (unlikely — CLI is pre-1.0), they get one preview to migrate. Communicate via release notes.
- **Action-count migration cost.** The four visible composite tools have on the order of 50–90 actions between them. Each gets a per-action `dataSchema` and `annotations` table. Initial migration declares `dataSchema = z.unknown()` for actions whose data shape isn't yet captured — follow-up issues per workflow domain tighten them.

## 11. Out of scope (locked)

- **Roots-based workspace discovery (#1290).** Deferred to preview.4 per epic #1354.
- **Dispatch-boundary operationId (#1291).** Deferred to preview.4.
- **SDK pin (#1292).** Deferred to preview.4.
- **Tasks (SEP-1686) adoption.** v2.11.0 work; gated on event-store substrate (#1259).
- **Per-action `data` schema tightening for all 99 actions.** Initial migration ships LCD per-action; tightening is follow-up work per workflow domain.
- **Output-side action discriminator on the envelope.** Approach B in the design exploration. Explicitly rejected to keep blast radius bounded.

## 12. Sources

- Epic: [#1354 — v2.10.0-preview.3](https://github.com/lvlup-sw/exarchos/issues/1354)
- Issues: [#1287 carrier swap](https://github.com/lvlup-sw/exarchos/issues/1287), [#1288 next_actions in outputSchema](https://github.com/lvlup-sw/exarchos/issues/1288), [#1289 annotations](https://github.com/lvlup-sw/exarchos/issues/1289), [#1277 JSON Schema 2020-12](https://github.com/lvlup-sw/exarchos/issues/1277)
- Milestone-16 design: [`docs/designs/2026-05-07-milestone-16-mcp-alignment.md`](2026-05-07-milestone-16-mcp-alignment.md) §4.1, §4.2
- Cross-cutting constraints: [#1109](https://github.com/lvlup-sw/exarchos/issues/1109)
- MCP spec: [`tools/call` structured content + outputSchema](https://modelcontextprotocol.io/specification/2025-11-25)
- Local prior art: `servers/exarchos-mcp/src/format.ts`, `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/adapters/mcp.ts`, `servers/exarchos-mcp/src/adapters/cli-format.ts`
