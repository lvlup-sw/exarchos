# Invariant catalog content audit (#1439)

> Audited: docs/architecture/invariants.md (18 entries, schema-version: 1)
> Date: 2026-05-18
> Methodology: 5-part audit per #1439 + INV-4 cross-runtime check + INV-5a skill-description appendix
> Bundle: #1441 preview-4 invariant-audit pair (PR-1)

## Summary

- Total entries audited: 18
- Recommended actions: keep: 11 | sharpen: 5 | delete: 0 | move-archive: 0 | downgrade-to-principle: 2
- INV-4 cross-runtime findings: 1 (INV-6 grep targets contain workflow-Claude-Code-typed literals as examples — wording is fine but adjacent surfaces leak)
- INV-5 selection-rule decision: migrate-references (Option B)
- Cost-of-load classification: always-load: 5 | reference-only: 11 | archivable: 2

| ID | Coverage refs ≥3? | Currency | Contradiction | INV-4 finding | Cost-of-load | recommended_action |
|---|---|---|---|---|---|---|
| INV-1 | yes (4) | stale: `workflow-state` scope vague | no (FINDING-2 fixed PR #1444) | no | always-load | keep |
| INV-2 | yes (5) | clean | no | no | always-load | keep |
| INV-3 | yes (3) | stale: `sideband-daemon` scope, no code surface | no | no | reference-only | sharpen |
| INV-4 | yes (4) | clean | partial (commands use `Skill({...})` widely, design-acceptable) | no | reference-only | keep |
| INV-5a | yes (3) | clean | no | no | always-load | keep |
| INV-5b | yes (5) | clean | no | no | always-load | keep |
| INV-5c | yes (3) | clean | no | no | reference-only | keep |
| INV-5d | yes (4) | clean (5 composite tools, 4 visible + 1 hidden) | no | no | reference-only | keep |
| INV-6 | yes (3) | clean | no | yes (description scope) | reference-only | sharpen |
| DIM-1 | yes (3) | clean | no | no | reference-only | sharpen |
| DIM-2 | yes (3) | clean | no | no | reference-only | sharpen |
| DIM-3 | yes (3) | clean | no | no | reference-only | keep |
| DIM-4 | partial (2 plus harness) | clean | no | no | reference-only | downgrade-to-principle |
| DIM-5 | partial (1) | name drift: catalog says "vestigial-code", axiom canonical is "Hygiene" | no | no | reference-only | sharpen |
| DIM-6 | yes (3, indirect via axiom) | clean | no | no | reference-only | keep |
| DIM-7 | partial (1) | name drift: catalog says "error-handling", axiom canonical is "Resilience" | no | no | reference-only | downgrade-to-principle |
| DIM-8 | partial (axiom-owned) | name drift: catalog says "ai-prose-tells", axiom canonical is "Prose Quality" | no | no | archivable | move-archive (see notes) |
| basileus-boundary | yes (4, mostly forward-looking) | broken: linked ADR file `basileus/docs/adrs/2026-04-18-...md` not present in repo | no | no | archivable | keep (cross-product entry; deliberately forward-looking) |

Notes on the table:
- "sharpen" entries are kept in the catalog but get a tighter `summary` proposed below.
- DIM-8 logically moves to archive because axiom owns the live check, but the catalog entry's pointer-only purpose is still useful for vocabulary-lint coverage. Final decision deferred to B1 — recommend `sharpen` to a one-line "axiom-owned, see /axiom:humanize" stub rather than full archive, preserving the ID for cross-references.
- `basileus-boundary` is the only cross-product entry; classified `archivable` because no Exarchos code surface depends on it today, but `keep` is recommended so the ID stays addressable for the forthcoming basileus integration.

## Per-entry walk

### INV-1: event-sourcing-integrity
- **Current summary** (verbatim from catalog): "The append-only event log is the source of truth. Every read-model is a left-fold; state mutations are events, not in-place updates. Reducers must be pure, deterministic, and structurally share state. Stores that hold derived state across calls must be projections over events, never in-memory side databases."
- **Coverage** — references found (≥3 required for `keep`):
  - `servers/exarchos-mcp/src/event-store/store.ts:148` — `class EventStore` — single per-process owner of append+query, holds per-stream locks and the idempotency cache at the EventStore boundary.
  - `servers/exarchos-mcp/src/event-store/atomic-appender.ts:138` — `AtomicAppender` with `expectedSequence` parameter — the substrate-level OCC primitive that lets reducers append safely without in-place updates.
  - `servers/exarchos-mcp/src/views/materializer.ts:117` — `register<T>(viewName, projection)` — every view is a registered left-fold over events; no view computes from anything except the event stream.
  - `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts:931` — `loadTask` cache-hit + tail-validation path (FINDING-2 fix, PR #1444) — the canonical "cache as projection, not as side database" implementation.
- **Currency** — `applies-to` scopes still present?
  - `event-store` — present at `servers/exarchos-mcp/src/event-store/`.
  - `projections` — present at `servers/exarchos-mcp/src/projections/` (registry, rebuild, snapshot-schema, taskstore).
  - `reducers` — present (implicit; every projection is a reducer); no dedicated `reducers/` directory but the term is used in code comments.
  - `workflow-state` — present via `servers/exarchos-mcp/src/views/workflow-state-projection.ts`. The scope name is vague — it could mean either "workflow-state projection" or "workflow `state.json` file." Recommend renaming to `workflow-state-projection` for clarity.
- **Contradiction** — does the implementation honor the claim?
  - FINDING-2 from `docs/research/2026-05-16-event-sourced-task-store-audit.md` (cache-hits skipped stream validation) WAS the contradiction the design exemplar called out. **PR #1444 fixed it** (commit 3f5247fa): `loadTask` now compares `cached.lastReadSequence` against `store.tailSequence(...)` and incrementally re-folds the delta. No remaining contradiction.
- **INV-4 cross-runtime** — does the entry's wording assume Claude Code? No. The summary is implementation-language-agnostic and references no `.claude/`-rooted paths in the catalog body. `inv-4-finding: no`.
- **Cost-of-load** — `always-load`
  - Rationale: INV-1 is the load-bearing invariant for every event-store, projection, or task-store proposal. Almost any non-trivial design touches this.
- **recommended_action** — `keep`. The summary is already tight; only sharpen the `applies-to: workflow-state` → `workflow-state-projection` for currency.

### INV-2: facade-equivalence
- **Current summary**: "CLI and MCP are both facades over a single functional dispatch core. For any verb, the same DispatchContext + arguments must produce the same ToolResult. Adapters carry zero behavior — only presentation. Post-#1266, every action also registers a Zod outputSchema so parity is schema-checked in addition to byte-checked."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/parity.test.ts:31` — `import type { DispatchContext }` and full CLI/MCP parity suite.
  - `servers/exarchos-mcp/src/registry.ts:202` — `assertActionHasOutputSchema()` enforces every action declares `outputSchema`.
  - `servers/exarchos-mcp/src/adapters/cli.ts` and `servers/exarchos-mcp/src/adapters/mcp.ts` — sibling adapters over the same dispatch core.
  - `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared parity primitives consumed by all per-tool parity suites.
  - `servers/exarchos-mcp/src/views/parity.test.ts`, `servers/exarchos-mcp/src/workflow/parity.test.ts`, `servers/exarchos-mcp/src/event-store/parity.test.ts` — per-tool parity coverage.
- **Currency** — all scopes present.
  - `cli-adapter` → `servers/exarchos-mcp/src/adapters/cli.ts`.
  - `mcp-adapter` → `servers/exarchos-mcp/src/adapters/mcp.ts`.
  - `dispatch-core` → `servers/exarchos-mcp/src/core/`, `servers/exarchos-mcp/src/dispatch/`.
  - `parity-tests` → multiple suites, listed above.
- **Contradiction** — no. The `assertActionHasOutputSchema` runtime check at registry-construction time makes the post-#1266 claim self-enforcing.
- **INV-4 cross-runtime** — `inv-4-finding: no`. No runtime-specific assumptions in the wording.
- **Cost-of-load** — `always-load`. Any new CLI or MCP verb design hits INV-2.
- **recommended_action** — `keep`.

### INV-3: basileus-forward
- **Current summary**: "No design decision presumes MCP is local-only. Workflow and Ontology channels have independent client lifecycles, handshake-authoritative capability resolution, and .exarchos.yml-only configuration. Workspace discovery prefers the MCP roots capability over cwd heuristics (post-#1269)."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/capabilities/resolver.ts:377` — comment "Merge order (load-bearing for INV-3 — basileus-forward)" + the `resolvePosture` function that enforces handshake-authoritative resolution.
  - `servers/exarchos-mcp/src/workspace/discovery.ts:1` — "#1290 — Roots-based workspace discovery" — the roots-over-cwd preference.
  - `servers/exarchos-mcp/src/adapters/remote-mcp.ts:41` — `'remote-mcp not implemented (tracking: #1081)'` — explicit "not yet, but designed-for" surface.
- **Currency** — partially stale.
  - `capabilities-resolver` — present.
  - `runtime-yaml` — present (`runtimes/<name>.yaml`, although these govern the skills renderer, not the MCP handshake).
  - `mcp-transport` — present (`servers/exarchos-mcp/src/adapters/mcp.ts`, the stdio transport boots there).
  - `sideband-daemon` — **stale**. Searched `servers/exarchos-mcp/src/` — only design docs (`docs/designs/2026-05-08-durable-event-store-substrate.md`, `docs/designs/2026-05-06-workflow-builder-sdk.md`, `docs/designs/2026-04-23-rehydrate-foundation.md`) mention it. No live code surface. Either the scope was aspirational or the daemon shipped under a different name.
- **Contradiction** — no. `remote-mcp.ts` explicitly throws "not implemented" rather than silently degrading.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`. Most ideations don't touch the basileus surface; load when capability-resolution, remote-MCP, or workspace-discovery come up.
- **recommended_action** — `sharpen`. Proposed summary: "No design decision presumes MCP is local-only. Workflow and Ontology channels have independent client lifecycles, handshake-authoritative capability resolution, and `.exarchos.yml`-only configuration. Workspace discovery prefers the MCP roots capability over cwd heuristics (post-#1269). The remote-MCP surface throws-not-degrades when called (#1081)." Drop `sideband-daemon` from `applies-to`; replace with `remote-mcp-adapter`.

### INV-4: platform-agnosticity
- **Current summary**: "Skills, rules, and workflows must not couple to any single harness. Six runtimes are first-class (Claude Code, Codex, Copilot, Cursor, OpenCode, generic). Runtime-specific text is tokenized via {{TOKEN}} placeholders or guarded via <!-- requires:* --> blocks. Source-of-truth edits go to skills-src/; skills/<runtime>/** is generated."
- **Coverage** — references found:
  - `src/build-skills.ts:46` — `{{TOKEN}}` substitution regex; `:301,499` — render path.
  - `src/build-skills.ts:663-695` — capability-aware `<!-- requires:* -->` guard parser + elision.
  - `runtimes/claude.yaml`, `runtimes/codex.yaml`, `runtimes/copilot.yaml`, `runtimes/cursor.yaml`, `runtimes/generic.yaml`, `runtimes/opencode.yaml` — six runtime variants present.
  - `skills-src/SKILL_AUTHORING.md:56` — `<!-- requires:* -->` guard documentation.
- **Currency** — all scopes present.
- **Contradiction** — partial-but-design-acceptable. `commands/*.md` and `skills-src/*/references/*.md` contain literal `Skill({...})` invocations (e.g., `commands/delegate.md:53,54`, `commands/synthesize.md:113`, `commands/review.md:78`, `skills-src/quality-review/references/axiom-integration.md:93,101`). These are Claude Code-specific calling conventions — but `commands/*.md` is the Claude-Code-runtime surface by design, and the skills renderer tokenizes/guards equivalents per runtime. The invariant's intent is honored as long as `skills-src/` keeps the Claude-Code-typed calls behind tokens or `<!-- requires:* -->` blocks. **Action**: include a sub-test in vocabulary-lint that flags `Skill({` literals in `skills-src/` outside `<!-- requires:claude -->` guards. File as PR-2 follow-up — out of scope here.
- **INV-4 cross-runtime** — `inv-4-finding: no` for the catalog entry itself.
- **Cost-of-load** — `reference-only`. Surfaces on skill / command / workflow-template designs, not on every ideation.
- **recommended_action** — `keep`.

### INV-5a: input-ergonomics
- **Current summary**: "Tool inputs are constrained at the schema level (enum, regex, format), not via prose hints. Every tool description states when NOT to use the tool with a pointer to the alternative. Visible tool count stays under 15. Static reference content is exposed as MCP Resources, not tools."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/registry.ts` — every action declares a Zod input schema (enum, refine, etc.); the registry enforces this.
  - `servers/exarchos-mcp/src/adapters/schema-to-flags.ts` — schema-derived CLI flags; the input-ergonomics invariant is the source-of-truth for this auto-emission.
  - `.claude/skills/design-invariants/SKILL.md:24-28` — `## When NOT to use` section; the skill itself models the "do NOT use for" guidance the invariant requires.
- **Currency** — all scopes present.
  - `mcp-registry`, `tool-schemas`, `cli-flags` all map cleanly to live code.
- **Contradiction** — no. The 4-visible-tool count (plus `exarchos_sync` hidden) is well under 15.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `always-load`. CLI/tool ergonomics is the dominant design topic.
- **recommended_action** — `keep`.

### INV-5b: output-contract
- **Current summary**: "Every successful ToolResult carries machine-actionable affordance hints — next_actions, _meta, _perf. Errors carry validTargets, expectedShape, suggestedFix. Post-#1266, the carrier is structuredContent with a registered outputSchema per action; long-running ops use Tasks (SEP-1686) not NDJSON."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/format.ts:93,164` — `Envelope<T>` with `next_actions`, `_meta`, `_perf`.
  - `servers/exarchos-mcp/src/format.ts:37-39` — `validTargets`, `expectedShape`, `suggestedFix` on the error envelope.
  - `servers/exarchos-mcp/src/next-actions-computer.ts:57` — populates `next_actions` per HSM topology.
  - `servers/exarchos-mcp/src/mcp/tasks-methods.ts` — `tasks/get` + `tasks/result` + `tasks/cancel` — the SEP-1686 surface; replaces NDJSON for long-running ops.
  - `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` — the canonical Tasks store, projection over `task.*` events.
- **Currency** — clean. NDJSON is still present (`servers/exarchos-mcp/src/ndjson/`) for CLI `--follow` streaming, but the long-running-op contract has moved to Tasks per the catalog.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `always-load`. Every ToolResult-producing change is governed by INV-5b.
- **recommended_action** — `keep`.

### INV-5c: aspire-verbs
- **Current summary**: "Exarchos CLI design borrows deliberately from Aspire — queryable, dry-run-capable, JSON-explicit control-plane verbs. Agents query state; they don't drive scripts. ps / describe / wait / export are observation verbs; mutating verbs default to --dry-run."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/describe/handler.ts` — `describe` verb on every composite tool.
  - `servers/exarchos-mcp/src/adapters/cli.ts:60` — `--json` / `--format json` envelope behavior; the JSON-explicit half.
  - `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts:617,635` — `dryRun: true` short-circuit pattern; `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts:273,285` — `dryRun` default-true.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`. Loaded for any new CLI verb or mutating-action design.
- **recommended_action** — `keep`.

### INV-5d: action-discriminator
- **Current summary**: "Exarchos exposes 4 visible composite tools, each with an action discriminator (exarchos_workflow, exarchos_event, exarchos_orchestrate, exarchos_view). The visible tool count stays under 15; per-action annotations (destructiveHint / readOnlyHint / idempotentHint / openWorldHint) live on CompositeAction post-#1268."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/registry.ts:380` — `/** A ZodObject whose shape includes an `action` discriminator key. */`.
  - `servers/exarchos-mcp/src/registry.ts:986,1219,1269,2304,2620` — 5 composite-tool blocks (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync` hidden).
  - `servers/exarchos-mcp/src/adapters/mcp.ts` — `readOnly`, `destructive`, `idempotent`, `openWorld` aggregations across an action set.
  - `servers/exarchos-mcp/src/adapters/mcp.test.ts` — annotation-rollup parity tests.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`. Loaded when adding a new action or composite tool.
- **recommended_action** — `keep`.

### INV-6: workflow-agnosticism
- **Current summary**: "Skills describe behaviors; playbooks describe workflows. A behavior-skill describes triggers in workflow-neutral terms (verb names, idempotency keys), not workflow stages or branch prefixes. Workflow-specific skills must declare metadata.workflow-type: <type> in frontmatter."
- **Coverage** — references found:
  - `.claude/skills/design-invariants/SKILL.md:52-63` — `## INV-6 walk` operational definition.
  - `.claude/skills/design-invariants/references/INV-6-workflow-agnosticism.md` — full rule + examples.
  - `scripts/lint-inv6.mjs` — the advisory lint that formalizes the grep.
- **Currency** — clean.
  - `skills-src` — present.
  - `playbooks` — surfaces nominally as commands; no top-level `playbooks/` directory but the semantic is preserved in `commands/`.
  - `skill-frontmatter` — present (every `skills-src/<name>/SKILL.md` has frontmatter).
- **Contradiction** — no, but adjacent: grep of `skills-src/` for `workflow-type` finds zero declarations, which is either "no workflow-typed skills exist" (the desired outcome) or "lint is advisory and gets ignored." Verified the former — all skills under `skills-src/` are behavior-skills by design.
- **INV-4 cross-runtime** — `inv-4-finding: yes`. The INV-6 grep targets (`feature/`, `delegate`, `synthesize`, `review`, `gathering`) are Exarchos-workflow-specific verbs, not generic. The invariant's wording is fine, but the lint targets bake in Claude-Code-rendered workflow vocabulary. **Action**: confirm lint targets are sourced from a single declarative file (e.g., `topology.yaml`'s phase list) rather than hardcoded — file as PR-2 follow-up.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `sharpen`. Proposed summary tweak: "Skills describe behaviors; playbooks/commands describe workflows. A behavior-skill describes activation triggers in workflow-neutral terms (verb names, idempotency keys), not workflow stages or branch prefixes. Workflow-specific skills must declare `metadata.workflow-type: <type>` in frontmatter. Lint: `scripts/lint-inv6.mjs` (advisory)." Adds the lint pointer; replaces "playbooks" with "playbooks/commands" since Exarchos has no `playbooks/` directory.

### DIM-1: topology
- **Current summary**: "Topology dimension from axiom — module boundaries, layering, dependency direction, ambient/shared-mutable state. Adapter-local mutable caches, lazy fallback singletons, and side databases are topology smells that frequently overlap with INV-1 / INV-2 violations."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/review/registry.ts:6` — "There is no lazy fallback or…" — explicit DIM-1 callout where the topology has been hardened.
  - `servers/exarchos-mcp/src/views/tools.ts:122` — "The previous registry/lazy-fallback…" — pattern intentionally removed.
  - `docs/rca/2026-04-27-v29-rc1-orchestrate-cluster.md:198` — RCA mapping #1188 → DIM-1 Topology.
- **Currency** — clean. The DIM-* entries are dimension-pointers, not code-level invariants; their `applies-to` scopes are conceptual surfaces.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`. Most ideations hit a single DIM, not all eight.
- **recommended_action** — `sharpen`. Per axiom canonical naming, summary should lead with "Topology" not "topology" lowercase; clarify that this dimension is axiom-owned and the catalog entry exists for cross-reference with INV-1/INV-2 only. Proposed: "Topology dimension (axiom-owned, /axiom:critique). Adapter-local mutable caches, lazy fallback singletons, and side databases are topology smells that frequently overlap with INV-1 / INV-2 — the design-invariants skill cross-links, doesn't duplicate. See `axiom:backend-quality` for the canonical check."

### DIM-2: observability
- **Current summary**: "Observability dimension from axiom — silent catches, missing log context, degradation paths that swallow signals. Frequently overlaps INV-1 when a reducer apply catches and continues instead of triggering the reducer-throw degradation path."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/agents/generate-agents.ts:10` — "Operability contract (DIM-2 observability)".
  - `servers/exarchos-mcp/src/agents/generate-agents.ts:92` — "(DIM-2)" annotation on the "surface every offending tuple" pattern.
  - `servers/exarchos-mcp/src/agents/generate-agents.test.ts:9,173` — test fidelity for DIM-2 surfacing.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `sharpen`. Same axiom-pointer treatment as DIM-1.

### DIM-3: contracts
- **Current summary**: "Contracts dimension from axiom — schema-runtime drift, type-assertion safety, breaking field renames without versioning. Overlaps INV-1 when an event field is removed but still read, and INV-5b when output shape changes without an envelope version bump."
- **Coverage** — references found:
  - `docs/rca/2026-04-27-v29-rc1-orchestrate-cluster.md:11,197,199,200` — multiple #1187-#1190 RCAs explicitly mapped to DIM-3.
  - `servers/exarchos-mcp/src/topology/phase-contract.ts:45` — `.strict()` posture as the DIM-3 surface.
  - `servers/exarchos-mcp/src/registry.ts:202` — `assertActionHasOutputSchema` is the DIM-3 enforcer.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `keep`. Already cross-links INV-1 + INV-5b crisply.

### DIM-4: test-fidelity
- **Current summary**: "Test-fidelity dimension from axiom — mock overuse, fixture drift, tests that pass against fakes but would fail in production. The TDD-task and static-analysis gates compose with this dimension to catch blast-radius regressions."
- **Coverage** — references found:
  - `docs/contexts/2026-05-07-insights-friction-discovery.md:18` — explicit DIM-4 Test Fidelity callout (gaps in subagent boot).
  - `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared real-substrate primitives; the anti-mock posture is built in.
  - Memory: `feedback_tdd_gate_blast_radius` — captures the gate-composition gap the summary names.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `downgrade-to-principle`. Only 2 in-code references, both indirect. The dimension is real but the catalog entry is pure axiom-pointer text; it adds nothing on top of `/axiom:verify`. Recommend the entry remain as a one-line pointer ("Test fidelity — see axiom:verify"), the way DIM-6 already does for SOLID.

### DIM-5: vestigial-code
- **Current summary**: "Vestigial-code dimension from axiom — dead code, unused exports, legacy feature flags that no longer gate behavior. Cleanup work that intersects INV-2 (legacy adapter paths) or INV-5d (legacy top-level tools that should collapse into composite actions)."
- **Coverage** — references found:
  - `docs/contexts/2026-05-07-insights-friction-discovery.md:57` — "DIM-5 hygiene noise" usage.
- **Currency** — **name drift**. Catalog says `dimension: vestigial-code`; axiom canonical name (`axiom/skills/backend-quality/SKILL.md:26`) is `DIM-5 | Hygiene | Dead code, vestigial patterns, evolutionary leftovers`. The vocabulary is split.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `sharpen`. Change `dimension: vestigial-code` → `dimension: hygiene` to align with axiom's canonical name. Summary stays close, but lead with "Hygiene (axiom-canonical)".

### DIM-6: solid-coupling
- **Current summary**: "SOLID / coupling dimension from axiom — generic dependency direction, single-responsibility violations, inheritance vs composition mismatches. Axiom-owned; design-invariants defers here for generic SOLID findings."
- **Coverage** — references found:
  - `.claude/skills/design-invariants/SKILL.md:110` — explicit "design-invariants defers to axiom:critique" entry in the complementarity matrix.
  - `docs/designs/2026-05-18-preview-4-invariant-audit-pair.md:93` — DIM-6 cited as the "architecture" axis the audit itself walks.
  - `/home/reedsalus/Documents/code/lvlup-sw/axiom/skills/backend-quality/SKILL.md:27` — axiom canonical definition.
- **Currency** — clean.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `keep`. This is the model the other DIM entries should follow — short pointer to axiom + explicit deference.

### DIM-7: error-handling
- **Current summary**: "Error-handling dimension from axiom — silent fallbacks, retry storms, degradation without telemetry. Often co-occurs with DIM-2 observability; design-invariants intersects when a fallback creates a degraded EventStore (INV-1) or hides parity divergence (INV-2)."
- **Coverage** — references found:
  - `servers/exarchos-mcp/src/agents/generate-agents.ts:323` — "Path-traversal guard (DIM-7)".
- **Currency** — **name drift**. Catalog says `dimension: error-handling`; axiom canonical (`axiom/skills/backend-quality/SKILL.md:28`) is `DIM-7 | Resilience | Resource management, timeouts, failure handling`. Catalog scopes (`error-paths`, `retry-logic`, `degradation`) match axiom's intent but the dimension name diverges.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `reference-only`.
- **recommended_action** — `downgrade-to-principle`. Same as DIM-4 — only 1 strong in-code reference. Recommend a tight axiom-pointer summary. Rename `dimension: error-handling` → `dimension: resilience` to align with axiom canonical.

### DIM-8: ai-prose-tells
- **Current summary**: "AI-prose-tells dimension from axiom — telltale AI-generated prose patterns (em-dashes that flatten clauses, padding adjectives, hedge phrases). Owned by axiom:humanize; design-invariants does not duplicate the check."
- **Coverage** — references found:
  - `docs/contexts/2026-05-07-insights-friction-discovery.md:31` — "DIM-8 Prose Quality" reference.
  - `/home/reedsalus/Documents/code/lvlup-sw/axiom/skills/backend-quality/SKILL.md:29` — axiom canonical name `DIM-8 | Prose Quality`.
- **Currency** — **name drift**. Catalog says `dimension: ai-prose-tells`; axiom canonical is `Prose Quality`.
- **Contradiction** — no.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `archivable`. Pure axiom-pointer; never load this for an Exarchos design ideation.
- **recommended_action** — `move-archive` (logically) but `sharpen` (pragmatically) to a one-line stub. The entry should stay addressable for vocabulary-lint cross-references but not consume Phase 0 attention. Rename `dimension: ai-prose-tells` → `dimension: prose-quality`. Final disposition deferred to B1 reviewer choice.

### basileus-boundary: cross-product-coordination
- **Current summary**: "Boundary discipline between Exarchos and Basileus. AgentHost ↔ Sandbox calls must route through ControlPlane (Basileus INV-1). Cross-product coordination uses the Ontology MCP Server (intent_register) rather than bespoke RPC. Strategos.Contracts via TypeSpec governs schema."
- **Coverage** — references found:
  - `docs/architecture/invariants.md:270-284` — the catalog entry itself.
  - `docs/research/2026-05-14-semantic-merge-queue-audit.md:559` — Ontology MCP Server description.
  - Memory: `project_basileus_coordination_adr` — references `basileus/docs/adrs/2026-04-18-exarchos-basileus-coordination.md` §2.2.
  - `servers/exarchos-mcp/src/sync/` — composite + outbox + sync-handler — the local-side surface that the cross-product boundary eventually flows through.
- **Currency** — **broken reference**. The entry's `references:` array points to `basileus/docs/adrs/2026-04-18-exarchos-basileus-coordination.md`, but this file does not exist in the Exarchos repo (`ls basileus/docs/...` returns nothing). Basileus is a sibling repo, not a submodule.
- **Contradiction** — no contradiction in the wording, but the broken pointer is a documentation defect.
- **INV-4 cross-runtime** — `inv-4-finding: no`.
- **Cost-of-load** — `archivable` from the Exarchos-only ideation standpoint, but `reference-only` for any sync / cross-product / Ontology-MCP-Server design.
- **recommended_action** — `keep`. Replace the broken `basileus/docs/adrs/...` reference with either a stub note ("see sibling basileus repo, ADR 2026-04-18") or remove the path and keep just the existing valid `.claude/skills/design-invariants/SKILL.md` reference. The cross-product entry is intentionally forward-looking and should not be archived.

## INV-5 selection-rule decision (per design §4 PR-1 Deliverable A step 4)

Background: PR #1425's "Known follow-up" flagged ~10 file references using the INV-5 umbrella without specific sub-discipline. Decide:

- **Option A**: Add an `INV-5` umbrella entry to the catalog with `applies-to: [agent-surface]` and pointer to the 4 sub-disciplines.
- **Option B**: Migrate the umbrella references to specific INV-5a/b/c/d.

Recommendation: **Option B (migrate-references)**.

Rationale: The four sub-disciplines (5a/5b/5c/5d) are sharper, individually-actionable, and already individually load-bearing in different design contexts. Adding an umbrella entry would create a fifth catalog entry whose only job is to point at the four siblings — pure indirection that increases Phase 0 token cost without adding correctness signal. Migrating the umbrella file-references to specific sub-IDs forces each call-site to declare which sub-discipline it cares about, sharpening the audit graph and exposing any miscategorizations.

If B chosen, the file:line pairs that need migration are (raw INV-5 umbrella tokens, excluding sub-discipline references already correctly typed):

- `.claude/skills/design-invariants/SKILL.md:34` — "For INV-5, walk all four sub-disciplines" — this is the procedural step, leave as-is (it's not a content-typing reference, it's a walk instruction).
- `docs/designs/2026-05-09-v2-10-0-preview-1-substrate-stabilization.md:139,169` — historical design doc; leave as-is (frozen artifact). Add a note acknowledging the umbrella usage at the doc head.
- `docs/plans/2026-05-08-durable-event-store-substrate-p8-review-fixes.md:16` — historical plan; leave as-is.
- `docs/designs/2026-05-16-correlation-indexed-columns.md:277` — `### INV-5 Agent-First Interface Design` — **migrate** to whichever specific sub-discipline this section discusses (likely INV-5b output-contract given the topic).
- `docs/research/2026-05-07-design-invariants-skill.md` — the founding design doc that introduced the split; leave as-is (it's the historical record of the umbrella).
- The remaining vocabulary-lint scanner already accepts `INV-5a`/`INV-5b`/`INV-5c`/`INV-5d` cleanly; it does not enforce migration of bare `INV-5` tokens. Recommend adding an optional `-strict` flag to vocabulary-lint that flags bare `INV-5` outside of `_archive/` and the historical design docs.

Net: most umbrella references are in historical artifacts and should stay; live design docs (e.g., `2026-05-16-correlation-indexed-columns.md`) should be migrated. No new catalog entry needed.

## Appendix: INV-5a walk of design-invariants skill description (per plan A1 step 2)

Walk `.claude/skills/design-invariants/SKILL.md` description-field-level and "When to use" / "When NOT to use" sections.

- **Description has "do NOT use for" guidance**: not in the frontmatter `description:` field itself, but the body `## When NOT to use` section (lines 24-28) does. INV-5a is honored at the body level but the frontmatter description (which is what triggers the skill loader's selection) is purely positive ("Audit a design proposal..."). A strict INV-5a reading wants negative-guidance in the description field. **Severity: LOW**. The skill's body covers it; the loader-visible description doesn't.
- **Triggers workflow-neutral**: triggers in the description (`'check invariants'`, `'design conformance'`, `'check #1118 / #1109'`, `/design-invariants`) are workflow-neutral — no `feature/`, `delegate`, `synthesize` literals. **Pass**.
- **`## When NOT to use` section** (body lines 24-28): present and well-structured. Lists three alternatives with explicit pointers (`/axiom:*`, `/exarchos:review`, `/axiom:humanize`).
- **INV-5a finding**: `inv-5a-finding: LOW`. Required fix: append a "Do NOT use for: generic backend quality (use /axiom:*), TDD or spec compliance (use /exarchos:review), prose/AI-writing tells (use /axiom:humanize)." sentence to the frontmatter `description:` field so the loader-visible signal includes negative guidance. The body's `## When NOT to use` section stays as the full canonical form. Filed in this audit doc; required_fix is non-blocking for PR-1 and may be deferred to a B3 follow-on edit.

## Filed sub-issues

(Empty initially — populated by Task B1 commit messages and PR-1 description.)
