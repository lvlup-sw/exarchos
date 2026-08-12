# Discovery: idiomatic rehydration of workflow machinery, not just narrative state

**Workflow:** `rehydrate-machinery-reinit` (discovery)
**Date:** 2026-05-08
**Originating incident:** [`docs/rca/2026-05-08-rehydrate-behavioral-gap.md`](../rca/2026-05-08-rehydrate-behavioral-gap.md)
**Audited against:** [`docs/architecture/runtime.md`](../architecture/runtime.md), `/design-invariants` (INV-1..INV-5d), `/axiom:backend-quality` (DIM-1..DIM-8)

## 1. Question

`/exarchos:rehydrate` re-injects prior workflow *state* (phase, tasks, artifacts, last handoff) but does not re-inject the *machinery* — the agent receives no imperative to keep dispatching through `/exarchos:delegate`, emitting `task.completed`, calling `exarchos_workflow.transition`. Manual editing becomes the path of least resistance and the workflow tracker silently drifts from git ground truth.

The RCA proposed a three-layer patch (projection default + handler backfill + command House Rules block). This discovery asks the wider question: **what is the most idiomatic shape for the fix given Exarchos's runtime architecture and load-bearing invariants?** — so that the patch we land aligns with the architecture rather than papering over the symptom in three places.

## 2. Reframing the problem — separating *execution truth* from *contract truth*

The RCA frames the defect as "the projection ships empty `behavioralGuidance`." The deeper observation is that **behavioral guidance is not event-derived state in the first place.**

