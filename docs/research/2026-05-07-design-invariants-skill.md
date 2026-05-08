# Design-Invariants Skill — Discovery Report

**Date:** 2026-05-07
**Status:** Discovery — feeds future `/exarchos:ideate` for skill implementation
**Workflow:** `design-invariants-skill` (discovery)
**Inputs:** issues [#1118](https://github.com/lvlup-sw/exarchos/issues/1118), [#1109](https://github.com/lvlup-sw/exarchos/issues/1109)
**Pairs with:** `/axiom:backend-quality` and its eight-dimension taxonomy

---

## 1. Goal

Author a repo-scoped Claude Code skill that, when invoked alongside `/axiom:backend-quality`, evaluates a design proposal or diff against the **Exarchos-specific architectural invariants** that #1118 enumerates as principles and #1109 codifies as cross-cutting constraints.

The skill is the operational complement to #1118's "codify principles" docs deliverable: principles get a single-source-of-truth document; this skill turns those principles into a checklist an agent can actually run during a design session.

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

The seam: axiom asks *"is this code well-engineered?"*; this skill asks *"does this design respect Exarchos's load-bearing invariants?"* A design can be axiom-clean and still violate event-sourcing integrity (e.g., a perfectly well-typed handler that mutates state in place instead of emitting events).

## 3. Invariant catalog (synthesized)

Six invariants distilled from #1118 (principles), #1109 (constraints), the basileus ADR (`docs/adrs/ontological-data-fabric.md` §§2.1, 2.3, 2.4, 2.7, 2.8), and `docs/architecture/projections.md` (canonical projection contract).

### INV-1: Event-sourcing integrity (load-bearing)

The append-only event log is the source of truth. Every read-model is a left-fold; state mutations are events, not in-place updates.

**Acceptance questions** (from #1109 §1):
1. Does the surface read from the event store? (which projections)
2. Does the surface write to the event store? (which event types)
3. Does the surface stream from the event store? (subscriptions)
4. Can the output be reconstructed from events alone?

**Repo-grounded checks:**
- New `ProjectionReducer` follows `apply: (state, event) => state` purity (no I/O, no mutation, deterministic) per `docs/architecture/projections.md` §1.
- Reducer ships all three required test types — given/when/then per event, immutability harness, registry round-trip — per §2.
- New event type is registered in `event-store/schemas.ts` before being appended (validator rejects unknown types — confirmed empirically: `discovery.sources_collected` failed with `Unknown event type` during this very workflow).
- Degradation paths emit `workflow.projection_degraded` with one of `reducer-throw | snapshot-corrupt | event-stream-unavailable` per §4.
- No module mutates `state` in `apply`; structural sharing only (enforced by `assertReducerImmutable`).

**External grounding:**
- Greg Young, *Why can't I update an event?* — events are immutable facts; updates kill cacheability and break subscribers.
- *16 practical guidelines for ES* (Vandermeer, 2020) — model aggregates around invariants; use autonomous async projections; design for cheap rebuild.
- *EventSourcingDB Common Issues* — handlers MUST be idempotent; at-least-once delivery is the floor; avoid PII in events (immutable + GDPR friction).

**Severity guide:**
- HIGH: state mutation outside an event; field read at runtime without corresponding emission; "fix-it-up" event rewrites.
- MEDIUM: projection that joins across streams without owning a private lookup; non-deterministic `apply`.
- LOW: missing snapshot cadence on a projection that won't grow.

---

### INV-2: MCP parity (CLI ≡ MCP)

Every output shape works identically from CLI and MCP facades. The HATEOAS envelope is identical between `exarchos describe --json` and `exarchos_orchestrate({ action: "describe" })`.

**Acceptance questions:**
1. Does the CLI command have an MCP equivalent (or vice versa) with byte-equivalent JSON output?
2. Is dispatch routed through a shared core, with CLI/MCP as thin presentation adapters?
3. Are at least one CLI ↔ MCP parity tests present for the new surface?

**Repo-grounded checks:**
- New verb has both adapters or a documented exception in the design.
- No CLI-only side effects (e.g., printing to stdout outside of the rendered envelope).
- No MCP-only fields in `data` that the CLI couldn't surface.

**External grounding:**
- Anthropic, *Writing effective tools for agents* (2025-09-11) — namespace per service; tools should map to user intents, not API endpoints; treat schema violations as contract failures.
- AgentPatterns *MCP Server Design* — symmetric error channels (protocol vs tool-execution); `isError: true` payloads carry actionable context.
- MCP spec lifecycle (2025-11-25) — capability negotiation is a mandatory init handshake; both sides must respect negotiated capabilities for the session.

**Severity guide:**
- HIGH: behavior diverges (e.g., CLI emits an event, MCP doesn't).
- MEDIUM: shape diverges in non-load-bearing fields.
- LOW: cosmetic differences (whitespace, key order).

---

### INV-3: Basileus-forward (no MCP-second-class assumptions)

No design decision presumes MCP is local-only. The Exarchos ↔ Basileus coordination ADR cements two-channel transport (Workflow client A, Ontology client B) with independent lifecycles, handshake-authoritative capability resolution, and `.exarchos.yml`-only configuration.

**Acceptance questions** (from #1109 §3 + ADR §§2.1, 2.4, 2.7, 2.8):
1. No reads of `runtimes/*.yaml` capability fields at runtime — the resolver merging `yaml ⊕ handshake` is the only authority.
2. `agent` namespace remains reserved for future remote agent coordination (not AI-assistant setup).
3. New config land in `.exarchos.yml` only — no `bridge-config.json`-style sibling files.
4. Sideband daemon assumptions hold across all runtimes (not Claude-Code-specific).

**External grounding:**
- AgentPatterns *Capability Negotiation* — version negotiation is mandatory; servers without a match disconnect rather than silently degrade.
- IBM ContextForge architecture patterns — single-responsibility servers (S1), workflow-oriented tools (S2); central host policy and consent.

**Severity guide:**
- HIGH: hard-coded "MCP is local" assumption (e.g., synchronous file I/O blocking the dispatch path).
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
- Reference files (`skills-src/<skill>/references/*.md`) carry no YAML frontmatter.
- Every Claude-flavored example has a tokenized rendering for non-Claude runtimes.

**External grounding:**
- AgentPatterns *MCP Client Design* — namespace by server ID; per-request timeouts; graceful degradation on capability gaps.
- WebMCP *Tool Design* — schemas are the type signature; constrain via enum/format, not free-text.

**Severity guide:**
- HIGH: hardcoded Claude-only feature reference (e.g., `Skill({...})` syntax in source instead of `{{CHAIN}}`).
- MEDIUM: missing token coverage for one runtime — caught by `assertRuntimeTokenCoverage` pre-flight.
- LOW: stylistic Claude-isms in prose (e.g., "TaskCreate" verbatim where `{{TASK_TOOL}}` would render correctly).

---

### INV-5: Agent-first interface design

The primary consumer of Exarchos surfaces is an AI agent; human readability is secondary. Skills, commands, and MCP tool descriptions must be designed for agent comprehension and selection accuracy.

**Acceptance questions:**
1. Tool descriptions tell the agent **when not to use** (e.g., `"Do NOT use for X — use Y instead"`).
2. Parameters are constrained at the schema level (enum, regex, format) — poka-yoke, not prose.
3. Tool count per server stays under ~15; tools collapse to natural intents, not raw API endpoints.
4. Token-efficient defaults: pagination, filtering, terse-by-default response modes.
5. Errors return `isError: true` with actionable recovery context, not opaque codes.

**External grounding:**
- Anthropic, *Writing effective tools for agents* — pagination, range selection, filtering, sensible defaults; truncation paired with steering instructions; descriptions ≥3–4 sentences for non-trivial tools.
- Anthropic, *Code execution with MCP* (2025-11-04) — hundreds of tool definitions blow context; deferred loading + `search_tools` cuts 150k → 2k tokens (98.7%).
- AgentPatterns *MCP Server Design* checklist — `verb_noun` snake_case; per-parameter description with constraints + examples; read-only context as resources, not tools; tool list <15.
- WebMCP — avoid near-duplicate tools (`search_products` + `search_products_with_filters`); collapse to one tool with optional params.

**Severity guide:**
- HIGH: tool description says only "queries the database" with no when-not-to-use guidance, no constraints, no examples.
- MEDIUM: free-text where an enum would do; missing pagination on a list endpoint.
- LOW: description under 3 sentences for a complex tool.

---

### INV-6: Single-source-of-truth for cross-cutting state

Repo memory captures three load-bearing single-source-of-truth rules; encode them as checks here.

**Repo-grounded checks:**
- Review-contract dimension names live in `review-contract.ts` only — no hardcoded duplicates elsewhere (see memory: `project_review_contract_sot.md`).
- Skills runtime source-of-truth is the harness cache (`~/.claude/`), not repo `skills/` — distribution-time concerns ≠ runtime concerns (see memory: `project_skills_runtime_cache.md`).
- Plugin v2.8.3 lag: MCP fixes only land after rebundle + restart (see memory: `project_plugin_deployment_lag.md`).

**Severity guide:** project-context-dependent. The skill should surface the principle and link to the memory entry; the human/orchestrator decides applicability.

---

## 4. Where the catalog comes from (traceability)

| Invariant | #1118 | #1109 | Basileus ADR | Repo state |
|---|---|---|---|---|
| INV-1 Event-sourcing integrity | Principle 1 | Constraint 1 | (cited) | `docs/architecture/projections.md` |
| INV-2 MCP parity | — | Constraint 2 | (cited) | `commands/*` + `servers/exarchos-mcp/` |
| INV-3 Basileus-forward | — | Constraint 3 | §§2.1, 2.4, 2.7, 2.8 | `runtimes/*.yaml` resolver |
| INV-4 Platform-agnosticity | Principle 2 | (implied) | §1.5 (constraints table) | `skills-src/SKILL_AUTHORING.md` |
| INV-5 Agent-first | Principle 3 | (implied) | thesis §1 | tool surface in `registry.ts` |
| INV-6 Single-SoT for cross-cutting state | — | — | — | repo memory + `project_review_contract_sot.md` |

#1118 stops at three principles; #1109 adds the operational layer; the basileus ADR adds two-channel/handshake/config-consolidation; this report is the first place all five invariants live as a unified catalog.

## 5. Skill blueprint

### 5.1 Placement (recommendation)

**Recommend: repo-local at `.claude/skills/design-invariants/SKILL.md`** — not `skills-src/`.

Rationale:
- These invariants govern Exarchos *itself*, not consumers of the Exarchos plugin. Distributing them to other projects via the marketplace would be self-referential and meaningless.
- Repo-local skills load only when working in this repo, which matches the desired scope ("local skill scoped to this repository").
- Avoids the renderer + token-substitution overhead that's only needed for distributed skills.

(`.claude/` exists in this repo with `agents/`, `commands/`, etc.; the `skills/` subdir would be new and is the standard project-skill location for Claude Code.)

### 5.2 Frontmatter

```yaml
---
name: design-invariants
description: "Audit a design proposal or diff against Exarchos's architectural invariants — event-sourcing integrity, MCP parity, basileus-forward, platform-agnosticity, agent-first interface design, and SoT cross-cutting state. Pairs with /axiom:backend-quality (this skill is project-specific, axiom is generic). Triggers: 'check invariants', 'design conformance', 'check #1118 / #1109', or /design-invariants."
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
2. Walk INV-1..INV-6 in order, recording HIGH/MEDIUM/LOW findings per invariant
3. Cross-link any axiom finding that overlaps (e.g., a topology issue under INV-1 may also be DIM-1)
4. Output the same finding format as axiom (severity + dimension + file:line + description + required_fix)

## Invariant references
- INV-1 → references/INV-1-event-sourcing.md
- INV-2 → references/INV-2-mcp-parity.md
- INV-3 → references/INV-3-basileus-forward.md
- INV-4 → references/INV-4-platform-agnosticity.md
- INV-5 → references/INV-5-agent-first.md
- INV-6 → references/INV-6-cross-cutting-sot.md

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

One per invariant, each carrying:
- The acceptance questions
- Repo-grounded checks (with paths)
- External grounding (citations + 1–2 sentence summaries)
- Severity guide
- Worked examples (positive + negative)

Reference files MUST NOT carry frontmatter (per CLAUDE.md "Reference-file frontmatter" convention).

### 5.5 Pairing with axiom — the explicit complementarity matrix

The skill should output a 2-column verdict so a reviewer reading both reports can dedupe:

| Finding | Axiom dimension | Design invariant |
|---|---|---|
| Lazy fallback that creates degraded EventStore | DIM-1 Topology | INV-1 (silent loss of event integrity) |
| Hardcoded `Skill({...})` in skills-src | — | INV-4 |
| `console.log`-only catch in projection apply | DIM-2 Observability | INV-1 (fold throws → must trigger reducer-throw degradation path) |
| New CLI verb without MCP equivalent | — | INV-2 |
| `runtimes/claude.yaml` field read at runtime | — | INV-3 |
| Tool description without "do NOT use for" guidance | — | INV-5 |
| Schema field removed but still read | DIM-3 Contracts | INV-1 if it's an event field |

The skill's report should always cite axiom dimensions where they apply — this is what "complementary" means in practice.

## 6. Open questions

1. **Naming.** `design-invariants` vs `arch-conformance` vs `exarchos-invariants`. Recommend `design-invariants` — symmetric with axiom (descriptive of what it does, not what project owns it).
2. **Trigger scope.** Should this run automatically inside `/exarchos:ideate` and `/exarchos:plan` design phases, or stay opt-in? Recommend opt-in for v0.1.0; promote to auto-pair with `/axiom:audit` after one or two real sessions.
3. **Severity calibration.** Axiom uses HIGH/MEDIUM/LOW with concrete examples. This skill should adopt the same vocabulary verbatim so reviewers don't context-switch between scales.
4. **Versioning.** When #1118's principles doc lands, this skill's references should link to it as the canonical source rather than re-stating principles. The skill becomes the operational projection of that doc.
5. **Test surface.** Should the skill ship with deterministic checks (grep patterns) à la `axiom:backend-quality/references/deterministic-checks.md`? Recommend yes for INV-1 (e.g., grep for `state.<field> =` in reducers; grep for `mutableState`) and INV-4 (e.g., grep `Skill\(\{ skill: "exarchos:` in `skills-src/`).
6. **Issue #1118 alignment.** This report covers principles 1–3 from #1118 and constraints 1–3 from #1109 plus three more. Should the principles doc home (`docs/architecture/principles.md` per #1118) cite this skill, or vice versa? Recommend: principles doc is the philosophical/normative source; this skill is the operational instrument; each links to the other.

## 7. Next step

After this discovery merges, run `/exarchos:ideate design-invariants-skill` to produce a TDD plan from this report. The plan deliverable will be the actual `.claude/skills/design-invariants/` tree (SKILL.md + 6 reference files + optional deterministic-checks.md).

## 8. Sources

### Repo
- [`#1118` — Codify architectural principles](https://github.com/lvlup-sw/exarchos/issues/1118)
- [`#1109` — Cross-cutting constraints](https://github.com/lvlup-sw/exarchos/issues/1109)
- [`basileus/docs/adrs/ontological-data-fabric.md`](https://github.com/lvlup-sw/basileus/blob/main/docs/adrs/ontological-data-fabric.md)
- `docs/architecture/projections.md` (canonical projection contract)
- `skills-src/SKILL_AUTHORING.md` (token vocabulary, capability guards)
- `CLAUDE.md` (project conventions)

### Axiom (for delineation)
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/SKILL.md` (8-dimension taxonomy)
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/references/dimensions.md`

### Event sourcing
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
- WebMCP, [*Tool Design*](https://docs.mcp-b.ai/explanation/design/tool-design) — schema as type signature; collapse near-duplicate tools.
- [MCP Specification 2025-11-25 — Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) — initialize handshake; capability negotiation.
- modelcontextprotocol.info, [*Mastering MCP Tool Development*](https://modelcontextprotocol.info/blog/writing-effective-mcp-tools/) — five core principles for agent-first tools.
- IBM, [*MCP Architecture Patterns*](https://ibm.github.io/mcp-context-forge/best-practices/mcp-architecture-patterns/) — single-responsibility servers; workflow-oriented tools.
- Kumar, [*MCP Architecture, Tradeoffs, and Production Realities*](https://ranjankumar.in/model-context-protocol-mcp-architecture-tradeoffs-and-production-realities) — capability manifest as cached, versioned record; structured error taxonomy.
