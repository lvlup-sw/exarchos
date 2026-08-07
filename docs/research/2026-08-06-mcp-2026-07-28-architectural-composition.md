# MCP `2026-07-28` × the Exarchos internal contract — architectural composition

**Date:** 2026-08-06
**Workflow:** `mcp-spec-2026-07-28-migration` (discovery, companion doc)
**Companion to:** [`2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md`](./2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md) — that doc scopes migration *cost*; this one scopes *fit*.
**Status:** research complete — no code changed. All counts verified against `main` @ `30831d05f`.

---

## 1. Thesis

> **`2026-07-28` moves MCP onto the architecture the CLI facade has had all along.**

Every headline pattern in the revision — explicit handles instead of session state, per-request self-description, polling instead of blocking, return-plus-retry instead of a server-initiated back-channel, server-directed rather than client-opted long-running work — is a pattern the CLI facade was *forced* into, because a CLI process has no session, no persistent connection, and no back-channel.

MCP was the facade that could do more. That surplus is exactly what the revision removes.

The consequence is not merely "migration is survivable." It is that **INV-2 facade equivalence gets structurally easier to hold**, and long-standing divergences between the facades either disappear or become pure presentation. Exarchos does not need to bend to accommodate this spec; the spec has bent toward Exarchos's CLI.

Worth stating precisely because it inverts the usual read. The ecosystem is treating `2026-07-28` as a tax on server authors who built around sessions. Exarchos never did — and the CLI facade is the reason. The parity discipline INV-2 imposed as a *cost* turns out to have been a hedge that just paid out.

**But the payout is conditional.** Four components decide whether the migration lands on a contract that actually holds or on one that merely looks like it does. They are the spine of this document (§3), and each is a **gate**, not a follow-up.

---

## 2. The two contracts, as they stand

### 2.1 The internal contract — INV-2 and INV-17

INV-2 (`dimension: facade-equivalence`, `integrity-class: substrate`), verbatim:

> CLI and MCP are both facades over a single functional dispatch core. For any verb, the same DispatchContext + arguments must produce the same ToolResult. Adapters carry zero behavior — only presentation. Post-#1266, every action also registers a Zod outputSchema so parity is schema-checked in addition to byte-checked.

Enforcement is `mode: audit`, deliberately not `check`, with this audit prompt:

> Do the CLI and MCP adapters carry only presentation, with all behavior in the shared dispatch core? Flag logic added to `adapters/cli.ts` or `adapters/mcp.ts` beyond formatting, and any verb lacking a parity or registered outputSchema guarantee.

INV-17 then states the ratified layering and names the precondition:

