# Milestone 16 — MCP 2025-11-25 spec alignment

**Status:** design (pending plan-review)
**Date:** 2026-05-07
**Audience:** Exarchos maintainers; v2.10.0 / v2.11.0 milestone owners
**Scope:** `servers/exarchos-mcp/` envelope, registration, capability surface
**Replaces in v2.10.0:** #1098, #1099, #1100 (close in favor of new spec-aligned issues filed from this design)
**Composes with:** #1170 (Windows CI — independent), #1259 (event-store substrate spike — gates Tasks adoption), #1260 (invariants file), #1261 (preflight events), #1262 (output-token quality_hint)
**Supporting research:**
[`docs/references/2026-05-07-ev2-mcp-agent-output-contract.md`](../references/2026-05-07-ev2-mcp-agent-output-contract.md),
[`docs/references/exarchos-1098-comment.md`](../references/exarchos-1098-comment.md)

## TL;DR

Milestone 16 was drafted before the MCP 2025-11-25 spec landed. Several pieces it
designs from scratch — the HATEOAS envelope (`#1098`), `next_actions`
(`#1099`), NDJSON streaming (`#1100`) — now have spec-native equivalents in
stable or near-stable form: `outputSchema` / `structuredContent`, tool
annotations, Roots, Elicitation, and Tasks (SEP-1686).

This design retargets the milestone onto those primitives. The biggest single
finding: the HATEOAS envelope is not new work — `Envelope<T>` (DR-7/DR-8) is
already implemented in `servers/exarchos-mcp/src/format.ts`. The gap is that
the envelope is JSON-stringified into `content[0].text` instead of emitted via
`structuredContent`. Aligning this is a one-boundary refactor (`formatResult`),
plus per-tool `outputSchema` registration in `registry.ts`. The same envelope
shape stays; only the carrier changes.

The deeper move is Tasks (SEP-1686). It supersedes `#1100`'s NDJSON design.
Tasks is capability-negotiated, has spec-defined `tasks/get` / `tasks/result`
/ `tasks/cancel`, supports `input_required` for human approval gates, and
fits Exarchos's `--follow` use case word-for-word (SEP-1686 customer use case
\#4). Adoption is bounded to one tool initially, blast-radius-limited by a
custom event-sourced TaskStore that is itself a projection over `task.*`
events. This last detail is non-negotiable under Constraint 1 — the SDK's
in-memory TaskStore would be a second source of truth and a Topology
violation (DIM-1).

