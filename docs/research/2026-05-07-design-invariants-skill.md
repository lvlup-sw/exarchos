# Design-Invariants Skill — Discovery Report

**Date:** 2026-05-07 (rev 2026-05-07 — incorporates feedback on INV-1 grounding, INV-2 reframing post-#1088 redesign, INV-5 split + action discriminator, INV-6 removal)
**Status:** Discovery — feeds future `/exarchos:ideate` for skill implementation
**Workflow:** `design-invariants-skill` (discovery)
**Inputs:** issues [#1118](https://github.com/lvlup-sw/exarchos/issues/1118), [#1109](https://github.com/lvlup-sw/exarchos/issues/1109), [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) (v2.10/v2.11 Output Contract — redesigned 2026-05-07), [#1260](https://github.com/lvlup-sw/exarchos/issues/1260) (machine-readable invariants file)
**Pairs with:** `/axiom:backend-quality` and its eight-dimension taxonomy

---

## 1. Goal

Author a repo-scoped Claude Code skill that, when invoked alongside `/axiom:backend-quality`, evaluates a design proposal or diff against the **Exarchos-specific architectural invariants** that #1118 enumerates as principles and #1109 codifies as cross-cutting constraints.

The skill is the operational complement to #1118's "codify principles" docs deliverable: principles get a single-source-of-truth document; this skill turns those principles into a checklist an agent can actually run during a design session. The skill's reference files are also direct candidates to back the v2.11.0 #1275 (Resources for invariants) MCP Resource surface — making them runtime-queryable, not just human-readable.

## 2. What the skill is *not*

Hard delineation — the skill must not duplicate axiom. It defers to axiom for everything axiom already covers:

| Concern | Owner |
|---|---|
| Generic SOLID, coupling, dependency direction (DIM-6) | `axiom:critique` |
| Generic error handling, silent fallbacks (DIM-2, DIM-7) | `axiom:harden` |
| Generic schema-runtime drift, type-assertion safety (DIM-3) | `axiom:scan`, `axiom:critique` |
| Generic test fidelity, mock overuse (DIM-4) | `axiom:verify` |
| Generic dead code, vestigial patterns (DIM-5) | `axiom:distill` |
| AI-prose tells (DIM-8) | `axiom:humanize` |
| **Exarchos-specific architectural invariants below** | **this skill** |

The seam: axiom asks *"is this code well-engineered?"*; this skill asks *"does this design respect Exarchos's load-bearing invariants?"* A design can be axiom-clean and still violate event-sourcing integrity (e.g., a perfectly well-typed handler that mutates state in place instead of emitting events). Conversely, the milestone-16 design doc shows the cross-invariant case: TaskStore-as-projection is non-negotiable because the SDK's `InMemoryTaskStore` would simultaneously violate INV-1 (second SoT for task state) and DIM-1 Topology (lazy fallback creates degraded instance silently).

## 3. Invariant catalog

Five invariants distilled from #1118 (principles), #1109 (constraints), the basileus ADR (`docs/adrs/ontological-data-fabric.md` §§2.1, 2.3, 2.4, 2.7, 2.8), `docs/architecture/projections.md` (canonical projection contract), and the milestone-16 alignment design (`docs/designs/2026-05-07-milestone-16-mcp-alignment.md`).

### INV-1: Event-sourcing integrity (load-bearing)

The append-only event log is the source of truth. Every read-model is a left-fold; state mutations are events, not in-place updates.

**Acceptance questions** (from #1109 §1):
1. Does the surface read from the event store? (which projections)
2. Does the surface write to the event store? (which event types)
3. Does the surface stream from the event store? (subscriptions)
4. Can the output be reconstructed from events alone?

**Repo-grounded checks:**
- New `ProjectionReducer` follows `apply: (state, event) => state` purity (no I/O, no mutation, deterministic) per `docs/architecture/projections.md` §1.
- Reducer ships all three required test types — given/when/then per event, immutability harness (`assertReducerImmutable`), registry round-trip — per §2.
- New event type is registered in `event-store/schemas.ts` before being appended (validator rejects unknown types — confirmed empirically: `discovery.sources_collected` failed with `Unknown event type` during this very workflow).
- Degradation paths emit `workflow.projection_degraded` with one of `reducer-throw | snapshot-corrupt | event-stream-unavailable` per §4.
- No module mutates `state` in `apply`; structural sharing only.
- **Stores-as-projections rule** — any module that holds derived state across calls (TaskStore, cache, view materializer) MUST be a reducer over events, never an in-memory side database. The milestone-16 design `§2.1` calls this "non-negotiable under Constraint 1" and cites the SDK's `InMemoryTaskStore` as an explicit anti-pattern: it would be a second source of truth for task state.

**External grounding:**
- **Microsoft Azure Architecture Center, [*Event Sourcing pattern*](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)** — Microsoft's canonical statement of the pattern. Key contributions to this invariant:
  - "The event store is the permanent source of information, so you should never update the event data. The only way to update an entity or undo a change is to add a compensating event." Compensating events (e.g. `ReservationCanceled` after `SeatsReserved`) are the *only* mechanism — never in-place updates.
  - "Snapshots are an optimization, not a replacement for the eventstream." Mirrors Exarchos's `projections/store.ts` snapshot sidecar contract.
  - **Schema-evolution toolkit** — tolerant deserialization, event versioning, upcasting, in-place migration (last resort). Maps directly to the per-event schema-versioning question that comes up whenever `event-store/schemas.ts` is edited.
  - **Event design discipline**: "Design events to capture the business intent behind each change in addition to the resulting state." `SeatsReserved(2)` beats `RemainingSeatsChanged(42)`. Translates: Exarchos events should be intent-named (`task.completed`, `workflow.transition`), not state-named (`stateChangedToReview`).
  - **Idempotency**: "Event delivery to consumers is typically *at least once*, so consumers can receive the same event more than once. Event handlers must be idempotent." Confirms #1109 Constraint 1 acceptance question 4.
  - **Don't confuse event store with message broker** — Exarchos's event-store is purpose-built for per-stream queries + optimistic concurrency, not a Kafka-style fan-out layer. Worth noting because the basileus two-channel transport could be misread as a broker boundary; it isn't.
- Greg Young, *Why can't I update an event?* — events are immutable facts; updates kill cacheability and break subscribers.
- Vandermeer, *16 practical guidelines for ES* (2020) — model aggregates around invariants; use autonomous async projections; design for cheap rebuild.
- *EventSourcingDB Common Issues* — handlers MUST be idempotent; at-least-once delivery is the floor; avoid PII in events. The Azure pattern doc reinforces the PII guidance: "store personal data outside the event store and reference it by identifier", or use crypto-shredding when separation isn't possible.
- Kurrent, *Projections 1: Theory* — left-fold formalization mirroring `docs/architecture/projections.md` §1.

**Severity guide:**
- HIGH: state mutation outside an event; field read at runtime without corresponding emission; "fix-it-up" event rewrites; in-memory store where a projection is required (TaskStore-as-side-database pattern).
- MEDIUM: projection that joins across streams without owning a private lookup; non-deterministic `apply`; state-named event (`somethingChanged`) where intent-named (`somethingHappened`) was possible; missing optimistic-concurrency guard on a write path.
- LOW: missing snapshot cadence on a projection that won't grow; verbose event payload that could be slimmed.

---

### INV-2: Facade equivalence over a shared dispatch core

CLI and MCP are both **facades over a single functional dispatch core** (`servers/exarchos-mcp/src/dispatch/core/dispatch.ts`). For any verb, the same `DispatchContext` + same arguments must produce the same `ToolResult`. Adapters (`adapters/cli.ts`, `adapters/mcp.ts`) carry **zero behavior** — only presentation: argv parsing, exit codes, stdio framing, error rendering, output carrier translation.

The byte-equivalence parity tests in `parity.test.ts` (and `views/parity.test.ts`, `workflow/parity.test.ts`, `event-store/parity.test.ts`) are the **witness**, not the invariant. The invariant is the architectural separation; the tests confirm it.

**Acceptance questions:**
1. Does the new verb route through `dispatch/core/dispatch.ts` as a typed handler, with both `adapters/cli.ts` and `adapters/mcp.ts` as thin wrappers?
2. Is there zero behavior in either adapter beyond format conversion? (No CLI-only event emission, no MCP-only side effects.)
3. Does the parity harness in `__tests__/parity-harness.ts` cover the new verb with at least one fixture covering the bug-cluster shapes (e.g., empty state vs duplicated events vs no-handoff invocations)?
4. Does the verb's `ToolResult` shape match the canonical envelope (`success`/`data`/`error`/`_meta`/`_perf`/`next_actions` and the v2.10 additions — see INV-5b)?

**Reframing post-#1088 redesign (2026-05-07):**

Epic #1088 was substantially reworked yesterday in `docs/designs/2026-05-07-milestone-16-mcp-alignment.md`. The reframe matters for INV-2 in two ways:

1. **The invariant is unchanged.** §2.2 of the design states: "CLI and MCP route through the same dispatch core today. This design preserves that." The shared-core architecture is preserved across the v2.10/v2.11 migration; it is not what's changing.
2. **The implementation surface gets a new declarative artifact.** Post-#1266, every action will register a Zod `outputSchema` in `registry.ts`. The MCP adapter binds it via `server.registerTool()`'s third argument; the CLI adapter's `--format json` mode literal-encodes the same envelope. The schema is no longer implicit in whatever `formatResult` returned — it is explicit, one-per-action, and shared between both carriers.

Practical impact on the skill's INV-2 checks:
- **(a) New parity dimension** — schema-equivalence, not just byte-equivalence. After #1266, parity tests should also confirm that the registered `outputSchema` validates both the CLI `--format json` payload and the MCP `structuredContent` payload from the same `DispatchContext` invocation.
- **(b) Carrier-translation discipline** — the `formatResult()` boundary becomes the *only* place CLI and MCP carriers diverge. Anything else that diverges between adapters is a violation. Pre-#1266, this is enforced by the parity test; post-#1266, it's enforced by both the test and the registered schema.
- **(c) Cross-invariant note** — the `TaskStore-as-projection` decision in §2.1 of the design is an example of INV-1 *driving* an INV-2 implementation choice. The SDK ships an `InMemoryTaskStore` that would let the MCP adapter "just work" — but using it would create a second source of truth invisible to the CLI adapter, breaking facade equivalence in a way the parity tests would not catch (state, not output). The skill should flag any "convenient adapter-local state" as a candidate for this anti-pattern.

**External grounding:**
- Anthropic, *Writing effective tools for agents* (2025-09-11) — namespace per service; tools should map to user intents, not API endpoints; treat schema violations as contract failures.
- AgentPatterns *MCP Server Design* — symmetric error channels (protocol vs tool-execution); `isError: true` payloads carry actionable context.
- MCP spec lifecycle (2025-11-25) — capability negotiation is a mandatory init handshake; both sides must respect negotiated capabilities for the session.
- MCP spec *2025-11-25 §CallToolResult* — `structuredContent` sibling to `content` is the spec-native carrier for validated JSON; #1266 migration is alignment, not invention.

**Severity guide:**
- HIGH: behavior diverges (one adapter emits an event the other doesn't); adapter-local mutable state that would not survive a swap; new verb that bypasses `dispatch/core/dispatch.ts`.
- MEDIUM: shape diverges in non-load-bearing fields; schema not registered post-#1266; missing parity-harness fixture.
- LOW: cosmetic differences (whitespace, key order).

---

### INV-3: Basileus-forward (no MCP-second-class assumptions)

No design decision presumes MCP is local-only. The Exarchos ↔ Basileus coordination ADR cements two-channel transport (Workflow client A on `/mcp/workflow`, Ontology client B on `/mcp/ontology`) with independent client lifecycles, handshake-authoritative capability resolution, and `.exarchos.yml`-only configuration.

**Acceptance questions** (from #1109 §3 + ADR §§2.1, 2.4, 2.7, 2.8):
1. No reads of `runtimes/*.yaml` capability fields at runtime — the resolver merging `yaml ⊕ handshake` is the only authority.
2. `agent` namespace remains reserved for future remote agent coordination (not AI-assistant setup).
3. New config lands in `.exarchos.yml` only — no `bridge-config.json`-style sibling files.
4. Sideband daemon assumptions hold across all runtimes (not Claude-Code-specific).
5. **Roots awareness** (#1269) — workspace discovery via the spec's `roots` capability rather than `cwd` heuristics, capability-gated so non-roots clients still work.

**External grounding:**
- AgentPatterns *Capability Negotiation* — version negotiation is mandatory; servers without a match disconnect rather than silently degrade.
- IBM ContextForge architecture patterns — single-responsibility servers (S1), workflow-oriented tools (S2); central host policy and consent.
- MCP spec *2025-11-25 §Roots* — the spec's standard mechanism for client-declared workspace boundaries; basileus-forward designs prefer this over implicit `cwd`.

**Severity guide:**
- HIGH: hard-coded "MCP is local" assumption (e.g., synchronous file I/O blocking the dispatch path); workspace path inferred from `cwd` when `roots` is available.
- MEDIUM: capability check that doesn't go through the resolver.
- LOW: design that works remotely but is less efficient than necessary.

---

### INV-4: Platform-agnosticity (multi-runtime, no Claude-only coupling)

Skills, rules, and workflows must not couple to any single harness. The skills renderer + runtime YAML system is the implementation; the invariant is the design discipline.

**Acceptance questions:**
1. Does the design tokenize Claude-specific text via `{{TOKEN}}` placeholders, or guard via `<!-- requires:* -->`?
2. Every new token is declared in all six `runtimes/*.yaml` files (Claude, Codex, Copilot, Cursor, OpenCode, generic).
3. New capability identifiers are members of `SupportedCapabilityKey` in `src/runtimes/types.ts`.
4. `npm run skills:guard` passes — generated `skills/` is in sync with `skills-src/`.

**Repo-grounded checks:**
- Source-of-truth edits go to `skills-src/<name>/SKILL.md`, never to `skills/<runtime>/**`.
- Reference files (`skills-src/<skill>/references/*.md`) carry no YAML frontmatter (CLAUDE.md "Reference-file frontmatter" rule).
- Every Claude-flavored example has a tokenized rendering for non-Claude runtimes.

**External grounding:**
- AgentPatterns *MCP Client Design* — namespace by server ID; per-request timeouts; graceful degradation on capability gaps.
- WebMCP *Tool Design* — schemas are the type signature; constrain via enum/format, not free-text.

**Severity guide:**
- HIGH: hardcoded Claude-only feature reference (e.g., `Skill({...})` syntax in source instead of `{{CHAIN}}`).
- MEDIUM: missing token coverage for one runtime — caught by `assertRuntimeTokenCoverage` pre-flight.
- LOW: stylistic Claude-isms in prose.

---

### INV-5: Agent-first interface design

Exarchos surfaces are designed for AI-agent consumption first; human readability is a secondary benefit. This invariant has four sub-disciplines, each addressing a different agent-failure mode.

#### INV-5a — Tool input ergonomics

Generic agent-friendly tool design — what *every* well-designed MCP server should do.

**Checks:**
- Tool descriptions ≥3–4 sentences with explicit "Do NOT use for X — use Y instead" guidance (Anthropic *Define tools*).
- Poka-yoke schemas — enum over free-text, regex/format constraints, absolute paths over relative ones (AgentPatterns *MCP Server Design*).
- Per-parameter description with constraints + examples; `input_examples` for complex schemas (Anthropic *Define tools*).
- Read-only context exposed as MCP **Resources**, not tools (#1275 will operationalize this for docs/playbooks/invariants).
- Visible tool count ≤15 per server — Exarchos achieves this via the action-discriminator pattern (INV-5d below).

#### INV-5b — Spec-aligned output contract

Every successful `ToolResult` carries machine-actionable affordance hints. The output contract is the single most-likely-to-drift dimension because it is easy to add a new MCP tool that returns `{ ok: true }` and ship; the omission only surfaces when an agent gets stuck mid-workflow.

**Reframed post-#1088 redesign (2026-05-07).** The original framing — HATEOAS envelope as JSON-stringified text payload — was a v3.0 differentiator before the MCP 2025-11-25 spec landed `outputSchema` / `structuredContent` / Tasks (SEP-1686) / Roots / Elicitation / Resources. The milestone-16 alignment design retargets onto those primitives. The invariant becomes:

**"Use spec primitives where they exist; extend Exarchos-specific shapes alongside them, not against them."**

| What | Pre-#1088-redesign framing (deprecated) | Post-#1088-redesign framing (this invariant) |
|---|---|---|
| Carrier | HATEOAS envelope as JSON-in-text in `content[0].text` | `structuredContent` (spec-native) with registered `outputSchema` per action |
| `next_actions` | Custom `next_actions` field in envelope | Same field, but exposed via the registered `outputSchema` so clients validate it natively |
| Long-running ops | NDJSON streaming wire protocol (`#1100`) | MCP Tasks (SEP-1686) with `tasks/get` / `tasks/result` / `tasks/cancel`; NDJSON survives only as a CLI render format |
| Schema | Implicit in `formatResult` | Declarative — one Zod `outputSchema` per action in `registry.ts` |
| Workspace discovery | `cwd` heuristics | `roots` capability (#1269), capability-gated |
| Recovery on `INVALID_INPUT` | Return error with text | Elicitation form mode (#1274), capability-gated |
| Reference content (docs, playbooks, invariants file) | Tools that return strings | MCP Resources (#1275) with subscriptions |

Three Exarchos-shaped extensions remain genuinely outside the spec and continue to ride alongside spec primitives:
- `_eventHints` — event-source acknowledgement (which events the verb may emit).
- `_cacheHints` — Anthropic cache-control hints.
- `next_actions` derived from HSM topology (the *content* is Exarchos-specific; the *carrier* is spec-aligned).

**Checks:**
- Every successful `ToolResult` carries `next_actions[]` derived from the HSM (the response *is* the affordance map — pure HATEOAS, but the carrier is `structuredContent`).
- Every error response carries `validTargets`, `expectedShape`, `suggestedFix` so the agent can self-correct without re-prompting the human (already implemented in `format.ts:32-47`).
- Every composite tool exposes a `describe` action returning schemas + emission catalogs + topology (already implemented across `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`).
- `_meta` carries control-plane hints (`checkpointAdvised`, `degraded`, `fallbackSource`); `_perf` carries `{ms, bytes, tokens}` for self-instrumentation (already implemented).
- Stable JSON shape — no breaking field renames without an envelope version bump.
- No "human-first" output (banners, ASCII tables, color codes) leaks into the envelope; presentation is the CLI adapter's job.
- Post-#1266: every new action registers an `outputSchema` in `registry.ts` and binds it via `server.registerTool()`'s third argument.
- Post-#1268: every new action declares its annotations table (`destructiveHint` / `readOnlyHint` / `idempotentHint` / `openWorldHint`).
- Long-running ops follow the Tasks (SEP-1686) shape post-v2.11.0; NDJSON is reserved for CLI rendering only.

**External grounding:**
- MCP spec *2025-11-25 §CallToolResult* — `structuredContent`, `outputSchema`, tool annotations.
- MCP spec *2025-11-25 SEP-1686* — Tasks for long-running operations with `input_required`.
- Anthropic, *Code execution with MCP* (2025-11-04) — deferred loading + `search_tools` cuts 150k → 2k tokens (98.7%); the action-discriminator pattern (INV-5d) is the structural complement.
- `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` — full design rationale.

#### INV-5c — Aspire-inspired control-plane verbs

Exarchos's CLI design borrows deliberately from Aspire (per CLAUDE.md "Design Philosophy": *"New feature designs must follow agent-first CLI patterns (Aspire-inspired), not config-file-centric or human-first designs."*). The substantive contribution is a *control-plane verb* model: agents query state, don't drive scripts.

**Checks:**
- Process-lifecycle verbs (`ps`, `describe`, `wait`, `export`) modeled on Aspire's CLI surface — agents observe and steer; they don't write shell.
- New verbs default to **queryable, dry-run-capable, JSON-explicit** (Aspire-style) before considering **positional args, exit codes, stdout-as-stream** (Unix-style).
- `describe` is a first-class verb, not an afterthought (every composite tool exposes `describe`).
- Long-running operations expose status verbs (`wait`, `tasks/get`) so an agent can poll without re-issuing the work.

**External grounding:**
- CLAUDE.md "Design Philosophy" section — explicit Aspire-inspiration constraint on new designs.
- v2.10.0 milestone (Process Lifecycle Verbs: ps/describe/wait/export) — the most concrete Aspire borrow currently shipping.

#### INV-5d — Action discriminator pattern (composite tools)

Exarchos exposes **4 visible composite tools**, each accepting an `action` discriminator: `exarchos_workflow({ action: "init" | "get" | "set" | ... })`, `exarchos_event({ action: "append" | "query" | ... })`, `exarchos_orchestrate({ action: ... })`, `exarchos_view({ action: ... })`. This is a deliberate *namespace-collapse* response to the tool-proliferation failure mode Anthropic flagged in *Writing effective tools for agents*.

**Why the pattern matters:**
1. **Visible tool count stays under the 10–15 threshold** that the AgentPatterns research identifies as the selection-accuracy cliff — even though Exarchos exposes ~30+ logical operations, the agent sees ~4 namespaces.
2. **The `action` field is the real verb.** The composite tool is a grouper; the action is the operation. This mirrors REST URI design (resource-as-tool, operation-as-action) and HTTP method semantics.
3. **`describe` action is the discoverability mechanism.** `exarchos_workflow({ action: "describe", actions: ["init", "set"] })` returns schemas inline. This is how agents progressively discover the namespace without paying the upfront token cost of all 30+ schemas.
4. **Annotations apply per-action, not per-tool** (#1268 — "tool annotations table on CompositeAction"). `exarchos_event({action: "append"})` is destructive; `exarchos_event({action: "query"})` is read-only. The annotations table lets a single composite tool carry different safety hints per action.

**Checks:**
- New operations land as actions on existing composite tools when the namespace fits (workflow / event / orchestrate / view), not as new top-level tools. New top-level tools require explicit justification.
- Action schemas are discriminated unions in Zod, not a permissive `Record<string, unknown>` — so the schema validates `action: "init"` parameters distinctly from `action: "set"` parameters.
- Each action carries its own `outputSchema` (post-#1266), `annotations` (post-#1268), and `describe` entry — none of these are tool-level when actions diverge.
- Tool-level descriptions enumerate the action set briefly; per-action descriptions go through `describe`. This keeps the upfront tool-list payload small while preserving full discoverability.
- Naming: `tool_name` is the namespace (`exarchos_workflow`); `action` is the verb (`init`, `set`, `cancel`). Tool names follow `verb_noun` only when the namespace is small enough that an action discriminator would be over-engineering (e.g., `exarchos_sync` is a hidden single-purpose tool).

**External grounding:**
- Anthropic, *Writing effective tools for agents* (2025-09-11) — namespacing, intent-shaped tools, token efficiency.
- Anthropic, *Code execution with MCP* (2025-11-04) — deferred loading is the *runtime* response to tool proliferation; the action-discriminator pattern is the *design-time* complement.
- AgentPatterns *MCP Server Design* — tool list <15; if you have more operations, the pattern says "tool" should map to a namespace, not an endpoint.
- WebMCP *Tool Design* — "avoid similar tools with subtle differences" (e.g., `search_products` + `search_products_with_filters`); the action discriminator is the structural answer.
- Milestone-16 alignment design `§2.5` — annotations are registered against `CompositeAction`, confirming the (tool, action) pair is the canonical dispatch identity.

**Severity guide for INV-5 overall:**
- HIGH: response without `next_actions` on a verb that has them; error without `validTargets`/`suggestedFix` on a transition guard failure; CLI banner leaking into the JSON envelope; new top-level tool that should have been an action on an existing composite (e.g., `exarchos_event_append` instead of `exarchos_event({action: "append"})`).
- MEDIUM: missing `_meta.checkpointAdvised` after a cadence-trigger; tool description under 3 sentences for a non-trivial tool; action without a `describe` entry; long-running op using NDJSON instead of Tasks post-v2.11.0.
- LOW: descriptive `_perf` units could be sharper; minor schema-vs-runtime drift in tool descriptions.

---

## 4. Where the catalog comes from (traceability)

| Invariant | #1118 | #1109 | Basileus ADR | Repo state |
|---|---|---|---|---|
| INV-1 Event-sourcing integrity | Principle 1 | Constraint 1 | (cited as constraint) | `docs/architecture/projections.md`, `event-store/schemas.ts`, milestone-16 §2.1 |
| INV-2 Facade equivalence over shared dispatch core | — | Constraint 2 | (cited) | `dispatch/core/dispatch.ts`, `parity.test.ts`, `__tests__/parity-harness.ts`, milestone-16 §2.2 |
| INV-3 Basileus-forward | — | Constraint 3 | §§2.1, 2.4, 2.7, 2.8 | `runtimes/*.yaml` resolver, milestone-16 §2.3 (Roots) |
| INV-4 Platform-agnosticity | Principle 2 | (implied) | §1.5 (constraints table) | `skills-src/SKILL_AUTHORING.md`, `runtimes/*.yaml` |
| INV-5 Agent-first (5a–5d) | Principle 3 | (implied) | thesis §1 | `format.ts`, `next-actions-from-result.ts`, `registry.ts`, milestone-16 alignment design |

#1118 stops at three principles; #1109 adds the operational layer; the basileus ADR adds two-channel/handshake/config-consolidation; the milestone-16 alignment design retargets the output contract onto MCP spec primitives. This report is the first place all five invariants live as a unified catalog.

## 5. Skill blueprint

### 5.1 Placement (recommendation)

**Recommend: repo-local at `.claude/skills/design-invariants/SKILL.md`** — not `skills-src/`.

Rationale:
- These invariants govern Exarchos *itself*, not consumers of the Exarchos plugin. Distributing them via the marketplace would be self-referential.
- Repo-local skills load only when working in this repo, which matches the desired scope.
- Avoids the renderer + token-substitution overhead that's only needed for distributed skills.

(`.claude/` exists in this repo with `agents/`, `commands/`, etc.; the `skills/` subdir would be new and is the standard project-skill location for Claude Code.)

### 5.2 Frontmatter

```yaml
---
name: design-invariants
description: "Audit a design proposal or diff against Exarchos's architectural invariants — event-sourcing integrity, facade equivalence over shared dispatch core, basileus-forward, platform-agnosticity, and agent-first interface design (input ergonomics + spec-aligned output contract + Aspire-inspired verbs + action-discriminator pattern). Pairs with /axiom:backend-quality (this skill is project-specific, axiom is generic). Triggers: 'check invariants', 'design conformance', 'check #1118 / #1109', or /design-invariants."
metadata:
  author: exarchos
  version: 0.1.0
  category: review
  pairs-with: axiom:backend-quality
---
```

### 5.3 Body shape (sketch)

```
# Design Invariants Skill

## When to use
- During /ideate or /plan, before committing a design
- During /review, alongside /axiom:audit
- When reviewing a PR that touches the event store, MCP surface, or runtime YAML

## When NOT to use
- For generic backend quality — use /axiom:* skills
- For TDD / spec compliance — use /review or /spec-review
- For prose / AI-writing tells — use /axiom:humanize

## How to invoke
1. State the artifact under review (design path, diff range, or PR URL)
2. Walk INV-1..INV-5 in order, recording HIGH/MEDIUM/LOW findings per invariant
3. For INV-5, walk all four sub-disciplines (5a input ergonomics, 5b output contract, 5c Aspire verbs, 5d action discriminator)
4. Cross-link any axiom finding that overlaps (e.g., a topology issue under INV-1 may also be DIM-1)
5. Output the same finding format as axiom (severity + dimension + file:line + description + required_fix)

## Invariant references
- INV-1 → references/INV-1-event-sourcing.md
- INV-2 → references/INV-2-facade-equivalence.md
- INV-3 → references/INV-3-basileus-forward.md
- INV-4 → references/INV-4-platform-agnosticity.md
- INV-5a → references/INV-5a-input-ergonomics.md
- INV-5b → references/INV-5b-output-contract.md
- INV-5c → references/INV-5c-aspire-verbs.md
- INV-5d → references/INV-5d-action-discriminator.md

## Finding format (matches axiom)
{
  "verdict": "pass | conditional | fail",
  "findings": [
    { "invariant": "INV-1", "severity": "HIGH", "file": "...", "line": N,
      "description": "...", "required_fix": "...",
      "axiom_overlap": "DIM-1" }
  ]
}
```

### 5.4 Reference files

One per invariant (with INV-5 split into four sub-references), each carrying:
- The acceptance questions
- Repo-grounded checks (with paths)
- External grounding (citations + 1–2 sentence summaries)
- Severity guide
- Worked examples (positive + negative)

Reference files MUST NOT carry frontmatter (per CLAUDE.md "Reference-file frontmatter" convention).

### 5.5 Forward-link to #1260 / #1275

Issue #1260 (machine-readable invariants file) and #1275 (Resources for docs/playbooks/invariants) are the runtime surface for what this skill consumes design-time. The skill's reference files should be authored such that they can also serve as the source for #1260's machine-readable manifest — i.e., each invariant has a stable ID (`INV-1`...`INV-5d`), structured acceptance questions, and explicit severity rubrics, so a generator can emit a Zod-validated invariants document. When v2.11.0 lands #1275, those same files become MCP Resources that agents `resources/read` directly.

This is a happy alignment of the discovery deliverable with the v2.11 roadmap: the skill's reference files do double duty as human-readable design checklists *and* machine-readable resource payloads.

### 5.6 Pairing with axiom — explicit complementarity matrix

| Finding | Axiom dimension | Design invariant |
|---|---|---|
| Lazy fallback that creates degraded EventStore | DIM-1 Topology | INV-1 (silent loss of event integrity) |
| Hardcoded `Skill({...})` in skills-src | — | INV-4 |
| `console.log`-only catch in projection apply | DIM-2 Observability | INV-1 (fold throws → must trigger reducer-throw degradation path) |
| New CLI verb without MCP equivalent | — | INV-2 |
| Adapter-local mutable cache for projection state | DIM-1 Topology | INV-1 + INV-2 (TaskStore-as-side-database anti-pattern) |
| `runtimes/claude.yaml` field read at runtime | — | INV-3 |
| Tool description without "do NOT use for" guidance | — | INV-5a |
| Successful `ToolResult` without `next_actions` | — | INV-5b |
| Long-running op using NDJSON post-v2.11.0 | — | INV-5b (should use Tasks SEP-1686) |
| New top-level tool that should be an action on `exarchos_workflow` | — | INV-5d |
| Schema field removed but still read | DIM-3 Contracts | INV-1 if it's an event field |

The skill's report should always cite axiom dimensions where they apply — this is what "complementary" means in practice.

## 6. Open questions

1. **Naming.** `design-invariants` vs `arch-conformance` vs `exarchos-invariants`. Recommend `design-invariants` — symmetric with axiom (descriptive of what it does, not what project owns it).
2. **Trigger scope.** Should this run automatically inside `/exarchos:ideate` and `/exarchos:plan` design phases, or stay opt-in? Recommend opt-in for v0.1.0; promote to auto-pair with `/axiom:audit` after one or two real sessions.
3. **Severity calibration.** Axiom uses HIGH/MEDIUM/LOW with concrete examples. This skill should adopt the same vocabulary verbatim so reviewers don't context-switch between scales.
4. **Versioning.** When #1118's principles doc lands (`docs/architecture/principles.md`), this skill's references should link to it as the canonical source rather than re-stating principles. The skill becomes the operational projection of that doc.
5. **Test surface.** Should the skill ship with deterministic checks (grep patterns) à la `axiom:backend-quality/references/deterministic-checks.md`? Recommend yes for INV-1 (e.g., grep for state mutation patterns in reducers; grep `InMemoryTaskStore` references), INV-2 (grep for adapter-local mutable state), INV-4 (grep `Skill\(\{ skill: "exarchos:` in `skills-src/`), and INV-5d (grep for new top-level tools added to `registry.ts` since the action-discriminator pattern was adopted).
6. **#1088 timing.** This skill must be co-authored with awareness of the v2.10/v2.11 spec-alignment migration. Pre-#1266, INV-5b checks that the envelope shape exists; post-#1266, they additionally check that an `outputSchema` is registered and that the structuredContent carrier is used. The skill's INV-5b reference should explicitly note both states, with a planned amendment when #1266 ships.
7. **#1260 alignment.** Should this discovery's outputs be authored from the start in a format that #1260's machine-readable invariants generator can consume? Recommend yes — every invariant gets a stable ID, structured acceptance questions, and explicit severity rubrics. The skill's reference files become both the human-readable checklist and the source for the v2.11.0 #1275 MCP Resource.

## 7. Next step

After this discovery merges, run `/exarchos:ideate design-invariants-skill` to produce a TDD plan from this report. The plan deliverable will be the actual `.claude/skills/design-invariants/` tree (SKILL.md + 8 reference files: INV-1 through INV-5d).

## 8. Sources

### Repo
- [`#1118` — Codify architectural principles](https://github.com/lvlup-sw/exarchos/issues/1118)
- [`#1109` — Cross-cutting constraints](https://github.com/lvlup-sw/exarchos/issues/1109)
- [`#1088` — Agent Output Contract (redesigned 2026-05-07)](https://github.com/lvlup-sw/exarchos/issues/1088)
- [`#1260` — machine-readable invariants file](https://github.com/lvlup-sw/exarchos/issues/1260) (forward-link)
- [`#1275` — MCP Resources for docs/playbooks/invariants](https://github.com/lvlup-sw/exarchos/issues/1275) (forward-link, v2.11.0)
- [`basileus/docs/adrs/ontological-data-fabric.md`](https://github.com/lvlup-sw/basileus/blob/main/docs/adrs/ontological-data-fabric.md)
- `docs/architecture/projections.md` (canonical projection contract)
- `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` (authoritative output-contract design)
- `skills-src/SKILL_AUTHORING.md` (token vocabulary, capability guards)
- `CLAUDE.md` (project conventions, including Aspire-inspiration constraint)
- `servers/exarchos-mcp/src/format.ts` (`ToolResult` shape, DR-7 envelope)
- `servers/exarchos-mcp/src/parity.test.ts` (CLI ↔ MCP byte equivalence)
- `servers/exarchos-mcp/src/next-actions-from-result.ts` (HSM-derived next_actions)

### Axiom (for delineation)
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/SKILL.md` (8-dimension taxonomy)
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/references/dimensions.md`

### Event sourcing
- **Microsoft, [*Event Sourcing pattern* (Azure Architecture Center)](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)** — canonical pattern statement; intent-named events, compensating events, snapshot-as-optimization, idempotency under at-least-once, schema evolution toolkit, PII handling.
- Greg Young, [*Why can't I update an event?*](https://www.eventstore.com/blog/why-cant-i-update-an-event) — immutability rationale.
- Vandermeer, [*16 practical guidelines for ES*](https://www.continuousimprover.com/2020/06/guidelines-event-sourcing.html) — aggregates around invariants, autonomous projections, cheap rebuild.
- EventStore, [*Event immutability and dealing with change*](https://www.eventstore.com/blog/event-immutability-and-dealing-with-change) — undo events vs idempotency-only fixes.
- [EventSourcingDB *Common Issues*](https://docs.eventsourcingdb.io/best-practices/common-issues/) — idempotency, at-least-once, PII anti-pattern.
- Greg Young, [*Why Event Sourced Systems Fail*](https://fwdays.com/en/event/highload-fwdays-2020/review/why-event-sourced-systems-fail) — non-transactional event store; many read models.
- Kurrent, [*Projections 1: Theory*](https://www.kurrent.io/blog/projections-1-theory/) — left-fold formalization.
- Fritzsche, [*Lean, functional event sourcing*](https://ricofritzsche.me/functional-event-sourcing/) — slice-local folds, no aggregate object soup.
- Maier, [*Eventsourced aggregates in Haskell*](https://akii.github.io/posts/2017-06-04-eventsourcing-in-haskell.html) — fold-based aggregate definition.

### Agent-first / MCP
- Anthropic, [*Writing effective tools for agents*](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11) — namespacing, intent-shaped tools, token efficiency, self-correcting errors.
- Anthropic, [*Code execution with MCP*](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04) — deferred loading; 150k→2k token reduction.
- Anthropic, [*Define tools*](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) — 3–4 sentence descriptions; `input_examples` for complex schemas; `strict: true`.
- AgentPatterns, [*MCP Server Design*](https://agentpatterns.ai/tool-engineering/mcp-server-design/) — `verb_noun` naming, enum-over-free-text, when-NOT-to-use guidance, <15 tools.
- AgentPatterns, [*MCP Client/Server Architecture Best Practices*](https://agentpatterns.ai/tool-engineering/mcp-client-server-architecture/) — poka-yoke parameters, capability negotiation, defer-loading at >10% context.
- WebMCP, [*Tool Design*](https://docs.mcp-b.ai/explanation/design/tool-design) — schemas as type signatures; collapse near-duplicate tools.
- [MCP Specification 2025-11-25 — Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) — initialize handshake; capability negotiation.
- [MCP Specification 2025-11-25 — CallToolResult / structuredContent](https://modelcontextprotocol.io/specification/2025-11-25) — spec-native output carrier (basis for INV-5b reframe).
- [MCP SEP-1686 — Tasks](https://github.com/modelcontextprotocol/modelcontextprotocol) — long-running operations protocol (basis for `--follow` migration in v2.11.0).
- modelcontextprotocol.info, [*Mastering MCP Tool Development*](https://modelcontextprotocol.info/blog/writing-effective-mcp-tools/) — five core principles for agent-first tools.
- IBM, [*MCP Architecture Patterns*](https://ibm.github.io/mcp-context-forge/best-practices/mcp-architecture-patterns/) — single-responsibility servers; workflow-oriented tools.
- Kumar, [*MCP Architecture, Tradeoffs, and Production Realities*](https://ranjankumar.in/model-context-protocol-mcp-architecture-tradeoffs-and-production-realities) — capability manifest as cached, versioned record; structured error taxonomy.