| Quantity | Source of truth | Update cadence | Layer (per [runtime.md §3](../architecture/runtime.md#3-layered-architecture)) |
|---|---|---|---|
| Phase | `workflow.transition` events | Per event | L2 (event store) → L3 (rehydration projection) |
| Tasks | `task.assigned` / `task.completed` / `state.patched.tasks` | Per event | L2 → L3 |
| Artifacts | `state.patched.artifacts` | Per event | L2 → L3 |
| **Phase machinery** (skill, tools, events to emit, transition criteria, validation scripts, compactGuidance) | **`workflow/playbooks.ts` registry, keyed by `(workflowType, phase)`** | **Static; checked into the repo; never event-derived** | **L4 (workflow primitives — `PhasePlaybook` registry)** |

The `behavioralGuidance` field on `RehydrationDocument` is a 2-key string struct (`skill`, `skillRef`) seeded empty and only mutated by an explicit guidance event no production flow emits. It is a vestigial hole the projection cannot fill — because the data the agent actually needs (the full `PhasePlaybook`) is structurally not in the event stream and never should be.

The playbook registry is *already* the canonical contract surface: `workflow/playbooks.ts` exports a complete `PhasePlaybook` per `(workflowType, phase)` with `tools`, `events`, `autoEmittedEvents`, `transitionCriteria`, `guardPrerequisites`, `validationScripts`, and `compactGuidance`. It is consumed by `exarchos_workflow describe playbook=feature:delegate` (the L6 `describe` action), by `verbs/gates/check-event-emissions.ts` (`PHASE_EXPECTED_EVENTS` derives from the same SoT), and by the playbook renderer. It is *not* consumed by `handleRehydrate` (the L5 dispatch handler that produces the rehydration envelope).

So the question is not "how do we fill the empty field" — it is **"why does rehydrate fail to compose the canonical contract surface that already exists at the same architectural layer?"**

### 2.1 Terminology guard — `phasePlaybook`, not `phaseContract`

Note that [runtime.md §3 L4](../architecture/runtime.md#3-layered-architecture) already uses *"Phase contract loader"* for the staleness/topology loader (`Topology.phases[name].staleness = { expectedMaxDwellMinutes, signals[], freshnessRequires }` from `topology.yaml`). To avoid terminology collision, this report uses **`phasePlaybook`** — matching the existing internal `PhasePlaybook` type and the `getPlaybook(workflowType, phase)` lookup. Reserve `phaseContract` for the staleness loader the runtime doc already named.

## 3. Option space

Nine candidate shapes, grouped by where the fix lands.

| ID | Shape | Locus (per L1-L9) | Sketch |
|---|---|---|---|
| A | Render-only | adapter / slash-command renderer (above L8) | Slash command renders House Rules / `_eventHints.missing` always; envelope unchanged. |
| B | Reducer-time phase defaults | L3 (projection reducer) | Reducer writes phase-default guidance into `behavioralGuidance` on `workflow.transition`. |
| C | Handler-time playbook composition | L5 (dispatch core, `workflow/rehydrate.ts`) | After fold, handler calls `getPlaybook(workflowType, phase)` and writes structured contract into the document. Reducer untouched. |
| D | Schema reshape — `phasePlaybook` replaces `behavioralGuidance` | L3 schema + L5 handler + L3 reducer | Drop the vestigial field; add a structured `phasePlaybook` populated at handler-time from the playbook registry. |
| E | Layered: handler-time enrichment **plus** command House Rules **plus** `_eventHints.missing` always-on | C + A | What the RCA calls the "three-layer fix," reframed: contract on the L6 envelope, House Rules on the renderer for redundancy. |
| F | Post-rehydrate `session.started` / `agent.action` event | L2 schema + L5 handler | Emit on first model action after rehydrate so external telemetry detects "rehydrated but no work events." Pairs with v2.12 lifecycle verbs at L7. |
| G | Wrap-time discipline reminder | `format.ts` `wrap()` or `envelopeWrapWithCacheHints` (L6 boundary) | Inject a reminder string into `_meta` for verb=rehydrate. |
| H | `phasePlaybook` as a **live projection** — derived at query time, never snapshotted | L5 handler + L6 envelope | Compute playbook lookup at envelope-wrap time; no schema persistence; no snapshot bloat. |
| I | Aspire-style: rehydrate composes describe | L5 handler | Internally call `handleDescribe({ playbook: \`${type}:${phase}\` })` and bundle its output into the rehydration envelope. |

A and G are render-only band-aids. B couples the L3 projection to the L4 playbook registry. F is observability, not a fix. H is the canonical CQRS live-projection idiom (Kurrent, Marten — see §6). I is a refinement of C using the existing L6 describe primitive as the data source.

## 4. Invariant scorecard

Severity reflects the worst-case finding the option carries — not its overall worth.

| Option | INV-1 (event-sourcing) | INV-2 (facade equivalence) | INV-5b (output contract) | INV-5c (Aspire verbs) | INV-5d (action discriminator) | Axiom dimensions |
|---|---|---|---|---|---|---|
| **A** Render-only | clean | **HIGH:** CLI renderer carries behavior MCP envelope lacks; structured contract leaks into per-runtime templates (violates [INV-2 acceptance question 2](../../.claude/skills/design-invariants/references/INV-2-facade-equivalence.md)) | **HIGH:** envelope omits the contract; slash command becomes a second source of truth (violates INV-5b acceptance question 6 — no presentation in envelope) | clean | clean | DIM-1 (state in renderer), DIM-3 (carrier-shape drift between adapters) |
| **B** Reducer-time defaults | **MEDIUM:** L3 reducer's `apply` reads L4 static config (playbook registry) — pure if registry is read-only, but couples the fold to a non-event input (cf. [INV-1 acceptance question 4](../../.claude/skills/design-invariants/references/INV-1-event-sourcing.md): *"Can the output be reconstructed from events alone?"*) | clean | acceptable | clean | clean | DIM-6 (reducer↔playbook coupling); DIM-3 if registry shape changes |
| **C** Handler enrichment | clean — playbook is L4 static SoT, not a second mutable store | clean — handler is in L5 dispatch core, both adapters benefit | clean — structured data lands in L6 envelope | clean | clean | DIM-1 clean; DIM-5 helps (vestigial field gets a real backing) |
| **D** Schema reshape (rename to `phasePlaybook`) | clean | clean | clean — contract field becomes first-class with `outputSchema` post-#1287 | clean | clean | DIM-3 needs a `v: 3` envelope bump or additive co-existence; DIM-5 wins (drops vestigial `behavioralGuidance`) |
| **E** Layered (C + A + always-on hints) | clean | clean — both the L6 envelope (canonical) and the renderer (redundancy) carry the contract; renderer becomes purely presentational | clean | clean | clean | Same as C; DIM-2 wins (multiple independent surfaces show the contract — degraded read still recovers) |
| **F** `session.started` event | clean — adds a registered event type at L2 | clean | doesn't address the gap | clean | clean | DIM-2 wins (telemetry); but doesn't fix the user-facing RCA |
| **G** Wrap-time `_meta.reminder` | clean | clean | **MEDIUM:** stuffs prose into `_meta` rather than typed contract field | clean | clean | DIM-3 (untyped prose in `_meta`); DIM-5 (band-aid) |
| **H** Live projection (no schema persistence) | clean — strongest INV-1 alignment (no derived state in the L3 projection) | clean | clean | clean | clean | DIM-5 cleanest; potential DIM-7 on degraded paths if the playbook lookup throws (mitigated by null-on-missing) |
| **I** Compose describe | clean | clean — uses the describe verb already present at L6 on `exarchos_workflow` | clean | **strongest** — leverages the Aspire-style `describe` primitive directly | clean (composition, not new top-level) | DIM-6 wins (single composition, two consumers: rehydrate + describe) |

### What the scorecard says

- **A and G** trade INV-2 / INV-5b violations for low implementation effort. They land the contract *in the wrong layer* (above L8 / `_meta` prose). Reject as primary fixes.
- **B** is internally consistent but couples the L3 reducer to the L4 playbook registry. The reducer would no longer be a pure fold over events; replaying would depend on whichever playbook ships in the build. Reject — INV-1 prefers derivations at read-time, not fold-time.
- **C, D, H, I** all land the contract at the L5 handler boundary with the L4 playbook registry as SoT. They differ only in where the field lives on the schema and how the lookup is sourced.
- **F** is complementary observability, not a fix. Park it as a follow-up to coordinate with L7 lifecycle verbs (v2.12 `ps`, `wait`).
- **E** is the layered combination the RCA proposes; the contribution of this discovery is to argue that the *primary* layer is the L5 handler (C/D/H/I) and the renderer (A) is a secondary defense, not a co-equal fix.

### Internal ranking among C, D, H, I

| Criterion | C (enrich existing field) | D (rename to `phasePlaybook`) | H (live projection) | I (compose describe) |
|---|---|---|---|---|
| Schema churn | low | medium (envelope `v: 3` bump) | low (no schema persistence) | low |
| INV-1 strength | strong | strong | strongest (no derived state in L3 projection) | strong |
| Reuse of existing primitives | good (`getPlaybook`) | good | good | strongest (`handleDescribe` at L6) |
| Snapshot/cache cost | playbook-text shipped on every snapshot read | same | zero — derived per-call, never snapshotted | zero — describe is composed at envelope-wrap time |
| Compatibility | additive | breaking (rename) | additive | additive |
| Maps to canonical CQRS pattern | "decorated read model" | same | **"live projection"** (Kurrent / Marten — see §6) | "live projection composing describe verb" |

**H and I dominate.** I is one step more idiomatic because it formally treats rehydrate as a *composition* of two L6 control-plane verbs (`describe` + `rehydrate`), which is exactly the Aspire pattern INV-5c codifies — agents observe the system through queryable verbs, and one envelope can carry the composed observation.

## 5. Recommendation

Land **Option I + Option H + Option E** as a single layered fix:

- **L5 handler** computes the playbook as a *live projection* — derived per call from the L4 registry, never persisted (Option H idiom).
- The lookup is sourced via the same path `exarchos_workflow describe playbook=…` already exposes (Option I composition).
- **Adapter / slash-command renderer** carries a redundant House Rules block keyed off the same envelope payload (Option E layering).

### 5.1 Server: `handleRehydrate` composes a live `phasePlaybook` projection

After the fold, before envelope return, look up the playbook for `(workflowType, phase)` via the same path `exarchos_workflow describe playbook=…` already exposes. Bundle the structured playbook as `document.phasePlaybook`. Leave the existing `behavioralGuidance` field in place (additive; never written by anything in production today, so deprecation can come later) — its presence is now subordinate to `phasePlaybook`.

```ts
// servers/exarchos-mcp/src/workflow/rehydrate.ts — sketch
import { getPlaybook, serializePlaybooks } from './playbooks.js';

// after fold completes, before workflow.rehydrated emission:
const playbook = getPlaybook(document.workflowState.workflowType, document.workflowState.phase);
const phasePlaybook = playbook
  ? {
      skill: playbook.skill,
      skillRef: playbook.skillRef,
      tools: playbook.tools,
      events: playbook.events,
      autoEmittedEvents: playbook.autoEmittedEvents ?? [],
      transitionCriteria: playbook.transitionCriteria,
      guardPrerequisites: playbook.guardPrerequisites,
      validationScripts: playbook.validationScripts,
      humanCheckpoint: playbook.humanCheckpoint,
      compactGuidance: playbook.compactGuidance,
    }
  : null;

return { success: true, data: { ...document, phasePlaybook } };
```

The lookup is pure, static, and synchronous; degrades to `null` when no playbook is registered for the pair (e.g., terminal phases or unknown types). The handler's existing degraded paths (`buildDegradedResponse`) are unaffected — `phasePlaybook` is added only to the success branch.

This pattern matches the canonical **live projection** idiom from event-sourced read-model literature: the projection is "rebuilt live from the event stream each time a query arrives" (Kurrent), is "on-demand and not persisted... essentially ad hoc computations" (Marten), and is appropriate for "experience-specific compositions" that combine event-derived state with static config (NILUS read-model layering — see §6).

### 5.2 Schema: additive `phasePlaybook` field

```ts
// servers/exarchos-mcp/src/projections/rehydration/schema.ts — sketch
export const PhasePlaybookSchema = z.object({
  skill: z.string(),
  skillRef: z.string(),
  tools: z.array(z.object({ tool: z.string(), action: z.string(), purpose: z.string() })),
  events: z.array(z.object({ type: z.string(), when: z.string(), fields: z.array(z.string()).optional() })),
  autoEmittedEvents: z.array(/* … */),
  transitionCriteria: z.string(),
  guardPrerequisites: z.string(),
  validationScripts: z.array(z.string()),
  humanCheckpoint: z.boolean(),
  compactGuidance: z.string(),
}).nullable();

// added to VolatileSectionsSchema as an optional field — does NOT bump v: 2 → v: 3
// because every existing v:2 reader should ignore unknown keys (verify the .strict()
// boundary first; if .strict() rejects, add to the schema with a default of null).
```

**Strict-boundary note:** `VolatileSectionsSchema` is `.strict()`. Adding `phasePlaybook` requires either (a) declaring it on the schema with a `.default(null)`, or (b) bumping to `v: 3` per [INV-5b](../../.claude/skills/design-invariants/references/INV-5b-output-contract.md) acceptance question 5. (a) is the additive path; (b) is the spec-aligned path post-#1287.

**Spec-alignment note (INV-5b post-#1287):** the [MCP 2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) makes `outputSchema` + `structuredContent` first-class. Once #1287 lands, `phasePlaybook` should be registered on the rehydrate action's `outputSchema` so that *clients SHOULD validate structured results against this schema* (per spec). Pre-#1287 it rides as a structured field on `data` like the rest of `RehydrationDocument`.

### 5.3 Reducer: leave alone (canonical "live projection" pattern)

The L3 reducer is *not* modified. `phasePlaybook` is derived at the L5 handler boundary, not folded. This preserves INV-1's "events are SoT" at maximum strength: no projection field stores playbook-derived data; the snapshot stays small; replay is unaffected; rebuild is cheap. From [EventSourcingDB best practices](https://docs.eventsourcingdb.io/best-practices/designing-read-models/): *"It is tempting to treat read models as the authoritative view of system state — especially when they are fast, easy to query, and often up to date. But in event-sourced systems, the only source of truth is the event log. Read models are derivations, and they may be incomplete, stale, or incorrect at any given moment."* The phasePlaybook is a derivation — combining event-derived phase with static config — and is correctly *not* in the projection.

If a future requirement adds *workflow-specific overrides* on top of phase defaults, those overrides can be event-derived (a `workflow.guidance_overridden` event → reducer field → handler precedence: explicit override > phase default > null). Until that requirement appears, do not invent the event type. (Cf. [Azure event-sourcing intent guidance](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing#problems-and-considerations): *"Design events to capture the business intent behind each change"* — a fictional `behavioralGuidance.set` event would be intent-free.)

### 5.4 Renderer: `commands/rehydrate.md` House Rules block

Replace the silent-on-empty template. Render `phasePlaybook` first, `_eventHints.missing` always (even when empty, render `(none)` to make the absence load-bearing), and a discipline reminder trailer.

```markdown
## Workflow Rehydrated: <featureId>
**Phase:** <phase> | **Type:** <workflowType>

### House Rules (apply every action this turn forward)
**Skill:** <phasePlaybook.skillRef or "(no playbook for this phase)">
**Tools:** <phasePlaybook.tools rendered as bullets>
**Required model-emitted events:** <phasePlaybook.events rendered as bullets>
**Auto-emitted events (runtime fires these):** <phasePlaybook.autoEmittedEvents>
**Transition:** <phasePlaybook.transitionCriteria> | Guard: <phasePlaybook.guardPrerequisites>
**Validation scripts:** <phasePlaybook.validationScripts joined>

### Event Emission Hints
<_eventHints.missing rendered as bullets, or "(none — phase machinery satisfied)">

<!-- existing Task Progress, Artifacts, Next Action sections preserved -->

> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or `/exarchos:delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md`).
```

### 5.5 Tests

| Layer | Test |
|---|---|
| L3 reducer | unchanged — no new behavior |
| L5 handler | `rehydrate.test.ts`: happy-path delegate-phase rehydrate carries `phasePlaybook.skill = "delegation"` and `phasePlaybook.events` non-empty; unknown-phase rehydrate carries `phasePlaybook = null` |
| L5 handler | regression: degraded paths (`reducer-throw`, `snapshot-corrupt`, `event-stream-unavailable`) still return; `phasePlaybook` may be null on the degraded fallback document |
| L3 schema | `schema.test.ts`: `RehydrationDocumentSchema.parse({ ...v2 doc, phasePlaybook: { ... } })` succeeds; `phasePlaybook: null` succeeds; absence does not throw if optional |
| L8 adapter | `commands-rehydrate-validation.test.ts`: rendered output for delegate phase contains `### House Rules`, `task.progressed`, `exarchos_event` (verbatim), and the discipline-reminder sentence |
| L5/L8 parity | `workflow/parity.test.ts` (per [INV-2](../../.claude/skills/design-invariants/references/INV-2-facade-equivalence.md)): CLI and MCP carriers produce byte-equivalent envelopes for the same rehydrate args |

### 5.6 Follow-ups (not in this fix)

- **Option F (`session.started` event)** — register the type in `event-store/schemas.ts` (L2), emit on first orchestrate action after a rehydrate, fold into a "session liveness" projection (L3). Lets external telemetry flag "rehydrated but no work events" without inferring from `task.*` arrivals. Coordinate with L7 lifecycle verbs (v2.12 `ps`, `wait`) — both consume `<surface>.executing_started` patterns. File as a separate issue.
- **Sibling slash commands** — RCA's sibling-skill issue notes `/exarchos:checkpoint` and `/exarchos:reload` likely render the same empty-section pattern. Audit after this lands.
- **Post-#1287 `outputSchema`** — once the milestone-16 alignment lands the registered output schemas, register `phasePlaybook` on the rehydrate action's `outputSchema` so MCP clients validate the structure natively (INV-5b acceptance question 7; [MCP spec §Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).

## 6. Grounding in runtime architecture

### 6.1 Layer mapping

The recommendation lands cleanly across layers without crossing them, per [runtime.md §3](../architecture/runtime.md#3-layered-architecture):

```
   L9  Cooperative Agents          ← read House Rules from envelope; consume next_actions
   L8  Adapters / slash command    ← render House Rules block from envelope.phasePlaybook (NO new behavior)
   L7  Lifecycle verbs             ← (Option F follow-up: session.started feeds into ps/wait)
   L6  Composite tools             ← envelope carries phasePlaybook field; outputSchema validates it post-#1287
   L5  Dispatch core               ← handleRehydrate composes phasePlaybook live from getPlaybook()
   L4  Workflow primitives         ← PhasePlaybook registry (already SoT; UNCHANGED)
   L3  Projections                 ← rehydrationReducer UNCHANGED (preserves event-fold purity)
   L2  Event store                 ← UNCHANGED (no new event types in primary fix)
   L1  Storage                     ← UNCHANGED
```

The fix is monotonic across layers: L4 stays SoT, L5 composes, L6 surfaces, L8 renders. No layer mutates state on behalf of another.

### 6.2 Runtime guarantee alignment

Per [runtime.md §2](../architecture/runtime.md#2-runtime-guarantees):

- **RT-1 (event log is SoT):** preserved — phasePlaybook does not become event-derived, and the existing `behavioralGuidance` (vestigial, never event-populated) is documented as such rather than backfilled with synthetic events.
- **RT-2..RT-6 (storage-layer guarantees):** untouched — no append-path changes.

### 6.3 The strongest justification — runtime.md §7

[Runtime.md §7](../architecture/runtime.md#7-agent-cooperation-model) states the principle directly:

> *"`merge_orchestrate` is auto-dispatched in `merge-pending` because the projection surfaces the verb; remove the verb from `next_actions` and the merge stops auto-firing. **This makes autonomy a property of state + topology, not a hidden side effect of any handler.**"*

The behavioral-discipline gap is the same problem in another phase. After rehydrate, orchestration discipline should be a property of *state + topology surfaced via structured envelope fields*, not a property of the slash-command renderer adding text or the human user remembering to act on it. Option H+I+E satisfies this principle: the L4 topology (`PhasePlaybook` registry) feeds the L5 handler, which surfaces the contract on the L6 envelope, which the L8 adapter renders and the L9 agent consumes — a clean state+topology pipeline with no "hidden side effect" rung.

The render-only fix (Option A) inverts this. It places autonomy back into the renderer's prose — exactly the "hidden side effect" §7 warns against.

### 6.4 The minimal-description framing

[Runtime.md §11](../architecture/runtime.md#11-the-minimal-description) compresses the architecture as:

> *"Exarchos is a single SQLite database with a typed dispatch core in front of it. Events are the authority; projections are caches over events; workflow state is one such projection. ... Cooperation is by construction — postures make unsafe actions unrepresentable; handshake-declared capabilities prevent privilege escalation; namespaced streams keep sub-agents from interfering."*

"Cooperation by construction" is the load-bearing phrase. The behavioral-discipline gap exists because cooperation-after-rehydrate is currently *not* by construction — it depends on the renderer and the human noticing. The recommendation moves that cooperation back into the construction tier: the envelope carries the structured contract by default; agents that consume `next_actions` and `phasePlaybook` get the discipline reflexively; the renderer becomes a redundant defense, not the load-bearing surface.

## 7. External grounding

### 7.1 The recommendation is the canonical CQRS "live projection" pattern

The recommendation is not novel — it is the standard CQRS read-model idiom for compositions that combine event-derived state with static configuration.

- **[Azure Architecture Center, Event Sourcing pattern](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing)** (Microsoft Learn): *"Applications derive the current state of an entity by replaying all the events in its stream. This process is known as **rehydration**. It can occur on demand when the application handles a request."* The term *rehydration* is the canonical CQRS term for derivation-on-demand; Exarchos's `/exarchos:rehydrate` is therefore well-named and the fix should preserve the on-demand-derivation property at all layers, not just for event-derived fields.
- **[Azure CQRS pattern, "Combine the Event Sourcing and CQRS patterns"](https://learn.microsoft.com/azure/architecture/patterns/cqrs#combine-the-event-sourcing-and-cqrs-patterns)** (Microsoft Learn): *"The read model can use its own data schema that's optimized for queries... The read data store can be a read-only replica of the write store or have a different structure."* The phasePlaybook field is a read-side optimization — it does not need to mirror an event projection.
- **[EventSourcingDB, Designing Read Models](https://docs.eventsourcingdb.io/best-practices/designing-read-models/)**: *"It is tempting to treat read models as the authoritative view of system state... But in event-sourced systems, the only source of truth is the event log. Read models are derivations, and they may be incomplete, stale, or incorrect at any given moment. ... Never update read models directly."* The current `behavioralGuidance` field is exactly the "read model treated as authoritative" anti-pattern at small scale — it is an empty read-model field with no event contract behind it. Drop the pretense; derive instead.
- **[Kurrent (EventStoreDB), Live projections for read models with Event Sourcing and CQRS](http://www.kurrent.io/blog/live-projections-for-read-models-with-event-sourcing-and-cqrs)** (Anton Stöckl, 2021): *"We just need to define a structure for the read model, a view, and rebuild it live from the event stream each time a query arrives. ... You'll never have to explain why eventual consistency is not a problem because your read model is immediately consistent."* This is the precise pattern Option H names. *"I think it's a good idea to start with the live projection strategy that I described and then, if necessary, switch to the full-blown implementation with a separate service for the read model."* — exactly the right starting posture for `phasePlaybook`.
- **[Marten Projections (Part 4 of the tutorials)](https://martendb.io/tutorials/read-model-projections)**: *"Live projections are on-demand and not persisted... essentially ad hoc computations and do not maintain state beyond the immediate query."* Marten's `AggregateStreamAsync` and live aggregation API are the operational equivalent of `handleRehydrate` calling `getPlaybook(...)` synchronously per request.
- **[NILUS, CQRS Read Model Explosion in Event-Driven Systems](https://www.nilus.be/blog/cqrs_read_model_explosion_in_event-driven_systems/)** (2025-06): *"In many enterprises, the healthiest pattern is to separate **foundational domain projections** from **experience-specific compositions**."* `rehydrationReducer` is a foundational domain projection (folds events to derive workflow state); `phasePlaybook` is an experience-specific composition (combines that projection with static config for the rehydrate consumer). Layering the two is exactly NILUS's recommendation, not a Exarchos-specific accommodation.
- **[Protean, Designing Projection Granularity](https://docs.proteanhq.com/patterns/projection-granularity/)**: *"A projection's field structure does not need to mirror the aggregate that produced the data. ... Combine data from multiple aggregates into the shape the consumer requires."* The rehydrate envelope is a consumer with its own shape; `phasePlaybook` is one of its required fields, sourced from a non-event aggregate (the static playbook registry).

### 7.2 INV-5b is reinforced by the MCP spec

Beyond the project's existing INV-5b citations, the [MCP 2025-11-25 spec on Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) directly grounds the structured-data-on-envelope recommendation:

> *"Tools may also provide an output schema for validation of structured results. If an output schema is provided: Servers MUST provide structured results that conform to this schema. Clients SHOULD validate structured results against this schema."*

> *"Structured content is returned as a JSON object in the `structuredContent` field of a result. ... For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."*

This is the spec-native carrier for the phasePlaybook field. Once #1287 lands, the rehydrate action's `outputSchema` should declare phasePlaybook, and the response should ride in `structuredContent` — backwards-compatible with the current `data` field via the dual-encoding the spec already mandates.

### 7.3 Why the RCA's reducer-default proposal under-fits

The RCA proposes a phase-default backfill *inside the reducer* (`rehydrationReducer.initial.behavioralGuidance` becomes per-phase). Read against [INV-1](../../.claude/skills/design-invariants/references/INV-1-event-sourcing.md) and the external sources above, this is borderline: the L3 reducer would gain a non-event input (the L4 playbook table) at fold time. It works in practice because the playbook is static, but it conflates two distinct concerns:

1. *Folding events into derived state.* (L3 reducer's job. INV-1.)
2. *Composing static contract data into the read-side envelope.* (L5 handler's job. INV-5b composition pattern. Live-projection idiom.)

Treating these as one concern means every future projection that wants to surface phase-machinery data has to re-import the playbook registry. Treating them as two — fold + compose — keeps each layer single-purpose, and lets the same composition help any other read-side consumer that joins state + machinery (e.g., `exarchos_view shepherd_status` already needs phase-machinery context for its rendering).

The RCA is right that the *fix surface* spans projection / handler / template. The reframing argues the *fix shape* is composition, not backfill — and the cleanest locus of composition is the L5 handler.

## 8. Risks and limits

- **Snapshot bloat.** `phasePlaybook` is non-trivial text per phase (≈ 1–2 KB after structured serialization). Option H mitigates by *not* writing it into the snapshot — derive at envelope-wrap time. Decision: derive, don't persist (matches Marten "live aggregation" guidance).
- **Playbook drift.** If a future PhasePlaybook adds a field, `PhasePlaybookSchema` must follow. Mitigated by structurally serializing the playbook (one source of truth) — already what `serializePlaybooks` does for the `describe` action. Reuse `SerializedPhasePlaybook` directly to avoid a parallel type.
- **Phase with no playbook.** Terminal/unknown phases legitimately have `phasePlaybook: null`. Renderer must show `(no playbook — phase is terminal or unrecognized)` rather than empty. Test covers this.
- **Behavioral coupling claim isn't tested.** The behavioral defect (agent skips orchestration after rehydrate) is downstream of envelope contents — we cannot test it from the server side. Mitigation: the regression test asserts the *envelope* carries the contract; the slash-command test asserts the *rendered output* contains the discipline-reminder sentence. The behavioral gain is observable but not assertable without a live agent harness.
- **`session.started` event not in this scope.** Without it we still cannot detect "rehydrated but no work events" except by inference. Acceptable trade-off; file follow-up to coordinate with L7 lifecycle verbs.
- **Eventual consistency does not apply here.** The Azure CQRS doc warns of read-model lag against the write store. That concern is irrelevant for `phasePlaybook` because the playbook registry is not event-fed — it is static, in-process config. Live projection is "immediately consistent in the data storage" (Kurrent) and so is the playbook lookup.

## 9. Decision summary

| Question | Answer |
|---|---|
| What is `behavioralGuidance` actually? | Static phase machinery from the L4 playbook registry; not event-derived state. |
| Where should the machinery surface? | L6 envelope's `phasePlaybook` field, populated by the L5 handler from the L4 playbook lookup. |
| What about the L3 reducer? | Untouched. Continues to fold events into execution state. |
| What about the L8 renderer? | Renders a House Rules block from the new field; surfaces `_eventHints.missing` always; trailing discipline reminder. |
| What's the precedence rule for future overrides? | Explicit override events (when introduced) > phase default > null. |
| What gets snapshotted? | Only the fold output. `phasePlaybook` is derived per-call, not persisted (canonical "live projection"). |
| What's the next composability move? | Compose `session.started` telemetry so "rehydrated but inactive" is observable on the stream via L7 lifecycle verbs. Out of scope here. |
| What naming clash do we avoid? | `phasePlaybook` (matches `PhasePlaybook` type) — *not* `phaseContract`, which the L4 staleness loader already owns. |
| Is the recommendation novel? | No — it's the canonical CQRS "live projection" pattern (Kurrent / Marten / EventSourcingDB / NILUS). |

## 10. References

### 10.1 Internal — runtime architecture and source

- [`docs/architecture/runtime.md`](../architecture/runtime.md) — L1-L9 layers, RT-1..RT-6 guarantees, §7 cooperation model, §11 minimal description
- RCA: [`docs/rca/2026-05-08-rehydrate-behavioral-gap.md`](../rca/2026-05-08-rehydrate-behavioral-gap.md)
- Slash command source: [`commands/rehydrate.md`](../../commands/rehydrate.md)
- Handler source (L5): [`servers/exarchos-mcp/src/workflow/rehydrate.ts`](../../servers/exarchos-mcp/src/workflow/rehydrate.ts)
- Composite envelope wrap (L6): [`servers/exarchos-mcp/src/workflow/composite.ts`](../../servers/exarchos-mcp/src/workflow/composite.ts) (`envelopeWrapWithCacheHints`)
- Reducer (L3): [`servers/exarchos-mcp/src/projections/rehydration/reducer.ts`](../../servers/exarchos-mcp/src/projections/rehydration/reducer.ts)
- Schema (L3): [`servers/exarchos-mcp/src/projections/rehydration/schema.ts`](../../servers/exarchos-mcp/src/projections/rehydration/schema.ts)
- Playbooks (L4 SoT): [`servers/exarchos-mcp/src/workflow/playbooks.ts`](../../servers/exarchos-mcp/src/workflow/playbooks.ts)
- Sibling SoT consumer: [`servers/exarchos-mcp/src/verbs/gates/check-event-emissions.ts`](../../servers/exarchos-mcp/src/verbs/gates/check-event-emissions.ts)
- Projection contract: [`docs/architecture/projections.md`](../architecture/projections.md)

### 10.2 Invariants

- [INV-1 event-sourcing integrity](../../.claude/skills/design-invariants/references/INV-1-event-sourcing.md)
- [INV-2 facade equivalence](../../.claude/skills/design-invariants/references/INV-2-facade-equivalence.md)
- [INV-4 platform-agnosticity](../../.claude/skills/design-invariants/references/INV-4-platform-agnosticity.md)
- [INV-5b output contract](../../.claude/skills/design-invariants/references/INV-5b-output-contract.md)
- [INV-5c Aspire verbs](../../.claude/skills/design-invariants/references/INV-5c-aspire-verbs.md)
- [INV-5d action discriminator](../../.claude/skills/design-invariants/references/INV-5d-action-discriminator.md)
- Quality dimensions: `axiom/skills/backend-quality/SKILL.md` (DIM-1..DIM-8)

## 11. Implementation phases — hook-removal final form

This section captures the final scope after the 2026-05-08 design conversation expanded the recommendation to remove the Claude Code hook chain and converge on a two-verb explicit-resume model.

### 11.1 Final shape — two verbs, zero hooks

Rehydration machinery operates exclusively through two slash commands, both runtime-agnostic:

- **`/exarchos:checkpoint`** — emits `workflow.checkpoint` event with handoff payload; envelope carries `phasePlaybook` for correctness signal.
- **`/exarchos:rehydrate <feature-id>`** — folds the event stream, composes `phasePlaybook` from the L4 registry, surfaces `latestHandoff` from the event-derived projection.

Removed surfaces:

- `SessionStart` hook (Claude Code-specific bootstrap)
- `PreCompact` hook (companion that fed the side-channel checkpoint file)
- `cli-commands/session-start.ts` (`handleSessionStart`, `getBehavioralGuidanceForPhase`, `readAndDeleteCheckpoints`, `detectOrphanedTeam`)
- `commands/reload.md` (procedure that depended on the hook chain)
- Checkpoint-file format on disk (side-channel state — silent migration; existing files orphaned and harmless)

### 11.2 Why removal satisfies multiple invariants

| Invariant | Today's violation | After removal |
|---|---|---|
| [INV-1 event-sourcing integrity](../../.claude/skills/design-invariants/references/INV-1-event-sourcing.md) | Checkpoint-file format is a second source of truth alongside `workflow.checkpoint` events. The "stores-as-projections rule" is violated. | Event log is the only authority; `latestHandoff`/`recentHandoffs` projection folds the events. |
| [INV-2 facade equivalence](../../.claude/skills/design-invariants/references/INV-2-facade-equivalence.md) | CLI side-channel (session-start.ts) carries behavior MCP envelope lacks; `getBehavioralGuidanceForPhase` returns rendered prose only on the CLI path. | Two surfaces, both routing through dispatch core, both producing identical structured envelopes. |
| [INV-4 platform-agnosticity](../../.claude/skills/design-invariants/references/INV-4-platform-agnosticity.md) | `SessionStart` hook is a Claude Code-specific bootstrap concept; Codex/Cursor/OpenCode/Copilot/generic runtimes cannot replicate it. | Explicit `/exarchos:rehydrate` verb works identically in all runtimes through the standard slash-command + MCP path. |
| [INV-5c Aspire verbs](../../.claude/skills/design-invariants/references/INV-5c-aspire-verbs.md) | Resume happens implicitly via hook side effect ("agent observes auto-injected context"). | Resume happens through an explicit control-plane verb the agent calls — Aspire-style. |

Per [runtime.md §7](../architecture/runtime.md#7-agent-cooperation-model): *"This makes autonomy a property of state + topology, not a hidden side effect of any handler."* Removing the hook chain removes the largest hidden side effect in the rehydration surface.

### 11.3 UX trade-off

Today, after `/clear` in Claude Code, context auto-injects via the `SessionStart` hook. That's pleasant when it works, opaque when it doesn't, and impossible to replicate in other runtimes. The explicit-verb model gives every runtime the same control surface at the cost of one `/exarchos:rehydrate` invocation per resume.

The fallback for "user does not remember the feature ID" is already documented in `commands/rehydrate.md` step 2: invoke `exarchos_view pipeline`, list active workflows, ask which to rehydrate. No auto-discovery side-channel needed.

### 11.4 Phased implementation plan

Six phases, each independently shippable. Numbered for the refactor workflow's overhaul-plan TDD task list.

| Phase | Locus (L1-L9) | Independently shippable | Description |
|---|---|---|---|
| **P1** Schema bump v:2 → v:3 | L3 | Yes (additive + cleanup, no behavior change yet) | Internal projection drops `behavioralGuidance`; envelope adds `phasePlaybook`; `upgrade.ts` v:2→v:3; v:2 demoted to read-back-only schema |
| **P2** Handler composition | L5 | Yes (depends on P1) | `handleRehydrate` and `handleCheckpoint` compose `phasePlaybook` from `getPlaybook(...)`; shared helper consolidated |
| **P3** Renderer rewrites | L8 | Yes (depends on P2) | `commands/rehydrate.md` and `commands/checkpoint.md` rewritten with House Rules block; both render structured `phasePlaybook` |
| **P4** Event emissions | L2 + L5 | Yes (independent of P1-P3) | Extend `workflow.rehydrated` data schema; register `session.machinery_consumed`; add dispatch-core interceptor |
| **P5** Hook + side-channel removal | manifests + L5 | Yes (depends on P2 — `cli-commands/session-start.ts` only safe to remove once handlers compose `phasePlaybook` directly) | Delete `SessionStart` + `PreCompact` hooks from `.claude-plugin/plugin.json` and `settings.json`; delete `cli-commands/session-start.ts`; delete `commands/reload.md`; silent migration on side-channel files |
| **P6** Vestigial cleanup | various | Yes (depends on all above) | Remove `BehavioralGuidanceSchema`, `getBehavioralGuidanceForPhase`, prose-lint references, stale tests; verify `STABLE_KEYS` reflects new schema |

### 11.5 Forward-monotonic milestone alignment

Each milestone past v2.10 adds capability without modifying anything P1-P6 lands.

| Milestone | What it consumes from this refactor | What it adds |
|---|---|---|
| **v2.10** (durable substrate) | Nothing — pure schema/handler change | Nothing |
| **v2.11** (autonomy, set→transition canonical) | Structured `phasePlaybook` + `session.machinery_consumed` events feed `next_actions` consumption | Nothing new |
| **v2.12 (lifecycle verbs ps/wait)** | New `workflow.rehydrated` extended fields + `session.machinery_consumed` events | `ps` queries them for liveness; `wait --condition=machinery_consumed` lands as one-line addition |
| **v2.12 (output contract — #1287)** | `RehydrationDocumentSchema` v:3 already structured | Register as `outputSchema` on the rehydrate action; response moves from `data` field to `structuredContent` carrier (shape unchanged) |
| **#1275 MCP Resources** | `getPlaybook(...)` lookup is the canonical data source | Expose playbooks as MCP Resources; `handleRehydrate` can compose locally or fetch via Resource — same data |

The rehydration machinery becomes evolutionary scaffolding for v2.11, v2.12, and the milestone-16 alignment work — not technical debt to be paid down.

### 11.6 Stopping point and human checkpoint

The refactor workflow stops at the `overhaul-plan-review` human checkpoint after the TDD task list is written. The user reviews the task plan before delegation begins. Track this discovery report as the design-of-record; the refactor workflow's brief and plan artifacts are the operational projections.

### 10.3 External — CQRS / event-sourcing / projection design

- [Azure Architecture Center — Event Sourcing pattern](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing) (Microsoft Learn). Canonical statement of "rehydration" as the on-demand derivation pattern; intent-named events; eventual consistency; idempotent at-least-once delivery.
- [Azure Architecture Center — CQRS pattern](https://learn.microsoft.com/azure/architecture/patterns/cqrs) (Microsoft Learn). Read/write separation; "the read model can use its own data schema that's optimized for queries"; combination with event sourcing.
- [.NET cloud-native data patterns — Event Sourcing](https://learn.microsoft.com/dotnet/architecture/cloud-native/distributed-data#high-volume-data) (Microsoft Learn). Event sourcing as immutable ledger; materialized views as the read side.
- [EventSourcingDB — Designing Read Models](https://docs.eventsourcingdb.io/best-practices/designing-read-models/). Read models as derivations, never authoritative; "never update read models directly."
- [Kurrent — Live projections for read models with Event Sourcing and CQRS](http://www.kurrent.io/blog/live-projections-for-read-models-with-event-sourcing-and-cqrs) (Anton Stöckl, 2021). Defines the "live projection" idiom adopted as Option H.
- [Marten — Projections tutorial part 4](https://martendb.io/tutorials/read-model-projections). Async vs live projections; `AggregateStreamAsync` and live aggregation API.
- [NILUS — CQRS Read Model Explosion in Event-Driven Systems](https://www.nilus.be/blog/cqrs_read_model_explosion_in_event-driven_systems/) (2025-06). Foundational projections vs experience-specific compositions; read-model layering as proliferation control.
- [Protean — Projections concept](https://docs.proteanhq.com/concepts/building-blocks/projections/) and [granularity guidance](https://docs.proteanhq.com/patterns/projection-granularity/). Projection field structure does not need to mirror aggregate structure; design around consumer needs.
- [Konrad Garus — Persistence in CQRS Read Models](https://blog.oasisdigital.com/2015/persistence-in-cqrs-read-models/). When to persist read models vs derive on demand; the disk as cache, not authority.

### 10.4 External — MCP spec for INV-5b alignment

- [MCP Specification 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). `outputSchema` and `structuredContent` carriers; servers MUST provide structured results that conform to declared schemas.
- [MCP Tools concept page](https://modelcontextprotocol.io/docs/concepts/tools). Tool annotations; structured result examples; `outputSchema` validation semantics.
- [MCP RFC PR #371 — outputSchema and structuredContent](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/371). Origin RFC for the structured-output mechanism.