The work splits across two milestones. v2.10.0 lands the carrier swap,
annotations, Roots, dispatch-boundary `operationId`, and the SDK pin. v2.11.0
adds Tasks (after #1259 substrate lands), Elicitation form mode, Resources for
docs, and the `#1262` quality_hint slot. URL-mode auth and full Resources
subscription get their own design later.

Three patterns from the parent spike are explicitly dropped here. They are
listed in §6 so future readers do not re-litigate them.

## 1. Context

### 1.1 Existing Exarchos infrastructure (already shipped)

The work the parent spike identifies as foundation-prerequisite is already done in Exarchos:

- `Envelope<T>` (`format.ts:68`) carries `success`, `data`, `next_actions`, `_eventHints`, `_meta`, `_perf`, `_cacheHints`
- `wrap()` accepts a typed `nextActions` argument (T041, DR-8)
- `computeNextActions(state, hsm)` derives them from HSM topology
- `wrapWithPassthrough()` threads `warnings` and `_corrections` through the envelope boundary
- `applyCacheHints()` adds Anthropic-native cache-boundary hints
- SDK `@modelcontextprotocol/sdk@1.26.0` is installed; `experimental/tasks/` is on disk

### 1.2 The actual gap

`formatResult()` (`format.ts:272`) returns:

```ts
{ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success }
```

This crams the entire envelope into a single text block. The 2025-11-25 spec's
`CallToolResult` carries a sibling `structuredContent` field for the validated
JSON object, with the text block kept "for backwards compatibility." No tool
in the registry declares an `outputSchema`. No tool declares annotations
(`destructiveHint` / `readOnlyHint` / `idempotentHint` / `openWorldHint`). The
client-side `roots` capability is not consulted. `taskSupport` is not
declared. The result: clients that understand the modern spec receive a
strictly less-typed payload than the protocol allows.

### 1.3 The novelty argument

`#1088`'s framing — "the most novel v3.0 differentiator" — was right when
written, before the spec absorbed the same patterns. That motion is
expected; it is what a healthy protocol does. The novelty now is *which
primitives Exarchos lifts to the envelope shape*, not the envelope itself.
Three Exarchos-shaped extensions remain genuinely outside the spec:
`_eventHints` (event-source acknowledgement), `_cacheHints` (Anthropic
cache-control hint), and the typed `next_actions` derived from HSM topology.
These ride alongside the spec primitives, not against them.

## 2. Cross-cutting constraints (#1109)

Each design decision below is mapped against the four #1109 constraints. Any
deviation is called out with reasoning.

### 2.1 Constraint 1 — Event-sourcing integrity

| Decision | Reads events | Writes events | Streams events | Reconstructable from events alone |
| --- | --- | --- | --- | --- |
| structuredContent migration | no | no | no | n/a (output shape, not state) |
| Tasks adoption | yes (TaskStore is a projection) | yes (`task.created`, `task.polled`, `task.result`, `task.cancelled`) | yes (subscriptions over the `task.*` projection) | yes |
| operationId correlation | no | yes (every event during dispatch carries `operationId`) | n/a | yes |
| Roots-based workspace discovery | no | yes (`workspace.resolved` with `source: roots \| cwd`) | no | yes |
| Annotations table | no | no | no | n/a (registration-time metadata) |
| Elicitation (v2.11.0) | no | yes (`elicitation.requested`, `elicitation.fulfilled`) | no | yes |
| Resources (v2.11.0) | yes (project state, design docs via projections) | no (read-only) | yes (subscriptions, bounded) | yes |

The TaskStore-as-projection rule is non-negotiable. The SDK ships an
`InMemoryTaskStore` that would be a second source of truth for task state.
That fails Constraint 1 and DIM-1 (Topology) at the HIGH severity bar from
`dimensions.md` ("module silently creates degraded instances of shared
resources"). The custom TaskStore in v2.11.0 is therefore a thin reducer over
`task.*` events, gated on the #1259 substrate landing.

### 2.2 Constraint 2 — MCP parity

CLI and MCP route through the same dispatch core today. This design preserves
that. Specifically: one Zod `outputSchema` per action lives in `registry.ts`.
The MCP adapter binds it via `server.registerTool()`'s third argument; the
CLI adapter's `--format json` mode literal-encodes the same envelope. The
contract is identical; the carrier differs (`structuredContent` on MCP, JSON
stdout on CLI). Tool annotations populate MCP's `tools/list` response and the
CLI's `exarchos schema` introspection from the same source.

### 2.3 Constraint 3 — Basileus-forward

Three implications:

1. `structuredContent` is JSON-RPC native. Remote MCP servers (basileus)
   serve the same envelope shape with no special-casing.
2. Roots is a *client* capability. Remote clients declaring it get the same
   workspace-discovery path Claude Code does. Clients without it fall back to
   explicit-path; no assumption that MCP is local.
3. Tasks is capability-negotiated end-to-end. `taskSupport: optional` means
   non-Task clients keep one-shot behavior. Remote orchestrators that
   understand Tasks get the polling protocol over the same JSON-RPC pipe.

### 2.4 Constraint 4 — Capability resolution

All capability decisions go through `CapabilityResolver` — none read
`server.capabilities` or `client.capabilities` at the call site. `taskSupport`
flags, annotation values, and Roots availability are resolved once at
handshake and cached on the resolver. Per-call lookups would create a Topology
violation (DIM-1) and a contract drift surface against the handshake-authoritative
ADR §3.6.

## 3. Quality invariants (axiom DIM-1..DIM-8)

These are not applied to specific files; they are design rules every issue
filed from this document must honor.

- **DIM-1 Topology.** One source of truth per concern. The action metadata
  table on `CompositeAction` is the single source for outputSchema, annotations,
  safety, taskSupport. The TaskStore is the single source for task lifecycle,
  itself a projection over events. `formatResult` becomes adapter-specific
  (`adapters/mcp.ts`, `adapters/cli-format.ts`); envelope construction stays
  in `format.ts`.
- **DIM-2 Observability.** Roots fallback to cwd is event-emitting, not
  silent. Elicitation events record the field name and reason. Tasks lifecycle
  is fully event-traced. No `catch {}` introduced by this work.
- **DIM-3 Contracts.** outputSchema is registered at server startup — schema
  drift is caught before first call. Registration tests assert against
  `tools/list` wire shape, not the internal registry. Annotation table is
  typed; missing entries fail registration.
- **DIM-4 Test fidelity.** New tests use the production wiring of registration
  and dispatch, not mock the renderer. The custom TaskStore is exercised by
  integration tests that emit and replay events, not by mock task lifecycle
  calls.
- **DIM-5 Hygiene.** Closing #1100 deletes any in-tree NDJSON prototype
  code; nothing ships commented-out. Closing #1098 / #1099 removes any code
  paths superseded by the new outputSchema/structuredContent flow.
- **DIM-6 Architecture.** Adapter boundary is preserved: dispatch core does
  not import adapter code. The new TaskStore lives next to the event store, not
  inside the MCP adapter, so basileus-remote remote clients can serve it.
- **DIM-7 Resilience.** TaskStore has bounded retention (TTL on each task,
  per spec). Resources subscriptions in v2.11.0 have a max-subscribers cap.
  operationId / guardOutcomes collectors are dispatch-scoped, not
  server-scoped — no unbounded growth.
- **DIM-8 Prose quality.** Issue bodies, action descriptions, and design
  doc updates avoid AI vocabulary clusters and maintain the direct technical
  voice of the existing `format.ts` comments.

## 4. Design

### 4.1 Carrier swap (v2.10.0)

`registerTool()` is called per composite tool with `inputSchema` today. Add a
fourth argument `outputSchema` derived from a new `CompositeAction.outputSchema`
field. The envelope shape stays as `Envelope<T>` from `format.ts` — the
schema is the existing type, expressed in Zod.

`formatResult()` is split. The envelope construction stays in `format.ts` and
is shared. Carrier mapping moves to two adapters:

```ts
// adapters/mcp.ts
function toMcpResult(env: Envelope<unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(env) }],
    structuredContent: env,
    isError: !env.success,
  };
}
```

The text block stays for backward compatibility (spec SHOULD; #1109
constraint 2). Clients that read `structuredContent` get the validated object;
clients that don't get the JSON in text. CLI `--format json` continues to
write the envelope literally to stdout; CLI `--format table` is unchanged.

### 4.2 Tool annotations (v2.10.0)

Add a new field on `CompositeAction`:

```ts
type ActionAnnotations = {
  safety: 'read-only' | 'local-mutation' | 'remote-mutation' | 'compensable';
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};
```

Spec annotations are computed from this table at registration. The `safety`
field is an Exarchos-internal addition consumed by next_actions and HSM
guards — server-trusted, where the spec annotations are explicitly untrusted
(spec §Tools / Annotations). Per-action examples:

| Action | safety | readOnly | destructive | idempotent |
| --- | --- | --- | --- | --- |
| `workflow.get`, `event.query`, `view.*` | read-only | true | false | true |
| `workflow.set` (non-terminal phase) | remote-mutation | false | false | depends |
| `workflow.set` (terminal phase), `workflow.cancel` | compensable | false | true | false |
| `event.append` | local-mutation | false | false | false |
| `orchestrate.delegate` | local-mutation | false | false | false |

### 4.3 Roots-based workspace discovery (v2.10.0)

Today `featureId` is supplied explicitly on every dispatch. In contexts where
it could be inferred from the workspace (CLI inside a worktree, MCP client
with `roots` capability), the absence is currently an `INVALID_INPUT` error.
With Roots: when `featureId` is omitted and the client declares `roots`,
`roots/list` is called, each root is examined for an Exarchos workspace
signature, and exactly one match resolves. Zero matches falls back to cwd
walk. Multiple matches return `INVALID_INPUT` with `validTargets` populated.

Both the resolved-via-roots and fallback-to-cwd paths emit
`workspace.resolved { source, path, featureId }`. No silent resolution.

### 4.4 Dispatch-boundary `operationId` (v2.10.0)

A uuid minted at the entry of `dispatch()` and threaded through:

- attached to every event emitted during the call (correlation)
- exposed on the envelope as `_meta.operationId`
- included in `dispatch.preflight` events from #1261 with the same value
- included in `task.*` events when a Tasks-augmented call fires

This bridges #1098 (envelope), #1100 (Tasks), #1261 (preflight events), and
#1262 (quality_hint). The four issues become one observability surface keyed
on operationId, not four uncorrelated metadata streams.

### 4.5 Tasks adoption (v2.11.0)

**Tasks is a dispatch-core abstraction, not an MCP-adapter-only adoption.**
Both CLI and MCP facades consume it, in keeping with #1109 Constraint 2 (MCP
parity — same dispatch core, thin adapters).

```
                ┌─────────────────────────────────────────────┐
                │  Dispatch Core (shared)                     │
                │  ┌────────────────────────────────────────┐ │
                │  │ One-shot: returns Envelope<T>          │ │
                │  ├────────────────────────────────────────┤ │
                │  │ Tasks-augmented:                       │ │
                │  │   - returns CreateTaskResult           │ │
                │  │   - lifecycle in EventSourcedTaskStore │ │
                │  │   - emits task.created/polled/result   │ │
                │  └────────────────────────────────────────┘ │
                └────────┬────────────────────────────┬───────┘
                         │                            │
               ┌─────────▼──────────┐    ┌────────────▼─────────────┐
               │  CLI adapter       │    │  MCP adapter             │
               │  (in-process       │    │  (delegated polling      │
               │   Tasks consumer)  │    │   via tasks/get etc)     │
               └────────────────────┘    └──────────────────────────┘
```

**The TaskStore is a custom implementation backed by the event store landed
via #1259:**

```
class EventSourcedTaskStore implements TaskStore {
  // CreateTask emits task.created → caller gets taskId
  // GetTask reads the task.* projection at sequence
  // GetTaskResult waits on task.result event
  // CancelTask emits task.cancelled
}
```

#### 4.5.1 MCP facade (`tools/call` with `task: { ttl }`)

The server receives the augmented call, runs the Tasks dispatch path, and
returns `CreateTaskResult` immediately. The client (Claude Code, Copilot, VS
Code MCP) drives `tasks/get` polling per the protocol's `pollInterval`. Final
result via `tasks/result`. `taskSupport: 'optional'` on the tool registration,
so non-Task clients fall back to one-shot.

#### 4.5.2 CLI facade (`exarchos <verb> --follow`)

The CLI adapter is itself an in-process Tasks consumer. The `--follow` flag
triggers the same dispatch-core path, then runs a local polling loop against
the **same EventSourcedTaskStore** that the MCP path consumes. Because the
TaskStore is a process-local projection, "polling" is a function call into
the projection at a sequence, not a JSON-RPC round-trip. Each terminal or
intermediate status transition is rendered to stdout per the configured
output format:

- `--format json`: one NDJSON line per transition (the wire shape #1100
  originally proposed, now downgraded from protocol to render format)
- `--format table`: rolling table rows or status updates

The loop exits when the task reaches `completed | failed | cancelled`. The
existing one-shot CLI path stays for non-`--follow` calls.

#### 4.5.3 Surface parity guarantee

Given the same workflow, `exarchos <verb> --follow --format json` and the
equivalent MCP `tools/call` with task augmentation produce **identical
envelope shapes per state transition** — only the carrier differs (NDJSON
stdout lines vs. `tasks/get` response payloads). Both surfaces share:

- the same `EventSourcedTaskStore` instance (process-local for CLI; same
  process for the MCP server)
- the same `task.*` event stream
- the same `operationId` correlation (§4.4)
- the same Zod schema (DIM-3 contracts) — render-shape is one source

This means a regression test can run the same dispatch through both adapters
and assert content equality on every transition.

#### 4.5.4 Bounded scope

First adoption is `exarchos_view --follow` (workflow status, shepherd
status). One tool, both adapters, capability-negotiated on MCP and `--follow`
gated on CLI.

Risk-acceptance: SDK pinned to `1.26.x` (no caret range); first adoption is
one tool only. If the experimental API breaks in `1.27.x`, blast radius is
the v2.11.0 follow-on. CLI consumption of the TaskStore is independent of
SDK API stability — the adapter calls into Exarchos's own TaskStore
interface, not the SDK surface.

`task.*` events carry the `operationId` from §4.4, so a Tasks-augmented
`--follow` is fully reconstructable from the event stream alone (Constraint 1,
acceptance criterion #4).

### 4.6 Elicitation form mode (v2.11.0)

When `dispatch()` finds a missing required parameter and the client declares
`elicitation`, send `elicitation/create` with the field's Zod schema instead
of returning `INVALID_INPUT`. Existing error-path stays as fallback for
clients without elicitation. Events: `elicitation.requested`,
`elicitation.fulfilled` — both carrying `operationId`.

The elicitation `requestedSchema` is derived from the action's `inputSchema`
via Zod's `.pick({ field: true })`, not hand-written. This forces DIM-3
contract integrity — the elicitation schema cannot drift from the validation
schema.

URL-mode elicitation (for credential / OAuth flows) is deferred to a separate
v2.12.0+ design.

### 4.7 Resources for docs and playbooks (v2.11.0)

Promote three sources to MCP Resources:

1. Action documentation (replaces inline `ev2Docs`-style strings)
2. Topology playbooks returned today by `workflow.describe(playbook: ...)`
3. Cross-cutting invariants from #1260's `docs/architecture/invariants.md`

Resources are read-only projections — no event-write surface. Subscription
fan-out is bounded by a max-subscribers cap (DIM-7). Resources for the
feature workspace tree (state file, design, plan) are deferred to v2.12.0+;
they raise different access-control questions.

### 4.8 Quality_hint slot (v2.11.0)

`#1262` (output-token hint) wires through `_meta.qualityHints[]`. The slot
already exists in the envelope; no shape change. The hint is computed from
the existing telemetry projection (DIM-1 single source), and the suggested
`next_action: checkpoint` rides through the existing next_actions channel.

## 5. Replaces / closes

| Existing issue | Disposition | Replaced by |
| --- | --- | --- |
| #1088 (epic) | Rewrite to point at this design | This document |
| #1098 (envelope) | Close | New issue: outputSchema + structuredContent migration (v2.10.0) |
| #1099 (next_actions) | Close — already implemented | New issue: next_actions in registered outputSchema (v2.10.0) |
| #1100 (NDJSON) | Close | New issue: Tasks dispatch-core integration covering MCP and CLI surfaces (v2.11.0, depends on #1259) |
| #1170 (Windows CI) | Keep — independent | (no change) |
| #1259 (event-store spike) | Keep — gating dependency for §4.5 | (no change) |
| #1260 (invariants file) | Keep — feeds Resources in v2.11.0 | (no change, links to §4.7) |
| #1261 (preflight events) | Keep — composes with §4.4 | (no change, links to operationId) |
| #1262 (quality_hint) | Keep — composes with §4.8 | (no change, links to envelope slot) |

## 6. Patterns dropped

Three patterns from the supporting research are dropped here. Documented so
future readers do not re-litigate.

| Pattern | Why dropped |
| --- | --- |
| HATEOAS envelope as JSON-in-text wrapper | `structuredContent` carries the envelope natively. Already done in `Envelope<T>`. |
| NDJSON streaming as the wire protocol | Tasks (SEP-1686) does this with capability negotiation. NDJSON would be polling-without-the-protocol. |
| Sampling, Prompts, pre-Tasks Progress notifications | Not applicable. Sampling inverts the loop (the model is outside the tool); Prompts would duplicate skill content; pre-Tasks Progress is superseded by Tasks. |

## 7. Milestone partition

```
v2.10.0 — Spec carrier + safety layer
├── ISSUE-A: outputSchema + structuredContent migration       (replaces #1098)
├── ISSUE-B: next_actions in registered outputSchema           (replaces #1099)
├── ISSUE-C: tool annotations table on CompositeAction         (new)
├── ISSUE-D: Roots-based workspace discovery, capability-gated (new)
├── ISSUE-E: dispatch-boundary operationId as event correlation (new, composes with #1261)
├── ISSUE-F: SDK pin to 1.26.x                                  (new)
├── #1170:   Windows CI matrix                                  (already filed)
└── #1100:   close                                              (no replacement in this milestone)

v2.11.0 — Spec interaction layer (depends on v2.10.0 + #1259)
├── ISSUE-G: Tasks (SEP-1686) dispatch-core integration         (replaces #1100, depends on #1259, ISSUE-H)
│            — covers MCP tools/call+task path AND CLI --follow renderer; surface parity required
├── ISSUE-H: EventSourcedTaskStore (TaskStore as projection)    (depends on #1259)
├── ISSUE-I: Elicitation form mode for INVALID_INPUT            (new)
├── ISSUE-J: Resources for docs / playbooks / invariants        (new, consumes #1260)
└── #1262:   quality_hint via _meta.qualityHints[]              (already filed, depends on ISSUE-A)

v2.12.0+ — Out of scope for this design
├── URL-mode Elicitation for credential flows                   (separate design)
├── Resources for feature workspace trees                       (access control questions)
└── Annotation-driven UI hints in client-side renderers         (downstream)
```

## 8. Decision points (resolved)

1. **SDK pin version** — `1.26.x` (current). Caret range removed. Re-pin
   reviewed each minor.
2. **TaskStore implementation** — custom event-sourced. Depends on #1259
   substrate. Tasks adoption (ISSUE-G, ISSUE-H) blocks on #1259's spike
   completing and a substrate decision landing.
3. **Annotation table location** — new field on `CompositeAction` in
   `registry.ts`. Typed, co-located with the schema, fails closed at
   registration if missing.

## 9. Open risks

- **Tasks experimental status drift.** SEP-1686 is Final on the SEP track;
  spec text marks the surface "experimental." Both SDKs mark it experimental.
  Risk-mitigated by SDK pin (decision 1) and bounded first adoption (§4.5).
- **#1259 dependency on Tasks adoption.** If the spike defers a substrate
  decision past v2.11.0, ISSUE-G and ISSUE-H slip alongside. Acceptable —
  Tasks is opt-in via capability negotiation, so deferring it does not break
  existing one-shot consumers.
- **Client compatibility unverified.** Before ISSUE-G ships, verify Copilot
  CLI, VS Code MCP, and the Claude Code MCP host fall back to one-shot
  behavior with `taskSupport: 'optional'`.
- **Skill drift.** Bundled skills reference action shapes via prose. ISSUE-A
  changes the carrier (text → text + structuredContent) but not the shape, so
  skills should not drift. ISSUE-C (annotations) introduces a new
  registration-time field that skill prompts can consume; coordinate skill
  refresh in the same release.

## 10. Sources

### Supporting research

- [`docs/references/2026-05-07-ev2-mcp-agent-output-contract.md`](../references/2026-05-07-ev2-mcp-agent-output-contract.md)
- [`docs/references/exarchos-1098-comment.md`](../references/exarchos-1098-comment.md)

### External

- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [SEP-1686: Tasks](https://modelcontextprotocol.io/seps/1686-tasks.md)
- [TypeScript SDK `@modelcontextprotocol/sdk@1.26.0`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [Basileus ADR — Ontological Data Fabric](https://github.com/lvlup-sw/basileus/blob/main/docs/adrs/ontological-data-fabric.md)

### Local prior art

- `servers/exarchos-mcp/src/format.ts` — existing `Envelope<T>` (DR-7/DR-8)
- `servers/exarchos-mcp/src/adapters/mcp.ts` — current MCP adapter, target of §4.1
- `servers/exarchos-mcp/src/registry.ts` — `CompositeAction` shape, target of §4.2
- `servers/exarchos-mcp/src/capabilities/resolver.ts` — capability resolver, used by §4.5 / §4.6
- `docs/designs/2026-04-23-rehydrate-foundation.md` — envelope wrapping origin (T036–T041)