> …the **INV-2 reframe (#1608: the CLI is a presentation client over the MCP contract, equivalence by construction)** and the **facade-codegen direction (system-design 05)**… the registered `outputSchema` must be **total over every emittable shape (baseline + capped + degraded)**, the precondition that makes facade equivalence hold by construction.

So the ratified layering is: **MCP contract is canonical (the wire); the dispatch core owns logic, database ops, and the economy measurement seam; the CLI is a derived presentation client.**

### 2.2 The CLI contract

| Element | Contract |
| --- | --- |
| Invocation | Process per command. No session, no daemon, no connection. |
| Identity | `featureId` as an ordinary argument. |
| State | SQLite event store; `resolveWorkflowState` is the only source of truth. |
| Flags | **Runtime-derived** from each action's Zod schema (`addFlagsFromSchema`), plus `cli.flags` alias/description overrides and `cli.examples` in the registry descriptor. Not build-time codegen — INV-17 calls full codegen a *direction*. |
| Output | The `ToolResult` / `Envelope<T>` envelope, JSON-serialized. |
| Exit codes | `CLI_EXIT_CODES` = `SUCCESS: 0`, `INVALID_INPUT: 1`, `HANDLER_ERROR: 2`, `UNCAUGHT_EXCEPTION: 3`. DR-7 maps `errorCode` → exit code as **presentation metadata**. |
| Long-running work | Registry metadata `longRunning: true` (9 actions) drives line-buffered heartbeats (DR-5). |
| Streaming | `--follow` over `VIEW_FOLLOW_ACTIONS` (5 view actions) → `runInspectFollow` → NDJSON `Frame`s. |

### 2.3 The loophole neither invariant closes

INV-2 quantifies parity over "**the same** DispatchContext **+ arguments**." Both halves of that quantifier carry divergence today.

**Context half.** `DispatchContext` carries three optional, facade-specific capability adapters, each with the same in-source disclaimer:

| Field | In-source doc |
| --- | --- |
| `rootsClient` | *"…Optional — CLI / direct-call contexts omit it and dispatch falls back to the cwd-walk branch."* |
| `elicitationClient` | *"…Optional — CLI / direct-call contexts omit it and dispatch falls back to the legacy INVALID_INPUT contract."* |
| `taskStore` | *"When wired, dispatch inspects… the SDK `task: { ttl? }` augmentation key… When absent, [the legacy one-shot envelope]."* |

**Arguments half.** The `task: { ttl }` augmentation key is an argument **only the MCP facade can send** — there is no `--task` flag, because `addFlagsFromSchema` derives flags from the action schema and `dispatch()` strips `task` before `.strict()` validation. A whole behavioural branch (`runTasksAugmented`) is reachable from one facade and not the other.

**The behavioural divergence lives in the context and the args, not in the adapters** — so INV-2's audit prompt, which inspects `adapters/cli.ts` and `adapters/mcp.ts`, structurally cannot see any of it. The invariant is honestly stated and correctly enforced; it just does not reach where the facades actually differ.

Every one of those divergences exists to expose an MCP capability the CLI cannot express: a server-initiated `roots/list`, a server-initiated `elicitation/create`, and an SDK task lifecycle bound to a live connection. **All are exactly what `2026-07-28` removes, deprecates, or restructures.**

---

## 3. The four critical migration components

These decide whether the migration lands on a contract that holds or one that merely appears to. Each is treated to the same template: **current state (verified) → what the spec changes → required work → verification gate → failure mode if skipped.**

They are ordered by dependency, not by size. **MC-3 gates MC-2; MC-2 gates MC-1.**

| | Component | Verdict | Blocks |
| --- | --- | --- | --- |
| **MC-1** | CLI layer code-generation | Incomplete — 14 hand-written commands | Equivalence-by-construction |
| **MC-2** | Event-sourced dispatch ↔ spec integration | Aligned in principle; one design decision open | MRTR |
| **MC-3** | `outputSchema` fullness | **Consistent but ~90% vacuous** | Every verification claim |
| **MC-4** | Dispatch ↔ spec ↔ CLI mapping | Mostly improves; one layering violation | Remote surface (v3.2) |

---

### MC-1 — CLI layer code-generation

> **Decision (2026-08-06): the CLI layer is to be fully code-generated. The current state is not acceptable.**

**Current state (verified).** The *action tree* is already derived: the registration loop walks the registry, `addFlagsFromSchema` emits flags from each action's Zod schema, and the descriptor carries `cli.flags` and `cli.examples`. Beside it sit:

- **1,565 lines** of `src/adapters/cli.ts`
- **14 hand-written `.command(...)` registrations**
- across **8 top-level verbs**: `doctor`, `emissions`, `init`, `install-skills`, `mcp`, `merge-orchestrate`, `onboard`, `version`

`merge-orchestrate` is the sharpest instance: it is a registered action (`merge_orchestrate` — the **only** action declaring `posture: 'shared-mutating'`) **and** a hand-written top-level command. One verb, two definitions, one of them outside the generated path and outside the parity guarantee. A trust-tier declaration that exists on only one of the two definitions is a security-relevant divergence, not merely a duplication.

**What the spec changes.** Nothing directly — but it adds pressure from two sides. MRTR introduces a fourth envelope state that must render on both facades (MC-2), and per-request capability resolution changes what the adapter may assume. Each new protocol concept authored by hand is a new place for equivalence-by-construction to lapse into equivalence-by-test.

**Required work**, in dependency order:

1. **A registry representation for top-level operational verbs.** A descriptor marking "this action also surfaces as a top-level CLI verb" lets the 8 hand-written commands generate instead of being authored. This is the bulk of the 1,565 lines. Resolve `merge_orchestrate`'s double definition first — it is the smallest case with the highest stakes.
2. **A reserved-flag concept in the generator.** `addFlagsFromSchema` skips exactly one field (`action`) and always adds `--json`; there is **no** reserved/excluded-flag mechanism. Protocol-level fields therefore have nowhere to live — which is why `task: { ttl }` is unreachable from the CLI today (§2.3).
3. **Presentation rules derived from the envelope discriminator** rather than adapter switches — the DR-7 `errorCode` → exit-code table, and the imminent `input_required` rendering.

**Verification gate.** A generated-surface guard analogous to `npm run skills:guard`: re-derive the CLI tree from the registry and fail CI on drift. That is the mechanism that turns "the CLI is a presentation client" from a stated intention into an enforced one, and the repo already has the pattern.

**Failure mode if skipped.** Every hand-written command is a verb outside the parity harness. The migration adds a fourth envelope state, so the hand-written surface becomes the place where the new contract is silently not implemented — and INV-2's audit prompt is looking at adapters for *logic*, not for *absence*.

**Second-order benefit.** Codegen is what makes MC-3 visible. Today a vacuous `outputSchema` is a weak assertion nothing checks. Once the CLI renderer is *generated from* the schema, `data: unknown` becomes a **build-time hole** — there is nothing to generate a typed renderer from. That is the same move INV-11 makes elsewhere: prefer unrepresentable over merely forbidden.

---

### MC-2 — Event-sourced dispatch ↔ spec integration

**Current state (verified).** The dispatch core owns logic, database operations, and the economy measurement seam (`dispatch.economy-seam.ts`, "the single origin of the un-capped tool payload," with a derivation proof). State lives in the SQLite event store; `resolveWorkflowState` is the only source of truth; the canonical existence check is `rehydrate`/`get` → `_meta.workflowExists`, never a filesystem or transport signal.

**What the spec changes.** The revision's central guidance is:

> …mint an explicit handle from a tool and have the model pass it back as an argument. We found this works better than session state hidden in the transport — the model can see the handle and thread it between tools.

That is a description of what Exarchos already does. `featureId` is the handle; the event store is the durable state behind it. **Exarchos is already conformant on the hardest part of the revision**, and there is no hidden session state to find because the design never had a place to put it.

The genuinely new concept is `requestState`: MRTR's resumption token, per-flow, signed (HMAC-SHA256, **not** encrypted — the client can base64url-decode it), TTL'd, and untrusted on return.

**Required work — one design decision, and it should go the Exarchos way.**

The spec's `requestState` exists because a stateless HTTP MCP server **has nowhere to put resumption state**. Exarchos has an event store, and the dispatch core owns it. The composition that preserves one core contract:

- **dispatch** mints a resumption handle backed by the event store (a pending-input event / stream position) and returns it inside the `input_required` envelope;
- the **MCP facade** wraps that handle in the SDK's signed `requestState` codec — wire integrity, as the spec requires, since the token round-trips through an untrusted client;
- the **CLI** passes the same handle back as an ordinary argument.

One core contract, two renderings. It also dissolves MC-1's reserved-flag problem for this case: a resumption handle that is *action state* is emittable by the existing generator, whereas a protocol-level signed blob would force a reserved-flag concept **and** hand the CLI wire-layer state it owns none of.

Do **not** collapse `requestState` into `featureId` — different lifetimes. Thread `featureId` *inside* the minted payload.

**Verification gate.** A round-trip test proving the same core handle drives resumption on both facades: MCP via the signed `requestState`, CLI via the plain argument, landing on identical envelopes. Note the SDK constraint that shapes the test: **`InMemoryTransport.createLinkedPair()` is 2025-era only**, so 2026-era coverage means driving `createMcpHandler` through its fetch function or spawning `serveStdio` as a child process.

**Failure mode if skipped.** Adopting the spec's token as primary creates a second persistence story for one flow — an opaque signed blob alongside a durable event stream — with no reconciliation between them, and a resumption path the event store cannot audit. For an event-sourced governance system, an un-auditable resumption is a hole in the record, not a convenience.

**Caveat.** The design is sound for workflow-scoped flows, where a stream position is the natural handle. A flow with no `featureId` — a cold `describe`, an onboarding prompt — has no stream to anchor to and may still need an opaque token. Scope that case explicitly rather than assuming it away.

---

### MC-3 — `outputSchema` fullness and consistency

**This is the load-bearing one. It gates every verification claim the other three make.**

**Current state (verified).** Consistency is total; substance is not.

*Presence: 100%, structurally enforced.* `readonly outputSchema: z.ZodType` is required at the interface boundary (not optional), and `validateAction` enforces presence at module load, so a malformed declaration fails the import (DIM-3 fail-closed). There is no action without one.

*Substance: ~10%.*

| Declared value | Count |
| --- | ---: |
| `EnvelopeSchema(z.unknown())` — **vacuous** | **106** |
| `withCappedShape(<Typed>OutputSchema)` — DR-10 worktree surface | 10 |
| `WorkflowTransitionOutputSchema` / `WorkflowUpdateOutputSchema` — HSM | 2 |
| **Total action declarations** | **118** |

*(Derivation: 120 `outputSchema:` occurrences in `registry.ts` minus 2 interface/validator declarations.)*

**106 of 118 (≈90%) declare `data: unknown`** — a schema that validates every payload and therefore constrains none. The registry's own JSDoc says so: *"most attach `EnvelopeSchema(z.unknown())`… Per-action data-shape tightening is incremental follow-up work (design §10, out of scope for Wave 0)."*

**What the spec changes.** MRTR adds `input_required` as a **fourth emittable shape** beside baseline, capped, and degraded. Separately, SEP-2106 makes output schemas unrestricted and lets `structuredContent` be any JSON value — so the ceiling on how precisely the envelope can be typed goes *up* exactly when the need does.

**Why the vacuity matters more than the count.** INV-17 names `outputSchema` totality as *the precondition that makes facade equivalence hold by construction*. A vacuous schema satisfies totality **trivially** — it is total over every shape because it is total over all shapes, including wrong ones. For 90% of actions the precondition is met on paper and guarantees nothing. INV-2's claim that "parity is schema-checked in addition to byte-checked" is, today, byte-checked plus a tautology for nine actions in ten.

Same defect class as the vacuous `withSession` gate (#1692): present, enforced, asserting nothing.

**Required work — and note the sequencing inverts what "totality" implies.**

- Adding `input_required` to the **12 typed** schemas is real, bounded work.
- Adding it to the **106 vacuous** ones is a **no-op**. Those schemas will absorb the fourth shape with no test failing. The migration will look cleanest exactly where the contract is weakest.
- Therefore the 106 must be **tightened, not merely amended** — tightening is the only thing that makes the fourth shape verifiable at all.

Tighten before MRTR lands. The reverse order banks a silent pass.

**Verification gate.** Two, and the second is the one that lasts:

1. A registry-enumeration snapshot asserting each action's `outputSchema` is non-vacuous — i.e. `EnvelopeSchema(z.unknown())` is a **finding**, not a pass. INV-17's audit should treat a vacuous declaration as a violation of the precondition it names.
2. A ratchet on the vacuous count so it can only fall — the repo already runs this pattern for type-debt.

**Failure mode if skipped.** Equivalence-by-construction is not merely unproven; it is *asserted* by a mechanism that cannot fail. That is worse than an absent gate, because it reads as coverage. Every downstream claim — MC-1's generated renderers, MC-2's round-trip parity, the migration's "no behavioural change" — inherits a guarantee that does not exist.

**A correction to the invariant's own framing.** INV-17's triple is baseline + capped + degraded. `withCappedShape` returns `EnvelopeSchema(z.union([baseData, CappedDataSchema]))` — baseline ∪ capped only. *Degraded* is not a data shape: it is a `_meta` marker (`economyDegraded`), structurally admitted by the envelope's `_meta: Record<string, unknown>`. Totality over degraded holds by envelope structure, not per-action declaration. Defensible — but the helper's name overstates its coverage, and the "triple" is really a pair plus a flag. Worth correcting in the catalog so the next reader does not over-trust it.

---

### MC-4 — Dispatch logic ↔ MCP spec ↔ CLI contract mapping

**Current state (verified).** 4 visible composite tools (+1 hidden) × 118 actions, dispatched on an `action` discriminator carried in the request body.

**The mapping, systematically:**

| Exarchos concept | MCP `2026-07-28` | Fit | Consequence |
| --- | --- | --- | --- |
| Composite tool + `action` discriminator | `tools/call` with `name` | **Improves** | SEP-2106 lifts input schemas to full JSON Schema 2020-12 with `oneOf`/`anyOf`/`allOf` and conditionals (root stays `type: "object"`). The discriminated union of action schemas becomes **natively expressible** — exactly what the local patch splices by hand today. The pattern goes from patched-in to first-class. |
| `Envelope<T>` | `structuredContent` + `outputSchema` | **Improves** | Output schemas unrestricted; `structuredContent` may be any JSON value, not only an object. Raises the ceiling for MC-3. |
| `next_actions` (HATEOAS) | no analogue | Neutral | Lives in the envelope → facade-neutral by construction. The precedent to follow for new metadata. |
| `annotations` (readOnly/destructive/idempotent/openWorld) | spec-defined, explicitly untrusted hints | Unchanged | Server-trusted `safety` stays separate from the untrusted hints. |
| `longRunning` (9 actions) | server-directed Tasks trigger | **Improves** | One registry declaration drives both facades; retires the client-opt-in `task: { ttl }` divergence (§2.3). |
| `economy` budget | no analogue | Neutral | In-envelope. Distinct axis from `ttlMs`/`cacheScope` — do not conflate (§4.5). |
| `posture` / capability tiers | per-request `_meta` client capabilities | **Improves precision** | Source changes from a connection-scoped handshake snapshot to the request's own envelope (§4.7). |
| Event-sourced state + `featureId` | "mint an explicit handle…" | **Already aligned** | MC-2. |
| `hidden: true` (1 tool) | excluded from `tools/list`; CLI-reachable | **Layering violation** | Below. |

**The one genuine misfit: `hidden: true`.** The registry declares it as *"excluded from MCP registration (not exposed to agents). **CLI access is preserved.**"* Under the #1608 reframe — the CLI is a presentation client over the MCP contract — a CLI-reachable tool absent from the MCP contract is the CLI presenting something the canonical contract does not contain. That is not a presentation difference; it is **surface the contract does not cover**, and it is declared in the registry rather than hidden in an adapter.

Two resolutions, both acceptable, one required: expose-and-annotate the tool (making it part of the contract, with annotations conveying that agents should not reach for it), or move it off the tool registry into a non-contract admin surface. Leaving it as-is means MC-1's codegen would faithfully generate a CLI verb with no contract behind it.

**Required work.** Resolve `hidden: true`; verify the composite discriminated union survives the patch removal natively under 2020-12 (companion doc §5.6); keep `longRunning` as the single task trigger and extend the parity harness to cover it, since it graduates from CLI presentation metadata to a shared behavioural declaration.

**Verification gate.** Registry-driven conformance: enumerate every action and assert each maps to exactly one spec concept, with no facade-exclusive surface. The `surface: 'worktree'` marker already exists precisely so "a registry-driven conformance harness [can] enumerate exactly the surface… by filter rather than a hardcoded name list" — the pattern is established.

**Failure mode if skipped.** A facade-exclusive tool is a permanent exception to the layering that every future generated surface must special-case.

**A routing note for v3.2.** `Mcp-Name` carries the *tool* name. With 118 verbs behind 4 tool names, every request presents as one of four values, so gateway routing, metering, and per-operation authorization cannot see the actual operation. Irrelevant on stdio; a real design input the moment a remote surface exists (companion doc §4). If the DKG / remote-agent work wants per-verb policy at the edge, the composite pattern is the thing that blocks it — worth deciding deliberately rather than discovering later.

---

## 4. Supporting analysis — pattern by pattern

Detail behind §3. Each item names the MC it feeds.

### 4.1 Stateless core + explicit handles → the CLI's model, adopted *(MC-2)*

Identity is an argument, state is in SQLite, the process is the request. The CLI has no session because it *cannot* have one; the spec now says that was the right shape. Composition is clean and mostly already done.

### 4.2 Tasks — two inversions, both toward the CLI *(MC-4)*

**Inversion 1: blocking → polling.** `tasks/result` is removed; `tasks/get` drives the lifecycle. Exarchos anticipated this pairing — from `src/adapters/cli.ts:239`:

> **Invariant (INV-2 — CLI `--follow` and MCP `tasks/get` polling produce byte-equivalent transitions):** every member MUST be backed by a pure `ViewProjection` fold — no `eventStore.append`, no `emit`, no `*.polled` events. Repeated polls must be a no-op against the EventStore so the polling cadence under `--follow` (and the MCP-side `tasks/get` retry path) doesn't mutate the timeline they are observing.

The facades were **already** paired on `tasks/get`-style polling, with an audited purity guarantee (5 view handlers verified as pure folds, plus a CI idempotency cross-check). The method the spec deletes — `tasks/result` — is precisely the one with no CLI analogue, because a CLI cannot block on a connection that does not exist.

One inherited wrinkle: `tasksGet` documents a side effect — *"emits a `task.polled` event… (handled inside the store's `getTask`)."* That is the exact write-on-poll the invariant above forbids for the view arm. Once polling is the *primary* lifecycle, it becomes write-amplification and timeline pollution. Re-base it on the pure-fold discipline; the justifying invariant text is already written.

**Inversion 2: client-opt-in → server-directed.** `longRunning` registry metadata already *is* the server-side decision, and it is already facade-neutral. See MC-4.

**Counter-current: `tasks/list` is removed** (unscopable without sessions). Exarchos's task store is event-sourced and scoped by stream/`featureId`, not by session, so the rationale does not bind us — but the right response is to express enumeration as an ordinary `exarchos_view` domain verb rather than a protocol method. A domain verb is facade-neutral by construction; a protocol method never was.

### 4.3 MRTR — the divergence-collapsing change *(MC-1, MC-2, MC-3)*

`elicitation/create` is structurally un-CLI-able: the server initiates a request to the client mid-call over a held-open channel. MRTR restructures it into **return `input_required` + `inputRequests` + `requestState`; caller re-invokes with `inputResponses`** — a return value and a re-invocation, which every facade has:

| Facade | `input_required` renders as | Re-invocation is |
| --- | --- | --- |
| MCP | `resultType: "input_required"` | the client's automatic retry |
| CLI (interactive) | a prompt on stdin | the same process, next loop iteration |
| CLI (scripted) | a distinct exit code + missing-field list + resumption handle | the operator's next command |
| Direct in-process | a discriminated return | the caller's next call |

So `elicitationClient` stops being a **context capability** and becomes a **result shape** — moving from a parity hole to exactly the presentation-only difference INV-2 sanctions.

Three load-bearing details:

1. **The SDK ships a legacy shim**, so an `inputRequired()` handler runs unchanged on 2025-era connections. The refactor is not gated on the era cutover — adopt it early.
2. **`inputResponses` are per round — replaced on every re-entry, never accumulated.** Multi-step flows thread prior answers through `requestState` as a discriminated union of phases and `switch` on the phase.
3. **`requestState` gives the scripted CLI resumability it does not have today.** A protocol change that *adds* CLI capability is a rare direction of travel.

### 4.4 `subscriptions/listen` vs. `--follow` *(MC-4)*

Both are caller-opened, opt-in streams with the same consent model. `tasksFollow` currently rides `notifications/tasks/status`, absent from the 2026 maps, so the MCP-side wire must re-base — but the shared carrier (`runInspectFollow` over the DR-1 subscription contract, byte-identical `Frame`s) is untouched. The INV-2 layering working as designed.

### 4.5 Cache hints — two layers, do not conflate *(MC-4)*

| | Exarchos `_cacheHints` | Spec `ttlMs` / `cacheScope` |
| --- | --- | --- |
| Layer | inside the response body | protocol-level, on list results |
| Answers | "where does the stable prefix end, so the **model's** prompt cache can split?" | "how long is this `tools/list` fresh, and is it shareable?" |
| Facade reach | **facade-neutral** (rides the envelope; CLI gets it free) | **MCP-only** (transport metadata) |

Complementary, not competing. The in-envelope design is *why* the CLI benefits for free — the precedent worth following when deciding where future metadata lives. `applyCacheHints` consults the `CapabilityResolver`, which becomes per-request under §4.7, so this path inherits that precision improvement too.

### 4.6 Extensions framework + `server/discover` *(MC-1, MC-4)*

`server/discover` is MUST-implement and carries its own `ttlMs`/`cacheScope`. Exarchos already has strong introspection (`describe`, `emissionGuide`, `topology`, `config`) and a registry that is the source of truth for action identity. **`server/discover` must be derived from the registry, never hand-maintained beside it** — the same discipline as `addFlagsFromSchema`, and the same drift risk `skills:guard` exists to prevent. This is MC-1's principle applied to a second generated surface.

The extensions framework also gives `experimental: { 'claude/channel': {} }` a proper reverse-DNS home, and gives the DKG / remote-agent work a sanctioned path for protocol-level vocabulary.

### 4.7 Per-request capability resolution *(MC-2, MC-4)*

`CapabilityResolver` is a mutable closure snapshotted once per handshake, constructed at context init (`index.ts:241`, `core/context.ts:67`). The CLI already builds a fresh one per process — its lifetime is *already* per-request, by having no choice. So "make the resolver request-scoped" is adopting the CLI's lifetime on the MCP side.

It also retires a bug class the code patched around: CodeRabbit MAJOR #1423 fixed cross-handshake roots-cache bleed by clearing the cache inside `snapshot()` — unnecessary when the resolver cannot outlive the request. Security review still applies: this backs `enforceReadonlyGate`, `enforceSharedMutatingGate`, and `mintCapabilitiesForKind`.

---

## 5. Net effect on the divergent surfaces

| Divergence | Today | Under `2026-07-28` | Net |
| --- | --- | --- | --- |
| `rootsClient` (context) | MCP-only server-initiated `roots/list` | Roots deprecated → tool params + config; `.exarchos.yml` + cwd-walk already facade-neutral | **Dies** |
| `elicitationClient` (context) | MCP-only server-initiated request | MRTR → `input_required` is a result shape (MC-2) | **Dies** — becomes presentation |
| `taskStore` (context) | MCP-only, client-opt-in | Server-directed from `longRunning` (MC-4) | **Survives; trigger becomes shared** |
| `task: { ttl }` (arguments) | MCP-only; no `--task` flag exists | Augmentation key retired | **Dies** |
| `hidden: true` (registry) | CLI-reachable, MCP-excluded | unchanged by the spec — **must be resolved deliberately** (MC-4) | **Requires a decision** |

> Four of five divergences resolve as a consequence of the migration. INV-2 can move from *"parity given the same context and arguments"* — where neither is ever the same — toward **parity, unqualified**. The fifth is ours to decide.

---

## 6. Where the changes land — the CLI is derived, so: not in the CLI

Given §2.1's ratified layering, work relocates out of the facades and into the core contract.

**The envelope gains a fourth state.** `input_required` is neither success nor failure; overloading `success: false` corrupts the DR-7 mapping and every `Envelope<T>` consumer. It must be designed once, at the envelope level, and — per MC-3 — landed in the 12 typed schemas while the 106 vacuous ones are tightened rather than nominally amended.

**Exit codes stay presentation, with an ordering dependency.** DR-7 already declares the `errorCode` → exit-code table presentation metadata. `CLI_EXIT_CODES` (0–3) has no slot for "needs input," so add one — but it is derivable **only after** the core envelope carries the state. Adding it CLI-side first, by special-casing in the adapter, is precisely the violation INV-2's audit prompt hunts for.

**The flag generator needs a reserved-flag concept** (MC-1), unless MC-2's core-minted handle removes the need for this case — which it does, and is one reason to prefer that design.

**Two items genuinely are CLI-shaped:** `--follow`/`tasks/get` convergence (§4.2), and the interactive-vs-scripted distinction MRTR introduces (§4.3) — the one place the CLI grows genuinely new surface rather than re-deriving it.

---

## 7. Risks

| # | Risk |
| --- | --- |
| **R-A** | **Vacuous-schema false confidence (MC-3).** 106 of 118 `outputSchema` declarations assert nothing, while INV-17 names them as the precondition for equivalence-by-construction. A gate that cannot fail reads as coverage. **The highest-severity item in this document.** |
| **R-B** | **`resultType` vs. `success` conflation.** `input_required` is neither. Design once, at the envelope level, before any MRTR code — it is the decision most expensive to revisit. |
| **R-C** | **`requestState` is untrusted input crossing a trust boundary.** Signed, **not encrypted**. Use `createRequestStateCodec`; bind to principal + originating method + expiry; never hand-roll; never put anything confidential in it. |
| **R-D** | **`task.polled` write-on-poll** contradicts the `VIEW_FOLLOW_ACTIONS` purity invariant and becomes write-amplification once polling is the primary lifecycle. |
| **R-E** | **Hand-written CLI commands are outside the parity harness (MC-1).** The migration adds a state they will silently not implement. |
| **R-F** | **Dual-era divergence is a third facade.** During the `serveStdio` dual-era window: CLI, MCP-2025, MCP-2026. Keep it short and deliberate — the repo just finished a test de-divergence wave (#1705). |
| **R-G** | **`server/discover` as a second source of truth** if authored beside the registry rather than derived from it. |
| **R-H** | **INV-2's audit prompt cannot see context- or argument-carried divergence.** Even after §5 resolves, tighten the invariant so the next capability adapter does not reopen the hole silently. |

---

## 8. Recommendations

**Gates — sequence these first, in order.**

1. **Tighten the 106 vacuous `outputSchema` declarations (MC-3), before MRTR lands.** Make `EnvelopeSchema(z.unknown())` a finding rather than a pass, and ratchet the count downward. Everything else's verification rests on this. *(R-A)*
2. **Design the `input_required` envelope state once, at the envelope level (MC-2/MC-3).** A fourth emittable shape touching `Envelope<T>`, the DR-7 table, the parity harness, and the 12 typed schemas. *(R-B)*
3. **Mint the MRTR resumption handle in the dispatch core, from the event store (MC-2)**; let the MCP facade wrap it in the SDK's signed `requestState`. One core contract, two renderings; no generator change needed. *(R-C)*
4. **Complete CLI code-generation (MC-1)** — registry descriptors for the 8 top-level verbs, a reserved-flag concept, presentation derived from the envelope discriminator. Start with `merge_orchestrate`'s double definition. Add a `skills:guard`-style drift gate. *(R-E)*

**Structural — do alongside.**

5. **Tighten INV-2** to quantify over the *facade*, not the context and arguments: *"any behavioural difference between facades must be expressible as a difference in the rendered presentation of one shared `ToolResult`; capability adapters on `DispatchContext` and facade-exclusive arguments that gate behaviour are INV-2 violations, not exemptions."* §5 is what makes this newly achievable. Author it through `/exarchos:invariants`. *(R-H)*
6. **Correct INV-17's totality triple** — `withCappedShape` covers baseline ∪ capped; degraded is a `_meta` flag (MC-3).
7. **Resolve `hidden: true` (MC-4)** — expose-and-annotate, or move off the tool registry.
8. **Make `longRunning` the single task trigger** for both facades and extend the parity harness to cover it (MC-4).

**Opportunistic — independently valuable.**

9. **Adopt MRTR early** — the legacy shim means it works on today's wire (§4.3).
10. **Drop the `task.polled` write from `tasks/get`** (R-D).
11. **Derive `server/discover` from the registry** (R-G).
12. **Exploit 2020-12 for the composite pattern** — the action discriminated union becomes natively expressible rather than patch-spliced; verify as part of patch removal (MC-4).
13. **Keep `_cacheHints` and `ttlMs`/`cacheScope` separate** (§4.5).

---

## 9. Open questions

1. **Does the interactive CLI get a stdin prompt loop for `input_required`, or is scripted handle-passing the only mode?** Affects whether the CLI grows an interactive surface it has so far avoided.
2. **Does the event-store-backed resumption handle hold for every MRTR flow?** Sound for workflow-scoped flows; a flow with no `featureId` (cold `describe`, onboarding) has no stream to anchor to.
3. **Should the removed `tasks/list` return as an `exarchos_view` domain verb?** §4.2 argues yes on INV-2 grounds.
4. **Does `longRunning` alone carry enough signal for server-directed task creation**, or does it need a per-action threshold/TTL now that it is behavioural rather than presentational?
5. **Does the composite tool pattern survive a remote surface?** `Mcp-Name` exposes 4 names for 118 verbs (MC-4). If v3.2 wants per-verb edge policy, this is the blocker.
6. **How far should `outputSchema` tightening go** — full per-action data shapes, or a tiered target (typed for the DR-10 + HSM surfaces, structured-but-loose elsewhere)? MC-3 argues the current 90% floor is untenable; the ceiling is a scope call.

---

## 10. Sources

**Specification / SDK** — full list in the companion doc §10. Load-bearing here: the [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), the [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/) (explicit-handle guidance, server-directed tasks), the [release candidate post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) (SEP-2260 consent model, SEP-2106 JSON Schema 2020-12, `tasks/list` removal rationale), and [Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html) (`requestState`, `inputRequired`, legacy shim, `subscriptions/listen`, cache-hint defaults, `InMemoryTransport` era limitation).

**Repository** (inspected at `main` @ `30831d05f`)
- `.exarchos/invariants.md` — INV-2 (lines 400–438); **INV-17** (lines ~784–806): the #1608 reframe, the facade-codegen direction, the `outputSchema`-totality precondition
- `src/registry.ts` — `ToolAction` descriptor (`outputSchema` required, `longRunning`, `posture`, `cli`, `dispatch`, `economy`, `surface`); `withCappedShape` (line 1238); `validateAction`; `hidden: true` (line 3987); the 118/106/10/2 outputSchema census
- `src/core/dispatch.ts` — `dispatch()`; `DispatchContext` (the three optional capability adapters); the `task` strip-before-validate path
- `src/core/dispatch.economy-seam.ts` — the single origin of the un-capped payload
- `src/adapters/cli.ts` — 1,565 lines; 14 `.command(...)` registrations; `CLI_EXIT_CODES`; DR-7 mapping; `VIEW_FOLLOW_ACTIONS` + the INV-2 purity comment (line 239); DR-5 `longRunning` heartbeats; stdio wiring (579–585)
- `src/adapters/schema-to-flags.ts` — `addFlagsFromSchema` (no reserved-flag mechanism)
- `src/format.ts` — `ToolResult` / `Envelope<T>`; `CacheHints`; `applyCacheHints`; `ECONOMY_META_DEGRADED`
- `src/mcp/tasks-methods.ts` — `tasksGet` `task.polled` side effect; `tasksFollow` DR-4 arm
- `src/dispatch/tasks-augmented.ts` — the `task: { ttl }` client-opt-in augmentation
- `src/capabilities/resolver.ts` — handshake-authoritative resolution; POLA gates; `ANTHROPIC_NATIVE_CACHING`
